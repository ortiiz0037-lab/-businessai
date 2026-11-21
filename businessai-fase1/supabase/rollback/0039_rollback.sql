-- Rollback of 0039 (catalog of products and services). Refuses, changing
-- nothing, while any catalog item exists: items are business data and are
-- never deleted by a rollback. Document lines that copied an item keep their
-- copy (catalog_item_id / code inside documents.items are plain data).
-- Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.catalog_items') is not null and exists (select 1 from public.catalog_items) then
    raise exception 'BA0039 rollback: the catalog has items; nothing was changed.';
  end if;
end $$;
drop function if exists public.catalog_save(uuid, uuid, text, text, text, text, text, bigint, numeric, boolean, integer);
drop function if exists public.catalog_set_status(uuid, text, integer);
drop table if exists public.catalog_events;
drop table if exists public.catalog_items;
drop function if exists public.catalog_guard();
delete from public.role_permissions where permission_key in ('catalog.view', 'catalog.manage');
delete from public.permissions where key in ('catalog.view', 'catalog.manage');
commit;
