-- Rollback of 0028 (Document Studio). Emergency use only.
-- Refuses, changing nothing, while any studio document, company template,
-- brand setting, uploaded image (row or file in Studio-assets) or studio
-- history exists. Business documents, clients, payments and company
-- profiles are not touched (0028 only reads them).
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.studio_documents') is not null then
    if exists (select 1 from public.studio_documents) or exists (select 1 from public.studio_templates) or exists (select 1 from public.studio_brand)
       or exists (select 1 from public.studio_assets) or exists (select 1 from public.studio_events) then
      raise exception 'BA0028 rollback: studio documents, templates, brand settings, images or history exist; nothing was changed.';
    end if;
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'Studio-assets') then
    raise exception 'BA0028 rollback: files exist in Studio-assets; nothing was changed.';
  end if;
end $$;
drop policy if exists ba_studio_assets_select on storage.objects;
drop policy if exists ba_studio_assets_insert on storage.objects;
delete from storage.buckets where id = 'Studio-assets';
drop function if exists public.studio_register_asset(uuid, text, text, text, integer, integer, integer, text);
drop function if exists public.studio_save_brand(uuid, jsonb);
drop function if exists public.studio_archive_template(uuid);
drop function if exists public.studio_save_template(uuid, uuid, text, text, text, text, jsonb, jsonb);
drop function if exists public.studio_record(uuid, text, jsonb);
drop function if exists public.studio_archive(uuid, text);
drop function if exists public.studio_finalize(uuid, integer, jsonb);
drop function if exists public.studio_data(uuid);
drop function if exists public.studio_restore_version(uuid, integer, integer);
drop function if exists public.studio_duplicate(uuid, text);
drop function if exists public.studio_save_document(uuid, uuid, text, text, text, jsonb, jsonb, uuid, uuid, uuid, uuid, uuid, text, integer, text);
drop function if exists public.studio_check_ref_access(uuid, uuid, uuid, uuid, uuid);
drop function if exists public.studio_doc_for(uuid, text);
drop function if exists public.studio_log(uuid, uuid, text, text, text, jsonb);
drop table if exists public.studio_versions;
drop table if exists public.studio_documents;
drop table if exists public.studio_templates;
alter table if exists public.studio_brand drop constraint if exists studio_brand_stamp_fk;
drop table if exists public.studio_brand;
drop table if exists public.studio_assets;
drop table if exists public.studio_counters;
drop table if exists public.studio_events;
drop function if exists public.studio_check_refs();
drop function if exists public.studio_guard();
drop function if exists public.studio_valid_page(jsonb);
drop function if exists public.studio_valid_content(jsonb);
delete from public.role_permissions where permission_key like 'studio.%';
delete from public.permissions where key like 'studio.%';
commit;
