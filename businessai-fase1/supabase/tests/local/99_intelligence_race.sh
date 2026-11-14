#!/usr/bin/env bash
# Concurrency for the Intelligence Engine core (0030). Sourced by run.sh
# (psqlq / RUNAS / WORK / PORT defined); never touches Supabase.
IR_CO=fc000000-0000-4000-8000-000000000001
IR_USER=fd000000-0000-4000-8000-000000000001
IR_SECRET=$(printf 'local-race-test-key-0030-local-race-test' | base64 -w0)
ir_mac() { # $1 db, $2 message → hex HMAC with the test key (computed by the database owner)
  psqlq -d "$1" -tAc "select encode(ba_private.hmac_sha256(decode('$IR_SECRET', 'base64'), convert_to(\$m\$$2\$m\$, 'UTF8')), 'hex')"
}
ir_as() { psqlq -d "$1" -tAc "select $2 from (select set_config('request.jwt.claims', '{\"sub\":\"$IR_USER\",\"role\":\"authenticated\"}', false)) s"; }
ir_setup() { # $1 db: a company on the pro plan, the test key, one open turn → $WORK/ir_turn.id
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$IR_USER', 'user@irace.test') on conflict do nothing;
    delete from public.companies where id = '$IR_CO';
    insert into public.companies (id, name, created_by) values ('$IR_CO', 'Carrera Inteligencia', '$IR_USER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$IR_CO', 'cus_ir', 'sub_ir', 'pro', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$IR_CO', '$IR_USER', 'owner');
    select public.assistant_set_server_key('kr', '$IR_SECRET');" >/dev/null
  local n ts m
  n=$(psqlq -d "$1" -tAc "select gen_random_uuid()"); ts=$(date +%s)
  m=$(ir_mac "$1" "begin|v1|kr|$IR_USER|$IR_CO||$n|$ts|$(printf '%s' 'carrera' | sha256sum | cut -d' ' -f1)")
  ir_as "$1" "(public.assistant_begin_turn('$IR_CO', null, 'c', 'es', 'carrera', null, 'kr', '$n', $ts, '$m')).turn_id" > "$WORK/ir_turn.id"
}
ir_session() { # $1 db, $2 sql, $3 delay, $4 hold
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$IR_USER","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select pg_sleep($3) \\g /dev/null
$2;
select pg_sleep($4) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
ir_pair() {
  ir_session "$1" "$2" 0 1.5 >"$WORK/ir1.out" & local p1=$!
  ir_session "$1" "$3" 0.4 0 >"$WORK/ir2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/ir1.out" "$WORK/ir2.out" | grep -c SESSION_OK)|$(cat "$WORK/ir1.out" "$WORK/ir2.out" | grep -oE 'ASSISTANT_[A-Z_]+' | sort | tr '\n' ',')"
}
ir_race_finish() { # the same turn finished twice at once (two server instances) → one message, usage counted once
  ir_setup "$1"; local t p m; t=$(cat "$WORK/ir_turn.id")
  p='{"status":"completed","answer":"ok","usage":{"input":100,"output":10,"calls":1},"cost_nanos":1000,"cost_status":"estimated"}'
  m=$(ir_mac "$1" "finish|v1|kr|$IR_USER|$t|$(printf '%s' "$p" | sha256sum | cut -d' ' -f1)")
  echo "$(ir_pair "$1" "select public.assistant_finish_turn('$t', '$p', 'kr', '$m')" "select public.assistant_finish_turn('$t', '$p', 'kr', '$m')")|$(psqlq -d "$1" -tAc "select (select count(*) from public.assistant_messages where turn_id = '$t' and role = 'assistant') || '/' || (select cost_nanos from public.assistant_usage where company_id = '$IR_CO')")"
}
ir_race_claim() { # a confirmed action taken by two workers at once → one execution
  ir_setup "$1"; local t a ts m
  t=$(cat "$WORK/ir_turn.id")
  a=$(ir_as "$1" "public.assistant_propose('$t', 'studio_draft', 'Carta', '{}')")
  ir_as "$1" "(public.assistant_decide('$a', 'confirm', gen_random_uuid())).status" >/dev/null
  ts=$(date +%s); m=$(ir_mac "$1" "claim|v1|kr|$IR_USER|$a|$ts")
  echo "$(ir_pair "$1" "select attempt from public.assistant_claim_action('$a', 'kr', $ts, '$m')" "select attempt from public.assistant_claim_action('$a', 'kr', $ts, '$m')")|$(psqlq -d "$1" -tAc "select status || '/' || attempts from public.assistant_actions where id = '$a'")"
}
ir_race_quota() { # one request left in the daily quota, two turns started at once → exactly one
  ir_setup "$1"
  psqlq -d "$1" -c "update public.assistant_usage set requests = 99, minute_count = 0 where company_id = '$IR_CO'" >/dev/null
  local n1 n2 ts h m1 m2
  n1=$(psqlq -d "$1" -tAc "select gen_random_uuid()"); n2=$(psqlq -d "$1" -tAc "select gen_random_uuid()"); ts=$(date +%s); h=$(printf '%s' 'hola' | sha256sum | cut -d' ' -f1)
  m1=$(ir_mac "$1" "begin|v1|kr|$IR_USER|$IR_CO||$n1|$ts|$h"); m2=$(ir_mac "$1" "begin|v1|kr|$IR_USER|$IR_CO||$n2|$ts|$h")
  ir_pair "$1" "select allowed from public.assistant_begin_turn('$IR_CO', null, 'c', 'es', 'hola', null, 'kr', '$n1', $ts, '$m1')" \
               "select allowed from public.assistant_begin_turn('$IR_CO', null, 'c', 'es', 'hola', null, 'kr', '$n2', $ts, '$m2')" >/dev/null
  echo "$(cat "$WORK/ir1.out" "$WORK/ir2.out" | grep -cE '^ *t$')/$(cat "$WORK/ir1.out" "$WORK/ir2.out" | grep -cE '^ *f$')/$(psqlq -d "$1" -tAc "select requests from public.assistant_usage where company_id = '$IR_CO'")"
}
