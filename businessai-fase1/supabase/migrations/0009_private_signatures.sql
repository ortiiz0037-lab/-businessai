-- =====================================================================
-- BusinessAI · Migration 0009 · Private signatures + image-only buckets
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Separate approval.
-- Needed by the app change "firmas privadas" (PR #1). Until it is applied,
-- logos keep working and existing signatures keep displaying, but NEW
-- signature uploads fail with "almacenamiento privado ... no configurado".
--
-- 1. Bucket `Company-signatures`: PRIVATE, 2 MB, PNG/JPEG/WEBP only.
--    Files are reachable only through signed URLs, which Storage issues
--    only to users allowed by the SELECT policy below.
--    If the SQL Editor refuses to insert into storage.buckets, create the
--    bucket in Dashboard → Storage → New bucket with exactly those values
--    (Public: OFF) and run this script again: it detects the bucket.
-- 2. Policies on storage.objects for that bucket, folder = company id:
--      select → any member of the company (needed to render documents)
--      insert → owner/admin
--      delete → owner/admin (to remove replaced signatures)
--      no update policy: every upload uses a new random name.
-- 3. Bucket `Company-assets` (logos, stays PUBLIC): allowed types limited to
--    PNG/JPEG/WEBP (was: any type, incl. HTML/SVG); size limit unchanged.
--
-- Does not move or delete any file. Old signatures uploaded to the public
-- bucket stay there (and stay public) until re-uploaded and then removed;
-- see supabase/RUNBOOK.md §6.
-- Rollback: supabase/rollback/0009_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  b record;
begin
  if to_regprocedure('public.has_company_role(uuid, text[])') is null
     or to_regprocedure('public.is_company_member(uuid)') is null then
    raise exception 'BA0009: membership helper functions not found';
  end if;

  select * into b from storage.buckets where id = 'Company-signatures';
  if not found then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('Company-signatures', 'Company-signatures', false, 2097152,
            array['image/png', 'image/jpeg', 'image/webp']);
    raise notice 'BA0009: bucket Company-signatures created (private)';
  elsif b.public then
    raise exception 'BA0009: bucket Company-signatures exists but is PUBLIC; make it private in the Dashboard first';
  else
    update storage.buckets
       set file_size_limit = 2097152,
           allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
     where id = 'Company-signatures';
    raise notice 'BA0009: bucket Company-signatures already existed (private); limits set';
  end if;

  if not exists (select 1 from storage.buckets where id = 'Company-assets') then
    raise exception 'BA0009: bucket Company-assets not found';
  end if;
  update storage.buckets
     set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
   where id = 'Company-assets';
end $$;

-- Same helper as 0007 (kept here so 0009 does not depend on 0007).
create or replace function public.storage_company_id(object_name text)
returns uuid
language sql immutable set search_path = '' as $$
  select case
    when (string_to_array(object_name, '/'))[1]
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and array_length(string_to_array(object_name, '/'), 1) > 1
    then ((string_to_array(object_name, '/'))[1])::uuid
  end
$$;
revoke all on function public.storage_company_id(text) from public, anon;
grant execute on function public.storage_company_id(text) to authenticated, service_role;

drop policy if exists ba_company_signatures_select on storage.objects;
drop policy if exists ba_company_signatures_insert on storage.objects;
drop policy if exists ba_company_signatures_delete on storage.objects;

create policy ba_company_signatures_select on storage.objects for select to authenticated
  using (bucket_id = 'Company-signatures'
         and public.is_company_member(public.storage_company_id(name)));
create policy ba_company_signatures_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'Company-signatures'
              and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']));
create policy ba_company_signatures_delete on storage.objects for delete to authenticated
  using (bucket_id = 'Company-signatures'
         and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']));

-- Self-check.
do $$
begin
  if (select public from storage.buckets where id = 'Company-signatures') is distinct from false then
    raise exception 'BA0009 self-check failed: Company-signatures is not private';
  end if;
  if exists (select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%company-signatures%'
               and (roles @> array['anon']::name[] or roles @> array['public']::name[])) then
    raise exception 'BA0009 self-check failed: a signatures policy applies to anon/public';
  end if;
  if (select count(*) from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname like 'ba\_company\_signatures\_%') <> 3 then
    raise exception 'BA0009 self-check failed: expected 3 signature policies';
  end if;
end $$;

commit;
