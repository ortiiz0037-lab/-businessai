#!/usr/bin/env bash
# Concurrency for budgets (0027). Sourced by run.sh (psqlq / RUNAS / WORK /
# PORT defined); never touches Supabase.
BG_CO=f6000000-0000-4000-8000-000000000001
BG_OWNER=f7000000-0000-4000-8000-000000000001
bg_as() { # $1 db, $2 expression → its value, evaluated as the owner
  psqlq -d "$1" -tAc "select $2 from (select set_config('request.jwt.claims', '{\"sub\":\"$BG_OWNER\",\"role\":\"authenticated\"}', false)) s"
}
bg_setup() { # $1 db: company with a ledger, one approved budget (v1) and its approved v2 → ids in $WORK/bg_*.id
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$BG_OWNER', 'owner@bgrace.test') on conflict do nothing;
    delete from public.companies where id = '$BG_CO';
    insert into public.companies (id, name, created_by) values ('$BG_CO', 'Carrera Presupuesto', '$BG_OWNER');
    insert into public.memberships (company_id, user_id, role) values ('$BG_CO', '$BG_OWNER', 'owner');
    select set_config('request.jwt.claims', '{\"sub\":\"$BG_OWNER\",\"role\":\"authenticated\"}', false);
    select public.ledger_init('$BG_CO');" >/dev/null
  local v1; v1=$(bg_as "$1" "public.budget_create('$BG_CO', 'Plan', 2030, 'annual')")
  bg_as "$1" "public.budget_set_line('$v1', (select id from public.ledger_accounts where company_id = '$BG_CO' and code = '6000'), null, null, 100000)" >/dev/null
  bg_as "$1" "public.budget_approve('$v1')" >/dev/null
  echo "$v1" > "$WORK/bg_v1.id"
}
bg_session() { # $1 db, $2 sql, $3 delay, $4 hold
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$BG_OWNER","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select pg_sleep($3) \\g /dev/null
$2;
select pg_sleep($4) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
bg_pair() {
  bg_session "$1" "$2" 0 1.5 >"$WORK/bg1.out" & local p1=$!
  bg_session "$1" "$3" 0.4 0 >"$WORK/bg2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/bg1.out" "$WORK/bg2.out" | grep -c SESSION_OK)|$(cat "$WORK/bg1.out" "$WORK/bg2.out" | grep -oE 'BUDGET_DRAFT_EXISTS|BUDGET_TRANSITION|BUDGET_LOCKED|budgets_published_uidx' | sort | tr '\n' ',')"
}
bg_race_version() { # two new versions at once → one draft
  bg_setup "$1"; local v1; v1=$(cat "$WORK/bg_v1.id")
  local q="select public.budget_new_version('$v1')"
  echo "$(bg_pair "$1" "$q" "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.budgets where company_id = '$BG_CO' and status = 'draft'")"
}
bg_race_publish() { # two approved versions of the same year published at once → exactly one published
  bg_setup "$1"; local v1; v1=$(cat "$WORK/bg_v1.id")
  local v2; v2=$(bg_as "$1" "public.budget_new_version('$v1')")
  bg_as "$1" "public.budget_approve('$v2')" >/dev/null
  echo "$(bg_pair "$1" "select public.budget_publish('$v1')" "select public.budget_publish('$v2')")|$(psqlq -d "$1" -tAc "select count(*) from public.budgets where company_id = '$BG_CO' and status = 'published'")"
}
bg_race_edit_approve() { # editing a draft while it is approved → the edit lands before, or is refused
  bg_setup "$1"; local v1; v1=$(cat "$WORK/bg_v1.id")
  local v2; v2=$(bg_as "$1" "public.budget_new_version('$v1')")
  echo "$(bg_pair "$1" "select public.budget_approve('$v2')" "select public.budget_set_line('$v2', (select id from public.ledger_accounts where company_id = '$BG_CO' and code = '6000'), null, null, 999)")|$(psqlq -d "$1" -tAc "select status || '/' || (select amount_cents from public.budget_lines where budget_id = '$v2') from public.budgets where id = '$v2'")"
}
bg_race_lines_approve() { # saving the 12 months of a line while the budget is approved → all months or none, never half
  bg_setup "$1"
  local v; v=$(bg_as "$1" "public.budget_create('$BG_CO', 'Mensual', 2031, 'monthly')")
  local acct="(select id from public.ledger_accounts where company_id = '$BG_CO' and code = '6000')"
  bg_as "$1" "public.budget_set_lines('$v', $acct, null, '{1,1,1,1,1,1,1,1,1,1,1,1}'::bigint[])" >/dev/null
  echo "$(bg_pair "$1" "select public.budget_approve('$v')" "select public.budget_set_lines('$v', $acct, null, '{9,9,9,9,9,9,9,9,9,9,9,9}'::bigint[])")|$(psqlq -d "$1" -tAc "select status || '/' || (select sum(amount_cents) || '/' || count(distinct amount_cents) from public.budget_lines where budget_id = '$v') from public.budgets where id = '$v'")"
}
