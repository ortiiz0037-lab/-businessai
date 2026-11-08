-- =====================================================================
-- BusinessAI · Read-only schema inspection (project: businessai-dev)
-- =====================================================================
-- What it is: ONE single SELECT statement. Nothing else.
--   * It only reads PostgreSQL system catalogs (pg_namespace, pg_class,
--     pg_attribute, pg_constraint, pg_index, pg_policy, pg_proc, ...)
--     and storage.buckets (bucket settings only).
--   * It reads NO rows from clients, documents, payments, companies,
--     memberships, company_profiles, subscriptions or any other business
--     table, and NO file names or file contents from storage.objects.
--   * It reads no secrets: no keys, passwords or auth.users data.
--   * Every function it calls is a catalog/formatting function
--     (format_type, pg_get_expr, pg_get_constraintdef, pg_get_indexdef,
--     pg_get_triggerdef, pg_get_function_identity_arguments,
--     has_table_privilege, has_function_privilege, jsonb_*).
--
-- How to run: Supabase Dashboard → SQL Editor → paste → Run.
-- Result: one row, one column `inspection` (JSON). Copy that value.
--
-- Sections returned:
--   schemas, tables (RLS flags, columns, constraints, foreign keys,
--   indexes, triggers, role privileges), rls_policies (public + storage),
--   functions (public), storage_buckets (settings only).
-- =====================================================================

with
-- Tables in scope: every table in `public`, plus Storage's own tables.
tbl as (
  select c.oid,
         n.nspname as schema_name,
         c.relname as table_name,
         c.relrowsecurity      as rls_enabled,
         c.relforcerowsecurity as rls_forced
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (n.nspname = 'public'
         or (n.nspname = 'storage' and c.relname in ('objects', 'buckets')))
)
select pg_catalog.jsonb_pretty(pg_catalog.jsonb_build_object(

  'inspected_at', now(),
  'postgres_version', current_setting('server_version'),

  -- 1. Schemas (non-system) and how many tables each one has.
  'schemas', (
    select jsonb_agg(jsonb_build_object(
             'schema', n.nspname,
             'tables', (select count(*) from pg_catalog.pg_class c
                        where c.relnamespace = n.oid and c.relkind in ('r', 'p'))
           ) order by n.nspname)
    from pg_catalog.pg_namespace n
    where n.nspname not like 'pg\_%'
      and n.nspname <> 'information_schema'
  ),

  -- 2. Tables: RLS flags, columns, constraints, FKs, indexes, triggers, privileges.
  'tables', (
    select jsonb_agg(jsonb_build_object(
      'table', t.schema_name || '.' || t.table_name,
      'rls_enabled', t.rls_enabled,
      'rls_forced', t.rls_forced,

      'columns', (
        select jsonb_agg(jsonb_build_object(
                 'name', a.attname,
                 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                 'not_null', a.attnotnull,
                 'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid)
               ) order by a.attnum)
        from pg_catalog.pg_attribute a
        left join pg_catalog.pg_attrdef d
               on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
      ),

      -- Primary keys, unique and check constraints (p / u / c / x).
      'constraints', (
        select jsonb_agg(jsonb_build_object(
                 'name', con.conname,
                 'kind', case con.contype
                           when 'p' then 'primary_key'
                           when 'u' then 'unique'
                           when 'c' then 'check'
                           when 'x' then 'exclusion'
                           else con.contype::text end,
                 'definition', pg_catalog.pg_get_constraintdef(con.oid)
               ) order by con.conname)
        from pg_catalog.pg_constraint con
        where con.conrelid = t.oid and con.contype <> 'f'
      ),

      'foreign_keys', (
        select jsonb_agg(jsonb_build_object(
                 'name', con.conname,
                 'references', con.confrelid::regclass::text,
                 'on_delete', case con.confdeltype
                                when 'a' then 'no action' when 'r' then 'restrict'
                                when 'c' then 'cascade'   when 'n' then 'set null'
                                when 'd' then 'set default' end,
                 'on_update', case con.confupdtype
                                when 'a' then 'no action' when 'r' then 'restrict'
                                when 'c' then 'cascade'   when 'n' then 'set null'
                                when 'd' then 'set default' end,
                 'definition', pg_catalog.pg_get_constraintdef(con.oid)
               ) order by con.conname)
        from pg_catalog.pg_constraint con
        where con.conrelid = t.oid and con.contype = 'f'
      ),

      'indexes', (
        select jsonb_agg(jsonb_build_object(
                 'name', ic.relname,
                 'unique', i.indisunique,
                 'primary', i.indisprimary,
                 'definition', pg_catalog.pg_get_indexdef(i.indexrelid)
               ) order by ic.relname)
        from pg_catalog.pg_index i
        join pg_catalog.pg_class ic on ic.oid = i.indexrelid
        where i.indrelid = t.oid
      ),

      'triggers', (
        select jsonb_agg(jsonb_build_object(
                 'name', tg.tgname,
                 'enabled', tg.tgenabled <> 'D',
                 'definition', pg_catalog.pg_get_triggerdef(tg.oid)
               ) order by tg.tgname)
        from pg_catalog.pg_trigger tg
        where tg.tgrelid = t.oid and not tg.tgisinternal
      ),

      -- Which privileges the API roles hold on this table (true/false).
      'role_privileges', (
        select jsonb_object_agg(r.role_name, jsonb_build_object(
                 'select',   has_table_privilege(r.role_name, t.oid, 'SELECT'),
                 'insert',   has_table_privilege(r.role_name, t.oid, 'INSERT'),
                 'update',   has_table_privilege(r.role_name, t.oid, 'UPDATE'),
                 'delete',   has_table_privilege(r.role_name, t.oid, 'DELETE'),
                 'truncate', has_table_privilege(r.role_name, t.oid, 'TRUNCATE')
               ))
        from (values ('anon'), ('authenticated'), ('service_role')) as r(role_name)
        where exists (select 1 from pg_catalog.pg_roles pr where pr.rolname = r.role_name)
      )
    ) order by t.schema_name, t.table_name)
    from tbl t
  ),

  -- 3. Row level security policies (public tables + Storage tables).
  'rls_policies', (
    select jsonb_agg(jsonb_build_object(
             'table', n.nspname || '.' || c.relname,
             'name', p.polname,
             'permissive', p.polpermissive,
             'command', case p.polcmd
                          when 'r' then 'select' when 'a' then 'insert'
                          when 'w' then 'update' when 'd' then 'delete'
                          when '*' then 'all' end,
             'roles', (select coalesce(jsonb_agg(case when rid = 0 then 'public'
                                                      else pg_catalog.pg_get_userbyid(rid)::text end), '[]'::jsonb)
                       from unnest(p.polroles) as rid),
             'using', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
             'with_check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
           ) order by n.nspname, c.relname, p.polname)
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
       or (n.nspname = 'storage' and c.relname in ('objects', 'buckets'))
  ),

  -- 4. Functions in `public` (policies call these; source not included).
  'functions', (
    select jsonb_agg(jsonb_build_object(
             'name', p.proname,
             'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
             'returns', pg_catalog.format_type(p.prorettype, null),
             'security_definer', p.prosecdef,
             'search_path_config', p.proconfig,
             'execute_anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
             'execute_authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')
           ) order by p.proname)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ),

  -- 5. Storage buckets: configuration only (no objects, no file names).
  'storage_buckets', (
    select jsonb_agg(jsonb_build_object(
             'id', b.id,
             'name', b.name,
             'public', b.public,
             'file_size_limit', b.file_size_limit,
             'allowed_mime_types', b.allowed_mime_types
           ) order by b.id)
    from storage.buckets b
  )

)) as inspection;
