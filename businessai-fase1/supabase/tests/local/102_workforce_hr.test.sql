-- Workforce / HR completion (0033). TEST-ONLY, local throw-away database with every
-- migration up to 0033. Schema at.
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
  ('owner', 'f5000000-0000-4000-8000-000000000001'), ('sup', 'f5000000-0000-4000-8000-000000000002'),
  ('dsup', 'f5000000-0000-4000-8000-000000000003'), ('member', 'f5000000-0000-4000-8000-000000000004'),
  ('emp1u', 'f5000000-0000-4000-8000-000000000005'), ('emp2u', 'f5000000-0000-4000-8000-000000000006'),
  ('other', 'f5000000-0000-4000-8000-000000000007'), ('stranger', 'f5000000-0000-4000-8000-000000000008'),
  ('A', 'f6000000-0000-4000-8000-000000000001'), ('B', 'f6000000-0000-4000-8000-000000000002'),
  ('emp1', 'f7000000-0000-4000-8000-000000000001'), ('emp2', 'f7000000-0000-4000-8000-000000000002'),
  ('emp3', 'f7000000-0000-4000-8000-000000000003'), ('empo', 'f7000000-0000-4000-8000-000000000004'),
  ('empB', 'f7000000-0000-4000-8000-000000000005'), ('dept', 'f8000000-0000-4000-8000-000000000001');
insert into auth.users (id, email) select val::uuid, key || '@hr.test' from at.ctx where key in ('owner', 'sup', 'dsup', 'member', 'emp1u', 'emp2u', 'other', 'stranger');
insert into public.companies (id, name, created_by) values (at.id('A'), 'HR A', at.id('owner')), (at.id('B'), 'HR B', at.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (at.id('A'), 'cus_hr_a', 'sub_hr_a', 'pro', 'active'), (at.id('B'), 'cus_hr_b', 'sub_hr_b', 'basic', 'active');
insert into public.memberships (company_id, user_id, role) values
  (at.id('A'), at.id('owner'), 'owner'), (at.id('A'), at.id('sup'), 'member'), (at.id('A'), at.id('dsup'), 'member'),
  (at.id('A'), at.id('member'), 'member'), (at.id('B'), at.id('other'), 'owner');
insert into public.departments (id, company_id, name) values (at.id('dept'), at.id('A'), 'Almacén');
insert into public.department_supervisors (company_id, department_id, user_id) values (at.id('A'), at.id('dept'), at.id('dsup'));
-- linked employees (the link is set by the database owner here; the app uses claim_employee_access)
insert into public.employees (id, company_id, first_name, last_name, user_id, employee_number) values
  (at.id('emp1'), at.id('A'), 'Ana', 'Uno', at.id('emp1u'), '101'),
  (at.id('emp2'), at.id('A'), 'Beto', 'Dos', at.id('emp2u'), '102'),
  (at.id('empo'), at.id('A'), 'Dueña', 'Empleada', at.id('owner'), '103');
insert into public.employees (id, company_id, first_name, last_name, department_id, hourly_rate) values
  (at.id('emp3'), at.id('A'), 'Carla', 'Tres', at.id('dept'), 41.77);
insert into public.employees (id, company_id, first_name, last_name) values (at.id('empB'), at.id('B'), 'Bea', 'Otra');

create function at.n(who text, q text) returns integer language sql as $$ select at.val(who, q)::integer $$;
grant execute on function at.n(text, text) to authenticated;
-- a future business day at hh:mm in Puerto Rico
create function at.ts(days integer, hhmm text) returns timestamptz language sql stable as $$
  select ((public.ba_today() + days) + hhmm::time) at time zone 'America/Puerto_Rico' $$;
grant execute on function at.ts(integer, text) to authenticated;

-- ===================================================================== employees
do $$ begin
  perform at.ok(at.err('owner', format('update public.employees set supervisor_user_id = %L where id = %L', at.id('stranger'), at.id('emp1'))) like '%SUPERVISOR_INVALID%',
    'a direct supervisor must be an active member of the company');
  perform at.ok(at.err('owner', format('update public.employees set supervisor_user_id = %L where id = %L', at.id('emp1u'), at.id('emp1'))) like '%SUPERVISOR_INVALID%',
    'an employee cannot be its own supervisor');
  perform at.ok(at.err('owner', format('update public.employees set supervisor_user_id = %L, employment_type = %L, classification = %L where id = %L',
    at.id('sup'), 'part_time', 'non_exempt', at.id('emp1'))) = '', 'the owner assigns a direct supervisor and the employment type');
  perform at.ok(at.val('owner', format('with x as (insert into public.employees (company_id, first_name, last_name) values (%L, %L, %L) returning id) select count(*)::text from x',
    at.id('A'), 'Nuevo', 'Contratado')) = '1', 'a manager creates an employee and reads it back (INSERT ... RETURNING, as the app does)');
  update public.employees set status = 'inactive' where first_name = 'Nuevo';
  perform at.ok(at.n('sup', 'select count(*) from public.employees') = 1, 'the direct supervisor sees only the direct report');
  perform at.ok(at.n('dsup', 'select count(*) from public.employees') = 1, 'the department supervisor sees only the department');
  perform at.ok(at.n('member', 'select count(*) from public.employees') = 0, 'a member without a workforce role sees no one');
  perform at.ok(at.n('other', 'select count(*) from public.employees') = 1, 'isolation: another company sees only its own');
  perform at.ok(at.n('sup', format('with u as (update public.employees set position = %L where id = %L returning 1) select count(*) from u', 'Jefa', at.id('emp1'))) = 0,
    'a supervisor cannot edit the employee record');
  perform at.ok(at.err('sup', format('select public.set_employee_status(%L, %L, %L)', at.id('emp1'), 'suspended', 'Prueba')) like '%EMPLOYEE_NOT_FOUND%',
    'a supervisor cannot suspend');
  perform at.ok(at.err('owner', format('select public.set_employee_status(%L, %L, null)', at.id('emp2'), 'suspended')) like '%REASON_REQUIRED%',
    'suspending requires a reason');
  perform at.ok(at.err('owner', format('select public.set_employee_status(%L, %L, %L)', at.id('emp2'), 'suspended', 'Investigación administrativa')) = '',
    'the owner suspends with a reason');
  perform at.ok(at.err('emp2u', format('select public.punch(%L, %L)', at.id('emp2'), 'in')) like '%EMPLOYEE_INACTIVE%', 'a suspended employee cannot punch');
  perform at.ok(at.n('emp2u', 'select count(*) from public.employees') = 1, 'a suspended employee still sees its own record');
  perform at.ok(at.err('owner', format('select public.archive_employee(%L, true)', at.id('emp1'))) like '%EMPLOYEE_ACTIVE%', 'an active employee cannot be archived');
  perform at.ok(at.err('owner', format('update public.employees set archived_at = now() where id = %L', at.id('emp3'))) like '%permission denied%',
    'archiving is never a direct write');
  perform at.ok(at.err('owner', format('select public.set_employee_status(%L, %L, null)', at.id('emp3'), 'inactive')) = ''
            and at.err('owner', format('select public.archive_employee(%L, true)', at.id('emp3'))) = '', 'an inactive employee is archived');
  perform at.ok(at.err('owner', format('select public.set_employee_status(%L, %L, null)', at.id('emp3'), 'active')) like '%EMPLOYEE_ARCHIVED%',
    'an archived employee must be unarchived before changing status');
  perform at.ok((select count(*) from public.time_punches where employee_id = at.id('emp3')) = 0 and (select count(*) from public.workforce_events where employee_id = at.id('emp3')) > 0,
    'archiving keeps the history');
  perform at.ok(at.err('owner', format('select public.archive_employee(%L, false)', at.id('emp3'))) = '', 'unarchive');
end $$;

do $$ declare d jsonb; begin
  select details into d from public.workforce_events where entity = 'employees' and employee_id = at.id('emp2') and action = 'update' order by id desc limit 1;
  perform at.ok(d -> 'changes' -> 'status' = '{"from": "active", "to": "suspended"}'::jsonb, 'history: old → new status');
  perform at.ok(at.err('owner', format('update public.employees set hourly_rate = 55.55, notes = %L where id = %L', 'nota privada', at.id('emp3'))) = '', 'a rate change');
  select details into d from public.workforce_events where entity = 'employees' and employee_id = at.id('emp3') and action = 'update' order by id desc limit 1;
  perform at.ok(d::text not like '%55.55%' and d::text not like '%nota privada%' and d -> 'fields' ? 'hourly_rate', 'history never stores pay or notes values (only that they changed)');
end $$;

-- plan limit: Basic = 3 active; suspended do not count; reactivating checks the limit
do $$ begin
  insert into public.employees (company_id, first_name, last_name) values (at.id('B'), 'B2', 'X'), (at.id('B'), 'B3', 'X');
  perform at.ok(at.err('other', format('insert into public.employees (company_id, first_name, last_name) values (%L, %L, %L)', at.id('B'), 'B4', 'X')) like '%PLAN_LIMIT_EMPLOYEES%',
    'Basic: a 4th active employee is refused by the server');
  perform at.ok(at.err('other', format('select public.set_employee_status(%L, %L, %L)', at.id('empB'), 'suspended', 'Licencia')) = ''
            and at.err('other', format('insert into public.employees (company_id, first_name, last_name) values (%L, %L, %L)', at.id('B'), 'B4', 'X')) = '',
    'a suspended employee frees the slot');
  perform at.ok(at.err('other', format('select public.set_employee_status(%L, %L, null)', at.id('empB'), 'active')) like '%PLAN_LIMIT_EMPLOYEES%',
    'reactivating over the limit is refused');
end $$;

-- private contacts: managers and the employee only
do $$ begin
  perform at.ok(at.err('owner', format('insert into public.employee_contacts (employee_id, company_id, address, emergency_contact_name, emergency_contact_phone) values (%L, %L, %L, %L, %L)',
    at.id('emp1'), at.id('A'), 'Calle Ficticia 1', 'Contacto Ficticio', '787-555-0100')) = '', 'the manager records private contact data');
  perform at.ok(at.n('sup', 'select count(*) from public.employee_contacts') = 0, 'a supervisor cannot read private contact data');
  perform at.ok(at.n('emp1u', 'select count(*) from public.employee_contacts') = 1 and at.n('emp2u', 'select count(*) from public.employee_contacts') = 0,
    'the employee reads only its own');
  perform at.ok(at.n('emp1u', format('with u as (update public.employee_contacts set emergency_contact_phone = %L where employee_id = %L returning 1) select count(*) from u', '787-555-0199', at.id('emp1'))) = 1,
    'the employee updates its own emergency contact');
  perform at.ok(at.n('other', 'select count(*) from public.employee_contacts') = 0, 'isolation: contacts');
  perform at.ok((select updated_by from public.employee_contacts where employee_id = at.id('emp1')) = at.id('emp1u'), 'who changed it is recorded');
end $$;

-- ===================================================================== private documents
do $$ declare p text := at.id('A') || '/' || at.id('emp1') || '/contrato.pdf'; d uuid; begin
  perform at.ok(at.err('sup', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'HR-documents', at.id('A') || '/' || at.id('emp1') || '/x.pdf')) like '%row-level security%',
    'a supervisor cannot upload labour documents');
  perform at.ok(at.err('owner', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'HR-documents', at.id('A') || '/' || at.id('empB') || '/x.pdf')) like '%row-level security%',
    'a file cannot point to an employee of another company');
  perform at.ok(at.err('owner', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'HR-documents', p)) = '', 'the manager uploads a private file');
  perform at.ok(at.err('owner', format('insert into public.employee_documents (company_id, employee_id, category, title, storage_path, file_name, content_type, size_bytes) values (%L, %L, %L, %L, %L, %L, %L, 1000)',
    at.id('A'), at.id('emp1'), 'contract', 'Contrato', at.id('A') || '/' || at.id('emp1') || '/falta.pdf', 'falta.pdf', 'application/pdf')) like '%DOCUMENT_FILE_MISSING%', 'a document needs its file');
  perform at.ok(at.err('owner', format('insert into public.employee_documents (company_id, employee_id, category, title, storage_path, file_name, content_type, size_bytes) values (%L, %L, %L, %L, %L, %L, %L, 1000)',
    at.id('A'), at.id('emp2'), 'contract', 'Contrato', p, 'contrato.pdf', 'application/pdf')) like '%DOCUMENT_PATH_INVALID%', 'the path must match the employee');
  perform at.ok(at.err('owner', format('insert into public.employee_documents (company_id, employee_id, category, title, storage_path, file_name, content_type, size_bytes) values (%L, %L, %L, %L, %L, %L, %L, 1000)',
    at.id('A'), at.id('emp1'), 'contract', 'Contrato', p, 'contrato.pdf', 'application/pdf')) = '', 'the manager registers the document');
  select id into d from public.employee_documents where storage_path = p;
  insert into at.ctx values ('doc', d);
  perform at.ok(at.n('emp1u', 'select count(*) from public.employee_documents') = 0, 'not shared: the employee does not see it');
  perform at.ok(at.n('emp1u', 'select count(*) from storage.objects where bucket_id = ''HR-documents''') = 0, 'not shared: nor its file');
  perform at.ok(at.n('sup', 'select count(*) from public.employee_documents') = 0 and at.n('sup', 'select count(*) from storage.objects where bucket_id = ''HR-documents''') = 0,
    'supervisors never see private documents');
  perform at.ok(at.err('owner', format('select public.set_employee_document(%L, true, false)', d)) = '', 'share with the employee');
  perform at.ok(at.n('emp1u', 'select count(*) from public.employee_documents') = 1 and at.n('emp1u', 'select count(*) from storage.objects where bucket_id = ''HR-documents''') = 1,
    'shared: the employee sees it and can download it');
  perform at.ok(at.n('emp2u', 'select count(*) from public.employee_documents') = 0, 'another employee does not');
  perform at.ok(at.n('other', 'select count(*) from storage.objects where bucket_id = ''HR-documents''') = 0, 'isolation: files');
  perform at.ok(at.n('owner', format('with x as (delete from storage.objects where name = %L returning 1) select count(*) from x', p)) = 0,
    'a registered document''s file cannot be deleted');
  perform at.ok(at.err('owner', format('delete from public.employee_documents where id = %L', d)) like '%permission denied%', 'documents cannot be deleted');
  perform at.ok(at.err('owner', format('update public.employee_documents set title = %L where id = %L', 'x', d)) like '%permission denied%', 'nor edited directly');
  perform at.ok(at.err('owner', format('select public.set_employee_document(%L, null, true)', d)) = '', 'archive');
  perform at.ok(at.n('emp1u', 'select count(*) from public.employee_documents') = 0 and at.n('owner', 'select count(*) from public.employee_documents') = 1,
    'archived: hidden from the employee, kept for the company');
  perform at.ok(at.err('owner', format('select public.set_employee_document(%L, true, false)', d)) like '%DOCUMENT_ARCHIVED%', 'an archived document is final');
  begin delete from public.employee_documents where id = d; perform at.ok(false, 'even the database owner cannot delete a document');
  exception when others then perform at.ok(sqlerrm like '%HISTORY_IMMUTABLE%', 'even the database owner cannot delete a document'); end;
end $$;

-- ===================================================================== schedules
do $$ declare pat uuid; r record; begin
  perform at.ok(at.err('emp1u', format('insert into public.shift_patterns (company_id, employee_id, weekdays, start_time, end_time, starts_on) values (%L, %L, %L, %L, %L, %L)',
    at.id('A'), at.id('emp1'), '{1,2,3}', '08:00', '16:00', public.ba_today())) like '%row-level security%', 'an employee cannot create its own schedule');
  perform at.ok(at.err('sup', format('insert into public.shift_patterns (company_id, employee_id, weekdays, start_time, end_time, break_minutes, starts_on) values (%L, %L, %L, %L, %L, 600, %L)',
    at.id('A'), at.id('emp1'), '{1}', '08:00', '16:00', public.ba_today())) like '%PATTERN_INVALID%', 'a break longer than the shift is refused');
  -- every day of the week, overnight 22:00 → 06:00
  perform at.ok(at.err('sup', format('insert into public.shift_patterns (company_id, employee_id, name, weekdays, start_time, end_time, break_minutes, starts_on) values (%L, %L, %L, %L, %L, %L, 30, %L)',
    at.id('A'), at.id('emp1'), 'Noche', '{0,1,2,3,4,5,6}', '22:00', '06:00', public.ba_today())) = '', 'the direct supervisor creates an overnight recurring pattern');
  select id into pat from public.shift_patterns where employee_id = at.id('emp1');
  insert into at.ctx values ('pat', pat);
  -- a manual shift on day +3 and an approved leave on day +5 are respected
  insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (at.id('A'), at.id('emp1'), at.ts(3, '23:00'), at.ts(4, '01:00'));
  insert into public.leave_requests (company_id, employee_id, leave_type, starts_on, ends_on, status, requested_by) values
    (at.id('A'), at.id('emp1'), 'vacation', public.ba_today() + 5, public.ba_today() + 5, 'approved', at.id('emp1u'));
  perform at.ok(at.val('sup', format('select g.created || ''/'' || g.skipped_conflict || ''/'' || g.skipped_leave from public.generate_pattern_shifts(%L, %L, %L) g', pat, public.ba_today() + 1, public.ba_today() + 7)) = '5/1/1',
    'generation: 7 days → 5 shifts, the manual-shift day and the leave day skipped');
  perform at.ok(at.val('sup', format('select g.created::text from public.generate_pattern_shifts(%L, %L, %L) g', pat, public.ba_today() + 1, public.ba_today() + 7)) = '0',
    'generation is idempotent');
  perform at.ok((select ends_at - starts_at from public.work_shifts where pattern_id = pat order by starts_at limit 1) = interval '8 hours'
            and (select (starts_at at time zone 'America/Puerto_Rico')::time from public.work_shifts where pattern_id = pat order by starts_at limit 1) = '22:00',
    'overnight: starts 22:00, ends 06:00 the next day');
  perform at.ok(at.err('dsup', format('select * from public.generate_pattern_shifts(%L, %L, %L)', pat, public.ba_today(), public.ba_today() + 7)) like '%PATTERN_NOT_FOUND%',
    'another team''s supervisor cannot generate it');
  perform at.ok(at.err('other', format('select * from public.generate_pattern_shifts(%L, %L, %L)', pat, public.ba_today(), public.ba_today() + 7)) like '%PATTERN_NOT_FOUND%',
    'isolation: patterns');
  perform at.ok(at.err('sup', format('select * from public.generate_pattern_shifts(%L, %L, %L)', pat, public.ba_today(), public.ba_today() + 200)) like '%RANGE_INVALID%',
    'the range is bounded');
  perform at.ok(at.n('emp1u', 'select count(*) from public.shift_patterns') = 1 and at.n('emp2u', 'select count(*) from public.shift_patterns') = 0,
    'the employee sees its own pattern');
  perform at.ok(at.err('sup', format('insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (%L, %L, %L, %L)',
    at.id('A'), at.id('emp1'), at.ts(1, '23:30'), at.ts(2, '00:30'))) like '%SHIFT_OVERLAP%', 'overlapping shifts are refused');
end $$;

do $$ declare s1 uuid; s2 uuid; s3 uuid; r1 uuid; r2 uuid; r3 uuid; so uuid; ro uuid; begin
  select id into s1 from public.work_shifts where pattern_id = at.id('pat') order by starts_at limit 1;
  select id into s2 from public.work_shifts where pattern_id = at.id('pat') order by starts_at offset 1 limit 1;
  select id into s3 from public.work_shifts where pattern_id = at.id('pat') order by starts_at offset 2 limit 1;
  r1 := at.val('emp1u', format('select public.request_shift_change(%L, %L, %L, %L, 30, %L)', s1, 'change', at.ts(1, '21:00'), at.ts(2, '05:00'), 'Cita familiar'))::uuid;
  perform at.ok(r1 is not null, 'the employee requests a change of its own shift');
  perform at.ok(at.err('emp1u', format('select public.request_shift_change(%L, %L, null, null, null, %L)', s1, 'drop', 'Otra vez')) like '%SHIFT_CHANGE_PENDING%',
    'one pending request per shift');
  perform at.ok(at.err('emp2u', format('select public.request_shift_change(%L, %L, null, null, null, %L)', s2, 'drop', 'Ajeno')) like '%SHIFT_NOT_FOUND%',
    'an employee cannot request changes to someone else''s shift');
  perform at.ok(at.err('emp1u', format('select public.decide_shift_change(%L, true)', r1)) like '%SHIFT_CHANGE_NOT_FOUND%', 'the employee cannot approve');
  perform at.ok(at.err('dsup', format('select public.decide_shift_change(%L, true)', r1)) like '%SHIFT_CHANGE_NOT_FOUND%', 'another team''s supervisor cannot approve');
  perform at.ok(at.err('sup', format('select public.decide_shift_change(%L, true, %L)', r1, 'Aprobado')) = '', 'the direct supervisor approves');
  perform at.ok((select starts_at from public.work_shifts where id = s1) = at.ts(1, '21:00'), 'the approved change is applied to the shift');
  perform at.ok(at.err('sup', format('select public.decide_shift_change(%L, true)', r1)) like '%SHIFT_CHANGE_NOT_PENDING%', 'a decision is final');
  -- drop: the shift goes, the request stays with its snapshot
  r2 := at.val('emp1u', format('select public.request_shift_change(%L, %L, null, null, null, %L)', s2, 'drop', 'Examen'))::uuid;
  perform at.ok(at.err('sup', format('select public.decide_shift_change(%L, true)', r2)) = '', 'the supervisor approves a drop');
  perform at.ok(not exists (select 1 from public.work_shifts where id = s2)
            and (select shift_id is null and old_starts_at is not null and status = 'approved' from public.shift_change_requests where id = r2), 'an approved drop removes the shift and keeps the request');
  -- a change that would overlap another shift is not applied (stays pending)
  r3 := at.val('emp1u', format('select public.request_shift_change(%L, %L, %L, %L, 0, %L)', s3, 'change', at.ts(1, '22:00'), at.ts(2, '02:00'), 'Choque'))::uuid;
  perform at.ok(at.err('sup', format('select public.decide_shift_change(%L, true)', r3)) like '%SHIFT_OVERLAP%', 'an overlapping change is refused');
  perform at.ok((select status from public.shift_change_requests where id = r3) = 'pending', 'and stays pending');
  -- the shift changed after the request: decide again
  update public.work_shifts set break_minutes = 45, ends_at = ends_at + interval '10 minutes' where id = s3;
  perform at.ok(at.err('sup', format('select public.decide_shift_change(%L, false, %L)', r3, 'No')) = '', 'a rejection is always possible');
  -- nobody approves their own: the owner is also an employee
  insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (at.id('A'), at.id('empo'), at.ts(2, '08:00'), at.ts(2, '12:00')) returning id into so;
  ro := at.val('owner', format('select public.request_shift_change(%L, %L, null, null, null, %L)', so, 'drop', 'Viaje'))::uuid;
  perform at.ok(at.err('owner', format('select public.decide_shift_change(%L, true)', ro)) like '%SELF_APPROVAL_FORBIDDEN%', 'nobody approves their own shift change');
  update public.work_shifts set starts_at = starts_at - interval '1 hour' where id = so;
  perform at.ok(at.err('sup', format('select public.decide_shift_change(%L, true)', ro)) like '%SHIFT_CHANGE_NOT_FOUND%', 'not the supervisor of that employee');
  perform at.ok(at.n('emp1u', 'select count(*) from public.shift_change_requests') = 3 and at.n('other', 'select count(*) from public.shift_change_requests') = 0,
    'the employee sees its own requests; isolation');
  begin update public.shift_change_requests set reason = 'x' where id = r1; perform at.ok(false, 'decided requests are immutable');
  exception when others then perform at.ok(sqlerrm like '%HISTORY_IMMUTABLE%', 'decided requests are immutable'); end;
  perform at.ok((select count(*) from public.workforce_events where entity = 'work_shifts' and details ? 'changes') >= 1, 'shift edits are in the history with old → new');
end $$;

-- conflicts and missing punches
do $$ declare c jsonb; m jsonb; begin
  insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (at.id('A'), at.id('emp1'), at.ts(5, '09:00'), at.ts(5, '10:00'));
  -- Monday to Friday of next week, 9.5 h a day for emp2 → 47.5 h, over 40 h
  insert into public.work_shifts (company_id, employee_id, starts_at, ends_at)
    select at.id('A'), at.id('emp2'), at.ts(g, '07:00'), at.ts(g, '16:30')
      from generate_series(8 - extract(isodow from public.ba_today())::int, 12 - extract(isodow from public.ba_today())::int) g;
  c := at.val('owner', format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.wf_schedule_conflicts(%L, %L, %L) x', at.id('A'), public.ba_today(), public.ba_today() + 20))::jsonb;
  perform at.ok(exists (select 1 from jsonb_array_elements(c) e where e ->> 'kind' = 'leave' and e ->> 'employee_id' = at.id('emp1')::text), 'conflict: a shift on approved leave');
  perform at.ok(exists (select 1 from jsonb_array_elements(c) e where e ->> 'kind' = 'employee_not_active' and e ->> 'employee_id' = at.id('emp2')::text), 'conflict: shifts of a suspended employee');
  perform at.ok(exists (select 1 from jsonb_array_elements(c) e where e ->> 'kind' = 'weekly_hours' and e ->> 'employee_id' = at.id('emp2')::text), 'conflict: a week over the overtime threshold');
  perform at.ok(at.n('other', format('select count(*) from public.wf_schedule_conflicts(%L, %L, %L)', at.id('A'), public.ba_today(), public.ba_today() + 20)) = 0, 'isolation: conflicts');
  -- missing punches: an open session from yesterday; a past shift with no clock-in
  insert into public.time_punches (company_id, employee_id, kind, at, source) values (at.id('A'), at.id('emp3'), 'in', now() - interval '30 hours', 'self');
  insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values (at.id('A'), at.id('emp1'), now() - interval '50 hours', now() - interval '46 hours');
  update public.employees set status = 'active' where id = at.id('emp3');
  m := at.val('owner', format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.wf_missing_punches(%L, %L, %L) x', at.id('A'), public.ba_today() - 5, public.ba_today()))::jsonb;
  perform at.ok(exists (select 1 from jsonb_array_elements(m) e where e ->> 'kind' = 'no_clock_out' and e ->> 'employee_id' = at.id('emp3')::text), 'missing: a forgotten clock-out');
  perform at.ok(exists (select 1 from jsonb_array_elements(m) e where e ->> 'kind' = 'no_clock_in' and e ->> 'employee_id' = at.id('emp1')::text), 'missing: a shift without clock-in');
  perform at.ok(at.n('sup', format('select count(*) from public.wf_missing_punches(%L, %L, %L)', at.id('A'), public.ba_today() - 5, public.ba_today())) = 1,
    'the direct supervisor sees only its team');
  perform at.ok(at.err('owner', format('select * from public.wf_missing_punches(%L, %L, %L)', at.id('A'), public.ba_today() - 100, public.ba_today())) like '%RANGE_INVALID%', 'bounded range');
end $$;

-- ===================================================================== rules
do $$ declare c1 uuid; c2 uuid; c3 uuid; v integer; begin
  perform at.ok(at.err('owner', format('select public.propose_rule_change(%L, %L, %L, %L)', at.id('A'), 'company', at.id('A'), '{"salary": 1}')) like '%RULE_VALUES_INVALID%',
    'unknown rule keys are refused');
  perform at.ok(at.err('owner', format('select public.propose_rule_change(%L, %L, %L, %L)', at.id('A'), 'company', at.id('A'), '{"daily_overtime_after_minutes": 5}')) like '%RULE_VALUES_INVALID%',
    'out-of-range values are refused');
  perform at.ok(at.err('owner', format('select public.propose_rule_change(%L, %L, %L, %L)', at.id('A'), 'company', at.id('A'), '{"timezone": "Mars/Base"}')) like '%RULE_VALUES_INVALID%',
    'unknown time zones are refused');
  perform at.ok(at.err('sup', format('select public.propose_rule_change(%L, %L, %L, %L)', at.id('A'), 'company', at.id('A'), '{"grace_minutes": 7}')) like '%FORBIDDEN%',
    'a supervisor cannot change rules');
  perform at.ok(at.err('other', format('select public.propose_rule_change(%L, %L, %L, %L)', at.id('A'), 'company', at.id('A'), '{"grace_minutes": 7}')) like '%FORBIDDEN%',
    'isolation: rules');
  c1 := at.val('owner', format('select public.propose_rule_change(%L, %L, %L, %L, %L)', at.id('A'), 'company', at.id('A'),
                               '{"daily_overtime_after_minutes": 600, "overnight_attribution": "split_midnight"}', 'Convenio'))::uuid;
  c2 := at.val('owner', format('select public.propose_rule_change(%L, %L, %L, %L)', at.id('A'), 'company', at.id('A'), '{"grace_minutes": 9}'))::uuid;
  perform at.ok(coalesce((select daily_overtime_after_minutes from public.workforce_settings where company_id = at.id('A')), 480) = 480, 'a proposal changes nothing');
  v := at.val('owner', format('select public.apply_rule_change(%L)', c1))::integer;
  perform at.ok((select daily_overtime_after_minutes = 600 and overnight_attribution = 'split_midnight' from public.workforce_settings where company_id = at.id('A')),
    'an applied change takes effect');
  perform at.ok(exists (select 1 from public.labor_rule_versions where scope = 'company' and scope_id = at.id('A') and version = v and change_id = c1 and actor = at.id('owner')),
    'the version records the change, who applied it and the values');
  perform at.ok(at.err('owner', format('select public.apply_rule_change(%L)', c2)) like '%RULES_CHANGED_SINCE%', 'a stale proposal is refused (rules changed since)');
  perform at.ok(at.err('owner', format('select public.apply_rule_change(%L)', c1)) like '%RULE_CHANGE_NOT_PENDING%', 'a change is applied once');
  perform at.ok(at.err('owner', format('select public.discard_rule_change(%L)', c2)) = '', 'discard the stale proposal');
  perform at.ok(at.n('sup', 'select count(*) from public.labor_rule_changes') = 0 and at.n('sup', 'select count(*) from public.labor_rule_versions') = 0,
    'supervisors do not see company rule history');
  -- any write path is versioned (direct API update by a manager)
  v := public.wf_rule_version_of('company', at.id('A'));
  perform at.ok(at.err('owner', format('update public.workforce_settings set grace_minutes = 11 where company_id = %L', at.id('A'))) = '', 'a manager updates a rule directly');
  perform at.ok(public.wf_rule_version_of('company', at.id('A')) = v + 1, 'a direct change also creates a version');
  begin update public.labor_rule_versions set rule_values = '{}' where scope_id = at.id('A'); perform at.ok(false, 'versions are append-only');
  exception when others then perform at.ok(sqlerrm like '%HISTORY_IMMUTABLE%', 'versions are append-only'); end;
  -- template as a proposal
  c3 := at.val('owner', format('select public.propose_jurisdiction_template(%L, %L)', at.id('A'), 'US-CA'))::uuid;
  perform at.ok((select changes ->> 'meal_break_min_minutes' from public.labor_rule_changes where id = c3) = '30', 'a template is shown as a proposal with its values');
  perform at.ok(at.val('owner', format('select public.apply_rule_change(%L)', c3)) is not null, 'apply the template proposal');
  perform at.ok((select meal_break_after_minutes = 300 and meal_break_min_minutes = 30 and jurisdiction = 'US-CA' from public.workforce_settings where company_id = at.id('A')),
    'the template applies only when applied explicitly');
  perform at.ok(not exists (select 1 from public.labor_jurisdictions where verification_status <> 'unverified'), 'template validity is marked as not verified');
end $$;

do $$ declare c uuid; r record; begin
  perform at.ok(at.err('owner', format('select public.propose_rule_change(%L, %L, %L, %L)', at.id('A'), 'employee', at.id('emp1'), '{"daily_overtime_after_minutes": null}')) like '%REASON_REQUIRED%',
    'an employee exception needs a reason');
  perform at.ok(at.err('owner', format('select public.propose_rule_change(%L, %L, %L, %L, %L)', at.id('A'), 'employee', at.id('empB'), '{}', 'x x x')) like '%RULE_SCOPE_INVALID%',
    'an exception for another company''s employee is refused');
  c := at.val('owner', format('select public.propose_rule_change(%L, %L, %L, %L, %L)', at.id('A'), 'employee', at.id('emp1'),
                              '{"daily_overtime_after_minutes": null, "weekly_overtime_after_minutes": 2700}', 'Acuerdo individual (ficticio)'))::uuid;
  perform at.val('owner', format('select public.apply_rule_change(%L)', c));
  select * into r from public.wf_rules(at.id('emp1'));
  perform at.ok(r.source = 'employee' and r.daily_overtime_after_minutes is null and r.weekly_overtime_after_minutes = 2700 and r.meal_break_after_minutes = 300,
    'employee exception over the company rules (other values inherited)');
  update public.employees set classification = 'exempt' where id = at.id('emp2');
  perform at.ok((select exempt from public.wf_rules(at.id('emp2'))), 'an exempt classification exempts from overtime');
  perform at.ok(at.n('sup', 'select count(*) from public.employee_rule_overrides') = 1 and at.n('emp1u', 'select count(*) from public.employee_rule_overrides') = 1
            and at.n('emp2u', 'select count(*) from public.employee_rule_overrides') = 0, 'exceptions: visible to the supervisor and the employee only');
  perform at.ok(at.n('sup', 'select count(*) from public.labor_rule_versions') >= 1, 'the supervisor sees the version history of its team''s exceptions');
end $$;

-- ===================================================================== alerts
do $$ declare a uuid; n integer; begin
  insert into public.meal_alerts (company_id, employee_id, session_start, kind, due_at) values (at.id('A'), at.id('emp1'), now() - interval '6 hours', 'missed', now() - interval '1 hour')
    returning id into a;
  perform at.ok(at.n('emp1u', 'select count(*) from public.meal_alerts') = 1, 'the employee sees its own alerts');
  perform at.ok(at.err('emp1u', format('select public.resolve_meal_alert(%L, %L)', a, 'no_action_needed')) like '%MEAL_ALERT_NOT_FOUND%', 'the employee cannot handle its own alert');
  perform at.ok(at.err('sup', format('select public.resolve_meal_alert(%L, %L)', a, 'ignore')) like '%ALERT_ACTION_INVALID%', 'unknown actions are refused');
  perform at.ok(at.err('sup', format('select public.resolve_meal_alert(%L, %L)', a, 'other')) like '%REASON_REQUIRED%', '"other" needs a note');
  perform at.ok(at.err('sup', format('select public.resolve_meal_alert(%L, %L, %L)', a, 'schedule_adjusted', 'Se movió la comida')) = '', 'the supervisor handles the alert');
  perform at.ok((select action_taken = 'schedule_adjusted' and acknowledged_by = at.id('sup') from public.meal_alerts where id = a), 'the action taken is recorded');
  perform at.ok(at.err('sup', format('select public.resolve_meal_alert(%L, %L, %L)', a, 'other', 'Otra vez')) like '%MEAL_ALERT_HANDLED%', 'handled once');
  perform at.ok(not has_function_privilege('authenticated', 'public.wf_meal_sweep()', 'EXECUTE'), 'the sweep is not callable from the API');
  -- the scheduler sweep: an open session over the meal limit becomes an alert without anyone watching
  insert into public.time_punches (company_id, employee_id, kind, at, source) values (at.id('A'), at.id('empo'), 'in', now() - interval '6 hours', 'self');
  n := public.wf_meal_sweep();
  perform at.ok(exists (select 1 from public.meal_alerts where employee_id = at.id('empo') and kind = 'missed'), 'the sweep records a missed meal period for open sessions');
  perform at.ok(public.wf_meal_sweep() = 0, 'the sweep is idempotent');
end $$;

-- ===================================================================== leave
do $$ begin
  perform at.ok(at.err('emp1u', format('select public.request_leave(%L, %L, %L, %L, null, null)', at.id('emp1'), 'bereavement', public.ba_today() + 30, public.ba_today() + 31)) = '',
    'new leave type: bereavement');
  perform at.ok(at.err('emp1u', format('select public.request_leave(%L, %L, %L, %L, null, null)', at.id('emp1'), 'medical_diagnosis', public.ba_today() + 40, public.ba_today() + 40)) like '%LEAVE_TYPE_INVALID%',
    'unknown leave types are refused');
  perform at.ok(at.err('emp1u', format('select public.request_leave(%L, %L, %L, %L, null, null)', at.id('emp1'), 'jury_duty', public.ba_today() + 31, public.ba_today() + 32)) like '%LEAVE_OVERLAP%',
    'overlapping requests are refused');
end $$;

do $$ begin
  if exists (select 1 from at.failures) then
    raise exception 'WORKFORCE HR TESTS FAILED: %', (select string_agg(msg, ' | ') from at.failures);
  end if;
  raise notice 'ALL WORKFORCE HR TESTS PASSED';
end $$;
