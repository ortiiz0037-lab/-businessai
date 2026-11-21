-- Permission foundation (0014a) test suite. TEST-ONLY, local throw-away
-- database with 0001–0011 + 0014a. Standalone: its own schema and fixture.
-- Checks what only exists after 0014a: the catalog, has_permission() against
-- the role matrix for every permission, suspended memberships, grants.
-- (Equivalence with the previous behaviour is 72_permission_matrix.sql.)
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema p;
create table p.ctx (key text primary key, id uuid not null);
create function p.id(k text) returns uuid language sql stable as $$ select id from p.ctx where key = k $$;
grant usage on schema p to anon, authenticated;
grant select on p.ctx to anon, authenticated;
grant execute on function p.id(text) to anon, authenticated;
create table p.failures (msg text);
create function p.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into p.failures values (msg); end if;
end $$;
grant insert on p.failures to anon, authenticated;
grant execute on function p.ok(boolean, text) to anon, authenticated;
create function p.as_user(k text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p.id(k), 'role', 'authenticated')::text, true);
end $$;
grant execute on function p.as_user(text) to authenticated;

insert into auth.users (id, email) values
  ('1a000000-0000-4000-8000-0000000000a1', 'p-owner@example.test'),
  ('1a000000-0000-4000-8000-0000000000a2', 'p-admin@example.test'),
  ('1a000000-0000-4000-8000-0000000000a3', 'p-member@example.test'),
  ('1a000000-0000-4000-8000-0000000000a4', 'p-suspended@example.test'),
  ('1b000000-0000-4000-8000-0000000000b1', 'p-other@example.test');
insert into p.ctx values
  ('owner', '1a000000-0000-4000-8000-0000000000a1'), ('admin', '1a000000-0000-4000-8000-0000000000a2'),
  ('member', '1a000000-0000-4000-8000-0000000000a3'), ('suspended', '1a000000-0000-4000-8000-0000000000a4'),
  ('other', '1b000000-0000-4000-8000-0000000000b1'),
  ('A', 'cccccccc-0000-4000-8000-000000000001'), ('B', 'dddddddd-0000-4000-8000-000000000001');
insert into public.companies (id, name, created_by) values
  (p.id('A'), 'Permisos A', p.id('owner')), (p.id('B'), 'Permisos B', p.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (p.id('A'), 'cus_perm_a', 'sub_perm_a', 'premium', 'active'), (p.id('B'), 'cus_perm_b', 'sub_perm_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values
  (p.id('A'), p.id('owner'), 'owner'), (p.id('A'), p.id('admin'), 'admin'), (p.id('A'), p.id('member'), 'member'),
  (p.id('A'), p.id('suspended'), 'admin'), (p.id('B'), p.id('other'), 'owner');
insert into public.clients (company_id, name) values (p.id('A'), 'Cliente A'), (p.id('B'), 'Cliente B');
insert into storage.objects (bucket_id, name, owner) values
  ('Company-signatures', p.id('A') || '/sig.png', p.id('owner'));

-- -------------------------------------------------- catalog and matrix
do $$ begin
  perform p.ok((select count(*) from public.permissions) = 18, 'catalog: 18 permissions');
  perform p.ok((select count(*) from public.role_permissions where role = 'owner') = 18
           and (select count(*) from public.role_permissions where role = 'admin') = 18
           and (select count(*) from public.role_permissions where role = 'member') = 13,
           'matrix: owner 18, admin 18, member 13');
  perform p.ok(not exists (
             select permission_key from public.role_permissions where role = 'owner'
             except select permission_key from public.role_permissions where role = 'admin')
           and not exists (
             select permission_key from public.role_permissions where role = 'admin'
             except select permission_key from public.role_permissions where role = 'owner'),
           'matrix: owner and admin are identical (as today)');
  perform p.ok((select array_agg(permission_key order by permission_key) from (
             select permission_key from public.role_permissions where role = 'owner'
             except select permission_key from public.role_permissions where role = 'member') d)
           = array['billing.manage', 'clients.delete', 'company.branding.manage',
                   'company.settings.manage', 'documents.delete'],
           'matrix: member lacks exactly delete, settings, branding and billing management');
end $$;

-- has_permission() for every permission and role equals the matrix.
do $$
declare r record; mismatches int := 0;
begin
  for r in
    select a.who, a.role, k.key,
           exists (select 1 from public.role_permissions rp where rp.role = a.role and rp.permission_key = k.key) as expected
    from (values ('owner', 'owner'), ('admin', 'admin'), ('member', 'member')) a(who, role)
    cross join public.permissions k
  loop
    perform p.as_user(r.who);
    set local role authenticated;
    if public.has_permission(p.id('A'), r.key) is distinct from r.expected then mismatches := mismatches + 1; end if;
    reset role;
  end loop;
  perform p.ok(mismatches = 0, 'has_permission() matches the matrix for 3 roles × 18 permissions');
end $$;

do $$ begin
  perform p.as_user('other'); set local role authenticated;
  perform p.ok(not public.has_permission(p.id('A'), 'company.view'), 'owner of B has no permission in A');
  perform p.ok(public.has_permission(p.id('B'), 'clients.delete'), 'owner of B has its permissions in B');
  perform p.ok(not public.has_permission(null, 'company.view'), 'null company → false');
  perform p.ok(not public.has_permission(p.id('B'), 'no.such.permission'), 'unknown permission → false');
  reset role;
end $$;

-- ------------------------------------------------- suspended membership
update public.memberships set status = 'suspended'
 where company_id = p.id('A') and user_id = p.id('suspended');
do $$ declare n int; begin
  perform p.as_user('suspended'); set local role authenticated;
  perform p.ok(not public.has_permission(p.id('A'), 'company.view'), 'suspended: has_permission false');
  perform p.ok(not public.is_company_member(p.id('A')), 'suspended: is_company_member false');
  perform p.ok(not public.has_company_role(p.id('A'), array['owner', 'admin']), 'suspended: has_company_role false');
  select count(*) into n from public.clients where company_id = p.id('A');
  perform p.ok(n = 0, 'suspended: sees no clients');
  select count(*) into n from public.companies where id = p.id('A');
  perform p.ok(n = 0, 'suspended: does not see the company');
  select count(*) into n from storage.objects where bucket_id = 'Company-signatures';
  perform p.ok(n = 0, 'suspended: cannot read the signature');
  select count(*) into n from public.memberships where user_id = p.id('suspended');
  perform p.ok(n = 1, 'suspended: still sees its own membership row (as today)');
  reset role;
end $$;

-- ---------------------------------------------------- column and grants
do $$ begin
  begin
    update public.memberships set status = 'paused' where user_id = p.id('member');
    perform p.ok(false, 'status only accepts active or suspended');
  exception when check_violation then perform p.ok(true, 'status only accepts active or suspended'); end;
  perform p.ok((select column_default from information_schema.columns
                 where table_schema = 'public' and table_name = 'memberships' and column_name = 'status')
               like '''active''%', 'status defaults to active');
end $$;

do $$ declare cid uuid; begin
  perform p.as_user('member'); set local role authenticated;
  cid := public.create_company('Nueva desde permisos');
  reset role;
  perform p.ok((select status from public.memberships where company_id = cid) = 'active',
               'create_company: the new owner membership is active');
  perform p.ok((select role from public.memberships where company_id = cid) = 'owner',
               'create_company: still creates the owner membership');
end $$;

do $$ declare n int; begin
  perform p.as_user('member'); set local role authenticated;
  select count(*) into n from public.permissions;
  perform p.ok(n = 18, 'authenticated can read the catalog');
  select count(*) into n from public.role_permissions;
  perform p.ok(n = 49, 'authenticated can read the matrix');
  begin
    insert into public.role_permissions (role, permission_key) values ('member', 'clients.delete');
    perform p.ok(false, 'authenticated cannot grant itself a permission');
  exception when insufficient_privilege then perform p.ok(true, 'authenticated cannot grant itself a permission'); end;
  begin
    delete from public.role_permissions where role = 'member';
    perform p.ok(false, 'authenticated cannot remove permissions');
  exception when insufficient_privilege then perform p.ok(true, 'authenticated cannot remove permissions'); end;
  reset role;
end $$;

do $$ begin
  set local role anon;
  begin
    perform public.has_permission(p.id('A'), 'company.view');
    perform p.ok(false, 'anon cannot execute has_permission');
  exception when insufficient_privilege then perform p.ok(true, 'anon cannot execute has_permission'); end;
  begin
    perform 1 from public.permissions;
    perform p.ok(false, 'anon cannot read the catalog');
  exception when insufficient_privilege then perform p.ok(true, 'anon cannot read the catalog'); end;
  reset role;
end $$;

do $$ begin
  perform p.ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
                 where oid = 'public.has_permission(uuid,text)'::regprocedure),
               'has_permission is SECURITY DEFINER with a fixed empty search_path');
  perform p.ok(not has_function_privilege('public', 'public.has_permission(uuid,text)', 'EXECUTE'),
               'PUBLIC cannot execute has_permission');
end $$;

do $$ begin
  if exists (select 1 from p.failures) then
    raise exception 'PERMISSION TESTS FAILED: %', (select string_agg(msg, '; ') from p.failures);
  end if;
  raise notice 'ALL PERMISSION TESTS PASSED';
end $$;
