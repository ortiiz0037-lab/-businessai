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
  echo "$out" | grep -oE '(PASS|FAIL): .*' | sed 's/^/    /' || true
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
STAGES=(base 0005_security_baseline 0007_storage_company_assets 0009_private_signatures 0006_payments_document_fk 0008_definer_function_grants 0010_billing 0011_usage_limits 0014a_permissions)
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
# 0014a must not change any application operation: its column equals 0011's.
check "$(awk 'NR > 1 { if ($(NF-1) != $NF) d++ } END { print d + 0 }' "$WORK/compat_matrix.txt")" 0 \
  "app compatibility: every operation has the same outcome after 0014a as after 0011"

snapshot() { # $1 db, $2 out — inspection output without the timestamp
  PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d "$1" -f "$INSPECT" \
    | python3 -I -c "import json,sys; d=json.load(sys.stdin); d.pop('inspected_at',None); print(json.dumps(d,sort_keys=True,indent=1))" > "$2"
}

echo "== Scenario 13: each rollback, in reverse order, restores exactly the state before its migration"
ORDER=(0005 0007 0009 0006 0008 0010 0011)
declare -A FILE=([0005]=0005_security_baseline [0007]=0007_storage_company_assets [0009]=0009_private_signatures \
                 [0006]=0006_payments_document_fk [0008]=0008_definer_function_grants [0010]=0010_billing [0011]=0011_usage_limits)
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
  [0010]="10,0,2,0,f,0,2,3,t,t,t,f"
  [0011]="10,0,2,0,f,0,2,3,t,t,t,f"
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
for m in 0005 0007 0009 0006 0008 0010; do
  base "d$m"
  psqlq -d "d$m" -f "$MIG/${FILE[$m]}.sql" >/dev/null && check ok ok "$m applies alone on the inspected state" || check failed ok "$m applies alone"
done
base drev
ok_all=ok; for m in 0010 0011 0008 0006 0009 0007 0005; do psqlq -d drev -f "$MIG/${FILE[$m]}.sql" >/dev/null || ok_all="failed at $m"; done
check "$ok_all" ok "other order 0010→0011→0008→0006→0009→0007→0005 also applies (only 0011 needs 0010)"
base d0011
if psqlq -d d0011 -f "$MIG/0011_usage_limits.sql" >"$WORK/d0011.out" 2>&1; then check applied aborted "0011 without 0010"; else
  grep -q "BA0011: migration 0010" "$WORK/d0011.out" && check aborted aborted "0011 without 0010 aborts with a clear message (nothing changed)"; fi
snapshot drev "$WORK/rev.json"
if diff -q "$WORK/snap_7.json" "$WORK/rev.json" >/dev/null; then check ok ok "same end state as the safe order"; else { diff "$WORK/snap_7.json" "$WORK/rev.json" || true; } | head -20; check different ok "same end state as the safe order"; fi
base doo
for m in 0007 0009; do psqlq -d doo -f "$MIG/${FILE[$m]}.sql" >/dev/null; done
if psqlq -d doo -f "$HERE/../../rollback/0007_rollback.sql" >"$WORK/doo.out" 2>&1; then
  check "$(count doo "select count(*) from pg_policies where policyname like 'ba\_company\_signatures\_%'")" 3 "out-of-order: rollback 0007 while 0009 is applied keeps signatures working"
else grep -m1 ERROR "$WORK/doo.out"; check failed ok "out-of-order: rollback 0007 while 0009 is applied"; fi

ALL_MIGS=(0005_security_baseline 0007_storage_company_assets 0009_private_signatures 0006_payments_document_fk 0008_definer_function_grants 0010_billing 0011_usage_limits)

echo "== Scenario 15: billing (0010) on the inspected state with all migrations"
base b15
for m in "${ALL_MIGS[@]}"; do psqlq -d b15 -f "$MIG/$m.sql" >/dev/null; done
psqlq -d b15 -f "$MIG/0010_billing.sql" >/dev/null && check ok ok "0010 re-applies cleanly (idempotent)"
run_suite b15 "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "RLS suite with 0010"
run_suite b15 "$HERE/50_billing.test.sql" 'ALL BILLING TESTS PASSED' "billing suite"
psqlq -d b15 -f "$MIG/0011_usage_limits.sql" >/dev/null && check ok ok "0011 re-applies cleanly (idempotent)"
run_suite b15 "$HERE/60_usage.test.sql" 'ALL USAGE TESTS PASSED' "usage limits suite"

echo "== Scenario 16: STAGING from scratch — repository migrations only (0001→0010)"
psqlq -d postgres -c "create database stg" >/dev/null
for f in "$HERE/00_supabase_shim.sql" "$MIG/0001_multitenant_core.sql" "$MIG/0002_business_tables.sql" \
         "$MIG/0003_company_profile.sql" "$MIG/0004_stripe_subscriptions.sql"; do psqlq -d stg -f "$f" >/dev/null; done
ok_all=ok; for m in "${ALL_MIGS[@]}"; do psqlq -d stg -f "$MIG/$m.sql" >/dev/null || ok_all="failed at $m"; done
check "$ok_all" ok "staging: every migration applies on a database built only from the repository"
check "$(PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -F, -h "$WORK" -p "$PORT" -U postgres -d stg -f "$HERE/../../inspect/verify_after_migrations.sql")" \
  "10,0,2,0,f,0,2,3,t,t,t," "staging: verify = production end state (can_edit_company_profile does not exist in staging → empty)"
run_suite stg "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "staging: RLS suite"
run_suite stg "$HERE/30_private_signatures.test.sql" 'ALL SIGNATURE TESTS PASSED' "staging: signature suite"
run_suite stg "$HERE/50_billing.test.sql" 'ALL BILLING TESTS PASSED' "staging: billing suite"
run_suite stg "$HERE/60_usage.test.sql" 'ALL USAGE TESTS PASSED' "staging: usage limits suite"
run_suite stg "$HERE/21_fk_after_0006.test.sql" 'ALL FK TESTS PASSED' "staging: FK suite"
base p16; snapshot p16 "$WORK/p16a.json"
psqlq -d p16 -f "$MIG/0002_business_tables.sql" >/dev/null
snapshot p16 "$WORK/p16b.json"
if diff -q "$WORK/p16a.json" "$WORK/p16b.json" >/dev/null; then check ok ok "0002 is a no-op on the production (inspected) database"; else { diff "$WORK/p16a.json" "$WORK/p16b.json" || true; } | head; check different ok "0002 is a no-op on production"; fi

echo "== Scenario 17: staging:migrate steps (scripts/staging/apply-migrations.sh) on an empty staging-like database"
MREF=stagingreftest0000001
psqlq -d postgres -c "create role \"postgres.$MREF\" login superuser" -c "create database mig" -c "create database prodlike" >/dev/null
psqlq -d mig -f "$HERE/00_supabase_shim.sql" >/dev/null
MURL="postgresql://postgres.$MREF@/mig?host=$WORK&port=$PORT"
mig() { (cd "$HERE/../.." && env STAGING_DB_URL="$1" STAGING_PROJECT_REF="$MREF" PRODUCTION_PROJECT_REF=prodreftest0000000001 \
  EXPECT_STAGING_REF="${PIN:-$MREF}" "${@:2}" bash ../scripts/staging/apply-migrations.sh 2>&1); }
o="$(PIN=otherref mig "$MURL" DRY_RUN=1 || true)"; check "$(grep -c 'not the pinned staging project' <<<"$o")" 1 "migrate: a different pinned ref is refused"
o="$(mig "postgresql://postgres.$MREF@/mig?host=$WORK&port=$PORT&x=prodreftest0000000001" DRY_RUN=1 || true)"; check "$(grep -c 'PRODUCTION' <<<"$o")" 1 "migrate: production ref in the URL is refused"
o="$(mig "postgresql://postgres@/mig?host=$WORK&port=$PORT&a=$MREF" DRY_RUN=1 || true)"; check "$(grep -c 'user/host is not the staging project' <<<"$o")" 1 "migrate: a user without the staging ref is refused"
o="$(mig "$MURL" DRY_RUN=1)"; check "$(grep -c 'Pending: 0001_multitenant_core.* 0011_usage_limits 0014a_permissions$' <<<"$o")/$(grep -c 'Held (draft not approved.*): 0015_documents_lifecycle 0016_billing_hardening 0017_plan_features 0018_team 0019_crm 0020_workforce 0021_workforce_kiosk 0022_workforce_rules 0023_ledger 0024_payables 0025_receivables 0026_bank_reconciliation 0027_statements_budgets 0028_document_studio 0029_assistant 0030_intelligence_core$' <<<"$o")" "1/1" \
  "migrate plan: lists 0001…0011 and 0014a; the gated drafts 0015 and 0016 are HELD; writes nothing"
check "$(psqlq -d mig -tA -c "select count(*) from pg_tables where schemaname='public'")" 0 "migrate plan: no table created"
o="$(mig "$MURL" DRY_RUN=1 VERIFY_0014A=1)"; check "$(grep -c 'verify_0014a: 0014a_permissions not recorded yet' <<<"$o")" 1 "verify_0014a: skipped while 0014a is not recorded"
o="$(mig "$MURL")"; check "$(grep -c 'Staging database is up to date and verified' <<<"$o")" 1 "migrate apply (I12): a label run applies 12 migrations and NOT the drafts"
check "$(grep -oE 'applying [0-9a-z_]+' <<<"$o" | tail -3 | tr '\n' ' ')/$(psqlq -d mig -tA -c "select to_regclass('public.document_counters') is null")" "applying 0010_billing applying 0011_usage_limits applying 0014a_permissions /t" \
  "migrate apply: 0014a_permissions runs after 0011; nothing of 0015 exists"
o="$(mig "$MURL" DRY_RUN=1 EXPECT_NONE=1 STATUS=1)"; check "$(grep -c '✓' <<<"$o")/$(grep -c 'No pending migrations' <<<"$o")/$(grep -c '^Held' <<<"$o")" "12/1/1" "migrate confirm: nothing runnable pending, 12 recorded, drafts listed as held"
check "$(psqlq -d mig -tA -c "select count(*) from ba_meta.applied_migrations where name = '0014a_permissions'")" 1 "migrate: the record stores the identifier 0014a_permissions"
o="$(mig "$MURL" APPROVED_DRAFTS=0015)"; check "$(grep -c '^→ applying' <<<"$o")" 0 "migrate: a partial name approves nothing"
o="$(mig "$MURL" APPROVED_DRAFTS=0015_documents_lifecycle)"
check "$(grep -oE 'applying [0-9a-z_]+' <<<"$o" | tr '\n' ' ')/$(grep -c 'Held.*: 0016_billing_hardening 0017_plan_features 0018_team 0019_crm 0020_workforce 0021_workforce_kiosk 0022_workforce_rules 0023_ledger 0024_payables 0025_receivables 0026_bank_reconciliation 0027_statements_budgets 0028_document_studio 0029_assistant 0030_intelligence_core$' <<<"$o")" "applying 0015_documents_lifecycle /1" "migrate with APPROVED_DRAFTS=0015: applies 0015 only; 0016 still held"
o="$(mig "$MURL" APPROVED_DRAFTS=0016_billing_hardening,0017_plan_features,0018_team,0019_crm,0020_workforce,0021_workforce_kiosk,0022_workforce_rules,0023_ledger,0024_payables,0025_receivables,0026_bank_reconciliation,0027_statements_budgets,0028_document_studio,0029_assistant,0030_intelligence_core)"; check "$(grep -oE 'applying [0-9a-z_]+' <<<"$o" | tr '\n' ' ')" "applying 0016_billing_hardening applying 0017_plan_features applying 0018_team applying 0019_crm applying 0020_workforce applying 0021_workforce_kiosk applying 0022_workforce_rules applying 0023_ledger applying 0024_payables applying 0025_receivables applying 0026_bank_reconciliation applying 0027_statements_budgets applying 0028_document_studio applying 0029_assistant applying 0030_intelligence_core " "migrate with APPROVED_DRAFTS=0016…0019: applies them"
o="$(mig "$MURL" DRY_RUN=1 EXPECT_NONE=1 STATUS=1)"; check "$(grep -c '✓' <<<"$o")/$(grep -c 'No pending migrations' <<<"$o")/$(grep -c '^Held' <<<"$o")" "28/1/0" "migrate confirm: 28 recorded, nothing pending or held"
# The migration committed but its record was lost (e.g. the connection dropped
# between the two steps): the next run re-applies it — idempotent — and every
# later one, INCLUDING the approved drafts (same content), with no new approval.
psqlq -d mig -c "delete from ba_meta.applied_migrations where name = '0014a_permissions'" >/dev/null
o="$(mig "$MURL" DRY_RUN=1)"; check "$(grep -c 'Pending: 0014a_permissions 0015_documents_lifecycle 0016_billing_hardening 0017_plan_features 0018_team 0019_crm 0020_workforce 0021_workforce_kiosk 0022_workforce_rules 0023_ledger 0024_payables 0025_receivables 0026_bank_reconciliation 0027_statements_budgets 0028_document_studio 0029_assistant 0030_intelligence_core$' <<<"$o")/$(grep -c '^Held' <<<"$o")" "1/0" "lost record: 0014a shows as pending with 0015 and 0016 after it (already approved content: not held)"
o="$(mig "$MURL")"; check "$(grep -c 'Staging database is up to date and verified' <<<"$o")" 1 "lost record: re-run re-applies 0014a, 0015 and 0016 idempotently and verifies"
check "$(psqlq -d mig -tA -c "select count(*) from ba_meta.applied_migrations")/$(psqlq -d mig -tA -c "select count(*) from public.role_permissions")" "28/113" "lost record: 28 recorded again; matrix 113 rows (admin still without billing.manage; + 9 accounting rows of 0023, + 13 payables rows of 0024, + 6 receivables rows of 0025, + 8 bank rows of 0026, + 3 budget rows of 0027, + 12 studio rows of 0028, + 5 assistant rows of 0029)"
# T5: read-only SQL verification of 0014a (staging:check and the migrate confirmation).
fp_mig() { "${RUNAS[@]}" psql -X -q -tA -h "$WORK" -p "$PORT" -U postgres -d mig -f "$HERE/catalog_fingerprint.sql" -c "select count(*) from public.role_permissions" -c "select count(*) from ba_meta.applied_migrations"; }
fp_mig > "$WORK/v_before.txt"
o="$(mig "$MURL" DRY_RUN=1 EXPECT_NONE=1 STATUS=1 VERIFY_0014A=1)"; check "$(grep -c '^verify_0014a: OK$' <<<"$o")" 1 "verify_0014a: OK on the migrated database"
check "$(grep -c '^storage_policy: ba_company_[a-z_]* | [A-Z]* | authenticated | repository$' <<<"$o")/$(grep -c '^storage_policy: ba_finance_attachments_[a-z]* | [A-Z]* | authenticated | allowed: limited to bucket Finance-attachments$' <<<"$o")/$(grep -c '^storage_policy: ba_studio_assets_[a-z]* | [A-Z]* | authenticated | allowed: limited to bucket Studio-assets$' <<<"$o")/$(grep -c '^storage_policy: ' <<<"$o")" "5/3/2/10" \
  "staging:check lists every storage.objects policy with its R3 verdict (5 repository policies + 3 of 0024 limited to Finance-attachments + 2 of 0028 limited to Studio-assets)"
fp_mig > "$WORK/v_after.txt"
check "$(diff -q "$WORK/v_before.txt" "$WORK/v_after.txt" >/dev/null && echo same || echo changed)" same "verify_0014a: catalog, matrix and record unchanged (read-only)"
check "$(PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d mig -c "begin transaction read only" -c "create table public.v_probe(i int)" 2>&1 | grep -c 'read-only transaction')" 1 \
  "verify_0014a: its session refuses any write (read-only transaction)"
psqlq -d mig -c "delete from public.role_permissions where role = 'member' and permission_key = 'clients.view'" \
  -c "grant execute on function public.has_permission(uuid, text) to anon" \
  -c "alter policy ba_clients_select on public.clients using (public.is_company_member(company_id))" >/dev/null
o="$(mig "$MURL" DRY_RUN=1 VERIFY_0014A=1 || true)"
check "$(grep -c '0014a verification failed' <<<"$o")/$(grep -o 'member:clients.view missing\|has_permission(uuid,text) grants wrong\|public.clients:ba_clients_select' <<<"$o" | sort -u | wc -l)" "1/3" \
  "verify_0014a: detects a changed matrix, an anon grant and an old-style policy, and fails"
psqlq -d prodlike -c "create table public.companies(id int); insert into public.companies values (1)" >/dev/null
o="$(mig "postgresql://postgres.$MREF@/prodlike?host=$WORK&port=$PORT" DRY_RUN=1 || true)"; check "$(grep -c 'production?' <<<"$o")" 1 "migrate: unmarked database with data is refused"

echo "== Scenario 18: 0014a permission foundation (E3) — behaviour identical before and after"
P14=0014a_permissions
stg_db() { # $1 db → staging-like database built only from the repository, up to 0011
  psqlq -d postgres -c "create database $1" >/dev/null
  for f in "$HERE/00_supabase_shim.sql" "$MIG/0001_multitenant_core.sql" "$MIG/0002_business_tables.sql" \
           "$MIG/0003_company_profile.sql" "$MIG/0004_stripe_subscriptions.sql"; do psqlq -d "$1" -f "$f" >/dev/null; done
  for m in "${ALL_MIGS[@]}"; do psqlq -d "$1" -f "$MIG/$m.sql" >/dev/null; done
}
matrix() { psqlq -d "$1" -f "$HERE/72_permission_matrix.sql" > "$2"; }
fingerprint() { PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -h "$WORK" -p "$PORT" -U postgres -d "$1" -f "$HERE/catalog_fingerprint.sql" > "$2"; }
same_matrix() { # $1 file, $2 label — compared with the committed expected matrix
  if diff -u "$HERE/permission_matrix_expected.txt" "$1" > "$WORK/matrix.diff"; then check ok ok "$2"; else head -20 "$WORK/matrix.diff"; check different ok "$2"; fi
}
# Before 0014a (the contract) — and the probe really discriminates between roles.
stg_db e18a; matrix e18a "$WORK/m_before.txt"
[ -n "${MATRIX_WRITE:-}" ] && cp "$WORK/m_before.txt" "$HERE/permission_matrix_expected.txt"
same_matrix "$WORK/m_before.txt" "matrix before 0014a = permission_matrix_expected.txt ($(wc -l < "$WORK/m_before.txt") operations × actors)"
check "$(grep -cE '^(aa\|delete client A\|rows=1|ma\|delete client A\|rows=0|ma\|insert storage logo A\|error 42501|ob\|select clients A/B\|0/1|x\|select documents A/B\|0/0|anon\|select clients A/B\|error 42501)$' "$WORK/m_before.txt")" 6 \
  "matrix discriminates: admin deletes, member cannot, member no logo, other company/no company/anon see nothing"
# After 0014a, applied twice (idempotent).
stg_db e18b
psqlq -d e18b -f "$MIG/$P14.sql" >/dev/null && check ok ok "0014a applies on a staging-like database"
psqlq -d e18b -f "$MIG/$P14.sql" >/dev/null && check ok ok "0014a re-applies cleanly (idempotent)"
matrix e18b "$WORK/m_after.txt"
same_matrix "$WORK/m_after.txt" "matrix after 0014a (applied twice) is IDENTICAL to before"
# Existing memberships become active; nobody loses access.
stg_db e18c
psqlq -d e18c -c "insert into auth.users (id) values ('2a000000-0000-4000-8000-000000000001'), ('2a000000-0000-4000-8000-000000000002'), ('2a000000-0000-4000-8000-000000000003');
  insert into public.companies (id, name, created_by) values ('2c000000-0000-4000-8000-000000000001', 'Existente', '2a000000-0000-4000-8000-000000000001');
  insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('2c000000-0000-4000-8000-000000000001', 'cus_e', 'sub_e', 'premium', 'active');
  insert into public.memberships (company_id, user_id, role) values ('2c000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001', 'owner'),
    ('2c000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000002', 'admin'), ('2c000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000003', 'member');" >/dev/null
psqlq -d e18c -f "$MIG/$P14.sql" >/dev/null
check "$(count e18c "select count(*) || '/' || count(*) filter (where status = 'active') from public.memberships")" "3/3" "existing memberships: all 3 kept and active"
# Existing suites still pass with 0014a: RLS, signatures, billing, usage limits, FKs.
stg_db e18d; psqlq -d e18d -f "$MIG/$P14.sql" >/dev/null
run_suite e18d "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "with 0014a: RLS suite"
run_suite e18d "$HERE/30_private_signatures.test.sql" 'ALL SIGNATURE TESTS PASSED' "with 0014a: signature suite"
run_suite e18d "$HERE/50_billing.test.sql" 'ALL BILLING TESTS PASSED' "with 0014a: billing suite"
run_suite e18d "$HERE/60_usage.test.sql" 'ALL USAGE TESTS PASSED' "with 0014a: usage limits suite"
run_suite e18d "$HERE/21_fk_after_0006.test.sql" 'ALL FK TESTS PASSED' "with 0014a: FK suite"
check "$(PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -F, -h "$WORK" -p "$PORT" -U postgres -d e18d -f "$HERE/../../inspect/verify_after_migrations.sql")" \
  "10,0,2,0,f,0,2,3,t,t,t," "with 0014a: verify_after_migrations unchanged (staging:migrate expectation still holds)"
stg_db e18e; psqlq -d e18e -f "$MIG/$P14.sql" >/dev/null
run_suite e18e "$HERE/73_permission_foundation.test.sql" 'ALL PERMISSION TESTS PASSED' "permission foundation suite"
# Production path (inspected database + 0005…0011): same behaviour too.
base p18; for m in "${ALL_MIGS[@]}"; do psqlq -d p18 -f "$MIG/$m.sql" >/dev/null; done
matrix p18 "$WORK/m_prod_before.txt"
# Known, pre-existing differences between environments (not caused by 0014a):
# production revoked DELETE on document_deletion_audit (6 actors) and anon's
# SELECT on it; staging did not (those statements match no row there).
# Everything else is the same.
prod_diff="$(diff "$HERE/permission_matrix_expected.txt" "$WORK/m_prod_before.txt" | grep '^>' || true)"
check "$(grep -c . <<<"$prod_diff")/$(grep -v -e '|delete deletion audit A|error 42501$' -e '^> anon|select document_deletion_audit A/B|error 42501$' <<<"$prod_diff" | grep -c . || true)" "7/0" \
  "production path before 0014a: same as staging except the deletion-audit grants revoked in production (DELETE ×6 actors, anon SELECT)"
base p18b; for m in "${ALL_MIGS[@]}"; do psqlq -d p18b -f "$MIG/$m.sql" >/dev/null; done
psqlq -d p18b -f "$MIG/$P14.sql" >/dev/null && check ok ok "production path: 0014a applies on the inspected database"
check "$(PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -h "$WORK" -p "$PORT" -U postgres -d p18b -c "begin transaction read only" -f "$HERE/../../inspect/verify_0014a.sql" -c "rollback")" OK \
  "production path: verify_0014a.sql answers OK (read-only)"
matrix p18b "$WORK/m_prod_after.txt"
if diff -u "$WORK/m_prod_before.txt" "$WORK/m_prod_after.txt" > "$WORK/prod.diff"; then check ok ok "production path: matrix after 0014a is IDENTICAL to before"
else head -20 "$WORK/prod.diff"; check different ok "production path: matrix after 0014a is IDENTICAL to before"; fi
# Rollback restores the schema exactly; refused once a membership is suspended.
stg_db e18r; fingerprint e18r "$WORK/fp_before.txt"
psqlq -d e18r -f "$MIG/$P14.sql" >/dev/null
fingerprint e18r "$WORK/fp_mid.txt"
check "$(diff "$WORK/fp_before.txt" "$WORK/fp_mid.txt" >/dev/null && echo same || echo changed)" changed "fingerprint detects the 0014a changes"
psqlq -d e18r -f "$HERE/../../rollback/0014a_rollback.sql" >/dev/null && check ok ok "0014a rollback runs"
fingerprint e18r "$WORK/fp_after.txt"
if diff -u "$WORK/fp_before.txt" "$WORK/fp_after.txt" > "$WORK/fp.diff"; then check ok ok "after rollback the catalog is identical to before 0014a"; else head -20 "$WORK/fp.diff"; check different ok "rollback restores the catalog"; fi
matrix e18r "$WORK/m_rb.txt"; same_matrix "$WORK/m_rb.txt" "after rollback the matrix is still the expected one"
# Rollback after applying 0014a TWICE: the second run converges to the same
# catalog as the first, and the rollback still restores the initial one.
stg_db e18t; fingerprint e18t "$WORK/fp2_initial.txt"
psqlq -d e18t -f "$MIG/$P14.sql" >/dev/null && check ok ok "double apply: first 0014a run"
fingerprint e18t "$WORK/fp2_first.txt"
psqlq -d e18t -f "$MIG/$P14.sql" >/dev/null && check ok ok "double apply: second 0014a run"
fingerprint e18t "$WORK/fp2_second.txt"
if diff -u "$WORK/fp2_first.txt" "$WORK/fp2_second.txt" > "$WORK/fp2_12.diff"; then check ok ok "double apply: catalog after the 2nd run IDENTICAL to after the 1st"
else head -20 "$WORK/fp2_12.diff"; check different ok "double apply: catalog after the 2nd run IDENTICAL to after the 1st"; fi
check "$(count e18t "select (select count(*) from public.permissions) || '/' || (select count(*) from public.role_permissions)")" "18/49" \
  "double apply: catalog still 18 permissions and 49 matrix rows"
psqlq -d e18t -f "$HERE/../../rollback/0014a_rollback.sql" >/dev/null && check ok ok "double apply: 0014a rollback runs"
fingerprint e18t "$WORK/fp2_final.txt"
if diff -u "$WORK/fp2_initial.txt" "$WORK/fp2_final.txt" > "$WORK/fp2_rb.diff"; then check ok ok "double apply + rollback: catalog IDENTICAL to the initial one (policies, functions, grants, tables, columns)"
else head -20 "$WORK/fp2_rb.diff"; check different ok "double apply + rollback: catalog IDENTICAL to the initial one"; fi
check "$(grep -cE '^policy\|(public\.(companies|memberships|company_profiles|company_subscriptions|document_deletion_audit|clients|documents|payments)|storage\.objects\|ba_company_(assets|signatures)_)' "$WORK/fp2_final.txt")/$(grep -c 'has_permission' "$WORK/fp2_final.txt")" "24/0" \
  "double apply + rollback: the 24 tenant policies are back and none uses has_permission"
check "$(grep -cE '^function\|(is_company_member\(uuid\)|has_company_role\(uuid,text\[\]\))\|' "$WORK/fp2_final.txt")/$(grep -cE '^(function\|has_permission\(|table\|(permissions|role_permissions)\||column\|memberships\.status\||constraint\|memberships\|memberships_status_check)' "$WORK/fp2_final.txt")" "2/0" \
  "double apply + rollback: original helpers present; has_permission, catalog tables, status column and constraint gone"
matrix e18t "$WORK/m_rb2.txt"; same_matrix "$WORK/m_rb2.txt" "double apply + rollback: behaviour matrix is the expected one"
if [ -n "${FP_OUT:-}" ]; then mkdir -p "$FP_OUT"; cp "$WORK"/fp2_*.txt "$FP_OUT"/; fi
stg_db e18s; psqlq -d e18s -f "$MIG/$P14.sql" >/dev/null
psqlq -d e18s -c "insert into auth.users (id) values ('3a000000-0000-4000-8000-000000000001');
  insert into public.companies (id, name, created_by) values ('3c000000-0000-4000-8000-000000000001', 'Suspendida', '3a000000-0000-4000-8000-000000000001');
  insert into public.memberships (company_id, user_id, role, status) values ('3c000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', 'owner', 'suspended');" >/dev/null
if psqlq -d e18s -f "$HERE/../../rollback/0014a_rollback.sql" >"$WORK/e18s.out" 2>&1; then check ran refused "rollback with a suspended membership"; else
  grep -q "suspended memberships exist" "$WORK/e18s.out" && check refused refused "rollback refuses while a membership is suspended (nothing changed)"; fi
check "$(count e18s "select count(*) from public.permissions")" 18 "refused rollback left 0014a in place"
# Atomicity: a failure anywhere leaves NOTHING applied.
stg_db e18f; fingerprint e18f "$WORK/fp_f0.txt"
psqlq -d e18f -c "create policy clients_extra on public.clients for select to authenticated using (true)" >/dev/null
fingerprint e18f "$WORK/fp_f1.txt"
if psqlq -d e18f -f "$MIG/$P14.sql" >"$WORK/e18f.out" 2>&1; then check applied aborted "unknown policy guard"; else
  grep -q "public.clients:clients_extra" "$WORK/e18f.out" && check aborted aborted "0014a aborts on a policy it does not know and names it"; fi
fingerprint e18f "$WORK/fp_f2.txt"
check "$(diff -q "$WORK/fp_f1.txt" "$WORK/fp_f2.txt" >/dev/null && echo same || echo changed)" same "guard abort: nothing changed"
stg_db e18l; fingerprint e18l "$WORK/fp_l1.txt"
# Lock payments: 0014a has already rewritten companies, memberships, profiles,
# clients and documents when it reaches payments, then times out → all undone.
"${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d e18l \
  -c "begin; lock table public.payments in access exclusive mode; select pg_sleep(15); commit;" >/dev/null 2>&1 &
holder=$!
sleep 1
if psqlq -d e18l -f "$MIG/$P14.sql" >"$WORK/e18l.out" 2>&1; then check applied aborted "mid-migration lock timeout"; else
  grep -q "lock timeout" "$WORK/e18l.out" && check aborted aborted "0014a fails mid-way on a lock timeout"; fi
kill $holder 2>/dev/null || true; wait $holder 2>/dev/null || true
fingerprint e18l "$WORK/fp_l2.txt"
check "$(diff -q "$WORK/fp_l1.txt" "$WORK/fp_l2.txt" >/dev/null && echo same || echo changed)" same "mid-migration failure: nothing changed (no partial policies, no status column)"

echo "== Scenario 19: demo company data (staging:demo) fits the real schema; removal leaves nothing"
stg_db e19; psqlq -d e19 -f "$MIG/$P14.sql" >/dev/null   # like staging today: 0001–0011 + 0014a
psqlq -d e19 -c "insert into auth.users (id, email) values ('e1900000-0000-4000-8000-000000000001', 'other@local.test');
  insert into public.companies (id, name, created_by) values ('e1900000-0000-4000-8000-0000000000c1', 'Otra empresa', 'e1900000-0000-4000-8000-000000000001');
  insert into public.memberships (company_id, user_id, role) values ('e1900000-0000-4000-8000-0000000000c1', 'e1900000-0000-4000-8000-000000000001', 'owner');" >/dev/null
node "$HERE/demo_seed_sql.mjs" > "$WORK/demo_seed.sql"
counts="$(tail -1 "$WORK/demo_seed.sql" | sed 's/^-- counts: //')"
psqlq -d e19 -f "$WORK/demo_seed.sql" >/dev/null && check ok ok "demo seed inserts into the real schema (constraints, triggers, FKs)"
check "$(count e19 "select (select count(*) from public.clients where company_id = 'd2000000-0000-4000-8000-000000000001') || ' ' || (select count(*) from public.documents where company_id = 'd2000000-0000-4000-8000-000000000001') || ' ' || (select count(*) from public.payments where company_id = 'd2000000-0000-4000-8000-000000000001')")" "$counts" \
  "demo seed: every generated client, document and payment stored ($counts)"
check "$(count e19 "select count(*) from public.clients where company_id = 'd2000000-0000-4000-8000-000000000001' and name not like 'Demo · %'")/$(count e19 "select count(*) from public.documents where company_id = 'd2000000-0000-4000-8000-000000000001' and (document_number not like 'DEMO-%' or metadata->>'source' <> 'businessai-demo-qa')")" "0/0" \
  "demo seed: every row is identified as demo"
cat > "$WORK/demo_rls.sql" <<'SQL'
begin;
select set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true) \gset ignored_
set local role authenticated;
select (select count(*) from public.documents) || '/' || (select count(*) from public.companies) || '/' ||
       public.has_permission('d2000000-0000-4000-8000-000000000001', 'payments.view');
rollback;
SQL
check "$("${RUNAS[@]}" psql -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d e19 -f - < "$WORK/demo_rls.sql" 2>&1 | grep -E '^[0-9]+/[0-9]+/(true|false)$')" "$(echo "$counts" | cut -d' ' -f2)/1/true" \
  "demo seed: the tester (admin) sees exactly the demo company and its documents through RLS"
# Removal: the same order as demo-company.mjs "remove".
for t in payments document_deletion_audit documents clients company_profiles company_subscriptions memberships; do
  psqlq -d e19 -c "delete from public.$t where company_id = 'd2000000-0000-4000-8000-000000000001'" >/dev/null
done
psqlq -d e19 -c "delete from public.companies where id = 'd2000000-0000-4000-8000-000000000001' and name = 'BusinessAI Demo (QA)'" \
  -c "delete from auth.users where id = 'd1000000-0000-4000-8000-000000000001'" >/dev/null && check ok ok "demo removal runs in the script's order"
check "$(count e19 "select (select count(*) from public.companies where name = 'BusinessAI Demo (QA)') + (select count(*) from public.clients where name like 'Demo · %') + (select count(*) from public.documents where document_number like 'DEMO-%') + (select count(*) from public.payments where reference like 'DEMO-%')")/$(count e19 "select count(*) from public.companies where id = 'e1900000-0000-4000-8000-0000000000c1'")" "0/1" \
  "demo removal leaves no demo row and does not touch other companies"

echo "== Scenario 20: R3 — 0014a stops on storage.objects policies that could reach the company buckets"
STOR="$HERE/../../inspect/inspect_storage_policies.sql"
VER="$HERE/../../inspect/verify_0014a.sql"
ro() { PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" psql -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d "$1" \
  -c "begin transaction read only" -f "$2" -c "rollback"; }
r3_stop() { # $1 db, $2 policy, $3 create statement, $4 expected verdict, $5 label
  stg_db "$1"; psqlq -d "$1" -c "$3" >/dev/null
  check "$(ro "$1" "$STOR" | grep -c "^$2|.*|$4")" 1 "$5: the read-only inspection marks it '$4'"
  fingerprint "$1" "$WORK/$1_a.txt"
  if psqlq -d "$1" -f "$MIG/$P14.sql" >"$WORK/$1.out" 2>&1; then check applied stopped "$5: 0014a stops"; else
    grep -q 'storage.objects policies that could reach the company buckets were found; nothing was changed' "$WORK/$1.out" \
      && grep -qF "$2 [" "$WORK/$1.out" && check stopped stopped "$5: 0014a stops and names $2"; fi
  fingerprint "$1" "$WORK/$1_b.txt"
  check "$(diff -q "$WORK/$1_a.txt" "$WORK/$1_b.txt" >/dev/null && echo same || echo changed)/$(count "$1" "select count(*) from pg_policies where schemaname = 'storage' and policyname = '$2'")" "same/1" \
    "$5: nothing changed and the policy was NOT dropped"
}
r3_stop r3a sig_read_all "create policy sig_read_all on storage.objects for select to authenticated using (bucket_id = 'Company-signatures')" \
  'block: mentions Company-assets or Company-signatures' "another policy on Company-signatures"
r3_stop r3b assets_lower "create policy assets_lower on storage.objects for select to authenticated using (lower(bucket_id) = 'company-assets')" \
  'block: mentions Company-assets or Company-signatures' "a policy on Company-assets written in another case"
r3_stop r3c read_everything "create policy read_everything on storage.objects for select to authenticated using (true)" \
  'block: not limited by bucket' "using (true) for authenticated (every bucket)"
r3_stop r3d upload_anything "create policy upload_anything on storage.objects for insert to authenticated with check (auth.uid() is not null)" \
  'block: not limited by bucket' "an INSERT policy that does not filter by bucket"
r3_stop r3e avatars_or_all "create policy avatars_or_all on storage.objects for select to anon using (bucket_id = 'avatars' or true)" \
  'block: not limited by bucket' "a bucket filter defeated by OR"
r3_stop r3f not_x "create policy not_x on storage.objects for select to authenticated using (bucket_id <> 'avatars')" \
  'block: not limited by bucket' "bucket_id <> 'avatars' (every other bucket)"
r3_stop r3g insert_no_check "create policy insert_no_check on storage.objects for insert to authenticated" \
  'block: no condition' "an INSERT policy with no condition"
r3_stop r3h avatars_move "create policy avatars_move on storage.objects for update to authenticated using (bucket_id = 'avatars') with check (true)" \
  'block: not limited by bucket' "an UPDATE that may move a file into any bucket (with check true)"
r3_stop r3i restrictive_all "create policy restrictive_all on storage.objects as restrictive for select to authenticated using (owner is not null)" \
  'block: not limited by bucket' "a RESTRICTIVE policy on every bucket (would change company-bucket behaviour)"
# Policies limited to other buckets: 0014a applies, keeps them unchanged and lists them.
stg_db r3ok
psqlq -d r3ok -c "create policy avatars_read on storage.objects for select to authenticated using (bucket_id = 'avatars' and name like 'public/%')" \
  -c "create policy media_upload on storage.objects for insert to authenticated with check (bucket_id in ('media', 'docs') and owner = auth.uid())" \
  -c "create policy avatars_mine on storage.objects for update to authenticated using (owner = auth.uid() and bucket_id = 'avatars')" >/dev/null
before_q="$(count r3ok "select string_agg(policyname || coalesce(qual, '') || coalesce(with_check, ''), '|' order by policyname) from pg_policies where schemaname = 'storage' and policyname in ('avatars_read', 'media_upload', 'avatars_mine')")"
check "$(ro r3ok "$STOR" | grep -c '|allowed: limited to bucket ')" 3 "other buckets: the inspection marks the 3 policies 'allowed'"
if PGOPTIONS="-c client_min_messages=warning" "${RUNAS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d r3ok -f "$MIG/$P14.sql" >"$WORK/r3ok.out" 2>&1; then
  check ok ok "other buckets: 0014a applies"; else head -5 "$WORK/r3ok.out"; check failed ok "other buckets: 0014a applies"; fi
check "$(grep -c 'storage.objects policies of other buckets kept unchanged: avatars_mine (allowed: limited to bucket avatars), avatars_read (allowed: limited to bucket avatars), media_upload (allowed: limited to bucket docs, media)' "$WORK/r3ok.out")" 1 \
  "other buckets: 0014a lists them in a warning"
check "$(count r3ok "select string_agg(policyname || coalesce(qual, '') || coalesce(with_check, ''), '|' order by policyname) from pg_policies where schemaname = 'storage' and policyname in ('avatars_read', 'media_upload', 'avatars_mine')")" "$before_q" \
  "other buckets: the 3 policies are unchanged"
check "$(ro r3ok "$VER")" OK "other buckets: verify_0014a answers OK"
matrix r3ok "$WORK/m_r3ok.txt"; same_matrix "$WORK/m_r3ok.txt" "other buckets: behaviour matrix identical to before 0014a"
o="$(ro r3ok "$STOR")"; check "$(grep -c '|repository|' <<<"$o")/$(grep -c '|allowed: ' <<<"$o")/$(grep -c '|block: ' <<<"$o")" "5/3/0" \
  "inspection after 0014a: 5 repository, 3 allowed, 0 blocked"
# Detected AFTER 0014a (e.g. a policy added later in the Dashboard): verify_0014a fails, read-only.
psqlq -d r3ok -c "create policy late_all on storage.objects for select to authenticated using (true)" \
  -c "create policy late_sig on storage.objects for delete to authenticated using (bucket_id = 'Company-signatures')" \
  -c "create policy clients_late on public.clients for select to authenticated using (true)" >/dev/null
fingerprint r3ok "$WORK/r3v_a.txt"
v="$(ro r3ok "$VER")"
check "$(grep -o 'storage.objects policy late_all \[PERMISSIVE SELECT to authenticated\] block: not limited by bucket\|storage.objects policy late_sig \[PERMISSIVE DELETE to authenticated\] block: mentions Company-assets or Company-signatures\|tenant table: public.clients:clients_late' <<<"$v" | sort -u | wc -l)" 3 \
  "verify_0014a detects later storage policies (every bucket / Company-signatures) and an unknown tenant policy"
fingerprint r3ok "$WORK/r3v_b.txt"
check "$(diff -q "$WORK/r3v_a.txt" "$WORK/r3v_b.txt" >/dev/null && echo same || echo changed)" same "verify_0014a and the inspection changed nothing (read-only)"
# Re-applying 0014a now stops (the late policies) — still nothing dropped.
if psqlq -d r3ok -f "$MIG/$P14.sql" >"$WORK/r3re.out" 2>&1; then check applied stopped "re-apply with late policies"; else
  grep -q 'public.clients:clients_late' "$WORK/r3re.out" && check stopped stopped "re-apply with an unknown policy stops (tenant guard first)"; fi
psqlq -d r3ok -c "drop policy clients_late on public.clients" >/dev/null
if psqlq -d r3ok -f "$MIG/$P14.sql" >"$WORK/r3re2.out" 2>&1; then check applied stopped "re-apply with late storage policies"; else
  grep -qF 'late_all [' "$WORK/r3re2.out" && grep -qF 'late_sig [' "$WORK/r3re2.out" && check stopped stopped "re-apply with late storage policies stops and names both"; fi
check "$(count r3ok "select count(*) from pg_policies where schemaname = 'storage' and policyname in ('late_all', 'late_sig')")" 2 "re-apply: the late policies were not dropped"
# Production path: the inspected database (before any migration) and after 0005…0011.
base r3p0
o="$(ro r3p0 "$STOR")"; check "$(grep -c '|block: ' <<<"$o")/$(grep -c '|allowed: \||repository|' <<<"$o")" "11/0" \
  "production shape BEFORE 0007: the inspection blocks all 11 old storage policies (0007 removes them)"
base r3p1; for m in "${ALL_MIGS[@]}"; do psqlq -d r3p1 -f "$MIG/$m.sql" >/dev/null; done
check "$(ro r3p1 "$STOR" | grep -c '|block: ')/$(ro r3p1 "$STOR" | grep -c '|repository|')" "0/5" "production path after 0005…0011: 0 blocked, 5 repository policies"
psqlq -d r3p1 -f "$MIG/$P14.sql" >/dev/null && check ok ok "production path: 0014a (with the R3 guard) applies"

echo "== Scenario 21: read-only Production inspections — 0007 preview, real migration state, 0010/0011 impact"
P7="$HERE/../../inspect/inspect_0007_preview.sql"; MS="$HERE/../../inspect/inspect_migration_state.sql"; IMP="$HERE/../../inspect/inspect_0010_impact.sql"
st() { ro "$1" "$MS" | cut -d'|' -f1,2 | tr '\n' ';'; }
# Inspected production shape: nothing of 0005…0014a applied; 0007 would drop exactly the 11 policies.
base i0; fingerprint i0 "$WORK/i0_a.txt"
o="$(ro i0 "$P7")"
check "$(grep -c '^summary|totals|.*dropped=11, guard_failures=0, kept_non_ba=0, ba=0, stop=0 ' <<<"$o")" 1 "0007 preview on the inspected shape: dropped=11, guard_failures=0, stop=0"
check "$(grep -c '^policy|.*|t|t|dropped by 0007$' <<<"$o")/$(grep -c '^bucket|Company-assets|.*ok: the real logo bucket' <<<"$o")" "11/1" "0007 preview: each of the 11 policies 'dropped by 0007'; Company-assets found"
check "$(st i0)" "0001–0004 base schema|applied;0005_security_baseline|not applied;0006_payments_document_fk|not applied;0007_storage_company_assets|not applied;0008_definer_function_grants|not applied;0009_private_signatures|not applied;0010_billing|not applied;0011_usage_limits|not applied;0014a_permissions|not applied;0015_documents_lifecycle|not applied;0016_billing_hardening|not applied;0017_plan_features|not applied;0018_team|not applied;0019_crm|not applied;0020_workforce|not applied;0021_workforce_kiosk|not applied;0022_workforce_rules|not applied;0023_ledger|not applied;0024_payables|not applied;0025_receivables|not applied;0026_bank_reconciliation|not applied;0027_statements_budgets|not applied;0028_document_studio|not applied;0029_assistant|not applied;0030_intelligence_core|not applied;staging bookkeeping (ba_meta)|absent;" \
  "migration state on the inspected shape: base applied, 0005…0016 not applied, no ba_meta"
o="$(ro i0 "$IMP")"; check "$(cut -d'|' -f1-5 <<<"$o")" "0|0|0|0|0" "0010 impact query runs on the inspected shape (no companies in the fixture)"
fingerprint i0 "$WORK/i0_b.txt"
check "$(diff -q "$WORK/i0_a.txt" "$WORK/i0_b.txt" >/dev/null && echo same || echo changed)" same "the three inspections changed nothing (read-only transaction)"
# The 0007 preview's drop condition is 0007's: apply 0007 and compare.
base i0d; dropped="$(ro i0d "$P7" | grep -c '^policy|.*dropped by 0007$')"
psqlq -d i0d -f "$MIG/0007_storage_company_assets.sql" >/dev/null
check "$dropped/$(count i0d "select count(*) from pg_policies where schemaname = 'storage' and policyname not like 'ba\_%'")/$(count i0d "select count(*) from pg_policies where schemaname = 'storage' and policyname like 'ba\_company\_assets\_%'")" "11/0/2" \
  "preview = reality: the 11 previewed policies are exactly the ones 0007 dropped; 2 ba_ created"
# STOP cases the preview must show.
base i0s; psqlq -d i0s -c "insert into storage.buckets (id, name, public) values ('company-assets', 'company-assets', false)" \
  -c "create policy everything on storage.objects for select to authenticated using (true)" >/dev/null
o="$(ro i0s "$P7")"
check "$(grep -c '^bucket|company-assets|.*STOP: same name as Company-assets in another case' <<<"$o")/$(grep -c '^policy|everything|SELECT|.*STOP: no bucket_id, 0007 aborts' <<<"$o")/$(grep -c 'stop=2 ' <<<"$o")" "1/1/1" \
  "0007 preview: STOP on a 'company-assets' bucket and on a policy without bucket_id"
# Full production path (0005…0011 + 0014a + 0015 + 0016): everything applied.
base i1; for m in "${ALL_MIGS[@]}" "$P14" 0015_documents_lifecycle 0016_billing_hardening 0017_plan_features 0018_team 0019_crm 0020_workforce 0021_workforce_kiosk 0022_workforce_rules 0023_ledger 0024_payables 0025_receivables 0026_bank_reconciliation 0027_statements_budgets 0028_document_studio 0029_assistant 0030_intelligence_core; do psqlq -d i1 -f "$MIG/$m.sql" >/dev/null; done
check "$(st i1)" "0001–0004 base schema|applied;0005_security_baseline|applied;0006_payments_document_fk|applied;0007_storage_company_assets|applied;0008_definer_function_grants|applied;0009_private_signatures|applied;0010_billing|applied;0011_usage_limits|applied;0014a_permissions|applied;0015_documents_lifecycle|applied;0016_billing_hardening|applied;0017_plan_features|applied;0018_team|applied;0019_crm|applied;0020_workforce|applied;0021_workforce_kiosk|applied;0022_workforce_rules|applied;0023_ledger|applied;0024_payables|applied;0025_receivables|applied;0026_bank_reconciliation|applied;0027_statements_budgets|applied;0028_document_studio|applied;0029_assistant|applied;0030_intelligence_core|applied;staging bookkeeping (ba_meta)|absent;" \
  "migration state after the full production path: every migration 'applied'"
check "$(ro i1 "$P7" | grep -c 'dropped=0, guard_failures=0, kept_non_ba=0, ba=10, stop=0 ')" 1 "0007 preview after everything: nothing left to drop, 10 ba_ policies (5 company buckets + 3 Finance-attachments of 0024 + 2 Studio-assets of 0028)"
# Partial states are reported, not guessed.
base i2; psqlq -d i2 -f "$MIG/0010_billing.sql" >/dev/null
check "$(ro i2 "$MS" | grep -c '^0010_billing|applied|')/$(ro i2 "$MS" | grep -c '^0011_usage_limits|not applied|')" "1/1" "migration state: 0010 alone → 0010 applied, 0011 not applied"
psqlq -d i2 -c "drop trigger ba_enforce_billing_documents on public.documents" >/dev/null
check "$(ro i2 "$MS" | grep -c '^0010_billing|PARTIAL — review|.*triggers=2/3')" 1 "migration state: a missing 0010 trigger shows PARTIAL — review"
# 0010/0011 impact on existing companies (counts only).
base i3
psqlq -d i3 -c "insert into auth.users (id) select ('4a000000-0000-4000-8000-00000000000' || g)::uuid from generate_series(1, 6) g;
  insert into public.companies (id, name, created_by) values
    ('4c000000-0000-4000-8000-000000000001', 'Sin suscripción', '4a000000-0000-4000-8000-000000000001'),
    ('4c000000-0000-4000-8000-000000000002', 'Pro activa', '4a000000-0000-4000-8000-000000000002'),
    ('4c000000-0000-4000-8000-000000000003', 'Cancelada', '4a000000-0000-4000-8000-000000000003');
  insert into public.memberships (company_id, user_id, role) values
    ('4c000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000001', 'owner'),
    ('4c000000-0000-4000-8000-000000000002', '4a000000-0000-4000-8000-000000000002', 'owner'),
    ('4c000000-0000-4000-8000-000000000002', '4a000000-0000-4000-8000-000000000004', 'admin'),
    ('4c000000-0000-4000-8000-000000000002', '4a000000-0000-4000-8000-000000000005', 'member'),
    ('4c000000-0000-4000-8000-000000000002', '4a000000-0000-4000-8000-000000000006', 'member'),
    ('4c000000-0000-4000-8000-000000000003', '4a000000-0000-4000-8000-000000000003', 'owner');
  insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
    ('4c000000-0000-4000-8000-000000000002', 'cus_i3b', 'sub_i3b', 'pro', 'active'),
    ('4c000000-0000-4000-8000-000000000003', 'cus_i3c', 'sub_i3c', 'basic', 'canceled');" >/dev/null
check "$(ro i3 "$IMP")" "3|1|2|1|1|active:1, canceled:1, no row:1|basic:1, no row:1, pro:1|0|0|0|1|1" \
  "0010 impact: 3 companies, 1 can create, 2 blocked (1 without Stripe subscription, 1 canceled); 1 over the Pro member limit"

echo "== Scenario 22: 0015 document lifecycle — numbering, statuses, no deletion of issued documents, payments, receipts, owner billing"
P15=0015_documents_lifecycle
stg_db l22a; psqlq -d l22a -f "$MIG/$P14.sql" >/dev/null; fingerprint l22a "$WORK/fp15_before.txt"
stg_db l22m0; psqlq -d l22m0 -f "$MIG/$P14.sql" >/dev/null; matrix l22m0 "$WORK/m15_before.txt"
psqlq -d l22a -f "$MIG/$P15.sql" >/dev/null && check ok ok "0015 applies after 0014a"
psqlq -d l22a -f "$MIG/$P15.sql" >/dev/null && check ok ok "0015 re-applies cleanly (idempotent)"
check "$(ro l22a "$VER")" OK "verify_0014a answers OK after 0015 (owner-only billing, documents.void)"
stg_db l22m1; psqlq -d l22m1 -f "$MIG/$P14.sql" >/dev/null; psqlq -d l22m1 -f "$MIG/$P15.sql" >/dev/null; matrix l22m1 "$WORK/m15_after.txt"
diff "$WORK/m15_before.txt" "$WORK/m15_after.txt" | grep '^[<>]' | sed 's/^/    matrix change: /' || true
check "$(diff "$WORK/m15_before.txt" "$WORK/m15_after.txt" | grep '^[<>]' | grep -vc '^[<>] \(oa\|aa\|ma\)|insert payment A' || true)" 0 \
  "behaviour matrix after 0015: the only change is that company A members cannot pay its DRAFT invoice; outsiders get the same errors as before"
stg_db l22b; psqlq -d l22b -f "$MIG/$P14.sql" >/dev/null; psqlq -d l22b -f "$MIG/$P15.sql" >/dev/null
run_suite l22b "$HERE/74_documents_lifecycle.test.sql" 'ALL LIFECYCLE TESTS PASSED' "lifecycle suite"
run_suite l22b "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "with 0015: RLS suite"
run_suite l22b "$HERE/30_private_signatures.test.sql" 'ALL SIGNATURE TESTS PASSED' "with 0015: signature suite"
run_suite l22b "$HERE/50_billing.test.sql" 'ALL BILLING TESTS PASSED' "with 0015: billing suite"
run_suite l22b "$HERE/60_usage.test.sql" 'ALL USAGE TESTS PASSED' "with 0015: usage limits suite"
# Rollback: back to the exact 0014a catalog.
psqlq -d l22a -f "$HERE/../../rollback/0015_rollback.sql" >/dev/null && check ok ok "0015 rollback runs"
fingerprint l22a "$WORK/fp15_after.txt"
if diff -u "$WORK/fp15_before.txt" "$WORK/fp15_after.txt" > "$WORK/fp15.diff"; then check ok ok "after the 0015 rollback the catalog is identical to 0014a"
else head -20 "$WORK/fp15.diff"; check different ok "after the 0015 rollback the catalog is identical to 0014a"; fi
check "$(ro l22a "$VER")" OK "verify_0014a answers OK after the 0015 rollback"
# Production path: inspected database + 0005…0011 + 0014a + 0015.
base p22; for m in "${ALL_MIGS[@]}" "$P14" "$P15"; do psqlq -d p22 -f "$MIG/$m.sql" >/dev/null; done
check "$(ro p22 "$VER")/$(ro p22 "$STOR" | grep -c '|block: ')" "OK/0" "production path: 0015 applies; verify_0014a OK; no blocked storage policy"
# Concurrent payments (I4) and repeated submissions (I5): two real sessions.
source "$HERE/75_payment_race.sh"
stg_db l22r; psqlq -d l22r -f "$MIG/$P14.sql" >/dev/null; psqlq -d l22r -f "$MIG/$P15.sql" >/dev/null
check "$(race l22r 'read committed' 60 60)" "1|60|sent|PAYMENT_EXCEEDS_BALANCE," "I4 READ COMMITTED: two payments of 60 on 100 → one accepted, the other PAYMENT_EXCEEDS_BALANCE"
check "$(race l22r 'repeatable read' 60 60)" "1|60|sent|could not serialize access due to concurrent update," "I4 REPEATABLE READ: one accepted, the other fails with a serialization error (no overpayment)"
check "$(race l22r 'serializable' 60 60)" "1|60|sent|could not serialize access due to concurrent update," "I4 SERIALIZABLE: one accepted, the other fails (no overpayment)"
check "$(race l22r 'repeatable read' 60 40)" "1|60|sent|could not serialize access due to concurrent update," "REPEATABLE READ 60 + 40: the late one must retry (never a stale balance)"
check "$(race l22r 'read committed' 60 40)" "2|100|paid|" "READ COMMITTED 60 + 40: both accepted and the invoice is paid"
check "$(race l22r 'read committed' 30 30 dup-key-0001 dup-key-0001)" "1|30|sent|payments_idempotency_uidx," "I5: the same form submitted twice at once stores one payment"
# Rollback with real data: documents, numbers, payments and history stay; a re-apply continues.
stg_db l22d; psqlq -d l22d -f "$MIG/$P14.sql" >/dev/null; psqlq -d l22d -f "$MIG/$P15.sql" >/dev/null; race l22d 'read committed' 60 40 >/dev/null
psqlq -d l22d -f "$HERE/../../rollback/0015_rollback.sql" >/dev/null 2>&1 && check ok ok "0015 rollback runs with documents, payments and history"
check "$(count l22d "select (select count(*) from public.payments)||'/'||(select status from public.documents where id='7d000000-0000-4000-8000-000000000001')||'/'||(to_regclass('public.document_events') is not null)||'/'||(select count(*) from public.document_events)")" "2/paid/true/2" \
  "after the rollback: payments, the paid status and the history (kept because not empty) are intact"
psqlq -d l22d -f "$MIG/$P15.sql" >/dev/null && check ok ok "0015 re-applies after the rollback (history table reused)"
check "$(count l22d "select count(*) from public.document_events")" 2 "the history survives rollback + re-apply"
# Refused rollback while a quote is accepted.
stg_db l22c; psqlq -d l22c -f "$MIG/$P14.sql" >/dev/null; psqlq -d l22c -f "$MIG/$P15.sql" >/dev/null
psqlq -d l22c -c "insert into auth.users (id) values ('6a000000-0000-4000-8000-000000000001');
  insert into public.companies (id, name, created_by) values ('6c000000-0000-4000-8000-000000000001', 'Aceptada', '6a000000-0000-4000-8000-000000000001');
  insert into public.documents (company_id, document_type, status) values ('6c000000-0000-4000-8000-000000000001', 'quote', 'accepted');" >/dev/null
if psqlq -d l22c -f "$HERE/../../rollback/0015_rollback.sql" >"$WORK/l22c.out" 2>&1; then check ran refused "0015 rollback with an accepted quote"; else
  grep -q "accepted/rejected quotes exist" "$WORK/l22c.out" && check refused refused "0015 rollback refuses while a quote is accepted (nothing changed)"; fi

echo "== Scenario 23: 0016 billing hardening — one trial per person, receipts outside the quota"
P16=0016_billing_hardening
stg_db l23a; fingerprint l23a "$WORK/fp16_before.txt"
psqlq -d l23a -f "$MIG/$P16.sql" >/dev/null && check ok ok "0016 applies on 0011 (without 0014a/0015)"
psqlq -d l23a -f "$MIG/$P16.sql" >/dev/null && check ok ok "0016 re-applies cleanly (idempotent)"
run_suite l23a "$HERE/76_billing_hardening.test.sql" 'ALL BILLING HARDENING TESTS PASSED' "0016 suite (without 0015)"
stg_db l23b; for m in "$P14" "$P15" "$P16"; do psqlq -d l23b -f "$MIG/$m.sql" >/dev/null; done
run_suite l23b "$HERE/76_billing_hardening.test.sql" 'ALL BILLING HARDENING TESTS PASSED' "0016 suite (with 0014a + 0015)"
stg_db l23c; for m in "$P14" "$P15" "$P16"; do psqlq -d l23c -f "$MIG/$m.sql" >/dev/null; done
run_suite l23c "$HERE/74_documents_lifecycle.test.sql" 'ALL LIFECYCLE TESTS PASSED' "with 0016: lifecycle suite"
run_suite l23c "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "with 0016: RLS suite"
run_suite l23c "$HERE/50_billing.test.sql" 'ALL BILLING TESTS PASSED' "with 0016: billing suite"
run_suite l23c "$HERE/60_usage.test.sql" 'ALL USAGE TESTS PASSED' "with 0016: usage limits suite"
stg_db l23e; psqlq -d l23e -f "$MIG/$P16.sql" >/dev/null
psqlq -d l23e -f "$HERE/../../rollback/0016_rollback.sql" >/dev/null && check ok ok "0016 rollback runs"
fingerprint l23e "$WORK/fp16_after.txt"
if diff -u "$WORK/fp16_before.txt" "$WORK/fp16_after.txt" > "$WORK/fp16.diff"; then check ok ok "after the 0016 rollback the catalog is identical to 0011"
else head -20 "$WORK/fp16.diff"; check different ok "after the 0016 rollback the catalog is identical to 0011"; fi
psqlq -d l23a -f "$HERE/../../rollback/0016_rollback.sql" >/dev/null && check ok ok "0016 rollback runs with claims and receipts present"
check "$(count l23a "select count(*) from public.documents where document_type = 'receipt'")" 1 "the rollback keeps the receipts"
base p23; for m in "${ALL_MIGS[@]}" "$P14" "$P15" "$P16"; do psqlq -d p23 -f "$MIG/$m.sql" >/dev/null; done
check "$(ro p23 "$VER")" OK "production path: 0005…0011 + 0014a + 0015 + 0016 apply; verify_0014a OK"
check "$(ro p23 "$MS" | cut -d'|' -f1,2 | grep -c '|applied$')" 11 "migration state after the production path: every row (0001–0004 … 0016) 'applied'"
check "$(ro l23e "$MS" | grep -E '^001[56]_' | cut -d'|' -f1,2 | tr '\n' ';')" "0015_documents_lifecycle|not applied;0016_billing_hardening|not applied;" "migration state after the 0016 rollback (no 0015 there): 0015 and 0016 'not applied'"

echo "== Scenario 24: 0017 plan features — deny by default, approved limits, rollback"
P17=0017_plan_features
stg_db l24a; for m in "$P14" "$P15" "$P16"; do psqlq -d l24a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l24a "$WORK/fp17_before.txt"
psqlq -d l24a -f "$MIG/$P17.sql" >/dev/null && check ok ok "0017 applies after 0016"
psqlq -d l24a -f "$MIG/$P17.sql" >/dev/null && check ok ok "0017 re-applies cleanly (idempotent)"
stg_db l24b; psqlq -d l24b -f "$MIG/$P17.sql" >/dev/null && check ok ok "0017 applies on 0011 alone"
run_suite l24a "$HERE/77_plan_features.test.sql" 'ALL PLAN FEATURE TESTS PASSED' "plan features suite"
stg_db l24c; for m in "$P14" "$P15" "$P16" "$P17"; do psqlq -d l24c -f "$MIG/$m.sql" >/dev/null; done
psqlq -d l24c -f "$HERE/../../rollback/0017_rollback.sql" >/dev/null && check ok ok "0017 rollback runs"
fingerprint l24c "$WORK/fp17_after.txt"
if diff -u "$WORK/fp17_before.txt" "$WORK/fp17_after.txt" > "$WORK/fp17.diff"; then check ok ok "after the 0017 rollback the catalog is identical to 0016"
else head -20 "$WORK/fp17.diff"; check different ok "after the 0017 rollback the catalog is identical to 0016"; fi

echo "== Scenario 25: 0018 team + 0019 CRM — invitations, roles, attacks, archive, history, rollbacks"
P18=0018_team; P19=0019_crm
stg_db l25a; for m in "$P14" "$P15" "$P16" "$P17"; do psqlq -d l25a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l25a "$WORK/fp18_before.txt"
for m in "$P18" "$P18" "$P19" "$P19"; do psqlq -d l25a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "0018 and 0019 apply and re-apply cleanly"
check "$(ro l25a "$VER")" OK "verify_0014a answers OK with 0018 and 0019 (permission matrix extended)"
run_suite l25a "$HERE/78_team.test.sql" 'ALL TEAM TESTS PASSED' "team suite (invitations, roles, attacks)"
run_suite l25a "$HERE/79_crm.test.sql" 'ALL CRM TESTS PASSED' "CRM suite (archive, history, language)"
run_suite l25a "$HERE/77_plan_features.test.sql" 'ALL PLAN FEATURE TESTS PASSED' "with 0018/0019: plan features suite"
stg_db l25b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19"; do psqlq -d l25b -f "$MIG/$m.sql" >/dev/null; done
run_suite l25b "$HERE/10_rls_business.test.sql" 'ALL RLS TESTS PASSED' "with 0018/0019: RLS suite"
run_suite l25b "$HERE/50_billing.test.sql" 'ALL BILLING TESTS PASSED' "with 0018/0019: billing suite"
run_suite l25b "$HERE/60_usage.test.sql" 'ALL USAGE TESTS PASSED' "with 0018/0019: usage limits suite"
stg_db l25c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19"; do psqlq -d l25c -f "$MIG/$m.sql" >/dev/null; done
psqlq -d l25c -f "$HERE/../../rollback/0019_rollback.sql" >/dev/null && psqlq -d l25c -f "$HERE/../../rollback/0018_rollback.sql" >/dev/null && check ok ok "0019 then 0018 rollbacks run"
fingerprint l25c "$WORK/fp18_after.txt"
if diff -u "$WORK/fp18_before.txt" "$WORK/fp18_after.txt" > "$WORK/fp18.diff"; then check ok ok "after the 0019 + 0018 rollbacks the catalog is identical to 0017"
else head -20 "$WORK/fp18.diff"; check different ok "after the 0019 + 0018 rollbacks the catalog is identical to 0017"; fi
# Refusals with live data (the 0018/0019 suites left a pending invitation? archived clients?)
psqlq -d l25a -c "update public.clients set archived_at = now() where id = (select id from public.clients limit 1)" >/dev/null
if psqlq -d l25a -f "$HERE/../../rollback/0019_rollback.sql" >"$WORK/l25a.out" 2>&1; then check ran refused "0019 rollback with an archived client"; else
  grep -q "archived clients exist" "$WORK/l25a.out" && check refused refused "0019 rollback refuses while a client is archived (nothing changed)"; fi
psqlq -d l25a -c "insert into public.invitations (company_id, email, role, token_hash, expires_at) select id, 'p@example.test', 'member', repeat('b', 64), now() + interval '1 day' from public.companies limit 1" >/dev/null
if psqlq -d l25a -f "$HERE/../../rollback/0018_rollback.sql" >"$WORK/l25a2.out" 2>&1; then check ran refused "0018 rollback with a pending invitation"; else
  grep -q "pending invitations exist" "$WORK/l25a2.out" && check refused refused "0018 rollback refuses while an invitation is pending (nothing changed)"; fi
check "$(count l25a "select (to_regprocedure('public.accept_invitation(text)') is not null)::text")" true "after the refusals 0018 is intact"

echo "== Scenario 26: 0020 workforce — employees, time clock, corrections, leave, shifts, concurrency, rollback"
P20=0020_workforce
stg_db l26a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19"; do psqlq -d l26a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l26a "$WORK/fp20_before.txt"
psqlq -d l26a -f "$MIG/$P20.sql" >/dev/null && psqlq -d l26a -f "$MIG/$P20.sql" >/dev/null && check ok ok "0020 applies and re-applies cleanly"
check "$(ro l26a "$VER")" OK "verify_0014a answers OK with 0020 (workforce.manage owner + admin)"
run_suite l26a "$HERE/80_workforce.test.sql" 'ALL WORKFORCE TESTS PASSED' "workforce suite (plans, isolation, clock, corrections, leave, shifts)"
run_suite l26a "$HERE/78_team.test.sql" 'ALL TEAM TESTS PASSED' "with 0020: team suite"
source "$HERE/81_workforce_race.sh"
stg_db l26r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20"; do psqlq -d l26r -f "$MIG/$m.sql" >/dev/null; done
check "$(wf_race_punch l26r)" "1|1|PUNCH_SEQUENCE" "two simultaneous taps on Entrada: one punch, the other refused (PUNCH_SEQUENCE)"
check "$(wf_race_hire l26r)" "1|3|PLAN_LIMIT_EMPLOYEES" "two simultaneous hires at 2 of 3 (Basic): one fits, the other PLAN_LIMIT_EMPLOYEES"
stg_db l26c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20"; do psqlq -d l26c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l26c -f "$HERE/../../rollback/0020_rollback.sql" >"$WORK/l26c.out" 2>&1; then check ok ok "0020 rollback runs without workforce data"; else head -3 "$WORK/l26c.out"; check failed ok "0020 rollback runs without workforce data"; fi
fingerprint l26c "$WORK/fp20_after.txt"
if diff -u "$WORK/fp20_before.txt" "$WORK/fp20_after.txt" > "$WORK/fp20.diff"; then check ok ok "after the 0020 rollback the catalog is identical to 0019"
else head -20 "$WORK/fp20.diff"; check different ok "after the 0020 rollback the catalog is identical to 0019"; fi
if psqlq -d l26r -f "$HERE/../../rollback/0020_rollback.sql" >"$WORK/l26r.out" 2>&1; then check ran refused "0020 rollback with attendance data"; else
  grep -q "workforce data exists" "$WORK/l26r.out" && check refused refused "0020 rollback refuses while attendance data exists (nothing changed)"; fi
check "$(count l26r "select count(*) from public.employees")" 3 "the workforce records are intact after the refused rollback"

echo "== Scenario 27: 0021 kiosk PIN mode, append-only evidence, supervisor scope, plan limits under concurrency"
P21=0021_workforce_kiosk
stg_db l27a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20"; do psqlq -d l27a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l27a "$WORK/fp21_before.txt"
psqlq -d l27a -f "$MIG/$P21.sql" >/dev/null && psqlq -d l27a -f "$MIG/$P21.sql" >/dev/null && check ok ok "0021 applies and re-applies cleanly"
check "$(ro l27a "$VER")" OK "verify_0014a answers OK with 0021"
run_suite l27a "$HERE/82_workforce_kiosk.test.sql" 'ALL KIOSK TESTS PASSED' "kiosk / PIN / append-only / supervisor scope suite"
stg_db l27b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21"; do psqlq -d l27b -f "$MIG/$m.sql" >/dev/null; done
run_suite l27b "$HERE/80_workforce.test.sql" 'ALL WORKFORCE TESTS PASSED' "with 0021: workforce suite"
run_suite l27b "$HERE/78_team.test.sql" 'ALL TEAM TESTS PASSED' "with 0021: team suite"
stg_db l27r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21"; do psqlq -d l27r -f "$MIG/$m.sql" >/dev/null; done
check "$(wf_race_punch l27r)" "1|1|PUNCH_SEQUENCE" "with 0021: two simultaneous taps → one punch"
for spec in "basic 3" "pro 25" "premium 100"; do
  set -- $spec
  check "$(wf_race_limit l27r "$1" "$2" hire)" "1|$2|PLAN_LIMIT_EMPLOYEES" "$1 ($2): two simultaneous hires at $(( $2 - 1 )) → exactly $2 active"
  check "$(wf_race_limit l27r "$1" "$2" reactivate)" "1|$2|PLAN_LIMIT_EMPLOYEES" "$1 ($2): two simultaneous reactivations at $(( $2 - 1 )) → exactly $2 active"
done
stg_db l27c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21"; do psqlq -d l27c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l27c -f "$HERE/../../rollback/0021_rollback.sql" >"$WORK/l27c.out" 2>&1; then check ok ok "0021 rollback runs without kiosk punches"; else head -3 "$WORK/l27c.out"; check failed ok "0021 rollback runs without kiosk punches"; fi
fingerprint l27c "$WORK/fp21_after.txt"
if diff -u "$WORK/fp21_before.txt" "$WORK/fp21_after.txt" > "$WORK/fp21.diff"; then check ok ok "after the 0021 rollback the catalog is identical to 0020"
else head -20 "$WORK/fp21.diff"; check different ok "after the 0021 rollback the catalog is identical to 0020"; fi
if psqlq -d l27a -f "$HERE/../../rollback/0021_rollback.sql" >"$WORK/l27a.out" 2>&1; then check ran refused "0021 rollback with kiosk punches"; else
  grep -q "punches made at kiosks exist" "$WORK/l27a.out" && check refused refused "0021 rollback refuses while kiosk punches exist (nothing changed)"; fi
check "$(count l27a "select count(*) from pg_trigger where tgname = 'ba_wf_append_only'")" 4 "after the refusal the evidence protection is intact"

echo "== Scenario 28: 0022 rules per employee / group, jurisdictions, meal alerts"
P22=0022_workforce_rules
stg_db l28a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21"; do psqlq -d l28a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l28a "$WORK/fp22_before.txt"
psqlq -d l28a -f "$MIG/$P22.sql" >/dev/null && psqlq -d l28a -f "$MIG/$P22.sql" >/dev/null && check ok ok "0022 applies and re-applies cleanly"
for m in "$P20" "$P21" "$P22"; do psqlq -d l28a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0020, 0021 and 0022 re-apply in order"
run_suite l28a "$HERE/83_workforce_rules.test.sql" 'ALL RULES TESTS PASSED' "rules / jurisdictions / meal alerts suite"
stg_db l28b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22"; do psqlq -d l28b -f "$MIG/$m.sql" >/dev/null; done
run_suite l28b "$HERE/80_workforce.test.sql" 'ALL WORKFORCE TESTS PASSED' "with 0022: workforce suite"
run_suite l28b "$HERE/82_workforce_kiosk.test.sql" 'ALL KIOSK TESTS PASSED' "with 0022: kiosk suite (6-digit PIN)"
stg_db l28c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22"; do psqlq -d l28c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l28c -f "$HERE/../../rollback/0022_rollback.sql" >"$WORK/l28c.out" 2>&1; then check ok ok "0022 rollback runs without alerts or groups in use"; else head -3 "$WORK/l28c.out"; check failed ok "0022 rollback runs without alerts or groups in use"; fi
fingerprint l28c "$WORK/fp22_after.txt"
if diff -u "$WORK/fp22_before.txt" "$WORK/fp22_after.txt" > "$WORK/fp22.diff"; then check ok ok "after the 0022 rollback the catalog is identical to 0021"
else head -20 "$WORK/fp22.diff"; check different ok "after the 0022 rollback the catalog is identical to 0021"; fi
if psqlq -d l28a -f "$HERE/../../rollback/0022_rollback.sql" >"$WORK/l28a.out" 2>&1; then check ran refused "0022 rollback with meal alerts"; else
  grep -q "meal alerts exist" "$WORK/l28a.out" && check refused refused "0022 rollback refuses while meal alerts exist (nothing changed)"; fi

echo "== Scenario 29: 0023 double-entry ledger — posting, immutability, reversals, periods, concurrency, rollback"
P23=0023_ledger
stg_db l29a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22"; do psqlq -d l29a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l29a "$WORK/fp23_before.txt"
psqlq -d l29a -f "$MIG/$P23.sql" >/dev/null && psqlq -d l29a -f "$MIG/$P23.sql" >/dev/null && check ok ok "0023 applies and re-applies cleanly"
for m in "$P15" "$P20" "$P21" "$P22" "$P23"; do psqlq -d l29a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0015 … 0023 re-apply in order"
check "$(ro l29a "$VER")" OK "verify_0014a answers OK with 0023 (accounting permissions)"
run_suite l29a "$HERE/84_ledger.test.sql" 'ALL LEDGER TESTS PASSED' "ledger suite (chart, posting, partial payments, voids, reversals, periods, isolation, import)"
stg_db l29b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23"; do psqlq -d l29b -f "$MIG/$m.sql" >/dev/null; done
stg_db l29d; for m in "$P14" "$P15" "$P23"; do psqlq -d l29d -f "$MIG/$m.sql" >/dev/null; done
run_suite l29d "$HERE/74_documents_lifecycle.test.sql" 'ALL LIFECYCLE TESTS PASSED' "0014a + 0015 + 0023: documents lifecycle suite (invoices post to the ledger)"
check "$(count l29d "select (select count(*) from public.journal_entries) > 0 and (select count(*) from public.ledger_integrity(c.id) i where i.unbalanced_entries > 0 or i.debit_cents <> i.credit_cents) = 0 from public.companies c limit 1")" t "the lifecycle documents posted balanced entries"
run_suite l29b "$HERE/80_workforce.test.sql" 'ALL WORKFORCE TESTS PASSED' "with 0023: workforce suite"
source "$HERE/85_ledger_race.sh"
stg_db l29r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23"; do psqlq -d l29r -f "$MIG/$m.sql" >/dev/null; done
check "$(lg_race_issue l29r)" "2|1|" "the same draft issued twice at once: one entry"
check "$(lg_race_pay l29r 60 60)" "1|1|PAYMENT_EXCEEDS_BALANCE,|4000/4000/0" "two payments of 60 on 100 at once: one posted, receivable = open balance"
check "$(lg_race_pay l29r 60 40)" "2|2||0/0/0" "60 + 40 at once: two payment entries, receivable 0"
check "$(lg_race_pay l29r 30 30 dup-key-0001 dup-key-0001)" "1|1|payments_idempotency_uidx,|7000/7000/0" "the same payment submitted twice at once: one payment, one entry"
check "$(lg_race_manual_idem l29r)" "2|1|" "the same manual entry (same key) twice at once: one entry"
check "$(lg_race_numbers l29r)" "2|2||1,2" "two entries at once: consecutive numbers, no gap"
check "$(lg_race_reverse l29r)" "1|1|ENTRY_ALREADY_REVERSED," "the same entry reversed twice at once: one reversal"
check "$(lg_race_close l29r 'read committed')" "1|0|PERIOD_CLOSED,|0" "READ COMMITTED: closing a month while posting into it — nothing lands in the closed month"
check "$(lg_race_close l29r 'repeatable read')" "1|0|could not serialize access due to concurrent update,|0" "REPEATABLE READ: the late posting fails to serialize instead of landing in the closed month"
stg_db l29c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23"; do psqlq -d l29c -f "$MIG/$m.sql" >/dev/null; done
psqlq -d l29c -c "insert into auth.users (id) values ('e1000000-0000-4000-8000-0000000000ff');
  insert into public.companies (id, name, created_by) values ('e2000000-0000-4000-8000-0000000000ff', 'Solo catálogo', 'e1000000-0000-4000-8000-0000000000ff');
  select public.ledger_ensure_chart('e2000000-0000-4000-8000-0000000000ff');" >/dev/null
if psqlq -d l29c -f "$HERE/../../rollback/0023_rollback.sql" >"$WORK/l29c.out" 2>&1; then check ok ok "0023 rollback runs with only a default chart (no entries)"; else head -3 "$WORK/l29c.out"; check failed ok "0023 rollback runs with only a default chart (no entries)"; fi
psqlq -d l29c -c "delete from public.companies where id = 'e2000000-0000-4000-8000-0000000000ff'; delete from auth.users where id = 'e1000000-0000-4000-8000-0000000000ff'" >/dev/null
fingerprint l29c "$WORK/fp23_after.txt"
if diff -u "$WORK/fp23_before.txt" "$WORK/fp23_after.txt" > "$WORK/fp23.diff"; then check ok ok "after the 0023 rollback the catalog is identical to 0022"
else head -20 "$WORK/fp23.diff"; check different ok "after the 0023 rollback the catalog is identical to 0022"; fi
check "$(count l29c "select count(*) from public.permissions where key like 'accounting.%'")" 0 "the rollback removes the accounting permissions"
if psqlq -d l29a -f "$HERE/../../rollback/0023_rollback.sql" >"$WORK/l29a.out" 2>&1; then check ran refused "0023 rollback with journal entries"; else
  grep -q "journal entries exist" "$WORK/l29a.out" && check refused refused "0023 rollback refuses while journal entries exist (nothing changed)"; fi
check "$(count l29a "select (to_regclass('public.journal_entries') is not null)::text || '/' || (select count(*) > 0 from public.journal_entries)::text")" "true/true" "after the refusal the ledger is intact"

echo "== Scenario 30: 0024 payables — vendors, bills, approvals, payments, attachments, recurring, concurrency, rollback"
P24=0024_payables
stg_db l30a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23"; do psqlq -d l30a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l30a "$WORK/fp24_before.txt"
psqlq -d l30a -f "$MIG/$P24.sql" >/dev/null && psqlq -d l30a -f "$MIG/$P24.sql" >/dev/null && check ok ok "0024 applies and re-applies cleanly"
for m in "$P15" "$P20" "$P21" "$P22" "$P23" "$P24"; do psqlq -d l30a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0015 … 0024 re-apply in order"
check "$(ro l30a "$VER")" OK "verify_0014a answers OK with 0024 (payables permissions; storage policies limited to Finance-attachments)"
run_suite l30a "$HERE/86_payables.test.sql" 'ALL PAYABLES TESTS PASSED' "payables suite (vendors, drafts, approvals and limits, payments, voids, attachments, recurring, reports, isolation)"
stg_db l30b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24"; do psqlq -d l30b -f "$MIG/$m.sql" >/dev/null; done
run_suite l30b "$HERE/84_ledger.test.sql" 'ALL LEDGER TESTS PASSED' "with 0024: ledger suite"
stg_db l30d; for m in "$P14" "$P15" "$P23" "$P24"; do psqlq -d l30d -f "$MIG/$m.sql" >/dev/null; done
run_suite l30d "$HERE/74_documents_lifecycle.test.sql" 'ALL LIFECYCLE TESTS PASSED' "0014a + 0015 + 0023 + 0024: documents lifecycle suite"
source "$HERE/87_payables_race.sh"
stg_db l30r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24"; do psqlq -d l30r -f "$MIG/$m.sql" >/dev/null; done
check "$(pb_race_approve l30r)" "1|1|BILL_TRANSITION,|approved/0" "the same bill approved twice at once: one entry"
check "$(pb_race_pay l30r 6000 6000)" "1|1|PAYMENT_EXCEEDS_BALANCE,|partially_paid/6000|4000/4000" "two payments of 60 on 100 at once: one refused; payable = open balance"
check "$(pb_race_pay l30r 6000 4000)" "2|2||paid/10000|0/0" "60 + 40 at once: both, paid, payable 0"
check "$(pb_race_pay l30r 3000 3000 dup-pay-0001 dup-pay-0001)" "2|1||partially_paid/3000|7000/7000" "the same vendor payment submitted twice at once: one payment, one entry"
check "$(pb_race_void_pay l30r)" "1|0|BILL_NOT_PAYABLE,|voided/0|0/0" "voiding while paying: the payment is refused, nothing posted"
check "$(pb_race_recurring l30r)" "2|6/6" "two recurring generations at once: one bill per period"
stg_db l30c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24"; do psqlq -d l30c -f "$MIG/$m.sql" >/dev/null; done
psqlq -d l30c -c "insert into auth.users (id) values ('e1000000-0000-4000-8000-0000000000fe');
  insert into public.companies (id, name, created_by) values ('e2000000-0000-4000-8000-0000000000fe', 'Solo inicio', 'e1000000-0000-4000-8000-0000000000fe');
  select public.payables_ensure('e2000000-0000-4000-8000-0000000000fe');" >/dev/null
if psqlq -d l30c -f "$HERE/../../rollback/0024_rollback.sql" >"$WORK/l30c.out" 2>&1; then check ok ok "0024 rollback runs with only defaults (no vendors or bills)"; else head -3 "$WORK/l30c.out"; check failed ok "0024 rollback runs with only defaults (no vendors or bills)"; fi
psqlq -d l30c -c "delete from public.companies where id = 'e2000000-0000-4000-8000-0000000000fe'; delete from auth.users where id = 'e1000000-0000-4000-8000-0000000000fe'" >/dev/null
fingerprint l30c "$WORK/fp24_after.txt"
if diff -u "$WORK/fp24_before.txt" "$WORK/fp24_after.txt" > "$WORK/fp24.diff"; then check ok ok "after the 0024 rollback the catalog is identical to 0023 (source constraint and line trigger restored)"
else head -20 "$WORK/fp24.diff"; check different ok "after the 0024 rollback the catalog is identical to 0023 (source constraint and line trigger restored)"; fi
check "$(count l30c "select count(*) from public.permissions where key like 'payables.%'")/$(count l30c "select count(*) from storage.buckets where id = 'Finance-attachments'")" 0/0 "the rollback removes the payables permissions and the empty bucket"
if psqlq -d l30a -f "$HERE/../../rollback/0024_rollback.sql" >"$WORK/l30a.out" 2>&1; then check ran refused "0024 rollback with bills"; else
  grep -q "vendors, bills or recurring expenses exist" "$WORK/l30a.out" && check refused refused "0024 rollback refuses while vendors or bills exist (nothing changed)"; fi
check "$(count l30a "select (to_regclass('public.bills') is not null)::text || '/' || (select count(*) > 0 from public.bills)::text")" "true/true" "after the refusal the payables are intact"

echo "== Scenario 31: 0025 receivables — aging, payment voids, collections, promises, reminders, concurrency, rollback"
P25=0025_receivables
stg_db l31a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24"; do psqlq -d l31a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l31a "$WORK/fp25_before.txt"
psqlq -d l31a -f "$MIG/$P25.sql" >/dev/null && psqlq -d l31a -f "$MIG/$P25.sql" >/dev/null && check ok ok "0025 applies and re-applies cleanly"
for m in "$P15" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25"; do psqlq -d l31a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0015 … 0025 re-apply in order (0025 replaces the 0015/0023 payment sums again)"
check "$(ro l31a "$VER")" OK "verify_0014a answers OK with 0025 (receivables permissions)"
run_suite l31a "$HERE/88_receivables.test.sql" 'ALL RECEIVABLES TESTS PASSED' "receivables suite (aging, statuses, payment voids, notes, promises, reminders, report, isolation)"
stg_db l31b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25"; do psqlq -d l31b -f "$MIG/$m.sql" >/dev/null; done
run_suite l31b "$HERE/84_ledger.test.sql" 'ALL LEDGER TESTS PASSED' "with 0025: ledger suite"
run_suite l31b "$HERE/86_payables.test.sql" 'ALL PAYABLES TESTS PASSED' "with 0025: payables suite"
stg_db l31d; for m in "$P14" "$P15" "$P23" "$P24" "$P25"; do psqlq -d l31d -f "$MIG/$m.sql" >/dev/null; done
run_suite l31d "$HERE/74_documents_lifecycle.test.sql" 'ALL LIFECYCLE TESTS PASSED' "0014a + 0015 + 0023 … 0025: documents lifecycle suite (payments are evidence)"
source "$HERE/89_receivables_race.sh"
stg_db l31r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25"; do psqlq -d l31r -f "$MIG/$m.sql" >/dev/null; done
check "$(ar_race_double_void l31r)" "1|PAYMENT_ALREADY_VOIDED,|overdue|0/1|10000=10000|1" "the same payment voided twice at once: one reversal"
check "$(ar_race_void_pay l31r)" "2||paid|1/1|0=0" "voiding a payment while a new one arrives: both serialised, never negative"
check "$(ar_race_overpay l31r)" "1|PAYMENT_EXCEEDS_BALANCE,|sent|1/0|4000=4000" "two payments of 60 on 100 at once: one refused, receivable = open balance"
check "$(ar_race_promise l31r)" "2||paid|2/0|0=0|kept/1" "two payments completing a promise at once: kept once"
check "$(ar_race_refresh l31r)" "2|1" "two reminder refreshes at once: one reminder"
stg_db l31c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25"; do psqlq -d l31c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l31c -f "$HERE/../../rollback/0025_rollback.sql" >"$WORK/l31c.out" 2>&1; then check ok ok "0025 rollback runs without collection records"; else head -3 "$WORK/l31c.out"; check failed ok "0025 rollback runs without collection records"; fi
fingerprint l31c "$WORK/fp25_after.txt"
if diff -u "$WORK/fp25_before.txt" "$WORK/fp25_after.txt" > "$WORK/fp25.diff"; then check ok ok "after the 0025 rollback the catalog is identical to 0024 (0015/0023 functions restored)"
else head -20 "$WORK/fp25.diff"; check different ok "after the 0025 rollback the catalog is identical to 0024 (0015/0023 functions restored)"; fi
if psqlq -d l31a -f "$HERE/../../rollback/0025_rollback.sql" >"$WORK/l31a.out" 2>&1; then check ran refused "0025 rollback with voided payments"; else
  grep -q "voided payments exist" "$WORK/l31a.out" && check refused refused "0025 rollback refuses while voided payments exist (nothing changed)"; fi
check "$(count l31a "select (to_regprocedure('public.payment_void(uuid,text)') is not null)::text")" true "after the refusal 0025 is intact"

echo "== Scenario 32: 0026 bank reconciliation — accounts, import, matching, reconciliation, concurrency, rollback"
P26=0026_bank_reconciliation
stg_db l32a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25"; do psqlq -d l32a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l32a "$WORK/fp26_before.txt"
psqlq -d l32a -f "$MIG/$P26.sql" >/dev/null && psqlq -d l32a -f "$MIG/$P26.sql" >/dev/null && check ok ok "0026 applies and re-applies cleanly"
for m in "$P15" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26"; do psqlq -d l32a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0015 … 0026 re-apply in order"
check "$(ro l32a "$VER")" OK "verify_0014a answers OK with 0026 (bank permissions)"
run_suite l32a "$HERE/90_bank.test.sql" 'ALL BANK TESTS PASSED' "bank suite (accounts, import and duplicates, suggestions, matching, postings, reconciliation, close/reopen, isolation)"
stg_db l32b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26"; do psqlq -d l32b -f "$MIG/$m.sql" >/dev/null; done
run_suite l32b "$HERE/84_ledger.test.sql" 'ALL LEDGER TESTS PASSED' "with 0026: ledger suite"
run_suite l32b "$HERE/86_payables.test.sql" 'ALL PAYABLES TESTS PASSED' "with 0026: payables suite"
run_suite l32b "$HERE/88_receivables.test.sql" 'ALL RECEIVABLES TESTS PASSED' "with 0026: receivables suite"
stg_db l32d; for m in "$P14" "$P15" "$P23" "$P24" "$P25" "$P26"; do psqlq -d l32d -f "$MIG/$m.sql" >/dev/null; done
run_suite l32d "$HERE/74_documents_lifecycle.test.sql" 'ALL LIFECYCLE TESTS PASSED' "0014a + 0015 + 0023 … 0026: documents lifecycle suite"
source "$HERE/91_bank_race.sh"
stg_db l32r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26"; do psqlq -d l32r -f "$MIG/$m.sql" >/dev/null; done
check "$(bk_race_import l32r)" "2||1/2" "the same statement imported twice at once: one import, no duplicated lines"
check "$(bk_race_match l32r)" "1|BANK_LINE_NOT_AVAILABLE|1" "one bank line matched to two book lines at once: one match"
check "$(bk_race_auto l32r)" "2|2/2" "two auto-matches at once: no duplicated groups"
check "$(bk_race_close_unmatch l32r)" "1|BANK_LINE_RECONCILED,|closed/2" "closing while a match is undone: serialised, the closed period stays complete"
check "$(bk_race_create l32r)" "1|RECONCILIATION_OVERLAP,|1" "two reconciliations of the same period at once: one"
stg_db l32c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26"; do psqlq -d l32c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l32c -f "$HERE/../../rollback/0026_rollback.sql" >"$WORK/l32c.out" 2>&1; then check ok ok "0026 rollback runs without bank data"; else head -3 "$WORK/l32c.out"; check failed ok "0026 rollback runs without bank data"; fi
fingerprint l32c "$WORK/fp26_after.txt"
if diff -u "$WORK/fp26_before.txt" "$WORK/fp26_after.txt" > "$WORK/fp26.diff"; then check ok ok "after the 0026 rollback the catalog is identical to 0025 (ledger_post_payment restored)"
else head -20 "$WORK/fp26.diff"; check different ok "after the 0026 rollback the catalog is identical to 0025 (ledger_post_payment restored)"; fi
if psqlq -d l32r -f "$HERE/../../rollback/0026_rollback.sql" >"$WORK/l32r.out" 2>&1; then check ran refused "0026 rollback with bank data"; else
  grep -q "bank accounts or bank records exist" "$WORK/l32r.out" && check refused refused "0026 rollback refuses while bank data exists (nothing changed)"; fi
check "$(count l32r "select (select count(*) from public.bank_accounts)::text || '/' || (select count(*) from public.bank_reconciliations)::text")" "1/1" "after the refusal the bank account and its reconciliation are intact"

echo "== Scenario 33: 0027 financial statements, budgets, budget vs actual, concurrency, rollback"
P27=0027_statements_budgets
stg_db l33a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26"; do psqlq -d l33a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l33a "$WORK/fp27_before.txt"
psqlq -d l33a -f "$MIG/$P27.sql" >/dev/null && psqlq -d l33a -f "$MIG/$P27.sql" >/dev/null && check ok ok "0027 applies and re-applies cleanly"
for m in "$P15" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27"; do psqlq -d l33a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0015 … 0027 re-apply in order"
check "$(ro l33a "$VER")" OK "verify_0014a answers OK with 0027 (budget permissions)"
run_suite l33a "$HERE/92_statements.test.sql" 'ALL STATEMENTS TESTS PASSED' "statements and budgets suite (income statement, balance sheet, cash flow, quality, budgets, versions, vs actual, isolation)"
stg_db l33b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27"; do psqlq -d l33b -f "$MIG/$m.sql" >/dev/null; done
run_suite l33b "$HERE/84_ledger.test.sql" 'ALL LEDGER TESTS PASSED' "with 0027: ledger suite"
run_suite l33b "$HERE/86_payables.test.sql" 'ALL PAYABLES TESTS PASSED' "with 0027: payables suite"
run_suite l33b "$HERE/88_receivables.test.sql" 'ALL RECEIVABLES TESTS PASSED' "with 0027: receivables suite"
run_suite l33b "$HERE/90_bank.test.sql" 'ALL BANK TESTS PASSED' "with 0027: bank suite"
source "$HERE/93_budget_race.sh"
stg_db l33r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27"; do psqlq -d l33r -f "$MIG/$m.sql" >/dev/null; done
check "$(bg_race_version l33r)" "1|BUDGET_DRAFT_EXISTS,|1" "two new versions of a budget at once: one draft"
check "$(bg_race_publish l33r)" "2||1" "two versions published at once: exactly one published"
check "$(bg_race_edit_approve l33r)" "1|BUDGET_LOCKED,|approved/100000" "editing a draft while it is approved: the edit is refused, nothing changes"
check "$(bg_race_lines_approve l33r)" "1|BUDGET_LOCKED,|approved/12/1" "saving a 12-month line while the budget is approved: refused as a whole, no half-saved line"
stg_db l33c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27"; do psqlq -d l33c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l33c -f "$HERE/../../rollback/0027_rollback.sql" >"$WORK/l33c.out" 2>&1; then check ok ok "0027 rollback runs without budgets"; else head -3 "$WORK/l33c.out"; check failed ok "0027 rollback runs without budgets"; fi
fingerprint l33c "$WORK/fp27_after.txt"
if diff -u "$WORK/fp27_before.txt" "$WORK/fp27_after.txt" > "$WORK/fp27.diff"; then check ok ok "after the 0027 rollback the catalog is identical to 0026"
else head -20 "$WORK/fp27.diff"; check different ok "after the 0027 rollback the catalog is identical to 0026"; fi
if psqlq -d l33r -f "$HERE/../../rollback/0027_rollback.sql" >"$WORK/l33r.out" 2>&1; then check ran refused "0027 rollback with budgets"; else
  grep -q "budgets, budget history or assumptions exist" "$WORK/l33r.out" && check refused refused "0027 rollback refuses while budgets exist (nothing changed)"; fi
check "$(count l33r "select (select count(*) > 0 from public.budgets)::text || '/' || (to_regprocedure('public.fs_balance_sheet(uuid,date)') is not null)::text")" "true/true" "after the refusal 0027 and its budgets are intact"

echo "== Scenario 34: 0028 Document Studio — documents, versions, issuing, templates, brand, images, concurrency, rollback"
P28=0028_document_studio
stg_db l34a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27"; do psqlq -d l34a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l34a "$WORK/fp28_before.txt"
psqlq -d l34a -f "$MIG/$P28.sql" >/dev/null && psqlq -d l34a -f "$MIG/$P28.sql" >/dev/null && check ok ok "0028 applies and re-applies cleanly"
for m in "$P15" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28"; do psqlq -d l34a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0015 … 0028 re-apply in order"
check "$(ro l34a "$VER")" OK "verify_0014a answers OK with 0028 (studio permissions)"
check "$(count l34a "select (select public from storage.buckets where id = 'Studio-assets')::text || '/' || (select count(*) from pg_policies where tablename = 'objects' and policyname like 'ba_studio_assets_%')")" "false/2" "Studio-assets is a private bucket with 2 company-scoped policies"
run_suite l34a "$HERE/94_studio.test.sql" 'ALL STUDIO TESTS PASSED' "Document Studio suite (content validation, references, versions, conflicts, live data, issuing, numbering, immutability, templates, brand, images, isolation, cascade)"
stg_db l34b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28"; do psqlq -d l34b -f "$MIG/$m.sql" >/dev/null; done
run_suite l34b "$HERE/84_ledger.test.sql" 'ALL LEDGER TESTS PASSED' "with 0028: ledger suite"
run_suite l34b "$HERE/88_receivables.test.sql" 'ALL RECEIVABLES TESTS PASSED' "with 0028: receivables suite"
run_suite l34b "$HERE/92_statements.test.sql" 'ALL STATEMENTS TESTS PASSED' "with 0028: statements and budgets suite"
source "$HERE/95_studio_race.sh"
stg_db l34r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28"; do psqlq -d l34r -f "$MIG/$m.sql" >/dev/null; done
check "$(sr_race_numbers l34r)" "2||2/0001,0002" "two documents issued at once: two consecutive numbers, no duplicate"
check "$(sr_race_save l34r)" "1|STUDIO_CONFLICT,|2/A/2" "two people save the same draft version: one saves, the other gets a conflict"
check "$(sr_race_save_issue l34r)" "1|STUDIO_LOCKED,|final/Hola" "saving while the draft is issued: the save is refused, the issued copy is the approved version"
stg_db l34c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28"; do psqlq -d l34c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l34c -f "$HERE/../../rollback/0028_rollback.sql" >"$WORK/l34c.out" 2>&1; then check ok ok "0028 rollback runs without studio data"; else head -3 "$WORK/l34c.out"; check failed ok "0028 rollback runs without studio data"; fi
fingerprint l34c "$WORK/fp28_after.txt"
if diff -u "$WORK/fp28_before.txt" "$WORK/fp28_after.txt" > "$WORK/fp28.diff"; then check ok ok "after the 0028 rollback the catalog is identical to 0027"
else head -20 "$WORK/fp28.diff"; check different ok "after the 0028 rollback the catalog is identical to 0027"; fi
check "$(count l34c "select (select count(*) from storage.buckets where id = 'Studio-assets')::text || '/' || (select count(*) from public.permissions where key like 'studio.%')")" "0/0" "the 0028 rollback removes the bucket and the studio permissions"
if psqlq -d l34r -f "$HERE/../../rollback/0028_rollback.sql" >"$WORK/l34r.out" 2>&1; then check ran refused "0028 rollback with studio documents"; else
  grep -q "studio documents, templates, brand settings, images or history exist" "$WORK/l34r.out" && check refused refused "0028 rollback refuses while studio documents exist (nothing changed)"; fi
check "$(count l34r "select (select count(*) > 0 from public.studio_documents)::text || '/' || (to_regprocedure('public.studio_finalize(uuid,integer,jsonb)') is not null)::text")" "true/true" "after the refusal 0028 and its documents are intact"

echo "== Scenario 35: 0029 BusinessAI Assistant — private conversations, confirmed actions, limits, audit, concurrency, rollback"
P29=0029_assistant
stg_db l35a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28"; do psqlq -d l35a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l35a "$WORK/fp29_before.txt"
psqlq -d l35a -f "$MIG/$P29.sql" >/dev/null && psqlq -d l35a -f "$MIG/$P29.sql" >/dev/null && check ok ok "0029 applies and re-applies cleanly"
for m in "$P15" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29"; do psqlq -d l35a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0015 … 0029 re-apply in order"
check "$(ro l35a "$VER")" OK "verify_0014a answers OK with 0029 (assistant permissions)"
run_suite l35a "$HERE/96_assistant.test.sql" 'ALL ASSISTANT TESTS PASSED' "Assistant suite (plan and permissions, private conversations, append-only messages, confirmed actions, audit without text, limits, isolation, cascade)"
stg_db l35b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29"; do psqlq -d l35b -f "$MIG/$m.sql" >/dev/null; done
run_suite l35b "$HERE/94_studio.test.sql" 'ALL STUDIO TESTS PASSED' "with 0029: Document Studio suite"
run_suite l35b "$HERE/92_statements.test.sql" 'ALL STATEMENTS TESTS PASSED' "with 0029: statements and budgets suite"
source "$HERE/97_assistant_race.sh"
stg_db l35r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29"; do psqlq -d l35r -f "$MIG/$m.sql" >/dev/null; done
check "$(ar_race_confirm l35r)" "1|ASSISTANT_ALREADY_DECIDED,|confirmed/1" "the same action confirmed twice at once: one confirmation, the other refused"
check "$(ar_race_quota l35r)" "1/1/30" "two requests at once with one left in the quota: exactly one is counted"
stg_db l35c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29"; do psqlq -d l35c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l35c -f "$HERE/../../rollback/0029_rollback.sql" >"$WORK/l35c.out" 2>&1; then check ok ok "0029 rollback runs without assistant data"; else head -3 "$WORK/l35c.out"; check failed ok "0029 rollback runs without assistant data"; fi
fingerprint l35c "$WORK/fp29_after.txt"
if diff -u "$WORK/fp29_before.txt" "$WORK/fp29_after.txt" > "$WORK/fp29.diff"; then check ok ok "after the 0029 rollback the catalog is identical to 0028"
else head -20 "$WORK/fp29.diff"; check different ok "after the 0029 rollback the catalog is identical to 0028"; fi
check "$(count l35c "select count(*) from public.permissions where key like 'assistant.%'")" "0" "the 0029 rollback removes the assistant permissions"
if psqlq -d l35r -f "$HERE/../../rollback/0029_rollback.sql" >"$WORK/l35r.out" 2>&1; then check ran refused "0029 rollback with assistant data"; else
  grep -q "assistant conversations, actions, usage or audit events exist" "$WORK/l35r.out" && check refused refused "0029 rollback refuses while conversations exist (nothing changed)"; fi
check "$(count l35r "select (select count(*) > 0 from public.assistant_conversations)::text || '/' || (to_regprocedure('public.assistant_decide_action(uuid,text)') is not null)::text")" "true/true" "after the refusal 0029 and its conversations are intact"

echo "== Scenario 36: 0030 Intelligence Engine core — server signatures, turns, budgets, idempotent actions, aggregates, concurrency, rollback"
P30=0030_intelligence_core
stg_db l36a; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29"; do psqlq -d l36a -f "$MIG/$m.sql" >/dev/null; done; fingerprint l36a "$WORK/fp30_before.txt"
psqlq -d l36a -f "$MIG/$P30.sql" >/dev/null && psqlq -d l36a -f "$MIG/$P30.sql" >/dev/null && check ok ok "0030 applies and re-applies cleanly"
for m in "$P15" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29" "$P30"; do psqlq -d l36a -f "$MIG/$m.sql" >/dev/null; done && check ok ok "lost-record cascade: 0015 … 0030 re-apply in order"
check "$(ro l36a "$VER")" OK "verify_0014a answers OK with 0030 (no new permissions)"
check "$(count l36a "select has_function_privilege('authenticated', 'public.assistant_log(uuid, uuid, text, jsonb, uuid)', 'EXECUTE')::text || '/' || has_function_privilege('authenticated', 'public.assistant_consume(uuid)', 'EXECUTE')::text || '/' || public.assistant_server_ready()::text")" "false/false/false" "0030 closes the forging functions and starts closed (no server key)"
run_suite l36a "$HERE/98_intelligence.test.sql" 'ALL INTELLIGENCE TESTS PASSED' "Intelligence suite (no forging, closed by default, HMAC, replay, stale, key rotation, turns, usage on failure, budget alerts, burst limits, idempotent decisions, leases, retries, aggregates in exact cents, access map, isolation, cascade)"
stg_db l36b; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29" "$P30"; do psqlq -d l36b -f "$MIG/$m.sql" >/dev/null; done
run_suite l36b "$HERE/94_studio.test.sql" 'ALL STUDIO TESTS PASSED' "with 0030: Document Studio suite"
run_suite l36b "$HERE/92_statements.test.sql" 'ALL STATEMENTS TESTS PASSED' "with 0030: statements and budgets suite"
run_suite l36b "$HERE/88_receivables.test.sql" 'ALL RECEIVABLES TESTS PASSED' "with 0030: receivables suite"
source "$HERE/99_intelligence_race.sh"
stg_db l36r; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29" "$P30"; do psqlq -d l36r -f "$MIG/$m.sql" >/dev/null; done
check "$(ir_race_finish l36r)" "1|ASSISTANT_ALREADY_DECIDED,|1/1000" "the same turn finished twice at once: one answer, usage counted once"
check "$(ir_race_claim l36r)" "1|ASSISTANT_ACTION_BUSY,|executing/1" "a confirmed action taken by two workers at once: one execution"
check "$(ir_race_quota l36r)" "1/1/100" "two turns at once with one request left: exactly one starts"
stg_db l36c; for m in "$P14" "$P15" "$P16" "$P17" "$P18" "$P19" "$P20" "$P21" "$P22" "$P23" "$P24" "$P25" "$P26" "$P27" "$P28" "$P29" "$P30"; do psqlq -d l36c -f "$MIG/$m.sql" >/dev/null; done
if psqlq -d l36c -f "$HERE/../../rollback/0030_rollback.sql" >"$WORK/l36c.out" 2>&1; then check ok ok "0030 rollback runs without new data"; else head -3 "$WORK/l36c.out"; check failed ok "0030 rollback runs without new data"; fi
fingerprint l36c "$WORK/fp30_after.txt"
if diff -u "$WORK/fp30_before.txt" "$WORK/fp30_after.txt" > "$WORK/fp30.diff"; then check ok ok "after the 0030 rollback the catalog is identical to 0029"
else head -30 "$WORK/fp30.diff"; check different ok "after the 0030 rollback the catalog is identical to 0029"; fi
if psqlq -d l36r -f "$HERE/../../rollback/0030_rollback.sql" >"$WORK/l36r.out" 2>&1; then check ran refused "0030 rollback with turns"; else
  grep -q "assistant turns, server keys, costs or new-style actions exist" "$WORK/l36r.out" && check refused refused "0030 rollback refuses while turns exist (nothing changed)"; fi
check "$(count l36r "select (select count(*) > 0 from public.assistant_turns)::text || '/' || (to_regprocedure('public.assistant_finish_turn(uuid,text,text,text)') is not null)::text")" "true/true" "after the refusal 0030 and its turns are intact"

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
