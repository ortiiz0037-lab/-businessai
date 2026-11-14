-- =====================================================================
-- Rollback of 0005: restores the INSPECTED policies and privileges
-- (2026-11-08 03:24 UTC). This brings back the known gaps (editable and
-- deletable payments, TRUNCATE for anon/authenticated, cross-company
-- references). Emergency use only, e.g. if the app breaks after 0005.
-- Policy definitions are copied from the inspection output.
-- Not restored: ALTER DEFAULT PRIVILEGES (the original default privileges
-- were not part of the inspection; tables created later simply will not
-- get TRUNCATE for anon/authenticated).
-- =====================================================================
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- canonical policies out
drop policy if exists ba_clients_select on public.clients;
drop policy if exists ba_clients_insert on public.clients;
drop policy if exists ba_clients_update on public.clients;
drop policy if exists ba_clients_delete on public.clients;
drop policy if exists ba_documents_select on public.documents;
drop policy if exists ba_documents_insert on public.documents;
drop policy if exists ba_documents_update on public.documents;
drop policy if exists ba_documents_delete on public.documents;
drop policy if exists ba_payments_select on public.payments;
drop policy if exists ba_payments_insert on public.payments;

-- inspected policies back
create policy clients_select_own_company on public.clients for select to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = clients.company_id) and (m.user_id = auth.uid()))));
create policy clients_insert_own_company on public.clients for insert to authenticated
  with check (exists (select 1 from public.memberships m where ((m.company_id = clients.company_id) and (m.user_id = auth.uid()))));
create policy clients_update_own_company on public.clients for update to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = clients.company_id) and (m.user_id = auth.uid()))))
  with check (exists (select 1 from public.memberships m where ((m.company_id = clients.company_id) and (m.user_id = auth.uid()))));
create policy clients_delete_own_company on public.clients for delete to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = clients.company_id) and (m.user_id = auth.uid()))));

create policy documents_select_own_company on public.documents for select to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = documents.company_id) and (m.user_id = auth.uid()))));
create policy documents_insert_own_company on public.documents for insert to authenticated
  with check ((exists (select 1 from public.memberships m where ((m.company_id = documents.company_id) and (m.user_id = auth.uid()))))
              and ((created_by is null) or (created_by = auth.uid())));
create policy documents_update_own_company on public.documents for update to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = documents.company_id) and (m.user_id = auth.uid()))))
  with check (exists (select 1 from public.memberships m where ((m.company_id = documents.company_id) and (m.user_id = auth.uid()))));
create policy documents_delete_own_company on public.documents for delete to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = documents.company_id) and (m.user_id = auth.uid()))));

create policy payments_select_own_company on public.payments for select to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = payments.company_id) and (m.user_id = auth.uid()))));
create policy payments_insert_own_company on public.payments for insert to authenticated
  with check (exists (select 1 from public.memberships m where ((m.company_id = payments.company_id) and (m.user_id = auth.uid()))));
create policy payments_update_own_company on public.payments for update to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = payments.company_id) and (m.user_id = auth.uid()))))
  with check (exists (select 1 from public.memberships m where ((m.company_id = payments.company_id) and (m.user_id = auth.uid()))));
create policy payments_delete_own_company on public.payments for delete to authenticated
  using (exists (select 1 from public.memberships m where ((m.company_id = payments.company_id) and (m.user_id = auth.uid()))));

create policy "Members can insert deletion audit" on public.document_deletion_audit for insert to authenticated
  with check (((deleted_by = auth.uid()) and (exists (select 1 from public.memberships m
    where ((m.company_id = document_deletion_audit.company_id) and (m.user_id = auth.uid()))))));
create policy "Members can view deletion audit" on public.document_deletion_audit for select to authenticated
  using (exists (select 1 from public.memberships m
    where ((m.company_id = document_deletion_audit.company_id) and (m.user_id = auth.uid()))));

-- inspected privileges back
grant update, delete on public.payments to authenticated;
grant truncate on public.clients, public.documents, public.payments, public.document_deletion_audit to anon;
grant truncate on public.clients, public.companies, public.company_profiles, public.company_subscriptions,
  public.document_deletion_audit, public.documents, public.memberships, public.payments to authenticated;
commit;
