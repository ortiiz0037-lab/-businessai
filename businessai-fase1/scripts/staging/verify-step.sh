#!/usr/bin/env bash
# =====================================================================
# Read-only checks after ONE of the drafts 0037–0045 was applied to STAGING
# (label staging:migrate-00NN in .github/workflows/staging.yml).
# Writes nothing: every query runs with default_transaction_read_only=on.
#   * the permission matrix (role_permissions) has the size expected after this step
#     (130 → 130 → 135 → 135 → 135 → 135 → 143 → 153 → 153, docs/STAGING_STATUS.md §8);
#   * the main objects of this migration exist (and, for 0042, the private
#     Banking-evidence bucket with its 3 policies; for 0045, no write on the deletion
#     audit for anon / authenticated, the issue snapshot trigger and the record of the
#     revoked grants that its rollback uses);
#   * business row counts are printed for the record (not changed by migrations).
# Usage: STAGING_DB_URL=… EXPECT_STAGING_REF=<staging ref> PRODUCTION_PROJECT_REF=<prod ref> \
#        bash scripts/staging/verify-step.sh 0037_studio_branches
# A failure stops the workflow run but does NOT roll back the migration (rollback is a
# separate, owner-approved decision: docs/STAGING_STATUS.md §8 D).
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/verify-lib.sh"
step="${1:-}"
strict_staging_url "${STAGING_DB_URL:-}" "${EXPECT_STAGING_REF:-}" "${PRODUCTION_PROJECT_REF:-}" || exit 1
ro() { PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 psql "$STAGING_DB_URL" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }

# expected matrix size and the objects that must exist after each step
case "$step" in
  0037_studio_branches)        matrix=130; objs="column:studio_documents.branch_id function:studio_set_branch" ;;
  0038_studio_finance)         matrix=130; objs="column:studio_documents.bill_payment_id function:studio_set_finance_link" ;;
  0039_catalog)                matrix=135; objs="table:catalog_items table:catalog_events" ;;
  0040_assistant_finance)      matrix=135; objs="" ;;   # widens a check constraint: covered by inspect_migration_state
  0041_studio_advanced)        matrix=135; objs="function:studio_valid_page" ;;
  0042_banking)                matrix=135; objs="table:bank_connections table:receipt_captures" ;;
  0043_inventory)              matrix=143; objs="table:inventory_movements table:purchase_orders" ;;
  0044_pos)                    matrix=153; objs="table:pos_sales table:pos_integrations" ;;
  0045_platform_stabilization) matrix=153; objs="table:account_deletion_requests function:document_issue_snapshot" ;;
  *) echo "ERROR: unknown step '$step' (expected one of 0037_studio_branches … 0045_platform_stabilization)"; exit 1 ;;
esac

fail=0
ok() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; else fail=1; echo "FAIL: $3 (got '$1', want '$2')"; fi; }
recorded="$(ro -c "select count(*) from ba_meta.applied_migrations where name = '$step'")" || { echo "ERROR: cannot read the migration record"; exit 1; }
ok "$recorded" 1 "$step is recorded in ba_meta.applied_migrations"
ok "$(ro -c "select count(*) from public.role_permissions")" "$matrix" "permission matrix: $matrix rows"
for o in $objs; do
  kind=${o%%:*}; name=${o#*:}
  case "$kind" in
    table)    q="select to_regclass('public.$name') is not null" ;;
    function) q="select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '$name')" ;;
    column)   q="select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${name%%.*}' and column_name = '${name#*.}')" ;;
  esac
  ok "$(ro -c "$q")" t "$kind $name exists"
done
if (( 10#${step:0:4} >= 42 )); then
  ok "$(ro -c "select coalesce((select public::text from storage.buckets where id = 'Banking-evidence'), 'missing')")" false "bucket Banking-evidence exists and is private"
  ok "$(ro -c "select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%Banking-evidence%'")" 3 "Banking-evidence has its 3 storage policies"
fi
if [[ "$step" == 0045_platform_stabilization ]]; then
  ok "$(ro -c "select has_table_privilege('anon', 'public.document_deletion_audit', 'INSERT') or has_table_privilege('anon', 'public.document_deletion_audit', 'DELETE') or has_table_privilege('authenticated', 'public.document_deletion_audit', 'DELETE')")" f "deletion audit: no write for anon / authenticated"
  ok "$(ro -c "select count(*) from pg_trigger where tgname = 'ba_snapshot_document_issue'")" 1 "issue snapshot trigger present"
  ok "$(ro -c "select to_regclass('ba_private.s9_revoked_audit_grants') is not null")" t "record of the revoked audit grants present (used by its rollback)"
fi
echo "rows (companies, memberships, clients, documents, payments): $(ro -c "select concat_ws(',', (select count(*) from public.companies), (select count(*) from public.memberships), (select count(*) from public.clients), (select count(*) from public.documents), (select count(*) from public.payments))")"
[[ $fail -eq 0 ]] && echo "OK: $step verified (read-only)" || echo "STOPPED: $step verification failed. It is NOT rolled back automatically."
exit $fail
