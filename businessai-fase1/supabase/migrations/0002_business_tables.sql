-- =====================================================================
-- BusinessAI · Migration 0002 · Business tables (clients, documents,
-- payments, document_deletion_audit) and the Company-assets bucket
-- =====================================================================
-- These objects already exist in production: they were created outside
-- this repository. This file reproduces their INSPECTED structure
-- (2026-11-08) so that a new environment (staging, local) can be built
-- from the repository alone. Everything is "if not exists": on a database
-- that already has them (production) it changes nothing.
-- No policies here: 0005 installs the canonical ones.
-- =====================================================================

begin;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  business_name text, email text, phone text, address text,
  city text, state text, postal_code text, notes text,
  status text not null default 'active' check (status = any (array['active', 'inactive'])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clients_company_id_idx on public.clients (company_id);
create index if not exists clients_company_name_idx on public.clients (company_id, name);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  document_type text not null check (document_type = any (array['quote', 'invoice', 'receipt',
    'work_order', 'letter', 'payment_reminder', 'contract', 'report'])),
  document_number text not null,
  status text not null default 'draft'
    check (status = any (array['draft', 'sent', 'paid', 'overdue', 'cancelled'])),
  title text,
  issue_date date not null default current_date,
  due_date date,
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  tax numeric(12,2) not null default 0 check (tax >= 0),
  total numeric(12,2) not null default 0 check (total >= 0),
  notes text,
  payment_info text,
  items jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, document_number)
);
create index if not exists documents_client_id_idx on public.documents (client_id);
create index if not exists documents_company_id_idx on public.documents (company_id);
create index if not exists documents_created_at_idx on public.documents (created_at desc);
create index if not exists documents_status_idx on public.documents (status);

-- payments.document_id is created ON DELETE CASCADE as inspected; 0006
-- changes it to NO ACTION.
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid not null,
  amount numeric(12,2) not null check (amount > 0),
  payment_method text,
  reference text,
  paid_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint payments_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete cascade
);
create index if not exists payments_company_id_idx on public.payments (company_id);
create index if not exists payments_document_id_idx on public.payments (document_id);

create table if not exists public.document_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  document_id uuid not null,
  document_number text, document_type text, title text, previous_status text,
  total numeric,
  reason text not null,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now(),
  status text
);
create index if not exists idx_document_deletion_audit_company_date
  on public.document_deletion_audit (company_id, deleted_at desc);

alter table public.clients enable row level security;
alter table public.documents enable row level security;
alter table public.payments enable row level security;
alter table public.document_deletion_audit enable row level security;

-- Audit table policies as inspected (0005 keeps exactly these two).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'document_deletion_audit' and policyname = 'audit_select_company') then
    create policy audit_select_company on public.document_deletion_audit for select to authenticated
      using (exists (select 1 from public.memberships m
             where m.company_id = document_deletion_audit.company_id and m.user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'document_deletion_audit' and policyname = 'audit_insert_company') then
    create policy audit_insert_company on public.document_deletion_audit for insert to authenticated
      with check ((deleted_by = auth.uid()) and (exists (select 1 from public.memberships m
                  where m.company_id = document_deletion_audit.company_id and m.user_id = auth.uid())));
  end if;
end $$;

-- Logos bucket (public), as inspected.
insert into storage.buckets (id, name, public, file_size_limit)
values ('Company-assets', 'Company-assets', true, 5242880)
on conflict (id) do nothing;

commit;
