-- =====================================================================
-- BusinessAI · Migration 0014a · Permission foundation (E3)
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Applying it to staging or
-- production requires the owner's explicit authorization.
--
-- WHAT IT DOES (and nothing else):
--   1. Closed catalog of permissions (public.permissions) and the initial
--      role → permission matrix (public.role_permissions). The matrix
--      reproduces TODAY's behaviour exactly: owner and admin have the same
--      permissions; member can read, create and edit, but cannot delete,
--      configure the company or manage branding.
--   2. public.memberships.status ('active' | 'suspended'), default 'active':
--      every existing membership becomes 'active', so nobody loses access.
--      Nothing in this migration suspends anyone (that belongs to E4).
--   3. public.has_permission(company_id, permission): SECURITY DEFINER,
--      search_path fixed, true only for an ACTIVE membership whose role has
--      the permission.
--   4. is_company_member / has_company_role keep their signatures and now
--      also require an active membership (all are active → same result).
--   5. The 24 tenant RLS policies created by 0002/0003/0004/0005/0007/0009
--      are rewritten with has_permission(), keeping their names, commands,
--      roles and every non-membership condition unchanged.
--
-- WHAT IT DOES NOT DO (E4): invitations, ownership transfer, suspending
-- members, separate owner/admin permissions, Stripe routes, team screens.
--
-- Requires 0011 (and therefore 0001–0010). Runs in ONE transaction: any
-- failure (guard, lock timeout, verification) changes nothing. Safe to
-- re-run: it converges to the same end state.
-- Rollback: supabase/rollback/0014a_rollback.sql.
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local client_min_messages = warning;

-- ------------------------------------------------------------ 0. guards
do $$
declare
  missing text;
  unknown text;
begin
  -- Objects created by earlier migrations that this one rewrites or uses.
  if to_regprocedure('public.is_company_member(uuid)') is null
     or to_regprocedure('public.has_company_role(uuid, text[])') is null
     or to_regprocedure('public.storage_company_id(text)') is null
     or to_regprocedure('public.company_billing_state(uuid)') is null
     or to_regprocedure('public.company_usage(uuid)') is null then
    raise exception 'BA0014a: migrations 0001–0011 must be applied first (membership helpers, storage_company_id, billing 0010/0011)';
  end if;

  -- Every policy this migration rewrites must exist (by table and name)…
  select string_agg(e.tbl || ':' || e.name, ', ' order by e.tbl, e.name) into missing
  from (values
    ('public.companies', 'companies_select'), ('public.companies', 'companies_update'),
    ('public.memberships', 'memberships_select'),
    ('public.company_profiles', 'company_profiles_select'),
    ('public.company_profiles', 'company_profiles_insert'),
    ('public.company_profiles', 'company_profiles_update'),
    ('public.company_subscriptions', 'company_subscriptions_select'),
    ('public.document_deletion_audit', 'audit_select_company'),
    ('public.document_deletion_audit', 'audit_insert_company'),
    ('public.clients', 'ba_clients_select'), ('public.clients', 'ba_clients_insert'),
    ('public.clients', 'ba_clients_update'), ('public.clients', 'ba_clients_delete'),
    ('public.documents', 'ba_documents_select'), ('public.documents', 'ba_documents_insert'),
    ('public.documents', 'ba_documents_update'), ('public.documents', 'ba_documents_delete'),
    ('public.payments', 'ba_payments_select'), ('public.payments', 'ba_payments_insert'),
    ('storage.objects', 'ba_company_assets_select'), ('storage.objects', 'ba_company_assets_insert'),
    ('storage.objects', 'ba_company_signatures_select'),
    ('storage.objects', 'ba_company_signatures_insert'),
    ('storage.objects', 'ba_company_signatures_delete')
  ) e(tbl, name)
  where not exists (select 1 from pg_policies p
                    where p.schemaname || '.' || p.tablename = e.tbl and p.policyname = e.name);
  if missing is not null then
    raise exception E'BA0014a: expected policies not found; nothing was changed:\n%', missing;
  end if;

  -- …and the tenant tables must not carry policies we do not know about
  -- (a policy added outside the repository could grant access we would not
  -- reproduce). storage.objects may hold policies of other buckets.
  select string_agg(p.schemaname || '.' || p.tablename || ':' || p.policyname, ', '
                    order by p.tablename, p.policyname) into unknown
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in ('companies', 'memberships', 'company_profiles', 'company_subscriptions',
                        'document_deletion_audit', 'clients', 'documents', 'payments')
    and p.policyname not in ('companies_select', 'companies_update', 'memberships_select',
                             'company_profiles_select', 'company_profiles_insert', 'company_profiles_update',
                             'company_subscriptions_select', 'audit_select_company', 'audit_insert_company',
                             'ba_clients_select', 'ba_clients_insert', 'ba_clients_update', 'ba_clients_delete',
                             'ba_documents_select', 'ba_documents_insert', 'ba_documents_update', 'ba_documents_delete',
                             'ba_payments_select', 'ba_payments_insert');
  if unknown is not null then
    raise exception E'BA0014a: policies not created by the repository were found; nothing was changed:\n%', unknown
      using hint = 'Review them before rewriting the tenant policies.';
  end if;

  -- A membership role outside the three roles would have no permissions.
  if exists (select 1 from public.memberships where role not in ('owner', 'admin', 'member')) then
    raise exception 'BA0014a: memberships with an unknown role exist; nothing was changed';
  end if;
end $$;

-- ------------------------------------------- 1. catalog and role matrix
create table if not exists public.permissions (
  key text primary key check (key ~ '^[a-z]+(\.[a-z_]+)+$'),
  module text not null,
  description_es text not null,
  description_en text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role text not null check (role in ('owner', 'admin', 'member')),
  permission_key text not null references public.permissions(key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role, permission_key)
);

alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;

-- Global catalogs: readable by signed-in users, written only by migrations.
revoke all on public.permissions, public.role_permissions from public, anon, authenticated;
grant select on public.permissions, public.role_permissions to authenticated;
grant all on public.permissions, public.role_permissions to service_role;

drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions for select to authenticated using (true);
drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select to authenticated using (true);

-- The permissions defined by THIS migration (later migrations add their own).
create temporary table ba_0014a_permissions (
  key text primary key, module text, description_es text, description_en text,
  owner boolean, admin boolean, member boolean
) on commit drop;
insert into ba_0014a_permissions values
  ('company.view', 'company', 'Ver la empresa y su perfil', 'View the company and its profile', true, true, true),
  ('company.settings.manage', 'company', 'Editar la empresa y su perfil', 'Edit the company and its profile', true, true, false),
  ('company.branding.manage', 'company', 'Subir y ver el logo; subir y borrar la firma', 'Upload and view the logo; upload and delete the signature', true, true, false),
  ('company.signature.view', 'company', 'Usar la firma de la empresa en los documentos', 'Use the company signature on documents', true, true, true),
  ('members.view', 'members', 'Ver los miembros de la empresa', 'View the company members', true, true, true),
  ('billing.view', 'billing', 'Ver el estado de la suscripción', 'View the subscription status', true, true, true),
  ('billing.manage', 'billing', 'Gestionar la suscripción (hoy lo aplica la app, no la base de datos)', 'Manage the subscription (enforced by the app today, not by the database)', true, true, false),
  ('clients.view', 'clients', 'Ver clientes', 'View clients', true, true, true),
  ('clients.create', 'clients', 'Crear clientes', 'Create clients', true, true, true),
  ('clients.edit', 'clients', 'Editar clientes', 'Edit clients', true, true, true),
  ('clients.delete', 'clients', 'Borrar clientes', 'Delete clients', true, true, false),
  ('documents.view', 'documents', 'Ver documentos', 'View documents', true, true, true),
  ('documents.create', 'documents', 'Crear documentos', 'Create documents', true, true, true),
  ('documents.edit', 'documents', 'Editar documentos y su estado', 'Edit documents and their status', true, true, true),
  ('documents.delete', 'documents', 'Borrar documentos', 'Delete documents', true, true, false),
  ('documents.deletion_log.write', 'documents', 'Registrar el borrado de un documento', 'Record a document deletion', true, true, true),
  ('payments.view', 'payments', 'Ver pagos', 'View payments', true, true, true),
  ('payments.record', 'payments', 'Registrar pagos', 'Record payments', true, true, true);

insert into public.permissions (key, module, description_es, description_en)
select key, module, description_es, description_en from ba_0014a_permissions
on conflict (key) do update
  set module = excluded.module,
      description_es = excluded.description_es,
      description_en = excluded.description_en;

-- Converge to exactly this matrix for these permissions (re-runs included).
delete from public.role_permissions
where permission_key in (select key from ba_0014a_permissions);
insert into public.role_permissions (role, permission_key)
select r.role, p.key
from ba_0014a_permissions p
cross join lateral (values ('owner', p.owner), ('admin', p.admin), ('member', p.member)) r(role, granted)
where r.granted;

-- -------------------------------------------------- 2. membership status
alter table public.memberships
  add column if not exists status text not null default 'active';
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.memberships'::regclass and conname = 'memberships_status_check') then
    alter table public.memberships
      add constraint memberships_status_check check (status in ('active', 'suspended'));
  end if;
end $$;

-- ------------------------------------------------------ 3. has_permission
create or replace function public.has_permission(target uuid, permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role = m.role and rp.permission_key = permission
    where m.company_id = target
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

-- ------------------------------- 4. existing helpers: active memberships
create or replace function public.is_company_member(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.company_id = target and m.user_id = (select auth.uid())
                   and m.status = 'active');
$$;

create or replace function public.has_company_role(target uuid, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.company_id = target and m.user_id = (select auth.uid())
                   and m.status = 'active' and m.role = any (roles));
$$;

-- Same grants as the existing helpers: never anon or PUBLIC.
revoke all on function public.has_permission(uuid, text),
  public.is_company_member(uuid), public.has_company_role(uuid, text[]) from public, anon;
grant execute on function public.has_permission(uuid, text),
  public.is_company_member(uuid), public.has_company_role(uuid, text[]) to authenticated, service_role;

-- ------------------------------------------------ 5. tenant RLS policies
-- Same names, commands and roles; only the membership check changes.
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies for select to authenticated
  using (public.has_permission(id, 'company.view'));
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies for update to authenticated
  using (public.has_permission(id, 'company.settings.manage'))
  with check (public.has_permission(id, 'company.settings.manage'));

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.has_permission(company_id, 'members.view'));

drop policy if exists company_profiles_select on public.company_profiles;
create policy company_profiles_select on public.company_profiles for select to authenticated
  using (public.has_permission(company_id, 'company.view'));
drop policy if exists company_profiles_insert on public.company_profiles;
create policy company_profiles_insert on public.company_profiles for insert to authenticated
  with check (public.has_permission(company_id, 'company.settings.manage'));
drop policy if exists company_profiles_update on public.company_profiles;
create policy company_profiles_update on public.company_profiles for update to authenticated
  using (public.has_permission(company_id, 'company.settings.manage'))
  with check (public.has_permission(company_id, 'company.settings.manage'));

drop policy if exists company_subscriptions_select on public.company_subscriptions;
create policy company_subscriptions_select on public.company_subscriptions for select to authenticated
  using (public.has_permission(company_id, 'billing.view'));

drop policy if exists audit_select_company on public.document_deletion_audit;
create policy audit_select_company on public.document_deletion_audit for select to authenticated
  using (public.has_permission(company_id, 'documents.view'));
drop policy if exists audit_insert_company on public.document_deletion_audit;
create policy audit_insert_company on public.document_deletion_audit for insert to authenticated
  with check (deleted_by = (select auth.uid())
              and public.has_permission(company_id, 'documents.deletion_log.write'));

drop policy if exists ba_clients_select on public.clients;
create policy ba_clients_select on public.clients for select to authenticated
  using (public.has_permission(company_id, 'clients.view'));
drop policy if exists ba_clients_insert on public.clients;
create policy ba_clients_insert on public.clients for insert to authenticated
  with check (public.has_permission(company_id, 'clients.create'));
drop policy if exists ba_clients_update on public.clients;
create policy ba_clients_update on public.clients for update to authenticated
  using (public.has_permission(company_id, 'clients.edit'))
  with check (public.has_permission(company_id, 'clients.edit'));
drop policy if exists ba_clients_delete on public.clients;
create policy ba_clients_delete on public.clients for delete to authenticated
  using (public.has_permission(company_id, 'clients.delete'));

drop policy if exists ba_documents_select on public.documents;
create policy ba_documents_select on public.documents for select to authenticated
  using (public.has_permission(company_id, 'documents.view'));
drop policy if exists ba_documents_insert on public.documents;
create policy ba_documents_insert on public.documents for insert to authenticated
  with check (
    public.has_permission(company_id, 'documents.create')
    and (created_by is null or created_by = (select auth.uid()))
    and (client_id is null or exists (
      select 1 from public.clients c
      where c.id = client_id and c.company_id = documents.company_id))
  );
drop policy if exists ba_documents_update on public.documents;
create policy ba_documents_update on public.documents for update to authenticated
  using (public.has_permission(company_id, 'documents.edit'))
  with check (
    public.has_permission(company_id, 'documents.edit')
    and (client_id is null or exists (
      select 1 from public.clients c
      where c.id = client_id and c.company_id = documents.company_id))
  );
drop policy if exists ba_documents_delete on public.documents;
create policy ba_documents_delete on public.documents for delete to authenticated
  using (public.has_permission(company_id, 'documents.delete'));

drop policy if exists ba_payments_select on public.payments;
create policy ba_payments_select on public.payments for select to authenticated
  using (public.has_permission(company_id, 'payments.view'));
drop policy if exists ba_payments_insert on public.payments;
create policy ba_payments_insert on public.payments for insert to authenticated
  with check (
    public.has_permission(company_id, 'payments.record')
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.documents d
      where d.id = document_id and d.company_id = payments.company_id)
  );

drop policy if exists ba_company_assets_select on storage.objects;
create policy ba_company_assets_select on storage.objects for select to authenticated
  using (bucket_id = 'Company-assets'
         and public.has_permission(public.storage_company_id(name), 'company.branding.manage'));
drop policy if exists ba_company_assets_insert on storage.objects;
create policy ba_company_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'Company-assets'
              and public.has_permission(public.storage_company_id(name), 'company.branding.manage'));

drop policy if exists ba_company_signatures_select on storage.objects;
create policy ba_company_signatures_select on storage.objects for select to authenticated
  using (bucket_id = 'Company-signatures'
         and public.has_permission(public.storage_company_id(name), 'company.signature.view'));
drop policy if exists ba_company_signatures_insert on storage.objects;
create policy ba_company_signatures_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'Company-signatures'
              and public.has_permission(public.storage_company_id(name), 'company.branding.manage'));
drop policy if exists ba_company_signatures_delete on storage.objects;
create policy ba_company_signatures_delete on storage.objects for delete to authenticated
  using (bucket_id = 'Company-signatures'
         and public.has_permission(public.storage_company_id(name), 'company.branding.manage'));

-- ---------------------------------------- 6. verification before commit
do $$
declare
  diff text;
  bad text;
begin
  -- The matrix is exactly the one declared above (no row more, none less).
  select string_agg(x, ', ') into diff from (
    (select r.role || ':' || p.key as x
       from ba_0014a_permissions p
       cross join lateral (values ('owner', p.owner), ('admin', p.admin), ('member', p.member)) r(role, granted)
      where r.granted
     except
     select role || ':' || permission_key from public.role_permissions)
    union all
    (select role || ':' || permission_key || ' (unexpected)' from public.role_permissions
      where permission_key in (select key from ba_0014a_permissions)
     except
     select r.role || ':' || p.key || ' (unexpected)'
       from ba_0014a_permissions p
       cross join lateral (values ('owner', p.owner), ('admin', p.admin), ('member', p.member)) r(role, granted)
      where r.granted)
  ) d;
  if diff is not null then raise exception 'BA0014a verification: role matrix differs: %', diff; end if;
  if (select count(*) from public.role_permissions
       where permission_key in (select key from ba_0014a_permissions)) <> 49 then
    raise exception 'BA0014a verification: expected 49 role/permission rows (owner 18, admin 18, member 13)';
  end if;

  -- Functions: SECURITY DEFINER, empty search_path, no anon/PUBLIC execute.
  select string_agg(f, ', ') into bad from (values
    ('public.has_permission(uuid,text)'), ('public.is_company_member(uuid)'),
    ('public.has_company_role(uuid,text[])')) v(f)
  where not exists (select 1 from pg_proc p
                    where p.oid = to_regprocedure(v.f) and p.prosecdef
                      and p.proconfig @> array['search_path=""'])
     or has_function_privilege('anon', to_regprocedure(v.f), 'EXECUTE')
     or not has_function_privilege('authenticated', to_regprocedure(v.f), 'EXECUTE');
  if bad is not null then raise exception 'BA0014a verification: function attributes or grants wrong: %', bad; end if;

  -- Every rewritten policy uses has_permission and no longer the old checks.
  select string_agg(p.tablename || ':' || p.policyname, ', ') into bad
  from pg_policies p
  where (p.schemaname = 'public'
         and p.tablename in ('companies', 'memberships', 'company_profiles', 'company_subscriptions',
                             'document_deletion_audit', 'clients', 'documents', 'payments'))
     or (p.schemaname = 'storage' and p.tablename = 'objects'
         and p.policyname in ('ba_company_assets_select', 'ba_company_assets_insert',
                              'ba_company_signatures_select', 'ba_company_signatures_insert',
                              'ba_company_signatures_delete'))
  group by ()
  having bool_or(coalesce(p.qual, '') || coalesce(p.with_check, '') not like '%has_permission(%'
                 or coalesce(p.qual, '') || coalesce(p.with_check, '') ~ '(is_company_member|has_company_role|FROM memberships)')
      or count(*) <> 24;
  if bad is not null then raise exception 'BA0014a verification: tenant policies not fully rewritten (24 expected): %', bad; end if;

  -- Status column: not null, default active, constrained.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'memberships' and column_name = 'status'
                   and is_nullable = 'NO' and column_default like '''active''%') then
    raise exception 'BA0014a verification: memberships.status missing or not "not null default active"';
  end if;

  -- New tables: RLS on, no anon access, no writes or TRUNCATE for API roles.
  if exists (select 1 from pg_class c
             where c.oid in ('public.permissions'::regclass, 'public.role_permissions'::regclass)
               and not c.relrowsecurity)
     or has_table_privilege('anon', 'public.permissions', 'SELECT')
     or has_table_privilege('anon', 'public.role_permissions', 'SELECT')
     or has_table_privilege('authenticated', 'public.permissions', 'INSERT,UPDATE,DELETE,TRUNCATE')
     or has_table_privilege('authenticated', 'public.role_permissions', 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'BA0014a verification: permissions catalog tables are not locked down';
  end if;
end $$;

commit;
