-- =====================================================================
-- BusinessAI · Migration 0018 · Team: invitations, roles, members
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a (permissions and
-- memberships.status) and 0011 (member limit).
--
-- Every team change goes through a SECURITY DEFINER function that checks
-- the caller's permission IN THE DATABASE; signed-in users still cannot
-- write memberships or invitations directly (no INSERT/UPDATE/DELETE grant).
--
-- Roles (owner decision: the owner keeps ownership, billing and role
-- assignment; the admin runs operations):
--   members.invite  owner, admin   invite / revoke MEMBER invitations
--   members.manage  owner          invite admins, change roles, suspend,
--                                  reactivate, remove members
--   ownership transfer: only the current owner.
-- Nobody can make an owner by invitation or role change, act on the owner,
-- or act on themselves (except leaving a company they do not own).
--
-- Invitations: a 256-bit random token is returned ONCE to the inviter (for
-- the email link); only its SHA-256 is stored. Valid 1–30 days (default 7).
-- Accepting requires a signed-in user whose account email is the invited
-- email (and, where the auth schema records it, a confirmed email). One
-- pending invitation per company and email (inviting again replaces it);
-- the plan's member limit counts members plus pending invitations, and the
-- 0011 trigger checks it again on acceptance.
-- public.team_events records every invitation and member change.
-- Rollback: supabase/rollback/0018_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.has_permission(uuid, text)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                      and table_name = 'memberships' and column_name = 'status') then
    raise exception 'BA0018: migration 0014a must be applied first';
  end if;
  if to_regprocedure('public.company_billing_state(uuid)') is null then
    raise exception 'BA0018: migrations 0010/0011 must be applied first';
  end if;
end $$;

-- ------------------------------------------------------- 1. permissions
insert into public.permissions (key, module, description_es, description_en) values
  ('members.invite', 'members', 'Invitar miembros y revocar sus invitaciones', 'Invite members and revoke their invitations'),
  ('members.manage', 'members', 'Invitar administradores, cambiar roles, suspender y quitar miembros', 'Invite admins, change roles, suspend and remove members')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'members.invite'), ('admin', 'members.invite'), ('owner', 'members.manage')
on conflict do nothing;

-- ------------------------------------------------------- 2. invitations
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254
                             and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role text not null check (role in ('admin', 'member')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  check (accepted_at is null or revoked_at is null),
  check (expires_at > created_at)
);
create unique index if not exists invitations_pending_uidx
  on public.invitations (company_id, email) where accepted_at is null and revoked_at is null;
create index if not exists invitations_company_idx on public.invitations (company_id, created_at desc);
alter table public.invitations enable row level security;
revoke all on public.invitations from public, anon, authenticated;
-- The token hash is never readable through the API.
grant select (id, company_id, email, role, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at, revoked_by)
  on public.invitations to authenticated;
grant all on public.invitations to service_role;
drop policy if exists ba_invitations_select on public.invitations;
create policy ba_invitations_select on public.invitations for select to authenticated
  using (public.has_permission(company_id, 'members.invite'));

-- ------------------------------------------------------- 3. team history
create table if not exists public.team_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  actor uuid,
  action text not null check (action in ('invited', 'invitation_revoked', 'invitation_accepted', 'role_changed',
                                         'suspended', 'reactivated', 'removed', 'left', 'ownership_transferred')),
  target_user uuid,
  target_email text,
  role_from text,
  role_to text,
  created_at timestamptz not null default now()
);
create index if not exists team_events_company_idx on public.team_events (company_id, created_at desc);
alter table public.team_events enable row level security;
revoke all on public.team_events from public, anon, authenticated;
grant select on public.team_events to authenticated;
grant all on public.team_events to service_role;
drop policy if exists ba_team_events_select on public.team_events;
create policy ba_team_events_select on public.team_events for select to authenticated
  using (public.has_permission(company_id, 'members.invite'));

-- ------------------------------------------------------- 4. helpers
create or replace function public.team_token_hash(raw text)
returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(raw, ''), 'UTF8')), 'hex')
$$;
revoke all on function public.team_token_hash(text) from public, anon, authenticated;

create or replace function public.team_log(target uuid, act text, who uuid, mail text, r_from text, r_to text)
returns void
language sql security definer set search_path = '' as $$
  insert into public.team_events (company_id, actor, action, target_user, target_email, role_from, role_to)
  values (target, (select auth.uid()), act, who, mail, r_from, r_to)
$$;
revoke all on function public.team_log(uuid, text, uuid, text, text, text) from public, anon, authenticated;

-- The account email of a user, and whether it is confirmed (when the
-- auth schema records confirmation; Supabase does).
create or replace function public.team_user_email(who uuid, out email text, out confirmed boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  j jsonb;
begin
  select to_jsonb(u) into j from auth.users u where u.id = who;
  email := lower(btrim(j ->> 'email'));
  confirmed := case when j ? 'email_confirmed_at' then (j ->> 'email_confirmed_at') is not null else true end;
end $$;
revoke all on function public.team_user_email(uuid) from public, anon, authenticated;

-- ------------------------------------------------------- 5. invitations
create or replace function public.create_invitation(target uuid, invite_email text, invite_role text, valid_days integer default 7)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  mail text := lower(btrim(coalesce(invite_email, '')));
  raw text;
  st record;
  seats bigint;
  inv record;
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not public.has_permission(target, 'members.invite') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if invite_role not in ('admin', 'member') then
    raise exception 'INVITATION_ROLE_INVALID' using errcode = 'P0001';
  end if;
  if invite_role = 'admin' and not public.has_permission(target, 'members.manage') then
    raise exception 'FORBIDDEN_ROLE' using errcode = '42501', detail = 'Only the owner invites admins.';
  end if;
  if char_length(mail) not between 3 and 254 or mail !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVITATION_EMAIL_INVALID' using errcode = 'P0001';
  end if;
  if valid_days is null or valid_days not between 1 and 30 then
    raise exception 'INVITATION_DAYS_INVALID' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_billing:' || target::text, 0));
  if exists (select 1 from public.memberships m join auth.users u on u.id = m.user_id
             where m.company_id = target and lower(btrim(u.email)) = mail) then
    raise exception 'INVITATION_ALREADY_MEMBER' using errcode = 'P0001';
  end if;
  if (select count(*) from public.invitations i where i.company_id = target and i.accepted_at is null
        and i.revoked_at is null and i.expires_at > now() and i.email <> mail) >= 50 then
    raise exception 'INVITATION_LIMIT' using errcode = 'P0001', hint = '50';
  end if;
  select * into st from public.company_billing_state(target);
  if not found or not st.can_write then
    raise exception 'BILLING_INACTIVE' using errcode = 'P0001', hint = coalesce(st.state, 'none');
  end if;
  select (select count(*) from public.memberships m where m.company_id = target)
       + (select count(*) from public.invitations i where i.company_id = target and i.accepted_at is null
            and i.revoked_at is null and i.expires_at > now() and i.email <> mail)
    into seats;
  if st.max_members is not null and seats >= st.max_members then
    raise exception 'PLAN_LIMIT_MEMBERS' using errcode = 'P0001', hint = st.max_members::text;
  end if;
  -- Inviting the same email again replaces the pending invitation (new link).
  update public.invitations i set revoked_at = now(), revoked_by = uid
   where i.company_id = target and i.email = mail and i.accepted_at is null and i.revoked_at is null;
  raw := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
  insert into public.invitations (company_id, email, role, token_hash, invited_by, expires_at)
  values (target, mail, invite_role, public.team_token_hash(raw), uid, now() + make_interval(days => valid_days))
  returning * into inv;
  perform public.team_log(target, 'invited', null, mail, null, invite_role);
  invitation_id := inv.id; token := raw; expires_at := inv.expires_at;
  return next;
end $$;

create or replace function public.revoke_invitation(invitation uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  inv record;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into inv from public.invitations where id = invitation for update;
  -- Same answer for "does not exist" and "not yours": nothing leaks.
  if not found or not public.has_permission(inv.company_id, 'members.invite') then
    raise exception 'INVITATION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if inv.role = 'admin' and not public.has_permission(inv.company_id, 'members.manage') then
    raise exception 'FORBIDDEN_ROLE' using errcode = '42501';
  end if;
  if inv.accepted_at is not null or inv.revoked_at is not null then
    raise exception 'INVITATION_NOT_PENDING' using errcode = 'P0001';
  end if;
  update public.invitations set revoked_at = now(), revoked_by = (select auth.uid()) where id = inv.id;
  perform public.team_log(inv.company_id, 'invitation_revoked', null, inv.email, null, inv.role);
end $$;

-- What the invitation page may show to whoever holds the link.
create or replace function public.invitation_preview(raw_token text)
returns table (company_name text, role text, email_hint text, status text)
language sql stable security definer set search_path = '' as $$
  select c.name, i.role,
         left(split_part(i.email, '@', 1), 1) || '***@' || split_part(i.email, '@', 2),
         case when i.revoked_at is not null then 'revoked'
              when i.accepted_at is not null then 'used'
              when i.expires_at <= now() then 'expired'
              else 'valid' end
  from public.invitations i join public.companies c on c.id = i.company_id
  where raw_token ~ '^[0-9a-f]{64}$' and i.token_hash = public.team_token_hash(raw_token)
$$;

create or replace function public.accept_invitation(raw_token text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  inv record;
  me record;
  existing record;
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if raw_token is null or raw_token !~ '^[0-9a-f]{64}$' then
    raise exception 'INVITATION_INVALID' using errcode = 'P0001';
  end if;
  select * into inv from public.invitations where token_hash = public.team_token_hash(raw_token) for update;
  if not found then
    raise exception 'INVITATION_INVALID' using errcode = 'P0001';
  end if;
  if inv.revoked_at is not null then
    raise exception 'INVITATION_REVOKED' using errcode = 'P0001';
  end if;
  if inv.accepted_at is not null then
    raise exception 'INVITATION_USED' using errcode = 'P0001';
  end if;
  if inv.expires_at <= now() then
    raise exception 'INVITATION_EXPIRED' using errcode = 'P0001';
  end if;
  select * into me from public.team_user_email(uid);
  if me.email is distinct from inv.email then
    raise exception 'INVITATION_EMAIL_MISMATCH' using errcode = 'P0001';
  end if;
  if not me.confirmed then
    raise exception 'INVITATION_EMAIL_UNCONFIRMED' using errcode = 'P0001';
  end if;
  select * into existing from public.memberships where company_id = inv.company_id and user_id = uid;
  if found then
    -- A suspended member cannot reactivate themselves with an invitation.
    raise exception 'INVITATION_ALREADY_MEMBER' using errcode = 'P0001', hint = existing.status;
  end if;
  -- The 0011 trigger checks the plan's member limit and the subscription.
  insert into public.memberships (company_id, user_id, role, status) values (inv.company_id, uid, inv.role, 'active');
  update public.invitations set accepted_at = now(), accepted_by = uid where id = inv.id;
  perform public.team_log(inv.company_id, 'invitation_accepted', uid, inv.email, null, inv.role);
  return inv.company_id;
end $$;

-- 0011's member-limit trigger read the billing state AS THE JOINING USER,
-- who is not a member yet, so company_billing_state() returned nothing and
-- every acceptance failed with BILLING_INACTIVE. The state is now read as
-- the server (claims cleared only for that read, then restored); the
-- limit and the subscription check are unchanged.
create or replace function public.enforce_member_limit()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  st record;
  members bigint;
  saved_claims text := current_setting('request.jwt.claims', true);
  saved_sub text := current_setting('request.jwt.claim.sub', true);
begin
  if (select auth.uid()) is null then
    return new;                                   -- server-side maintenance
  end if;
  select count(*) into members from public.memberships where company_id = new.company_id;
  if members = 0 then
    return new;                                   -- the owner, via create_company
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_billing:' || new.company_id::text, 0));
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select * into st from public.company_billing_state(new.company_id);
  perform set_config('request.jwt.claims', coalesce(saved_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(saved_sub, ''), true);
  if not found or not st.can_write then
    raise exception 'BILLING_INACTIVE' using errcode = 'P0001', hint = coalesce(st.state, 'none');
  end if;
  if st.max_members is not null and members >= st.max_members then
    raise exception 'PLAN_LIMIT_MEMBERS' using errcode = 'P0001', hint = st.max_members::text;
  end if;
  return new;
end $$;
revoke all on function public.enforce_member_limit() from public, anon, authenticated;

-- ------------------------------------------------------- 6. members
-- Common checks for acting on another member (members.manage, not the
-- owner, not yourself). Returns the target membership, locked.
create or replace function public.team_target(target uuid, member_user uuid)
returns public.memberships
language plpgsql security definer set search_path = '' as $$
declare
  m public.memberships;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not public.has_permission(target, 'members.manage') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into m from public.memberships where company_id = target and user_id = member_user for update;
  if not found then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if m.user_id = (select auth.uid()) then
    raise exception 'MEMBER_SELF' using errcode = 'P0001';
  end if;
  if m.role = 'owner' then
    raise exception 'MEMBER_IS_OWNER' using errcode = 'P0001';
  end if;
  return m;
end $$;
revoke all on function public.team_target(uuid, uuid) from public, anon, authenticated;

create or replace function public.set_member_role(target uuid, member_user uuid, new_role text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.memberships;
begin
  if new_role not in ('admin', 'member') then
    raise exception 'MEMBER_ROLE_INVALID' using errcode = 'P0001';
  end if;
  m := public.team_target(target, member_user);
  if m.role = new_role then
    return;
  end if;
  update public.memberships set role = new_role where id = m.id;
  perform public.team_log(target, 'role_changed', member_user, null, m.role, new_role);
end $$;

create or replace function public.set_member_status(target uuid, member_user uuid, new_status text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.memberships;
begin
  if new_status not in ('active', 'suspended') then
    raise exception 'MEMBER_STATUS_INVALID' using errcode = 'P0001';
  end if;
  m := public.team_target(target, member_user);
  if m.status = new_status then
    return;
  end if;
  update public.memberships set status = new_status where id = m.id;
  perform public.team_log(target, case when new_status = 'suspended' then 'suspended' else 'reactivated' end,
                          member_user, null, m.role, m.role);
end $$;

create or replace function public.remove_member(target uuid, member_user uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.memberships;
begin
  m := public.team_target(target, member_user);
  delete from public.memberships where id = m.id;
  perform public.team_log(target, 'removed', member_user, null, m.role, null);
end $$;

-- A member (not the owner) leaves a company.
create or replace function public.leave_company(target uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.memberships;
begin
  select * into m from public.memberships where company_id = target and user_id = (select auth.uid()) for update;
  if not found then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if m.role = 'owner' then
    raise exception 'MEMBER_IS_OWNER' using errcode = 'P0001', detail = 'Transfer the ownership first.';
  end if;
  delete from public.memberships where id = m.id;
  perform public.team_log(target, 'left', m.user_id, null, m.role, null);
end $$;

-- The owner hands the company to an ACTIVE member; the old owner becomes admin.
create or replace function public.transfer_ownership(target uuid, new_owner uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  me public.memberships;
  m public.memberships;
begin
  select * into me from public.memberships
   where company_id = target and user_id = (select auth.uid()) and status = 'active' for update;
  if not found or me.role <> 'owner' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into m from public.memberships where company_id = target and user_id = new_owner for update;
  if not found or m.user_id = me.user_id then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if m.status <> 'active' then
    raise exception 'MEMBER_SUSPENDED' using errcode = 'P0001';
  end if;
  update public.memberships set role = 'admin' where id = me.id;
  update public.memberships set role = 'owner' where id = m.id;
  perform public.team_log(target, 'ownership_transferred', new_owner, null, m.role, 'owner');
end $$;

-- Team list with account emails (members.view).
create or replace function public.company_members(target uuid)
returns table (user_id uuid, email text, role text, status text, joined_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email, m.role, m.status, m.created_at
  from public.memberships m left join auth.users u on u.id = m.user_id
  where m.company_id = target and public.has_permission(target, 'members.view')
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at
$$;

do $$
declare
  f text;
begin
  foreach f in array array['create_invitation(uuid, text, text, integer)', 'revoke_invitation(uuid)',
    'accept_invitation(text)', 'set_member_role(uuid, uuid, text)', 'set_member_status(uuid, uuid, text)',
    'remove_member(uuid, uuid)', 'leave_company(uuid)', 'transfer_ownership(uuid, uuid)', 'company_members(uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------ self-check
do $$
begin
  if has_table_privilege('authenticated', 'public.invitations', 'INSERT')
     or has_table_privilege('authenticated', 'public.invitations', 'UPDATE')
     or has_column_privilege('authenticated', 'public.invitations', 'token_hash', 'SELECT')
     or has_table_privilege('anon', 'public.invitations', 'SELECT')
     or has_table_privilege('authenticated', 'public.team_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.memberships', 'INSERT')
     or has_table_privilege('authenticated', 'public.memberships', 'UPDATE')
     or has_table_privilege('authenticated', 'public.memberships', 'DELETE') then
    raise exception 'BA0018 self-check failed: direct writes or token hash exposed';
  end if;
  if exists (select 1 from public.role_permissions where role <> 'owner' and permission_key = 'members.manage')
     or exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'members.invite') then
    raise exception 'BA0018 self-check failed: role matrix';
  end if;
end $$;

commit;
