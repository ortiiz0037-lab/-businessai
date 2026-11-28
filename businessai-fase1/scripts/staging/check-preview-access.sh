#!/usr/bin/env bash
# =====================================================================
# Read-only check: can automation reach the STAGING preview?
# =====================================================================
#   STAGING_URL=https://… [VERCEL_AUTOMATION_BYPASS_SECRET=…] check-preview-access.sh
#
# Vercel Deployment Protection (Vercel Authentication, Standard Protection)
# redirects anyone not signed in to Vercel (HTTP 302 → vercel.com, or 401) —
# including Stripe's webhook deliveries and this workflow. Vercel's
# "Protection Bypass for Automation" secret lets automation through WITHOUT
# turning protection off:
#   * header   x-vercel-protection-bypass: <secret>   (smoke tests)
#   * query    ?x-vercel-protection-bypass=<secret>   (Stripe webhooks)
#
# Two separate questions, two separate probes:
#   1. Is the bypass accepted?  → a STATIC path (/_next/static/…) that never
#      runs the app: rejected = Vercel's login again (302/401/403);
#      accepted = anything else (normally 404 from the deployment itself).
#      This does not depend on the app being healthy.
#   2. Is the app healthy?      → /login with the bypass. Reported only: before
#      step 3 writes the staging variables the preview may legitimately fail
#      (e.g. built without NEXT_PUBLIC_SUPABASE_*). The smoke test (step 4a)
#      checks health after step 3.
# Only GET requests. The secret is never printed.
# Exit 1 only when the preview is protected and the bypass is missing or
# rejected.
# =====================================================================
set -uo pipefail
: "${STAGING_URL:?STAGING_URL is required}"
BASE="${STAGING_URL%/}"
SECRET="${VERCEL_AUTOMATION_BYPASS_SECRET:-}"
PROBE="/_next/static/businessai-bypass-probe"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# probe <name> <url> [curl args…] → sets <name>_code, <name>_redirect, <name>_err
probe() {
  local name="$1" url="$2"; shift 2
  local out
  out="$(curl -s -D "$TMP/$name.h" -o "$TMP/$name.b" -w '%{http_code} %{redirect_url}' --max-time 20 "$@" "$url")"
  printf -v "${name}_code" '%s' "${out%% *}"
  printf -v "${name}_redirect" '%s' "${out#* }"
  printf -v "${name}_err" '%s' "$(grep -i '^x-vercel-error:' "$TMP/$name.h" | head -1 | cut -d: -f2- | tr -d ' \r')"
}
is_login_wall() { # code redirect
  [[ "$1" == 401 || "$1" == 403 ]] || [[ "$1" =~ ^30[1278]$ && "$2" == *vercel.com* ]]
}

probe plain "$BASE$PROBE"
if ! is_login_wall "$plain_code" "$plain_redirect"; then
  echo "Preview without bypass: HTTP $plain_code → not protected."
  echo "OK: the preview is reachable without bypass (Stripe can deliver webhooks)."
  exit 0
fi
echo "Preview without bypass: HTTP $plain_code → protected by Vercel Authentication (expected)."

if [[ -z "$SECRET" ]]; then
  echo "ERROR: the preview is protected and the secret VERCEL_AUTOMATION_BYPASS_SECRET" >&2
  echo "       is not available to this workflow (GitHub → Settings → Secrets and variables → Actions)." >&2
  exit 1
fi

encoded="$(printf %s "$SECRET" | jq -sRr @uri)"
probe header "$BASE$PROBE" -H "x-vercel-protection-bypass: $SECRET"
probe query "$BASE$PROBE?x-vercel-protection-bypass=$encoded"
echo "Bypass check on a static path (does not run the app):"
echo "  header x-vercel-protection-bypass → HTTP $header_code${header_err:+ ($header_err)}"
echo "  query parameter (as Stripe uses it) → HTTP $query_code${query_err:+ ($query_err)}"

if is_login_wall "$header_code" "$header_redirect" || is_login_wall "$query_code" "$query_redirect"; then
  echo "ERROR: Vercel still answers with its login wall: the bypass secret is not accepted" >&2
  echo "       for this deployment (wrong value, revoked, or created for another project)." >&2
  exit 1
fi
echo "OK: Vercel accepts the bypass secret (header and query parameter); protection stays on for everyone else."

# App health — informational only.
probe app "$BASE/login" -H "x-vercel-protection-bypass: $SECRET"
if [[ "$app_code" =~ ^5 ]]; then
  echo "NOTE: through the bypass, the app answers /login with HTTP $app_code${app_err:+ ($app_err)}."
  if grep -qi "URL and Key are required" "$TMP/app.b" 2>/dev/null || [[ "$app_err" == MIDDLEWARE_INVOCATION_FAILED ]]; then
    echo "      Likely cause: this preview was built without NEXT_PUBLIC_SUPABASE_URL /"
    echo "      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY for the Preview environment. Step 3"
    echo "      (staging:run) writes the staging values and the preview must be rebuilt;"
    echo "      the smoke test (step 4a) verifies the app afterwards."
  else
    echo "      Step 3 (staging:run) writes the staging variables; the smoke test (step 4a) verifies the app afterwards."
  fi
else
  echo "App through the bypass: /login → HTTP $app_code."
fi
exit 0
