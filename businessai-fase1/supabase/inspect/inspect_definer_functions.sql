-- =====================================================================
-- BusinessAI · Read-only: source of SECURITY DEFINER functions in public
-- =====================================================================
-- ONE single SELECT statement. It only reads the system catalog
-- (pg_proc) and prints each function's definition text with
-- pg_get_functiondef. It does not call or execute the functions, and it
-- reads no table rows.
--
-- Run in: Supabase Dashboard → SQL Editor → paste → Run.
-- Result: one row per function (name, signature, owner, who may execute
-- it, and its full source). Includes can_edit_company_profile.
-- =====================================================================

select p.proname                                   as function_name,
       p.oid::regprocedure::text                   as signature,
       pg_catalog.pg_get_userbyid(p.proowner)      as owner,
       p.proconfig                                 as config,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as execute_anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as execute_authenticated,
       pg_catalog.pg_get_functiondef(p.oid)        as source
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and p.prokind = 'f'
order by p.proname;
