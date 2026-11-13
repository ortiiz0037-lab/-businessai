#!/usr/bin/env bash
# =====================================================================
# Apply the repository migrations to the STAGING Supabase database.
# =====================================================================
# Required environment:
#   STAGING_DB_URL       Postgres URI of the STAGING project (Supabase →
#                        Connect → Session pooler). Secret.
#   STAGING_PROJECT_REF  The staging project ref (subdomain of its API URL).
# Optional:
#   PRODUCTION_PROJECT_REF  Ref of the production project: refused if it
#                           appears in STAGING_DB_URL.
#   DRY_RUN=1               Run every guard and list pending migrations,
#                           without changing anything.
#   EXPECT_NONE=1           (with DRY_RUN=1) fail if anything is still pending
#                           — used to confirm a run.
#   STATUS=1                (with DRY_RUN=1) also list the applied migrations
#                           recorded in ba_meta.applied_migrations.
#   VERIFY_0014A=1          (with DRY_RUN=1) run supabase/inspect/verify_0014a.sql
#                           in a READ-ONLY transaction when 0014a is recorded;
#                           fail unless it answers OK.
#                           Also lists every storage.objects policy with its R3
#                           verdict (supabase/inspect/inspect_storage_policies.sql,
#                           read-only), whether or not 0014a is recorded.
#   APPROVED_DRAFTS         Comma-separated migration names that the owner
#                           approved for THIS run although their header says
#                           "-- STAGING-GATE: approval required". Without it that migration and every
#                           migration after it are HELD: listed, never applied
#                           (review finding I12: adding a draft to ORDER must
#                           not make the next staging:migrate apply it).
#   EXPECT_STAGING_REF      If set, STAGING_PROJECT_REF must equal it (a ref
#                           pinned in the workflow, so a changed repository
#                           variable cannot redirect the run).
#
# Guards (any failure → exit before changing anything):
#   * STAGING_DB_URL must contain STAGING_PROJECT_REF and must not contain
#     PRODUCTION_PROJECT_REF.
#   * The database must NOT look like production: production has objects
#     created outside the repository (can_edit_company_profile, the legacy
#     payments_update_own_company policy) that staging never gets.
#   * Environment marker: the first run marks an EMPTY database as staging
#     (ba_meta.environment). Later runs require that marker. A database that
#     already has companies and no staging marker (production) is refused,
#     whatever else changes in it over time.
# Applied migrations are recorded in ba_meta.applied_migrations (name =
# identifier in ORDER, sha256 of the file), only after the file succeeded.
# Transactions: 0002 and 0005 onwards wrap their whole content in
# begin/commit, so a failure changes nothing; 0001, 0003 and 0004 have no
# explicit transaction (already applied; not modified). Every new migration
# must start with "begin;" and end with "commit;" (tests/staging-scripts.test.ts).
# If a file commits but its record is lost, the next run re-applies it:
# migrations must be idempotent.
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MIG="$ROOT/supabase/migrations"
VERIFY="$ROOT/supabase/inspect/verify_after_migrations.sql"
VERIFY_E3="$ROOT/supabase/inspect/verify_0014a.sql"
STORAGE_POLICIES="$ROOT/supabase/inspect/inspect_storage_policies.sql"

# Order for a NEW environment (docs/ENVIRONMENTS.md).
ORDER=(
  0001_multitenant_core
  0002_business_tables
  0003_company_profile
  0004_stripe_subscriptions
  0005_security_baseline
  0007_storage_company_assets
  0009_private_signatures
  0006_payments_document_fk
  0008_definer_function_grants
  0010_billing
  0011_usage_limits
  0014a_permissions
  0015_documents_lifecycle
  0016_billing_hardening
  0017_plan_features
  0018_team
  0019_crm
  0020_workforce
  0021_workforce_kiosk
  0022_workforce_rules
  0023_ledger
  0024_payables
  0025_receivables
  0026_bank_reconciliation
  0027_statements_budgets
  0028_document_studio
  0029_assistant
  0030_intelligence_core
  0031_intelligence_insights
  0032_assistant_bank_summary
  0033_workforce_hr
  0034_payroll
)
EXPECTED_VERIFY="10,0,2,0,f,0,2,3,t,t,t,"

die() { echo "ERROR: $*" >&2; exit 1; }

: "${STAGING_DB_URL:?STAGING_DB_URL is required}"
: "${STAGING_PROJECT_REF:?STAGING_PROJECT_REF is required}"
[[ "$STAGING_PROJECT_REF" =~ ^[a-z0-9]{6,40}$ ]] || die "STAGING_PROJECT_REF has an unexpected format"
[[ -z "${EXPECT_STAGING_REF:-}" || "$STAGING_PROJECT_REF" == "$EXPECT_STAGING_REF" ]] || die "STAGING_PROJECT_REF is not the pinned staging project"
[[ "$STAGING_DB_URL" == *"$STAGING_PROJECT_REF"* ]] || die "STAGING_DB_URL does not belong to STAGING_PROJECT_REF"
# The pooler user must be exactly postgres.<staging ref> (no other project can be reached).
[[ "$STAGING_DB_URL" == *"://postgres.$STAGING_PROJECT_REF:"* || "$STAGING_DB_URL" == *"://postgres.$STAGING_PROJECT_REF@"* || "$STAGING_DB_URL" == *"@db.$STAGING_PROJECT_REF.supabase.co"* ]] \
  || die "STAGING_DB_URL user/host is not the staging project (expected postgres.$STAGING_PROJECT_REF)"
if [[ -n "${PRODUCTION_PROJECT_REF:-}" ]]; then
  [[ "$STAGING_PROJECT_REF" != "$PRODUCTION_PROJECT_REF" ]] || die "STAGING_PROJECT_REF equals PRODUCTION_PROJECT_REF"
  [[ "$STAGING_DB_URL" != *"$PRODUCTION_PROJECT_REF"* ]] || die "STAGING_DB_URL points at the PRODUCTION project"
fi

psqlx() { PGCONNECT_TIMEOUT=15 psql "$STAGING_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "Connecting to staging project ${STAGING_PROJECT_REF}…"
fingerprint="$(psqlx -tA -c "
  select (to_regprocedure('public.can_edit_company_profile(uuid)') is not null)::int
       + (select count(*) from pg_policies where schemaname = 'public'
            and policyname in ('payments_update_own_company', 'payments_delete_own_company'))::int")" \
  || die "cannot connect to the staging database"
[[ "$fingerprint" == "0" ]] || die "this database looks like PRODUCTION (objects created outside the repository found). Nothing was changed."

# (two queries: a table that does not exist cannot be referenced in one)
has_marker="$(psqlx -tA -c "select to_regclass('ba_meta.environment') is not null")" || die "cannot read the environment marker"
if [[ "$has_marker" == "t" ]]; then
  marker="$(psqlx -tA -c "select coalesce(string_agg(name, ','), '') from ba_meta.environment")" || die "cannot read the environment marker"
else
  marker="$(psqlx -tA -c "select case when to_regclass('public.companies') is null then 'unmarked-empty' else '' end")"
  if [[ -z "$marker" ]]; then
    marker="$(psqlx -tA -c "select case when exists (select 1 from public.companies) then 'unmarked-with-data' else 'unmarked-empty' end")" \
      || die "cannot read the environment marker"
  fi
fi
case "$marker" in
  staging) echo "Environment marker: staging" ;;
  unmarked-empty)
    if [[ "${DRY_RUN:-0}" != "1" ]]; then
      psqlx -c "create schema if not exists ba_meta;
                create table ba_meta.environment (name text primary key check (name = 'staging'),
                                                  marked_at timestamptz not null default now());
                insert into ba_meta.environment (name) values ('staging');" >/dev/null
      echo "Empty database marked as staging."
    fi ;;
  unmarked-with-data) die "this database already has companies and no staging marker (production?). Nothing was changed." ;;
  *) die "environment marker is '$marker', not staging. Nothing was changed." ;;
esac

# The record table is created only when applying (DRY_RUN writes nothing).
if [[ "${DRY_RUN:-0}" != "1" ]]; then
  psqlx -c "create schema if not exists ba_meta;
          create table if not exists ba_meta.applied_migrations (
            name text primary key, sha256 text not null, applied_at timestamptz not null default now());
          revoke all on schema ba_meta from public, anon, authenticated;" >/dev/null

fi
has_record="$(psqlx -tA -c "select to_regclass('ba_meta.applied_migrations') is not null")"

# Once one migration is (re)applied, every later one is re-applied too: a
# later migration may replace objects of an earlier one (e.g. 0011 replaces
# 0010's company_billing_state), so order is preserved.
pending=()
cascade=0
known=""
for name in "${ORDER[@]}"; do
  file="$MIG/$name.sql"
  [[ -f "$file" ]] || die "missing migration file $name.sql"
  sum="$(sha256sum "$file" | cut -d' ' -f1)"
  recorded=""
  if [[ "$has_record" == "t" ]]; then
    recorded="$(psqlx -tA -c "select sha256 from ba_meta.applied_migrations where name = '$name'")"
  fi
  # Exactly this content was applied here before (used by the draft gate).
  [[ -n "$recorded" && "$recorded" == "$sum" ]] && known+="$name,"
  if [[ "$cascade" == 1 ]]; then pending+=("$name"); continue; fi
  if [[ -z "$recorded" ]]; then
    pending+=("$name"); cascade=1
  elif [[ "$recorded" != "$sum" ]]; then
    echo "  ~ $name changed since it was applied; it and every later migration will be re-applied"
    pending+=("$name"); cascade=1
  fi
done

# Draft gate: stop at the first pending draft that was not approved.
# shellcheck source=draft-gate.sh
source "$HERE/draft-gate.sh"
held=()
runnable=()
if [[ ${#pending[@]} -gt 0 ]]; then
  while read -r verdict name; do
    if [[ "$verdict" == RUN ]]; then runnable+=("$name"); else held+=("$name"); fi
  done < <(draft_gate "$MIG" "${APPROVED_DRAFTS:-}" "$known" "${pending[@]}")
fi
pending=("${runnable[@]+"${runnable[@]}"}")

if [[ ${#pending[@]} -eq 0 ]]; then
  echo "No pending migrations."
else
  echo "Pending: ${pending[*]}"
fi
if [[ ${#held[@]} -gt 0 ]]; then
  echo "Held (draft not approved — pass APPROVED_DRAFTS to apply): ${held[*]}"
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  if [[ "${STATUS:-0}" == "1" && "$has_record" == "t" ]]; then
    echo "Applied (ba_meta.applied_migrations):"
    psqlx -tA -F' ' -c "select '  ✓ ' || name || '  ' || to_char(applied_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' from ba_meta.applied_migrations order by applied_at, name"
    result="$(psqlx -tA -F, -f "$VERIFY")"
    echo "verify_after_migrations: $result"
    [[ "$result" == "$EXPECTED_VERIFY" ]] || die "verification differs from the expected $EXPECTED_VERIFY"
  fi
  if [[ "${VERIFY_0014A:-0}" == "1" ]]; then
    # R3: every storage.objects policy with its verdict (names and verdicts
    # only; read-only like the verification below). Listed before and after 0014a.
    PGOPTIONS="-c default_transaction_read_only=on" psqlx -tA -F' | ' \
      -c "begin transaction read only" \
      -c "select 'storage_policy: ' || policyname, cmd, roles, verdict from ($(sed -e 's/--.*$//' -e '/^order by/d' -e 's/;$//' "$STORAGE_POLICIES")) s order by 1" \
      -c "rollback"
    recorded_0014a=""
    if [[ "$has_record" == "t" ]]; then
      recorded_0014a="$(psqlx -tA -c "select sha256 from ba_meta.applied_migrations where name = '0014a_permissions'")"
    fi
    if [[ -z "$recorded_0014a" ]]; then
      echo "verify_0014a: 0014a_permissions not recorded yet — skipped"
    else
      # Strictly read-only: read-only session default AND an explicit
      # read-only transaction that is rolled back.
      e3="$(PGOPTIONS="-c default_transaction_read_only=on" psqlx -tA \
              -c "begin transaction read only" -f "$VERIFY_E3" -c "rollback")"
      echo "verify_0014a: $e3"
      [[ "$e3" == "OK" ]] || die "0014a verification failed: $e3"
    fi
  fi
  if [[ "${EXPECT_NONE:-0}" == "1" && ${#pending[@]} -gt 0 ]]; then die "migrations still pending after the run: ${pending[*]}"; fi
  echo "DRY_RUN=1: nothing applied."
  exit 0
fi

for name in "${pending[@]}"; do
  file="$MIG/$name.sql"
  echo "→ applying $name"
  PGOPTIONS="-c client_min_messages=warning" psqlx -f "$file" >/dev/null
  psqlx -c "insert into ba_meta.applied_migrations (name, sha256) values ('$name', '$(sha256sum "$file" | cut -d' ' -f1)')
            on conflict (name) do update set sha256 = excluded.sha256, applied_at = now()" >/dev/null
done

result="$(psqlx -tA -F, -f "$VERIFY")"
echo "verify_after_migrations: $result"
[[ "$result" == "$EXPECTED_VERIFY" ]] || die "verification differs from the expected $EXPECTED_VERIFY"
echo "Staging database is up to date and verified."
