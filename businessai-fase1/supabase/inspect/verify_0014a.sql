-- =====================================================================
-- READ-ONLY verification of migration 0014a_permissions (E3).
-- =====================================================================
-- One SELECT on the catalog and the two permission tables: no writes, no
-- DDL, no functions with side effects. Run it inside a read-only
-- transaction (scripts/staging/apply-migrations.sh does, with
-- default_transaction_read_only=on).
--
-- Requires 0014a to be applied (the script runs it only when 0014a is
-- recorded in ba_meta.applied_migrations); otherwise the query fails.
--
-- Output: one line. "OK" when everything below holds, otherwise the list of
-- problems separated by "; ".
--   1. Permissions and exactly the expected role matrix:
--      after 0014a: 18 permissions; owner 18, admin 18, member 13 (all but
--      the 5 management/delete permissions);
--      after 0015 (detected by public.document_counters): 19 permissions
--      (+ documents.void); owner 19, admin 18 (no billing.manage), member 13
--      after 0018 (public.invitations): + members.invite (owner, admin) and
--      members.manage (owner); after 0019 (public.client_events): +
--      clients.archive (owner, admin); after 0020 (public.employees):
--      workforce.manage (owner, admin); after 0023 (public.journal_entries):
--      accounting.view / manage / post / close (owner, admin) and
--      accounting.reopen (owner); after 0024 (public.bills): payables.view,
--      pay, manage (owner, admin), payables.create and approve (all roles),
--      payables.settings (owner)
--      (no documents.void either).
--   2. has_permission, is_company_member, has_company_role: SECURITY DEFINER,
--      search_path="", executable by authenticated, not by anon or PUBLIC.
--   3. The 24 tenant policies exist and all use has_permission, none the old
--      helpers or a direct memberships lookup.
--   4. memberships.status: not null, default 'active', constraint present.
--   5. permissions / role_permissions: RLS on, no anon read, no writes for
--      authenticated.
--   6. No policy on the 8 tenant tables other than the repository's.
--   7. (R3) No storage.objects policy other than the 5 ba_ policies that
--      mentions a company bucket or is not limited by bucket — the same
--      classifier 0014a uses as its guard.
-- =====================================================================
with
has15 as (select to_regclass('public.document_counters') is not null as yes),
has18 as (select to_regclass('public.invitations') is not null as yes),
has19 as (select to_regclass('public.client_events') is not null as yes),
has20 as (select to_regclass('public.employees') is not null as yes),
has23 as (select to_regclass('public.journal_entries') is not null as yes),
has24 as (select to_regclass('public.bills') is not null as yes),
expected_count as (select 18 + (select yes::int from has15) + 2 * (select yes::int from has18) + (select yes::int from has19)
                          + (select yes::int from has20) + 5 * (select yes::int from has23) + 6 * (select yes::int from has24) as n),
member_lacks(key) as (values ('billing.manage'), ('clients.delete'), ('company.branding.manage'),
                             ('company.settings.manage'), ('documents.delete'), ('documents.void'),
                             ('members.invite'), ('members.manage'), ('clients.archive'), ('workforce.manage'),
                             ('accounting.view'), ('accounting.manage'), ('accounting.post'), ('accounting.close'), ('accounting.reopen'),
                             ('payables.view'), ('payables.pay'), ('payables.manage'), ('payables.settings')),
admin_lacks(key) as (select 'billing.manage' from has15 where yes
                     union all select 'members.manage' from has18 where yes
                     union all select 'accounting.reopen' from has23 where yes
                     union all select 'payables.settings' from has24 where yes),
expected_policies(tbl, name) as (values
  ('public.companies', 'companies_select'), ('public.companies', 'companies_update'),
  ('public.memberships', 'memberships_select'),
  ('public.company_profiles', 'company_profiles_select'), ('public.company_profiles', 'company_profiles_insert'),
  ('public.company_profiles', 'company_profiles_update'),
  ('public.company_subscriptions', 'company_subscriptions_select'),
  ('public.document_deletion_audit', 'audit_select_company'), ('public.document_deletion_audit', 'audit_insert_company'),
  ('public.clients', 'ba_clients_select'), ('public.clients', 'ba_clients_insert'),
  ('public.clients', 'ba_clients_update'), ('public.clients', 'ba_clients_delete'),
  ('public.documents', 'ba_documents_select'), ('public.documents', 'ba_documents_insert'),
  ('public.documents', 'ba_documents_update'), ('public.documents', 'ba_documents_delete'),
  ('public.payments', 'ba_payments_select'), ('public.payments', 'ba_payments_insert'),
  ('storage.objects', 'ba_company_assets_select'), ('storage.objects', 'ba_company_assets_insert'),
  ('storage.objects', 'ba_company_signatures_select'), ('storage.objects', 'ba_company_signatures_insert'),
  ('storage.objects', 'ba_company_signatures_delete')),
fns(sig) as (values ('public.has_permission(uuid,text)'), ('public.is_company_member(uuid)'),
                    ('public.has_company_role(uuid,text[])')),
matrix as (
  select r.role, p.key
  from (values ('owner'), ('admin'), ('member')) r(role)
  cross join public.permissions p
  where (r.role <> 'member' or p.key not in (select key from member_lacks))
    and (r.role <> 'admin' or p.key not in (select key from admin_lacks))),
problems(msg) as (
  select 'expected ' || (select n from expected_count) || ' permissions, found ' || count(*)
  from public.permissions
  having count(*) <> (select n from expected_count)
  union all
  select 'role matrix differs: ' || string_agg(x, ', ' order by x) from (
    (select role || ':' || key || ' missing' as x from matrix
     except select role || ':' || permission_key || ' missing' from public.role_permissions)
    union all
    (select role || ':' || permission_key || ' unexpected' from public.role_permissions
     except select role || ':' || key || ' unexpected' from matrix)) d
  having count(*) > 0
  union all
  select 'function ' || f.sig || ' missing or not SECURITY DEFINER with search_path=""' from fns f
  where not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f.sig)
                      and p.prosecdef and p.proconfig @> array['search_path=""'])
  union all
  select 'function ' || f.sig || ' grants wrong (anon/PUBLIC can execute or authenticated cannot)' from fns f
  where to_regprocedure(f.sig) is not null
    and (has_function_privilege('anon', to_regprocedure(f.sig), 'EXECUTE')
         or not has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE')
         or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid = to_regprocedure(f.sig) and a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  union all
  select 'policy missing: ' || e.tbl || ':' || e.name from expected_policies e
  where not exists (select 1 from pg_policies p where p.schemaname || '.' || p.tablename = e.tbl and p.policyname = e.name)
  union all
  select 'policy not on has_permission or still on the old checks: ' || p.schemaname || '.' || p.tablename || ':' || p.policyname
  from pg_policies p join expected_policies e on e.tbl = p.schemaname || '.' || p.tablename and e.name = p.policyname
  where coalesce(p.qual, '') || coalesce(p.with_check, '') not like '%has_permission(%'
     or coalesce(p.qual, '') || coalesce(p.with_check, '') ~ '(is_company_member|has_company_role|FROM memberships)'
  union all
  select 'memberships.status missing, nullable or without default active'
  where not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'memberships' and column_name = 'status'
                      and is_nullable = 'NO' and column_default like '''active''%')
  union all
  select 'constraint memberships_status_check missing'
  where not exists (select 1 from pg_constraint
                    where conrelid = 'public.memberships'::regclass and conname = 'memberships_status_check')
  union all
  select 'permission tables not locked down (RLS off, anon read or authenticated writes)'
  where (exists (select 1 from pg_class c where c.oid in (to_regclass('public.permissions'), to_regclass('public.role_permissions'))
                   and not c.relrowsecurity)
         or has_table_privilege('anon', 'public.permissions', 'SELECT')
         or has_table_privilege('anon', 'public.role_permissions', 'SELECT')
         or has_table_privilege('authenticated', 'public.permissions', 'INSERT,UPDATE,DELETE,TRUNCATE')
         or has_table_privilege('authenticated', 'public.role_permissions', 'INSERT,UPDATE,DELETE,TRUNCATE'))
  union all
  select 'policy not created by the repository on a tenant table: ' || p.schemaname || '.' || p.tablename || ':' || p.policyname
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in ('companies', 'memberships', 'company_profiles', 'company_subscriptions',
                        'document_deletion_audit', 'clients', 'documents', 'payments')
    and not exists (select 1 from expected_policies e where e.tbl = p.schemaname || '.' || p.tablename and e.name = p.policyname)
  union all
  select 'storage.objects policy ' || c.policyname || ' [' || c.permissive || ' ' || c.cmd || ' to ' || c.roles || '] ' || c.verdict
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
  where c.verdict like 'block:%'
)
select coalesce(string_agg(msg, '; ' order by msg), 'OK') from problems;
