-- Rollback of 0017 (plan features). Removes the feature catalog and its
-- functions. Refuses while a module table that depends on it exists
-- (employees / branches): roll those back first. Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.employees') is not null or to_regclass('public.branches') is not null then
    raise exception 'BA0017 rollback: employees/branches exist; roll back those migrations first. Nothing was changed.';
  end if;
end $$;
drop function if exists public.assert_feature_available(uuid, text);
drop function if exists public.company_feature(uuid, text);
drop function if exists public.company_feature_usage(uuid, text);
drop table if exists public.billing_plan_features;
commit;
