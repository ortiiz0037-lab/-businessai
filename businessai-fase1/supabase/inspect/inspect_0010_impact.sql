-- =====================================================================
-- READ-ONLY: impact of 0010 (billing) and 0011 (usage limits) on the
-- companies that ALREADY exist, before applying them anywhere with data.
-- =====================================================================
-- One SELECT. Reads only tables of 0001–0004 (companies, memberships,
-- company_subscriptions, clients, documents) and returns COUNTS: no names,
-- emails, amounts or identifiers. No writes. Safe in Production.
--
-- Why: 0010 adds BEFORE INSERT triggers on clients and documents. From
-- that moment a signed-in user can create clients/documents only if the
-- company's subscription is trialing / active / past_due (a Stripe
-- subscription id is required), and within the plan limits. 0011 adds the
-- same check for new members, plus the member limit. Existing rows are
-- never touched; only NEW rows are refused (BILLING_INACTIVE /
-- PLAN_LIMIT_*). Reading, editing, printing and payments are not blocked.
--
-- The limits below are the ones 0010 inserts into billing_plans
-- (basic 50 clients / 40 documents a month / 1 member; pro 500 / 300 / 3;
-- premium unlimited / unlimited / 10). The month is the calendar month in
-- Puerto Rico (0011 uses the Stripe period when there is one).
-- =====================================================================
with
lim(plan, max_clients, max_docs, max_members) as (values
  ('basic', 50, 40, 1), ('pro', 500, 300, 3), ('premium', null::int, null::int, 10)),
co as (
  select c.id,
         s.stripe_subscription_id is not null as has_sub,
         s.status, s.plan,
         (select count(*) from public.clients x where x.company_id = c.id) as clients,
         (select count(*) from public.documents d where d.company_id = c.id
            and d.created_at >= date_trunc('month', now() at time zone 'America/Puerto_Rico')
                                at time zone 'America/Puerto_Rico') as docs_month,
         (select count(*) from public.memberships m where m.company_id = c.id) as members
  from public.companies c
  left join public.company_subscriptions s on s.company_id = c.id),
v as (
  select co.*, l.max_clients, l.max_docs, l.max_members,
         co.has_sub and co.status in ('trialing', 'active', 'past_due') as can_write
  from co left join lim l on l.plan = co.plan and co.has_sub)
select
  (select count(*) from v)                                              as companies,
  (select count(*) from v where can_write)                              as can_create_after_0010,
  (select count(*) from v where not can_write)                          as BLOCKED_after_0010,
  (select count(*) from v where not has_sub)                            as blocked_no_stripe_subscription,
  (select count(*) from v where has_sub and not can_write)              as blocked_by_status,
  (select coalesce(string_agg(x, ', ' order by x), '-') from (
     select coalesce(status, 'no row') || ':' || count(*) as x from v group by status) s) as by_status,
  (select coalesce(string_agg(x, ', ' order by x), '-') from (
     select coalesce(plan, 'no row') || ':' || count(*) as x from v group by plan) s) as by_plan,
  (select count(*) from public.company_subscriptions
    where plan not in ('basic', 'pro', 'premium'))                      as plans_breaking_0010_fk,
  (select count(*) from v where can_write and max_clients is not null and clients >= max_clients)
                                                                        as at_client_limit,
  (select count(*) from v where can_write and max_docs is not null and docs_month >= max_docs)
                                                                        as at_document_limit_this_month,
  (select count(*) from v where can_write and max_members is not null and members > max_members)
                                                                        as over_member_limit_0011,
  (select count(*) from v where can_write and max_members is not null and members >= max_members)
                                                                        as cannot_add_members_0011;
