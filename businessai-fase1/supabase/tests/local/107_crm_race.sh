#!/usr/bin/env bash
# Concurrency for 0035 (CRM). Sourced by run.sh after 81_workforce_race.sh
# (psqlq / RUNAS / WORK / PORT / wf_session defined); never touches Supabase.
CR_OWNER=fe000000-0000-4000-8000-000000000001
CR_MEMBER=fe000000-0000-4000-8000-000000000002
CR_CO=fe100000-0000-4000-8000-000000000001
CR_CLIENT=fe200000-0000-4000-8000-000000000001
cr_as() { echo "select set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', false);"; }
cr_setup() { # $1 db: a company, a client, the pipeline, an accepted quote
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$CR_OWNER', 'owner@crmrace.test'), ('$CR_MEMBER', 'member@crmrace.test') on conflict do nothing;
    delete from public.companies where id = '$CR_CO';
    insert into public.companies (id, name, created_by) values ('$CR_CO', 'Carrera CRM', '$CR_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$CR_CO', 'cus_crr', 'sub_crr', 'pro', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$CR_CO', '$CR_OWNER', 'owner'), ('$CR_CO', '$CR_MEMBER', 'member');
    insert into public.clients (id, company_id, name) values ('$CR_CLIENT', '$CR_CO', 'Cliente Carrera');" >/dev/null
  psqlq -d "$1" -c "$(cr_as $CR_OWNER)
    select public.ledger_init('$CR_CO'); select public.crm_ensure_setup('$CR_CO');" >/dev/null
}
cr_quote() { # $1 db → an accepted quote id
  psqlq -d "$1" -tAc "$(cr_as $CR_OWNER)
    with q as (insert into public.documents (company_id, client_id, created_by, document_type, document_number, title, subtotal, total)
               values ('$CR_CO', '$CR_CLIENT', '$CR_OWNER', 'quote', 'x', 'Carrera', 500, 500) returning id)
    select id from q;" | tail -1 > "$WORK/cr_q.txt"
  local q; q=$(cat "$WORK/cr_q.txt")
  psqlq -d "$1" -c "$(cr_as $CR_OWNER) update public.documents set status = 'sent' where id = '$q'; update public.documents set status = 'accepted' where id = '$q';" >/dev/null
  echo "$q"
}
cr_pair() { # $1 db, $2 user1, $3 sql1, $4 user2, $5 sql2
  wf_session "$1" "$2" "$3" 0 1.2 >"$WORK/cr1.out" & local p1=$!
  wf_session "$1" "$4" "$5" 0.3 0 >"$WORK/cr2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  cat "$WORK/cr1.out" "$WORK/cr2.out" | grep -c SESSION_OK
}
cr_err() { cat "$WORK/cr1.out" "$WORK/cr2.out" | grep -oE "$1" | head -1; }
# The same accepted quote converted twice at once (two different requests) → one invoice.
cr_race_convert() {
  cr_setup "$1"; local q; q=$(cr_quote "$1")
  local q1="select public.crm_convert_quote('$q', null, public.ba_today() + 30, gen_random_uuid())"
  echo "$(cr_pair "$1" $CR_OWNER "$q1" $CR_MEMBER "$q1")|$(psqlq -d "$1" -tAc "select count(*) from public.documents where company_id = '$CR_CO' and document_type = 'invoice'")|$(cr_err 'CRM_QUOTE_ALREADY_CONVERTED')"
}
# The same form submitted twice at once (same idempotency key) → one opportunity, both answered.
cr_race_create() {
  cr_setup "$1"
  local q="select public.crm_save_opportunity('$CR_CO', null, '$CR_CLIENT', null, 'Carrera', null, 1000, null, null, null, null, null, null, null, 'fe300000-0000-4000-8000-000000000001')"
  echo "$(cr_pair "$1" $CR_MEMBER "$q" $CR_MEMBER "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.crm_opportunities where company_id = '$CR_CO'")"
}
# Two people move the same opportunity from the same version → one move, the other is stale.
cr_race_move() {
  cr_setup "$1"
  local o; o=$(psqlq -d "$1" -tAc "$(cr_as $CR_OWNER) select public.crm_save_opportunity('$CR_CO', null, '$CR_CLIENT', null, 'Mover', null, 1000, null, null, '$CR_MEMBER', null, null, null, null, gen_random_uuid())" | tail -1)
  local s1="select public.crm_move_opportunity('$o', (select id from public.crm_pipeline_stages where company_id = '$CR_CO' and key = 'won'), 1)"
  local s2="select public.crm_move_opportunity('$o', (select id from public.crm_pipeline_stages where company_id = '$CR_CO' and key = 'lost'), 1, 'Precio')"
  echo "$(cr_pair "$1" $CR_OWNER "$s1" $CR_MEMBER "$s2")|$(psqlq -d "$1" -tAc "select status || ':' || version from public.crm_opportunities where id = '$o'")|$(cr_err 'CRM_STALE')"
}
# The same activity submitted twice at once → one activity.
cr_race_activity() {
  cr_setup "$1"
  local q="select public.crm_save_activity('$CR_CO', null, 'task', 'Llamar', null, null, '$CR_CLIENT', null, null, now() + interval '1 day', null, null, 'fe300000-0000-4000-8000-000000000002')"
  echo "$(cr_pair "$1" $CR_MEMBER "$q" $CR_MEMBER "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.crm_activities where company_id = '$CR_CO'")"
}
