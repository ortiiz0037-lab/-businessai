#!/usr/bin/env bash
# =====================================================================
# ONE phase-1 migration on PRODUCTION (pinned project rugqcumiuqrjbfwpuslm) from the owner's machine,
# without GitHub Actions. Same steps and the same scripts as .github/workflows/production-migrate.yml:
#
#   MODE=plan   READ-ONLY: migrate.sh plan — TARGET must be exactly the next migration and the catalog must be
#               exactly the state RUNBOOK §3 expects before it. Writes nothing, no backup.
#   MODE=apply  1. the same plan (stops on any FAIL);
#               2. a local scratch PostgreSQL (unix socket only) for the restore test;
#               3. backup.sh BEFORE: read-only dump, restore test (same rows + same content checksums), encrypted
#                  bundle decrypted and compared. If ANY check fails, the migration is NOT applied;
#               4. migrate.sh apply: only TARGET, one transaction, then state / data / RUNBOOK §3 checks;
#               5. backup.sh AFTER (same checks).
#               Needs CONFIRM_PRODUCTION=rugqcumiuqrjbfwpuslm and BACKUP_PASSPHRASE.
# Phase 1 only (0005, 0007, 0009, 0006, 0008): phase 2 needs its own approval and stays on the workflow.
#
# Run it on Linux, or in the PostgreSQL 17 container (macOS / Windows), from businessai-fase1/:
#   docker run --rm -it -v "$PWD":/w -w /w postgres:17 bash
#   apt-get update -qq && apt-get install -y -qq openssl >/dev/null      # inside the container
#   read -rs PRODUCTION_DB_URL && export PRODUCTION_DB_URL               # not echoed, not in history
#   read -rs BACKUP_PASSPHRASE && export BACKUP_PASSPHRASE
#   TARGET=0005_security_baseline MODE=plan bash scripts/production/run-local.sh
#   TARGET=0005_security_baseline MODE=apply CONFIRM_PRODUCTION=rugqcumiuqrjbfwpuslm bash scripts/production/run-local.sh
# Env: PRODUCTION_DB_URL, TARGET, MODE, [CONFIRM_PRODUCTION], [BACKUP_PASSPHRASE], [OUT_DIR=./production-backups],
#      [PG_BIN], [SCRATCH_PORT=54329]. Prints no data and no URL; backups are kept only encrypted in OUT_DIR.
# =====================================================================
set -uo pipefail
(( BASH_VERSINFO[0] >= 4 )) || { echo "ERROR: bash 4 or later is required (use the postgres:17 container)"; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
source "$here/lib.sh"
strict_production_url "${PRODUCTION_DB_URL:-}" || exit 1
TARGET="${TARGET:-}"; MODE="${MODE:-plan}"
[[ "$MODE" == plan || "$MODE" == apply ]] || { echo "ERROR: MODE must be plan or apply"; exit 1; }
is_phase1 "$TARGET" || { echo "ERROR: TARGET must be a phase-1 migration ($PHASE1). Nothing was done."; exit 1; }
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_dump 2>/dev/null || echo /nonexistent/pg_dump)")}
for t in psql pg_dump pg_restore; do [[ -x "$PG_BIN/$t" ]] || { echo "ERROR: $t not found in PG_BIN=$PG_BIN"; exit 1; }; done
export PG_BIN

echo "######## $TARGET · $MODE"
echo "## Plan (read-only)"
TARGET="$TARGET" MODE=plan bash "$here/migrate.sh" || { echo "STOPPED: the plan did not pass. Nothing was done."; exit 1; }
[[ "$MODE" == plan ]] && exit 0

# ---- apply: every precondition before anything is dumped or written
[[ "${CONFIRM_PRODUCTION:-}" == "$PRODUCTION_REF" ]] || { echo "ERROR: apply needs CONFIRM_PRODUCTION=$PRODUCTION_REF. Nothing was done."; exit 1; }
pp=${BACKUP_PASSPHRASE:-}; (( ${#pp} >= 16 )) || { echo "ERROR: BACKUP_PASSPHRASE (16+ characters) is required: no migration without an encrypted backup. Nothing was done."; exit 1; }
SRV_BIN=${SRV_BIN:-$( [[ -x "$PG_BIN/initdb" ]] && echo "$PG_BIN" || ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
for t in initdb pg_ctl; do [[ -x "$SRV_BIN/$t" ]] || { echo "ERROR: $t not found (scratch server for the restore test); use the postgres:17 container"; exit 1; }; done
for t in openssl sha256sum tar; do command -v "$t" >/dev/null || { echo "ERROR: $t is required (inside the container: apt-get install -y openssl)"; exit 1; }; done
stat -c %s / >/dev/null 2>&1 || { echo "ERROR: GNU stat is required (Linux or the postgres:17 container)"; exit 1; }
OUT_DIR=${OUT_DIR:-$PWD/production-backups}; mkdir -p "$OUT_DIR" && chmod 700 "$OUT_DIR" || { echo "ERROR: cannot create OUT_DIR"; exit 1; }

echo "## Scratch PostgreSQL for the restore test (local socket only)"
SCR=$(mktemp -d); RUNAS=()
if [[ "$(id -u)" == 0 ]]; then RUNAS=(runuser -u postgres --); chown postgres "$SCR"; fi
chmod 755 "$SCR"; PORT=${SCRATCH_PORT:-54329}
cleanup() { "${RUNAS[@]}" "$SRV_BIN/pg_ctl" -D "$SCR/data" -m immediate stop >/dev/null 2>&1; rm -rf "$SCR"; }
trap cleanup EXIT
"${RUNAS[@]}" "$SRV_BIN/initdb" -D "$SCR/data" -U postgres -A trust >/dev/null &&
  "${RUNAS[@]}" "$SRV_BIN/pg_ctl" -D "$SCR/data" -o "-k $SCR -p $PORT -c listen_addresses=''" -l "$SCR/log" -w start >/dev/null \
  || { echo "STOPPED: the scratch server did not start. Nothing was done."; exit 1; }
echo "PASS: scratch server on a local socket"

backup() {
  local label="$1" before after
  before=$(ls "$OUT_DIR"/production-"$label"-*.tar.enc 2>/dev/null | wc -l)
  LABEL="$label" OUT_DIR="$OUT_DIR" RESTORE_PSQL="$PG_BIN/psql -h $SCR -p $PORT -U postgres" RESTORE_HOST="$SCR" RESTORE_PORT="$PORT" \
    bash "$here/backup.sh" || return 1
  after=$(ls "$OUT_DIR"/production-"$label"-*.tar.enc 2>/dev/null | wc -l)
  (( after == before + 1 )) || { echo "FAIL: no new encrypted bundle for $label"; return 1; }
  echo "PASS: encrypted backup $label kept: $(ls -t "$OUT_DIR"/production-"$label"-*.tar.enc | head -1 | xargs basename)"
}

echo "## Backup BEFORE $TARGET"
backup "before-$TARGET" || { echo "STOPPED: the backup before $TARGET did not pass every check. $TARGET was NOT applied."; exit 1; }

echo "## Apply $TARGET"
TARGET="$TARGET" MODE=apply bash "$here/migrate.sh"; rc=$?
if (( rc != 0 )); then
  echo "STOPPED: $TARGET failed or its verification failed. Do not continue. If it was committed, the rollback is"
  echo "         supabase/rollback/${TARGET%%_*}_rollback.sql (owner decision, supabase/RUNBOOK.md §4 / §10)."
  exit 1
fi

echo "## Backup AFTER $TARGET"
backup "after-$TARGET" || { echo "STOPPED: $TARGET is applied and verified, but the backup after it did not pass. Take it again before the next step."; exit 1; }
echo "OK: $TARGET applied and verified; encrypted backups before and after are in $OUT_DIR (copy them off this machine)."
