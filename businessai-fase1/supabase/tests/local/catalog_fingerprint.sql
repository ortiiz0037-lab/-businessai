-- Read-only catalog fingerprint (TEST-ONLY): every RLS policy, public
-- function (attributes, grants, body hash), public table/column and
-- memberships constraint, one line each, sorted. Two databases with the same
-- output have the same security-relevant schema. No table rows are read.
\pset format unaligned
\pset tuples_only on
select line from (
  select 'policy|' || schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|'
         || array_to_string(roles, ',') || '|' || coalesce(qual, '-') || '|' || coalesce(with_check, '-') as line
  from pg_policies
  union all
  select 'function|' || p.oid::regprocedure::text || '|secdef=' || p.prosecdef || '|cfg='
         || coalesce(array_to_string(p.proconfig, ','), '') || '|acl=' || coalesce(p.proacl::text, '')
         || '|body=' || md5(p.prosrc)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
  union all
  select 'table|' || c.relname || '|rls=' || c.relrowsecurity || '|acl=' || coalesce(c.relacl::text, '')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
  union all
  select 'column|' || table_name || '.' || column_name || '|' || data_type || '|' || is_nullable || '|'
         || coalesce(column_default, '')
  from information_schema.columns where table_schema = 'public'
  union all
  select 'constraint|memberships|' || conname || '|' || pg_get_constraintdef(oid)
  from pg_constraint where conrelid = 'public.memberships'::regclass
) f
order by line;
