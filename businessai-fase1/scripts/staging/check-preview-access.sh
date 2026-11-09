#!/usr/bin/env bash
# =====================================================================
# Read-only check: can automation reach the STAGING preview?
# =====================================================================
#   STAGING_URL=https://… [VERCEL_AUTOMATION_BYPASS_SECRET=…] check-preview-access.sh
#
# Vercel Deployment Protection (Vercel Authentication, Standard Protection)
# answers 401 to anyone not signed in to Vercel — including Stripe's webhook
# deliveries and this workflow. Vercel's "Protection Bypass for Automation"
# secret lets automation through WITHOUT turning protection off:
#   * header   x-vercel-protection-bypass: <secret>   (smoke tests)
#   * query    ?x-vercel-protection-bypass=<secret>   (Stripe webhooks,
#              which cannot send custom headers)
# This script only sends GET requests to /login and never prints the secret.
# Exit 1 when the preview is protected and the secret is missing or rejected.
# =====================================================================
set -uo pipefail
: "${STAGING_URL:?STAGING_URL is required}"
BASE="${STAGING_URL%/}"
SECRET="${VERCEL_AUTOMATION_BYPASS_SECRET:-}"

code() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 "$@"; }

read -r plain plain_redirect <<<"$(code "$BASE/login")"
protected=false
if [[ "$plain" == 401 || "$plain" == 403 ]] || [[ "$plain" =~ ^30[1278]$ && "$plain_redirect" == *vercel.com* ]]; then
  protected=true
fi
echo "Preview without bypass: HTTP $plain → protected: $protected"

if [[ "$protected" == false ]]; then
  echo "OK: the preview is reachable without bypass (Stripe can deliver webhooks)."
  exit 0
fi

if [[ -z "$SECRET" ]]; then
  echo "ERROR: the preview is protected (Vercel Authentication) and the secret" >&2
  echo "       VERCEL_AUTOMATION_BYPASS_SECRET is not configured in GitHub." >&2
  echo "       Vercel → project → Settings → Deployment Protection →" >&2
  echo "       Protection Bypass for Automation → create; then GitHub → Settings →" >&2
  echo "       Secrets and variables → Actions → New repository secret." >&2
  exit 1
fi

read -r with_header _ <<<"$(code -H "x-vercel-protection-bypass: $SECRET" "$BASE/login")"
read -r with_query _ <<<"$(code "$BASE/login?x-vercel-protection-bypass=$(printf %s "$SECRET" | jq -sRr @uri)")"
echo "With bypass header: HTTP $with_header · with bypass query parameter (as Stripe will use it): HTTP $with_query"

if [[ "$with_header" == 200 && "$with_query" != 401 && "$with_query" != 403 ]]; then
  echo "OK: the bypass secret is accepted; protection stays on for everyone else."
  exit 0
fi
echo "ERROR: Vercel rejected VERCEL_AUTOMATION_BYPASS_SECRET (wrong value, revoked, or for another project)." >&2
exit 1
