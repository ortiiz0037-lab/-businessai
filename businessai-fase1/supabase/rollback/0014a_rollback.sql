-- Rollback of 0014a: restores the tenant policies and membership helpers of
-- 0001–0011 exactly as they were, then removes has_permission, the
-- permission catalog and memberships.status. Emergency use only.
--
-- Refuses to run (nothing changed) once E4 is in use: a suspended
-- membership or the invitations table means 0014b has been applied, and
-- dropping memberships.status would silently re-activate suspended users.
-- No business data is touched.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.invitations') is not null then
    raise exception 'BA0014a rollback: 0014b is applied (public.invitations exists); roll it back first. Nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'memberships' and column_name = 'status')
     and exists (select 1 from public.memberships where status <> 'active') then
    raise exception 'BA0014a rollback: suspended memberships exist; nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------- policies as in 0001–0011
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies for select to authenticated
  using (public.is_company_member(id));
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies for update to authenticated
  using (public.has_company_role(id, array['owner','admin']))
  with check (public.has_company_role(id, array['owner','admin']));

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.is_company_member(company_id));

drop policy if exists company_profiles_select on public.company_profiles;
create policy company_profiles_select on public.company_profiles for select to authenticated
  using (public.is_company_member(company_id));
drop policy if exists company_profiles_insert on public.company_profiles;
create policy company_profiles_insert on public.company_profiles for insert to authenticated
  with check (public.has_company_role(company_id, array['owner', 'admin']));
drop policy if exists company_profiles_update on public.company_profiles;
create policy company_profiles_update on public.company_profiles for update to authenticated
  using (public.has_company_role(company_id, array['owner', 'admin']))
  with check (public.has_company_role(company_id, array['owner', 'admin']));

drop policy if exists company_subscriptions_select on public.company_subscriptions;
create policy company_subscriptions_select on public.company_subscriptions for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists audit_select_company on public.document_deletion_audit;
create policy audit_select_company on public.document_deletion_audit for select to authenticated
  using (exists (select 1 from public.memberships m
         where m.company_id = document_deletion_audit.company_id and m.user_id = auth.uid()));
drop policy if exists audit_insert_company on public.document_deletion_audit;
create policy audit_insert_company on public.document_deletion_audit for insert to authenticated
  with check ((deleted_by = auth.uid()) and (exists (select 1 from public.memberships m
              where m.company_id = document_deletion_audit.company_id and m.user_id = auth.uid())));

drop policy if exists ba_clients_select on public.clients;
create policy ba_clients_select on public.clients for select to authenticated
  using (public.is_company_member(company_id));
drop policy if exists ba_clients_insert on public.clients;
create policy ba_clients_insert on public.clients for insert to authenticated
  with check (public.is_company_member(company_id));
drop policy if exists ba_clients_update on public.clients;
create policy ba_clients_update on public.clients for update to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));
drop policy if exists ba_clients_delete on public.clients;
create policy ba_clients_delete on public.clients for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'admin']));

drop policy if exists ba_documents_select on public.documents;
create policy ba_documents_select on public.documents for select to authenticated
  using (public.is_company_member(company_id));
drop policy if exists ba_documents_insert on public.documents;
create policy ba_documents_insert on public.documents for insert to authenticated
  with check (
    public.is_company_member(company_id)
    and (created_by is null or created_by = (select auth.uid()))
    and (client_id is null or exists (
      select 1 from public.clients c
      where c.id = client_id and c.company_id = documents.company_id))
  );
drop policy if exists ba_documents_update on public.documents;
create policy ba_documents_update on public.documents for update to authenticated
  using (public.is_company_member(company_id))
  with check (
    public.is_company_member(company_id)
    and (client_id is null or exists (
      select 1 from public.clients c
      where c.id = client_id and c.company_id = documents.company_id))
  );
drop policy if exists ba_documents_delete on public.documents;
create policy ba_documents_delete on public.documents for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'admin']));

drop policy if exists ba_payments_select on public.payments;
create policy ba_payments_select on public.payments for select to authenticated
  using (public.is_company_member(company_id));
drop policy if exists ba_payments_insert on public.payments;
create policy ba_payments_insert on public.payments for insert to authenticated
  with check (
    public.is_company_member(company_id)
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.documents d
      where d.id = document_id and d.company_id = payments.company_id)
  );

drop policy if exists ba_company_assets_select on storage.objects;
create policy ba_company_assets_select on storage.objects for select to authenticated
  using (bucket_id = 'Company-assets'
         and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']));
drop policy if exists ba_company_assets_insert on storage.objects;
create policy ba_company_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'Company-assets'
              and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']));

drop policy if exists ba_company_signatures_select on storage.objects;
create policy ba_company_signatures_select on storage.objects for select to authenticated
  using (bucket_id = 'Company-signatures'
         and public.is_company_member(public.storage_company_id(name)));
drop policy if exists ba_company_signatures_insert on storage.objects;
create policy ba_company_signatures_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'Company-signatures'
              and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']));
drop policy if exists ba_company_signatures_delete on storage.objects;
create policy ba_company_signatures_delete on storage.objects for delete to authenticated
  using (bucket_id = 'Company-signatures'
         and public.has_company_role(public.storage_company_id(name), array['owner', 'admin']));

-- ------------------------------------------- helpers as in 0001 (no status)
create or replace function public.is_company_member(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.company_id = target and m.user_id = (select auth.uid()));
$$;

create or replace function public.has_company_role(target uuid, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.company_id = target and m.user_id = (select auth.uid())
                   and m.role = any (roles));
$$;

-- ------------------------------------------------------ remove 0014a objects
drop function if exists public.has_permission(uuid, text);
drop table if exists public.role_permissions;
drop table if exists public.permissions;
alter table public.memberships drop constraint if exists memberships_status_check;
alter table public.memberships drop column if exists status;

commit;
