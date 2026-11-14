-- =====================================================================
-- READ-ONLY preview of migration 0007 (Company-assets storage policies).
-- =====================================================================
-- One SELECT on the catalog and storage.buckets (plus a COUNT of objects
-- per bucket; no file names, no rows): no writes, no DDL. Safe in
-- Production: SQL Editor → Run. It changes nothing.
--
-- It applies EXACTLY the conditions of 0007_storage_company_assets.sql:
--   * 0007 aborts if bucket 'Company-assets' does not exist;
--   * 0007 aborts if a non-ba_ policy on storage.objects has no 'bucket_id'
--     in its conditions (guard);
--   * 0007 drops every non-ba_ policy whose USING/WITH CHECK contains
--     'company-assets' in any letter case (ILIKE), whatever its name;
--   * 0007 then (re)creates ba_company_assets_select / _insert.
--
-- Rows (kind):
--   bucket   every bucket, with its object count. A bucket called
--            'company-assets' or 'COMPANY-ASSETS' (other case) is a STOP:
--            the "dead" policies would then govern it, and 0007 drops them.
--   policy   every storage.objects policy: what 0007 does with it.
--   summary  totals. Expected in Production (inspection of 2026-11-08):
--            11 dropped, 0 guard failures, 0 kept, 0 stop.
-- What to do with a STOP: supabase/RUNBOOK.md §3 step 2 and §7.
-- =====================================================================
with
pol as (
  select p.policyname::text as name, p.cmd::text as cmd,
         coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') as cond,
         p.policyname like 'ba\_%' as is_ba
  from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects'),
pol_verdict as (
  select pol.name, pol.cmd,
         substring(pol.cond from 'bucket_id = ''([^'']*)''') as bucket_literal,
         pol.name ~ '[^[:print:]]' or pol.name <> btrim(pol.name) as invisible_chars,
         not pol.is_ba and pol.cond ilike '%company-assets%' as dropped_by_0007,
         pol.is_ba or pol.cond ilike '%bucket_id%' as passes_0007_guard,
         case
           when pol.is_ba then 'repository (ba_): 0007 recreates ba_company_assets_*; leaves the others'
           when pol.cond not ilike '%bucket_id%' then 'STOP: no bucket_id, 0007 aborts (guard); review it'
           when pol.cond ilike '%company-assets%' then 'dropped by 0007'
           else 'kept by 0007 (does not mention company-assets); review with inspect_storage_policies.sql'
         end as verdict
  from pol),
buckets as (
  select b.id::text as name, b.public,
         (select count(*) from storage.objects o where o.bucket_id = b.id) as objects
  from storage.buckets b)
select 'bucket' as kind, b.name, null::text as cmd, null::text as bucket_literal, null::boolean as invisible_chars,
       null::boolean as dropped_by_0007, null::boolean as passes_0007_guard,
       'public=' || b.public || ', objects=' || b.objects || ' — ' ||
       case
         when lower(b.name) = 'company-assets' and b.name <> 'Company-assets'
           then 'STOP: same name as Company-assets in another case; the old policies apply to THIS bucket'
         when b.name = 'Company-assets' then 'ok: the real logo bucket (0007 requires it)'
         when b.name = 'Company-signatures' then 'ok: private signatures bucket (0009)'
         else 'ok: other bucket, 0007 does not touch its policies'
       end as verdict
from buckets b
union all
select 'bucket', 'Company-assets', null, null, null, null, null,
       'STOP: bucket Company-assets not found, 0007 aborts'
where not exists (select 1 from storage.buckets where id = 'Company-assets')
union all
select 'policy', v.name, v.cmd, v.bucket_literal, v.invisible_chars, v.dropped_by_0007, v.passes_0007_guard, v.verdict
from pol_verdict v
union all
select 'summary', 'totals', null, null, null, null, null,
       'dropped=' || count(*) filter (where v.dropped_by_0007)
       || ', guard_failures=' || count(*) filter (where not v.passes_0007_guard)
       || ', kept_non_ba=' || count(*) filter (where v.verdict like 'kept%')
       || ', ba=' || count(*) filter (where v.verdict like 'repository%')
       || ', stop=' || (count(*) filter (where v.verdict like 'STOP%')
                        + (select count(*) from buckets b where lower(b.name) = 'company-assets' and b.name <> 'Company-assets')
                        + (select count(*) from (select 1 where not exists (select 1 from storage.buckets where id = 'Company-assets')) x))
       || ' (Production expectation: dropped=11, guard_failures=0, kept_non_ba=0, ba=0, stop=0)'
from pol_verdict v
order by 1, 2;
