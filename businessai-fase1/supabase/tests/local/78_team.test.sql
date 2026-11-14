-- Team (0018) test suite: invitations, roles, members, attacks.
-- TEST-ONLY, local throw-away database. Standalone fixture (schema tm).
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema tm;
create table tm.ctx (key text primary key, val text not null);
create function tm.v(k text) returns text language sql stable as $$ select val from tm.ctx where key = k $$;
create function tm.id(k text) returns uuid language sql stable as $$ select val::uuid from tm.ctx where key = k $$;
create table tm.failures (msg text);
create function tm.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into tm.failures values (msg); end if;
end $$;
grant usage on schema tm to anon, authenticated;
grant select on tm.ctx to anon, authenticated;
grant execute on all functions in schema tm to anon, authenticated;
grant insert on tm.failures to anon, authenticated;
-- Run a statement as a user ('' = anon); returns the error text or ''.
create function tm.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  if who = '' then
    perform set_config('request.jwt.claims', '', true); set local role anon;
  else
    perform set_config('request.jwt.claims', json_build_object('sub', tm.id(who), 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
-- Value of a scalar query run as a user.
create function tm.val(who text, q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', tm.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- Create an invitation as a user and remember its token under key k.
create function tm.invite(who text, company text, mail text, r text, k text) returns text language plpgsql as $$
declare msg text := ''; t text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', tm.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    select token into t from public.create_invitation(tm.id(company), mail, r);
  exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  if msg = '' then insert into tm.ctx values (k, t) on conflict (key) do update set val = excluded.val; end if;
  return msg;
end $$;
create function tm.accept(who text, k text) returns text language sql as $$
  select tm.err(who, format('select public.accept_invitation(%L)', tm.v(k))) $$;
create function tm.role_of(company text, who text) returns text language sql stable as $$
  select role || ':' || status from public.memberships where company_id = tm.id(company) and user_id = tm.id(who) $$;

insert into tm.ctx values
  ('oA', 'a1000000-0000-4000-8000-000000000001'), ('aA', 'a1000000-0000-4000-8000-000000000002'),
  ('mA', 'a1000000-0000-4000-8000-000000000003'), ('oB', 'b1000000-0000-4000-8000-000000000001'),
  ('new1', 'c1000000-0000-4000-8000-000000000001'), ('new2', 'c1000000-0000-4000-8000-000000000002'),
  ('thief', 'c1000000-0000-4000-8000-000000000009'),
  ('A', 'a2000000-0000-4000-8000-000000000001'), ('B', 'b2000000-0000-4000-8000-000000000001'),
  ('C', 'c2000000-0000-4000-8000-000000000001');
insert into auth.users (id, email) values
  (tm.id('oA'), 'owner.a@example.test'), (tm.id('aA'), 'admin.a@example.test'), (tm.id('mA'), 'member.a@example.test'),
  (tm.id('oB'), 'owner.b@example.test'), (tm.id('new1'), 'New.One@Example.test'), (tm.id('new2'), 'new.two@example.test'),
  (tm.id('thief'), 'thief@example.test');
insert into public.companies (id, name, created_by) values
  (tm.id('A'), 'Equipo A', tm.id('oA')), (tm.id('B'), 'Equipo B', tm.id('oB')), (tm.id('C'), 'Equipo C', tm.id('oB'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (tm.id('A'), 'cus_tm_a', 'sub_tm_a', 'premium', 'active'), (tm.id('B'), 'cus_tm_b', 'sub_tm_b', 'premium', 'active'),
  (tm.id('C'), 'cus_tm_c', 'sub_tm_c', 'basic', 'active');
insert into public.memberships (company_id, user_id, role) values
  (tm.id('A'), tm.id('oA'), 'owner'), (tm.id('A'), tm.id('aA'), 'admin'), (tm.id('A'), tm.id('mA'), 'member'),
  (tm.id('B'), tm.id('oB'), 'owner'), (tm.id('C'), tm.id('oB'), 'owner');

-- ------------------------------------------------------ inviting
do $$ begin
  perform tm.ok(tm.invite('mA', 'A', 'x@example.test', 'member', 'k0') like '%FORBIDDEN%', 'a member cannot invite');
  perform tm.ok(tm.invite('aA', 'A', 'new.one@example.test', 'member', 'k1') = '', 'an admin invites a member');
  perform tm.ok(tm.v('k1') ~ '^[0-9a-f]{64}$', 'the token is 256 bits (64 hex)');
  perform tm.ok(tm.invite('aA', 'A', 'x@example.test', 'admin', 'k0') like '%FORBIDDEN_ROLE%', 'privilege escalation: an admin cannot invite an admin');
  perform tm.ok(tm.invite('oA', 'A', 'new.two@example.test', 'admin', 'k2') = '', 'the owner invites an admin');
  perform tm.ok(tm.invite('oA', 'A', 'x@example.test', 'owner', 'k0') like '%INVITATION_ROLE_INVALID%', 'nobody is invited as owner');
  perform tm.ok(tm.invite('oA', 'A', 'not-an-email', 'member', 'k0') like '%INVITATION_EMAIL_INVALID%', 'invalid email refused');
  perform tm.ok(tm.err('oA', format('select * from public.create_invitation(%L, %L, %L, 90)', tm.id('A'), 'y@example.test', 'member')) like '%INVITATION_DAYS_INVALID%', 'validity above 30 days refused');
  perform tm.ok(tm.invite('oA', 'A', 'Member.A@example.test', 'member', 'k0') like '%INVITATION_ALREADY_MEMBER%', 'an existing member (any case) is not invited again');
  perform tm.ok(tm.invite('oB', 'A', 'x@example.test', 'member', 'k0') like '%FORBIDDEN%', 'isolation: the owner of B cannot invite into A');
  perform tm.ok(tm.invite('oB', 'C', 'x@example.test', 'member', 'k0') like '%PLAN_LIMIT_MEMBERS%', 'plan limit: Basic (1 user) cannot invite');
  perform tm.ok((select count(*) from public.invitations where token_hash = tm.v('k1')) = 0
                and (select count(*) from public.invitations where token_hash = public.team_token_hash(tm.v('k1'))) = 1,
                'only the SHA-256 of the token is stored');
end $$;

-- ------------------------------------------------------ reading and direct writes
do $$ begin
  perform tm.ok(tm.val('oA', format('select count(*) from public.invitations where company_id = %L', tm.id('A'))) = '2', 'the owner sees the 2 pending invitations');
  perform tm.ok(tm.val('mA', format('select count(*) from public.invitations where company_id = %L', tm.id('A'))) = '0', 'a member does not see invitations');
  perform tm.ok(tm.val('oB', format('select count(*) from public.invitations where company_id = %L', tm.id('A'))) = '0', 'isolation: B sees no invitation of A');
  perform tm.ok(tm.err('oA', 'select token_hash from public.invitations') like '%permission denied%', 'the token hash is not readable through the API');
  perform tm.ok(tm.err('oA', format('insert into public.invitations (company_id, email, role, token_hash, expires_at) values (%L, %L, %L, %L, now() + interval ''1 day'')',
                tm.id('A'), 'z@example.test', 'admin', repeat('a', 64))) like '%permission denied%', 'no direct insert of invitations');
  perform tm.ok(tm.err('mA', format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', tm.id('A'), tm.id('thief'), 'owner')) like '%permission denied%',
                'no direct insert of memberships');
  perform tm.ok(tm.err('aA', format('update public.memberships set role = %L where user_id = %L', 'owner', tm.id('aA'))) like '%permission denied%',
                'privilege escalation: an admin cannot update its own role directly');
  perform tm.ok(tm.err('oA', 'insert into public.role_permissions (role, permission_key) values (''member'', ''members.manage'')') <> '',
                'the role matrix cannot be changed through the API');
end $$;

-- ------------------------------------------------------ preview and acceptance
do $$ declare r record; begin
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  select * into r from public.invitation_preview(tm.v('k1'));
  reset role;
  perform tm.ok(r.company_name = 'Equipo A' and r.role = 'member' and r.status = 'valid' and r.email_hint = 'n***@example.test',
                'anyone with the link sees company, role and a masked email');
  set local role anon;
  perform tm.ok((select count(*) from public.invitation_preview(repeat('0', 64))) = 0, 'a guessed token shows nothing');
  reset role;
  perform tm.ok(tm.err('', format('select public.accept_invitation(%L)', tm.v('k1'))) like '%permission denied%' or
                tm.err('', format('select public.accept_invitation(%L)', tm.v('k1'))) like '%AUTH_REQUIRED%', 'accepting requires a signed-in user');
  perform tm.ok(tm.accept('thief', 'k1') like '%INVITATION_EMAIL_MISMATCH%', 'attack: a stolen link does not work for another account');
  perform tm.ok(tm.accept('new1', 'k1') = '', 'the invited account accepts (email compared case-insensitively) ' || tm.accept('new1', 'k1'));
  perform tm.ok(tm.role_of('A', 'new1') = 'member:active', 'the new member is an active member');
  perform tm.ok(tm.accept('new1', 'k1') like '%INVITATION_USED%', 'a link works only once');
  perform tm.ok(tm.val('new1', format('select count(*) from public.clients where company_id = %L', tm.id('A'))) = '0'
                and tm.val('new1', format('select public.has_permission(%L, %L)', tm.id('A'), 'clients.view')) = 'true',
                'the new member has the member permissions');
end $$;

-- ------------------------------------------------------ expiry, revoke, replace
do $$ begin
  update public.invitations set created_at = now() - interval '10 days', expires_at = now() - interval '1 second'
   where token_hash = public.team_token_hash(tm.v('k2'));
  perform tm.ok(tm.accept('new2', 'k2') like '%INVITATION_EXPIRED%', 'an expired invitation cannot be accepted');
  perform tm.ok(tm.invite('oA', 'A', 'new.two@example.test', 'admin', 'k3') = '', 'inviting again creates a new link');
  perform tm.ok(tm.accept('new2', 'k2') like '%INVITATION_REVOKED%', 'the replaced link is revoked');
  perform tm.ok(tm.invite('aA', 'A', 'third@example.test', 'member', 'k4') = '', 'admin invites another member');
  perform tm.ok(tm.err('aA', format('select public.revoke_invitation(%L)', (select id from public.invitations where token_hash = public.team_token_hash(tm.v('k3'))))) like '%FORBIDDEN_ROLE%',
                'an admin cannot revoke an admin invitation');
  perform tm.ok(tm.err('oB', format('select public.revoke_invitation(%L)', (select id from public.invitations where token_hash = public.team_token_hash(tm.v('k4'))))) like '%INVITATION_NOT_FOUND%',
                'isolation: B cannot revoke (and learns nothing about) A''s invitation');
  perform tm.ok(tm.err('aA', format('select public.revoke_invitation(%L)', (select id from public.invitations where token_hash = public.team_token_hash(tm.v('k4'))))) = '',
                'the admin revokes a member invitation');
  perform tm.ok(tm.err('aA', format('select public.revoke_invitation(%L)', (select id from public.invitations where token_hash = public.team_token_hash(tm.v('k4'))))) like '%INVITATION_NOT_PENDING%',
                'a revoked invitation cannot be revoked again');
  perform tm.ok(tm.accept('new2', 'k3') = '', 'the admin invitation is accepted: admin ');
  perform tm.ok(tm.role_of('A', 'new2') = 'admin:active', 'the admin invitation is accepted: admin  (state)');
end $$;

-- ------------------------------------------------------ managing members
do $$ begin
  perform tm.ok(tm.err('aA', format('select public.set_member_role(%L, %L, %L)', tm.id('A'), tm.id('mA'), 'admin')) like '%FORBIDDEN%',
                'privilege escalation: an admin cannot promote');
  perform tm.ok(tm.err('oA', format('select public.set_member_role(%L, %L, %L)', tm.id('A'), tm.id('mA'), 'owner')) like '%MEMBER_ROLE_INVALID%',
                'nobody is made owner by a role change');
  perform tm.ok(tm.err('oA', format('select public.set_member_role(%L, %L, %L)', tm.id('A'), tm.id('oA'), 'member')) like '%MEMBER_SELF%',
                'the owner cannot demote itself');
  perform tm.ok(tm.err('oB', format('select public.set_member_role(%L, %L, %L)', tm.id('A'), tm.id('mA'), 'admin')) like '%FORBIDDEN%',
                'isolation: the owner of B cannot change A''s roles');
  perform tm.ok(tm.err('oA', format('select public.set_member_role(%L, %L, %L)', tm.id('A'), tm.id('mA'), 'admin')) = '', 'the owner promotes a member to admin ');
  perform tm.ok(tm.role_of('A', 'mA') = 'admin:active', 'the owner promotes a member to admin  (state)');
  perform tm.ok(tm.err('oA', format('select public.set_member_role(%L, %L, %L)', tm.id('A'), tm.id('mA'), 'member')) = '', 'and demotes it back');
  perform tm.ok(tm.err('oA', format('select public.set_member_status(%L, %L, %L)', tm.id('A'), tm.id('mA'), 'suspended')) = '', 'the owner suspends a member');
  perform tm.ok(tm.role_of('A', 'mA') = 'member:suspended', 'the owner suspends a member (state)');
  perform tm.ok(tm.val('mA', format('select public.has_permission(%L, %L)', tm.id('A'), 'documents.view')) = 'false',
                'a suspended member loses every permission');
  perform tm.ok(tm.invite('oA', 'A', 'member.a@example.test', 'member', 'k5') like '%INVITATION_ALREADY_MEMBER%',
                'a suspended member is not re-invited (reactivation is explicit)');
  perform tm.ok(tm.err('oA', format('select public.set_member_status(%L, %L, %L)', tm.id('A'), tm.id('mA'), 'active')) = '', 'the owner reactivates the member');
  perform tm.ok(tm.role_of('A', 'mA') = 'member:active', 'the owner reactivates the member (state)');
  perform tm.ok(tm.err('aA', format('select public.remove_member(%L, %L)', tm.id('A'), tm.id('mA'))) like '%FORBIDDEN%', 'an admin cannot remove members');
  perform tm.ok(tm.err('oA', format('select public.remove_member(%L, %L)', tm.id('A'), tm.id('oA'))) like '%MEMBER_SELF%', 'the owner cannot remove itself');
  perform tm.ok(tm.err('oA', format('select public.remove_member(%L, %L)', tm.id('A'), tm.id('new1'))) = '', 'the owner removes a member');
  perform tm.ok(tm.role_of('A', 'new1') is null, 'the owner removes a member (state)');
  perform tm.ok(tm.err('new2', format('select public.leave_company(%L)', tm.id('A'))) = '', 'a member leaves');
  perform tm.ok(tm.role_of('A', 'new2') is null, 'a member leaves (state)');
  perform tm.ok(tm.err('oA', format('select public.leave_company(%L)', tm.id('A'))) like '%MEMBER_IS_OWNER%', 'the owner cannot leave without transferring');
end $$;

-- ------------------------------------------------------ ownership and visibility
do $$ begin
  perform tm.ok(tm.err('aA', format('select public.transfer_ownership(%L, %L)', tm.id('A'), tm.id('aA'))) like '%FORBIDDEN%',
                'privilege escalation: an admin cannot take the ownership');
  perform tm.ok(tm.err('oA', format('select public.transfer_ownership(%L, %L)', tm.id('A'), tm.id('oB'))) like '%MEMBER_NOT_FOUND%',
                'ownership only to a member of the company');
  perform tm.ok(tm.err('oA', format('select public.transfer_ownership(%L, %L)', tm.id('A'), tm.id('aA'))) = '', 'the owner transfers the ownership');
  perform tm.ok(tm.role_of('A', 'aA') = 'owner:active' and tm.role_of('A', 'oA') = 'admin:active', 'the new owner is owner; the old owner becomes admin');
  perform tm.ok(tm.val('oA', format('select public.has_permission(%L, %L)', tm.id('A'), 'members.manage')) = 'false'
                and tm.val('aA', format('select public.has_permission(%L, %L)', tm.id('A'), 'billing.manage')) = 'true',
                'permissions follow the new roles (billing and team management to the new owner)');
  perform tm.ok(tm.val('mA', format('select count(*) from public.company_members(%L)', tm.id('A'))) = '3', 'members see their team (3)');
  perform tm.ok(tm.val('oB', format('select count(*) from public.company_members(%L)', tm.id('A'))) = '0', 'isolation: B sees nobody of A');
  perform tm.ok(tm.val('aA', format('select count(*) from public.team_events where company_id = %L', tm.id('A')))::int >= 12,
                'the owner reads the team history');
  perform tm.ok(tm.val('mA', format('select count(*) from public.team_events where company_id = %L', tm.id('A'))) = '0'
                and tm.val('oB', format('select count(*) from public.team_events where company_id = %L', tm.id('A'))) = '0',
                'members and outsiders do not read the team history');
  perform tm.ok(tm.err('aA', format('delete from public.team_events where company_id = %L', tm.id('A'))) like '%permission denied%',
                'the team history cannot be deleted through the API');
end $$;

do $$ begin
  if exists (select 1 from tm.failures) then
    raise exception 'TEAM TESTS FAILED: %', (select string_agg(msg, '; ') from tm.failures);
  end if;
  raise notice 'ALL TEAM TESTS PASSED';
end $$;
