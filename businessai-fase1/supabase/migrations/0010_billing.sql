-- =====================================================================
-- BusinessAI · Migration 0010 · Billing: plans, card-required trial, access
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Separate approval.
-- Apply on STAGING first (docs/ENVIRONMENTS.md). Requires 0001/0004.
--
-- Trial model (owner decision): 7-day free trial WITH a card collected by
-- Stripe Checkout at sign-up. The trial is a Stripe trial: nothing is
-- charged during it, Stripe charges the chosen plan automatically when it
-- ends, and cancelling before the end means no charge. Without a completed
-- Checkout a company has no access to create records.
--
-- 1. public.billing_plans — plan catalog and limits (editable with SQL).
--    Prices live in Stripe, found by lookup key (test and live separate).
-- 2. public.billing_config — trial length used by Checkout (single row).
-- 3. company_subscriptions — Stripe trial/cancellation/end dates, last
--    payment failure, and trial_consumed_at: ONE trial per company, set by
--    the database the first time a subscription with a trial is stored and
--    never cleared (a later subscription without trial cannot reset it).
-- 4. public.company_billing_state(company) — single source of truth for
--    access (used by the app and by the triggers below).
-- 5. Triggers on clients/documents: creating rows requires trialing /
--    active / past_due and respects plan limits. Reading, printing,
--    editing, status changes and recording payments are never blocked.
--
-- Rollback: supabase/rollback/0010_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.company_subscriptions') is null
     or to_regclass('public.clients') is null
     or to_regclass('public.documents') is null then
    raise exception 'BA0010: company_subscriptions, clients and documents must exist';
  end if;
  if to_regprocedure('public.is_company_member(uuid)') is null then
    raise exception 'BA0010: public.is_company_member(uuid) not found';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. plans
create table if not exists public.billing_plans (
  plan text primary key check (plan in ('basic', 'pro', 'premium')),
  name text not null,
  stripe_lookup_key text not null unique,
  max_clients integer check (max_clients is null or max_clients > 0),
  max_documents_per_month integer check (max_documents_per_month is null or max_documents_per_month > 0),
  max_members integer check (max_members is null or max_members > 0),
  sort_order integer not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Default limits: a PROPOSAL, editable at any time with SQL (NULL = unlimited).
insert into public.billing_plans
  (plan, name, stripe_lookup_key, max_clients, max_documents_per_month, max_members, sort_order)
values
  ('basic',   'Básico',  'businessai_basic_monthly',   50,   40,   1, 1),
  ('pro',     'Pro',     'businessai_pro_monthly',     500,  300,  3, 2),
  ('premium', 'Premium', 'businessai_premium_monthly', null, null, 10, 3)
on conflict (plan) do nothing;

alter table public.billing_plans enable row level security;
revoke all on public.billing_plans from public, anon, authenticated;
-- The catalog is not sensitive: readable for a future public pricing page.
grant select on public.billing_plans to anon, authenticated;
grant all on public.billing_plans to service_role;
drop policy if exists ba_billing_plans_select on public.billing_plans;
create policy ba_billing_plans_select on public.billing_plans for select to anon, authenticated
  using (active);

-- --------------------------------------------------------------- 2. config
create table if not exists public.billing_config (
  id boolean primary key default true check (id),
  trial_days integer not null default 7 check (trial_days between 1 and 30),
  updated_at timestamptz not null default now()
);
insert into public.billing_config (id) values (true) on conflict (id) do nothing;
alter table public.billing_config enable row level security;
revoke all on public.billing_config from public, anon, authenticated;
grant all on public.billing_config to service_role;

-- -------------------------------------------------- 3. subscription columns
alter table public.company_subscriptions
  add column if not exists trial_start timestamptz,
  add column if not exists trial_end timestamptz,
  add column if not exists trial_consumed_at timestamptz,
  add column if not exists cancel_at timestamptz,
  add column if not exists canceled_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists last_payment_failed_at timestamptz,
  add column if not exists last_payment_error text,
  add column if not exists stripe_synced_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'company_subscriptions_plan_fkey'
                   and conrelid = 'public.company_subscriptions'::regclass) then
    alter table public.company_subscriptions
      add constraint company_subscriptions_plan_fkey
      foreign key (plan) references public.billing_plans(plan);
  end if;
end $$;

-- One trial per company: once consumed it stays consumed, whatever later
-- subscriptions (without trial) write into trial_start.
create or replace function public.keep_trial_consumed()
returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.trial_consumed_at := coalesce(old.trial_consumed_at, new.trial_consumed_at, new.trial_start);
  else
    new.trial_consumed_at := coalesce(new.trial_consumed_at, new.trial_start);
  end if;
  return new;
end $$;
revoke all on function public.keep_trial_consumed() from public, anon, authenticated;

drop trigger if exists ba_keep_trial_consumed on public.company_subscriptions;
create trigger ba_keep_trial_consumed before insert or update on public.company_subscriptions
  for each row execute function public.keep_trial_consumed();

-- Members can read their company's subscription (existing policy); nobody
-- but service_role (webhook, checkout route) writes it.
revoke insert, update, delete, truncate on public.company_subscriptions from public, anon, authenticated;

-- ------------------------------------------------------ 4. effective state
-- state: none | trialing | active | past_due | canceled | unpaid |
--        incomplete | incomplete_expired | paused
-- none = no Stripe subscription yet (Checkout not completed).
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

-- --------------------------------------------------- 5. enforcement trigger
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

drop trigger if exists ba_enforce_billing_clients on public.clients;
create trigger ba_enforce_billing_clients before insert on public.clients
  for each row execute function public.enforce_billing_limits();
drop trigger if exists ba_enforce_billing_documents on public.documents;
create trigger ba_enforce_billing_documents before insert on public.documents
  for each row execute function public.enforce_billing_limits();

-- ------------------------------------------------------------- self-check
do $$
begin
  if (select count(*) from public.billing_plans) < 3 then
    raise exception 'BA0010 self-check failed: plans missing';
  end if;
  if has_table_privilege('authenticated', 'public.company_subscriptions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.company_subscriptions', 'INSERT') then
    raise exception 'BA0010 self-check failed: authenticated can write subscriptions';
  end if;
  if has_function_privilege('anon', 'public.company_billing_state(uuid)', 'EXECUTE') then
    raise exception 'BA0010 self-check failed: anon can read billing state';
  end if;
  if has_table_privilege('authenticated', 'public.billing_plans', 'INSERT')
     or has_table_privilege('authenticated', 'public.billing_plans', 'UPDATE') then
    raise exception 'BA0010 self-check failed: authenticated can edit plans';
  end if;
end $$;

commit;
