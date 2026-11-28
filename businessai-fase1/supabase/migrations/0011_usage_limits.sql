-- =====================================================================
-- BusinessAI · Migration 0011 · Usage limits: 80 % / 90 % warnings,
-- block at 100 %, monthly reset, member limit
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0010. Staging first.
--
-- Builds on 0010 (plans, billing state, enforcement triggers):
-- 1. billing_config: usage_warning_percent (80) and usage_upgrade_percent
--    (90), editable with SQL.
-- 2. public.company_usage_window(company): the period the monthly document
--    limit counts in —
--      * the Stripe billing period when a subscription is in its current
--        period (trialing/active/past_due, period ≤ 35 days): the counter
--        resets on every renewal;
--      * otherwise the calendar month in Puerto Rico time.
-- 3. company_billing_state(): same signature; documents_this_month now
--    counts inside that window (the enforcement trigger uses it).
-- 4. public.company_usage(company): one row per metric — clients, documents
--    (in the window) and members — with used, limit, percent, level
--    (ok | warning ≥ 80 % | upgrade ≥ 90 % | blocked = 100 % | unlimited)
--    and when it resets. For the app's warnings; readable by members only.
-- 5. Member limit: adding a member beyond max_members is blocked. The first
--    member (the owner created by create_company) is never blocked.
--
-- At a limit only NEW rows are refused (clients, documents, extra members).
-- Nothing is ever deleted or modified: data above a lower plan's limit
-- (after a downgrade) stays, and can still be read, edited and printed.
-- Rollback: supabase/rollback/0011_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.company_billing_state(uuid)') is null
     or to_regprocedure('public.enforce_billing_limits()') is null
     or to_regclass('public.billing_config') is null then
    raise exception 'BA0011: migration 0010 (billing) must be applied first';
  end if;
end $$;

-- ------------------------------------------------------------ 1. thresholds
alter table public.billing_config
  add column if not exists usage_warning_percent integer not null default 80,
  add column if not exists usage_upgrade_percent integer not null default 90;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_config_usage_thresholds_check') then
    alter table public.billing_config add constraint billing_config_usage_thresholds_check
      check (usage_warning_percent between 1 and 99
             and usage_upgrade_percent between 1 and 99
             and usage_warning_percent < usage_upgrade_percent);
  end if;
end $$;

-- ------------------------------------------------------- 2. usage window
create or replace function public.company_usage_window(target uuid)
returns table (starts_at timestamptz, resets_at timestamptz, source text)
language sql stable security definer set search_path = '' as $$
  with period as (
    select s.current_period_start as s, s.current_period_end as e
    from public.company_subscriptions s
    where s.company_id = target
      and s.stripe_subscription_id is not null
      and s.status in ('trialing', 'active', 'past_due')
      and s.current_period_start <= now() and now() < s.current_period_end
      and s.current_period_end - s.current_period_start <= interval '35 days'
  ),
  month as (
    select (date_trunc('month', now() at time zone 'America/Puerto_Rico')
              at time zone 'America/Puerto_Rico') as s
  )
  select coalesce((select s from period), (select s from month)),
         coalesce((select e from period), (select s + interval '1 month' from month)),
         case when exists (select 1 from period) then 'billing_period' else 'calendar_month' end
$$;
revoke all on function public.company_usage_window(uuid) from public, anon, authenticated;
grant execute on function public.company_usage_window(uuid) to service_role;

-- --------------------------------- 3. billing state: documents in the window
create or replace function public.company_billing_state(target uuid)
returns table (
  state text,
  plan text,
  plan_name text,
  can_write boolean,
  trial_eligible boolean,
  trial_days integer,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  cancel_at timestamptz,
  last_payment_failed_at timestamptz,
  max_clients integer,
  max_documents_per_month integer,
  max_members integer,
  clients_used bigint,
  documents_this_month bigint
)
language sql stable security definer set search_path = '' as $$
  with allowed as (
    -- members of the company, or server-side callers without a user
    select (select auth.uid()) is null or public.is_company_member(target) as ok
  ),
  sub as (
    select s.*,
      case when s.stripe_subscription_id is null then 'none' else s.status end as effective
    from public.company_subscriptions s
    where s.company_id = target
  ),
  win as (select * from public.company_usage_window(target))
  select
    coalesce(sub.effective, 'none'),
    case when sub.stripe_subscription_id is null then null else sub.plan end,
    case when sub.stripe_subscription_id is null then null else p.name end,
    coalesce(sub.effective in ('trialing', 'active', 'past_due'), false),
    sub.trial_consumed_at is null,
    (select c.trial_days from public.billing_config c where c.id),
    case when sub.effective = 'trialing' then sub.trial_end end,
    sub.current_period_start,
    sub.current_period_end,
    coalesce(sub.cancel_at_period_end, false),
    sub.cancel_at,
    sub.last_payment_failed_at,
    p.max_clients,
    p.max_documents_per_month,
    p.max_members,
    (select count(*) from public.clients c where c.company_id = target),
    (select count(*) from public.documents d, win
      where d.company_id = target and d.created_at >= win.starts_at and d.created_at < win.resets_at)
  from allowed
  left join sub on true
  left join public.billing_plans p on p.plan = sub.plan and sub.stripe_subscription_id is not null
  where allowed.ok
$$;
revoke all on function public.company_billing_state(uuid) from public, anon;
grant execute on function public.company_billing_state(uuid) to authenticated, service_role;

-- ------------------------------------------------------- 4. usage per metric
create or replace function public.company_usage(target uuid)
returns table (
  metric text,
  used bigint,
  max_allowed integer,
  percent integer,
  level text,
  resets_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  with st as (select * from public.company_billing_state(target)),
  cfg as (select usage_warning_percent as w, usage_upgrade_percent as u from public.billing_config where id),
  win as (select * from public.company_usage_window(target)),
  m as (
    select 'clients'::text as metric, st.clients_used as used, st.max_clients as max_allowed, null::timestamptz as resets_at from st
    union all
    select 'documents', st.documents_this_month, st.max_documents_per_month, (select resets_at from win) from st
    union all
    select 'members', (select count(*) from public.memberships mm where mm.company_id = target),
           st.max_members, null from st
  )
  select m.metric, m.used, m.max_allowed,
    case when m.max_allowed is null then null
         else least(100, floor(m.used * 100.0 / m.max_allowed))::int end,
    case when m.max_allowed is null then 'unlimited'
         when m.used >= m.max_allowed then 'blocked'
         when m.used * 100 >= m.max_allowed * (select u from cfg) then 'upgrade'
         when m.used * 100 >= m.max_allowed * (select w from cfg) then 'warning'
         else 'ok' end,
    m.resets_at
  from m
$$;
revoke all on function public.company_usage(uuid) from public, anon;
grant execute on function public.company_usage(uuid) to authenticated, service_role;

-- ------------------------------------------------------- 5. member limit
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

drop trigger if exists ba_enforce_member_limit on public.memberships;
create trigger ba_enforce_member_limit before insert on public.memberships
  for each row execute function public.enforce_member_limit();

-- ------------------------------------------------------------- self-check
do $$
begin
  if has_function_privilege('anon', 'public.company_usage(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.company_usage_window(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.company_usage_window(uuid)', 'EXECUTE') then
    raise exception 'BA0011 self-check failed: usage helpers exposed';
  end if;
  if (select usage_warning_percent from public.billing_config where id) is null then
    raise exception 'BA0011 self-check failed: thresholds missing';
  end if;
end $$;

commit;
