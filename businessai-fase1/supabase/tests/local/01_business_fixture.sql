-- TEST FIXTURE — NOT THE REAL SCHEMA.
-- The live clients/documents/payments tables were created outside this repo.
-- These stand-ins contain only the columns the application code reads or
-- writes today (see src/app/(app)/**), so migration 0005 can be exercised
-- locally. Replace with the inspected definitions once
-- supabase/inspect/inspect_security_baseline.sql has been run on dev.
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  business_name text, email text, phone text, address text,
  city text, state text, postal_code text, notes text,
  status text default 'active',
  created_at timestamptz not null default now()
);
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  document_type text, title text, document_number text,
  issue_date date, due_date date,
  subtotal numeric(12,2), tax numeric(12,2), total numeric(12,2),
  status text default 'draft', notes text,
  created_at timestamptz not null default now()
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  amount numeric(12,2) not null,
  payment_method text, reference text, paid_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
insert into storage.buckets (id, name, public) values ('Company-assets', 'Company-assets', true);
