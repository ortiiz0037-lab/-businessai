-- =====================================================================
-- BusinessAI · Migration 0044 · Point of sale and register integrations (S8)
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0043 (inventory), 0042 (banking), 0035 (branches), 0023 (ledger).
--
-- One record of sales for every source (BusinessAI POS, Square, Clover, Shopify POS, Lightspeed,
-- CSV files of traditional registers, the local bridge):
--   * pos_sales / pos_sale_lines keep the amounts AS SOLD (name, SKU, unit price, discounts, tax
--     rate and tax): a later catalog price change never alters a past sale. Amount columns are
--     immutable (trigger); a sale changes only by void or refund, both compensating.
--   * payments are separate from the sale and keep their own lifecycle (authorized → captured →
--     refunded / voided), the processor settlement (pos_settlements) and the bank deposit it
--     reconciles with (bank_lines of 0026 through bank_match). No card data is stored: brand,
--     last four digits and the processor's reference only.
--   * inventory: tracked lines leave stock through the S7 ledger (ba_private.inv_post) once per
--     line (idempotency key per sale line); voids post compensating 'correction' movements (once
--     per movement); refunds with restock post 'customer_return'. Native sales check AVAILABLE
--     stock (on hand − reserved − committed) under the same stock-key lock as S7. Imported sales
--     are validated first; if their stock is not available the sale is kept (the money already
--     changed hands) with inventory 'blocked' until an approver posts it.
--   * ledger (0023): a sale posts Dr cash (cash) / Dr POS funds to deposit (other methods),
--     Cr revenue, Cr sales tax payable; voids post the mirror entry; refunds the reverse; a
--     processor settlement posts Dr bank + Dr processor fees, Cr POS funds to deposit, and matches
--     the bank line; a reviewed cash difference posts cash over / short. Cost of sales is NOT
--     posted (same owner decision as S7).
--   * cash: shifts per register (one open shift per register and per cashier), opening float,
--     paid in / paid out / drops (with approval), cash sales and refunds, blind count and close.
--     A difference is recorded as counted and needs an approver's review; it is never corrected.
--   * approvals: discounts above the company limit, voids, refunds and cash out need pos.approve
--     or a one-time supervisor code (8 digits, hashed, scope + limit + expiry, failures logged and
--     throttled).
--   * integrations: tokens encrypted by the server (AES-256-GCM, key only on the server) in
--     ba_private; webhooks and syncs have no user and write only through functions that verify the
--     server's HMAC signature, a fresh timestamp and a single-use nonce (same scheme as 0042).
--     Events are idempotent per provider event id; sales per (integration, external id); an older
--     version of an order never overwrites a newer one (out-of-order events are 'stale'); failed
--     events are retried with backoff and stay visible.
-- Security: RLS on every table; writes only through SECURITY DEFINER functions with permission and
-- branch checks (branch_members of 0035); audit in pos_events.
-- Rollback: supabase/rollback/0044_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$ begin
  if to_regclass('public.inventory_movements') is null or to_regclass('public.bank_webhook_events') is null or to_regclass('public.branch_members') is null
     or to_regprocedure('ba_private.hmac_sha256(bytea, bytea)') is null or to_regprocedure('ba_private.inv_post(uuid, uuid, uuid, uuid, uuid, text, numeric, numeric, text, text, uuid, uuid, bigint, text, timestamptz)') is null then
    raise exception 'BA0044: migrations 0023, 0030, 0035, 0042 and 0043 must be applied first';
  end if;
end $$;

-- ===================================================================== permissions
insert into public.permissions (key, module, description_es, description_en) values
  ('pos.view', 'pos', 'Ver ventas, turnos de caja e informes del punto de venta', 'View point-of-sale sales, cash shifts and reports'),
  ('pos.sell', 'pos', 'Vender, abrir y cerrar su turno de caja, registrar entradas de efectivo', 'Sell, open and close own cash shift, record cash in'),
  ('pos.approve', 'pos', 'Autorizar descuentos, anulaciones, devoluciones, salidas de efectivo y diferencias de caja', 'Authorise discounts, voids, refunds, cash out and cash differences'),
  ('pos.manage', 'pos', 'Configurar cajas, impuestos e integraciones; importar y conciliar ventas externas', 'Configure registers, taxes and integrations; import and reconcile external sales')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'pos.view'), ('admin', 'pos.view'), ('member', 'pos.view'),
  ('owner', 'pos.sell'), ('admin', 'pos.sell'), ('member', 'pos.sell'),
  ('owner', 'pos.approve'), ('admin', 'pos.approve'),
  ('owner', 'pos.manage'), ('admin', 'pos.manage')
on conflict do nothing;

-- ===================================================================== S7 / ledger sources
alter table public.inventory_movements drop constraint if exists inventory_movements_source_type_check;
alter table public.inventory_movements add constraint inventory_movements_source_type_check
  check (source_type is null or source_type in ('purchase_receipt', 'transfer', 'count', 'adjustment', 'document', 'manual', 'correction', 'pos_sale', 'pos_refund', 'pos_void'));
alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void', 'payment_void',
                    'bank_adjustment', 'bank_reconciliation', 'payroll', 'payroll_void', 'payroll_payment', 'payroll_payment_void',
                    'pos_sale', 'pos_sale_void', 'pos_refund', 'pos_settlement', 'pos_cash_difference'));

-- ===================================================================== server keys (webhooks / syncs without a user)
create table if not exists ba_private.pos_server_keys (
  key_id text primary key check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  secret bytea not null check (octet_length(secret) between 32 and 128),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create table if not exists ba_private.pos_nonces (nonce uuid primary key, expires_at timestamptz not null);
create table if not exists ba_private.pos_integration_secrets (
  integration_id uuid primary key,
  token_ciphertext text not null check (char_length(token_ciphertext) between 20 and 8000),
  key_version text not null check (key_version ~ '^[A-Za-z0-9_-]{1,32}$'),
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
-- the local bridge authenticates with a token shown once; only its SHA-256 is kept
create table if not exists ba_private.pos_bridge_tokens (
  token_sha text primary key check (token_sha ~ '^[0-9a-f]{64}$'),
  integration_id uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
revoke all on ba_private.pos_server_keys, ba_private.pos_nonces, ba_private.pos_integration_secrets, ba_private.pos_bridge_tokens from public, anon, authenticated;

create or replace function ba_private.pos_verify(key text, msg text, mac text, ts bigint, nonce uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s bytea;
begin
  select k.secret into s from ba_private.pos_server_keys k where k.key_id = key and (k.retired_at is null or k.retired_at > now());
  if s is null then raise exception 'POS_SERVER_AUTH' using errcode = 'P0001', hint = 'key'; end if;
  if mac is null or lower(mac) !~ '^[0-9a-f]{64}$' or encode(ba_private.hmac_sha256(s, convert_to(msg, 'UTF8')), 'hex') <> lower(mac) then
    raise exception 'POS_SERVER_AUTH' using errcode = 'P0001', hint = 'mac';
  end if;
  if ts is null or abs(extract(epoch from now()) - ts) > 120 then raise exception 'POS_SERVER_AUTH' using errcode = 'P0001', hint = 'stale'; end if;
  delete from ba_private.pos_nonces where expires_at < now();
  begin
    insert into ba_private.pos_nonces (nonce, expires_at) values (nonce, now() + interval '10 minutes');
  exception when unique_violation then raise exception 'POS_SERVER_AUTH' using errcode = 'P0001', hint = 'replay';
  end;
end $$;

/** Database owner / service role only: registers the server key also set as POS_SERVER_KEYS="<id>:<base64>". */
create or replace function public.pos_set_server_key(key text, secret_b64 text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into ba_private.pos_server_keys (key_id, secret) values (key, decode(secret_b64, 'base64'))
  on conflict (key_id) do update set secret = excluded.secret, retired_at = null;
end $$;
create or replace function public.pos_retire_server_key(key text, at_time timestamptz default now() + interval '1 hour')
returns void language sql security definer set search_path = '' as $$
  update ba_private.pos_server_keys set retired_at = at_time where key_id = key
$$;
revoke all on function public.pos_set_server_key(text, text), public.pos_retire_server_key(text, timestamptz) from public, anon, authenticated;
grant execute on function public.pos_set_server_key(text, text), public.pos_retire_server_key(text, timestamptz) to service_role;

-- ===================================================================== branch scope
-- Approvers see every branch; users assigned to branches (branch_members) only those; users without assignments, every branch.
create or replace function public.pos_branch_ok(target uuid, branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select branch is not null
     and exists (select 1 from public.branches b where b.id = branch and b.company_id = target)
     and (public.has_permission(target, 'pos.approve')
          or not exists (select 1 from public.branch_members bm where bm.company_id = target and bm.user_id = (select auth.uid()))
          or exists (select 1 from public.branch_members bm where bm.company_id = target and bm.branch_id = branch and bm.user_id = (select auth.uid())))
$$;

-- ===================================================================== tables
create table if not exists public.pos_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  max_discount_pct numeric(5, 2) not null default 0 check (max_discount_pct between 0 and 100),   -- above it: approval
  require_shift boolean not null default true,
  cash_tolerance_cents bigint not null default 0 check (cash_tolerance_cents between 0 and 100000),   -- informative only: every difference is reviewed
  receipt_header text check (receipt_header is null or char_length(receipt_header) <= 300),
  receipt_footer text check (receipt_footer is null or char_length(receipt_footer) <= 300),
  allow_card_external boolean not null default true,     -- a card charged on a stand-alone terminal, recorded with its reference
  updated_by uuid, updated_at timestamptz not null default now()
);

create table if not exists public.pos_tax_rates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  rate numeric(6, 3) not null check (rate between 0 and 100),
  is_default boolean not null default false,
  archived_at timestamptz,
  created_by uuid, created_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index if not exists pos_tax_rates_code_uidx on public.pos_tax_rates (company_id, lower(code));
create unique index if not exists pos_tax_rates_default_uidx on public.pos_tax_rates (company_id) where is_default and archived_at is null;

create table if not exists public.pos_item_taxes (
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid not null,
  tax_rate_id uuid not null,
  updated_by uuid, updated_at timestamptz not null default now(),
  primary key (company_id, item_id),
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) on delete cascade,
  foreign key (company_id, tax_rate_id) references public.pos_tax_rates (company_id, id) deferrable initially deferred
);

create table if not exists public.pos_integrations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider in ('square', 'clover', 'shopify', 'lightspeed_x', 'lightspeed_r', 'csv', 'bridge')),
  environment text not null check (environment in ('sandbox', 'production', 'test_double', 'file', 'local')),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  external_account_id text check (external_account_id is null or char_length(external_account_id) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'error', 'login_required', 'disconnected')),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 4000),
  sync_cursor text check (sync_cursor is null or char_length(sync_cursor) <= 2000),
  last_sync_at timestamptz, last_success_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 100),
  created_by uuid, created_at timestamptz not null default now(),
  disconnected_at timestamptz, disconnected_by uuid,
  unique (company_id, id)
);
create unique index if not exists pos_integrations_account_uidx on public.pos_integrations (provider, external_account_id) where external_account_id is not null and status <> 'disconnected';

create table if not exists public.pos_location_maps (
  integration_id uuid not null,
  company_id uuid not null,
  external_location_id text not null check (char_length(external_location_id) between 1 and 200),
  branch_id uuid not null,
  primary key (integration_id, external_location_id),
  foreign key (company_id, integration_id) references public.pos_integrations (company_id, id) on delete cascade,
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred
);

create table if not exists public.pos_item_maps (
  integration_id uuid not null,
  company_id uuid not null,
  external_ref text not null check (char_length(external_ref) between 1 and 200),
  item_id uuid not null,
  variant_id uuid,
  created_by uuid, created_at timestamptz not null default now(),
  primary key (integration_id, external_ref),
  foreign key (company_id, integration_id) references public.pos_integrations (company_id, id) on delete cascade,
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) deferrable initially deferred,
  foreign key (company_id, variant_id) references public.catalog_variants (company_id, id) deferrable initially deferred
);

create table if not exists public.pos_registers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  kind text not null default 'native' check (kind in ('native', 'external')),
  integration_id uuid,
  external_ref text check (external_ref is null or char_length(external_ref) <= 200),
  archived_at timestamptz,
  created_by uuid, created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, integration_id) references public.pos_integrations (company_id, id) deferrable initially deferred,
  check ((kind = 'external') = (integration_id is not null))
);
create unique index if not exists pos_registers_code_uidx on public.pos_registers (company_id, lower(code));
create unique index if not exists pos_registers_ext_uidx on public.pos_registers (integration_id, external_ref) where integration_id is not null and external_ref is not null;

-- assigned terminals: when a register has assignments only those users (and approvers) open shifts on it
create table if not exists public.pos_register_users (
  register_id uuid not null,
  company_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_by uuid, added_at timestamptz not null default now(),
  primary key (register_id, user_id),
  foreign key (company_id, register_id) references public.pos_registers (company_id, id) on delete cascade
);

create table if not exists public.pos_counters (
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('sale', 'refund', 'shift')),
  last_value integer not null default 0,
  primary key (company_id, kind)
);

create table if not exists public.pos_shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  number text not null,
  branch_id uuid not null,
  register_id uuid not null,
  cashier_id uuid not null,
  status text not null default 'open' check (status in ('open', 'closed', 'pending_review', 'reviewed')),
  opened_at timestamptz not null default now(),
  opening_float_cents bigint not null check (opening_float_cents between 0 and 100000000),
  closed_at timestamptz, closed_by uuid,
  expected_cash_cents bigint, counted_cash_cents bigint, difference_cents bigint,
  count_detail jsonb check (count_detail is null or (jsonb_typeof(count_detail) = 'object' and octet_length(count_detail::text) <= 2000)),
  close_note text check (close_note is null or char_length(close_note) <= 500),
  reviewed_by uuid, reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  ledger_entry_id uuid,
  idem_key text check (idem_key is null or char_length(idem_key) between 8 and 120),
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, register_id) references public.pos_registers (company_id, id) deferrable initially deferred
);
create unique index if not exists pos_shifts_open_register_uidx on public.pos_shifts (register_id) where status = 'open';
create unique index if not exists pos_shifts_open_cashier_uidx on public.pos_shifts (company_id, cashier_id) where status = 'open';
create unique index if not exists pos_shifts_idem_uidx on public.pos_shifts (company_id, idem_key) where idem_key is not null;
create index if not exists pos_shifts_list_idx on public.pos_shifts (company_id, opened_at desc);

create table if not exists public.pos_sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  number text not null,
  source text not null check (source in ('native', 'external', 'import')),
  integration_id uuid,
  external_id text check (external_id is null or char_length(external_id) between 1 and 200),
  external_version bigint,                              -- provider version / updated time (epoch ms): older events never overwrite newer data
  branch_id uuid not null,
  register_id uuid,
  shift_id uuid,
  cashier_id uuid,
  cashier_ref text check (cashier_ref is null or char_length(cashier_ref) <= 120),
  client_id uuid,
  occurred_at timestamptz not null,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  status text not null default 'completed' check (status in ('completed', 'partially_refunded', 'refunded', 'voided')),
  inventory_status text not null default 'not_required' check (inventory_status in ('posted', 'not_required', 'blocked')),
  inventory_error text check (inventory_error is null or char_length(inventory_error) <= 300),
  ledger_entry_id uuid,
  discount_reason text check (discount_reason is null or char_length(discount_reason) <= 200),
  discount_approved_by uuid,
  note text check (note is null or char_length(note) <= 500),
  idem_key text check (idem_key is null or char_length(idem_key) between 8 and 120),
  voided_at timestamptz, voided_by uuid, void_approved_by uuid,
  void_reason text check (void_reason is null or char_length(void_reason) <= 300),
  created_by uuid, created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number),
  check (total_cents = subtotal_cents - discount_cents + tax_cents),
  check (refunded_cents <= total_cents),
  check ((source = 'native') = (integration_id is null)),
  check (source = 'native' or external_id is not null),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, register_id) references public.pos_registers (company_id, id) deferrable initially deferred,
  foreign key (company_id, shift_id) references public.pos_shifts (company_id, id) deferrable initially deferred,
  foreign key (company_id, integration_id) references public.pos_integrations (company_id, id) deferrable initially deferred
);
create unique index if not exists pos_sales_external_uidx on public.pos_sales (integration_id, external_id) where integration_id is not null;
create unique index if not exists pos_sales_idem_uidx on public.pos_sales (company_id, idem_key) where idem_key is not null;
create index if not exists pos_sales_list_idx on public.pos_sales (company_id, occurred_at desc);
create index if not exists pos_sales_shift_idx on public.pos_sales (shift_id);

create table if not exists public.pos_sale_lines (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  sale_id uuid not null,
  line_no smallint not null check (line_no between 1 and 500),
  item_id uuid,
  variant_id uuid,
  external_line_id text check (external_line_id is null or char_length(external_line_id) <= 200),
  sku text check (sku is null or char_length(sku) <= 60),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  gross_cents bigint not null check (gross_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_name text check (tax_name is null or char_length(tax_name) <= 60),
  tax_rate numeric(6, 3) not null default 0 check (tax_rate between 0 and 100),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  track_inventory boolean not null default false,
  movement_id bigint,
  refunded_qty numeric(14, 3) not null default 0 check (refunded_qty >= 0),
  unique (sale_id, line_no),
  check (discount_cents <= gross_cents),
  check (total_cents = gross_cents - discount_cents + tax_cents),
  check (refunded_qty <= quantity),
  check (not track_inventory or item_id is not null),
  foreign key (company_id, sale_id) references public.pos_sales (company_id, id) on delete cascade,
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) deferrable initially deferred,
  foreign key (company_id, variant_id) references public.catalog_variants (company_id, id) deferrable initially deferred
);
create index if not exists pos_sale_lines_item_idx on public.pos_sale_lines (company_id, item_id);

create table if not exists public.pos_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  integration_id uuid not null,
  provider_payout_id text not null check (char_length(provider_payout_id) between 1 and 200),
  payout_date date not null,
  gross_cents bigint not null check (gross_cents >= 0),
  fees_cents bigint not null default 0 check (fees_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  status text not null check (status in ('pending', 'in_transit', 'paid', 'failed')),
  bank_line_id uuid,
  ledger_entry_id uuid,
  reconciled_at timestamptz, reconciled_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (integration_id, provider_payout_id),
  check (net_cents = gross_cents - fees_cents),
  foreign key (company_id, integration_id) references public.pos_integrations (company_id, id) deferrable initially deferred
);
create unique index if not exists pos_settlements_bank_uidx on public.pos_settlements (bank_line_id) where bank_line_id is not null;

create table if not exists public.pos_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  sale_id uuid not null,
  method text not null check (method in ('cash', 'check', 'ath_movil', 'transfer', 'card', 'card_external', 'gift_card', 'store_credit', 'other')),
  amount_cents bigint not null check (amount_cents > 0),
  tendered_cents bigint check (tendered_cents is null or tendered_cents >= amount_cents),
  change_cents bigint not null default 0 check (change_cents >= 0),
  reference text check (reference is null or char_length(reference) <= 120),
  status text not null default 'captured' check (status in ('authorized', 'captured', 'partially_refunded', 'refunded', 'voided', 'failed')),
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  provider text check (provider is null or char_length(provider) <= 40),
  provider_payment_id text check (provider_payment_id is null or char_length(provider_payment_id) <= 200),
  card_brand text check (card_brand is null or card_brand ~ '^[A-Za-z_ ]{1,30}$'),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  auth_code text check (auth_code is null or auth_code ~ '^[A-Za-z0-9]{1,12}$'),
  settlement_id uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  check (refunded_cents <= amount_cents),
  foreign key (company_id, sale_id) references public.pos_sales (company_id, id) on delete cascade,
  foreign key (company_id, settlement_id) references public.pos_settlements (company_id, id) deferrable initially deferred
);
create unique index if not exists pos_payments_provider_uidx on public.pos_payments (provider, provider_payment_id) where provider_payment_id is not null;
create index if not exists pos_payments_sale_idx on public.pos_payments (sale_id);

-- authorization, capture, void, refund, settlement: every step of a payment, append-only
create table if not exists public.pos_payment_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  payment_id uuid not null,
  kind text not null check (kind in ('authorized', 'captured', 'voided', 'refunded', 'settled', 'failed')),
  amount_cents bigint not null check (amount_cents >= 0),
  provider_event_id text check (provider_event_id is null or char_length(provider_event_id) <= 200),
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists pos_payment_events_payment_idx on public.pos_payment_events (payment_id, id);

create table if not exists public.pos_refunds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  number text not null,
  sale_id uuid not null,
  branch_id uuid not null,
  shift_id uuid,
  method text not null check (method in ('cash', 'check', 'ath_movil', 'transfer', 'card', 'card_external', 'gift_card', 'store_credit', 'other')),
  reference text check (reference is null or char_length(reference) <= 120),
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  amount_cents bigint not null check (amount_cents > 0),
  restock boolean not null default true,
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  approved_by uuid,
  external_id text check (external_id is null or char_length(external_id) <= 200),
  ledger_entry_id uuid,
  idem_key text check (idem_key is null or char_length(idem_key) between 8 and 120),
  occurred_at timestamptz not null default now(),
  created_by uuid, created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number),
  check (amount_cents = subtotal_cents - discount_cents + tax_cents),
  foreign key (company_id, sale_id) references public.pos_sales (company_id, id) deferrable initially deferred,
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, shift_id) references public.pos_shifts (company_id, id) deferrable initially deferred
);
create unique index if not exists pos_refunds_idem_uidx on public.pos_refunds (company_id, idem_key) where idem_key is not null;
create unique index if not exists pos_refunds_external_uidx on public.pos_refunds (sale_id, external_id) where external_id is not null;

create table if not exists public.pos_refund_lines (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  refund_id uuid not null,
  sale_line_id bigint not null references public.pos_sale_lines(id) deferrable initially deferred,
  quantity numeric(14, 3) not null check (quantity > 0),
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  movement_id bigint,
  foreign key (company_id, refund_id) references public.pos_refunds (company_id, id) on delete cascade
);
create index if not exists pos_refund_lines_line_idx on public.pos_refund_lines (sale_line_id);

-- the cash drawer of a shift: expected cash = sum(amount_cents)
create table if not exists public.pos_cash_movements (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  shift_id uuid not null,
  kind text not null check (kind in ('opening_float', 'paid_in', 'paid_out', 'drop', 'sale', 'refund', 'void')),
  amount_cents bigint not null,
  reason text check (reason is null or char_length(reason) <= 300),
  sale_id uuid, refund_id uuid,
  approved_by uuid,
  idem_key text check (idem_key is null or char_length(idem_key) between 8 and 120),
  created_by uuid, created_at timestamptz not null default now(),
  check (case when kind in ('opening_float', 'paid_in', 'sale') then amount_cents >= 0 else amount_cents <= 0 end),
  foreign key (company_id, shift_id) references public.pos_shifts (company_id, id) deferrable initially deferred
);
create unique index if not exists pos_cash_movements_idem_uidx on public.pos_cash_movements (company_id, idem_key) where idem_key is not null;
create index if not exists pos_cash_movements_shift_idx on public.pos_cash_movements (shift_id, id);

-- one-time supervisor codes (only the SHA-256 is kept)
create table if not exists public.pos_approval_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid,
  scope text not null check (scope in ('discount', 'void', 'refund', 'cash_out')),
  max_cents bigint check (max_cents is null or max_cents > 0),
  max_pct numeric(5, 2) check (max_pct is null or max_pct between 0 and 100),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  issued_by uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz, used_by uuid, used_for text,
  created_at timestamptz not null default now()
);
create unique index if not exists pos_approval_codes_hash_uidx on public.pos_approval_codes (code_hash);

-- every webhook delivery, sync item or imported row: the queue, its retries and its history
create table if not exists public.pos_sync_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('square', 'clover', 'shopify', 'lightspeed_x', 'lightspeed_r', 'csv', 'bridge')),
  event_key text not null check (char_length(event_key) between 8 and 200),
  company_id uuid references public.companies(id) on delete cascade,
  integration_id uuid,
  event_type text check (event_type is null or char_length(event_type) <= 80),
  object_id text check (object_id is null or char_length(object_id) <= 200),
  object_version bigint,
  status text not null default 'received' check (status in ('received', 'applied', 'duplicate', 'stale', 'ignored', 'needs_review', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  sale_id uuid,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_key)
);
create index if not exists pos_sync_events_company_idx on public.pos_sync_events (company_id, id desc);
create index if not exists pos_sync_events_due_idx on public.pos_sync_events (next_attempt_at) where status = 'failed';

create table if not exists public.pos_sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  integration_id uuid not null,
  trigger text not null check (trigger in ('manual', 'webhook', 'scheduled', 'import', 'recovery', 'bridge')),
  status text not null check (status in ('succeeded', 'partial', 'failed')),
  received integer not null default 0, created integer not null default 0, updated integer not null default 0,
  duplicates integer not null default 0, stale integer not null default 0, needs_review integer not null default 0, failed integer not null default 0,
  error_code text check (error_code is null or char_length(error_code) <= 100),
  file_name text check (file_name is null or char_length(file_name) <= 200),
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  actor uuid,
  foreign key (company_id, integration_id) references public.pos_integrations (company_id, id) on delete cascade
);
create unique index if not exists pos_sync_runs_file_uidx on public.pos_sync_runs (integration_id, file_sha256) where file_sha256 is not null;
create index if not exists pos_sync_runs_list_idx on public.pos_sync_runs (company_id, started_at desc);

create table if not exists public.pos_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  entity text not null,
  entity_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists pos_events_company_idx on public.pos_events (company_id, id desc);
create index if not exists pos_events_actor_idx on public.pos_events (actor, action, created_at desc);

-- ===================================================================== guards
-- history is never edited: amounts of sales, lines, refunds and the cash drawer are fixed once written
create or replace function public.pos_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'POS_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  if tg_table_name = 'pos_sales' then
    if (new.company_id, new.number, new.source, new.integration_id, new.external_id, new.branch_id, new.register_id, new.shift_id, new.cashier_id, new.client_id,
        new.occurred_at, new.currency, new.subtotal_cents, new.discount_cents, new.tax_cents, new.total_cents, new.idem_key, new.created_by, new.created_at)
       is distinct from
       (old.company_id, old.number, old.source, old.integration_id, old.external_id, old.branch_id, old.register_id, old.shift_id, old.cashier_id, old.client_id,
        old.occurred_at, old.currency, old.subtotal_cents, old.discount_cents, old.tax_cents, old.total_cents, old.idem_key, old.created_by, old.created_at)
       or (old.status = 'voided') or new.refunded_cents < old.refunded_cents then
      raise exception 'POS_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
    return new;
  elsif tg_table_name = 'pos_sale_lines' then
    if (new.sale_id, new.line_no, new.item_id, new.variant_id, new.name, new.sku, new.quantity, new.unit_price_cents, new.gross_cents, new.discount_cents,
        new.tax_rate, new.tax_cents, new.total_cents, new.track_inventory) is distinct from
       (old.sale_id, old.line_no, old.item_id, old.variant_id, old.name, old.sku, old.quantity, old.unit_price_cents, old.gross_cents, old.discount_cents,
        old.tax_rate, old.tax_cents, old.total_cents, old.track_inventory)
       or (old.movement_id is not null and new.movement_id is distinct from old.movement_id) or new.refunded_qty < old.refunded_qty then
      raise exception 'POS_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
    return new;
  elsif tg_table_name = 'pos_payments' then
    if (new.sale_id, new.method, new.amount_cents, new.tendered_cents, new.change_cents, new.reference, new.provider, new.provider_payment_id, new.card_last4)
       is distinct from (old.sale_id, old.method, old.amount_cents, old.tendered_cents, old.change_cents, old.reference, old.provider, old.provider_payment_id, old.card_last4)
       or new.refunded_cents < old.refunded_cents or old.status in ('voided', 'refunded', 'failed') and new.status <> old.status then
      raise exception 'POS_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
    return new;
  elsif tg_table_name = 'pos_shifts' then
    if (new.number, new.branch_id, new.register_id, new.cashier_id, new.opened_at, new.opening_float_cents) is distinct from
       (old.number, old.branch_id, old.register_id, old.cashier_id, old.opened_at, old.opening_float_cents)
       or (old.status <> 'open' and (new.expected_cash_cents, new.counted_cash_cents, new.difference_cents, new.closed_at, new.closed_by) is distinct from
                                    (old.expected_cash_cents, old.counted_cash_cents, old.difference_cents, old.closed_at, old.closed_by))
       or old.status = 'reviewed' or (old.status in ('closed', 'pending_review') and new.status = 'open') then
      raise exception 'POS_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
    return new;
  end if;
  raise exception 'POS_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
end $$;
do $$
declare t text;
begin
  foreach t in array array['pos_sales', 'pos_sale_lines', 'pos_payments', 'pos_shifts'] loop
    execute format('drop trigger if exists ba_%s_guard on public.%I', t, t);
    execute format('create trigger ba_%s_guard before update or delete on public.%I for each row execute function public.pos_guard()', t, t);
  end loop;
  foreach t in array array['pos_refunds', 'pos_refund_lines', 'pos_cash_movements', 'pos_payment_events', 'pos_events'] loop
    execute format('drop trigger if exists ba_%s_guard on public.%I', t, t);
    execute format('create trigger ba_%s_guard before update or delete on public.%I for each row execute function public.pos_guard()', t, t);
  end loop;
end $$;

-- ===================================================================== RLS
do $$
declare t text;
begin
  foreach t in array array['pos_settings', 'pos_tax_rates', 'pos_item_taxes', 'pos_integrations', 'pos_location_maps', 'pos_item_maps', 'pos_registers',
    'pos_register_users', 'pos_counters', 'pos_shifts', 'pos_sales', 'pos_sale_lines', 'pos_settlements', 'pos_payments', 'pos_payment_events', 'pos_refunds',
    'pos_refund_lines', 'pos_cash_movements', 'pos_approval_codes', 'pos_sync_events', 'pos_sync_runs', 'pos_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    if t not in ('pos_counters', 'pos_approval_codes') then execute format('grant select on public.%I to authenticated', t); end if;
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
  end loop;
end $$;
create policy ba_pos_settings_select on public.pos_settings for select to authenticated using (public.has_permission(company_id, 'pos.view'));
create policy ba_pos_tax_rates_select on public.pos_tax_rates for select to authenticated using (public.has_permission(company_id, 'pos.view'));
create policy ba_pos_item_taxes_select on public.pos_item_taxes for select to authenticated using (public.has_permission(company_id, 'pos.view'));
create policy ba_pos_integrations_select on public.pos_integrations for select to authenticated using (public.has_permission(company_id, 'pos.manage'));
create policy ba_pos_location_maps_select on public.pos_location_maps for select to authenticated using (public.has_permission(company_id, 'pos.manage'));
create policy ba_pos_item_maps_select on public.pos_item_maps for select to authenticated using (public.has_permission(company_id, 'pos.manage'));
create policy ba_pos_registers_select on public.pos_registers for select to authenticated using (public.has_permission(company_id, 'pos.view') and public.pos_branch_ok(company_id, branch_id));
create policy ba_pos_register_users_select on public.pos_register_users for select to authenticated using (public.has_permission(company_id, 'pos.view'));
create policy ba_pos_shifts_select on public.pos_shifts for select to authenticated using (public.has_permission(company_id, 'pos.view') and public.pos_branch_ok(company_id, branch_id));
create policy ba_pos_sales_select on public.pos_sales for select to authenticated using (public.has_permission(company_id, 'pos.view') and public.pos_branch_ok(company_id, branch_id));
create policy ba_pos_sale_lines_select on public.pos_sale_lines for select to authenticated
  using (exists (select 1 from public.pos_sales s where s.id = sale_id and public.has_permission(s.company_id, 'pos.view') and public.pos_branch_ok(s.company_id, s.branch_id)));
create policy ba_pos_payments_select on public.pos_payments for select to authenticated
  using (exists (select 1 from public.pos_sales s where s.id = sale_id and public.has_permission(s.company_id, 'pos.view') and public.pos_branch_ok(s.company_id, s.branch_id)));
create policy ba_pos_payment_events_select on public.pos_payment_events for select to authenticated using (public.has_permission(company_id, 'pos.approve'));
create policy ba_pos_refunds_select on public.pos_refunds for select to authenticated using (public.has_permission(company_id, 'pos.view') and public.pos_branch_ok(company_id, branch_id));
create policy ba_pos_refund_lines_select on public.pos_refund_lines for select to authenticated
  using (exists (select 1 from public.pos_refunds r where r.id = refund_id and public.has_permission(r.company_id, 'pos.view') and public.pos_branch_ok(r.company_id, r.branch_id)));
create policy ba_pos_cash_movements_select on public.pos_cash_movements for select to authenticated
  using (exists (select 1 from public.pos_shifts x where x.id = shift_id and public.has_permission(x.company_id, 'pos.view') and public.pos_branch_ok(x.company_id, x.branch_id)));
create policy ba_pos_settlements_select on public.pos_settlements for select to authenticated using (public.has_permission(company_id, 'pos.manage'));
create policy ba_pos_sync_events_select on public.pos_sync_events for select to authenticated using (company_id is not null and public.has_permission(company_id, 'pos.manage'));
create policy ba_pos_sync_runs_select on public.pos_sync_runs for select to authenticated using (public.has_permission(company_id, 'pos.manage'));
create policy ba_pos_events_select on public.pos_events for select to authenticated using (public.has_permission(company_id, 'pos.approve'));

-- ===================================================================== internal
create or replace function ba_private.pos_log(target uuid, ent text, ent_id text, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.pos_events (company_id, entity, entity_id, action, details, actor) values (target, ent, ent_id, act, coalesce(info, '{}'), (select auth.uid()))
$$;
create or replace function ba_private.pos_next(target uuid, k text, prefix text)
returns text language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  insert into public.pos_counters (company_id, kind, last_value) values (target, k, 1)
  on conflict (company_id, kind) do update set last_value = public.pos_counters.last_value + 1
  returning last_value into v;
  return prefix || '-' || lpad(v::text, 6, '0');
end $$;
create or replace function ba_private.pos_require(target uuid, perm text, branch uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.has_permission(target, perm) then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if branch is not null and not public.pos_branch_ok(target, branch) then raise exception 'BRANCH_FORBIDDEN' using errcode = 'P0001'; end if;
end $$;

-- system accounts of the POS (created once per company, on a free code)
create or replace function ba_private.pos_account(target uuid, sk text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a uuid; c integer; nm text; nm_en text; ty text; base integer;
begin
  perform public.ledger_ensure_chart(target);
  select id into a from public.ledger_accounts where company_id = target and system_key = sk;
  if a is not null then return a; end if;
  case sk
    when 'pos_clearing' then base := 1050; nm := 'Fondos por depositar (punto de venta)'; nm_en := 'POS funds to deposit'; ty := 'asset';
    when 'processor_fees' then base := 6450; nm := 'Comisiones de procesadores de pago'; nm_en := 'Payment processor fees'; ty := 'expense';
    when 'cash_over_short' then base := 6460; nm := 'Sobrantes y faltantes de caja'; nm_en := 'Cash over and short'; ty := 'expense';
    else raise exception 'LEDGER_ACCOUNT_MISSING' using errcode = 'P0001', hint = sk;
  end case;
  perform pg_advisory_xact_lock(hashtextextended('ba_pos_acct:' || target::text, 0));
  select id into a from public.ledger_accounts where company_id = target and system_key = sk;
  if a is not null then return a; end if;
  c := base;
  while exists (select 1 from public.ledger_accounts where company_id = target and code = c::text) loop c := c + 1; end loop;
  insert into public.ledger_accounts (company_id, code, name, name_en, type, system_key, description)
  values (target, c::text, nm, nm_en, ty, sk, 'Creada por el punto de venta (0044).') returning id into a;
  return a;
end $$;

-- the ledger entry of a sale (cash to Cash, any other method to POS funds to deposit)
create or replace function ba_private.pos_post_sale(s public.pos_sales)
returns uuid language plpgsql security definer set search_path = '' as $$
declare cash bigint; other bigint; ln jsonb := '[]'::jsonb; on_date date; eid uuid;
begin
  if s.total_cents = 0 then return null; end if;
  select coalesce(sum(p.amount_cents) filter (where p.method = 'cash'), 0), coalesce(sum(p.amount_cents) filter (where p.method <> 'cash'), 0)
    into cash, other from public.pos_payments p where p.sale_id = s.id and p.status not in ('failed', 'voided');
  if cash + other <> s.total_cents then raise exception 'POS_PAYMENTS_MISMATCH' using errcode = 'P0001'; end if;
  perform ba_private.pos_account(s.company_id, 'pos_clearing');
  if cash > 0 then ln := ln || jsonb_build_object('key', 'cash', 'debit', cash, 'client_id', s.client_id); end if;
  if other > 0 then ln := ln || jsonb_build_object('key', 'pos_clearing', 'debit', other, 'client_id', s.client_id); end if;
  if s.subtotal_cents - s.discount_cents > 0 then ln := ln || jsonb_build_object('key', 'sales_revenue', 'credit', s.subtotal_cents - s.discount_cents, 'client_id', s.client_id); end if;
  if s.tax_cents > 0 then ln := ln || jsonb_build_object('key', 'sales_tax_payable', 'credit', s.tax_cents, 'client_id', s.client_id); end if;
  on_date := (s.occurred_at at time zone 'America/Puerto_Rico')::date;
  if on_date > public.ba_today() or public.ledger_period_closed(s.company_id, on_date) then on_date := public.ba_today(); end if;   -- a closed month is never reopened silently
  eid := public.ledger_post(s.company_id, on_date, 'Venta ' || s.number, coalesce(s.external_id, s.number), 'pos_sale', s.id, ln);
  return eid;
end $$;

-- available = on hand − reserved − committed (S7 rule), read under the stock-key lock taken by the caller
create or replace function ba_private.pos_available(target uuid, branch uuid, item uuid, variant uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select public.inventory_on_hand(branch, item, variant)
       - coalesce((select sum(r.quantity) from public.inventory_reservations r where r.company_id = target and r.branch_id = branch and r.item_id = item
                     and ba_private.inv_vkey(r.variant_id) = ba_private.inv_vkey(variant) and r.status = 'active'), 0)
       - coalesce((select sum(coalesce(l.qty_prepared, l.qty_requested)) from public.inventory_transfer_lines l join public.inventory_transfers t on t.id = l.transfer_id
                     where t.from_branch_id = branch and l.item_id = item and ba_private.inv_vkey(l.variant_id) = ba_private.inv_vkey(variant) and t.status in ('approved', 'prepared')), 0)
$$;

-- stock leaves for the tracked lines of a sale (once per line). strict: refuse when not available.
-- Returns null when posted, or the error code when the stock is not available (non-strict).
create or replace function ba_private.pos_post_inventory(s public.pos_sales, strict boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare l record; mid bigint; allow_neg boolean; need record;
begin
  allow_neg := coalesce((select x.allow_negative from public.inventory_settings x where x.company_id = s.company_id), false);
  -- locks in a fixed order (no deadlock between two sales of the same products)
  for need in select sl.item_id, sl.variant_id, sum(sl.quantity) as qty from public.pos_sale_lines sl
              where sl.sale_id = s.id and sl.track_inventory and sl.movement_id is null group by 1, 2 order by 1, ba_private.inv_vkey(sl.variant_id) loop
    perform pg_advisory_xact_lock(hashtextextended('ba_inv:' || s.branch_id::text || ':' || need.item_id::text || ':' || ba_private.inv_vkey(need.variant_id)::text, 0));
    if not allow_neg and ba_private.pos_available(s.company_id, s.branch_id, need.item_id, need.variant_id) < need.qty then
      if strict then
        raise exception 'POS_STOCK_UNAVAILABLE' using errcode = 'P0001', hint = format('item=%s available=%s requested=%s', need.item_id,
          ba_private.pos_available(s.company_id, s.branch_id, need.item_id, need.variant_id), need.qty);
      end if;
      return 'POS_STOCK_UNAVAILABLE';
    end if;
  end loop;
  for l in select * from public.pos_sale_lines sl where sl.sale_id = s.id and sl.track_inventory and sl.movement_id is null order by sl.line_no loop
    mid := ba_private.inv_post(s.company_id, s.branch_id, null, l.item_id, l.variant_id, 'sale', -l.quantity, null, 'Venta ' || s.number,
                               'pos_sale', s.id, null, null, 'pos:' || s.id || ':' || l.line_no, s.occurred_at);
    update public.pos_sale_lines set movement_id = mid where id = l.id;
  end loop;
  return null;
end $$;

/**
 * Prices a cart on the server (the only source of the amounts of a native sale):
 * lines [{item, variant, qty, discount_cents | discount_pct}], cart discount in cents or percent.
 * Unit price: variant price, else catalog price. Line discounts first, then the cart discount
 * allocated in proportion to each line's net (largest remainder). Tax per line on its net:
 * the product's POS tax rate, else the catalog item's rate, else the company's default rate.
 */
create or replace function ba_private.pos_price(target uuid, lines jsonb, cart_discount_cents bigint, cart_discount_pct numeric)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  l jsonb; res jsonb := '[]'::jsonb; it public.catalog_items; v public.catalog_variants; n integer := 0;
  qty numeric; unit bigint; gross bigint; disc bigint; rate numeric; tname text; tr public.pos_tax_rates; deft public.pos_tax_rates;
  sum_gross bigint := 0; sum_net bigint := 0; cart bigint; alloc bigint; given bigint := 0; rem jsonb; i integer; tax bigint; tot_tax bigint := 0; tot_disc bigint := 0;
  arr jsonb; x jsonb;
begin
  if lines is null or jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) not between 1 and 200 then raise exception 'POS_LINES_INVALID' using errcode = 'P0001'; end if;
  select * into deft from public.pos_tax_rates t where t.company_id = target and t.is_default and t.archived_at is null;
  for l in select * from jsonb_array_elements(lines) loop
    n := n + 1;
    if coalesce(l ->> 'item', '') !~ '^[0-9a-f-]{36}$' or (l ->> 'variant' is not null and l ->> 'variant' !~ '^[0-9a-f-]{36}$')
       or coalesce(l ->> 'qty', '') !~ '^[0-9]{1,7}(\.[0-9]{1,3})?$' or (l ->> 'qty')::numeric <= 0
       or (l ? 'discount_cents' and coalesce(l ->> 'discount_cents', '0') !~ '^[0-9]{1,12}$')
       or (l ? 'discount_pct' and coalesce(l ->> 'discount_pct', '0') !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$') then
      raise exception 'POS_LINES_INVALID' using errcode = 'P0001', hint = n::text;
    end if;
    select * into it from public.catalog_items x2 where x2.id = (l ->> 'item')::uuid and x2.company_id = target;
    if it.id is null or it.status <> 'active' then raise exception 'POS_ITEM_INVALID' using errcode = 'P0001', hint = n::text; end if;
    v := null;
    if l ->> 'variant' is not null then
      select * into v from public.catalog_variants x2 where x2.id = (l ->> 'variant')::uuid and x2.item_id = it.id and x2.status = 'active';
      if v.id is null then raise exception 'POS_ITEM_INVALID' using errcode = 'P0001', hint = 'variant'; end if;
    elsif exists (select 1 from public.catalog_variants x2 where x2.item_id = it.id and x2.status = 'active') then
      raise exception 'INVENTORY_VARIANT_REQUIRED' using errcode = 'P0001', hint = n::text;
    end if;
    qty := (l ->> 'qty')::numeric;
    if it.kind = 'product' and it.unit in ('unidad', 'unit', 'pieza', 'und', 'u') and qty <> trunc(qty) then raise exception 'POS_QTY_INVALID' using errcode = 'P0001', hint = n::text; end if;
    unit := coalesce(v.price_cents, it.price_cents);
    gross := round(qty * unit)::bigint;
    disc := case when l ? 'discount_pct' then round(gross * (l ->> 'discount_pct')::numeric / 100)::bigint else coalesce((l ->> 'discount_cents')::bigint, 0) end;
    if disc > gross or coalesce((l ->> 'discount_pct')::numeric, 0) > 100 then raise exception 'POS_DISCOUNT_INVALID' using errcode = 'P0001', hint = n::text; end if;
    select t.* into tr from public.pos_item_taxes pit join public.pos_tax_rates t on t.id = pit.tax_rate_id where pit.company_id = target and pit.item_id = it.id;
    if tr.id is not null then rate := tr.rate; tname := tr.name;
    elsif it.tax_rate is not null then rate := it.tax_rate; tname := null;
    elsif deft.id is not null then rate := deft.rate; tname := deft.name;
    else rate := 0; tname := null; end if;
    res := res || jsonb_build_object('line_no', n, 'item', it.id, 'variant', v.id, 'name', it.name || coalesce(' · ' || (select string_agg(value, ' / ') from jsonb_each_text(v.attributes)), ''),
      'sku', coalesce(v.sku, it.code), 'qty', qty, 'unit_price_cents', unit, 'gross_cents', gross, 'line_discount_cents', disc, 'tax_rate', rate, 'tax_name', tname,
      'track_inventory', it.track_inventory and it.kind = 'product');
    sum_gross := sum_gross + gross; sum_net := sum_net + gross - disc;
  end loop;
  -- cart discount
  if cart_discount_pct is not null and (cart_discount_pct < 0 or cart_discount_pct > 100) then raise exception 'POS_DISCOUNT_INVALID' using errcode = 'P0001'; end if;
  cart := coalesce(cart_discount_cents, case when cart_discount_pct is not null then round(sum_net * cart_discount_pct / 100)::bigint else 0 end);
  if cart < 0 or cart > sum_net then raise exception 'POS_DISCOUNT_INVALID' using errcode = 'P0001'; end if;
  -- largest remainder allocation of the cart discount
  arr := '[]'::jsonb;
  for x in select * from jsonb_array_elements(res) loop
    alloc := case when sum_net = 0 then 0 else floor(cart::numeric * ((x ->> 'gross_cents')::bigint - (x ->> 'line_discount_cents')::bigint) / sum_net)::bigint end;
    given := given + alloc;
    arr := arr || (x || jsonb_build_object('cart_alloc', alloc, 'frac',
      case when sum_net = 0 then 0 else (cart::numeric * ((x ->> 'gross_cents')::bigint - (x ->> 'line_discount_cents')::bigint) / sum_net) - alloc end));
  end loop;
  -- give the leftover cents to the largest fractions (ties: first line)
  for rem in select e from jsonb_array_elements(arr) e order by (e ->> 'frac')::numeric desc, (e ->> 'line_no')::int limit (cart - given) loop
    i := (rem ->> 'line_no')::int - 1;
    arr := jsonb_set(arr, array[i::text, 'cart_alloc'], to_jsonb((arr -> i ->> 'cart_alloc')::bigint + 1));
  end loop;
  res := '[]'::jsonb;
  for x in select * from jsonb_array_elements(arr) loop
    disc := (x ->> 'line_discount_cents')::bigint + (x ->> 'cart_alloc')::bigint;
    tax := round(((x ->> 'gross_cents')::bigint - disc) * (x ->> 'tax_rate')::numeric / 100)::bigint;
    tot_tax := tot_tax + tax; tot_disc := tot_disc + disc;
    res := res || ((x - 'frac' - 'cart_alloc' - 'line_discount_cents') || jsonb_build_object('discount_cents', disc, 'tax_cents', tax,
                                                                                         'total_cents', (x ->> 'gross_cents')::bigint - disc + tax));
  end loop;
  return jsonb_build_object('lines', res, 'subtotal_cents', sum_gross, 'discount_cents', tot_disc, 'tax_cents', tot_tax, 'total_cents', sum_gross - tot_disc + tot_tax,
    'discount_pct', case when sum_gross = 0 then 0 else round(tot_disc::numeric * 100 / sum_gross, 2) end);
end $$;

-- a one-time supervisor code: returns the approver, or null (the failure is logged; 5 failures in 10 minutes lock the user out)
create or replace function ba_private.pos_take_approval(target uuid, branch uuid, p_scope text, code text, amount bigint, pct numeric, used text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.pos_approval_codes; me uuid := (select auth.uid());
begin
  if code is null or btrim(code) = '' then return null; end if;
  if (select count(*) from public.pos_events e where e.actor = me and e.action = 'approval_failed' and e.created_at > now() - interval '10 minutes') >= 5 then
    perform ba_private.pos_log(target, 'pos_approval_codes', null, 'approval_locked', jsonb_build_object('scope', p_scope));
    return null;
  end if;
  select * into a from public.pos_approval_codes c where c.code_hash = ba_private.sha_hex(target::text || ':' || btrim(code)) and c.company_id = target for update;
  if a.id is null or a.used_at is not null or a.expires_at < now() or a.scope <> p_scope or (a.branch_id is not null and a.branch_id <> branch)
     or (a.max_cents is not null and coalesce(amount, 0) > a.max_cents) or (a.max_pct is not null and coalesce(pct, 0) > a.max_pct) or a.issued_by = me then
    perform ba_private.pos_log(target, 'pos_approval_codes', a.id::text, 'approval_failed', jsonb_build_object('scope', p_scope));
    return null;
  end if;
  update public.pos_approval_codes set used_at = now(), used_by = me, used_for = left(used, 120) where id = a.id;
  perform ba_private.pos_log(target, 'pos_approval_codes', a.id::text, 'approval_used', jsonb_build_object('scope', p_scope, 'for', used, 'issued_by', a.issued_by));
  return a.issued_by;
end $$;

-- ===================================================================== configuration
create or replace function public.pos_settings_save(target uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform ba_private.pos_require(target, 'pos.manage', null);
  if jsonb_typeof(p) <> 'object' or coalesce(p ->> 'max_discount_pct', '0') !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' or (p ->> 'max_discount_pct')::numeric > 100
     or coalesce(p ->> 'cash_tolerance_cents', '0') !~ '^[0-9]{1,6}$' then
    raise exception 'POS_INVALID' using errcode = 'P0001';
  end if;
  insert into public.pos_settings (company_id, max_discount_pct, require_shift, cash_tolerance_cents, receipt_header, receipt_footer, allow_card_external, updated_by)
  values (target, coalesce((p ->> 'max_discount_pct')::numeric, 0), coalesce((p ->> 'require_shift')::boolean, true), coalesce((p ->> 'cash_tolerance_cents')::bigint, 0),
          nullif(left(btrim(coalesce(p ->> 'receipt_header', '')), 300), ''), nullif(left(btrim(coalesce(p ->> 'receipt_footer', '')), 300), ''),
          coalesce((p ->> 'allow_card_external')::boolean, true), (select auth.uid()))
  on conflict (company_id) do update set max_discount_pct = excluded.max_discount_pct, require_shift = excluded.require_shift, cash_tolerance_cents = excluded.cash_tolerance_cents,
    receipt_header = excluded.receipt_header, receipt_footer = excluded.receipt_footer, allow_card_external = excluded.allow_card_external,
    updated_by = excluded.updated_by, updated_at = now();
  perform ba_private.pos_log(target, 'pos_settings', target::text, 'saved', p);
end $$;

create or replace function public.pos_tax_rate_save(target uuid, rate_id uuid, p_code text, p_name text, p_rate numeric, p_default boolean, archived boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  perform ba_private.pos_require(target, 'pos.manage', null);
  if btrim(coalesce(p_code, '')) !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$' or char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 or p_rate is null or p_rate not between 0 and 100 then
    raise exception 'POS_INVALID' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_pos_tax:' || target::text, 0));
  if coalesce(p_default, false) and not coalesce(archived, false) then
    update public.pos_tax_rates set is_default = false where company_id = target and is_default and id is distinct from rate_id;
  end if;
  if rate_id is null then
    insert into public.pos_tax_rates (company_id, code, name, rate, is_default, created_by) values (target, btrim(p_code), btrim(p_name), p_rate, coalesce(p_default, false), (select auth.uid()))
    returning id into rid;
  else
    -- a rate already used keeps its value in past sales (lines store the rate as sold)
    update public.pos_tax_rates t set code = btrim(p_code), name = btrim(p_name), rate = p_rate, is_default = coalesce(p_default, false) and not coalesce(archived, false),
      archived_at = case when archived then coalesce(t.archived_at, now()) end
     where t.id = rate_id and t.company_id = target returning id into rid;
    if rid is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
    if archived then delete from public.pos_item_taxes where tax_rate_id = rid; end if;
  end if;
  perform ba_private.pos_log(target, 'pos_tax_rates', rid::text, 'saved', jsonb_build_object('code', btrim(p_code), 'rate', p_rate, 'default', p_default, 'archived', archived));
  return rid;
end $$;

create or replace function public.pos_item_tax_set(target uuid, item uuid, rate_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform ba_private.pos_require(target, 'pos.manage', null);
  if not exists (select 1 from public.catalog_items i where i.id = item and i.company_id = target)
     or (rate_id is not null and not exists (select 1 from public.pos_tax_rates t where t.id = rate_id and t.company_id = target and t.archived_at is null)) then
    raise exception 'POS_INVALID' using errcode = 'P0001';
  end if;
  if rate_id is null then delete from public.pos_item_taxes where company_id = target and item_id = item;
  else
    insert into public.pos_item_taxes (company_id, item_id, tax_rate_id, updated_by) values (target, item, rate_id, (select auth.uid()))
    on conflict (company_id, item_id) do update set tax_rate_id = excluded.tax_rate_id, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform ba_private.pos_log(target, 'pos_item_taxes', item::text, 'saved', jsonb_build_object('tax_rate', rate_id));
end $$;

create or replace function public.pos_register_save(target uuid, register uuid, branch uuid, p_code text, p_name text, archived boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  perform ba_private.pos_require(target, 'pos.manage', branch);
  if btrim(coalesce(p_code, '')) !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$' or char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'POS_INVALID' using errcode = 'P0001';
  end if;
  if register is null then
    insert into public.pos_registers (company_id, branch_id, code, name, created_by) values (target, branch, btrim(p_code), btrim(p_name), (select auth.uid())) returning id into rid;
  else
    if archived and exists (select 1 from public.pos_shifts s where s.register_id = register and s.status = 'open') then raise exception 'POS_SHIFT_OPEN' using errcode = 'P0001'; end if;
    update public.pos_registers r set code = btrim(p_code), name = btrim(p_name), branch_id = branch,
      archived_at = case when archived then coalesce(r.archived_at, now()) end
     where r.id = register and r.company_id = target and r.kind = 'native' returning id into rid;
    if rid is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform ba_private.pos_log(target, 'pos_registers', rid::text, 'saved', jsonb_build_object('code', btrim(p_code), 'branch', branch, 'archived', archived));
  return rid;
end $$;

create or replace function public.pos_register_assign(register uuid, p_user uuid, assigned boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.pos_registers;
begin
  select * into r from public.pos_registers x where x.id = register;
  if r.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(r.company_id, 'pos.manage', r.branch_id);
  if assigned then
    if not exists (select 1 from public.memberships m where m.company_id = r.company_id and m.user_id = p_user and m.status = 'active') then raise exception 'POS_INVALID' using errcode = 'P0001'; end if;
    insert into public.pos_register_users (register_id, company_id, user_id, added_by) values (r.id, r.company_id, p_user, (select auth.uid())) on conflict do nothing;
  else
    delete from public.pos_register_users where register_id = r.id and user_id = p_user;
  end if;
  perform ba_private.pos_log(r.company_id, 'pos_registers', r.id::text, case when assigned then 'user_assigned' else 'user_removed' end, jsonb_build_object('user', p_user));
end $$;

-- supervisor code: shown once to the approver, who tells it to the cashier
create or replace function public.pos_approval_issue(target uuid, branch uuid, p_scope text, p_max_cents bigint, p_max_pct numeric, minutes integer default 10)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare code text; cid uuid; tries integer := 0;
begin
  perform ba_private.pos_require(target, 'pos.approve', branch);
  if p_scope not in ('discount', 'void', 'refund', 'cash_out') or coalesce(minutes, 0) not between 1 and 60
     or (p_max_cents is not null and p_max_cents <= 0) or (p_max_pct is not null and p_max_pct not between 0 and 100) then
    raise exception 'POS_INVALID' using errcode = 'P0001';
  end if;
  loop
    tries := tries + 1;
    code := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint % 100000000)::text, 8, '0');
    begin
      insert into public.pos_approval_codes (company_id, branch_id, scope, max_cents, max_pct, code_hash, issued_by, expires_at)
      values (target, branch, p_scope, p_max_cents, p_max_pct, ba_private.sha_hex(target::text || ':' || code), (select auth.uid()), now() + make_interval(mins => minutes))
      returning id into cid;
      exit;
    exception when unique_violation then if tries > 5 then raise; end if;
    end;
  end loop;
  perform ba_private.pos_log(target, 'pos_approval_codes', cid::text, 'issued', jsonb_build_object('scope', p_scope, 'branch', branch, 'max_cents', p_max_cents, 'max_pct', p_max_pct, 'minutes', minutes));
  return jsonb_build_object('id', cid, 'code', code, 'expires_at', now() + make_interval(mins => minutes));
end $$;

-- ===================================================================== shifts and the cash drawer
create or replace function public.pos_shift_open(register uuid, float_cents bigint, idem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.pos_registers; sid uuid; me uuid := (select auth.uid()); num text;
begin
  select * into r from public.pos_registers x where x.id = register;
  if r.id is null or r.archived_at is not null or r.kind <> 'native' then raise exception 'POS_REGISTER_INVALID' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(r.company_id, 'pos.sell', r.branch_id);
  if float_cents is null or float_cents not between 0 and 100000000 or idem is null or idem !~ '^[A-Za-z0-9:_-]{8,80}$' then raise exception 'POS_INVALID' using errcode = 'P0001'; end if;
  select s.id into sid from public.pos_shifts s where s.company_id = r.company_id and s.idem_key = idem;
  if sid is not null then return jsonb_build_object('id', sid, 'already', true); end if;
  if exists (select 1 from public.pos_register_users u where u.register_id = r.id) and not public.has_permission(r.company_id, 'pos.approve')
     and not exists (select 1 from public.pos_register_users u where u.register_id = r.id and u.user_id = me) then
    raise exception 'POS_REGISTER_NOT_ASSIGNED' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_pos_reg:' || r.id::text, 0));
  if exists (select 1 from public.pos_shifts s where s.register_id = r.id and s.status = 'open') then raise exception 'POS_SHIFT_ALREADY_OPEN' using errcode = 'P0001', hint = 'register'; end if;
  if exists (select 1 from public.pos_shifts s where s.company_id = r.company_id and s.cashier_id = me and s.status = 'open') then raise exception 'POS_SHIFT_ALREADY_OPEN' using errcode = 'P0001', hint = 'cashier'; end if;
  num := ba_private.pos_next(r.company_id, 'shift', 'TU');
  insert into public.pos_shifts (company_id, number, branch_id, register_id, cashier_id, opening_float_cents, idem_key)
  values (r.company_id, num, r.branch_id, r.id, me, float_cents, idem) returning id into sid;
  insert into public.pos_cash_movements (company_id, shift_id, kind, amount_cents, reason, created_by) values (r.company_id, sid, 'opening_float', float_cents, 'Fondo inicial', me);
  perform ba_private.pos_log(r.company_id, 'pos_shifts', sid::text, 'opened', jsonb_build_object('register', r.id, 'float_cents', float_cents));
  return jsonb_build_object('id', sid, 'number', num, 'already', false);
end $$;

create or replace function ba_private.pos_expected_cash(shift uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(m.amount_cents), 0)::bigint from public.pos_cash_movements m where m.shift_id = shift
$$;

-- paid in (no approval), paid out and drops to the safe (approval: pos.approve or a cash_out code)
create or replace function public.pos_cash_move(shift uuid, p_kind text, amount bigint, reason text, approval_code text, idem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.pos_shifts; me uuid := (select auth.uid()); approver uuid; mid bigint;
begin
  select * into s from public.pos_shifts x where x.id = shift for update;
  if s.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(s.company_id, 'pos.sell', s.branch_id);
  if p_kind not in ('paid_in', 'paid_out', 'drop') or amount is null or amount not between 1 and 100000000 or idem is null or idem !~ '^[A-Za-z0-9:_-]{8,80}$'
     or reason is null or char_length(btrim(reason)) not between 3 and 300 then
    raise exception 'POS_INVALID' using errcode = 'P0001';
  end if;
  select m.id into mid from public.pos_cash_movements m where m.company_id = s.company_id and m.idem_key = idem;
  if mid is not null then return jsonb_build_object('id', mid, 'already', true); end if;
  if s.status <> 'open' then raise exception 'POS_SHIFT_NOT_OPEN' using errcode = 'P0001'; end if;
  if s.cashier_id <> me and not public.has_permission(s.company_id, 'pos.approve') then raise exception 'POS_NOT_YOUR_SHIFT' using errcode = 'P0001'; end if;
  if p_kind in ('paid_out', 'drop') then
    if public.has_permission(s.company_id, 'pos.approve') then approver := me;
    else
      approver := ba_private.pos_take_approval(s.company_id, s.branch_id, 'cash_out', approval_code, amount, null, 'cash:' || idem);
      if approver is null then return jsonb_build_object('error', 'POS_APPROVAL_REQUIRED'); end if;
    end if;
    if amount > ba_private.pos_expected_cash(s.id) then raise exception 'POS_CASH_INSUFFICIENT' using errcode = 'P0001'; end if;
  end if;
  insert into public.pos_cash_movements (company_id, shift_id, kind, amount_cents, reason, approved_by, idem_key, created_by)
  values (s.company_id, s.id, p_kind, case when p_kind = 'paid_in' then amount else -amount end, btrim(reason), approver, idem, me) returning id into mid;
  perform ba_private.pos_log(s.company_id, 'pos_shifts', s.id::text, p_kind, jsonb_build_object('amount_cents', amount, 'reason', btrim(reason), 'approved_by', approver));
  return jsonb_build_object('id', mid, 'already', false);
end $$;

-- close: the counted cash is recorded as counted; any difference waits for an approver's review
create or replace function public.pos_shift_close(shift uuid, counted bigint, detail jsonb, note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.pos_shifts; me uuid := (select auth.uid()); expected bigint; diff bigint; st text;
begin
  select * into s from public.pos_shifts x where x.id = shift for update;
  if s.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(s.company_id, 'pos.sell', s.branch_id);
  if s.status <> 'open' then raise exception 'POS_SHIFT_NOT_OPEN' using errcode = 'P0001'; end if;
  if s.cashier_id <> me and not public.has_permission(s.company_id, 'pos.approve') then raise exception 'POS_NOT_YOUR_SHIFT' using errcode = 'P0001'; end if;
  if counted is null or counted not between 0 and 1000000000 or (detail is not null and jsonb_typeof(detail) <> 'object') then raise exception 'POS_INVALID' using errcode = 'P0001'; end if;
  expected := ba_private.pos_expected_cash(s.id);
  diff := counted - expected;
  if diff <> 0 and (note is null or char_length(btrim(note)) < 3) then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  st := case when diff = 0 then 'closed' else 'pending_review' end;
  update public.pos_shifts set status = st, closed_at = now(), closed_by = me, expected_cash_cents = expected, counted_cash_cents = counted, difference_cents = diff,
         count_detail = detail, close_note = nullif(left(btrim(coalesce(note, '')), 500), '') where id = s.id;
  perform ba_private.pos_log(s.company_id, 'pos_shifts', s.id::text, 'closed', jsonb_build_object('expected', expected, 'counted', counted, 'difference', diff));
  return jsonb_build_object('status', st, 'expected_cents', expected, 'counted_cents', counted, 'difference_cents', diff);
end $$;

-- review of a difference (another approver; the owner may review their own): posted to cash over / short
create or replace function public.pos_shift_review(shift uuid, note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.pos_shifts; me uuid := (select auth.uid()); eid uuid; acct uuid;
begin
  select * into s from public.pos_shifts x where x.id = shift for update;
  if s.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(s.company_id, 'pos.approve', s.branch_id);
  if s.status <> 'pending_review' then raise exception 'POS_SHIFT_NOT_PENDING' using errcode = 'P0001'; end if;
  if note is null or char_length(btrim(note)) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if s.cashier_id = me and not exists (select 1 from public.memberships m where m.company_id = s.company_id and m.user_id = me and m.role = 'owner' and m.status = 'active') then
    raise exception 'POS_SELF_APPROVAL' using errcode = 'P0001';
  end if;
  acct := ba_private.pos_account(s.company_id, 'cash_over_short');
  eid := public.ledger_post(s.company_id, public.ba_today(), 'Diferencia de caja ' || s.number, s.number, 'pos_cash_difference', s.id,
    case when s.difference_cents < 0
      then jsonb_build_array(jsonb_build_object('key', 'cash_over_short', 'debit', -s.difference_cents), jsonb_build_object('key', 'cash', 'credit', -s.difference_cents))
      else jsonb_build_array(jsonb_build_object('key', 'cash', 'debit', s.difference_cents), jsonb_build_object('key', 'cash_over_short', 'credit', s.difference_cents)) end);
  update public.pos_shifts set status = 'reviewed', reviewed_by = me, reviewed_at = now(), review_note = left(btrim(note), 500), ledger_entry_id = eid where id = s.id;
  perform ba_private.pos_log(s.company_id, 'pos_shifts', s.id::text, 'reviewed', jsonb_build_object('difference', s.difference_cents, 'note', btrim(note), 'entry', eid));
  return jsonb_build_object('status', 'reviewed', 'entry', eid);
end $$;

-- ===================================================================== native sales
-- the server's price of a cart, for the register screen (nothing is written)
create or replace function public.pos_quote(target uuid, lines jsonb, cart_discount_cents bigint default null, cart_discount_pct numeric default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform ba_private.pos_require(target, 'pos.sell', null);
  return ba_private.pos_price(target, lines, cart_discount_cents, cart_discount_pct);
end $$;

/**
 * A sale of the BusinessAI register. payload:
 *   {branch, register, shift, client, lines:[{item, variant, qty, discount_cents|discount_pct}], cart_discount_cents | cart_discount_pct,
 *    discount_reason, approval_code, note, payments:[{method, amount_cents, tendered_cents, reference, card_last4, card_brand}]}
 * Amounts come from the catalog (ba_private.pos_price), never from the browser. Integrated card
 * payments are not accepted here: they need a processor and a terminal (see docs/POS.md).
 */
create or replace function public.pos_sale_create(target uuid, payload jsonb, idem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid()); p jsonb := payload; br uuid; reg public.pos_registers; sh public.pos_shifts; cfg public.pos_settings; pr jsonb; ln jsonb; py jsonb;
  sid uuid; num text; paid bigint := 0; cash_net bigint := 0; approver uuid; s public.pos_sales; client uuid; err text; eid uuid; pid uuid; amt bigint; tend bigint;
begin
  if idem is null or idem !~ '^[A-Za-z0-9:_-]{8,80}$' or jsonb_typeof(p) <> 'object' then raise exception 'POS_INVALID' using errcode = 'P0001', hint = 'idem'; end if;
  br := case when coalesce(p ->> 'branch', '') ~ '^[0-9a-f-]{36}$' then (p ->> 'branch')::uuid end;
  perform ba_private.pos_require(target, 'pos.sell', br);
  perform pg_advisory_xact_lock(hashtextextended('ba_pos_idem:' || target::text || ':' || idem, 0));
  select x.id into sid from public.pos_sales x where x.company_id = target and x.idem_key = idem;
  if sid is not null then return jsonb_build_object('id', sid, 'already', true, 'number', (select number from public.pos_sales where id = sid)); end if;
  select * into cfg from public.pos_settings x where x.company_id = target;
  select * into reg from public.pos_registers x where x.id = case when coalesce(p ->> 'register', '') ~ '^[0-9a-f-]{36}$' then (p ->> 'register')::uuid end and x.company_id = target;
  if reg.id is null or reg.archived_at is not null or reg.branch_id <> br or reg.kind <> 'native' then raise exception 'POS_REGISTER_INVALID' using errcode = 'P0001'; end if;
  if coalesce(p ->> 'shift', '') ~ '^[0-9a-f-]{36}$' then select * into sh from public.pos_shifts x where x.id = (p ->> 'shift')::uuid for update; end if;
  if sh.id is not null and (sh.register_id <> reg.id or sh.status <> 'open' or sh.cashier_id <> me) then raise exception 'POS_SHIFT_NOT_OPEN' using errcode = 'P0001'; end if;
  if sh.id is null and coalesce(cfg.require_shift, true) then raise exception 'POS_SHIFT_REQUIRED' using errcode = 'P0001'; end if;
  if coalesce(p ->> 'client', '') <> '' then
    client := case when p ->> 'client' ~ '^[0-9a-f-]{36}$' then (p ->> 'client')::uuid end;
    if client is null or not exists (select 1 from public.clients c where c.id = client and c.company_id = target) then raise exception 'POS_CLIENT_INVALID' using errcode = 'P0001'; end if;
  end if;
  pr := ba_private.pos_price(target, p -> 'lines',
          case when coalesce(p ->> 'cart_discount_cents', '') ~ '^[0-9]{1,12}$' then (p ->> 'cart_discount_cents')::bigint end,
          case when coalesce(p ->> 'cart_discount_pct', '') ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' then (p ->> 'cart_discount_pct')::numeric end);
  -- discounts above the company's limit need an approver
  if (pr ->> 'discount_cents')::bigint > 0 then
    if (pr ->> 'discount_pct')::numeric > coalesce(cfg.max_discount_pct, 0) and not public.has_permission(target, 'pos.approve') then
      approver := ba_private.pos_take_approval(target, br, 'discount', p ->> 'approval_code', (pr ->> 'discount_cents')::bigint, (pr ->> 'discount_pct')::numeric, 'sale:' || idem);
      if approver is null then return jsonb_build_object('error', 'POS_APPROVAL_REQUIRED', 'discount_pct', pr -> 'discount_pct'); end if;
    elsif public.has_permission(target, 'pos.approve') then approver := me;
    end if;
    if char_length(btrim(coalesce(p ->> 'discount_reason', ''))) < 3 and (pr ->> 'discount_pct')::numeric > coalesce(cfg.max_discount_pct, 0) then
      raise exception 'REASON_REQUIRED' using errcode = 'P0001', hint = 'discount';
    end if;
  end if;
  -- payments: their sum is the total; cash may be tendered above it (change)
  if jsonb_typeof(coalesce(p -> 'payments', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p -> 'payments', '[]'::jsonb)) > 10 then raise exception 'POS_PAYMENTS_INVALID' using errcode = 'P0001'; end if;
  for py in select * from jsonb_array_elements(coalesce(p -> 'payments', '[]'::jsonb)) loop
    if coalesce(py ->> 'method', '') not in ('cash', 'check', 'ath_movil', 'transfer', 'card_external', 'gift_card', 'store_credit', 'other') then
      raise exception 'POS_PAYMENT_METHOD_INVALID' using errcode = 'P0001', hint = case when py ->> 'method' = 'card' then 'card_requires_terminal' else 'method' end;
    end if;
    if py ->> 'method' = 'card_external' and not coalesce(cfg.allow_card_external, true) then raise exception 'POS_PAYMENT_METHOD_INVALID' using errcode = 'P0001', hint = 'card_external'; end if;
    if coalesce(py ->> 'amount_cents', '') !~ '^[0-9]{1,12}$' or (py ->> 'amount_cents')::bigint <= 0 then raise exception 'POS_PAYMENTS_INVALID' using errcode = 'P0001'; end if;
    if py ->> 'method' in ('check', 'ath_movil', 'transfer', 'card_external') and char_length(btrim(coalesce(py ->> 'reference', ''))) < 2 then
      raise exception 'POS_PAYMENT_REFERENCE_REQUIRED' using errcode = 'P0001', hint = py ->> 'method';
    end if;
    if py ->> 'method' = 'cash' and sh.id is null then raise exception 'POS_SHIFT_REQUIRED' using errcode = 'P0001', hint = 'cash'; end if;
    if py ? 'card_last4' and py ->> 'card_last4' is not null and py ->> 'card_last4' !~ '^[0-9]{4}$' then raise exception 'POS_PAYMENTS_INVALID' using errcode = 'P0001', hint = 'last4'; end if;
    paid := paid + (py ->> 'amount_cents')::bigint;
  end loop;
  if paid <> (pr ->> 'total_cents')::bigint then raise exception 'POS_PAYMENTS_MISMATCH' using errcode = 'P0001', hint = format('total=%s paid=%s', pr ->> 'total_cents', paid); end if;

  num := ba_private.pos_next(target, 'sale', 'POS');
  insert into public.pos_sales (company_id, number, source, branch_id, register_id, shift_id, cashier_id, client_id, occurred_at, subtotal_cents, discount_cents, tax_cents,
                                total_cents, discount_reason, discount_approved_by, note, idem_key, created_by, inventory_status)
  values (target, num, 'native', br, reg.id, sh.id, me, client, now(), (pr ->> 'subtotal_cents')::bigint, (pr ->> 'discount_cents')::bigint, (pr ->> 'tax_cents')::bigint,
          (pr ->> 'total_cents')::bigint, nullif(left(btrim(coalesce(p ->> 'discount_reason', '')), 200), ''), approver, nullif(left(btrim(coalesce(p ->> 'note', '')), 500), ''), idem, me,
          case when exists (select 1 from jsonb_array_elements(pr -> 'lines') e where (e ->> 'track_inventory')::boolean) then 'posted' else 'not_required' end)
  returning * into s;
  for ln in select * from jsonb_array_elements(pr -> 'lines') loop
    insert into public.pos_sale_lines (company_id, sale_id, line_no, item_id, variant_id, sku, name, quantity, unit_price_cents, gross_cents, discount_cents, tax_name, tax_rate,
                                       tax_cents, total_cents, track_inventory)
    values (target, s.id, (ln ->> 'line_no')::int, (ln ->> 'item')::uuid, (ln ->> 'variant')::uuid, left(ln ->> 'sku', 60), left(ln ->> 'name', 200), (ln ->> 'qty')::numeric,
            (ln ->> 'unit_price_cents')::bigint, (ln ->> 'gross_cents')::bigint, (ln ->> 'discount_cents')::bigint, ln ->> 'tax_name', (ln ->> 'tax_rate')::numeric,
            (ln ->> 'tax_cents')::bigint, (ln ->> 'total_cents')::bigint, (ln ->> 'track_inventory')::boolean);
  end loop;
  for py in select * from jsonb_array_elements(coalesce(p -> 'payments', '[]'::jsonb)) loop
    amt := (py ->> 'amount_cents')::bigint;
    tend := case when py ->> 'method' = 'cash' and coalesce(py ->> 'tendered_cents', '') ~ '^[0-9]{1,12}$' then (py ->> 'tendered_cents')::bigint end;
    if tend is not null and tend < amt then raise exception 'POS_PAYMENTS_INVALID' using errcode = 'P0001', hint = 'tendered'; end if;
    insert into public.pos_payments (company_id, sale_id, method, amount_cents, tendered_cents, change_cents, reference, status, card_brand, card_last4)
    values (target, s.id, py ->> 'method', amt, tend, coalesce(tend - amt, 0), nullif(left(btrim(coalesce(py ->> 'reference', '')), 120), ''), 'captured',
            case when py ->> 'method' = 'card_external' then nullif(left(btrim(coalesce(py ->> 'card_brand', '')), 30), '') end,
            case when py ->> 'method' = 'card_external' then py ->> 'card_last4' end)
    returning id into pid;
    insert into public.pos_payment_events (company_id, payment_id, kind, amount_cents, actor) values (target, pid, 'captured', amt, me);
    if py ->> 'method' = 'cash' then cash_net := cash_net + amt; end if;
  end loop;
  if cash_net > 0 then
    insert into public.pos_cash_movements (company_id, shift_id, kind, amount_cents, sale_id, created_by) values (target, sh.id, 'sale', cash_net, s.id, me);
  end if;
  err := ba_private.pos_post_inventory(s, true);
  eid := ba_private.pos_post_sale(s);
  update public.pos_sales set ledger_entry_id = eid where id = s.id;
  perform ba_private.pos_log(target, 'pos_sales', s.id::text, 'created', jsonb_build_object('number', num, 'total_cents', s.total_cents, 'discount_cents', s.discount_cents,
    'discount_approved_by', approver));
  return jsonb_build_object('id', s.id, 'number', num, 'already', false, 'total_cents', s.total_cents,
    'change_cents', (select coalesce(sum(change_cents), 0) from public.pos_payments where sale_id = s.id));
end $$;

-- the compensations of a void (shared by the register and by provider events)
create or replace function ba_private.pos_void_apply(s public.pos_sales, reason text, approver uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare l record; cash bigint; orig uuid;
begin
  for l in select * from public.pos_sale_lines sl where sl.sale_id = s.id and sl.movement_id is not null order by sl.line_no loop
    if not exists (select 1 from public.inventory_movements m where m.corrects_id = l.movement_id) then
      perform ba_private.inv_post(s.company_id, s.branch_id, null, l.item_id, l.variant_id, 'correction', l.quantity,
                                  (select m.unit_cost_cents from public.inventory_movements m where m.id = l.movement_id), 'Anulación ' || s.number,
                                  'pos_void', s.id, null, l.movement_id, 'posvoid:' || l.movement_id);
    end if;
  end loop;
  select coalesce(sum(m.amount_cents), 0) into cash from public.pos_cash_movements m where m.sale_id = s.id;
  if cash > 0 and s.shift_id is not null then
    insert into public.pos_cash_movements (company_id, shift_id, kind, amount_cents, reason, sale_id, approved_by, created_by)
    values (s.company_id, s.shift_id, 'void', -cash, left(reason, 300), s.id, approver, (select auth.uid()));
  end if;
  update public.pos_payments set status = 'voided' where sale_id = s.id and status in ('authorized', 'captured');
  insert into public.pos_payment_events (company_id, payment_id, kind, amount_cents, actor)
  select s.company_id, p.id, 'voided', p.amount_cents, (select auth.uid()) from public.pos_payments p where p.sale_id = s.id and p.status = 'voided';
  select e.id into orig from public.journal_entries e where e.company_id = s.company_id and e.source = 'pos_sale' and e.source_id = s.id;
  if orig is not null then
    perform public.ledger_post(s.company_id, greatest(public.ba_today(), (select entry_date from public.journal_entries where id = orig)), 'Anulación ' || s.number, s.number,
                               'pos_sale_void', s.id, public.ledger_mirror_lines(orig), null, orig, left(coalesce(nullif(btrim(reason), ''), 'void'), 300));
  end if;
  update public.pos_sales set status = 'voided', voided_at = now(), voided_by = (select auth.uid()), void_approved_by = approver, void_reason = left(reason, 300) where id = s.id;
end $$;

-- void a native sale of the still-open shift (afterwards: a refund)
create or replace function public.pos_sale_void(sale uuid, reason text, approval_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.pos_sales; me uuid := (select auth.uid()); approver uuid;
begin
  select * into s from public.pos_sales x where x.id = sale for update;
  if s.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(s.company_id, 'pos.sell', s.branch_id);
  if s.status = 'voided' then return jsonb_build_object('already', true); end if;
  if reason is null or char_length(btrim(reason)) not between 3 and 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if s.source <> 'native' then raise exception 'POS_EXTERNAL_SALE' using errcode = 'P0001'; end if;
  if s.status <> 'completed' or s.refunded_cents > 0 then raise exception 'POS_VOID_NOT_ALLOWED' using errcode = 'P0001', hint = 'refunded'; end if;
  if s.shift_id is not null and (select x.status from public.pos_shifts x where x.id = s.shift_id) <> 'open' then raise exception 'POS_VOID_NOT_ALLOWED' using errcode = 'P0001', hint = 'shift_closed'; end if;
  if s.shift_id is null and s.occurred_at < now() - interval '12 hours' then raise exception 'POS_VOID_NOT_ALLOWED' using errcode = 'P0001', hint = 'too_old'; end if;
  if public.has_permission(s.company_id, 'pos.approve') then approver := me;
  else
    approver := ba_private.pos_take_approval(s.company_id, s.branch_id, 'void', approval_code, s.total_cents, null, 'void:' || s.id);
    if approver is null then return jsonb_build_object('error', 'POS_APPROVAL_REQUIRED'); end if;
  end if;
  perform ba_private.pos_void_apply(s, btrim(reason), approver);
  perform ba_private.pos_log(s.company_id, 'pos_sales', s.id::text, 'voided', jsonb_build_object('reason', btrim(reason), 'approved_by', approver));
  return jsonb_build_object('already', false, 'status', 'voided');
end $$;

-- refund lines of a sale: [{line (sale line id), qty}]; amounts in proportion to what was sold (the last unit takes the remainder)
create or replace function ba_private.pos_refund_apply(s public.pos_sales, lines jsonb, p_method text, p_reference text, p_restock boolean, p_reason text, approver uuid,
                                                       shift uuid, p_external text, at_time timestamptz, idem text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  l jsonb; sl public.pos_sale_lines; q numeric; sub bigint; dsc bigint; tx bigint; rid uuid; num text; n integer := 0; mid bigint;
  t_sub bigint := 0; t_dsc bigint := 0; t_tx bigint := 0; done record; amt bigint; eid uuid; rec public.pos_refunds; ln jsonb := '[]'::jsonb;
begin
  if lines is null or jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) not between 1 and 200 then raise exception 'POS_LINES_INVALID' using errcode = 'P0001'; end if;
  num := ba_private.pos_next(s.company_id, 'refund', 'DEV');
  insert into public.pos_refunds (company_id, number, sale_id, branch_id, shift_id, method, reference, subtotal_cents, discount_cents, tax_cents, amount_cents, restock, reason,
                                  approved_by, external_id, idem_key, occurred_at, created_by)
  values (s.company_id, num, s.id, s.branch_id, shift, p_method, nullif(left(btrim(coalesce(p_reference, '')), 120), ''), 1, 0, 0, 1, coalesce(p_restock, true), btrim(p_reason),
          approver, p_external, idem, coalesce(at_time, now()), (select auth.uid()))
  returning id into rid;
  for l in select * from jsonb_array_elements(lines) loop
    n := n + 1;
    if coalesce(l ->> 'line', '') !~ '^[0-9]{1,18}$' or coalesce(l ->> 'qty', '') !~ '^[0-9]{1,7}(\.[0-9]{1,3})?$' or (l ->> 'qty')::numeric <= 0 then
      raise exception 'POS_LINES_INVALID' using errcode = 'P0001', hint = n::text;
    end if;
    select * into sl from public.pos_sale_lines x where x.id = (l ->> 'line')::bigint and x.sale_id = s.id for update;
    if sl.id is null then raise exception 'POS_LINES_INVALID' using errcode = 'P0001', hint = 'line'; end if;
    q := (l ->> 'qty')::numeric;
    if q > sl.quantity - sl.refunded_qty then raise exception 'POS_REFUND_EXCEEDS' using errcode = 'P0001', hint = format('line=%s left=%s', sl.line_no, sl.quantity - sl.refunded_qty); end if;
    select coalesce(sum(r.subtotal_cents), 0) as sub, coalesce(sum(r.discount_cents), 0) as dsc, coalesce(sum(r.tax_cents), 0) as tx into done
      from public.pos_refund_lines r where r.sale_line_id = sl.id;
    if q = sl.quantity - sl.refunded_qty then
      sub := sl.gross_cents - done.sub; dsc := sl.discount_cents - done.dsc; tx := sl.tax_cents - done.tx;
    else
      sub := round(sl.gross_cents * q / sl.quantity)::bigint; dsc := round(sl.discount_cents * q / sl.quantity)::bigint; tx := round(sl.tax_cents * q / sl.quantity)::bigint;
    end if;
    mid := null;
    if sl.track_inventory and sl.movement_id is not null and coalesce(p_restock, true) then
      mid := ba_private.inv_post(s.company_id, s.branch_id, null, sl.item_id, sl.variant_id, 'customer_return', q,
                                 (select m.unit_cost_cents from public.inventory_movements m where m.id = sl.movement_id), 'Devolución ' || num, 'pos_refund', rid, null, null,
                                 'posref:' || rid || ':' || n, coalesce(at_time, now()));
    end if;
    insert into public.pos_refund_lines (company_id, refund_id, sale_line_id, quantity, subtotal_cents, discount_cents, tax_cents, movement_id)
    values (s.company_id, rid, sl.id, q, sub, dsc, tx, mid);
    update public.pos_sale_lines set refunded_qty = refunded_qty + q where id = sl.id;
    t_sub := t_sub + sub; t_dsc := t_dsc + dsc; t_tx := t_tx + tx;
  end loop;
  amt := t_sub - t_dsc + t_tx;
  if amt <= 0 then raise exception 'POS_REFUND_ZERO' using errcode = 'P0001'; end if;
  -- the refund row is completed once its lines are known (amount columns are written once, here)
  perform set_config('ba.pos_refund_fill', rid::text, true);
  update public.pos_refunds set subtotal_cents = t_sub, discount_cents = t_dsc, tax_cents = t_tx, amount_cents = amt where id = rid;
  perform set_config('ba.pos_refund_fill', '', true);
  update public.pos_sales set refunded_cents = refunded_cents + amt,
         status = case when refunded_cents + amt >= total_cents then 'refunded' else 'partially_refunded' end where id = s.id;
  -- payment status (the refunded method first, then any other)
  update public.pos_payments p set refunded_cents = least(p.amount_cents, p.refunded_cents + amt),
         status = case when least(p.amount_cents, p.refunded_cents + amt) >= p.amount_cents then 'refunded' else 'partially_refunded' end
   where p.id = (select x.id from public.pos_payments x where x.sale_id = s.id and x.status in ('captured', 'partially_refunded')
                 order by (x.method = p_method) desc, x.created_at limit 1);
  if shift is not null and p_method = 'cash' then
    insert into public.pos_cash_movements (company_id, shift_id, kind, amount_cents, reason, refund_id, sale_id, approved_by, created_by)
    values (s.company_id, shift, 'refund', -amt, left(p_reason, 300), rid, s.id, approver, (select auth.uid()));
  end if;
  -- ledger: revenue and tax back, money out of cash (cash) or POS funds to deposit (other methods)
  if t_sub - t_dsc > 0 then ln := ln || jsonb_build_object('key', 'sales_revenue', 'debit', t_sub - t_dsc, 'client_id', s.client_id); end if;
  if t_tx > 0 then ln := ln || jsonb_build_object('key', 'sales_tax_payable', 'debit', t_tx, 'client_id', s.client_id); end if;
  perform ba_private.pos_account(s.company_id, 'pos_clearing');
  ln := ln || jsonb_build_object('key', case when p_method = 'cash' then 'cash' else 'pos_clearing' end, 'credit', amt, 'client_id', s.client_id);
  eid := public.ledger_post(s.company_id, public.ba_today(), 'Devolución ' || num || ' · ' || s.number, s.number, 'pos_refund', rid, ln);
  perform set_config('ba.pos_refund_fill', rid::text, true);
  update public.pos_refunds set ledger_entry_id = eid where id = rid;
  perform set_config('ba.pos_refund_fill', '', true);
  return rid;
end $$;

/** Refund (all or part) of a sale: payload {lines:[{line, qty}], method, reference, restock, reason}. Approval: pos.approve or a refund code. */
create or replace function public.pos_refund_create(sale uuid, payload jsonb, approval_code text, idem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.pos_sales; me uuid := (select auth.uid()); approver uuid; sh public.pos_shifts; rid uuid; est bigint := 0; l jsonb; sl public.pos_sale_lines;
begin
  select * into s from public.pos_sales x where x.id = sale for update;
  if s.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(s.company_id, 'pos.sell', s.branch_id);
  if idem is null or idem !~ '^[A-Za-z0-9:_-]{8,80}$' or jsonb_typeof(payload) <> 'object' then raise exception 'POS_INVALID' using errcode = 'P0001'; end if;
  select r.id into rid from public.pos_refunds r where r.company_id = s.company_id and r.idem_key = idem;
  if rid is not null then return jsonb_build_object('id', rid, 'already', true); end if;
  if s.status not in ('completed', 'partially_refunded') then raise exception 'POS_REFUND_NOT_ALLOWED' using errcode = 'P0001', hint = s.status; end if;
  if coalesce(payload ->> 'reason', '') = '' or char_length(btrim(payload ->> 'reason')) not between 3 and 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if coalesce(payload ->> 'method', '') not in ('cash', 'check', 'ath_movil', 'transfer', 'card_external', 'store_credit', 'other') then
    raise exception 'POS_PAYMENT_METHOD_INVALID' using errcode = 'P0001', hint = case when payload ->> 'method' = 'card' then 'card_requires_terminal' else 'method' end;
  end if;
  if payload ->> 'method' in ('ath_movil', 'transfer', 'card_external', 'check') and char_length(btrim(coalesce(payload ->> 'reference', ''))) < 2 then
    raise exception 'POS_PAYMENT_REFERENCE_REQUIRED' using errcode = 'P0001', hint = payload ->> 'method';
  end if;
  if payload ->> 'method' = 'cash' then
    select * into sh from public.pos_shifts x where x.company_id = s.company_id and x.cashier_id = me and x.status = 'open' and x.branch_id = s.branch_id for update;
    if sh.id is null then raise exception 'POS_SHIFT_REQUIRED' using errcode = 'P0001', hint = 'cash'; end if;
  end if;
  -- estimate for the approval limit (the exact amount is computed by pos_refund_apply)
  for l in select * from jsonb_array_elements(case when jsonb_typeof(payload -> 'lines') = 'array' then payload -> 'lines' else '[]'::jsonb end) loop
    select * into sl from public.pos_sale_lines x where x.id = case when coalesce(l ->> 'line', '') ~ '^[0-9]{1,18}$' then (l ->> 'line')::bigint end and x.sale_id = s.id;
    if sl.id is not null and coalesce(l ->> 'qty', '') ~ '^[0-9]{1,7}(\.[0-9]{1,3})?$' then est := est + ceil(sl.total_cents * (l ->> 'qty')::numeric / sl.quantity)::bigint; end if;
  end loop;
  if public.has_permission(s.company_id, 'pos.approve') then approver := me;
  else
    approver := ba_private.pos_take_approval(s.company_id, s.branch_id, 'refund', approval_code, est, null, 'refund:' || idem);
    if approver is null then return jsonb_build_object('error', 'POS_APPROVAL_REQUIRED'); end if;
  end if;
  if payload ->> 'method' = 'cash' and est > ba_private.pos_expected_cash(sh.id) then raise exception 'POS_CASH_INSUFFICIENT' using errcode = 'P0001'; end if;
  rid := ba_private.pos_refund_apply(s, payload -> 'lines', payload ->> 'method', payload ->> 'reference', coalesce((payload ->> 'restock')::boolean, true), payload ->> 'reason',
                                     approver, sh.id, null, now(), idem);
  perform ba_private.pos_log(s.company_id, 'pos_refunds', rid::text, 'created', jsonb_build_object('sale', s.id, 'approved_by', approver, 'method', payload ->> 'method'));
  return jsonb_build_object('id', rid, 'already', false, 'amount_cents', (select amount_cents from public.pos_refunds where id = rid),
                            'number', (select number from public.pos_refunds where id = rid));
end $$;

-- refunds are written once: only the filling step inside pos_refund_apply may complete the row
create or replace function public.pos_refund_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'POS_IMMUTABLE' using errcode = 'P0001', hint = 'pos_refunds';
  end if;
  if current_setting('ba.pos_refund_fill', true) = old.id::text and (new.id, new.sale_id, new.number, new.method, new.reason) = (old.id, old.sale_id, old.number, old.method, old.reason) then
    return new;
  end if;
  raise exception 'POS_IMMUTABLE' using errcode = 'P0001', hint = 'pos_refunds';
end $$;
drop trigger if exists ba_pos_refunds_guard on public.pos_refunds;
create trigger ba_pos_refunds_guard before update or delete on public.pos_refunds for each row execute function public.pos_refund_guard();

-- an approver posts the stock of an imported sale that was blocked (after receiving or adjusting stock)
create or replace function public.pos_sale_post_inventory(sale uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.pos_sales; err text;
begin
  select * into s from public.pos_sales x where x.id = sale for update;
  if s.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(s.company_id, 'pos.approve', s.branch_id);
  if s.inventory_status <> 'blocked' then return jsonb_build_object('status', s.inventory_status, 'already', true); end if;
  if s.status = 'voided' then raise exception 'POS_VOID_NOT_ALLOWED' using errcode = 'P0001'; end if;
  err := ba_private.pos_post_inventory(s, false);
  if err is not null then return jsonb_build_object('error', err); end if;
  update public.pos_sales set inventory_status = 'posted', inventory_error = null where id = s.id;
  perform ba_private.pos_log(s.company_id, 'pos_sales', s.id::text, 'inventory_posted', '{}');
  return jsonb_build_object('status', 'posted', 'already', false);
end $$;

-- ===================================================================== integrations (server-signed)
-- connect / update (user + server signature): payload {provider, environment, external_account_id, display_name, token_ciphertext, key_version, expires_at, settings}
create or replace function public.pos_integration_connect(target uuid, payload text, key text, ts bigint, nonce uuid, mac text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid()); p jsonb; iid uuid;
begin
  perform ba_private.pos_verify(key, concat_ws('|', 'pos_connect', 'v1', key, lower(coalesce(me::text, '')), target::text, ts::text, nonce::text, ba_private.sha_hex(payload)), mac, ts, nonce);
  perform ba_private.pos_require(target, 'pos.manage', null);
  p := payload::jsonb;
  if coalesce(p ->> 'provider', '') not in ('square', 'clover', 'shopify', 'lightspeed_x', 'lightspeed_r', 'bridge')
     or coalesce(p ->> 'environment', '') not in ('sandbox', 'production', 'test_double', 'local') then
    raise exception 'POS_INTEGRATION_INVALID' using errcode = 'P0001';
  end if;
  select i.id into iid from public.pos_integrations i where i.company_id = target and i.provider = p ->> 'provider' and i.external_account_id = p ->> 'external_account_id' and i.status <> 'disconnected';
  if iid is null then
    if exists (select 1 from public.pos_integrations i where i.provider = p ->> 'provider' and i.external_account_id = p ->> 'external_account_id' and i.status <> 'disconnected') then
      raise exception 'POS_INTEGRATION_TAKEN' using errcode = 'P0001';   -- the same merchant account is connected to another company
    end if;
    insert into public.pos_integrations (company_id, provider, environment, display_name, external_account_id, settings, created_by)
    values (target, p ->> 'provider', p ->> 'environment', left(coalesce(nullif(btrim(p ->> 'display_name'), ''), initcap(p ->> 'provider')), 120), nullif(p ->> 'external_account_id', ''),
            coalesce(p -> 'settings', '{}'::jsonb), me) returning id into iid;
  else
    update public.pos_integrations set status = 'active', error_code = null, settings = coalesce(p -> 'settings', settings),
      display_name = left(coalesce(nullif(btrim(p ->> 'display_name'), ''), display_name), 120) where id = iid;
  end if;
  if coalesce(p ->> 'token_ciphertext', '') <> '' then
    insert into ba_private.pos_integration_secrets (integration_id, token_ciphertext, key_version, expires_at)
    values (iid, p ->> 'token_ciphertext', p ->> 'key_version', nullif(p ->> 'expires_at', '')::timestamptz)
    on conflict (integration_id) do update set token_ciphertext = excluded.token_ciphertext, key_version = excluded.key_version, expires_at = excluded.expires_at, updated_at = now();
  end if;
  perform ba_private.pos_log(target, 'pos_integrations', iid::text, 'connected', jsonb_build_object('provider', p ->> 'provider', 'environment', p ->> 'environment'));
  return iid;
end $$;

-- the server's context for a sync: token ciphertext, cursor, mappings (signature, no user needed)
create or replace function public.pos_integration_context(integration uuid, key text, ts bigint, nonce uuid, mac text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.pos_integrations; s ba_private.pos_integration_secrets;
begin
  perform ba_private.pos_verify(key, concat_ws('|', 'pos_ctx', 'v1', key, integration::text, ts::text, nonce::text), mac, ts, nonce);
  select * into i from public.pos_integrations where id = integration;
  if i.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  if (select auth.uid()) is not null and not public.has_permission(i.company_id, 'pos.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into s from ba_private.pos_integration_secrets where integration_id = i.id;
  return jsonb_build_object('company_id', i.company_id, 'provider', i.provider, 'environment', i.environment, 'status', i.status, 'cursor', i.sync_cursor,
    'external_account_id', i.external_account_id, 'settings', i.settings, 'token_ciphertext', s.token_ciphertext, 'key_version', s.key_version,
    'locations', coalesce((select jsonb_object_agg(m.external_location_id, m.branch_id) from public.pos_location_maps m where m.integration_id = i.id), '{}'::jsonb));
end $$;

create or replace function public.pos_integration_disconnect(integration uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.pos_integrations;
begin
  select * into i from public.pos_integrations where id = integration for update;
  if i.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(i.company_id, 'pos.manage', null);
  delete from ba_private.pos_integration_secrets where integration_id = i.id;
  update ba_private.pos_bridge_tokens set revoked_at = now() where integration_id = i.id and revoked_at is null;
  update public.pos_integrations set status = 'disconnected', disconnected_at = now(), disconnected_by = (select auth.uid()) where id = i.id;
  perform ba_private.pos_log(i.company_id, 'pos_integrations', i.id::text, 'disconnected', '{}');
end $$;

create or replace function public.pos_location_map(integration uuid, external_location text, branch uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.pos_integrations;
begin
  select * into i from public.pos_integrations where id = integration;
  if i.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(i.company_id, 'pos.manage', branch);
  if char_length(coalesce(external_location, '')) not between 1 and 200 then raise exception 'POS_INVALID' using errcode = 'P0001'; end if;
  if branch is null then delete from public.pos_location_maps where integration_id = i.id and external_location_id = external_location;
  else
    insert into public.pos_location_maps (integration_id, company_id, external_location_id, branch_id) values (i.id, i.company_id, external_location, branch)
    on conflict (integration_id, external_location_id) do update set branch_id = excluded.branch_id;
  end if;
  perform ba_private.pos_log(i.company_id, 'pos_integrations', i.id::text, 'location_mapped', jsonb_build_object('external', external_location, 'branch', branch));
end $$;

create or replace function public.pos_item_map(integration uuid, p_external_ref text, item uuid, variant uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.pos_integrations;
begin
  select * into i from public.pos_integrations where id = integration;
  if i.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(i.company_id, 'pos.manage', null);
  if char_length(coalesce(p_external_ref, '')) not between 1 and 200 then raise exception 'POS_INVALID' using errcode = 'P0001'; end if;
  if item is null then delete from public.pos_item_maps m where m.integration_id = i.id and m.external_ref = p_external_ref;
  else
    if not exists (select 1 from public.catalog_items c where c.id = item and c.company_id = i.company_id)
       or (variant is not null and not exists (select 1 from public.catalog_variants v where v.id = variant and v.item_id = item)) then
      raise exception 'POS_INVALID' using errcode = 'P0001';
    end if;
    insert into public.pos_item_maps (integration_id, company_id, external_ref, item_id, variant_id, created_by) values (i.id, i.company_id, p_external_ref, item, variant, (select auth.uid()))
    on conflict (integration_id, external_ref) do update set item_id = excluded.item_id, variant_id = excluded.variant_id;
  end if;
  perform ba_private.pos_log(i.company_id, 'pos_integrations', i.id::text, 'item_mapped', jsonb_build_object('external', p_external_ref, 'item', item, 'variant', variant));
end $$;

-- local bridge: a token for the agent next to a traditional register (shown once)
create or replace function public.pos_bridge_token_issue(integration uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare i public.pos_integrations; tok text;
begin
  select * into i from public.pos_integrations where id = integration;
  if i.id is null or i.provider <> 'bridge' or i.status = 'disconnected' then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(i.company_id, 'pos.manage', null);
  tok := 'bapos_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update ba_private.pos_bridge_tokens set revoked_at = now() where integration_id = i.id and revoked_at is null;
  insert into ba_private.pos_bridge_tokens (token_sha, integration_id) values (ba_private.sha_hex(tok), i.id);
  perform ba_private.pos_log(i.company_id, 'pos_integrations', i.id::text, 'bridge_token_issued', '{}');
  return tok;
end $$;
create or replace function public.pos_bridge_resolve(token_sha text, key text, ts bigint, nonce uuid, mac text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare iid uuid;
begin
  perform ba_private.pos_verify(key, concat_ws('|', 'pos_bridge', 'v1', key, token_sha, ts::text, nonce::text), mac, ts, nonce);
  select t.integration_id into iid from ba_private.pos_bridge_tokens t join public.pos_integrations i on i.id = t.integration_id
   where t.token_sha = pos_bridge_resolve.token_sha and t.revoked_at is null and i.status <> 'disconnected';
  if iid is null then raise exception 'POS_BRIDGE_AUTH' using errcode = 'P0001'; end if;
  return iid;
end $$;

-- a provider webhook (no user): idempotent by the provider's event id; tells the server which order to fetch
-- payload: {"account_id","event_type","object_type","object_id","version"}
create or replace function public.pos_webhook_record(provider text, event_key text, payload text, key text, ts bigint, nonce uuid, mac text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare p jsonb; i public.pos_integrations; eid bigint; st text;
begin
  perform ba_private.pos_verify(key, concat_ws('|', 'pos_webhook', 'v1', key, provider, event_key, ts::text, nonce::text, ba_private.sha_hex(payload)), mac, ts, nonce);
  if provider not in ('square', 'clover', 'shopify', 'lightspeed_x', 'lightspeed_r') or char_length(coalesce(event_key, '')) not between 8 and 200 then
    raise exception 'POS_WEBHOOK_INVALID' using errcode = 'P0001';
  end if;
  p := payload::jsonb;
  if exists (select 1 from public.pos_sync_events e where e.provider = provider and e.event_key = event_key) then return jsonb_build_object('already', true); end if;
  select * into i from public.pos_integrations x where x.provider = provider and x.external_account_id = p ->> 'account_id' and x.status <> 'disconnected';
  st := case when i.id is null then 'ignored' else 'received' end;
  insert into public.pos_sync_events (provider, event_key, company_id, integration_id, event_type, object_id, object_version, status, last_error)
  values (provider, event_key, i.company_id, i.id, left(p ->> 'event_type', 80), left(p ->> 'object_id', 200),
          case when coalesce(p ->> 'version', '') ~ '^[0-9]{1,18}$' then (p ->> 'version')::bigint end, st, case when i.id is null then 'unknown_account' end)
  on conflict do nothing returning id into eid;
  if eid is null then return jsonb_build_object('already', true); end if;   -- a concurrent delivery of the same event
  return jsonb_build_object('already', false, 'event_id', eid, 'integration_id', i.id, 'company_id', i.company_id, 'status', st);
end $$;

/**
 * One normalized external sale (validated before anything changes):
 * {external_id, version, state: completed|voided, occurred_at, location_id, register_ref, cashier_ref, currency,
 *  lines:[{external_line_id, item_ref, sku, name, qty, unit_price_cents, discount_cents, tax_cents, tax_rate}],
 *  payments:[{method, amount_cents, provider_payment_id, card_brand, card_last4, status}],
 *  refunds:[{external_id, method, reason, occurred_at, restock, lines:[{external_line_id, qty}]}]}
 * Returns the outcome: created | updated | duplicate | stale | needs_review (with the reason) | ignored.
 */
create or replace function ba_private.pos_ingest_one(i public.pos_integrations, x jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.pos_sales; br uuid; reg uuid; ver bigint; l jsonb; py jsonb; n integer := 0; it public.catalog_items; mp public.pos_item_maps; item uuid; variant uuid;
  sub bigint := 0; dsc bigint := 0; tx bigint := 0; tot bigint; paid bigint := 0; sid uuid; num text; err text; eid uuid; rf jsonb; rl jsonb; lines jsonb; sl record;
  track boolean; refunds integer := 0; occ timestamptz; src text;
begin
  src := case when i.provider in ('csv', 'bridge') then 'import' else 'external' end;
  if coalesce(x ->> 'external_id', '') = '' or char_length(x ->> 'external_id') > 200 then return jsonb_build_object('outcome', 'needs_review', 'error', 'external_id'); end if;
  ver := case when coalesce(x ->> 'version', '') ~ '^[0-9]{1,18}$' then (x ->> 'version')::bigint else 0 end;
  perform pg_advisory_xact_lock(hashtextextended('ba_pos_ext:' || i.id::text || ':' || (x ->> 'external_id'), 0));
  select * into s from public.pos_sales y where y.integration_id = i.id and y.external_id = x ->> 'external_id' for update;
  if s.id is not null then
    if ver < coalesce(s.external_version, 0) then return jsonb_build_object('outcome', 'stale', 'sale_id', s.id); end if;
    -- a newer (or the same) version: only what can change after the sale — a void or new refunds
    if x ->> 'state' = 'voided' and s.status <> 'voided' then
      if s.refunded_cents > 0 then return jsonb_build_object('outcome', 'needs_review', 'error', 'void_after_refund', 'sale_id', s.id); end if;
      update public.pos_sales set external_version = greatest(coalesce(external_version, 0), ver) where id = s.id;
      select * into s from public.pos_sales y where y.id = s.id;
      perform ba_private.pos_void_apply(s, 'Anulada en ' || i.provider, null);
      return jsonb_build_object('outcome', 'updated', 'sale_id', s.id, 'change', 'voided');
    end if;
    for rf in select * from jsonb_array_elements(case when jsonb_typeof(x -> 'refunds') = 'array' then x -> 'refunds' else '[]'::jsonb end) loop
      if coalesce(rf ->> 'external_id', '') = '' or exists (select 1 from public.pos_refunds r where r.sale_id = s.id and r.external_id = rf ->> 'external_id') then continue; end if;
      if s.status = 'voided' then continue; end if;
      lines := '[]'::jsonb;
      for rl in select * from jsonb_array_elements(case when jsonb_typeof(rf -> 'lines') = 'array' then rf -> 'lines' else '[]'::jsonb end) loop
        select y.id into sl from public.pos_sale_lines y where y.sale_id = s.id and y.external_line_id = rl ->> 'external_line_id';
        if sl.id is null then return jsonb_build_object('outcome', 'needs_review', 'error', 'refund_line_unknown', 'sale_id', s.id); end if;
        lines := lines || jsonb_build_object('line', sl.id::text, 'qty', rl ->> 'qty');
      end loop;
      occ := case when coalesce(rf ->> 'occurred_at', '') <> '' then (rf ->> 'occurred_at')::timestamptz end;
      begin
        perform ba_private.pos_refund_apply(s, lines, case when rf ->> 'method' in ('cash', 'check', 'ath_movil', 'transfer', 'card', 'card_external', 'gift_card', 'store_credit', 'other')
                                                            then rf ->> 'method' else 'other' end,
                                           left(rf ->> 'external_id', 120), coalesce((rf ->> 'restock')::boolean, true),
                                           coalesce(nullif(left(btrim(coalesce(rf ->> 'reason', '')), 300), ''), 'Devolución en ' || i.provider), null, null, rf ->> 'external_id', occ, null);
      exception when others then
        return jsonb_build_object('outcome', 'needs_review', 'error', left(sqlerrm, 120), 'sale_id', s.id);
      end;
      select * into s from public.pos_sales y where y.id = s.id;
      refunds := refunds + 1;
    end loop;
    if ver > coalesce(s.external_version, 0) then update public.pos_sales set external_version = ver where id = s.id; end if;
    return jsonb_build_object('outcome', case when refunds > 0 then 'updated' else 'duplicate' end, 'sale_id', s.id, 'refunds', refunds);
  end if;
  if coalesce(x ->> 'state', 'completed') not in ('completed', 'voided') then return jsonb_build_object('outcome', 'ignored', 'error', 'state'); end if;
  if coalesce(x ->> 'state', 'completed') = 'voided' then return jsonb_build_object('outcome', 'ignored', 'error', 'voided_before_import'); end if;
  -- validation (nothing is written when it fails)
  if coalesce(x ->> 'currency', 'USD') <> 'USD' then return jsonb_build_object('outcome', 'needs_review', 'error', 'currency'); end if;
  if coalesce(x ->> 'occurred_at', '') = '' then return jsonb_build_object('outcome', 'needs_review', 'error', 'occurred_at'); end if;
  begin occ := (x ->> 'occurred_at')::timestamptz; exception when others then return jsonb_build_object('outcome', 'needs_review', 'error', 'occurred_at'); end;
  if occ > now() + interval '1 day' or occ < now() - interval '3 years' then return jsonb_build_object('outcome', 'needs_review', 'error', 'occurred_at'); end if;
  select m.branch_id into br from public.pos_location_maps m where m.integration_id = i.id and m.external_location_id = coalesce(x ->> 'location_id', '');
  if br is null then return jsonb_build_object('outcome', 'needs_review', 'error', 'location_unmapped', 'location', x ->> 'location_id'); end if;
  if jsonb_typeof(x -> 'lines') <> 'array' or jsonb_array_length(x -> 'lines') not between 1 and 500 then return jsonb_build_object('outcome', 'needs_review', 'error', 'lines'); end if;
  for l in select * from jsonb_array_elements(x -> 'lines') loop
    if coalesce(l ->> 'qty', '') !~ '^[0-9]{1,7}(\.[0-9]{1,3})?$' or (l ->> 'qty')::numeric <= 0 or coalesce(l ->> 'unit_price_cents', '') !~ '^[0-9]{1,12}$'
       or coalesce(l ->> 'discount_cents', '0') !~ '^[0-9]{1,12}$' or coalesce(l ->> 'tax_cents', '0') !~ '^[0-9]{1,12}$' or char_length(btrim(coalesce(l ->> 'name', ''))) = 0 then
      return jsonb_build_object('outcome', 'needs_review', 'error', 'line_invalid');
    end if;
    sub := sub + round((l ->> 'qty')::numeric * (l ->> 'unit_price_cents')::bigint)::bigint;
    dsc := dsc + coalesce((l ->> 'discount_cents')::bigint, 0); tx := tx + coalesce((l ->> 'tax_cents')::bigint, 0);
    if coalesce((l ->> 'discount_cents')::bigint, 0) > round((l ->> 'qty')::numeric * (l ->> 'unit_price_cents')::bigint) then return jsonb_build_object('outcome', 'needs_review', 'error', 'line_discount'); end if;
  end loop;
  tot := sub - dsc + tx;
  if coalesce(x ->> 'total_cents', '') ~ '^[0-9]{1,12}$' and (x ->> 'total_cents')::bigint <> tot then return jsonb_build_object('outcome', 'needs_review', 'error', 'totals_mismatch', 'computed', tot); end if;
  for py in select * from jsonb_array_elements(case when jsonb_typeof(x -> 'payments') = 'array' then x -> 'payments' else '[]'::jsonb end) loop
    if coalesce(py ->> 'amount_cents', '') !~ '^[0-9]{1,12}$' or coalesce(py ->> 'method', '') not in ('cash', 'check', 'ath_movil', 'transfer', 'card', 'card_external', 'gift_card', 'store_credit', 'other')
       or (py ->> 'card_last4' is not null and py ->> 'card_last4' !~ '^[0-9]{4}$') then
      return jsonb_build_object('outcome', 'needs_review', 'error', 'payment_invalid');
    end if;
    if coalesce(py ->> 'status', 'captured') = 'captured' then paid := paid + (py ->> 'amount_cents')::bigint; end if;
    if py ->> 'provider_payment_id' is not null and exists (select 1 from public.pos_payments p where p.provider = i.provider and p.provider_payment_id = py ->> 'provider_payment_id') then
      return jsonb_build_object('outcome', 'needs_review', 'error', 'payment_duplicate');
    end if;
  end loop;
  if paid <> tot then return jsonb_build_object('outcome', 'needs_review', 'error', 'payments_mismatch', 'computed', tot, 'paid', paid); end if;
  -- every line resolved to the catalog before anything is written (mapping, then barcode / SKU / code)
  lines := '[]'::jsonb;
  for l in select * from jsonb_array_elements(x -> 'lines') loop
    n := n + 1; item := null; variant := null; track := false;
    select * into mp from public.pos_item_maps m where m.integration_id = i.id and m.external_ref = coalesce(l ->> 'item_ref', '');
    if mp.item_id is not null then item := mp.item_id; variant := mp.variant_id;
    elsif coalesce(l ->> 'sku', '') <> '' then
      select b.item_id, b.variant_id into item, variant from public.catalog_barcodes b where b.company_id = i.company_id and upper(b.code) = upper(btrim(l ->> 'sku')) limit 1;
      if item is null then select v.item_id, v.id into item, variant from public.catalog_variants v where v.company_id = i.company_id and lower(v.sku) = lower(btrim(l ->> 'sku')); end if;
      if item is null then select c.id into item from public.catalog_items c where c.company_id = i.company_id and lower(c.code) = lower(btrim(l ->> 'sku')); end if;
    end if;
    if item is not null then
      select * into it from public.catalog_items c where c.id = item;
      track := it.kind = 'product' and it.track_inventory;
      if track and variant is null and exists (select 1 from public.catalog_variants v where v.item_id = item and v.status = 'active') then
        return jsonb_build_object('outcome', 'needs_review', 'error', 'variant_required', 'line', n, 'sku', l ->> 'sku');
      end if;
    elsif coalesce((l ->> 'catalog_required')::boolean, true) and coalesce(l ->> 'item_ref', l ->> 'sku', '') <> '' then
      -- a product of the provider that BusinessAI does not know: map it first (no stock is guessed)
      return jsonb_build_object('outcome', 'needs_review', 'error', 'item_unmapped', 'line', n, 'item_ref', l ->> 'item_ref', 'sku', l ->> 'sku', 'name', left(l ->> 'name', 120));
    end if;
    lines := lines || (l || jsonb_build_object('n', n, 'item', item, 'variant', variant, 'track', track));
  end loop;
  if coalesce(x ->> 'register_ref', '') <> '' then
    select r.id into reg from public.pos_registers r where r.integration_id = i.id and r.external_ref = x ->> 'register_ref';
    if reg is null then
      insert into public.pos_registers (company_id, branch_id, code, name, kind, integration_id, external_ref)
      values (i.company_id, br, left(upper(regexp_replace(i.provider, '[^a-z]', '', 'g')), 6) || '-' || substr(md5(i.id::text || (x ->> 'register_ref')), 1, 8),
              left(initcap(i.provider) || ' · ' || (x ->> 'register_ref'), 80), 'external', i.id, x ->> 'register_ref')
      on conflict do nothing returning id into reg;
      if reg is null then select r.id into reg from public.pos_registers r where r.integration_id = i.id and r.external_ref = x ->> 'register_ref'; end if;
    end if;
  end if;
  num := ba_private.pos_next(i.company_id, 'sale', 'POS');
  insert into public.pos_sales (company_id, number, source, integration_id, external_id, external_version, branch_id, register_id, cashier_ref, occurred_at,
                                subtotal_cents, discount_cents, tax_cents, total_cents, inventory_status, note)
  values (i.company_id, num, src, i.id, x ->> 'external_id', ver, br, reg, nullif(left(btrim(coalesce(x ->> 'cashier_ref', '')), 120), ''), occ, sub, dsc, tx, tot,
          case when exists (select 1 from jsonb_array_elements(lines) e where (e ->> 'track')::boolean) then 'posted' else 'not_required' end,
          nullif(left(btrim(coalesce(x ->> 'note', '')), 500), ''))
  returning * into s;
  for l in select * from jsonb_array_elements(lines) loop
    insert into public.pos_sale_lines (company_id, sale_id, line_no, item_id, variant_id, external_line_id, sku, name, quantity, unit_price_cents, gross_cents, discount_cents,
                                       tax_rate, tax_cents, total_cents, track_inventory)
    values (i.company_id, s.id, (l ->> 'n')::int, (l ->> 'item')::uuid, (l ->> 'variant')::uuid, left(l ->> 'external_line_id', 200), left(nullif(btrim(coalesce(l ->> 'sku', '')), ''), 60),
            left(btrim(l ->> 'name'), 200), (l ->> 'qty')::numeric, (l ->> 'unit_price_cents')::bigint,
            round((l ->> 'qty')::numeric * (l ->> 'unit_price_cents')::bigint)::bigint, coalesce((l ->> 'discount_cents')::bigint, 0),
            least(100, greatest(0, coalesce(case when coalesce(l ->> 'tax_rate', '') ~ '^[0-9]{1,3}(\.[0-9]{1,3})?$' then (l ->> 'tax_rate')::numeric end, 0))),
            coalesce((l ->> 'tax_cents')::bigint, 0),
            round((l ->> 'qty')::numeric * (l ->> 'unit_price_cents')::bigint)::bigint - coalesce((l ->> 'discount_cents')::bigint, 0) + coalesce((l ->> 'tax_cents')::bigint, 0),
            (l ->> 'track')::boolean);
  end loop;
  for py in select * from jsonb_array_elements(case when jsonb_typeof(x -> 'payments') = 'array' then x -> 'payments' else '[]'::jsonb end) loop
    if coalesce(py ->> 'status', 'captured') <> 'captured' then continue; end if;
    insert into public.pos_payments (company_id, sale_id, method, amount_cents, reference, status, provider, provider_payment_id, card_brand, card_last4)
    values (i.company_id, s.id, py ->> 'method', (py ->> 'amount_cents')::bigint, left(nullif(py ->> 'reference', ''), 120), 'captured', i.provider,
            left(nullif(py ->> 'provider_payment_id', ''), 200), left(nullif(regexp_replace(coalesce(py ->> 'card_brand', ''), '[^A-Za-z_ ]', '', 'g'), ''), 30), py ->> 'card_last4')
    returning id into sid;
    insert into public.pos_payment_events (company_id, payment_id, kind, amount_cents, provider_event_id) values (i.company_id, sid, 'captured', (py ->> 'amount_cents')::bigint, left(py ->> 'provider_payment_id', 200));
  end loop;
  err := ba_private.pos_post_inventory(s, false);
  if err is not null then
    update public.pos_sales set inventory_status = 'blocked', inventory_error = err where id = s.id;
  end if;
  eid := ba_private.pos_post_sale(s);
  update public.pos_sales set ledger_entry_id = eid where id = s.id;
  -- refunds already present in the first version
  if jsonb_typeof(x -> 'refunds') = 'array' and jsonb_array_length(x -> 'refunds') > 0 then
    perform ba_private.pos_ingest_one(i, x || jsonb_build_object('version', ver));
  end if;
  perform ba_private.pos_log(i.company_id, 'pos_sales', s.id::text, 'imported', jsonb_build_object('provider', i.provider, 'external_id', x ->> 'external_id', 'inventory', coalesce(err, 'ok')));
  return jsonb_build_object('outcome', 'created', 'sale_id', s.id, 'inventory', coalesce(err, 'ok'));
end $$;

-- one sale inside its own savepoint, with its sync event (idempotent per provider + key)
create or replace function ba_private.pos_ingest_record(i public.pos_integrations, x jsonb, event_id bigint, trig text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb; ek text; st text; eid bigint := event_id;
begin
  begin
    r := ba_private.pos_ingest_one(i, x);
  exception when others then
    r := jsonb_build_object('outcome', 'failed', 'error', left(sqlerrm, 200));
  end;
  st := case r ->> 'outcome' when 'created' then 'applied' when 'updated' then 'applied' when 'duplicate' then 'duplicate' when 'stale' then 'stale'
                             when 'ignored' then 'ignored' when 'needs_review' then 'needs_review' else 'failed' end;
  if eid is null then
    ek := 'sale:' || left(coalesce(x ->> 'external_id', 'none'), 150) || ':' || coalesce(x ->> 'version', '0') || ':' || left(ba_private.sha_hex(x::text), 16);
    insert into public.pos_sync_events (provider, event_key, company_id, integration_id, event_type, object_id, object_version, status)
    values (i.provider, ek, i.company_id, i.id, trig, left(x ->> 'external_id', 200), case when coalesce(x ->> 'version', '') ~ '^[0-9]{1,18}$' then (x ->> 'version')::bigint end, 'received')
    on conflict (provider, event_key) do update set status = public.pos_sync_events.status returning id into eid;
  end if;
  update public.pos_sync_events e set status = st, attempts = e.attempts + 1, processed_at = now(), sale_id = coalesce((r ->> 'sale_id')::uuid, e.sale_id),
         last_error = case when st in ('applied', 'duplicate') then null else left(r ->> 'error', 300) end,
         next_attempt_at = case when st = 'failed' then now() + make_interval(mins => (2 ^ least(e.attempts, 8))::int) end,
         object_id = coalesce(e.object_id, left(x ->> 'external_id', 200))
   where e.id = eid;
  update public.pos_sync_events e set status = 'dead' where e.id = eid and e.status = 'failed' and e.attempts >= 8;
  return r || jsonb_build_object('event_id', eid);
end $$;

-- a batch of sales from a sync (server-signed; a signed-in caller also needs pos.manage)
-- payload: {"trigger","status","error_code","cursor","sales":[{...normalized sale..., "event_id"}]}
create or replace function public.pos_ingest_batch(integration uuid, payload text, key text, ts bigint, nonce uuid, mac text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.pos_integrations; p jsonb; x jsonb; r jsonb; c jsonb := '{}'::jsonb; res jsonb := '[]'::jsonb; ok boolean; k text; rid uuid := gen_random_uuid();
begin
  perform ba_private.pos_verify(key, concat_ws('|', 'pos_ingest', 'v1', key, integration::text, ts::text, nonce::text, ba_private.sha_hex(payload)), mac, ts, nonce);
  select * into i from public.pos_integrations where id = integration for update;
  if i.id is null or i.status = 'disconnected' then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  if (select auth.uid()) is not null and not public.has_permission(i.company_id, 'pos.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  p := payload::jsonb;
  if coalesce(p ->> 'trigger', '') not in ('manual', 'webhook', 'scheduled', 'recovery', 'bridge') or coalesce(p ->> 'status', 'succeeded') not in ('succeeded', 'failed')
     or (p ? 'sales' and jsonb_typeof(p -> 'sales') <> 'array') or jsonb_array_length(coalesce(p -> 'sales', '[]'::jsonb)) > 500 then
    raise exception 'POS_SYNC_INVALID' using errcode = 'P0001';
  end if;
  ok := coalesce(p ->> 'status', 'succeeded') = 'succeeded';
  for x in select * from jsonb_array_elements(coalesce(p -> 'sales', '[]'::jsonb)) loop
    r := ba_private.pos_ingest_record(i, x - 'event_id', case when coalesce(x ->> 'event_id', '') ~ '^[0-9]{1,18}$'
           and exists (select 1 from public.pos_sync_events e where e.id = (x ->> 'event_id')::bigint and e.integration_id = i.id) then (x ->> 'event_id')::bigint end, p ->> 'trigger');
    k := r ->> 'outcome';
    c := c || jsonb_build_object(k, coalesce((c ->> k)::int, 0) + 1);
    res := res || jsonb_build_object('external_id', x ->> 'external_id', 'outcome', k, 'error', r ->> 'error', 'sale_id', r ->> 'sale_id');
  end loop;
  insert into public.pos_sync_runs (id, company_id, integration_id, trigger, status, received, created, updated, duplicates, stale, needs_review, failed, error_code, actor)
  values (rid, i.company_id, i.id, p ->> 'trigger', case when not ok then 'failed' when coalesce((c ->> 'failed')::int, 0) + coalesce((c ->> 'needs_review')::int, 0) > 0 then 'partial' else 'succeeded' end,
          jsonb_array_length(coalesce(p -> 'sales', '[]'::jsonb)), coalesce((c ->> 'created')::int, 0), coalesce((c ->> 'updated')::int, 0), coalesce((c ->> 'duplicate')::int, 0),
          coalesce((c ->> 'stale')::int, 0), coalesce((c ->> 'needs_review')::int, 0), coalesce((c ->> 'failed')::int, 0), left(nullif(p ->> 'error_code', ''), 100), (select auth.uid()));
  update public.pos_integrations set last_sync_at = now(), last_success_at = case when ok then now() else last_success_at end,
         sync_cursor = case when ok and p ? 'cursor' then left(p ->> 'cursor', 2000) else sync_cursor end,
         status = case when ok and status in ('error', 'login_required') then 'active' when not ok and p ->> 'error_code' = 'login_required' then 'login_required'
                       when not ok then 'error' else status end,
         error_code = case when ok then null else left(nullif(p ->> 'error_code', ''), 100) end
   where id = i.id;
  return jsonb_build_object('run', rid, 'counts', c, 'results', res);
end $$;

-- events to retry (failed, due) for the server's recovery job (signed)
create or replace function public.pos_sync_due(key text, ts bigint, nonce uuid, mac text, max_rows integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ba_private.pos_verify(key, concat_ws('|', 'pos_due', 'v1', key, ts::text, nonce::text), mac, ts, nonce);
  return coalesce((select jsonb_agg(jsonb_build_object('event_id', e.id, 'integration_id', e.integration_id, 'provider', e.provider, 'object_id', e.object_id, 'attempts', e.attempts))
                   from (select * from public.pos_sync_events e where ((e.status = 'failed' and e.next_attempt_at <= now()) or (e.status = 'received' and e.received_at < now() - interval '5 minutes'))
                         and e.integration_id is not null order by e.id limit least(coalesce(max_rows, 100), 500)) e), '[]'::jsonb);
end $$;

-- a user asks to retry one event (failed / needs review after fixing a mapping): due now
create or replace function public.pos_sync_retry(event bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.pos_sync_events;
begin
  select * into e from public.pos_sync_events x where x.id = event for update;
  if e.id is null or e.company_id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(e.company_id, 'pos.manage', null);
  if e.status not in ('failed', 'needs_review', 'dead') then raise exception 'POS_SYNC_NOT_RETRYABLE' using errcode = 'P0001'; end if;
  update public.pos_sync_events set status = 'failed', next_attempt_at = now(), attempts = least(attempts, 7) where id = e.id;
  perform ba_private.pos_log(e.company_id, 'pos_sync_events', e.id::text, 'retry_requested', '{}');
end $$;

-- CSV / exported files of traditional registers (signed-in user with pos.manage; the file is parsed by the server)
create or replace function public.pos_import_sales(target uuid, integration uuid, p_file_name text, p_file_sha text, sales jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.pos_integrations; x jsonb; r jsonb; c jsonb := '{}'::jsonb; res jsonb := '[]'::jsonb; k text; rid uuid := gen_random_uuid();
begin
  perform ba_private.pos_require(target, 'pos.manage', null);
  if coalesce(p_file_sha, '') !~ '^[0-9a-f]{64}$' or jsonb_typeof(sales) <> 'array' or jsonb_array_length(sales) not between 1 and 2000 then raise exception 'POS_IMPORT_INVALID' using errcode = 'P0001'; end if;
  if integration is null then
    select * into i from public.pos_integrations x2 where x2.company_id = target and x2.provider = 'csv' and x2.status <> 'disconnected' order by created_at limit 1;
    if i.id is null then
      insert into public.pos_integrations (company_id, provider, environment, display_name, created_by) values (target, 'csv', 'file', 'Archivos CSV', (select auth.uid())) returning * into i;
    end if;
  else
    select * into i from public.pos_integrations x2 where x2.id = integration and x2.company_id = target and x2.provider in ('csv', 'bridge') and x2.status <> 'disconnected';
    if i.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_pos_file:' || i.id::text || ':' || p_file_sha, 0));
  if exists (select 1 from public.pos_sync_runs r2 where r2.integration_id = i.id and r2.file_sha256 = p_file_sha) then
    return jsonb_build_object('already', true, 'integration', i.id);
  end if;
  for x in select * from jsonb_array_elements(sales) loop
    r := ba_private.pos_ingest_record(i, x, null, 'import');
    k := r ->> 'outcome';
    c := c || jsonb_build_object(k, coalesce((c ->> k)::int, 0) + 1);
    res := res || jsonb_build_object('external_id', x ->> 'external_id', 'outcome', k, 'error', r ->> 'error');
  end loop;
  insert into public.pos_sync_runs (id, company_id, integration_id, trigger, status, received, created, updated, duplicates, stale, needs_review, failed, file_name, file_sha256, actor)
  values (rid, target, i.id, 'import', case when coalesce((c ->> 'failed')::int, 0) + coalesce((c ->> 'needs_review')::int, 0) > 0 then 'partial' else 'succeeded' end,
          jsonb_array_length(sales), coalesce((c ->> 'created')::int, 0), coalesce((c ->> 'updated')::int, 0), coalesce((c ->> 'duplicate')::int, 0), coalesce((c ->> 'stale')::int, 0),
          coalesce((c ->> 'needs_review')::int, 0), coalesce((c ->> 'failed')::int, 0), left(btrim(coalesce(p_file_name, '')), 200), p_file_sha, (select auth.uid()));
  update public.pos_integrations set last_sync_at = now(), last_success_at = now() where id = i.id;
  perform ba_private.pos_log(target, 'pos_sync_runs', rid::text, 'imported', jsonb_build_object('file', p_file_name, 'counts', c));
  return jsonb_build_object('already', false, 'integration', i.id, 'run', rid, 'counts', c, 'results', res);
end $$;

-- ===================================================================== settlements and reconciliation
-- a processor payout (server-signed): {payout_id, payout_date, gross_cents, fees_cents, net_cents, status, payment_ids:[provider payment ids]}
create or replace function public.pos_settlement_record(integration uuid, payload text, key text, ts bigint, nonce uuid, mac text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.pos_integrations; p jsonb; st public.pos_settlements; n integer := 0; pid text; pay public.pos_payments;
begin
  perform ba_private.pos_verify(key, concat_ws('|', 'pos_settle', 'v1', key, integration::text, ts::text, nonce::text, ba_private.sha_hex(payload)), mac, ts, nonce);
  select * into i from public.pos_integrations where id = integration;
  if i.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  if (select auth.uid()) is not null and not public.has_permission(i.company_id, 'pos.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  p := payload::jsonb;
  if coalesce(p ->> 'payout_id', '') = '' or coalesce(p ->> 'payout_date', '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p ->> 'gross_cents', '') !~ '^[0-9]{1,12}$'
     or coalesce(p ->> 'fees_cents', '0') !~ '^[0-9]{1,12}$' or coalesce(p ->> 'status', '') not in ('pending', 'in_transit', 'paid', 'failed')
     or (p ->> 'gross_cents')::bigint - coalesce((p ->> 'fees_cents')::bigint, 0) <> coalesce((p ->> 'net_cents')::bigint, -1) then
    raise exception 'POS_SETTLEMENT_INVALID' using errcode = 'P0001';
  end if;
  insert into public.pos_settlements (company_id, integration_id, provider_payout_id, payout_date, gross_cents, fees_cents, net_cents, status)
  values (i.company_id, i.id, left(p ->> 'payout_id', 200), (p ->> 'payout_date')::date, (p ->> 'gross_cents')::bigint, coalesce((p ->> 'fees_cents')::bigint, 0), (p ->> 'net_cents')::bigint, p ->> 'status')
  on conflict (integration_id, provider_payout_id) do update set status = case when public.pos_settlements.bank_line_id is null then excluded.status else public.pos_settlements.status end
  returning * into st;
  for pid in select jsonb_array_elements_text(case when jsonb_typeof(p -> 'payment_ids') = 'array' then p -> 'payment_ids' else '[]'::jsonb end) loop
    select * into pay from public.pos_payments x where x.provider = i.provider and x.provider_payment_id = pid and x.company_id = i.company_id for update;
    if pay.id is not null and pay.settlement_id is null then
      update public.pos_payments set settlement_id = st.id where id = pay.id;
      insert into public.pos_payment_events (company_id, payment_id, kind, amount_cents, provider_event_id) values (i.company_id, pay.id, 'settled', pay.amount_cents, left(p ->> 'payout_id', 200));
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('settlement', st.id, 'payments_linked', n);
end $$;

-- the payout reached the bank: Dr bank (net) + Dr processor fees, Cr POS funds to deposit (gross); the bank line is matched
create or replace function public.pos_settlement_reconcile(settlement uuid, line uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare st public.pos_settlements; bl public.bank_lines; ba public.bank_accounts; eid uuid; jl bigint; ln jsonb; gid uuid;
begin
  select * into st from public.pos_settlements x where x.id = settlement for update;
  if st.id is null then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.pos_require(st.company_id, 'pos.manage', null);
  if not public.has_permission(st.company_id, 'bank.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if st.bank_line_id is not null then return jsonb_build_object('already', true, 'entry', st.ledger_entry_id); end if;
  select * into bl from public.bank_lines x where x.id = line and x.company_id = st.company_id;
  if bl.id is null or bl.status <> 'unmatched' then raise exception 'BANK_LINE_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if bl.amount_cents <> st.net_cents then raise exception 'POS_SETTLEMENT_AMOUNT' using errcode = 'P0001', hint = format('bank=%s net=%s', bl.amount_cents, st.net_cents); end if;
  select * into ba from public.bank_accounts x where x.id = bl.bank_account_id;
  perform ba_private.pos_account(st.company_id, 'pos_clearing');
  ln := jsonb_build_array(jsonb_build_object('account', ba.ledger_account_id, 'debit', st.net_cents));
  if st.fees_cents > 0 then perform ba_private.pos_account(st.company_id, 'processor_fees'); ln := ln || jsonb_build_object('key', 'processor_fees', 'debit', st.fees_cents); end if;
  ln := ln || jsonb_build_object('key', 'pos_clearing', 'credit', st.gross_cents);
  eid := public.ledger_post(st.company_id, bl.txn_date, 'Liquidación ' || st.provider_payout_id, left(st.provider_payout_id, 100), 'pos_settlement', st.id, ln);
  select l.id into jl from public.journal_lines l where l.entry_id = eid and l.account_id = ba.ledger_account_id and l.debit_cents = st.net_cents;
  gid := public.bank_match(array[bl.id], array[jl], 'Liquidación del procesador ' || st.provider_payout_id, 'manual', null);
  update public.pos_settlements set bank_line_id = bl.id, ledger_entry_id = eid, reconciled_at = now(), reconciled_by = (select auth.uid()), status = 'paid' where id = st.id;
  perform ba_private.pos_log(st.company_id, 'pos_settlements', st.id::text, 'reconciled', jsonb_build_object('bank_line', bl.id, 'entry', eid, 'match', gid));
  return jsonb_build_object('already', false, 'entry', eid, 'match', gid);
end $$;

-- ===================================================================== reports (confirmed sales only; voided excluded; refunds subtracted)
create or replace function public.pos_report(target uuid, p_from date, p_to date, branch uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public.has_permission(target, 'pos.view') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'POS_INVALID' using errcode = 'P0001'; end if;
  if branch is not null and not public.pos_branch_ok(target, branch) then raise exception 'BRANCH_FORBIDDEN' using errcode = 'P0001'; end if;
  with s as (
    select x.* from public.pos_sales x
    where x.company_id = target and x.status <> 'voided' and (x.occurred_at at time zone 'America/Puerto_Rico')::date between p_from and p_to
      and (branch is null or x.branch_id = branch) and public.pos_branch_ok(target, x.branch_id)
  ), rf as (
    select r.* from public.pos_refunds r join public.pos_sales x on x.id = r.sale_id
    where r.company_id = target and (r.occurred_at at time zone 'America/Puerto_Rico')::date between p_from and p_to
      and (branch is null or r.branch_id = branch) and public.pos_branch_ok(target, r.branch_id)
  ), v as (
    select x.* from public.pos_sales x
    where x.company_id = target and x.status = 'voided' and (x.occurred_at at time zone 'America/Puerto_Rico')::date between p_from and p_to
      and (branch is null or x.branch_id = branch) and public.pos_branch_ok(target, x.branch_id)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'totals', jsonb_build_object('sales', (select count(*) from s), 'gross_cents', (select coalesce(sum(subtotal_cents), 0) from s),
       'discount_cents', (select coalesce(sum(discount_cents), 0) from s), 'tax_cents', (select coalesce(sum(tax_cents), 0) from s),
       'total_cents', (select coalesce(sum(total_cents), 0) from s), 'refunds', (select count(*) from rf), 'refunded_cents', (select coalesce(sum(amount_cents), 0) from rf),
       'refunded_tax_cents', (select coalesce(sum(tax_cents), 0) from rf),
       'net_cents', (select coalesce(sum(total_cents), 0) from s) - (select coalesce(sum(amount_cents), 0) from rf),
       'voided', (select count(*) from v), 'voided_cents', (select coalesce(sum(total_cents), 0) from v)),
    'daily', coalesce((select jsonb_agg(d order by d ->> 'day') from (
        select jsonb_build_object('day', (occurred_at at time zone 'America/Puerto_Rico')::date, 'sales', count(*), 'total_cents', sum(total_cents), 'tax_cents', sum(tax_cents),
                                  'discount_cents', sum(discount_cents)) d
        from s group by (occurred_at at time zone 'America/Puerto_Rico')::date) q), '[]'::jsonb),
    'by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch_id', branch_id, 'sales', n, 'total_cents', t)) from (
        select branch_id, count(*) n, sum(total_cents) t from s group by branch_id) q), '[]'::jsonb),
    'by_cashier', coalesce((select jsonb_agg(jsonb_build_object('cashier_id', cashier_id, 'cashier_ref', cashier_ref, 'sales', n, 'total_cents', t, 'discount_cents', dd)) from (
        select cashier_id, cashier_ref, count(*) n, sum(total_cents) t, sum(discount_cents) dd from s group by cashier_id, cashier_ref) q), '[]'::jsonb),
    'top_products', coalesce((select jsonb_agg(q order by (q ->> 'net_cents')::bigint desc) from (
        select jsonb_build_object('item_id', l.item_id, 'variant_id', l.variant_id, 'name', min(l.name), 'qty', sum(l.quantity - l.refunded_qty),
                                  'net_cents', sum(l.gross_cents - l.discount_cents)) q
        from public.pos_sale_lines l join s on s.id = l.sale_id group by l.item_id, l.variant_id, case when l.item_id is null then l.name end
        order by sum(l.gross_cents - l.discount_cents) desc limit 20) z), '[]'::jsonb),
    'payment_methods', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'count', n, 'amount_cents', a, 'refunded_cents', rr)) from (
        select p.method, count(*) n, sum(p.amount_cents) a, sum(p.refunded_cents) rr from public.pos_payments p join s on s.id = p.sale_id
        where p.status <> 'voided' group by p.method) q), '[]'::jsonb),
    'taxes', coalesce((select jsonb_agg(jsonb_build_object('tax_name', tax_name, 'tax_rate', tax_rate, 'taxable_cents', b, 'tax_cents', t)) from (
        select l.tax_name, l.tax_rate, sum(l.gross_cents - l.discount_cents) b, sum(l.tax_cents) t from public.pos_sale_lines l join s on s.id = l.sale_id
        group by l.tax_name, l.tax_rate) q), '[]'::jsonb),
    'discounts', coalesce((select jsonb_agg(jsonb_build_object('sale_id', id, 'number', number, 'discount_cents', discount_cents, 'reason', discount_reason,
                                                               'approved_by', discount_approved_by, 'cashier_id', cashier_id) order by discount_cents desc)
        from (select * from s where discount_cents > 0 order by discount_cents desc limit 50) q), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'number', number, 'sale_id', sale_id, 'amount_cents', amount_cents, 'method', method, 'reason', reason,
                                                             'approved_by', approved_by, 'occurred_at', occurred_at) order by occurred_at desc)
        from (select * from rf order by occurred_at desc limit 100) q), '[]'::jsonb),
    'cash_differences', coalesce((select jsonb_agg(jsonb_build_object('shift_id', x.id, 'number', x.number, 'cashier_id', x.cashier_id, 'expected_cents', x.expected_cash_cents,
                                                                      'counted_cents', x.counted_cash_cents, 'difference_cents', x.difference_cents, 'status', x.status) order by x.closed_at)
        from public.pos_shifts x where x.company_id = target and x.difference_cents is not null and x.difference_cents <> 0
          and (x.closed_at at time zone 'America/Puerto_Rico')::date between p_from and p_to and (branch is null or x.branch_id = branch)
          and public.pos_branch_ok(target, x.branch_id)), '[]'::jsonb),
    'sync', jsonb_build_object(
        'needs_review', (select count(*) from public.pos_sync_events e where e.company_id = target and e.status = 'needs_review'),
        'failed', (select count(*) from public.pos_sync_events e where e.company_id = target and e.status in ('failed', 'dead')),
        'inventory_blocked', (select count(*) from public.pos_sales x where x.company_id = target and x.inventory_status = 'blocked' and x.status <> 'voided')),
    'settlements', jsonb_build_object(
        'card_captured_cents', (select coalesce(sum(p.amount_cents - p.refunded_cents), 0) from public.pos_payments p join s on s.id = p.sale_id where p.method = 'card'),
        'settled_cents', (select coalesce(sum(st.gross_cents), 0) from public.pos_settlements st where st.company_id = target and st.payout_date between p_from and p_to),
        'deposited_cents', (select coalesce(sum(st.net_cents), 0) from public.pos_settlements st where st.company_id = target and st.payout_date between p_from and p_to and st.bank_line_id is not null),
        'pending_deposit', (select count(*) from public.pos_settlements st where st.company_id = target and st.bank_line_id is null and st.status <> 'failed'))
  ) into r;
  return r;
end $$;

-- ===================================================================== grants
do $$ declare f text; begin
  foreach f in array array[
    'public.pos_branch_ok(uuid, uuid)', 'public.pos_settings_save(uuid, jsonb)', 'public.pos_tax_rate_save(uuid, uuid, text, text, numeric, boolean, boolean)',
    'public.pos_item_tax_set(uuid, uuid, uuid)', 'public.pos_register_save(uuid, uuid, uuid, text, text, boolean)', 'public.pos_register_assign(uuid, uuid, boolean)',
    'public.pos_approval_issue(uuid, uuid, text, bigint, numeric, integer)', 'public.pos_shift_open(uuid, bigint, text)',
    'public.pos_cash_move(uuid, text, bigint, text, text, text)', 'public.pos_shift_close(uuid, bigint, jsonb, text)', 'public.pos_shift_review(uuid, text)',
    'public.pos_quote(uuid, jsonb, bigint, numeric)', 'public.pos_sale_create(uuid, jsonb, text)', 'public.pos_sale_void(uuid, text, text)',
    'public.pos_refund_create(uuid, jsonb, text, text)', 'public.pos_sale_post_inventory(uuid)',
    'public.pos_integration_connect(uuid, text, text, bigint, uuid, text)', 'public.pos_integration_context(uuid, text, bigint, uuid, text)',
    'public.pos_integration_disconnect(uuid)', 'public.pos_location_map(uuid, text, uuid)', 'public.pos_item_map(uuid, text, uuid, uuid)',
    'public.pos_bridge_token_issue(uuid)', 'public.pos_bridge_resolve(text, text, bigint, uuid, text)',
    'public.pos_webhook_record(text, text, text, text, bigint, uuid, text)', 'public.pos_ingest_batch(uuid, text, text, bigint, uuid, text)',
    'public.pos_sync_due(text, bigint, uuid, text, integer)', 'public.pos_sync_retry(bigint)', 'public.pos_import_sales(uuid, uuid, text, text, jsonb)',
    'public.pos_settlement_record(uuid, text, text, bigint, uuid, text)', 'public.pos_settlement_reconcile(uuid, uuid)', 'public.pos_report(uuid, date, date, uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- machine functions (no user): callable without a session, but only with the server's signature
  foreach f in array array['public.pos_webhook_record(text, text, text, text, bigint, uuid, text)', 'public.pos_ingest_batch(uuid, text, text, bigint, uuid, text)',
    'public.pos_integration_context(uuid, text, bigint, uuid, text)', 'public.pos_sync_due(text, bigint, uuid, text, integer)',
    'public.pos_bridge_resolve(text, text, bigint, uuid, text)', 'public.pos_settlement_record(uuid, text, text, bigint, uuid, text)'] loop
    execute format('grant execute on function %s to anon', f);
  end loop;
  foreach f in array array['public.pos_guard()', 'public.pos_refund_guard()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
revoke all on all functions in schema ba_private from public, anon, authenticated;

-- ===================================================================== self-check
do $$ begin
  if has_table_privilege('authenticated', 'public.pos_sales', 'INSERT') or has_table_privilege('authenticated', 'public.pos_sale_lines', 'UPDATE')
     or has_table_privilege('authenticated', 'public.pos_cash_movements', 'INSERT') or has_table_privilege('anon', 'public.pos_sales', 'SELECT')
     or has_table_privilege('authenticated', 'public.pos_approval_codes', 'SELECT') then
    raise exception 'BA0044 self-check failed: POS writable directly, readable by anon, or approval codes readable';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key in ('pos.approve', 'pos.manage')) then
    raise exception 'BA0044 self-check failed: members must not approve or configure the POS';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'ba_private')
        and p.proname like 'pos\_%' and p.prosecdef and not (p.proconfig @> array['search_path=""'])) > 0 then
    raise exception 'BA0044 self-check failed: definer without search_path';
  end if;
end $$;

commit;
