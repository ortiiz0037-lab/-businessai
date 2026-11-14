-- Payroll engine (0034). TEST-ONLY, local throw-away database with every migration
-- up to 0034. Schema at. Expected amounts are worked out by hand in the comments.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema at;
create table at.ctx (key text primary key, val text not null);
create function at.id(k text) returns uuid language sql stable as $$ select val::uuid from at.ctx where key = k $$;
create table at.failures (msg text);
create function at.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into at.failures values (msg); end if;
end $$;
create function at.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', at.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function at.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', at.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function at.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
grant usage on schema at to authenticated;
grant select on at.ctx to authenticated;
grant execute on all functions in schema at to authenticated;

insert into at.ctx values
  ('owner', 'fa000000-0000-4000-8000-000000000001'), ('admin', 'fa000000-0000-4000-8000-000000000002'),
  ('member', 'fa000000-0000-4000-8000-000000000003'), ('emp1u', 'fa000000-0000-4000-8000-000000000004'),
  ('other', 'fa000000-0000-4000-8000-000000000005'),
  ('A', 'fb000000-0000-4000-8000-000000000001'), ('B', 'fb000000-0000-4000-8000-000000000002'),
  ('emp1', 'fc000000-0000-4000-8000-000000000001'), ('emp2', 'fc000000-0000-4000-8000-000000000002'),
  ('emp3', 'fc000000-0000-4000-8000-000000000003'), ('empB', 'fc000000-0000-4000-8000-000000000004');
insert into auth.users (id, email) select val::uuid, key || '@pay.test' from at.ctx where key in ('owner', 'admin', 'member', 'emp1u', 'other');
insert into public.companies (id, name, created_by) values (at.id('A'), 'Nómina A', at.id('owner')), (at.id('B'), 'Nómina B', at.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (at.id('A'), 'cus_py_a', 'sub_py_a', 'pro', 'active'), (at.id('B'), 'cus_py_b', 'sub_py_b', 'basic', 'active');
insert into public.memberships (company_id, user_id, role) values
  (at.id('A'), at.id('owner'), 'owner'), (at.id('A'), at.id('admin'), 'admin'), (at.id('A'), at.id('member'), 'member'), (at.id('B'), at.id('other'), 'owner');
insert into public.employees (id, company_id, first_name, last_name, user_id, employee_number) values
  (at.id('emp1'), at.id('A'), 'Ana', 'Horas', at.id('emp1u'), '1');
insert into public.employees (id, company_id, first_name, last_name, employee_number) values
  (at.id('emp2'), at.id('A'), 'Beto', 'Salario', '2'), (at.id('emp3'), at.id('A'), 'Caro', 'SinTarifa', '3'), (at.id('empB'), at.id('B'), 'Bea', 'Otra', '9');
-- period: the Monday-to-Sunday week two weeks ago (always closed and in the past)
insert into at.ctx values ('p0', (date_trunc('week', public.ba_today())::date - 14)::text);
create function at.ctx_date() returns date language sql stable as $$ select val::date from at.ctx where key = 'p0' $$;
create function at.d(n integer) returns date language sql stable as $$ select at.ctx_date() + n $$;
create function at.t(n integer, hhmm text) returns timestamptz language sql stable as $$ select ((at.ctx_date() + n) + hhmm::time) at time zone 'America/Puerto_Rico' $$;
create function at.n(who text, q text) returns integer language sql as $$ select at.val(who, q)::integer $$;
grant execute on all functions in schema at to authenticated;
do $$ begin perform at.val('owner', format('select public.ledger_init(%L)::text', at.id('A'))); end $$;
-- emp1: day 0 08:00–17:00 with a 12:00–13:00 break (480 min); day 1 08:00–18:30 (630 min) → 1110 min;
-- with 8 h daily overtime: regular 960, overtime 150. emp3 works 4 h on day 2 but has no compensation.
insert into public.time_punches (company_id, employee_id, kind, at, source) values
  (at.id('A'), at.id('emp1'), 'in', at.t(0, '08:00'), 'self'), (at.id('A'), at.id('emp1'), 'break_start', at.t(0, '12:00'), 'self'),
  (at.id('A'), at.id('emp1'), 'break_end', at.t(0, '13:00'), 'self'), (at.id('A'), at.id('emp1'), 'out', at.t(0, '17:00'), 'self'),
  (at.id('A'), at.id('emp1'), 'in', at.t(1, '08:00'), 'self'), (at.id('A'), at.id('emp1'), 'out', at.t(1, '18:30'), 'self'),
  (at.id('A'), at.id('emp3'), 'in', at.t(2, '08:00'), 'self'), (at.id('A'), at.id('emp3'), 'out', at.t(2, '12:00'), 'self');
-- emp1: a scheduled 8 h shift on day 3 covered by approved vacation (paid leave once configured)
insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (at.id('A'), at.id('emp1'), at.t(3, '09:00'), at.t(3, '17:00'));
insert into public.leave_requests (company_id, employee_id, leave_type, starts_on, ends_on, status, requested_by) values
  (at.id('A'), at.id('emp1'), 'vacation', at.d(3), at.d(3), 'approved', at.id('emp1u'));

-- ===================================================================== money and time basics
do $$ begin
  perform at.ok(public.payroll_round(0.5) = 1 and public.payroll_round(2.5) = 3 and public.payroll_round(2.4999) = 2 and public.payroll_round(-0.5) = -1,
    'rounding to cents: half away from zero, once');
  perform at.ok(public.payroll_period_ok('weekly', at.d(0), at.d(6)) and public.payroll_period_ok('biweekly', at.d(0), at.d(13))
            and public.payroll_period_ok('semimonthly', '2026-02-16', '2026-02-28') and public.payroll_period_ok('semimonthly', '2026-03-01', '2026-03-15')
            and public.payroll_period_ok('monthly', '2026-02-01', '2026-02-28') and not public.payroll_period_ok('weekly', at.d(0), at.d(7))
            and not public.payroll_period_ok('semimonthly', '2026-03-01', '2026-03-16'), 'pay periods: weekly, biweekly, semimonthly, monthly shapes');
  perform at.ok((select w.worked_minutes from public.wf_worked_minutes(at.id('emp1'), at.d(0), at.d(6)) w) = 1110, 'hours come from the time clock: 1110 minutes of closed sessions');
end $$;

-- ===================================================================== compensation: private, effective dates, plan
do $$ begin
  perform at.ok(at.err('member', format('select public.set_compensation(%L, %L, %L, %L, 1525, null, null, %L)', at.id('emp1'), at.d(-30), 'hourly', 'weekly', 'Contratación')) like '%EMPLOYEE_NOT_FOUND%',
    'a member cannot set pay');
  perform at.ok(at.err('admin', format('select public.set_compensation(%L, %L, %L, %L, 1525, null, null, %L)', at.id('emp1'), at.d(-30), 'hourly', 'weekly', 'x')) like '%REASON_REQUIRED%',
    'a pay change needs a reason');
  perform at.ok(at.err('admin', format('select public.set_compensation(%L, %L, %L, %L, null, null, null, %L)', at.id('emp1'), at.d(-30), 'hourly', 'weekly', 'Sin tarifa')) like '%COMPENSATION_INVALID%',
    'an hourly compensation needs a rate');
  perform at.ok(at.err('admin', format('select public.set_compensation(%L, %L, %L, %L, 1400, null, null, %L)', at.id('emp1'), at.d(-60), 'hourly', 'weekly', 'Contratación (ficticia)')) = ''
            and at.err('admin', format('select public.set_compensation(%L, %L, %L, %L, 1525, null, null, %L)', at.id('emp1'), at.d(-30), 'hourly', 'weekly', 'Aumento (ficticio)')) = '',
    'pay history with effective dates ($14.00, then $15.25)');
  perform at.ok(at.err('admin', format('select public.set_compensation(%L, %L, %L, %L, null, 5200000, null, %L)', at.id('emp2'), at.d(-60), 'salary', 'weekly', 'Salario anual (ficticio)')) = '',
    'a salaried employee: $52,000.00 a year, paid weekly');
  perform at.ok((public.payroll_compensation_at(at.id('emp1'), at.d(6))).hourly_rate_cents = 1525 and (public.payroll_compensation_at(at.id('emp1'), at.d(-40))).hourly_rate_cents = 1400,
    'the rate in effect on each date');
  perform at.ok(at.n('member', 'select count(*) from public.employee_compensation') = 0, 'pay is private: a member sees none');
  perform at.ok(at.n('emp1u', 'select count(*) from public.employee_compensation') = 2 and at.n('emp1u', format('select count(*) from public.employee_compensation where employee_id = %L', at.id('emp2'))) = 0,
    'an employee sees only its own pay history');
  perform at.ok(at.n('other', 'select count(*) from public.employee_compensation') = 0, 'isolation: another company sees none');
  perform at.ok(at.err('other', format('select public.set_compensation(%L, %L, %L, %L, 1000, null, null, %L)', at.id('empB'), at.d(-1), 'hourly', 'weekly', 'Plan básico')) like '%EMPLOYEE_NOT_FOUND%',
    'plan: Basic has no payroll (refused by the server)');
  begin update public.employee_compensation set hourly_rate_cents = 1 where employee_id = at.id('emp1'); perform at.ok(false, 'pay history is append-only');
  exception when others then perform at.ok(sqlerrm like '%HISTORY_IMMUTABLE%', 'pay history is append-only'); end;
end $$;

-- recurring items: 2.5 % of gross for emp1, fixed $25.00 for emp2; a one-off bonus item
do $$ declare pct uuid; fix uuid; bon uuid; begin
  pct := at.val('admin', format('select public.payroll_save_item(%L, %L, %L, %L, %L, null, 250)', at.id('A'), 'RETIRO', 'Plan de retiro (ficticio)', 'deduction', 'percent'))::uuid;
  fix := at.val('admin', format('select public.payroll_save_item(%L, %L, %L, %L, %L, 2500, null)', at.id('A'), 'SEGURO', 'Seguro médico (ficticio)', 'deduction', 'fixed'))::uuid;
  bon := at.val('admin', format('select public.payroll_save_item(%L, %L, %L, %L, %L, null, null)', at.id('A'), 'BONO', 'Bonificación', 'earning', 'fixed'))::uuid;
  insert into at.ctx values ('bonus', bon);
  perform at.ok(at.err('admin', format('select public.payroll_save_item(%L, %L, %L, %L, %L, null, 500)', at.id('A'), 'PCTEARN', 'x', 'earning', 'percent')) like '%PAYROLL_ITEM_INVALID%',
    'percentages only for deductions');
  perform at.ok(at.err('admin', format('select public.payroll_save_item(%L, %L, %L, %L, %L, 1, null)', at.id('A'), 'BONO', 'x', 'earning', 'fixed')) like '%PAYROLL_ITEM_EXISTS%', 'item codes are unique');
  perform at.val('admin', format('select public.assign_payroll_item(%L, %L, null, 250, %L)', at.id('emp1'), pct, at.d(-60)));
  perform at.val('admin', format('select public.assign_payroll_item(%L, %L, 2500, null, %L)', at.id('emp2'), fix, at.d(-60)));
  perform at.ok(at.err('admin', format('select public.assign_payroll_item(%L, %L, 2500, null, %L)', at.id('emp1'), pct, at.d(-60))) like '%PAYROLL_ITEM_INVALID%',
    'an item is assigned with its own kind of value');
end $$;

-- ===================================================================== runs
do $$ declare r uuid; r2 uuid; v integer; begin
  perform at.ok(at.err('admin', format('select public.payroll_create_run(%L, %L, %L, %L, %L)', at.id('A'), 'weekly', at.d(0), at.d(7), at.d(9))) like '%PAYROLL_PERIOD_INVALID%',
    'a weekly period is 7 days');
  r := at.val('admin', format('select public.payroll_create_run(%L, %L, %L, %L, %L, %L)', at.id('A'), 'weekly', at.d(0), at.d(6), at.d(9), 'run-key-0001'))::uuid;
  r2 := at.val('admin', format('select public.payroll_create_run(%L, %L, %L, %L, %L, %L)', at.id('A'), 'weekly', at.d(0), at.d(6), at.d(9), 'run-key-0001'))::uuid;
  perform at.ok(r = r2, 'idempotent: the same request returns the same run');
  perform at.ok(at.err('admin', format('select public.payroll_create_run(%L, %L, %L, %L, %L, %L)', at.id('A'), 'weekly', at.d(0), at.d(6), at.d(9), 'run-key-0002')) like '%PAYROLL_PERIOD_EXISTS%',
    'one live run per period');
  insert into at.ctx values ('run', r);
  perform at.ok(at.err('admin', format('select public.payroll_prepare(%L, %L)', r, jsonb_build_array(jsonb_build_object('employee_id', at.id('emp1'), 'regular_minutes', 900, 'overtime_minutes', 150))))
    like '%PAYROLL_HOURS_MISMATCH%', 'hours that do not match the time clock are refused (no parallel source of hours)');
  -- with emp3's hours (no compensation): shown and blocking
  perform at.val('admin', format('select public.payroll_prepare(%L, %L)', r, jsonb_build_array(
    jsonb_build_object('employee_id', at.id('emp1'), 'regular_minutes', 960, 'overtime_minutes', 150),
    jsonb_build_object('employee_id', at.id('emp3'), 'regular_minutes', 240, 'overtime_minutes', 0))));
  perform at.ok((select blocking and 'no_compensation' = any (issues) from public.payroll_lines where run_id = r and employee_id = at.id('emp3')), 'hours without compensation: shown, blocking');
  perform at.ok(at.err('owner', format('select public.payroll_approve(%L, %s)', r, (select version from public.payroll_runs where id = r))) like '%PAYROLL_BLOCKING_ISSUES%',
    'a run with blocking issues cannot be approved');
  -- emp3 gets a monthly compensation: not part of this weekly run any more
  perform at.val('admin', format('select public.set_compensation(%L, %L, %L, %L, 1200, null, null, %L)', at.id('emp3'), at.d(-60), 'hourly', 'monthly', 'Contratación (ficticia)'));
  -- paid leave: vacation, valued at the scheduled 8 h
  update public.payroll_settings set paid_leave_types = array['vacation'] where company_id = at.id('A');
  perform at.val('admin', format('select public.payroll_prepare(%L, %L)', r, jsonb_build_array(jsonb_build_object('employee_id', at.id('emp1'), 'regular_minutes', 960, 'overtime_minutes', 150))));
  perform at.val('admin', format('select public.payroll_add_adjustment(%L, %L, %L, 5000, %L)', r, at.id('emp1'), at.id('bonus'), 'Bono de desempeño (ficticio)'));
  v := (select version from public.payroll_runs where id = r);
  perform at.ok(at.err('owner', format('select public.payroll_approve(%L, %s)', r, v)) like '%PAYROLL_NOT_PREPARED%',
    'after an adjustment the preview is stale: it must be prepared again before approval');
  perform at.val('admin', format('select public.payroll_prepare(%L, %L)', r, jsonb_build_array(jsonb_build_object('employee_id', at.id('emp1'), 'regular_minutes', 960, 'overtime_minutes', 150))));
end $$;

do $$ declare r uuid := at.id('run'); l1 record; l2 record; v integer; begin
  select * into l1 from public.payroll_lines where run_id = r and employee_id = at.id('emp1');
  select * into l2 from public.payroll_lines where run_id = r and employee_id = at.id('emp2');
  -- emp1 @ $15.25: regular 960 min = 24,400; overtime 150 min × 1.5 = 5,718.75 → 5,719; leave 480 min = 12,200; bonus 5,000
  perform at.ok(l1.regular_pay_cents = 24400 and l1.overtime_pay_cents = 5719 and l1.leave_pay_cents = 12200 and l1.other_earnings_cents = 5000 and l1.gross_cents = 47319,
    'hourly: regular, overtime (×1.5 from the rules), paid leave and bonus, exact cents (gross $473.19)');
  -- 2.5 % of 47,319 = 1,182.975 → 1,183; net 46,136
  perform at.ok(l1.deductions_cents = 1183 and l1.net_cents = 46136 and l1.taxes_cents = 0, 'percentage deduction rounded once; net = gross − deductions (no taxes calculated)');
  perform at.ok(l1.worked_minutes_verified = 1110 and l1.leave_paid_minutes = 480 and l1.overtime_multiplier = 1.5, 'hours verified against the clock; leave minutes from the schedule');
  -- emp2: 5,200,000 / 52 = 100,000; fixed 2,500 → net 97,500
  perform at.ok(l2.salary_pay_cents = 100000 and l2.deductions_cents = 2500 and l2.net_cents = 97500, 'salary: annual / 52 for weekly; fixed deduction');
  perform at.ok((select gross_cents = 147319 and deductions_cents = 3683 and net_cents = 143636 and employees = 2 and blocking_issues = 0 and tax_status = 'not_calculated'
                 from public.payroll_runs where id = r), 'run totals equal the sum of the lines; taxes marked not calculated');
  perform at.ok(not exists (select 1 from public.payroll_lines where run_id = r and employee_id = at.id('emp3')), 'an employee of another frequency is not in the run');
  perform at.ok(at.n('member', 'select count(*) from public.payroll_runs') = 0 and at.n('emp1u', 'select count(*) from public.payroll_lines') = 0,
    'a draft is visible only to payroll.view (not members, not the employee yet)');
  v := (select version from public.payroll_runs where id = r);
  perform at.ok(at.err('owner', format('select public.payroll_approve(%L, %s)', r, v - 1)) like '%PAYROLL_PREVIEW_STALE%', 'approve exactly the previewed version');
  perform at.ok(at.err('admin', format('select public.payroll_approve(%L, %s)', r, v)) like '%PAYROLL_RUN_NOT_FOUND%', 'an admin without payroll.approve cannot approve');
  perform at.ok(at.err('owner', format('select public.payroll_approve(%L, %s)', r, v)) = '', 'the owner approves');
  perform at.ok(at.err('owner', format('select public.payroll_approve(%L, %s)', r, v)) like '%PAYROLL_ALREADY_APPROVED%', 'approved once (idempotent)');
end $$;

do $$ declare r uuid := at.id('run'); e public.journal_entries; begin
  select * into e from public.journal_entries where source = 'payroll' and source_id = r;
  perform at.ok(e.total_cents = 147319 and e.entry_date = at.d(6), 'ledger: one accrual entry on the period end');
  perform at.ok((select sum(debit_cents) = sum(credit_cents) from public.journal_lines where entry_id = e.id)
            and exists (select 1 from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id where l.entry_id = e.id and a.code = '6100' and l.debit_cents = 147319)
            and exists (select 1 from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id where l.entry_id = e.id and a.code = '2200' and l.credit_cents = 143636)
            and exists (select 1 from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id where l.entry_id = e.id and a.code = '2210' and l.credit_cents = 3683),
    'balanced: Dr payroll expense 1,473.19 / Cr wages payable 1,436.36 / Cr deductions payable 36.83');
  perform at.ok(at.err('admin', format('select public.payroll_prepare(%L, %L)', r, '[]')) like '%PAYROLL_RUN_LOCKED%', 'an approved run cannot be recomputed');
  perform at.ok(at.err('admin', format('select public.payroll_add_adjustment(%L, %L, %L, 100, null)', r, at.id('emp1'), at.id('bonus'))) like '%PAYROLL_RUN_LOCKED%', 'nor adjusted');
  begin update public.payroll_lines set net_cents = 1 where run_id = r; perform at.ok(false, 'lines are locked after approval (even for the database owner)');
  exception when others then perform at.ok(sqlerrm like '%PAYROLL_RUN_LOCKED%' or sqlerrm like '%check%', 'lines are locked after approval (even for the database owner)'); end;
  perform at.ok(at.err('admin', format('select public.set_compensation(%L, %L, %L, %L, 9999, null, null, %L)', at.id('emp1'), at.d(3), 'hourly', 'weekly', 'Retroactivo')) like '%COMPENSATION_PERIOD_LOCKED%',
    'an approved period is never repriced');
  perform at.ok(at.n('emp1u', 'select count(*) from public.payroll_lines') = 1 and at.n('emp1u', 'select count(*) from public.payroll_runs') = 1
            and at.n('emp1u', format('select count(*) from public.payroll_lines where employee_id = %L', at.id('emp2'))) = 0, 'published: the employee sees only its own pay stub');
  perform at.ok(at.n('emp1u', 'select count(*) from public.payroll_line_items') = 2, 'and its own breakdown (bonus and deduction)');
  perform at.ok(at.n('other', 'select count(*) from public.payroll_lines') = 0 and at.n('member', 'select count(*) from public.payroll_lines') = 0, 'isolation and roles: nobody else');
  perform at.ok(at.err('owner', format('select public.payroll_record_payment(%L, %L, %L)', r, public.ba_today() + 3, 'ACH ficticio')) like '%PAYMENT_DATE_INVALID%', 'a payment date cannot be in the future');
  perform at.ok(at.err('owner', format('select public.payroll_record_payment(%L, %L, %L)', r, public.ba_today(), 'ACH ficticio')) = '', 'record the payment (no money is moved)');
  perform at.ok(exists (select 1 from public.journal_entries x join public.journal_lines l on l.entry_id = x.id join public.ledger_accounts a on a.id = l.account_id
                        where x.source = 'payroll_payment' and x.source_id = r and a.code = '2200' and l.debit_cents = 143636)
            and exists (select 1 from public.journal_entries x join public.journal_lines l on l.entry_id = x.id join public.ledger_accounts a on a.id = l.account_id
                        where x.source = 'payroll_payment' and x.source_id = r and a.code = '1010' and l.credit_cents = 143636), 'payment: Dr wages payable / Cr bank');
  perform at.ok(at.err('owner', format('select public.payroll_record_payment(%L, %L, %L)', r, public.ba_today(), 'otra vez')) like '%PAYROLL_ALREADY_PAID%', 'paid once');
end $$;

-- corrections and reversals
do $$ declare r uuid := at.id('run'); c uuid; v integer; n integer; begin
  c := at.val('admin', format('select public.payroll_create_correction(%L, %L)', r, public.ba_today()))::uuid;
  perform at.val('admin', format('select public.payroll_add_adjustment(%L, %L, %L, 1000, %L)', c, at.id('emp2'), at.id('bonus'), 'Diferencia omitida (ficticia)'));
  perform at.val('admin', format('select public.payroll_prepare(%L, %L)', c, '[]'));
  perform at.ok((select gross_cents = 1000 and employees = 1 from public.payroll_runs where id = c), 'a correction run carries only its adjustments');
  v := (select version from public.payroll_runs where id = c);
  perform at.ok(at.err('owner', format('select public.payroll_approve(%L, %s)', c, v)) = '', 'the correction is approved and posted on its own');
  perform at.ok(at.err('owner', format('select public.payroll_reverse(%L, %L)', r, 'Error de prueba')) like '%PAYROLL_HAS_CORRECTIONS%', 'reverse the corrections first');
  perform at.ok(at.err('owner', format('select public.payroll_reverse(%L, null)', c)) like '%REASON_REQUIRED%', 'a reversal needs a reason');
  perform at.ok(at.err('owner', format('select public.payroll_reverse(%L, %L)', c, 'Corrección duplicada (ficticia)')) = ''
            and at.err('owner', format('select public.payroll_reverse(%L, %L)', r, 'Nómina reemplazada (ficticia)')) = '', 'reversals: correction, then the paid run');
  perform at.ok((select coalesce(sum(l.debit_cents - l.credit_cents), 0) from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id
                  join public.journal_entries x on x.id = l.entry_id
                 where x.company_id = at.id('A') and x.source like 'payroll%' and a.code in ('6100', '2200', '2210', '1010')) = 0
            and (select count(*) from public.journal_entries where company_id = at.id('A') and source in ('payroll_void', 'payroll_payment_void')) = 3,
    'every payroll entry was mirrored: expense, liabilities and bank back to zero; history kept');
  perform at.ok((select status = 'reversed' and reverse_reason is not null from public.payroll_runs where id = r)
            and (select count(*) from public.payroll_lines where run_id = r) = 2, 'the reversed run and its lines stay as history');
  n := at.val('admin', format('select count(*) from (select public.payroll_create_run(%L, %L, %L, %L, %L)) x', at.id('A'), 'weekly', at.d(0), at.d(6), at.d(9)))::integer;
  perform at.ok(n = 1, 'after a reversal the period can be prepared again');
  begin delete from public.payroll_runs where id = r; perform at.ok(false, 'runs are never deleted');
  exception when others then perform at.ok(sqlerrm like '%HISTORY_IMMUTABLE%', 'runs are never deleted'); end;
  perform at.ok((select count(*) from public.payroll_events where run_id = r) >= 5, 'audit trail: created, prepared, approved, paid, reversed');
end $$;

-- open sessions, second approver, taxes
do $$ declare r uuid; v integer; begin
  r := (select id from public.payroll_runs where company_id = at.id('A') and status = 'draft' and run_type = 'regular');
  insert into public.time_punches (company_id, employee_id, kind, at, source) values (at.id('A'), at.id('emp1'), 'in', at.t(5, '08:00'), 'self');
  perform at.val('admin', format('select public.payroll_prepare(%L, %L)', r, jsonb_build_array(jsonb_build_object('employee_id', at.id('emp1'), 'regular_minutes', 960, 'overtime_minutes', 150))));
  perform at.ok((select blocking and 'open_session' = any (issues) from public.payroll_lines where run_id = r and employee_id = at.id('emp1')), 'a session without clock-out blocks the line');
  insert into public.time_punches (company_id, employee_id, kind, at, source) values (at.id('A'), at.id('emp1'), 'out', at.t(5, '09:00'), 'self');
  perform at.val('admin', format('select public.payroll_prepare(%L, %L)', r, jsonb_build_array(jsonb_build_object('employee_id', at.id('emp1'), 'regular_minutes', 1020, 'overtime_minutes', 150))));
  update public.payroll_settings set require_second_approver = true where company_id = at.id('A');
  perform at.val('owner', format('select public.payroll_prepare(%L, %L)', r, jsonb_build_array(jsonb_build_object('employee_id', at.id('emp1'), 'regular_minutes', 1020, 'overtime_minutes', 150))));
  v := (select version from public.payroll_runs where id = r);
  perform at.ok(at.err('owner', format('select public.payroll_approve(%L, %s)', r, v)) like '%SELF_APPROVAL_FORBIDDEN%', 'with a second approver required, the preparer cannot approve');
  update public.payroll_settings set require_second_approver = false where company_id = at.id('A');
  perform at.ok(not exists (select 1 from public.payroll_tax_rules where status <> 'disabled') and not exists (select 1 from public.payroll_tax_rules where rate_bp is not null),
    'taxes: placeholders only, disabled, no rates');
  begin update public.payroll_tax_rules set status = 'approved' where code = 'PR_INCOME_TAX_WITHHOLDING'; perform at.ok(false, 'a tax rule cannot be enabled without verified data');
  exception when others then perform at.ok(sqlerrm like '%check%', 'a tax rule cannot be enabled without verified data'); end;
  update public.payroll_tax_rules set status = 'approved', rate_bp = 0, effective_from = '2026-01-01', source_reference = 'prueba', approved_by = at.id('owner'), approved_at = now()
   where code = 'PR_INCOME_TAX_WITHHOLDING';
  perform at.ok(at.err('admin', format('select public.payroll_prepare(%L, %L)', r, '[]')) like '%PAYROLL_TAX_ENGINE_NOT_AVAILABLE%', 'an enabled tax rule stops payroll rather than guessing');
  update public.payroll_tax_rules set status = 'disabled', rate_bp = null, effective_from = null, source_reference = null, approved_by = null, approved_at = null
   where code = 'PR_INCOME_TAX_WITHHOLDING';
  perform at.ok(not has_function_privilege('authenticated', 'public.wf_worked_minutes(uuid, date, date)', 'EXECUTE')
            and not has_table_privilege('authenticated', 'public.payroll_runs', 'UPDATE') and not has_table_privilege('authenticated', 'public.employee_compensation', 'INSERT'),
    'no direct writes from the API; internal helpers are not callable');
end $$;

-- overnight split (same algorithm as lib/workforce/hours.ts): 22:00 → 06:30 with a 01:00–01:30 break
do $$ begin
  insert into public.time_punches (company_id, employee_id, kind, at, source) values
    (at.id('A'), at.id('emp2'), 'in', at.t(-5, '22:00'), 'self'), (at.id('A'), at.id('emp2'), 'break_start', at.t(-4, '01:00'), 'self'),
    (at.id('A'), at.id('emp2'), 'break_end', at.t(-4, '01:30'), 'self'), (at.id('A'), at.id('emp2'), 'out', at.t(-4, '06:30'), 'self');
  perform at.ok((select worked_minutes from public.wf_worked_minutes(at.id('emp2'), at.d(-5), at.d(-5))) = 480
            and (select worked_minutes from public.wf_worked_minutes(at.id('emp2'), at.d(-4), at.d(-4))) = 0, 'start day: the whole night shift counts on the day it began');
  update public.workforce_settings set overnight_attribution = 'split_midnight' where company_id = at.id('A');
  if not found then insert into public.workforce_settings (company_id, overnight_attribution) values (at.id('A'), 'split_midnight'); end if;
  perform at.ok((select worked_minutes from public.wf_worked_minutes(at.id('emp2'), at.d(-5), at.d(-5))) = 120
            and (select worked_minutes from public.wf_worked_minutes(at.id('emp2'), at.d(-4), at.d(-4))) = 360, 'split at midnight: 2 h + 6 h (break on the second day)');
end $$;

do $$ begin
  if exists (select 1 from at.failures) then
    raise exception 'PAYROLL TESTS FAILED: %', (select string_agg(msg, ' | ') from at.failures);
  end if;
  raise notice 'ALL PAYROLL TESTS PASSED';
end $$;
