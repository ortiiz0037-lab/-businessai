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
--   1. 18 permissions and exactly the 0014a role matrix (owner 18, admin 18,
--      member 13 = all but the 5 management/delete permissions).
--   2. has_permission, is_company_member, has_company_role: SECURITY DEFINER,
--      search_path="", executable by authenticated, not by anon or PUBLIC.
--   3. The 24 tenant policies exist and all use has_permission, none the old
--      helpers or a direct memberships lookup.
--   4. memberships.status: not null, default 'active', constraint present.
--   5. permissions / role_permissions: RLS on, no anon read, no writes for
--      authenticated.
-- =====================================================================
with
member_lacks(key) as (values ('billing.manage'), ('clients.delete'), ('company.branding.manage'),
                             ('company.settings.manage'), ('documents.delete')),
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
  where (r.role <> 'member' or p.key not in (select key from member_lacks))),
problems(msg) as (
  select 'expected 18 permissions, found ' || count(*) from public.permissions
  having count(*) <> 18
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
)
select coalesce(string_agg(msg, '; ' order by msg), 'OK') from problems;
