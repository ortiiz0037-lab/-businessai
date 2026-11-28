-- =====================================================================
-- BusinessAI · Migration 0007 · Storage policies for Company-assets
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Separate approval.
-- Split out of 0005: storage.objects is a Supabase-managed table. If the
-- platform refuses a policy change here, only this migration rolls back.
--
-- Inspected state: 11 policies on storage.objects, all for this bucket:
--   * 9 use bucket_id = 'company-assets' or 'COMPANY-ASSETS'. Bucket ids
--     are case-sensitive and the real bucket is 'Company-assets', so they
--     never match anything (dead policies, some with duplicate-looking
--     names that must contain invisible characters).
--   * 2 work: company_assets_read (select) and company_assets_upload
--     (insert), both for owner/admin of the <company_id>/ folder.
--
-- Change: drop all 11 (matched by CONTENT, so odd names do not matter) and
-- recreate the 2 live ones as ba_company_assets_select/_insert with the
-- SAME rule. No update/delete policy is added. The bucket stays public.
--
-- NOTE: this does not make files private. Public-bucket files are served
-- to anyone who has the URL; policies only govern listing/upload through
-- the API. See supabase/inspect/SCHEMA_REVIEW.md §5.
--
-- Rollback: supabase/rollback/0007_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'Company-assets') then
    raise exception 'BA0007: bucket Company-assets not found';
  end if;
  if to_regprocedure('public.has_company_role(uuid, text[])') is null then
    raise exception 'BA0007: public.has_company_role(uuid, text[]) not found';
  end if;
end $$;

-- Guard: a policy on storage.objects that does not restrict bucket_id
-- applies to every bucket and was not in the inspection → abort.
do $$
declare
  unknown text;
begin
  select string_agg(format('storage.objects:%s [%s] using(%s) check(%s)',
                           p.policyname, p.cmd, coalesce(p.qual, '-'), coalesce(p.with_check, '-')), E'\n')
    into unknown
  from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects'
    and p.policyname not like 'ba\_%'
    and coalesce(p.qual, '') || coalesce(p.with_check, '') not ilike '%bucket_id%';

  if unknown is not null then
    raise exception E'BA0007: storage policies not covered by the inspection; nothing was changed:\n%', unknown;
  end if;
end $$;

-- Helper: company id from '<company_id>/<file>', or NULL for any other path.
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

do $$
declare
  r record;
  dropped int := 0;
begin
  for r in
    select p.policyname
    from pg_policies p
    where p.schemaname = 'storage' and p.tablename = 'objects'
      and p.policyname not like 'ba\_%'
      and coalesce(p.qual, '') || coalesce(p.with_check, '') ilike '%company-assets%'
  loop
    execute format('drop policy %I on storage.objects', r.policyname);
    dropped := dropped + 1;
    raise notice 'BA0007: dropped storage policy %', r.policyname;
  end loop;
  raise notice 'BA0007: % storage policies dropped (inspection: 11)', dropped;

  execute 'drop policy if exists ba_company_assets_select on storage.objects';
  execute 'drop policy if exists ba_company_assets_insert on storage.objects';

  -- Same rule as today's company_assets_read / company_assets_upload.
  execute $p$
    create policy ba_company_assets_select on storage.objects for select to authenticated
      using (bucket_id = 'Company-assets'
             and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']))
  $p$;
  execute $p$
    create policy ba_company_assets_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'Company-assets'
                  and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']))
  $p$;
end $$;

-- Self-check.
do $$
begin
  if exists (select 1 from pg_policies p
             where p.schemaname = 'storage' and p.tablename = 'objects'
               and p.policyname not like 'ba\_%'
               and coalesce(p.qual, '') || coalesce(p.with_check, '') ilike '%company-assets%') then
    raise exception 'BA0007 self-check failed: a non-canonical Company-assets policy remains';
  end if;
  if (select count(*) from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname in ('ba_company_assets_select', 'ba_company_assets_insert')) <> 2 then
    raise exception 'BA0007 self-check failed: canonical policies missing';
  end if;
end $$;

commit;
