-- =====================================================================
-- READ-ONLY inspection of the storage.objects policies (R3).
-- =====================================================================
-- One SELECT on the catalog: no writes, no DDL. Safe in Production: paste it
-- in SQL Editor → Run (or run it in a read-only transaction). It works before
-- and after 0014a and never changes anything.
--
-- One row per policy on storage.objects (every bucket shares that table):
--   verdict  repository   one of the 5 ba_ policies (0007/0009/0014a)
--            allowed: …   limited to other buckets; 0014a keeps it as is
--            block: …     mentions a company bucket, has no condition or is
--                         not limited by bucket. 0014a STOPS while one exists.
--   qual / with_check     the policy's conditions, for the review.
-- What to do with a "block" row: supabase/RUNBOOK.md §7. Nothing is dropped
-- automatically by any script or migration of this repository for R3.
-- =====================================================================
select c.policyname, c.permissive, c.cmd, c.roles, c.verdict, p.qual, p.with_check
from
    -- BEGIN storage.objects policy classifier (R3). This block is identical in
    -- 0014a_permissions.sql (3x), verify_0014a.sql and inspect_storage_policies.sql.
    -- One row per storage.objects policy that is not one of the 5 repository
    -- ba_ policies, with a verdict:
    --   allowed  the policy is limited, at its top level, to buckets other than
    --            Company-assets / Company-signatures ("bucket_id = '…'" alone or
    --            as one of the AND conditions, in every USING / WITH CHECK);
    --   block    anything else: it mentions a company bucket, has no condition,
    --            or is not limited by bucket (true, OR, <>, lower(bucket_id)…),
    --            so it could grant access to the company buckets.
    -- Conservative by design: what it cannot prove limited is blocked.
    (with
     pol as (
       select p.policyname::text as policyname, p.permissive::text as permissive, p.cmd::text as cmd,
              array_to_string(p.roles, ',') as roles, p.qual, p.with_check
       from pg_policies p
       where p.schemaname = 'storage' and p.tablename = 'objects'
         and p.policyname not in ('ba_company_assets_select', 'ba_company_assets_insert',
                                  'ba_company_signatures_select', 'ba_company_signatures_insert',
                                  'ba_company_signatures_delete')),
     cond as (  -- every condition of every policy (USING and WITH CHECK)
       select pol.policyname, e.kind, e.expr
       from pol cross join lateral (values ('using', pol.qual), ('with check', pol.with_check)) e(kind, expr)
       where e.expr is not null),
     chr as (
       select cond.policyname, cond.kind, cond.expr, g.i, substr(cond.expr, g.i, 1) as c
       from cond cross join lateral generate_series(1, length(cond.expr)) g(i)),
     quoted as (  -- inside a string literal before this character?
       select chr.*, coalesce(sum((chr.c = '''')::int) over (partition by chr.policyname, chr.kind order by chr.i
                                rows between unbounded preceding and 1 preceding), 0) % 2 = 1 as in_quote
       from chr),
     depth as (  -- parenthesis depth after this character, outside string literals
       select quoted.*, sum(case when quoted.in_quote or quoted.c = '''' then 0
                                 when quoted.c = '(' then 1 when quoted.c = ')' then -1 else 0 end)
                          over (partition by quoted.policyname, quoted.kind order by quoted.i) as d
       from quoted),
     shape as (  -- top level of each condition: wrapped in one (…), its AND starts, any OR
       select depth.policyname, depth.kind, depth.expr,
              coalesce(min(depth.d) filter (where depth.i < length(depth.expr)), 0) >= 1
                and left(depth.expr, 1) = '(' and right(depth.expr, 1) = ')' as wrapped,
              bool_or(depth.d = 1 and not depth.in_quote and substr(depth.expr, depth.i, 4) = ' OR ') as top_or,
              array_agg(depth.i + 5 order by depth.i)
                filter (where depth.d = 1 and not depth.in_quote and substr(depth.expr, depth.i, 5) = ' AND ') as and_starts
       from depth group by depth.policyname, depth.kind, depth.expr),
     filtered as (  -- the bucket filter found at the top level of the condition, if any
       select shape.policyname, shape.kind,
              (select m[1] from (
                 select regexp_match(shape.expr, '^\((?:objects\.)?bucket_id = ((?:''[^'']*''::text)|ANY \(ARRAY\[(?:''[^'']*''::text(?:, )?)+\]\))\)$') as m
                 union all
                 select regexp_match(substr(shape.expr, s), '^\((?:objects\.)?bucket_id = ((?:''[^'']*''::text)|ANY \(ARRAY\[(?:''[^'']*''::text(?:, )?)+\]\))\)(?: AND |\)$)')
                 from unnest(array[2] || coalesce(shape.and_starts, '{}'::int[])) s
                 where shape.wrapped and not coalesce(shape.top_or, false)) x
               where m is not null limit 1) as bucket_filter
       from shape),
     verdict as (
       select pol.policyname, pol.permissive, pol.cmd, pol.roles,
              case
                when lower(coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~ 'company-(assets|signatures)'
                  then 'block: mentions Company-assets or Company-signatures'
                when pol.qual is null and pol.with_check is null
                  then 'block: no condition (applies to every bucket)'
                when exists (select 1 from filtered f where f.policyname = pol.policyname and f.bucket_filter is null)
                  then 'block: not limited by bucket (applies to every bucket, including Company-signatures)'
                else 'allowed: limited to bucket ' || (
                  select string_agg(distinct b[1], ', ' order by b[1])
                  from filtered f cross join lateral regexp_matches(f.bucket_filter, '''([^'']*)''', 'g') b
                  where f.policyname = pol.policyname)
              end as verdict
       from pol)
     select verdict.policyname, verdict.permissive, verdict.cmd, verdict.roles, verdict.verdict from verdict)
    -- END storage.objects policy classifier (R3)
  c
join pg_policies p on p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = c.policyname
union all
select p.policyname::text, p.permissive::text, p.cmd::text, array_to_string(p.roles, ','), 'repository', p.qual, p.with_check
from pg_policies p
where p.schemaname = 'storage' and p.tablename = 'objects'
  and p.policyname in ('ba_company_assets_select', 'ba_company_assets_insert',
                       'ba_company_signatures_select', 'ba_company_signatures_insert',
                       'ba_company_signatures_delete')
order by 1;
