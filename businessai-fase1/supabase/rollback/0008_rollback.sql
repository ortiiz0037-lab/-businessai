-- Rollback of 0008: restores the inspected grant (anon may execute
-- can_edit_company_profile). Emergency use only.
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.can_edit_company_profile(uuid)') is not null then
    grant execute on function public.can_edit_company_profile(uuid) to anon;
  end if;
end $$;
commit;
