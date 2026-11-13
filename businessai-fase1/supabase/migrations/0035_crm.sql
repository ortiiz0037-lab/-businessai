-- =====================================================================
-- BusinessAI · Migration 0035 · CRM: contacts, tags, pipeline,
-- opportunities, activities, branches (preparation), quote → invoice
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0019, 0023, 0025 and 0030.
--
-- Builds on what exists, without parallel data:
--   * people: public.clients (0002 / 0019) is the ONE table of clients and
--     prospects. New columns: kind (individual / company), legal_name,
--     tax_id, lifecycle (lead / prospect / customer / former), source,
--     owner_id (responsible member), branch_id. Archive stays as in 0019
--     (archived clients keep every document, payment and entry).
--   * documents: quotes and invoices stay in public.documents (numbering,
--     lifecycle, ledger triggers of 0015 / 0023 / 0025). The CRM only LINKS
--     documents to opportunities and converts an ACCEPTED quote into a DRAFT
--     invoice through a normal insert (numbering, plan limits, archived
--     client check apply). Nothing is posted until the invoice is sent by
--     the existing flow. One live invoice per quote (row lock + check).
--   * money: balances, aging and payments are READ from receivables
--     (ar_invoice_balances / ar_aging); the CRM keeps no balance and never
--     writes the ledger. Opportunity values are integer cents.
--   * branches: there was no branches table (0017 only counts one). This
--     adds the minimal model the CRM needs: branches (plan limit
--     'branches'), branch members, clients shared with branches and an
--     opt-in scoping setting. Default: no scoping (behaviour unchanged).
--   * assistant: proposals 'crm_note' / 'crm_task' (confirmed by the user,
--     like studio drafts); reads go through RLS.
-- Security: RLS on every new table; writes ONLY through SECURITY DEFINER
-- functions that check has_permission in the record's company; members see
-- their own opportunities (crm.view_all: owner, admin); audit in crm_events.
-- Rollback: supabase/rollback/0035_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$ begin
  if to_regclass('public.client_events') is null or to_regclass('public.journal_entries') is null
     or to_regclass('public.payment_promises') is null or to_regprocedure('public.assistant_propose(uuid, text, text, jsonb)') is null then
    raise exception 'BA0035: migrations 0019, 0023, 0025 and 0030 must be applied first';
  end if;
end $$;

-- ===================================================================== permissions
insert into public.permissions (key, module, description_es, description_en) values
  ('crm.view', 'crm', 'Ver el CRM: oportunidades, actividades y pipeline', 'View the CRM: opportunities, activities and pipeline'),
  ('crm.manage', 'crm', 'Crear y editar oportunidades, actividades, contactos y etiquetas de clientes', 'Create and edit opportunities, activities, contacts and client tags'),
  ('crm.view_all', 'crm', 'Ver todas las oportunidades y actividades (no solo las propias)', 'View every opportunity and activity (not only one''s own)'),
  ('crm.configure', 'crm', 'Configurar el pipeline, las etiquetas y la visibilidad por sucursal', 'Configure the pipeline, tags and branch visibility'),
  ('branches.manage', 'branches', 'Crear, archivar y asignar sucursales', 'Create, archive and assign branches')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'crm.view'), ('admin', 'crm.view'), ('member', 'crm.view'),
  ('owner', 'crm.manage'), ('admin', 'crm.manage'), ('member', 'crm.manage'),
  ('owner', 'crm.view_all'), ('admin', 'crm.view_all'),
  ('owner', 'crm.configure'), ('admin', 'crm.configure'),
  ('owner', 'branches.manage'), ('admin', 'branches.manage')
on conflict do nothing;

-- ===================================================================== branches (minimal model)
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  code text not null check (code ~ '^[A-Z0-9_-]{1,12}$'),
  address text check (address is null or char_length(address) <= 240),
  archived_at timestamptz,
  archived_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, code),
  unique (company_id, id)
);
create table if not exists public.branch_members (
  company_id uuid not null,
  branch_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (branch_id, user_id),
  foreign key (company_id, branch_id) references public.branches (company_id, id) on delete cascade
);
create index if not exists branch_members_user_idx on public.branch_members (company_id, user_id);

-- ===================================================================== settings
create table if not exists public.crm_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  -- opt-in: members assigned to branches only see their branches' records
  branch_scoping boolean not null default false,
  -- with scoping: clients of another branch stay readable (shared) unless this is off
  share_clients_across_branches boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- ===================================================================== clients: CRM columns
alter table public.clients add column if not exists kind text not null default 'individual';
alter table public.clients add column if not exists legal_name text;
alter table public.clients add column if not exists tax_id text;
alter table public.clients add column if not exists lifecycle text not null default 'customer';
alter table public.clients add column if not exists source text;
alter table public.clients add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.clients add column if not exists branch_id uuid references public.branches(id) on delete restrict;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'clients_crm_check' and conrelid = 'public.clients'::regclass) then
    alter table public.clients add constraint clients_crm_check check (
      kind in ('individual', 'company') and lifecycle in ('lead', 'prospect', 'customer', 'former')
      and (legal_name is null or char_length(legal_name) <= 200) and (tax_id is null or char_length(tax_id) <= 40)
      and (source is null or char_length(source) <= 80));
  end if;
end $$;
create index if not exists clients_crm_email_idx on public.clients (company_id, lower(btrim(email))) where email is not null;
create index if not exists clients_crm_phone_idx on public.clients (company_id, regexp_replace(phone, '\D', '', 'g')) where phone is not null;
create index if not exists clients_crm_tax_idx on public.clients (company_id, upper(regexp_replace(tax_id, '[^0-9A-Za-z]', '', 'g'))) where tax_id is not null;
create index if not exists clients_crm_owner_idx on public.clients (company_id, owner_id) where owner_id is not null;
create index if not exists clients_crm_lifecycle_idx on public.clients (company_id, lifecycle);

-- clients shared with additional branches
create table if not exists public.crm_client_branches (
  company_id uuid not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  branch_id uuid not null,
  shared_by uuid,
  shared_at timestamptz not null default now(),
  primary key (client_id, branch_id),
  foreign key (company_id, branch_id) references public.branches (company_id, id) on delete cascade
);

-- ===================================================================== contacts and tags
create table if not exists public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  first_name text not null check (char_length(btrim(first_name)) between 1 and 80),
  last_name text check (last_name is null or char_length(last_name) <= 80),
  title text check (title is null or char_length(title) <= 80),
  email text check (email is null or (char_length(email) <= 160 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  phone text check (phone is null or char_length(phone) <= 40),
  is_primary boolean not null default false,
  notes text check (notes is null or char_length(notes) <= 1000),
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_contacts_client_idx on public.crm_contacts (client_id);
create unique index if not exists crm_contacts_primary_idx on public.crm_contacts (client_id) where is_primary and archived_at is null;

create table if not exists public.crm_tags (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  color text not null default 'blue' check (color in ('blue', 'silver', 'green', 'amber', 'red', 'violet')),
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index if not exists crm_tags_name_idx on public.crm_tags (company_id, lower(btrim(name)));
create table if not exists public.crm_client_tags (
  company_id uuid not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  tag_id uuid not null,
  tagged_by uuid,
  tagged_at timestamptz not null default now(),
  primary key (client_id, tag_id),
  foreign key (company_id, tag_id) references public.crm_tags (company_id, id) on delete cascade
);
create index if not exists crm_client_tags_tag_idx on public.crm_client_tags (tag_id);

-- ===================================================================== pipeline
create table if not exists public.crm_pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{1,32}$'),
  name_es text not null check (char_length(btrim(name_es)) between 1 and 40),
  name_en text not null check (char_length(btrim(name_en)) between 1 and 40),
  position integer not null check (position between 0 and 1000),
  probability_bp integer not null check (probability_bp between 0 and 10000),
  outcome text not null check (outcome in ('open', 'won', 'lost')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, key),
  unique (company_id, id),
  check ((outcome = 'won' and probability_bp = 10000) or (outcome = 'lost' and probability_bp = 0) or outcome = 'open')
);

create table if not exists public.crm_opportunities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  contact_id uuid references public.crm_contacts(id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text check (description is null or char_length(description) <= 4000),
  amount_cents bigint not null default 0 check (amount_cents between 0 and 100000000000),
  probability_bp integer not null check (probability_bp between 0 and 10000),
  probability_manual boolean not null default false,
  expected_close date,
  owner_id uuid references auth.users(id) on delete set null,
  source text check (source is null or char_length(source) <= 80),
  stage_id uuid not null,
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  lost_reason text check (lost_reason is null or char_length(lost_reason) between 3 and 300),
  closed_at timestamptz,
  branch_id uuid,
  archived_at timestamptz,
  version integer not null default 1,
  idempotency_key uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, stage_id) references public.crm_pipeline_stages (company_id, id),
  foreign key (company_id, branch_id) references public.branches (company_id, id),
  check ((status = 'lost') = (lost_reason is not null)),
  check ((status = 'open') = (closed_at is null))
);
create unique index if not exists crm_opportunities_idem_idx on public.crm_opportunities (company_id, idempotency_key) where idempotency_key is not null;
create index if not exists crm_opportunities_stage_idx on public.crm_opportunities (company_id, stage_id) where archived_at is null;
create index if not exists crm_opportunities_client_idx on public.crm_opportunities (client_id);
create index if not exists crm_opportunities_owner_idx on public.crm_opportunities (company_id, owner_id);

create table if not exists public.crm_opportunity_documents (
  company_id uuid not null,
  opportunity_id uuid not null references public.crm_opportunities(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete restrict,
  linked_by uuid,
  linked_at timestamptz not null default now(),
  primary key (opportunity_id, document_id)
);
create index if not exists crm_opportunity_documents_doc_idx on public.crm_opportunity_documents (document_id);

-- One record per quote converted: the live invoice it produced.
create table if not exists public.crm_quote_conversions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  quote_id uuid not null references public.documents(id) on delete restrict,
  invoice_id uuid not null references public.documents(id) on delete restrict,
  opportunity_id uuid references public.crm_opportunities(id) on delete set null,
  idempotency_key uuid not null,
  converted_by uuid,
  converted_at timestamptz not null default now(),
  unique (company_id, idempotency_key),
  unique (invoice_id)
);
create index if not exists crm_quote_conversions_quote_idx on public.crm_quote_conversions (quote_id);

-- ===================================================================== activities
create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('call', 'email', 'meeting', 'task', 'note', 'reminder')),
  subject text not null check (char_length(btrim(subject)) between 1 and 160),
  body text check (body is null or char_length(body) <= 4000),
  direction text check (direction is null or direction in ('inbound', 'outbound')),
  client_id uuid references public.clients(id) on delete restrict,
  contact_id uuid references public.crm_contacts(id) on delete set null,
  opportunity_id uuid references public.crm_opportunities(id) on delete restrict,
  due_at timestamptz,
  assigned_to uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  outcome text check (outcome is null or char_length(outcome) <= 1000),
  completed_at timestamptz,
  completed_by uuid,
  origin text not null default 'user' check (origin in ('user', 'assistant')),
  version integer not null default 1,
  idempotency_key uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (client_id is not null or opportunity_id is not null),
  check (kind not in ('task', 'reminder') or due_at is not null),
  check ((status = 'completed') = (completed_at is not null)),
  check (direction is null or kind in ('call', 'email'))
);
create unique index if not exists crm_activities_idem_idx on public.crm_activities (company_id, idempotency_key) where idempotency_key is not null;
create index if not exists crm_activities_due_idx on public.crm_activities (company_id, status, due_at);
create index if not exists crm_activities_client_idx on public.crm_activities (client_id, created_at desc);
create index if not exists crm_activities_opp_idx on public.crm_activities (opportunity_id, created_at desc);
create index if not exists crm_activities_assigned_idx on public.crm_activities (company_id, assigned_to, status);

-- ===================================================================== audit
create table if not exists public.crm_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  entity text not null check (entity in ('client', 'contact', 'tag', 'client_tag', 'stage', 'opportunity', 'activity', 'document_link', 'conversion', 'branch', 'branch_member', 'settings')),
  entity_id text not null,
  client_id uuid,
  opportunity_id uuid,
  action text not null check (char_length(action) between 1 and 40),
  changes jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists crm_events_client_idx on public.crm_events (client_id, id desc) where client_id is not null;
create index if not exists crm_events_opp_idx on public.crm_events (opportunity_id, id desc) where opportunity_id is not null;
create index if not exists crm_events_company_idx on public.crm_events (company_id, id desc);

-- ===================================================================== helpers
create or replace function public.crm_log(target uuid, ent text, ent_id text, client uuid, opp uuid, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.crm_events (company_id, entity, entity_id, client_id, opportunity_id, action, changes, actor)
  values (target, ent, ent_id, client, opp, act, coalesce(info, '{}'::jsonb), (select auth.uid()));
$$;

-- old → new of the fields that changed (values cut to 300 characters)
create or replace function public.crm_diff(o jsonb, n jsonb, skip text[])
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k.key, jsonb_build_object('from', left(o ->> k.key, 300), 'to', left(n ->> k.key, 300))), '{}'::jsonb)
  from jsonb_each(n) k
  where not (k.key = any (skip)) and (o -> k.key) is distinct from k.value
$$;

create or replace function public.crm_is_member(target uuid, who uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.company_id = target and m.user_id = who and m.status = 'active')
$$;

-- Is the caller limited to some branches in this company? (opt-in scoping)
create or replace function public.crm_scoped(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.branch_scoping from public.crm_settings s where s.company_id = target), false)
     and not public.has_permission(target, 'crm.view_all')
     and exists (select 1 from public.branch_members bm where bm.company_id = target and bm.user_id = (select auth.uid()))
$$;

create or replace function public.crm_in_my_branch(target uuid, branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.branch_members bm where bm.company_id = target and bm.branch_id = branch and bm.user_id = (select auth.uid()))
$$;

-- Client visibility under branch scoping: unassigned clients are shared;
-- otherwise the caller's branches, clients explicitly shared with them, or
-- every branch when the company shares clients across branches.
create or replace function public.crm_client_visible(target uuid, client uuid, branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select branch is null
      or not public.crm_scoped(target)
      or coalesce((select s.share_clients_across_branches from public.crm_settings s where s.company_id = target), true)
      or public.crm_in_my_branch(target, branch)
      or exists (select 1 from public.crm_client_branches cb join public.branch_members bm on bm.branch_id = cb.branch_id and bm.user_id = (select auth.uid())
                 where cb.client_id = client)
$$;

-- Opportunity visibility: crm.view, and (crm.view_all or own / created),
-- and the branch scope.
create or replace function public.crm_opp_visible(opp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.crm_opportunities o
    where o.id = opp and public.has_permission(o.company_id, 'crm.view')
      and (public.has_permission(o.company_id, 'crm.view_all') or o.owner_id = (select auth.uid()) or o.created_by = (select auth.uid()))
      and (o.branch_id is null or not public.crm_scoped(o.company_id) or public.crm_in_my_branch(o.company_id, o.branch_id)))
$$;

create or replace function public.crm_client_ok(target uuid, client uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.clients c where c.id = client and c.company_id = target
                   and public.has_permission(target, 'clients.view') and public.crm_client_visible(target, c.id, c.branch_id))
$$;

create or replace function public.crm_require(target uuid, perm text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if target is null or not public.has_permission(target, perm) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
end $$;

-- Default pipeline (configurable afterwards): keys, names and probabilities.
create or replace function public.crm_ensure_setup(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.crm_require(target, 'crm.view');
  insert into public.crm_settings (company_id) values (target) on conflict do nothing;
  if not exists (select 1 from public.crm_pipeline_stages s where s.company_id = target) then
    insert into public.crm_pipeline_stages (company_id, key, name_es, name_en, position, probability_bp, outcome) values
      (target, 'new', 'Nuevo prospecto', 'New lead', 10, 1000, 'open'),
      (target, 'contacted', 'Contactado', 'Contacted', 20, 2000, 'open'),
      (target, 'qualified', 'Calificado', 'Qualified', 30, 4000, 'open'),
      (target, 'proposal', 'Propuesta enviada', 'Proposal sent', 40, 6000, 'open'),
      (target, 'negotiation', 'Negociación', 'Negotiation', 50, 8000, 'open'),
      (target, 'won', 'Ganado', 'Won', 90, 10000, 'won'),
      (target, 'lost', 'Perdido', 'Lost', 100, 0, 'lost')
    on conflict (company_id, key) do nothing;
  end if;
end $$;

-- ===================================================================== RLS
alter table public.branches enable row level security;
alter table public.branch_members enable row level security;
alter table public.crm_settings enable row level security;
alter table public.crm_client_branches enable row level security;
alter table public.crm_contacts enable row level security;
alter table public.crm_tags enable row level security;
alter table public.crm_client_tags enable row level security;
alter table public.crm_pipeline_stages enable row level security;
alter table public.crm_opportunities enable row level security;
alter table public.crm_opportunity_documents enable row level security;
alter table public.crm_quote_conversions enable row level security;
alter table public.crm_activities enable row level security;
alter table public.crm_events enable row level security;

do $$ declare t text; begin
  foreach t in array array['branches', 'branch_members', 'crm_settings', 'crm_client_branches', 'crm_contacts', 'crm_tags', 'crm_client_tags',
                           'crm_pipeline_stages', 'crm_opportunities', 'crm_opportunity_documents', 'crm_quote_conversions', 'crm_activities', 'crm_events'] loop
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

drop policy if exists ba_branches_select on public.branches;
create policy ba_branches_select on public.branches for select to authenticated using (public.is_company_member(company_id));
drop policy if exists ba_branch_members_select on public.branch_members;
create policy ba_branch_members_select on public.branch_members for select to authenticated
  using (user_id = (select auth.uid()) or public.has_permission(company_id, 'branches.manage'));
drop policy if exists ba_crm_settings_select on public.crm_settings;
create policy ba_crm_settings_select on public.crm_settings for select to authenticated using (public.has_permission(company_id, 'crm.view'));
drop policy if exists ba_crm_client_branches_select on public.crm_client_branches;
create policy ba_crm_client_branches_select on public.crm_client_branches for select to authenticated using (public.crm_client_ok(company_id, client_id));
drop policy if exists ba_crm_contacts_select on public.crm_contacts;
create policy ba_crm_contacts_select on public.crm_contacts for select to authenticated using (public.crm_client_ok(company_id, client_id));
drop policy if exists ba_crm_tags_select on public.crm_tags;
create policy ba_crm_tags_select on public.crm_tags for select to authenticated using (public.has_permission(company_id, 'clients.view'));
drop policy if exists ba_crm_client_tags_select on public.crm_client_tags;
create policy ba_crm_client_tags_select on public.crm_client_tags for select to authenticated using (public.crm_client_ok(company_id, client_id));
drop policy if exists ba_crm_stages_select on public.crm_pipeline_stages;
create policy ba_crm_stages_select on public.crm_pipeline_stages for select to authenticated using (public.has_permission(company_id, 'crm.view'));
drop policy if exists ba_crm_opportunities_select on public.crm_opportunities;
create policy ba_crm_opportunities_select on public.crm_opportunities for select to authenticated
  using (public.has_permission(company_id, 'crm.view')
         and (public.has_permission(company_id, 'crm.view_all') or owner_id = (select auth.uid()) or created_by = (select auth.uid()))
         and (branch_id is null or not public.crm_scoped(company_id) or public.crm_in_my_branch(company_id, branch_id)));
drop policy if exists ba_crm_opp_docs_select on public.crm_opportunity_documents;
create policy ba_crm_opp_docs_select on public.crm_opportunity_documents for select to authenticated
  using (public.crm_opp_visible(opportunity_id) and public.has_permission(company_id, 'documents.view'));
drop policy if exists ba_crm_conversions_select on public.crm_quote_conversions;
create policy ba_crm_conversions_select on public.crm_quote_conversions for select to authenticated using (public.has_permission(company_id, 'documents.view'));
-- activities: own / assigned; else with an opportunity → its visibility; else (client only) → the client's
drop policy if exists ba_crm_activities_select on public.crm_activities;
create policy ba_crm_activities_select on public.crm_activities for select to authenticated
  using (public.has_permission(company_id, 'crm.view')
         and (assigned_to = (select auth.uid()) or created_by = (select auth.uid())
              or (opportunity_id is not null and public.crm_opp_visible(opportunity_id))
              or (opportunity_id is null and public.crm_client_ok(company_id, client_id))));
drop policy if exists ba_crm_events_select on public.crm_events;
create policy ba_crm_events_select on public.crm_events for select to authenticated
  using (public.has_permission(company_id, 'crm.view')
         and (public.has_permission(company_id, 'crm.view_all')
              or (opportunity_id is not null and public.crm_opp_visible(opportunity_id))
              or (opportunity_id is null and client_id is not null and public.crm_client_ok(company_id, client_id))));

-- clients: same permission as 0014a, plus the opt-in branch scope
drop policy if exists ba_clients_select on public.clients;
create policy ba_clients_select on public.clients for select to authenticated
  using (public.has_permission(company_id, 'clients.view') and public.crm_client_visible(company_id, id, branch_id));

-- ===================================================================== clients: validation and value history
create or replace function public.crm_client_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.owner_id is not distinct from old.owner_id and new.branch_id is not distinct from old.branch_id then
    return new;
  end if;
  if new.owner_id is not null and not public.crm_is_member(new.company_id, new.owner_id) then
    raise exception 'CRM_OWNER_INVALID' using errcode = 'P0001';
  end if;
  if new.branch_id is not null and not exists (select 1 from public.branches b where b.id = new.branch_id and b.company_id = new.company_id and b.archived_at is null) then
    raise exception 'CRM_BRANCH_INVALID' using errcode = 'P0001';
  end if;
  if new.branch_id is not null and (select auth.uid()) is not null and public.crm_scoped(new.company_id) and not public.crm_in_my_branch(new.company_id, new.branch_id) then
    raise exception 'CRM_BRANCH_INVALID' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_crm_client_guard on public.clients;
create trigger ba_crm_client_guard before insert or update on public.clients for each row execute function public.crm_client_guard();

create or replace function public.crm_client_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare d jsonb;
begin
  d := public.crm_diff(to_jsonb(old), to_jsonb(new), array['updated_at', 'created_at', 'id', 'company_id']);
  if d <> '{}'::jsonb then
    insert into public.crm_events (company_id, entity, entity_id, client_id, action, changes, actor)
    values (new.company_id, 'client', new.id::text, new.id, 'updated', d, (select auth.uid()));
  end if;
  return null;
end $$;
drop trigger if exists ba_crm_client_audit on public.clients;
create trigger ba_crm_client_audit after update on public.clients for each row execute function public.crm_client_audit();

-- ===================================================================== write functions
-- Duplicate candidates among the clients the caller can see (RLS: security invoker).
create or replace function public.crm_find_duplicates(target uuid, p_name text, p_email text, p_phone text, p_tax_id text, exclude uuid default null)
returns table (client_id uuid, name text, business_name text, archived boolean, reasons text[])
language sql stable security invoker set search_path = '' as $$
  with q as (select lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))) as n, lower(btrim(coalesce(p_email, ''))) as e,
                    regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as p, upper(regexp_replace(coalesce(p_tax_id, ''), '[^0-9A-Za-z]', '', 'g')) as t),
  m as (
    select c.id, c.name, c.business_name, c.archived_at is not null as archived,
           array_remove(array[
             case when q.e <> '' and lower(btrim(c.email)) = q.e then 'email' end,
             case when char_length(q.p) >= 7 and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = right(q.p, 10) then 'phone' end,
             case when q.t <> '' and upper(regexp_replace(coalesce(c.tax_id, ''), '[^0-9A-Za-z]', '', 'g')) = q.t then 'tax_id' end,
             case when q.n <> '' and (lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) = q.n
                                      or lower(btrim(regexp_replace(coalesce(c.business_name, ''), '\s+', ' ', 'g'))) = q.n
                                      or lower(btrim(regexp_replace(coalesce(c.legal_name, ''), '\s+', ' ', 'g'))) = q.n) then 'name' end], null) as reasons
    from public.clients c, q
    where c.company_id = target and (exclude is null or c.id <> exclude))
  select m.id, m.name, m.business_name, m.archived, m.reasons from m where cardinality(m.reasons) > 0
  order by cardinality(m.reasons) desc, m.name limit 10
$$;

create or replace function public.crm_save_contact(target uuid, contact uuid, client uuid, p_first text, p_last text, p_title text,
  p_email text, p_phone text, p_primary boolean, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare cid uuid := contact; c public.crm_contacts;
begin
  perform public.crm_require(target, 'crm.manage');
  if not public.crm_client_ok(target, client) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if contact is not null then
    select * into c from public.crm_contacts x where x.id = contact and x.company_id = target for update;
    if c.id is null or c.client_id <> client then raise exception 'CONTACT_NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  if coalesce(p_primary, false) then
    update public.crm_contacts set is_primary = false, updated_at = now() where client_id = client and is_primary and id is distinct from contact;
  end if;
  if contact is null then
    insert into public.crm_contacts (company_id, client_id, first_name, last_name, title, email, phone, is_primary, notes, created_by)
    values (target, client, btrim(p_first), nullif(btrim(p_last), ''), nullif(btrim(p_title), ''), nullif(lower(btrim(p_email)), ''), nullif(btrim(p_phone), ''),
            coalesce(p_primary, false), nullif(btrim(p_notes), ''), (select auth.uid()))
    returning id into cid;
    perform public.crm_log(target, 'contact', cid::text, client, null, 'created', jsonb_build_object('name', btrim(p_first) || coalesce(' ' || nullif(btrim(p_last), ''), '')));
  else
    update public.crm_contacts set first_name = btrim(p_first), last_name = nullif(btrim(p_last), ''), title = nullif(btrim(p_title), ''),
      email = nullif(lower(btrim(p_email)), ''), phone = nullif(btrim(p_phone), ''), is_primary = coalesce(p_primary, false), notes = nullif(btrim(p_notes), ''), updated_at = now()
    where id = contact;
    perform public.crm_log(target, 'contact', cid::text, client, null, 'updated',
      public.crm_diff(to_jsonb(c), (select to_jsonb(x) from public.crm_contacts x where x.id = contact), array['updated_at']));
  end if;
  return cid;
end $$;

create or replace function public.crm_set_contact_archived(contact uuid, archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.crm_contacts;
begin
  select * into c from public.crm_contacts x where x.id = contact for update;
  if c.id is null or not public.has_permission(c.company_id, 'crm.manage') or not public.crm_client_ok(c.company_id, c.client_id) then
    raise exception 'CONTACT_NOT_FOUND' using errcode = 'P0001';
  end if;
  update public.crm_contacts set archived_at = case when archived then coalesce(archived_at, now()) end,
    is_primary = case when archived then false else is_primary end, updated_at = now() where id = contact;
  perform public.crm_log(c.company_id, 'contact', contact::text, c.client_id, null, case when archived then 'archived' else 'restored' end, '{}');
end $$;

create or replace function public.crm_save_tag(target uuid, tag uuid, p_name text, p_color text, archived boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare tid uuid := tag;
begin
  perform public.crm_require(target, 'crm.configure');
  if exists (select 1 from public.crm_tags t where t.company_id = target and lower(btrim(t.name)) = lower(btrim(p_name)) and t.id is distinct from tag) then
    raise exception 'CRM_TAG_EXISTS' using errcode = 'P0001';
  end if;
  if tag is null then
    insert into public.crm_tags (company_id, name, color, created_by) values (target, btrim(p_name), coalesce(p_color, 'blue'), (select auth.uid())) returning id into tid;
  else
    update public.crm_tags set name = btrim(p_name), color = coalesce(p_color, color), archived_at = case when archived then coalesce(archived_at, now()) end
    where id = tag and company_id = target;
    if not found then raise exception 'CRM_TAG_NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform public.crm_log(target, 'tag', tid::text, null, null, case when tag is null then 'created' else 'updated' end, jsonb_build_object('name', btrim(p_name), 'archived', archived));
  return tid;
end $$;

-- Replace the tags of a client (active tags of the same company only).
create or replace function public.crm_set_client_tags(client uuid, tags uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare target uuid; before_tags uuid[]; n integer;
begin
  select c.company_id into target from public.clients c where c.id = client;
  if target is null or not public.has_permission(target, 'crm.manage') or not public.crm_client_ok(target, client) then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(coalesce(tags, '{}')) t(id) where not exists (select 1 from public.crm_tags x where x.id = t.id and x.company_id = target and x.archived_at is null)) then
    raise exception 'CRM_TAG_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform 1 from public.clients c where c.id = client for update;
  select coalesce(array_agg(tag_id order by tag_id), '{}') into before_tags from public.crm_client_tags where client_id = client;
  delete from public.crm_client_tags where client_id = client and not (tag_id = any (coalesce(tags, '{}')));
  insert into public.crm_client_tags (company_id, client_id, tag_id, tagged_by)
  select target, client, t, (select auth.uid()) from (select distinct unnest(coalesce(tags, '{}')) as t) x on conflict do nothing;
  select count(*) into n from public.crm_client_tags where client_id = client;
  if before_tags is distinct from (select coalesce(array_agg(tag_id order by tag_id), '{}') from public.crm_client_tags where client_id = client) then
    perform public.crm_log(target, 'client_tag', client::text, client, null, 'tags_set',
      jsonb_build_object('from', (select coalesce(jsonb_agg(t.name order by t.name), '[]') from public.crm_tags t where t.id = any (before_tags)),
                         'to', (select coalesce(jsonb_agg(t.name order by t.name), '[]') from public.crm_tags t join public.crm_client_tags ct on ct.tag_id = t.id where ct.client_id = client)));
  end if;
  return n;
end $$;

create or replace function public.crm_save_stage(target uuid, stage uuid, p_name_es text, p_name_en text, p_probability_bp integer, p_position integer, p_active boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.crm_pipeline_stages; sid uuid := stage; k text;
begin
  perform public.crm_require(target, 'crm.configure');
  perform public.crm_ensure_setup(target);
  if p_probability_bp is null or p_probability_bp not between 0 and 10000 then raise exception 'CRM_PROBABILITY_INVALID' using errcode = 'P0001'; end if;
  if stage is null then
    if (select count(*) from public.crm_pipeline_stages x where x.company_id = target) >= 20 then raise exception 'CRM_STAGE_LIMIT' using errcode = 'P0001'; end if;
    k := 'custom_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    insert into public.crm_pipeline_stages (company_id, key, name_es, name_en, position, probability_bp, outcome, active)
    values (target, k, btrim(p_name_es), btrim(p_name_en), coalesce(p_position, 60), p_probability_bp, 'open', coalesce(p_active, true)) returning id into sid;
    perform public.crm_log(target, 'stage', sid::text, null, null, 'created', jsonb_build_object('name', btrim(p_name_es), 'probability_bp', p_probability_bp));
    return sid;
  end if;
  select * into s from public.crm_pipeline_stages x where x.id = stage and x.company_id = target for update;
  if s.id is null then raise exception 'CRM_STAGE_NOT_FOUND' using errcode = 'P0001'; end if;
  if s.outcome <> 'open' and (p_probability_bp <> s.probability_bp or not coalesce(p_active, true)) then
    raise exception 'CRM_STAGE_FIXED' using errcode = 'P0001', detail = 'Won and lost keep 100 % / 0 % and stay active.';
  end if;
  if not coalesce(p_active, true) and exists (select 1 from public.crm_opportunities o where o.stage_id = stage and o.archived_at is null and o.status = 'open') then
    raise exception 'CRM_STAGE_IN_USE' using errcode = 'P0001';
  end if;
  update public.crm_pipeline_stages set name_es = btrim(p_name_es), name_en = btrim(p_name_en), probability_bp = p_probability_bp,
    position = coalesce(p_position, position), active = coalesce(p_active, true) where id = stage;
  perform public.crm_log(target, 'stage', sid::text, null, null, 'updated',
    public.crm_diff(to_jsonb(s), (select to_jsonb(x) from public.crm_pipeline_stages x where x.id = stage), array[]::text[]));
  return sid;
end $$;

create or replace function public.crm_save_settings(target uuid, p_branch_scoping boolean, p_share_clients boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.crm_settings;
begin
  perform public.crm_require(target, 'crm.configure');
  perform public.crm_ensure_setup(target);
  select * into o from public.crm_settings s where s.company_id = target for update;
  update public.crm_settings set branch_scoping = coalesce(p_branch_scoping, false), share_clients_across_branches = coalesce(p_share_clients, true),
    updated_by = (select auth.uid()), updated_at = now() where company_id = target;
  perform public.crm_log(target, 'settings', target::text, null, null, 'updated',
    public.crm_diff(to_jsonb(o), (select to_jsonb(s) from public.crm_settings s where s.company_id = target), array['updated_at', 'updated_by']));
end $$;

-- ------------------------------------------------------------- branches
create or replace function public.crm_save_branch(target uuid, branch uuid, p_name text, p_code text, p_address text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare bid uuid := branch; o public.branches;
begin
  perform public.crm_require(target, 'branches.manage');
  if upper(btrim(coalesce(p_code, ''))) !~ '^[A-Z0-9_-]{1,12}$' then raise exception 'BRANCH_CODE_INVALID' using errcode = 'P0001'; end if;
  if exists (select 1 from public.branches b where b.company_id = target and b.code = upper(btrim(p_code)) and b.id is distinct from branch) then
    raise exception 'BRANCH_CODE_EXISTS' using errcode = 'P0001';
  end if;
  if branch is null then
    perform public.assert_feature_available(target, 'branches');
    insert into public.branches (company_id, name, code, address, created_by)
    values (target, btrim(p_name), upper(btrim(p_code)), nullif(btrim(p_address), ''), (select auth.uid())) returning id into bid;
    perform public.crm_log(target, 'branch', bid::text, null, null, 'created', jsonb_build_object('name', btrim(p_name), 'code', upper(btrim(p_code))));
  else
    select * into o from public.branches b where b.id = branch and b.company_id = target for update;
    if o.id is null then raise exception 'BRANCH_NOT_FOUND' using errcode = 'P0001'; end if;
    update public.branches set name = btrim(p_name), code = upper(btrim(p_code)), address = nullif(btrim(p_address), '') where id = branch;
    perform public.crm_log(target, 'branch', bid::text, null, null, 'updated',
      public.crm_diff(to_jsonb(o), (select to_jsonb(b) from public.branches b where b.id = branch), array[]::text[]));
  end if;
  return bid;
end $$;

create or replace function public.crm_set_branch_archived(branch uuid, archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.branches;
begin
  select * into b from public.branches x where x.id = branch for update;
  if b.id is null or not public.has_permission(b.company_id, 'branches.manage') then raise exception 'BRANCH_NOT_FOUND' using errcode = 'P0001'; end if;
  if not archived and b.archived_at is not null then perform public.assert_feature_available(b.company_id, 'branches'); end if;
  update public.branches set archived_at = case when archived then coalesce(archived_at, now()) end,
    archived_by = case when archived then (select auth.uid()) end where id = branch;
  perform public.crm_log(b.company_id, 'branch', branch::text, null, null, case when archived then 'archived' else 'restored' end, '{}');
end $$;

create or replace function public.crm_set_branch_member(branch uuid, member uuid, assigned boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.branches;
begin
  select * into b from public.branches x where x.id = branch;
  if b.id is null or not public.has_permission(b.company_id, 'branches.manage') then raise exception 'BRANCH_NOT_FOUND' using errcode = 'P0001'; end if;
  if assigned then
    if b.archived_at is not null then raise exception 'CRM_BRANCH_INVALID' using errcode = 'P0001'; end if;
    if not public.crm_is_member(b.company_id, member) then raise exception 'CRM_OWNER_INVALID' using errcode = 'P0001'; end if;
    insert into public.branch_members (company_id, branch_id, user_id, added_by) values (b.company_id, branch, member, (select auth.uid())) on conflict do nothing;
  else
    delete from public.branch_members where branch_id = branch and user_id = member;
  end if;
  if found then
    perform public.crm_log(b.company_id, 'branch_member', branch::text, null, null, case when assigned then 'assigned' else 'unassigned' end, jsonb_build_object('user_id', member));
  end if;
end $$;

create or replace function public.crm_share_client(client uuid, branch uuid, shared boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  select c.company_id into target from public.clients c where c.id = client;
  if target is null or not public.has_permission(target, 'crm.configure') then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.branches b where b.id = branch and b.company_id = target and b.archived_at is null) then
    raise exception 'CRM_BRANCH_INVALID' using errcode = 'P0001';
  end if;
  if shared then
    insert into public.crm_client_branches (company_id, client_id, branch_id, shared_by) values (target, client, branch, (select auth.uid())) on conflict do nothing;
  else
    delete from public.crm_client_branches where client_id = client and branch_id = branch;
  end if;
  if found then perform public.crm_log(target, 'client', client::text, client, null, case when shared then 'shared_with_branch' else 'unshared_from_branch' end, jsonb_build_object('branch_id', branch)); end if;
end $$;

-- ------------------------------------------------------------- opportunities
create or replace function public.crm_save_opportunity(target uuid, opp uuid, client uuid, contact uuid, p_name text, p_description text,
  p_amount_cents bigint, p_probability_bp integer, p_expected_close date, owner uuid, p_source text, branch uuid, stage uuid,
  expected_version integer, idem uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare o public.crm_opportunities; s public.crm_pipeline_stages; oid uuid; manual boolean := p_probability_bp is not null;
begin
  perform public.crm_require(target, 'crm.manage');
  perform public.crm_ensure_setup(target);
  if not public.crm_client_ok(target, client) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if contact is not null and not exists (select 1 from public.crm_contacts c where c.id = contact and c.client_id = client and c.archived_at is null) then
    raise exception 'CONTACT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if owner is not null and not public.crm_is_member(target, owner) then raise exception 'CRM_OWNER_INVALID' using errcode = 'P0001'; end if;
  if branch is not null and not exists (select 1 from public.branches b where b.id = branch and b.company_id = target and b.archived_at is null) then
    raise exception 'CRM_BRANCH_INVALID' using errcode = 'P0001';
  end if;
  if branch is not null and public.crm_scoped(target) and not public.crm_in_my_branch(target, branch) then raise exception 'CRM_BRANCH_INVALID' using errcode = 'P0001'; end if;
  if p_amount_cents is null or p_amount_cents < 0 or p_amount_cents > 100000000000 then raise exception 'CRM_AMOUNT_INVALID' using errcode = 'P0001'; end if;
  if p_probability_bp is not null and p_probability_bp not between 0 and 10000 then raise exception 'CRM_PROBABILITY_INVALID' using errcode = 'P0001'; end if;
  if opp is null then
    if idem is null then raise exception 'CRM_IDEMPOTENCY_REQUIRED' using errcode = 'P0001'; end if;
    select x.id into oid from public.crm_opportunities x where x.company_id = target and x.idempotency_key = idem;
    if oid is not null then return oid; end if;                      -- the same submission again
    if exists (select 1 from public.clients c where c.id = client and c.archived_at is not null) then
      raise exception 'CLIENT_ARCHIVED' using errcode = 'P0001';    -- like documents (0019): history kept, nothing new
    end if;
    select * into s from public.crm_pipeline_stages x where x.company_id = target and x.active and x.outcome = 'open'
      and (x.id = stage or (stage is null and x.key = 'new')) order by x.position limit 1;
    if s.id is null then raise exception 'CRM_STAGE_NOT_FOUND' using errcode = 'P0001'; end if;
    begin
      insert into public.crm_opportunities (company_id, client_id, contact_id, name, description, amount_cents, probability_bp, probability_manual,
        expected_close, owner_id, source, stage_id, branch_id, idempotency_key, created_by)
      values (target, client, contact, btrim(p_name), nullif(btrim(p_description), ''), p_amount_cents, coalesce(p_probability_bp, s.probability_bp), manual,
        p_expected_close, coalesce(owner, (select auth.uid())), nullif(btrim(p_source), ''), s.id, branch, idem, (select auth.uid()))
      returning id into oid;
    exception when unique_violation then
      select x.id into oid from public.crm_opportunities x where x.company_id = target and x.idempotency_key = idem;
      if oid is null then raise; end if;
      return oid;
    end;
    -- a lead becomes a prospect once it has an opportunity
    update public.clients set lifecycle = 'prospect', updated_at = now() where id = client and lifecycle = 'lead';
    perform public.crm_log(target, 'opportunity', oid::text, client, oid, 'created',
      jsonb_build_object('name', btrim(p_name), 'amount_cents', p_amount_cents, 'stage', s.key));
    return oid;
  end if;
  select * into o from public.crm_opportunities x where x.id = opp and x.company_id = target for update;
  if o.id is null or not public.crm_opp_visible(opp) then raise exception 'CRM_OPPORTUNITY_NOT_FOUND' using errcode = 'P0001'; end if;
  if o.version is distinct from expected_version then raise exception 'CRM_STALE' using errcode = 'P0001'; end if;
  if o.status <> 'open' or o.archived_at is not null then raise exception 'CRM_OPPORTUNITY_CLOSED' using errcode = 'P0001'; end if;
  update public.crm_opportunities set client_id = client, contact_id = contact, name = btrim(p_name), description = nullif(btrim(p_description), ''),
    amount_cents = p_amount_cents,
    probability_bp = coalesce(p_probability_bp, (select st.probability_bp from public.crm_pipeline_stages st where st.id = o.stage_id)), probability_manual = manual,
    expected_close = p_expected_close, owner_id = owner, source = nullif(btrim(p_source), ''), branch_id = branch,
    version = version + 1, updated_at = now()
  where id = opp;
  perform public.crm_log(target, 'opportunity', opp::text, client, opp, 'updated',
    public.crm_diff(to_jsonb(o), (select to_jsonb(x) from public.crm_opportunities x where x.id = opp), array['updated_at', 'version']));
  return opp;
end $$;

-- Move to a stage. Lost needs a reason; won turns a lead / prospect into a customer.
create or replace function public.crm_move_opportunity(opp uuid, stage uuid, expected_version integer, reason text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare o public.crm_opportunities; s public.crm_pipeline_stages; from_key text;
begin
  select * into o from public.crm_opportunities x where x.id = opp for update;
  if o.id is null or not public.has_permission(o.company_id, 'crm.manage') or not public.crm_opp_visible(opp) then
    raise exception 'CRM_OPPORTUNITY_NOT_FOUND' using errcode = 'P0001';
  end if;
  if o.version is distinct from expected_version then raise exception 'CRM_STALE' using errcode = 'P0001'; end if;
  if o.archived_at is not null then raise exception 'CRM_OPPORTUNITY_CLOSED' using errcode = 'P0001'; end if;
  select * into s from public.crm_pipeline_stages x where x.id = stage and x.company_id = o.company_id and x.active;
  if s.id is null then raise exception 'CRM_STAGE_NOT_FOUND' using errcode = 'P0001'; end if;
  if s.id = o.stage_id then return o.version; end if;
  if s.outcome = 'lost' and char_length(btrim(coalesce(reason, ''))) not between 3 and 300 then raise exception 'CRM_LOST_REASON_REQUIRED' using errcode = 'P0001'; end if;
  select key into from_key from public.crm_pipeline_stages where id = o.stage_id;
  update public.crm_opportunities set stage_id = s.id, status = s.outcome,
    probability_bp = case when s.outcome <> 'open' or not o.probability_manual then s.probability_bp else o.probability_bp end,
    probability_manual = case when s.outcome <> 'open' then false else o.probability_manual end,
    lost_reason = case when s.outcome = 'lost' then btrim(reason) end,
    closed_at = case when s.outcome = 'open' then null else now() end,
    version = version + 1, updated_at = now()
  where id = opp;
  if s.outcome = 'won' then
    update public.clients set lifecycle = 'customer', updated_at = now() where id = o.client_id and lifecycle in ('lead', 'prospect');
  end if;
  perform public.crm_log(o.company_id, 'opportunity', opp::text, o.client_id, opp,
    case s.outcome when 'won' then 'won' when 'lost' then 'lost' else case when o.status <> 'open' then 'reopened' else 'stage_changed' end end,
    jsonb_build_object('from', from_key, 'to', s.key, 'reason', case when s.outcome = 'lost' then btrim(reason) end));
  return o.version + 1;
end $$;

create or replace function public.crm_set_opportunity_archived(opp uuid, archived boolean, expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare o public.crm_opportunities;
begin
  select * into o from public.crm_opportunities x where x.id = opp for update;
  if o.id is null or not public.has_permission(o.company_id, 'crm.manage') or not public.crm_opp_visible(opp) then
    raise exception 'CRM_OPPORTUNITY_NOT_FOUND' using errcode = 'P0001';
  end if;
  if o.version is distinct from expected_version then raise exception 'CRM_STALE' using errcode = 'P0001'; end if;
  update public.crm_opportunities set archived_at = case when archived then coalesce(archived_at, now()) end, version = version + 1, updated_at = now() where id = opp;
  perform public.crm_log(o.company_id, 'opportunity', opp::text, o.client_id, opp, case when archived then 'archived' else 'restored' end, '{}');
  return o.version + 1;
end $$;

-- Link (or unlink) an existing business document of the same client.
create or replace function public.crm_link_document(opp uuid, doc uuid, linked boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.crm_opportunities; d record;
begin
  select * into o from public.crm_opportunities x where x.id = opp;
  if o.id is null or not public.has_permission(o.company_id, 'crm.manage') or not public.crm_opp_visible(opp) then
    raise exception 'CRM_OPPORTUNITY_NOT_FOUND' using errcode = 'P0001';
  end if;
  select x.id, x.client_id, x.document_type, x.document_number into d from public.documents x where x.id = doc and x.company_id = o.company_id;
  if d.id is null or not public.has_permission(o.company_id, 'documents.view') then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if linked then
    if d.client_id is distinct from o.client_id then raise exception 'CRM_DOCUMENT_OTHER_CLIENT' using errcode = 'P0001'; end if;
    insert into public.crm_opportunity_documents (company_id, opportunity_id, document_id, linked_by) values (o.company_id, opp, doc, (select auth.uid())) on conflict do nothing;
  else
    delete from public.crm_opportunity_documents where opportunity_id = opp and document_id = doc;
  end if;
  if found then
    perform public.crm_log(o.company_id, 'document_link', doc::text, o.client_id, opp, case when linked then 'linked' else 'unlinked' end,
      jsonb_build_object('document_type', d.document_type, 'document_number', d.document_number));
  end if;
end $$;

-- Accepted quote → DRAFT invoice with the same lines, client and language.
-- A normal insert: numbering, plan limits and the archived-client check of
-- 0010 / 0015 / 0019 apply; the ledger posts only when the invoice is sent.
-- One live invoice per quote; the same request key returns the same invoice.
create or replace function public.crm_convert_quote(quote uuid, opp uuid, due date, idem uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare q record; inv uuid; existing uuid;
begin
  if idem is null then raise exception 'CRM_IDEMPOTENCY_REQUIRED' using errcode = 'P0001'; end if;
  select d.* into q from public.documents d where d.id = quote for update;      -- serialises conversions of this quote
  if q.id is null or not public.has_permission(q.company_id, 'documents.view') or not public.has_permission(q.company_id, 'documents.create') then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  select c.invoice_id into existing from public.crm_quote_conversions c where c.company_id = q.company_id and c.idempotency_key = idem;
  if existing is not null then return existing; end if;
  if q.document_type <> 'quote' then raise exception 'CRM_NOT_A_QUOTE' using errcode = 'P0001'; end if;
  if q.status <> 'accepted' then raise exception 'CRM_QUOTE_NOT_ACCEPTED' using errcode = 'P0001', hint = q.status; end if;
  if q.client_id is null then raise exception 'CRM_QUOTE_WITHOUT_CLIENT' using errcode = 'P0001'; end if;
  select c.invoice_id into existing from public.crm_quote_conversions c join public.documents d on d.id = c.invoice_id
   where c.quote_id = quote and d.status <> 'cancelled' limit 1;
  if existing is not null then raise exception 'CRM_QUOTE_ALREADY_CONVERTED' using errcode = 'P0001', hint = existing::text; end if;
  if due is null or due < public.ba_today() then raise exception 'CRM_DUE_DATE_INVALID' using errcode = 'P0001'; end if;
  if opp is not null and not exists (select 1 from public.crm_opportunities o where o.id = opp and o.company_id = q.company_id and o.client_id = q.client_id)
     then raise exception 'CRM_OPPORTUNITY_NOT_FOUND' using errcode = 'P0001'; end if;
  if opp is not null and not public.crm_opp_visible(opp) then raise exception 'CRM_OPPORTUNITY_NOT_FOUND' using errcode = 'P0001'; end if;
  insert into public.documents (company_id, client_id, created_by, document_type, status, title, issue_date, due_date, subtotal, tax, total,
                                notes, payment_info, items, metadata, language)
  values (q.company_id, q.client_id, (select auth.uid()), 'invoice', 'draft',
          left(case when q.language = 'en' then 'Invoice' else 'Factura' end || ' · ' || coalesce(q.document_number, '') || coalesce(' · ' || nullif(btrim(q.title), ''), ''), 200),
          public.ba_today(), due, q.subtotal, q.tax, q.total, q.notes, q.payment_info, q.items,
          jsonb_build_object('source_quote_id', q.id, 'source_quote_number', q.document_number) || case when opp is null then '{}'::jsonb else jsonb_build_object('crm_opportunity_id', opp) end,
          q.language)
  returning id into inv;
  insert into public.crm_quote_conversions (company_id, quote_id, invoice_id, opportunity_id, idempotency_key, converted_by)
  values (q.company_id, quote, inv, opp, idem, (select auth.uid()));
  if opp is not null then
    insert into public.crm_opportunity_documents (company_id, opportunity_id, document_id, linked_by) values
      (q.company_id, opp, quote, (select auth.uid())), (q.company_id, opp, inv, (select auth.uid())) on conflict do nothing;
  end if;
  perform public.crm_log(q.company_id, 'conversion', inv::text, q.client_id, opp, 'quote_converted',
    jsonb_build_object('quote', q.document_number, 'invoice', (select d.document_number from public.documents d where d.id = inv)));
  return inv;
end $$;

-- ------------------------------------------------------------- activities
create or replace function public.crm_save_activity(target uuid, act uuid, p_kind text, p_subject text, p_body text, p_direction text,
  client uuid, contact uuid, opp uuid, p_due_at timestamptz, assignee uuid, expected_version integer, idem uuid, p_origin text default 'user')
returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.crm_activities; aid uuid; cl uuid := client;
begin
  perform public.crm_require(target, 'crm.manage');
  if p_kind not in ('call', 'email', 'meeting', 'task', 'note', 'reminder') then raise exception 'CRM_ACTIVITY_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  if p_direction is not null and (p_direction not in ('inbound', 'outbound') or p_kind not in ('call', 'email')) then
    raise exception 'CRM_ACTIVITY_INVALID' using errcode = 'P0001', hint = 'direction';
  end if;
  if p_kind in ('task', 'reminder') and p_due_at is null then raise exception 'CRM_DUE_REQUIRED' using errcode = 'P0001'; end if;
  if opp is not null then
    if not exists (select 1 from public.crm_opportunities o where o.id = opp and o.company_id = target) or not public.crm_opp_visible(opp) then
      raise exception 'CRM_OPPORTUNITY_NOT_FOUND' using errcode = 'P0001';
    end if;
    cl := coalesce(cl, (select o.client_id from public.crm_opportunities o where o.id = opp));
    if cl is distinct from (select o.client_id from public.crm_opportunities o where o.id = opp) then raise exception 'CRM_ACTIVITY_INVALID' using errcode = 'P0001', hint = 'client'; end if;
  end if;
  if cl is null then raise exception 'CRM_ACTIVITY_INVALID' using errcode = 'P0001', hint = 'target'; end if;
  if not public.crm_client_ok(target, cl) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if contact is not null and not exists (select 1 from public.crm_contacts c where c.id = contact and c.client_id = cl) then
    raise exception 'CONTACT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if assignee is not null and not public.crm_is_member(target, assignee) then raise exception 'CRM_OWNER_INVALID' using errcode = 'P0001'; end if;
  if act is null then
    if idem is null then raise exception 'CRM_IDEMPOTENCY_REQUIRED' using errcode = 'P0001'; end if;
    select x.id into aid from public.crm_activities x where x.company_id = target and x.idempotency_key = idem;
    if aid is not null then return aid; end if;
    begin
      insert into public.crm_activities (company_id, kind, subject, body, direction, client_id, contact_id, opportunity_id, due_at, assigned_to, status,
        completed_at, completed_by, origin, idempotency_key, created_by)
      values (target, p_kind, btrim(p_subject), nullif(btrim(p_body), ''), p_direction, cl, contact, opp, p_due_at, coalesce(assignee, (select auth.uid())),
        case when p_kind = 'note' then 'completed' else 'pending' end, case when p_kind = 'note' then now() end,
        case when p_kind = 'note' then (select auth.uid()) end, case when p_origin = 'assistant' then 'assistant' else 'user' end, idem, (select auth.uid()))
      returning id into aid;
    exception when unique_violation then
      select x.id into aid from public.crm_activities x where x.company_id = target and x.idempotency_key = idem;
      if aid is null then raise; end if;
      return aid;
    end;
    perform public.crm_log(target, 'activity', aid::text, cl, opp, 'created', jsonb_build_object('kind', p_kind, 'subject', btrim(p_subject), 'origin', p_origin));
    return aid;
  end if;
  select * into a from public.crm_activities x where x.id = act and x.company_id = target for update;
  if a.id is null or not (a.created_by = (select auth.uid()) or a.assigned_to = (select auth.uid()) or public.has_permission(target, 'crm.view_all')
                          or (a.opportunity_id is not null and public.crm_opp_visible(a.opportunity_id)) or (a.opportunity_id is null and public.crm_client_ok(target, a.client_id))) then
    raise exception 'CRM_ACTIVITY_NOT_FOUND' using errcode = 'P0001';
  end if;
  if a.version is distinct from expected_version then raise exception 'CRM_STALE' using errcode = 'P0001'; end if;
  if a.kind <> p_kind and (a.kind = 'note' or p_kind = 'note') then raise exception 'CRM_ACTIVITY_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  update public.crm_activities set kind = p_kind, subject = btrim(p_subject), body = nullif(btrim(p_body), ''), direction = p_direction, client_id = cl,
    contact_id = contact, opportunity_id = opp, due_at = p_due_at, assigned_to = assignee, version = version + 1, updated_at = now()
  where id = act;
  perform public.crm_log(target, 'activity', act::text, cl, opp, 'updated',
    public.crm_diff(to_jsonb(a), (select to_jsonb(x) from public.crm_activities x where x.id = act), array['updated_at', 'version']));
  return act;
end $$;

create or replace function public.crm_set_activity_status(act uuid, p_status text, p_outcome text, expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare a public.crm_activities;
begin
  select * into a from public.crm_activities x where x.id = act for update;
  if a.id is null or not public.has_permission(a.company_id, 'crm.manage')
     or not (a.created_by = (select auth.uid()) or a.assigned_to = (select auth.uid()) or public.has_permission(a.company_id, 'crm.view_all')
             or (a.opportunity_id is not null and public.crm_opp_visible(a.opportunity_id)) or (a.opportunity_id is null and public.crm_client_ok(a.company_id, a.client_id))) then
    raise exception 'CRM_ACTIVITY_NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_status not in ('pending', 'completed', 'cancelled') or a.kind = 'note' then raise exception 'CRM_ACTIVITY_INVALID' using errcode = 'P0001', hint = 'status'; end if;
  if a.version is distinct from expected_version then raise exception 'CRM_STALE' using errcode = 'P0001'; end if;
  if a.status = p_status then return a.version; end if;
  update public.crm_activities set status = p_status, outcome = coalesce(nullif(btrim(p_outcome), ''), outcome),
    completed_at = case when p_status = 'completed' then now() end, completed_by = case when p_status = 'completed' then (select auth.uid()) end,
    version = version + 1, updated_at = now()
  where id = act;
  perform public.crm_log(a.company_id, 'activity', act::text, a.client_id, a.opportunity_id, p_status, jsonb_build_object('from', a.status, 'outcome', nullif(btrim(p_outcome), '')));
  return a.version + 1;
end $$;

-- ===================================================================== reads (security invoker: RLS decides)
-- Pipeline per stage: count, amount, weighted amount (rounded once, half away from zero).
create or replace function public.crm_pipeline_summary(target uuid, branch uuid default null)
returns table (stage_id uuid, key text, name_es text, name_en text, stage_position integer, outcome text, probability_bp integer,
               opportunities bigint, amount_cents bigint, weighted_cents bigint)
language sql stable security invoker set search_path = '' as $$
  select s.id, s.key, s.name_es, s.name_en, s.position, s.outcome, s.probability_bp,
         count(o.id), coalesce(sum(o.amount_cents), 0)::bigint,
         coalesce(round(sum(o.amount_cents::numeric * o.probability_bp) / 10000), 0)::bigint
  from public.crm_pipeline_stages s
  left join public.crm_opportunities o on o.stage_id = s.id and o.archived_at is null and (branch is null or o.branch_id = branch)
  where s.company_id = target and (s.active or o.id is not null)
  group by s.id order by s.position, s.key
$$;

-- ===================================================================== assistant (A6 proposals)
alter table public.assistant_actions drop constraint if exists assistant_actions_kind_check;
alter table public.assistant_actions add constraint assistant_actions_kind_check check (kind in ('studio_draft', 'crm_note', 'crm_task'));

create or replace function public.assistant_propose(turn uuid, act_kind text, act_summary text, act_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare t public.assistant_turns; me uuid := (select auth.uid()); lvl text; nid uuid;
begin
  select * into t from public.assistant_turns x where x.id = turn;
  if t.id is null or t.user_id is distinct from me or t.status <> 'open' or t.expires_at < now() or not public.has_permission(t.company_id, 'assistant.use') then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  lvl := case act_kind when 'studio_draft' then 'draft' when 'crm_note' then 'draft' when 'crm_task' then 'draft' end;
  if lvl is null then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  if act_kind = 'studio_draft' and not public.has_permission(t.company_id, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if act_kind in ('crm_note', 'crm_task') and not public.has_permission(t.company_id, 'crm.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if act_summary is null or char_length(btrim(act_summary)) not between 1 and 400 then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'summary'; end if;
  if (select count(*) from public.assistant_actions a where a.conversation_id = t.conversation_id and a.status = 'proposed' and a.expires_at > now()) >= 5 then
    raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'too_many_pending';
  end if;
  insert into public.assistant_actions (company_id, conversation_id, user_id, kind, level, summary, payload, turn_id)
  values (t.company_id, t.conversation_id, me, act_kind, lvl, left(btrim(act_summary), 400), act_payload, t.id)
  returning id into nid;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (t.company_id, me, t.conversation_id, nid, 'action_proposed', jsonb_build_object('kind', act_kind, 'level', lvl));
  return nid;
end $$;

-- ===================================================================== grants
do $$ declare f text; begin
  foreach f in array array[
    'public.crm_log(uuid, text, text, uuid, uuid, text, jsonb)', 'public.crm_diff(jsonb, jsonb, text[])', 'public.crm_is_member(uuid, uuid)',
    'public.crm_require(uuid, text)', 'public.crm_client_guard()', 'public.crm_client_audit()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.crm_scoped(uuid)', 'public.crm_in_my_branch(uuid, uuid)', 'public.crm_client_visible(uuid, uuid, uuid)', 'public.crm_opp_visible(uuid)',
    'public.crm_client_ok(uuid, uuid)', 'public.crm_ensure_setup(uuid)',
    'public.crm_find_duplicates(uuid, text, text, text, text, uuid)',
    'public.crm_save_contact(uuid, uuid, uuid, text, text, text, text, text, boolean, text)', 'public.crm_set_contact_archived(uuid, boolean)',
    'public.crm_save_tag(uuid, uuid, text, text, boolean)', 'public.crm_set_client_tags(uuid, uuid[])',
    'public.crm_save_stage(uuid, uuid, text, text, integer, integer, boolean)', 'public.crm_save_settings(uuid, boolean, boolean)',
    'public.crm_save_branch(uuid, uuid, text, text, text)', 'public.crm_set_branch_archived(uuid, boolean)', 'public.crm_set_branch_member(uuid, uuid, boolean)',
    'public.crm_share_client(uuid, uuid, boolean)',
    'public.crm_save_opportunity(uuid, uuid, uuid, uuid, text, text, bigint, integer, date, uuid, text, uuid, uuid, integer, uuid)',
    'public.crm_move_opportunity(uuid, uuid, integer, text)', 'public.crm_set_opportunity_archived(uuid, boolean, integer)',
    'public.crm_link_document(uuid, uuid, boolean)', 'public.crm_convert_quote(uuid, uuid, date, uuid)',
    'public.crm_save_activity(uuid, uuid, text, text, text, text, uuid, uuid, uuid, timestamptz, uuid, integer, uuid, text)',
    'public.crm_set_activity_status(uuid, text, text, integer)', 'public.crm_pipeline_summary(uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ===================================================================== self-check
do $$
declare t text;
begin
  foreach t in array array['branches', 'branch_members', 'crm_settings', 'crm_client_branches', 'crm_contacts', 'crm_tags', 'crm_client_tags',
                           'crm_pipeline_stages', 'crm_opportunities', 'crm_opportunity_documents', 'crm_quote_conversions', 'crm_activities', 'crm_events'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'BA0035 self-check failed: RLS off on %', t; end if;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT') or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') or has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'BA0035 self-check failed: % writable or readable by anon', t;
    end if;
  end loop;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key in ('crm.view_all', 'crm.configure', 'branches.manage')) then
    raise exception 'BA0035 self-check failed: member permissions';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'crm\_%'
        and p.prosecdef and not (p.proconfig @> array['search_path=""'])) > 0 then
    raise exception 'BA0035 self-check failed: definer without search_path';
  end if;
end $$;

commit;
