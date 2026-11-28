-- =====================================================================
-- BusinessAI · Migration 0023 · Finance: double-entry general ledger
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a and 0015.
--
-- MODEL
--  * ledger_accounts: chart of accounts per company (asset, liability,
--    equity, revenue, expense). A default chart is created on first use;
--    system accounts (cash, accounts receivable, revenue, sales tax…) can be
--    renamed but not deleted, archived or retyped. An account with movements
--    is never deleted (archive it instead) and keeps its code and type.
--  * journal_entries + journal_lines: amounts are INTEGER CENTS (bigint),
--    never floating point. Each line is a debit or a credit (> 0). Every
--    entry balances exactly (sum of debits = sum of credits = total_cents,
--    at least two lines): checked by a DEFERRED constraint trigger at
--    commit, whatever writes the rows (app, SQL editor, service role).
--  * Posted entries are IMMUTABLE: no UPDATE, no DELETE, no TRUNCATE, and no
--    line can be added to an entry posted by an earlier transaction. Only
--    the deletion of a whole company (cascade) removes them.
--  * Corrections: a REVERSAL entry (mirror lines, documented reason) that
--    points to the original; the original stays as it was. An entry is
--    reversed at most once; a reversal is not reversed (post a new entry).
--    Entries posted from documents are corrected through the document
--    (voiding the invoice), never reversed by hand.
--  * accounting_periods: a closed month refuses every entry dated in it
--    (including maintenance). Close: accounting.close; reopen: owner only,
--    with a reason; both recorded.
--  * Numbering: entry_number is consecutive per company without gaps
--    (counter row written in the same transaction).
--  * Currency: every entry carries its ISO currency; today only the company
--    base currency (USD by default) is accepted. Multi-currency will add
--    per-line base amounts and an exchange rate stored as integers.
--
-- POSTING FROM DOCUMENTS (automatic, by triggers, in the same transaction
-- as the document change — accrual basis):
--  * Invoice issued (leaves draft, or created issued):
--      Dr Accounts receivable  total
--      Cr Sales revenue        total − tax
--      Cr Sales tax payable    tax
--  * Payment received:  Dr Cash  amount  /  Cr Accounts receivable  amount
--    (partial payments are simply several entries). Revenue is NOT
--    recognised again: cash received, revenue and receivables stay apart.
--  * Invoice voided (only possible without payments, 0015): reversal of
--    the invoice entry dated the void day, with the void reason.
--  * Drafts, quotes and other documents: nothing. Receipts: nothing — a
--    receipt is the proof of a payment that is already in the ledger.
--  * One entry per event: (company, source, source_id) is unique and
--    posting runs under a per-company lock, so repeated or simultaneous
--    events never post twice. Zero-amount invoices post nothing.
--  * Documents issued BEFORE this migration are not posted automatically
--    (nothing is invented): ledger_import_history() posts them from their
--    real dates when a manager asks. A payment on such an invoice posts the
--    invoice first (it was really issued).
--
-- ROLES: accounting.view / manage / post / close (owner, admin);
--        accounting.reopen (owner). Members see nothing of the ledger; the
--        documents they issue still post (the triggers run as definer).
-- HISTORY: ledger_events records accounts, entries, reversals, periods and
--        imports with the actor; append-only.
-- Rollback: supabase/rollback/0023_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.has_permission(uuid, text)') is null then
    raise exception 'BA0023: migration 0014a must be applied first';
  end if;
  if to_regprocedure('public.forbid_company_change()') is null or to_regprocedure('public.ba_today()') is null then
    raise exception 'BA0023: migration 0015 must be applied first';
  end if;
end $$;

-- ------------------------------------------------------------ permissions
insert into public.permissions (key, module, description_es, description_en) values
  ('accounting.view', 'accounting', 'Ver la contabilidad (catálogo, diario, mayor, balances)', 'View accounting (chart, journal, ledger, balances)'),
  ('accounting.manage', 'accounting', 'Gestionar el catálogo de cuentas', 'Manage the chart of accounts'),
  ('accounting.post', 'accounting', 'Registrar asientos manuales, reversiones e importar historial', 'Post manual entries, reversals and import history'),
  ('accounting.close', 'accounting', 'Cerrar periodos contables', 'Close accounting periods'),
  ('accounting.reopen', 'accounting', 'Reabrir periodos contables cerrados', 'Reopen closed accounting periods')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'accounting.view'), ('admin', 'accounting.view'),
  ('owner', 'accounting.manage'), ('admin', 'accounting.manage'),
  ('owner', 'accounting.post'), ('admin', 'accounting.post'),
  ('owner', 'accounting.close'), ('admin', 'accounting.close'),
  ('owner', 'accounting.reopen')
on conflict do nothing;

-- ----------------------------------------------------------------- tables
create table if not exists public.ledger_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  base_currency text not null default 'USD' check (base_currency ~ '^[A-Z]{3}$'),
  initialized_at timestamptz not null default now(),
  initialized_by uuid
);

create table if not exists public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null check (code ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  name_en text check (name_en is null or char_length(btrim(name_en)) between 1 and 120),
  type text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  description text check (description is null or char_length(description) <= 500),
  status text not null default 'active' check (status in ('active', 'archived')),
  system_key text check (system_key is null or system_key ~ '^[a-z_]{2,40}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code),
  unique (company_id, id)
);
create unique index if not exists ledger_accounts_system_uidx on public.ledger_accounts (company_id, system_key) where system_key is not null;

create table if not exists public.ledger_counters (
  company_id uuid primary key references public.companies(id) on delete cascade,
  last_number bigint not null default 0 check (last_number >= 0)
);

create table if not exists public.accounting_periods (
  company_id uuid not null references public.companies(id) on delete cascade,
  period_month date not null check (extract(day from period_month) = 1),
  status text not null check (status in ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid,
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text,
  primary key (company_id, period_month)
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  entry_number bigint not null,
  entry_date date not null,
  description text not null check (char_length(btrim(description)) between 1 and 300),
  reference text check (reference is null or char_length(reference) <= 100),
  source text not null check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal')),
  source_id uuid,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_cents bigint not null check (total_cents > 0),
  reverses_entry_id uuid references public.journal_entries(id) deferrable initially deferred,
  reversal_reason text check (reversal_reason is null or char_length(reversal_reason) between 3 and 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  posted_txid bigint not null default txid_current(),
  unique (company_id, entry_number),
  unique (company_id, id),
  check ((reverses_entry_id is null) = (reversal_reason is null))
);
create unique index if not exists journal_entries_source_uidx on public.journal_entries (company_id, source, source_id) where source_id is not null;
create unique index if not exists journal_entries_idem_uidx on public.journal_entries (company_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists journal_entries_reverses_uidx on public.journal_entries (reverses_entry_id) where reverses_entry_id is not null;
create index if not exists journal_entries_company_date_idx on public.journal_entries (company_id, entry_date desc, entry_number desc);

create table if not exists public.journal_lines (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  entry_id uuid not null,
  line_no smallint not null check (line_no between 1 and 200),
  account_id uuid not null,
  debit_cents bigint not null default 0 check (debit_cents >= 0 and debit_cents < 1000000000000000),
  credit_cents bigint not null default 0 check (credit_cents >= 0 and credit_cents < 1000000000000000),
  memo text check (memo is null or char_length(memo) <= 200),
  client_id uuid,
  document_id uuid,
  check ((debit_cents > 0) <> (credit_cents > 0)),
  unique (entry_id, line_no),
  foreign key (company_id, entry_id) references public.journal_entries (company_id, id) on delete cascade,
  -- Deferred NO ACTION: an account with lines is never deleted (the account
  -- guard refuses it at once), while a whole company can be (the cascade
  -- removes lines and accounts in any order).
  foreign key (company_id, account_id) references public.ledger_accounts (company_id, id) deferrable initially deferred
);
create index if not exists journal_lines_account_idx on public.journal_lines (account_id, entry_id);
create index if not exists journal_lines_entry_idx on public.journal_lines (entry_id);

create table if not exists public.ledger_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  entity text not null,
  entity_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists ledger_events_company_idx on public.ledger_events (company_id, created_at desc);

-- -------------------------------------------------------------- privileges
alter table public.ledger_settings enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_counters enable row level security;
alter table public.accounting_periods enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;
alter table public.ledger_events enable row level security;
revoke all on public.ledger_settings, public.ledger_accounts, public.ledger_counters, public.accounting_periods,
  public.journal_entries, public.journal_lines, public.ledger_events from public, anon, authenticated;
grant all on public.ledger_settings, public.ledger_accounts, public.ledger_counters, public.accounting_periods,
  public.journal_entries, public.journal_lines, public.ledger_events to service_role;
grant select on public.ledger_settings, public.accounting_periods, public.journal_entries, public.journal_lines,
  public.ledger_events to authenticated;
-- Accounts: written directly (RLS + triggers); never their identity columns.
grant select, delete on public.ledger_accounts to authenticated;
grant insert (company_id, code, name, name_en, type, description, status) on public.ledger_accounts to authenticated;
grant update (code, name, name_en, type, description, status) on public.ledger_accounts to authenticated;

do $$
declare t text;
begin
  foreach t in array array['ledger_settings', 'ledger_accounts', 'accounting_periods', 'journal_entries', 'journal_lines', 'ledger_events'] loop
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
    execute format('create policy ba_%s_select on public.%I for select to authenticated using (public.has_permission(company_id, ''accounting.view''))', t, t);
  end loop;
end $$;
drop policy if exists ba_ledger_accounts_insert on public.ledger_accounts;
create policy ba_ledger_accounts_insert on public.ledger_accounts for insert to authenticated
  with check (public.has_permission(company_id, 'accounting.manage'));
drop policy if exists ba_ledger_accounts_update on public.ledger_accounts;
create policy ba_ledger_accounts_update on public.ledger_accounts for update to authenticated
  using (public.has_permission(company_id, 'accounting.manage')) with check (public.has_permission(company_id, 'accounting.manage'));
drop policy if exists ba_ledger_accounts_delete on public.ledger_accounts;
create policy ba_ledger_accounts_delete on public.ledger_accounts for delete to authenticated
  using (public.has_permission(company_id, 'accounting.manage'));

do $$
declare t text;
begin
  foreach t in array array['ledger_settings', 'ledger_accounts', 'accounting_periods', 'journal_entries', 'journal_lines', 'ledger_events'] loop
    execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    execute format('create trigger ba_company_immutable before update on public.%I for each row execute function public.forbid_company_change()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------- helpers
create or replace function public.ledger_company_gone(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.companies c where c.id = target)
$$;

create or replace function public.ledger_log(target uuid, ent text, ent_id text, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.ledger_events (company_id, entity, entity_id, action, details, actor)
  values (target, ent, ent_id, act, coalesce(info, '{}'::jsonb), (select auth.uid()))
$$;

-- One posting at a time per company: idempotency checks and numbering.
create or replace function public.ledger_lock(target uuid)
returns void language sql security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('ba_ledger:' || target::text, 0))
$$;

create or replace function public.ledger_period_closed(target uuid, d date)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accounting_periods p
                 where p.company_id = target and p.period_month = date_trunc('month', d)::date and p.status = 'closed')
$$;

-- Money of a document (numeric(12,2)) in exact integer cents.
create or replace function public.ledger_cents(amount numeric)
returns bigint language plpgsql immutable set search_path = '' as $$
begin
  if amount is null then return 0; end if;
  if amount * 100 <> trunc(amount * 100) then
    raise exception 'LEDGER_AMOUNT_PRECISION' using errcode = 'P0001', hint = amount::text;
  end if;
  return (amount * 100)::bigint;
end $$;

-- ------------------------------------------------------- default chart
create or replace function public.ledger_ensure_chart(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.ledger_settings s where s.company_id = target) then
    return;
  end if;
  insert into public.ledger_settings (company_id, initialized_by) values (target, (select auth.uid()))
  on conflict (company_id) do nothing;
  if not found then
    return;                                       -- initialised by a parallel transaction
  end if;
  insert into public.ledger_accounts (company_id, code, name, name_en, type, system_key, description)
  select target, v.code, v.name, v.name_en, v.type, v.sk, v.descr
  from (values
    ('1000', 'Efectivo', 'Cash', 'asset', 'cash', 'Pagos de clientes recibidos (efectivo, tarjeta, transferencia).'),
    ('1010', 'Banco', 'Bank', 'asset', null, null),
    ('1200', 'Cuentas por cobrar', 'Accounts receivable', 'asset', 'accounts_receivable', 'Facturas emitidas pendientes de cobro.'),
    ('1500', 'Equipo', 'Equipment', 'asset', null, null),
    ('2000', 'Cuentas por pagar', 'Accounts payable', 'liability', 'accounts_payable', null),
    ('2100', 'Impuesto sobre ventas por pagar', 'Sales tax payable', 'liability', 'sales_tax_payable', 'Impuesto cobrado en facturas, pendiente de remitir.'),
    ('2500', 'Préstamos por pagar', 'Loans payable', 'liability', null, null),
    ('3000', 'Capital del dueño', 'Owner''s equity', 'equity', 'owner_equity', null),
    ('3100', 'Utilidades retenidas', 'Retained earnings', 'equity', 'retained_earnings', null),
    ('4000', 'Ingresos por ventas y servicios', 'Sales and service revenue', 'revenue', 'sales_revenue', 'Reconocidos al emitir la factura.'),
    ('4900', 'Otros ingresos', 'Other income', 'revenue', null, null),
    ('5000', 'Costo de ventas', 'Cost of sales', 'expense', null, null),
    ('6000', 'Gastos generales', 'General expenses', 'expense', null, null),
    ('6100', 'Nómina', 'Payroll', 'expense', null, null),
    ('6200', 'Alquiler', 'Rent', 'expense', null, null),
    ('6300', 'Servicios públicos', 'Utilities', 'expense', null, null)
  ) as v(code, name, name_en, type, sk, descr)
  on conflict do nothing;
  perform public.ledger_log(target, 'ledger', target::text, 'initialized', '{}');
end $$;

create or replace function public.ledger_init(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_permission(target, 'accounting.manage') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  perform public.ledger_ensure_chart(target);
end $$;

create or replace function public.ledger_system_account(target uuid, key text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare a uuid;
begin
  select id into a from public.ledger_accounts where company_id = target and system_key = key;
  if a is null then
    raise exception 'LEDGER_ACCOUNT_MISSING' using errcode = 'P0001', hint = key;
  end if;
  return a;
end $$;

-- ------------------------------------------------------ account triggers
create or replace function public.ledger_account_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  used boolean;
begin
  if tg_op = 'INSERT' then
    if uid is not null then
      if not exists (select 1 from public.ledger_settings s where s.company_id = new.company_id) then
        raise exception 'LEDGER_NOT_INITIALIZED' using errcode = 'P0001';
      end if;
      new.created_by := uid;
    end if;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if public.ledger_company_gone(old.company_id) then return old; end if;
    if old.system_key is not null then
      raise exception 'ACCOUNT_SYSTEM' using errcode = 'P0001', hint = old.code;
    end if;
    if exists (select 1 from public.journal_lines l where l.account_id = old.id) then
      raise exception 'ACCOUNT_HAS_ENTRIES' using errcode = 'P0001', hint = old.code,
        detail = 'An account with movements is archived, never deleted.';
    end if;
    return old;
  end if;
  if new.id <> old.id or new.system_key is distinct from old.system_key or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'ACCOUNT_FIELD_LOCKED' using errcode = 'P0001';
  end if;
  if old.system_key is not null and (new.type <> old.type or new.status <> 'active') then
    raise exception 'ACCOUNT_SYSTEM' using errcode = 'P0001', hint = old.code;
  end if;
  if new.type <> old.type or new.code <> old.code then
    select exists (select 1 from public.journal_lines l where l.account_id = old.id) into used;
    if used then
      raise exception 'ACCOUNT_LOCKED' using errcode = 'P0001', hint = old.code,
        detail = 'The code and type of an account with movements do not change.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ba_ledger_account_guard on public.ledger_accounts;
create trigger ba_ledger_account_guard before insert or update or delete on public.ledger_accounts
  for each row execute function public.ledger_account_guard();

create or replace function public.ledger_account_log()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.ledger_accounts := coalesce(new, old);
begin
  if public.ledger_company_gone(r.company_id) then return null; end if;
  perform public.ledger_log(r.company_id, 'ledger_accounts', r.id::text,
    case tg_op when 'INSERT' then 'created' when 'DELETE' then 'deleted'
      else case when new.status <> old.status then case when new.status = 'archived' then 'archived' else 'restored' end else 'updated' end end,
    jsonb_build_object('code', r.code, 'name', r.name, 'type', r.type)
      || case when tg_op = 'UPDATE' and (new.code <> old.code or new.name <> old.name)
              then jsonb_build_object('previous_code', old.code, 'previous_name', old.name) else '{}'::jsonb end);
  return null;
end $$;
drop trigger if exists ba_ledger_account_log on public.ledger_accounts;
create trigger ba_ledger_account_log after insert or update or delete on public.ledger_accounts
  for each row execute function public.ledger_account_log();

-- -------------------------------------------------------- entry triggers
create or replace function public.ledger_entry_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  base text;
  orig public.journal_entries;
begin
  select s.base_currency into base from public.ledger_settings s where s.company_id = new.company_id;
  if base is null then
    raise exception 'LEDGER_NOT_INITIALIZED' using errcode = 'P0001';
  end if;
  if new.currency is null then new.currency := base; end if;
  if new.currency <> base then
    raise exception 'CURRENCY_NOT_SUPPORTED' using errcode = 'P0001', hint = new.currency;
  end if;
  if new.entry_date is null or new.entry_date < date '2000-01-01' or new.entry_date > public.ba_today() + 366 then
    raise exception 'ENTRY_DATE_INVALID' using errcode = 'P0001';
  end if;
  if public.ledger_period_closed(new.company_id, new.entry_date) then
    raise exception 'PERIOD_CLOSED' using errcode = 'P0001', hint = to_char(new.entry_date, 'YYYY-MM');
  end if;
  if new.reverses_entry_id is not null then
    select * into orig from public.journal_entries where id = new.reverses_entry_id;
    if orig.id is null or orig.company_id <> new.company_id then
      raise exception 'ENTRY_NOT_FOUND' using errcode = 'P0001';
    end if;
    if orig.reverses_entry_id is not null then
      raise exception 'REVERSAL_OF_REVERSAL' using errcode = 'P0001';
    end if;
    if new.entry_date < orig.entry_date then
      raise exception 'ENTRY_DATE_INVALID' using errcode = 'P0001', hint = 'before the original';
    end if;
  end if;
  insert into public.ledger_counters as c (company_id, last_number) values (new.company_id, 1)
  on conflict (company_id) do update set last_number = c.last_number + 1
  returning c.last_number into new.entry_number;
  new.posted_txid := txid_current();
  new.created_at := now();
  if uid is not null then new.created_by := uid; end if;
  return new;
end $$;
drop trigger if exists ba_ledger_entry_insert on public.journal_entries;
create trigger ba_ledger_entry_insert before insert on public.journal_entries
  for each row execute function public.ledger_entry_before_insert();

-- Balanced at commit: lines ≥ 2, debits = credits = total_cents.
create or replace function public.ledger_entry_balanced()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  n integer; dr numeric; cr numeric; tot bigint;
begin
  select e.total_cents into tot from public.journal_entries e where e.id = new.id;
  if tot is null then return null; end if;      -- removed with its company in the same transaction
  select count(*), coalesce(sum(l.debit_cents), 0), coalesce(sum(l.credit_cents), 0) into n, dr, cr
  from public.journal_lines l where l.entry_id = new.id;
  if n < 2 or dr <> cr or dr <> tot then
    raise exception 'ENTRY_UNBALANCED' using errcode = 'P0001',
      hint = format('lines=%s debits=%s credits=%s total=%s', n, dr, cr, tot);
  end if;
  return null;
end $$;
drop trigger if exists ba_ledger_entry_balanced on public.journal_entries;
create constraint trigger ba_ledger_entry_balanced after insert on public.journal_entries
  deferrable initially deferred for each row execute function public.ledger_entry_balanced();

create or replace function public.ledger_line_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  e public.journal_entries;
  a public.ledger_accounts;
begin
  select * into e from public.journal_entries where id = new.entry_id;
  if e.id is null or e.company_id <> new.company_id then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'P0001';
  end if;
  if e.posted_txid <> txid_current() then
    raise exception 'LEDGER_IMMUTABLE' using errcode = 'P0001',
      detail = 'Lines are added only when the entry is posted.';
  end if;
  select * into a from public.ledger_accounts where id = new.account_id;
  if a.id is null or a.company_id <> new.company_id then
    raise exception 'ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  if a.status <> 'active' and e.source <> 'reversal' and e.source <> 'invoice_void' then
    raise exception 'ACCOUNT_ARCHIVED' using errcode = 'P0001', hint = a.code;
  end if;
  return new;
end $$;
drop trigger if exists ba_ledger_line_insert on public.journal_lines;
create trigger ba_ledger_line_insert before insert on public.journal_lines
  for each row execute function public.ledger_line_before_insert();

-- Append-only: posted rows never change; only a company cascade removes them.
create or replace function public.ledger_append_only()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and public.ledger_company_gone(old.company_id) then
    return old;
  end if;
  raise exception 'LEDGER_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name,
    detail = 'Posted accounting records are corrected with a reversal entry.';
end $$;
create or replace function public.ledger_no_truncate()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'LEDGER_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
end $$;
do $$
declare t text;
begin
  foreach t in array array['journal_entries', 'journal_lines', 'ledger_events'] loop
    execute format('drop trigger if exists ba_ledger_append_only on public.%I', t);
    execute format('create trigger ba_ledger_append_only before update or delete on public.%I for each row execute function public.ledger_append_only()', t);
    execute format('drop trigger if exists ba_ledger_no_truncate on public.%I', t);
    execute format('create trigger ba_ledger_no_truncate before truncate on public.%I for each statement execute function public.ledger_no_truncate()', t);
  end loop;
end $$;

-- Periods: changed only by the close / reopen functions (not by users).
create or replace function public.ledger_period_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.ledger_company_gone(old.company_id) then return old; end if;
    raise exception 'LEDGER_IMMUTABLE' using errcode = 'P0001', hint = 'accounting_periods';
  end if;
  return new;
end $$;
drop trigger if exists ba_ledger_period_guard on public.accounting_periods;
create trigger ba_ledger_period_guard before delete on public.accounting_periods
  for each row execute function public.ledger_period_guard();

-- ------------------------------------------------------------- posting core
-- lines: [{"account": uuid | "key": system_key, "debit": int, "credit": int,
--          "memo", "client_id", "document_id"}] — integer cents only.
create or replace function public.ledger_post(target uuid, on_date date, descr text, ref text, src text,
  src_id uuid, lines jsonb, idem text default null, reverses uuid default null, reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  eid uuid;
  ln jsonb;
  i integer := 0;
  acc uuid;
  dr bigint; cr bigint;
  tot bigint := 0;
  crs bigint := 0;
begin
  perform public.ledger_ensure_chart(target);
  perform public.ledger_lock(target);
  if src_id is not null and exists (select 1 from public.journal_entries e
                                    where e.company_id = target and e.source = src and e.source_id = src_id) then
    return null;                                  -- already posted: one entry per event
  end if;
  if jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) < 2 or jsonb_array_length(lines) > 200 then
    raise exception 'ENTRY_LINES_INVALID' using errcode = 'P0001';
  end if;
  for ln in select * from jsonb_array_elements(lines) loop
    if coalesce(ln ->> 'debit', '0') !~ '^[0-9]{1,15}$' or coalesce(ln ->> 'credit', '0') !~ '^[0-9]{1,15}$' then
      raise exception 'ENTRY_AMOUNT_INVALID' using errcode = 'P0001', hint = 'integer cents only';
    end if;
    if (coalesce((ln ->> 'debit')::bigint, 0) > 0) = (coalesce((ln ->> 'credit')::bigint, 0) > 0) then
      raise exception 'ENTRY_LINE_INVALID' using errcode = 'P0001', hint = 'each line is a debit or a credit';
    end if;
    tot := tot + coalesce((ln ->> 'debit')::bigint, 0);
    crs := crs + coalesce((ln ->> 'credit')::bigint, 0);
  end loop;
  -- Checked here for a clear error now; the deferred trigger re-checks at commit.
  if tot = 0 or tot <> crs then
    raise exception 'ENTRY_UNBALANCED' using errcode = 'P0001', hint = format('debits=%s credits=%s', tot, crs);
  end if;
  insert into public.journal_entries (company_id, entry_date, description, reference, source, source_id,
                                      idempotency_key, total_cents, reverses_entry_id, reversal_reason)
  values (target, on_date, btrim(descr), nullif(btrim(coalesce(ref, '')), ''), src, src_id, idem, tot, reverses, reason)
  returning id into eid;
  for ln in select * from jsonb_array_elements(lines) loop
    i := i + 1;
    if ln ? 'key' then
      acc := public.ledger_system_account(target, ln ->> 'key');
    elsif coalesce(ln ->> 'account', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      acc := (ln ->> 'account')::uuid;
    else
      raise exception 'ACCOUNT_INVALID' using errcode = 'P0001';
    end if;
    dr := coalesce((ln ->> 'debit')::bigint, 0);
    cr := coalesce((ln ->> 'credit')::bigint, 0);
    insert into public.journal_lines (company_id, entry_id, line_no, account_id, debit_cents, credit_cents, memo, client_id, document_id)
    values (target, eid, i, acc, dr, cr, nullif(btrim(coalesce(ln ->> 'memo', '')), ''),
            nullif(ln ->> 'client_id', '')::uuid, nullif(ln ->> 'document_id', '')::uuid);
  end loop;
  perform public.ledger_log(target, 'journal_entries', eid::text,
    case when reverses is not null then 'reversed' else 'posted' end,
    jsonb_build_object('source', src, 'source_id', src_id, 'total_cents', tot, 'date', on_date, 'reverses', reverses));
  return eid;
end $$;

-- Mirror of an entry (debits ↔ credits).
create or replace function public.ledger_mirror_lines(orig uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('account', l.account_id, 'debit', l.credit_cents, 'credit', l.debit_cents,
           'memo', l.memo, 'client_id', l.client_id, 'document_id', l.document_id) order by l.line_no), '[]'::jsonb)
  from public.journal_lines l where l.entry_id = orig
$$;

-- ------------------------------------------------------ from documents
create or replace function public.ledger_post_invoice(doc uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  d record;
  tot bigint; tx bigint;
  ln jsonb;
begin
  select id, company_id, client_id, document_type, document_number, status, issue_date, total, tax, metadata
    into d from public.documents where id = doc;
  if d.id is null or d.document_type <> 'invoice' or d.status = 'draft'
     or (d.status = 'cancelled' and coalesce(d.metadata -> 'void' ->> 'previous_status', 'draft') = 'draft') then
    return null;                                  -- never issued: nothing to post
  end if;
  tot := public.ledger_cents(d.total);
  tx := public.ledger_cents(d.tax);
  if tot = 0 then return null; end if;
  if tx > tot then
    raise exception 'LEDGER_DOCUMENT_INCONSISTENT' using errcode = 'P0001', hint = d.document_number;
  end if;
  ln := jsonb_build_array(jsonb_build_object('key', 'accounts_receivable', 'debit', tot, 'client_id', d.client_id, 'document_id', d.id));
  if tot - tx > 0 then
    ln := ln || jsonb_build_object('key', 'sales_revenue', 'credit', tot - tx, 'client_id', d.client_id, 'document_id', d.id);
  end if;
  if tx > 0 then
    ln := ln || jsonb_build_object('key', 'sales_tax_payable', 'credit', tx, 'client_id', d.client_id, 'document_id', d.id);
  end if;
  if jsonb_array_length(ln) < 2 then return null; end if;   -- only tax and no revenue: impossible (tx <= tot, tot > 0)
  return public.ledger_post(d.company_id, d.issue_date, d.document_number, d.document_number, 'invoice', d.id, ln);
end $$;

create or replace function public.ledger_post_invoice_void(doc uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  d record;
  orig public.journal_entries;
  why text;
  on_date date;
begin
  select id, company_id, document_number, metadata into d from public.documents where id = doc;
  select * into orig from public.journal_entries e
   where e.company_id = d.company_id and e.source = 'invoice' and e.source_id = doc;
  if orig.id is null then return null; end if;   -- never posted (zero total or before the ledger)
  why := left(coalesce(nullif(btrim(d.metadata -> 'void' ->> 'reason'), ''), 'void'), 300);
  if char_length(why) < 3 then why := 'void'; end if;
  on_date := greatest(public.ba_today(), orig.entry_date);
  if d.metadata -> 'void' ? 'voided_at' then
    on_date := greatest(((d.metadata -> 'void' ->> 'voided_at')::timestamptz at time zone 'America/Puerto_Rico')::date, orig.entry_date);
  end if;
  return public.ledger_post(d.company_id, on_date, d.document_number, d.document_number, 'invoice_void', doc,
                            public.ledger_mirror_lines(orig.id), null, orig.id, why);
end $$;

create or replace function public.ledger_post_payment(pay uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  pr record;
  amt bigint;
begin
  select py.id, py.company_id, py.document_id, py.amount, py.reference, py.paid_at, d.document_number, d.client_id
    into pr from public.payments py join public.documents d on d.id = py.document_id where py.id = pay;
  if pr.id is null then return null; end if;
  perform public.ledger_post_invoice(pr.document_id);  -- an invoice from before the ledger: its real issue first
  amt := public.ledger_cents(pr.amount);
  return public.ledger_post(pr.company_id, (pr.paid_at at time zone 'America/Puerto_Rico')::date,
    pr.document_number, coalesce(nullif(btrim(pr.reference), ''), pr.document_number), 'payment', pr.id,
    jsonb_build_array(
      jsonb_build_object('key', 'cash', 'debit', amt, 'client_id', pr.client_id, 'document_id', pr.document_id),
      jsonb_build_object('key', 'accounts_receivable', 'credit', amt, 'client_id', pr.client_id, 'document_id', pr.document_id)));
end $$;

create or replace function public.ledger_on_document()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.document_type <> 'invoice' then return null; end if;
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'cancelled') then perform public.ledger_post_invoice(new.id); end if;
  elsif new.status is distinct from old.status then
    if old.status = 'draft' and new.status not in ('draft', 'cancelled') then
      perform public.ledger_post_invoice(new.id);
    elsif new.status = 'cancelled' and old.status not in ('draft', 'cancelled') then
      perform public.ledger_post_invoice_void(new.id);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists ba_ledger_document on public.documents;
create trigger ba_ledger_document after insert or update of status on public.documents
  for each row execute function public.ledger_on_document();

create or replace function public.ledger_on_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.ledger_post_payment(new.id);
  return null;
end $$;
drop trigger if exists ba_ledger_payment on public.payments;
create trigger ba_ledger_payment after insert on public.payments
  for each row execute function public.ledger_on_payment();

-- ---------------------------------------------------- user-facing actions
create or replace function public.ledger_post_manual(target uuid, entry_date date, description text, reference text,
  lines jsonb, idempotency_key text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  eid uuid;
  ln jsonb;
begin
  if not public.has_permission(target, 'accounting.post') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  perform public.ledger_ensure_chart(target);
  perform public.ledger_lock(target);
  if idempotency_key is not null then
    select e.id into eid from public.journal_entries e where e.company_id = target and e.idempotency_key = ledger_post_manual.idempotency_key;
    if eid is not null then return eid; end if;   -- the same submission again
  end if;
  if jsonb_typeof(lines) <> 'array' then
    raise exception 'ENTRY_LINES_INVALID' using errcode = 'P0001';
  end if;
  for ln in select * from jsonb_array_elements(lines) loop
    if ln ? 'key' then                            -- only explicit accounts from users
      raise exception 'ACCOUNT_INVALID' using errcode = 'P0001';
    end if;
  end loop;
  if char_length(btrim(coalesce(description, ''))) < 1 then
    raise exception 'ENTRY_DESCRIPTION_REQUIRED' using errcode = 'P0001';
  end if;
  return public.ledger_post(target, entry_date, description, reference, 'manual', null, lines, idempotency_key);
end $$;

create or replace function public.ledger_reverse_entry(entry uuid, reason text, reversal_date date default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  e public.journal_entries;
  why text := btrim(coalesce(reason, ''));
  eid uuid;
begin
  select * into e from public.journal_entries where id = entry;
  if e.id is null or not public.has_permission(e.company_id, 'accounting.post') then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'P0001';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then
    raise exception 'REVERSAL_REASON_REQUIRED' using errcode = 'P0001';
  end if;
  if e.source in ('reversal', 'invoice_void') then
    raise exception 'REVERSAL_OF_REVERSAL' using errcode = 'P0001';
  elsif e.source <> 'manual' then
    raise exception 'ENTRY_FROM_DOCUMENT' using errcode = 'P0001', hint = e.source,
      detail = 'Entries posted from documents are corrected through the document (void).';
  end if;
  perform public.ledger_lock(e.company_id);
  if exists (select 1 from public.journal_entries r where r.reverses_entry_id = e.id) then
    raise exception 'ENTRY_ALREADY_REVERSED' using errcode = 'P0001';
  end if;
  eid := public.ledger_post(e.company_id, coalesce(reversal_date, greatest(public.ba_today(), e.entry_date)),
    left('Reversión / Reversal #' || e.entry_number || ': ' || e.description, 300), e.reference, 'reversal', null,
    public.ledger_mirror_lines(e.id), null, e.id, why);
  return eid;
end $$;

create or replace function public.ledger_close_period(target uuid, month date)
returns void language plpgsql security definer set search_path = '' as $$
declare m date := date_trunc('month', month)::date;
begin
  if not public.has_permission(target, 'accounting.close') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if m >= date_trunc('month', public.ba_today())::date then
    raise exception 'PERIOD_NOT_ENDED' using errcode = 'P0001', hint = to_char(m, 'YYYY-MM');
  end if;
  perform public.ledger_ensure_chart(target);
  perform public.ledger_lock(target);
  if public.ledger_period_closed(target, m) then
    raise exception 'PERIOD_ALREADY_CLOSED' using errcode = 'P0001';
  end if;
  -- Write the counter row as postings do: a posting transaction that read
  -- the period as open under REPEATABLE READ / SERIALIZABLE then fails with
  -- a serialization error instead of landing in the closed month.
  insert into public.ledger_counters as c (company_id, last_number) values (target, 0)
  on conflict (company_id) do update set last_number = c.last_number;
  insert into public.accounting_periods as p (company_id, period_month, status, closed_at, closed_by)
  values (target, m, 'closed', now(), (select auth.uid()))
  on conflict (company_id, period_month) do update set status = 'closed', closed_at = now(), closed_by = (select auth.uid());
  perform public.ledger_log(target, 'accounting_periods', to_char(m, 'YYYY-MM'), 'closed', '{}');
end $$;

create or replace function public.ledger_reopen_period(target uuid, month date, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m date := date_trunc('month', month)::date;
  why text := btrim(coalesce(reason, ''));
begin
  if not public.has_permission(target, 'accounting.reopen') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then
    raise exception 'REOPEN_REASON_REQUIRED' using errcode = 'P0001';
  end if;
  perform public.ledger_lock(target);
  -- Write the counter row as postings do: a posting transaction that read
  -- the period as open under REPEATABLE READ / SERIALIZABLE then fails with
  -- a serialization error instead of landing in the closed month.
  insert into public.ledger_counters as c (company_id, last_number) values (target, 0)
  on conflict (company_id) do update set last_number = c.last_number;
  update public.accounting_periods set status = 'open', reopened_at = now(), reopened_by = (select auth.uid()), reopen_reason = why
   where company_id = target and period_month = m and status = 'closed';
  if not found then
    raise exception 'PERIOD_NOT_CLOSED' using errcode = 'P0001';
  end if;
  perform public.ledger_log(target, 'accounting_periods', to_char(m, 'YYYY-MM'), 'reopened', jsonb_build_object('reason', why));
end $$;

-- Issued invoices and payments that exist from before the ledger, posted
-- from their real dates (idempotent; nothing invented).
create or replace function public.ledger_import_history(target uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
begin
  if not public.has_permission(target, 'accounting.post') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  perform public.ledger_ensure_chart(target);
  perform public.ledger_lock(target);
  for r in
    select 'invoice' as k, d.id, d.issue_date as on_day, d.created_at as tie from public.documents d
     where d.company_id = target and d.document_type = 'invoice' and d.status <> 'draft'
    union all
    select 'payment', p.id, (p.paid_at at time zone 'America/Puerto_Rico')::date, p.created_at from public.payments p
     where p.company_id = target
    union all
    select 'void', d.id, ((d.metadata -> 'void' ->> 'voided_at')::timestamptz at time zone 'America/Puerto_Rico')::date, d.updated_at
      from public.documents d
     where d.company_id = target and d.document_type = 'invoice' and d.status = 'cancelled'
       and coalesce(d.metadata -> 'void' ->> 'previous_status', 'draft') <> 'draft' and d.metadata -> 'void' ? 'voided_at'
    order by 3, 4, 1
  loop
    if r.k = 'invoice' then
      if public.ledger_post_invoice(r.id) is not null then n := n + 1; end if;
    elsif r.k = 'payment' then
      if public.ledger_post_payment(r.id) is not null then n := n + 1; end if;
    elsif public.ledger_post_invoice_void(r.id) is not null then
      n := n + 1;
    end if;
  end loop;
  perform public.ledger_log(target, 'ledger', target::text, 'history_imported', jsonb_build_object('entries', n));
  return n;
end $$;

-- ---------------------------------------------------------------- reports
-- SECURITY INVOKER: the caller's RLS (accounting.view) decides what is read.
create or replace function public.ledger_trial_balance(target uuid, as_of date default null)
returns table (account_id uuid, code text, name text, name_en text, type text, status text,
               debit_cents bigint, credit_cents bigint, balance_cents bigint)
language sql stable set search_path = '' as $$
  select a.id, a.code, a.name, a.name_en, a.type, a.status,
         coalesce(sum(l.debit_cents), 0)::bigint, coalesce(sum(l.credit_cents), 0)::bigint,
         (case when a.type in ('asset', 'expense') then coalesce(sum(l.debit_cents), 0) - coalesce(sum(l.credit_cents), 0)
               else coalesce(sum(l.credit_cents), 0) - coalesce(sum(l.debit_cents), 0) end)::bigint
  from public.ledger_accounts a
  left join (public.journal_lines l join public.journal_entries e on e.id = l.entry_id
             and (as_of is null or e.entry_date <= as_of)) on l.account_id = a.id
  where a.company_id = target
  group by a.id
  having a.status = 'active' or count(l.id) > 0
  order by a.code
$$;

create or replace function public.ledger_account_activity(account uuid, from_date date, to_date date)
returns table (entry_id uuid, entry_number bigint, entry_date date, description text, reference text, source text,
               reverses_entry_id uuid, memo text, debit_cents bigint, credit_cents bigint, balance_cents bigint)
language sql stable set search_path = '' as $$
  with a as (select id, type from public.ledger_accounts where id = account),
  sign as (select case when type in ('asset', 'expense') then 1 else -1 end as s from a),
  opening as (
    select coalesce(sum(l.debit_cents - l.credit_cents), 0) as o
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
    where l.account_id = account and e.entry_date < from_date)
  select t.entry_id, t.entry_number, t.entry_date, t.description, t.reference, t.source, t.reverses_entry_id, t.memo,
         t.debit_cents, t.credit_cents, t.balance_cents
  from (
    select 0 as o1, null::uuid as entry_id, null::bigint as entry_number, from_date as entry_date, 'opening'::text as description,
           null::text as reference, 'opening'::text as source, null::uuid as reverses_entry_id, null::text as memo,
           null::bigint as debit_cents, null::bigint as credit_cents, ((select o from opening) * (select s from sign))::bigint as balance_cents,
           0::bigint as o2, 0 as o3
    where exists (select 1 from a)
    union all
    select 1, e.id, e.entry_number, e.entry_date, e.description, e.reference, e.source, e.reverses_entry_id, l.memo,
           l.debit_cents, l.credit_cents,
           (((select o from opening) + sum(l.debit_cents - l.credit_cents) over (order by e.entry_date, e.entry_number, l.line_no))
             * (select s from sign))::bigint,
           e.entry_number, l.line_no
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
    where l.account_id = account and e.entry_date between from_date and to_date) t
  order by t.o1, t.entry_date, t.o2, t.o3
$$;

-- Integrity summary: all debits = all credits, and the receivable account
-- equals the open balance of the invoices that are in the ledger.
create or replace function public.ledger_integrity(target uuid)
returns table (debit_cents bigint, credit_cents bigint, unbalanced_entries bigint,
               receivable_cents bigint, open_invoices_cents bigint, unposted_invoices bigint, unposted_payments bigint)
language sql stable set search_path = '' as $$
  select
    (select coalesce(sum(l.debit_cents), 0) from public.journal_lines l where l.company_id = target)::bigint,
    (select coalesce(sum(l.credit_cents), 0) from public.journal_lines l where l.company_id = target)::bigint,
    (select count(*) from (select l.entry_id from public.journal_lines l where l.company_id = target
                           group by l.entry_id having sum(l.debit_cents) <> sum(l.credit_cents)) u),
    (select coalesce(sum(l.debit_cents - l.credit_cents), 0) from public.journal_lines l
       join public.ledger_accounts a on a.id = l.account_id
      where l.company_id = target and a.system_key = 'accounts_receivable')::bigint,
    (select coalesce(sum(public.ledger_cents(d.total) - coalesce((select public.ledger_cents(sum(p.amount)) from public.payments p where p.document_id = d.id), 0)), 0)
       from public.documents d
      where d.company_id = target and d.document_type = 'invoice' and d.status in ('sent', 'overdue', 'paid')
        and exists (select 1 from public.journal_entries e where e.company_id = target and e.source = 'invoice' and e.source_id = d.id))::bigint,
    (select count(*) from public.documents d
      where d.company_id = target and d.document_type = 'invoice' and d.status in ('sent', 'overdue', 'paid') and d.total > 0
        and not exists (select 1 from public.journal_entries e where e.company_id = target and e.source = 'invoice' and e.source_id = d.id)),
    (select count(*) from public.payments p
      where p.company_id = target
        and not exists (select 1 from public.journal_entries e where e.company_id = target and e.source = 'payment' and e.source_id = p.id))
  where public.has_permission(target, 'accounting.view') or (select auth.uid()) is null
$$;

-- -------------------------------------------------------------- function grants
do $$
declare f text;
begin
  foreach f in array array[
    'ledger_company_gone(uuid)', 'ledger_log(uuid, text, text, text, jsonb)', 'ledger_lock(uuid)',
    'ledger_period_closed(uuid, date)', 'ledger_ensure_chart(uuid)', 'ledger_system_account(uuid, text)',
    'ledger_account_guard()', 'ledger_account_log()', 'ledger_entry_before_insert()', 'ledger_entry_balanced()',
    'ledger_line_before_insert()', 'ledger_append_only()', 'ledger_no_truncate()', 'ledger_period_guard()',
    'ledger_post(uuid, date, text, text, text, uuid, jsonb, text, uuid, text)', 'ledger_mirror_lines(uuid)',
    'ledger_post_invoice(uuid)', 'ledger_post_invoice_void(uuid)', 'ledger_post_payment(uuid)',
    'ledger_on_document()', 'ledger_on_payment()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'ledger_init(uuid)', 'ledger_post_manual(uuid, date, text, text, jsonb, text)', 'ledger_reverse_entry(uuid, text, date)',
    'ledger_close_period(uuid, date)', 'ledger_reopen_period(uuid, date, text)', 'ledger_import_history(uuid)',
    'ledger_trial_balance(uuid, date)', 'ledger_account_activity(uuid, date, date)', 'ledger_integrity(uuid)',
    'ledger_cents(numeric)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ------------------------------------------------------------ self-check
do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in
        ('ba_ledger_account_guard', 'ba_ledger_account_log', 'ba_ledger_entry_insert', 'ba_ledger_entry_balanced',
         'ba_ledger_line_insert', 'ba_ledger_period_guard', 'ba_ledger_document', 'ba_ledger_payment')) <> 8 then
    raise exception 'BA0023 self-check failed: triggers missing';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in ('ba_ledger_append_only', 'ba_ledger_no_truncate')) <> 6 then
    raise exception 'BA0023 self-check failed: append-only triggers missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'ba_ledger_entry_balanced' and tgdeferrable and tginitdeferred) then
    raise exception 'BA0023 self-check failed: the balance check must be deferred';
  end if;
  if has_table_privilege('authenticated', 'public.journal_entries', 'INSERT')
     or has_table_privilege('authenticated', 'public.journal_lines', 'INSERT')
     or has_table_privilege('authenticated', 'public.journal_entries', 'UPDATE')
     or has_table_privilege('authenticated', 'public.journal_lines', 'DELETE')
     or has_table_privilege('authenticated', 'public.accounting_periods', 'INSERT')
     or has_table_privilege('authenticated', 'public.ledger_counters', 'SELECT')
     or has_table_privilege('anon', 'public.journal_entries', 'SELECT')
     or has_function_privilege('authenticated', 'public.ledger_post(uuid, date, text, text, text, uuid, jsonb, text, uuid, text)', 'EXECUTE') then
    raise exception 'BA0023 self-check failed: privileges';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key like 'accounting.%')
     or (select count(*) from public.role_permissions where permission_key = 'accounting.reopen') <> 1 then
    raise exception 'BA0023 self-check failed: role matrix';
  end if;
  if (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'journal_lines' and column_name = 'debit_cents') <> 'bigint' then
    raise exception 'BA0023 self-check failed: amounts must be integer cents';
  end if;
end $$;

commit;
