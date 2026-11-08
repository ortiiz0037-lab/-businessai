-- =====================================================================
-- BusinessAI · Migration 0005 · Security baseline for business tables
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires owner approval.
--
-- clients, documents and payments already exist in the live databases
-- (created outside this repo). This migration does NOT create, recreate
-- or alter their columns, and it touches no rows. It only:
--   1. verifies the columns the app already reads/writes exist;
--   2. refuses to run (rolls back, zero changes) if it finds RLS policies
--      on these tables or on the Company-assets bucket that have not been
--      reviewed — so it can never silently coexist with a broader policy;
--   3. enables RLS, sets least-privilege grants and installs one canonical
--      set of tenant-isolation policies (names prefixed `ba_`);
--   4. blocks cross-tenant references (a document pointing at another
--      company's client; a payment pointing at another company's document);
--   5. makes payments append-only for app users (no update/delete);
--   6. adds company-scoped Storage policies for the Company-assets bucket
--      (folder = company id; writes for owner/admin only);
--   7. adds missing tenant indexes only when no equivalent exists;
--   8. removes TRUNCATE from anon/authenticated on every public table
--      (RLS does not apply to TRUNCATE) and from future tables;
--   9. removes EXECUTE from anon/PUBLIC on every SECURITY DEFINER function
--      in public (e.g. can_edit_company_profile) — bodies are not changed;
--  10. self-checks the result and aborts if anything is off.
--
-- Everything runs in one transaction: any failure leaves the DB untouched.
-- Safe to run more than once.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Reviewed policies
-- ---------------------------------------------------------------------
-- Existing policies that were reviewed (from
-- supabase/inspect/inspect_security_baseline.sql output) and are replaced
-- by the canonical `ba_` policies below. Format: 'schema.table:policy'.
-- Until this list is filled from the real inspection, the migration aborts
-- on any database that already has its own policies on these tables.
create temporary table _ba_reviewed_policies (ref text primary key) on commit drop;
insert into _ba_reviewed_policies (ref) values
  ('_placeholder_:_none_');  -- replace with the reviewed list

-- ---------------------------------------------------------------------
-- 1. Preconditions: the columns the application already uses must exist.
-- ---------------------------------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
  req record;
begin
  for req in
    select * from (values
      ('clients',   'id'), ('clients',   'company_id'),
      ('documents', 'id'), ('documents', 'company_id'), ('documents', 'client_id'),
      ('payments',  'id'), ('payments',  'company_id'), ('payments',  'document_id'),
      ('payments',  'created_by')
    ) as t(tbl, col)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = req.tbl and column_name = req.col
    ) then
      missing := missing || (req.tbl || '.' || req.col);
    end if;
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception 'BA0005: missing expected columns: %', array_to_string(missing, ', ')
      using hint = 'Run supabase/inspect/inspect_security_baseline.sql and adapt this migration.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name in ('clients', 'documents', 'payments')
      and column_name = 'company_id' and data_type <> 'uuid'
  ) then
    raise exception 'BA0005: company_id must be uuid on clients/documents/payments';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Guard: unreviewed policies abort the migration.
-- ---------------------------------------------------------------------
do $$
declare
  unknown text;
begin
  select string_agg(format('%s.%s:%s [%s] using(%s) check(%s)',
                           p.schemaname, p.tablename, p.policyname, p.cmd,
                           coalesce(p.qual, '-'), coalesce(p.with_check, '-')), E'\n')
    into unknown
  from pg_policies p
  where p.policyname not like 'ba\_%'
    and (p.schemaname || '.' || p.tablename || ':' || p.policyname)
        not in (select ref from _ba_reviewed_policies)
    and (
      (p.schemaname = 'public' and p.tablename in ('clients', 'documents', 'payments'))
      or (
        p.schemaname = 'storage' and p.tablename = 'objects'
        and (
          coalesce(p.qual, '') || coalesce(p.with_check, '') ilike '%company-assets%'
          -- a policy that does not restrict bucket_id applies to every bucket
          or coalesce(p.qual, '') || coalesce(p.with_check, '') not ilike '%bucket_id%'
        )
      )
    );

  if unknown is not null then
    raise exception E'BA0005: unreviewed policies found; nothing was changed:\n%', unknown
      using hint = 'Review them and add the ones to replace to _ba_reviewed_policies.';
  end if;
end $$;

-- Drop only the reviewed policies (the canonical ones are recreated below).
do $$
declare
  r record;
begin
  for r in
    select p.schemaname, p.tablename, p.policyname
    from pg_policies p
    join _ba_reviewed_policies rv
      on rv.ref = p.schemaname || '.' || p.tablename || ':' || p.policyname
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Row level security and least-privilege grants.
-- ---------------------------------------------------------------------
alter table public.clients   enable row level security;
alter table public.documents enable row level security;
alter table public.payments  enable row level security;

revoke all on public.clients, public.documents, public.payments from anon;

grant select, insert, update, delete on public.clients   to authenticated;
grant select, insert, update, delete on public.documents to authenticated;
-- Payments are a ledger: app users may record and read, never edit/erase.
grant select, insert on public.payments to authenticated;
revoke update, delete, truncate on public.payments from authenticated;
revoke truncate, references, trigger on public.clients, public.documents from authenticated;

grant all on public.clients, public.documents, public.payments to service_role;

-- ---------------------------------------------------------------------
-- 4. Canonical tenant-isolation policies.
-- ---------------------------------------------------------------------
-- clients
drop policy if exists ba_clients_select on public.clients;
drop policy if exists ba_clients_insert on public.clients;
drop policy if exists ba_clients_update on public.clients;
drop policy if exists ba_clients_delete on public.clients;

create policy ba_clients_select on public.clients for select to authenticated
  using (public.is_company_member(company_id));
create policy ba_clients_insert on public.clients for insert to authenticated
  with check (public.is_company_member(company_id));
create policy ba_clients_update on public.clients for update to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));
create policy ba_clients_delete on public.clients for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'admin']));

-- documents: the referenced client (if any) must belong to the same company.
drop policy if exists ba_documents_select on public.documents;
drop policy if exists ba_documents_insert on public.documents;
drop policy if exists ba_documents_update on public.documents;
drop policy if exists ba_documents_delete on public.documents;

create policy ba_documents_select on public.documents for select to authenticated
  using (public.is_company_member(company_id));
create policy ba_documents_insert on public.documents for insert to authenticated
  with check (
    public.is_company_member(company_id)
    and (client_id is null or exists (
      select 1 from public.clients c
      where c.id = client_id and c.company_id = documents.company_id))
  );
create policy ba_documents_update on public.documents for update to authenticated
  using (public.is_company_member(company_id))
  with check (
    public.is_company_member(company_id)
    and (client_id is null or exists (
      select 1 from public.clients c
      where c.id = client_id and c.company_id = documents.company_id))
  );
create policy ba_documents_delete on public.documents for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'admin']));

-- payments: same-company document, recorded by the signed-in user.
drop policy if exists ba_payments_select on public.payments;
drop policy if exists ba_payments_insert on public.payments;

create policy ba_payments_select on public.payments for select to authenticated
  using (public.is_company_member(company_id));
create policy ba_payments_insert on public.payments for insert to authenticated
  with check (
    public.is_company_member(company_id)
    and created_by = (select auth.uid())
    and (document_id is null or exists (
      select 1 from public.documents d
      where d.id = document_id and d.company_id = payments.company_id))
  );

-- ---------------------------------------------------------------------
-- 5. Storage: Company-assets bucket, one folder per company.
--    Path format used by the app: <company_id>/<logo|signature>-<ts>.<ext>
-- ---------------------------------------------------------------------
create or replace function public.storage_company_id(object_name text)
returns uuid
language sql immutable set search_path = '' as $$
  select case
    when (string_to_array(object_name, '/'))[1]
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and array_length(string_to_array(object_name, '/'), 1) > 1
    then ((string_to_array(object_name, '/'))[1])::uuid
  end
$$;

revoke all on function public.storage_company_id(text) from public, anon;
grant execute on function public.storage_company_id(text) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'Company-assets') then
    raise notice 'BA0005: bucket Company-assets not found; storage policies skipped';
    return;
  end if;

  execute 'drop policy if exists ba_company_assets_select on storage.objects';
  execute 'drop policy if exists ba_company_assets_insert on storage.objects';
  execute 'drop policy if exists ba_company_assets_update on storage.objects';
  execute 'drop policy if exists ba_company_assets_delete on storage.objects';

  execute $p$
    create policy ba_company_assets_select on storage.objects for select to authenticated
      using (bucket_id = 'Company-assets'
             and public.is_company_member(public.storage_company_id(name)))
  $p$;
  execute $p$
    create policy ba_company_assets_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'Company-assets'
                  and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']))
  $p$;
  execute $p$
    create policy ba_company_assets_update on storage.objects for update to authenticated
      using (bucket_id = 'Company-assets'
             and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']))
      with check (bucket_id = 'Company-assets'
                  and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']))
  $p$;
  execute $p$
    create policy ba_company_assets_delete on storage.objects for delete to authenticated
      using (bucket_id = 'Company-assets'
             and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']))
  $p$;
end $$;

-- ---------------------------------------------------------------------
-- 6. Tenant indexes — only when no index already starts with the column.
-- ---------------------------------------------------------------------
do $$
declare
  want record;
begin
  for want in
    select * from (values
      ('clients',   'company_id',  'ba_clients_company_idx',   '(company_id, created_at desc)'),
      ('documents', 'company_id',  'ba_documents_company_idx', '(company_id, created_at desc)'),
      ('documents', 'client_id',   'ba_documents_client_idx',  '(client_id)'),
      ('payments',  'company_id',  'ba_payments_company_idx',  '(company_id, created_at desc)'),
      ('payments',  'document_id', 'ba_payments_document_idx', '(document_id)')
    ) as t(tbl, lead_col, idx_name, idx_cols)
  loop
    if not exists (
      select 1
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = ('public.' || want.tbl)::regclass
        and a.attname = want.lead_col
    ) then
      -- created_at is optional: fall back to the tenant column alone.
      if want.idx_cols like '%created_at%' and not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = want.tbl and column_name = 'created_at'
      ) then
        want.idx_cols := '(' || want.lead_col || ')';
      end if;
      execute format('create index %I on public.%I %s', want.idx_name, want.tbl, want.idx_cols);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6b. TRUNCATE: row level security does not apply to TRUNCATE, so any
--     role holding it can empty a table regardless of policies. The app
--     never truncates. Remove it from the API roles on every public table,
--     and from tables created later by `postgres`.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('revoke truncate on table public.%I from public, anon, authenticated', r.relname);
  end loop;

  if exists (select 1 from pg_roles where rolname = 'postgres') then
    alter default privileges for role postgres in schema public
      revoke truncate on tables from public, anon, authenticated;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6c. SECURITY DEFINER functions run with the owner's rights. Nothing in
--     the app calls them anonymously, so anon/PUBLIC must not execute them
--     (this covers can_edit_company_profile). Function bodies are NOT
--     changed here: they are reviewed separately from their source.
--     Functions that belong to an extension are left alone.
-- ---------------------------------------------------------------------
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Self-check: abort if the end state is not the intended one.
-- ---------------------------------------------------------------------
do $$
declare
  problems text[] := array[]::text[];
  t text;
begin
  foreach t in array array['clients', 'documents', 'payments'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      problems := problems || (t || ': RLS disabled');
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE') then
      problems := problems || (t || ': anon has privileges');
    end if;
    if exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname not like 'ba\_%'
    ) then
      problems := problems || (t || ': non-canonical policy remains');
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.payments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.payments', 'DELETE') then
    problems := problems || 'payments: authenticated can update/delete'::text;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payments' and cmd in ('UPDATE', 'DELETE', 'ALL')
  ) then
    problems := problems || 'payments: an update/delete/all policy exists'::text;
  end if;

  select problems || coalesce(array_agg('truncate allowed on public.' || c.relname || ' for ' || r.rolname), '{}')
    into problems
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as r(rolname)
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and has_table_privilege(r.rolname, c.oid, 'TRUNCATE');

  select problems || coalesce(array_agg('anon can execute security definer ' || p.oid::regprocedure::text), '{}')
    into problems
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if array_length(problems, 1) > 0 then
    raise exception 'BA0005 self-check failed: %', array_to_string(problems, '; ');
  end if;

  -- Not fatal, but reported: a definer function without a fixed
  -- search_path can be hijacked through objects in other schemas.
  perform 1;
  for t in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search\_path=%')
  loop
    raise warning 'BA0005: security definer function % has no fixed search_path (review its source)', t;
  end loop;
end $$;

commit;
