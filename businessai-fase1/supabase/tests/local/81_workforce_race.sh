#!/usr/bin/env bash
# Concurrency for the time clock and the employee limit (0020). Sourced by
# run.sh (psqlq / RUNAS / WORK / PORT defined); never touches Supabase.
wf_race_setup() { # $1 db: company on Basic (3 employees), one linked employee
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('f1000000-0000-4000-8000-000000000001', 'boss@race.test'),
      ('f1000000-0000-4000-8000-000000000002', 'worker@race.test') on conflict do nothing;
    insert into public.companies (id, name, created_by) values ('f2000000-0000-4000-8000-000000000001', 'Carrera WF', 'f1000000-0000-4000-8000-000000000001') on conflict do nothing;
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status)
      values ('f2000000-0000-4000-8000-000000000001', 'cus_wfr', 'sub_wfr', 'basic', 'active') on conflict do nothing;
    insert into public.memberships (company_id, user_id, role) values ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'owner') on conflict do nothing;
    delete from public.workforce_events where company_id = 'f2000000-0000-4000-8000-000000000001';
    delete from public.time_punches where company_id = 'f2000000-0000-4000-8000-000000000001';
    delete from public.employees where company_id = 'f2000000-0000-4000-8000-000000000001';
    insert into public.employees (id, company_id, first_name, last_name, user_id, email)
      values ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Obrero', 'Uno', 'f1000000-0000-4000-8000-000000000002', 'worker@race.test');" >/dev/null
}
wf_session() { # $1 db, $2 user, $3 sql, $4 delay before, $5 hold after
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$2","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select pg_sleep($4) \\g /dev/null
$3;
select pg_sleep($5) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
# Two simultaneous taps on "Entrada" by the same employee → one entry.
wf_race_punch() {
  wf_race_setup "$1"
  local w=f1000000-0000-4000-8000-000000000002 q="select count(*) from public.punch('f3000000-0000-4000-8000-000000000001', 'in')"
  wf_session "$1" $w "$q" 0 1.5 >"$WORK/wf1.out" & local p1=$!
  wf_session "$1" $w "$q" 0.3 0 >"$WORK/wf2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/wf1.out" "$WORK/wf2.out" | grep -c SESSION_OK)|$(psqlq -d "$1" -tAc "select count(*) from public.time_punches where employee_id = 'f3000000-0000-4000-8000-000000000001'")|$(cat "$WORK/wf1.out" "$WORK/wf2.out" | grep -o 'PUNCH_SEQUENCE' | head -1)"
}
# Two managers hire at the same time with 2 of 3 used → only one fits.
wf_race_hire() {
  wf_race_setup "$1"
  psqlq -d "$1" -c "insert into public.employees (company_id, first_name, last_name) values ('f2000000-0000-4000-8000-000000000001', 'Dos', 'X')" >/dev/null
  local b=f1000000-0000-4000-8000-000000000001
  wf_session "$1" $b "insert into public.employees (company_id, first_name, last_name) values ('f2000000-0000-4000-8000-000000000001', 'Tres', 'A')" 0 1.5 >"$WORK/wf3.out" & local p1=$!
  wf_session "$1" $b "insert into public.employees (company_id, first_name, last_name) values ('f2000000-0000-4000-8000-000000000001', 'Tres', 'B')" 0.3 0 >"$WORK/wf4.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/wf3.out" "$WORK/wf4.out" | grep -c SESSION_OK)|$(psqlq -d "$1" -tAc "select count(*) from public.employees where company_id = 'f2000000-0000-4000-8000-000000000001' and status = 'active'")|$(cat "$WORK/wf3.out" "$WORK/wf4.out" | grep -o 'PLAN_LIMIT_EMPLOYEES' | head -1)"
}
