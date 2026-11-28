-- Rules per employee / group, jurisdiction templates, meal alerts (0022).
-- TEST-ONLY, local throw-away database with 0014a … 0022. Schema mr.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema mr;
create table mr.ctx (key text primary key, val text not null);
create function mr.id(k text) returns uuid language sql stable as $$ select val::uuid from mr.ctx where key = k $$;
create table mr.failures (msg text);
create function mr.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into mr.failures values (msg); end if;
end $$;
grant usage on schema mr to authenticated;
grant select on mr.ctx to authenticated;
grant execute on all functions in schema mr to authenticated;
grant insert on mr.failures to authenticated;
create function mr.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', mr.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function mr.val(who text, q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', mr.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- Punches in the past (maintenance), minutes before now.
create function mr.p(emp text, kind text, mins_ago int) returns void language sql as $$
  insert into public.time_punches (company_id, employee_id, kind, at, source)
  select company_id, id, kind, now() - make_interval(mins => mins_ago), 'correction' from public.employees where id = mr.id(emp) $$;
-- A whole session in ONE statement (as it exists when evaluated).
create function mr.ps(emp text, kinds text[], mins int[]) returns void language sql as $$
  insert into public.time_punches (company_id, employee_id, kind, at, source)
  select e.company_id, e.id, k.kind, now() - make_interval(mins => k.m), 'correction'
  from public.employees e, unnest(kinds, mins) as k(kind, m) where e.id = mr.id(emp) $$;
create function mr.alerts(emp text) returns text language sql stable as $$
  select coalesce(string_agg(kind, ',' order by kind), '') from public.meal_alerts where employee_id = mr.id(emp) $$;

insert into mr.ctx values
  ('owner', 'b7000000-0000-4000-8000-000000000001'), ('sup', 'b7000000-0000-4000-8000-000000000002'), ('u1', 'b7000000-0000-4000-8000-000000000003'),
  ('other', 'b7000000-0000-4000-8000-000000000004'), ('A', 'b8000000-0000-4000-8000-000000000001'), ('B', 'b8000000-0000-4000-8000-000000000002'),
  ('D1', 'b9000000-0000-4000-8000-000000000001'),
  ('e1', 'ba000000-0000-4000-8000-000000000001'), ('e2', 'ba000000-0000-4000-8000-000000000002'), ('e3', 'ba000000-0000-4000-8000-000000000003'),
  ('e4', 'ba000000-0000-4000-8000-000000000004'), ('e5', 'ba000000-0000-4000-8000-000000000005');
insert into auth.users (id, email) select val::uuid, key || '@mr.test' from mr.ctx where key in ('owner', 'sup', 'u1', 'other');
insert into public.companies (id, name, created_by) values (mr.id('A'), 'Reglas A', mr.id('owner')), (mr.id('B'), 'Reglas B', mr.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (mr.id('A'), 'cus_mr_a', 'sub_mr_a', 'premium', 'active'), (mr.id('B'), 'cus_mr_b', 'sub_mr_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values
  (mr.id('A'), mr.id('owner'), 'owner'), (mr.id('A'), mr.id('sup'), 'member'), (mr.id('B'), mr.id('other'), 'owner');
insert into public.departments (id, company_id, name) values (mr.id('D1'), mr.id('A'), 'Cocina');
insert into public.department_supervisors (company_id, department_id, user_id) values (mr.id('A'), mr.id('D1'), mr.id('sup'));
insert into public.employees (id, company_id, first_name, last_name, department_id, user_id) values
  (mr.id('e1'), mr.id('A'), 'Uno', 'X', mr.id('D1'), mr.id('u1')), (mr.id('e2'), mr.id('A'), 'Dos', 'X', mr.id('D1'), null),
  (mr.id('e3'), mr.id('A'), 'Tres', 'X', mr.id('D1'), null), (mr.id('e4'), mr.id('A'), 'Cuatro', 'X', mr.id('D1'), null),
  (mr.id('e5'), mr.id('A'), 'Cinco', 'X', mr.id('D1'), null);

-- ------------------------------------------------------ jurisdictions and groups
do $$ declare g uuid; begin
  perform mr.ok((select count(*) from public.labor_jurisdictions where code in ('PR', 'US-FED', 'US-CA', 'CUSTOM')) = 4, 'four reference templates');
  perform mr.ok((select bool_and(note_es ilike '%no es asesoría legal%' or code = 'CUSTOM') from public.labor_jurisdictions), 'every template says it is not legal advice');
  perform mr.ok(mr.val('sup', format('select coalesce(meal_break_after_minutes::text, ''none'') from public.wf_rules(%L)', mr.id('e1'))) = 'none',
                'nothing is assumed: without a template there are no meal rules');
  perform mr.ok(mr.err('sup', format('select public.apply_jurisdiction_template(%L, %L)', mr.id('A'), 'PR')) like '%FORBIDDEN%', 'only managers apply templates');
  perform mr.ok(mr.err('owner', format('select public.apply_jurisdiction_template(%L, %L)', mr.id('A'), 'PR')) = '', 'the owner applies the Puerto Rico template to the company');
  perform mr.ok(mr.val('sup', format('select jurisdiction || ''/'' || meal_break_after_minutes || ''/'' || meal_break_min_minutes || ''/'' || daily_overtime_after_minutes from public.wf_rules(%L)', mr.id('e1'))) = 'PR/300/60/480',
                'the employee follows the company defaults (PR reference)');
  perform mr.ok(mr.err('sup', format('insert into public.labor_rule_sets (company_id, name) values (%L, %L)', mr.id('A'), 'X')) like '%row-level security%', 'supervisors cannot create rule groups');
  perform mr.ok(mr.err('owner', format('insert into public.labor_rule_sets (company_id, name, jurisdiction, exempt, daily_overtime_after_minutes, weekly_overtime_after_minutes) values (%L, %L, %L, true, null, null)',
                mr.id('A'), 'Exentos', 'CUSTOM')) = '', 'the owner creates an exempt group without meal rules');
  select id into g from public.labor_rule_sets where name = 'Exentos';
  insert into mr.ctx values ('gEx', g);
  perform mr.ok(mr.err('owner', format('insert into public.labor_rule_sets (company_id, name, weekly_overtime_after_minutes, meal_break_after_minutes, meal_break_min_minutes) values (%L, %L, 2640, 360, 30)',
                mr.id('A'), 'Convenio 44h')) = '', 'a group with its own agreement (44 h weekly, meal after 6 h)');
  perform mr.ok(mr.err('owner', format('update public.employees set rule_set_id = %L where id = %L', g, mr.id('e5'))) = '', 'employee 5 joins the exempt group');
  perform mr.ok(mr.val('owner', format('select source || ''/'' || exempt from public.wf_rules(%L)', mr.id('e5'))) = 'group/true', 'its rules come from the group');
  perform mr.ok(mr.err('other', format('insert into public.labor_rule_sets (company_id, name) values (%L, %L)', mr.id('B'), 'Exentos B')) = '', 'company B has its own group');
  perform mr.ok(mr.err('owner', format('update public.employees set rule_set_id = %L where id = %L', (select id from public.labor_rule_sets where name = 'Exentos B'), mr.id('e4'))) like '%RULE_SET_INVALID%',
                'isolation: an employee cannot use another company''s group');
  perform mr.ok(mr.val('other', format('select count(*) from public.labor_rule_sets where company_id = %L', mr.id('A'))) = '0', 'isolation: B sees no group of A');
  perform mr.ok(mr.val('other', format('select count(*) from public.wf_rules(%L)', mr.id('e1'))) = '0', 'isolation: B reads no rules of A''s employees');
end $$;

-- ------------------------------------------------------ meal alerts (PR: meal before 300 min, 60 min, alert 15 min before)
do $$ begin
  perform mr.p('e1', 'in', 290);                                             -- 4 h 50 working, no break
  perform mr.p('e2', 'in', 360);                                             -- 6 h working, no break
  perform mr.ps('e3', array['in', 'break_start', 'break_end'], array[420, 180, 120]);   -- 60-min meal after 4 h
  perform mr.ps('e4', array['in', 'break_start', 'break_end'], array[420, 410, 395]);   -- 15-min break only
  perform mr.p('e5', 'in', 480);                                             -- exempt group: no meal rules
  perform mr.ok(mr.alerts('e2') = 'missed', 'six hours without a meal: missed (recorded by the punch trigger)');
  perform mr.ok(mr.alerts('e4') = 'missed', 'a 15-minute break is not a meal: missed');
  perform mr.ok(mr.val('sup', format('select public.refresh_meal_alerts(%L)', mr.id('A'))) is not null, 'the live panel refresh evaluates open sessions');
  perform mr.ok(mr.alerts('e1') = 'approaching', 'at 4 h 50: approaching (15 minutes before the 5th hour)');
  perform mr.ok(mr.alerts('e3') = '', 'a full meal resets the count: no alert');
  perform mr.ok(mr.alerts('e5') = '', 'a group without meal rules: no alert');
  perform mr.val('sup', format('select public.refresh_meal_alerts(%L)', mr.id('A')));
  perform mr.ok((select count(*) from public.meal_alerts where employee_id = mr.id('e2')) = 1, 'refreshing again does not duplicate alerts');
  perform mr.ok(exists (select 1 from public.workforce_events where action = 'meal_missed' and employee_id = mr.id('e2')), 'the alert is in the history');
  perform mr.ok(mr.val('u1', 'select count(*) from public.meal_alerts') = '1', 'the employee sees only its own alert');
  perform mr.ok(mr.val('other', 'select count(*) from public.meal_alerts') = '0', 'isolation: B sees no alert of A');
  perform mr.ok(mr.val('other', format('select public.refresh_meal_alerts(%L)', mr.id('A'))) = '0', 'isolation: B cannot evaluate A''s employees');
end $$;

-- ------------------------------------------------------ acknowledgement and evidence
do $$ declare a uuid; begin
  select id into a from public.meal_alerts where employee_id = mr.id('e2');
  perform mr.ok(mr.err('u1', format('select public.acknowledge_meal_alert(%L)', (select id from public.meal_alerts where employee_id = mr.id('e1')))) like '%MEAL_ALERT_NOT_FOUND%',
                'an employee cannot acknowledge its own alert');
  perform mr.ok(mr.err('sup', format('select public.acknowledge_meal_alert(%L, %L)', a, 'Hablado con el empleado')) = '', 'the supervisor acknowledges with a note');
  perform mr.ok((select acknowledged_by = mr.id('sup') and acknowledged_at is not null from public.meal_alerts where id = a), 'who and when are recorded');
  perform mr.ok(mr.err('owner', 'update public.meal_alerts set note = ''x''') like '%permission denied%', 'users cannot edit alerts');
  perform set_config('request.jwt.claims', '', true);
  begin
    update public.meal_alerts set acknowledged_by = null where id = a;
    perform mr.ok(false, 'an acknowledgement cannot be erased (even by maintenance)');
  exception when others then perform mr.ok(sqlerrm like '%HISTORY_IMMUTABLE%', 'an acknowledgement cannot be erased (even by maintenance)'); end;
  begin
    delete from public.meal_alerts where id = a;
    perform mr.ok(false, 'alerts are never deleted');
  exception when others then perform mr.ok(sqlerrm like '%HISTORY_IMMUTABLE%', 'alerts are never deleted'); end;
end $$;

do $$ begin
  if exists (select 1 from mr.failures) then
    raise exception 'RULES TESTS FAILED: %', (select string_agg(msg, '; ') from mr.failures);
  end if;
  raise notice 'ALL RULES TESTS PASSED';
end $$;
