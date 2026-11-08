-- Rollback of 0010. Removes the billing enforcement and catalog.
-- WARNING: drops the columns/tables added by 0010, including the Stripe
-- dates synced since and trial_consumed_at (the one-trial-per-company
-- record). Stripe keeps the subscriptions; they can be re-synced. Use right
-- after applying, or in an emergency.
begin;
set local lock_timeout = '5s';
drop trigger if exists ba_enforce_billing_clients on public.clients;
drop trigger if exists ba_enforce_billing_documents on public.documents;
drop trigger if exists ba_keep_trial_consumed on public.company_subscriptions;
drop function if exists public.enforce_billing_limits();
drop function if exists public.keep_trial_consumed();
drop function if exists public.company_billing_state(uuid);
alter table public.company_subscriptions drop constraint if exists company_subscriptions_plan_fkey;
alter table public.company_subscriptions
  drop column if exists trial_start,
  drop column if exists trial_end,
  drop column if exists trial_consumed_at,
  drop column if exists cancel_at,
  drop column if exists canceled_at,
  drop column if exists ended_at,
  drop column if exists last_payment_failed_at,
  drop column if exists last_payment_error,
  drop column if exists stripe_synced_at;
drop table if exists public.billing_config;
drop table if exists public.billing_plans;
commit;
