#!/usr/bin/env bash
# =====================================================================
# Post-migration checks for 0036 on STAGING, leaving NOTHING behind:
#   1. counts of business rows + catalog fingerprint (before)
#   2. the SQL suites run on the real staging schema, each inside ONE
#      transaction that is ROLLED BACK (fixture companies, users and
#      employees never persist; existing rows are never touched):
#        108_workforce_access  — the employee link flow («Vincular y ponchar»)
#        102_workforce_hr      — workforce permissions: roles, supervisors,
#                                isolation, documents, rules (with 0036 in place)
#      (80_workforce is not run here: its fixture reuses fixed user ids that a
#       populated database may already have; it runs in the local harness.)
#   3. counts + fingerprint again (after): must be identical.
# Usage: STAGING_DB_URL=… bash scripts/staging/verify-0036.sh
# Refuses anything that is not the pinned staging project (EXPECT_STAGING_REF).
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); sb="$here/../../supabase"
: "${STAGING_DB_URL:?STAGING_DB_URL is required}"
: "${EXPECT_STAGING_REF:?EXPECT_STAGING_REF is required}"
[[ "$STAGING_DB_URL" == *"$EXPECT_STAGING_REF"* ]] || { echo "ERROR: STAGING_DB_URL is not the pinned staging project"; exit 1; }
[[ -z "${PRODUCTION_PROJECT_REF:-}" || "$STAGING_DB_URL" != *"$PRODUCTION_PROJECT_REF"* ]] || { echo "ERROR: STAGING_DB_URL points at PRODUCTION"; exit 1; }
p() { PGCONNECT_TIMEOUT=15 psql "$STAGING_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
ro() { PGOPTIONS='-c default_transaction_read_only=on' p -tA "$@"; }
COUNTS="select concat_ws(',', (select count(*) from public.companies), (select count(*) from public.memberships), (select count(*) from auth.users),
  (select count(*) from public.employees), (select count(*) from public.employees where user_id is not null), (select count(*) from public.employees where access_token_hash is not null),
  (select count(*) from public.workforce_events), (select count(*) from public.time_punches), (select count(*) from public.employee_access_uses),
  (select count(*) from public.clients), (select count(*) from public.documents), (select count(*) from public.payments))"
fail=0
before_counts="$(ro -c "$COUNTS")" || { echo "ERROR: cannot read the counts"; exit 1; }
before_fp="$(ro -f "$sb/tests/local/catalog_fingerprint.sql" | sha256sum | cut -c1-16)"
echo "before: rows (companies,memberships,users,employees,linked,pending_links,wf_events,punches,used_links,clients,documents,payments) = $before_counts"
for t in "108_workforce_access:ALL WORKFORCE ACCESS TESTS PASSED" "102_workforce_hr:ALL WORKFORCE HR TESTS PASSED"; do
  f="$sb/tests/local/${t%%:*}.test.sql"
  out="$(printf 'begin;\n\\i %s\nrollback;\n' "$f" | PGOPTIONS='-c client_min_messages=notice' p 2>&1)"; rc=$?
  n_pass=$(grep -c 'PASS:' <<<"$out"); n_fail=$(grep -c 'FAIL:' <<<"$out")
  if [[ $rc -eq 0 && $n_fail -eq 0 ]] && grep -q "${t#*:}" <<<"$out"; then echo "PASS: ${t%%:*} on staging (rolled back): $n_pass assertions"
  else fail=1; echo "FAIL: ${t%%:*} on staging (rolled back): rc=$rc pass=$n_pass fail=$n_fail"; grep -E 'FAIL:|ERROR' <<<"$out" | head -8; fi
done
after_counts="$(ro -c "$COUNTS")"; after_fp="$(ro -f "$sb/tests/local/catalog_fingerprint.sql" | sha256sum | cut -c1-16)"
echo "after:  rows = $after_counts"
[[ "$before_counts" == "$after_counts" ]] && echo "PASS: no row added, changed or removed (counts identical)" || { fail=1; echo "FAIL: row counts changed"; }
[[ "$before_fp" == "$after_fp" ]] && echo "PASS: catalog identical before/after the tests ($after_fp)" || { fail=1; echo "FAIL: catalog changed"; }
exit $fail
