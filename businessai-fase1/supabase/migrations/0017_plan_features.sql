-- =====================================================================
-- BusinessAI · Migration 0017 · Plan features (Phase B: controls per plan)
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0010/0011.
--
-- Plan limits beyond clients / documents / members, for the modules of
-- Phases C–E (branches, employees and time clock, payroll). DENY BY DEFAULT:
-- a feature is available on a plan only when a row exists here; a missing
-- row means "not available" (never "unlimited"). Only the owner's approved
-- decisions are seeded:
--   branches    Basic 1 · Pro 3 · Premium 10
--   employees   Basic 3 · Pro 25 · Premium 100 active employees
--   time_clock  Basic · Pro · Premium (the time clock is included from Basic)
--   payroll     Pro · Premium (Basic has no payroll)
--
-- public.company_feature(target, feature) → (available, max_allowed, used)
-- is what the app and the module triggers ask. max_allowed NULL with
-- available = true means unlimited. A company without an active
-- subscription or trial has no feature available.
-- Rollback: supabase/rollback/0017_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.billing_plans') is null
     or to_regprocedure('public.company_billing_state(uuid)') is null then
    raise exception 'BA0017: migrations 0010 and 0011 must be applied first';
  end if;
end $$;

create table if not exists public.billing_plan_features (
  plan text not null references public.billing_plans(plan) on delete cascade,
  feature text not null check (feature in ('branches', 'employees', 'time_clock', 'payroll')),
  max_allowed integer check (max_allowed is null or max_allowed >= 0),
  primary key (plan, feature)
);
alter table public.billing_plan_features enable row level security;
revoke all on public.billing_plan_features from public, anon, authenticated;
grant select on public.billing_plan_features to authenticated;
grant all on public.billing_plan_features to service_role;
-- The catalog is not sensitive (same as billing_plans).
drop policy if exists ba_billing_plan_features_select on public.billing_plan_features;
create policy ba_billing_plan_features_select on public.billing_plan_features for select to authenticated using (true);

insert into public.billing_plan_features (plan, feature, max_allowed) values
  ('basic', 'branches', 1), ('pro', 'branches', 3), ('premium', 'branches', 10),
  ('basic', 'employees', 3), ('pro', 'employees', 25), ('premium', 'employees', 100),
  ('basic', 'time_clock', null), ('pro', 'time_clock', null), ('premium', 'time_clock', null),
  ('pro', 'payroll', null), ('premium', 'payroll', null)
on conflict (plan, feature) do nothing;

-- Usage of a feature: counted by the module that owns it, once it exists.
create or replace function public.company_feature_usage(target uuid, feature text)
returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  n integer := 0;
begin
  if feature = 'employees' and to_regclass('public.employees') is not null then
    execute 'select count(*) from public.employees where company_id = $1 and status = ''active'''
      into n using target;
  elsif feature = 'branches' and to_regclass('public.branches') is not null then
    execute 'select count(*) from public.branches where company_id = $1 and archived_at is null'
      into n using target;
  end if;
  return n;
end $$;
revoke all on function public.company_feature_usage(uuid, text) from public, anon, authenticated;
grant execute on function public.company_feature_usage(uuid, text) to service_role;

create or replace function public.company_feature(target uuid, feature text)
returns table (available boolean, max_allowed integer, used integer)
language sql stable security definer set search_path = '' as $$
  with allowed as (
    select (select auth.uid()) is null or public.is_company_member(target) as ok
  ),
  st as (select * from public.company_billing_state(target)),
  f as (
    select pf.max_allowed from public.billing_plan_features pf, st
    where st.can_write and pf.plan = st.plan and pf.feature = company_feature.feature
  )
  select exists (select 1 from f),
         (select f.max_allowed from f),
         public.company_feature_usage(target, feature)
  from allowed
  where allowed.ok
$$;
revoke all on function public.company_feature(uuid, text) from public, anon;
grant execute on function public.company_feature(uuid, text) to authenticated, service_role;

-- For module triggers (Phases C–E): raise unless one more is allowed.
create or replace function public.assert_feature_available(target uuid, feature text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  -- Serialise concurrent creations for one company and feature.
  perform pg_advisory_xact_lock(hashtextextended('ba_feature:' || target::text || ':' || feature, 0));
  select * into r from public.company_feature(target, feature);
  if not found or not r.available then
    raise exception 'PLAN_FEATURE_UNAVAILABLE' using errcode = 'P0001', hint = feature;
  end if;
  if r.max_allowed is not null and r.used >= r.max_allowed then
    raise exception 'PLAN_LIMIT_%', upper(feature) using errcode = 'P0001', hint = r.max_allowed::text;
  end if;
end $$;
revoke all on function public.assert_feature_available(uuid, text) from public, anon, authenticated;
grant execute on function public.assert_feature_available(uuid, text) to service_role;

do $$
begin
  if (select count(*) from public.billing_plan_features) < 11 then
    raise exception 'BA0017 self-check failed: feature catalog';
  end if;
  if exists (select 1 from public.billing_plan_features where plan = 'basic' and feature = 'payroll') then
    raise exception 'BA0017 self-check failed: Basic has no payroll';
  end if;
  if has_function_privilege('authenticated', 'public.assert_feature_available(uuid, text)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.billing_plan_features', 'INSERT') then
    raise exception 'BA0017 self-check failed: privileges';
  end if;
end $$;

commit;
