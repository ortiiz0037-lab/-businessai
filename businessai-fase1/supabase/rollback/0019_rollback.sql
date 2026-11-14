-- Rollback of 0019 (CRM). Removes archive guards, the client history (only
-- when empty; kept otherwise) and documents.language. Refuses, changing
-- nothing, while any client is archived (it would silently reappear as
-- active) or any document has a chosen language (it would lose it):
-- decide those first. Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'archived_at')
     and exists (select 1 from public.clients where archived_at is not null) then
    raise exception 'BA0019 rollback: archived clients exist; nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documents' and column_name = 'language')
     and exists (select 1 from public.documents where language is not null) then
    raise exception 'BA0019 rollback: documents with a chosen language exist; nothing was changed.';
  end if;
end $$;
drop trigger if exists ba_guard_client_change on public.clients;
drop trigger if exists ba_log_client_event on public.clients;
drop trigger if exists ba_check_document_client on public.documents;
drop function if exists public.guard_client_change();
drop function if exists public.log_client_event();
drop function if exists public.check_document_client();
drop index if exists public.clients_company_archived_idx;
alter table public.clients drop column if exists archived_by;
alter table public.clients drop column if exists archived_at;
alter table public.documents drop constraint if exists documents_language_check;
alter table public.documents drop column if exists language;
do $$ begin
  if to_regclass('public.client_events') is not null and not exists (select 1 from public.client_events) then
    drop table public.client_events;
  elsif to_regclass('public.client_events') is not null then
    raise notice 'BA0019 rollback: client_events has history and is kept.';
  end if;
end $$;
delete from public.role_permissions where permission_key = 'clients.archive';
delete from public.permissions where key = 'clients.archive';
commit;
