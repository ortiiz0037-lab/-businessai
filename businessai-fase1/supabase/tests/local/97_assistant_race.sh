#!/usr/bin/env bash
# Concurrency for the BusinessAI Assistant (0029). Sourced by run.sh (psqlq /
# RUNAS / WORK / PORT defined); never touches Supabase.
AR_CO=fa000000-0000-4000-8000-000000000001
AR_USER=fb000000-0000-4000-8000-000000000001
ar_as() { # $1 db, $2 expression → its value, evaluated as the user
  psqlq -d "$1" -tAc "select $2 from (select set_config('request.jwt.claims', '{\"sub\":\"$AR_USER\",\"role\":\"authenticated\"}', false)) s"
}
ar_setup() { # $1 db: a company on the basic plan, one conversation with one proposed action → $WORK/ar_act.id
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$AR_USER', 'user@arace.test') on conflict do nothing;
    delete from public.companies where id = '$AR_CO';
    insert into public.companies (id, name, created_by) values ('$AR_CO', 'Carrera Asistente', '$AR_USER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$AR_CO', 'cus_ar', 'sub_ar', 'basic', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$AR_CO', '$AR_USER', 'owner');" >/dev/null
  local conv; conv=$(ar_as "$1" "public.assistant_start_conversation('$AR_CO', 'Carrera', 'es')")
  ar_as "$1" "public.assistant_propose_action('$conv', 'studio_draft', 'Carta', '{\"kind\":\"letter\"}')" > "$WORK/ar_act.id"
}
ar_session() { # $1 db, $2 sql, $3 delay, $4 hold
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$AR_USER","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select pg_sleep($3) \\g /dev/null
$2;
select pg_sleep($4) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
ar_race_confirm() { # the same action confirmed twice at once (double click, two tabs) → one confirmation, the other refused
  ar_setup "$1"; local a; a=$(cat "$WORK/ar_act.id")
  ar_session "$1" "select status from public.assistant_decide_action('$a', 'confirm')" 0 1.5 >"$WORK/ar1.out" & local p1=$!
  ar_session "$1" "select status from public.assistant_decide_action('$a', 'confirm')" 0.4 0 >"$WORK/ar2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/ar1.out" "$WORK/ar2.out" | grep -c SESSION_OK)|$(cat "$WORK/ar1.out" "$WORK/ar2.out" | grep -oE 'ASSISTANT_ALREADY_DECIDED' | sort | tr '\n' ',')|$(psqlq -d "$1" -tAc "select status || '/' || (select count(*) from public.assistant_events where action_id = '$a' and event = 'action_confirmed') from public.assistant_actions where id = '$a'")"
}
ar_race_quota() { # a user with 1 request left sends two at once → exactly one is counted
  ar_setup "$1"
  psqlq -d "$1" -c "insert into public.assistant_usage (company_id, user_id, day, requests) values ('$AR_CO', '$AR_USER', (now() at time zone 'America/Puerto_Rico')::date, 29)" >/dev/null
  ar_session "$1" "select allowed from public.assistant_consume('$AR_CO')" 0 1.5 >"$WORK/ar1.out" & local p1=$!
  ar_session "$1" "select allowed from public.assistant_consume('$AR_CO')" 0.4 0 >"$WORK/ar2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/ar1.out" "$WORK/ar2.out" | grep -cE '^ *t$')/$(cat "$WORK/ar1.out" "$WORK/ar2.out" | grep -cE '^ *f$')/$(psqlq -d "$1" -tAc "select requests from public.assistant_usage where company_id = '$AR_CO'")"
}
