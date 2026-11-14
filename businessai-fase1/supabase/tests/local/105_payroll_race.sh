#!/usr/bin/env bash
# Concurrency for 0034 (payroll). Sourced by run.sh after 81_workforce_race.sh
# (psqlq / RUNAS / WORK / PORT / wf_session defined); never touches Supabase.
PY_OWNER=fd000000-0000-4000-8000-000000000001
PY_ADMIN=fd000000-0000-4000-8000-000000000002
PY_CO=fd100000-0000-4000-8000-000000000001
PY_EMP=fd200000-0000-4000-8000-000000000001
py_setup() { # $1 db: one salaried employee, a prepared weekly run (two weeks ago)
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$PY_OWNER', 'owner@payrace.test'), ('$PY_ADMIN', 'admin@payrace.test') on conflict do nothing;
    delete from public.companies where id = '$PY_CO';
    insert into public.companies (id, name, created_by) values ('$PY_CO', 'Carrera Nómina', '$PY_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$PY_CO', 'cus_pyr', 'sub_pyr', 'pro', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$PY_CO', '$PY_OWNER', 'owner'), ('$PY_CO', '$PY_ADMIN', 'admin');
    insert into public.employees (id, company_id, first_name, last_name) values ('$PY_EMP', '$PY_CO', 'Sal', 'Ario');" >/dev/null
  psqlq -d "$1" -c "
    select set_config('request.jwt.claims', '{\"sub\":\"$PY_OWNER\",\"role\":\"authenticated\"}', false);
    select public.ledger_init('$PY_CO');
    select public.set_compensation('$PY_EMP', date_trunc('week', public.ba_today())::date - 60, 'salary', 'weekly', null, 5200000, null, 'Carrera');" >/dev/null
}
py_run() { # $1 db → a prepared run id (as the owner)
  psqlq -d "$1" -tAc "
    select set_config('request.jwt.claims', '{\"sub\":\"$PY_OWNER\",\"role\":\"authenticated\"}', false);
    select r from public.payroll_create_run('$PY_CO', 'weekly', date_trunc('week', public.ba_today())::date - 14, date_trunc('week', public.ba_today())::date - 8,
                                            date_trunc('week', public.ba_today())::date - 7) r, public.payroll_prepare(r, '[]') p;" | tail -1 | cut -d'|' -f1
}
py_pair() { # $1 db, $2 user1, $3 sql1, $4 user2, $5 sql2
  wf_session "$1" "$2" "$3" 0 1.2 >"$WORK/py1.out" & local p1=$!
  wf_session "$1" "$4" "$5" 0.3 0 >"$WORK/py2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  cat "$WORK/py1.out" "$WORK/py2.out" | grep -c SESSION_OK
}
py_err() { cat "$WORK/py1.out" "$WORK/py2.out" | grep -oE "$1" | head -1; }
# The same run approved twice at once → one approval, one ledger entry.
py_race_approve() {
  py_setup "$1"; local r; r=$(py_run "$1")
  local v; v=$(psqlq -d "$1" -tAc "select version from public.payroll_runs where id = '$r'")
  local q="select public.payroll_approve('$r', $v)"
  echo "$(py_pair "$1" $PY_OWNER "$q" $PY_OWNER "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.journal_entries where source = 'payroll' and source_id = '$r'")|$(py_err 'PAYROLL_ALREADY_APPROVED')"
}
# The payment recorded twice at once → one payment entry.
py_race_pay() {
  py_setup "$1"; local r; r=$(py_run "$1")
  local v; v=$(psqlq -d "$1" -tAc "select version from public.payroll_runs where id = '$r'")
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$PY_OWNER\",\"role\":\"authenticated\"}', false); select public.payroll_approve('$r', $v);" >/dev/null
  local q="select public.payroll_record_payment('$r', public.ba_today(), 'carrera')"
  echo "$(py_pair "$1" $PY_OWNER "$q" $PY_OWNER "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.journal_entries where source = 'payroll_payment' and source_id = '$r'")|$(py_err 'PAYROLL_ALREADY_PAID')"
}
# Two people create the same period at once (different requests) → one run.
py_race_create() {
  py_setup "$1"
  local base="date_trunc('week', public.ba_today())::date"
  local q1="select public.payroll_create_run('$PY_CO', 'weekly', $base - 21, $base - 15, $base - 14, 'race-key-a')"
  local q2="select public.payroll_create_run('$PY_CO', 'weekly', $base - 21, $base - 15, $base - 14, 'race-key-b')"
  echo "$(py_pair "$1" $PY_OWNER "$q1" $PY_ADMIN "$q2")|$(psqlq -d "$1" -tAc "select count(*) from public.payroll_runs where company_id = '$PY_CO' and status = 'draft'")|$(py_err 'PAYROLL_PERIOD_EXISTS')"
}
# A re-preparation and an approval at once → the approval only succeeds on the version it saw (never a mix).
py_race_prepare_approve() {
  py_setup "$1"; local r; r=$(py_run "$1")
  local v; v=$(psqlq -d "$1" -tAc "select version from public.payroll_runs where id = '$r'")
  echo "$(py_pair "$1" $PY_ADMIN "select public.payroll_prepare('$r', '[]')" $PY_OWNER "select public.payroll_approve('$r', $v)")|$(psqlq -d "$1" -tAc "select status from public.payroll_runs where id = '$r'")|$(py_err 'PAYROLL_PREVIEW_STALE')"
}
