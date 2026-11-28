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
--   6. Guard (R3): it stops, changing nothing, if storage.objects carries a
--      policy it does not know that mentions a company bucket or is not
--      limited by bucket (such a policy would grant access to Company-assets
--      or the private Company-signatures outside has_permission()). Policies
--      limited to other buckets are kept and listed. It never drops a policy:
--      every finding is for the owner to review (supabase/RUNBOOK.md §7).
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
  kept text;
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
  -- reproduce). storage.objects is checked separately below (R3).
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

  -- storage.objects is shared by every bucket, so other buckets may have
  -- their own policies. Policies combine with OR: an unknown policy that is
  -- not limited to another bucket would still grant access to the company
  -- buckets, outside has_permission(). Stop on those; list the others.
  select string_agg(c.policyname || ' [' || c.permissive || ' ' || c.cmd || ' to ' || c.roles || '] ' || c.verdict,
                    E'\n' order by c.policyname) into unknown
  from
    -- BEGIN storage.objects policy classifier (R3). This block is identical in
    -- 0014a_permissions.sql (3x), verify_0014a.sql and inspect_storage_policies.sql.
    -- One row per storage.objects policy that is not one of the 5 repository
    -- ba_ policies, with a verdict:
    --   allowed  the policy is limited, at its top level, to buckets other than
    --            Company-assets / Company-signatures ("bucket_id = '…'" alone or
    --            as one of the AND conditions, in every USING / WITH CHECK);
    --   block    anything else: it mentions a company bucket, has no condition,
    --            or is not limited by bucket (true, OR, <>, lower(bucket_id)…),
    --            so it could grant access to the company buckets.
    -- Conservative by design: what it cannot prove limited is blocked.
    (with
     pol as (
       select p.policyname::text as policyname, p.permissive::text as permissive, p.cmd::text as cmd,
              array_to_string(p.roles, ',') as roles, p.qual, p.with_check
       from pg_policies p
       where p.schemaname = 'storage' and p.tablename = 'objects'
         and p.policyname not in ('ba_company_assets_select', 'ba_company_assets_insert',
                                  'ba_company_signatures_select', 'ba_company_signatures_insert',
                                  'ba_company_signatures_delete')),
     cond as (  -- every condition of every policy (USING and WITH CHECK)
       select pol.policyname, e.kind, e.expr
       from pol cross join lateral (values ('using', pol.qual), ('with check', pol.with_check)) e(kind, expr)
       where e.expr is not null),
     chr as (
       select cond.policyname, cond.kind, cond.expr, g.i, substr(cond.expr, g.i, 1) as c
       from cond cross join lateral generate_series(1, length(cond.expr)) g(i)),
     quoted as (  -- inside a string literal before this character?
       select chr.*, coalesce(sum((chr.c = '''')::int) over (partition by chr.policyname, chr.kind order by chr.i
                                rows between unbounded preceding and 1 preceding), 0) % 2 = 1 as in_quote
       from chr),
     depth as (  -- parenthesis depth after this character, outside string literals
       select quoted.*, sum(case when quoted.in_quote or quoted.c = '''' then 0
                                 when quoted.c = '(' then 1 when quoted.c = ')' then -1 else 0 end)
                          over (partition by quoted.policyname, quoted.kind order by quoted.i) as d
       from quoted),
     shape as (  -- top level of each condition: wrapped in one (…), its AND starts, any OR
       select depth.policyname, depth.kind, depth.expr,
              coalesce(min(depth.d) filter (where depth.i < length(depth.expr)), 0) >= 1
                and left(depth.expr, 1) = '(' and right(depth.expr, 1) = ')' as wrapped,
              bool_or(depth.d = 1 and not depth.in_quote and substr(depth.expr, depth.i, 4) = ' OR ') as top_or,
              array_agg(depth.i + 5 order by depth.i)
                filter (where depth.d = 1 and not depth.in_quote and substr(depth.expr, depth.i, 5) = ' AND ') as and_starts
       from depth group by depth.policyname, depth.kind, depth.expr),
     filtered as (  -- the bucket filter found at the top level of the condition, if any
       select shape.policyname, shape.kind,
              (select m[1] from (
                 select regexp_match(shape.expr, '^\((?:objects\.)?bucket_id = ((?:''[^'']*''::text)|ANY \(ARRAY\[(?:''[^'']*''::text(?:, )?)+\]\))\)$') as m
                 union all
                 select regexp_match(substr(shape.expr, s), '^\((?:objects\.)?bucket_id = ((?:''[^'']*''::text)|ANY \(ARRAY\[(?:''[^'']*''::text(?:, )?)+\]\))\)(?: AND |\)$)')
                 from unnest(array[2] || coalesce(shape.and_starts, '{}'::int[])) s
                 where shape.wrapped and not coalesce(shape.top_or, false)) x
               where m is not null limit 1) as bucket_filter
       from shape),
     verdict as (
       select pol.policyname, pol.permissive, pol.cmd, pol.roles,
              case
                when lower(coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~ 'company-(assets|signatures)'
                  then 'block: mentions Company-assets or Company-signatures'
                when pol.qual is null and pol.with_check is null
                  then 'block: no condition (applies to every bucket)'
                when exists (select 1 from filtered f where f.policyname = pol.policyname and f.bucket_filter is null)
                  then 'block: not limited by bucket (applies to every bucket, including Company-signatures)'
                else 'allowed: limited to bucket ' || (
                  select string_agg(distinct b[1], ', ' order by b[1])
                  from filtered f cross join lateral regexp_matches(f.bucket_filter, '''([^'']*)''', 'g') b
                  where f.policyname = pol.policyname)
              end as verdict
       from pol)
     select verdict.policyname, verdict.permissive, verdict.cmd, verdict.roles, verdict.verdict from verdict)
    -- END storage.objects policy classifier (R3)
  c
  where c.verdict like 'block:%';
  if unknown is not null then
    raise exception E'BA0014a: storage.objects policies that could reach the company buckets were found; nothing was changed:\n%', unknown
      using hint = 'Review each one (supabase/RUNBOOK.md §7). This migration never drops a policy.';
  end if;
  select string_agg(c.policyname || ' (' || c.verdict || ')', ', ' order by c.policyname) into kept
  from
    -- BEGIN storage.objects policy classifier (R3). This block is identical in
    -- 0014a_permissions.sql (3x), verify_0014a.sql and inspect_storage_policies.sql.
    -- One row per storage.objects policy that is not one of the 5 repository
    -- ba_ policies, with a verdict:
    --   allowed  the policy is limited, at its top level, to buckets other than
    --            Company-assets / Company-signatures ("bucket_id = '…'" alone or
    --            as one of the AND conditions, in every USING / WITH CHECK);
    --   block    anything else: it mentions a company bucket, has no condition,
    --            or is not limited by bucket (true, OR, <>, lower(bucket_id)…),
    --            so it could grant access to the company buckets.
    -- Conservative by design: what it cannot prove limited is blocked.
    (with
     pol as (
       select p.policyname::text as policyname, p.permissive::text as permissive, p.cmd::text as cmd,
              array_to_string(p.roles, ',') as roles, p.qual, p.with_check
       from pg_policies p
       where p.schemaname = 'storage' and p.tablename = 'objects'
         and p.policyname not in ('ba_company_assets_select', 'ba_company_assets_insert',
                                  'ba_company_signatures_select', 'ba_company_signatures_insert',
                                  'ba_company_signatures_delete')),
     cond as (  -- every condition of every policy (USING and WITH CHECK)
       select pol.policyname, e.kind, e.expr
       from pol cross join lateral (values ('using', pol.qual), ('with check', pol.with_check)) e(kind, expr)
       where e.expr is not null),
     chr as (
       select cond.policyname, cond.kind, cond.expr, g.i, substr(cond.expr, g.i, 1) as c
       from cond cross join lateral generate_series(1, length(cond.expr)) g(i)),
     quoted as (  -- inside a string literal before this character?
       select chr.*, coalesce(sum((chr.c = '''')::int) over (partition by chr.policyname, chr.kind order by chr.i
                                rows between unbounded preceding and 1 preceding), 0) % 2 = 1 as in_quote
       from chr),
     depth as (  -- parenthesis depth after this character, outside string literals
       select quoted.*, sum(case when quoted.in_quote or quoted.c = '''' then 0
                                 when quoted.c = '(' then 1 when quoted.c = ')' then -1 else 0 end)
                          over (partition by quoted.policyname, quoted.kind order by quoted.i) as d
       from quoted),
     shape as (  -- top level of each condition: wrapped in one (…), its AND starts, any OR
       select depth.policyname, depth.kind, depth.expr,
              coalesce(min(depth.d) filter (where depth.i < length(depth.expr)), 0) >= 1
                and left(depth.expr, 1) = '(' and right(depth.expr, 1) = ')' as wrapped,
              bool_or(depth.d = 1 and not depth.in_quote and substr(depth.expr, depth.i, 4) = ' OR ') as top_or,
              array_agg(depth.i + 5 order by depth.i)
                filter (where depth.d = 1 and not depth.in_quote and substr(depth.expr, depth.i, 5) = ' AND ') as and_starts
       from depth group by depth.policyname, depth.kind, depth.expr),
     filtered as (  -- the bucket filter found at the top level of the condition, if any
       select shape.policyname, shape.kind,
              (select m[1] from (
                 select regexp_match(shape.expr, '^\((?:objects\.)?bucket_id = ((?:''[^'']*''::text)|ANY \(ARRAY\[(?:''[^'']*''::text(?:, )?)+\]\))\)$') as m
                 union all
                 select regexp_match(substr(shape.expr, s), '^\((?:objects\.)?bucket_id = ((?:''[^'']*''::text)|ANY \(ARRAY\[(?:''[^'']*''::text(?:, )?)+\]\))\)(?: AND |\)$)')
                 from unnest(array[2] || coalesce(shape.and_starts, '{}'::int[])) s
                 where shape.wrapped and not coalesce(shape.top_or, false)) x
               where m is not null limit 1) as bucket_filter
       from shape),
     verdict as (
       select pol.policyname, pol.permissive, pol.cmd, pol.roles,
              case
                when lower(coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~ 'company-(assets|signatures)'
                  then 'block: mentions Company-assets or Company-signatures'
                when pol.qual is null and pol.with_check is null
                  then 'block: no condition (applies to every bucket)'
                when exists (select 1 from filtered f where f.policyname = pol.policyname and f.bucket_filter is null)
                  then 'block: not limited by bucket (applies to every bucket, including Company-signatures)'
                else 'allowed: limited to bucket ' || (
                  select string_agg(distinct b[1], ', ' order by b[1])
                  from filtered f cross join lateral regexp_matches(f.bucket_filter, '''([^'']*)''', 'g') b
                  where f.policyname = pol.policyname)
              end as verdict
       from pol)
     select verdict.policyname, verdict.permissive, verdict.cmd, verdict.roles, verdict.verdict from verdict)
    -- END storage.objects policy classifier (R3)
  c
  where c.verdict like 'allowed:%';
  if kept is not null then
    raise warning 'BA0014a: storage.objects policies of other buckets kept unchanged: %', kept;
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

  -- R3 again, now that storage.objects is locked by this transaction: no
  -- policy appeared meanwhile that could reach the company buckets.
  select string_agg(c.policyname || ': ' || c.verdict, '; ' order by c.policyname) into bad
  from
    -- BEGIN storage.objects policy classifier (R3). This block is identical in
    -- 0014a_permissions.sql (3x), verify_0014a.sql and inspect_storage_policies.sql.
    -- One row per storage.objects policy that is not one of the 5 repository
    -- ba_ policies, with a verdict:
    --   allowed  the policy is limited, at its top level, to buckets other than
    --            Company-assets / Company-signatures ("bucket_id = '…'" alone or
    --            as one of the AND conditions, in every USING / WITH CHECK);
    --   block    anything else: it mentions a company bucket, has no condition,
    --            or is not limited by bucket (true, OR, <>, lower(bucket_id)…),
    --            so it could grant access to the company buckets.
    -- Conservative by design: what it cannot prove limited is blocked.
    (with
     pol as (
       select p.policyname::text as policyname, p.permissive::text as permissive, p.cmd::text as cmd,
              array_to_string(p.roles, ',') as roles, p.qual, p.with_check
       from pg_policies p
       where p.schemaname = 'storage' and p.tablename = 'objects'
         and p.policyname not in ('ba_company_assets_select', 'ba_company_assets_insert',
                                  'ba_company_signatures_select', 'ba_company_signatures_insert',
                                  'ba_company_signatures_delete')),
     cond as (  -- every condition of every policy (USING and WITH CHECK)
       select pol.policyname, e.kind, e.expr
       from pol cross join lateral (values ('using', pol.qual), ('with check', pol.with_check)) e(kind, expr)
       where e.expr is not null),
     chr as (
       select cond.policyname, cond.kind, cond.expr, g.i, substr(cond.expr, g.i, 1) as c
       from cond cross join lateral generate_series(1, length(cond.expr)) g(i)),
     quoted as (  -- inside a string literal before this character?
       select chr.*, coalesce(sum((chr.c = '''')::int) over (partition by chr.policyname, chr.kind order by chr.i
                                rows between unbounded preceding and 1 preceding), 0) % 2 = 1 as in_quote
       from chr),
     depth as (  -- parenthesis depth after this character, outside string literals
       select quoted.*, sum(case when quoted.in_quote or quoted.c = '''' then 0
                                 when quoted.c = '(' then 1 when quoted.c = ')' then -1 else 0 end)
                          over (partition by quoted.policyname, quoted.kind order by quoted.i) as d
       from quoted),
     shape as (  -- top level of each condition: wrapped in one (…), its AND starts, any OR
       select depth.policyname, depth.kind, depth.expr,
              coalesce(min(depth.d) filter (where depth.i < length(depth.expr)), 0) >= 1
                and left(depth.expr, 1) = '(' and right(depth.expr, 1) = ')' as wrapped,
              bool_or(depth.d = 1 and not depth.in_quote and substr(depth.expr, depth.i, 4) = ' OR ') as top_or,
              array_agg(depth.i + 5 order by depth.i)
                filter (where depth.d = 1 and not depth.in_quote and substr(depth.expr, depth.i, 5) = ' AND ') as and_starts
       from depth group by depth.policyname, depth.kind, depth.expr),
     filtered as (  -- the bucket filter found at the top level of the condition, if any
       select shape.policyname, shape.kind,
              (select m[1] from (
                 select regexp_match(shape.expr, '^\((?:objects\.)?bucket_id = ((?:''[^'']*''::text)|ANY \(ARRAY\[(?:''[^'']*''::text(?:, )?)+\]\))\)$') as m
                 union all
                 select regexp_match(substr(shape.expr, s), '^\((?:objects\.)?bucket_id = ((?:''[^'']*''::text)|ANY \(ARRAY\[(?:''[^'']*''::text(?:, )?)+\]\))\)(?: AND |\)$)')
                 from unnest(array[2] || coalesce(shape.and_starts, '{}'::int[])) s
                 where shape.wrapped and not coalesce(shape.top_or, false)) x
               where m is not null limit 1) as bucket_filter
       from shape),
     verdict as (
       select pol.policyname, pol.permissive, pol.cmd, pol.roles,
              case
                when lower(coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~ 'company-(assets|signatures)'
                  then 'block: mentions Company-assets or Company-signatures'
                when pol.qual is null and pol.with_check is null
                  then 'block: no condition (applies to every bucket)'
                when exists (select 1 from filtered f where f.policyname = pol.policyname and f.bucket_filter is null)
                  then 'block: not limited by bucket (applies to every bucket, including Company-signatures)'
                else 'allowed: limited to bucket ' || (
                  select string_agg(distinct b[1], ', ' order by b[1])
                  from filtered f cross join lateral regexp_matches(f.bucket_filter, '''([^'']*)''', 'g') b
                  where f.policyname = pol.policyname)
              end as verdict
       from pol)
     select verdict.policyname, verdict.permissive, verdict.cmd, verdict.roles, verdict.verdict from verdict)
    -- END storage.objects policy classifier (R3)
  c
  where c.verdict like 'block:%';
  if bad is not null then raise exception 'BA0014a verification: storage.objects policies that could reach the company buckets: %', bad; end if;

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
