-- Rollback of 0007: restores the two inspected policies that actually
-- governed the Company-assets bucket (company_assets_read/upload, copied
-- from the inspection). The 9 policies that targeted 'company-assets' /
-- 'COMPANY-ASSETS' are intentionally NOT recreated: they never matched the
-- real bucket, so they had no effect (and two of their real names could
-- not be reproduced exactly). Emergency use only.
begin;
set local lock_timeout = '5s';

drop policy if exists ba_company_assets_select on storage.objects;
drop policy if exists ba_company_assets_insert on storage.objects;

create policy company_assets_read on storage.objects for select to authenticated
  using ((bucket_id = 'Company-assets'::text) and ((storage.foldername(name))[1] in (
    select (m.company_id)::text as company_id
    from public.memberships m
    where ((m.user_id = (select auth.uid() as uid)) and (m.role = any (array['owner'::text, 'admin'::text]))))));

create policy company_assets_upload on storage.objects for insert to authenticated
  with check ((bucket_id = 'Company-assets'::text) and ((storage.foldername(name))[1] in (
    select (m.company_id)::text as company_id
    from public.memberships m
    where ((m.user_id = (select auth.uid() as uid)) and (m.role = any (array['owner'::text, 'admin'::text]))))));

-- 0009 (private signatures) uses the same helper: drop it only when no
-- policy depends on it any more, so this rollback also works while 0009
-- is still applied.
do $$
begin
  if to_regprocedure('public.storage_company_id(text)') is not null
     and not exists (select 1 from pg_depend
                     where refobjid = 'public.storage_company_id(text)'::regprocedure
                       and deptype = 'n') then
    drop function public.storage_company_id(text);
  else
    raise notice 'BA0007 rollback: storage_company_id kept (still used, e.g. by 0009)';
  end if;
end $$;
commit;
