#!/usr/bin/env bash
# =====================================================================
# LOCAL rehearsal of the next Staging step: apply the drafts 0037 → 0045,
# ONE PER RUN, to a Staging that has 0001–0036 (state since run #38), then
# rehearse both recovery paths. Never connects to Supabase: it refuses any
# non-local PSQL and works on throw-away databases of a LOCAL PostgreSQL.
#
# It runs the REAL scripts/staging/apply-migrations.sh with the REAL pinned
# staging / production refs (local role names), exactly as staging.yml does:
#   0. Staging today: 0001–0036 through the script, staging marker, fictitious
#      data like the staging tests leave; 0037–0045 held without approval.
#   1. Backup before the first step: pg_dump -Fc (the owner's §1b dump).
#   2. For each draft, in order: DRY_RUN with APPROVED_DRAFTS=<that one> lists
#      exactly it and holds the rest (nothing written); apply → only it is
#      applied, "up to date and verified"; confirm DRY_RUN EXPECT_NONE STATUS
#      VERIFY_0014A → verify_0014a OK, permission matrix at its expected size,
#      record count +1; existing data unchanged.
#      Also: approving a LATER draft alone applies nothing (order kept).
#   3. After 0045: Banking-evidence private with its 3 policies, data intact,
#      another company sees nothing (RLS).
#   4. Recovery A (rollback scripts, no module data written): 0045 → 0037 in
#      reverse order, deleting each record from ba_meta.applied_migrations →
#      catalog fingerprint identical to step 0 and 0037–0045 held again.
#   5. Recovery B (restore the step-1 dump into a new database): fingerprint
#      and data identical to step 0.
#
#   PSQL_ADMIN="runuser -u postgres -- psql -h /sock -p 5432 -U postgres" \
#   PG_HOST=/sock PG_PORT=5432 bash scripts/staging/rehearse-0037-0045.sh
#   (optional PG_BIN=/usr/lib/postgresql/16/bin for pg_dump / pg_restore; the
#    same RUNAS prefix as PSQL_ADMIN is used when it starts with runuser)
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); root="$here/../.."; sb="$root/supabase"
: "${PSQL_ADMIN:?local psql command (superuser)}"; : "${PG_HOST:?local socket dir}"; PG_PORT=${PG_PORT:-5432}
case "$PSQL_ADMIN $PG_HOST" in *supabase.co*|*pooler.supabase*|*amazonaws*) echo "refusing: not a local server" >&2; exit 2;; esac
[[ "$PG_HOST" == /* ]] || { echo "refusing: PG_HOST must be a local socket directory" >&2; exit 2; }
PG_BIN=${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
RUNAS=(); [[ "$PSQL_ADMIN" == runuser* ]] && RUNAS=(runuser -u postgres --)
STG=wbfpvxptoujgvflljasc; PROD=rugqcumiuqrjbfwpuslm   # the pinned refs of .github/workflows/staging.yml
DB=ba_rehearsal_s10
BEFORE=0015_documents_lifecycle,0016_billing_hardening,0017_plan_features,0018_team,0019_crm,0020_workforce,0021_workforce_kiosk,0022_workforce_rules,0023_ledger,0024_payables,0025_receivables,0026_bank_reconciliation,0027_statements_budgets,0028_document_studio,0029_assistant,0030_intelligence_core,0031_intelligence_insights,0032_assistant_bank_summary,0033_workforce_hr,0034_payroll,0035_crm,0036_workforce_access_check
STEPS=(0037_studio_branches 0038_studio_finance 0039_catalog 0040_assistant_finance 0041_studio_advanced 0042_banking 0043_inventory 0044_pos 0045_platform_stabilization)
# role_permissions rows expected after each step (130 at 0036; docs/STAGING_STATUS.md §8)
MATRIX=(130 130 135 135 135 135 143 153 153)
q() { $PSQL_ADMIN -X -q -v ON_ERROR_STOP=1 "$@"; }
pass=0; fail=0
ok() { if [[ "$1" == "$2" ]]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got '$1', want '$2')"; fi; }
url() { echo "postgresql://postgres.$STG@/$1?host=$PG_HOST&port=$PG_PORT"; }
mig() { local u="$1"; shift; (cd "$root" && env STAGING_DB_URL="$u" STAGING_PROJECT_REF="$STG" PRODUCTION_PROJECT_REF="$PROD" EXPECT_STAGING_REF="$STG" "$@" bash scripts/staging/apply-migrations.sh 2>&1); }
fp() { q -d "$1" -tA -f "$sb/tests/local/catalog_fingerprint.sql" | grep -v 'ba_meta'; }
# A table whose ACL lists only its owner with every right is the same as the default (NULL) ACL;
# pg_dump does not emit such grants, so a restored table shows NULL. Only that exact form is
# normalised: any grant to another role still differs.
fpn() { sed -E "s/\|acl=\{\"\\\\\"postgres\.$STG\\\\\"=arwdDxt\/\\\\\"postgres\.$STG\\\\\"\"\}$/|acl=/" "$1"; }
WORK=$(mktemp -d); chmod 755 "$WORK"; trap 'rm -rf "$WORK"' EXIT

q -d postgres -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'postgres.$STG') then create role \"postgres.$STG\" login superuser; end if; end \$\$" >/dev/null
for d in "$DB" "${DB}_rb" "${DB}_restored"; do q -d postgres -c "drop database if exists $d" >/dev/null; done
q -d postgres -c "create database $DB" >/dev/null
q -d "$DB" -f "$sb/tests/local/00_supabase_shim.sql" >/dev/null

echo "== 0. Staging today: 0001–0036 (run #38) through the same script"
o="$(mig "$(url $DB)" APPROVED_DRAFTS=$BEFORE)"; ok "$(grep -c 'Staging database is up to date and verified' <<<"$o")" 1 "staging shape rebuilt with apply-migrations.sh"
ok "$(q -d $DB -tA -c "select count(*) from ba_meta.applied_migrations")" 34 "34 migrations recorded (0001–0036)"
q -d "$DB" >/dev/null <<'SQL'
insert into auth.users (id, email) values ('d1000000-0000-4000-8000-000000000001', 'qa-owner@example.test'), ('d1000000-0000-4000-8000-000000000002', 'qa-other@example.test');
insert into public.companies (id, name, created_by) values ('d2000000-0000-4000-8000-000000000001', 'BusinessAI Demo (QA)', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000002', 'Otra QA', 'd1000000-0000-4000-8000-000000000002');
insert into public.memberships (company_id, user_id, role) values ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'owner'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'owner');
insert into public.clients (id, company_id, name, email) values ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Demo · Cliente', 'cliente@example.test');
insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date, metadata) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'quote', 'DEMO-Q-0001', 'draft', 50, 0, 50, current_date, null, '{"demo": true}');
SQL
counts() { q -d "$DB" -tA -c "select (select count(*) from public.companies)||'/'||(select count(*) from public.clients)||'/'||(select count(*) from public.documents)||'/'||(select count(*) from public.memberships)"; }
base_counts=$(counts)
ok "$(q -d $DB -tA -c "select count(*) from public.role_permissions")" 130 "permission matrix: 130 rows at 0036"
o="$(mig "$(url $DB)" DRY_RUN=1)"
ok "$(grep -c '^Held (draft not approved.*): 0037_studio_branches 0038_studio_finance 0039_catalog 0040_assistant_finance 0041_studio_advanced 0042_banking 0043_inventory 0044_pos 0045_platform_stabilization$' <<<"$o")/$(grep -c '^No pending migrations' <<<"$o")" "1/1" \
  "staging:check shape: nothing pending, 0037–0045 held (no 0001–0036 file changed)"
fp $DB > "$WORK/fp0"

echo "== 1. Backup before the first step (owner's logical dump, §1b)"
"${RUNAS[@]}" "$PG_BIN/pg_dump" -h "$PG_HOST" -p "$PG_PORT" -U postgres -Fc "$DB" > "$WORK/before-0037.dump"; ok "$?" 0 "pg_dump -Fc of the 0036 state"

echo "== 2. One draft per run, in order"
o="$(mig "$(url $DB)" APPROVED_DRAFTS=0039_catalog)"
ok "$(grep -c '^→ applying' <<<"$o")" 0 "approving a later draft alone (0039) applies nothing: 0037 is held first"
for i in "${!STEPS[@]}"; do
  m=${STEPS[$i]}; rest=("${STEPS[@]:$((i+1))}")
  fp $DB > "$WORK/fp_pre"
  o="$(mig "$(url $DB)" DRY_RUN=1 APPROVED_DRAFTS=$m)"
  held_ok=1; [[ ${#rest[@]} -gt 0 ]] && held_ok=$(grep -c "^Held (draft not approved.*): ${rest[*]}$" <<<"$o")
  ok "$(grep -c "^Pending: $m$" <<<"$o")/$held_ok" "1/1" "$m dry run: pending exactly $m, later drafts held"
  fp $DB > "$WORK/fp_dry"; ok "$(diff -q "$WORK/fp_pre" "$WORK/fp_dry" >/dev/null && echo same || echo changed)" same "$m dry run wrote nothing"
  o="$(mig "$(url $DB)" APPROVED_DRAFTS=$m)"
  ok "$(grep -oE 'applying [0-9a-z_]+' <<<"$o" | tr '\n' ' ')$(grep -c 'Staging database is up to date and verified' <<<"$o")" "applying $m 1" "$m applied alone: up to date and verified"
  o="$(mig "$(url $DB)" DRY_RUN=1 EXPECT_NONE=1 STATUS=1 VERIFY_0014A=1)"
  ok "$(grep -c '^verify_0014a: OK$' <<<"$o")/$(grep -c '✓' <<<"$o")" "1/$((35+i))" "$m confirm: verify_0014a OK (read-only), $((35+i)) recorded"
  ok "$(q -d $DB -tA -c "select count(*) from public.role_permissions")" "${MATRIX[$i]}" "$m permission matrix: ${MATRIX[$i]} rows"
  ok "$(counts)" "$base_counts" "$m existing companies / clients / documents / memberships unchanged"
  o="$(cd "$root" && STAGING_DB_URL="$(url $DB)" EXPECT_STAGING_REF="$STG" PRODUCTION_PROJECT_REF="$PROD" bash scripts/staging/verify-step.sh "$m" 2>&1)"
  ok "$?/$(grep -c '^OK: ' <<<"$o")/$(grep -c '^FAIL' <<<"$o")" "0/1/0" "$m verify-step.sh (the workflow's read-only checks) passes"
  [[ "$(grep -c '^FAIL' <<<"$o")" == 0 ]] || grep '^FAIL' <<<"$o" | sed 's/^/    /'
done
o="$(cd "$root" && STAGING_DB_URL="$(url $DB)" EXPECT_STAGING_REF="$STG" PRODUCTION_PROJECT_REF="$PROD" bash scripts/staging/verify-step.sh 0099_unknown 2>&1)"
ok "$?" 1 "verify-step.sh refuses an unknown step"
o="$(cd "$root" && STAGING_DB_URL="$(url $DB)&x=$PROD" EXPECT_STAGING_REF="$STG" PRODUCTION_PROJECT_REF="$PROD" bash scripts/staging/verify-step.sh 0037_studio_branches 2>&1)"
ok "$(grep -c 'PRODUCTION' <<<"$o")" 1 "verify-step.sh refuses a URL that mentions the production project"

echo "== 3. End state"
ok "$(q -d $DB -tA -c "select public::text from storage.buckets where id = 'Banking-evidence'")/$(q -d $DB -tA -c "select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and (coalesce(qual,'') || coalesce(with_check,'')) ilike '%Banking-evidence%'")" "false/3" \
  "Banking-evidence bucket private with its 3 policies"
other=$(q -d $DB -tA -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"d1000000-0000-4000-8000-000000000002\",\"role\":\"authenticated\"}', true); set local role authenticated; select count(*) from public.documents; rollback;" | sed -n 2p)
ok "$other" 0 "another company's owner sees none of the demo documents (RLS)"
own=$(q -d $DB -tA -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"d1000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}', true); set local role authenticated; select count(*) from public.clients; rollback;" | sed -n 2p)
ok "$own" 1 "the demo owner reads its client"

echo "== 4. Recovery A: rollbacks 0045 → 0037 (each record removed from ba_meta.applied_migrations)"
q -d postgres -c "create database ${DB}_rb template $DB" >/dev/null
rb_ok=1
for (( i=${#STEPS[@]}-1; i>=0; i-- )); do
  m=${STEPS[$i]}; f="$sb/rollback/${m%%_*}_rollback.sql"
  if out=$(q -d "${DB}_rb" -f "$f" 2>&1) && q -d "${DB}_rb" -c "delete from ba_meta.applied_migrations where name = '$m'" >/dev/null; then echo "    $m: rolled back"
  else echo "    $m: FAILED — $(head -c 300 <<<"$out")"; rb_ok=0; break; fi
done
ok "$rb_ok" 1 "every rollback ran in reverse order (no module data was written)"
fp "${DB}_rb" > "$WORK/fp_rb"
ok "$(diff -q "$WORK/fp0" "$WORK/fp_rb" >/dev/null && echo same || echo changed)" same "catalog fingerprint identical to the 0036 state"
diff "$WORK/fp0" "$WORK/fp_rb" | head -20 | sed 's/^/    diff: /' 
o="$(mig "$(url ${DB}_rb)" DRY_RUN=1 STATUS=1 VERIFY_0014A=1)"
ok "$(grep -c '^Held (draft not approved.*): 0037_studio_branches .* 0045_platform_stabilization$' <<<"$o")/$(grep -c '^verify_0014a: OK$' <<<"$o")/$(grep -c '✓' <<<"$o")" "1/1/34" \
  "after recovery A: 0037–0045 held again, verify_0014a OK, 34 recorded"
ok "$(q -d ${DB}_rb -tA -c "select count(*) from public.role_permissions")" 130 "after recovery A: permission matrix back to 130"

echo "== 5. Recovery B: restore the step-1 dump into a new database"
q -d postgres -c "create database ${DB}_restored" >/dev/null
"${RUNAS[@]}" "$PG_BIN/pg_restore" -h "$PG_HOST" -p "$PG_PORT" -U postgres -d "${DB}_restored" < "$WORK/before-0037.dump" >/dev/null 2>"$WORK/restore.err"
ok "$(grep -vc 'already exists\|^pg_restore: warning\|errors ignored on restore\|^$\|^Command was\|^pg_restore: error: could not execute query\|^pg_restore: from TOC entry' "$WORK/restore.err")" 0 "pg_restore completed (only pre-existing shim objects reported)"
grep -v 'already exists' "$WORK/restore.err" | head -8 | sed 's/^/    restore: /' 
fp "${DB}_restored" > "$WORK/fp_restored"
ok "$(diff -q <(fpn "$WORK/fp0") <(fpn "$WORK/fp_restored") >/dev/null && echo same || echo changed)" same "restored catalog identical to the 0036 state (owner-only ACL = default ACL)"
diff <(fpn "$WORK/fp0") <(fpn "$WORK/fp_restored") | head -12 | sed 's/^/    diff: /' 
ok "$(DB=${DB}_restored; q -d "$DB" -tA -c "select (select count(*) from public.companies)||'/'||(select count(*) from public.clients)||'/'||(select count(*) from public.documents)||'/'||(select count(*) from public.memberships)")" "$base_counts" "restored data identical"
ok "$(q -d ${DB}_restored -tA -c "select count(*) from ba_meta.applied_migrations")" 34 "restored record: 34 migrations (0037–0045 not recorded)"

for d in "$DB" "${DB}_rb" "${DB}_restored"; do q -d postgres -c "drop database if exists $d" >/dev/null; done
echo; echo "Result: $pass passed, $fail failed"; [[ $fail == 0 ]]
