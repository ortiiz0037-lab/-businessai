-- Business tables, policies and privileges as INSPECTED on businessai-dev
-- (PostgreSQL 17.11, 2026-11-08 03:24 UTC). TEST-ONLY; never run on Supabase.
-- Reproduces the inspected columns, defaults, NOT NULLs, checks, unique
-- constraints, foreign keys (with their ON DELETE actions), indexes, RLS
-- policies and table privileges. Runs after 0001/0003/0004.
--
-- Known limits of this reproduction:
--  * The inspection lists two storage policies twice with the same name
--    ("Company assets update kgntv7_0" / "_1", once for 'COMPANY-ASSETS'
--    and once for 'company-assets'). PostgreSQL cannot hold two policies
--    with the same name on one table, so the real names must differ
--    (e.g. invisible characters). Here the second copy gets a " #2" suffix.
--    0005 matches storage policies by content, not by name.
--  * Function bodies were not inspected: can_edit_company_profile and
--    delete_document_with_audit are stand-ins with the inspected signature,
--    SECURITY setting, search_path and EXECUTE grants only.

-- --------------------------------------------------------------- tables
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  business_name text, email text, phone text, address text,
  city text, state text, postal_code text, notes text,
  status text not null default 'active' check (status = any (array['active', 'inactive'])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clients_company_id_idx on public.clients (company_id);
create index clients_company_name_idx on public.clients (company_id, name);

create table public.documents (
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
create index documents_client_id_idx on public.documents (client_id);
create index documents_company_id_idx on public.documents (company_id);
create index documents_created_at_idx on public.documents (created_at desc);
create index documents_status_idx on public.documents (status);

create table public.payments (
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
create index payments_company_id_idx on public.payments (company_id);
create index payments_document_id_idx on public.payments (document_id);

create table public.document_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  document_id uuid not null,
  document_number text,
  document_type text,
  title text,
  previous_status text,
  total numeric,
  reason text not null,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now(),
  status text
);
create index idx_document_deletion_audit_company_date
  on public.document_deletion_audit (company_id, deleted_at desc);

alter table public.clients enable row level security;
alter table public.documents enable row level security;
alter table public.payments enable row level security;
alter table public.document_deletion_audit enable row level security;

-- ------------------------------------------------------ inspected policies
create policy clients_select_own_company on public.clients for select to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = clients.company_id and m.user_id = auth.uid()));
create policy clients_insert_own_company on public.clients for insert to authenticated
  with check (exists (select 1 from public.memberships m where m.company_id = clients.company_id and m.user_id = auth.uid()));
create policy clients_update_own_company on public.clients for update to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = clients.company_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.memberships m where m.company_id = clients.company_id and m.user_id = auth.uid()));
create policy clients_delete_own_company on public.clients for delete to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = clients.company_id and m.user_id = auth.uid()));

create policy documents_select_own_company on public.documents for select to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = documents.company_id and m.user_id = auth.uid()));
create policy documents_insert_own_company on public.documents for insert to authenticated
  with check ((exists (select 1 from public.memberships m where m.company_id = documents.company_id and m.user_id = auth.uid()))
              and (created_by is null or created_by = auth.uid()));
create policy documents_update_own_company on public.documents for update to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = documents.company_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.memberships m where m.company_id = documents.company_id and m.user_id = auth.uid()));
create policy documents_delete_own_company on public.documents for delete to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = documents.company_id and m.user_id = auth.uid()));

create policy payments_select_own_company on public.payments for select to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = payments.company_id and m.user_id = auth.uid()));
create policy payments_insert_own_company on public.payments for insert to authenticated
  with check (exists (select 1 from public.memberships m where m.company_id = payments.company_id and m.user_id = auth.uid()));
create policy payments_update_own_company on public.payments for update to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = payments.company_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.memberships m where m.company_id = payments.company_id and m.user_id = auth.uid()));
create policy payments_delete_own_company on public.payments for delete to authenticated
  using (exists (select 1 from public.memberships m where m.company_id = payments.company_id and m.user_id = auth.uid()));

create policy "Members can insert deletion audit" on public.document_deletion_audit for insert to authenticated
  with check ((deleted_by = auth.uid()) and (exists (select 1 from public.memberships m
              where m.company_id = document_deletion_audit.company_id and m.user_id = auth.uid())));
create policy "Members can view deletion audit" on public.document_deletion_audit for select to authenticated
  using (exists (select 1 from public.memberships m
         where m.company_id = document_deletion_audit.company_id and m.user_id = auth.uid()));
create policy audit_insert_company on public.document_deletion_audit for insert to authenticated
  with check ((deleted_by = auth.uid()) and (exists (select 1 from public.memberships m
              where m.company_id = document_deletion_audit.company_id and m.user_id = auth.uid())));
create policy audit_select_company on public.document_deletion_audit for select to authenticated
  using (exists (select 1 from public.memberships m
         where m.company_id = document_deletion_audit.company_id and m.user_id = auth.uid()));

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit)
  values ('Company-assets', 'Company-assets', true, 5242880);

create policy "Authenticated users can upload company assets" on storage.objects for insert to authenticated
  with check ((bucket_id = 'company-assets') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy "Company assets read kgntv7_0" on storage.objects for select to authenticated
  using ((bucket_id = 'COMPANY-ASSETS') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy "Company assets update kgntv7_0" on storage.objects for update to authenticated
  using ((bucket_id = 'COMPANY-ASSETS') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy "Company assets update kgntv7_1" on storage.objects for select to authenticated
  using ((bucket_id = 'COMPANY-ASSETS') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy "Company assets update kgntv7_0 #2" on storage.objects for update to authenticated
  using ((bucket_id = 'company-assets') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy "Company assets update kgntv7_1 #2" on storage.objects for select to authenticated
  using ((bucket_id = 'company-assets') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy "Company assets upload kgntv7_0" on storage.objects for insert to authenticated
  with check ((bucket_id = 'company-assets') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy "Company assets view kgntv7_0" on storage.objects for select to authenticated
  using ((bucket_id = 'company-assets') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy "Give users authenticated access to folder kgntv7_0" on storage.objects for insert to authenticated
  with check ((bucket_id = 'COMPANY-ASSETS') and ((storage.foldername(name))[1] in
    (select memberships.company_id::text from public.memberships where memberships.user_id = auth.uid())));
create policy company_assets_read on storage.objects for select to authenticated
  using ((bucket_id = 'Company-assets') and ((storage.foldername(name))[1] in
    (select m.company_id::text from public.memberships m
     where m.user_id = (select auth.uid()) and m.role = any (array['owner', 'admin']))));
create policy company_assets_upload on storage.objects for insert to authenticated
  with check ((bucket_id = 'Company-assets') and ((storage.foldername(name))[1] in
    (select m.company_id::text from public.memberships m
     where m.user_id = (select auth.uid()) and m.role = any (array['owner', 'admin']))));

-- -------------------------------------------------------------- functions
-- Stand-ins: signature, SECURITY and search_path as inspected; bodies unknown.
create function public.can_edit_company_profile(target_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_company_role(target_company_id, array['owner', 'admin'])
$$;
create function public.delete_document_with_audit(p_document_id uuid, p_reason text) returns void
language plpgsql security invoker set search_path = public as $$
begin
  raise exception 'stand-in: real body not inspected';
end $$;
revoke all on function public.delete_document_with_audit(uuid, text) from public, anon;
grant execute on function public.can_edit_company_profile(uuid) to anon, authenticated;
grant execute on function public.delete_document_with_audit(uuid, text) to authenticated;

-- ------------------------------------------- table privileges as inspected
-- (anon / authenticated / service_role; S I U D T)
create function pg_temp.grant_letters(tbl text, grantee text, letters text) returns void
language plpgsql as $$
declare
  privs text[] := array[]::text[];
begin
  if letters like '%S%' then privs := privs || 'select'::text; end if;
  if letters like '%I%' then privs := privs || 'insert'::text; end if;
  if letters like '%U%' then privs := privs || 'update'::text; end if;
  if letters like '%D%' then privs := privs || 'delete'::text; end if;
  if letters like '%T%' then privs := privs || 'truncate'::text; end if;
  if array_length(privs, 1) > 0 then
    execute format('grant %s on public.%I to %I', array_to_string(privs, ', '), tbl, grantee);
  end if;
end $$;

do $$
declare
  r record;
begin
  for r in select * from (values
    -- table                     anon     authenticated  service_role
    ('clients',                  'T',     'SIUDT',       'SIUDT'),
    ('companies',                '',      'SUT',         'SIUDT'),
    ('company_profiles',         '',      'SIUT',        'SIUDT'),
    ('company_subscriptions',    '',      'ST',          'SIUDT'),
    ('document_deletion_audit',  'T',     'SIT',         'T'),
    ('documents',                'T',     'SIUDT',       'SIUDT'),
    ('memberships',              '',      'ST',          'SIUDT'),
    ('payments',                 'T',     'SIUDT',       'SIUDT'),
    ('stripe_events',            '',      '',            'SIUDT')
  ) as t(tbl, anon_p, auth_p, svc_p)
  loop
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', r.tbl);
    perform pg_temp.grant_letters(r.tbl, 'anon', r.anon_p);
    perform pg_temp.grant_letters(r.tbl, 'authenticated', r.auth_p);
    perform pg_temp.grant_letters(r.tbl, 'service_role', r.svc_p);
  end loop;
end $$;
