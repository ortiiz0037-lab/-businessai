-- =====================================================================
-- BusinessAI · Migration 0028 · Document Studio
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a, 0015, 0019, 0020, 0024, 0025.
--
-- A layout and writing layer on top of the existing data. NO PARALLEL
-- RECORDS: a studio document only REFERENCES a client, a business document
-- (documents: quotes, invoices, receipts, work orders), an employee or a
-- vendor; amounts, items and payments are read from their own tables.
-- When a studio document is ISSUED (studio_finalize) the database itself
-- copies the referenced data from those tables into an immutable snapshot
-- (a legal copy of what was issued, never a source for accounting): the
-- client cannot supply amounts, only the item lines, which are checked
-- against documents.items / subtotal.
--
-- Numbering: a studio document bound to a business document uses THAT
-- number (no second numbering for invoices / quotes / receipts); the rest
-- take the company's studio numbering (pattern per kind, e.g. CT-2026-0001).
--
-- System templates are versioned in the app code (read-only for every
-- company); a company customises its own copies here (studio_templates),
-- never another company's. Identity: logo, signature and base colours stay
-- in company_profiles (0003/0009); studio_brand adds fonts, header/footer,
-- watermark, stamp, page and numbering settings.
--
-- Images (stamps, pictures) go to the PRIVATE bucket Studio-assets under
-- <company>/<file>; the app validates type (PNG/JPEG by magic bytes), size
-- (≤ 2 MB) and dimensions before uploading; the bucket enforces the type
-- and size again.
--
-- ROLES: studio.view / studio.edit (owner, admin, member); studio.issue,
-- studio.templates, studio.brand (owner, admin). Reading a bound record
-- also needs that record's own permission (clients.view, documents.view,
-- workforce.manage for employees, payables.view for vendors).
-- Rollback: supabase/rollback/0028_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.employees') is null or to_regclass('public.vendors') is null or to_regprocedure('public.ar_invoice_balances(uuid, date)') is null then
    raise exception 'BA0028: migrations 0020, 0024 and 0025 must be applied first';
  end if;
end $$;

insert into public.permissions (key, module, description_es, description_en) values
  ('studio.view', 'studio', 'Ver documentos de Document Studio', 'View Document Studio documents'),
  ('studio.edit', 'studio', 'Crear, editar y duplicar borradores de Document Studio', 'Create, edit and duplicate Document Studio drafts'),
  ('studio.issue', 'studio', 'Emitir y archivar documentos de Document Studio', 'Issue and archive Document Studio documents'),
  ('studio.templates', 'studio', 'Gestionar las plantillas de la empresa', 'Manage the company templates'),
  ('studio.brand', 'studio', 'Gestionar la identidad corporativa de los documentos', 'Manage the corporate identity of documents')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'studio.view'), ('admin', 'studio.view'), ('member', 'studio.view'),
  ('owner', 'studio.edit'), ('admin', 'studio.edit'), ('member', 'studio.edit'),
  ('owner', 'studio.issue'), ('admin', 'studio.issue'),
  ('owner', 'studio.templates'), ('admin', 'studio.templates'),
  ('owner', 'studio.brand'), ('admin', 'studio.brand')
on conflict do nothing;

-- ------------------------------------------------------------- content validation
-- The editor's block document: { "v": 1, "blocks": [ … ] }. Only known block
-- types, bounded sizes, no markup, no URLs (images reference a studio asset
-- of the same company or the company logo).
create or replace function public.studio_valid_content(c jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare b jsonb; t text;
begin
  if c is null or jsonb_typeof(c) <> 'object' or (c ->> 'v') is distinct from '1' or jsonb_typeof(c -> 'blocks') <> 'array' then return false; end if;
  if octet_length(c::text) > 400000 or jsonb_array_length(c -> 'blocks') > 500 then return false; end if;
  for b in select value from jsonb_array_elements(c -> 'blocks') loop
    if jsonb_typeof(b) <> 'object' then return false; end if;
    t := b ->> 'type';
    if t is null or t not in ('heading', 'paragraph', 'table', 'image', 'signature', 'stamp', 'spacer', 'divider', 'pagebreak', 'items', 'totals', 'payments', 'statement', 'fields') then
      return false;
    end if;
    if octet_length(coalesce(b ->> 'text', '')) > 20000 then return false; end if;
    if t = 'table' and (jsonb_typeof(b -> 'rows') <> 'array' or jsonb_array_length(b -> 'rows') > 200) then return false; end if;
    if t = 'image' and coalesce(b ->> 'asset', '') !~* '^(logo|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then return false; end if;
    -- no markup or links smuggled into text
    if b::text ~* '<\s*/?\s*(script|iframe|object|embed|img|svg|style|link|a|form|input|meta|base)\y|javascript:|vbscript:|data:text/html|\son[a-z]+\s*=' then return false; end if;
  end loop;
  return true;
end $$;

create or replace function public.studio_valid_page(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'object'
    and coalesce(p ->> 'size', 'letter') in ('letter', 'a4', 'legal')
    and coalesce(p ->> 'orientation', 'portrait') in ('portrait', 'landscape')
    and coalesce(p ->> 'font', 'sans') in ('sans', 'serif')
    and coalesce((p ->> 'fontSize')::numeric, 10.5) between 8 and 16
    and coalesce((p ->> 'lineHeight')::numeric, 1.35) between 1 and 2.2
    and coalesce((p ->> 'marginTop')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginRight')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginBottom')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginLeft')::numeric, 20) between 8 and 50
    and coalesce(p ->> 'accent', '#000000') ~ '^#[0-9A-Fa-f]{6}$'
    and octet_length(p::text) < 4000
$$;

-- ------------------------------------------------------------- tables
create table if not exists public.studio_brand (
  company_id uuid primary key references public.companies(id) on delete cascade,
  heading_font text not null default 'sans' check (heading_font in ('sans', 'serif')),
  body_font text not null default 'sans' check (body_font in ('sans', 'serif')),
  accent_color text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  text_color text not null default '#111827' check (text_color ~ '^#[0-9A-Fa-f]{6}$'),
  header_text text check (header_text is null or char_length(header_text) <= 300),
  footer_text text check (footer_text is null or char_length(footer_text) <= 300),
  show_logo boolean not null default true,
  show_page_numbers boolean not null default true,
  watermark_text text check (watermark_text is null or char_length(watermark_text) between 1 and 40),
  watermark_opacity integer not null default 8 check (watermark_opacity between 3 and 30),
  stamp_asset_id uuid,
  signature_name text check (signature_name is null or char_length(signature_name) <= 120),
  signature_title text check (signature_title is null or char_length(signature_title) <= 120),
  page jsonb not null default '{}'::jsonb check (public.studio_valid_page(page)),
  number_formats jsonb not null default '{}'::jsonb check (jsonb_typeof(number_formats) = 'object' and octet_length(number_formats::text) < 2000),
  updated_by uuid, updated_at timestamptz not null default now()
);

create table if not exists public.studio_assets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 160),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes between 1 and 2097152),
  width integer not null check (width between 1 and 6000),
  height integer not null check (height between 1 and 6000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid, created_at timestamptz not null default now(),
  unique (company_id, id),
  check (split_part(storage_path, '/', 1) = company_id::text)
);
alter table public.studio_brand drop constraint if exists studio_brand_stamp_fk;
alter table public.studio_brand add constraint studio_brand_stamp_fk foreign key (company_id, stamp_asset_id) references public.studio_assets (company_id, id) deferrable initially deferred;

create table if not exists public.studio_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('letter', 'quote', 'invoice', 'receipt', 'work_order', 'purchase_order', 'contract', 'report', 'account_statement', 'certificate')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  base_key text check (base_key is null or base_key ~ '^[a-z0-9_]{1,60}$'),
  content jsonb not null check (public.studio_valid_content(content)),
  page jsonb not null default '{}'::jsonb check (public.studio_valid_page(page)),
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  created_by uuid, created_at timestamptz not null default now(),
  updated_by uuid, updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index if not exists studio_templates_name_uidx on public.studio_templates (company_id, lower(btrim(name))) where status = 'active';

create table if not exists public.studio_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('letter', 'quote', 'invoice', 'receipt', 'work_order', 'purchase_order', 'contract', 'report', 'account_statement', 'certificate')),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  folder text check (folder is null or char_length(btrim(folder)) between 1 and 60),
  status text not null default 'draft' check (status in ('draft', 'final', 'archived')),
  number text check (number is null or char_length(number) <= 60),
  template_id uuid,
  base_key text check (base_key is null or base_key ~ '^[a-z0-9_]{1,60}$'),
  content jsonb not null check (public.studio_valid_content(content)),
  page jsonb not null default '{}'::jsonb check (public.studio_valid_page(page)),
  client_id uuid, source_document_id uuid, employee_id uuid, vendor_id uuid,
  origin text not null default 'user' check (origin in ('user', 'assistant')),
  version integer not null default 1 check (version >= 1),
  snapshot jsonb,
  created_by uuid, created_at timestamptz not null default now(),
  updated_by uuid, updated_at timestamptz not null default now(),
  finalized_by uuid, finalized_at timestamptz,
  archived_by uuid, archived_at timestamptz, archive_reason text,
  unique (company_id, id),
  foreign key (company_id, template_id) references public.studio_templates (company_id, id) deferrable initially deferred,
  check ((status = 'draft') = (finalized_at is null) or status = 'archived'),
  check (status <> 'final' or (number is not null and snapshot is not null))
);
create unique index if not exists studio_documents_number_uidx on public.studio_documents (company_id, kind, number) where number is not null;
create index if not exists studio_documents_list_idx on public.studio_documents (company_id, updated_at desc);
create index if not exists studio_documents_source_idx on public.studio_documents (source_document_id) where source_document_id is not null;

create table if not exists public.studio_versions (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  document_id uuid not null,
  version integer not null,
  title text not null,
  content jsonb not null,
  page jsonb not null,
  saved_by uuid, saved_at timestamptz not null default now(),
  unique (document_id, version),
  foreign key (company_id, document_id) references public.studio_documents (company_id, id) on delete cascade
);

create table if not exists public.studio_counters (
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null,
  year integer not null,
  last_number integer not null default 0,
  primary key (company_id, kind, year)
);

create table if not exists public.studio_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid,
  entity text not null check (entity in ('document', 'template', 'brand', 'asset')),
  entity_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists studio_events_doc_idx on public.studio_events (document_id, id desc);
create index if not exists studio_events_company_idx on public.studio_events (company_id, id desc);

-- RLS: read with studio.view (counters: nobody); every write goes through
-- the functions below (no direct insert / update / delete).
do $$
declare t text;
begin
  foreach t in array array['studio_brand', 'studio_assets', 'studio_templates', 'studio_documents', 'studio_versions', 'studio_events', 'studio_counters'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
    if t <> 'studio_counters' then
      execute format('grant select on public.%I to authenticated', t);
      execute format('create policy ba_%s_select on public.%I for select to authenticated using (public.has_permission(company_id, ''studio.view''))', t, t);
    end if;
    execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    execute format('create trigger ba_company_immutable before update on public.%I for each row execute function public.forbid_company_change()', t);
  end loop;
end $$;
drop trigger if exists ba_studio_append_only on public.studio_events;
create trigger ba_studio_append_only before update or delete on public.studio_events for each row execute function public.ledger_append_only();
drop trigger if exists ba_studio_append_only on public.studio_versions;
create trigger ba_studio_append_only before update on public.studio_versions for each row execute function public.ledger_append_only();

-- Issued documents never change and are never deleted (only archived, with
-- a reason); drafts are not deleted either (archived), except by the
-- company cascade.
create or replace function public.studio_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'STUDIO_IMMUTABLE' using errcode = 'P0001';
  end if;
  if old.status = 'archived' then raise exception 'STUDIO_LOCKED' using errcode = 'P0001', hint = 'archived'; end if;
  if old.status = 'final' and (to_jsonb(new) - array['status', 'archived_by', 'archived_at', 'archive_reason'])
                              <> (to_jsonb(old) - array['status', 'archived_by', 'archived_at', 'archive_reason']) then
    raise exception 'STUDIO_LOCKED' using errcode = 'P0001', hint = 'final';
  end if;
  if new.created_at <> old.created_at or new.created_by is distinct from old.created_by then raise exception 'STUDIO_LOCKED' using errcode = 'P0001'; end if;
  return new;
end $$;
drop trigger if exists ba_studio_guard on public.studio_documents;
create trigger ba_studio_guard before update or delete on public.studio_documents for each row execute function public.studio_guard();

-- References must belong to the same company (and to the right kind).
create or replace function public.studio_check_refs()
returns trigger language plpgsql set search_path = '' as $$
declare dt text;
begin
  if new.client_id is not null and not exists (select 1 from public.clients c where c.id = new.client_id and c.company_id = new.company_id) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'client';
  end if;
  if new.employee_id is not null and not exists (select 1 from public.employees e where e.id = new.employee_id and e.company_id = new.company_id) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'employee';
  end if;
  if new.vendor_id is not null and not exists (select 1 from public.vendors v where v.id = new.vendor_id and v.company_id = new.company_id) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'vendor';
  end if;
  if new.source_document_id is not null then
    select d.document_type into dt from public.documents d where d.id = new.source_document_id and d.company_id = new.company_id;
    if dt is null then raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'document'; end if;
    if (new.kind = 'invoice' and dt <> 'invoice') or (new.kind = 'quote' and dt <> 'quote') or (new.kind = 'receipt' and dt not in ('receipt', 'invoice'))
       or (new.kind = 'work_order' and dt not in ('work_order', 'quote', 'invoice')) or new.kind in ('purchase_order', 'certificate') then
      raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'document_type';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ba_studio_refs on public.studio_documents;
create trigger ba_studio_refs before insert or update of client_id, employee_id, vendor_id, source_document_id, kind on public.studio_documents
  for each row execute function public.studio_check_refs();

-- ------------------------------------------------------------- helpers
create or replace function public.studio_log(target uuid, doc uuid, ent text, ent_id text, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.studio_events (company_id, document_id, entity, entity_id, action, details, actor)
  values (target, doc, ent, ent_id, act, coalesce(info, '{}'::jsonb), (select auth.uid()))
$$;

create or replace function public.studio_doc_for(doc uuid, perm text)
returns public.studio_documents language plpgsql security definer set search_path = '' as $$
declare d public.studio_documents;
begin
  select * into d from public.studio_documents where id = doc;
  if d.id is null or ((select auth.uid()) is not null and not public.has_permission(d.company_id, perm)) then
    raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_studio:' || d.id::text, 0));
  select * into d from public.studio_documents where id = doc;          -- under the lock
  return d;
end $$;

-- Reading a bound record needs that record's own permission.
create or replace function public.studio_check_ref_access(target uuid, client uuid, source_document uuid, employee uuid, vendor uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then return; end if;
  if (client is not null and not public.has_permission(target, 'clients.view'))
     or (source_document is not null and not public.has_permission(target, 'documents.view'))
     or (employee is not null and not public.has_permission(target, 'workforce.manage'))
     or (vendor is not null and not public.has_permission(target, 'payables.view')) then
    raise exception 'FORBIDDEN' using errcode = 'P0001', hint = 'reference';
  end if;
end $$;

-- ------------------------------------------------------------- documents
-- Create (doc null) or save a draft. expected_version guards against two
-- people saving the same draft (STUDIO_CONFLICT); each save keeps a version.
create or replace function public.studio_save_document(target uuid, doc uuid, doc_kind text, doc_title text, doc_folder text, doc_content jsonb, doc_page jsonb,
  client uuid default null, source_document uuid default null, employee uuid default null, vendor uuid default null,
  template uuid default null, base text default null, expected_version integer default null, doc_origin text default 'user')
returns table (id uuid, version integer) language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  d public.studio_documents;
  nid uuid;
  nv integer;
begin
  if not public.has_permission(target, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if not public.studio_valid_content(doc_content) then raise exception 'STUDIO_CONTENT_INVALID' using errcode = 'P0001'; end if;
  if not public.studio_valid_page(coalesce(doc_page, '{}'::jsonb)) then raise exception 'STUDIO_CONTENT_INVALID' using errcode = 'P0001', hint = 'page'; end if;
  perform public.studio_check_ref_access(target, client, source_document, employee, vendor);
  if exists (select 1 from jsonb_array_elements(doc_content -> 'blocks') b
             where b ->> 'type' = 'image' and b ->> 'asset' <> 'logo'
               and not exists (select 1 from public.studio_assets a where a.id = (b ->> 'asset')::uuid and a.company_id = target)) then
    raise exception 'STUDIO_ASSET_INVALID' using errcode = 'P0001';
  end if;
  if template is not null and not exists (select 1 from public.studio_templates t where t.id = template and t.company_id = target) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'template';
  end if;
  if doc is null then
    nid := gen_random_uuid();
    insert into public.studio_documents (id, company_id, kind, title, folder, content, page, client_id, source_document_id, employee_id, vendor_id, template_id, base_key, origin, created_by, updated_by)
    values (nid, target, doc_kind, btrim(doc_title), nullif(btrim(coalesce(doc_folder, '')), ''), doc_content, coalesce(doc_page, '{}'::jsonb), client, source_document, employee, vendor,
            template, base, coalesce(doc_origin, 'user'), (select auth.uid()), (select auth.uid()));
    insert into public.studio_versions (company_id, document_id, version, title, content, page, saved_by)
    values (target, nid, 1, btrim(doc_title), doc_content, coalesce(doc_page, '{}'::jsonb), (select auth.uid()));
    perform public.studio_log(target, nid, 'document', nid::text, case when doc_origin = 'assistant' then 'drafted_by_assistant' else 'created' end,
                              jsonb_build_object('kind', doc_kind, 'title', doc_title, 'template', coalesce(template::text, base)));
    return query select nid, 1;
    return;
  end if;
  d := public.studio_doc_for(doc, 'studio.edit');
  if d.company_id <> target then raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001'; end if;
  if d.status <> 'draft' then raise exception 'STUDIO_LOCKED' using errcode = 'P0001', hint = d.status; end if;
  if expected_version is not null and expected_version <> d.version then raise exception 'STUDIO_CONFLICT' using errcode = 'P0001', hint = d.version::text; end if;
  nv := d.version + 1;
  update public.studio_documents s set title = btrim(doc_title), folder = nullif(btrim(coalesce(doc_folder, '')), ''), content = doc_content, page = coalesce(doc_page, '{}'::jsonb),
         kind = doc_kind, client_id = client, source_document_id = source_document, employee_id = employee, vendor_id = vendor,
         version = nv, updated_by = (select auth.uid()), updated_at = now()
   where s.id = d.id;
  insert into public.studio_versions (company_id, document_id, version, title, content, page, saved_by)
  values (target, d.id, nv, btrim(doc_title), doc_content, coalesce(doc_page, '{}'::jsonb), (select auth.uid()));
  return query select d.id, nv;
end $$;

create or replace function public.studio_duplicate(doc uuid, new_title text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  d public.studio_documents := public.studio_doc_for(doc, 'studio.edit');
  nid uuid := gen_random_uuid();
  t text := left(coalesce(nullif(btrim(new_title), ''), 'Copia de ' || d.title), 160);
begin
  perform public.studio_check_ref_access(d.company_id, d.client_id, d.source_document_id, d.employee_id, d.vendor_id);
  insert into public.studio_documents (id, company_id, kind, title, folder, content, page, client_id, source_document_id, employee_id, vendor_id, template_id, base_key, created_by, updated_by)
  values (nid, d.company_id, d.kind, t, d.folder, d.content, d.page, d.client_id, d.source_document_id, d.employee_id, d.vendor_id, d.template_id, d.base_key, (select auth.uid()), (select auth.uid()));
  insert into public.studio_versions (company_id, document_id, version, title, content, page, saved_by)
  values (d.company_id, nid, 1, t, d.content, d.page, (select auth.uid()));
  perform public.studio_log(d.company_id, nid, 'document', nid::text, 'duplicated', jsonb_build_object('from', d.id, 'from_number', d.number));
  return nid;
end $$;

-- Restore an earlier saved version into the draft (as a new version).
create or replace function public.studio_restore_version(doc uuid, from_version integer, expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  d public.studio_documents := public.studio_doc_for(doc, 'studio.edit');
  v public.studio_versions;
begin
  if d.status <> 'draft' then raise exception 'STUDIO_LOCKED' using errcode = 'P0001', hint = d.status; end if;
  if expected_version is distinct from d.version then raise exception 'STUDIO_CONFLICT' using errcode = 'P0001', hint = d.version::text; end if;
  select * into v from public.studio_versions x where x.document_id = d.id and x.version = from_version;
  if v.id is null then raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001', hint = 'version'; end if;
  update public.studio_documents set title = v.title, content = v.content, page = v.page, version = d.version + 1, updated_by = (select auth.uid()), updated_at = now() where id = d.id;
  insert into public.studio_versions (company_id, document_id, version, title, content, page, saved_by) values (d.company_id, d.id, d.version + 1, v.title, v.content, v.page, (select auth.uid()));
  perform public.studio_log(d.company_id, d.id, 'document', d.id::text, 'version_restored', jsonb_build_object('from_version', from_version, 'version', d.version + 1));
  return d.version + 1;
end $$;

-- Data a document shows, read from its own tables (the same shape the app
-- builds for the live preview). Also used to freeze the issued copy.
create or replace function public.studio_data(doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  d public.studio_documents;
  r jsonb := '{}'::jsonb;
begin
  select * into d from public.studio_documents where id = doc;
  if d.id is null or ((select auth.uid()) is not null and not public.has_permission(d.company_id, 'studio.view')) then
    raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform public.studio_check_ref_access(d.company_id, d.client_id, d.source_document_id, d.employee_id, d.vendor_id);
  r := jsonb_build_object('company', (
    select jsonb_build_object('name', c.name, 'legal_name', p.legal_name, 'display_name', p.display_name, 'phone', p.phone, 'email', p.email,
                              'address', p.address, 'city', p.city, 'state', p.state, 'postal_code', p.postal_code, 'payment_info', p.payment_info)
    from public.companies c left join public.company_profiles p on p.company_id = c.id where c.id = d.company_id));
  if d.client_id is not null then
    r := r || jsonb_build_object('client', (select jsonb_build_object('name', c.name, 'business_name', c.business_name, 'email', c.email, 'phone', c.phone,
      'address', c.address, 'city', c.city, 'state', c.state, 'postal_code', c.postal_code) from public.clients c where c.id = d.client_id));
  end if;
  if d.source_document_id is not null then
    r := r || jsonb_build_object('document', (select jsonb_build_object('id', x.id, 'type', x.document_type, 'number', x.document_number, 'status', x.status, 'title', x.title,
      'issue_date', x.issue_date, 'due_date', x.due_date, 'subtotal', x.subtotal, 'tax', x.tax, 'total', x.total, 'payment_info', x.payment_info, 'language', x.language,
      'discount', coalesce((x.metadata ->> 'discount')::numeric, 0), 'tax_rate', (x.metadata ->> 'tax_rate')::numeric, 'client_id', x.client_id)
      from public.documents x where x.id = d.source_document_id),
      'payments', coalesce((select jsonb_agg(jsonb_build_object('date', (coalesce(y.paid_at, y.created_at) at time zone 'America/Puerto_Rico')::date, 'amount', y.amount,
                              'method', y.payment_method, 'reference', y.reference) order by coalesce(y.paid_at, y.created_at))
                            from public.payments y where y.document_id = d.source_document_id and y.voided_at is null), '[]'::jsonb));
    if d.client_id is null then
      r := r || jsonb_build_object('client', (select jsonb_build_object('name', c.name, 'business_name', c.business_name, 'email', c.email, 'phone', c.phone,
        'address', c.address, 'city', c.city, 'state', c.state, 'postal_code', c.postal_code)
        from public.clients c join public.documents x on x.client_id = c.id where x.id = d.source_document_id));
    end if;
  end if;
  if d.kind = 'account_statement' and d.client_id is not null then
    r := r || jsonb_build_object('statement', coalesce((select jsonb_agg(jsonb_build_object('number', b.document_number, 'issue_date', b.issue_date, 'due_date', b.due_date,
      'total_cents', b.total_cents, 'paid_cents', b.paid_cents, 'balance_cents', b.balance_cents, 'days_past_due', b.days_past_due) order by b.issue_date)
      from public.ar_invoice_balances(d.company_id, null) b where b.client_id = d.client_id and b.balance_cents > 0), '[]'::jsonb));
  end if;
  if d.employee_id is not null then
    r := r || jsonb_build_object('employee', (select jsonb_build_object('first_name', e.first_name, 'last_name', e.last_name, 'full_name', btrim(e.first_name || ' ' || coalesce(e.last_name, '')),
      'employee_number', e.employee_number, 'position', e.position, 'hire_date', e.hire_date, 'termination_date', e.termination_date, 'status', e.status,
      'department', (select dp.name from public.departments dp where dp.id = e.department_id)) from public.employees e where e.id = d.employee_id));
  end if;
  if d.vendor_id is not null then
    r := r || jsonb_build_object('vendor', (select jsonb_build_object('name', v.name, 'tax_id', v.tax_id, 'email', v.email, 'phone', v.phone, 'address', v.address)
      from public.vendors v where v.id = d.vendor_id));
  end if;
  return r;
end $$;

-- Issue: freeze the data (read here, not sent by the app), assign the
-- number and lock the document. items: the lines the app read from the
-- business document; they must be exactly documents.items, or (documents
-- saved in the old text format) add up to its subtotal.
create or replace function public.studio_finalize(doc uuid, expected_version integer, items jsonb default '[]'::jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  d public.studio_documents := public.studio_doc_for(doc, 'studio.issue');
  src public.documents;
  data jsonb;
  num text;
  y integer := extract(year from public.ba_today())::int;
  n integer;
  pattern text;
  item_sum numeric;
begin
  if d.status <> 'draft' then raise exception 'STUDIO_TRANSITION' using errcode = 'P0001', hint = d.status || '->final'; end if;
  if expected_version is distinct from d.version then raise exception 'STUDIO_CONFLICT' using errcode = 'P0001', hint = d.version::text; end if;
  if jsonb_typeof(coalesce(items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(items, '[]'::jsonb)) > 30 then raise exception 'STUDIO_ITEMS_INVALID' using errcode = 'P0001'; end if;
  if d.kind in ('invoice', 'quote', 'receipt') and d.source_document_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001'; end if;
  if d.kind = 'account_statement' and d.client_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001', hint = 'client'; end if;
  if d.kind = 'certificate' and d.employee_id is null and d.client_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001', hint = 'recipient'; end if;
  data := public.studio_data(d.id);
  if d.source_document_id is not null then
    select * into src from public.documents x where x.id = d.source_document_id;
    if src.status = 'draft' and d.kind in ('invoice', 'receipt') then raise exception 'STUDIO_SOURCE_DRAFT' using errcode = 'P0001'; end if;
    if jsonb_array_length(coalesce(items, '[]'::jsonb)) > 0 then
      if jsonb_typeof(src.items) = 'array' and jsonb_array_length(src.items) > 0 then
        if items <> src.items then raise exception 'STUDIO_ITEMS_INVALID' using errcode = 'P0001', hint = 'differ'; end if;
      else
        select coalesce(sum((x ->> 'amount')::numeric), 0) into item_sum from jsonb_array_elements(items) x;
        if item_sum <> src.subtotal then raise exception 'STUDIO_ITEMS_INVALID' using errcode = 'P0001', hint = 'subtotal'; end if;
      end if;
    elsif jsonb_typeof(src.items) = 'array' and jsonb_array_length(src.items) > 0 then
      items := src.items;
    end if;
    num := src.document_number;                                        -- the business document's own number
  else
    insert into public.studio_counters as c (company_id, kind, year, last_number) values (d.company_id, d.kind, y, 1)
    on conflict (company_id, kind, year) do update set last_number = c.last_number + 1
    returning last_number into n;
    select b.number_formats ->> d.kind into pattern from public.studio_brand b where b.company_id = d.company_id;
    pattern := coalesce(nullif(pattern, ''), upper(case d.kind when 'letter' then 'CAR' when 'work_order' then 'OT' when 'purchase_order' then 'OC' when 'contract' then 'CON'
                 when 'report' then 'INF' when 'account_statement' then 'EC' when 'certificate' then 'CER' else left(d.kind, 3) end) || '-{YYYY}-{####}');
    num := replace(replace(replace(pattern, '{YYYY}', y::text), '{YY}', right(y::text, 2)), '{####}', lpad(n::text, 4, '0'));
    if num !~ '\d' then num := num || '-' || lpad(n::text, 4, '0'); end if;
  end if;
  update public.studio_documents set status = 'final', number = left(num, 60), finalized_by = (select auth.uid()), finalized_at = now(),
         snapshot = jsonb_build_object('data', data, 'items', coalesce(items, '[]'::jsonb), 'issued_on', public.ba_today(), 'version', d.version)
   where id = d.id;
  perform public.studio_log(d.company_id, d.id, 'document', d.id::text, 'finalized', jsonb_build_object('number', num, 'version', d.version));
  return num;
end $$;

create or replace function public.studio_archive(doc uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  d public.studio_documents;
  why text := btrim(coalesce(reason, ''));
begin
  select * into d from public.studio_documents where id = doc;
  d := public.studio_doc_for(doc, case when d.status = 'final' then 'studio.issue' else 'studio.edit' end);
  if d.status = 'archived' then return; end if;
  if char_length(why) < 3 or char_length(why) > 300 then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  update public.studio_documents set status = 'archived', archived_by = (select auth.uid()), archived_at = now(), archive_reason = why where id = d.id;
  perform public.studio_log(d.company_id, d.id, 'document', d.id::text, 'archived', jsonb_build_object('reason', why, 'was', d.status));
end $$;

-- Audit of what happens outside the database: export, print, e-mail prepared.
create or replace function public.studio_record(doc uuid, act text, info jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.studio_documents;
begin
  select * into d from public.studio_documents where id = doc;
  if d.id is null or ((select auth.uid()) is not null and not public.has_permission(d.company_id, 'studio.view')) then raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001'; end if;
  if act not in ('exported_pdf', 'printed', 'email_prepared') then raise exception 'STUDIO_ACTION_INVALID' using errcode = 'P0001'; end if;
  if act = 'email_prepared' and d.status <> 'final' then raise exception 'STUDIO_TRANSITION' using errcode = 'P0001', hint = 'email needs an issued document'; end if;
  perform public.studio_log(d.company_id, d.id, 'document', d.id::text, act, coalesce(info, '{}'::jsonb) - 'body');
end $$;

-- ------------------------------------------------------------- templates, brand, assets
create or replace function public.studio_save_template(target uuid, template uuid, t_kind text, t_name text, t_description text, t_base text, t_content jsonb, t_page jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  nid uuid;
  t public.studio_templates;
begin
  if not public.has_permission(target, 'studio.templates') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if not public.studio_valid_content(t_content) or not public.studio_valid_page(coalesce(t_page, '{}'::jsonb)) then raise exception 'STUDIO_CONTENT_INVALID' using errcode = 'P0001'; end if;
  if exists (select 1 from jsonb_array_elements(t_content -> 'blocks') b where b ->> 'type' = 'image' and b ->> 'asset' <> 'logo'
             and not exists (select 1 from public.studio_assets a where a.id = (b ->> 'asset')::uuid and a.company_id = target)) then
    raise exception 'STUDIO_ASSET_INVALID' using errcode = 'P0001';
  end if;
  if template is null then
    nid := gen_random_uuid();
    insert into public.studio_templates (id, company_id, kind, name, description, base_key, content, page, created_by, updated_by)
    values (nid, target, t_kind, btrim(t_name), nullif(btrim(coalesce(t_description, '')), ''), t_base, t_content, coalesce(t_page, '{}'::jsonb), (select auth.uid()), (select auth.uid()));
    perform public.studio_log(target, null, 'template', nid::text, 'template_created', jsonb_build_object('name', t_name, 'kind', t_kind, 'base', t_base));
    return nid;
  end if;
  select * into t from public.studio_templates x where x.id = template and x.company_id = target for update;
  if t.id is null then raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001', hint = 'template'; end if;
  if t.status <> 'active' then raise exception 'STUDIO_LOCKED' using errcode = 'P0001', hint = 'archived'; end if;
  update public.studio_templates set kind = t_kind, name = btrim(t_name), description = nullif(btrim(coalesce(t_description, '')), ''), content = t_content,
         page = coalesce(t_page, '{}'::jsonb), version = t.version + 1, updated_by = (select auth.uid()), updated_at = now() where id = t.id;
  perform public.studio_log(target, null, 'template', t.id::text, 'template_updated', jsonb_build_object('name', t_name, 'version', t.version + 1));
  return t.id;
end $$;

create or replace function public.studio_archive_template(template uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.studio_templates;
begin
  select * into t from public.studio_templates where id = template;
  if t.id is null or ((select auth.uid()) is not null and not public.has_permission(t.company_id, 'studio.templates')) then raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001'; end if;
  update public.studio_templates set status = 'archived', updated_by = (select auth.uid()), updated_at = now() where id = t.id;
  perform public.studio_log(t.company_id, null, 'template', t.id::text, 'template_archived', '{}'::jsonb);
end $$;

create or replace function public.studio_save_brand(target uuid, settings jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare s jsonb := coalesce(settings, '{}'::jsonb);
begin
  if not public.has_permission(target, 'studio.brand') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if (s ? 'stamp_asset_id') and (s ->> 'stamp_asset_id') is not null
     and not exists (select 1 from public.studio_assets a where a.id = (s ->> 'stamp_asset_id')::uuid and a.company_id = target) then
    raise exception 'STUDIO_ASSET_INVALID' using errcode = 'P0001';
  end if;
  insert into public.studio_brand as b (company_id, heading_font, body_font, accent_color, text_color, header_text, footer_text, show_logo, show_page_numbers,
    watermark_text, watermark_opacity, stamp_asset_id, signature_name, signature_title, page, number_formats, updated_by)
  values (target, coalesce(s ->> 'heading_font', 'sans'), coalesce(s ->> 'body_font', 'sans'), nullif(s ->> 'accent_color', ''), coalesce(nullif(s ->> 'text_color', ''), '#111827'),
    nullif(btrim(coalesce(s ->> 'header_text', '')), ''), nullif(btrim(coalesce(s ->> 'footer_text', '')), ''), coalesce((s ->> 'show_logo')::boolean, true),
    coalesce((s ->> 'show_page_numbers')::boolean, true), nullif(btrim(coalesce(s ->> 'watermark_text', '')), ''), coalesce((s ->> 'watermark_opacity')::int, 8),
    (s ->> 'stamp_asset_id')::uuid, nullif(btrim(coalesce(s ->> 'signature_name', '')), ''), nullif(btrim(coalesce(s ->> 'signature_title', '')), ''),
    coalesce(s -> 'page', '{}'::jsonb), coalesce(s -> 'number_formats', '{}'::jsonb), (select auth.uid()))
  on conflict (company_id) do update set heading_font = excluded.heading_font, body_font = excluded.body_font, accent_color = excluded.accent_color, text_color = excluded.text_color,
    header_text = excluded.header_text, footer_text = excluded.footer_text, show_logo = excluded.show_logo, show_page_numbers = excluded.show_page_numbers,
    watermark_text = excluded.watermark_text, watermark_opacity = excluded.watermark_opacity, stamp_asset_id = excluded.stamp_asset_id,
    signature_name = excluded.signature_name, signature_title = excluded.signature_title, page = excluded.page, number_formats = excluded.number_formats,
    updated_by = excluded.updated_by, updated_at = now();
  perform public.studio_log(target, null, 'brand', target::text, 'brand_updated', s - 'number_formats');
end $$;

-- Registers an image the app validated and uploaded to Studio-assets.
create or replace function public.studio_register_asset(target uuid, path text, name text, mime text, bytes integer, w integer, h integer, digest text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare nid uuid := gen_random_uuid();
begin
  if not public.has_permission(target, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if split_part(path, '/', 1) <> target::text or path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg)$' then raise exception 'STUDIO_ASSET_INVALID' using errcode = 'P0001', hint = 'path'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'Studio-assets' and o.name = path) then raise exception 'STUDIO_ASSET_INVALID' using errcode = 'P0001', hint = 'missing'; end if;
  insert into public.studio_assets (id, company_id, storage_path, file_name, mime_type, size_bytes, width, height, sha256, created_by)
  values (nid, target, path, left(btrim(name), 160), mime, bytes, w, h, digest, (select auth.uid()));
  perform public.studio_log(target, null, 'asset', nid::text, 'asset_uploaded', jsonb_build_object('name', name, 'bytes', bytes, 'mime', mime));
  return nid;
end $$;

-- ------------------------------------------------------------- storage (private)
do $$
declare b record;
begin
  select * into b from storage.buckets where id = 'Studio-assets';
  if not found then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('Studio-assets', 'Studio-assets', false, 2097152, array['image/png', 'image/jpeg']);
  elsif b.public then
    raise exception 'BA0028: bucket Studio-assets exists but is PUBLIC; make it private first';
  else
    update storage.buckets set file_size_limit = 2097152, allowed_mime_types = array['image/png', 'image/jpeg'] where id = 'Studio-assets';
  end if;
end $$;
drop policy if exists ba_studio_assets_select on storage.objects;
drop policy if exists ba_studio_assets_insert on storage.objects;
create policy ba_studio_assets_select on storage.objects for select to authenticated
  using (bucket_id = 'Studio-assets' and public.has_permission(public.storage_company_id(name), 'studio.view'));
create policy ba_studio_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'Studio-assets' and public.has_permission(public.storage_company_id(name), 'studio.edit')
              and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg)$');

-- ------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['studio_guard()', 'studio_check_refs()', 'studio_log(uuid, uuid, text, text, text, jsonb)', 'studio_doc_for(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['studio_valid_content(jsonb)', 'studio_valid_page(jsonb)', 'studio_check_ref_access(uuid, uuid, uuid, uuid, uuid)',
    'studio_save_document(uuid, uuid, text, text, text, jsonb, jsonb, uuid, uuid, uuid, uuid, uuid, text, integer, text)', 'studio_duplicate(uuid, text)',
    'studio_restore_version(uuid, integer, integer)', 'studio_data(uuid)', 'studio_finalize(uuid, integer, jsonb)', 'studio_archive(uuid, text)',
    'studio_record(uuid, text, jsonb)', 'studio_save_template(uuid, uuid, text, text, text, text, jsonb, jsonb)', 'studio_archive_template(uuid)',
    'studio_save_brand(uuid, jsonb)', 'studio_register_asset(uuid, text, text, text, integer, integer, integer, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.studio_guard() to authenticated;
grant execute on function public.studio_check_refs() to authenticated;

do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in ('ba_studio_guard', 'ba_studio_refs', 'ba_studio_append_only')) <> 4 then
    raise exception 'BA0028 self-check failed: triggers missing';
  end if;
  if has_table_privilege('authenticated', 'public.studio_documents', 'INSERT') or has_table_privilege('authenticated', 'public.studio_documents', 'UPDATE')
     or has_table_privilege('authenticated', 'public.studio_counters', 'SELECT') or has_table_privilege('anon', 'public.studio_documents', 'SELECT') then
    raise exception 'BA0028 self-check failed: privileges';
  end if;
  if (select public from storage.buckets where id = 'Studio-assets') is distinct from false then
    raise exception 'BA0028 self-check failed: Studio-assets must be private';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key in ('studio.issue', 'studio.templates', 'studio.brand')) then
    raise exception 'BA0028 self-check failed: role matrix';
  end if;
end $$;

commit;
