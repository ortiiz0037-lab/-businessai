-- =====================================================================
-- BusinessAI · Migration 0005 · Security baseline for business tables
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires owner approval.
-- Target: project businessai-dev (main branch = PRODUCTION), PostgreSQL 17.
-- Adapted to the real schema inspected on 2026-11-08 03:24 UTC
-- (see supabase/inspect/SCHEMA_REVIEW.md).
--
-- It does NOT create, drop or alter any table or column and touches no
-- rows. It only changes policies and privileges:
--   1. verifies the columns its policies rely on exist (else aborts);
--   2. aborts with zero changes if it finds a policy on the reviewed
--      tables that was not in the inspection (the database changed since);
--   3. clients/documents/payments: replaces the existing per-company
--      policies with one canonical set (`ba_` prefix):
--        - same tenant rule as today (membership in the row's company);
--        - a document may only reference a client of the same company;
--        - a payment must reference a document of the same company and be
--          recorded as the signed-in user;
--        - payments: the UPDATE and DELETE policies are removed and the
--          privileges revoked → app users can record and read, never edit
--          or erase;
--        - deleting clients/documents requires owner/admin;
--   4. document_deletion_audit: removes the two exact duplicate policies;
--   5. TRUNCATE (not subject to RLS) revoked from PUBLIC/anon/authenticated
--      on every public table, and from future tables owned by postgres;
--   6. self-check; aborts if the end state is not the intended one.
--
-- NOT in this migration (separate drafts, separate approval):
--   * 0006 — payments.document_id ON DELETE CASCADE (deleting a document
--     silently erases its payments, bypassing RLS and privileges).
--   * 0007 — Storage policies for the Company-assets bucket (storage.objects
--     is a Supabase-managed table; kept apart so a refusal there cannot
--     block or roll back this migration).
--   * 0008 — EXECUTE on can_edit_company_profile for anon.
-- Rollback: supabase/rollback/0005_rollback.sql (restores the inspected state).
--
-- One transaction: any failure leaves the database untouched. Re-runnable.
-- =====================================================================

begin;

-- Fail fast instead of queueing application traffic behind our locks:
-- if a table is busy, the migration aborts (nothing changed) and can be
-- retried in a quieter moment.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------
-- 0. Reviewed policies (exact names from the inspection).
--    action = 'replace': dropped, superseded by a canonical `ba_` policy.
--    action = 'remove' : dropped, exact duplicate of a policy that stays.
--    action = 'keep'   : reviewed and left unchanged.
-- ---------------------------------------------------------------------
create temporary table _ba_reviewed_policies (
  tbl text not null,
  name text not null,
  action text not null check (action in ('replace', 'remove', 'keep')),
  primary key (tbl, name)
) on commit drop;

insert into _ba_reviewed_policies (tbl, name, action) values
  ('public.clients',   'clients_select_own_company',    'replace'),
  ('public.clients',   'clients_insert_own_company',    'replace'),
  ('public.clients',   'clients_update_own_company',    'replace'),
  ('public.clients',   'clients_delete_own_company',    'replace'),
  ('public.documents', 'documents_select_own_company',  'replace'),
  ('public.documents', 'documents_insert_own_company',  'replace'),
  ('public.documents', 'documents_update_own_company',  'replace'),
  ('public.documents', 'documents_delete_own_company',  'replace'),
  ('public.payments',  'payments_select_own_company',   'replace'),
  ('public.payments',  'payments_insert_own_company',   'replace'),
  ('public.payments',  'payments_update_own_company',   'replace'),
  ('public.payments',  'payments_delete_own_company',   'replace'),
  ('public.document_deletion_audit', 'audit_select_company',              'keep'),
  ('public.document_deletion_audit', 'audit_insert_company',              'keep'),
  ('public.document_deletion_audit', 'Members can view deletion audit',   'remove'),
  ('public.document_deletion_audit', 'Members can insert deletion audit', 'remove');

-- ---------------------------------------------------------------------
-- 1. Preconditions: columns used by the policies below must exist.
-- ---------------------------------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
  req record;
begin
  for req in
    select * from (values
      ('clients',   'company_id'),
      ('documents', 'company_id'), ('documents', 'client_id'), ('documents', 'created_by'),
      ('payments',  'company_id'), ('payments',  'document_id'), ('payments', 'created_by'),
      ('document_deletion_audit', 'company_id'), ('document_deletion_audit', 'deleted_by')
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
    raise exception 'BA0005: missing expected columns: %', array_to_string(missing, ', ');
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
-- 2. Guard: a policy that was not in the inspection aborts everything.
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
    and p.schemaname = 'public'
    and p.tablename in ('clients', 'documents', 'payments', 'document_deletion_audit')
    and not exists (select 1 from _ba_reviewed_policies r
                    where r.tbl = 'public.' || p.tablename and r.name = p.policyname);

  if unknown is not null then
    raise exception E'BA0005: policies not covered by the inspection; nothing was changed:\n%', unknown
      using hint = 'The database changed since the inspection. Re-inspect and review.';
  end if;
end $$;

-- Drop reviewed 'replace' and 'remove' policies. A reviewed policy that is
-- no longer present is reported, not fatal.
do $$
declare
  r record;
begin
  for r in select * from _ba_reviewed_policies where action in ('replace', 'remove') loop
    if exists (select 1 from pg_policies
               where schemaname || '.' || tablename = r.tbl and policyname = r.name) then
      execute format('drop policy %I on %s', r.name, r.tbl);
      raise notice 'BA0005: dropped policy % on % (%)', r.name, r.tbl, r.action;
    else
      raise notice 'BA0005: policy % on % already absent', r.name, r.tbl;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Row level security and least-privilege grants.
-- ---------------------------------------------------------------------
alter table public.clients   enable row level security;
alter table public.documents enable row level security;
alter table public.payments  enable row level security;

revoke all on public.clients, public.documents, public.payments from anon;

-- Unchanged for clients/documents (the app reads, creates, edits, deletes).
grant select, insert, update, delete on public.clients   to authenticated;
grant select, insert, update, delete on public.documents to authenticated;
-- Payments are a ledger: app users record and read, never edit or erase.
grant select, insert on public.payments to authenticated;
revoke update, delete on public.payments from authenticated;
-- A table-level REVOKE does not remove column-level grants: remove those too.
do $$
declare
  col record;
begin
  for col in
    select a.attname from pg_attribute a
    where a.attrelid = 'public.payments'::regclass and a.attnum > 0 and not a.attisdropped
  loop
    execute format('revoke update (%I) on public.payments from authenticated', col.attname);
  end loop;
end $$;
revoke references, trigger on public.clients, public.documents, public.payments from authenticated;

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

-- documents: keeps today's created_by rule on insert; a referenced client
-- must belong to the same company.
drop policy if exists ba_documents_select on public.documents;
drop policy if exists ba_documents_insert on public.documents;
drop policy if exists ba_documents_update on public.documents;
drop policy if exists ba_documents_delete on public.documents;

create policy ba_documents_select on public.documents for select to authenticated
  using (public.is_company_member(company_id));
create policy ba_documents_insert on public.documents for insert to authenticated
  with check (
    public.is_company_member(company_id)
    and (created_by is null or created_by = (select auth.uid()))
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

-- payments: select + insert only (no update/delete policy exists).
drop policy if exists ba_payments_select on public.payments;
drop policy if exists ba_payments_insert on public.payments;

create policy ba_payments_select on public.payments for select to authenticated
  using (public.is_company_member(company_id));
create policy ba_payments_insert on public.payments for insert to authenticated
  with check (
    public.is_company_member(company_id)
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.documents d
      where d.id = document_id and d.company_id = payments.company_id)
  );

-- ---------------------------------------------------------------------
-- 5. TRUNCATE bypasses RLS: remove it from the API roles on every public
--    table (the app never truncates), and from future postgres tables.
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
-- 6. Self-check.
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
    if exists (select 1 from pg_policies
               where schemaname = 'public' and tablename = t and policyname not like 'ba\_%') then
      problems := problems || (t || ': non-canonical policy remains');
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.payments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.payments', 'DELETE')
     or has_any_column_privilege('authenticated', 'public.payments', 'UPDATE') then
    problems := problems || 'payments: authenticated can update/delete (table or column level)'::text;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payments'
             and cmd in ('UPDATE', 'DELETE', 'ALL')) then
    problems := problems || 'payments: an update/delete/all policy exists'::text;
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'document_deletion_audit') <> 2 then
    problems := problems || 'document_deletion_audit: expected exactly 2 policies'::text;
  end if;

  select problems || coalesce(array_agg('truncate allowed on public.' || c.relname || ' for ' || r.rolname), '{}')
    into problems
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as r(rolname)
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and has_table_privilege(r.rolname, c.oid, 'TRUNCATE');

  if array_length(problems, 1) > 0 then
    raise exception 'BA0005 self-check failed: %', array_to_string(problems, '; ');
  end if;
end $$;

commit;
