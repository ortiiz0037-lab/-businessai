#!/usr/bin/env bash
# =====================================================================
# READ-ONLY reinspection of PRODUCTION (pinned project rugqcumiuqrjbfwpuslm) before any migration:
# docs/PRODUCTION_MIGRATION_PLAN.md §4. Every session is read-only (default_transaction_read_only=on) and
# only the supabase/inspect/*.sql queries run. Nothing is written to Production.
#
# Nothing is stored: no file is written (outputs stay in shell variables and pipes) and nothing is uploaded.
# The log shows ONLY PASS/FAIL lines and BLOCKER lines (yes/no findings) — no counts of companies, subscriptions
# or plans, and never names, emails, identifiers, amounts, rows, table or column definitions, policy text or code.
#
# Checks (all must PASS before a migration is proposed):
#   1. migration state: 0001–0004 applied, 0005 … 0045 not applied, nothing PARTIAL, no Staging bookkeeping
#      → the next migration is 0005_security_baseline;
#   2. security baseline identical to the inspection of 2026-11-08 (PASS/FAIL only);
#   3. 0007 preview: dropped=11, guard_failures=0, kept_non_ba=0, ba=0, stop=0;
#   4. relationship integrity: the 4 cross-company counts are 0;
#   5. 0010 impact: no subscription breaks 0010's plan key (PASS/FAIL); whether existing companies would lose
#      creation rights or are at plan limits is reported as a yes/no BLOCKER for the owner's decision, no counts;
#   6. verify_after_migrations baseline 0,12,4,2,t,12,11,0,,,f,t.
# Env: PRODUCTION_DB_URL, [PG_BIN].
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/lib.sh"
ROOT=$(cd "$here/../.." && pwd); INS="$ROOT/supabase/inspect"
strict_production_url "${PRODUCTION_DB_URL:-}" || exit 1
PG_BIN=${PG_BIN:-$(dirname "$(command -v psql)")}
ro()  { PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/psql" "$PRODUCTION_DB_URL" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
roh() { PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/psql" "$PRODUCTION_DB_URL" -X -q -A -P footer=off -v ON_ERROR_STOP=1 "$@"; }
# value of column NAME in the first data row of a headed, '|' separated output given on stdin
col() { awk -F'|' -v c="$1" 'NR==1{for(i=1;i<=NF;i++) if($i==c) k=i; next} k{print $k; exit}'; }
fail=0
# PASS/FAIL only: the measured value is never printed
ok() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; else fail=1; echo "FAIL: $3"; fi; }

echo "== 0. Connection (read-only)"
ro -c "select 1" >/dev/null || { echo "ERROR: cannot connect (read-only) to the Production database"; exit 1; }
echo "PASS: connected read-only to the pinned Production project"

echo "== 1. Migration state"
state="$(ro -f "$INS/inspect_migration_state.sql")" || { echo "ERROR: inspect_migration_state failed"; exit 1; }
ok "$(next_migration <<<"$state")" 0005_security_baseline "0001–0004 applied, nothing else, nothing PARTIAL, no Staging bookkeeping → next is 0005"

echo "== 2. Security baseline vs the inspection of 2026-11-08"
summary="$(ro -f "$INS/inspect_security_baseline.sql" | python3 -I "$ROOT/supabase/tests/local/compare_fixture.py" /dev/stdin "$ROOT/supabase/tests/local/inspected_expectations.json" 2>/dev/null | tail -1)"
[[ "$summary" =~ ^([0-9]+)/([0-9]+)\ fidelity ]] && ok "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "security baseline identical to the inspection of 2026-11-08 (details not printed)" \
  || { fail=1; echo "FAIL: the security baseline could not be compared"; }

echo "== 3. 0007 preview (Storage policies)"
ok "$(ro -f "$INS/inspect_0007_preview.sql" | grep '^summary|' | grep -oE 'dropped=[0-9]+, guard_failures=[0-9]+, kept_non_ba=[0-9]+, ba=[0-9]+, stop=[0-9]+' | head -1)" \
   "dropped=11, guard_failures=0, kept_non_ba=0, ba=0, stop=0" "0007 would drop exactly the 11 inspected policies, none fails its guard"

echo "== 4. Relationship integrity (PASS/FAIL)"
rel="$(roh -f "$INS/inspect_relationship_integrity.sql")" || { echo "ERROR: inspect_relationship_integrity failed"; exit 1; }
for c in documents_with_client_of_other_company payments_with_document_of_other_company payments_without_created_by payments_by_non_member; do
  ok "$(col "$c" <<<"$rel")" 0 "$c: none"
done

echo "== 5. Companies and subscriptions — impact of 0010 / 0011 (yes/no only, no counts)"
imp="$(roh -f "$INS/inspect_0010_impact.sql")" || { echo "ERROR: inspect_0010_impact failed"; exit 1; }
num() { local v; v="$(col "$1" <<<"$imp")"; [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo -1; }
ok "$(( $(num plans_breaking_0010_fk) == 0 ))" 1 "no subscription would break 0010's plan foreign key"
blockers=0
yesno() { local n; n=$(num "$1"); if (( n < 0 )); then fail=1; echo "FAIL: $2 (could not be read)"; elif (( n > 0 )); then blockers=1; echo "BLOCKER: $2"; else echo "PASS: no — $2"; fi; }
yesno blocked_after_0010 "existing companies would lose the ability to create clients/documents after 0010 (owner decision: docs/PRODUCTION_GRACE_OPTIONS.md)"
yesno at_client_limit "companies already at their plan's client limit"
yesno at_document_limit_this_month "companies already at their plan's monthly document limit"
yesno over_member_limit_0011 "companies above their plan's member limit after 0011"
(( blockers == 0 )) || echo "Phase 2 (0010 onwards) needs the owner's decision above; phase 1 (0005–0009) is not affected."

echo "== 6. verify_after_migrations baseline"
ok "$( [[ "$(ro -f "$INS/verify_after_migrations.sql" | tr '|' ',')" == "$VERIFY_BASELINE" ]] && echo match || echo differs)" match "verification baseline before 0005 (supabase/RUNBOOK.md §3)"

[[ $fail -eq 0 ]] && echo "OK: Production matches the inspection; next migration 0005_security_baseline" || echo "STOPPED: Production differs from the inspection: review before any migration"
exit $fail
