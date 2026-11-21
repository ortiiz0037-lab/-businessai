# Shared guards and logic for the PRODUCTION scripts (sourced; no side effects when sourced).
#
# The Production project is PINNED here, not taken from a variable: a changed repository
# variable or secret can never redirect these scripts to another project.
PRODUCTION_REF=rugqcumiuqrjbfwpuslm   # Supabase project "businessai-dev" (PRODUCTION)
STAGING_REF=wbfpvxptoujgvflljasc      # businessai-staging: always refused here

_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Production order = the ORDER of scripts/staging/apply-migrations.sh from 0005 on (the same list Staging
# and the local Production rehearsal, scenario 53, use). One source of truth.
prod_order() {
  sed -n '/^ORDER=(/,/^)/p' "$_lib_dir/../staging/apply-migrations.sh" | grep -oE '[0-9]{4}[a-z]?_[a-z0-9_]+' | sed -n '/^0005_security_baseline$/,$p'
}
# Phase 1 (security, compatible with the current main app): the first five of the order.
PHASE1="0005_security_baseline 0007_storage_company_assets 0009_private_signatures 0006_payments_document_fk 0008_definer_function_grants"
is_phase1() { [[ " $PHASE1 " == *" $1 "* ]]; }

# strict_production_url URL — returns 1 (with the reason) unless the URL is exactly the pinned Production
# project: user postgres.<ref> (pooler) or host db.<ref>.supabase.co; never the Staging ref.
strict_production_url() {
  local url="$1"
  [[ -n "$url" ]] || { echo "ERROR: PRODUCTION_DB_URL is required"; return 1; }
  [[ "$url" != *"$STAGING_REF"* ]] || { echo "ERROR: the URL points at the STAGING project"; return 1; }
  [[ "$url" == *"$PRODUCTION_REF"* ]] || { echo "ERROR: the URL does not belong to the pinned Production project"; return 1; }
  [[ "$url" == *"://postgres.$PRODUCTION_REF:"* || "$url" == *"://postgres.$PRODUCTION_REF@"* || "$url" == *"@db.$PRODUCTION_REF.supabase.co"* ]] \
    || { echo "ERROR: the URL user/host is not the pinned Production project (expected postgres.$PRODUCTION_REF or db.$PRODUCTION_REF.supabase.co)"; return 1; }
}

# next_migration — reads the output of supabase/inspect/inspect_migration_state.sql (psql -tA, '|' separated:
# migration|status|evidence|applied_when) on stdin and prints the ONE migration that may run next, "none" when
# all are applied, or "STOP: <reason>" (exit 1) when the state is not a clean prefix of the order.
next_migration() {
  local -A st=(); local line name status
  while IFS='|' read -r name status _; do [[ -n "$name" ]] && st["$name"]="$status"; done
  [[ "${st[0001–0004 base schema]:-}" == applied ]] || { echo "STOP: base schema 0001–0004 not detected as applied"; return 1; }
  [[ "${st[staging bookkeeping (ba_meta)]:-}" == absent ]] || { echo "STOP: Staging bookkeeping found: this is not the Production database"; return 1; }
  local m seen_not=0 next=none
  for m in $(prod_order); do
    status="${st[$m]:-missing}"
    case "$status" in
      applied)       (( seen_not == 0 )) || { echo "STOP: $m is applied after a migration that is not: state is not a prefix of the order"; return 1; } ;;
      'not applied') (( seen_not == 1 )) || next="$m"; seen_not=1 ;;
      *)             echo "STOP: $m is '$status' (expected applied / not applied): review before any change"; return 1 ;;
    esac
  done
  echo "$next"
}

# ---- data checks (use the caller's read-only ro(); no side effects)
SUM_TABLES="public.companies public.memberships public.company_profiles public.company_subscriptions public.clients public.documents public.payments auth.users"
# Row-content checksums of the tables that hold today's data, over the columns they have BEFORE the migration
# (snapshot taken just before applying; a migration that adds columns with defaults is not a change of the
# existing data, a migration that rewrites a value is). Fails explicitly when a query fails.
declare -A COLS=()
snapshot_cols() {
  local t
  for t in $SUM_TABLES; do
    COLS[$t]="$(ro -c "select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema = split_part('$t', '.', 1) and table_name = split_part('$t', '.', 2)")" || return 1
  done
}
checksums() {
  local q="" t
  for t in $SUM_TABLES; do
    [[ -n "${COLS[$t]:-}" ]] || continue
    q+="${q:+ union all }select '$t' || chr(9) || count(*) || chr(9) || coalesce(md5(string_agg(row(${COLS[$t]})::text, chr(10) order by row(${COLS[$t]})::text)), 'empty') from $t"
  done
  [[ -n "$q" ]] || return 1
  ro -c "$q" | sort
}

