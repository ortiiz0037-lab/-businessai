-- =====================================================================
-- BusinessAI · Migration 0042 · Banking, payments & smart receipt capture (S6)
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0026 (bank), 0025 (receivables), 0024 (payables), 0035 (branches).
--
-- Builds on the existing modules, without parallel financial data:
--   * bank connections through a financial data provider (Plaid first). The
--     provider's access token is stored ENCRYPTED by the server (AES-256-GCM,
--     key only on the server) in ba_private (never exposed by the API). Never a
--     bank password: the provider's own flow (Link) collects credentials.
--   * synced transactions are ordinary bank_lines of 0026: each sync run is a
--     bank_imports row (source 'provider'); the provider transaction id is the
--     line fingerprint ('id:<txid>'), so a repeated sync or webhook inserts
--     nothing new. Removed transactions are excluded (if not matched).
--   * webhooks and automatic syncs have no user: they write only through
--     functions that verify an HMAC signature of the server (BANK_SERVER_KEYS,
--     same scheme as 0030), a fresh timestamp and a single-use nonce. Webhook
--     events are idempotent by the SHA-256 of the body.
--   * deposits applied to invoices: a confirmed decision creates the client
--     payment through the normal insert (balance checks, ledger posting of
--     0015 / 0023 / 0026), records an allocation (deposit → payment) and, when
--     the deposit is fully applied, matches the bank line with the payments'
--     journal lines (bank_match of 0026). An existing payment can be linked
--     instead (no new payment). One payment never has two allocations; a
--     deposit is never applied beyond its amount.
--   * manual payments: branch, notes and evidence (a receipt capture).
--   * receipt captures: the original file in the private bucket
--     Banking-evidence, OCR suggestions (provider-neutral), the confirmed data
--     and the link to an expense or a payment. Duplicate files are refused.
--   * branches: bank accounts and bank lines carry a branch (0035).
-- Rollback: supabase/rollback/0042_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$ begin
  if to_regclass('public.bank_lines') is null or to_regclass('public.branches') is null or to_regclass('public.bill_attachments') is null
     or to_regprocedure('ba_private.hmac_sha256(bytea, bytea)') is null then
    raise exception 'BA0042: migrations 0024, 0026, 0030 and 0035 must be applied first';
  end if;
end $$;

-- ===================================================================== server keys (webhooks / syncs without a user)
create table if not exists ba_private.bank_server_keys (
  key_id text primary key check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  secret bytea not null check (octet_length(secret) between 32 and 128),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create table if not exists ba_private.bank_nonces (nonce uuid primary key, expires_at timestamptz not null);
-- the provider access token, encrypted by the server; never readable through the API
create table if not exists ba_private.bank_connection_secrets (
  connection_id uuid primary key,
  token_ciphertext text not null check (char_length(token_ciphertext) between 20 and 4000),
  key_version text not null check (key_version ~ '^[A-Za-z0-9_-]{1,32}$'),
  updated_at timestamptz not null default now()
);
revoke all on ba_private.bank_server_keys, ba_private.bank_nonces, ba_private.bank_connection_secrets from public, anon, authenticated;

create or replace function ba_private.bank_verify(key text, msg text, mac text, ts bigint, nonce uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s bytea;
begin
  select k.secret into s from ba_private.bank_server_keys k where k.key_id = key and (k.retired_at is null or k.retired_at > now());
  if s is null then raise exception 'BANK_SERVER_AUTH' using errcode = 'P0001', hint = 'key'; end if;
  if mac is null or lower(mac) !~ '^[0-9a-f]{64}$' or encode(ba_private.hmac_sha256(s, convert_to(msg, 'UTF8')), 'hex') <> lower(mac) then
    raise exception 'BANK_SERVER_AUTH' using errcode = 'P0001', hint = 'mac';
  end if;
  if ts is null or abs(extract(epoch from now()) - ts) > 120 then raise exception 'BANK_SERVER_AUTH' using errcode = 'P0001', hint = 'stale'; end if;
  delete from ba_private.bank_nonces where expires_at < now();
  begin
    insert into ba_private.bank_nonces (nonce, expires_at) values (nonce, now() + interval '10 minutes');
  exception when unique_violation then raise exception 'BANK_SERVER_AUTH' using errcode = 'P0001', hint = 'replay';
  end;
end $$;

/** Database owner / service role only (not callable by users): registers the server key also set as BANK_SERVER_KEYS="<id>:<base64>". */
create or replace function public.bank_set_server_key(key text, secret_b64 text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into ba_private.bank_server_keys (key_id, secret) values (key, decode(secret_b64, 'base64'))
  on conflict (key_id) do update set secret = excluded.secret, retired_at = null;
end $$;
create or replace function public.bank_retire_server_key(key text, at_time timestamptz default now() + interval '1 hour')
returns void language sql security definer set search_path = '' as $$
  update ba_private.bank_server_keys set retired_at = at_time where key_id = key
$$;
revoke all on function public.bank_set_server_key(text, text), public.bank_retire_server_key(text, timestamptz) from public, anon, authenticated;
grant execute on function public.bank_set_server_key(text, text), public.bank_retire_server_key(text, timestamptz) to service_role;

-- ===================================================================== tables
create table if not exists public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider in ('plaid')),
  environment text not null check (environment in ('sandbox', 'production', 'test_double')),
  item_id text not null check (char_length(item_id) between 1 and 200),
  institution_id text check (institution_id is null or char_length(institution_id) <= 100),
  institution_name text check (institution_name is null or char_length(institution_name) <= 200),
  status text not null default 'active' check (status in ('active', 'login_required', 'pending_disconnect', 'revoked', 'error', 'disconnected')),
  error_code text check (error_code is null or char_length(error_code) <= 100),
  sync_cursor text check (sync_cursor is null or char_length(sync_cursor) <= 2000),
  last_sync_at timestamptz,
  last_success_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  disconnected_at timestamptz, disconnected_by uuid,
  unique (company_id, id),
  unique (provider, item_id)
);
create table if not exists public.bank_provider_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  connection_id uuid not null,
  provider_account_id text not null check (char_length(provider_account_id) between 1 and 200),
  name text not null check (char_length(name) between 1 and 200),
  mask text check (mask is null or mask ~ '^[0-9A-Za-z]{2,4}$'),
  type text check (type is null or char_length(type) <= 40),
  subtype text check (subtype is null or char_length(subtype) <= 40),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  bank_account_id uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (connection_id, provider_account_id),
  foreign key (company_id, connection_id) references public.bank_connections (company_id, id) on delete cascade,
  foreign key (company_id, bank_account_id) references public.bank_accounts (company_id, id)
);
create unique index if not exists bank_provider_accounts_bank_uidx on public.bank_provider_accounts (bank_account_id) where bank_account_id is not null;

create table if not exists public.bank_sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  connection_id uuid not null,
  trigger text not null check (trigger in ('manual', 'webhook', 'initial')),
  status text not null check (status in ('succeeded', 'failed')),
  added integer not null default 0 check (added >= 0),
  duplicates integer not null default 0 check (duplicates >= 0),
  removed integer not null default 0 check (removed >= 0),
  pending_skipped integer not null default 0 check (pending_skipped >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 100),
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  actor uuid,
  unique (company_id, id),
  foreign key (company_id, connection_id) references public.bank_connections (company_id, id) on delete cascade
);
create index if not exists bank_sync_runs_conn_idx on public.bank_sync_runs (connection_id, started_at desc);

create table if not exists public.bank_webhook_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('plaid')),
  event_key text not null check (event_key ~ '^[0-9a-f]{64}$'),           -- SHA-256 of the raw body: a retried delivery is the same event
  company_id uuid references public.companies(id) on delete cascade,
  connection_id uuid,
  webhook_type text check (webhook_type is null or char_length(webhook_type) <= 60),
  webhook_code text check (webhook_code is null or char_length(webhook_code) <= 60),
  outcome text not null check (outcome in ('recorded', 'unknown_item', 'status_changed', 'sync_requested', 'ignored')),
  received_at timestamptz not null default now(),
  unique (provider, event_key)
);

alter table public.bank_imports add column if not exists source text not null default 'file';
alter table public.bank_imports add column if not exists sync_run_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bank_imports_source_check') then
    alter table public.bank_imports add constraint bank_imports_source_check check (source in ('file', 'provider'));
  end if;
end $$;

alter table public.bank_accounts add column if not exists branch_id uuid;
alter table public.bank_lines add column if not exists branch_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bank_accounts_branch_fk') then
    alter table public.bank_accounts add constraint bank_accounts_branch_fk foreign key (company_id, branch_id) references public.branches (company_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bank_lines_branch_fk') then
    alter table public.bank_lines add constraint bank_lines_branch_fk foreign key (company_id, branch_id) references public.branches (company_id, id);
  end if;
end $$;

-- a deposit (bank line, money in) applied to a client payment
create table if not exists public.bank_line_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_line_id uuid not null,
  payment_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  kind text not null check (kind in ('new_payment', 'existing_payment')),
  confidence integer check (confidence is null or confidence between 0 and 100),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz, voided_by uuid, void_reason text,
  unique (company_id, id),
  check ((voided_at is null) = (void_reason is null)),
  foreign key (company_id, bank_line_id) references public.bank_lines (company_id, id)
);
create unique index if not exists bank_line_allocations_payment_uidx on public.bank_line_allocations (payment_id) where voided_at is null;
create index if not exists bank_line_allocations_line_idx on public.bank_line_allocations (bank_line_id);

create table if not exists public.receipt_captures (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid,
  storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/receipts/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'),
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'captured' check (status in ('captured', 'confirmed', 'discarded')),
  ocr_provider text check (ocr_provider is null or char_length(ocr_provider) <= 40),
  ocr_status text not null default 'pending' check (ocr_status in ('pending', 'not_configured', 'succeeded', 'failed')),
  ocr_error text check (ocr_error is null or char_length(ocr_error) <= 100),
  extracted jsonb not null default '{}'::jsonb check (jsonb_typeof(extracted) = 'object' and octet_length(extracted::text) < 20000),
  confirmed jsonb check (confirmed is null or (jsonb_typeof(confirmed) = 'object' and octet_length(confirmed::text) < 8000)),
  bill_id uuid,
  payment_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  confirmed_by uuid, confirmed_at timestamptz,
  unique (company_id, id),
  check (split_part(storage_path, '/', 1) = company_id::text),
  foreign key (company_id, branch_id) references public.branches (company_id, id),
  foreign key (company_id, bill_id) references public.bills (company_id, id)
);
-- the same file twice is the same receipt
create unique index if not exists receipt_captures_file_uidx on public.receipt_captures (company_id, sha256) where status <> 'discarded';

alter table public.payments add column if not exists branch_id uuid;
alter table public.payments add column if not exists notes text;
alter table public.payments add column if not exists evidence_capture_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_notes_check') then
    alter table public.payments add constraint payments_notes_check check (notes is null or char_length(notes) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_branch_fk') then
    alter table public.payments add constraint payments_branch_fk foreign key (branch_id) references public.branches (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_evidence_fk') then
    alter table public.payments add constraint payments_evidence_fk foreign key (evidence_capture_id) references public.receipt_captures (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'receipt_captures_payment_fk') then
    alter table public.receipt_captures add constraint receipt_captures_payment_fk foreign key (payment_id) references public.payments (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bank_line_allocations_payment_fk') then
    alter table public.bank_line_allocations add constraint bank_line_allocations_payment_fk foreign key (payment_id) references public.payments (id);
  end if;
end $$;

-- payments: the branch and the evidence belong to the company (set when the payment is recorded; payments are immutable)
create or replace function public.payment_s6_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.branch_id is not null and not exists (select 1 from public.branches b where b.id = new.branch_id and b.company_id = new.company_id and b.archived_at is null) then
    raise exception 'BRANCH_INVALID' using errcode = 'P0001';
  end if;
  if new.evidence_capture_id is not null and not exists (select 1 from public.receipt_captures r where r.id = new.evidence_capture_id and r.company_id = new.company_id and r.status <> 'discarded') then
    raise exception 'EVIDENCE_INVALID' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_payment_s6_guard on public.payments;
create trigger ba_payment_s6_guard before insert on public.payments for each row execute function public.payment_s6_guard();

-- bank lines: the branch may change too (only the workflow fields otherwise, as in 0026)
create or replace function public.bank_record_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(old, new));
  frozen boolean;
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone((r ->> 'company_id')::uuid) then return old; end if;
    raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  if tg_table_name = 'bank_lines' then
    if (to_jsonb(new) - array['status', 'reconciliation_id', 'branch_id']) <> (to_jsonb(old) - array['status', 'reconciliation_id', 'branch_id']) then
      raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
    frozen := old.reconciliation_id is not null and public.bank_rec_closed(old.reconciliation_id);
    if frozen and (new.status <> old.status or new.reconciliation_id is distinct from old.reconciliation_id) then
      raise exception 'BANK_LINE_RECONCILED' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'bank_match_groups' then
    if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason', 'reconciliation_id']) <> (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason', 'reconciliation_id'])
       or (old.voided_at is not null and new.voided_at is distinct from old.voided_at) then
      raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
    if old.reconciliation_id is not null and public.bank_rec_closed(old.reconciliation_id) and new.voided_at is not null and old.voided_at is null then
      raise exception 'BANK_LINE_RECONCILED' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'bank_match_items' then
    if (to_jsonb(new) - 'active') <> (to_jsonb(old) - 'active') or (old.active = false and new.active) then
      raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
  elsif tg_table_name = 'bank_imports' then
    if (to_jsonb(new) - array['status', 'reverted_at', 'reverted_by', 'revert_reason']) <> (to_jsonb(old) - array['status', 'reverted_at', 'reverted_by', 'revert_reason'])
       or old.status = 'reverted' then
      raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
  end if;
  return new;
end $$;

-- allocations: only the void fields move, once
create or replace function public.bank_allocation_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = 'bank_line_allocations';
  end if;
  if old.voided_at is not null or (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason']) <> (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = 'bank_line_allocations';
  end if;
  return new;
end $$;
drop trigger if exists ba_bank_allocation_guard on public.bank_line_allocations;
create trigger ba_bank_allocation_guard before update or delete on public.bank_line_allocations for each row execute function public.bank_allocation_guard();

-- RLS: read with bank.view (receipts: also whoever may record expenses or payments, and the author)
do $$
declare t text;
begin
  foreach t in array array['bank_connections', 'bank_provider_accounts', 'bank_sync_runs', 'bank_webhook_events', 'bank_line_allocations', 'receipt_captures'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
drop policy if exists ba_bank_connections_select on public.bank_connections;
create policy ba_bank_connections_select on public.bank_connections for select to authenticated using (public.has_permission(company_id, 'bank.view'));
drop policy if exists ba_bank_provider_accounts_select on public.bank_provider_accounts;
create policy ba_bank_provider_accounts_select on public.bank_provider_accounts for select to authenticated using (public.has_permission(company_id, 'bank.view'));
drop policy if exists ba_bank_sync_runs_select on public.bank_sync_runs;
create policy ba_bank_sync_runs_select on public.bank_sync_runs for select to authenticated using (public.has_permission(company_id, 'bank.view'));
drop policy if exists ba_bank_webhook_events_select on public.bank_webhook_events;
create policy ba_bank_webhook_events_select on public.bank_webhook_events for select to authenticated using (company_id is not null and public.has_permission(company_id, 'bank.manage'));
drop policy if exists ba_bank_line_allocations_select on public.bank_line_allocations;
create policy ba_bank_line_allocations_select on public.bank_line_allocations for select to authenticated using (public.has_permission(company_id, 'bank.view'));
drop policy if exists ba_receipt_captures_select on public.receipt_captures;
create policy ba_receipt_captures_select on public.receipt_captures for select to authenticated
  using (public.has_permission(company_id, 'bank.view') or public.has_permission(company_id, 'payables.view') or created_by = (select auth.uid()));

-- ===================================================================== private bucket for evidence
do $$
declare b record;
begin
  select * into b from storage.buckets where id = 'Banking-evidence';
  if b.id is null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('Banking-evidence', 'Banking-evidence', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  elsif b.public then
    raise exception 'BA0042: bucket Banking-evidence exists but is PUBLIC; make it private first';
  end if;
end $$;
create or replace function public.can_capture_evidence(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select target is not null and (public.has_permission(target, 'payables.create') or public.has_permission(target, 'payments.record') or public.has_permission(target, 'bank.manage'))
$$;
drop policy if exists ba_banking_evidence_select on storage.objects;
create policy ba_banking_evidence_select on storage.objects for select to authenticated
  using (bucket_id = 'Banking-evidence' and (public.has_permission(public.storage_company_id(name), 'bank.view') or public.has_permission(public.storage_company_id(name), 'payables.view')
         or exists (select 1 from public.receipt_captures r where r.storage_path = name and r.created_by = (select auth.uid()))
         -- an upload not registered yet (the upload itself, or its clean-up after a failed registration)
         or (public.can_capture_evidence(public.storage_company_id(name)) and not exists (select 1 from public.receipt_captures r where r.storage_path = name))));
drop policy if exists ba_banking_evidence_insert on storage.objects;
create policy ba_banking_evidence_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'Banking-evidence' and public.can_capture_evidence(public.storage_company_id(name))
              and name ~ '^[0-9a-f-]{36}/receipts/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$');
-- only a file that is not (or no longer) registered: an upload whose record failed
drop policy if exists ba_banking_evidence_delete on storage.objects;
create policy ba_banking_evidence_delete on storage.objects for delete to authenticated
  using (bucket_id = 'Banking-evidence' and public.can_capture_evidence(public.storage_company_id(name))
         and not exists (select 1 from public.receipt_captures r where r.storage_path = name));

-- ===================================================================== connections (user + server signature)
-- payload: {"provider","environment","item_id","institution_id","institution_name","token_ciphertext","key_version",
--           "accounts":[{"id","name","mask","type","subtype","currency"}]}
create or replace function public.bank_connection_save(target uuid, payload text, key text, ts bigint, nonce uuid, mac text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare p jsonb; cid uuid; a jsonb; me uuid := (select auth.uid());
begin
  if me is null or not public.has_permission(target, 'bank.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform ba_private.bank_verify(key, concat_ws('|', 'bank_connect', 'v1', key, lower(me::text), target::text, ts::text, nonce::text, ba_private.sha_hex(payload)), mac, ts, nonce);
  p := payload::jsonb;
  if p ->> 'provider' <> 'plaid' or coalesce(p ->> 'environment', '') not in ('sandbox', 'production', 'test_double') or coalesce(p ->> 'item_id', '') = ''
     or coalesce(p ->> 'token_ciphertext', '') = '' or jsonb_typeof(p -> 'accounts') <> 'array' or jsonb_array_length(p -> 'accounts') > 50 then
    raise exception 'BANK_CONNECTION_INVALID' using errcode = 'P0001';
  end if;
  select c.id into cid from public.bank_connections c where c.provider = p ->> 'provider' and c.item_id = p ->> 'item_id';
  if cid is not null and not exists (select 1 from public.bank_connections c where c.id = cid and c.company_id = target) then
    raise exception 'BANK_CONNECTION_INVALID' using errcode = 'P0001', hint = 'other_company';
  end if;
  if cid is null then
    insert into public.bank_connections (company_id, provider, environment, item_id, institution_id, institution_name, created_by)
    values (target, p ->> 'provider', p ->> 'environment', p ->> 'item_id', left(p ->> 'institution_id', 100), left(p ->> 'institution_name', 200), me)
    returning id into cid;
  else   -- reconnection (update mode): the same item, a new token
    update public.bank_connections set status = 'active', error_code = null, disconnected_at = null, disconnected_by = null where id = cid;
  end if;
  insert into ba_private.bank_connection_secrets (connection_id, token_ciphertext, key_version) values (cid, p ->> 'token_ciphertext', coalesce(p ->> 'key_version', 'v1'))
  on conflict (connection_id) do update set token_ciphertext = excluded.token_ciphertext, key_version = excluded.key_version, updated_at = now();
  for a in select * from jsonb_array_elements(p -> 'accounts') loop
    insert into public.bank_provider_accounts (company_id, connection_id, provider_account_id, name, mask, type, subtype, currency)
    values (target, cid, a ->> 'id', left(coalesce(nullif(a ->> 'name', ''), 'Cuenta'), 200), nullif(left(regexp_replace(coalesce(a ->> 'mask', ''), '[^0-9A-Za-z]', '', 'g'), 4), ''),
            left(a ->> 'type', 40), left(a ->> 'subtype', 40), nullif(upper(coalesce(a ->> 'currency', '')), ''))
    on conflict (connection_id, provider_account_id) do update set name = excluded.name, mask = excluded.mask, type = excluded.type, subtype = excluded.subtype;
  end loop;
  perform public.bank_log(target, null, 'bank_connections', cid::text, 'connected',
    jsonb_build_object('provider', p ->> 'provider', 'environment', p ->> 'environment', 'institution', p ->> 'institution_name', 'accounts', jsonb_array_length(p -> 'accounts')));
  return cid;
end $$;

-- link a provider account to a BusinessAI bank account (only linked accounts are synced)
create or replace function public.bank_link_provider_account(provider_account uuid, account uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare pa public.bank_provider_accounts; b public.bank_accounts;
begin
  select * into pa from public.bank_provider_accounts where id = provider_account;
  if pa.id is null or not public.has_permission(pa.company_id, 'bank.manage') then raise exception 'BANK_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if account is null then
    update public.bank_provider_accounts set bank_account_id = null where id = pa.id;
  else
    b := public.bank_account_for(account, 'bank.manage');
    if b.company_id <> pa.company_id or b.status <> 'active' then raise exception 'BANK_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
    update public.bank_provider_accounts set bank_account_id = b.id where id = pa.id;
    -- a newly linked account is synced from the start (the cursor restarts; known transactions are skipped by id)
    if pa.bank_account_id is distinct from b.id then update public.bank_connections set sync_cursor = null where id = pa.connection_id; end if;
    update public.bank_accounts set last4 = coalesce(last4, case when pa.mask ~ '^[0-9]{4}$' then pa.mask end), updated_at = now() where id = b.id;
  end if;
  perform public.bank_log(pa.company_id, account, 'bank_provider_accounts', pa.id::text, 'linked', jsonb_build_object('bank_account', account));
end $$;

-- the sync context for the server: token ciphertext, cursor and the linked accounts (signature, no user needed)
create or replace function public.bank_sync_context(connection uuid, key text, ts bigint, nonce uuid, mac text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.bank_connections; s ba_private.bank_connection_secrets;
begin
  perform ba_private.bank_verify(key, concat_ws('|', 'bank_ctx', 'v1', key, connection::text, ts::text, nonce::text), mac, ts, nonce);
  select * into c from public.bank_connections where id = connection;
  if c.id is null then raise exception 'BANK_CONNECTION_NOT_FOUND' using errcode = 'P0001'; end if;
  if (select auth.uid()) is not null and not public.has_permission(c.company_id, 'bank.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into s from ba_private.bank_connection_secrets where connection_id = c.id;
  return jsonb_build_object('company_id', c.company_id, 'provider', c.provider, 'environment', c.environment, 'status', c.status, 'cursor', c.sync_cursor,
    'token_ciphertext', s.token_ciphertext, 'key_version', s.key_version,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('provider_account_id', a.provider_account_id, 'bank_account_id', a.bank_account_id))
                          from public.bank_provider_accounts a where a.connection_id = c.id and a.bank_account_id is not null), '[]'::jsonb));
end $$;

-- the result of a sync: new lines per linked account (idempotent by transaction id), removed ids, cursor, status
-- payload: {"trigger","status","error_code","cursor","pending_skipped",
--           "accounts":[{"bank_account_id","rows":[{"date","amount_cents","description","reference","bank_txn_id","raw"}]}],"removed":["txid",…]}
create or replace function public.bank_sync_apply(connection uuid, payload text, key text, ts bigint, nonce uuid, mac text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.bank_connections; p jsonb; acc jsonb; r jsonb; b public.bank_accounts;
  run uuid := gen_random_uuid(); iid uuid; lid uuid; n_add integer := 0; n_dup integer := 0; n_rm integer := 0; fp text;
  d date; amt bigint; descr text; ok boolean;
begin
  perform ba_private.bank_verify(key, concat_ws('|', 'bank_apply', 'v1', key, connection::text, ts::text, nonce::text, ba_private.sha_hex(payload)), mac, ts, nonce);
  select * into c from public.bank_connections where id = connection for update;
  if c.id is null then raise exception 'BANK_CONNECTION_NOT_FOUND' using errcode = 'P0001'; end if;
  if (select auth.uid()) is not null and not public.has_permission(c.company_id, 'bank.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  p := payload::jsonb;
  ok := p ->> 'status' = 'succeeded';
  if coalesce(p ->> 'trigger', '') not in ('manual', 'webhook', 'initial') or coalesce(p ->> 'status', '') not in ('succeeded', 'failed') then
    raise exception 'BANK_SYNC_INVALID' using errcode = 'P0001';
  end if;
  if ok then
    for acc in select * from jsonb_array_elements(coalesce(p -> 'accounts', '[]'::jsonb)) loop
      select * into b from public.bank_accounts x where x.id = (acc ->> 'bank_account_id')::uuid and x.company_id = c.company_id;
      if b.id is null or not exists (select 1 from public.bank_provider_accounts a where a.connection_id = c.id and a.bank_account_id = b.id) then
        raise exception 'BANK_SYNC_INVALID' using errcode = 'P0001', hint = 'account';
      end if;
      if jsonb_array_length(coalesce(acc -> 'rows', '[]'::jsonb)) = 0 then continue; end if;
      perform public.bank_lock(b.id);
      iid := gen_random_uuid();
      for r in select * from jsonb_array_elements(acc -> 'rows') loop
        if coalesce(r ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(r ->> 'amount_cents', '') !~ '^-?[0-9]{1,15}$' or (r ->> 'amount_cents')::bigint = 0
           or coalesce(r ->> 'bank_txn_id', '') = '' then
          raise exception 'BANK_SYNC_INVALID' using errcode = 'P0001', hint = 'row';
        end if;
        d := (r ->> 'date')::date; amt := (r ->> 'amount_cents')::bigint;
        descr := left(btrim(regexp_replace(coalesce(nullif(r ->> 'description', ''), '—'), '\s+', ' ', 'g')), 500);
        fp := 'id:' || left(r ->> 'bank_txn_id', 117);
        insert into public.bank_lines (company_id, bank_account_id, import_id, line_no, txn_date, description, reference, amount_cents, bank_txn_id, fingerprint, raw, branch_id)
        values (c.company_id, b.id, iid, n_add + n_dup + 1, d, descr, nullif(left(btrim(coalesce(r ->> 'reference', '')), 120), ''), amt, left(r ->> 'bank_txn_id', 120), fp,
                coalesce(r -> 'raw', '{}'::jsonb), b.branch_id)
        on conflict (bank_account_id, fingerprint) where status <> 'excluded' do nothing
        returning id into lid;
        if lid is null then n_dup := n_dup + 1; else n_add := n_add + 1; end if;
        lid := null;
      end loop;
      insert into public.bank_imports (id, company_id, bank_account_id, file_name, file_sha256, mapping, row_count, imported_count, duplicate_count, first_date, last_date,
                                       created_by, source, sync_run_id)
      values (iid, c.company_id, b.id, left(format('%s · sync %s', initcap(c.provider), to_char(now() at time zone 'America/Puerto_Rico', 'YYYY-MM-DD HH24:MI')), 200),
              encode(sha256(convert_to(run::text || b.id::text, 'UTF8')), 'hex'), jsonb_build_object('provider', c.provider, 'connection', c.id),
              jsonb_array_length(acc -> 'rows'), (select count(*) from public.bank_lines l where l.import_id = iid), jsonb_array_length(acc -> 'rows') - (select count(*) from public.bank_lines l where l.import_id = iid),
              (select min(l.txn_date) from public.bank_lines l where l.import_id = iid), (select max(l.txn_date) from public.bank_lines l where l.import_id = iid),
              (select auth.uid()), 'provider', run);
    end loop;
    -- removed by the bank: unmatched lines are excluded; matched ones stay (the reconciliation decides) and are logged
    update public.bank_lines l set status = 'excluded'
     where l.company_id = c.company_id and l.status = 'unmatched' and l.bank_txn_id = any (array(select jsonb_array_elements_text(coalesce(p -> 'removed', '[]'::jsonb))))
       and exists (select 1 from public.bank_provider_accounts a where a.connection_id = c.id and a.bank_account_id = l.bank_account_id);
    get diagnostics n_rm = row_count;
    if exists (select 1 from public.bank_lines l where l.company_id = c.company_id and l.status = 'matched'
                 and l.bank_txn_id = any (array(select jsonb_array_elements_text(coalesce(p -> 'removed', '[]'::jsonb))))) then
      perform public.bank_log(c.company_id, null, 'bank_connections', c.id::text, 'removed_but_matched', jsonb_build_object('note', 'the bank removed a transaction that is matched; review it'));
    end if;
  end if;
  insert into public.bank_sync_runs (id, company_id, connection_id, trigger, status, added, duplicates, removed, pending_skipped, error_code, actor)
  values (run, c.company_id, c.id, p ->> 'trigger', p ->> 'status', n_add, n_dup, n_rm, greatest(0, coalesce((p ->> 'pending_skipped')::integer, 0)),
          left(nullif(p ->> 'error_code', ''), 100), (select auth.uid()));
  update public.bank_connections set last_sync_at = now(),
         last_success_at = case when ok then now() else last_success_at end,
         sync_cursor = case when ok and p ? 'cursor' then left(p ->> 'cursor', 2000) else sync_cursor end,
         status = case when ok and status in ('error', 'login_required') then 'active'
                       when not ok and p ->> 'error_code' in ('ITEM_LOGIN_REQUIRED', 'login_required') then 'login_required'
                       when not ok and status = 'active' then 'error' else status end,
         error_code = case when ok then null else left(nullif(p ->> 'error_code', ''), 100) end
   where id = c.id;
  return jsonb_build_object('run', run, 'added', n_add, 'duplicates', n_dup, 'removed', n_rm);
end $$;

-- a provider webhook (no user): idempotent by the body hash; updates the connection status
-- payload: {"item_id","webhook_type","webhook_code","error_code"}
create or replace function public.bank_webhook_record(provider text, event_key text, payload text, key text, ts bigint, nonce uuid, mac text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare p jsonb; c public.bank_connections; outcome text; eid bigint; code text;
begin
  perform ba_private.bank_verify(key, concat_ws('|', 'bank_webhook', 'v1', key, provider, event_key, ts::text, nonce::text, ba_private.sha_hex(payload)), mac, ts, nonce);
  if provider <> 'plaid' or event_key !~ '^[0-9a-f]{64}$' then raise exception 'BANK_WEBHOOK_INVALID' using errcode = 'P0001'; end if;
  p := payload::jsonb;
  if exists (select 1 from public.bank_webhook_events e where e.provider = provider and e.event_key = event_key) then
    return jsonb_build_object('already', true);
  end if;
  select * into c from public.bank_connections x where x.provider = provider and x.item_id = p ->> 'item_id';
  code := upper(coalesce(p ->> 'webhook_code', ''));
  outcome := case
    when c.id is null then 'unknown_item'
    when c.status = 'disconnected' then 'ignored'
    when code in ('SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE') then 'sync_requested'
    when code in ('ERROR', 'PENDING_DISCONNECT', 'PENDING_EXPIRATION', 'USER_PERMISSION_REVOKED', 'USER_ACCOUNT_REVOKED', 'LOGIN_REPAIRED', 'NEW_ACCOUNTS_AVAILABLE') then 'status_changed'
    else 'recorded' end;
  insert into public.bank_webhook_events (provider, event_key, company_id, connection_id, webhook_type, webhook_code, outcome)
  values (provider, event_key, c.company_id, c.id, left(p ->> 'webhook_type', 60), left(code, 60), outcome)
  on conflict do nothing returning id into eid;
  if eid is null then return jsonb_build_object('already', true); end if;     -- a concurrent delivery of the same event
  if outcome = 'status_changed' then
    update public.bank_connections set
      status = case code when 'ERROR' then case when upper(coalesce(p ->> 'error_code', '')) = 'ITEM_LOGIN_REQUIRED' then 'login_required' else 'error' end
                         when 'PENDING_DISCONNECT' then 'pending_disconnect' when 'PENDING_EXPIRATION' then 'pending_disconnect'
                         when 'USER_PERMISSION_REVOKED' then 'revoked' when 'USER_ACCOUNT_REVOKED' then 'revoked'
                         when 'LOGIN_REPAIRED' then 'active' else status end,
      error_code = case when code = 'ERROR' then left(p ->> 'error_code', 100) when code = 'LOGIN_REPAIRED' then null else error_code end
     where id = c.id;
    perform public.bank_log(c.company_id, null, 'bank_connections', c.id::text, 'webhook_status', jsonb_build_object('code', code));
  end if;
  return jsonb_build_object('already', false, 'outcome', outcome, 'connection_id', c.id);
end $$;

-- disconnect (user; the server removes the item at the provider first): the token is erased, history stays
create or replace function public.bank_connection_disconnect(connection uuid, key text, ts bigint, nonce uuid, mac text)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.bank_connections; me uuid := (select auth.uid());
begin
  select * into c from public.bank_connections where id = connection for update;
  if c.id is null or me is null or not public.has_permission(c.company_id, 'bank.manage') then raise exception 'BANK_CONNECTION_NOT_FOUND' using errcode = 'P0001'; end if;
  perform ba_private.bank_verify(key, concat_ws('|', 'bank_disconnect', 'v1', key, lower(me::text), connection::text, ts::text, nonce::text), mac, ts, nonce);
  delete from ba_private.bank_connection_secrets where connection_id = c.id;
  update public.bank_connections set status = 'disconnected', disconnected_at = now(), disconnected_by = me, sync_cursor = null where id = c.id;
  perform public.bank_log(c.company_id, null, 'bank_connections', c.id::text, 'disconnected', '{}');
end $$;

-- ===================================================================== branches
create or replace function public.bank_account_set_branch(account uuid, branch uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bank_accounts := public.bank_account_for(account, 'bank.manage');
begin
  if branch is not null and not exists (select 1 from public.branches x where x.id = branch and x.company_id = b.company_id and x.archived_at is null) then
    raise exception 'BRANCH_INVALID' using errcode = 'P0001';
  end if;
  update public.bank_accounts set branch_id = branch, updated_at = now() where id = b.id;
  perform public.bank_log(b.company_id, b.id, 'bank_accounts', b.id::text, 'branch_set', jsonb_build_object('branch', branch));
end $$;
create or replace function public.bank_line_set_branch(line uuid, branch uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare l public.bank_lines; b public.bank_accounts;
begin
  select * into l from public.bank_lines where id = line;
  if l.id is null then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(l.bank_account_id, 'bank.manage');
  if branch is not null and not exists (select 1 from public.branches x where x.id = branch and x.company_id = b.company_id and x.archived_at is null) then
    raise exception 'BRANCH_INVALID' using errcode = 'P0001';
  end if;
  update public.bank_lines set branch_id = branch where id = l.id;
  perform public.bank_log(b.company_id, b.id, 'bank_lines', l.id::text, 'branch_set', jsonb_build_object('branch', branch));
end $$;

-- ===================================================================== deposits applied to invoices (human decision)
-- the payment's journal line on the bank's ledger account (+ money in)
create or replace function public.bank_payment_journal_line(pay uuid, ledger_account uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select l.id from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.source = 'payment' and e.source_id = pay and l.account_id = ledger_account and l.debit_cents > 0
   order by l.id limit 1
$$;

-- When the deposit is fully applied, the bank line is matched with the payments' journal lines (0026).
create or replace function public.bank_settle_deposit(l public.bank_lines, b public.bank_accounts)
returns uuid language plpgsql security definer set search_path = '' as $$
declare total bigint; jls bigint[];
begin
  select coalesce(sum(a.amount_cents), 0) into total from public.bank_line_allocations a where a.bank_line_id = l.id and a.voided_at is null;
  if total <> l.amount_cents then return null; end if;
  select array_agg(public.bank_payment_journal_line(a.payment_id, b.ledger_account_id)) into jls from public.bank_line_allocations a where a.bank_line_id = l.id and a.voided_at is null;
  if jls is null or array_position(jls, null) is not null then raise exception 'BANK_PAYMENT_NOT_IN_BANK' using errcode = 'P0001'; end if;
  return public.bank_match(array[l.id], jls, 'deposit applied to invoices', 'manual', null);
end $$;

-- allocations: [{"document_id", "amount_cents", "confidence", "reasons": [..]}]; idem: one decision → one result
create or replace function public.bank_apply_deposit(line uuid, allocations jsonb, idem text, method_code text default 'bank_transfer')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  l public.bank_lines; b public.bank_accounts; a jsonb; d public.documents; pid uuid; used bigint; want bigint := 0; me uuid := (select auth.uid());
  created jsonb := '[]'::jsonb; key text; k integer := 0; gid uuid;
begin
  select * into l from public.bank_lines where id = line;
  if l.id is null then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(l.bank_account_id, 'bank.reconcile');
  if me is null or not public.has_permission(b.company_id, 'payments.record') or not public.has_permission(b.company_id, 'bank.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if idem is null or char_length(idem) not between 8 and 80 then raise exception 'DEPOSIT_INVALID' using errcode = 'P0001', hint = 'idem'; end if;
  if method_code not in ('bank_transfer', 'transfer', 'ath_movil', 'check', 'cash', 'credit_card', 'debit_card', 'card', 'other') then raise exception 'DEPOSIT_INVALID' using errcode = 'P0001', hint = 'method'; end if;
  -- the same decision again: its payments, nothing new
  if exists (select 1 from public.payments p where p.company_id = b.company_id and p.idempotency_key like 'dep:' || idem || ':%') then
    return jsonb_build_object('already', true, 'payments', (select jsonb_agg(p.id) from public.payments p where p.company_id = b.company_id and p.idempotency_key like 'dep:' || idem || ':%'));
  end if;
  if l.amount_cents <= 0 then raise exception 'BANK_LINE_NOT_DEPOSIT' using errcode = 'P0001'; end if;
  if l.status <> 'unmatched' then raise exception 'BANK_LINE_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if jsonb_typeof(allocations) <> 'array' or jsonb_array_length(allocations) < 1 or jsonb_array_length(allocations) > 20 then raise exception 'DEPOSIT_INVALID' using errcode = 'P0001', hint = 'allocations'; end if;
  select coalesce(sum(x.amount_cents), 0) into used from public.bank_line_allocations x where x.bank_line_id = l.id and x.voided_at is null;
  for a in select * from jsonb_array_elements(allocations) loop
    if coalesce(a ->> 'amount_cents', '') !~ '^[0-9]{1,15}$' or (a ->> 'amount_cents')::bigint <= 0 then raise exception 'DEPOSIT_INVALID' using errcode = 'P0001', hint = 'amount'; end if;
    want := want + (a ->> 'amount_cents')::bigint;
  end loop;
  if used + want > l.amount_cents then raise exception 'DEPOSIT_OVER_APPLIED' using errcode = 'P0001', hint = format('deposit=%s applied=%s new=%s', l.amount_cents, used, want); end if;
  for a in select * from jsonb_array_elements(allocations) loop
    k := k + 1;
    select * into d from public.documents x where x.id = (a ->> 'document_id')::uuid and x.company_id = b.company_id and x.document_type = 'invoice';
    if d.id is null then raise exception 'DEPOSIT_INVALID' using errcode = 'P0001', hint = 'invoice'; end if;
    key := 'dep:' || idem || ':' || k;
    -- the normal payment insert: balance and status checks (0015 / 0025), ledger posting into the bank's ledger account (0023 / 0026)
    insert into public.payments (company_id, document_id, amount, payment_method, reference, paid_at, created_by, deposit_account_id, idempotency_key, branch_id, notes)
    values (b.company_id, d.id, ((a ->> 'amount_cents')::bigint)::numeric / 100, method_code, left(coalesce(l.reference, l.description), 120),
            (l.txn_date::text || ' 12:00:00-04')::timestamptz, me, b.ledger_account_id, key, coalesce(l.branch_id, b.branch_id),
            left('Depósito bancario ' || l.txn_date::text || ' · ' || l.description, 500))
    returning id into pid;
    insert into public.bank_line_allocations (company_id, bank_line_id, payment_id, amount_cents, kind, confidence, reasons, created_by)
    values (b.company_id, l.id, pid, (a ->> 'amount_cents')::bigint, 'new_payment', least(100, greatest(0, coalesce((a ->> 'confidence')::integer, 0))),
            coalesce(a -> 'reasons', '[]'::jsonb), me);
    created := created || jsonb_build_object('payment', pid, 'document', d.id, 'amount_cents', (a ->> 'amount_cents')::bigint);
  end loop;
  gid := public.bank_settle_deposit(l, b);
  perform public.bank_log(b.company_id, b.id, 'bank_lines', l.id::text, 'deposit_applied',
    jsonb_build_object('payments', created, 'applied_cents', used + want, 'deposit_cents', l.amount_cents, 'matched', gid is not null));
  return jsonb_build_object('already', false, 'payments', created, 'matched_group', gid, 'remaining_cents', l.amount_cents - used - want);
end $$;

-- a payment already recorded (deposited into this bank) is linked to the deposit: no new payment
create or replace function public.bank_link_payment(line uuid, payment uuid, confidence integer default null, reasons jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.bank_lines; b public.bank_accounts; p public.payments; used bigint; amt bigint; gid uuid;
begin
  select * into l from public.bank_lines where id = line;
  if l.id is null then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(l.bank_account_id, 'bank.reconcile');
  if not public.has_permission(b.company_id, 'bank.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if l.amount_cents <= 0 then raise exception 'BANK_LINE_NOT_DEPOSIT' using errcode = 'P0001'; end if;
  if l.status <> 'unmatched' then raise exception 'BANK_LINE_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  select * into p from public.payments x where x.id = payment and x.company_id = b.company_id;
  if p.id is null or p.voided_at is not null then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from public.bank_line_allocations x where x.payment_id = p.id and x.voided_at is null) then raise exception 'PAYMENT_ALREADY_LINKED' using errcode = 'P0001'; end if;
  if public.bank_payment_journal_line(p.id, b.ledger_account_id) is null then
    raise exception 'BANK_PAYMENT_NOT_IN_BANK' using errcode = 'P0001', detail = 'The payment was not recorded as deposited into this bank account.';
  end if;
  amt := round(p.amount * 100)::bigint;
  select coalesce(sum(x.amount_cents), 0) into used from public.bank_line_allocations x where x.bank_line_id = l.id and x.voided_at is null;
  if used + amt > l.amount_cents then raise exception 'DEPOSIT_OVER_APPLIED' using errcode = 'P0001'; end if;
  insert into public.bank_line_allocations (company_id, bank_line_id, payment_id, amount_cents, kind, confidence, reasons, created_by)
  values (b.company_id, l.id, p.id, amt, 'existing_payment', least(100, greatest(0, coalesce(confidence, 0))), coalesce(reasons, '[]'::jsonb), (select auth.uid()));
  gid := public.bank_settle_deposit(l, b);
  perform public.bank_log(b.company_id, b.id, 'bank_lines', l.id::text, 'payment_linked', jsonb_build_object('payment', p.id, 'amount_cents', amt, 'matched', gid is not null));
  return jsonb_build_object('matched_group', gid, 'remaining_cents', l.amount_cents - used - amt);
end $$;

-- undo an application (not in a closed reconciliation): the allocation is voided and the match undone;
-- a payment created for it stays (void it through Receivables, with its reversal entry)
create or replace function public.bank_allocation_void(allocation uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare x public.bank_line_allocations; l public.bank_lines; b public.bank_accounts; g uuid;
begin
  select * into x from public.bank_line_allocations where id = allocation;
  if x.id is null or x.voided_at is not null then raise exception 'ALLOCATION_NOT_FOUND' using errcode = 'P0001'; end if;
  select * into l from public.bank_lines where id = x.bank_line_id;
  b := public.bank_account_for(l.bank_account_id, 'bank.reconcile');
  if reason is null or char_length(btrim(reason)) not between 3 and 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select i.group_id into g from public.bank_match_items i join public.bank_match_groups gr on gr.id = i.group_id where i.bank_line_id = l.id and i.active and gr.voided_at is null limit 1;
  if g is not null then perform public.bank_unmatch(g, btrim(reason)); end if;
  update public.bank_line_allocations set voided_at = now(), voided_by = (select auth.uid()), void_reason = btrim(reason) where id = x.id;
  perform public.bank_log(b.company_id, b.id, 'bank_line_allocations', x.id::text, 'voided', jsonb_build_object('reason', btrim(reason), 'payment', x.payment_id));
end $$;

-- ===================================================================== receipt captures
create or replace function public.receipt_register(target uuid, path text, name text, mime text, bytes integer, digest text, branch uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare rid uuid; dup uuid;
begin
  if not public.can_capture_evidence(target) then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if path !~ ('^' || target::text || '/receipts/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$') then raise exception 'RECEIPT_INVALID' using errcode = 'P0001', hint = 'path'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'Banking-evidence' and o.name = path) then raise exception 'RECEIPT_INVALID' using errcode = 'P0001', hint = 'file'; end if;
  if branch is not null and not exists (select 1 from public.branches x where x.id = branch and x.company_id = target and x.archived_at is null) then raise exception 'BRANCH_INVALID' using errcode = 'P0001'; end if;
  select r.id into dup from public.receipt_captures r where r.company_id = target and r.sha256 = lower(digest) and r.status <> 'discarded';
  if dup is not null then return jsonb_build_object('id', dup, 'duplicate', true); end if;
  insert into public.receipt_captures (company_id, branch_id, storage_path, file_name, content_type, size_bytes, sha256, created_by)
  values (target, branch, path, left(btrim(name), 200), mime, bytes, lower(digest), (select auth.uid()))
  returning id into rid;
  return jsonb_build_object('id', rid, 'duplicate', false);
end $$;

-- OCR suggestions (never final): fields {"name": {"value": …, "confidence": 0–1} | null}
create or replace function public.receipt_set_extraction(capture uuid, provider text, status text, error text, fields jsonb)
returns void language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare r public.receipt_captures;
begin
  select * into r from public.receipt_captures where id = capture for update;
  if r.id is null or not (public.can_capture_evidence(r.company_id) or r.created_by = (select auth.uid())) then raise exception 'RECEIPT_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status <> 'captured' then raise exception 'RECEIPT_LOCKED' using errcode = 'P0001'; end if;
  if status not in ('not_configured', 'succeeded', 'failed') then raise exception 'RECEIPT_INVALID' using errcode = 'P0001'; end if;
  update public.receipt_captures set ocr_provider = left(provider, 40), ocr_status = status, ocr_error = left(error, 100), extracted = coalesce(fields, '{}'::jsonb) where id = r.id;
end $$;

-- the person's confirmed data and, optionally, the expense or payment it is evidence of
-- data: {"date","merchant","receipt_number","total_cents","tax_cents","payment_method","reference","currency","notes"}
create or replace function public.receipt_confirm(capture uuid, data jsonb, bill uuid default null, payment uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.receipt_captures;
begin
  select * into r from public.receipt_captures where id = capture for update;
  if r.id is null or not public.can_capture_evidence(r.company_id) then raise exception 'RECEIPT_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status <> 'captured' then raise exception 'RECEIPT_LOCKED' using errcode = 'P0001'; end if;
  if jsonb_typeof(data) <> 'object' or coalesce(data ->> 'total_cents', '') !~ '^[0-9]{1,15}$' or coalesce(data ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(data ->> 'currency', 'USD') !~ '^[A-Z]{3}$' or (data ? 'tax_cents' and coalesce(data ->> 'tax_cents', '') !~ '^[0-9]{1,15}$') then
    raise exception 'RECEIPT_INVALID' using errcode = 'P0001', hint = 'data';
  end if;
  if bill is not null and not exists (select 1 from public.bills x where x.id = bill and x.company_id = r.company_id and public.has_permission(r.company_id, 'payables.view')) then
    raise exception 'RECEIPT_LINK_INVALID' using errcode = 'P0001';
  end if;
  if payment is not null and not exists (select 1 from public.payments x where x.id = payment and x.company_id = r.company_id) then raise exception 'RECEIPT_LINK_INVALID' using errcode = 'P0001'; end if;
  update public.receipt_captures set status = 'confirmed', confirmed = data, bill_id = bill, payment_id = payment, confirmed_by = (select auth.uid()), confirmed_at = now() where id = r.id;
end $$;

create or replace function public.receipt_discard(capture uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.receipt_captures;
begin
  select * into r from public.receipt_captures where id = capture for update;
  if r.id is null or not (public.can_capture_evidence(r.company_id) or r.created_by = (select auth.uid())) then raise exception 'RECEIPT_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status <> 'captured' or exists (select 1 from public.payments p where p.evidence_capture_id = r.id) then raise exception 'RECEIPT_LOCKED' using errcode = 'P0001'; end if;
  update public.receipt_captures set status = 'discarded' where id = r.id;    -- the file is kept (evidence is never deleted here)
end $$;

-- receipts: only the workflow fields move; confirmed / discarded receipts are final
create or replace function public.receipt_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'RECEIPT_IMMUTABLE' using errcode = 'P0001';
  end if;
  if old.status <> 'captured' or new.storage_path <> old.storage_path or new.sha256 <> old.sha256 or new.company_id <> old.company_id or new.created_by is distinct from old.created_by then
    raise exception 'RECEIPT_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_receipt_guard on public.receipt_captures;
create trigger ba_receipt_guard before update or delete on public.receipt_captures for each row execute function public.receipt_guard();

-- ===================================================================== grants
do $$ declare f text; begin
  foreach f in array array[
    'public.bank_connection_save(uuid, text, text, bigint, uuid, text)', 'public.bank_link_provider_account(uuid, uuid)',
    'public.bank_connection_disconnect(uuid, text, bigint, uuid, text)', 'public.bank_account_set_branch(uuid, uuid)', 'public.bank_line_set_branch(uuid, uuid)',
    'public.bank_apply_deposit(uuid, jsonb, text, text)', 'public.bank_link_payment(uuid, uuid, integer, jsonb)', 'public.bank_allocation_void(uuid, text)',
    'public.receipt_register(uuid, text, text, text, integer, text, uuid)', 'public.receipt_set_extraction(uuid, text, text, text, jsonb)',
    'public.receipt_confirm(uuid, jsonb, uuid, uuid)', 'public.receipt_discard(uuid)', 'public.can_capture_evidence(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- server-signed (webhooks and automatic syncs arrive without a user): the HMAC, freshness and nonce protect them
  foreach f in array array['public.bank_sync_context(uuid, text, bigint, uuid, text)', 'public.bank_sync_apply(uuid, text, text, bigint, uuid, text)',
    'public.bank_webhook_record(text, text, text, text, bigint, uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
  foreach f in array array['public.bank_settle_deposit(public.bank_lines, public.bank_accounts)', 'public.bank_payment_journal_line(uuid, uuid)',
    'public.payment_s6_guard()', 'public.bank_allocation_guard()', 'public.receipt_guard()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ===================================================================== self-check
do $$ begin
  if has_table_privilege('authenticated', 'public.bank_connections', 'INSERT') or has_table_privilege('authenticated', 'public.bank_line_allocations', 'INSERT')
     or has_table_privilege('authenticated', 'public.receipt_captures', 'UPDATE') or has_table_privilege('anon', 'public.bank_connections', 'SELECT') then
    raise exception 'BA0042 self-check failed: banking tables writable directly or readable by anon';
  end if;
  if has_function_privilege('authenticated', 'public.bank_set_server_key(text, text)', 'EXECUTE') then
    raise exception 'BA0042 self-check failed: users may register server keys';
  end if;
  if (select public from storage.buckets where id = 'Banking-evidence') is distinct from false then raise exception 'BA0042 self-check failed: Banking-evidence must be private'; end if;
end $$;

commit;
