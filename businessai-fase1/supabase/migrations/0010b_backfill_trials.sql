-- =====================================================================
-- BusinessAI · 0010b (OPTIONAL, DATA CHANGE) · Trial for existing companies
-- =====================================================================
-- STATUS: DRAFT — run only if the owner decides so, after 0010.
-- 0010 gives a 7-day trial to companies created AFTER it is applied.
-- Companies that already exist and have no company_subscriptions row are
-- "none" → read-only (they can view/print/collect, not create).
-- This script inserts a trial row for those companies only. It never
-- touches a company that already has a row (e.g. a Stripe subscription).
-- =====================================================================
begin;
set local lock_timeout = '5s';

insert into public.company_subscriptions (company_id, plan, status, app_trial_started_at, app_trial_ends_at)
select c.id, cfg.trial_plan, 'trialing', now(), now() + make_interval(days => cfg.trial_days)
from public.companies c
cross join public.billing_config cfg
where not exists (select 1 from public.company_subscriptions s where s.company_id = c.id);

commit;
