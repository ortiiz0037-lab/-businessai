-- =====================================================================
-- BusinessAI · Migration 0026 · Finance: bank accounts and reconciliation
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a, 0015, 0023, 0024, 0025.
--
-- ONE SOURCE OF TRUTH. A bank account is linked to one asset account of the
-- ledger (0023). Everything that moved money through it already is a
-- journal line on that account: client payments (0023, now with an
-- optional deposit account), vendor payments (0024), expenses paid,
-- transfers and deposits (manual entries). Reconciliation pairs the
-- imported bank statement lines with those journal lines; it never
-- changes posted revenue or expenses. The only entries it creates are
-- balanced ledger entries for bank items not yet in the books (fees,
-- interest, unknown items) and documented adjustments, through ledger_post.
--
-- MODEL
--  * bank_accounts: name, bank, currency (the ledger base currency for
--    now), last 4 digits, linked ledger account (asset, one bank account
--    per ledger account), active / archived. No credentials are stored.
--  * bank_imports + bank_lines: statement lines in signed integer cents
--    (+ money in, − money out). A file is imported once per account (SHA-256
--    of the file); a line once per account (bank transaction id, or a
--    fingerprint of date, amount, description, reference and balance).
--    Identical rows inside one file are duplicates unless the user states
--    they are separate transactions. An import can be reverted (its lines
--    are kept, excluded) while none of them is matched.
--  * bank_match_groups + bank_match_items: one or more bank lines ↔ one or
--    more journal lines of the linked account, whose sums are exactly
--    equal. A line belongs to one active group at most (unique indexes).
--    Unmatching keeps the group as history (voided with a reason).
--  * bank_reconciliations: account, period, statement opening and closing
--    balance. Close requires: statement complete (opening + lines =
--    closing), no unmatched line in the period, difference 0 (statement
--    closing + uncleared book items − bank items booked later = ledger
--    balance at the end), and opening = previous closing. A difference can
--    only be closed with an adjustment entry authorised by the owner, with
--    a documented reason. Closing locks the period's lines and matches;
--    only the owner reopens the latest one, with a reason.
--  * Every step is logged in bank_events (append-only).
-- ROLES: bank.view, bank.manage, bank.reconcile (owner, admin); bank.adjust
--   and bank.reopen (owner).
-- Rollback: supabase/rollback/0026_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.payment_void(uuid, text)') is null then
    raise exception 'BA0026: migration 0025 must be applied first';
  end if;
end $$;

insert into public.permissions (key, module, description_es, description_en) values
  ('bank.view', 'bank', 'Ver cuentas bancarias, movimientos y conciliaciones', 'View bank accounts, statement lines and reconciliations'),
  ('bank.manage', 'bank', 'Gestionar cuentas bancarias, importar estados y emparejar movimientos', 'Manage bank accounts, import statements and match lines'),
  ('bank.reconcile', 'bank', 'Preparar y cerrar conciliaciones bancarias', 'Prepare and close bank reconciliations'),
  ('bank.adjust', 'bank', 'Autorizar ajustes de diferencias de conciliación', 'Authorise reconciliation difference adjustments'),
  ('bank.reopen', 'bank', 'Reabrir conciliaciones cerradas', 'Reopen closed reconciliations')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'bank.view'), ('admin', 'bank.view'), ('owner', 'bank.manage'), ('admin', 'bank.manage'),
  ('owner', 'bank.reconcile'), ('admin', 'bank.reconcile'), ('owner', 'bank.adjust'), ('owner', 'bank.reopen')
on conflict do nothing;

alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void', 'payment_void',
                    'bank_adjustment', 'bank_reconciliation'));

-- ------------------------------------------------ client payments: deposit account
alter table public.payments add column if not exists deposit_account_id uuid;

create or replace function public.payment_deposit_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare a public.ledger_accounts;
begin
  if new.deposit_account_id is null then return new; end if;
  select * into a from public.ledger_accounts where id = new.deposit_account_id;
  if a.id is null or a.company_id <> new.company_id or a.type <> 'asset' or a.status <> 'active'
     or (a.system_key is not null and a.system_key <> 'cash') then
    raise exception 'PAYMENT_ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_payment_deposit_guard on public.payments;
create trigger ba_payment_deposit_guard before insert on public.payments for each row execute function public.payment_deposit_guard();

-- 0023 posting of client payments: the deposit account when given.
create or replace function public.ledger_post_payment(pay uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  pr record;
  amt bigint;
begin
  select py.id, py.company_id, py.document_id, py.amount, py.reference, py.paid_at, py.deposit_account_id, d.document_number, d.client_id
    into pr from public.payments py join public.documents d on d.id = py.document_id where py.id = pay;
  if pr.id is null then return null; end if;
  perform public.ledger_post_invoice(pr.document_id);  -- an invoice from before the ledger: its real issue first
  amt := public.ledger_cents(pr.amount);
  return public.ledger_post(pr.company_id, (pr.paid_at at time zone 'America/Puerto_Rico')::date,
    pr.document_number, coalesce(nullif(btrim(pr.reference), ''), pr.document_number), 'payment', pr.id,
    jsonb_build_array(
      -- 0026: the deposit account chosen for the payment (a bank), else Cash
      case when pr.deposit_account_id is not null
        then jsonb_build_object('account', pr.deposit_account_id, 'debit', amt, 'client_id', pr.client_id, 'document_id', pr.document_id)
        else jsonb_build_object('key', 'cash', 'debit', amt, 'client_id', pr.client_id, 'document_id', pr.document_id) end,
      jsonb_build_object('key', 'accounts_receivable', 'credit', amt, 'client_id', pr.client_id, 'document_id', pr.document_id)));
end $$;

-- ------------------------------------------------------------- tables
create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  bank_name text check (bank_name is null or char_length(bank_name) <= 120),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  ledger_account_id uuid not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, ledger_account_id) references public.ledger_accounts (company_id, id) deferrable initially deferred
);
create unique index if not exists bank_accounts_ledger_uidx on public.bank_accounts (ledger_account_id) where status = 'active';
create unique index if not exists bank_accounts_name_uidx on public.bank_accounts (company_id, lower(btrim(name)));

create table if not exists public.bank_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null,
  file_name text not null check (char_length(file_name) between 1 and 200),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  mapping jsonb not null default '{}'::jsonb,
  row_count integer not null default 0 check (row_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  first_date date,
  last_date date,
  status text not null default 'completed' check (status in ('completed', 'reverted')),
  reverted_at timestamptz, reverted_by uuid, revert_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, bank_account_id) references public.bank_accounts (company_id, id) deferrable initially deferred
);
create unique index if not exists bank_imports_file_uidx on public.bank_imports (bank_account_id, file_sha256) where status = 'completed';

create table if not exists public.bank_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null,
  import_id uuid not null,
  line_no integer not null check (line_no >= 1),
  txn_date date not null,
  description text not null check (char_length(description) between 1 and 500),
  reference text check (reference is null or char_length(reference) <= 120),
  amount_cents bigint not null check (amount_cents <> 0 and abs(amount_cents) < 1000000000000000),
  balance_cents bigint check (balance_cents is null or abs(balance_cents) < 1000000000000000),
  bank_txn_id text check (bank_txn_id is null or char_length(bank_txn_id) between 1 and 120),
  fingerprint text not null check (fingerprint ~ '^(id:.+|[0-9a-f]{64})$'),
  raw jsonb not null default '{}'::jsonb,
  status text not null default 'unmatched' check (status in ('unmatched', 'matched', 'excluded')),
  reconciliation_id uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, bank_account_id) references public.bank_accounts (company_id, id) deferrable initially deferred,
  foreign key (company_id, import_id) references public.bank_imports (company_id, id) deferrable initially deferred
);
create unique index if not exists bank_lines_fingerprint_uidx on public.bank_lines (bank_account_id, fingerprint) where status <> 'excluded';
create index if not exists bank_lines_account_date_idx on public.bank_lines (bank_account_id, txn_date);

create table if not exists public.bank_match_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null,
  method text not null check (method in ('manual', 'suggestion', 'auto_exact', 'adjustment')),
  confidence integer check (confidence is null or confidence between 0 and 100),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz, voided_by uuid, void_reason text,
  reconciliation_id uuid,
  unique (company_id, id),
  check ((voided_at is null) = (void_reason is null))
);
create table if not exists public.bank_match_items (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  group_id uuid not null,
  bank_line_id uuid,
  journal_line_id bigint,
  amount_cents bigint not null,
  active boolean not null default true,
  check ((bank_line_id is null) <> (journal_line_id is null)),
  foreign key (company_id, group_id) references public.bank_match_groups (company_id, id) on delete cascade
);
create unique index if not exists bank_match_items_line_uidx on public.bank_match_items (bank_line_id) where active and bank_line_id is not null;
create unique index if not exists bank_match_items_journal_uidx on public.bank_match_items (journal_line_id) where active and journal_line_id is not null;
create index if not exists bank_match_items_group_idx on public.bank_match_items (group_id);

create table if not exists public.bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null,
  period_start date not null,
  period_end date not null,
  statement_opening_cents bigint not null,
  statement_closing_cents bigint not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  difference_cents bigint,
  adjustment_entry_id uuid,
  adjustment_reason text,
  closed_at timestamptz, closed_by uuid,
  reopened_at timestamptz, reopened_by uuid, reopen_reason text,
  note text check (note is null or char_length(note) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  check (period_end >= period_start),
  foreign key (company_id, bank_account_id) references public.bank_accounts (company_id, id) deferrable initially deferred
);
create index if not exists bank_reconciliations_account_idx on public.bank_reconciliations (bank_account_id, period_end desc);

create table if not exists public.bank_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid,
  entity text not null,
  entity_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists bank_events_company_idx on public.bank_events (company_id, created_at desc);
create index if not exists bank_events_account_idx on public.bank_events (bank_account_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['bank_accounts', 'bank_imports', 'bank_lines', 'bank_match_groups', 'bank_match_items', 'bank_reconciliations', 'bank_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
    execute format('create policy ba_%s_select on public.%I for select to authenticated using (public.has_permission(company_id, ''bank.view''))', t, t);
    execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    execute format('create trigger ba_company_immutable before update on public.%I for each row execute function public.forbid_company_change()', t);
  end loop;
end $$;
drop trigger if exists ba_bank_append_only on public.bank_events;
create trigger ba_bank_append_only before update or delete on public.bank_events for each row execute function public.ledger_append_only();
drop trigger if exists ba_bank_no_truncate on public.bank_events;
create trigger ba_bank_no_truncate before truncate on public.bank_events for each statement execute function public.ledger_no_truncate();

-- Statement data and history never change and are never deleted (company
-- cascade aside); only the workflow fields move, and not while the line or
-- group belongs to a closed reconciliation.
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
    if (to_jsonb(new) - array['status', 'reconciliation_id']) <> (to_jsonb(old) - array['status', 'reconciliation_id']) then
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

create or replace function public.bank_rec_closed(rec uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select r.status = 'closed' from public.bank_reconciliations r where r.id = rec), false)
$$;

do $$
declare t text;
begin
  foreach t in array array['bank_lines', 'bank_match_groups', 'bank_match_items', 'bank_imports'] loop
    execute format('drop trigger if exists ba_bank_record_guard on public.%I', t);
    execute format('create trigger ba_bank_record_guard before update or delete on public.%I for each row execute function public.bank_record_guard()', t);
  end loop;
end $$;

create or replace function public.bank_rec_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = 'bank_reconciliations';
  end if;
  if old.status = 'closed' and new.status = 'closed' and (to_jsonb(new) <> to_jsonb(old)) then
    raise exception 'RECONCILIATION_CLOSED' using errcode = 'P0001';
  end if;
  if new.bank_account_id <> old.bank_account_id or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
    raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = 'bank_reconciliations';
  end if;
  return new;
end $$;
drop trigger if exists ba_bank_rec_guard on public.bank_reconciliations;
create trigger ba_bank_rec_guard before update or delete on public.bank_reconciliations for each row execute function public.bank_rec_guard();

-- ------------------------------------------------------------- helpers
create or replace function public.bank_log(target uuid, account uuid, ent text, ent_id text, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.bank_events (company_id, bank_account_id, entity, entity_id, action, details, actor)
  values (target, account, ent, ent_id, act, coalesce(info, '{}'::jsonb), (select auth.uid()))
$$;

create or replace function public.bank_lock(account uuid)
returns void language sql security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('ba_bank:' || account::text, 0))
$$;

-- The bank account, checked for the caller's permission; locked when asked.
create or replace function public.bank_account_for(account uuid, perm text, lock boolean default true)
returns public.bank_accounts language plpgsql security definer set search_path = '' as $$
declare b public.bank_accounts;
begin
  select * into b from public.bank_accounts where id = account;
  if b.id is null or ((select auth.uid()) is not null and not public.has_permission(b.company_id, perm)) then
    raise exception 'BANK_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if lock then perform public.bank_lock(b.id); end if;
  return b;
end $$;

-- Signed amount of a journal line on an asset account (+ money in).
create or replace function public.bank_journal_amount(jl bigint)
returns bigint language sql stable security definer set search_path = '' as $$
  select (l.debit_cents - l.credit_cents)::bigint from public.journal_lines l where l.id = jl
$$;

-- ------------------------------------------------------------- bank accounts
create or replace function public.bank_save_account(target uuid, account uuid, account_name text, bank text, digits text, ledger_account uuid, currency_code text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  a public.ledger_accounts;
  b public.bank_accounts;
  bid uuid := account;
  base text;
begin
  if not public.has_permission(target, 'bank.manage') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  perform public.ledger_ensure_chart(target);
  select * into a from public.ledger_accounts where id = ledger_account;
  if a.id is null or a.company_id <> target or a.type <> 'asset' or a.status <> 'active' or (a.system_key is not null and a.system_key <> 'cash') then
    raise exception 'BANK_LEDGER_ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  select s.base_currency into base from public.ledger_settings s where s.company_id = target;
  if coalesce(currency_code, base) <> base then
    raise exception 'CURRENCY_NOT_SUPPORTED' using errcode = 'P0001', hint = currency_code;
  end if;
  if digits is not null and btrim(digits) <> '' and btrim(digits) !~ '^[0-9]{4}$' then
    raise exception 'LAST4_INVALID' using errcode = 'P0001';
  end if;
  if bid is null then
    insert into public.bank_accounts (company_id, name, bank_name, currency, last4, ledger_account_id, created_by)
    values (target, btrim(account_name), nullif(btrim(coalesce(bank, '')), ''), base, nullif(btrim(coalesce(digits, '')), ''), a.id, (select auth.uid()))
    returning id into bid;
    perform public.bank_log(target, bid, 'bank_accounts', bid::text, 'created', jsonb_build_object('name', account_name, 'ledger_account', a.code));
  else
    b := public.bank_account_for(bid, 'bank.manage');
    if b.company_id <> target then raise exception 'BANK_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
    if b.ledger_account_id <> a.id and exists (select 1 from public.bank_match_groups g where g.bank_account_id = b.id and g.voided_at is null) then
      raise exception 'BANK_LEDGER_ACCOUNT_LOCKED' using errcode = 'P0001', detail = 'The linked ledger account does not change once lines are matched.';
    end if;
    update public.bank_accounts x set name = btrim(account_name), bank_name = nullif(btrim(coalesce(bank, '')), ''), last4 = nullif(btrim(coalesce(digits, '')), ''),
           ledger_account_id = a.id, updated_at = now() where x.id = b.id;
    perform public.bank_log(target, b.id, 'bank_accounts', b.id::text, 'updated', jsonb_build_object('name', account_name, 'ledger_account', a.code));
  end if;
  return bid;
end $$;

create or replace function public.bank_set_account_status(account uuid, new_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bank_accounts := public.bank_account_for(account, 'bank.manage');
begin
  if new_status not in ('active', 'archived') then raise exception 'STATUS_INVALID' using errcode = 'P0001'; end if;
  if new_status = 'archived' and exists (select 1 from public.bank_reconciliations r where r.bank_account_id = b.id and r.status = 'open') then
    raise exception 'BANK_ACCOUNT_HAS_OPEN_RECONCILIATION' using errcode = 'P0001';
  end if;
  update public.bank_accounts set status = new_status, updated_at = now() where id = b.id;
  perform public.bank_log(b.company_id, b.id, 'bank_accounts', b.id::text, new_status, '{}');
end $$;

-- ------------------------------------------------------------- import
-- rows: [{"date": "YYYY-MM-DD", "description": text, "reference": text|null,
--         "amount_cents": "signed integer", "balance_cents": "integer"|null,
--         "bank_txn_id": text|null, "raw": {...}}]
-- Returns the import and its counts; the same file again returns the first
-- import (already = true) and inserts nothing.
create or replace function public.bank_import(account uuid, file_name text, file_sha256 text, mapping jsonb, rows jsonb, allow_identical boolean default false)
returns table (import_id uuid, imported integer, duplicates integer, already boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  b public.bank_accounts := public.bank_account_for(account, 'bank.manage');
  iid uuid;
  r jsonb;
  i integer := 0;
  n_ok integer := 0;
  n_dup integer := 0;
  d date;
  amt bigint;
  bal bigint;
  descr text;
  ref text;
  txn text;
  key text;
  occ integer;
  fp text;
  seen jsonb := '{}'::jsonb;
  lid uuid;
begin
  if b.status <> 'active' then raise exception 'BANK_ACCOUNT_ARCHIVED' using errcode = 'P0001'; end if;
  if file_sha256 is null or file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'IMPORT_INVALID' using errcode = 'P0001', hint = 'sha256'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) < 1 or jsonb_array_length(rows) > 5000 then
    raise exception 'IMPORT_INVALID' using errcode = 'P0001', hint = 'rows';
  end if;
  select x.id into iid from public.bank_imports x where x.bank_account_id = b.id and x.file_sha256 = file_sha256 and x.status = 'completed';
  if iid is not null then
    return query select iid, 0, 0, true;                 -- the same file again: nothing new
    return;
  end if;
  -- The lines first, the import row last with its final counts (the import
  -- row is never updated afterwards; the foreign key is checked at commit).
  iid := gen_random_uuid();
  for r in select * from jsonb_array_elements(rows) loop
    i := i + 1;
    if coalesce(r ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'IMPORT_ROW_INVALID' using errcode = 'P0001', hint = i::text || ':date'; end if;
    begin d := (r ->> 'date')::date; exception when others then raise exception 'IMPORT_ROW_INVALID' using errcode = 'P0001', hint = i::text || ':date'; end;
    if d < date '2000-01-01' or d > public.ba_today() + 1 then raise exception 'IMPORT_ROW_INVALID' using errcode = 'P0001', hint = i::text || ':date'; end if;
    if coalesce(r ->> 'amount_cents', '') !~ '^-?[0-9]{1,15}$' or (r ->> 'amount_cents')::bigint = 0 then
      raise exception 'IMPORT_ROW_INVALID' using errcode = 'P0001', hint = i::text || ':amount';
    end if;
    amt := (r ->> 'amount_cents')::bigint;
    if r ? 'balance_cents' and r ->> 'balance_cents' is not null then
      if (r ->> 'balance_cents') !~ '^-?[0-9]{1,15}$' then raise exception 'IMPORT_ROW_INVALID' using errcode = 'P0001', hint = i::text || ':balance'; end if;
      bal := (r ->> 'balance_cents')::bigint;
    else
      bal := null;
    end if;
    descr := left(btrim(regexp_replace(coalesce(r ->> 'description', ''), '\s+', ' ', 'g')), 500);
    if descr = '' then raise exception 'IMPORT_ROW_INVALID' using errcode = 'P0001', hint = i::text || ':description'; end if;
    ref := nullif(left(btrim(coalesce(r ->> 'reference', '')), 120), '');
    txn := nullif(left(btrim(coalesce(r ->> 'bank_txn_id', '')), 120), '');
    if txn is not null then
      fp := 'id:' || txn;
    else
      key := concat_ws('|', d::text, amt::text, lower(descr), coalesce(lower(ref), ''), coalesce(bal::text, ''));
      occ := coalesce((seen ->> key)::integer, 0) + 1;
      seen := seen || jsonb_build_object(key, occ);
      if occ > 1 and not allow_identical then
        n_dup := n_dup + 1;                              -- identical row inside the file
        continue;
      end if;
      fp := encode(sha256(convert_to(key || '|' || occ::text, 'UTF8')), 'hex');
    end if;
    insert into public.bank_lines (company_id, bank_account_id, import_id, line_no, txn_date, description, reference, amount_cents, balance_cents, bank_txn_id, fingerprint, raw)
    values (b.company_id, b.id, iid, i, d, descr, ref, amt, bal, txn, fp, coalesce(r -> 'raw', '{}'::jsonb))
    on conflict (bank_account_id, fingerprint) where status <> 'excluded' do nothing
    returning id into lid;
    if lid is null then n_dup := n_dup + 1; else n_ok := n_ok + 1; end if;
    lid := null;
  end loop;
  insert into public.bank_imports (id, company_id, bank_account_id, file_name, file_sha256, mapping, row_count, imported_count, duplicate_count,
                                   first_date, last_date, created_by)
  values (iid, b.company_id, b.id, left(btrim(file_name), 200), file_sha256, coalesce(mapping, '{}'::jsonb), jsonb_array_length(rows), n_ok, n_dup,
          (select min(l.txn_date) from public.bank_lines l where l.import_id = iid), (select max(l.txn_date) from public.bank_lines l where l.import_id = iid),
          (select auth.uid()));
  perform public.bank_log(b.company_id, b.id, 'bank_imports', iid::text, 'imported',
    jsonb_build_object('file', file_name, 'rows', jsonb_array_length(rows), 'imported', n_ok, 'duplicates', n_dup));
  return query select iid, n_ok, n_dup, false;
end $$;

create or replace function public.bank_import_revert(import uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  im public.bank_imports;
  b public.bank_accounts;
  why text := btrim(coalesce(reason, ''));
begin
  select * into im from public.bank_imports where id = import;
  if im.id is null then raise exception 'IMPORT_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(im.bank_account_id, 'bank.manage');
  select * into im from public.bank_imports where id = import;   -- under the lock
  if im.status <> 'completed' then raise exception 'IMPORT_ALREADY_REVERTED' using errcode = 'P0001'; end if;
  if char_length(why) < 3 or char_length(why) > 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if exists (select 1 from public.bank_lines l where l.import_id = im.id and (l.status = 'matched' or l.reconciliation_id is not null)) then
    raise exception 'IMPORT_HAS_MATCHES' using errcode = 'P0001', detail = 'Unmatch its lines first.';
  end if;
  update public.bank_lines set status = 'excluded' where import_id = im.id;
  update public.bank_imports set status = 'reverted', reverted_at = now(), reverted_by = (select auth.uid()), revert_reason = why where id = im.id;
  perform public.bank_log(b.company_id, b.id, 'bank_imports', im.id::text, 'reverted', jsonb_build_object('reason', why));
end $$;

-- ------------------------------------------------------------- matching
-- Lines of the linked ledger account not in an active match.
create or replace function public.bank_open_journal_lines(account uuid, from_date date default null, to_date date default null)
returns table (journal_line_id bigint, entry_id uuid, entry_number bigint, entry_date date, source text, source_id uuid, description text,
               reference text, memo text, amount_cents bigint)
language sql stable security definer set search_path = '' as $$
  select l.id, e.id, e.entry_number, e.entry_date, e.source, e.source_id, e.description, e.reference, l.memo, (l.debit_cents - l.credit_cents)::bigint
  from public.bank_accounts b
  join public.journal_lines l on l.account_id = b.ledger_account_id and l.company_id = b.company_id
  join public.journal_entries e on e.id = l.entry_id
  where b.id = account and public.has_permission(b.company_id, 'bank.view')
    and (from_date is null or e.entry_date >= from_date) and (to_date is null or e.entry_date <= to_date)
    and not exists (select 1 from public.bank_match_items i where i.journal_line_id = l.id and i.active)
  order by e.entry_date, e.entry_number
$$;

-- One match group: bank lines ↔ journal lines of the linked account with
-- exactly equal sums. Idempotent: the same set again returns its group.
create or replace function public.bank_match(bank_lines uuid[], journal_lines bigint[], note text default null, method text default 'manual', confidence integer default null)
returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  first_line public.bank_lines;
  b public.bank_accounts;
  gid uuid;
  bank_sum bigint;
  book_sum bigint;
  n integer;
begin
  if bank_lines is null or cardinality(bank_lines) < 1 or cardinality(bank_lines) > 50
     or journal_lines is null or cardinality(journal_lines) < 1 or cardinality(journal_lines) > 50 then
    raise exception 'MATCH_INVALID' using errcode = 'P0001';
  end if;
  if method not in ('manual', 'suggestion', 'auto_exact', 'adjustment') then raise exception 'MATCH_INVALID' using errcode = 'P0001'; end if;
  select * into first_line from public.bank_lines where id = bank_lines[1];
  if first_line.id is null then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(first_line.bank_account_id, 'bank.manage');
  -- the same set already matched together: return it (idempotent)
  select g.id into gid from public.bank_match_groups g
   where g.bank_account_id = b.id and g.voided_at is null
     and (select array_agg(i.bank_line_id order by i.bank_line_id) from public.bank_match_items i where i.group_id = g.id and i.bank_line_id is not null)
         = (select array_agg(x order by x) from (select distinct unnest(bank_lines) x) s)
     and (select array_agg(i.journal_line_id order by i.journal_line_id) from public.bank_match_items i where i.group_id = g.id and i.journal_line_id is not null)
         = (select array_agg(x order by x) from (select distinct unnest(journal_lines) x) s);
  if gid is not null then return gid; end if;
  select count(*), coalesce(sum(l.amount_cents), 0) into n, bank_sum from public.bank_lines l
   where l.id = any (bank_lines) and l.bank_account_id = b.id and l.status = 'unmatched';
  if n <> cardinality(array(select distinct unnest(bank_lines))) then
    raise exception 'BANK_LINE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  select count(*), coalesce(sum(l.debit_cents - l.credit_cents), 0) into n, book_sum from public.journal_lines l
   where l.id = any (journal_lines) and l.account_id = b.ledger_account_id and l.company_id = b.company_id
     and not exists (select 1 from public.bank_match_items i where i.journal_line_id = l.id and i.active);
  if n <> cardinality(array(select distinct unnest(journal_lines))) then
    raise exception 'JOURNAL_LINE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if bank_sum <> book_sum then
    raise exception 'MATCH_AMOUNT_MISMATCH' using errcode = 'P0001', hint = format('bank=%s book=%s', bank_sum, book_sum);
  end if;
  insert into public.bank_match_groups (company_id, bank_account_id, method, confidence, note, created_by)
  values (b.company_id, b.id, method, confidence, nullif(left(btrim(coalesce(note, '')), 300), ''), (select auth.uid()))
  returning id into gid;
  insert into public.bank_match_items (company_id, group_id, bank_line_id, amount_cents)
  select b.company_id, gid, l.id, l.amount_cents from public.bank_lines l where l.id = any (bank_lines);
  insert into public.bank_match_items (company_id, group_id, journal_line_id, amount_cents)
  select b.company_id, gid, l.id, (l.debit_cents - l.credit_cents) from public.journal_lines l where l.id = any (journal_lines);
  update public.bank_lines set status = 'matched' where id = any (bank_lines);
  perform public.bank_log(b.company_id, b.id, 'bank_match_groups', gid::text, 'matched',
    jsonb_build_object('method', method, 'bank_lines', cardinality(bank_lines), 'journal_lines', cardinality(journal_lines), 'amount_cents', bank_sum, 'confidence', confidence));
  return gid;
end $$;

create or replace function public.bank_unmatch(match_group uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  g public.bank_match_groups;
  b public.bank_accounts;
  why text := btrim(coalesce(reason, ''));
begin
  select * into g from public.bank_match_groups where id = match_group;
  if g.id is null then raise exception 'MATCH_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(g.bank_account_id, 'bank.manage');
  select * into g from public.bank_match_groups where id = match_group;
  if g.voided_at is not null then raise exception 'MATCH_ALREADY_VOIDED' using errcode = 'P0001'; end if;
  if g.reconciliation_id is not null and public.bank_rec_closed(g.reconciliation_id) then
    raise exception 'BANK_LINE_RECONCILED' using errcode = 'P0001', detail = 'Reopen the reconciliation first.';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  update public.bank_match_groups set voided_at = now(), voided_by = (select auth.uid()), void_reason = why, reconciliation_id = null where id = g.id;
  update public.bank_lines set status = 'unmatched', reconciliation_id = null
   where id in (select i.bank_line_id from public.bank_match_items i where i.group_id = g.id and i.bank_line_id is not null);
  update public.bank_match_items set active = false where group_id = g.id;
  perform public.bank_log(b.company_id, b.id, 'bank_match_groups', g.id::text, 'unmatched', jsonb_build_object('reason', why));
end $$;

-- Suggestions for the unmatched lines of an account, with a confidence
-- (0–100) and whether they are ambiguous (another candidate as good).
--   100 same amount, same date and the reference / document number appears
--    95 same amount and same date
--    90 same amount, reference appears, within 7 days
--  80…50 same amount within 7 days (−5 per day)
--    60 several book lines of the same date adding up to the amount (group)
--    fee: description looks like a bank charge and no book line exists.
create or replace function public.bank_suggestions(account uuid)
returns table (bank_line_id uuid, journal_line_ids bigint[], confidence integer, reason text, ambiguous boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  b public.bank_accounts;
begin
  select * into b from public.bank_accounts where id = account;
  if b.id is null or not public.has_permission(b.company_id, 'bank.view') then return; end if;
  return query
  with bl as (select * from public.bank_lines l where l.bank_account_id = b.id and l.status = 'unmatched'),
  jl as (select * from public.bank_open_journal_lines(b.id)),
  pairs as (
    select bl.id as bid, jl.journal_line_id as jid,
           abs(bl.txn_date - jl.entry_date) as days,
           (coalesce(jl.reference, '') <> '' and (position(lower(jl.reference) in lower(bl.description || ' ' || coalesce(bl.reference, ''))) > 0))
             or (coalesce(bl.reference, '') <> '' and position(lower(bl.reference) in lower(coalesce(jl.reference, '') || ' ' || jl.description)) > 0) as refhit
    from bl join jl on jl.amount_cents = bl.amount_cents and abs(bl.txn_date - jl.entry_date) <= 7),
  scored as (
    select bid, jid, case when days = 0 and refhit then 100 when days = 0 then 95 when refhit then 90 else greatest(50, 80 - 5 * days) end as score,
           case when refhit then 'amount_reference_date' when days = 0 then 'amount_date' else 'amount_near_date' end as why
    from pairs),
  ranked as (
    select s.*, max(score) over (partition by bid) as top_b, max(score) over (partition by jid) as top_j,
           count(*) filter (where true) over (partition by bid, score) as same_b,
           count(*) over (partition by jid, score) as same_j
    from scored s),
  singles as (
    select bid, array[jid] as jids, score, why, (same_b > 1 or same_j > 1 or score < top_j) as amb from ranked where score = top_b),
  groups as (
    select bl.id as bid, array_agg(jl.journal_line_id order by jl.journal_line_id) as jids
    from bl join jl on jl.entry_date = bl.txn_date and sign(jl.amount_cents) = sign(bl.amount_cents)
    where not exists (select 1 from scored s where s.bid = bl.id)
    group by bl.id, bl.amount_cents
    having count(*) between 2 and 10 and sum(jl.amount_cents) = bl.amount_cents),
  fees as (
    select bl.id as bid from bl
    where bl.amount_cents < 0 and not exists (select 1 from scored s where s.bid = bl.id)
      and bl.description ~* '(fee|comisi[oó]n|cargo|service charge|maintenance|mantenimiento|overdraft|sobregiro|interest|inter[eé]s)')
  select bid, jids, score, why, amb from singles
  union all select bid, jids, 60, 'group_same_date', false from groups
  union all select bid, array[]::bigint[], 0, 'bank_fee_or_unknown', false from fees;
end $$;

-- Confirms only exact, unambiguous suggestions (100 / 95 with a single
-- candidate both ways). Returns the number of groups created.
create or replace function public.bank_auto_match(account uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  b public.bank_accounts := public.bank_account_for(account, 'bank.manage');
  s record;
  n integer := 0;
begin
  for s in select * from public.bank_suggestions(b.id) x where x.confidence >= 95 and not x.ambiguous and cardinality(x.journal_line_ids) = 1 loop
    begin
      perform public.bank_match(array[s.bank_line_id], s.journal_line_ids, null, 'auto_exact', s.confidence);
      n := n + 1;
    exception when others then
      null;                                              -- taken by an earlier pair of this run: skipped
    end;
  end loop;
  perform public.bank_log(b.company_id, b.id, 'bank_accounts', b.id::text, 'auto_matched', jsonb_build_object('groups', n));
  return n;
end $$;

-- A bank item not in the books (fee, interest, unknown, transfer): posts a
-- balanced entry bank account ↔ counter account and matches the line.
create or replace function public.bank_line_post(bank_line uuid, counter_account uuid, description text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  l public.bank_lines;
  b public.bank_accounts;
  c public.ledger_accounts;
  eid uuid;
  jid bigint;
  amt bigint;
begin
  select * into l from public.bank_lines where id = bank_line;
  if l.id is null then raise exception 'BANK_LINE_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(l.bank_account_id, 'bank.manage');
  if (select auth.uid()) is not null and not public.has_permission(b.company_id, 'accounting.post') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  select * into l from public.bank_lines where id = bank_line;
  if l.status <> 'unmatched' then raise exception 'BANK_LINE_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  select * into c from public.ledger_accounts where id = counter_account;
  if c.id is null or c.company_id <> b.company_id or c.status <> 'active' or c.id = b.ledger_account_id then
    raise exception 'ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(description, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  amt := abs(l.amount_cents);
  eid := public.ledger_post(b.company_id, l.txn_date, left(btrim(description), 300), coalesce(l.reference, left(l.description, 100)), 'bank_adjustment', l.id,
    case when l.amount_cents > 0
      then jsonb_build_array(jsonb_build_object('account', b.ledger_account_id, 'debit', amt, 'memo', left(l.description, 200)), jsonb_build_object('account', c.id, 'credit', amt))
      else jsonb_build_array(jsonb_build_object('account', c.id, 'debit', amt), jsonb_build_object('account', b.ledger_account_id, 'credit', amt, 'memo', left(l.description, 200))) end);
  if eid is null then raise exception 'BANK_LINE_ALREADY_POSTED' using errcode = 'P0001'; end if;
  select jl.id into jid from public.journal_lines jl where jl.entry_id = eid and jl.account_id = b.ledger_account_id;
  perform public.bank_match(array[l.id], array[jid], description, 'adjustment', 100);
  perform public.bank_log(b.company_id, b.id, 'bank_lines', l.id::text, 'posted', jsonb_build_object('entry_id', eid, 'account', c.code, 'amount_cents', l.amount_cents));
  return eid;
end $$;

-- ------------------------------------------------------------- reconciliation
create or replace function public.bank_reconciliation_create(account uuid, period_start date, period_end date, opening_cents bigint, closing_cents bigint, note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  b public.bank_accounts := public.bank_account_for(account, 'bank.reconcile');
  rid uuid;
begin
  if b.status <> 'active' then raise exception 'BANK_ACCOUNT_ARCHIVED' using errcode = 'P0001'; end if;
  if period_start is null or period_end is null or period_end < period_start or period_end > public.ba_today() then
    raise exception 'DATE_INVALID' using errcode = 'P0001';
  end if;
  if opening_cents is null or closing_cents is null then raise exception 'AMOUNT_INVALID' using errcode = 'P0001'; end if;
  if exists (select 1 from public.bank_reconciliations r where r.bank_account_id = b.id and r.period_start <= period_end and r.period_end >= period_start) then
    raise exception 'RECONCILIATION_OVERLAP' using errcode = 'P0001';
  end if;
  insert into public.bank_reconciliations (company_id, bank_account_id, period_start, period_end, statement_opening_cents, statement_closing_cents, note, created_by)
  values (b.company_id, b.id, period_start, period_end, opening_cents, closing_cents, nullif(left(btrim(coalesce(note, '')), 500), ''), (select auth.uid()))
  returning id into rid;
  perform public.bank_log(b.company_id, b.id, 'bank_reconciliations', rid::text, 'created',
    jsonb_build_object('from', period_start, 'to', period_end, 'opening', opening_cents, 'closing', closing_cents));
  return rid;
end $$;

-- Corrects the statement balances / note of an OPEN reconciliation (logged
-- with the previous values; reconciliations are never deleted).
create or replace function public.bank_reconciliation_update(rec uuid, opening_cents bigint, closing_cents bigint, note text default null)
returns void language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  r public.bank_reconciliations;
  b public.bank_accounts;
begin
  select * into r from public.bank_reconciliations where id = rec;
  if r.id is null then raise exception 'RECONCILIATION_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(r.bank_account_id, 'bank.reconcile');
  select * into r from public.bank_reconciliations where id = rec;
  if r.status <> 'open' then raise exception 'RECONCILIATION_CLOSED' using errcode = 'P0001'; end if;
  if opening_cents is null or closing_cents is null then raise exception 'AMOUNT_INVALID' using errcode = 'P0001'; end if;
  update public.bank_reconciliations x set statement_opening_cents = opening_cents, statement_closing_cents = closing_cents,
         note = coalesce(nullif(left(btrim(coalesce(note, '')), 500), ''), x.note) where x.id = r.id;
  perform public.bank_log(b.company_id, b.id, 'bank_reconciliations', r.id::text, 'updated',
    jsonb_build_object('opening', opening_cents, 'closing', closing_cents, 'previous_opening', r.statement_opening_cents, 'previous_closing', r.statement_closing_cents));
end $$;

-- The figures of a reconciliation (recomputed every time).
create or replace function public.bank_reconciliation_summary(rec uuid)
returns table (statement_opening_cents bigint, statement_closing_cents bigint, statement_lines_cents bigint, statement_difference_cents bigint,
               ledger_balance_cents bigint, uncleared_book_cents bigint, uncleared_book_count bigint, bank_booked_later_cents bigint,
               adjusted_bank_cents bigint, difference_cents bigint, unmatched_bank_count bigint, unmatched_bank_cents bigint,
               matched_bank_count bigint, previous_closing_cents bigint, continuity_ok boolean)
language sql stable security definer set search_path = '' as $$
  with r as (select x.*, b.ledger_account_id from public.bank_reconciliations x join public.bank_accounts b on b.id = x.bank_account_id
             where x.id = rec and (public.has_permission(x.company_id, 'bank.view') or (select auth.uid()) is null)),
  lines as (select l.* from public.bank_lines l, r where l.bank_account_id = r.bank_account_id and l.status <> 'excluded'
            and l.txn_date between r.period_start and r.period_end),
  -- book lines up to the end that no bank line up to the end has cleared
  book as (select jl.id, (jl.debit_cents - jl.credit_cents) as amt from public.journal_lines jl join public.journal_entries e on e.id = jl.entry_id, r
           where jl.account_id = r.ledger_account_id and e.entry_date <= r.period_end),
  cleared as (select i.journal_line_id from public.bank_match_items i join public.bank_match_items ib on ib.group_id = i.group_id and ib.active and ib.bank_line_id is not null
              join public.bank_lines bl on bl.id = ib.bank_line_id, r
              where i.active and i.journal_line_id is not null and bl.txn_date <= r.period_end
              -- documented reconciliation adjustments of this account are book-side corrections: cleared
              union all
              select jl.id from public.journal_lines jl join public.journal_entries e on e.id = jl.entry_id
              join public.bank_reconciliations x on x.id = e.source_id and e.source = 'bank_reconciliation', r
              where x.bank_account_id = r.bank_account_id and jl.account_id = r.ledger_account_id and e.entry_date <= r.period_end),
  later as (select coalesce(sum(bl.amount_cents), 0) as c from lines bl
            where bl.status = 'matched' and exists (select 1 from public.bank_match_items ib join public.bank_match_items ij on ij.group_id = ib.group_id and ij.active and ij.journal_line_id is not null
                                                     join public.journal_lines jl on jl.id = ij.journal_line_id join public.journal_entries e on e.id = jl.entry_id, r
                                                     where ib.bank_line_id = bl.id and ib.active and e.entry_date > r.period_end)),
  prev as (select p.statement_closing_cents from public.bank_reconciliations p, r
           where p.bank_account_id = r.bank_account_id and p.status = 'closed' and p.period_end < r.period_start order by p.period_end desc limit 1),
  v as (select r.statement_opening_cents as so, r.statement_closing_cents as sc,
               coalesce((select sum(amount_cents) from lines), 0)::bigint as sl,
               coalesce((select sum(amt) from book), 0)::bigint as lb,
               coalesce((select sum(amt) from book where id not in (select journal_line_id from cleared)), 0)::bigint as ub,
               (select count(*) from book where id not in (select journal_line_id from cleared)) as ubn,
               (select c from later)::bigint as bl8,
               (select count(*) from lines where status = 'unmatched') as un, coalesce((select sum(amount_cents) from lines where status = 'unmatched'), 0)::bigint as uc,
               (select count(*) from lines where status = 'matched') as mn,
               (select statement_closing_cents from prev) as pc
        from r)
  select so, sc, sl, so + sl - sc, lb, ub, ubn, bl8, sc + ub - bl8, sc + ub - bl8 - lb, un, uc, mn, pc, (pc is null or pc = so) from v
$$;

-- Documented adjustment for a remaining difference (owner): a balanced
-- entry between the bank's ledger account and the chosen account.
create or replace function public.bank_reconciliation_adjust(rec uuid, counter_account uuid, reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  r public.bank_reconciliations;
  b public.bank_accounts;
  c public.ledger_accounts;
  s record;
  eid uuid;
  why text := btrim(coalesce(reason, ''));
  amt bigint;
begin
  select * into r from public.bank_reconciliations where id = rec;
  if r.id is null then raise exception 'RECONCILIATION_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(r.bank_account_id, 'bank.adjust');
  select * into r from public.bank_reconciliations where id = rec;
  if r.status <> 'open' then raise exception 'RECONCILIATION_CLOSED' using errcode = 'P0001'; end if;
  if r.adjustment_entry_id is not null then raise exception 'RECONCILIATION_ALREADY_ADJUSTED' using errcode = 'P0001'; end if;
  if char_length(why) < 10 or char_length(why) > 300 then raise exception 'ADJUSTMENT_REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into c from public.ledger_accounts where id = counter_account;
  if c.id is null or c.company_id <> b.company_id or c.status <> 'active' or c.id = b.ledger_account_id then
    raise exception 'ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  select * into s from public.bank_reconciliation_summary(r.id);
  if s.statement_difference_cents <> 0 or s.unmatched_bank_count > 0 then
    raise exception 'RECONCILIATION_INCOMPLETE' using errcode = 'P0001',
      detail = 'Import or match every statement line first; only a remaining book difference is adjusted.';
  end if;
  if s.difference_cents = 0 then raise exception 'NOTHING_TO_ADJUST' using errcode = 'P0001'; end if;
  -- difference = adjusted bank − books: books go up (debit bank) when positive.
  amt := abs(s.difference_cents);
  eid := public.ledger_post(b.company_id, r.period_end, left('Ajuste de conciliación / Reconciliation adjustment: ' || why, 300), null, 'bank_reconciliation', r.id,
    case when s.difference_cents > 0
      then jsonb_build_array(jsonb_build_object('account', b.ledger_account_id, 'debit', amt), jsonb_build_object('account', c.id, 'credit', amt))
      else jsonb_build_array(jsonb_build_object('account', c.id, 'debit', amt), jsonb_build_object('account', b.ledger_account_id, 'credit', amt)) end);
  update public.bank_reconciliations set adjustment_entry_id = eid, adjustment_reason = why where id = r.id;
  perform public.bank_log(b.company_id, b.id, 'bank_reconciliations', r.id::text, 'adjusted',
    jsonb_build_object('entry_id', eid, 'difference_cents', s.difference_cents, 'account', c.code, 'reason', why));
  return eid;
end $$;

create or replace function public.bank_reconciliation_close(rec uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.bank_reconciliations;
  b public.bank_accounts;
  s record;
begin
  select * into r from public.bank_reconciliations where id = rec;
  if r.id is null then raise exception 'RECONCILIATION_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(r.bank_account_id, 'bank.reconcile');
  select * into r from public.bank_reconciliations where id = rec;
  if r.status = 'closed' then return; end if;               -- idempotent
  select * into s from public.bank_reconciliation_summary(r.id);
  if not s.continuity_ok then
    raise exception 'STATEMENT_GAP' using errcode = 'P0001', hint = s.previous_closing_cents::text,
      detail = 'The opening balance must equal the closing balance of the previous closed reconciliation.';
  end if;
  if s.statement_difference_cents <> 0 then
    raise exception 'STATEMENT_INCOMPLETE' using errcode = 'P0001', hint = s.statement_difference_cents::text,
      detail = 'Opening + imported lines must equal the closing balance (lines are missing or duplicated).';
  end if;
  if s.unmatched_bank_count > 0 then
    raise exception 'UNMATCHED_LINES' using errcode = 'P0001', hint = s.unmatched_bank_count::text;
  end if;
  if s.difference_cents <> 0 then
    raise exception 'RECONCILIATION_NOT_BALANCED' using errcode = 'P0001', hint = s.difference_cents::text;
  end if;
  update public.bank_reconciliations set status = 'closed', closed_at = now(), closed_by = (select auth.uid()), difference_cents = 0 where id = r.id;
  update public.bank_lines l set reconciliation_id = r.id
   where l.bank_account_id = b.id and l.status = 'matched' and l.txn_date between r.period_start and r.period_end;
  update public.bank_match_groups g set reconciliation_id = r.id
   where g.voided_at is null and exists (select 1 from public.bank_match_items i join public.bank_lines l on l.id = i.bank_line_id
                                         where i.group_id = g.id and i.active and l.reconciliation_id = r.id);
  perform public.bank_log(b.company_id, b.id, 'bank_reconciliations', r.id::text, 'closed',
    jsonb_build_object('from', r.period_start, 'to', r.period_end, 'closing', r.statement_closing_cents, 'matched', s.matched_bank_count));
end $$;

create or replace function public.bank_reconciliation_reopen(rec uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.bank_reconciliations;
  b public.bank_accounts;
  why text := btrim(coalesce(reason, ''));
begin
  select * into r from public.bank_reconciliations where id = rec;
  if r.id is null then raise exception 'RECONCILIATION_NOT_FOUND' using errcode = 'P0001'; end if;
  b := public.bank_account_for(r.bank_account_id, 'bank.reopen');
  select * into r from public.bank_reconciliations where id = rec;
  if r.status <> 'closed' then raise exception 'RECONCILIATION_NOT_CLOSED' using errcode = 'P0001'; end if;
  if exists (select 1 from public.bank_reconciliations x where x.bank_account_id = r.bank_account_id and x.status = 'closed' and x.period_end > r.period_end) then
    raise exception 'RECONCILIATION_NOT_LATEST' using errcode = 'P0001', detail = 'Reopen the later reconciliations first.';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  -- status first: the guards then let the lines and groups leave the period
  update public.bank_reconciliations set status = 'open', reopened_at = now(), reopened_by = (select auth.uid()), reopen_reason = why, difference_cents = null where id = r.id;
  update public.bank_lines set reconciliation_id = null where reconciliation_id = r.id;
  update public.bank_match_groups set reconciliation_id = null where reconciliation_id = r.id;
  perform public.bank_log(b.company_id, b.id, 'bank_reconciliations', r.id::text, 'reopened', jsonb_build_object('reason', why));
end $$;

-- Default account for bank charges (created when the company sets up banking).
create or replace function public.bank_init(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_permission(target, 'bank.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform public.ledger_ensure_chart(target);
  if not exists (select 1 from public.ledger_accounts a where a.company_id = target and a.code = '6500') then
    insert into public.ledger_accounts (company_id, code, name, name_en, type, description)
    values (target, '6500', 'Comisiones bancarias', 'Bank fees', 'expense', 'Cargos y comisiones del banco.');
  end if;
end $$;

-- ------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['bank_record_guard()', 'bank_rec_guard()', 'bank_log(uuid, uuid, text, text, text, jsonb)', 'bank_lock(uuid)',
    'bank_account_for(uuid, text, boolean)', 'bank_journal_amount(bigint)', 'payment_deposit_guard()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['bank_rec_closed(uuid)', 'bank_save_account(uuid, uuid, text, text, text, uuid, text)', 'bank_set_account_status(uuid, text)',
    'bank_import(uuid, text, text, jsonb, jsonb, boolean)', 'bank_import_revert(uuid, text)', 'bank_open_journal_lines(uuid, date, date)',
    'bank_match(uuid[], bigint[], text, text, integer)', 'bank_unmatch(uuid, text)', 'bank_suggestions(uuid)', 'bank_auto_match(uuid)',
    'bank_line_post(uuid, uuid, text)', 'bank_reconciliation_create(uuid, date, date, bigint, bigint, text)', 'bank_reconciliation_summary(uuid)',
    'bank_reconciliation_adjust(uuid, uuid, text)', 'bank_reconciliation_close(uuid)', 'bank_reconciliation_update(uuid, bigint, bigint, text)', 'bank_reconciliation_reopen(uuid, text)', 'bank_init(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.bank_record_guard(), public.bank_rec_guard() to authenticated;

do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in ('ba_bank_record_guard', 'ba_bank_rec_guard', 'ba_bank_append_only', 'ba_payment_deposit_guard')) <> 7 then
    raise exception 'BA0026 self-check failed: triggers missing';
  end if;
  if has_table_privilege('authenticated', 'public.bank_lines', 'INSERT') or has_table_privilege('authenticated', 'public.bank_lines', 'UPDATE')
     or has_table_privilege('authenticated', 'public.bank_match_groups', 'INSERT') or has_table_privilege('authenticated', 'public.bank_reconciliations', 'UPDATE')
     or has_table_privilege('anon', 'public.bank_accounts', 'SELECT') then
    raise exception 'BA0026 self-check failed: privileges';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bank_accounts'
             and column_name ~* '(password|secret|token|credential|routing|account_number|pin)') then
    raise exception 'BA0026 self-check failed: bank credentials must never be stored';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key like 'bank.%')
     or exists (select 1 from public.role_permissions where role = 'admin' and permission_key in ('bank.adjust', 'bank.reopen')) then
    raise exception 'BA0026 self-check failed: role matrix';
  end if;
end $$;

commit;
