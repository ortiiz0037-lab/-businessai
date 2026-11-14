-- Rollback of 0016 (billing hardening). Restores 0011's
-- company_billing_state and 0010's enforce_billing_limits (receipts count
-- again) and removes the per-person trial claim. Emergency use only.
-- trial_claims is dropped: after the rollback trials are per company again
-- (company_subscriptions.trial_consumed_at is untouched).
begin;
set local lock_timeout = '5s';

drop function if exists public.claim_trial(uuid, uuid);
drop function if exists public.user_trial_available(uuid, uuid);
drop function if exists public.user_trial_used_elsewhere(uuid, uuid);
drop table if exists public.trial_claims;

-- 0011 version
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

-- 0010 version
create or replace function public.enforce_billing_limits()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  st record;
begin
  -- Server-side maintenance (service_role / SQL editor) is not limited.
  if (select auth.uid()) is null then
    return new;
  end if;

  -- Not a member: let RLS reject the row with its usual error (42501).
  if not public.is_company_member(new.company_id) then
    return new;
  end if;

  -- Serialise concurrent creations for one company so limits hold.
  perform pg_advisory_xact_lock(hashtextextended('ba_billing:' || new.company_id::text, 0));

  select * into st from public.company_billing_state(new.company_id);
  if not found or not st.can_write then
    raise exception 'BILLING_INACTIVE'
      using errcode = 'P0001', hint = coalesce(st.state, 'none'),
            detail = 'A trial or an active subscription is required to create records.';
  end if;

  if tg_table_name = 'clients' and st.max_clients is not null
     and st.clients_used >= st.max_clients then
    raise exception 'PLAN_LIMIT_CLIENTS'
      using errcode = 'P0001', hint = st.max_clients::text;
  end if;

  if tg_table_name = 'documents' and st.max_documents_per_month is not null
     and st.documents_this_month >= st.max_documents_per_month then
    raise exception 'PLAN_LIMIT_DOCUMENTS'
      using errcode = 'P0001', hint = st.max_documents_per_month::text;
  end if;

  return new;
end $$;
revoke all on function public.enforce_billing_limits() from public, anon, authenticated;
commit;
