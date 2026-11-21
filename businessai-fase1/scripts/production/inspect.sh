#!/usr/bin/env bash
# =====================================================================
# READ-ONLY reinspection of PRODUCTION (pinned project rugqcumiuqrjbfwpuslm) before any migration:
# docs/PRODUCTION_MIGRATION_PLAN.md §4. Every session is read-only (default_transaction_read_only=on) and
# only the supabase/inspect/*.sql queries run. Nothing is written to Production.
#
# Checks (all must PASS before a migration is proposed):
#   1. migration state: 0001–0004 applied, 0005 … 0045 not applied, nothing PARTIAL, no Staging bookkeeping
#      → the next migration is 0005_security_baseline;
#   2. security baseline identical to the inspection of 2026-11-08 (supabase/tests/local/inspected_expectations.json:
#      tables, columns, keys, indexes, policies, grants);
#   3. 0007 preview: dropped=11, guard_failures=0, kept_non_ba=0, ba=0, stop=0;
#   4. relationship integrity: no document with another company's client, no payment of another company's
#      document, no payment without author, no payment by a non-member (first 4 values 0);
#   5. 0010 impact: no subscription whose plan would break 0010's foreign key (plans_breaking_0010_fk = 0);
#   6. verify_after_migrations baseline 0,12,4,2,t,12,11,0,,,f,t.
# This repository is PUBLIC: the log shows PASS/FAIL and schema-level differences only. The full outputs
# (which include counts of companies) are kept only ENCRYPTED, when PRODUCTION_BACKUP_PASSPHRASE is set.
# Env: PRODUCTION_DB_URL, OUT_DIR, [BACKUP_PASSPHRASE], [PG_BIN].
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/lib.sh"
ROOT=$(cd "$here/../.." && pwd); INS="$ROOT/supabase/inspect"
strict_production_url "${PRODUCTION_DB_URL:-}" || exit 1
: "${OUT_DIR:?OUT_DIR is required}"; mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
PG_BIN=${PG_BIN:-$(dirname "$(command -v psql)")}
ro()  { PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/psql" "$PRODUCTION_DB_URL" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
roh() { PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/psql" "$PRODUCTION_DB_URL" -X -q -A -P footer=off -v ON_ERROR_STOP=1 "$@"; }
# value of column NAME in the first data row of a headed, '|' separated output
col() { awk -F'|' -v c="$2" 'NR==1{for(i=1;i<=NF;i++) if($i==c) k=i; next} k{print $k; exit}' "$1"; }
fail=0
ok() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; else fail=1; echo "FAIL: $3 (got '$1', want '$2')"; fi; }

echo "== 0. Connection (read-only) and target"
ro -c "select 1" >/dev/null || { echo "ERROR: cannot connect (read-only) to the Production database"; exit 1; }
echo "PASS: connected read-only to the pinned Production project · server $(ro -c 'show server_version')"

echo "== 1. Migration state"
ro -f "$INS/inspect_migration_state.sql" > "$OUT_DIR/migration-state.tsv" || { echo "ERROR: inspect_migration_state failed"; exit 1; }
cut -d'|' -f1,2 "$OUT_DIR/migration-state.tsv" | sed 's/^/    /'
ok "$(next_migration < "$OUT_DIR/migration-state.tsv")" 0005_security_baseline "0001–0004 applied, nothing else, nothing PARTIAL, no Staging bookkeeping → next is 0005"

echo "== 2. Security baseline vs the inspection of 2026-11-08"
ro -f "$INS/inspect_security_baseline.sql" > "$OUT_DIR/security-baseline.json" || { echo "ERROR: inspect_security_baseline failed"; exit 1; }
if out="$(python3 -I "$ROOT/supabase/tests/local/compare_fixture.py" "$OUT_DIR/security-baseline.json" "$ROOT/supabase/tests/local/inspected_expectations.json" 2>&1)"; then
  echo "PASS: tables, columns, keys, indexes, policies and grants identical to the inspection"
else
  fail=1; echo "FAIL: the security baseline differs from the inspection (schema differences, no data):"; echo "$out" | head -20 | sed 's/^/    /'
fi

echo "== 3. 0007 preview (Storage policies)"
ro -f "$INS/inspect_0007_preview.sql" > "$OUT_DIR/0007-preview.tsv" || { echo "ERROR: inspect_0007_preview failed"; exit 1; }
summary="$(grep '^summary|' "$OUT_DIR/0007-preview.tsv" | awk -F'|' '{print $NF}')"
ok "$(grep -oE 'dropped=[0-9]+, guard_failures=[0-9]+, kept_non_ba=[0-9]+, ba=[0-9]+, stop=[0-9]+' <<<"$summary" | head -1)" "dropped=11, guard_failures=0, kept_non_ba=0, ba=0, stop=0" "0007 would drop exactly the 11 inspected policies, none fails its guard"

echo "== 4. Relationship integrity"
roh -f "$INS/inspect_relationship_integrity.sql" > "$OUT_DIR/relationship-integrity.txt" || { echo "ERROR: inspect_relationship_integrity failed"; exit 1; }
for c in documents_with_client_of_other_company payments_with_document_of_other_company payments_without_created_by payments_by_non_member; do
  ok "$(col "$OUT_DIR/relationship-integrity.txt" "$c")" 0 "$c = 0"
done

echo "== 5. 0010 impact"
roh -f "$INS/inspect_0010_impact.sql" > "$OUT_DIR/0010-impact.txt" || { echo "ERROR: inspect_0010_impact failed"; exit 1; }
ok "$(col "$OUT_DIR/0010-impact.txt" plans_breaking_0010_fk)" 0 "no subscription would break 0010's plan foreign key"
echo "    companies blocked after 0010 (needed for the grace-period decision): in the encrypted bundle only"

echo "== 6. verify_after_migrations baseline"
ok "$(ro -f "$INS/verify_after_migrations.sql" | tr '|' ',')" "0,12,4,2,t,12,11,0,,,f,t" "baseline before 0005 (supabase/RUNBOOK.md §3)"

echo "== 7. Saved for the rollbacks of 0007 / 0008"
ro -A -F ',' -P footer=off -f "$INS/inspect_storage_policies.sql" > "$OUT_DIR/storage-policies.csv" && echo "PASS: Storage policies saved" || { fail=1; echo "FAIL: Storage policies"; }
ro -f "$INS/inspect_definer_functions.sql" > "$OUT_DIR/definer-functions.txt" && echo "PASS: definer functions saved" || { fail=1; echo "FAIL: definer functions"; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  tar -C "$OUT_DIR" -cf "$OUT_DIR/production-inspection-$stamp.tar" migration-state.tsv security-baseline.json 0007-preview.tsv relationship-integrity.txt 0010-impact.txt storage-policies.csv definer-functions.txt
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASSPHRASE -in "$OUT_DIR/production-inspection-$stamp.tar" -out "$OUT_DIR/production-inspection-$stamp.tar.enc" && echo "outputs kept ENCRYPTED: production-inspection-$stamp.tar.enc"
else
  echo "outputs NOT kept (no PRODUCTION_BACKUP_PASSPHRASE)"
fi
find "$OUT_DIR" -maxdepth 1 -type f ! -name '*.enc' -delete
[[ $fail -eq 0 ]] && echo "OK: Production matches the inspection; next migration 0005_security_baseline" || echo "STOPPED: Production differs from the inspection: review before any migration"
exit $fail
