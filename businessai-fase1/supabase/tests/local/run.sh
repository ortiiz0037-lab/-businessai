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
for m in 0005_security_baseline 0007_storage_company_assets 0009_private_signatures 0006_payments_document_fk 0008_definer_function_grants; do
  psqlq -d s8 -f "$MIG/$m.sql" >/dev/null || { check failed ok "apply $m"; }
done
check "$(count s8 "select count(*) from pg_policies where policyname like 'ba\_%'")" 15 "all five applied (10 table + 2 logo + 3 signature policies)"
check "$(PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -F, -h "$WORK" -p "$PORT" -U postgres -d s8 -f "$HERE/../../inspect/verify_after_migrations.sql")" \
  "10,0,2,0,f,0,2,3,t,t,t,f" "verify_after_migrations.sql shows the expected end state"
for r in 0008 0006 0009 0007 0005; do
  psqlq -d s8 -f "$HERE/../../rollback/${r}_rollback.sql" >/dev/null && check ok ok "rollback $r"
done
PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d s8 -f "$INSPECT" > "$WORK/s8.json"
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); d['storage_objects_policy_count']=2; json.dump(d,open(sys.argv[2],'w'))" \
  "$HERE/inspected_expectations.json" "$WORK/expect_rollback.json"
chmod a+r "$WORK/expect_rollback.json" "$WORK/s8.json"
if out="$(python3 -I "$HERE/compare_fixture.py" "$WORK/s8.json" "$WORK/expect_rollback.json")"; then
  echo "$out" | sed 's/^/    /'; check ok ok "after rollback the database matches the inspection (storage: the 2 live policies)"
else echo "$out"; check mismatch ok "after rollback the database matches the inspection"; fi

echo "== Scenario 10: 0009 — private signatures bucket, then signature RLS suite"
base s10
for m in 0005_security_baseline 0007_storage_company_assets; do psqlq -d s10 -f "$MIG/$m.sql" >/dev/null; done
psqlq -d s10 -f "$MIG/0009_private_signatures.sql" >/dev/null && check ok ok "0009 applies"
psqlq -d s10 -f "$MIG/0009_private_signatures.sql" >/dev/null && check ok ok "0009 re-applies cleanly (idempotent)"
psqlq -d s10 -f "$MIG/0007_storage_company_assets.sql" >/dev/null && check ok ok "0007 re-applied after 0009 leaves signature policies alone"
check "$(count s10 "select count(*) from pg_policies where policyname like 'ba\_company\_signatures\_%'")" 3 "3 signature policies survive 0007"
run_suite s10 "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "RLS suite with 0009"
run_suite s10 "$HERE/30_private_signatures.test.sql" 'ALL SIGNATURE TESTS PASSED' "signature suite"

echo "== Scenario 11: 0009 refuses to adopt an existing PUBLIC Company-signatures bucket"
base s11
psqlq -d s11 -c "insert into storage.buckets (id, name, public) values ('Company-signatures', 'Company-signatures', true)" >/dev/null
if psqlq -d s11 -f "$MIG/0009_private_signatures.sql" >"$WORK/s11.out" 2>&1; then check applied aborted "public bucket guard"; else
  grep -q "exists but is PUBLIC" "$WORK/s11.out" && check aborted aborted "0009 aborts: bucket exists but is public"; fi
check "$(count s11 "select count(*) from pg_policies where policyname like 'ba\_company\_signatures\_%'")" 0 "nothing changed (rolled back)"

echo "== Scenario 12: application compatibility at every step of the safe order"
STAGES=(base 0005_security_baseline 0007_storage_company_assets 0009_private_signatures 0006_payments_document_fk 0008_definer_function_grants)
: > "$WORK/compat.txt"
for k in "${!STAGES[@]}"; do
  db="c$k"; base "$db"
  for ((j=1; j<=k; j++)); do psqlq -d "$db" -f "$MIG/${STAGES[$j]}.sql" >/dev/null; done
  psqlq -d "$db" -f "$HERE/40_app_compat.sql" | sed "s/^/${STAGES[$k]%%_*}|/" >> "$WORK/compat.txt"
done
python3 -I - "$WORK/compat.txt" > "$WORK/compat_matrix.txt" <<'PY'
import sys
rows, stages = {}, []
for line in open(sys.argv[1]):
    stage, op, outcome = line.rstrip("\n").split("|", 2)
    if stage not in stages: stages.append(stage)
    rows.setdefault(op, {})[stage] = outcome
w = max(len(o) for o in rows)
print("operation".ljust(w), *[s.ljust(10) for s in stages])
for op, r in rows.items():
    print(op.ljust(w), *[r.get(s, "-").ljust(10) for s in stages])
PY
sed 's/^/    /' "$WORK/compat_matrix.txt"
if [ -n "${COMPAT_WRITE:-}" ]; then cp "$WORK/compat_matrix.txt" "$HERE/app_compat_expected.txt"; fi
if diff -u "$HERE/app_compat_expected.txt" "$WORK/compat_matrix.txt" > "$WORK/compat.diff"; then
  check ok ok "app compatibility matrix matches the expected outcomes"
else cat "$WORK/compat.diff"; check different ok "app compatibility matrix matches the expected outcomes"; fi

snapshot() { # $1 db, $2 out — inspection output without the timestamp
  PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d "$1" -f "$INSPECT" \
    | python3 -I -c "import json,sys; d=json.load(sys.stdin); d.pop('inspected_at',None); print(json.dumps(d,sort_keys=True,indent=1))" > "$2"
}

echo "== Scenario 13: each rollback, in reverse order, restores exactly the state before its migration"
ORDER=(0005 0007 0009 0006 0008)
declare -A FILE=([0005]=0005_security_baseline [0007]=0007_storage_company_assets [0009]=0009_private_signatures \
                 [0006]=0006_payments_document_fk [0008]=0008_definer_function_grants)
base r13
snapshot r13 "$WORK/snap_0.json"
verify() { PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -F, -h "$WORK" -p "$PORT" -U postgres -d "$1" -f "$HERE/../../inspect/verify_after_migrations.sql"; }
# Expected verify_after_migrations.sql output after each step (same values as RUNBOOK §3).
declare -A VEXP=(
  [base]="0,12,4,2,t,12,11,0,,,f,t"
  [0005]="10,0,2,0,f,0,11,0,,,f,t"
  [0007]="10,0,2,0,f,0,2,0,,,f,t"
  [0009]="10,0,2,0,f,0,2,3,t,t,f,t"
  [0006]="10,0,2,0,f,0,2,3,t,t,t,t"
  [0008]="10,0,2,0,f,0,2,3,t,t,t,f"
)
check "$(verify r13)" "${VEXP[base]}" "verify before any migration = ${VEXP[base]}"
for i in "${!ORDER[@]}"; do
  psqlq -d r13 -f "$MIG/${FILE[${ORDER[$i]}]}.sql" >/dev/null
  snapshot r13 "$WORK/snap_$((i+1)).json"
  check "$(verify r13)" "${VEXP[${ORDER[$i]}]}" "verify after ${ORDER[$i]} = ${VEXP[${ORDER[$i]}]}"
done
for ((i=${#ORDER[@]}-1; i>=0; i--)); do
  m="${ORDER[$i]}"
  psqlq -d r13 -f "$HERE/../../rollback/${m}_rollback.sql" >/dev/null || { check failed ok "rollback $m runs"; continue; }
  snapshot r13 "$WORK/after_rb.json"
  # Documented, intentional differences: 0007_rollback does not recreate the 9
  # dead storage policies; 0009_rollback keeps the Company-signatures bucket.
  rolled="${rolled:-} $m"
  if python3 -I - "$m" "$WORK/snap_$i.json" "$WORK/after_rb.json" "$rolled" > "$WORK/rb.diff" <<'PY'
import json, sys
m, fa, fb, rolled = sys.argv[1:5]
rolled = rolled.split()
a, b = json.load(open(fa)), json.load(open(fb))
def norm(d):
    d = dict(d)
    if "0007" in rolled:
        d["rls_policies"] = [p for p in d["rls_policies"] or []
            if not (p["table"] == "storage.objects"
                    and "'Company-assets'" not in ((p["using"] or "") + (p["with_check"] or "")))]
    if "0009" in rolled:
        d["storage_buckets"] = [x for x in d["storage_buckets"] or [] if x["id"] != "Company-signatures"]
    return d
if norm(a) != norm(b):
    for k in a:
        if norm(a)[k] != norm(b).get(k): print("differs in", k)
    sys.exit(1)
PY
  then
    note=""
    [[ " $rolled " == *" 0009 "* ]] && note=" [kept by design: Company-signatures bucket]"
    [[ " $rolled " == *" 0007 "* ]] && note="$note [not restored by design: 9 dead storage policies]"
    check ok ok "rollback $m → identical to the state before $m$note"
  else cat "$WORK/rb.diff"; check different ok "rollback $m → identical to the state before $m"; fi
done

echo "== Scenario 14: dependencies — each migration alone, and the reverse order"
for m in 0005 0007 0009 0006 0008; do
  base "d$m"
  psqlq -d "d$m" -f "$MIG/${FILE[$m]}.sql" >/dev/null && check ok ok "$m applies alone on the inspected state" || check failed ok "$m applies alone"
done
base drev
ok_all=ok; for m in 0008 0006 0009 0007 0005; do psqlq -d drev -f "$MIG/${FILE[$m]}.sql" >/dev/null || ok_all="failed at $m"; done
check "$ok_all" ok "reverse order 0008→0006→0009→0007→0005 also applies (no hard ordering between them)"
snapshot drev "$WORK/rev.json"
if diff -q "$WORK/snap_5.json" "$WORK/rev.json" >/dev/null; then check ok ok "same end state as the safe order"; else { diff "$WORK/snap_5.json" "$WORK/rev.json" || true; } | head -20; check different ok "same end state as the safe order"; fi
base doo
for m in 0007 0009; do psqlq -d doo -f "$MIG/${FILE[$m]}.sql" >/dev/null; done
if psqlq -d doo -f "$HERE/../../rollback/0007_rollback.sql" >"$WORK/doo.out" 2>&1; then
  check "$(count doo "select count(*) from pg_policies where policyname like 'ba\_company\_signatures\_%'")" 3 "out-of-order: rollback 0007 while 0009 is applied keeps signatures working"
else grep -m1 ERROR "$WORK/doo.out"; check failed ok "out-of-order: rollback 0007 while 0009 is applied"; fi

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
