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
# Applied migrations are recorded in ba_meta.applied_migrations; each file
# runs in its own transaction (the files contain begin/commit).
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MIG="$ROOT/supabase/migrations"
VERIFY="$ROOT/supabase/inspect/verify_after_migrations.sql"

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
)
EXPECTED_VERIFY="10,0,2,0,f,0,2,3,t,t,t,"

die() { echo "ERROR: $*" >&2; exit 1; }

: "${STAGING_DB_URL:?STAGING_DB_URL is required}"
: "${STAGING_PROJECT_REF:?STAGING_PROJECT_REF is required}"
[[ "$STAGING_PROJECT_REF" =~ ^[a-z0-9]{6,40}$ ]] || die "STAGING_PROJECT_REF has an unexpected format"
[[ "$STAGING_DB_URL" == *"$STAGING_PROJECT_REF"* ]] || die "STAGING_DB_URL does not belong to STAGING_PROJECT_REF"
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
for name in "${ORDER[@]}"; do
  if [[ "$cascade" == 1 ]]; then pending+=("$name"); continue; fi
  file="$MIG/$name.sql"
  [[ -f "$file" ]] || die "missing migration file $name.sql"
  sum="$(sha256sum "$file" | cut -d' ' -f1)"
  recorded=""
  if [[ "$has_record" == "t" ]]; then
    recorded="$(psqlx -tA -c "select sha256 from ba_meta.applied_migrations where name = '$name'")"
  fi
  if [[ -z "$recorded" ]]; then
    pending+=("$name"); cascade=1
  elif [[ "$recorded" != "$sum" ]]; then
    echo "  ~ $name changed since it was applied; it and every later migration will be re-applied"
    pending+=("$name"); cascade=1
  fi
done

if [[ ${#pending[@]} -eq 0 ]]; then
  echo "No pending migrations."
else
  echo "Pending: ${pending[*]}"
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
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
