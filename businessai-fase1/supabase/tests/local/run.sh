#!/usr/bin/env bash
# Local, throw-away Postgres that validates migration 0005 and the RLS suite.
# Never connects to Supabase. Usage: supabase/tests/local/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$HERE/../../migrations"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }

WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi
PORT="${PGTEST_PORT:-54329}"
cleanup() { "${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUNAS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -p $PORT -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

psqlq() { PGOPTIONS="-c client_min_messages=warning" "${RUNAS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres "$@"; }

base() { # $1 = db name
  psqlq -d postgres -c "create database $1" >/dev/null
  for f in "$HERE/00_supabase_shim.sql" "$MIG/0001_multitenant_core.sql" "$MIG/0003_company_profile.sql" \
           "$MIG/0004_stripe_subscriptions.sql" "$HERE/01_business_fixture.sql"; do
    psqlq -d "$1" -f "$f" >/dev/null
  done
}
count_ba() { psqlq -d "$1" -tAc "select count(*) from pg_policies where policyname like 'ba\_%'"; }

pass=0; fail=0
check() { if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass+1)); else echo "FAIL: $3 (got '$1', want '$2')"; fail=$((fail+1)); fi; }

echo "== Scenario 1: clean apply, idempotent re-apply, full RLS suite"
base s1
psqlq -d s1 -f "$MIG/0005_security_baseline.sql" >/dev/null && check ok ok "0005 applies on a database without unreviewed policies"
psqlq -d s1 -f "$MIG/0005_security_baseline.sql" >/dev/null && check ok ok "0005 re-applies cleanly (idempotent)"
check "$(count_ba s1)" 14 "14 canonical policies installed (10 table + 4 storage)"
check "$(psqlq -d s1 -tAc "select count(*) from pg_indexes where indexname like 'ba\_%'")" 5 "5 tenant indexes created once"
out="$(PGOPTIONS="-c client_min_messages=notice" "${RUNAS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d s1 -f "$HERE/10_rls_business.test.sql" 2>&1)" || { echo "$out"; echo "FAIL: RLS suite"; exit 1; }
n="$(grep -c 'PASS:' <<<"$out")"; echo "$out" | grep -E 'PASS:|FAIL:' | sed 's/^.*NOTICE:  /  /'
check "$(grep -c 'ALL RLS TESTS PASSED' <<<"$out")" 1 "RLS suite: $n assertions passed"

echo "== Scenario 2: an unreviewed permissive policy makes 0005 abort with zero changes"
base s2
psqlq -d s2 -c "create policy legacy_all on public.clients for all to authenticated using (true) with check (true)" >/dev/null
if psqlq -d s2 -f "$MIG/0005_security_baseline.sql" >"$WORK/s2.out" 2>&1; then check applied aborted "guard aborts"; else
  grep -q "unreviewed policies found" "$WORK/s2.out" && check aborted aborted "guard aborts and names the policy"; fi
check "$(count_ba s2)" 0 "no canonical policy was created (rolled back)"
check "$(psqlq -d s2 -tAc "select count(*) from pg_policies where policyname='legacy_all'")" 1 "existing policy left untouched"
check "$(psqlq -d s2 -tAc "select count(*) from pg_proc where proname='storage_company_id'")" 0 "no function created (rolled back)"

echo "== Scenario 3: the same policy, once listed as reviewed, is replaced"
base s3
psqlq -d s3 -c "create policy legacy_all on public.clients for all to authenticated using (true) with check (true)" >/dev/null
sed "s/('_placeholder_:_none_')/('public.clients:legacy_all')/" "$MIG/0005_security_baseline.sql" > "$WORK/0005_reviewed.sql"
chmod a+r "$WORK/0005_reviewed.sql"
psqlq -d s3 -f "$WORK/0005_reviewed.sql" >/dev/null && check ok ok "0005 applies with the reviewed list"
check "$(psqlq -d s3 -tAc "select count(*) from pg_policies where policyname='legacy_all'")" 0 "reviewed legacy policy removed"
out="$(PGOPTIONS="-c client_min_messages=notice" "${RUNAS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d s3 -f "$HERE/10_rls_business.test.sql" 2>&1)" || { echo "$out" | tail -5; echo "FAIL: RLS suite s3"; exit 1; }
check "$(grep -c 'ALL RLS TESTS PASSED' <<<"$out")" 1 "RLS suite passes after replacement"

echo "== Scenario 4: a storage policy that ignores bucket_id makes 0005 abort"
base s4
psqlq -d s4 -c "create policy any_upload on storage.objects for insert to authenticated with check (true)" >/dev/null
if psqlq -d s4 -f "$MIG/0005_security_baseline.sql" >"$WORK/s4.out" 2>&1; then check applied aborted "storage guard"; else
  grep -q "storage.objects:any_upload" "$WORK/s4.out" && check aborted aborted "storage guard aborts and names the policy"; fi

echo "== Scenario 5: missing expected column makes 0005 abort"
base s5
psqlq -d s5 -c "alter table public.payments drop column created_by" >/dev/null
if psqlq -d s5 -f "$MIG/0005_security_baseline.sql" >"$WORK/s5.out" 2>&1; then check applied aborted "precondition"; else
  grep -q "payments.created_by" "$WORK/s5.out" && check aborted aborted "precondition aborts and names payments.created_by"; fi

echo "== Scenario 6: control — the suite FAILS on an insecure database (no 0005)"
base s6
psqlq -d s6 -c "create policy legacy_all on public.clients for all to authenticated using (true) with check (true)" >/dev/null
for t in documents payments; do psqlq -d s6 -c "alter table public.$t disable row level security" >/dev/null; done
if psqlq -d s6 -f "$HERE/10_rls_business.test.sql" >"$WORK/s6.out" 2>&1; then check passed failed "suite detects missing isolation"; else
  check failed failed "suite detects missing isolation ($(grep -o 'FAIL: .*' "$WORK/s6.out" | head -1))"; fi

echo; echo "Result: $pass passed, $fail failed"
[ "$fail" = 0 ]
