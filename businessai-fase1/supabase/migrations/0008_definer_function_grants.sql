-- =====================================================================
-- BusinessAI · Migration 0008 · anon may not execute definer functions
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Separate approval.
--
-- Inspected: public.can_edit_company_profile(target_company_id uuid) is
-- SECURITY DEFINER (runs with its owner's rights) and EXECUTE is granted
-- to anon. Nothing needs that grant:
--   * no RLS policy references the function (inspection);
--   * the application never calls it (code search: no .rpc() other than
--     create_company);
--   * authenticated keeps EXECUTE, so anything signed-in keeps working.
-- Revoking is therefore safe whatever the function body does. Reading the
-- body (inspect/inspect_definer_functions.sql) is still needed to know
-- whether the grant exposed anything in the past.
--
-- Rollback: supabase/rollback/0008_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';

-- The function only exists where it was created outside the repository
-- (production). Elsewhere (staging, local) there is nothing to do.
do $$
begin
  if to_regprocedure('public.can_edit_company_profile(uuid)') is null then
    raise notice 'BA0008: public.can_edit_company_profile(uuid) not present; nothing to do';
    return;
  end if;
  revoke execute on function public.can_edit_company_profile(uuid) from public, anon;
  grant execute on function public.can_edit_company_profile(uuid) to authenticated, service_role;
end $$;

do $$
begin
  if to_regprocedure('public.can_edit_company_profile(uuid)') is null then
    return;
  end if;
  if has_function_privilege('anon', 'public.can_edit_company_profile(uuid)', 'EXECUTE') then
    raise exception 'BA0008 self-check failed: anon can still execute can_edit_company_profile';
  end if;
  if not has_function_privilege('authenticated', 'public.can_edit_company_profile(uuid)', 'EXECUTE') then
    raise exception 'BA0008 self-check failed: authenticated lost EXECUTE';
  end if;
end $$;

commit;
