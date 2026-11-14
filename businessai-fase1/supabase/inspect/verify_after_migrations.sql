-- =====================================================================
-- BusinessAI · Read-only verification after each migration step
-- =====================================================================
-- ONE single SELECT over system catalogs (no table rows). Run after each
-- step of supabase/RUNBOOK.md and compare with the "expected" column there.
-- =====================================================================

select
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('clients', 'documents', 'payments')
      and policyname like 'ba\_%')                                        as ba_table_policies,       -- 0005: 10
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('clients', 'documents', 'payments')
      and policyname not like 'ba\_%')                                    as old_table_policies,      -- 0005: 0
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'document_deletion_audit') as audit_policies,         -- 0005: 2
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'payments'
      and cmd in ('UPDATE', 'DELETE', 'ALL'))                             as payment_edit_policies,   -- 0005: 0
  has_table_privilege('authenticated', 'public.payments', 'UPDATE')
    or has_table_privilege('authenticated', 'public.payments', 'DELETE') as payments_editable,       -- 0005: false
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) r(role_name)
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and has_table_privilege(r.role_name, c.oid, 'TRUNCATE'))            as truncate_grants,         -- 0005: 0
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%company-assets%')
                                                                          as logo_bucket_policies,    -- 0007: 2
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'ba\_company\_signatures\_%')                 as signature_policies,      -- 0009: 3
  (select public = false from storage.buckets where id = 'Company-signatures')
                                                                          as signatures_bucket_private, -- 0009: true
  (select allowed_mime_types from storage.buckets where id = 'Company-assets')
    = array['image/png', 'image/jpeg', 'image/webp']                       as logo_types_limited,      -- 0009: true
  (select confdeltype = 'a' from pg_constraint
    where conname = 'payments_document_id_fkey'
      and conrelid = 'public.payments'::regclass)                         as payments_fk_no_action,   -- 0006: true
  -- NULL where the function does not exist (staging/local).
  has_function_privilege('anon', to_regprocedure('public.can_edit_company_profile(uuid)'), 'EXECUTE')
                                                                          as anon_can_edit_fn;        -- 0008: false
