#!/usr/bin/env bash
# Local rehearsal of the PHASE-1 procedure exactly as the owner will run it (scripts/production/run-local.sh, which
# calls the real migrate.sh and backup.sh), against a throw-away PostgreSQL that stands in for Production: the
# INSPECTED shape with legacy data (base of scenario 53). Never connects to Supabase.
# The stand-in is reached through a URL that passes the Production guard (user postgres.<ref>, host
# db.<ref>.supabase.co) and whose libpq query parameters (host / port / user) point at the local socket.
# Checks: refusals before anything is written (no confirmation, no key, wrong order, phase 2, changed catalog,
# a backup whose restore test fails); then the 5 phase-1 steps, each with a verified encrypted backup before and
# after, the RUNBOOK §3 catalog values before and after, and existing data unchanged.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
LOCAL="$ROOT/supabase/tests/local"; MIG="$ROOT/supabase/migrations"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "initdb not found; set PG_BIN" >&2; exit 2; }
export PG_BIN
source "$HERE/lib.sh"

pass=0; fails=0
check() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; pass=$((pass+1)); else echo "FAIL: $3 (got '$1', want '$2')"; fails=$((fails+1)); fi; }

WORK="$(mktemp -d)"; RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi
chmod 755 "$WORK"
PORT="${PGTEST_PORT:-54341}"; export SCRATCH_PORT="${SCRATCH_PORT:-54342}"
cleanup() { "${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -p $PORT -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
DB=prod_standin
psqlq() { PGOPTIONS="-c client_min_messages=warning" "${RUNAS[@]}" "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres "$@"; }
ro() { PGOPTIONS="-c default_transaction_read_only=on" "${RUNAS[@]}" "$PG_BIN/psql" -X -q -tA -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d "$DB" "$@"; }
verify_now() { ro -f "$ROOT/supabase/inspect/verify_after_migrations.sql" | tr '|' ','; }
next_now() { ro -f "$ROOT/supabase/inspect/inspect_migration_state.sql" | next_migration; }

echo "== Production stand-in: inspected shape + legacy data"
psqlq -d postgres -c "create database $DB" >/dev/null
for f in "$LOCAL/00_supabase_shim.sql" "$MIG/0001_multitenant_core.sql" "$MIG/0003_company_profile.sql" "$MIG/0004_stripe_subscriptions.sql" "$LOCAL/01_business_fixture.sql" "$LOCAL/53_production_legacy_seed.sql"; do
  psqlq -d "$DB" -f "$f" >/dev/null || { echo "FAIL: cannot build the stand-in ($f)"; exit 1; }
done
p=$PRODUCTION_REF
export PRODUCTION_DB_URL="postgresql://postgres.$p:rehearsal@db.$p.supabase.co:5432/$DB?host=$WORK&port=$PORT&user=postgres"
check "$(strict_production_url "$PRODUCTION_DB_URL" >/dev/null && echo accept)" accept "the stand-in URL passes the Production guard"
check "$("$PG_BIN/psql" "$PRODUCTION_DB_URL" -X -tA -c 'select current_database()')" "$DB" "…and reaches the local stand-in only (libpq host override)"
check "$(next_now)" 0005_security_baseline "stand-in state: next is 0005"
check "$(verify_now)" "$VERIFY_BASELINE" "stand-in catalog = Production baseline of RUNBOOK §3 ($VERIFY_BASELINE)"
snapshot_cols >/dev/null; base_sums="$(checksums)"
declare -A BASE_COLS=(); for k in "${!COLS[@]}"; do BASE_COLS[$k]="${COLS[$k]}"; done

export OUT_DIR="$WORK/backups" BACKUP_PASSPHRASE="rehearsal-passphrase-0123456789"
enc_count() { ls "$OUT_DIR"/*.tar.enc 2>/dev/null | wc -l | tr -d ' '; }
run() { bash "$HERE/run-local.sh" > "$WORK/run.out" 2>&1; echo $?; }

echo "== Refusals: nothing is dumped or applied"
check "$(TARGET=0005_security_baseline MODE=apply run)" 1 "apply without CONFIRM_PRODUCTION is refused"
check "$(grep -c 'needs CONFIRM_PRODUCTION' "$WORK/run.out")" 1 "…with the reason"
check "$(BACKUP_PASSPHRASE=short TARGET=0005_security_baseline MODE=apply CONFIRM_PRODUCTION=$p run)" 1 "apply without a 16+ character backup key is refused"
check "$(TARGET=0007_storage_company_assets MODE=apply CONFIRM_PRODUCTION=$p run)" 1 "a migration that is not the next one is refused (0007 before 0005)"
check "$(grep -c 'not the next migration' "$WORK/run.out")" 1 "…by the plan"
check "$(TARGET=0010_billing MODE=plan run)" 1 "phase 2 is refused by the local wrapper"
check "$(enc_count)" 0 "no backup was taken by a refused run"
check "$(next_now)" 0005_security_baseline "nothing applied by a refused run"

echo "== A catalog that changed since the inspection stops everything"
psqlq -d "$DB" -c "create policy rehearsal_extra on public.clients for select to authenticated using (false)" >/dev/null
check "$(TARGET=0005_security_baseline MODE=apply CONFIRM_PRODUCTION=$p run)" 1 "an extra policy (catalog differs from RUNBOOK §3) stops the run"
check "$(grep -c 'not the expected state before 0005_security_baseline' "$WORK/run.out")" 1 "…before any backup or change"
check "$(enc_count)/$(next_now)" "0/0005_security_baseline" "no backup taken, nothing applied"
psqlq -d "$DB" -c "drop policy rehearsal_extra on public.clients" >/dev/null

echo "== A backup whose restore test fails stops the migration"
# (TRUNCATE revoked so the RUNBOOK §3 catalog row stays the baseline: only the restore test can catch it)
psqlq -d "$DB" -c "create extension citext" -c "create table public.rehearsal_unrestorable (v citext)" -c "insert into public.rehearsal_unrestorable values ('x')" \
  -c "revoke truncate on public.rehearsal_unrestorable from anon, authenticated" >/dev/null
check "$(verify_now)" "$VERIFY_BASELINE" "(the unrestorable table leaves the catalog row at the baseline)"
check "$(TARGET=0005_security_baseline MODE=apply CONFIRM_PRODUCTION=$p run)" 1 "a backup that does not restore identically stops the run"
check "$(grep -c 'restore test failed: this backup does NOT count' "$WORK/run.out")/$(grep -c '0005_security_baseline was NOT applied' "$WORK/run.out")" 1/1 "…and 0005 is NOT applied"
check "$(next_now)" 0005_security_baseline "state unchanged after the failed backup"
check "$(enc_count)" 0 "a backup that failed its restore test is not kept"
psqlq -d "$DB" -c "drop table public.rehearsal_unrestorable" -c "drop extension citext" >/dev/null

echo "== Phase 1: plan, backup before, apply, verify, backup after — one migration at a time"
step=0
for m in $PHASE1; do
  check "$(TARGET=$m MODE=plan run)" 0 "$m: plan passes (it is the next one; catalog = $(verify_before "$m"))"
  n0=$(enc_count)
  check "$(TARGET=$m MODE=apply CONFIRM_PRODUCTION=$p run)" 0 "$m: applied through run-local.sh"
  grep -qE '^(STOPPED|FAIL)' "$WORK/run.out" && sed -n '1,80p' "$WORK/run.out"
  check "$(grep -c "PASS: verify_after_migrations after $m" "$WORK/run.out")" 1 "$m: catalog after = ${VERIFY_AFTER[$m]} (checked by migrate.sh)"
  check "$(verify_now)" "${VERIFY_AFTER[$m]}" "$m: catalog after, read independently"
  check "$(( $(enc_count) - n0 ))" 2 "$m: two new encrypted backups (before and after)"
  check "$(grep -c 'OK: Production backup' "$WORK/run.out")" 2 "$m: both backups passed the restore test and the encryption check"
  step=$((step+1))
done
check "$step" 5 "5 / 5 phase-1 steps"
check "$(next_now)" 0010_billing "after phase 1 the next migration is 0010 (phase 2, not run)"
check "$(TARGET=0010_billing MODE=apply CONFIRM_PRODUCTION=$p run)" 1 "0010 is refused by the phase-1 wrapper"
for k in "${!BASE_COLS[@]}"; do COLS[$k]="${BASE_COLS[$k]}"; done
check "$(checksums)" "$base_sums" "existing data identical to before phase 1 (row counts + content checksums, 8 tables)"

echo "== The backups themselves"
check "$(ls "$OUT_DIR" | grep -vcE '\.tar\.enc$|\.state\.tsv$')" 0 "only encrypted bundles (and the no-data state files) are kept: no plaintext dump"
first=$(ls "$OUT_DIR"/production-before-0005_security_baseline-*.tar.enc | head -1)
mkdir -p "$WORK/open"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$first" | tar -C "$WORK/open" -xf - 2>/dev/null
check "$(ls "$WORK/open" | grep -c '\.dump$')" 1 "the backup before 0005 decrypts with the key and contains the dump"
check "$("$PG_BIN/pg_restore" --list "$WORK/open"/*.dump >/dev/null 2>&1 && echo readable)" readable "…which pg_restore can read"
check "$(grep -c 'migration-state\|checksums\|storage-policies\|definer-functions' <(ls "$WORK/open"))" 4 "…with the state, the checksums and what the 0007 / 0008 rollbacks need"
check "$(BACKUP_PASSPHRASE=wrong-key-wrong-key openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$first" >/dev/null 2>&1 && echo opened || echo refused)" refused "a wrong key cannot open it"

echo; echo "Phase-1 procedure rehearsal: $pass passed, $fails failed"
exit $fails
