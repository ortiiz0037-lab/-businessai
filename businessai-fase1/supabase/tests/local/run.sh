#!/usr/bin/env bash
# Local, throw-away Postgres that validates migrations 0005/0006 against a
# reproduction of the INSPECTED schema. Never connects to Supabase.
# Usage: supabase/tests/local/run.sh   (PG_BIN=/path/to/bin to pick a version)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$HERE/../../migrations"
INSPECT="$HERE/../../inspect/inspect_security_baseline.sql"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }

WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; chmod 755 "$WORK"; fi
PORT="${PGTEST_PORT:-54329}"
cleanup() { "${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUNAS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -p $PORT -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
echo "Local server: $("${RUNAS[@]}" "$PG_BIN/postgres" --version)"

psqlq() { PGOPTIONS="-c client_min_messages=warning" "${RUNAS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres "$@"; }
suite() { # $1 db, $2 file -> prints output, returns psql status
  PGOPTIONS="-c client_min_messages=notice" "${RUNAS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d "$1" -f "$2" 2>&1
}

base() { # inspected state: shim + 0001/0003/0004 + inspected business tables/policies/grants
  psqlq -d postgres -c "create database $1" >/dev/null
  for f in "$HERE/00_supabase_shim.sql" "$MIG/0001_multitenant_core.sql" "$MIG/0003_company_profile.sql" \
           "$MIG/0004_stripe_subscriptions.sql" "$HERE/01_business_fixture.sql"; do
    psqlq -d "$1" -f "$f" >/dev/null
  done
}
count() { psqlq -d "$1" -tAc "$2"; }
all_policies="select count(*) from pg_policies"

pass=0; fail=0
check() { if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass+1)); else echo "FAIL: $3 (got '$1', want '$2')"; fail=$((fail+1)); fi; }
run_suite() { # $1 db, $2 file, $3 marker, $4 label
  local out; if out="$(suite "$1" "$2")"; then :; else echo "$out" | grep -E 'FAIL|ERROR' | head -3; fi
  echo "$out" | grep -oE '(PASS|FAIL): .*' | sed 's/^/    /'
  check "$(grep -c "$3" <<<"$out")" 1 "$4: $(grep -c 'PASS:' <<<"$out") assertions"
}

echo "== Scenario 0: the local fixture reproduces the inspected database"
base s0
PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d s0 -f "$INSPECT" > "$WORK/s0.json"
if out="$(python3 -I "$HERE/compare_fixture.py" "$WORK/s0.json" "${EXPECT:-$HERE/inspected_expectations.json}")"; then
  echo "$out" | sed 's/^/    /'; check ok ok "fixture matches the inspection"; else echo "$out"; check mismatch ok "fixture matches the inspection"; fi

echo "== Scenario 1: 0005 then 0007 on the inspected state (each re-applied), then the RLS suite"
base s1
idx_before="$(count s1 "select count(*) from pg_indexes where schemaname='public'")"
psqlq -d s1 -f "$MIG/0005_security_baseline.sql" >/dev/null && check ok ok "0005 applies on the inspected state"
psqlq -d s1 -f "$MIG/0005_security_baseline.sql" >/dev/null && check ok ok "0005 re-applies cleanly (idempotent)"
check "$(count s1 "select count(*) from pg_policies where policyname like 'ba\_%'")" 10 "0005: 10 canonical table policies (clients 4, documents 4, payments 2)"
check "$(count s1 "select count(*) from pg_policies where schemaname='storage'")" 11 "0005 leaves storage untouched (11 policies)"
psqlq -d s1 -f "$MIG/0007_storage_company_assets.sql" >/dev/null && check ok ok "0007 applies"
psqlq -d s1 -f "$MIG/0007_storage_company_assets.sql" >/dev/null && check ok ok "0007 re-applies cleanly (idempotent)"
check "$(count s1 "select count(*) from pg_policies where schemaname='storage'")" 2 "0007: storage has exactly the 2 canonical policies"
check "$(count s1 "select count(*) from pg_indexes where schemaname='public'")" "$idx_before" "no index added (all tenant indexes already exist)"
check "$(count s1 "select count(*) from pg_policies where schemaname='public' and tablename in ('companies','memberships','company_profiles','company_subscriptions')")" 7 "policies on other tables untouched (7)"
run_suite s1 "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "RLS suite"
run_suite s1 "$HERE/20_fk_before_0006.test.sql" 'cascade (hole confirmed)' "without 0006: cascade hole reproduced"
PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d s1 \
  -f "$HERE/../../inspect/inspect_relationship_integrity.sql" >/dev/null && check ok ok "integrity query runs read-only"

echo "== Scenario 2: a policy that was not in the inspection makes 0005 abort with zero changes"
base s2
psqlq -d s2 -c "create policy payments_extra on public.payments for update to authenticated using (true)" >/dev/null
before="$(count s2 "$all_policies")"
if psqlq -d s2 -f "$MIG/0005_security_baseline.sql" >"$WORK/s2.out" 2>&1; then check applied aborted "guard aborts"; else
  grep -q "public.payments:payments_extra" "$WORK/s2.out" && check aborted aborted "guard aborts and names public.payments:payments_extra"; fi
check "$(count s2 "$all_policies")" "$before" "no policy dropped or created (rolled back)"
check "$(count s2 "select has_table_privilege('anon','public.payments','TRUNCATE')::text")" true "privileges unchanged (rolled back)"

echo "== Scenario 3: a storage policy that ignores bucket_id makes 0007 abort"
base s3
psqlq -d s3 -c "create policy any_upload on storage.objects for insert to authenticated with check (true)" >/dev/null
if psqlq -d s3 -f "$MIG/0007_storage_company_assets.sql" >"$WORK/s3.out" 2>&1; then check applied aborted "storage guard"; else
  grep -q "storage.objects:any_upload" "$WORK/s3.out" && check aborted aborted "storage guard aborts and names the policy"; fi
check "$(count s3 "select count(*) from pg_policies where schemaname='storage'")" 12 "storage policies unchanged (rolled back)"

echo "== Scenario 4: a missing column makes 0005 abort"
base s4
psqlq -d s4 -c "alter table public.payments drop column created_by" >/dev/null
if psqlq -d s4 -f "$MIG/0005_security_baseline.sql" >"$WORK/s4.out" 2>&1; then check applied aborted "precondition"; else
  grep -q "payments.created_by" "$WORK/s4.out" && check aborted aborted "precondition aborts and names payments.created_by"; fi

echo "== Scenario 5: 0005 + 0007 + 0006"
base s5
psqlq -d s5 -f "$MIG/0005_security_baseline.sql" >/dev/null
psqlq -d s5 -f "$MIG/0007_storage_company_assets.sql" >/dev/null
psqlq -d s5 -f "$MIG/0006_payments_document_fk.sql" >/dev/null && check ok ok "0006 applies"
psqlq -d s5 -f "$MIG/0006_payments_document_fk.sql" >/dev/null && check ok ok "0006 re-applies cleanly (idempotent)"
run_suite s5 "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "RLS suite with 0006"
run_suite s5 "$HERE/21_fk_after_0006.test.sql" 'ALL FK TESTS PASSED' "FK suite with 0006"

echo "== Scenario 6: control — the RLS suite FAILS on the inspected state (no 0005)"
base s6
check "$(count s6 "select (has_table_privilege('anon','public.payments','TRUNCATE') and has_table_privilege('authenticated','public.payments','DELETE'))::text")" true "control: today anon can TRUNCATE and authenticated can DELETE payments"
if suite s6 "$HERE/10_rls_business.test.sql" >"$WORK/s6.out"; then check passed failed "suite detects today's gaps"; else
  check failed failed "suite detects today's gaps (first: $(grep -oE 'FAIL: [^"]*' "$WORK/s6.out" | head -1 | sed 's/ *$//'))"; fi

echo "== Scenario 7: 0008 — anon loses EXECUTE on can_edit_company_profile, authenticated keeps it"
base s7
psqlq -d s7 -f "$MIG/0008_definer_function_grants.sql" >/dev/null && check ok ok "0008 applies"
psqlq -d s7 -f "$MIG/0008_definer_function_grants.sql" >/dev/null && check ok ok "0008 re-applies cleanly"
check "$(count s7 "select has_function_privilege('anon','public.can_edit_company_profile(uuid)','EXECUTE')::text || ',' || has_function_privilege('authenticated','public.can_edit_company_profile(uuid)','EXECUTE')::text")" "false,true" "anon: no EXECUTE; authenticated: EXECUTE"

echo "== Scenario 8: full safe order, then full rollback → back to the inspected state"
base s8
for m in 0005_security_baseline 0007_storage_company_assets 0006_payments_document_fk 0008_definer_function_grants; do
  psqlq -d s8 -f "$MIG/$m.sql" >/dev/null || { check failed ok "apply $m"; }
done
check "$(count s8 "select count(*) from pg_policies where policyname like 'ba\_%'")" 12 "all four applied"
check "$(PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -F, -h "$WORK" -p "$PORT" -U postgres -d s8 -f "$HERE/../../inspect/verify_after_migrations.sql")" \
  "10,0,2,0,f,0,2,t,f" "verify_after_migrations.sql shows the expected end state"
for r in 0008 0006 0007 0005; do
  psqlq -d s8 -f "$HERE/../../rollback/${r}_rollback.sql" >/dev/null && check ok ok "rollback $r"
done
PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d s8 -f "$INSPECT" > "$WORK/s8.json"
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); d['storage_objects_policy_count']=2; json.dump(d,open(sys.argv[2],'w'))" \
  "$HERE/inspected_expectations.json" "$WORK/expect_rollback.json"
chmod a+r "$WORK/expect_rollback.json" "$WORK/s8.json"
if out="$(python3 -I "$HERE/compare_fixture.py" "$WORK/s8.json" "$WORK/expect_rollback.json")"; then
  echo "$out" | sed 's/^/    /'; check ok ok "after rollback the database matches the inspection (storage: the 2 live policies)"
else echo "$out"; check mismatch ok "after rollback the database matches the inspection"; fi

echo "== Scenario 9: a busy table makes 0005 fail fast (lock_timeout) with zero changes"
base s9
"${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d s9 \
  -c "begin; lock table public.payments in access share mode; select pg_sleep(20); commit;" >/dev/null 2>&1 &
holder=$!
sleep 1
start=$(date +%s)
if psqlq -d s9 -f "$MIG/0005_security_baseline.sql" >"$WORK/s9.out" 2>&1; then check applied aborted "lock timeout"; else
  grep -q "lock timeout" "$WORK/s9.out" && check aborted aborted "0005 aborts on lock timeout after $(( $(date +%s) - start ))s instead of waiting"; fi
check "$(count s9 "select count(*) from pg_policies where policyname like 'ba\_%'")" 0 "nothing changed (rolled back)"
kill $holder 2>/dev/null || true; wait $holder 2>/dev/null || true

echo; echo "Result: $pass passed, $fail failed"
[ "$fail" = 0 ]
