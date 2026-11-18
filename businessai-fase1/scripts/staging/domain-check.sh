#!/usr/bin/env bash
# READ-ONLY check of the staging custom domain (label `staging:domain-check`). Writes nothing anywhere:
# DNS lookups, a TLS handshake and HTTP GET / unsigned POST requests only.
#   1. DNS: what the domain resolves to (CNAME target, addresses).
#   2. TLS: certificate valid for the domain (issuer, expiry).
#   3. Protection: without the bypass the Preview is NOT public (Vercel Authentication).
#   4. With the bypass: /login answers 200 on the domain.
#   5. Same deployment as the branch alias (STAGING_URL): a build asset of the alias is served by the domain.
#   6. The Stripe webhook route on the domain refuses an unsigned request (400) — signature checked there too.
# Env: STAGING_DOMAIN, STAGING_URL, VERCEL_AUTOMATION_BYPASS_SECRET, PRODUCTION_PROJECT_REF (refused if present).
set -uo pipefail
: "${STAGING_DOMAIN:?}" "${STAGING_URL:?}" "${VERCEL_AUTOMATION_BYPASS_SECRET:?}"
case "$STAGING_DOMAIN$STAGING_URL" in *"${PRODUCTION_PROJECT_REF:-never-matches}"*) echo "ERROR: refusing a production reference"; exit 1;; esac
case "$STAGING_DOMAIN" in staging.*) ;; *) echo "ERROR: only a staging.* domain is checked here"; exit 1;; esac
fail=0
ok() { if [ "$1" = 0 ]; then echo "PASS: $2"; else echo "FAIL: $2${3:+ — $3}"; fail=1; fi; }
D="https://$STAGING_DOMAIN"; A="${STAGING_URL%/}"
BY=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" -H "x-vercel-skip-toolbar: 1")

echo "== 1. DNS"
cname=$(dig +short CNAME "$STAGING_DOMAIN" | head -1); addrs=$(dig +short "$STAGING_DOMAIN" | grep -E '^[0-9.]+$' | paste -sd' ' -)
echo "CNAME: ${cname:-none} · addresses: ${addrs:-none}"
[ -n "$addrs" ]; ok $? "the domain resolves"

echo "== 2. TLS"
cert=$(echo | openssl s_client -connect "$STAGING_DOMAIN:443" -servername "$STAGING_DOMAIN" 2>/dev/null | openssl x509 -noout -issuer -enddate -ext subjectAltName 2>/dev/null)
echo "$cert" | sed 's/^/    /'
echo "$cert" | grep -q "DNS:$STAGING_DOMAIN"; ok $? "certificate covers $STAGING_DOMAIN"
curl -sS -o /dev/null --max-time 20 "$D/login"; ok $? "TLS handshake and certificate chain accepted by curl"

echo "== 3. Protection (no bypass)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$D/login")
case "$code" in 401|302|307|403) r=0;; *) r=1;; esac; ok $r "without the bypass the Preview is not public (HTTP $code)"

echo "== 4. App through the bypass"
html=$(curl -s --max-time 30 "${BY[@]}" "$D/login"); code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${BY[@]}" "$D/login")
[ "$code" = 200 ]; ok $? "/login answers 200 on the domain"

echo "== 5. Same deployment as the branch alias"
asset=$(curl -s --max-time 30 "${BY[@]}" "$A/login" | grep -oE '/_next/static/[^"]+\.js' | head -1)
if [ -n "$asset" ]; then
  a=$(curl -s --max-time 30 "${BY[@]}" "$A$asset" | sha256sum | cut -c1-16); d=$(curl -s --max-time 30 "${BY[@]}" "$D$asset" | sha256sum | cut -c1-16)
  [ "$a" = "$d" ]; ok $? "the domain serves the alias's build (asset hash $a / $d)"
else ok 1 "a build asset was found on the alias"; fi
grep -q "$asset" <<<"$html"; ok $? "the domain's /login references the same build asset"

echo "== 6. Stripe webhook route on the domain"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${BY[@]}" -X POST -H 'content-type: application/json' --data '{}' "$D/api/stripe/webhook")
[ "$code" = 400 ]; ok $? "an unsigned webhook request is refused (HTTP $code)"

[ $fail = 0 ] && echo "RESULT: $STAGING_DOMAIN serves the staging Preview correctly" || echo "RESULT: see the FAIL lines"
exit $fail
