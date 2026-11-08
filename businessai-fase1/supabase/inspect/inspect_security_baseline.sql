-- =====================================================================
-- BusinessAI · Read-only inspection of the security baseline
-- =====================================================================
-- Run in: Supabase Dashboard → SQL Editor (DEVELOPMENT project).
-- It only reads the system catalogs: it changes nothing. The read-only
-- transaction makes Postgres itself reject any write.
-- It does NOT read business data (no rows from clients/documents/payments),
-- only structure: columns, constraints, indexes, triggers, RLS policies,
-- grants, functions and Storage buckets/policies.
--
-- Output: a single row/column `inspection` (JSON). Copy it into
-- supabase/inspect/dev-schema.json, or paste it into the conversation.
-- =====================================================================

begin transaction read only;

with
tables as (
  select c.oid, n.nspname as schema, c.relname as name,
         c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (n.nspname = 'public' or (n.nspname = 'storage' and c.relname in ('objects', 'buckets')))
)
select jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'postgres_version', current_setting('server_version'),

  'tables', (
    select jsonb_agg(jsonb_build_object(
      'table', t.schema || '.' || t.name,
      'rls_enabled', t.rls_enabled,
      'rls_forced', t.rls_forced,
      'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'not_null', a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid)
        ) order by a.attnum)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
      ),
      'constraints', (
        select jsonb_agg(jsonb_build_object(
          'name', con.conname,
          'type', con.contype,
          'definition', pg_get_constraintdef(con.oid)
        ) order by con.conname)
        from pg_constraint con where con.conrelid = t.oid
      ),
      'indexes', (
        select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid)
        from pg_index i where i.indrelid = t.oid
      ),
      'triggers', (
        select jsonb_agg(jsonb_build_object('name', tg.tgname, 'definition', pg_get_triggerdef(tg.oid)))
        from pg_trigger tg where tg.tgrelid = t.oid and not tg.tgisinternal
      ),
      'grants', (
        select jsonb_agg(jsonb_build_object('grantee', g.grantee, 'privilege', g.privilege_type)
                         order by g.grantee, g.privilege_type)
        from information_schema.role_table_grants g
        where g.table_schema = t.schema and g.table_name = t.name
          and g.grantee in ('anon', 'authenticated', 'public', 'service_role')
      )
    ) order by t.schema, t.name)
    from tables t
  ),

  'policies', (
    select jsonb_agg(jsonb_build_object(
      'table', p.schemaname || '.' || p.tablename,
      'name', p.policyname,
      'permissive', p.permissive,
      'roles', p.roles,
      'command', p.cmd,
      'using', p.qual,
      'with_check', p.with_check
    ) order by p.schemaname, p.tablename, p.policyname)
    from pg_policies p
    where p.schemaname = 'public' or (p.schemaname = 'storage' and p.tablename in ('objects', 'buckets'))
  ),

  'functions', (
    select jsonb_agg(jsonb_build_object(
      'name', p.proname,
      'args', pg_get_function_identity_arguments(p.oid),
      'security_definer', p.prosecdef,
      'config', p.proconfig,
      'execute_anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'execute_authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ),

  'storage_buckets', (
    select jsonb_agg(to_jsonb(b) - 'owner' - 'owner_id' order by b.id)
    from storage.buckets b
  ),

  -- Structure only: how many objects per bucket and per top-level folder
  -- shape (uuid folder or not). No file names are returned.
  'storage_object_layout', (
    select jsonb_agg(x)
    from (
      select o.bucket_id,
             ((storage.foldername(o.name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as first_folder_is_uuid,
             count(*) as objects
      from storage.objects o
      group by 1, 2
    ) x
  )
)) as inspection;

rollback;
