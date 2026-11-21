-- Workforce (0020) test suite. TEST-ONLY, local throw-away database with
-- 0014a … 0020. Standalone fixture (schema wt): plan limits, isolation,
-- roles (manager / supervisor / employee / plain member / outsider), the
-- time clock sequence, corrections without self-approval, leave, shifts,
-- history and the live panel.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema wt;
create table wt.ctx (key text primary key, val text not null);
create function wt.v(k text) returns text language sql stable as $$ select val from wt.ctx where key = k $$;
create function wt.id(k text) returns uuid language sql stable as $$ select val::uuid from wt.ctx where key = k $$;
create table wt.failures (msg text);
create function wt.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into wt.failures values (msg); end if;
end $$;
grant usage on schema wt to authenticated;
grant select on wt.ctx to authenticated;
grant execute on all functions in schema wt to authenticated;
grant insert on wt.failures to authenticated;
create function wt.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', wt.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function wt.val(who text, q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', wt.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- Insert an employee as a user, remembering its id.
create function wt.emp(who text, k text, company text, fname text, dept text default null, mail text default null) returns text language plpgsql as $$
declare msg text; new_id uuid := gen_random_uuid(); r text;
begin
  msg := wt.err(who, format('insert into public.employees (company_id, first_name, last_name, department_id, email) values (%L, %L, %L, %L, %L)',
                wt.id(company), fname, 'Prueba', case when dept is null then null else wt.id(dept) end, mail));
  if msg = '' then
    select id::text into r from public.employees where company_id = wt.id(company) and first_name = fname order by created_at desc limit 1;
    insert into wt.ctx values (k, r) on conflict (key) do update set val = excluded.val;
  end if;
  return msg;
end $$;
create function wt.punch(who text, emp text, kind text) returns text language sql as $$
  select wt.err(who, format('select * from public.punch(%L, %L)', wt.id(emp), kind)) $$;
create function wt.last(emp text) returns text language sql stable as $$
  select kind from public.time_punches where employee_id = wt.id(emp) and voided_at is null order by at desc, created_at desc limit 1 $$;

insert into wt.ctx values
  ('owner', 'e1000000-0000-4000-8000-000000000001'), ('sup', 'e1000000-0000-4000-8000-000000000002'),
  ('member', 'e1000000-0000-4000-8000-000000000003'), ('u1', 'e1000000-0000-4000-8000-000000000004'),
  ('u2', 'e1000000-0000-4000-8000-000000000005'), ('other', 'e1000000-0000-4000-8000-000000000006'),
  ('A', 'e2000000-0000-4000-8000-000000000001'), ('B', 'e2000000-0000-4000-8000-000000000002'),
  ('D1', 'e3000000-0000-4000-8000-000000000001'), ('D2', 'e3000000-0000-4000-8000-000000000002');
insert into auth.users (id, email) values
  (wt.id('owner'), 'owner@wf.test'), (wt.id('sup'), 'sup@wf.test'), (wt.id('member'), 'member@wf.test'),
  (wt.id('u1'), 'ana@wf.test'), (wt.id('u2'), 'beto@wf.test'), (wt.id('other'), 'other@wf.test');
insert into public.companies (id, name, created_by) values (wt.id('A'), 'Taller A', wt.id('owner')), (wt.id('B'), 'Taller B', wt.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (wt.id('A'), 'cus_wt_a', 'sub_wt_a', 'basic', 'active'), (wt.id('B'), 'cus_wt_b', 'sub_wt_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (wt.id('A'), wt.id('owner'), 'owner'), (wt.id('A'), wt.id('sup'), 'member'), (wt.id('A'), wt.id('member'), 'member'),
  (wt.id('B'), wt.id('other'), 'owner');
insert into public.departments (id, company_id, name) values (wt.id('D1'), wt.id('A'), 'Taller'), (wt.id('D2'), wt.id('A'), 'Oficina');
insert into public.department_supervisors (company_id, department_id, user_id) values (wt.id('A'), wt.id('D1'), wt.id('sup'));

-- ------------------------------------------------------ employees and plan
do $$ declare members_before int := (select count(*) from public.memberships where company_id = wt.id('A')); begin
  perform wt.ok(wt.emp('member', 'x', 'A', 'Nadie') <> '', 'a plain member cannot create employees');
  perform wt.ok(wt.emp('sup', 'x', 'A', 'Nadie') <> '', 'a supervisor cannot create employees (managers only)');
  perform wt.ok(wt.emp('owner', 'e1', 'A', 'Ana', 'D1', 'ana@wf.test') = '', 'the owner creates employee 1 (Taller)');
  perform wt.ok(wt.emp('owner', 'e2', 'A', 'Beto', 'D2', 'beto@wf.test') = '', 'employee 2 (Oficina)');
  perform wt.ok(wt.emp('owner', 'e3', 'A', 'Supervisor', 'D1', 'sup@wf.test') = '', 'employee 3 (the supervisor is also an employee)');
  perform wt.ok(wt.emp('owner', 'e4', 'A', 'Cuarto') like '%PLAN_LIMIT_EMPLOYEES%', 'Basic: a 4th active employee is refused (limit 3)');
  perform wt.ok((select count(*) from public.memberships where company_id = wt.id('A')) = members_before,
                'employees use no user seat (memberships unchanged)');
  perform wt.ok(wt.err('owner', format('update public.employees set status = %L where id = %L', 'inactive', wt.id('e2'))) = '', 'an employee is deactivated');
  perform wt.ok(wt.emp('owner', 'e4', 'A', 'Cuarto') = '', 'with one inactive, a new active employee fits');
  perform wt.ok(wt.err('owner', format('update public.employees set status = %L where id = %L', 'active', wt.id('e2'))) like '%PLAN_LIMIT_EMPLOYEES%',
                'reactivating above the limit is refused');
  perform wt.ok(wt.err('owner', format('update public.employees set status = %L where id = %L', 'terminated', wt.id('e4'))) = '', 'an employee is terminated');
  perform wt.ok((select termination_date is not null from public.employees where id = wt.id('e4')), 'termination date set automatically');
  perform wt.ok(wt.err('owner', format('update public.employees set status = %L where id = %L', 'active', wt.id('e2'))) = '', 'employee 2 active again (3 of 3)');
  perform wt.ok(wt.err('owner', format('update public.employees set hourly_rate = 15.50 where id = %L', wt.id('e1'))) = '', 'the owner sets a pay rate');
  perform wt.ok(wt.err('sup', 'select hourly_rate from public.employees') like '%permission denied%', 'the pay rate column is not readable through the API');
  perform wt.ok(wt.val('owner', format('select hourly_rate from public.employee_pay(%L)', wt.id('e1'))) = '15.50', 'managers read the pay rate through employee_pay');
  perform wt.ok(wt.val('sup', format('select count(*) from public.employee_pay(%L)', wt.id('e1'))) = '0', 'supervisors do not see pay');
  perform wt.ok(wt.err('owner', format('update public.employees set company_id = %L where id = %L', wt.id('B'), wt.id('e1'))) <> '', 'an employee never moves to another company');
  perform wt.ok(wt.val('other', 'select count(*) from public.employees') = '0', 'isolation: B sees no employee of A');
  perform wt.ok(wt.val('sup', 'select count(*) from public.employees') = '2', 'the supervisor sees only its department (2 in Taller)');
  perform wt.ok(wt.val('member', 'select count(*) from public.employees') = '0', 'a plain member sees no employees');
end $$;

-- ------------------------------------------------------ login link
do $$ declare tok text; begin
  perform wt.ok(wt.err('sup', format('select public.create_employee_access(%L)', wt.id('e1'))) like '%EMPLOYEE_NOT_FOUND%', 'only managers create login links');
  perform set_config('request.jwt.claims', json_build_object('sub', wt.id('owner'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  tok := public.create_employee_access(wt.id('e1'));
  reset role;
  insert into wt.ctx values ('tok1', tok);
  perform wt.ok(tok ~ '^[0-9a-f]{64}$' and (select access_token_hash from public.employees where id = wt.id('e1')) <> tok, 'a 256-bit link; only its hash is stored');
  perform wt.ok(wt.err('u2', format('select public.claim_employee_access(%L)', tok)) like '%ACCESS_EMAIL_MISMATCH%', 'attack: another account cannot claim the link');
  perform wt.ok(wt.err('u1', format('select public.claim_employee_access(%L)', tok)) = '', 'the employee claims its link with its own account');
  perform wt.ok((select user_id from public.employees where id = wt.id('e1')) = wt.id('u1'), 'the login is linked');
  -- 0036: the same account pressing again is answered «already linked» (no change); with 0020 alone it is ACCESS_INVALID
  perform wt.ok(case when to_regprocedure('public.employee_access_check(text)') is null
                     then wt.err('u1', format('select public.claim_employee_access(%L)', tok)) like '%ACCESS_INVALID%'
                     else wt.err('u1', format('select public.claim_employee_access(%L)', tok)) = ''
                          and wt.err('u2', format('select public.claim_employee_access(%L)', tok)) like '%ACCESS_USED%' end, 'the link works once');
  perform wt.ok(wt.err('owner', format('update public.employees set user_id = %L where id = %L', wt.id('owner'), wt.id('e2'))) like '%permission denied%',
                'attack: a manager cannot attach any login by hand');
  -- link employee 3 to the supervisor's login (maintenance) for the self-approval tests
  update public.employees set user_id = wt.id('sup') where id = wt.id('e3');
  perform wt.ok(wt.val('u1', 'select count(*) from public.employees') = '1', 'the employee sees only its own record');
end $$;

-- ------------------------------------------------------ time clock
do $$ begin
  perform wt.ok(wt.punch('u1', 'e1', 'out') like '%PUNCH_SEQUENCE%', 'the first punch must be an entry');
  perform wt.ok(wt.punch('u1', 'e1', 'in') = '', 'the employee clocks in');
  perform wt.ok((select abs(extract(epoch from (at - now()))) < 5 from public.time_punches where employee_id = wt.id('e1') order by at desc limit 1),
                'the time is the server time');
  perform wt.ok(wt.punch('u1', 'e1', 'in') like '%PUNCH_SEQUENCE%', 'no duplicate entry');
  perform wt.ok(wt.punch('u1', 'e1', 'break_end') like '%PUNCH_SEQUENCE%', 'no break end without a break');
  perform wt.ok(wt.punch('u1', 'e2', 'in') like '%EMPLOYEE_NOT_FOUND%', 'an employee cannot punch for someone else');
  perform wt.ok(wt.punch('member', 'e1', 'break_start') like '%EMPLOYEE_NOT_FOUND%', 'a plain member cannot punch');
  perform wt.ok(wt.punch('other', 'e1', 'break_start') like '%EMPLOYEE_NOT_FOUND%', 'isolation: B cannot punch A''s employee');
  perform wt.ok(wt.err('u1', format('insert into public.time_punches (company_id, employee_id, kind, at, source) values (%L, %L, %L, now() - interval ''3 hours'', %L)',
                wt.id('A'), wt.id('e1'), 'in', 'self')) like '%permission denied%', 'attack: no direct insert of a back-dated punch');
  perform wt.ok(wt.err('u1', format('update public.time_punches set at = at - interval ''2 hours'' where employee_id = %L', wt.id('e1'))) like '%permission denied%',
                'attack: no editing of punch times');
  perform pg_sleep(0.01);
  perform wt.ok(wt.punch('u1', 'e1', 'break_start') = '', 'break starts');
  perform pg_sleep(0.01);
  perform wt.ok(wt.punch('u1', 'e1', 'break_end') = '', 'break ends');
  perform pg_sleep(0.01);
  perform wt.ok(wt.punch('sup', 'e1', 'out') = '', 'the supervisor clocks the employee out (kiosk)');
  perform wt.ok((select source from public.time_punches where employee_id = wt.id('e1') order by at desc limit 1) = 'supervisor'
                and (select recorded_by from public.time_punches where employee_id = wt.id('e1') order by at desc limit 1) = wt.id('sup'),
                'it is recorded as a supervisor punch, with who did it');
  perform wt.ok(wt.punch('sup', 'e2', 'in') like '%EMPLOYEE_NOT_FOUND%', 'a supervisor cannot punch outside its department');
  perform wt.ok(wt.val('u1', format('select count(*) from public.time_punches where employee_id = %L', wt.id('e1'))) = '4', 'the employee sees its 4 punches');
  perform wt.ok(wt.val('u1', 'select count(*) from public.time_punches') = '4', '… and no one else''s');
  perform wt.ok(wt.val('other', 'select count(*) from public.time_punches') = '0', 'isolation: B sees no punches of A');
  perform wt.ok(wt.punch('owner', 'e4', 'in') like '%EMPLOYEE_INACTIVE%', 'a terminated employee cannot punch');
end $$;

-- ------------------------------------------------------ corrections
do $$ declare c1 uuid; c2 uuid; c3 uuid; pout uuid; begin
  select id into pout from public.time_punches where employee_id = wt.id('e1') and kind = 'out' and voided_at is null;
  perform wt.ok(wt.err('u1', format('select public.request_punch_correction(%L, %L, null, %L, now() + interval ''1 hour'', %L)', wt.id('e1'), 'add', 'in', 'olvidé')) like '%CORRECTION_TIME_INVALID%',
                'no correction into the future');
  perform wt.ok(wt.err('u1', format('select public.request_punch_correction(%L, %L, %L, %L, now() - interval ''1 minute'', %L)', wt.id('e1'), 'change', pout, 'out', 'x')) like '%CORRECTION_REASON_REQUIRED%',
                'a reason is required');
  perform set_config('request.jwt.claims', json_build_object('sub', wt.id('u1'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  c1 := public.request_punch_correction(wt.id('e1'), 'change', pout, 'out', clock_timestamp() - interval '1 millisecond', 'Salí más tarde: estaba cerrando el taller');
  -- an "add" that breaks the sequence: an entry before the first entry with nothing closing it
  c2 := public.request_punch_correction(wt.id('e1'), 'add', null, 'out', now() - interval '20 days', 'Prueba de secuencia inválida');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform wt.ok(c1 is not null and c2 is not null, 'the employee requests corrections');
  perform wt.ok(wt.err('u1', format('select public.decide_punch_correction(%L, true)', c1)) like '%CORRECTION_NOT_FOUND%', 'an employee cannot approve its own correction');
  perform wt.ok(wt.err('member', format('select public.decide_punch_correction(%L, true)', c1)) like '%CORRECTION_NOT_FOUND%', 'a plain member cannot approve');
  perform wt.ok(wt.err('other', format('select public.decide_punch_correction(%L, true)', c1)) like '%CORRECTION_NOT_FOUND%', 'isolation: B cannot approve');
  perform wt.ok(wt.err('sup', format('select public.decide_punch_correction(%L, true, %L)', c1, 'ok')) = '', 'the supervisor approves');
  perform wt.ok((select voided_at is not null and voided_by = wt.id('sup') from public.time_punches where id = pout), 'the old punch is voided, with who voided it');
  perform wt.ok((select source from public.time_punches where correction_id = c1) = 'correction', 'the corrected punch is added and linked to the correction');
  perform wt.ok((select decided_by = wt.id('sup') and status = 'approved' from public.punch_corrections where id = c1), 'the decision records who approved');
  perform wt.ok(wt.err('sup', format('select public.decide_punch_correction(%L, true)', c1)) like '%CORRECTION_NOT_PENDING%', 'a correction is decided once');
  perform wt.ok(wt.err('sup', format('select public.decide_punch_correction(%L, true)', c2)) like '%CORRECTION_INVALID_SEQUENCE%',
                'an approval that would break the in/out sequence is refused');
  perform wt.ok((select status from public.punch_corrections where id = c2) = 'pending', '… and changes nothing');
  perform wt.ok(wt.err('sup', format('select public.decide_punch_correction(%L, false, %L)', c2, 'no')) = '', 'the supervisor rejects it');
  -- the supervisor is also employee 3: it cannot approve its own correction
  perform set_config('request.jwt.claims', json_build_object('sub', wt.id('sup'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.punch(wt.id('e3'), 'in');
  c3 := public.request_punch_correction(wt.id('e3'), 'add', null, 'in', now() - interval '2 days', 'Olvidé ponchar el lunes');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform wt.ok(wt.err('sup', format('select public.decide_punch_correction(%L, true)', c3)) like '%SELF_APPROVAL_FORBIDDEN%',
                'a supervisor cannot approve a correction of its own attendance');
  perform wt.ok(wt.err('owner', format('select public.decide_punch_correction(%L, false, %L)', c3, 'falta la salida')) = '', 'the owner decides it instead');
end $$;

-- ------------------------------------------------------ leave
do $$ declare l1 uuid; begin
  perform set_config('request.jwt.claims', json_build_object('sub', wt.id('u1'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  l1 := public.request_leave(wt.id('e1'), 'vacation', current_date + 10, current_date + 14, null, 'Vacaciones de familia');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform wt.ok(l1 is not null, 'the employee requests vacation');
  perform wt.ok(wt.err('u1', format('select public.request_leave(%L, %L, current_date + 12, current_date + 13, null, null)', wt.id('e1'), 'personal')) like '%LEAVE_OVERLAP%',
                'overlapping requests are refused');
  perform wt.ok(wt.err('u1', format('select public.request_leave(%L, %L, current_date + 3, current_date + 2, null, null)', wt.id('e1'), 'sick')) like '%LEAVE_DATES_INVALID%', 'dates in order');
  perform wt.ok(wt.err('u1', format('select public.decide_leave(%L, true)', l1)) like '%LEAVE_NOT_FOUND%', 'an employee cannot approve its own leave');
  perform wt.ok(wt.err('sup', format('select public.decide_leave(%L, true, %L)', l1, 'aprobado')) = '', 'the supervisor approves the vacation');
  perform wt.ok(wt.err('u1', format('select public.cancel_leave(%L)', l1)) like '%LEAVE_NOT_PENDING%', 'an approved leave is not cancelled by the employee alone');
  perform wt.ok(wt.err('u1', format('select public.request_leave(%L, %L, current_date + 30, current_date + 30, 120, %L)', wt.id('e1'), 'personal', 'cita médica')) = '',
                'a partial day (2 hours) can be requested');
end $$;

-- ------------------------------------------------------ shifts
do $$ begin
  perform wt.ok(wt.err('sup', format('insert into public.work_shifts (company_id, employee_id, starts_at, ends_at, break_minutes) values (%L, %L, %L, %L, 30)',
                wt.id('A'), wt.id('e1'), '2030-01-07 08:00-04', '2030-01-07 17:00-04')) = '', 'the supervisor schedules a shift');
  perform wt.ok(wt.err('sup', format('insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (%L, %L, %L, %L)',
                wt.id('A'), wt.id('e1'), '2030-01-07 16:00-04', '2030-01-07 20:00-04')) like '%SHIFT_OVERLAP%', 'overlapping shifts are refused');
  perform wt.ok(wt.err('sup', format('insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (%L, %L, %L, %L)',
                wt.id('A'), wt.id('e2'), '2030-01-07 08:00-04', '2030-01-07 12:00-04')) like '%row-level security%', 'not outside its department');
  perform wt.ok(wt.err('u1', format('insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (%L, %L, %L, %L)',
                wt.id('A'), wt.id('e1'), '2030-01-08 08:00-04', '2030-01-08 12:00-04')) <> '', 'an employee cannot schedule itself');
  perform wt.ok(wt.val('u1', 'select count(*) from public.work_shifts') = '1', 'the employee sees its schedule');
end $$;

-- ------------------------------------------------------ history, live panel, plan
do $$ begin
  perform wt.ok(exists (select 1 from public.workforce_events where entity = 'punch_corrections' and action = 'approved' and actor = wt.id('sup')),
                'history: the approval and its actor');
  perform wt.ok(exists (select 1 from public.workforce_events where entity = 'employees' and action = 'update' and details -> 'fields' ? 'hourly_rate'),
                'history: which employee fields changed');
  perform wt.ok(wt.val('u1', 'select count(*) from public.workforce_events') = '0', 'employees do not read the company history');
  perform wt.ok(wt.err('owner', 'delete from public.workforce_events') like '%permission denied%', 'the history cannot be deleted through the API');
  perform wt.ok(wt.val('owner', format('select state from public.workforce_now(%L) where employee_id = %L', wt.id('A'), wt.id('e3'))) = 'in',
                'live panel: employee 3 is in');
  perform wt.ok(wt.val('owner', format('select state from public.workforce_now(%L) where employee_id = %L', wt.id('A'), wt.id('e1'))) = 'out',
                'live panel: employee 1 is out');
  perform wt.ok(wt.val('other', format('select count(*) from public.workforce_now(%L)', wt.id('A'))) = '0', 'isolation: B sees nobody on A''s panel');
end $$;
update public.company_subscriptions set status = 'canceled' where company_id = 'e2000000-0000-4000-8000-000000000001';
do $$ begin
  perform wt.ok(wt.punch('u1', 'e1', 'in') like '%TIME_CLOCK_UNAVAILABLE%', 'without an active plan the time clock stops');
end $$;

do $$ begin
  if exists (select 1 from wt.failures) then
    raise exception 'WORKFORCE TESTS FAILED: %', (select string_agg(msg, '; ') from wt.failures);
  end if;
  raise notice 'ALL WORKFORCE TESTS PASSED';
end $$;
