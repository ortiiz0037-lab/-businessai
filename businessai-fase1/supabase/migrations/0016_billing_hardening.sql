-- =====================================================================
-- BusinessAI · Migration 0016 · Billing hardening
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Staging first, with the owner's
-- authorization; Production only with its own approval. Requires 0011.
-- Independent of 0015 (either order).
--
-- 1. One free trial per PERSON (review finding C3). Until now each company
--    had its own trial, so creating companies chained free trials.
--    public.trial_claims keeps, per user, the company where that user's
--    trial was granted. public.claim_trial(company, user) — service_role
--    only, called by the Checkout route — grants it when:
--      * the company has not consumed a trial, and
--      * no other company the user owns or created has consumed one, and
--      * the user has no claim, or the claim is for this same company, or
--        the earlier claim never became a subscription and is older than
--        25 hours (a Checkout session lives 24 hours: an abandoned
--        checkout does not burn the trial).
--    Concurrent checkouts for two companies: the primary key lets only one
--    claim win. public.user_trial_available(company, user) answers the
--    same question without claiming (for the /billing page).
--    Deleting a company does not free the claim (company_id set null).
-- 2. Receipts do not use the monthly document quota (review finding I8):
--    a receipt is the automatic consequence of a payment already
--    registered on an invoice that counted. Receipts still require an
--    active subscription or trial, like any other document.
--
-- Nothing existing is deleted or rewritten.
-- Rollback: supabase/rollback/0016_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.company_usage_window(uuid)') is null
     or to_regprocedure('public.company_billing_state(uuid)') is null
     or to_regprocedure('public.enforce_billing_limits()') is null then
    raise exception 'BA0016: migrations 0010 and 0011 must be applied first';
  end if;
end $$;

-- ------------------------------------------------ 1. one trial per person
create table if not exists public.trial_claims (
  user_id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  claimed_at timestamptz not null default now()
);
alter table public.trial_claims enable row level security;
revoke all on public.trial_claims from public, anon, authenticated;
grant all on public.trial_claims to service_role;

-- Has the user already used a trial in another company (before this
-- migration too: trial_consumed_at)?
create or replace function public.user_trial_used_elsewhere(target uuid, claimant uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.company_subscriptions s
    join public.companies c on c.id = s.company_id
    where s.company_id <> target
      and s.trial_consumed_at is not null
      and (c.created_by = claimant
           or exists (select 1 from public.memberships m
                      where m.company_id = c.id and m.user_id = claimant and m.role = 'owner'))
  )
$$;
revoke all on function public.user_trial_used_elsewhere(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_trial_used_elsewhere(uuid, uuid) to service_role;

create or replace function public.user_trial_available(target uuid, claimant uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.company_subscriptions s
                     where s.company_id = target and s.trial_consumed_at is not null)
     and not public.user_trial_used_elsewhere(target, claimant)
     and not exists (
       select 1 from public.trial_claims t
       where t.user_id = claimant
         and t.company_id is distinct from target
         and (t.company_id is null
              or t.claimed_at > now() - interval '25 hours'
              or exists (select 1 from public.company_subscriptions s
                         where s.company_id = t.company_id and s.stripe_subscription_id is not null)))
$$;
revoke all on function public.user_trial_available(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_trial_available(uuid, uuid) to service_role;

create or replace function public.claim_trial(target uuid, claimant uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  won uuid;
begin
  if target is null or claimant is null then
    return false;
  end if;
  if exists (select 1 from public.company_subscriptions s
             where s.company_id = target and s.trial_consumed_at is not null)
     or public.user_trial_used_elsewhere(target, claimant) then
    return false;
  end if;
  insert into public.trial_claims as t (user_id, company_id) values (claimant, target)
  on conflict (user_id) do update set company_id = excluded.company_id, claimed_at = now()
    where t.company_id = excluded.company_id
       or (t.company_id is not null
           and t.claimed_at <= now() - interval '25 hours'
           and not exists (select 1 from public.company_subscriptions s
                           where s.company_id = t.company_id and s.stripe_subscription_id is not null))
  returning t.user_id into won;
  return won is not null;
end $$;
revoke all on function public.claim_trial(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_trial(uuid, uuid) to service_role;

-- ------------------------------- 2. receipts outside the document quota
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
    -- Receipts are the consequence of a payment: they do not use the quota.
    (select count(*) from public.documents d, win
      where d.company_id = target and d.document_type <> 'receipt'
        and d.created_at >= win.starts_at and d.created_at < win.resets_at)
  from allowed
  left join sub on true
  left join public.billing_plans p on p.plan = sub.plan and sub.stripe_subscription_id is not null
  where allowed.ok
$$;
revoke all on function public.company_billing_state(uuid) from public, anon;
grant execute on function public.company_billing_state(uuid) to authenticated, service_role;

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

  -- (nested: the same trigger runs on clients, which has no document_type)
  if tg_table_name = 'documents' and st.max_documents_per_month is not null
     and st.documents_this_month >= st.max_documents_per_month then
    if new.document_type <> 'receipt' then
      raise exception 'PLAN_LIMIT_DOCUMENTS'
        using errcode = 'P0001', hint = st.max_documents_per_month::text;
    end if;
  end if;

  return new;
end $$;
revoke all on function public.enforce_billing_limits() from public, anon, authenticated;

-- ------------------------------------------------------------ self-check
do $$
begin
  if has_table_privilege('authenticated', 'public.trial_claims', 'SELECT')
     or has_function_privilege('authenticated', 'public.claim_trial(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.claim_trial(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.user_trial_available(uuid, uuid)', 'EXECUTE') then
    raise exception 'BA0016 self-check failed: trial functions must be service_role only';
  end if;
  if pg_get_functiondef('public.company_billing_state(uuid)'::regprocedure) not like '%document_type <> ''receipt''%'
     or pg_get_functiondef('public.enforce_billing_limits()'::regprocedure) not like '%new.document_type <> ''receipt''%' then
    raise exception 'BA0016 self-check failed: receipts still use the quota';
  end if;
end $$;

commit;
