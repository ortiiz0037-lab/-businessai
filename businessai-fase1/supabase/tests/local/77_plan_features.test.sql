-- Plan features (0017) test suite. TEST-ONLY, local throw-away database.
-- Deny by default, approved limits, inactive subscriptions, isolation.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema pf;
create table pf.failures (msg text);
create function pf.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into pf.failures values (msg); end if;
end $$;
grant usage on schema pf to authenticated;
grant insert on pf.failures to authenticated;
grant execute on function pf.ok(boolean, text) to authenticated;

insert into auth.users (id) values ('9a000000-0000-4000-8000-000000000001'), ('9a000000-0000-4000-8000-000000000002');
insert into public.companies (id, name, created_by) values
  ('9c000000-0000-4000-8000-00000000000b', 'Plan Basico', '9a000000-0000-4000-8000-000000000001'),
  ('9c000000-0000-4000-8000-00000000000c', 'Plan Pro', '9a000000-0000-4000-8000-000000000001'),
  ('9c000000-0000-4000-8000-00000000000d', 'Sin plan', '9a000000-0000-4000-8000-000000000001');
insert into public.memberships (company_id, user_id, role) values
  ('9c000000-0000-4000-8000-00000000000b', '9a000000-0000-4000-8000-000000000001', 'owner'),
  ('9c000000-0000-4000-8000-00000000000c', '9a000000-0000-4000-8000-000000000001', 'owner'),
  ('9c000000-0000-4000-8000-00000000000d', '9a000000-0000-4000-8000-000000000001', 'owner');
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  ('9c000000-0000-4000-8000-00000000000b', 'cus_pf_b', 'sub_pf_b', 'basic', 'active'),
  ('9c000000-0000-4000-8000-00000000000c', 'cus_pf_p', 'sub_pf_p', 'pro', 'trialing');

do $$
declare b uuid := '9c000000-0000-4000-8000-00000000000b'; p uuid := '9c000000-0000-4000-8000-00000000000c';
        x uuid := '9c000000-0000-4000-8000-00000000000d'; r record; msg text;
begin
  select * into r from public.company_feature(b, 'branches');
  perform pf.ok(r.available and r.max_allowed = 1 and r.used = 0, 'Basic: 1 branch');
  select * into r from public.company_feature(b, 'payroll');
  perform pf.ok(not r.available, 'Basic: no payroll');
  select * into r from public.company_feature(b, 'employees');
  perform pf.ok(not r.available, 'Basic: employees not available (decision pending → deny, never unlimited)');
  select * into r from public.company_feature(p, 'employees');
  perform pf.ok(r.available and r.max_allowed = 25, 'Pro (trial): 25 employees');
  select * into r from public.company_feature(p, 'payroll');
  perform pf.ok(r.available and r.max_allowed is null, 'Pro: payroll available');
  select * into r from public.company_feature(x, 'branches');
  perform pf.ok(not r.available, 'no subscription: no feature available');
  begin
    perform public.assert_feature_available(b, 'payroll'); msg := 'allowed';
  exception when others then msg := sqlerrm; end;
  perform pf.ok(msg = 'PLAN_FEATURE_UNAVAILABLE', 'assert: payroll on Basic refused');
  begin
    perform public.assert_feature_available(p, 'employees'); msg := '';
  exception when others then msg := sqlerrm; end;
  perform pf.ok(msg = '', 'assert: an employee on Pro allowed (0 of 25)');
end $$;
update public.company_subscriptions set status = 'canceled' where company_id = '9c000000-0000-4000-8000-00000000000c';
do $$ declare r record; begin
  select * into r from public.company_feature('9c000000-0000-4000-8000-00000000000c', 'employees');
  perform pf.ok(not r.available, 'a canceled subscription loses the features');
end $$;
-- Isolation: a user who is not a member gets no row.
do $$ declare n int; begin
  perform set_config('request.jwt.claims', '{"sub":"9a000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.company_feature('9c000000-0000-4000-8000-00000000000b', 'branches');
  reset role;
  perform pf.ok(n = 0, 'outsiders read nothing about another company''s plan');
  perform set_config('request.jwt.claims', '{"sub":"9a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.billing_plan_features;
  reset role;
  perform pf.ok(n = 7, 'signed-in users can read the public feature catalog (7 rows)');
  perform set_config('request.jwt.claims', '', true);
end $$;
do $$ begin
  if exists (select 1 from pf.failures) then
    raise exception 'PLAN FEATURE TESTS FAILED: %', (select string_agg(msg, '; ') from pf.failures);
  end if;
  raise notice 'ALL PLAN FEATURE TESTS PASSED';
end $$;
