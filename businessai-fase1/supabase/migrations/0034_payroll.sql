-- =====================================================================
-- BusinessAI · Migration 0034 · Payroll engine
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0017, 0020–0023 and 0033.
--
-- Payroll connected to Workforce (hours) and Finance (ledger). No parallel
-- source of hours, people or accounting:
--   * hours: the app computes regular / overtime with the Workforce rules and
--     this database VERIFIES that they add up to the minutes of the closed
--     sessions of the time clock (wf_worked_minutes); open sessions block;
--   * people: public.employees; pay: an append-only compensation history with
--     effective dates (private: payroll.view only, and the employee itself);
--   * money: integer cents; every component rounded half away from zero once;
--   * ledger: approve posts Dr payroll expense / Cr wages payable / Cr
--     deductions payable; paying posts Dr wages payable / Cr bank; reversal
--     mirrors them. Through public.ledger_post (balanced, numbered, period
--     locks, one entry per event). Nothing moves money: "paid" only records it.
--   * taxes: an architecture only. Tax rules are seeded as DISABLED
--     placeholders without rates; the engine computes no tax (tax_status
--     'not_calculated') and refuses to run if a rule were ever enabled before a
--     verified implementation exists.
-- Lifecycle: draft (prepare / preview / adjust) → approved (locked, posted)
-- → paid → reversed. Corrections: a correction run, or reversal + new run.
-- Rollback: supabase/rollback/0034_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$ begin
  if to_regclass('public.journal_entries') is null or to_regclass('public.shift_patterns') is null
     or to_regclass('public.billing_plan_features') is null then
    raise exception 'BA0034: migrations 0017, 0020–0023 and 0033 must be applied first';
  end if;
end $$;

-- ===================================================================== permissions
insert into public.permissions (key, module, description_es, description_en) values
  ('payroll.view', 'payroll', 'Ver nóminas, compensaciones y recibos', 'View payroll, compensation and pay stubs'),
  ('payroll.manage', 'payroll', 'Preparar nóminas y gestionar compensaciones y deducciones', 'Prepare payroll and manage compensation and deductions'),
  ('payroll.approve', 'payroll', 'Aprobar, registrar el pago y revertir nóminas', 'Approve, record payment of and reverse payroll')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'payroll.view'), ('admin', 'payroll.view'),
  ('owner', 'payroll.manage'), ('admin', 'payroll.manage'),
  ('owner', 'payroll.approve')
on conflict do nothing;

-- ===================================================================== ledger sources
alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void', 'payment_void',
                    'bank_adjustment', 'bank_reconciliation', 'payroll', 'payroll_void', 'payroll_payment', 'payroll_payment_void'));

-- ===================================================================== settings
create table if not exists public.payroll_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  expense_account_id uuid not null,
  wages_payable_account_id uuid not null,
  deductions_payable_account_id uuid not null,
  payment_account_id uuid not null,
  paid_leave_types text[] not null default '{}'
    check (paid_leave_types <@ array['vacation', 'sick', 'personal', 'unpaid', 'day_off', 'other', 'bereavement', 'jury_duty', 'parental', 'military']::text[]),
  require_second_approver boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (company_id, expense_account_id) references public.ledger_accounts (company_id, id),
  foreign key (company_id, wages_payable_account_id) references public.ledger_accounts (company_id, id),
  foreign key (company_id, deductions_payable_account_id) references public.ledger_accounts (company_id, id),
  foreign key (company_id, payment_account_id) references public.ledger_accounts (company_id, id)
);

-- ===================================================================== compensation (private, append-only)
create table if not exists public.employee_compensation (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  effective_from date not null,
  pay_type text not null check (pay_type in ('hourly', 'salary')),
  pay_frequency text not null check (pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  hourly_rate_cents bigint check (hourly_rate_cents is null or hourly_rate_cents between 1 and 100000000),
  annual_salary_cents bigint check (annual_salary_cents is null or annual_salary_cents between 1 and 100000000000),
  -- a salaried NON-exempt employee's overtime needs an explicit hourly rate (never derived by the system)
  overtime_hourly_rate_cents bigint check (overtime_hourly_rate_cents is null or overtime_hourly_rate_cents between 1 and 100000000),
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((pay_type = 'hourly' and hourly_rate_cents is not null and annual_salary_cents is null)
      or (pay_type = 'salary' and annual_salary_cents is not null and hourly_rate_cents is null))
);
create index if not exists employee_compensation_emp_idx on public.employee_compensation (employee_id, effective_from desc, created_at desc);

-- ===================================================================== earnings / deductions catalog
create table if not exists public.payroll_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_]{2,24}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('earning', 'deduction')),
  calc text not null check (calc in ('fixed', 'percent')),
  default_amount_cents bigint check (default_amount_cents is null or default_amount_cents between 0 and 100000000000),
  default_rate_bp integer check (default_rate_bp is null or default_rate_bp between 1 and 10000),
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, code),
  unique (company_id, id),
  check (kind = 'deduction' or calc = 'fixed')          -- percentages only for deductions (of gross)
);

create table if not exists public.employee_payroll_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  item_id uuid not null,
  amount_cents bigint check (amount_cents is null or amount_cents between 1 and 100000000000),
  rate_bp integer check (rate_bp is null or rate_bp between 1 and 10000),
  starts_on date not null,
  ends_on date,
  created_by uuid,
  created_at timestamptz not null default now(),
  ended_by uuid,
  check ((amount_cents is null) <> (rate_bp is null)),
  check (ends_on is null or ends_on >= starts_on),
  foreign key (company_id, item_id) references public.payroll_items (company_id, id)
);
create index if not exists employee_payroll_items_emp_idx on public.employee_payroll_items (employee_id, starts_on);

-- ===================================================================== taxes: architecture only (disabled)
create table if not exists public.payroll_tax_rules (
  id uuid primary key default gen_random_uuid(),
  jurisdiction text not null check (jurisdiction in ('PR', 'US-FED')),
  code text not null check (code ~ '^[A-Z0-9_]{2,40}$'),
  name_es text not null,
  name_en text not null,
  status text not null default 'disabled' check (status in ('disabled', 'approved')),
  -- nothing below is filled: no rate, base or limit is assumed by BusinessAI
  rate_bp integer check (rate_bp is null or rate_bp between 0 and 10000),
  wage_base_cents bigint,
  effective_from date,
  source_reference text,
  approved_by uuid,
  approved_at timestamptz,
  note_es text not null,
  note_en text not null,
  unique (jurisdiction, code),
  check (status = 'disabled' or (rate_bp is not null and effective_from is not null and source_reference is not null and approved_by is not null and approved_at is not null))
);
insert into public.payroll_tax_rules (jurisdiction, code, name_es, name_en, note_es, note_en) values
  ('PR', 'PR_INCOME_TAX_WITHHOLDING', 'Retención de contribución sobre ingresos (Puerto Rico)', 'Income tax withholding (Puerto Rico)',
   'Desactivada. Requiere reglas verificadas y aprobadas; BusinessAI no supone tasas ni tablas.', 'Disabled. Requires verified and approved rules; BusinessAI assumes no rates or tables.'),
  ('PR', 'PR_OTHER_EMPLOYEE_CONTRIBUTIONS', 'Otras aportaciones del empleado (Puerto Rico)', 'Other employee contributions (Puerto Rico)',
   'Desactivada. Por verificar con un asesor (programas, tasas y topes vigentes).', 'Disabled. To be verified with an advisor (current programs, rates and caps).'),
  ('US-FED', 'US_FED_INCOME_TAX_WITHHOLDING', 'Retención federal de impuesto sobre ingresos', 'Federal income tax withholding',
   'Desactivada. Requiere reglas verificadas y aprobadas.', 'Disabled. Requires verified and approved rules.'),
  ('US-FED', 'US_FED_PAYROLL_TAXES', 'Impuestos federales sobre nómina (empleado y patrono)', 'Federal payroll taxes (employee and employer)',
   'Desactivada. Por verificar (tasas y bases salariales vigentes).', 'Disabled. To be verified (current rates and wage bases).')
on conflict (jurisdiction, code) do nothing;

-- ===================================================================== runs and lines
create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  run_type text not null default 'regular' check (run_type in ('regular', 'correction')),
  corrects_run_id uuid references public.payroll_runs(id) on delete restrict,
  pay_frequency text not null check (pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid', 'reversed', 'discarded')),
  version integer not null default 0,
  prepared_version integer,          -- the version the lines were computed at (adjustments make it stale)
  gross_cents bigint not null default 0,
  deductions_cents bigint not null default 0,
  taxes_cents bigint not null default 0,
  net_cents bigint not null default 0,
  employees integer not null default 0,
  blocking_issues integer not null default 0,
  tax_status text not null default 'not_calculated' check (tax_status in ('not_calculated')),
  rules_snapshot jsonb,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  created_by uuid,
  created_at timestamptz not null default now(),
  prepared_by uuid, prepared_at timestamptz,
  approved_by uuid, approved_at timestamptz, self_approved boolean,
  paid_by uuid, paid_at timestamptz, payment_date date, payment_reference text check (payment_reference is null or char_length(payment_reference) <= 100),
  reversed_by uuid, reversed_at timestamptz, reverse_reason text check (reverse_reason is null or char_length(reverse_reason) between 3 and 300),
  expense_entry_id uuid, payment_entry_id uuid,
  check (period_end >= period_start and period_end - period_start <= 31),
  check (pay_date >= period_start),
  check ((run_type = 'correction') = (corrects_run_id is not null)),
  unique (company_id, idempotency_key)
);
-- one live regular run per company, frequency and period (a reversed or discarded one can be redone)
create unique index if not exists payroll_runs_period_uidx on public.payroll_runs (company_id, pay_frequency, period_start, period_end)
  where run_type = 'regular' and status not in ('reversed', 'discarded');
create index if not exists payroll_runs_company_idx on public.payroll_runs (company_id, period_start desc);

create table if not exists public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  item_id uuid not null,
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  note text check (note is null or char_length(note) <= 200),
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (company_id, item_id) references public.payroll_items (company_id, id)
);

create table if not exists public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  employee_name text not null,
  employee_number text,
  compensation_id uuid references public.employee_compensation(id) on delete restrict,
  pay_type text,
  hourly_rate_cents bigint,
  annual_salary_cents bigint,
  overtime_multiplier numeric(4,2),
  regular_minutes integer not null default 0,
  overtime_minutes integer not null default 0,
  worked_minutes_verified integer,
  leave_paid_minutes integer not null default 0,
  regular_pay_cents bigint not null default 0,
  overtime_pay_cents bigint not null default 0,
  leave_pay_cents bigint not null default 0,
  salary_pay_cents bigint not null default 0,
  other_earnings_cents bigint not null default 0,
  gross_cents bigint not null default 0,
  deductions_cents bigint not null default 0,
  taxes_cents bigint not null default 0,
  net_cents bigint not null default 0,
  issues text[] not null default '{}',
  blocking boolean not null default false,
  created_at timestamptz not null default now(),
  unique (run_id, employee_id),
  check (gross_cents = regular_pay_cents + overtime_pay_cents + leave_pay_cents + salary_pay_cents + other_earnings_cents),
  check (net_cents = gross_cents - deductions_cents - taxes_cents)
);
create index if not exists payroll_lines_emp_idx on public.payroll_lines (employee_id, created_at desc);

create table if not exists public.payroll_line_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  line_id uuid not null references public.payroll_lines(id) on delete cascade,
  item_id uuid,
  kind text not null check (kind in ('earning', 'deduction')),
  label text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  source text not null check (source in ('recurring', 'adjustment'))
);
create index if not exists payroll_line_items_line_idx on public.payroll_line_items (line_id);

create table if not exists public.payroll_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  run_id uuid,
  employee_id uuid,
  action text not null,
  details jsonb not null default '{}',
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists payroll_events_company_idx on public.payroll_events (company_id, created_at desc);

-- ===================================================================== helpers
create or replace function public.payroll_log(target uuid, run uuid, emp uuid, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.payroll_events (company_id, run_id, employee_id, action, details, actor)
  values (target, run, emp, act, coalesce(info, '{}'), (select auth.uid()))
$$;

create or replace function public.payroll_can(target uuid, perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_permission(target, perm) and coalesce((select f.available from public.wf_feature(target, 'payroll') f), false)
$$;

-- Half away from zero to whole cents (every money component is rounded once, here).
create or replace function public.payroll_round(x numeric)
returns bigint language sql immutable set search_path = '' as $$
  select (case when x >= 0 then floor(x + 0.5) else -floor(-x + 0.5) end)::bigint
$$;

create or replace function public.payroll_periods_per_year(freq text)
returns integer language sql immutable set search_path = '' as $$
  select case freq when 'weekly' then 52 when 'biweekly' then 26 when 'semimonthly' then 24 when 'monthly' then 12 end
$$;

-- Expected period shape for each frequency.
create or replace function public.payroll_period_ok(freq text, p_start date, p_end date)
returns boolean language sql immutable set search_path = '' as $$
  select case freq
    when 'weekly' then p_end = p_start + 6
    when 'biweekly' then p_end = p_start + 13
    when 'semimonthly' then (extract(day from p_start) = 1 and extract(day from p_end) = 15 and date_trunc('month', p_end) = date_trunc('month', p_start))
                         or (extract(day from p_start) = 16 and p_end = (date_trunc('month', p_start) + interval '1 month - 1 day')::date)
    when 'monthly' then extract(day from p_start) = 1 and p_end = (date_trunc('month', p_start) + interval '1 month - 1 day')::date
    else false end
$$;

-- Settings with the ledger accounts: payroll expense (6100), wages payable
-- (2200), payroll deductions payable (2210), payment account (1010 bank).
create or replace function public.payroll_ensure_settings(target uuid)
returns public.payroll_settings language plpgsql security definer set search_path = '' as $$
declare
  s public.payroll_settings;
  exp_id uuid; wages uuid; ded uuid; pay uuid;
begin
  select * into s from public.payroll_settings where company_id = target;
  if found then return s; end if;
  perform public.ledger_ensure_chart(target);
  perform public.ledger_lock(target);
  select id into exp_id from public.ledger_accounts where company_id = target and code = '6100' and type = 'expense';
  if exp_id is null then
    insert into public.ledger_accounts (company_id, code, name, name_en, type, description)
    values (target, '6110', 'Sueldos y salarios', 'Wages and salaries', 'expense', 'Nómina aprobada (0034).') on conflict (company_id, code) do nothing
    returning id into exp_id;
    if exp_id is null then raise exception 'PAYROLL_ACCOUNTS_MISSING' using errcode = 'P0001', hint = '6100'; end if;
  end if;
  insert into public.ledger_accounts (company_id, code, name, name_en, type, description)
  values (target, '2200', 'Salarios por pagar', 'Wages payable', 'liability', 'Neto aprobado pendiente de pago (0034).'),
         (target, '2210', 'Deducciones de nómina por pagar', 'Payroll deductions payable', 'liability', 'Deducciones retenidas pendientes de remitir (0034).')
  on conflict (company_id, code) do nothing;
  select id into wages from public.ledger_accounts where company_id = target and code = '2200' and type = 'liability';
  select id into ded from public.ledger_accounts where company_id = target and code = '2210' and type = 'liability';
  select id into pay from public.ledger_accounts where company_id = target and code = '1010' and type = 'asset';
  if pay is null then select id into pay from public.ledger_accounts where company_id = target and system_key = 'cash'; end if;
  if wages is null or ded is null or pay is null then
    raise exception 'PAYROLL_ACCOUNTS_MISSING' using errcode = 'P0001';
  end if;
  insert into public.payroll_settings (company_id, expense_account_id, wages_payable_account_id, deductions_payable_account_id, payment_account_id, updated_by)
  values (target, exp_id, wages, ded, pay, (select auth.uid()))
  on conflict (company_id) do nothing;
  select * into s from public.payroll_settings where company_id = target;
  perform public.payroll_log(target, null, null, 'settings_initialized', '{}');
  return s;
end $$;

-- The compensation in effect on a day: latest effective date, then latest record (a correction).
create or replace function public.payroll_compensation_at(emp uuid, on_day date)
returns public.employee_compensation language sql stable security definer set search_path = '' as $$
  select c.* from public.employee_compensation c where c.employee_id = emp and c.effective_from <= on_day
  order by c.effective_from desc, c.created_at desc limit 1
$$;

-- Minutes worked in [from_day, to_day] (company time zone) from the CLOSED
-- sessions of the time clock — the same algorithm as lib/workforce/hours.ts:
-- each session = round(out − in) − Σ round(breaks); 'start_day' attributes the
-- whole session to the day it began; 'split_midnight' cuts it at local
-- midnights (pieces rounded, the last one absorbs the difference). Also
-- reports whether a session is still open.
create or replace function public.wf_worked_minutes(emp uuid, from_day date, to_day date)
returns table (worked_minutes integer, open_session boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  e public.employees;
  tz text;
  mode text;
  p record;
  s_start timestamptz; b_start timestamptz;
  brks tstzrange[] := '{}';
  total integer := 0;
  is_open boolean := false;
  sess_min integer; brk_min integer;
  d date; cut timestamptz; nxt timestamptz; piece_sum integer; piece numeric; bsum numeric; br tstzrange; i integer;
begin
  select * into e from public.employees where id = emp;
  if not found then return; end if;
  tz := public.wf_timezone(e.company_id);
  mode := coalesce((select w.overnight_attribution from public.workforce_settings w where w.company_id = e.company_id), 'start_day');
  for p in select tp.kind, tp.at from public.time_punches tp
            where tp.employee_id = emp and tp.voided_at is null
              and tp.at >= ((from_day - 2)::timestamp at time zone tz) and tp.at < ((to_day + 3)::timestamp at time zone tz)
            order by tp.at, tp.created_at, tp.id loop
    if p.kind = 'in' then s_start := p.at; brks := '{}'; b_start := null;
    elsif p.kind = 'break_start' and s_start is not null then b_start := p.at;
    elsif p.kind = 'break_end' and b_start is not null then brks := brks || tstzrange(b_start, p.at); b_start := null;
    elsif p.kind = 'out' and s_start is not null then
      if b_start is not null then brks := brks || tstzrange(b_start, p.at); b_start := null; end if;
      brk_min := 0;
      foreach br in array brks loop brk_min := brk_min + round(extract(epoch from (upper(br) - lower(br))) / 60)::integer; end loop;
      sess_min := greatest(0, round(extract(epoch from (p.at - s_start)) / 60)::integer - brk_min);
      if mode = 'split_midnight' then
        -- pieces per local day, the last piece absorbs the rounding (as sessionPieces in TypeScript)
        d := (s_start at time zone tz)::date; cut := s_start; piece_sum := 0; i := 0;
        while cut < p.at loop
          nxt := least(p.at, ((d + 1)::timestamp at time zone tz));
          bsum := 0;
          foreach br in array brks loop
            bsum := bsum + greatest(0, extract(epoch from (least(upper(br), nxt) - greatest(lower(br), cut))));
          end loop;
          if nxt >= p.at then
            piece := sess_min - piece_sum;                       -- last piece
          else
            piece := round(greatest(0, extract(epoch from (nxt - cut)) / 60 - bsum / 60));
            piece_sum := piece_sum + piece;
          end if;
          if d between from_day and to_day then total := total + piece::integer; end if;
          cut := nxt; d := d + 1; i := i + 1;
          exit when i > 40;
        end loop;
      elsif (s_start at time zone tz)::date between from_day and to_day then
        total := total + sess_min;
      end if;
      s_start := null; brks := '{}';
    end if;
  end loop;
  if s_start is not null and (s_start at time zone tz)::date <= to_day then is_open := true; end if;
  worked_minutes := total; open_session := is_open;
  return next;
end $$;

-- Paid leave minutes in a period: approved leave of the paid types, valued at
-- the SCHEDULED time of each day it covers (partial leave: its minutes).
create or replace function public.payroll_leave_minutes(emp uuid, from_day date, to_day date, types text[])
returns integer language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := public.wf_timezone((select company_id from public.employees where id = emp));
  n integer := 0;
begin
  if coalesce(cardinality(types), 0) = 0 then return 0; end if;
  select coalesce(sum(l.partial_minutes), 0) into n from public.leave_requests l
   where l.employee_id = emp and l.status = 'approved' and l.leave_type = any (types) and l.partial_minutes is not null
     and l.starts_on between from_day and to_day;
  select n + coalesce(sum(greatest(0, round(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer - s.break_minutes)), 0) into n
    from public.work_shifts s
   where s.employee_id = emp and (s.starts_at at time zone tz)::date between from_day and to_day
     and exists (select 1 from public.leave_requests l where l.employee_id = emp and l.status = 'approved' and l.leave_type = any (types)
                   and l.partial_minutes is null and l.starts_on <= (s.starts_at at time zone tz)::date and (s.starts_at at time zone tz)::date <= l.ends_on);
  return n;
end $$;

-- ===================================================================== RLS
do $$
declare t text;
begin
  foreach t in array array['payroll_settings', 'employee_compensation', 'payroll_items', 'employee_payroll_items', 'payroll_runs',
                           'payroll_adjustments', 'payroll_lines', 'payroll_line_items', 'payroll_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
alter table public.payroll_tax_rules enable row level security;
revoke all on public.payroll_tax_rules from public, anon, authenticated;
grant all on public.payroll_tax_rules to service_role;
grant select on public.payroll_tax_rules to authenticated;
drop policy if exists ba_payroll_tax_rules_select on public.payroll_tax_rules;
create policy ba_payroll_tax_rules_select on public.payroll_tax_rules for select to authenticated using (true);

drop policy if exists ba_payroll_settings_select on public.payroll_settings;
create policy ba_payroll_settings_select on public.payroll_settings for select to authenticated using (public.has_permission(company_id, 'payroll.view'));
drop policy if exists ba_payroll_items_select on public.payroll_items;
create policy ba_payroll_items_select on public.payroll_items for select to authenticated using (public.has_permission(company_id, 'payroll.view'));
drop policy if exists ba_payroll_events_select on public.payroll_events;
create policy ba_payroll_events_select on public.payroll_events for select to authenticated using (public.has_permission(company_id, 'payroll.view'));
drop policy if exists ba_payroll_adjustments_select on public.payroll_adjustments;
create policy ba_payroll_adjustments_select on public.payroll_adjustments for select to authenticated using (public.has_permission(company_id, 'payroll.view'));
-- pay data: payroll.view, or the employee's own records
drop policy if exists ba_employee_compensation_select on public.employee_compensation;
create policy ba_employee_compensation_select on public.employee_compensation for select to authenticated
  using (public.has_permission(company_id, 'payroll.view') or public.wf_is_self(employee_id));
drop policy if exists ba_employee_payroll_items_select on public.employee_payroll_items;
create policy ba_employee_payroll_items_select on public.employee_payroll_items for select to authenticated
  using (public.has_permission(company_id, 'payroll.view') or public.wf_is_self(employee_id));
-- a published (approved / paid) run is visible to its employees; drafts and reversals only to payroll.view.
-- The cross-table checks run in SECURITY DEFINER helpers (a policy reading the other table's policy would recurse).
create or replace function public.payroll_run_published(run uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.payroll_runs r where r.id = run and r.status in ('approved', 'paid'))
$$;
create or replace function public.payroll_self_in_run(run uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.payroll_lines l where l.run_id = run and public.wf_is_self(l.employee_id))
$$;
create or replace function public.payroll_self_line(line uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.payroll_lines l join public.payroll_runs r on r.id = l.run_id
                 where l.id = line and public.wf_is_self(l.employee_id) and r.status in ('approved', 'paid'))
$$;
drop policy if exists ba_payroll_runs_select on public.payroll_runs;
create policy ba_payroll_runs_select on public.payroll_runs for select to authenticated
  using (public.has_permission(company_id, 'payroll.view') or (status in ('approved', 'paid') and public.payroll_self_in_run(id)));
drop policy if exists ba_payroll_lines_select on public.payroll_lines;
create policy ba_payroll_lines_select on public.payroll_lines for select to authenticated
  using (public.has_permission(company_id, 'payroll.view') or (public.wf_is_self(employee_id) and public.payroll_run_published(run_id)));
drop policy if exists ba_payroll_line_items_select on public.payroll_line_items;
create policy ba_payroll_line_items_select on public.payroll_line_items for select to authenticated
  using (public.has_permission(company_id, 'payroll.view') or public.payroll_self_line(line_id));

-- ===================================================================== immutability
create or replace function public.payroll_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  cid uuid := (to_jsonb(coalesce(new, old)) ->> 'company_id')::uuid;
  rid uuid := (to_jsonb(coalesce(new, old)) ->> 'run_id')::uuid;
  st text;
begin
  if tg_op = 'DELETE' and public.ledger_company_gone(cid) then return old; end if;
  if tg_table_name in ('employee_compensation', 'payroll_events') then
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  if tg_table_name in ('payroll_lines', 'payroll_line_items', 'payroll_adjustments') then
    select r.status into st from public.payroll_runs r where r.id = rid;
    if st is distinct from 'draft' and st is not null then
      raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = st;
    end if;
    return coalesce(new, old);
  end if;
  if tg_table_name = 'payroll_runs' then
    if tg_op = 'DELETE' then raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name; end if;
    if old.status <> 'draft' and (to_jsonb(new) - array['status', 'paid_by', 'paid_at', 'payment_date', 'payment_reference', 'payment_entry_id',
                                                          'reversed_by', 'reversed_at', 'reverse_reason'])
                                 <> (to_jsonb(old) - array['status', 'paid_by', 'paid_at', 'payment_date', 'payment_reference', 'payment_entry_id',
                                                          'reversed_by', 'reversed_at', 'reverse_reason']) then
      raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = old.status;
    end if;
    if old.status in ('reversed', 'discarded') or (old.status = 'paid' and new.status not in ('paid', 'reversed'))
       or (old.status = 'approved' and new.status not in ('approved', 'paid', 'reversed')) then
      raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = old.status;
    end if;
    return new;
  end if;
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['employee_compensation', 'payroll_events', 'payroll_lines', 'payroll_line_items', 'payroll_adjustments', 'payroll_runs'] loop
    execute format('drop trigger if exists ba_payroll_guard on public.%I', t);
    execute format('create trigger ba_payroll_guard before update or delete on public.%I for each row execute function public.payroll_guard()', t);
  end loop;
end $$;

-- ===================================================================== compensation and items
create or replace function public.set_compensation(emp uuid, effective date, kind text, frequency text, rate_cents bigint, annual_cents bigint,
                                                   ot_rate_cents bigint, why text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  cid uuid;
  locked date;
begin
  select * into e from public.employees where id = emp;
  if not found or not public.payroll_can(e.company_id, 'payroll.manage') then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if effective is null or effective < date '2000-01-01' or effective > public.ba_today() + 366 then
    raise exception 'EFFECTIVE_DATE_INVALID' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(why, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  -- an approved period is never repriced: corrections go through a correction run
  select max(r.period_end) into locked from public.payroll_runs r join public.payroll_lines l on l.run_id = r.id
   where l.employee_id = emp and r.status in ('approved', 'paid');
  if locked is not null and effective <= locked then
    raise exception 'COMPENSATION_PERIOD_LOCKED' using errcode = 'P0001', hint = locked::text;
  end if;
  begin
    insert into public.employee_compensation (company_id, employee_id, effective_from, pay_type, pay_frequency, hourly_rate_cents, annual_salary_cents,
                                              overtime_hourly_rate_cents, reason, created_by)
    values (e.company_id, emp, effective, kind, frequency, case when kind = 'hourly' then rate_cents end, case when kind = 'salary' then annual_cents end,
            case when kind = 'salary' then ot_rate_cents end, left(btrim(why), 300), (select auth.uid()))
    returning id into cid;
  exception when check_violation then
    raise exception 'COMPENSATION_INVALID' using errcode = 'P0001';
  end;
  perform public.payroll_log(e.company_id, null, emp, 'compensation_set', jsonb_build_object('effective_from', effective, 'pay_type', kind, 'frequency', frequency));
  return cid;
end $$;

create or replace function public.payroll_save_item(target uuid, item_code text, item_name text, item_kind text, item_calc text, amount bigint, rate integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare iid uuid;
begin
  if not public.payroll_can(target, 'payroll.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  begin
    insert into public.payroll_items (company_id, code, name, kind, calc, default_amount_cents, default_rate_bp, created_by)
    values (target, upper(btrim(item_code)), btrim(item_name), item_kind, item_calc, amount, rate, (select auth.uid()))
    returning id into iid;
  exception when unique_violation then raise exception 'PAYROLL_ITEM_EXISTS' using errcode = 'P0001';
            when check_violation then raise exception 'PAYROLL_ITEM_INVALID' using errcode = 'P0001';
  end;
  perform public.payroll_log(target, null, null, 'item_created', jsonb_build_object('code', upper(btrim(item_code)), 'kind', item_kind));
  return iid;
end $$;

create or replace function public.assign_payroll_item(emp uuid, item uuid, amount bigint, rate integer, from_day date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare e public.employees; i public.payroll_items; aid uuid;
begin
  select * into e from public.employees where id = emp;
  select * into i from public.payroll_items where id = item;
  if e.id is null or i.id is null or i.company_id <> e.company_id or not public.payroll_can(e.company_id, 'payroll.manage') then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if (i.calc = 'fixed' and (amount is null or rate is not null)) or (i.calc = 'percent' and (rate is null or amount is not null)) or from_day is null then
    raise exception 'PAYROLL_ITEM_INVALID' using errcode = 'P0001';
  end if;
  insert into public.employee_payroll_items (company_id, employee_id, item_id, amount_cents, rate_bp, starts_on, created_by)
  values (e.company_id, emp, item, amount, rate, from_day, (select auth.uid())) returning id into aid;
  perform public.payroll_log(e.company_id, null, emp, 'item_assigned', jsonb_build_object('item', i.code, 'from', from_day));
  return aid;
end $$;

create or replace function public.end_payroll_item(assignment uuid, last_day date)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.employee_payroll_items;
begin
  select * into a from public.employee_payroll_items where id = assignment for update;
  if not found or not public.payroll_can(a.company_id, 'payroll.manage') then raise exception 'PAYROLL_ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
  if a.ends_on is not null or last_day is null or last_day < a.starts_on then raise exception 'PAYROLL_ITEM_INVALID' using errcode = 'P0001'; end if;
  update public.employee_payroll_items set ends_on = last_day, ended_by = (select auth.uid()) where id = a.id;
  perform public.payroll_log(a.company_id, null, a.employee_id, 'item_ended', jsonb_build_object('assignment', a.id, 'last_day', last_day));
end $$;

-- assignments change only by ending them (once)
create or replace function public.payroll_assignment_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.ledger_company_gone(old.company_id) then return old; end if;
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = 'employee_payroll_items';
  end if;
  if old.ends_on is not null or (to_jsonb(new) - array['ends_on', 'ended_by']) <> (to_jsonb(old) - array['ends_on', 'ended_by']) then
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = 'employee_payroll_items';
  end if;
  return new;
end $$;
drop trigger if exists ba_payroll_assignment_guard on public.employee_payroll_items;
create trigger ba_payroll_assignment_guard before update or delete on public.employee_payroll_items for each row execute function public.payroll_assignment_guard();

-- ===================================================================== runs
create or replace function public.payroll_create_run(target uuid, frequency text, p_start date, p_end date, p_pay_date date, idem text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  if not public.payroll_can(target, 'payroll.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if idem is not null then
    select id into rid from public.payroll_runs where company_id = target and idempotency_key = idem;
    if found then return rid; end if;                                -- the same request again: the same run
  end if;
  if not public.payroll_period_ok(frequency, p_start, p_end) or p_pay_date is null or p_pay_date < p_start or p_pay_date > p_end + 31 then
    raise exception 'PAYROLL_PERIOD_INVALID' using errcode = 'P0001';
  end if;
  perform public.payroll_ensure_settings(target);
  begin
    insert into public.payroll_runs (company_id, pay_frequency, period_start, period_end, pay_date, idempotency_key, created_by)
    values (target, frequency, p_start, p_end, p_pay_date, idem, (select auth.uid())) returning id into rid;
  exception when unique_violation then
    if idem is not null then
      select id into rid from public.payroll_runs where company_id = target and idempotency_key = idem;
      if found then return rid; end if;
    end if;
    raise exception 'PAYROLL_PERIOD_EXISTS' using errcode = 'P0001';
  end;
  perform public.payroll_log(target, rid, null, 'run_created', jsonb_build_object('frequency', frequency, 'from', p_start, 'to', p_end));
  return rid;
end $$;

-- A correction of an approved / paid run: extra earnings or deductions only (traceable).
create or replace function public.payroll_create_correction(run uuid, p_pay_date date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.payroll_runs; rid uuid;
begin
  select * into r from public.payroll_runs where id = run;
  if not found or not public.payroll_can(r.company_id, 'payroll.manage') then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status not in ('approved', 'paid') or r.run_type <> 'regular' then raise exception 'PAYROLL_RUN_NOT_CORRECTABLE' using errcode = 'P0001'; end if;
  insert into public.payroll_runs (company_id, run_type, corrects_run_id, pay_frequency, period_start, period_end, pay_date, created_by)
  values (r.company_id, 'correction', r.id, r.pay_frequency, r.period_start, r.period_end, coalesce(p_pay_date, public.ba_today()), (select auth.uid()))
  returning id into rid;
  perform public.payroll_log(r.company_id, rid, null, 'correction_created', jsonb_build_object('corrects', r.id));
  return rid;
end $$;

create or replace function public.payroll_add_adjustment(run uuid, emp uuid, item uuid, amount bigint, adj_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.payroll_runs; i public.payroll_items; aid uuid;
begin
  select * into r from public.payroll_runs where id = run for update;
  select * into i from public.payroll_items where id = item;
  if r.id is null or not public.payroll_can(r.company_id, 'payroll.manage') then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status <> 'draft' then raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = r.status; end if;
  if i.id is null or i.company_id <> r.company_id or i.calc <> 'fixed' or not i.active
     or not exists (select 1 from public.employees e where e.id = emp and e.company_id = r.company_id) or amount is null or amount < 1 then
    raise exception 'PAYROLL_ITEM_INVALID' using errcode = 'P0001';
  end if;
  insert into public.payroll_adjustments (company_id, run_id, employee_id, item_id, amount_cents, note, created_by)
  values (r.company_id, run, emp, item, amount, nullif(left(btrim(coalesce(adj_note, '')), 200), ''), (select auth.uid())) returning id into aid;
  update public.payroll_runs set version = version + 1 where id = run;   -- the preview is no longer current
  perform public.payroll_log(r.company_id, run, emp, 'adjustment_added', jsonb_build_object('item', i.code, 'amount_cents', amount));
  return aid;
end $$;

create or replace function public.payroll_remove_adjustment(adjustment uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.payroll_adjustments; r public.payroll_runs;
begin
  select * into a from public.payroll_adjustments where id = adjustment;
  select * into r from public.payroll_runs where id = a.run_id for update;
  if a.id is null or not public.payroll_can(a.company_id, 'payroll.manage') then raise exception 'PAYROLL_ITEM_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status <> 'draft' then raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = r.status; end if;
  delete from public.payroll_adjustments where id = a.id;
  update public.payroll_runs set version = version + 1 where id = r.id;
  perform public.payroll_log(a.company_id, r.id, a.employee_id, 'adjustment_removed', jsonb_build_object('amount_cents', a.amount_cents));
end $$;

-- Prepare (or re-prepare) a draft: one line per employee of the run's pay
-- frequency, from Workforce hours (verified against the punches), the
-- compensation in effect at the end of the period, paid leave, recurring
-- items and adjustments. `hours`: [{employee_id, regular_minutes, overtime_minutes}]
-- computed by the app with the Workforce rules (lib/workforce/hours.ts).
create or replace function public.payroll_prepare(run uuid, hours jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r public.payroll_runs;
  s public.payroll_settings;
  e record;
  c public.employee_compensation;
  h jsonb;
  worked integer;
  is_open boolean;
  rl record;
  li record;
  lid uuid;
  reg integer; ot integer; leave_min integer;
  reg_pay bigint; ot_pay bigint; leave_pay bigint; sal_pay bigint; earn bigint; ded bigint; gross bigint; base bigint;
  v_issues text[]; v_blocking boolean;
  n integer := 0;
  amt bigint;
begin
  select * into r from public.payroll_runs where id = run for update;
  if not found or not public.payroll_can(r.company_id, 'payroll.manage') then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status <> 'draft' then raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = r.status; end if;
  if exists (select 1 from public.payroll_tax_rules t where t.status = 'approved') then
    -- a tax rule was enabled but no verified tax calculation exists in this version: refuse rather than guess
    raise exception 'PAYROLL_TAX_ENGINE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if hours is null or jsonb_typeof(hours) <> 'array' then raise exception 'PAYROLL_HOURS_INVALID' using errcode = 'P0001'; end if;
  s := public.payroll_ensure_settings(r.company_id);
  delete from public.payroll_lines where run_id = run;

  for e in
    select x.id, x.first_name, x.last_name, x.employee_number, x.status
      from public.employees x
     where x.company_id = r.company_id
       and (r.run_type = 'correction' and exists (select 1 from public.payroll_adjustments a where a.run_id = run and a.employee_id = x.id)
         or r.run_type = 'regular' and (
              ((public.payroll_compensation_at(x.id, r.period_end)).pay_frequency = r.pay_frequency
                and (x.status in ('active', 'suspended') or exists (select 1 from public.time_punches t where t.employee_id = x.id and t.voided_at is null
                                                                      and t.at >= (r.period_start - 1)::timestamptz and t.at < (r.period_end + 2)::timestamptz)))
              -- hours submitted for someone without compensation: shown (blocking), never dropped silently
              or ((public.payroll_compensation_at(x.id, r.period_end)).id is null
                  and exists (select 1 from jsonb_array_elements(hours) j where j ->> 'employee_id' = x.id::text
                                and coalesce((j ->> 'regular_minutes')::integer, 0) + coalesce((j ->> 'overtime_minutes')::integer, 0) > 0))))
     order by x.first_name, x.last_name, x.id
  loop
    c := public.payroll_compensation_at(e.id, r.period_end);
    v_issues := '{}'; v_blocking := false; h := null; worked := null; is_open := false;
    reg := 0; ot := 0; leave_min := 0; reg_pay := 0; ot_pay := 0; leave_pay := 0; sal_pay := 0; earn := 0; ded := 0;
    select * into rl from public.wf_rules(e.id);
    if not found and r.run_type = 'regular' then
      v_issues := v_issues || 'rules_unavailable'::text; v_blocking := true;     -- never a default multiplier in silence
    end if;
    if r.run_type = 'regular' then
      if c.id is null then
        v_issues := v_issues || 'no_compensation'::text; v_blocking := true;
      else
        if exists (select 1 from public.employee_compensation x where x.employee_id = e.id and x.effective_from > r.period_start and x.effective_from <= r.period_end) then
          v_issues := v_issues || 'rate_changed_in_period'::text;   -- informative: the rate in effect at the end of the period is used
        end if;
        select value into h from jsonb_array_elements(hours) where value ->> 'employee_id' = e.id::text;
        reg := coalesce((h ->> 'regular_minutes')::integer, 0);
        ot := coalesce((h ->> 'overtime_minutes')::integer, 0);
        if reg < 0 or ot < 0 then raise exception 'PAYROLL_HOURS_INVALID' using errcode = 'P0001'; end if;
        select w.worked_minutes, w.open_session into worked, is_open from public.wf_worked_minutes(e.id, r.period_start, r.period_end) w;
        if is_open then
          -- a session without clock-out: hours are not final; correct the punches first
          v_issues := v_issues || 'open_session'::text; v_blocking := true; reg := 0; ot := 0;
        elsif reg + ot <> coalesce(worked, 0) then
          raise exception 'PAYROLL_HOURS_MISMATCH' using errcode = 'P0001',
            hint = format('%s: %s submitted, %s from the time clock', e.id, reg + ot, coalesce(worked, 0));
        end if;
        if ot > 0 and rl.exempt then raise exception 'PAYROLL_HOURS_INVALID' using errcode = 'P0001', hint = 'exempt employee with overtime'; end if;
        if c.pay_type = 'hourly' then
          leave_min := public.payroll_leave_minutes(e.id, r.period_start, r.period_end, s.paid_leave_types);
          reg_pay := public.payroll_round(reg::numeric * c.hourly_rate_cents / 60);
          ot_pay := public.payroll_round(ot::numeric * c.hourly_rate_cents * coalesce(rl.overtime_multiplier, 1) / 60);
          leave_pay := public.payroll_round(leave_min::numeric * c.hourly_rate_cents / 60);
        else
          sal_pay := public.payroll_round(c.annual_salary_cents::numeric / public.payroll_periods_per_year(r.pay_frequency));
          if ot > 0 then
            if c.overtime_hourly_rate_cents is null then
              v_issues := v_issues || 'salaried_overtime_rate_missing'::text; v_blocking := true;
            else
              ot_pay := public.payroll_round(ot::numeric * c.overtime_hourly_rate_cents * coalesce(rl.overtime_multiplier, 1) / 60);
            end if;
          end if;
          if exists (select 1 from public.employees x where x.id = e.id and (x.hire_date > r.period_start or x.termination_date < r.period_end)) then
            v_issues := v_issues || 'partial_period_review'::text;  -- no proration is assumed: review before approving
          end if;
        end if;
      end if;
    end if;
    insert into public.payroll_lines (company_id, run_id, employee_id, employee_name, employee_number, compensation_id, pay_type, hourly_rate_cents,
                                      annual_salary_cents, overtime_multiplier, regular_minutes, overtime_minutes, worked_minutes_verified, leave_paid_minutes)
    values (r.company_id, run, e.id, e.first_name || ' ' || e.last_name, e.employee_number, c.id, c.pay_type, c.hourly_rate_cents, c.annual_salary_cents,
            case when r.run_type = 'regular' then rl.overtime_multiplier end, reg, ot, worked, leave_min)
    returning id into lid;
    -- earnings: recurring fixed earnings (regular runs) and adjustments
    for li in
      select i.id as item_id, i.name, i.kind, i.calc, a.amount_cents, a.rate_bp, 'recurring'::text as src
        from public.employee_payroll_items a join public.payroll_items i on i.id = a.item_id
       where r.run_type = 'regular' and a.employee_id = e.id and a.starts_on <= r.period_end and (a.ends_on is null or a.ends_on >= r.period_start)
      union all
      select i.id, i.name, i.kind, i.calc, a.amount_cents, null, 'adjustment'
        from public.payroll_adjustments a join public.payroll_items i on i.id = a.item_id
       where a.run_id = run and a.employee_id = e.id
    loop
      if li.kind = 'earning' then
        insert into public.payroll_line_items (company_id, run_id, line_id, item_id, kind, label, amount_cents, source)
        values (r.company_id, run, lid, li.item_id, 'earning', li.name, li.amount_cents, li.src);
        earn := earn + li.amount_cents;
      end if;
    end loop;
    gross := reg_pay + ot_pay + leave_pay + sal_pay + earn;
    -- deductions: fixed, or a percentage of gross (rounded once)
    for li in
      select i.id as item_id, i.name, i.calc, a.amount_cents, a.rate_bp, 'recurring'::text as src
        from public.employee_payroll_items a join public.payroll_items i on i.id = a.item_id
       where r.run_type = 'regular' and i.kind = 'deduction' and a.employee_id = e.id and a.starts_on <= r.period_end and (a.ends_on is null or a.ends_on >= r.period_start)
      union all
      select i.id, i.name, i.calc, a.amount_cents, null, 'adjustment'
        from public.payroll_adjustments a join public.payroll_items i on i.id = a.item_id
       where a.run_id = run and a.employee_id = e.id and i.kind = 'deduction'
    loop
      amt := case when li.calc = 'percent' then public.payroll_round(gross::numeric * li.rate_bp / 10000) else li.amount_cents end;
      if amt > 0 then
        insert into public.payroll_line_items (company_id, run_id, line_id, item_id, kind, label, amount_cents, source)
        values (r.company_id, run, lid, li.item_id, 'deduction', li.name, amt, li.src);
        ded := ded + amt;
      end if;
    end loop;
    if ded > gross then v_issues := v_issues || 'net_negative'::text; v_blocking := true; end if;
    update public.payroll_lines set regular_pay_cents = reg_pay, overtime_pay_cents = ot_pay, leave_pay_cents = leave_pay, salary_pay_cents = sal_pay,
           other_earnings_cents = earn, gross_cents = gross, deductions_cents = ded, taxes_cents = 0, net_cents = gross - ded, issues = v_issues, blocking = v_blocking
     where id = lid;
    n := n + 1;
  end loop;
  -- employees whose submitted hours were not used (another frequency, no compensation…) must not be silently dropped
  if exists (select 1 from jsonb_array_elements(hours) x
              where (coalesce((x ->> 'regular_minutes')::integer, 0) + coalesce((x ->> 'overtime_minutes')::integer, 0)) > 0
                and not exists (select 1 from public.payroll_lines l where l.run_id = run and l.employee_id::text = x ->> 'employee_id')
                and r.run_type = 'regular'
                and (public.payroll_compensation_at((x ->> 'employee_id')::uuid, r.period_end)).pay_frequency = r.pay_frequency) then
    raise exception 'PAYROLL_HOURS_INVALID' using errcode = 'P0001', hint = 'hours for an employee outside the run';
  end if;
  update public.payroll_runs pr set
    gross_cents = coalesce((select sum(gross_cents) from public.payroll_lines where run_id = run), 0),
    deductions_cents = coalesce((select sum(deductions_cents) from public.payroll_lines where run_id = run), 0),
    taxes_cents = 0,
    net_cents = coalesce((select sum(net_cents) from public.payroll_lines where run_id = run), 0),
    employees = n,
    blocking_issues = (select count(*) from public.payroll_lines where run_id = run and blocking),
    rules_snapshot = jsonb_build_object('overnight', (select w.overnight_attribution from public.workforce_settings w where w.company_id = pr.company_id),
                                        'rule_version', public.wf_rule_version_of('company', pr.company_id), 'paid_leave_types', s.paid_leave_types),
    version = version + 1, prepared_version = version + 1, prepared_by = (select auth.uid()), prepared_at = now()
   where id = run;
  perform public.payroll_log(r.company_id, run, null, 'prepared', jsonb_build_object('employees', n));
  return n;
end $$;

-- Approve exactly the previewed version: locks the run and posts the accrual.
create or replace function public.payroll_approve(run uuid, expected_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  r public.payroll_runs;
  s public.payroll_settings;
  uid uuid := (select auth.uid());
  eid uuid;
  ln jsonb;
begin
  select * into r from public.payroll_runs where id = run for update;
  if not found or not public.payroll_can(r.company_id, 'payroll.approve') then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status = 'approved' or r.status = 'paid' then
    raise exception 'PAYROLL_ALREADY_APPROVED' using errcode = 'P0001';
  end if;
  if r.status <> 'draft' then raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = r.status; end if;
  if r.prepared_at is null or r.employees = 0 or r.prepared_version is distinct from r.version then
    raise exception 'PAYROLL_NOT_PREPARED' using errcode = 'P0001';     -- changed since the last preparation: prepare again
  end if;
  if r.version <> expected_version then raise exception 'PAYROLL_PREVIEW_STALE' using errcode = 'P0001'; end if;
  if r.blocking_issues > 0 then raise exception 'PAYROLL_BLOCKING_ISSUES' using errcode = 'P0001', hint = r.blocking_issues::text; end if;
  if r.gross_cents <= 0 then raise exception 'PAYROLL_NOT_PREPARED' using errcode = 'P0001'; end if;
  s := public.payroll_ensure_settings(r.company_id);
  -- with a second approver required, nobody approves a run they prepared or in which they are paid
  if s.require_second_approver and (r.prepared_by = uid or exists (select 1 from public.payroll_lines l where l.run_id = run and public.wf_is_self(l.employee_id))) then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0001';
  end if;
  ln := jsonb_build_array(jsonb_build_object('account', s.expense_account_id, 'debit', r.gross_cents::text, 'memo', 'Nómina bruta / Gross payroll'));
  if r.net_cents > 0 then ln := ln || jsonb_build_object('account', s.wages_payable_account_id, 'credit', r.net_cents::text, 'memo', 'Neto por pagar / Net payable'); end if;
  if r.deductions_cents > 0 then ln := ln || jsonb_build_object('account', s.deductions_payable_account_id, 'credit', r.deductions_cents::text, 'memo', 'Deducciones / Deductions'); end if;
  eid := public.ledger_post(r.company_id, r.period_end, left(format('Nómina %s – %s', r.period_start, r.period_end), 300), 'PAYROLL', 'payroll', r.id, ln);
  update public.payroll_runs set status = 'approved', approved_by = uid, approved_at = now(),
         self_approved = (r.prepared_by = uid or exists (select 1 from public.payroll_lines l where l.run_id = run and public.wf_is_self(l.employee_id))),
         expense_entry_id = eid where id = run;
  perform public.payroll_log(r.company_id, run, null, 'approved', jsonb_build_object('entry_id', eid, 'gross_cents', r.gross_cents, 'net_cents', r.net_cents, 'version', r.version));
  return eid;
end $$;

-- Record that the net was paid (no money is moved by BusinessAI).
create or replace function public.payroll_record_payment(run uuid, paid_on date, reference text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.payroll_runs; s public.payroll_settings; eid uuid;
begin
  select * into r from public.payroll_runs where id = run for update;
  if not found or not public.payroll_can(r.company_id, 'payroll.approve') then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status = 'paid' then raise exception 'PAYROLL_ALREADY_PAID' using errcode = 'P0001'; end if;
  if r.status <> 'approved' then raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = r.status; end if;
  if paid_on is null or paid_on < r.period_start or paid_on > public.ba_today() then raise exception 'PAYMENT_DATE_INVALID' using errcode = 'P0001'; end if;
  s := public.payroll_ensure_settings(r.company_id);
  if r.net_cents > 0 then
    eid := public.ledger_post(r.company_id, paid_on, left(format('Pago de nómina %s – %s', r.period_start, r.period_end), 300),
      nullif(left(btrim(coalesce(reference, '')), 100), ''), 'payroll_payment', r.id,
      jsonb_build_array(jsonb_build_object('account', s.wages_payable_account_id, 'debit', r.net_cents::text),
                        jsonb_build_object('account', s.payment_account_id, 'credit', r.net_cents::text)));
  end if;
  update public.payroll_runs set status = 'paid', paid_by = (select auth.uid()), paid_at = now(), payment_date = paid_on,
         payment_reference = nullif(left(btrim(coalesce(reference, '')), 100), ''), payment_entry_id = eid where id = run;
  perform public.payroll_log(r.company_id, run, null, 'paid', jsonb_build_object('entry_id', eid, 'date', paid_on));
  return eid;
end $$;

-- Reverse an approved or paid run: mirror entries (payment first), run kept as history.
create or replace function public.payroll_reverse(run uuid, why text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.payroll_runs; o public.journal_entries; d date := public.ba_today();
begin
  select * into r from public.payroll_runs where id = run for update;
  if not found or not public.payroll_can(r.company_id, 'payroll.approve') then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
  if char_length(btrim(coalesce(why, ''))) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if r.status not in ('approved', 'paid') then raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = r.status; end if;
  if exists (select 1 from public.payroll_runs x where x.corrects_run_id = r.id and x.status in ('approved', 'paid')) then
    raise exception 'PAYROLL_HAS_CORRECTIONS' using errcode = 'P0001';
  end if;
  if r.payment_entry_id is not null then
    select * into o from public.journal_entries where id = r.payment_entry_id;
    perform public.ledger_post(r.company_id, greatest(d, o.entry_date), left('Reversión pago de nómina / Payroll payment reversal: ' || o.description, 300), o.reference,
      'payroll_payment_void', r.id, public.ledger_mirror_lines(o.id), null, o.id, left(btrim(why), 300));
  end if;
  if r.expense_entry_id is not null then
    select * into o from public.journal_entries where id = r.expense_entry_id;
    perform public.ledger_post(r.company_id, greatest(d, o.entry_date), left('Reversión de nómina / Payroll reversal: ' || o.description, 300), o.reference,
      'payroll_void', r.id, public.ledger_mirror_lines(o.id), null, o.id, left(btrim(why), 300));
  end if;
  update public.payroll_runs set status = 'reversed', reversed_by = (select auth.uid()), reversed_at = now(), reverse_reason = left(btrim(why), 300) where id = run;
  perform public.payroll_log(r.company_id, run, null, 'reversed', jsonb_build_object('reason', left(btrim(why), 300)));
end $$;

create or replace function public.payroll_discard(run uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.payroll_runs;
begin
  select * into r from public.payroll_runs where id = run for update;
  if not found or not public.payroll_can(r.company_id, 'payroll.manage') then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status <> 'draft' then raise exception 'PAYROLL_RUN_LOCKED' using errcode = 'P0001', hint = r.status; end if;
  update public.payroll_runs set status = 'discarded' where id = run;
  perform public.payroll_log(r.company_id, run, null, 'discarded', '{}');
end $$;

create or replace function public.payroll_save_settings(target uuid, expense uuid, wages uuid, deductions uuid, payment uuid, leave_types text[], second_approver boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.payroll_can(target, 'payroll.approve') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  perform public.payroll_ensure_settings(target);
  if not exists (select 1 from public.ledger_accounts a where a.id = expense and a.company_id = target and a.type = 'expense' and a.status = 'active')
     or not exists (select 1 from public.ledger_accounts a where a.id = wages and a.company_id = target and a.type = 'liability' and a.status = 'active')
     or not exists (select 1 from public.ledger_accounts a where a.id = deductions and a.company_id = target and a.type = 'liability' and a.status = 'active')
     or not exists (select 1 from public.ledger_accounts a where a.id = payment and a.company_id = target and a.type = 'asset' and a.status = 'active') then
    raise exception 'ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  begin
    update public.payroll_settings set expense_account_id = expense, wages_payable_account_id = wages, deductions_payable_account_id = deductions,
           payment_account_id = payment, paid_leave_types = coalesce(leave_types, '{}'), require_second_approver = coalesce(second_approver, false),
           updated_by = (select auth.uid()), updated_at = now()
     where company_id = target;
  exception when check_violation then raise exception 'PAYROLL_SETTINGS_INVALID' using errcode = 'P0001';
  end;
  perform public.payroll_log(target, null, null, 'settings_updated', jsonb_build_object('paid_leave_types', leave_types, 'second_approver', second_approver));
end $$;

-- ===================================================================== existing pay rates → history (no data invented)
insert into public.employee_compensation (company_id, employee_id, effective_from, pay_type, pay_frequency, hourly_rate_cents, reason)
select e.company_id, e.id, coalesce(e.hire_date, date '2000-01-01'), 'hourly', 'biweekly', public.payroll_round(e.hourly_rate * 100),
       'Tarifa por hora existente del expediente (0020); frecuencia quincenal por defecto, revisar.'
  from public.employees e
 where e.hourly_rate is not null and e.hourly_rate > 0 and e.pay_type = 'hourly'
   and not exists (select 1 from public.employee_compensation c where c.employee_id = e.id);

-- ===================================================================== grants
do $$
declare f text;
begin
  foreach f in array array['payroll_log(uuid, uuid, uuid, text, jsonb)', 'payroll_ensure_settings(uuid)', 'payroll_compensation_at(uuid, date)',
                           'payroll_guard()', 'payroll_assignment_guard()', 'payroll_leave_minutes(uuid, date, date, text[])', 'wf_worked_minutes(uuid, date, date)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['payroll_run_published(uuid)', 'payroll_self_in_run(uuid)', 'payroll_self_line(uuid)', 'payroll_can(uuid, text)', 'payroll_round(numeric)', 'payroll_periods_per_year(text)', 'payroll_period_ok(text, date, date)',
                           'set_compensation(uuid, date, text, text, bigint, bigint, bigint, text)', 'payroll_save_item(uuid, text, text, text, text, bigint, integer)',
                           'assign_payroll_item(uuid, uuid, bigint, integer, date)', 'end_payroll_item(uuid, date)',
                           'payroll_create_run(uuid, text, date, date, date, text)', 'payroll_create_correction(uuid, date)',
                           'payroll_add_adjustment(uuid, uuid, uuid, bigint, text)', 'payroll_remove_adjustment(uuid)', 'payroll_prepare(uuid, jsonb)',
                           'payroll_approve(uuid, integer)', 'payroll_record_payment(uuid, date, text)', 'payroll_reverse(uuid, text)', 'payroll_discard(uuid)',
                           'payroll_save_settings(uuid, uuid, uuid, uuid, uuid, text[], boolean)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ===================================================================== self-check
do $$
begin
  if has_table_privilege('authenticated', 'public.employee_compensation', 'INSERT') or has_table_privilege('authenticated', 'public.payroll_runs', 'UPDATE')
     or has_table_privilege('authenticated', 'public.payroll_lines', 'INSERT') or has_table_privilege('authenticated', 'public.payroll_tax_rules', 'UPDATE')
     or has_table_privilege('anon', 'public.employee_compensation', 'SELECT') or has_table_privilege('anon', 'public.payroll_lines', 'SELECT')
     or has_function_privilege('authenticated', 'public.wf_worked_minutes(uuid, date, date)', 'EXECUTE') then
    raise exception 'BA0034 self-check failed: privileges';
  end if;
  if exists (select 1 from public.payroll_tax_rules where status <> 'disabled') then
    raise exception 'BA0034 self-check failed: tax rules must start disabled';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key like 'payroll.%') then
    raise exception 'BA0034 self-check failed: members have no payroll access';
  end if;
end $$;

commit;
