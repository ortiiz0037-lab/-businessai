-- Fase 2: perfil y branding de la empresa

create table public.company_profiles (
  company_id uuid primary key
    references public.companies(id) on delete cascade,

  legal_name text,
  display_name text,
  phone text,
  email text,
  address text,
  city text,
  state text default 'Puerto Rico',
  postal_code text,

  primary_color text not null default '#2563EB',
  secondary_color text not null default '#0F172A',

  logo_url text,
  signature_url text,

  payment_info text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (
    legal_name is null
    or char_length(btrim(legal_name)) between 2 and 160
  ),

  check (
    display_name is null
    or char_length(btrim(display_name)) between 2 and 160
  )
);

create index company_profiles_display_name_idx
  on public.company_profiles (display_name);

alter table public.company_profiles enable row level security;

revoke all on public.company_profiles from anon;

grant select on table public.company_profiles to authenticated;
grant insert, update on table public.company_profiles to authenticated;

create policy company_profiles_select
on public.company_profiles
for select
to authenticated
using (
  public.is_company_member(company_id)
);

create policy company_profiles_insert
on public.company_profiles
for insert
to authenticated
with check (
  public.has_company_role(company_id, array['owner', 'admin'])
);

create policy company_profiles_update
on public.company_profiles
for update
to authenticated
using (
  public.has_company_role(company_id, array['owner', 'admin'])
)
with check (
  public.has_company_role(company_id, array['owner', 'admin'])
);

grant select, insert, update, delete
on table public.company_profiles
to service_role;