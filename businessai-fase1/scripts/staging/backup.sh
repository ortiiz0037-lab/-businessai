#!/usr/bin/env bash
# =====================================================================
# Logical backup of the STAGING database, verified by a real restore.
# READ-ONLY on Staging: every session it opens there is read-only
# (default_transaction_read_only=on); pg_dump only takes ACCESS SHARE locks.
#
#   1. Guards: strict staging URL (verify-lib.sh: user postgres.<staging ref>,
#      Production ref required and refused), not production-shaped, staging marker.
#   2. Live facts (read-only): server version, ba_meta.applied_migrations count
#      (EXPECT_APPLIED, default 34 = 0001–0036) and exact row counts of every table
#      of the dumped schemas.
#   3. pg_dump -Fc of the schemas public, ba_meta, ba_private, auth and storage
#      (the application data, its records, the users and the storage metadata).
#   4. Integrity: pg_restore --list readable, TABLE DATA entries, size, sha256.
#   5. Restore test (RESTORE_PSQL / RESTORE_HOST given): restore into a throw-away
#      database of a scratch server and compare the row count of EVERY table with
#      the live counts: any difference is a failure.
#   6. Optional encryption (BACKUP_PASSPHRASE set): AES-256-CBC, PBKDF2 600 000
#      iterations; the encrypted file is decrypted again and its sha256 compared.
#      Without a passphrase the plaintext dump is never meant to leave the runner.
# Prints only counts, sizes and checksums: never data, names of users or the URL.
#
# Usage: STAGING_DB_URL=… EXPECT_STAGING_REF=<ref> PRODUCTION_PROJECT_REF=<prod ref> OUT_DIR=dir \
#        [RESTORE_PSQL="psql -h /sock -p 5432 -U postgres"] [PG_BIN=/usr/lib/postgresql/17/bin] \
#        [BACKUP_PASSPHRASE=…] bash scripts/staging/backup.sh
# =====================================================================
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/verify-lib.sh"
strict_staging_url "${STAGING_DB_URL:-}" "${EXPECT_STAGING_REF:-}" "${PRODUCTION_PROJECT_REF:-}" || exit 1
: "${OUT_DIR:?OUT_DIR is required}"
EXPECT_APPLIED=${EXPECT_APPLIED:-34}
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_dump)")}
SCHEMAS=(public ba_meta ba_private auth storage)
mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
ro() { PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/psql" "$STAGING_DB_URL" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
fail=0
ok() { if [[ "$1" == "$2" ]]; then echo "PASS: $3"; else fail=1; echo "FAIL: $3 (got '$1', want '$2')"; fi; }

echo "== 1. Guards (read-only)"
fpx="$(ro -c "select (to_regprocedure('public.can_edit_company_profile(uuid)') is not null)::int + (select count(*) from pg_policies where schemaname = 'public' and policyname in ('payments_update_own_company', 'payments_delete_own_company'))::int")" \
  || { echo "ERROR: cannot connect (read-only) to the staging database"; exit 1; }
[[ "$fpx" == 0 ]] || { echo "ERROR: this database looks like PRODUCTION. Nothing was dumped."; exit 1; }
ok "$(ro -c "select coalesce((select string_agg(name, ',') from ba_meta.environment), '')")" staging "staging marker (ba_meta.environment)"
[[ $fail -eq 0 ]] || { echo "ERROR: not the staging database. Nothing was dumped."; exit 1; }

echo "== 2. Live facts (read-only)"
server_major="$(ro -c "show server_version_num" | cut -c1-2)"
client_major="$("$PG_BIN/pg_dump" --version | grep -oE '[0-9]+' | head -1)"
echo "server major: $server_major · pg_dump major: $client_major"
(( client_major >= server_major )) || { echo "ERROR: pg_dump $client_major is older than the server ($server_major)"; exit 1; }
applied="$(ro -c "select count(*) from ba_meta.applied_migrations")"
ok "$applied" "$EXPECT_APPLIED" "ba_meta.applied_migrations: $EXPECT_APPLIED recorded"
last_recorded="$(ro -c "select name from ba_meta.applied_migrations order by name desc limit 1")"
echo "last recorded: $last_recorded"
in_list=$(printf "'%s'," "${SCHEMAS[@]}"); in_list=${in_list%,}
count_sql="$(ro -c "select string_agg(format('select %L || chr(9) || count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname), ' union all ' order by n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname in ($in_list)")"
ro -c "$count_sql" | sort > "$OUT_DIR/counts-live.tsv" || { echo "ERROR: cannot count rows"; exit 1; }
echo "tables: $(wc -l < "$OUT_DIR/counts-live.tsv") · rows: $(awk -F'\t' '{s+=$2} END {print s+0}' "$OUT_DIR/counts-live.tsv")"
echo "users (auth.users): $(awk -F'\t' '$1=="auth.users"{print $2}' "$OUT_DIR/counts-live.tsv") · companies: $(awk -F'\t' '$1=="public.companies"{print $2}' "$OUT_DIR/counts-live.tsv")"

echo "== 3. Dump"
stamp=$(date -u +%Y%m%dT%H%M%SZ); dump="$OUT_DIR/staging-${last_recorded:0:4}-$stamp.dump"
schema_args=(); for s in "${SCHEMAS[@]}"; do schema_args+=(--schema="$s"); done
PGOPTIONS='-c default_transaction_read_only=on' PGCONNECT_TIMEOUT=15 "$PG_BIN/pg_dump" "$STAGING_DB_URL" -Fc "${schema_args[@]}" -f "$dump" 2> "$OUT_DIR/pg_dump.err"
rc=$?; ok "$rc" 0 "pg_dump exit status"; [[ $rc -eq 0 ]] || { sed 's/postgres[^ ]*@[^ ]*/<url>/g' "$OUT_DIR/pg_dump.err" | head -10; exit 1; }

echo "== 4. Integrity"
"$PG_BIN/pg_restore" --list "$dump" > "$OUT_DIR/toc.txt" 2>/dev/null; ok "$?" 0 "pg_restore --list reads the archive"
tables_live=$(wc -l < "$OUT_DIR/counts-live.tsv"); data_entries=$(grep -c ' TABLE DATA ' "$OUT_DIR/toc.txt")
ok "$data_entries" "$tables_live" "one TABLE DATA entry per live table ($tables_live)"
size=$(stat -c %s "$dump"); sha=$(sha256sum "$dump" | cut -d' ' -f1)
echo "file: $(basename "$dump") · size: $size bytes · sha256: $sha"

if [[ -n "${RESTORE_PSQL:-}" ]]; then
  echo "== 5. Restore test (scratch server, throw-away database)"
  case "$RESTORE_PSQL" in *supabase*|*amazonaws*) echo "ERROR: the restore target must be a local scratch server"; exit 1;; esac
  rq() { $RESTORE_PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
  rdb=ba_backup_restore_test
  rq -d postgres -c "drop database if exists $rdb" -c "create database $rdb" >/dev/null || { echo "ERROR: cannot create the scratch database"; exit 1; }
  # what Supabase provides around the dumped schemas: its roles and the extensions schema
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
  if [[ -n "${RESTORE_HOST:-}" ]]; then restore_cmd+=(-h "$RESTORE_HOST" -p "${RESTORE_PORT:-5432}" -U "${RESTORE_USER:-postgres}"); fi
  read -r -a runas <<<"${RESTORE_RUNAS:-}"
  "${runas[@]}" "${restore_cmd[@]}" < "$dump" 2> "$OUT_DIR/restore.err"
  echo "restore messages (non-fatal objects that depend on Supabase internals): $(grep -c 'ERROR' "$OUT_DIR/restore.err")"
  grep 'ERROR' "$OUT_DIR/restore.err" | sed -E 's/.*ERROR: +//' | sort | uniq -c | sort -rn | head -8 | sed 's/^/    /'
  rcount_sql="${count_sql}"
  rq -d "$rdb" -tA -c "$rcount_sql" 2>/dev/null | sort > "$OUT_DIR/counts-restored.tsv"
  diff_lines=$(diff "$OUT_DIR/counts-live.tsv" "$OUT_DIR/counts-restored.tsv" | grep -c '^[<>]')
  ok "$diff_lines" 0 "every table restored with the same row count as live Staging ($tables_live tables)"
  [[ $diff_lines -eq 0 ]] || diff "$OUT_DIR/counts-live.tsv" "$OUT_DIR/counts-restored.tsv" | head -10 | sed 's/^/    /'
  ok "$(rq -d "$rdb" -tA -c "select count(*) from ba_meta.applied_migrations")" "$EXPECT_APPLIED" "restored record: $EXPECT_APPLIED migrations"
  rq -d postgres -c "drop database if exists $rdb" >/dev/null
fi

if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  echo "== 6. Encryption (AES-256-CBC, PBKDF2 600 000 iterations)"
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASSPHRASE -in "$dump" -out "$dump.enc"; ok "$?" 0 "encrypted"
  ok "$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$dump.enc" | sha256sum | cut -d' ' -f1)" "$sha" "decrypting gives back the same sha256"
  echo "encrypted file: $(basename "$dump.enc") · size: $(stat -c %s "$dump.enc") bytes · sha256: $(sha256sum "$dump.enc" | cut -d' ' -f1)"
  rm -f "$dump"   # only the encrypted copy is kept
else
  echo "== 6. No BACKUP_PASSPHRASE: the plaintext dump is NOT kept outside this machine"
fi
printf 'file=%s\nsize=%s\nsha256=%s\napplied=%s\ntables=%s\nserver_major=%s\n' "$(basename "$dump")" "$size" "$sha" "$applied" "$tables_live" "$server_major" > "$OUT_DIR/manifest.txt"
rm -f "$OUT_DIR/pg_dump.err"
[[ $fail -eq 0 ]] && echo "OK: staging backup verified" || echo "STOPPED: backup verification failed"
exit $fail
