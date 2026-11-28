-- Rollback of 0009: removes the signature policies and restores the
-- inspected Company-assets setting (allowed_mime_types = any type).
-- The Company-signatures bucket is NOT deleted: it may hold signatures.
-- With its policies gone nobody but service_role can read or write it.
-- Deleting it (only if empty) is a manual Dashboard step.
-- Emergency use only.
begin;
set local lock_timeout = '5s';
drop policy if exists ba_company_signatures_select on storage.objects;
drop policy if exists ba_company_signatures_insert on storage.objects;
drop policy if exists ba_company_signatures_delete on storage.objects;
update storage.buckets set allowed_mime_types = null where id = 'Company-assets';
commit;
