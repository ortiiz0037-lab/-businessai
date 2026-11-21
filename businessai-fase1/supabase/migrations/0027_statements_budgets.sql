-- =====================================================================
-- BusinessAI · Migration 0027 · Finance: financial statements, budgets,
-- budget vs actual, projection assumptions
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a, 0015, 0020, 0023 … 0026.
--
-- NO PARALLEL BOOK. Every statement is computed from the posted journal
-- lines (0023) at query time; nothing is stored or copied. Budgets are
-- plans (no journal entries); projections are computed in the app from
-- the same functions and are always labelled as estimates.
--
-- CLASSIFICATION. ledger_accounts.statement_class (optional) places an
-- account in the statements; when empty it is derived (fs_class):
--   asset      cash (system cash, codes 10xx, or linked to a bank account), current_asset,
--              non_current_asset (code 15–19), accumulated_depreciation
--   liability  current_liability, non_current_liability (code 25–29)
--   equity     equity, retained_earnings (system)
--   revenue    operating_revenue, other_income (code 45–49)
--   expense    cost_of_sales (5xxx), operating_expense (6xxx–7xxx),
--              other_expense (8xxx), income_tax (9xxx)
-- Changing a class changes reports only, never entries (logged).
--
-- STATEMENTS
--  * fs_account_balances: opening / movement / closing per account (cents).
--  * fs_income_statement(from, to): revenue and expense movements by class.
--  * fs_balance_sheet(as_of): balances by class + prior-year results +
--    current-year result (no year-end close exists: results are computed);
--    assets = liabilities + equity + results always (the ledger balances).
--  * fs_cash_flow(from, to): indirect method; net income, accumulated
--    depreciation (only if such accounts exist), working capital, investing,
--    financing; cash change = sum by identity.
--  * fs_data_quality(as_of): history not posted, negative cash, missing
--    opening balances, open months → the app marks statements provisional.
--  * fs_monthly: monthly series (revenue, cost, expenses, tax, net, cash).
-- BUDGETS draft → approved → published → archived; approved and published
--  budgets never change (a new version is a new draft copy); one published
--  budget per year, scenario and department. budget_vs_actual compares with
--  the ledger (accounts) or the approved bills (expense categories).
-- ROLES: statements and budgets readable with accounting.view;
--  budgets.manage (owner, admin), budgets.approve (owner).
-- Rollback: supabase/rollback/0027_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.bank_accounts') is null or to_regclass('public.departments') is null then
    raise exception 'BA0027: migrations 0020 and 0026 must be applied first';
  end if;
end $$;

insert into public.permissions (key, module, description_es, description_en) values
  ('budgets.manage', 'budgets', 'Crear y editar presupuestos (borradores), versiones y supuestos de proyección', 'Create and edit budgets (drafts), versions and projection assumptions'),
  ('budgets.approve', 'budgets', 'Aprobar y publicar presupuestos', 'Approve and publish budgets')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'budgets.manage'), ('admin', 'budgets.manage'), ('owner', 'budgets.approve')
on conflict do nothing;

-- ------------------------------------------------------------- classification
alter table public.ledger_accounts add column if not exists statement_class text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_accounts_statement_class_check') then
    alter table public.ledger_accounts add constraint ledger_accounts_statement_class_check check (
      statement_class is null
      or (type = 'asset' and statement_class in ('cash', 'current_asset', 'non_current_asset', 'accumulated_depreciation'))
      or (type = 'liability' and statement_class in ('current_liability', 'non_current_liability'))
      or (type = 'equity' and statement_class in ('equity', 'retained_earnings'))
      or (type = 'revenue' and statement_class in ('operating_revenue', 'other_income'))
      or (type = 'expense' and statement_class in ('cost_of_sales', 'operating_expense', 'other_expense', 'income_tax')));
  end if;
end $$;
grant update (statement_class) on public.ledger_accounts to authenticated;

create or replace function public.fs_class(account uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(a.statement_class,
    case a.type
      when 'asset' then case
        when a.system_key = 'cash' or a.code ~ '^10' or exists (select 1 from public.bank_accounts b where b.ledger_account_id = a.id) then 'cash'
        when a.code ~ '^1[5-9]' then 'non_current_asset' else 'current_asset' end
      when 'liability' then case when a.code ~ '^2[5-9]' then 'non_current_liability' else 'current_liability' end
      when 'equity' then case when a.system_key = 'retained_earnings' then 'retained_earnings' else 'equity' end
      when 'revenue' then case when a.code ~ '^4[5-9]' then 'other_income' else 'operating_revenue' end
      else case when a.code ~ '^5' then 'cost_of_sales' when a.code ~ '^8' then 'other_expense' when a.code ~ '^9' then 'income_tax' else 'operating_expense' end
    end)
  from public.ledger_accounts a where a.id = account
$$;

-- ------------------------------------------------------------- balances
-- Signed amounts: dr = debit − credit (assets, expenses positive).
create or replace function public.fs_account_balances(target uuid, from_date date, to_date date)
returns table (account_id uuid, code text, name text, name_en text, type text, class text, status text,
               opening_dr bigint, movement_dr bigint, closing_dr bigint)
language sql stable security definer set search_path = '' as $$
  select a.id, a.code, a.name, a.name_en, a.type, public.fs_class(a.id), a.status,
         coalesce(sum(l.debit_cents - l.credit_cents) filter (where e.entry_date < from_date), 0)::bigint,
         coalesce(sum(l.debit_cents - l.credit_cents) filter (where e.entry_date between from_date and to_date), 0)::bigint,
         coalesce(sum(l.debit_cents - l.credit_cents) filter (where e.entry_date <= to_date), 0)::bigint
  from public.ledger_accounts a
  left join public.journal_lines l on l.account_id = a.id
  left join public.journal_entries e on e.id = l.entry_id
  where a.company_id = target and (public.has_permission(target, 'accounting.view') or (select auth.uid()) is null)
  group by a.id
  order by a.code
$$;

-- Income statement lines: amount in the natural sign (revenue +, expense +).
create or replace function public.fs_income_statement(target uuid, from_date date, to_date date)
returns table (section text, account_id uuid, code text, name text, name_en text, amount_cents bigint)
language sql stable security definer set search_path = '' as $$
  select b.class, b.account_id, b.code, b.name, b.name_en,
         case when b.type = 'revenue' then -b.movement_dr else b.movement_dr end
  from public.fs_account_balances(target, from_date, to_date) b
  where b.type in ('revenue', 'expense') and (b.movement_dr <> 0 or b.status = 'active')
  order by b.code
$$;

-- Balance sheet as of a date: accounts in their natural sign plus the
-- computed result lines (prior years, current year).
create or replace function public.fs_balance_sheet(target uuid, as_of date)
returns table (section text, account_id uuid, code text, name text, name_en text, amount_cents bigint)
language sql stable security definer set search_path = '' as $$
  with b as (select * from public.fs_account_balances(target, make_date(extract(year from as_of)::int, 1, 1), as_of)),
  pl as (select coalesce(sum(-b.opening_dr), 0)::bigint as prior, coalesce(sum(-b.movement_dr), 0)::bigint as cur
         from b where b.type in ('revenue', 'expense'))
  select b.class, b.account_id, b.code, b.name, b.name_en,
         case when b.type = 'asset' then b.closing_dr else -b.closing_dr end
  from b where b.type in ('asset', 'liability', 'equity') and (b.closing_dr <> 0 or b.status = 'active')
  union all select 'prior_results', null, null, null, null, (select prior from pl)
           where exists (select 1 from b)
  union all select 'current_result', null, null, null, null, (select cur from pl)
           where exists (select 1 from b)
$$;

-- Cash flow (indirect): cash effect of every non-cash account = −movement.
create or replace function public.fs_cash_flow(target uuid, from_date date, to_date date)
returns table (section text, account_id uuid, code text, name text, name_en text, amount_cents bigint)
language sql stable security definer set search_path = '' as $$
  with b as (select * from public.fs_account_balances(target, from_date, to_date))
  select 'net_income', null::uuid, null::text, null::text, null::text, coalesce(sum(-b.movement_dr), 0)::bigint
  from b where b.type in ('revenue', 'expense') having count(*) > 0
  union all
  select case b.class
           when 'accumulated_depreciation' then 'non_cash'
           when 'current_asset' then 'working_capital' when 'current_liability' then 'working_capital'
           when 'non_current_asset' then 'investing'
           else 'financing' end,
         b.account_id, b.code, b.name, b.name_en, -b.movement_dr
  from b where b.type in ('asset', 'liability', 'equity') and b.class <> 'cash' and b.movement_dr <> 0
  union all
  select 'cash_opening', null, null, null, null, coalesce(sum(b.opening_dr), 0)::bigint from b where b.class = 'cash' having count(*) > 0
  union all
  select 'cash_closing', null, null, null, null, coalesce(sum(b.closing_dr), 0)::bigint from b where b.class = 'cash' having count(*) > 0
$$;

-- What makes a statement provisional.
create or replace function public.fs_data_quality(target uuid, from_date date, to_date date)
returns table (entries bigint, first_entry_date date, unposted_invoices bigint, unposted_payments bigint, negative_cash_accounts bigint,
               opening_balance_recorded boolean, months_in_range integer, closed_months integer, unbalanced_entries bigint)
language sql stable security definer set search_path = '' as $$
  with ok as (select public.has_permission(target, 'accounting.view') or (select auth.uid()) is null as yes),
  integ as (select * from public.ledger_integrity(target))
  select (select count(*) from public.journal_entries e where e.company_id = target and e.entry_date <= to_date),
         (select min(e.entry_date) from public.journal_entries e where e.company_id = target),
         coalesce((select unposted_invoices from integ), 0), coalesce((select unposted_payments from integ), 0),
         (select count(*) from public.fs_account_balances(target, from_date, to_date) b where b.class = 'cash' and b.closing_dr < 0),
         exists (select 1 from public.journal_entries e join public.journal_lines l on l.entry_id = e.id join public.ledger_accounts a on a.id = l.account_id
                 where e.company_id = target and e.source in ('manual', 'bank_reconciliation') and a.type = 'equity'),
         ((extract(year from to_date)::int * 12 + extract(month from to_date)::int) - (extract(year from from_date)::int * 12 + extract(month from from_date)::int) + 1),
         (select count(*)::int from public.accounting_periods p where p.company_id = target and p.status = 'closed'
            and p.period_month between date_trunc('month', from_date)::date and date_trunc('month', to_date)::date),
         coalesce((select unbalanced_entries from integ), 0)
  where (select yes from ok)
$$;

-- Monthly series for trends and projections (at most 60 months).
create or replace function public.fs_monthly(target uuid, first_month date, months integer)
returns table (month date, revenue_cents bigint, cost_of_sales_cents bigint, expense_cents bigint, tax_cents bigint, net_cents bigint, cash_change_cents bigint, closed boolean)
language sql stable security definer set search_path = '' as $$
  with ok as (select public.has_permission(target, 'accounting.view') or (select auth.uid()) is null as yes),
  m as (select (date_trunc('month', first_month) + make_interval(months => g))::date as m from generate_series(0, least(greatest(months, 1), 60) - 1) g),
  cls as (select a.id, a.type, public.fs_class(a.id) as class from public.ledger_accounts a where a.company_id = target),
  mv as (select date_trunc('month', e.entry_date)::date as m, c.type, c.class, sum(l.debit_cents - l.credit_cents) as dr
         from public.journal_lines l join public.journal_entries e on e.id = l.entry_id join cls c on c.id = l.account_id
         where e.company_id = target and e.entry_date >= (select min(m) from m) and e.entry_date < (select max(m) from m) + interval '1 month'
         group by 1, 2, 3)
  select m.m,
         coalesce(sum(-mv.dr) filter (where mv.type = 'revenue'), 0)::bigint,
         coalesce(sum(mv.dr) filter (where mv.class = 'cost_of_sales'), 0)::bigint,
         coalesce(sum(mv.dr) filter (where mv.type = 'expense' and mv.class not in ('cost_of_sales', 'income_tax')), 0)::bigint,
         coalesce(sum(mv.dr) filter (where mv.class = 'income_tax'), 0)::bigint,
         coalesce(sum(-mv.dr) filter (where mv.type in ('revenue', 'expense')), 0)::bigint,
         coalesce(sum(mv.dr) filter (where mv.class = 'cash'), 0)::bigint,
         exists (select 1 from public.accounting_periods p where p.company_id = target and p.period_month = m.m and p.status = 'closed')
  from m left join mv on mv.m = m.m
  where (select yes from ok)
  group by m.m order by m.m
$$;

-- ------------------------------------------------------------- budgets
create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  fiscal_year integer not null check (fiscal_year between 2000 and 2100),
  period_type text not null check (period_type in ('monthly', 'annual')),
  scenario text not null default 'base' check (scenario in ('base', 'conservative', 'optimistic')),
  department_id uuid,
  root_id uuid not null,
  version integer not null default 1 check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'approved', 'published', 'archived')),
  notes text check (notes is null or char_length(notes) <= 2000),
  expense_warn_pct integer not null default 80 check (expense_warn_pct between 1 and 500),
  expense_crit_pct integer not null default 100 check (expense_crit_pct between 1 and 500),
  revenue_warn_pct integer not null default 90 check (revenue_warn_pct between 1 and 500),
  revenue_crit_pct integer not null default 75 check (revenue_crit_pct between 1 and 500),
  created_by uuid, created_at timestamptz not null default now(),
  approved_by uuid, approved_at timestamptz, approval_note text,
  published_by uuid, published_at timestamptz,
  archived_by uuid, archived_at timestamptz, archive_reason text,
  unique (company_id, id),
  unique (root_id, version),
  check (expense_warn_pct <= expense_crit_pct and revenue_crit_pct <= revenue_warn_pct)
);
create unique index if not exists budgets_published_uidx on public.budgets (company_id, fiscal_year, scenario, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'published';
create unique index if not exists budgets_one_draft_uidx on public.budgets (root_id) where status = 'draft';

create table if not exists public.budget_lines (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  budget_id uuid not null,
  account_id uuid,
  category_id uuid,
  month smallint check (month is null or month between 1 and 12),
  amount_cents bigint not null check (amount_cents >= 0 and amount_cents < 1000000000000000),
  note text check (note is null or char_length(note) <= 500),
  check ((account_id is null) <> (category_id is null)),
  foreign key (company_id, budget_id) references public.budgets (company_id, id) on delete cascade
);
create unique index if not exists budget_lines_uidx on public.budget_lines (budget_id, coalesce(account_id, category_id), coalesce(month, 0));

create table if not exists public.fs_assumptions (
  company_id uuid primary key references public.companies(id) on delete cascade,
  growth_pct numeric(6,2) not null default 0 check (growth_pct between -100 and 1000),
  collection_pct numeric(5,2) not null default 90 check (collection_pct between 0 and 100),
  conservative_pct numeric(5,2) not null default 15 check (conservative_pct between 0 and 100),
  optimistic_pct numeric(5,2) not null default 10 check (optimistic_pct between 0 and 100),
  horizon_months integer not null default 6 check (horizon_months between 1 and 24),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.budget_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  budget_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists budget_events_budget_idx on public.budget_events (budget_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['budgets', 'budget_lines', 'fs_assumptions', 'budget_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
    execute format('create policy ba_%s_select on public.%I for select to authenticated using (public.has_permission(company_id, ''accounting.view''))', t, t);
    execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    execute format('create trigger ba_company_immutable before update on public.%I for each row execute function public.forbid_company_change()', t);
  end loop;
end $$;
drop trigger if exists ba_budget_append_only on public.budget_events;
create trigger ba_budget_append_only before update or delete on public.budget_events for each row execute function public.ledger_append_only();

-- Approved / published / archived budgets never change (status moves only
-- through the functions; nothing else, not even by maintenance); budgets
-- are never deleted (company cascade aside).
create or replace function public.budget_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  st text;
  r jsonb := to_jsonb(coalesce(new, old));
begin
  if tg_table_name = 'budgets' then
    if tg_op = 'DELETE' then
      if public.payables_company_gone(old.company_id) then return old; end if;
      raise exception 'BUDGET_IMMUTABLE' using errcode = 'P0001';
    end if;
    if old.status <> 'draft' and (to_jsonb(new) - array['status', 'approved_by', 'approved_at', 'approval_note', 'published_by', 'published_at', 'archived_by', 'archived_at', 'archive_reason'])
                                   <> (to_jsonb(old) - array['status', 'approved_by', 'approved_at', 'approval_note', 'published_by', 'published_at', 'archived_by', 'archived_at', 'archive_reason']) then
      raise exception 'BUDGET_LOCKED' using errcode = 'P0001', hint = old.status;
    end if;
    if old.status = 'archived' then raise exception 'BUDGET_LOCKED' using errcode = 'P0001', hint = 'archived'; end if;
    if new.root_id <> old.root_id or new.version <> old.version or new.created_at <> old.created_at then
      raise exception 'BUDGET_LOCKED' using errcode = 'P0001';
    end if;
    return new;
  end if;
  -- budget_lines: only while the budget is a draft
  select b.status into st from public.budgets b where b.id = (r ->> 'budget_id')::uuid;
  if tg_op = 'DELETE' and (st is null or public.payables_company_gone(old.company_id)) then return old; end if;
  if st is distinct from 'draft' then
    raise exception 'BUDGET_LOCKED' using errcode = 'P0001', hint = coalesce(st, 'missing');
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists ba_budget_guard on public.budgets;
create trigger ba_budget_guard before update or delete on public.budgets for each row execute function public.budget_guard();
drop trigger if exists ba_budget_guard on public.budget_lines;
create trigger ba_budget_guard before insert or update or delete on public.budget_lines for each row execute function public.budget_guard();

create or replace function public.budget_log(target uuid, budget uuid, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.budget_events (company_id, budget_id, action, details, actor) values (target, budget, act, coalesce(info, '{}'::jsonb), (select auth.uid()))
$$;

create or replace function public.budget_for(budget uuid, perm text)
returns public.budgets language plpgsql security definer set search_path = '' as $$
declare b public.budgets;
begin
  select * into b from public.budgets where id = budget;
  if b.id is null or ((select auth.uid()) is not null and not public.has_permission(b.company_id, perm)) then
    raise exception 'BUDGET_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_budget:' || b.company_id::text, 0));
  select * into b from public.budgets where id = budget;          -- under the lock
  return b;
end $$;

create or replace function public.budget_create(target uuid, budget_name text, year integer, period text, scen text default 'base', department uuid default null, note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare bid uuid := gen_random_uuid();
begin
  if not public.has_permission(target, 'budgets.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if department is not null and not exists (select 1 from public.departments d where d.id = department and d.company_id = target) then
    raise exception 'DEPARTMENT_INVALID' using errcode = 'P0001';
  end if;
  insert into public.budgets (id, company_id, name, fiscal_year, period_type, scenario, department_id, root_id, notes, created_by)
  values (bid, target, btrim(budget_name), year, period, coalesce(scen, 'base'), department, bid, nullif(btrim(coalesce(note, '')), ''), (select auth.uid()));
  perform public.budget_log(target, bid, 'created', jsonb_build_object('name', budget_name, 'year', year, 'period', period, 'scenario', scen));
  return bid;
end $$;

create or replace function public.budget_update(budget uuid, budget_name text, note text, exp_warn integer, exp_crit integer, rev_warn integer, rev_crit integer)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.budgets := public.budget_for(budget, 'budgets.manage');
begin
  if b.status <> 'draft' then raise exception 'BUDGET_LOCKED' using errcode = 'P0001', hint = b.status; end if;
  update public.budgets set name = coalesce(nullif(btrim(budget_name), ''), name), notes = nullif(btrim(coalesce(note, '')), ''),
         expense_warn_pct = coalesce(exp_warn, expense_warn_pct), expense_crit_pct = coalesce(exp_crit, expense_crit_pct),
         revenue_warn_pct = coalesce(rev_warn, revenue_warn_pct), revenue_crit_pct = coalesce(rev_crit, revenue_crit_pct)
   where id = b.id;
  perform public.budget_log(b.company_id, b.id, 'updated', jsonb_build_object('name', budget_name));
end $$;

-- One line (account or expense category, month or the whole year).
-- amount null deletes the line. Draft only.
create or replace function public.budget_set_line(budget uuid, account uuid, category uuid, line_month integer, amount_cents bigint, note text default null)
returns void language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  b public.budgets := public.budget_for(budget, 'budgets.manage');
  a public.ledger_accounts;
begin
  if b.status <> 'draft' then raise exception 'BUDGET_LOCKED' using errcode = 'P0001', hint = b.status; end if;
  if (account is null) = (category is null) then raise exception 'BUDGET_LINE_INVALID' using errcode = 'P0001'; end if;
  if account is not null then
    select * into a from public.ledger_accounts where id = account;
    if a.id is null or a.company_id <> b.company_id or a.type not in ('revenue', 'expense') then raise exception 'BUDGET_LINE_INVALID' using errcode = 'P0001', hint = 'account'; end if;
  elsif not exists (select 1 from public.expense_categories c where c.id = category and c.company_id = b.company_id) then
    raise exception 'BUDGET_LINE_INVALID' using errcode = 'P0001', hint = 'category';
  end if;
  if (b.period_type = 'monthly' and (line_month is null or line_month not between 1 and 12)) or (b.period_type = 'annual' and line_month is not null) then
    raise exception 'BUDGET_LINE_INVALID' using errcode = 'P0001', hint = 'month';
  end if;
  delete from public.budget_lines l where l.budget_id = b.id and coalesce(l.account_id, l.category_id) = coalesce(account, category) and coalesce(l.month, 0) = coalesce(line_month, 0);
  if amount_cents is not null then
    if amount_cents < 0 then raise exception 'AMOUNT_INVALID' using errcode = 'P0001'; end if;
    insert into public.budget_lines (company_id, budget_id, account_id, category_id, month, amount_cents, note)
    values (b.company_id, b.id, account, category, line_month, amount_cents, nullif(btrim(coalesce(note, '')), ''));
  end if;
end $$;

-- Every month of one line in a single transaction (monthly: 12 amounts,
-- annual: 1). Either all months change or none (no half-saved line if the
-- budget is approved meanwhile: the budget lock is taken first).
create or replace function public.budget_set_lines(budget uuid, account uuid, category uuid, amounts bigint[], note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.budgets := public.budget_for(budget, 'budgets.manage');
begin
  if b.status <> 'draft' then raise exception 'BUDGET_LOCKED' using errcode = 'P0001', hint = b.status; end if;
  if amounts is null or array_ndims(amounts) <> 1 or array_length(amounts, 1) <> (case when b.period_type = 'monthly' then 12 else 1 end) then
    raise exception 'BUDGET_LINE_INVALID' using errcode = 'P0001', hint = 'months';
  end if;
  if b.period_type = 'monthly' then
    for m in 1..12 loop perform public.budget_set_line(b.id, account, category, m, amounts[m], note); end loop;
  else
    perform public.budget_set_line(b.id, account, category, null, amounts[1], note);
  end if;
end $$;

-- Draft prefill from the actuals of a year (revenue and expense accounts),
-- adjusted by a growth percentage. Replaces the account lines.
create or replace function public.budget_fill_from_actuals(budget uuid, source_year integer, growth_pct numeric default 0)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  b public.budgets := public.budget_for(budget, 'budgets.manage');
  n integer;
begin
  if b.status <> 'draft' then raise exception 'BUDGET_LOCKED' using errcode = 'P0001', hint = b.status; end if;
  if growth_pct is null or growth_pct < -100 or growth_pct > 1000 then raise exception 'AMOUNT_INVALID' using errcode = 'P0001'; end if;
  delete from public.budget_lines where budget_id = b.id and account_id is not null;
  insert into public.budget_lines (company_id, budget_id, account_id, month, amount_cents, note)
  select b.company_id, b.id, x.account_id, x.m, round(x.amt * (1 + growth_pct / 100))::bigint,
         format('Real %s %s%%', source_year, growth_pct)
  from (select l.account_id, case when b.period_type = 'monthly' then extract(month from e.entry_date)::smallint end as m,
               sum(case when a.type = 'revenue' then l.credit_cents - l.debit_cents else l.debit_cents - l.credit_cents end) as amt
        from public.journal_lines l join public.journal_entries e on e.id = l.entry_id join public.ledger_accounts a on a.id = l.account_id
        where e.company_id = b.company_id and a.type in ('revenue', 'expense') and extract(year from e.entry_date) = source_year
        group by 1, 2) x
  where x.amt > 0;
  get diagnostics n = row_count;
  perform public.budget_log(b.company_id, b.id, 'filled_from_actuals', jsonb_build_object('year', source_year, 'growth_pct', growth_pct, 'lines', n));
  return n;
end $$;

create or replace function public.budget_approve(budget uuid, note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.budgets := public.budget_for(budget, 'budgets.approve');
begin
  if b.status <> 'draft' then raise exception 'BUDGET_TRANSITION' using errcode = 'P0001', hint = b.status || '->approved'; end if;
  if not exists (select 1 from public.budget_lines l where l.budget_id = b.id) then raise exception 'BUDGET_EMPTY' using errcode = 'P0001'; end if;
  update public.budgets set status = 'approved', approved_by = (select auth.uid()), approved_at = now(), approval_note = nullif(btrim(coalesce(note, '')), '') where id = b.id;
  perform public.budget_log(b.company_id, b.id, 'approved', jsonb_build_object('note', note));
end $$;

-- Publishing replaces (archives) the published budget of the same year,
-- scenario and department: one published budget per key.
create or replace function public.budget_publish(budget uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b public.budgets := public.budget_for(budget, 'budgets.approve');
  old_id uuid;
begin
  if b.status = 'published' then return; end if;                        -- idempotent
  if b.status <> 'approved' then raise exception 'BUDGET_TRANSITION' using errcode = 'P0001', hint = b.status || '->published'; end if;
  update public.budgets x set status = 'archived', archived_at = now(), archived_by = (select auth.uid()), archive_reason = 'Reemplazado / Replaced'
   where x.company_id = b.company_id and x.fiscal_year = b.fiscal_year and x.scenario = b.scenario and x.department_id is not distinct from b.department_id
     and x.status = 'published' and x.id <> b.id
  returning x.id into old_id;
  update public.budgets set status = 'published', published_by = (select auth.uid()), published_at = now() where id = b.id;
  perform public.budget_log(b.company_id, b.id, 'published', jsonb_build_object('replaced', old_id));
  if old_id is not null then perform public.budget_log(b.company_id, old_id, 'archived', jsonb_build_object('replaced_by', b.id)); end if;
end $$;

create or replace function public.budget_archive(budget uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b public.budgets := public.budget_for(budget, 'budgets.manage');
  why text := btrim(coalesce(reason, ''));
begin
  if b.status = 'archived' then return; end if;
  if b.status = 'published' and (select auth.uid()) is not null and not public.has_permission(b.company_id, 'budgets.approve') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  update public.budgets set status = 'archived', archived_at = now(), archived_by = (select auth.uid()), archive_reason = why where id = b.id;
  perform public.budget_log(b.company_id, b.id, 'archived', jsonb_build_object('reason', why));
end $$;

-- A new version: a draft copy of any non-draft version (one draft per budget).
create or replace function public.budget_new_version(budget uuid, note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  b public.budgets := public.budget_for(budget, 'budgets.manage');
  nid uuid := gen_random_uuid();
  v integer;
begin
  if b.status = 'draft' then raise exception 'BUDGET_TRANSITION' using errcode = 'P0001', hint = 'draft->version'; end if;
  if exists (select 1 from public.budgets x where x.root_id = b.root_id and x.status = 'draft') then
    raise exception 'BUDGET_DRAFT_EXISTS' using errcode = 'P0001';
  end if;
  select max(x.version) + 1 into v from public.budgets x where x.root_id = b.root_id;
  insert into public.budgets (id, company_id, name, fiscal_year, period_type, scenario, department_id, root_id, version, notes,
                              expense_warn_pct, expense_crit_pct, revenue_warn_pct, revenue_crit_pct, created_by)
  values (nid, b.company_id, b.name, b.fiscal_year, b.period_type, b.scenario, b.department_id, b.root_id, v, coalesce(nullif(btrim(coalesce(note, '')), ''), b.notes),
          b.expense_warn_pct, b.expense_crit_pct, b.revenue_warn_pct, b.revenue_crit_pct, (select auth.uid()));
  insert into public.budget_lines (company_id, budget_id, account_id, category_id, month, amount_cents, note)
  select l.company_id, nid, l.account_id, l.category_id, l.month, l.amount_cents, l.note from public.budget_lines l where l.budget_id = b.id;
  perform public.budget_log(b.company_id, nid, 'version_created', jsonb_build_object('from', b.id, 'version', v, 'note', note));
  return nid;
end $$;

-- Budget vs actual up to a date. Lines grouped by account / category.
-- budget_ytd: months before as_of in full + the current month pro rata
-- (annual budgets: pro rata of the year). projection: run-rate to the end
-- of the fiscal year (null before the year starts). Percentages null when
-- the base is zero. favorable: revenue at or above, expense at or below.
create or replace function public.budget_vs_actual(budget uuid, as_of date)
returns table (kind text, account_id uuid, category_id uuid, label text, label_en text, line_type text, budget_total_cents bigint, budget_ytd_cents bigint,
               actual_cents bigint, variance_cents bigint, variance_pct numeric, consumed_pct numeric, projection_cents bigint, favorable boolean,
               alert text, in_total boolean, actual_available boolean)
language sql stable security definer set search_path = '' as $$
  with b as (select x.* from public.budgets x where x.id = budget and (public.has_permission(x.company_id, 'accounting.view') or (select auth.uid()) is null)),
  p as (select make_date(b.fiscal_year, 1, 1) as y0, make_date(b.fiscal_year, 12, 31) as y1,
               least(greatest(as_of, make_date(b.fiscal_year, 1, 1) - 1), make_date(b.fiscal_year, 12, 31)) as cut from b),
  -- elapsed share of the year and of the cut month
  t as (select p.*, (p.cut - p.y0 + 1)::numeric as days_elapsed, (p.y1 - p.y0 + 1)::numeric as days_year,
               extract(month from p.cut)::int as cut_month, extract(day from p.cut)::numeric as cut_day,
               extract(day from (date_trunc('month', p.cut) + interval '1 month - 1 day'))::numeric as month_days from p),
  lines as (
    select coalesce(l.account_id::text, 'c:' || l.category_id::text) as k, l.account_id, l.category_id,
           sum(l.amount_cents)::bigint as total,
           round(sum(case when t.days_elapsed <= 0 then 0
                          when b.period_type = 'annual' then l.amount_cents * t.days_elapsed / t.days_year
                          when l.month < t.cut_month then l.amount_cents
                          when l.month = t.cut_month then l.amount_cents * t.cut_day / t.month_days else 0 end))::bigint as ytd
    from public.budget_lines l, b, t where l.budget_id = b.id
    group by 1, 2, 3),
  info as (
    select la.*, case when la.account_id is not null then 'account' else 'category' end as kind,
           coalesce(a.name, c.name) as label, coalesce(a.name_en, c.name_en) as label_en,
           coalesce(a.type, 'expense') as line_type,
           coalesce(c.account_id, a.id) as ledger_account
    from lines la left join public.ledger_accounts a on a.id = la.account_id left join public.expense_categories c on c.id = la.category_id),
  act as (
    select i.k,
           case when i.kind = 'account' then
             (select coalesce(sum(case when i.line_type = 'revenue' then l.credit_cents - l.debit_cents else l.debit_cents - l.credit_cents end), 0)
              from public.journal_lines l join public.journal_entries e on e.id = l.entry_id, t
              where l.account_id = i.account_id and e.entry_date between t.y0 and t.cut)
           else
             (select coalesce(sum(bl.amount_cents), 0) from public.bill_lines bl join public.bills bb on bb.id = bl.bill_id, t
              where bl.category_id = i.category_id and bb.status in ('approved', 'scheduled', 'partially_paid', 'paid') and bb.bill_date between t.y0 and t.cut)
           end::bigint as actual
    from info i)
  select i.kind, i.account_id, i.category_id, i.label, i.label_en, i.line_type, i.total, i.ytd, a.actual, a.actual - i.ytd,
         case when i.ytd = 0 then null else round((a.actual - i.ytd)::numeric * 100 / i.ytd, 1) end,
         case when i.total = 0 then null else round(a.actual::numeric * 100 / i.total, 1) end,
         case when t.days_elapsed <= 0 then null else round(a.actual * t.days_year / t.days_elapsed)::bigint end,
         case when i.line_type = 'revenue' then a.actual >= i.ytd else a.actual <= i.ytd end,
         case when i.line_type = 'revenue' then
                case when i.ytd = 0 then 'ok' when a.actual::numeric * 100 / i.ytd < b.revenue_crit_pct then 'critical'
                     when a.actual::numeric * 100 / i.ytd < b.revenue_warn_pct then 'warning' else 'ok' end
              else
                case when i.total = 0 then (case when a.actual > 0 then 'critical' else 'ok' end)
                     when a.actual::numeric * 100 / i.total >= b.expense_crit_pct then 'critical'
                     when a.actual::numeric * 100 / i.total >= b.expense_warn_pct then 'warning' else 'ok' end end,
         i.kind = 'account' or not exists (select 1 from info j where j.kind = 'account' and j.account_id = i.ledger_account),
         (select department_id is null from b)
  from info i join act a on a.k = i.k, b, t
  order by i.line_type desc, i.label
$$;

-- ------------------------------------------------------------- assumptions
create or replace function public.fs_save_assumptions(target uuid, growth numeric, collection numeric, conservative numeric, optimistic numeric, horizon integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_permission(target, 'budgets.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  insert into public.fs_assumptions as a (company_id, growth_pct, collection_pct, conservative_pct, optimistic_pct, horizon_months, updated_by)
  values (target, growth, collection, conservative, optimistic, horizon, (select auth.uid()))
  on conflict (company_id) do update set growth_pct = excluded.growth_pct, collection_pct = excluded.collection_pct, conservative_pct = excluded.conservative_pct,
    optimistic_pct = excluded.optimistic_pct, horizon_months = excluded.horizon_months, updated_at = now(), updated_by = excluded.updated_by;
  perform public.budget_log(target, null, 'assumptions_updated', jsonb_build_object('growth', growth, 'collection', collection, 'conservative', conservative, 'optimistic', optimistic, 'horizon', horizon));
end $$;

-- ------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['budget_guard()', 'budget_log(uuid, uuid, text, jsonb)', 'budget_for(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['fs_class(uuid)', 'fs_account_balances(uuid, date, date)', 'fs_income_statement(uuid, date, date)', 'fs_balance_sheet(uuid, date)',
    'fs_cash_flow(uuid, date, date)', 'fs_data_quality(uuid, date, date)', 'fs_monthly(uuid, date, integer)',
    'budget_create(uuid, text, integer, text, text, uuid, text)', 'budget_update(uuid, text, text, integer, integer, integer, integer)',
    'budget_set_line(uuid, uuid, uuid, integer, bigint, text)', 'budget_set_lines(uuid, uuid, uuid, bigint[], text)', 'budget_fill_from_actuals(uuid, integer, numeric)', 'budget_approve(uuid, text)',
    'budget_publish(uuid)', 'budget_archive(uuid, text)', 'budget_new_version(uuid, text)', 'budget_vs_actual(uuid, date)',
    'fs_save_assumptions(uuid, numeric, numeric, numeric, numeric, integer)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.budget_guard() to authenticated;

do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in ('ba_budget_guard', 'ba_budget_append_only')) <> 3 then
    raise exception 'BA0027 self-check failed: triggers missing';
  end if;
  if has_table_privilege('authenticated', 'public.budgets', 'INSERT') or has_table_privilege('authenticated', 'public.budget_lines', 'INSERT')
     or has_table_privilege('authenticated', 'public.budgets', 'UPDATE') or has_table_privilege('anon', 'public.budgets', 'SELECT') then
    raise exception 'BA0027 self-check failed: privileges';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key like 'budgets.%')
     or exists (select 1 from public.role_permissions where role = 'admin' and permission_key = 'budgets.approve') then
    raise exception 'BA0027 self-check failed: role matrix';
  end if;
end $$;

commit;
