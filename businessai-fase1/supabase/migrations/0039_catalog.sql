-- =====================================================================
-- BusinessAI · Migration 0039 · Catalog of products and services
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0035 (and the Studio drafts before it in ORDER).
--
-- One catalog per company: code, name, description, kind (product /
-- service), unit, price in integer cents, an optional tax rate of its own
-- and whether stock will be tracked (the base for inventory: NO stock,
-- movements or costs here).
--
-- Without parallel data:
--   * documents keep their lines as they are (documents.items, a snapshot).
--     A line chosen from the catalog COPIES its values and records
--     catalog_item_id / code inside the line: changing or archiving an item
--     never changes a document already written. Where an item was used is
--     read from documents.items through the documents' own RLS.
--   * Document Studio tables take rows from the catalog the same way (copies).
-- Security: RLS (catalog.view); no direct writes — catalog_save /
-- catalog_set_status (SECURITY DEFINER, catalog.manage, same company,
-- optimistic version); items are archived, never deleted (while the company
-- exists); history in catalog_events (append-only).
-- Rollback: supabase/rollback/0039_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$ begin
  if to_regclass('public.crm_events') is null or to_regprocedure('public.payables_company_gone(uuid)') is null then
    raise exception 'BA0039: migrations 0024 and 0035 must be applied first';
  end if;
end $$;

-- ===================================================================== permissions
insert into public.permissions (key, module, description_es, description_en) values
  ('catalog.view', 'catalog', 'Ver el catálogo de productos y servicios', 'View the catalog of products and services'),
  ('catalog.manage', 'catalog', 'Crear, editar y archivar productos y servicios del catálogo', 'Create, edit and archive catalog products and services')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'catalog.view'), ('admin', 'catalog.view'), ('member', 'catalog.view'),
  ('owner', 'catalog.manage'), ('admin', 'catalog.manage')
on conflict do nothing;

-- ===================================================================== tables
create table if not exists public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text check (description is null or char_length(description) <= 1000),
  kind text not null default 'product' check (kind in ('product', 'service')),
  unit text not null default 'unidad' check (char_length(btrim(unit)) between 1 and 20),
  price_cents bigint not null default 0 check (price_cents between 0 and 100000000000),
  tax_rate numeric(5, 2) check (tax_rate is null or tax_rate between 0 and 100),   -- null: the document's rate
  track_inventory boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  created_by uuid, created_at timestamptz not null default now(),
  updated_by uuid, updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (kind = 'product' or not track_inventory)   -- a service holds no stock
);
-- one code per company (case-insensitive), archived items included: a code is never reused for something else
create unique index if not exists catalog_items_code_uidx on public.catalog_items (company_id, lower(code));
create index if not exists catalog_items_list_idx on public.catalog_items (company_id, status, lower(name));

create table if not exists public.catalog_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid not null,
  action text not null check (action in ('created', 'updated', 'archived', 'restored')),
  changes jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now(),
  foreign key (company_id, item_id) references public.catalog_items (company_id, id) on delete cascade
);
create index if not exists catalog_events_item_idx on public.catalog_events (item_id, id desc);

-- items: never deleted while the company exists; history: append-only
create or replace function public.catalog_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'CATALOG_IMMUTABLE' using errcode = 'P0001', hint = 'archive it instead';
  end if;
  if tg_table_name = 'catalog_events' then raise exception 'CATALOG_IMMUTABLE' using errcode = 'P0001'; end if;
  if new.company_id <> old.company_id or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
    raise exception 'CATALOG_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_catalog_guard on public.catalog_items;
create trigger ba_catalog_guard before update or delete on public.catalog_items for each row execute function public.catalog_guard();
drop trigger if exists ba_catalog_events_guard on public.catalog_events;
create trigger ba_catalog_events_guard before update or delete on public.catalog_events for each row execute function public.catalog_guard();

alter table public.catalog_items enable row level security;
alter table public.catalog_events enable row level security;
do $$ declare t text; begin
  foreach t in array array['catalog_items', 'catalog_events'] loop
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
drop policy if exists ba_catalog_items_select on public.catalog_items;
create policy ba_catalog_items_select on public.catalog_items for select to authenticated using (public.has_permission(company_id, 'catalog.view'));
drop policy if exists ba_catalog_events_select on public.catalog_events;
create policy ba_catalog_events_select on public.catalog_events for select to authenticated using (public.has_permission(company_id, 'catalog.manage'));

-- ===================================================================== writes
-- Create (item null) or update (expected_version must match). Returns id and the new version.
create or replace function public.catalog_save(target uuid, item uuid, p_code text, p_name text, p_description text, p_kind text, p_unit text,
                                               p_price_cents bigint, p_tax_rate numeric, p_track_inventory boolean, expected_version integer)
returns table (id uuid, version integer) language plpgsql security definer set search_path = '' as $$
declare
  c public.catalog_items;
  n public.catalog_items;
  code_t text := btrim(coalesce(p_code, ''));
begin
  if target is null or not public.has_permission(target, 'catalog.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if code_t !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$' or char_length(btrim(coalesce(p_name, ''))) not between 1 and 160
     or char_length(coalesce(p_description, '')) > 1000 or coalesce(p_kind, '') not in ('product', 'service')
     or char_length(btrim(coalesce(p_unit, ''))) not between 1 and 20 or p_price_cents is null or p_price_cents not between 0 and 100000000000
     or (p_tax_rate is not null and p_tax_rate not between 0 and 100) or (p_kind = 'service' and coalesce(p_track_inventory, false)) then
    raise exception 'CATALOG_INVALID' using errcode = 'P0001';
  end if;
  if item is not null then
    select * into c from public.catalog_items x where x.id = item and x.company_id = target for update;
    if c.id is null then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
    if c.status = 'archived' then raise exception 'CATALOG_ARCHIVED' using errcode = 'P0001'; end if;
    if expected_version is distinct from c.version then raise exception 'CATALOG_CONFLICT' using errcode = 'P0001'; end if;
  end if;
  if exists (select 1 from public.catalog_items x where x.company_id = target and lower(x.code) = lower(code_t) and x.id is distinct from item) then
    raise exception 'CATALOG_CODE_TAKEN' using errcode = 'P0001';
  end if;
  if item is null then
    insert into public.catalog_items (company_id, code, name, description, kind, unit, price_cents, tax_rate, track_inventory, created_by, updated_by)
    values (target, code_t, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), p_kind, btrim(p_unit), p_price_cents, p_tax_rate,
            coalesce(p_track_inventory, false), (select auth.uid()), (select auth.uid()))
    returning * into n;
    insert into public.catalog_events (company_id, item_id, action, changes, actor)
    values (target, n.id, 'created', jsonb_build_object('code', n.code, 'name', n.name, 'price_cents', n.price_cents), (select auth.uid()));
  else
    update public.catalog_items x set code = code_t, name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''), kind = p_kind,
      unit = btrim(p_unit), price_cents = p_price_cents, tax_rate = p_tax_rate, track_inventory = coalesce(p_track_inventory, false),
      version = x.version + 1, updated_by = (select auth.uid()), updated_at = now()
    where x.id = item returning * into n;
    insert into public.catalog_events (company_id, item_id, action, changes, actor)
    select target, n.id, 'updated', coalesce(jsonb_object_agg(k.key, jsonb_build_object('from', left(o.value #>> '{}', 300), 'to', left(k.value #>> '{}', 300))), '{}'::jsonb), (select auth.uid())
    from jsonb_each(to_jsonb(n) - array['version', 'updated_by', 'updated_at']) k
    join jsonb_each(to_jsonb(c)) o on o.key = k.key
    where o.value is distinct from k.value;
  end if;
  return query select n.id, n.version;
end $$;

-- Archive / restore. An archived item cannot be chosen for new lines; documents that used it keep their copy.
create or replace function public.catalog_set_status(item uuid, p_status text, expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare c public.catalog_items;
begin
  select * into c from public.catalog_items x where x.id = item for update;
  if c.id is null or not public.has_permission(c.company_id, 'catalog.manage') then raise exception 'CATALOG_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_status not in ('active', 'archived') then raise exception 'CATALOG_INVALID' using errcode = 'P0001'; end if;
  if expected_version is distinct from c.version then raise exception 'CATALOG_CONFLICT' using errcode = 'P0001'; end if;
  if c.status = p_status then return c.version; end if;
  update public.catalog_items x set status = p_status, version = x.version + 1, updated_by = (select auth.uid()), updated_at = now() where x.id = item;
  insert into public.catalog_events (company_id, item_id, action, actor)
  values (c.company_id, c.id, case p_status when 'archived' then 'archived' else 'restored' end, (select auth.uid()));
  return c.version + 1;
end $$;

do $$ declare f text; begin
  foreach f in array array['catalog_save(uuid, uuid, text, text, text, text, text, bigint, numeric, boolean, integer)', 'catalog_set_status(uuid, text, integer)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function public.catalog_guard() from public, anon, authenticated;

-- ===================================================================== self-check
do $$ begin
  if has_table_privilege('authenticated', 'public.catalog_items', 'INSERT') or has_table_privilege('authenticated', 'public.catalog_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.catalog_items', 'DELETE') or has_table_privilege('anon', 'public.catalog_items', 'SELECT') then
    raise exception 'BA0039 self-check failed: catalog writable directly or readable by anon';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
        and p.proname in ('catalog_save', 'catalog_set_status') and p.prosecdef and not (p.proconfig @> array['search_path=""'])) > 0 then
    raise exception 'BA0039 self-check failed: definer without search_path';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'catalog.manage') then
    raise exception 'BA0039 self-check failed: members must not manage the catalog';
  end if;
end $$;

commit;
