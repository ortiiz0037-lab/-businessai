# Shared checks of scripts/staging/verify-0036.sh (sourced; also sourced by the tests).
# No side effects when sourced: only function definitions.

# strict_staging_url URL STAGING_REF PRODUCTION_REF
# Same project criterion as scripts/staging/apply-migrations.sh, and Production is
# REQUIRED here (never optional): prints the reason and returns 1 on any doubt.
strict_staging_url() {
  local url="$1" ref="$2" prod="$3"
  [[ -n "$url" ]] || { echo "ERROR: STAGING_DB_URL is required"; return 1; }
  [[ "$ref" =~ ^[a-z0-9]{6,40}$ ]] || { echo "ERROR: the staging project ref has an unexpected format"; return 1; }
  [[ "$prod" =~ ^[a-z0-9]{6,40}$ ]] || { echo "ERROR: PRODUCTION_PROJECT_REF is required (to refuse Production)"; return 1; }
  [[ "$ref" != "$prod" ]] || { echo "ERROR: the staging project ref equals PRODUCTION_PROJECT_REF"; return 1; }
  [[ "$url" != *"$prod"* ]] || { echo "ERROR: STAGING_DB_URL points at the PRODUCTION project"; return 1; }
  [[ "$url" == *"$ref"* ]] || { echo "ERROR: STAGING_DB_URL does not belong to the staging project"; return 1; }
  # the user must be exactly postgres.<staging ref> (pooler) or the host db.<staging ref>.supabase.co
  [[ "$url" == *"://postgres.$ref:"* || "$url" == *"://postgres.$ref@"* || "$url" == *"@db.$ref.supabase.co"* ]] \
    || { echo "ERROR: STAGING_DB_URL user/host is not the staging project (expected postgres.$ref)"; return 1; }
}

# catalog_fp FILE — hash of the read-only catalog fingerprint. Fails EXPLICITLY when psql
# fails or returns nothing: two failed or empty reads must never compare as "identical".
# Uses the caller's ro() (read-only psql).
catalog_fp() {
  local out rc err
  err="$(mktemp)"
  out="$(ro -f "$1" 2>"$err")"; rc=$?
  if [[ $rc -ne 0 ]]; then echo "ERROR: catalog fingerprint failed (psql exit $rc): $(head -c 300 "$err")" >&2; rm -f "$err"; return 1; fi
  rm -f "$err"
  if [[ -z "${out//[[:space:]]/}" ]]; then echo "ERROR: catalog fingerprint is empty" >&2; return 1; fi
  sha256sum <<<"$out" | cut -c1-16
}
