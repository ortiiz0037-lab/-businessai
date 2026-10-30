
-- =====================================================
-- BusinessAI
-- Migration 0004
-- Stripe subscriptions and webhook events
-- =====================================================

-- 1. COMPANY SUBSCRIPTIONS
-- One current subscription per company.

create table public.company_subscriptions (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null
    references public.companies(id)
    on delete cascade,

  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_price_id text,

  plan text not null
    check (plan in ('basic', 'pro', 'premium')),

  status text not null default 'incomplete'
    check (
      status in (
        'incomplete',
        'trialing',
        'active',
        'past_due',
        'canceled',
        'unpaid',
        'incomplete_expired',
        'paused'
      )
    ),

  current_period_start timestamptz,
  current_period_end timestamptz,

  cancel_at_period_end boolean
    not null default false,

  created_at timestamptz
    not null default now(),

  updated_at timestamptz
    not null default now(),

  unique (company_id)
);

-- Subscription indexes

create index company_subscriptions_status_idx
  on public.company_subscriptions(status);

create index company_subscriptions_company_idx
  on public.company_subscriptions(company_id);


-- 2. SUBSCRIPTION SECURITY

alter table public.company_subscriptions
  enable row level security;

revoke all on public.company_subscriptions
  from anon;

grant select on public.company_subscriptions
  to authenticated;

create policy company_subscriptions_select
on public.company_subscriptions
for select
to authenticated
using (
  public.is_company_member(company_id)
);

grant all on public.company_subscriptions
  to service_role;


-- 3. STRIPE WEBHOOK EVENTS
-- Tracks processing, successful events and failures.
-- Failed events can be retried safely by the webhook handler.

create table public.stripe_events (
  id text primary key,

  event_type text not null,

  status text not null default 'processing'
    check (
      status in (
        'processing',
        'processed',
        'failed'
      )
    ),

  attempts integer not null default 1
    check (attempts > 0),

  last_error text,

  created_at timestamptz
    not null default now(),

  updated_at timestamptz
    not null default now(),

  processed_at timestamptz
);

-- Webhook indexes

create index stripe_events_status_idx
  on public.stripe_events(status);

create index stripe_events_created_at_idx
  on public.stripe_events(created_at);


-- 4. WEBHOOK SECURITY

alter table public.stripe_events
  enable row level security;

revoke all on public.stripe_events
  from anon, authenticated;

grant all on public.stripe_events
  to service_role;


-- =====================================================
-- END OF MIGRATION 0004
-- =====================================================
