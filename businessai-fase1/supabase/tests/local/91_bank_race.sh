#!/usr/bin/env bash
# Concurrency for bank reconciliation (0026). Sourced by run.sh (psqlq /
# RUNAS / WORK / PORT defined); never touches Supabase.
BK_CO=ee000000-0000-4000-8000-000000000001
BK_OWNER=ef000000-0000-4000-8000-000000000001
BK_SHA=1111111111111111111111111111111111111111111111111111111111111111
bk_race_setup() { # $1 db: company, bank account on 1010, two book lines of 100.00 and two statement lines
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$BK_OWNER', 'owner@bkrace.test') on conflict do nothing;
    delete from public.companies where id = '$BK_CO';
    insert into public.companies (id, name, created_by) values ('$BK_CO', 'Carrera Banco', '$BK_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$BK_CO', 'cus_bkr', 'sub_bkr', 'basic', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$BK_CO', '$BK_OWNER', 'owner');
    select set_config('request.jwt.claims', '{\"sub\":\"$BK_OWNER\",\"role\":\"authenticated\"}', false);
    select public.bank_init('$BK_CO');
    select public.bank_save_account('$BK_CO', null, 'Carrera', null, null, (select id from public.ledger_accounts where company_id = '$BK_CO' and code = '1010'));
    select public.ledger_post_manual('$BK_CO', public.ba_today() - 3, 'Depósito uno', 'R1', jsonb_build_array(
      jsonb_build_object('account', (select id from public.ledger_accounts where company_id = '$BK_CO' and code = '1010'), 'debit', 10000),
      jsonb_build_object('account', (select id from public.ledger_accounts where company_id = '$BK_CO' and code = '3000'), 'credit', 10000)));
    select public.ledger_post_manual('$BK_CO', public.ba_today() - 3, 'Depósito dos', 'R2', jsonb_build_array(
      jsonb_build_object('account', (select id from public.ledger_accounts where company_id = '$BK_CO' and code = '1010'), 'debit', 10000),
      jsonb_build_object('account', (select id from public.ledger_accounts where company_id = '$BK_CO' and code = '3000'), 'credit', 10000)));" >/dev/null
}
bk_acct() { echo "(select id from public.bank_accounts where company_id = '$BK_CO')"; }
bk_rows() { echo "jsonb_build_array(jsonb_build_object('date', (public.ba_today() - 3)::text, 'description', 'DEP R1', 'reference', 'R1', 'amount_cents', '10000'),
  jsonb_build_object('date', (public.ba_today() - 3)::text, 'description', 'DEP R2', 'reference', 'R2', 'amount_cents', '10000'))"; }
bk_import_now() { psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$BK_OWNER\",\"role\":\"authenticated\"}', false);
  select * from public.bank_import($(bk_acct), 'r.csv', '$BK_SHA', '{}', $(bk_rows))" >/dev/null; }
bk_session() { # $1 db, $2 sql, $3 delay before, $4 hold after
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$BK_OWNER","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select pg_sleep($3) \\g /dev/null
$2;
select pg_sleep($4) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
bk_pair() { # $1 db, $2 sql1, $3 sql2 → "<ok>|<errors>"
  bk_session "$1" "$2" 0 1.5 >"$WORK/bk1.out" & local p1=$!
  bk_session "$1" "$3" 0.4 0 >"$WORK/bk2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/bk1.out" "$WORK/bk2.out" | grep -c SESSION_OK)|$(cat "$WORK/bk1.out" "$WORK/bk2.out" | grep -oE 'BANK_LINE_NOT_AVAILABLE|JOURNAL_LINE_NOT_AVAILABLE|UNMATCHED_LINES|BANK_LINE_RECONCILED|RECONCILIATION_OVERLAP' | sort | tr '\n' ',')"
}
bk_race_import() { # the same file imported twice at once → one import, 2 lines
  bk_race_setup "$1"
  local q="select * from public.bank_import($(bk_acct), 'r.csv', '$BK_SHA', '{}', $(bk_rows))"
  echo "$(bk_pair "$1" "$q" "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.bank_imports where company_id = '$BK_CO'")/$(psqlq -d "$1" -tAc "select count(*) from public.bank_lines where company_id = '$BK_CO'")"
}
bk_jl() { echo "(select l.id from public.journal_lines l join public.journal_entries e on e.id = l.entry_id where e.company_id = '$BK_CO' and e.reference = '$1' and l.debit_cents > 0)"; }
bk_bl() { echo "(select id from public.bank_lines where company_id = '$BK_CO' and reference = '$1')"; }
bk_race_match() { # one bank line matched to two different book lines at once → one match
  bk_race_setup "$1"; bk_import_now "$1"
  bk_pair "$1" "select public.bank_match(array[$(bk_bl R1)], array[$(bk_jl R1)])" "select public.bank_match(array[$(bk_bl R1)], array[$(bk_jl R2)])" >/dev/null
  echo "$(cat "$WORK/bk1.out" "$WORK/bk2.out" | grep -c SESSION_OK)|$(cat "$WORK/bk1.out" "$WORK/bk2.out" | grep -oE 'BANK_LINE_NOT_AVAILABLE' | head -1)|$(psqlq -d "$1" -tAc "select count(*) from public.bank_match_groups where company_id = '$BK_CO' and voided_at is null")"
}
bk_race_auto() { # two auto-matches at once → two groups total, never duplicated
  bk_race_setup "$1"; bk_import_now "$1"
  local q="select public.bank_auto_match($(bk_acct))"
  bk_pair "$1" "$q" "$q" >/dev/null
  echo "$(cat "$WORK/bk1.out" "$WORK/bk2.out" | grep -c SESSION_OK)|$(psqlq -d "$1" -tAc "select count(*) from public.bank_match_groups where company_id = '$BK_CO' and voided_at is null")/$(psqlq -d "$1" -tAc "select count(*) from public.bank_lines where company_id = '$BK_CO' and status = 'matched'")"
}
bk_race_close_unmatch() { # closing while a match is undone → consistent either way
  bk_race_setup "$1"; bk_import_now "$1"
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$BK_OWNER\",\"role\":\"authenticated\"}', false);
    select public.bank_auto_match($(bk_acct));
    select public.bank_reconciliation_create($(bk_acct), public.ba_today() - 10, public.ba_today() - 1, 0, 20000)" >/dev/null
  local rec="(select id from public.bank_reconciliations where company_id = '$BK_CO')"
  local grp="(select group_id from public.bank_match_items where bank_line_id = $(bk_bl R1) and active)"
  echo "$(bk_pair "$1" "select public.bank_reconciliation_close($rec)" "select public.bank_unmatch($grp, 'Revisión')")|$(psqlq -d "$1" -tAc "select status from public.bank_reconciliations where company_id = '$BK_CO'")/$(psqlq -d "$1" -tAc "select count(*) from public.bank_lines where company_id = '$BK_CO' and status = 'matched'")"
}
bk_race_create() { # two reconciliations of the same period at once → one
  bk_race_setup "$1"
  local q="select public.bank_reconciliation_create($(bk_acct), public.ba_today() - 10, public.ba_today() - 1, 0, 20000)"
  echo "$(bk_pair "$1" "$q" "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.bank_reconciliations where company_id = '$BK_CO'")"
}
