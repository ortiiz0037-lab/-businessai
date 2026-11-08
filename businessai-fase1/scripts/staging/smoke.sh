#!/usr/bin/env bash
# Smoke test of the deployed STAGING app. Reads nothing private.
#   STAGING_URL=https://… [VERCEL_AUTOMATION_BYPASS_SECRET=…] scripts/staging/smoke.sh
set -uo pipefail
: "${STAGING_URL:?STAGING_URL is required}"
BASE="${STAGING_URL%/}"
H=()
[[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]] && H=(-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")

pass=0; fail=0
expect() { # label, expected-code, curl args...
  local label="$1" want="$2"; shift 2
  local got; got="$(curl -s -o /tmp/smoke.body -w '%{http_code}' --max-time 20 "${H[@]}" "$@")"
  if [[ "$got" == "$want" ]]; then echo "PASS: $label ($got)"; pass=$((pass+1))
  else echo "FAIL: $label (got $got, want $want) $(head -c 200 /tmp/smoke.body)"; fail=$((fail+1)); fi
}

expect "login page is served" 200 "$BASE/login"
expect "billing requires a session" 307 "$BASE/billing"
expect "checkout requires a session" 307 -X POST "$BASE/api/stripe/checkout"
expect "webhook rejects a request without signature" 400 -X POST -d '{}' "$BASE/api/stripe/webhook"
expect "webhook rejects a forged signature" 400 -X POST -H 'stripe-signature: t=1,v1=forged' -d '{"id":"evt_x"}' "$BASE/api/stripe/webhook"
if grep -q "invalid_signature" /tmp/smoke.body 2>/dev/null; then
  echo "PASS: webhook is configured (verifies signatures)"; pass=$((pass+1))
else echo "FAIL: webhook is not configured on staging (expected invalid_signature)"; fail=$((fail+1)); fi

echo "Smoke: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
