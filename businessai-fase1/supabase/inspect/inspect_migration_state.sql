-- =====================================================================
-- READ-ONLY: which repository migrations are REALLY applied (any project).
-- =====================================================================
-- Production has no record table: migrations there are pasted in the SQL
-- Editor, so ba_meta.applied_migrations (staging only) does not exist. This
-- query decides from what each migration leaves in the catalog instead.
--
-- One SELECT on system catalogs (pg_policies, pg_proc, pg_trigger,
-- pg_constraint, information_schema, storage.buckets). No table rows, no
-- writes. It works whatever is applied: tables that may not exist are only
-- looked up by name (to_regclass / to_regprocedure), never queried.
--
-- One row per migration (0001–0004 together, then 0005 … 0029):
--   status   applied | not applied | PARTIAL — review | n/a
--   evidence what was measured (counts, flags) — compare it with the
--            "applied when" column.
-- A PARTIAL row means the catalog matches neither state: STOP and review
-- before deciding any order (supabase/RUNBOOK.md §8).
-- =====================================================================
with
e as (
  select
    -- 0001–0004 (base schema)
    to_regclass('public.companies') is not null           as t_companies,
    to_regclass('public.memberships') is not null         as t_memberships,
    to_regclass('public.company_profiles') is not null    as t_profiles,
    to_regclass('public.company_subscriptions') is not null as t_subscriptions,
    to_regclass('public.clients') is not null             as t_clients,
    to_regprocedure('public.is_company_member(uuid)') is not null as f_member,
    -- 0005
    (select count(*) from pg_policies where schemaname = 'public'
       and tablename in ('clients', 'documents', 'payments') and policyname like 'ba\_%') as ba_table,
    (select count(*) from pg_policies where schemaname = 'public'
       and tablename in ('clients', 'documents', 'payments') and policyname not like 'ba\_%') as old_table,
    -- 0006
    (select confdeltype::text from pg_constraint
      where conname = 'payments_document_id_fkey' and conrelid = to_regclass('public.payments')) as fk_del,
    -- 0007
    (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and policyname in ('ba_company_assets_select', 'ba_company_assets_insert')) as ba_assets,
    (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and policyname not like 'ba\_%'
       and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%company-assets%') as old_assets,
    -- 0008
    case when to_regprocedure('public.can_edit_company_profile(uuid)') is null then null
         else has_function_privilege('anon', to_regprocedure('public.can_edit_company_profile(uuid)'), 'EXECUTE') end
      as anon_edit_fn,
    -- 0009
    (select public from storage.buckets where id = 'Company-signatures') as sig_public,
    (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'ba\_company\_signatures\_%') as ba_sig,
    (select allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
       from storage.buckets where id = 'Company-assets') as logo_types,
    -- 0010
    to_regclass('public.billing_plans') is not null   as t_plans,
    to_regclass('public.billing_config') is not null  as t_config,
    to_regprocedure('public.company_billing_state(uuid)') is not null as f_state,
    (select count(*) from pg_trigger where not tgisinternal
       and tgname in ('ba_enforce_billing_clients', 'ba_enforce_billing_documents', 'ba_keep_trial_consumed')) as billing_trg,
    exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'company_subscriptions' and column_name = 'trial_consumed_at') as c_trial,
    -- 0011
    to_regprocedure('public.company_usage(uuid)') is not null as f_usage,
    to_regprocedure('public.company_usage_window(uuid)') is not null as f_window,
    exists (select 1 from pg_trigger where not tgisinternal and tgname = 'ba_enforce_member_limit') as member_trg,
    exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'billing_config' and column_name = 'usage_warning_percent') as c_thresholds,
    -- 0014a
    to_regclass('public.permissions') is not null      as t_perm,
    to_regclass('public.role_permissions') is not null as t_roleperm,
    to_regprocedure('public.has_permission(uuid, text)') is not null as f_perm,
    exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'memberships' and column_name = 'status') as c_status,
    (select count(*) from pg_policies
      where ((schemaname = 'public' and tablename in ('companies', 'memberships', 'company_profiles',
               'company_subscriptions', 'document_deletion_audit', 'clients', 'documents', 'payments'))
             or (schemaname = 'storage' and tablename = 'objects' and policyname like 'ba\_company\_%'))
        and coalesce(qual, '') || coalesce(with_check, '') like '%has_permission(%') as perm_policies,
    -- 0015
    to_regclass('public.document_counters') is not null as t_counters,
    (select count(*) from pg_trigger where not tgisinternal and tgname in
       ('ba_assign_document_number', 'ba_protect_issued_documents', 'ba_check_receipt',
        'ba_check_payment', 'ba_settle_invoice', 'ba_check_document_insert', 'ba_log_document_event')) as lifecycle_trg,
    to_regclass('public.document_events') is not null as t_events,
    exists (select 1 from pg_constraint where conname = 'documents_status_check'
              and conrelid = to_regclass('public.documents')
              and pg_get_constraintdef(oid) ilike '%accepted%') as c_quote_status,
    -- 0016
    to_regclass('public.trial_claims') is not null as t_claims,
    to_regprocedure('public.claim_trial(uuid, uuid)') is not null as f_claim,
    coalesce(pg_get_functiondef(to_regprocedure('public.enforce_billing_limits()')) like '%new.document_type <> ''receipt''%', false) as receipts_free,
    -- 0017
    to_regclass('public.billing_plan_features') is not null as t_features,
    to_regprocedure('public.company_feature(uuid, text)') is not null as f_feature,
    -- 0018 / 0019
    to_regclass('public.invitations') is not null as t_invitations,
    to_regprocedure('public.accept_invitation(text)') is not null as f_accept,
    to_regclass('public.client_events') is not null as t_client_events,
    exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'documents' and column_name = 'language') as c_language,
    -- 0020
    to_regclass('public.employees') is not null as t_employees,
    to_regprocedure('public.punch(uuid, text, text)') is not null as f_punch,
    -- 0021
    to_regclass('public.time_clock_kiosks') is not null as t_kiosks,
    (select count(*) from pg_trigger where not tgisinternal and tgname = 'ba_wf_append_only') as append_only_trg,
    -- 0022
    to_regclass('public.labor_rule_sets') is not null as t_rule_sets,
    to_regclass('public.meal_alerts') is not null as t_meal_alerts,
    -- 0023
    to_regclass('public.journal_entries') is not null as t_journal,
    to_regclass('public.ledger_accounts') is not null as t_ledger_accounts,
    -- 0024
    to_regclass('public.bills') is not null as t_bills,
    to_regclass('public.vendors') is not null as t_vendors,
    -- 0025
    to_regclass('public.payment_promises') is not null as t_promises,
    to_regclass('public.collection_reminders') is not null as t_reminders,
    -- 0026
    to_regclass('public.bank_accounts') is not null as t_bank_accounts,
    to_regclass('public.bank_reconciliations') is not null as t_bank_recs,
    -- 0027
    to_regclass('public.budgets') is not null as t_budgets,
    to_regprocedure('public.fs_balance_sheet(uuid,date)') is not null as f_balance_sheet,
    -- 0028
    to_regclass('public.studio_documents') is not null as t_studio,
    to_regprocedure('public.studio_finalize(uuid,integer,jsonb)') is not null as f_studio_finalize,
    -- 0029
    to_regclass('public.assistant_actions') is not null as t_assistant,
    to_regprocedure('public.assistant_decide_action(uuid,text)') is not null as f_assistant_decide,
    -- staging bookkeeping (absent in Production)
    to_regclass('ba_meta.applied_migrations') is not null as t_record,
    to_regclass('ba_meta.environment') is not null        as t_marker
),
r(ord, migration, applied_when, status, evidence) as (
  select 1, '0001–0004 base schema', 'all base tables and is_company_member exist',
    case when t_companies and t_memberships and t_profiles and t_subscriptions and t_clients and f_member then 'applied'
         when not (t_companies or t_memberships) then 'not applied' else 'PARTIAL — review' end,
    format('companies=%s memberships=%s company_profiles=%s company_subscriptions=%s clients=%s is_company_member=%s',
           t_companies, t_memberships, t_profiles, t_subscriptions, t_clients, f_member)
  from e
  union all
  select 2, '0005_security_baseline', 'ba_ table policies = 10 and old ones = 0',
    case when ba_table = 10 and old_table = 0 then 'applied'
         when ba_table = 0 then 'not applied' else 'PARTIAL — review' end,
    format('ba_table_policies=%s old_table_policies=%s (inspected Production: 0 / 12)', ba_table, old_table)
  from e
  union all
  select 3, '0006_payments_document_fk', 'payments_document_id_fkey ON DELETE NO ACTION (a)',
    case fk_del when 'a' then 'applied' when 'c' then 'not applied' else 'PARTIAL — review' end,
    format('confdeltype=%s (a = no action, c = cascade; inspected Production: c)', coalesce(fk_del, 'missing'))
  from e
  union all
  select 4, '0007_storage_company_assets', '2 ba_company_assets_* and 0 old company-assets policies',
    case when ba_assets = 2 and old_assets = 0 then 'applied'
         when ba_assets = 0 then 'not applied' else 'PARTIAL — review' end,
    format('ba_company_assets=%s old_company_assets_policies=%s (inspected Production: 0 / 11)', ba_assets, old_assets)
  from e
  union all
  select 5, '0008_definer_function_grants', 'anon cannot execute can_edit_company_profile',
    case when anon_edit_fn is null then 'n/a' when anon_edit_fn then 'not applied' else 'applied' end,
    format('anon_can_execute=%s (NULL = function absent; inspected Production: true)', coalesce(anon_edit_fn::text, 'NULL'))
  from e
  union all
  select 6, '0009_private_signatures', 'Company-signatures private + 3 ba_ policies + logo types limited',
    case when sig_public = false and ba_sig = 3 and logo_types then 'applied'
         when sig_public is null and ba_sig = 0 and not coalesce(logo_types, false) then 'not applied'
         else 'PARTIAL — review' end,
    format('signatures_bucket_public=%s ba_signature_policies=%s logo_types_limited=%s',
           coalesce(sig_public::text, 'no bucket'), ba_sig, coalesce(logo_types::text, 'NULL'))
  from e
  union all
  select 7, '0010_billing', 'plans + config + company_billing_state + 3 triggers + trial columns',
    case when t_plans and t_config and f_state and billing_trg = 3 and c_trial then 'applied'
         when not (t_plans or t_config or f_state or c_trial) and billing_trg = 0 then 'not applied'
         else 'PARTIAL — review' end,
    format('billing_plans=%s billing_config=%s company_billing_state=%s triggers=%s/3 trial_consumed_at=%s',
           t_plans, t_config, f_state, billing_trg, c_trial)
  from e
  union all
  select 8, '0011_usage_limits', 'company_usage + usage window + member trigger + thresholds',
    case when f_usage and f_window and member_trg and c_thresholds then 'applied'
         when not (f_usage or f_window or member_trg or c_thresholds) then 'not applied'
         else 'PARTIAL — review' end,
    format('company_usage=%s company_usage_window=%s member_trigger=%s thresholds=%s',
           f_usage, f_window, member_trg, c_thresholds)
  from e
  union all
  select 9, '0014a_permissions', 'catalog + has_permission + memberships.status + 24 policies on has_permission',
    case when t_perm and t_roleperm and f_perm and c_status and perm_policies = 24 then 'applied'
         when not (t_perm or t_roleperm or f_perm or c_status) and perm_policies = 0 then 'not applied'
         else 'PARTIAL — review' end,
    format('permissions=%s role_permissions=%s has_permission=%s memberships.status=%s policies_on_has_permission=%s/24',
           t_perm, t_roleperm, f_perm, c_status, perm_policies)
  from e
  union all
  select 10, '0015_documents_lifecycle', 'counters table + 7 triggers + accepted/rejected statuses (document_events may outlive a rollback)',
    case when t_counters and lifecycle_trg = 7 and c_quote_status then 'applied'
         when not t_counters and lifecycle_trg = 0 and not c_quote_status then 'not applied'
         else 'PARTIAL — review' end,
    format('document_counters=%s triggers=%s/7 quote_statuses=%s document_events=%s', t_counters, lifecycle_trg, c_quote_status, t_events)
  from e
  union all
  select 11, '0016_billing_hardening', 'trial_claims + claim_trial + receipts outside the quota',
    case when t_claims and f_claim and receipts_free then 'applied'
         when not (t_claims or f_claim or receipts_free) then 'not applied'
         else 'PARTIAL — review' end,
    format('trial_claims=%s claim_trial=%s receipts_outside_quota=%s', t_claims, f_claim, receipts_free)
  from e
  union all
  select 12, '0017_plan_features', 'billing_plan_features + company_feature',
    case when t_features and f_feature then 'applied'
         when not (t_features or f_feature) then 'not applied' else 'PARTIAL — review' end,
    format('billing_plan_features=%s company_feature=%s', t_features, f_feature)
  from e
  union all
  select 13, '0018_team', 'invitations + accept_invitation',
    case when t_invitations and f_accept then 'applied'
         when not (t_invitations or f_accept) then 'not applied' else 'PARTIAL — review' end,
    format('invitations=%s accept_invitation=%s', t_invitations, f_accept)
  from e
  union all
  select 14, '0019_crm', 'client_events + documents.language',
    case when t_client_events and c_language then 'applied'
         when not (t_client_events or c_language) then 'not applied' else 'PARTIAL — review' end,
    format('client_events=%s documents.language=%s', t_client_events, c_language)
  from e
  union all
  select 15, '0020_workforce', 'employees + punch()',
    case when t_employees and f_punch then 'applied'
         when not (t_employees or f_punch) then 'not applied' else 'PARTIAL — review' end,
    format('employees=%s punch=%s', t_employees, f_punch)
  from e
  union all
  select 16, '0021_workforce_kiosk', 'kiosks + 4 append-only triggers',
    case when t_kiosks and append_only_trg = 4 then 'applied'
         when not t_kiosks and append_only_trg = 0 then 'not applied' else 'PARTIAL — review' end,
    format('time_clock_kiosks=%s append_only_triggers=%s/4', t_kiosks, append_only_trg)
  from e
  union all
  select 17, '0022_workforce_rules', 'labor_rule_sets + meal_alerts',
    case when t_rule_sets and t_meal_alerts then 'applied'
         when not (t_rule_sets or t_meal_alerts) then 'not applied' else 'PARTIAL — review' end,
    format('labor_rule_sets=%s meal_alerts=%s', t_rule_sets, t_meal_alerts)
  from e
  union all
  select 18, '0023_ledger', 'ledger_accounts + journal_entries',
    case when t_journal and t_ledger_accounts then 'applied'
         when not (t_journal or t_ledger_accounts) then 'not applied' else 'PARTIAL — review' end,
    format('ledger_accounts=%s journal_entries=%s', t_ledger_accounts, t_journal)
  from e
  union all
  select 19, '0024_payables', 'vendors + bills',
    case when t_bills and t_vendors then 'applied'
         when not (t_bills or t_vendors) then 'not applied' else 'PARTIAL — review' end,
    format('vendors=%s bills=%s', t_vendors, t_bills)
  from e
  union all
  select 20, '0025_receivables', 'payment_promises + collection_reminders',
    case when t_promises and t_reminders then 'applied'
         when not (t_promises or t_reminders) then 'not applied' else 'PARTIAL — review' end,
    format('payment_promises=%s collection_reminders=%s', t_promises, t_reminders)
  from e
  union all
  select 21, '0026_bank_reconciliation', 'bank_accounts + bank_reconciliations',
    case when t_bank_accounts and t_bank_recs then 'applied'
         when not (t_bank_accounts or t_bank_recs) then 'not applied' else 'PARTIAL — review' end,
    format('bank_accounts=%s bank_reconciliations=%s', t_bank_accounts, t_bank_recs)
  from e
  union all
  select 22, '0027_statements_budgets', 'budgets + fs_balance_sheet',
    case when t_budgets and f_balance_sheet then 'applied'
         when not (t_budgets or f_balance_sheet) then 'not applied' else 'PARTIAL — review' end,
    format('budgets=%s fs_balance_sheet=%s', t_budgets, f_balance_sheet)
  from e
  union all
  select 23, '0028_document_studio', 'studio_documents + studio_finalize',
    case when t_studio and f_studio_finalize then 'applied'
         when not (t_studio or f_studio_finalize) then 'not applied' else 'PARTIAL — review' end,
    format('studio_documents=%s studio_finalize=%s', t_studio, f_studio_finalize)
  from e
  union all
  select 24, '0029_assistant', 'assistant_actions + assistant_decide_action',
    case when t_assistant and f_assistant_decide then 'applied'
         when not (t_assistant or f_assistant_decide) then 'not applied' else 'PARTIAL — review' end,
    format('assistant_actions=%s assistant_decide_action=%s', t_assistant, f_assistant_decide)
  from e
  union all
  select 25, 'staging bookkeeping (ba_meta)', 'only in Staging: Production should show false/false',
    case when t_record or t_marker then 'present (staging?)' else 'absent' end,
    format('ba_meta.applied_migrations=%s ba_meta.environment=%s', t_record, t_marker)
  from e
)
select migration, status, evidence, applied_when from r order by ord;
