#!/usr/bin/env bash
# =====================================================================
# ONE migration on PRODUCTION (pinned project rugqcumiuqrjbfwpuslm) — called by
# .github/workflows/production-migrate.yml after the owner approved the run in the GitHub
# Environment "production" and after a verified, encrypted backup (backup.sh) of this very moment.
#
#   MODE=plan   READ-ONLY: works out the next migration from the catalog (inspect_migration_state.sql)
#               and checks it is exactly TARGET. Prints what --apply would run. Writes nothing.
#   MODE=apply  same checks, then runs supabase/migrations/TARGET.sql (one file = one transaction with
#               lock_timeout 5 s: a failure changes nothing), then verifies: TARGET now applied, every
#               later migration still not applied, nothing PARTIAL, the business tables' CONTENT checksums
#               unchanged, and the step-specific checks. A failed verification does NOT roll back
#               (rollback is a separate owner decision: supabase/RUNBOOK.md §10).
# Production has no record table: the state is read from what each migration leaves in the catalog, so
# no Staging-only object (ba_meta) is ever created here.
# Phase 2 (0010 onwards) also needs PHASE2_DECISION (owner decision on companies without a subscription,
# docs/PRODUCTION_GRACE_OPTIONS.md): "a" (apply with Stripe LIVE ready) or "b" (grace period, once its own
# migration exists and was applied) — otherwise it refuses. Postponing (option c) simply means no phase 2 run.
# Env: PRODUCTION_DB_URL, TARGET, MODE, [PHASE2_DECISION], [PG_BIN]. Prints no data, no URL.
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/lib.sh"
ROOT=$(cd "$here/../.." && pwd)
strict_production_url "${PRODUCTION_DB_URL:-}" || exit 1
TARGET="${TARGET:-}"; MODE="${MODE:-plan}"
[[ "$MODE" == plan || "$MODE" == apply ]] || { echo "ERROR: MODE must be plan or apply"; exit 1; }
prod_order | grep -qx -- "$TARGET" || { echo "ERROR: '$TARGET' is not a Production migration (0005 … 0045 in ORDER)"; exit 1; }
file="$ROOT/supabase/migrations/$TARGET.sql"; [[ -f "$file" ]] || { echo "ERROR: $TARGET.sql not found"; exit 1; }
if ! is_phase1 "$TARGET"; then
  case "${PHASE2_DECISION:-}" in
    a) ;;
    b) [[ -n "$(ls "$ROOT"/supabase/migrations/*grace*.sql 2>/dev/null)" ]] || { echo "ERROR: decision b (grace period) needs its reviewed grace migration first; none exists yet. Nothing was done."; exit 1; } ;;
    *) echo "ERROR: $TARGET is phase 2: it needs the owner's decision on companies without a subscription (PHASE2_DECISION = a or b; see docs/PRODUCTION_GRACE_OPTIONS.md). Nothing was done."; exit 1 ;;
  esac
fi
PG_BIN=${PG_BIN:-$(dirname "$(command -v psql)")}
ro() { PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/psql" "$PRODUCTION_DB_URL" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
fail=0
ok() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; else fail=1; echo "FAIL: $3 (got '$1', want '$2')"; fi; }

echo "== 1. Where Production stands (read-only)"
state="$(ro -f "$ROOT/supabase/inspect/inspect_migration_state.sql")" || { echo "ERROR: cannot read the migration state (read-only)"; exit 1; }
next="$(next_migration <<<"$state")" || { echo "$next"; echo "Nothing was done."; exit 1; }
echo "next migration in ORDER: $next"
ok "$next" "$TARGET" "the requested migration is exactly the next one"
[[ $fail -eq 0 ]] || { echo "STOPPED: $TARGET is not the next migration. Nothing was done."; exit 1; }
echo "file: $TARGET.sql · sha256 $(sha256sum "$file" | cut -c1-16) · $(wc -l < "$file") lines · phase $(is_phase1 "$TARGET" && echo 1 || echo 2)"
if [[ "$MODE" == plan ]]; then echo "PLAN ONLY — nothing was written. --apply would run exactly $TARGET.sql in one transaction."; exit 0; fi

echo "== 2. Apply $TARGET (one transaction)"
snapshot_cols && before="$(checksums)" || { echo "ERROR: cannot checksum the business tables"; exit 1; }
PGCONNECT_TIMEOUT=15 "$PG_BIN/psql" "$PRODUCTION_DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$file" > /tmp/ba-prod-apply.out 2>&1
rc=$?
grep -oE 'BA[0-9a-z]+[^"]*' /tmp/ba-prod-apply.out | head -5 | sed 's/^/    /'
rm -f /tmp/ba-prod-apply.out
[[ $rc -eq 0 ]] || { echo "STOPPED: $TARGET failed (exit $rc). The transaction was rolled back: nothing changed."; exit 1; }
echo "PASS: $TARGET committed"

echo "== 3. Verify (read-only)"
state="$(ro -f "$ROOT/supabase/inspect/inspect_migration_state.sql")" || { echo "ERROR: cannot read the migration state"; exit 1; }
ok "$(awk -F'|' -v m="$TARGET" '$1==m{print $2}' <<<"$state")" applied "$TARGET detected as applied"
after_next="$(next_migration <<<"$state")"; rc=$?
ok "$rc" 0 "state is still a clean prefix of the order (nothing PARTIAL, nothing later applied): next is $after_next"
after="$(checksums)"
ok "$(diff <(echo "$before") <(echo "$after") | grep -c '^[<>]')" 0 "existing companies, members, profiles, subscriptions, clients, documents, payments and users unchanged (row count + content checksum)"
case "$TARGET" in
  0005_security_baseline|0006_payments_document_fk|0007_storage_company_assets|0008_definer_function_grants|0009_private_signatures)
    echo "verify_after_migrations: $(ro -f "$ROOT/supabase/inspect/verify_after_migrations.sql" | tr '\n' ' ') (compare with supabase/RUNBOOK.md §3 for this step)" ;;
  0014a_permissions) ok "$(ro -f "$ROOT/supabase/inspect/verify_0014a.sql" | tail -1)" OK "verify_0014a" ;;
esac
declare -A MATRIX=([0037_studio_branches]=130 [0038_studio_finance]=130 [0039_catalog]=135 [0040_assistant_finance]=135 [0041_studio_advanced]=135 [0042_banking]=135 [0043_inventory]=143 [0044_pos]=153 [0045_platform_stabilization]=153)
[[ -n "${MATRIX[$TARGET]:-}" ]] && ok "$(ro -c "select count(*) from public.role_permissions")" "${MATRIX[$TARGET]}" "permission matrix: ${MATRIX[$TARGET]} rows"
[[ $fail -eq 0 ]] && echo "OK: $TARGET applied and verified on Production" || echo "STOPPED: $TARGET verification failed. It is NOT rolled back automatically: review (supabase/RUNBOOK.md §10)."
exit $fail
