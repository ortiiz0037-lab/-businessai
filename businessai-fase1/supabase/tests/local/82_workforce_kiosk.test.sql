-- Kiosk PIN mode, append-only evidence and supervisor scope (0021).
-- TEST-ONLY, local throw-away database with 0014a … 0021. Schema kt.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema kt;
create table kt.ctx (key text primary key, val text not null);
create function kt.v(k text) returns text language sql stable as $$ select val from kt.ctx where key = k $$;
create function kt.id(k text) returns uuid language sql stable as $$ select val::uuid from kt.ctx where key = k $$;
create table kt.failures (msg text);
create function kt.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into kt.failures values (msg); end if;
end $$;
grant usage on schema kt to anon, authenticated;
grant select on kt.ctx to anon, authenticated;
grant execute on all functions in schema kt to anon, authenticated;
grant insert on kt.failures to anon, authenticated;
-- As a user ('' = anon, the tablet): error text or ''.
create function kt.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  if who = '' then perform set_config('request.jwt.claims', '', true); set local role anon;
  else perform set_config('request.jwt.claims', json_build_object('sub', kt.id(who), 'role', 'authenticated')::text, true); set local role authenticated; end if;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function kt.val(who text, q text) returns text language plpgsql as $$
declare r text;
begin
  if who = '' then perform set_config('request.jwt.claims', '', true); set local role anon;
  else perform set_config('request.jwt.claims', json_build_object('sub', kt.id(who), 'role', 'authenticated')::text, true); set local role authenticated; end if;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- Kiosk punch from the (anonymous) tablet: "status|first_name|kind".
create function kt.kiosk(tok text, num text, pin text, kind text) returns text language sql as $$
  select kt.val('', format('select status || ''|'' || coalesce(first_name, '''') || ''|'' || coalesce(kind, '''') from public.kiosk_punch(%L, %L, %L, %L)', tok, num, pin, kind)) $$;
-- Maintenance statement (no user, like service_role / SQL editor).
create function kt.sys(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', '', true);
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;

insert into kt.ctx values
  ('owner', 'a7000000-0000-4000-8000-000000000001'), ('sup', 'a7000000-0000-4000-8000-000000000002'),
  ('member', 'a7000000-0000-4000-8000-000000000003'), ('u1', 'a7000000-0000-4000-8000-000000000004'),
  ('u2', 'a7000000-0000-4000-8000-000000000005'), ('other', 'a7000000-0000-4000-8000-000000000006'),
  ('A', 'a8000000-0000-4000-8000-000000000001'), ('B', 'a8000000-0000-4000-8000-000000000002'),
  ('D1', 'a9000000-0000-4000-8000-000000000001'), ('D2', 'a9000000-0000-4000-8000-000000000002'),
  ('e1', 'aa000000-0000-4000-8000-000000000001'), ('e2', 'aa000000-0000-4000-8000-000000000002'),
  ('eB', 'aa000000-0000-4000-8000-000000000009');
insert into auth.users (id, email) select val::uuid, key || '@kt.test' from kt.ctx where key in ('owner', 'sup', 'member', 'u1', 'u2', 'other');
insert into public.companies (id, name, created_by) values (kt.id('A'), 'Quiosco A', kt.id('owner')), (kt.id('B'), 'Quiosco B', kt.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (kt.id('A'), 'cus_kt_a', 'sub_kt_a', 'pro', 'active'), (kt.id('B'), 'cus_kt_b', 'sub_kt_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (kt.id('A'), kt.id('owner'), 'owner'), (kt.id('A'), kt.id('sup'), 'member'), (kt.id('A'), kt.id('member'), 'member'), (kt.id('B'), kt.id('other'), 'owner');
insert into public.departments (id, company_id, name) values (kt.id('D1'), kt.id('A'), 'Taller'), (kt.id('D2'), kt.id('A'), 'Oficina');
insert into public.department_supervisors (company_id, department_id, user_id) values (kt.id('A'), kt.id('D1'), kt.id('sup'));
insert into public.employees (id, company_id, first_name, last_name, employee_number, department_id, user_id, email) values
  (kt.id('e1'), kt.id('A'), 'Ana', 'Rivera', '7', kt.id('D1'), kt.id('u1'), 'u1@kt.test'),
  (kt.id('e2'), kt.id('A'), 'Beto', 'Soto', '8', kt.id('D2'), kt.id('u2'), 'u2@kt.test'),
  (kt.id('eB'), kt.id('B'), 'Carla', 'Vega', '7', null, null, null);

-- ------------------------------------------------------ PINs
do $$ begin
  perform kt.ok(kt.err('u1', format('select public.set_employee_pin(%L, %L)', kt.id('e1'), '1234')) like '%PIN_TOO_SIMPLE%', 'a sequential PIN is refused');
  perform kt.ok(kt.err('u1', format('select public.set_employee_pin(%L, %L)', kt.id('e1'), '0000')) like '%PIN_TOO_SIMPLE%', 'a repeated-digit PIN is refused');
  perform kt.ok(kt.err('u1', format('select public.set_employee_pin(%L, %L)', kt.id('e1'), '9876')) like '%PIN_TOO_SIMPLE%', 'a descending PIN is refused');
  perform kt.ok(kt.err('u1', format('select public.set_employee_pin(%L, %L)', kt.id('e1'), '12a4')) like '%PIN_INVALID%', 'only 4–8 digits');
  perform kt.ok(kt.err('u1', format('select public.set_employee_pin(%L, %L)', kt.id('e1'), '4829')) = '', 'the employee sets its own PIN');
  perform kt.ok(kt.err('u1', format('select public.set_employee_pin(%L, %L)', kt.id('e2'), '5917')) like '%EMPLOYEE_NOT_FOUND%', 'an employee cannot set another employee''s PIN');
  perform kt.ok(kt.err('sup', format('select public.set_employee_pin(%L, %L)', kt.id('e1'), '5917')) like '%EMPLOYEE_NOT_FOUND%', 'a supervisor cannot set PINs (manager or the employee only)');
  perform kt.ok(kt.err('owner', format('select public.set_employee_pin(%L, %L)', kt.id('e2'), '4829')) = '', 'the owner sets employee 2''s PIN (same digits as employee 1)');
  perform kt.ok((select count(distinct pin_hash) from public.employee_pins) = 2 and not exists (select 1 from public.employee_pins where pin_hash like '%4829%'),
                'salted hashes: the same PIN gives different hashes and never appears in clear');
  perform kt.ok(kt.err('owner', 'select * from public.employee_pins') like '%permission denied%', 'nobody reads PIN hashes through the API (not even the owner)');
  perform kt.ok(kt.val('sup', format('select pin_set::text from public.employee_pin_status(%L)', kt.id('e1'))) = 'true', 'a supervisor sees only whether a PIN is set');
  perform kt.ok(kt.val('u2', format('select count(*) from public.employee_pin_status(%L)', kt.id('e1'))) = '0', 'an employee learns nothing about another''s PIN');
end $$;

-- ------------------------------------------------------ kiosk
do $$ declare tok text; tokB text; r text; i int; begin
  perform kt.ok(kt.err('sup', format('select public.create_kiosk(%L, %L)', kt.id('A'), 'Entrada')) like '%FORBIDDEN%', 'a supervisor cannot register kiosks');
  perform set_config('request.jwt.claims', json_build_object('sub', kt.id('owner'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  tok := public.create_kiosk(kt.id('A'), 'Tablet de la entrada');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', kt.id('other'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  tokB := public.create_kiosk(kt.id('B'), 'Tablet B');
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into kt.ctx values ('tok', tok), ('tokB', tokB);
  perform kt.ok(tok ~ '^[0-9a-f]{64}$' and not exists (select 1 from public.time_clock_kiosks where token_hash = tok), 'a 256-bit kiosk token; only its hash is stored');
  perform kt.ok(kt.err('owner', 'select token_hash from public.time_clock_kiosks') like '%permission denied%', 'the kiosk token hash is not readable through the API');
  perform kt.ok(kt.val('', format('select company_name || '' / '' || kiosk_name from public.kiosk_info(%L)', tok)) = 'Quiosco A / Tablet de la entrada', 'the tablet shows its company and name');
  perform kt.ok(kt.val('', format('select count(*) from public.kiosk_info(%L)', repeat('0', 64))) = '0', 'a guessed token shows nothing');
  perform kt.ok(kt.kiosk(tok, '7', '4829', 'in') = 'ok|Ana|in', 'Ana punches in at the tablet with number + PIN (no account on the tablet)');
  perform kt.ok((select source = 'kiosk' and recorded_by is null and kiosk_id is not null from public.time_punches where employee_id = kt.id('e1')),
                'the punch is recorded as a kiosk punch, with the kiosk');
  perform kt.ok(exists (select 1 from public.workforce_events where employee_id = kt.id('e1') and details ->> 'source' = 'kiosk' and details ? 'kiosk_id'),
                'the history names the kiosk');
  perform kt.ok(kt.kiosk(tok, '7', '4829', 'in') = 'sequence|Ana|', 'no duplicate entry from the tablet');
  perform kt.ok(kt.err('', 'select count(*) from public.time_punches') like '%permission denied%', 'the tablet (anon) cannot read punches');
  perform kt.ok(kt.err('', 'select count(*) from public.employees') like '%permission denied%', 'the tablet (anon) cannot list employees');
  perform kt.ok(kt.kiosk(tok, '7', '1111', 'out') = 'invalid||', 'wrong PIN: generic answer');
  perform kt.ok(kt.kiosk(tok, '999', '4829', 'out') = 'invalid||', 'unknown number: the same answer (no employee enumeration)');
  perform kt.ok(kt.kiosk(tokB, '8', '4829', 'in') = 'invalid||', 'isolation: B''s tablet cannot punch A''s employee with A''s PIN');
  for i in 1 .. 4 loop perform kt.kiosk(tok, '7', '1111', 'out'); end loop;
  perform kt.ok((select locked_until > now() from public.employee_pins where employee_id = kt.id('e1')), 'five wrong PINs lock the employee PIN (the counter is really stored)');
  perform kt.ok(kt.kiosk(tok, '7', '4829', 'out') = 'invalid||', 'while locked even the right PIN gets the generic answer');
  perform kt.ok(exists (select 1 from public.workforce_events where action = 'pin_locked' and employee_id = kt.id('e1')), 'the lock is recorded');
  perform kt.ok(kt.err('owner', format('select public.set_employee_pin(%L, %L)', kt.id('e1'), '3857')) = '', 'a manager resets the PIN (unlocks)');
  perform kt.ok(kt.kiosk(tok, '7', '3857', 'out') = 'ok|Ana|out', 'Ana punches out with the new PIN');
  for i in 1 .. 20 loop perform kt.kiosk(tok, '555', '0001', 'in'); end loop;
  perform kt.ok(kt.kiosk(tok, '8', '4829', 'in') = 'kiosk_locked||', 'twenty failures lock the tablet for 10 minutes');
  update public.time_clock_kiosks set failed_window_start = now() - interval '11 minutes' where name = 'Tablet de la entrada';
  perform kt.ok(kt.kiosk(tok, '8', '4829', 'in') = 'ok|Beto|in', 'after the window the tablet works again');
  perform kt.ok(kt.err('owner', format('select public.revoke_kiosk(%L)', (select id from public.time_clock_kiosks where name = 'Tablet de la entrada'))) = '', 'the owner revokes the tablet');
  perform kt.ok(kt.kiosk(tok, '8', '4829', 'out') = 'kiosk_invalid||', 'a revoked tablet stops at once');
end $$;

-- ------------------------------------------------------ evidence is append-only (also for maintenance)
do $$ declare c uuid; l uuid; pid uuid; begin
  select id into pid from public.time_punches where employee_id = kt.id('e2') limit 1;
  perform kt.ok(kt.sys('update public.workforce_events set actor = null') like '%HISTORY_IMMUTABLE%', 'history: never updated, not even by maintenance');
  perform kt.ok(kt.sys('delete from public.workforce_events') like '%HISTORY_IMMUTABLE%', 'history: never deleted');
  perform kt.ok(kt.sys(format('delete from public.time_punches where id = %L', pid)) like '%HISTORY_IMMUTABLE%', 'punches: never deleted');
  perform kt.ok(kt.sys(format('update public.time_punches set at = at - interval ''1 hour'' where id = %L', pid)) like '%HISTORY_IMMUTABLE%', 'punches: the time never changes');
  perform kt.ok(kt.sys(format('update public.time_punches set voided_at = now(), void_reason = %L where id = %L', 'prueba', pid)) = '', 'a punch can be voided once');
  perform kt.ok(kt.sys(format('update public.time_punches set voided_at = null where id = %L', pid)) like '%HISTORY_IMMUTABLE%', 'a voided punch cannot be restored or edited');
  -- corrections
  perform set_config('request.jwt.claims', json_build_object('sub', kt.id('u1'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  c := public.request_punch_correction(kt.id('e1'), 'add', null, 'break_start', clock_timestamp() - interval '2 days', 'Olvidé el descanso');
  l := public.request_leave(kt.id('e1'), 'sick', current_date + 3, current_date + 3, null, 'Cita');
  perform public.cancel_punch_correction(c);
  reset role; perform set_config('request.jwt.claims', '', true);
  perform kt.ok((select decided_by = kt.id('u1') and status = 'cancelled' from public.punch_corrections where id = c), 'a cancellation records who cancelled');
  perform kt.ok(kt.sys(format('update public.punch_corrections set status = %L where id = %L', 'approved', c)) like '%HISTORY_IMMUTABLE%', 'a decided correction never changes');
  perform kt.ok(kt.sys(format('update public.leave_requests set starts_on = starts_on - 1 where id = %L', l)) like '%HISTORY_IMMUTABLE%', 'a pending request''s content cannot be edited');
  perform kt.ok(kt.err('sup', format('select public.decide_leave(%L, true)', l)) = '', 'the supervisor approves the leave');
  perform kt.ok(kt.sys(format('update public.leave_requests set decided_by = null where id = %L', l)) like '%HISTORY_IMMUTABLE%', 'who approved can never be erased');
  perform kt.ok(kt.err('sup', format('select public.cancel_leave(%L)', l)) = '', 'an approved leave can still be cancelled by a supervisor');
  perform kt.ok((select decided_by = kt.id('sup') and status = 'cancelled' from public.leave_requests where id = l), '… recording who cancelled it');
  perform kt.ok(kt.err('owner', 'update public.punch_corrections set reason = ''x''') like '%permission denied%', 'users cannot even attempt to edit corrections');
end $$;

-- ------------------------------------------------------ supervisor scope
do $$ begin
  perform kt.ok(kt.val('sup', 'select count(*) from public.employees') = '1', 'the Taller supervisor sees only its department''s employee');
  perform kt.ok(kt.val('sup', format('select count(*) from public.time_punches where employee_id = %L', kt.id('e2'))) = '0', 'no punches of other departments');
  perform kt.ok(kt.val('sup', format('select count(*) from public.workforce_events where employee_id = %L', kt.id('e2'))) = '0', 'no history of other departments');
  perform kt.ok(kt.val('sup', format('select count(*) from public.workforce_now(%L)', kt.id('A'))) = '1', 'the live panel shows only its department');
  perform kt.ok(kt.val('sup', format('select count(*) from public.employee_pay(%L)', kt.id('e1'))) = '0', 'no pay rates for supervisors');
  perform kt.ok(kt.val('member', 'select count(*) from public.employees') = '0', 'a plain member sees no workforce data');
  update public.memberships set status = 'suspended' where user_id = kt.id('sup') and company_id = kt.id('A');
  perform kt.ok(kt.val('sup', 'select count(*) from public.employees') = '0', 'a suspended supervisor loses access at once');
  perform kt.ok(kt.err('sup', format('select * from public.punch(%L, %L)', kt.id('e1'), 'in')) like '%EMPLOYEE_NOT_FOUND%', '… and cannot punch for its department');
  update public.memberships set status = 'active' where user_id = kt.id('sup') and company_id = kt.id('A');
  delete from public.department_supervisors where user_id = kt.id('sup');
  perform kt.ok(kt.val('sup', 'select count(*) from public.employees') = '0', 'removed from the department: no access');
end $$;

-- ------------------------------------------------------ company deletion still works
do $$ begin
  perform kt.ok(kt.sys(format('delete from public.companies where id = %L', kt.id('B'))) = '', 'deleting a whole company still removes its evidence (cascade) ' || kt.sys(format('delete from public.companies where id = %L', kt.id('B'))));
end $$;

do $$ begin
  if exists (select 1 from kt.failures) then
    raise exception 'KIOSK TESTS FAILED: %', (select string_agg(msg, '; ') from kt.failures);
  end if;
  raise notice 'ALL KIOSK TESTS PASSED';
end $$;
