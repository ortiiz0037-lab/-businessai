#!/usr/bin/env bash
# =====================================================================
# Verified, encrypted logical backup of the PRODUCTION database (pinned project rugqcumiuqrjbfwpuslm).
# READ-ONLY on Production: every session it opens there is read-only (default_transaction_read_only=on);
# pg_dump takes ACCESS SHARE locks only. Nothing is written to Production.
#
# A backup only counts when ALL of this passes (any failure stops the caller before any migration):
#   1. Guards: strict Production URL (lib.sh), no Staging bookkeeping in the database.
#   2. Live facts: server version; exact row count of every table of the dumped schemas; a CONTENT checksum
#      (md5 of every row, in a fixed order) of each table that exists in Production today; the migration
#      state (supabase/inspect/inspect_migration_state.sql). The Storage policies and the definer function
#      code that the rollbacks of 0007 / 0008 need are saved too.
#   3. pg_dump -Fc of public, auth, storage (+ ba_meta / ba_private once they exist).
#   4. Integrity: pg_restore --list readable, one TABLE DATA entry per live table, sha256.
#   5. RESTORE TEST (mandatory): restore into a throw-away database of a LOCAL scratch server; every table must
#      have the same row count AND every checksummed table the same content checksum as live Production.
#   6. ENCRYPTION (mandatory): one bundle (dump + counts + checksums + state + policies + functions),
#      AES-256-CBC, PBKDF2 600 000 iterations; decrypted again and its sha256 compared. Plaintext is deleted.
# This repository is PUBLIC: the log prints PASS/FAIL, table counts and checksums of FILES only — never row
# counts, data, user names or the URL. Counts and checksums of data live inside the encrypted bundle.
#
# Usage: PRODUCTION_DB_URL=… BACKUP_PASSPHRASE=… OUT_DIR=dir LABEL=before-0005_security_baseline \
#        RESTORE_PSQL="psql -h /sock -p 5432 -U postgres" [RESTORE_HOST=/sock] [PG_BIN=…] \
#        bash scripts/production/backup.sh
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/lib.sh"
strict_production_url "${PRODUCTION_DB_URL:-}" || exit 1
: "${OUT_DIR:?OUT_DIR is required}"; : "${LABEL:?LABEL is required}"
[[ "$LABEL" =~ ^[a-z0-9_.-]+$ ]] || { echo "ERROR: LABEL has unexpected characters"; exit 1; }
[[ -n "${BACKUP_PASSPHRASE:-}" ]] || { echo "ERROR: PRODUCTION_BACKUP_PASSPHRASE is required: a Production backup is never kept unencrypted"; exit 1; }
[[ -n "${RESTORE_PSQL:-}" ]] || { echo "ERROR: RESTORE_PSQL is required: a Production backup always gets a restore test"; exit 1; }
case "$RESTORE_PSQL" in *supabase*|*amazonaws*|*pooler*) echo "ERROR: the restore target must be a local scratch server"; exit 1;; esac
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_dump)")}
ROOT=$(cd "$here/../.." && pwd)
mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"; work="$OUT_DIR/$LABEL"; mkdir -p "$work"; chmod 700 "$work"
ro() { PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/psql" "$PRODUCTION_DB_URL" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
fail=0
ok() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; else fail=1; echo "FAIL: $3"; fi; }
stop() { echo "STOPPED: $*"; rm -rf "$work"; exit 1; }

echo "== 1. Guards (read-only)"
marker="$(ro -c "select (to_regclass('ba_meta.environment') is not null)::int")" || stop "cannot connect (read-only) to the Production database"
[[ "$marker" == 0 ]] || stop "Staging bookkeeping (ba_meta.environment) found: this is not the Production database. Nothing was dumped."
echo "PASS: pinned Production project, no Staging marker"

echo "== 2. Live facts (read-only)"
server_major="$(ro -c "show server_version_num" | cut -c1-2)"; client_major="$("$PG_BIN/pg_dump" --version | grep -oE '[0-9]+' | head -1)"
echo "server major: $server_major · pg_dump major: $client_major"
(( client_major >= server_major )) || stop "pg_dump $client_major is older than the server ($server_major)"
SCHEMAS=(public auth storage)
for s in ba_meta ba_private; do [[ "$(ro -c "select count(*) from pg_namespace where nspname = '$s'")" == 1 ]] && SCHEMAS+=("$s"); done
in_list=$(printf "'%s'," "${SCHEMAS[@]}"); in_list=${in_list%,}
count_sql="$(ro -c "select string_agg(format('select %L || chr(9) || count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname), ' union all ' order by n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname in ($in_list)")"
ro -c "$count_sql" | sort > "$work/counts.tsv" || stop "cannot count rows"
# content checksum of the tables that exist in Production today (0001–0004) and of the users
SUM_TABLES="public.companies public.memberships public.company_profiles public.company_subscriptions public.clients public.documents public.payments public.document_deletion_audit public.stripe_events auth.users"
sum_sql=""
for t in $SUM_TABLES; do
  [[ "$(ro -c "select to_regclass('$t') is not null")" == t ]] || continue
  sum_sql+="${sum_sql:+ union all }select '$t' || chr(9) || coalesce(md5(string_agg(x::text, chr(10) order by x::text)), 'empty') from $t x"
done
ro -c "$sum_sql" | sort > "$work/checksums.tsv" || stop "cannot checksum the business tables"
ro -f "$ROOT/supabase/inspect/inspect_migration_state.sql" > "$work/migration-state.tsv" || stop "cannot read the migration state"
ro -A -F ',' -P footer=off -f "$ROOT/supabase/inspect/inspect_storage_policies.sql" > "$work/storage-policies.csv" 2>/dev/null || stop "cannot save the Storage policies"
ro -f "$ROOT/supabase/inspect/inspect_definer_functions.sql" > "$work/definer-functions.txt" 2>/dev/null || stop "cannot save the definer functions"
echo "tables: $(wc -l < "$work/counts.tsv") · content-checksummed tables: $(wc -l < "$work/checksums.tsv") · migration state saved"

echo "== 3. Dump"
stamp=$(date -u +%Y%m%dT%H%M%SZ); dump="$work/production-$LABEL-$stamp.dump"
schema_args=(); for s in "${SCHEMAS[@]}"; do schema_args+=(--schema="$s"); done
PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/pg_dump" "$PRODUCTION_DB_URL" -Fc "${schema_args[@]}" -f "$dump" 2> "$work/pg_dump.err"
rc=$?; ok "$rc" 0 "pg_dump exit status"; [[ $rc -eq 0 ]] || { sed 's/postgres[^ ]*@[^ ]*/<url>/g' "$work/pg_dump.err" | head -5; stop "dump failed"; }

echo "== 4. Integrity"
"$PG_BIN/pg_restore" --list "$dump" > "$work/toc.txt" 2>/dev/null; ok "$?" 0 "pg_restore --list reads the archive"
tables_live=$(wc -l < "$work/counts.tsv"); ok "$(grep -c ' TABLE DATA ' "$work/toc.txt")" "$tables_live" "one TABLE DATA entry per live table ($tables_live)"
sha=$(sha256sum "$dump" | cut -d' ' -f1); echo "dump sha256: $sha · size: $(stat -c %s "$dump") bytes"

echo "== 5. Restore test (local scratch server, throw-away database)"
rq() { $RESTORE_PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
rdb=ba_prod_restore_test
rq -d postgres -c "drop database if exists $rdb" -c "create database $rdb" >/dev/null || stop "cannot create the scratch database"
rq -d "$rdb" >/dev/null <<'SQL'
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','authenticator','supabase_admin','supabase_auth_admin','supabase_storage_admin','dashboard_user','pgsodium_keyiduser','supabase_realtime_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop; end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
SQL
restore_cmd=("$PG_BIN/pg_restore" --no-owner --no-acl -d "$rdb")
[[ -n "${RESTORE_HOST:-}" ]] && restore_cmd+=(-h "$RESTORE_HOST" -p "${RESTORE_PORT:-5432}" -U "${RESTORE_USER:-postgres}")
read -r -a runas <<<"${RESTORE_RUNAS:-}"
"${runas[@]}" "${restore_cmd[@]}" < "$dump" 2> "$work/restore.err"
echo "restore messages (objects that depend on Supabase internals, not data): $(grep -c 'ERROR' "$work/restore.err")"
rq -d "$rdb" -tA -c "$count_sql" 2>/dev/null | sort > "$work/counts-restored.tsv"
bad=$(diff "$work/counts.tsv" "$work/counts-restored.tsv" | grep '^[<>]' | cut -f1 | cut -c3- | sort -u)
ok "${bad:-none}" none "every table restored with the same row count ($tables_live tables)"; [[ -z "$bad" ]] || echo "    tables that differ: $(echo $bad)"
rq -d "$rdb" -tA -c "$sum_sql" 2>/dev/null | sort > "$work/checksums-restored.tsv"
bad=$(diff "$work/checksums.tsv" "$work/checksums-restored.tsv" | grep '^[<>]' | cut -f1 | cut -c3- | sort -u)
ok "${bad:-none}" none "business tables and users restored with the same CONTENT checksum ($(wc -l < "$work/checksums.tsv") tables)"; [[ -z "$bad" ]] || echo "    tables that differ: $(echo $bad)"
rq -d postgres -c "drop database if exists $rdb" >/dev/null
[[ $fail -eq 0 ]] || stop "the restore test failed: this backup does NOT count"

echo "== 6. Encrypted bundle (AES-256-CBC, PBKDF2 600 000 iterations)"
bundle="$OUT_DIR/production-$LABEL-$stamp.tar"
printf 'label=%s\ndump=%s\ndump_sha256=%s\ntables=%s\nserver_major=%s\ncreated_utc=%s\n' "$LABEL" "$(basename "$dump")" "$sha" "$tables_live" "$server_major" "$stamp" > "$work/manifest.txt"
tar -C "$work" -cf "$bundle" "$(basename "$dump")" counts.tsv checksums.tsv migration-state.tsv storage-policies.csv definer-functions.txt manifest.txt
bsha=$(sha256sum "$bundle" | cut -d' ' -f1)
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASSPHRASE -in "$bundle" -out "$bundle.enc"; ok "$?" 0 "encrypted"
ok "$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$bundle.enc" | sha256sum | cut -d' ' -f1)" "$bsha" "decrypting gives back the same bundle (sha256)"
echo "encrypted bundle: $(basename "$bundle.enc") · size: $(stat -c %s "$bundle.enc") bytes · sha256: $(sha256sum "$bundle.enc" | cut -d' ' -f1)"
cp "$work/migration-state.tsv" "$OUT_DIR/$LABEL.state.tsv"   # state only (no data): used by the caller
rm -rf "$work" "$bundle"   # only the encrypted bundle is kept
[[ $fail -eq 0 ]] && echo "OK: Production backup '$LABEL' verified by a restore and encrypted" || echo "STOPPED: backup verification failed"
exit $fail
