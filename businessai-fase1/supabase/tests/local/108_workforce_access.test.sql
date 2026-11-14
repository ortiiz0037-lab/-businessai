-- Employee access link (0036) test suite. TEST-ONLY, local throw-away
-- database with 0014a … 0036. Reproduces «Vincular y ponchar» → «El enlace de
-- acceso no es válido» and checks the fix: the link is checked BEFORE it is
-- consumed (read-only), a replaced link and a used link are told apart, the
-- same account pressing twice is not an error, the right user is linked to the
-- right employee and company, and nothing leaks (hashes, other accounts).
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema wa;
create table wa.ctx (key text primary key, val text not null);
create function wa.v(k text) returns text language sql stable as $$ select val from wa.ctx where key = k $$;
create function wa.id(k text) returns uuid language sql stable as $$ select val::uuid from wa.ctx where key = k $$;
create table wa.failures (msg text);
create function wa.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into wa.failures values (msg); end if;
end $$;
grant usage on schema wa to authenticated;
grant select on wa.ctx to authenticated;
grant execute on all functions in schema wa to authenticated;
grant insert on wa.failures to authenticated;
create function wa.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', wa.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function wa.val(who text, q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', wa.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

insert into wa.ctx values
  ('owner', 'e1000000-0000-4000-8000-0000000000a1'), ('juan', 'e1000000-0000-4000-8000-0000000000a2'),
  ('intruso', 'e1000000-0000-4000-8000-0000000000a3'), ('other', 'e1000000-0000-4000-8000-0000000000a4'),
  ('A', 'e2000000-0000-4000-8000-0000000000a1'), ('B', 'e2000000-0000-4000-8000-0000000000a2');
insert into auth.users (id, email) values
  (wa.id('owner'), 'owner@wa.test'), (wa.id('juan'), ' Juan.Prueba@WA.test '), (wa.id('intruso'), 'intruso@wa.test'), (wa.id('other'), 'other@wa.test');
insert into public.companies (id, name, created_by) values (wa.id('A'), 'Colmado Prueba', wa.id('owner')), (wa.id('B'), 'Otra Empresa', wa.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (wa.id('A'), 'cus_wa_a', 'sub_wa_a', 'pro', 'active'), (wa.id('B'), 'cus_wa_b', 'sub_wa_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values (wa.id('A'), wa.id('owner'), 'owner'), (wa.id('B'), wa.id('other'), 'owner');
-- check(token) as a user → 'state|employee|company|expected email'
create function wa.chk(who text, tok text) returns text language sql as $$
  select wa.val(who, format($q$select concat_ws('|', state, coalesce(employee_name, '-'), coalesce(company_name, '-'), coalesce(expected_email, '-')) from public.employee_access_check(%L)$q$, tok)) $$;
create function wa.link_for(emp text) returns text language plpgsql as $$
declare tok text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', wa.id('owner'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  tok := public.create_employee_access(wa.id(emp));
  reset role; perform set_config('request.jwt.claims', '', true);
  return tok;
end $$;
grant execute on all functions in schema wa to authenticated;

do $$ begin
  perform wa.ok(wa.err('owner', format('insert into public.employees (company_id, first_name, last_name, email) values (%L, %L, %L, %L)',
                wa.id('A'), 'Juan', 'Del Pueblo Prueba', 'juan.prueba@wa.test')) = '', 'the owner hires Juan Del Pueblo Prueba with his email');
  insert into wa.ctx select 'emp', id::text from public.employees where last_name = 'Del Pueblo Prueba';
  perform wa.ok(wa.err('owner', format('insert into public.employees (company_id, first_name, last_name, email) values (%L, %L, %L, %L)',
                wa.id('A'), 'Otra', 'Persona', 'otra@wa.test')) = '', 'a second employee');
  insert into wa.ctx select 'emp2', id::text from public.employees where last_name = 'Persona';
end $$;

-- ------------------------------------------------------ the bug: a replaced link still offered the button
do $$ declare t1 text; t2 text; begin
  t1 := wa.link_for('emp'); t2 := wa.link_for('emp');
  insert into wa.ctx values ('t1', t1), ('t2', t2);
  perform wa.ok(t1 ~ '^[0-9a-f]{64}$' and t2 ~ '^[0-9a-f]{64}$' and t1 <> t2, 'the manager created the link twice (two different 64-hex tokens)');
  perform wa.ok(wa.chk('juan', t1) = 'invalid|-|-|-', 'the FIRST link is reported invalid before pressing (it was replaced): no button, nothing consumed');
  perform wa.ok(wa.err('juan', format('select public.claim_employee_access(%L)', t1)) like '%ACCESS_INVALID%', 'claiming the replaced link is refused (the exact error of the report)');
  perform wa.ok((select user_id is null and access_token_hash is not null from public.employees where id = wa.id('emp')), 'the current link is intact after the failed attempt');
end $$;

-- ------------------------------------------------------ check before consuming
do $$ declare t2 text := wa.v('t2'); h text := (select access_token_hash from public.employees where id = wa.id('emp')); begin
  perform wa.ok(not has_function_privilege('anon', 'public.employee_access_check(text)', 'EXECUTE')
                and wa.err(null, format('select * from public.employee_access_check(%L)', t2)) like '%AUTH_REQUIRED%', 'without a session there is no check');
  perform wa.ok(wa.chk('juan', 'abc') = 'invalid|-|-|-', 'a malformed token is invalid');
  perform wa.ok(wa.chk('owner', t2) = 'email_mismatch|Juan Del Pueblo Prueba|Colmado Prueba|j•••@wa.test',
                'signed in BEFORE with another account (the owner): told upfront, with the masked expected email');
  perform wa.ok(wa.err('owner', format('select public.claim_employee_access(%L)', t2)) like '%ACCESS_EMAIL_MISMATCH%', 'and the owner cannot claim it');
  perform wa.ok(wa.chk('juan', t2) = 'ok|Juan Del Pueblo Prueba|Colmado Prueba|-', 'Juan (email with other case and spaces in auth) gets ok, with his name and company');
  perform wa.ok((select access_token_hash = h and user_id is null from public.employees where id = wa.id('emp')), 'the checks consumed nothing');
  perform wa.ok(wa.err('juan', 'select count(*) from public.employee_access_uses') like '%permission denied%', 'used-link hashes are not readable through the API');
end $$;

-- ------------------------------------------------------ claim: right user, right employee, right company
do $$ declare t2 text := wa.v('t2'); r text; begin
  r := wa.val('juan', format('select public.claim_employee_access(%L)', t2));
  perform wa.ok(r = wa.v('emp'), 'Juan claims the current link: returns his employee');
  perform wa.ok((select user_id = wa.id('juan') and company_id = wa.id('A') and access_token_hash is null and access_expires_at is null
                 from public.employees where id = wa.id('emp')), 'linked to Juan''s account, in Colmado Prueba; the link is consumed');
  perform wa.ok((select count(*) from public.employees where user_id = wa.id('juan')) = 1, 'only that employee got the account');
  perform wa.ok(wa.val('juan', 'select first_name || '' '' || last_name || ''|'' || company_id from public.employees') = 'Juan Del Pueblo Prueba|' || wa.v('A'),
                'Juan now reads his own employee record (the clock)');
  perform wa.ok(wa.val('juan', 'select count(*) from public.memberships') = '0', 'no company membership is created (an employee is not a team member)');
end $$;

-- ------------------------------------------------------ pressing again / using it again
do $$ declare t2 text := wa.v('t2'); ev int := (select count(*) from public.workforce_events where employee_id = wa.id('emp') and action = 'access_linked'); begin
  perform wa.ok(wa.chk('juan', t2) = 'linked|Juan Del Pueblo Prueba|Colmado Prueba|-', 'opening the used link again: «already linked» (not «invalid»)');
  perform wa.ok(wa.err('juan', format('select public.claim_employee_access(%L)', t2)) = '', 'pressing «Vincular y ponchar» again with the same account is not an error');
  perform wa.ok((select count(*) from public.workforce_events where employee_id = wa.id('emp') and action = 'access_linked') = ev, '… and changes nothing (no second link event)');
  perform wa.ok(wa.chk('intruso', t2) = 'used|-|-|-', 'another account sees «used», with no name or company');
  perform wa.ok(wa.err('intruso', format('select public.claim_employee_access(%L)', t2)) like '%ACCESS_USED%', 'and cannot claim it');
  perform wa.ok((select user_id = wa.id('juan') from public.employees where id = wa.id('emp')), 'Juan stays linked');
end $$;

-- ------------------------------------------------------ expired, already linked, revoke
do $$ declare t3 text; begin
  t3 := wa.link_for('emp2');
  update public.employees set access_expires_at = now() - interval '1 minute' where id = wa.id('emp2');
  perform wa.ok(split_part(wa.chk('intruso', t3), '|', 1) = 'expired', 'an expired link is reported before pressing');
  update public.employees set access_expires_at = now() + interval '1 day', email = 'juan.prueba@wa.test' where id = wa.id('emp2');
  perform wa.ok(split_part(wa.chk('juan', t3), '|', 1) = 'already_linked', 'an account already linked to another employee of the company is told before pressing');
  perform wa.ok(wa.err('owner', format('select public.revoke_employee_access(%L)', wa.id('emp'))) = '', 'the owner removes Juan''s access');
  perform wa.ok(wa.chk('juan', wa.v('t2')) = 'invalid|-|-|-' and not exists (select 1 from public.employee_access_uses where employee_id = wa.id('emp')),
                'after a revocation the old link is simply invalid (used hashes forgotten)');
  perform wa.ok(wa.chk('other', wa.v('t2')) = 'invalid|-|-|-', 'another company learns nothing');
end $$;

do $$ begin
  if exists (select 1 from wa.failures) then raise exception 'WORKFORCE ACCESS TESTS FAILED: %', (select string_agg(msg, '; ') from wa.failures); end if;
  raise notice 'ALL WORKFORCE ACCESS TESTS PASSED';
end $$;
