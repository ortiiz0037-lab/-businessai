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
o="$(mig "$MURL" DRY_RUN=1)"; check "$(grep -c 'Pending: 0001_multitenant_core.* 0011_usage_limits 0014a_permissions$' <<<"$o")" 1 "migrate plan: lists 0001…0011 then 0014a_permissions (last), writes nothing"
check "$(psqlq -d mig -tA -c "select count(*) from pg_tables where schemaname='public'")" 0 "migrate plan: no table created"
o="$(mig "$MURL" DRY_RUN=1 VERIFY_0014A=1)"; check "$(grep -c 'verify_0014a: 0014a_permissions not recorded yet' <<<"$o")" 1 "verify_0014a: skipped while 0014a is not recorded"
o="$(mig "$MURL")"; check "$(grep -c 'Staging database is up to date and verified' <<<"$o")" 1 "migrate apply: 12 migrations applied and verified"
check "$(grep -oE 'applying [0-9a-z_]+' <<<"$o" | tail -2 | tr '\n' ' ')" "applying 0011_usage_limits applying 0014a_permissions " "migrate apply: 0014a_permissions runs after 0011"
o="$(mig "$MURL" DRY_RUN=1 EXPECT_NONE=1 STATUS=1)"; check "$(grep -c '✓' <<<"$o")/$(grep -c 'No pending migrations' <<<"$o")" "12/1" "migrate confirm: nothing pending, 12 recorded"
check "$(psqlq -d mig -tA -c "select count(*) from ba_meta.applied_migrations where name = '0014a_permissions'")" 1 "migrate: the record stores the identifier 0014a_permissions"
# The migration committed but its record was lost (e.g. the connection dropped
# between the two steps): the next run re-applies it — idempotent — and records it.
psqlq -d mig -c "delete from ba_meta.applied_migrations where name = '0014a_permissions'" >/dev/null
o="$(mig "$MURL" DRY_RUN=1)"; check "$(grep -c 'Pending: 0014a_permissions$' <<<"$o")" 1 "lost record: 0014a_permissions shows as pending"
o="$(mig "$MURL")"; check "$(grep -c 'Staging database is up to date and verified' <<<"$o")" 1 "lost record: re-run re-applies 0014a idempotently and verifies"
check "$(psqlq -d mig -tA -c "select count(*) from ba_meta.applied_migrations")/$(psqlq -d mig -tA -c "select count(*) from public.role_permissions")" "12/49" "lost record: 12 recorded again, matrix still 49 rows"
# T5: read-only SQL verification of 0014a (staging:check and the migrate confirmation).
fp_mig() { "${RUNAS[@]}" psql -X -q -tA -h "$WORK" -p "$PORT" -U postgres -d mig -f "$HERE/catalog_fingerprint.sql" -c "select count(*) from public.role_permissions" -c "select count(*) from ba_meta.applied_migrations"; }
fp_mig > "$WORK/v_before.txt"
o="$(mig "$MURL" DRY_RUN=1 EXPECT_NONE=1 STATUS=1 VERIFY_0014A=1)"; check "$(grep -c '^verify_0014a: OK$' <<<"$o")" 1 "verify_0014a: OK on the migrated database"
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
