-- Rollback of 0018 (team). Removes the team functions, the invitations and
-- the team history, and the members.invite / members.manage permissions.
-- Memberships created by accepted invitations STAY (they are business
-- data); suspended members stay suspended (0014a's rollback refuses while
-- any is suspended). Refuses while an invitation is still pending and
-- valid, so nobody holding a live link is silently cut off: revoke them
-- first. The team history is dropped only when empty, otherwise kept.
-- Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.invitations') is not null and exists (
       select 1 from public.invitations where accepted_at is null and revoked_at is null and expires_at > now()) then
    raise exception 'BA0018 rollback: pending invitations exist; revoke them first. Nothing was changed.';
  end if;
end $$;
drop function if exists public.create_invitation(uuid, text, text, integer);
drop function if exists public.revoke_invitation(uuid);
drop function if exists public.invitation_preview(text);
drop function if exists public.accept_invitation(text);
drop function if exists public.set_member_role(uuid, uuid, text);
drop function if exists public.set_member_status(uuid, uuid, text);
drop function if exists public.remove_member(uuid, uuid);
drop function if exists public.leave_company(uuid);
drop function if exists public.transfer_ownership(uuid, uuid);
drop function if exists public.company_members(uuid);
drop function if exists public.team_target(uuid, uuid);
drop function if exists public.team_user_email(uuid);
drop function if exists public.team_log(uuid, text, uuid, text, text, text);
drop function if exists public.team_token_hash(text);
drop table if exists public.invitations;
do $$ begin
  if to_regclass('public.team_events') is not null and not exists (select 1 from public.team_events) then
    drop table public.team_events;
  elsif to_regclass('public.team_events') is not null then
    raise notice 'BA0018 rollback: team_events has history and is kept.';
  end if;
end $$;
-- 0011 version of the member-limit trigger function
create or replace function public.enforce_member_limit()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  st record;
  members bigint;
begin
  if (select auth.uid()) is null then
    return new;                                   -- server-side maintenance
  end if;
  select count(*) into members from public.memberships where company_id = new.company_id;
  if members = 0 then
    return new;                                   -- the owner, via create_company
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_billing:' || new.company_id::text, 0));
  select * into st from public.company_billing_state(new.company_id);
  if not found or not st.can_write then
    raise exception 'BILLING_INACTIVE' using errcode = 'P0001', hint = coalesce(st.state, 'none');
  end if;
  if st.max_members is not null and members >= st.max_members then
    raise exception 'PLAN_LIMIT_MEMBERS' using errcode = 'P0001', hint = st.max_members::text;
  end if;
  return new;
end $$;
revoke all on function public.enforce_member_limit() from public, anon, authenticated;

delete from public.role_permissions where permission_key in ('members.invite', 'members.manage');
delete from public.permissions where key in ('members.invite', 'members.manage');
commit;
