-- Rollback of 0011: removes the usage function, the member limit and the
-- thresholds, and restores 0010's company_billing_state (calendar month).
-- No business data is touched. Emergency use only.
begin;
set local lock_timeout = '5s';
drop trigger if exists ba_enforce_member_limit on public.memberships;
drop function if exists public.enforce_member_limit();
drop function if exists public.company_usage(uuid);

create or replace function public.company_billing_state(target uuid)
returns table (
  state text, plan text, plan_name text, can_write boolean, trial_eligible boolean, trial_days integer,
  trial_ends_at timestamptz, current_period_start timestamptz, current_period_end timestamptz,
  cancel_at_period_end boolean, cancel_at timestamptz, last_payment_failed_at timestamptz,
  max_clients integer, max_documents_per_month integer, max_members integer,
  clients_used bigint, documents_this_month bigint
)
language sql stable security definer set search_path = '' as $$
  with allowed as (
    select (select auth.uid()) is null or public.is_company_member(target) as ok
  ),
  sub as (
    select s.*,
      case when s.stripe_subscription_id is null then 'none' else s.status end as effective
    from public.company_subscriptions s
    where s.company_id = target
  )
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
    (select count(*) from public.documents d
      where d.company_id = target
        and d.created_at >= date_trunc('month', now() at time zone 'America/Puerto_Rico')
                            at time zone 'America/Puerto_Rico')
  from allowed
  left join sub on true
  left join public.billing_plans p on p.plan = sub.plan and sub.stripe_subscription_id is not null
  where allowed.ok
$$;
revoke all on function public.company_billing_state(uuid) from public, anon;
grant execute on function public.company_billing_state(uuid) to authenticated, service_role;

drop function if exists public.company_usage_window(uuid);
alter table public.billing_config drop constraint if exists billing_config_usage_thresholds_check;
alter table public.billing_config
  drop column if exists usage_warning_percent,
  drop column if exists usage_upgrade_percent;
commit;
