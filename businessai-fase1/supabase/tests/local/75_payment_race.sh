#!/usr/bin/env bash
# Concurrent payments against one invoice (0015). Sourced by run.sh with
# psqlq / RUNAS / WORK / PORT / PG_BIN defined; never touches Supabase.
# race <db> <isolation> <amount1> <amount2> [key1] [key2]
#   Two sessions of the same member each pay one invoice of 100 at the same
#   time. The first holds its transaction open for 2 s after inserting.
#   Prints "<ok sessions>|<sum paid>|<status>|<errors>".
race_setup() { # $1 db
  psqlq -d "$1" -c "
    insert into auth.users (id) values ('7a000000-0000-4000-8000-000000000001') on conflict do nothing;
    insert into public.companies (id, name, created_by) values ('7c000000-0000-4000-8000-000000000001', 'Carrera', '7a000000-0000-4000-8000-000000000001') on conflict do nothing;
    insert into public.memberships (company_id, user_id, role) values ('7c000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 'member') on conflict do nothing;
    delete from public.payments where company_id = '7c000000-0000-4000-8000-000000000001';
    delete from public.documents where company_id = '7c000000-0000-4000-8000-000000000001';
    insert into public.documents (id, company_id, document_type, document_number, status, issue_date, total, subtotal)
    values ('7d000000-0000-4000-8000-000000000001', '7c000000-0000-4000-8000-000000000001', 'invoice', 'FAC-RACE-1', 'sent', current_date - 1, 100, 100);" >/dev/null
}
race_session() { # $1 db, $2 isolation, $3 amount, $4 key, $5 hold seconds, $6 delay before insert
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin isolation level $2;
select set_config('request.jwt.claims', '{"sub":"7a000000-0000-4000-8000-000000000001","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select coalesce(sum(amount), 0) from public.payments \\g /dev/null
select pg_sleep($6) \\g /dev/null
insert into public.payments (company_id, document_id, amount, created_by, idempotency_key)
values ('7c000000-0000-4000-8000-000000000001', '7d000000-0000-4000-8000-000000000001', $3,
        '7a000000-0000-4000-8000-000000000001', nullif('$4', ''));
select pg_sleep($5) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
race() {
  race_setup "$1"
  local out1="$WORK/race1.out" out2="$WORK/race2.out"
  race_session "$1" "$2" "$3" "${5:-}" 2 0 >"$out1" &
  local p1=$!
  race_session "$1" "$2" "$4" "${6:-}" 0 0.5 >"$out2" &
  local p2=$!
  wait $p1 || true; wait $p2 || true
  local ok errs
  ok=$(cat "$out1" "$out2" | grep -c SESSION_OK || true)
  errs=$(cat "$out1" "$out2" | grep -oE 'could not serialize[^"]*update|PAYMENT_EXCEEDS_BALANCE|PAYMENT_NOT_ALLOWED|payments_idempotency_uidx' | sort | tr '\n' ',' || true)
  echo "$ok|$(psqlq -d "$1" -tAc "select coalesce(sum(amount),0)::int from public.payments where document_id = '7d000000-0000-4000-8000-000000000001'")|$(psqlq -d "$1" -tAc "select status from public.documents where id = '7d000000-0000-4000-8000-000000000001'")|$errs"
}
