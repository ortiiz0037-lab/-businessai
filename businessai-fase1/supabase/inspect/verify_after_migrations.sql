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
    where schemaname = 'storage' and tablename = 'objects')               as storage_policies,        -- 0007: 2
  (select confdeltype = 'a' from pg_constraint
    where conname = 'payments_document_id_fkey'
      and conrelid = 'public.payments'::regclass)                         as payments_fk_no_action,   -- 0006: true
  has_function_privilege('anon', 'public.can_edit_company_profile(uuid)', 'EXECUTE')
                                                                          as anon_can_edit_fn;        -- 0008: false
