#!/usr/bin/env bash
# =====================================================================
# LOCAL rehearsal of "apply the module drafts 0015–0035 to staging".
# Never connects to Supabase: it refuses any non-local PSQL and builds a
# throw-away database on a LOCAL PostgreSQL server.
#
# It runs the REAL scripts/staging/apply-migrations.sh, with the REAL staging
# ref (as a local role name) and the REAL production ref, exactly as the
# staging workflow does, on a database shaped like businessai-staging today
# (0001–0011 + 0014a + staging marker + fictitious data like the staging
# tests leave), then:
#   1. guards: production ref in the URL, another pinned ref, a database
#      with companies and no staging marker → all refused, nothing changed;
#   2. DRY_RUN with APPROVED_DRAFTS = 0015…0035: exact pending list, catalog
#      fingerprint unchanged (nothing written);
#   3. apply → "up to date and verified"; confirm EXPECT_NONE + STATUS +
#      VERIFY_0014A (read-only) → OK;
#   4. the existing fictitious data is intact and readable through RLS;
#   5. rollbacks 0035 → 0015 in reverse order on a copy: each one runs or
#      refuses with its own explanation (never a half state).
#
#   PSQL_ADMIN="runuser -u postgres -- psql -h /sock -p 5432 -U postgres" \
#   PG_HOST=/sock PG_PORT=5432 bash scripts/staging/rehearse-modules.sh
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); root="$here/../.."; sb="$root/supabase"
: "${PSQL_ADMIN:?local psql command (superuser)}"; : "${PG_HOST:?local socket dir}"; PG_PORT=${PG_PORT:-5432}
case "$PSQL_ADMIN $PG_HOST" in *supabase.co*|*pooler.supabase*|*amazonaws*) echo "refusing: not a local server" >&2; exit 2;; esac
[[ "$PG_HOST" == /* ]] || { echo "refusing: PG_HOST must be a local socket directory" >&2; exit 2; }
STG=wbfpvxptoujgvflljasc; PROD=rugqcumiuqrjbfwpuslm   # the pinned refs of .github/workflows/staging.yml
DB=ba_rehearsal_stg
MODULES=0015_documents_lifecycle,0016_billing_hardening,0017_plan_features,0018_team,0019_crm,0020_workforce,0021_workforce_kiosk,0022_workforce_rules,0023_ledger,0024_payables,0025_receivables,0026_bank_reconciliation,0027_statements_budgets,0028_document_studio,0029_assistant,0030_intelligence_core,0031_intelligence_insights,0032_assistant_bank_summary,0033_workforce_hr,0034_payroll,0035_crm
q() { $PSQL_ADMIN -X -q -v ON_ERROR_STOP=1 "$@"; }
pass=0; fail=0
ok() { if [[ "$1" == "$2" ]]; then pass=$((pass+1)); echo "PASS: $3"; else fail=$((fail+1)); echo "FAIL: $3 (got '$1', want '$2')"; fi; }
url() { echo "postgresql://postgres.$STG@/$1?host=$PG_HOST&port=$PG_PORT${2:-}"; }
mig() { local u="$1"; shift; (cd "$root" && env STAGING_DB_URL="$u" STAGING_PROJECT_REF="$STG" PRODUCTION_PROJECT_REF="$PROD" EXPECT_STAGING_REF="${PIN:-$STG}" "$@" bash scripts/staging/apply-migrations.sh 2>&1); }
fp() { q -d "$1" -tA -f "$sb/tests/local/catalog_fingerprint.sql"; }

q -d postgres -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'postgres.$STG') then create role \"postgres.$STG\" login superuser; end if; end \$\$" \
  -c "drop database if exists $DB" -c "drop database if exists ${DB}_rb" -c "drop database if exists ${DB}_prodlike" -c "create database $DB" -c "create database ${DB}_prodlike" >/dev/null
q -d "$DB" -f "$sb/tests/local/00_supabase_shim.sql" >/dev/null
q -d "${DB}_prodlike" -f "$sb/tests/local/00_supabase_shim.sql" >/dev/null

echo "== 0. Today's staging: 0001–0011 + 0014a through the same script (label run, no drafts)"
o="$(mig "$(url $DB)")"; ok "$(grep -c 'Staging database is up to date and verified' <<<"$o")" 1 "staging shape rebuilt with apply-migrations.sh"
ok "$(grep -c '^Held' <<<"$o")" 1 "without approval the drafts 0015–0035 are held"
ok "$(q -d $DB -tA -c "select count(*) from ba_meta.applied_migrations")" 12 "12 migrations recorded, like staging (run #30)"
# fictitious data like the staging tests leave behind (users, companies, plans, clients, invoices, a payment)
q -d "$DB" >/dev/null <<'SQL'
insert into auth.users (id, email) values ('d1000000-0000-4000-8000-000000000001', 'qa-owner@example.test'), ('d1000000-0000-4000-8000-000000000002', 'qa-other@example.test');
insert into public.companies (id, name, created_by) values ('d2000000-0000-4000-8000-000000000001', 'BusinessAI Demo (QA)', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000002', 'Otra QA', 'd1000000-0000-4000-8000-000000000002');
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  ('d2000000-0000-4000-8000-000000000001', 'cus_demo_qa_1', 'sub_demo_qa_1', 'pro', 'trialing'), ('d2000000-0000-4000-8000-000000000002', 'cus_demo_qa_2', 'sub_demo_qa_2', 'basic', 'active');
insert into public.memberships (company_id, user_id, role) values ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'owner'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'owner');
insert into public.clients (id, company_id, name, email) values ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'Demo · Cliente', 'cliente@example.test');
insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date, metadata) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'invoice', 'DEMO-0001', 'sent', 100, 11.5, 111.5, current_date - 40, current_date - 10, '{"demo": true}'),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'quote', 'DEMO-Q-0001', 'draft', 50, 0, 50, current_date, null, '{"demo": true}');
insert into public.payments (company_id, document_id, amount, created_by, reference) values ('d2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 40, 'd1000000-0000-4000-8000-000000000001', 'DEMO-PAY-1');
SQL
counts() { q -d "$DB" -tA -c "select (select count(*) from public.companies)||'/'||(select count(*) from public.clients)||'/'||(select count(*) from public.documents)||'/'||(select count(*) from public.payments)||'/'||(select count(*) from public.memberships)"; }
before_counts=$(counts)

echo "== 1. Guards (nothing changed on refusal)"
fp $DB > /tmp/rehearsal_fp0.$$
o="$(mig "$(url $DB "&x=$PROD")" DRY_RUN=1 APPROVED_DRAFTS=$MODULES || true)"; ok "$(grep -c 'PRODUCTION' <<<"$o")" 1 "production ref in the URL → refused"
o="$(PIN=otherref000000000000 mig "$(url $DB)" DRY_RUN=1 APPROVED_DRAFTS=$MODULES || true)"; ok "$(grep -c 'not the pinned staging project' <<<"$o")" 1 "another pinned ref → refused"
q -d "${DB}_prodlike" -c "create table public.companies (id uuid primary key, name text); insert into public.companies values (gen_random_uuid(), 'real')" >/dev/null
o="$(mig "$(url ${DB}_prodlike)" DRY_RUN=1 APPROVED_DRAFTS=$MODULES || true)"; ok "$(grep -c 'no staging marker' <<<"$o")" 1 "a database with companies and no staging marker (production-like) → refused"
o="$(cd "$root" && env STAGING_DB_URL="postgresql://postgres@/$DB?host=$PG_HOST&port=$PG_PORT&a=$STG" STAGING_PROJECT_REF="$STG" PRODUCTION_PROJECT_REF="$PROD" EXPECT_STAGING_REF="$STG" DRY_RUN=1 bash scripts/staging/apply-migrations.sh 2>&1 || true)"
ok "$(grep -c 'user/host is not the staging project' <<<"$o")" 1 "a user that is not postgres.<staging ref> → refused"

echo "== 2. DRY_RUN with the module approvals"
o="$(mig "$(url $DB)" DRY_RUN=1 APPROVED_DRAFTS=$MODULES)"; echo "$o" | grep -E '^(Pending|Held|DRY_RUN|Environment marker)' | sed 's/^/    /'
ok "$(grep -c "^Pending: ${MODULES//,/ }$" <<<"$o")" 1 "dry run lists exactly 0015 … 0035, in order"
ok "$(grep -c '^Held (draft not approved.*): 0036_workforce_access_check$' <<<"$o")" 1 "once 0015–0035 are approved only the later draft 0036 stays held (it needs its own approval)"
fp $DB > /tmp/rehearsal_fp1.$$
ok "$(diff -q /tmp/rehearsal_fp0.$$ /tmp/rehearsal_fp1.$$ >/dev/null && echo same || echo changed)" same "dry run and refusals wrote nothing (catalog fingerprint identical)"
o="$(mig "$(url $DB)" DRY_RUN=1)"; ok "$(grep -c '^Held (draft not approved' <<<"$o")" 1 "without APPROVED_DRAFTS the same drafts stay held"

echo "== 3. Apply and confirm"
q -d postgres -c "create database ${DB}_rb template $DB" >/dev/null      # copy at today's state for the rollback rehearsal of an empty module set
o="$(mig "$(url $DB)" APPROVED_DRAFTS=$MODULES)"; echo "$o" | grep -E 'applying|ERROR|verify_after' | sed 's/^/    /' | tail -25
ok "$(grep -c 'Staging database is up to date and verified' <<<"$o")" 1 "apply 0015–0035: up to date and verified"
o="$(mig "$(url $DB)" DRY_RUN=1 EXPECT_NONE=1 STATUS=1 VERIFY_0014A=1)"
ok "$(grep -c 'No pending migrations' <<<"$o")/$(grep -c '✓' <<<"$o")" "1/33" "confirm: nothing pending, 33 recorded"
ok "$(grep -c '^verify_0014a: OK$' <<<"$o")" 1 "verify_0014a (read-only): OK with every module permission"
echo "$o" | grep '^storage_policy' | sed 's/^/    /'
ok "$(grep -c '^storage_policy: .*\(repository\|allowed: limited to bucket\)' <<<"$o")/$(grep -c '^storage_policy: ' <<<"$o")" "13/13" "storage: 13 policies, all repository or limited to their own bucket"

echo "== 4. Existing data intact and isolated"
ok "$(counts)" "$before_counts" "companies / clients / documents / payments / memberships unchanged"
ok "$(q -d $DB -tA -c "select document_number from public.documents where id = 'd4000000-0000-4000-8000-000000000001'")" "DEMO-0001" "the old invoice keeps its number"
other=$(q -d $DB -tA -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"d1000000-0000-4000-8000-000000000002\",\"role\":\"authenticated\"}', true); set local role authenticated; select count(*) from public.documents; rollback;" | sed -n 2p)
ok "$other" 0 "another company's owner sees none of the demo documents (RLS)"
own=$(q -d $DB -tA -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"d1000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}', true); set local role authenticated; select count(*) from public.clients; rollback;" | sed -n 2p)
ok "$own" 1 "the demo owner reads its client"

echo "== 5. Rollbacks in reverse order (0035 → 0015) on the migrated database"
for m in $(tr ',' '\n' <<<"$MODULES" | tac); do
  f="$sb/rollback/${m%%_*}_rollback.sql"
  if [[ ! -f "$f" ]]; then echo "    $m: no rollback file"; fail=$((fail+1)); continue; fi
  if out=$(q -d "$DB" -f "$f" 2>&1); then echo "    $m: rolled back"
  else echo "    $m: REFUSED — $(grep -oE 'BA[0-9a-z]+ rollback[^.]*\.?' <<<"$out" | head -1)"; echo "    (stopping: later rollbacks depend on it)"; break; fi
done
ok "$(q -d $DB -tA -c "select count(*) from public.documents")" "$(cut -d/ -f3 <<<"$before_counts")" "rollbacks never delete business documents"

rm -f /tmp/rehearsal_fp0.$$ /tmp/rehearsal_fp1.$$
echo; echo "Result: $pass passed, $fail failed"; [[ $fail == 0 ]]
