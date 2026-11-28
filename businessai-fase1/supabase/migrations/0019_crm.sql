-- =====================================================================
-- BusinessAI · Migration 0019 · CRM: archived clients, client history,
-- document language
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a.
--
-- 1. Archive instead of delete: clients.archived_at / archived_by. Only
--    users with clients.archive (owner, admin) archive or restore; the
--    database writes who and when. Archived clients keep their documents
--    and payments, and cannot receive NEW documents (CLIENT_ARCHIVED).
-- 2. History protection: a client that has any document cannot be deleted
--    by a signed-in user (CLIENT_HAS_HISTORY) — archive it instead.
-- 3. public.client_events: creation, changes (which fields), archive,
--    restore and deletion of clients, written by a trigger; readable with
--    clients.view; nobody writes or deletes it through the API.
-- 4. documents.language ('es' | 'en'): each document is written and printed
--    in its own language, chosen when it is created. NULL (documents
--    created before) = shown in the reader's language, as before.
-- Rollback: supabase/rollback/0019_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.has_permission(uuid, text)') is null then
    raise exception 'BA0019: migration 0014a must be applied first';
  end if;
end $$;

insert into public.permissions (key, module, description_es, description_en) values
  ('clients.archive', 'clients', 'Archivar y restaurar clientes', 'Archive and restore clients')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values ('owner', 'clients.archive'), ('admin', 'clients.archive')
on conflict do nothing;

-- ------------------------------------------------------------ 1. archive
alter table public.clients add column if not exists archived_at timestamptz;
alter table public.clients add column if not exists archived_by uuid references auth.users(id) on delete set null;
create index if not exists clients_company_archived_idx on public.clients (company_id, archived_at);

create or replace function public.guard_client_change()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    return coalesce(new, old);                    -- server-side maintenance
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from public.documents d where d.client_id = old.id) then
      raise exception 'CLIENT_HAS_HISTORY' using errcode = 'P0001', detail = 'Archive the client instead.';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.archived_at := null;
    new.archived_by := null;
    return new;
  end if;
  if new.archived_at is distinct from old.archived_at then
    if not public.has_permission(new.company_id, 'clients.archive') then
      raise exception 'CLIENT_ARCHIVE_FORBIDDEN' using errcode = 'P0001';
    end if;
    -- The database decides who and when.
    if new.archived_at is not null then
      new.archived_at := now();
      new.archived_by := uid;
    else
      new.archived_by := null;
    end if;
  elsif new.archived_by is distinct from old.archived_by then
    new.archived_by := old.archived_by;
  end if;
  return new;
end $$;
revoke all on function public.guard_client_change() from public, anon, authenticated;
drop trigger if exists ba_guard_client_change on public.clients;
create trigger ba_guard_client_change before insert or update or delete on public.clients
  for each row execute function public.guard_client_change();

-- No new documents for an archived client (signed-in users).
create or replace function public.check_document_client()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or new.client_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.client_id is not distinct from old.client_id then
    return new;
  end if;
  if exists (select 1 from public.clients c where c.id = new.client_id and c.company_id = new.company_id
               and c.archived_at is not null) then
    raise exception 'CLIENT_ARCHIVED' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.check_document_client() from public, anon, authenticated;
drop trigger if exists ba_check_document_client on public.documents;
create trigger ba_check_document_client before insert or update of client_id on public.documents
  for each row execute function public.check_document_client();

-- ------------------------------------------------------------ 2. history
create table if not exists public.client_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null,
  event text not null check (event in ('created', 'updated', 'archived', 'restored', 'deleted')),
  fields text[] not null default '{}',
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists client_events_client_idx on public.client_events (client_id, created_at desc);
alter table public.client_events enable row level security;
revoke all on public.client_events from public, anon, authenticated;
grant select on public.client_events to authenticated;
grant all on public.client_events to service_role;
drop policy if exists ba_client_events_select on public.client_events;
create policy ba_client_events_select on public.client_events for select to authenticated
  using (public.has_permission(company_id, 'clients.view'));

create or replace function public.log_client_event()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  changed text[];
begin
  if tg_op = 'INSERT' then
    insert into public.client_events (company_id, client_id, event, actor) values (new.company_id, new.id, 'created', (select auth.uid()));
  elsif tg_op = 'UPDATE' then
    if new.archived_at is distinct from old.archived_at then
      insert into public.client_events (company_id, client_id, event, actor)
      values (new.company_id, new.id, case when new.archived_at is null then 'restored' else 'archived' end, (select auth.uid()));
    end if;
    select coalesce(array_agg(n.key order by n.key), '{}') into changed
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value and n.key not in ('updated_at', 'archived_at', 'archived_by');
    if cardinality(changed) > 0 then
      insert into public.client_events (company_id, client_id, event, fields, actor)
      values (new.company_id, new.id, 'updated', changed, (select auth.uid()));
    end if;
  elsif exists (select 1 from public.companies c where c.id = old.company_id) then
    insert into public.client_events (company_id, client_id, event, actor) values (old.company_id, old.id, 'deleted', (select auth.uid()));
  end if;
  return null;
end $$;
revoke all on function public.log_client_event() from public, anon, authenticated;
drop trigger if exists ba_log_client_event on public.clients;
create trigger ba_log_client_event after insert or update or delete on public.clients
  for each row execute function public.log_client_event();

-- ------------------------------------------------------------ 3. language
alter table public.documents add column if not exists language text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'documents_language_check' and conrelid = 'public.documents'::regclass) then
    alter table public.documents add constraint documents_language_check check (language is null or language in ('es', 'en'));
  end if;
end $$;

do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in
        ('ba_guard_client_change', 'ba_check_document_client', 'ba_log_client_event')) <> 3 then
    raise exception 'BA0019 self-check failed: triggers';
  end if;
  if has_table_privilege('authenticated', 'public.client_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.client_events', 'DELETE') then
    raise exception 'BA0019 self-check failed: client_events writable';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'clients.archive') then
    raise exception 'BA0019 self-check failed: members cannot archive';
  end if;
end $$;

commit;
