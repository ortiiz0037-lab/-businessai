#!/usr/bin/env bash
# Concurrency for 0033 (rules apply, shifts, patterns, shift changes, leave).
# Sourced by run.sh after 81_workforce_race.sh (psqlq / RUNAS / WORK / PORT /
# wf_session defined); never touches Supabase.
HR_OWNER=f9000000-0000-4000-8000-000000000001
HR_SUP=f9000000-0000-4000-8000-000000000002
HR_EMPU=f9000000-0000-4000-8000-000000000003
HR_CO=f9100000-0000-4000-8000-000000000001
HR_EMP=f9200000-0000-4000-8000-000000000001
hr_race_setup() { # $1 db
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$HR_OWNER', 'owner@hrrace.test'), ('$HR_SUP', 'sup@hrrace.test'), ('$HR_EMPU', 'emp@hrrace.test') on conflict do nothing;
    delete from public.companies where id = '$HR_CO';
    insert into public.companies (id, name, created_by) values ('$HR_CO', 'Carrera HR', '$HR_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$HR_CO', 'cus_hrr', 'sub_hrr', 'pro', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$HR_CO', '$HR_OWNER', 'owner'), ('$HR_CO', '$HR_SUP', 'member');
    insert into public.employees (id, company_id, first_name, last_name, user_id, supervisor_user_id) values ('$HR_EMP', '$HR_CO', 'Rita', 'Carrera', '$HR_EMPU', '$HR_SUP');" >/dev/null
}
hr_pair() { # $1 db, $2 user1, $3 sql1, $4 user2, $5 sql2 → "<sessions ok>"
  wf_session "$1" "$2" "$3" 0 1.2 >"$WORK/hr1.out" & local p1=$!
  wf_session "$1" "$4" "$5" 0.3 0 >"$WORK/hr2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  cat "$WORK/hr1.out" "$WORK/hr2.out" | grep -c SESSION_OK
}
hr_err() { cat "$WORK/hr1.out" "$WORK/hr2.out" | grep -oE "$1" | head -1; }
# The same rule change applied twice at once → applied once, one version.
hr_race_apply() {
  hr_race_setup "$1"
  local c; c=$(psqlq -d "$1" -tAc "select set_config('request.jwt.claims', '{\"sub\":\"$HR_OWNER\",\"role\":\"authenticated\"}', false);
    select public.propose_rule_change('$HR_CO', 'company', '$HR_CO', '{\"grace_minutes\": 9}')" | tail -1)
  local q="select public.apply_rule_change('$c')"
  echo "$(hr_pair "$1" $HR_OWNER "$q" $HR_OWNER "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.labor_rule_versions where change_id = '$c'")|$(hr_err 'RULE_CHANGE_NOT_PENDING')"
}
# Two supervisors schedule overlapping shifts at once → one shift.
hr_race_overlap() {
  hr_race_setup "$1"
  local q1="insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values ('$HR_CO', '$HR_EMP', now() + interval '3 days', now() + interval '3 days 8 hours')"
  local q2="insert into public.work_shifts (company_id, employee_id, starts_at, ends_at) values ('$HR_CO', '$HR_EMP', now() + interval '3 days 2 hours', now() + interval '3 days 6 hours')"
  echo "$(hr_pair "$1" $HR_OWNER "$q1" $HR_SUP "$q2")|$(psqlq -d "$1" -tAc "select count(*) from public.work_shifts where employee_id = '$HR_EMP'")|$(hr_err 'SHIFT_OVERLAP')"
}
# A pattern generated twice at once → each shift exactly once.
hr_race_generate() {
  hr_race_setup "$1"
  psqlq -d "$1" -c "insert into public.shift_patterns (id, company_id, employee_id, weekdays, start_time, end_time, starts_on)
    values ('f9300000-0000-4000-8000-000000000001', '$HR_CO', '$HR_EMP', '{0,1,2,3,4,5,6}', '09:00', '17:00', public.ba_today())" >/dev/null
  local q="select * from public.generate_pattern_shifts('f9300000-0000-4000-8000-000000000001', public.ba_today() + 1, public.ba_today() + 14)"
  echo "$(hr_pair "$1" $HR_OWNER "$q" $HR_SUP "$q")|$(psqlq -d "$1" -tAc "select count(*) || '/' || count(distinct starts_at) from public.work_shifts where employee_id = '$HR_EMP'")"
}
# Approve and reject the same shift change at once → one decision.
hr_race_decide() {
  hr_race_setup "$1"
  psqlq -d "$1" -c "insert into public.work_shifts (id, company_id, employee_id, starts_at, ends_at) values ('f9400000-0000-4000-8000-000000000001', '$HR_CO', '$HR_EMP', now() + interval '5 days', now() + interval '5 days 8 hours')" >/dev/null
  local r; r=$(psqlq -d "$1" -tAc "select set_config('request.jwt.claims', '{\"sub\":\"$HR_EMPU\",\"role\":\"authenticated\"}', false);
    select public.request_shift_change('f9400000-0000-4000-8000-000000000001', 'drop', null, null, null, 'Carrera de prueba')" | tail -1)
  echo "$(hr_pair "$1" $HR_OWNER "select public.decide_shift_change('$r', true)" $HR_SUP "select public.decide_shift_change('$r', false)")|$(psqlq -d "$1" -tAc "select status || '/' || (select count(*) from public.work_shifts where employee_id = '$HR_EMP') from public.shift_change_requests where id = '$r'")|$(hr_err 'SHIFT_CHANGE_NOT_PENDING')"
}
# Two overlapping leave requests at once → one.
hr_race_leave() {
  hr_race_setup "$1"
  local q="select public.request_leave('$HR_EMP', 'vacation', public.ba_today() + 20, public.ba_today() + 22, null, null)"
  echo "$(hr_pair "$1" $HR_EMPU "$q" $HR_SUP "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.leave_requests where employee_id = '$HR_EMP'")|$(hr_err 'LEAVE_OVERLAP')"
}
