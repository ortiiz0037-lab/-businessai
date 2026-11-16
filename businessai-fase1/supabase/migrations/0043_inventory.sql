-- =====================================================================
-- BusinessAI · Migration 0043 · Inventory, barcodes, purchasing & replenishment (S7)
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0039 (catalog), 0035 (branches), 0024 (vendors, bills).
--
-- Extends the catalog of 0039 (no second product list):
--   * catalog_items.cost_cents (reference acquisition cost), variants (size / color / model)
--     with their own SKU, barcodes (UPC / EAN / GTIN-14 validated by check digit, Code 128 /
--     Code 39 / other) and alternative codes. One code identifies ONE product or variant per
--     company: barcodes, SKUs and catalog codes never collide.
-- One source of truth for stock:
--   * inventory_movements is an append-only ledger (receipt, sale, returns, transfers,
--     adjustments, damaged, lost, unsellable, counts, corrections, revaluations). History is
--     never edited: a correction is a new, compensating movement that points to the one it
--     corrects (once).
--   * inventory_stock / inventory_location_stock are a cache maintained in the same
--     transaction by the only function that writes movements; inventory_verify() recomputes
--     them from the ledger. Reserved / committed / in transit / on order are read from their
--     own records (reservations, transfers, purchase orders), never stored twice.
--   * Outflows can never take stock below zero unless the company allows it explicitly.
-- Flows: purchase orders (draft → approval → issued → partial / full receipts, link to the
-- vendor bill of Payables without creating bills or payments), branch transfers (request →
-- approval → preparation → dispatch → in transit → receipt with differences), physical counts
-- (full / partial, by scanning; adjustments only when approved), adjustment requests subject to
-- approval, reservations for future sales (S8 POS).
-- Valuation: weighted average cost per branch and FIFO cost layers, both kept from the
-- movements. NOT posted to the ledger: Payables posts purchases to expense categories today;
-- perpetual inventory accounting needs an owner decision (docs/INVENTORY.md).
-- Security: RLS; writes only through SECURITY DEFINER functions with permission and branch
-- checks; idempotency keys; advisory locks per stock key; audit in inventory_events.
-- Rollback: supabase/rollback/0043_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$ begin
  if to_regclass('public.catalog_items') is null or to_regclass('public.branch_members') is null or to_regclass('public.vendors') is null then
    raise exception 'BA0043: migrations 0024, 0035 and 0039 must be applied first';
  end if;
end $$;

-- ===================================================================== permissions
insert into public.permissions (key, module, description_es, description_en) values
  ('inventory.view', 'inventory', 'Ver existencias, movimientos, compras y transferencias', 'View stock, movements, purchases and transfers'),
  ('inventory.operate', 'inventory', 'Recibir, dar salida, contar, transferir y preparar órdenes de compra', 'Receive, issue, count, transfer and draft purchase orders'),
  ('inventory.approve', 'inventory', 'Aprobar ajustes, conteos, transferencias y órdenes de compra; configurar inventario', 'Approve adjustments, counts, transfers and purchase orders; configure inventory')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'inventory.view'), ('admin', 'inventory.view'), ('member', 'inventory.view'),
  ('owner', 'inventory.operate'), ('admin', 'inventory.operate'), ('member', 'inventory.operate'),
  ('owner', 'inventory.approve'), ('admin', 'inventory.approve')
on conflict do nothing;

-- ===================================================================== helpers
-- GTIN check digit (EAN-8, UPC-A, EAN-13, GTIN-14)
create or replace function public.ba_gtin_valid(code text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s integer := 0; i integer; n integer; d integer;
begin
  if code is null or code !~ '^[0-9]+$' or char_length(code) not in (8, 12, 13, 14) then return false; end if;
  n := char_length(code);
  for i in 1 .. n - 1 loop
    d := substr(code, n - i, 1)::integer;
    s := s + case when i % 2 = 1 then d * 3 else d end;
  end loop;
  return (10 - s % 10) % 10 = substr(code, n, 1)::integer;
end $$;

-- UPC-E (8 digits) expanded to UPC-A, then checked
create or replace function public.ba_upce_valid(code text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare d text; m text; p text;
begin
  if code is null or code !~ '^[01][0-9]{7}$' then return false; end if;
  d := substr(code, 2, 6);
  case substr(d, 6, 1)
    when '0', '1', '2' then m := substr(d, 1, 2) || substr(d, 6, 1) || '00'; p := '00' || substr(d, 3, 3);
    when '3' then m := substr(d, 1, 3) || '00'; p := '000' || substr(d, 4, 2);
    when '4' then m := substr(d, 1, 4) || '0'; p := '0000' || substr(d, 5, 1);
    else m := substr(d, 1, 5); p := '0000' || substr(d, 6, 1);
  end case;
  return public.ba_gtin_valid(substr(code, 1, 1) || m || p || substr(code, 8, 1));
end $$;

create or replace function public.ba_barcode_valid(code text, symbology text)
returns boolean language sql immutable set search_path = '' as $$
  select case symbology
    when 'ean13' then code ~ '^[0-9]{13}$' and public.ba_gtin_valid(code)
    when 'upca' then code ~ '^[0-9]{12}$' and public.ba_gtin_valid(code)
    when 'ean8' then code ~ '^[0-9]{8}$' and public.ba_gtin_valid(code)
    when 'gtin14' then code ~ '^[0-9]{14}$' and public.ba_gtin_valid(code)
    when 'upce' then public.ba_upce_valid(code)
    when 'code128' then code ~ '^[\x20-\x7E]{1,64}$'
    when 'code39' then code ~ '^[0-9A-Z \-.$/+%]{1,64}$'
    when 'qr' then char_length(code) between 1 and 64 and code !~ '[\x00-\x1F]'
    when 'other' then char_length(code) between 1 and 64 and code !~ '[\x00-\x1F]'
    else false end
$$;

-- Is this branch inside the caller's scope? Approvers see every branch; users assigned to
-- branches (branch_members) only those; users without assignments, every branch.
create or replace function public.inventory_branch_ok(target uuid, branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select branch is not null
     and exists (select 1 from public.branches b where b.id = branch and b.company_id = target)
     and (public.has_permission(target, 'inventory.approve')
          or not exists (select 1 from public.branch_members bm where bm.company_id = target and bm.user_id = (select auth.uid()))
          or exists (select 1 from public.branch_members bm where bm.company_id = target and bm.branch_id = branch and bm.user_id = (select auth.uid())))
$$;

-- ===================================================================== catalog extension
alter table public.catalog_items add column if not exists cost_cents bigint;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_items_cost_check') then
    alter table public.catalog_items add constraint catalog_items_cost_check check (cost_cents is null or cost_cents between 0 and 100000000000);
  end if;
end $$;

create table if not exists public.catalog_variants (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid not null,
  sku text not null check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object' and octet_length(attributes::text) <= 500),
  price_cents bigint check (price_cents is null or price_cents between 0 and 100000000000),
  cost_cents bigint check (cost_cents is null or cost_cents between 0 and 100000000000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) on delete cascade
);
create unique index if not exists catalog_variants_sku_uidx on public.catalog_variants (company_id, lower(sku));
create index if not exists catalog_variants_item_idx on public.catalog_variants (item_id);

create table if not exists public.catalog_barcodes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid not null,
  variant_id uuid,
  code text not null check (char_length(code) between 1 and 64),
  symbology text not null check (symbology in ('ean13', 'upca', 'ean8', 'upce', 'gtin14', 'code128', 'code39', 'qr', 'other')),
  is_primary boolean not null default false,
  created_by uuid, created_at timestamptz not null default now(),
  check (public.ba_barcode_valid(code, symbology)),
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) on delete cascade,
  foreign key (company_id, variant_id) references public.catalog_variants (company_id, id) on delete cascade
);
-- one code → one product (or variant) per company
create unique index if not exists catalog_barcodes_code_uidx on public.catalog_barcodes (company_id, upper(code));
create index if not exists catalog_barcodes_item_idx on public.catalog_barcodes (item_id);

-- a catalog code, a variant SKU and a barcode never point to different products of the company
create or replace function public.catalog_code_conflict(target uuid, p_code text, own_item uuid, own_variant uuid, own_barcode uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.catalog_items i where i.company_id = target and lower(i.code) = lower(p_code) and i.id <> own_item)
      or exists (select 1 from public.catalog_variants v where v.company_id = target and lower(v.sku) = lower(p_code) and v.id is distinct from own_variant
                   and (own_variant is not null or v.item_id <> own_item))
      or exists (select 1 from public.catalog_barcodes b where b.company_id = target and upper(b.code) = upper(p_code) and b.id is distinct from own_barcode
                   and (b.item_id <> own_item or b.variant_id is distinct from own_variant))
$$;
create or replace function public.catalog_items_code_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.code <> old.code then
    perform pg_advisory_xact_lock(hashtextextended('ba_catalog_codes:' || new.company_id::text, 0));
    if exists (select 1 from public.catalog_variants v where v.company_id = new.company_id and lower(v.sku) = lower(new.code))
       or exists (select 1 from public.catalog_barcodes b where b.company_id = new.company_id and upper(b.code) = upper(new.code) and b.item_id <> new.id) then
      raise exception 'CATALOG_CODE_TAKEN' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ba_catalog_items_code_guard on public.catalog_items;
create trigger ba_catalog_items_code_guard before insert or update of code on public.catalog_items for each row execute function public.catalog_items_code_guard();

-- ===================================================================== inventory tables
create table if not exists public.inventory_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  allow_negative boolean not null default false,
  valuation_method text not null default 'average' check (valuation_method in ('average', 'fifo')),
  updated_by uuid, updated_at timestamptz not null default now()
);

create table if not exists public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  archived_at timestamptz,
  created_by uuid, created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred
);
create unique index if not exists inventory_locations_code_uidx on public.inventory_locations (branch_id, lower(code));

-- per branch / item settings for replenishment
create table if not exists public.inventory_item_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  item_id uuid not null,
  variant_key uuid not null default '00000000-0000-0000-0000-000000000000',
  min_qty numeric(14, 3) check (min_qty is null or min_qty >= 0),
  max_qty numeric(14, 3) check (max_qty is null or max_qty > 0),
  reorder_point numeric(14, 3) check (reorder_point is null or reorder_point >= 0),
  reorder_qty numeric(14, 3) check (reorder_qty is null or reorder_qty > 0),
  preferred_vendor_id uuid,
  lead_time_days integer check (lead_time_days is null or lead_time_days between 0 and 365),
  updated_by uuid, updated_at timestamptz not null default now(),
  unique (branch_id, item_id, variant_key),
  check (max_qty is null or reorder_point is null or max_qty >= reorder_point),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) on delete cascade,
  foreign key (company_id, preferred_vendor_id) references public.vendors (company_id, id) deferrable initially deferred
);

-- the ledger
create table if not exists public.inventory_movements (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  location_id uuid,
  item_id uuid not null,
  variant_id uuid,
  kind text not null check (kind in ('opening', 'receipt', 'sale', 'customer_return', 'vendor_return', 'transfer_out', 'transfer_in', 'adjustment_in',
                                     'adjustment_out', 'damaged', 'lost', 'unsellable', 'count', 'correction', 'revaluation')),
  quantity numeric(14, 3) not null,
  unit_cost_cents numeric(16, 4),           -- incoming: acquisition cost; outgoing: average cost at that moment
  fifo_cost_cents bigint,                   -- value moved under FIFO (signed)
  avg_cost_cents bigint,                    -- value moved under weighted average (signed)
  reason text check (reason is null or char_length(reason) <= 300),
  source_type text check (source_type is null or source_type in ('purchase_receipt', 'transfer', 'count', 'adjustment', 'document', 'manual', 'correction')),
  source_id uuid,
  document_id uuid,
  corrects_id bigint unique,
  idem_key text check (idem_key is null or char_length(idem_key) between 8 and 120),
  occurred_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (case when kind in ('opening', 'receipt', 'customer_return', 'transfer_in', 'adjustment_in') then quantity > 0
              when kind in ('sale', 'vendor_return', 'transfer_out', 'adjustment_out', 'damaged', 'lost', 'unsellable') then quantity < 0
              when kind = 'revaluation' then quantity = 0
              else quantity <> 0 end),
  check ((kind = 'correction') = (corrects_id is not null)),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) deferrable initially deferred,
  foreign key (company_id, variant_id) references public.catalog_variants (company_id, id) deferrable initially deferred,
  foreign key (company_id, location_id) references public.inventory_locations (company_id, id) deferrable initially deferred
);
create unique index if not exists inventory_movements_idem_uidx on public.inventory_movements (company_id, idem_key) where idem_key is not null;
create index if not exists inventory_movements_item_idx on public.inventory_movements (item_id, branch_id, id desc);
create index if not exists inventory_movements_company_idx on public.inventory_movements (company_id, occurred_at desc);
create index if not exists inventory_movements_source_idx on public.inventory_movements (source_type, source_id);

-- cache of the ledger per branch (cost) and per location (quantity)
create table if not exists public.inventory_stock (
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  item_id uuid not null,
  variant_key uuid not null,
  on_hand numeric(14, 3) not null default 0,
  avg_cost_cents numeric(16, 4) not null default 0,
  last_movement_at timestamptz,
  primary key (branch_id, item_id, variant_key)
);
create index if not exists inventory_stock_company_idx on public.inventory_stock (company_id, item_id);
create table if not exists public.inventory_location_stock (
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  location_key uuid not null,
  item_id uuid not null,
  variant_key uuid not null,
  on_hand numeric(14, 3) not null default 0,
  primary key (branch_id, location_key, item_id, variant_key)
);
create table if not exists public.inventory_cost_layers (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  item_id uuid not null,
  variant_key uuid not null,
  movement_id bigint not null references public.inventory_movements(id),
  qty_in numeric(14, 3) not null check (qty_in > 0),
  qty_remaining numeric(14, 3) not null check (qty_remaining >= 0),
  unit_cost_cents numeric(16, 4) not null check (unit_cost_cents >= 0),
  received_at timestamptz not null
);
create index if not exists inventory_cost_layers_open_idx on public.inventory_cost_layers (branch_id, item_id, variant_key, received_at, id) where qty_remaining > 0;

create table if not exists public.inventory_cost_history (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid not null,
  variant_id uuid,
  branch_id uuid,
  source text not null check (source in ('manual', 'receipt', 'revaluation')),
  cost_cents numeric(16, 4) not null,
  previous_cents numeric(16, 4),
  movement_id bigint,
  reason text,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists inventory_cost_history_item_idx on public.inventory_cost_history (item_id, id desc);

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  item_id uuid not null,
  variant_id uuid,
  quantity numeric(14, 3) not null check (quantity > 0),
  kind text not null check (kind in ('reserved', 'committed')),
  reference text check (reference is null or char_length(reference) <= 120),
  document_id uuid,
  status text not null default 'active' check (status in ('active', 'released', 'fulfilled')),
  idem_key text,
  created_by uuid, created_at timestamptz not null default now(),
  closed_by uuid, closed_at timestamptz,
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) deferrable initially deferred
);
create unique index if not exists inventory_reservations_idem_uidx on public.inventory_reservations (company_id, idem_key) where idem_key is not null;

create table if not exists public.inventory_counters (
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('purchase_order', 'transfer', 'count', 'adjustment')),
  last_value integer not null default 0,
  primary key (company_id, kind)
);

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  number text not null,
  vendor_id uuid not null,
  branch_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'partially_received', 'received', 'closed', 'cancelled')),
  source text not null default 'manual' check (source in ('manual', 'replenishment')),
  expected_date date,
  notes text check (notes is null or char_length(notes) <= 1000),
  version integer not null default 1,
  created_by uuid, created_at timestamptz not null default now(),
  submitted_by uuid, submitted_at timestamptz,
  approved_by uuid, approved_at timestamptz,
  closed_by uuid, closed_at timestamptz, close_reason text,
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, vendor_id) references public.vendors (company_id, id) deferrable initially deferred,
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred
);
create table if not exists public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  po_id uuid not null,
  line_no smallint not null check (line_no between 1 and 200),
  item_id uuid not null,
  variant_id uuid,
  qty_ordered numeric(14, 3) not null check (qty_ordered > 0),
  qty_received numeric(14, 3) not null default 0 check (qty_received >= 0),
  qty_damaged numeric(14, 3) not null default 0 check (qty_damaged >= 0),
  unit_cost_cents bigint not null check (unit_cost_cents between 0 and 100000000000),
  unique (company_id, id),
  unique (po_id, line_no),
  check (qty_received <= qty_ordered),
  foreign key (company_id, po_id) references public.purchase_orders (company_id, id) on delete cascade,
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) deferrable initially deferred,
  foreign key (company_id, variant_id) references public.catalog_variants (company_id, id) deferrable initially deferred
);
-- a vendor bill belongs to one purchase order at most (no duplicated expense)
create table if not exists public.purchase_order_bills (
  company_id uuid not null,
  po_id uuid not null,
  bill_id uuid not null unique,
  linked_by uuid, linked_at timestamptz not null default now(),
  primary key (po_id, bill_id),
  foreign key (company_id, po_id) references public.purchase_orders (company_id, id) on delete cascade,
  foreign key (company_id, bill_id) references public.bills (company_id, id) deferrable initially deferred
);

create table if not exists public.inventory_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  po_id uuid not null,
  branch_id uuid not null,
  notes text check (notes is null or char_length(notes) <= 500),
  idem_key text not null check (char_length(idem_key) between 8 and 80),
  received_by uuid, received_at timestamptz not null default now(),
  unique (company_id, idem_key),
  unique (company_id, id),
  foreign key (company_id, po_id) references public.purchase_orders (company_id, id) deferrable initially deferred
);
create table if not exists public.inventory_receipt_lines (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  receipt_id uuid not null,
  po_line_id uuid not null,
  qty_received numeric(14, 3) not null check (qty_received >= 0),
  qty_damaged numeric(14, 3) not null default 0 check (qty_damaged >= 0),
  movement_id bigint,
  note text check (note is null or char_length(note) <= 200),
  check (qty_received + qty_damaged > 0),
  foreign key (company_id, receipt_id) references public.inventory_receipts (company_id, id) on delete cascade,
  foreign key (company_id, po_line_id) references public.purchase_order_lines (company_id, id) deferrable initially deferred
);

create table if not exists public.inventory_transfers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  number text not null,
  from_branch_id uuid not null,
  to_branch_id uuid not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'prepared', 'in_transit', 'received', 'cancelled')),
  notes text check (notes is null or char_length(notes) <= 500),
  difference_note text check (difference_note is null or char_length(difference_note) <= 500),
  requested_by uuid, requested_at timestamptz not null default now(),
  approved_by uuid, approved_at timestamptz,
  prepared_by uuid, prepared_at timestamptz,
  dispatched_by uuid, dispatched_at timestamptz,
  received_by uuid, received_at timestamptz,
  cancelled_by uuid, cancelled_at timestamptz,
  idem_key text,
  unique (company_id, id),
  unique (company_id, number),
  check (from_branch_id <> to_branch_id),
  foreign key (company_id, from_branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, to_branch_id) references public.branches (company_id, id) deferrable initially deferred
);
create unique index if not exists inventory_transfers_idem_uidx on public.inventory_transfers (company_id, idem_key) where idem_key is not null;
create table if not exists public.inventory_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  transfer_id uuid not null,
  item_id uuid not null,
  variant_id uuid,
  qty_requested numeric(14, 3) not null check (qty_requested > 0),
  qty_prepared numeric(14, 3) check (qty_prepared is null or qty_prepared >= 0),
  qty_dispatched numeric(14, 3) check (qty_dispatched is null or qty_dispatched >= 0),
  qty_received numeric(14, 3) check (qty_received is null or qty_received >= 0),
  qty_damaged numeric(14, 3) check (qty_damaged is null or qty_damaged >= 0),
  unit_cost_cents numeric(16, 4),
  unique (company_id, id),
  foreign key (company_id, transfer_id) references public.inventory_transfers (company_id, id) on delete cascade,
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) deferrable initially deferred,
  foreign key (company_id, variant_id) references public.catalog_variants (company_id, id) deferrable initially deferred
);

create table if not exists public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  number text not null,
  branch_id uuid not null,
  location_id uuid,
  scope text not null check (scope in ('full', 'partial')),
  status text not null default 'open' check (status in ('open', 'submitted', 'approved', 'cancelled')),
  notes text check (notes is null or char_length(notes) <= 500),
  started_by uuid, started_at timestamptz not null default now(),
  submitted_by uuid, submitted_at timestamptz,
  approved_by uuid, approved_at timestamptz,
  unique (company_id, id),
  unique (company_id, number),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred,
  foreign key (company_id, location_id) references public.inventory_locations (company_id, id) deferrable initially deferred
);
create table if not exists public.inventory_count_lines (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  count_id uuid not null,
  item_id uuid not null,
  variant_key uuid not null default '00000000-0000-0000-0000-000000000000',
  counted_qty numeric(14, 3) not null check (counted_qty >= 0),
  scans integer not null default 0,
  expected_qty numeric(14, 3),
  difference_qty numeric(14, 3),
  movement_id bigint,
  updated_by uuid, updated_at timestamptz not null default now(),
  unique (count_id, item_id, variant_key),
  foreign key (company_id, count_id) references public.inventory_counts (company_id, id) on delete cascade,
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) deferrable initially deferred
);

create table if not exists public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  number text not null,
  branch_id uuid not null,
  location_id uuid,
  kind text not null check (kind in ('opening', 'adjustment_in', 'adjustment_out', 'damaged', 'lost', 'unsellable', 'vendor_return', 'customer_return')),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 100),
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  vendor_id uuid,
  document_id uuid,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  idem_key text not null check (char_length(idem_key) between 8 and 80),
  requested_by uuid, requested_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz, decision_note text,
  unique (company_id, idem_key),
  unique (company_id, number),
  unique (company_id, id),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred
);

-- sales issued from an invoice (once per invoice)
create table if not exists public.inventory_document_issues (
  document_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  lines integer not null,
  issued_by uuid, issued_at timestamptz not null default now(),
  foreign key (company_id, branch_id) references public.branches (company_id, id) deferrable initially deferred
);

create table if not exists public.inventory_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  entity text not null,
  entity_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists inventory_events_company_idx on public.inventory_events (company_id, id desc);

-- ===================================================================== guards
create or replace function public.inventory_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'INVENTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  raise exception 'INVENTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
end $$;
drop trigger if exists ba_inventory_movements_guard on public.inventory_movements;
create trigger ba_inventory_movements_guard before update or delete on public.inventory_movements for each row execute function public.inventory_guard();
drop trigger if exists ba_inventory_events_guard on public.inventory_events;
create trigger ba_inventory_events_guard before update or delete on public.inventory_events for each row execute function public.inventory_guard();
drop trigger if exists ba_inventory_cost_history_guard on public.inventory_cost_history;
create trigger ba_inventory_cost_history_guard before update or delete on public.inventory_cost_history for each row execute function public.inventory_guard();

-- ===================================================================== RLS
do $$
declare t text;
begin
  foreach t in array array['catalog_variants', 'catalog_barcodes', 'inventory_settings', 'inventory_locations', 'inventory_item_settings', 'inventory_movements',
    'inventory_stock', 'inventory_location_stock', 'inventory_cost_layers', 'inventory_cost_history', 'inventory_reservations', 'inventory_counters',
    'purchase_orders', 'purchase_order_lines', 'purchase_order_bills', 'inventory_receipts', 'inventory_receipt_lines', 'inventory_transfers',
    'inventory_transfer_lines', 'inventory_counts', 'inventory_count_lines', 'inventory_adjustments', 'inventory_document_issues', 'inventory_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    if t <> 'inventory_counters' then execute format('grant select on public.%I to authenticated', t); end if;
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
  end loop;
end $$;
create policy ba_catalog_variants_select on public.catalog_variants for select to authenticated using (public.has_permission(company_id, 'catalog.view'));
create policy ba_catalog_barcodes_select on public.catalog_barcodes for select to authenticated using (public.has_permission(company_id, 'catalog.view'));
create policy ba_inventory_settings_select on public.inventory_settings for select to authenticated using (public.has_permission(company_id, 'inventory.view'));
create policy ba_inventory_locations_select on public.inventory_locations for select to authenticated using (public.has_permission(company_id, 'inventory.view'));
-- branch-scoped rows
do $$
declare t text;
begin
  foreach t in array array['inventory_item_settings', 'inventory_movements', 'inventory_stock', 'inventory_location_stock', 'inventory_reservations',
    'inventory_counts', 'inventory_adjustments', 'inventory_document_issues', 'inventory_receipts'] loop
    execute format('create policy ba_%s_select on public.%I for select to authenticated using (public.has_permission(company_id, ''inventory.view'') and public.inventory_branch_ok(company_id, branch_id))', t, t);
  end loop;
end $$;
create policy ba_purchase_orders_select on public.purchase_orders for select to authenticated
  using (public.has_permission(company_id, 'inventory.view') and public.inventory_branch_ok(company_id, branch_id));
create policy ba_purchase_order_lines_select on public.purchase_order_lines for select to authenticated
  using (exists (select 1 from public.purchase_orders p where p.id = po_id and public.has_permission(p.company_id, 'inventory.view') and public.inventory_branch_ok(p.company_id, p.branch_id)));
create policy ba_purchase_order_bills_select on public.purchase_order_bills for select to authenticated using (public.has_permission(company_id, 'inventory.view'));
create policy ba_inventory_receipt_lines_select on public.inventory_receipt_lines for select to authenticated
  using (exists (select 1 from public.inventory_receipts r where r.id = receipt_id and public.has_permission(r.company_id, 'inventory.view') and public.inventory_branch_ok(r.company_id, r.branch_id)));
create policy ba_inventory_transfers_select on public.inventory_transfers for select to authenticated
  using (public.has_permission(company_id, 'inventory.view') and (public.inventory_branch_ok(company_id, from_branch_id) or public.inventory_branch_ok(company_id, to_branch_id)));
create policy ba_inventory_transfer_lines_select on public.inventory_transfer_lines for select to authenticated
  using (exists (select 1 from public.inventory_transfers x where x.id = transfer_id and public.has_permission(x.company_id, 'inventory.view')
                   and (public.inventory_branch_ok(x.company_id, x.from_branch_id) or public.inventory_branch_ok(x.company_id, x.to_branch_id))));
create policy ba_inventory_count_lines_select on public.inventory_count_lines for select to authenticated
  using (exists (select 1 from public.inventory_counts x where x.id = count_id and public.has_permission(x.company_id, 'inventory.view') and public.inventory_branch_ok(x.company_id, x.branch_id)));
-- costs are visible to approvers (operators see quantities)
create policy ba_inventory_cost_layers_select on public.inventory_cost_layers for select to authenticated using (public.has_permission(company_id, 'inventory.approve'));
create policy ba_inventory_cost_history_select on public.inventory_cost_history for select to authenticated using (public.has_permission(company_id, 'inventory.approve'));
create policy ba_inventory_events_select on public.inventory_events for select to authenticated using (public.has_permission(company_id, 'inventory.approve'));

-- ===================================================================== internal
create or replace function ba_private.inv_log(target uuid, ent text, ent_id text, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.inventory_events (company_id, entity, entity_id, action, details, actor) values (target, ent, ent_id, act, coalesce(info, '{}'), (select auth.uid()))
$$;
create or replace function ba_private.inv_next(target uuid, k text, prefix text)
returns text language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  insert into public.inventory_counters (company_id, kind, last_value) values (target, k, 1)
  on conflict (company_id, kind) do update set last_value = public.inventory_counters.last_value + 1
  returning last_value into v;
  return prefix || '-' || lpad(v::text, 6, '0');
end $$;
create or replace function ba_private.inv_vkey(v uuid) returns uuid language sql immutable set search_path = '' as $$
  select coalesce(v, '00000000-0000-0000-0000-000000000000'::uuid) $$;

-- current on hand of a stock key (branch level, or one location)
create or replace function public.inventory_on_hand(branch uuid, item uuid, variant uuid, location uuid default null)
returns numeric language sql stable security definer set search_path = '' as $$
  select case when location is null
    then coalesce((select s.on_hand from public.inventory_stock s where s.branch_id = branch and s.item_id = item and s.variant_key = ba_private.inv_vkey(variant)), 0)
    else coalesce((select s.on_hand from public.inventory_location_stock s where s.branch_id = branch and s.location_key = location and s.item_id = item
                     and s.variant_key = ba_private.inv_vkey(variant)), 0) end
$$;

/**
 * THE only writer of inventory_movements. Validates the product (tracked, of the company),
 * the variant, branch and location; serializes the stock key; refuses negative stock unless
 * the company allows it; keeps weighted average and FIFO layers; updates the caches.
 */
create or replace function ba_private.inv_post(target uuid, branch uuid, location uuid, item uuid, variant uuid, p_kind text, qty numeric, unit_cost numeric,
                                               p_reason text, src_type text, src_id uuid, doc uuid, corrects bigint, idem text, at_time timestamptz default now())
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  it public.catalog_items; vk uuid := ba_private.inv_vkey(variant); lk uuid := ba_private.inv_vkey(location);
  st public.inventory_stock; allow_neg boolean; uc numeric; new_avg numeric; fifo numeric := 0; left_qty numeric; ly record; take numeric;
  mid bigint; loc_on numeric; existing bigint;
begin
  if idem is not null then
    select m.id into existing from public.inventory_movements m where m.company_id = target and m.idem_key = idem;
    if existing is not null then return existing; end if;
  end if;
  select * into it from public.catalog_items x where x.id = item and x.company_id = target;
  if it.id is null or it.kind <> 'product' or not it.track_inventory then raise exception 'INVENTORY_ITEM_INVALID' using errcode = 'P0001'; end if;
  if variant is not null and not exists (select 1 from public.catalog_variants v where v.id = variant and v.item_id = item and v.company_id = target) then
    raise exception 'INVENTORY_ITEM_INVALID' using errcode = 'P0001', hint = 'variant';
  end if;
  if exists (select 1 from public.catalog_variants v where v.item_id = item and v.status = 'active') and variant is null then
    raise exception 'INVENTORY_VARIANT_REQUIRED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.branches b where b.id = branch and b.company_id = target) then raise exception 'BRANCH_INVALID' using errcode = 'P0001'; end if;
  if location is not null and not exists (select 1 from public.inventory_locations l where l.id = location and l.branch_id = branch and l.archived_at is null) then
    raise exception 'INVENTORY_LOCATION_INVALID' using errcode = 'P0001';
  end if;
  if qty is null or abs(qty) >= 100000000000 or (qty = 0 and p_kind <> 'revaluation') then raise exception 'INVENTORY_QTY_INVALID' using errcode = 'P0001'; end if;
  if unit_cost is not null and (unit_cost < 0 or unit_cost > 100000000000) then raise exception 'INVENTORY_COST_INVALID' using errcode = 'P0001'; end if;

  perform pg_advisory_xact_lock(hashtextextended('ba_inv:' || branch::text || ':' || item::text || ':' || vk::text, 0));
  if idem is not null then   -- again under the lock: a concurrent twin may have committed meanwhile
    select m.id into existing from public.inventory_movements m where m.company_id = target and m.idem_key = idem;
    if existing is not null then return existing; end if;
  end if;
  insert into public.inventory_stock (company_id, branch_id, item_id, variant_key) values (target, branch, item, vk) on conflict do nothing;
  select * into st from public.inventory_stock s where s.branch_id = branch and s.item_id = item and s.variant_key = vk for update;
  insert into public.inventory_location_stock (company_id, branch_id, location_key, item_id, variant_key) values (target, branch, lk, item, vk) on conflict do nothing;
  select s.on_hand into loc_on from public.inventory_location_stock s where s.branch_id = branch and s.location_key = lk and s.item_id = item and s.variant_key = vk for update;
  allow_neg := coalesce((select s.allow_negative from public.inventory_settings s where s.company_id = target), false);
  if qty < 0 and not allow_neg and st.on_hand + qty < 0 then
    raise exception 'INVENTORY_INSUFFICIENT' using errcode = 'P0001', hint = format('on_hand=%s requested=%s', st.on_hand, -qty);
  end if;

  if p_kind = 'revaluation' then
    if unit_cost is null then raise exception 'INVENTORY_COST_INVALID' using errcode = 'P0001'; end if;
    uc := unit_cost; new_avg := unit_cost;
    update public.inventory_cost_layers l set unit_cost_cents = unit_cost where l.branch_id = branch and l.item_id = item and l.variant_key = vk and l.qty_remaining > 0;
  elsif qty > 0 then
    uc := coalesce(unit_cost, nullif(st.avg_cost_cents, 0), (select v.cost_cents from public.catalog_variants v where v.id = variant), it.cost_cents, 0);
    new_avg := case when st.on_hand <= 0 then uc else round((st.on_hand * st.avg_cost_cents + qty * uc) / (st.on_hand + qty), 4) end;
    fifo := qty * uc;
  else
    uc := st.avg_cost_cents; new_avg := st.avg_cost_cents;
    left_qty := -qty;
    for ly in select l.id, l.qty_remaining, l.unit_cost_cents from public.inventory_cost_layers l
              where l.branch_id = branch and l.item_id = item and l.variant_key = vk and l.qty_remaining > 0 order by l.received_at, l.id for update loop
      exit when left_qty <= 0;
      take := least(left_qty, ly.qty_remaining);
      update public.inventory_cost_layers set qty_remaining = qty_remaining - take where id = ly.id;
      fifo := fifo - take * ly.unit_cost_cents;
      left_qty := left_qty - take;
    end loop;
    if left_qty > 0 then fifo := fifo - left_qty * st.avg_cost_cents; end if;   -- negative stock allowed: valued at average
  end if;

  insert into public.inventory_movements (company_id, branch_id, location_id, item_id, variant_id, kind, quantity, unit_cost_cents, fifo_cost_cents, avg_cost_cents,
                                          reason, source_type, source_id, document_id, corrects_id, idem_key, occurred_at, created_by)
  values (target, branch, location, item, variant, p_kind, qty, uc, round(fifo)::bigint,
          case when p_kind = 'revaluation' then round((unit_cost - st.avg_cost_cents) * st.on_hand)::bigint else round(qty * uc)::bigint end,
          nullif(left(btrim(coalesce(p_reason, '')), 300), ''), src_type, src_id, doc, corrects, idem, coalesce(at_time, now()), (select auth.uid()))
  returning id into mid;
  if qty > 0 then
    insert into public.inventory_cost_layers (company_id, branch_id, item_id, variant_key, movement_id, qty_in, qty_remaining, unit_cost_cents, received_at)
    values (target, branch, item, vk, mid, qty, qty, uc, coalesce(at_time, now()));
  end if;
  update public.inventory_stock s set on_hand = s.on_hand + qty, avg_cost_cents = new_avg, last_movement_at = now()
   where s.branch_id = branch and s.item_id = item and s.variant_key = vk;
  update public.inventory_location_stock s set on_hand = s.on_hand + qty where s.branch_id = branch and s.location_key = lk and s.item_id = item and s.variant_key = vk;
  if p_kind in ('receipt', 'revaluation') or (p_kind in ('opening', 'adjustment_in') and unit_cost is not null) then
    insert into public.inventory_cost_history (company_id, item_id, variant_id, branch_id, source, cost_cents, previous_cents, movement_id, reason, actor)
    values (target, item, variant, branch, case p_kind when 'revaluation' then 'revaluation' when 'receipt' then 'receipt' else 'manual' end, uc, st.avg_cost_cents, mid, p_reason, (select auth.uid()));
  end if;
  return mid;
end $$;

-- parse [{item, variant, qty, unit_cost}] lines (validated in inv_post)
create or replace function ba_private.inv_lines(lines jsonb)
returns table (item uuid, variant uuid, qty numeric, unit_cost numeric) language plpgsql immutable set search_path = '' as $$
declare l jsonb;
begin
  if lines is null or jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) not between 1 and 200 then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001'; end if;
  for l in select * from jsonb_array_elements(lines) loop
    if coalesce(l ->> 'item', '') !~ '^[0-9a-f-]{36}$' or (l ? 'variant' and l ->> 'variant' is not null and l ->> 'variant' !~ '^[0-9a-f-]{36}$')
       or coalesce(l ->> 'qty', '') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' or (l ->> 'qty')::numeric <= 0
       or (l ->> 'unit_cost' is not null and l ->> 'unit_cost' !~ '^[0-9]{1,11}(\.[0-9]{1,4})?$') then
      raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001';
    end if;
    item := (l ->> 'item')::uuid; variant := (l ->> 'variant')::uuid; qty := (l ->> 'qty')::numeric; unit_cost := (l ->> 'unit_cost')::numeric;
    return next;
  end loop;
end $$;

create or replace function ba_private.inv_check_item(target uuid, item uuid, variant uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.catalog_items i where i.id = item and i.company_id = target and i.kind = 'product' and i.track_inventory) then
    raise exception 'INVENTORY_ITEM_INVALID' using errcode = 'P0001';
  end if;
  if variant is not null and not exists (select 1 from public.catalog_variants v where v.id = variant and v.item_id = item) then
    raise exception 'INVENTORY_ITEM_INVALID' using errcode = 'P0001', hint = 'variant';
  end if;
  if variant is null and exists (select 1 from public.catalog_variants v where v.item_id = item and v.status = 'active') then
    raise exception 'INVENTORY_VARIANT_REQUIRED' using errcode = 'P0001';
  end if;
end $$;

create or replace function ba_private.inv_require(target uuid, perm text, branch uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.has_permission(target, perm) then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if branch is not null and not public.inventory_branch_ok(target, branch) then raise exception 'BRANCH_FORBIDDEN' using errcode = 'P0001'; end if;
end $$;

-- ===================================================================== catalog: cost, variants, barcodes
create or replace function public.catalog_set_cost(item uuid, variant uuid, cost bigint, reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.catalog_items; prev bigint;
begin
  select * into c from public.catalog_items x where x.id = item;
  if c.id is null or not public.has_permission(c.company_id, 'catalog.manage') then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
  if cost is null or cost not between 0 and 100000000000 then raise exception 'CATALOG_INVALID' using errcode = 'P0001'; end if;
  if variant is null then
    prev := c.cost_cents;
    update public.catalog_items x set cost_cents = cost, updated_by = (select auth.uid()), updated_at = now() where x.id = item;
  else
    select v.cost_cents into prev from public.catalog_variants v where v.id = variant and v.item_id = item;
    if not found then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
    update public.catalog_variants v set cost_cents = cost, updated_at = now() where v.id = variant;
  end if;
  insert into public.inventory_cost_history (company_id, item_id, variant_id, source, cost_cents, previous_cents, reason, actor)
  values (c.company_id, item, variant, 'manual', cost, prev, nullif(left(btrim(coalesce(reason, '')), 300), ''), (select auth.uid()));
end $$;

create or replace function public.catalog_variant_save(item uuid, variant uuid, p_sku text, p_attributes jsonb, p_price bigint, p_cost bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.catalog_items; vid uuid; sku_t text := btrim(coalesce(p_sku, '')); k text;
begin
  select * into c from public.catalog_items x where x.id = item;
  if c.id is null or not public.has_permission(c.company_id, 'catalog.manage') then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
  if c.kind <> 'product' or c.status <> 'active' then raise exception 'CATALOG_INVALID' using errcode = 'P0001', hint = 'product'; end if;
  if sku_t !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$' or jsonb_typeof(coalesce(p_attributes, '{}')) <> 'object'
     or (select count(*) from jsonb_object_keys(coalesce(p_attributes, '{}'))) > 5
     or (p_price is not null and p_price not between 0 and 100000000000) or (p_cost is not null and p_cost not between 0 and 100000000000) then
    raise exception 'CATALOG_INVALID' using errcode = 'P0001';
  end if;
  for k in select * from jsonb_object_keys(coalesce(p_attributes, '{}')) loop
    if char_length(k) not between 1 and 30 or jsonb_typeof(p_attributes -> k) <> 'string' or char_length(p_attributes ->> k) not between 1 and 60 then
      raise exception 'CATALOG_INVALID' using errcode = 'P0001', hint = 'attributes';
    end if;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('ba_catalog_codes:' || c.company_id::text, 0));
  if public.catalog_code_conflict(c.company_id, sku_t, item, coalesce(variant, '00000000-0000-0000-0000-000000000001'::uuid), null)
     or exists (select 1 from public.catalog_items i where i.company_id = c.company_id and lower(i.code) = lower(sku_t)) then
    raise exception 'CATALOG_CODE_TAKEN' using errcode = 'P0001';
  end if;
  if variant is null then
    insert into public.catalog_variants (company_id, item_id, sku, attributes, price_cents, cost_cents, created_by)
    values (c.company_id, item, sku_t, coalesce(p_attributes, '{}'), p_price, p_cost, (select auth.uid())) returning id into vid;
    perform ba_private.inv_log(c.company_id, 'catalog_variants', vid::text, 'created', jsonb_build_object('item', item, 'sku', sku_t));
  else
    update public.catalog_variants v set sku = sku_t, attributes = coalesce(p_attributes, '{}'), price_cents = p_price, cost_cents = p_cost, updated_at = now()
     where v.id = variant and v.item_id = item returning v.id into vid;
    if vid is null then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
    perform ba_private.inv_log(c.company_id, 'catalog_variants', vid::text, 'updated', jsonb_build_object('sku', sku_t));
  end if;
  return vid;
end $$;

create or replace function public.catalog_variant_set_status(variant uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.catalog_variants;
begin
  select * into v from public.catalog_variants x where x.id = variant;
  if v.id is null or not public.has_permission(v.company_id, 'catalog.manage') then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_status not in ('active', 'archived') then raise exception 'CATALOG_INVALID' using errcode = 'P0001'; end if;
  update public.catalog_variants x set status = p_status, updated_at = now() where x.id = variant;
  perform ba_private.inv_log(v.company_id, 'catalog_variants', v.id::text, p_status, '{}');
end $$;

create or replace function public.catalog_barcode_add(item uuid, variant uuid, p_code text, p_symbology text, p_primary boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.catalog_items; bid uuid; code_t text := btrim(coalesce(p_code, ''));
begin
  select * into c from public.catalog_items x where x.id = item;
  if c.id is null or not public.has_permission(c.company_id, 'catalog.manage') then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
  if variant is not null and not exists (select 1 from public.catalog_variants v where v.id = variant and v.item_id = item) then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.ba_barcode_valid(code_t, p_symbology) then raise exception 'BARCODE_INVALID' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_catalog_codes:' || c.company_id::text, 0));
  if public.catalog_code_conflict(c.company_id, code_t, item, variant, null)
     or exists (select 1 from public.catalog_barcodes b where b.company_id = c.company_id and upper(b.code) = upper(code_t)) then
    raise exception 'BARCODE_TAKEN' using errcode = 'P0001';
  end if;
  if coalesce(p_primary, false) then
    update public.catalog_barcodes b set is_primary = false where b.item_id = item and b.variant_id is not distinct from variant;
  end if;
  insert into public.catalog_barcodes (company_id, item_id, variant_id, code, symbology, is_primary, created_by)
  values (c.company_id, item, variant, code_t, p_symbology, coalesce(p_primary, false), (select auth.uid())) returning id into bid;
  perform ba_private.inv_log(c.company_id, 'catalog_barcodes', bid::text, 'added', jsonb_build_object('item', item, 'variant', variant, 'code', code_t, 'symbology', p_symbology));
  return bid;
end $$;

create or replace function public.catalog_barcode_remove(barcode uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.catalog_barcodes;
begin
  select * into b from public.catalog_barcodes x where x.id = barcode;
  if b.id is null or not public.has_permission(b.company_id, 'catalog.manage') then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
  delete from public.catalog_barcodes where id = b.id;
  perform ba_private.inv_log(b.company_id, 'catalog_barcodes', b.id::text, 'removed', jsonb_build_object('code', b.code, 'item', b.item_id));
end $$;

-- scan / search: barcode first, then variant SKU, then catalog code (RLS of the caller applies)
create or replace function public.inventory_lookup(target uuid, p_code text)
returns table (item_id uuid, variant_id uuid, matched_by text, code text, name text, sku text, attributes jsonb, unit text, track_inventory boolean, status text)
language sql stable set search_path = '' as $$
  with q as (select btrim(coalesce(p_code, '')) as c)
  select * from (
    select i.id, b.variant_id, 'barcode'::text, b.code, i.name, coalesce(v.sku, i.code), coalesce(v.attributes, '{}'::jsonb), i.unit, i.track_inventory, coalesce(v.status, i.status)
    from public.catalog_barcodes b join public.catalog_items i on i.id = b.item_id left join public.catalog_variants v on v.id = b.variant_id, q
    where b.company_id = target and upper(b.code) = upper(q.c)
    union all
    select i.id, v.id, 'sku', v.sku, i.name, v.sku, v.attributes, i.unit, i.track_inventory, v.status
    from public.catalog_variants v join public.catalog_items i on i.id = v.item_id, q
    where v.company_id = target and lower(v.sku) = lower(q.c)
    union all
    select i.id, null, 'code', i.code, i.name, i.code, '{}'::jsonb, i.unit, i.track_inventory, i.status
    from public.catalog_items i, q where i.company_id = target and lower(i.code) = lower(q.c)
  ) r limit 1
$$;

-- ===================================================================== settings and locations
create or replace function public.inventory_settings_save(target uuid, p_allow_negative boolean, p_method text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform ba_private.inv_require(target, 'inventory.approve', null);
  if p_method not in ('average', 'fifo') then raise exception 'INVENTORY_INVALID' using errcode = 'P0001'; end if;
  insert into public.inventory_settings (company_id, allow_negative, valuation_method, updated_by) values (target, coalesce(p_allow_negative, false), p_method, (select auth.uid()))
  on conflict (company_id) do update set allow_negative = excluded.allow_negative, valuation_method = excluded.valuation_method, updated_by = excluded.updated_by, updated_at = now();
  perform ba_private.inv_log(target, 'inventory_settings', target::text, 'saved', jsonb_build_object('allow_negative', coalesce(p_allow_negative, false), 'method', p_method));
end $$;

create or replace function public.inventory_location_save(target uuid, branch uuid, location uuid, p_code text, p_name text, archived boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare lid uuid;
begin
  perform ba_private.inv_require(target, 'inventory.approve', branch);
  if btrim(coalesce(p_code, '')) !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$' or char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'INVENTORY_INVALID' using errcode = 'P0001';
  end if;
  if location is null then
    insert into public.inventory_locations (company_id, branch_id, code, name, created_by) values (target, branch, btrim(p_code), btrim(p_name), (select auth.uid())) returning id into lid;
  else
    update public.inventory_locations l set code = btrim(p_code), name = btrim(p_name), archived_at = case when archived then coalesce(l.archived_at, now()) end
     where l.id = location and l.company_id = target and l.branch_id = branch returning id into lid;
    if lid is null then raise exception 'INVENTORY_LOCATION_INVALID' using errcode = 'P0001'; end if;
    if archived and exists (select 1 from public.inventory_location_stock s where s.location_key = lid and s.on_hand <> 0) then
      raise exception 'INVENTORY_LOCATION_NOT_EMPTY' using errcode = 'P0001';
    end if;
  end if;
  perform ba_private.inv_log(target, 'inventory_locations', lid::text, 'saved', jsonb_build_object('code', btrim(p_code)));
  return lid;
end $$;

create or replace function public.inventory_item_settings_save(target uuid, branch uuid, item uuid, variant uuid, p_min numeric, p_max numeric, p_reorder_point numeric,
                                                             p_reorder_qty numeric, p_vendor uuid, p_lead_days integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform ba_private.inv_require(target, 'inventory.approve', branch);
  if not exists (select 1 from public.catalog_items i where i.id = item and i.company_id = target and i.track_inventory)
     or (variant is not null and not exists (select 1 from public.catalog_variants v where v.id = variant and v.item_id = item))
     or (p_vendor is not null and not exists (select 1 from public.vendors x where x.id = p_vendor and x.company_id = target)) then
    raise exception 'INVENTORY_INVALID' using errcode = 'P0001';
  end if;
  insert into public.inventory_item_settings (company_id, branch_id, item_id, variant_key, min_qty, max_qty, reorder_point, reorder_qty, preferred_vendor_id, lead_time_days, updated_by)
  values (target, branch, item, ba_private.inv_vkey(variant), p_min, p_max, p_reorder_point, p_reorder_qty, p_vendor, p_lead_days, (select auth.uid()))
  on conflict (branch_id, item_id, variant_key) do update set min_qty = excluded.min_qty, max_qty = excluded.max_qty, reorder_point = excluded.reorder_point,
    reorder_qty = excluded.reorder_qty, preferred_vendor_id = excluded.preferred_vendor_id, lead_time_days = excluded.lead_time_days, updated_by = excluded.updated_by, updated_at = now();
  perform ba_private.inv_log(target, 'inventory_item_settings', item::text, 'saved',
    jsonb_build_object('branch', branch, 'variant', variant, 'min', p_min, 'max', p_max, 'reorder_point', p_reorder_point, 'reorder_qty', p_reorder_qty, 'lead_time_days', p_lead_days));
end $$;

-- ===================================================================== direct movements (operators): sales and customer returns
create or replace function public.inventory_move(target uuid, branch uuid, location uuid, p_kind text, lines jsonb, reason text, doc uuid, idem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l record; ids bigint[] := '{}'; n integer := 0;
begin
  perform ba_private.inv_require(target, 'inventory.operate', branch);
  if p_kind not in ('sale', 'customer_return') then raise exception 'INVENTORY_KIND_NOT_DIRECT' using errcode = 'P0001'; end if;
  if idem is null or idem !~ '^[A-Za-z0-9:_-]{8,80}$' then raise exception 'INVENTORY_INVALID' using errcode = 'P0001', hint = 'idem'; end if;
  if doc is not null and not exists (select 1 from public.documents d where d.id = doc and d.company_id = target) then raise exception 'INVENTORY_INVALID' using errcode = 'P0001', hint = 'document'; end if;
  if exists (select 1 from public.inventory_movements m where m.company_id = target and m.idem_key = 'mv:' || idem || ':1') then
    return jsonb_build_object('already', true, 'movements', (select jsonb_agg(m.id) from public.inventory_movements m where m.company_id = target and m.idem_key like 'mv:' || idem || ':%'));
  end if;
  for l in select * from ba_private.inv_lines(lines) loop
    n := n + 1;
    ids := ids || ba_private.inv_post(target, branch, location, l.item, l.variant, p_kind, case when p_kind = 'sale' then -l.qty else l.qty end, null, reason,
                                      case when doc is null then 'manual' else 'document' end, null, doc, null, 'mv:' || idem || ':' || n);
  end loop;
  perform ba_private.inv_log(target, 'inventory_movements', array_to_string(ids, ','), p_kind, jsonb_build_object('branch', branch, 'lines', n, 'document', doc));
  return jsonb_build_object('already', false, 'movements', to_jsonb(ids));
end $$;

-- the tracked catalog lines of an issued invoice leave the branch's stock (once per invoice)
create or replace function public.inventory_issue_document(target uuid, branch uuid, doc uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.documents; it jsonb; n integer := 0; ids bigint[] := '{}'; ci public.catalog_items;
begin
  perform ba_private.inv_require(target, 'inventory.operate', branch);
  select * into d from public.documents x where x.id = doc and x.company_id = target;
  if d.id is null or d.document_type <> 'invoice' or d.status not in ('sent', 'overdue', 'paid') then raise exception 'INVENTORY_DOCUMENT_INVALID' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_inv_doc:' || doc::text, 0));
  if exists (select 1 from public.inventory_document_issues x where x.document_id = doc) then raise exception 'INVENTORY_DOCUMENT_ALREADY_ISSUED' using errcode = 'P0001'; end if;
  for it in select * from jsonb_array_elements(case when jsonb_typeof(d.items) = 'array' then d.items else '[]'::jsonb end) loop
    if coalesce(it ->> 'catalog_item_id', '') !~ '^[0-9a-f-]{36}$' then continue; end if;
    select * into ci from public.catalog_items x where x.id = (it ->> 'catalog_item_id')::uuid and x.company_id = target;
    if ci.id is null or not ci.track_inventory or coalesce(it ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' or (it ->> 'quantity')::numeric <= 0 then continue; end if;
    n := n + 1;
    ids := ids || ba_private.inv_post(target, branch, null, ci.id, case when coalesce(it ->> 'catalog_variant_id', '') ~ '^[0-9a-f-]{36}$' then (it ->> 'catalog_variant_id')::uuid end,
                                      'sale', -round((it ->> 'quantity')::numeric, 3), null, 'Factura ' || coalesce(d.document_number, ''), 'document', doc, doc, null, 'doc:' || doc || ':' || n);
  end loop;
  if n = 0 then raise exception 'INVENTORY_DOCUMENT_NO_ITEMS' using errcode = 'P0001'; end if;
  insert into public.inventory_document_issues (document_id, company_id, branch_id, lines, issued_by) values (doc, target, branch, n, (select auth.uid()));
  perform ba_private.inv_log(target, 'documents', doc::text, 'stock_issued', jsonb_build_object('branch', branch, 'lines', n));
  return jsonb_build_object('lines', n, 'movements', to_jsonb(ids));
end $$;

-- ===================================================================== adjustments (approval)
create or replace function ba_private.inv_apply_adjustment(a public.inventory_adjustments)
returns integer language plpgsql security definer set search_path = '' as $$
declare l record; n integer := 0; outk boolean := a.kind in ('adjustment_out', 'damaged', 'lost', 'unsellable', 'vendor_return');
begin
  for l in select * from ba_private.inv_lines(a.lines) loop
    n := n + 1;
    perform ba_private.inv_post(a.company_id, a.branch_id, a.location_id, l.item, l.variant, a.kind, case when outk then -l.qty else l.qty end,
                                case when outk then null else l.unit_cost end, a.reason, 'adjustment', a.id, a.document_id, null, 'adj:' || a.id || ':' || n);
  end loop;
  return n;
end $$;

create or replace function public.inventory_adjust(target uuid, branch uuid, location uuid, p_kind text, lines jsonb, reason text, vendor uuid, doc uuid, idem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.inventory_adjustments; approver boolean;
begin
  perform ba_private.inv_require(target, 'inventory.operate', branch);
  if p_kind not in ('opening', 'adjustment_in', 'adjustment_out', 'damaged', 'lost', 'unsellable', 'vendor_return', 'customer_return') then
    raise exception 'INVENTORY_INVALID' using errcode = 'P0001', hint = 'kind';
  end if;
  if idem is null or idem !~ '^[A-Za-z0-9:_-]{8,80}$' then raise exception 'INVENTORY_INVALID' using errcode = 'P0001', hint = 'idem'; end if;
  if reason is null or char_length(btrim(reason)) not between 3 and 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  perform ba_private.inv_lines(lines);   -- validates the shape now
  if vendor is not null and not exists (select 1 from public.vendors v where v.id = vendor and v.company_id = target) then raise exception 'INVENTORY_INVALID' using errcode = 'P0001', hint = 'vendor'; end if;
  select * into a from public.inventory_adjustments x where x.company_id = target and x.idem_key = idem;
  if a.id is not null then return jsonb_build_object('id', a.id, 'status', a.status, 'already', true); end if;
  approver := public.has_permission(target, 'inventory.approve');
  insert into public.inventory_adjustments (company_id, number, branch_id, location_id, kind, lines, reason, vendor_id, document_id, idem_key, requested_by)
  values (target, ba_private.inv_next(target, 'adjustment', 'AJ'), branch, location, p_kind, lines, btrim(reason), vendor, doc, idem, (select auth.uid()))
  returning * into a;
  if approver then
    perform ba_private.inv_apply_adjustment(a);
    update public.inventory_adjustments set status = 'approved', decided_by = (select auth.uid()), decided_at = now(), decision_note = 'auto: approver' where id = a.id;
  end if;
  perform ba_private.inv_log(target, 'inventory_adjustments', a.id::text, case when approver then 'posted' else 'requested' end, jsonb_build_object('kind', p_kind, 'reason', btrim(reason)));
  return jsonb_build_object('id', a.id, 'status', case when approver then 'approved' else 'pending' end, 'already', false);
end $$;

create or replace function public.inventory_adjustment_decide(adjustment uuid, approve boolean, note text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.inventory_adjustments;
begin
  select * into a from public.inventory_adjustments x where x.id = adjustment for update;
  if a.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.inv_require(a.company_id, 'inventory.approve', a.branch_id);
  if a.status <> 'pending' then raise exception 'INVENTORY_ALREADY_DECIDED' using errcode = 'P0001'; end if;
  if not approve and (note is null or char_length(btrim(note)) < 3) then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if approve then perform ba_private.inv_apply_adjustment(a); end if;
  update public.inventory_adjustments set status = case when approve then 'approved' else 'rejected' end, decided_by = (select auth.uid()), decided_at = now(),
    decision_note = nullif(left(btrim(coalesce(note, '')), 300), '') where id = a.id;
  perform ba_private.inv_log(a.company_id, 'inventory_adjustments', a.id::text, case when approve then 'approved' else 'rejected' end, jsonb_build_object('note', note));
end $$;

-- corrections: a compensating movement, never an edit (once per movement)
create or replace function public.inventory_correct(movement bigint, reason text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare m public.inventory_movements; nid bigint;
begin
  select * into m from public.inventory_movements x where x.id = movement;
  if m.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.inv_require(m.company_id, 'inventory.approve', m.branch_id);
  if reason is null or char_length(btrim(reason)) not between 3 and 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if m.kind in ('correction', 'revaluation', 'transfer_out', 'transfer_in') then raise exception 'INVENTORY_NOT_CORRECTABLE' using errcode = 'P0001'; end if;
  if exists (select 1 from public.inventory_movements x where x.corrects_id = m.id) then raise exception 'INVENTORY_ALREADY_CORRECTED' using errcode = 'P0001'; end if;
  nid := ba_private.inv_post(m.company_id, m.branch_id, m.location_id, m.item_id, m.variant_id, 'correction', -m.quantity,
                             case when m.quantity < 0 then m.unit_cost_cents end, btrim(reason), 'correction', null, m.document_id, m.id, 'correction:' || m.id);
  perform ba_private.inv_log(m.company_id, 'inventory_movements', m.id::text, 'corrected', jsonb_build_object('correction', nid, 'reason', btrim(reason)));
  return nid;
end $$;

-- cost revaluation (approvers): average and open FIFO layers take the new cost; history kept
create or replace function public.inventory_revalue(target uuid, branch uuid, item uuid, variant uuid, new_cost numeric, reason text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare nid bigint;
begin
  perform ba_private.inv_require(target, 'inventory.approve', branch);
  if reason is null or char_length(btrim(reason)) not between 3 and 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  nid := ba_private.inv_post(target, branch, null, item, variant, 'revaluation', 0, new_cost, btrim(reason), 'manual', null, null, null, null);
  perform ba_private.inv_log(target, 'inventory_movements', nid::text, 'revalued', jsonb_build_object('item', item, 'cost', new_cost));
  return nid;
end $$;

-- ===================================================================== reservations (future sales / POS)
create or replace function public.inventory_reserve(target uuid, branch uuid, item uuid, variant uuid, qty numeric, p_kind text, p_reference text, doc uuid, idem text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare rid uuid; avail numeric;
begin
  perform ba_private.inv_require(target, 'inventory.operate', branch);
  if p_kind not in ('reserved', 'committed') or qty is null or qty <= 0 or idem is null then raise exception 'INVENTORY_INVALID' using errcode = 'P0001'; end if;
  select r.id into rid from public.inventory_reservations r where r.company_id = target and r.idem_key = idem;
  if rid is not null then return rid; end if;
  if not exists (select 1 from public.catalog_items i where i.id = item and i.company_id = target and i.track_inventory) then raise exception 'INVENTORY_ITEM_INVALID' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_inv:' || branch::text || ':' || item::text || ':' || ba_private.inv_vkey(variant)::text, 0));
  avail := (select available from public.inventory_levels(target, branch) x where x.item_id = item and x.variant_key = ba_private.inv_vkey(variant));
  if coalesce(avail, 0) < qty and not coalesce((select s.allow_negative from public.inventory_settings s where s.company_id = target), false) then
    raise exception 'INVENTORY_INSUFFICIENT' using errcode = 'P0001', hint = format('available=%s requested=%s', coalesce(avail, 0), qty);
  end if;
  insert into public.inventory_reservations (company_id, branch_id, item_id, variant_id, quantity, kind, reference, document_id, idem_key, created_by)
  values (target, branch, item, variant, qty, p_kind, nullif(left(btrim(coalesce(p_reference, '')), 120), ''), doc, idem, (select auth.uid())) returning id into rid;
  perform ba_private.inv_log(target, 'inventory_reservations', rid::text, 'created', jsonb_build_object('qty', qty, 'kind', p_kind));
  return rid;
end $$;
create or replace function public.inventory_release(reservation uuid, fulfilled boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.inventory_reservations;
begin
  select * into r from public.inventory_reservations x where x.id = reservation for update;
  if r.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.inv_require(r.company_id, 'inventory.operate', r.branch_id);
  if r.status <> 'active' then return; end if;
  update public.inventory_reservations set status = case when fulfilled then 'fulfilled' else 'released' end, closed_by = (select auth.uid()), closed_at = now() where id = r.id;
  perform ba_private.inv_log(r.company_id, 'inventory_reservations', r.id::text, case when fulfilled then 'fulfilled' else 'released' end, '{}');
end $$;

-- ===================================================================== levels (single read of the derived quantities)
create or replace function ba_private.inv_levels_base(target uuid, branch uuid)
returns table (branch_id uuid, item_id uuid, variant_key uuid, on_hand numeric, reserved numeric, committed numeric, in_transit numeric, on_order numeric,
               avg_cost_cents numeric, last_movement_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with keys as (
    select s.branch_id, s.item_id, s.variant_key from public.inventory_stock s where s.company_id = target
    union select r.branch_id, r.item_id, ba_private.inv_vkey(r.variant_id) from public.inventory_reservations r where r.company_id = target and r.status = 'active'
    union select t.to_branch_id, l.item_id, ba_private.inv_vkey(l.variant_id) from public.inventory_transfer_lines l join public.inventory_transfers t on t.id = l.transfer_id
          where t.company_id = target and t.status = 'in_transit'
    union select p.branch_id, l.item_id, ba_private.inv_vkey(l.variant_id) from public.purchase_order_lines l join public.purchase_orders p on p.id = l.po_id
          where p.company_id = target and p.status in ('approved', 'partially_received')
  )
  select k.branch_id, k.item_id, k.variant_key,
    coalesce(s.on_hand, 0),
    coalesce((select sum(r.quantity) from public.inventory_reservations r where r.branch_id = k.branch_id and r.item_id = k.item_id
                and ba_private.inv_vkey(r.variant_id) = k.variant_key and r.status = 'active' and r.kind = 'reserved'), 0),
    coalesce((select sum(r.quantity) from public.inventory_reservations r where r.branch_id = k.branch_id and r.item_id = k.item_id
                and ba_private.inv_vkey(r.variant_id) = k.variant_key and r.status = 'active' and r.kind = 'committed'), 0)
      + coalesce((select sum(coalesce(l.qty_prepared, l.qty_requested)) from public.inventory_transfer_lines l join public.inventory_transfers t on t.id = l.transfer_id
                   where t.from_branch_id = k.branch_id and l.item_id = k.item_id and ba_private.inv_vkey(l.variant_id) = k.variant_key and t.status in ('approved', 'prepared')), 0),
    coalesce((select sum(coalesce(l.qty_dispatched, 0)) from public.inventory_transfer_lines l join public.inventory_transfers t on t.id = l.transfer_id
               where t.to_branch_id = k.branch_id and l.item_id = k.item_id and ba_private.inv_vkey(l.variant_id) = k.variant_key and t.status = 'in_transit'), 0),
    coalesce((select sum(l.qty_ordered - l.qty_received - l.qty_damaged) from public.purchase_order_lines l join public.purchase_orders p on p.id = l.po_id
               where p.branch_id = k.branch_id and l.item_id = k.item_id and ba_private.inv_vkey(l.variant_id) = k.variant_key and p.status in ('approved', 'partially_received')
                 and l.qty_ordered > l.qty_received + l.qty_damaged), 0),
    case when public.has_permission(target, 'inventory.approve') then coalesce(s.avg_cost_cents, 0) end,
    s.last_movement_at
  from keys k left join public.inventory_stock s on s.branch_id = k.branch_id and s.item_id = k.item_id and s.variant_key = k.variant_key
  where public.has_permission(target, 'inventory.view') and public.inventory_branch_ok(target, k.branch_id) and (branch is null or k.branch_id = branch)
$$;
-- available = on_hand - reserved - committed
create or replace function public.inventory_levels(target uuid, branch uuid default null)
returns table (branch_id uuid, item_id uuid, variant_key uuid, on_hand numeric, reserved numeric, committed numeric, available numeric, in_transit numeric, on_order numeric,
               avg_cost_cents numeric, last_movement_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.branch_id, l.item_id, l.variant_key, l.on_hand, l.reserved, l.committed, l.on_hand - l.reserved - l.committed, l.in_transit, l.on_order, l.avg_cost_cents, l.last_movement_at
  from ba_private.inv_levels_base(target, branch) l
$$;

-- ===================================================================== purchase orders and receiving
create or replace function public.purchase_order_save(target uuid, po uuid, vendor uuid, branch uuid, p_expected date, p_notes text, lines jsonb, expected_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare p public.purchase_orders; l jsonb; n integer := 0;
begin
  perform ba_private.inv_require(target, 'inventory.operate', branch);
  if not exists (select 1 from public.vendors v where v.id = vendor and v.company_id = target) then raise exception 'INVENTORY_INVALID' using errcode = 'P0001', hint = 'vendor'; end if;
  if lines is null or jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) not between 1 and 200 then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001'; end if;
  if po is null then
    insert into public.purchase_orders (company_id, number, vendor_id, branch_id, expected_date, notes, created_by)
    values (target, ba_private.inv_next(target, 'purchase_order', 'OC'), vendor, branch, p_expected, nullif(btrim(coalesce(p_notes, '')), ''), (select auth.uid())) returning * into p;
  else
    select * into p from public.purchase_orders x where x.id = po and x.company_id = target for update;
    if p.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
    if p.status <> 'draft' then raise exception 'PO_NOT_EDITABLE' using errcode = 'P0001'; end if;
    if expected_version is distinct from p.version then raise exception 'INVENTORY_CONFLICT' using errcode = 'P0001'; end if;
    update public.purchase_orders x set vendor_id = vendor, branch_id = branch, expected_date = p_expected, notes = nullif(btrim(coalesce(p_notes, '')), ''), version = x.version + 1
     where x.id = p.id returning * into p;
    delete from public.purchase_order_lines where po_id = p.id;
  end if;
  for l in select * from jsonb_array_elements(lines) loop
    n := n + 1;
    if coalesce(l ->> 'item', '') !~ '^[0-9a-f-]{36}$' or coalesce(l ->> 'qty', '') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' or (l ->> 'qty')::numeric <= 0
       or coalesce(l ->> 'unit_cost', '') !~ '^[0-9]{1,11}$'
       or not exists (select 1 from public.catalog_items i where i.id = (l ->> 'item')::uuid and i.company_id = target and i.track_inventory and i.status = 'active')
       or (l ->> 'variant' is not null and not exists (select 1 from public.catalog_variants v where v.id = (l ->> 'variant')::uuid and v.item_id = (l ->> 'item')::uuid)) then
      raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001', hint = format('line %s', n);
    end if;
    perform ba_private.inv_check_item(target, (l ->> 'item')::uuid, (l ->> 'variant')::uuid);
    insert into public.purchase_order_lines (company_id, po_id, line_no, item_id, variant_id, qty_ordered, unit_cost_cents)
    values (target, p.id, n, (l ->> 'item')::uuid, (l ->> 'variant')::uuid, (l ->> 'qty')::numeric, (l ->> 'unit_cost')::bigint);
  end loop;
  perform ba_private.inv_log(target, 'purchase_orders', p.id::text, case when po is null then 'created' else 'updated' end, jsonb_build_object('number', p.number, 'lines', n));
  return p.id;
end $$;

create or replace function public.purchase_order_transition(po uuid, p_action text, reason text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare p public.purchase_orders; nxt text;
begin
  select * into p from public.purchase_orders x where x.id = po for update;
  if p.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  case p_action
    when 'submit' then
      perform ba_private.inv_require(p.company_id, 'inventory.operate', p.branch_id);
      if p.status <> 'draft' then raise exception 'PO_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      nxt := 'pending_approval';
      update public.purchase_orders set status = nxt, submitted_by = (select auth.uid()), submitted_at = now() where id = p.id;
    when 'approve' then
      perform ba_private.inv_require(p.company_id, 'inventory.approve', p.branch_id);
      if p.status not in ('pending_approval', 'draft') then raise exception 'PO_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      nxt := 'approved';
      update public.purchase_orders set status = nxt, approved_by = (select auth.uid()), approved_at = now(), submitted_at = coalesce(submitted_at, now()),
             submitted_by = coalesce(submitted_by, (select auth.uid())) where id = p.id;
    when 'reject' then
      perform ba_private.inv_require(p.company_id, 'inventory.approve', p.branch_id);
      if p.status <> 'pending_approval' then raise exception 'PO_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      nxt := 'draft';
      update public.purchase_orders set status = nxt where id = p.id;
    when 'cancel' then
      perform ba_private.inv_require(p.company_id, 'inventory.approve', p.branch_id);
      if p.status not in ('draft', 'pending_approval', 'approved') or exists (select 1 from public.inventory_receipts r where r.po_id = p.id) then
        raise exception 'PO_TRANSITION_INVALID' using errcode = 'P0001';
      end if;
      nxt := 'cancelled';
      update public.purchase_orders set status = nxt, closed_by = (select auth.uid()), closed_at = now(), close_reason = left(btrim(coalesce(reason, '')), 300) where id = p.id;
    when 'close' then   -- the rest will not arrive
      perform ba_private.inv_require(p.company_id, 'inventory.approve', p.branch_id);
      if p.status not in ('approved', 'partially_received') then raise exception 'PO_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      if reason is null or char_length(btrim(reason)) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
      nxt := 'closed';
      update public.purchase_orders set status = nxt, closed_by = (select auth.uid()), closed_at = now(), close_reason = left(btrim(reason), 300) where id = p.id;
    else raise exception 'PO_TRANSITION_INVALID' using errcode = 'P0001';
  end case;
  perform ba_private.inv_log(p.company_id, 'purchase_orders', p.id::text, p_action, jsonb_build_object('from', p.status, 'to', nxt, 'reason', reason));
  return nxt;
end $$;

-- receive (partial or full, several deliveries): lines [{po_line, qty, damaged, note}]
create or replace function public.purchase_order_receive(po uuid, lines jsonb, notes text, idem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.purchase_orders; r public.inventory_receipts; l jsonb; pl public.purchase_order_lines; q numeric; dmg numeric; mid bigint; n integer := 0; done boolean;
begin
  select * into p from public.purchase_orders x where x.id = po for update;
  if p.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.inv_require(p.company_id, 'inventory.operate', p.branch_id);
  if idem is null or idem !~ '^[A-Za-z0-9:_-]{8,80}$' then raise exception 'INVENTORY_INVALID' using errcode = 'P0001', hint = 'idem'; end if;
  select * into r from public.inventory_receipts x where x.company_id = p.company_id and x.idem_key = idem;
  if r.id is not null then return jsonb_build_object('receipt', r.id, 'already', true, 'status', p.status); end if;
  if p.status not in ('approved', 'partially_received') then raise exception 'PO_NOT_RECEIVABLE' using errcode = 'P0001'; end if;
  if lines is null or jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) not between 1 and 200 then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001'; end if;
  insert into public.inventory_receipts (company_id, po_id, branch_id, notes, idem_key, received_by)
  values (p.company_id, p.id, p.branch_id, nullif(left(btrim(coalesce(notes, '')), 500), ''), idem, (select auth.uid())) returning * into r;
  for l in select * from jsonb_array_elements(lines) loop
    if coalesce(l ->> 'po_line', '') !~ '^[0-9a-f-]{36}$' or coalesce(l ->> 'qty', '0') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$'
       or coalesce(l ->> 'damaged', '0') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' then
      raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001';
    end if;
    q := coalesce((l ->> 'qty')::numeric, 0); dmg := coalesce((l ->> 'damaged')::numeric, 0);
    if q + dmg = 0 then continue; end if;
    select * into pl from public.purchase_order_lines x where x.id = (l ->> 'po_line')::uuid and x.po_id = p.id for update;
    if pl.id is null then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001', hint = 'po_line'; end if;
    if pl.qty_received + pl.qty_damaged + q + dmg > pl.qty_ordered then
      raise exception 'PO_OVER_RECEIPT' using errcode = 'P0001', hint = format('line %s: ordered=%s received=%s new=%s', pl.line_no, pl.qty_ordered, pl.qty_received + pl.qty_damaged, q + dmg);
    end if;
    n := n + 1; mid := null;
    if q > 0 then
      mid := ba_private.inv_post(p.company_id, p.branch_id, null, pl.item_id, pl.variant_id, 'receipt', q, pl.unit_cost_cents,
                                 p.number, 'purchase_receipt', r.id, null, null, 'rcv:' || r.id || ':' || pl.id);
    end if;
    update public.purchase_order_lines set qty_received = qty_received + q, qty_damaged = qty_damaged + dmg where id = pl.id;
    insert into public.inventory_receipt_lines (company_id, receipt_id, po_line_id, qty_received, qty_damaged, movement_id, note)
    values (p.company_id, r.id, pl.id, q, dmg, mid, nullif(left(btrim(coalesce(l ->> 'note', '')), 200), ''));
  end loop;
  if n = 0 then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001', hint = 'empty'; end if;
  select bool_and(x.qty_received + x.qty_damaged >= x.qty_ordered) into done from public.purchase_order_lines x where x.po_id = p.id;
  update public.purchase_orders set status = case when done then 'received' else 'partially_received' end where id = p.id;
  perform ba_private.inv_log(p.company_id, 'purchase_orders', p.id::text, 'received', jsonb_build_object('receipt', r.id, 'lines', n, 'complete', done));
  return jsonb_build_object('receipt', r.id, 'already', false, 'status', case when done then 'received' else 'partially_received' end);
end $$;

-- the vendor bill of Payables for this purchase (linked, never created: no duplicated expense or payment)
create or replace function public.purchase_order_link_bill(po uuid, bill uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.purchase_orders; b record;
begin
  select * into p from public.purchase_orders x where x.id = po;
  if p.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.inv_require(p.company_id, 'inventory.approve', p.branch_id);
  if not public.has_permission(p.company_id, 'payables.view') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select x.id, x.vendor_id, x.status into b from public.bills x where x.id = bill and x.company_id = p.company_id;
  if b.id is null or b.vendor_id <> p.vendor_id or b.status = 'void' then raise exception 'PO_BILL_INVALID' using errcode = 'P0001'; end if;
  if exists (select 1 from public.purchase_order_bills x where x.bill_id = bill) then raise exception 'PO_BILL_ALREADY_LINKED' using errcode = 'P0001'; end if;
  insert into public.purchase_order_bills (company_id, po_id, bill_id, linked_by) values (p.company_id, p.id, bill, (select auth.uid()));
  perform ba_private.inv_log(p.company_id, 'purchase_orders', p.id::text, 'bill_linked', jsonb_build_object('bill', bill));
end $$;

-- drafts from replenishment suggestions, grouped by vendor and branch (approval still required)
create or replace function public.purchase_orders_from_suggestions(target uuid, lines jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g record; ids jsonb := '[]'::jsonb; pid uuid;
begin
  perform ba_private.inv_require(target, 'inventory.operate', null);
  if lines is null or jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) not between 1 and 500 then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001'; end if;
  for g in select (x ->> 'vendor')::uuid as vendor, (x ->> 'branch')::uuid as branch,
                  jsonb_agg(jsonb_build_object('item', x ->> 'item', 'variant', x ->> 'variant', 'qty', x ->> 'qty', 'unit_cost', coalesce(x ->> 'unit_cost', '0'))) as l
           from jsonb_array_elements(lines) x
           where coalesce(x ->> 'vendor', '') ~ '^[0-9a-f-]{36}$' and coalesce(x ->> 'branch', '') ~ '^[0-9a-f-]{36}$'
           group by 1, 2 loop
    pid := public.purchase_order_save(target, null, g.vendor, g.branch, null, 'Reposición sugerida', g.l, null);
    update public.purchase_orders set source = 'replenishment' where id = pid;
    ids := ids || to_jsonb(pid);
  end loop;
  if jsonb_array_length(ids) = 0 then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001', hint = 'vendor'; end if;
  return ids;
end $$;

-- ===================================================================== transfers
create or replace function public.inventory_transfer_request(target uuid, from_branch uuid, to_branch uuid, lines jsonb, p_notes text, idem text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare t public.inventory_transfers; l record;
begin
  perform ba_private.inv_require(target, 'inventory.operate', null);
  if not (public.inventory_branch_ok(target, from_branch) or public.inventory_branch_ok(target, to_branch)) then raise exception 'BRANCH_FORBIDDEN' using errcode = 'P0001'; end if;
  if from_branch = to_branch or not exists (select 1 from public.branches b where b.id = to_branch and b.company_id = target and b.archived_at is null)
     or not exists (select 1 from public.branches b where b.id = from_branch and b.company_id = target) then raise exception 'BRANCH_INVALID' using errcode = 'P0001'; end if;
  if idem is not null then
    select * into t from public.inventory_transfers x where x.company_id = target and x.idem_key = idem;
    if t.id is not null then return t.id; end if;
  end if;
  insert into public.inventory_transfers (company_id, number, from_branch_id, to_branch_id, notes, requested_by, idem_key)
  values (target, ba_private.inv_next(target, 'transfer', 'TR'), from_branch, to_branch, nullif(left(btrim(coalesce(p_notes, '')), 500), ''), (select auth.uid()), idem) returning * into t;
  for l in select * from ba_private.inv_lines(lines) loop
    perform ba_private.inv_check_item(target, l.item, l.variant);
    insert into public.inventory_transfer_lines (company_id, transfer_id, item_id, variant_id, qty_requested) values (target, t.id, l.item, l.variant, l.qty);
  end loop;
  perform ba_private.inv_log(target, 'inventory_transfers', t.id::text, 'requested', jsonb_build_object('number', t.number, 'from', from_branch, 'to', to_branch));
  return t.id;
end $$;

create or replace function public.inventory_transfer_step(transfer uuid, p_action text, lines jsonb default null, note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare t public.inventory_transfers; tl public.inventory_transfer_lines; l jsonb; q numeric; dmg numeric; diff boolean := false; mid bigint; nxt text; uc numeric;
begin
  select * into t from public.inventory_transfers x where x.id = transfer for update;
  if t.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  case p_action
    when 'approve' then
      perform ba_private.inv_require(t.company_id, 'inventory.approve', t.from_branch_id);
      if t.status <> 'requested' then raise exception 'TRANSFER_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      nxt := 'approved';
      update public.inventory_transfers set status = nxt, approved_by = (select auth.uid()), approved_at = now() where id = t.id;
    when 'prepare' then   -- picked quantities at the origin (scanning or typing); lines [{line, qty}]
      perform ba_private.inv_require(t.company_id, 'inventory.operate', t.from_branch_id);
      if t.status not in ('approved', 'prepared') then raise exception 'TRANSFER_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      for l in select * from jsonb_array_elements(coalesce(lines, '[]'::jsonb)) loop
        if coalesce(l ->> 'qty', '') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001'; end if;
        update public.inventory_transfer_lines x set qty_prepared = (l ->> 'qty')::numeric where x.id = (l ->> 'line')::uuid and x.transfer_id = t.id;
        if not found then raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001'; end if;
      end loop;
      nxt := 'prepared';
      update public.inventory_transfers set status = nxt, prepared_by = (select auth.uid()), prepared_at = now() where id = t.id;
    when 'dispatch' then  -- leaves the origin now (in transit); the destination is NOT increased yet
      perform ba_private.inv_require(t.company_id, 'inventory.operate', t.from_branch_id);
      if t.status not in ('approved', 'prepared') then raise exception 'TRANSFER_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      for tl in select * from public.inventory_transfer_lines x where x.transfer_id = t.id for update loop
        q := coalesce(tl.qty_prepared, tl.qty_requested); uc := null;
        if q > 0 then
          mid := ba_private.inv_post(t.company_id, t.from_branch_id, null, tl.item_id, tl.variant_id, 'transfer_out', -q, null, t.number, 'transfer', t.id, null, null, 'tro:' || tl.id);
          select m.unit_cost_cents into uc from public.inventory_movements m where m.id = mid;
        end if;
        update public.inventory_transfer_lines set qty_dispatched = q, unit_cost_cents = uc where id = tl.id;
      end loop;
      nxt := 'in_transit';
      update public.inventory_transfers set status = nxt, dispatched_by = (select auth.uid()), dispatched_at = now() where id = t.id;
    when 'receive' then   -- lines [{line, qty, damaged}]; differences need a note
      perform ba_private.inv_require(t.company_id, 'inventory.operate', t.to_branch_id);
      if t.status <> 'in_transit' then raise exception 'TRANSFER_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      for tl in select * from public.inventory_transfer_lines x where x.transfer_id = t.id for update loop
        l := null;
        select x.value into l from jsonb_array_elements(coalesce(lines, '[]'::jsonb)) x where x.value ->> 'line' = tl.id::text;
        if l is null then q := tl.qty_dispatched; dmg := 0;
        else
          if coalesce(l ->> 'qty', '') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' or coalesce(l ->> 'damaged', '0') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' then
            raise exception 'INVENTORY_LINES_INVALID' using errcode = 'P0001';
          end if;
          q := (l ->> 'qty')::numeric; dmg := coalesce((l ->> 'damaged')::numeric, 0);
        end if;
        if q + dmg > tl.qty_dispatched then raise exception 'TRANSFER_OVER_RECEIPT' using errcode = 'P0001'; end if;
        if q + dmg <> tl.qty_dispatched or dmg > 0 then diff := true; end if;
        if q > 0 then
          perform ba_private.inv_post(t.company_id, t.to_branch_id, null, tl.item_id, tl.variant_id, 'transfer_in', q, tl.unit_cost_cents, t.number, 'transfer', t.id, null, null, 'tri:' || tl.id);
        end if;
        update public.inventory_transfer_lines set qty_received = q, qty_damaged = dmg where id = tl.id;
      end loop;
      if diff and (note is null or char_length(btrim(note)) < 3) then raise exception 'TRANSFER_DIFFERENCE_NOTE_REQUIRED' using errcode = 'P0001'; end if;
      nxt := 'received';
      update public.inventory_transfers set status = nxt, received_by = (select auth.uid()), received_at = now(), difference_note = case when diff then left(btrim(note), 500) end where id = t.id;
    when 'cancel' then
      perform ba_private.inv_require(t.company_id, 'inventory.operate', t.from_branch_id);
      if t.status not in ('requested', 'approved', 'prepared') then raise exception 'TRANSFER_TRANSITION_INVALID' using errcode = 'P0001'; end if;
      if t.status <> 'requested' and not public.has_permission(t.company_id, 'inventory.approve') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
      nxt := 'cancelled';
      update public.inventory_transfers set status = nxt, cancelled_by = (select auth.uid()), cancelled_at = now() where id = t.id;
    else raise exception 'TRANSFER_TRANSITION_INVALID' using errcode = 'P0001';
  end case;
  perform ba_private.inv_log(t.company_id, 'inventory_transfers', t.id::text, p_action, jsonb_build_object('from', t.status, 'to', nxt, 'difference', diff, 'note', note));
  return nxt;
end $$;

-- ===================================================================== physical counts
create or replace function public.inventory_count_start(target uuid, branch uuid, location uuid, p_scope text, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  perform ba_private.inv_require(target, 'inventory.operate', branch);
  if p_scope not in ('full', 'partial') then raise exception 'INVENTORY_INVALID' using errcode = 'P0001'; end if;
  if location is not null and not exists (select 1 from public.inventory_locations l where l.id = location and l.branch_id = branch) then raise exception 'INVENTORY_LOCATION_INVALID' using errcode = 'P0001'; end if;
  insert into public.inventory_counts (company_id, number, branch_id, location_id, scope, notes, started_by)
  values (target, ba_private.inv_next(target, 'count', 'CF'), branch, location, p_scope, nullif(left(btrim(coalesce(p_notes, '')), 500), ''), (select auth.uid())) returning id into cid;
  perform ba_private.inv_log(target, 'inventory_counts', cid::text, 'started', jsonb_build_object('scope', p_scope, 'branch', branch));
  return cid;
end $$;

-- set (typed) or add (each scan adds 1) a counted quantity
create or replace function public.inventory_count_record(count uuid, item uuid, variant uuid, qty numeric, p_mode text)
returns numeric language plpgsql security definer set search_path = '' as $$
declare c public.inventory_counts; v numeric;
begin
  select * into c from public.inventory_counts x where x.id = count;
  if c.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.inv_require(c.company_id, 'inventory.operate', c.branch_id);
  if c.status <> 'open' then raise exception 'COUNT_NOT_OPEN' using errcode = 'P0001'; end if;
  if p_mode not in ('set', 'add') or qty is null or qty < 0 or qty >= 100000000000 then raise exception 'INVENTORY_QTY_INVALID' using errcode = 'P0001'; end if;
  perform ba_private.inv_check_item(c.company_id, item, variant);
  insert into public.inventory_count_lines (company_id, count_id, item_id, variant_key, counted_qty, scans, updated_by)
  values (c.company_id, c.id, item, ba_private.inv_vkey(variant), qty, case when p_mode = 'add' then 1 else 0 end, (select auth.uid()))
  on conflict (count_id, item_id, variant_key) do update set
    counted_qty = case when p_mode = 'add' then public.inventory_count_lines.counted_qty + excluded.counted_qty else excluded.counted_qty end,
    scans = public.inventory_count_lines.scans + excluded.scans, updated_by = excluded.updated_by, updated_at = now()
  returning counted_qty into v;
  return v;
end $$;

create or replace function public.inventory_count_step(count uuid, p_action text)
returns text language plpgsql security definer set search_path = '' as $$
declare c public.inventory_counts; ln public.inventory_count_lines; s record; cur numeric; mid bigint; nxt text; zero uuid := '00000000-0000-0000-0000-000000000000';
begin
  select * into c from public.inventory_counts x where x.id = count for update;
  if c.id is null then raise exception 'INVENTORY_NOT_FOUND' using errcode = 'P0001'; end if;
  case p_action
    when 'submit' then
      perform ba_private.inv_require(c.company_id, 'inventory.operate', c.branch_id);
      if c.status <> 'open' then raise exception 'COUNT_NOT_OPEN' using errcode = 'P0001'; end if;
      -- a full count covers everything with stock: what was not counted is counted as zero
      if c.scope = 'full' then
        for s in select x.item_id, x.variant_key from public.inventory_location_stock x
                 where x.branch_id = c.branch_id and x.location_key = coalesce(c.location_id, x.location_key) and x.on_hand <> 0
                   and not exists (select 1 from public.inventory_count_lines y where y.count_id = c.id and y.item_id = x.item_id and y.variant_key = x.variant_key)
                 group by 1, 2 loop
          insert into public.inventory_count_lines (company_id, count_id, item_id, variant_key, counted_qty, updated_by)
          values (c.company_id, c.id, s.item_id, s.variant_key, 0, (select auth.uid())) on conflict do nothing;
        end loop;
      end if;
      update public.inventory_count_lines y set expected_qty = public.inventory_on_hand(c.branch_id, y.item_id, nullif(y.variant_key, zero), c.location_id),
             difference_qty = y.counted_qty - public.inventory_on_hand(c.branch_id, y.item_id, nullif(y.variant_key, zero), c.location_id)
       where y.count_id = c.id;
      nxt := 'submitted';
      update public.inventory_counts set status = nxt, submitted_by = (select auth.uid()), submitted_at = now() where id = c.id;
    when 'approve' then   -- differences are posted against the stock AT APPROVAL (movements in between are respected)
      perform ba_private.inv_require(c.company_id, 'inventory.approve', c.branch_id);
      if c.status <> 'submitted' then raise exception 'COUNT_NOT_SUBMITTED' using errcode = 'P0001'; end if;
      for ln in select * from public.inventory_count_lines y where y.count_id = c.id for update loop
        cur := public.inventory_on_hand(c.branch_id, ln.item_id, nullif(ln.variant_key, zero), c.location_id);
        mid := null;
        if ln.counted_qty <> cur then
          mid := ba_private.inv_post(c.company_id, c.branch_id, c.location_id, ln.item_id, nullif(ln.variant_key, zero), 'count', ln.counted_qty - cur, null,
                                     c.number, 'count', c.id, null, null, 'cnt:' || c.id || ':' || ln.id);
        end if;
        update public.inventory_count_lines set expected_qty = cur, difference_qty = ln.counted_qty - cur, movement_id = mid where id = ln.id;
      end loop;
      nxt := 'approved';
      update public.inventory_counts set status = nxt, approved_by = (select auth.uid()), approved_at = now() where id = c.id;
    when 'reopen' then
      perform ba_private.inv_require(c.company_id, 'inventory.approve', c.branch_id);
      if c.status <> 'submitted' then raise exception 'COUNT_NOT_SUBMITTED' using errcode = 'P0001'; end if;
      nxt := 'open';
      update public.inventory_counts set status = nxt where id = c.id;
    when 'cancel' then
      perform ba_private.inv_require(c.company_id, 'inventory.operate', c.branch_id);
      if c.status not in ('open', 'submitted') then raise exception 'COUNT_NOT_OPEN' using errcode = 'P0001'; end if;
      nxt := 'cancelled';
      update public.inventory_counts set status = nxt where id = c.id;
    else raise exception 'INVENTORY_INVALID' using errcode = 'P0001';
  end case;
  perform ba_private.inv_log(c.company_id, 'inventory_counts', c.id::text, p_action, jsonb_build_object('from', c.status, 'to', nxt));
  return nxt;
end $$;

-- ===================================================================== replenishment data (no invented figures)
-- sales velocity only from recorded 'sale' movements of the last 90 days; null when there are none
create or replace function public.inventory_replenishment_data(target uuid, branch uuid default null)
returns table (branch_id uuid, item_id uuid, variant_key uuid, on_hand numeric, reserved numeric, committed numeric, available numeric, in_transit numeric, on_order numeric,
               min_qty numeric, max_qty numeric, reorder_point numeric, reorder_qty numeric, preferred_vendor_id uuid, lead_time_days integer,
               sold_90d numeric, sale_days integer, first_sale date, unit_cost_cents numeric)
language sql stable security definer set search_path = '' as $$
  with lv as (select * from public.inventory_levels(target, branch)),
  st as (select s.* from public.inventory_item_settings s where s.company_id = target and (branch is null or s.branch_id = branch) and public.inventory_branch_ok(target, s.branch_id)),
  k as (select lv.branch_id, lv.item_id, lv.variant_key from lv union select st.branch_id, st.item_id, st.variant_key from st)
  select k.branch_id, k.item_id, k.variant_key, coalesce(lv.on_hand, 0), coalesce(lv.reserved, 0), coalesce(lv.committed, 0), coalesce(lv.available, 0),
         coalesce(lv.in_transit, 0), coalesce(lv.on_order, 0), st.min_qty, st.max_qty, st.reorder_point, st.reorder_qty, st.preferred_vendor_id, st.lead_time_days,
         sales.sold, sales.days, sales.first_sale,
         coalesce((select v.cost_cents from public.catalog_variants v where v.id = nullif(k.variant_key, '00000000-0000-0000-0000-000000000000'::uuid)),
                  (select i.cost_cents from public.catalog_items i where i.id = k.item_id))
  from k left join lv on lv.branch_id = k.branch_id and lv.item_id = k.item_id and lv.variant_key = k.variant_key
  left join st on st.branch_id = k.branch_id and st.item_id = k.item_id and st.variant_key = k.variant_key
  left join lateral (select -sum(m.quantity) as sold, count(distinct (m.occurred_at at time zone 'America/Puerto_Rico')::date)::integer as days,
                            min((m.occurred_at at time zone 'America/Puerto_Rico')::date) as first_sale
                     from public.inventory_movements m where m.branch_id = k.branch_id and m.item_id = k.item_id
                       and ba_private.inv_vkey(m.variant_id) = k.variant_key and m.kind = 'sale' and m.occurred_at > now() - interval '90 days'
                     having count(*) > 0) sales on true
  where public.has_permission(target, 'inventory.view')
$$;

-- consistency: the caches equal the ledger (used by tests and the reports page)
create or replace function public.inventory_verify(target uuid)
returns table (problem text, branch_id uuid, item_id uuid, variant_key uuid, cached numeric, ledger numeric)
language sql stable security definer set search_path = '' as $$
  select 'stock', s.branch_id, s.item_id, s.variant_key, s.on_hand, coalesce(m.q, 0)
  from public.inventory_stock s
  left join (select x.branch_id, x.item_id, ba_private.inv_vkey(x.variant_id) vk, sum(x.quantity) q from public.inventory_movements x where x.company_id = target group by 1, 2, 3) m
    on m.branch_id = s.branch_id and m.item_id = s.item_id and m.vk = s.variant_key
  where s.company_id = target and s.on_hand <> coalesce(m.q, 0) and public.has_permission(target, 'inventory.view')
  union all
  select 'layers', s.branch_id, s.item_id, s.variant_key, s.on_hand, coalesce((select sum(l.qty_remaining) from public.inventory_cost_layers l
           where l.branch_id = s.branch_id and l.item_id = s.item_id and l.variant_key = s.variant_key), 0)
  from public.inventory_stock s
  where s.company_id = target and s.on_hand >= 0 and public.has_permission(target, 'inventory.view')
    and s.on_hand <> coalesce((select sum(l.qty_remaining) from public.inventory_cost_layers l where l.branch_id = s.branch_id and l.item_id = s.item_id and l.variant_key = s.variant_key), 0)
$$;

-- ===================================================================== grants
do $$ declare f text; begin
  foreach f in array array[
    'public.catalog_set_cost(uuid, uuid, bigint, text)', 'public.catalog_variant_save(uuid, uuid, text, jsonb, bigint, bigint)', 'public.catalog_variant_set_status(uuid, text)',
    'public.catalog_barcode_add(uuid, uuid, text, text, boolean)', 'public.catalog_barcode_remove(uuid)', 'public.inventory_lookup(uuid, text)',
    'public.inventory_settings_save(uuid, boolean, text)', 'public.inventory_location_save(uuid, uuid, uuid, text, text, boolean)',
    'public.inventory_item_settings_save(uuid, uuid, uuid, uuid, numeric, numeric, numeric, numeric, uuid, integer)',
    'public.inventory_move(uuid, uuid, uuid, text, jsonb, text, uuid, text)', 'public.inventory_issue_document(uuid, uuid, uuid)',
    'public.inventory_adjust(uuid, uuid, uuid, text, jsonb, text, uuid, uuid, text)', 'public.inventory_adjustment_decide(uuid, boolean, text)',
    'public.inventory_correct(bigint, text)', 'public.inventory_revalue(uuid, uuid, uuid, uuid, numeric, text)',
    'public.inventory_reserve(uuid, uuid, uuid, uuid, numeric, text, text, uuid, text)', 'public.inventory_release(uuid, boolean)',
    'public.inventory_levels(uuid, uuid)', 'public.inventory_on_hand(uuid, uuid, uuid, uuid)',
    'public.purchase_order_save(uuid, uuid, uuid, uuid, date, text, jsonb, integer)', 'public.purchase_order_transition(uuid, text, text)',
    'public.purchase_order_receive(uuid, jsonb, text, text)', 'public.purchase_order_link_bill(uuid, uuid)', 'public.purchase_orders_from_suggestions(uuid, jsonb)',
    'public.inventory_transfer_request(uuid, uuid, uuid, jsonb, text, text)', 'public.inventory_transfer_step(uuid, text, jsonb, text)',
    'public.inventory_count_start(uuid, uuid, uuid, text, text)', 'public.inventory_count_record(uuid, uuid, uuid, numeric, text)', 'public.inventory_count_step(uuid, text)',
    'public.inventory_replenishment_data(uuid, uuid)', 'public.inventory_verify(uuid)', 'public.inventory_branch_ok(uuid, uuid)',
    'public.ba_gtin_valid(text)', 'public.ba_upce_valid(text)', 'public.ba_barcode_valid(text, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['public.catalog_code_conflict(uuid, text, uuid, uuid, uuid)', 'public.catalog_items_code_guard()', 'public.inventory_guard()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
revoke all on all functions in schema ba_private from public, anon, authenticated;

-- ===================================================================== self-check
do $$ begin
  if has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT') or has_table_privilege('authenticated', 'public.inventory_stock', 'UPDATE')
     or has_table_privilege('authenticated', 'public.catalog_barcodes', 'INSERT') or has_table_privilege('anon', 'public.inventory_movements', 'SELECT') then
    raise exception 'BA0043 self-check failed: inventory writable directly or readable by anon';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'inventory.approve') then
    raise exception 'BA0043 self-check failed: members must not approve inventory';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'ba_private')
        and (p.proname like 'inventory%' or p.proname like 'inv\_%' or p.proname like 'purchase_order%' or p.proname like 'catalog_variant%' or p.proname like 'catalog_barcode%')
        and p.prosecdef and not (p.proconfig @> array['search_path=""'])) > 0 then
    raise exception 'BA0043 self-check failed: definer without search_path';
  end if;
end $$;

commit;
