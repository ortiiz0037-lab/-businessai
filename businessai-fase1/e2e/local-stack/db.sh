#!/usr/bin/env bash
# Builds a disposable LOCAL database for the authenticated browser test:
# Supabase shim + every migration in the canonical order + the PostgREST
# login role + test data. Never points at Supabase (only a local socket).
#   PSQL="psql -h /path/to/socket -p 5432 -U postgres" DB=ba_e2e_fin bash e2e/local-stack/db.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); sb="$here/../../supabase"
: "${PSQL:?set PSQL to a psql command for a LOCAL server}"; DB=${DB:-ba_e2e_fin}
case "$PSQL" in *supabase.co*|*pooler.supabase*) echo "refusing: PSQL points at Supabase" >&2; exit 2;; esac
q() { $PSQL -X -q -v ON_ERROR_STOP=1 "$@"; }
q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
q -d "$DB" -f "$sb/tests/local/00_supabase_shim.sql" >/dev/null
order=$(sed -n '/^ORDER=(/,/^)/p' "$here/../../scripts/staging/apply-migrations.sh" | grep -oE '[0-9]{4}[a-z]?_[a-z0-9_]+')
for m in $order; do q -d "$DB" -f "$sb/migrations/$m.sql" >/dev/null || { echo "migration $m failed" >&2; exit 1; }; done
q -d "$DB" -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end \$\$;
  grant anon, authenticated, service_role to authenticator;" >/dev/null
q -d "$DB" -f "$here/seed.sql" >/dev/null
echo "ok: $DB ($(echo $order | wc -w) migrations, seed loaded)"
