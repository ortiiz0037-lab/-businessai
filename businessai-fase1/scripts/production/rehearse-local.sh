#!/usr/bin/env bash
# Local rehearsal of the PRODUCTION migration procedure (scripts/production/lib.sh + migrate.sh logic)
# on a throw-away PostgreSQL with the INSPECTED Production shape and legacy data (the base of scenario 53 of
# supabase/tests/local/run.sh). Never connects to Supabase. For every migration in the Production order:
#   * next_migration (from inspect_migration_state.sql) names exactly that migration;
#   * a request for any OTHER migration would be refused (it is not the next one);
#   * after applying it, it is detected as applied and the state is still a clean prefix of the order;
#   * the content checksums of companies, memberships, profiles, subscriptions, clients, documents, payments
#     and users are unchanged.
# Also: the URL guard accepts only the pinned Production project; phase 2 needs a decision.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
LOCAL="$ROOT/supabase/tests/local"; MIG="$ROOT/supabase/migrations"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }
source "$HERE/lib.sh"

pass=0; fails=0
check() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; pass=$((pass+1)); else echo "FAIL: $3 (got '$1', want '$2')"; fails=$((fails+1)); fi; }

echo "== URL guard (no connection)"
p=rugqcumiuqrjbfwpuslm; s=wbfpvxptoujgvflljasc
g() { strict_production_url "$1" >/dev/null && echo accept || echo refuse; }
check "$(g "postgresql://postgres.$p:x@aws-0-us-east-1.pooler.supabase.com:5432/postgres")" accept "pooler URL of the pinned Production project"
check "$(g "postgresql://postgres:x@db.$p.supabase.co:5432/postgres")" accept "direct URL of the pinned Production project"
check "$(g "postgresql://postgres.$s:x@aws-0-us-east-1.pooler.supabase.com:5432/postgres")" refuse "Staging URL refused"
check "$(g "postgresql://postgres.$s:$p@aws-0-us-east-1.pooler.supabase.com:5432/postgres")" refuse "Staging URL with the Production ref elsewhere refused"
check "$(g "postgresql://postgres.otherproject:x@aws-0-us-east-1.pooler.supabase.com:5432/postgres?x=$p")" refuse "another project with the ref in the query refused"
check "$(g "postgresql://postgres@localhost:5432/postgres")" refuse "local URL refused"
check "$(g "")" refuse "empty URL refused"
check "$(prod_order | wc -l | tr -d ' ')" 39 "Production order: 39 migrations (0005 … 0045)"
check "$(prod_order | head -5 | tr '\n' ' ')" "$PHASE1 " "phase 1 = the first five of the order"

WORK="$(mktemp -d)"; RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; chmod 755 "$WORK"; fi
PORT="${PGTEST_PORT:-54339}"
cleanup() { "${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -p $PORT -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
psqlq() { PGOPTIONS="-c client_min_messages=warning" "${RUNAS[@]}" "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres "$@"; }
DB=prod_rehearsal
ro() { PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" "$PG_BIN/psql" -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d "$DB" "$@"; }

echo "== Inspected Production shape with legacy data"
psqlq -d postgres -c "create database $DB" >/dev/null
for f in "$LOCAL/00_supabase_shim.sql" "$MIG/0001_multitenant_core.sql" "$MIG/0003_company_profile.sql" "$MIG/0004_stripe_subscriptions.sql" "$LOCAL/01_business_fixture.sql" "$LOCAL/53_production_legacy_seed.sql"; do
  psqlq -d "$DB" -f "$f" >/dev/null || { echo "FAIL: cannot build the base ($f)"; exit 1; }
done
snapshot_cols || { echo "FAIL: cannot read columns"; exit 1; }
base_sums="$(checksums)"
declare -A BASE_COLS=(); for k in "${!COLS[@]}"; do BASE_COLS[$k]="${COLS[$k]}"; done
check "$(wc -l <<<"$base_sums" | tr -d ' ')" 8 "content checksums taken for the 8 tables that hold today's data"

echo "== Restore proof: pg_dump -Fc → pg_restore into a throw-away database → same rows and same content"
"${RUNAS[@]}" "$PG_BIN/pg_dump" -h "$WORK" -p "$PORT" -U postgres -Fc -d "$DB" -f "$WORK/base.dump" && check ok ok "dump of the Production-shaped database"
psqlq -d postgres -c "create database restored" >/dev/null
"${RUNAS[@]}" "$PG_BIN/pg_restore" --no-owner --no-acl -h "$WORK" -p "$PORT" -U postgres -d restored "$WORK/base.dump" 2>/dev/null
restored_sums="$(DB=restored checksums)"
check "$restored_sums" "$base_sums" "restored copy: same row counts and content checksums for the 8 tables"
check "$(DB=restored ro -f "$ROOT/supabase/inspect/inspect_migration_state.sql" | next_migration)" 0005_security_baseline "restored copy: same migration state (next is 0005)"
psqlq -d restored -c "update public.payments set amount = amount + 0.01 where id = (select id from public.payments limit 1)" >/dev/null
check "$( [[ "$(DB=restored checksums)" == "$base_sums" ]] && echo same || echo differs)" differs "a one-cent change in one payment is detected by the content checksum"
psqlq -d postgres -c "drop database restored" >/dev/null

echo "== One migration at a time, in the Production order"
steps=0
for m in $(prod_order); do
  state="$(ro -f "$ROOT/supabase/inspect/inspect_migration_state.sql")"
  next="$(next_migration <<<"$state")"
  [[ "$next" == "$m" ]] || { check "$next" "$m" "next migration before $m"; break; }
  other="$(prod_order | grep -vx "$m" | tail -1)"; [[ "$other" != "$next" ]] || other=0005_security_baseline
  snapshot_cols; before="$(checksums)"
  psqlq -d "$DB" -f "$MIG/$m.sql" >/dev/null 2>"$WORK/err" || { check fail ok "$m applies (see: $(head -c 200 "$WORK/err"))"; break; }
  state="$(ro -f "$ROOT/supabase/inspect/inspect_migration_state.sql")"
  [[ "$(awk -F'|' -v m="$m" '$1==m{print $2}' <<<"$state")" == applied ]] || { check no yes "$m detected as applied"; break; }
  after_next="$(next_migration <<<"$state")" || { check "$after_next" clean "state after $m"; break; }
  after="$(checksums)"
  [[ "$before" == "$after" ]] || { check changed unchanged "existing data unchanged by $m"; diff <(echo "$before") <(echo "$after") | head -4; break; }
  steps=$((steps+1))
done
check "$steps" 39 "39 / 39 steps: each one was the next, applied, detected, left a clean prefix and changed no existing data"
check "$(next_migration <<<"$(ro -f "$ROOT/supabase/inspect/inspect_migration_state.sql")")" none "after 0045: nothing left to apply"
for k in "${!BASE_COLS[@]}"; do COLS[$k]="${BASE_COLS[$k]}"; done
check "$(checksums)" "$base_sums" "existing data identical to before 0005 (content checksums of the 8 tables)"
check "$(ro -c 'select count(*) from public.role_permissions')" 153 "permission matrix: 153 rows"
check "$(ro -c "select count(*) from pg_namespace where nspname = 'ba_meta'")" 0 "no Staging bookkeeping created (ba_meta absent)"

echo "== Refusals (no connection)"
check "$(PRODUCTION_DB_URL="postgresql://postgres.$p:x@db.invalid:1/x" TARGET=0010_billing MODE=plan bash "$HERE/migrate.sh" 2>&1 | grep -c 'needs the owner')" 1 "phase 2 without the owner's decision is refused before connecting"
check "$(PRODUCTION_DB_URL="postgresql://postgres.$s:x@db.invalid:1/x" TARGET=0005_security_baseline MODE=plan bash "$HERE/migrate.sh" 2>&1 | grep -c 'STAGING')" 1 "a Staging URL is refused before connecting"
check "$(PRODUCTION_DB_URL="postgresql://postgres.$p:x@db.invalid:1/x" TARGET=0012_nothing MODE=plan bash "$HERE/migrate.sh" 2>&1 | grep -c 'not a Production migration')" 1 "an unknown migration name is refused"
check "$(PRODUCTION_DB_URL="postgresql://postgres.$p:x@db.invalid:1/x" OUT_DIR="$WORK/b" LABEL=x RESTORE_PSQL=psql bash "$HERE/backup.sh" 2>&1 | grep -c 'never kept unencrypted')" 1 "a backup without the encryption key is refused"
check "$(PRODUCTION_DB_URL="postgresql://postgres.$p:x@db.invalid:1/x" OUT_DIR="$WORK/b" LABEL=x BACKUP_PASSPHRASE=k bash "$HERE/backup.sh" 2>&1 | grep -c 'always gets a restore test')" 1 "a backup without a restore test is refused"

echo; echo "Production procedure rehearsal: $pass passed, $fails failed"
exit $fails
