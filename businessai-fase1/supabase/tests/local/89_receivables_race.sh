#!/usr/bin/env bash
# Concurrency for receivables (0025). Sourced by run.sh (psqlq / RUNAS /
# WORK / PORT defined); never touches Supabase.
AR_CO=ea000000-0000-4000-8000-000000000001
AR_OWNER=e9000000-0000-4000-8000-000000000001
AR_CLIENT=eb000000-0000-4000-8000-000000000001
AR_INV=ec000000-0000-4000-8000-000000000001
AR_PAY=ed000000-0000-4000-8000-000000000001
ar_race_setup() { # $1 db: invoice of 100.00 due 10 days ago; $2 = paid (one payment of 100) | open
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$AR_OWNER', 'owner@arrace.test') on conflict do nothing;
    delete from public.companies where id = '$AR_CO';
    insert into public.companies (id, name, created_by) values ('$AR_CO', 'Carrera Cobros', '$AR_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$AR_CO', 'cus_arr', 'sub_arr', 'basic', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$AR_CO', '$AR_OWNER', 'owner');
    insert into public.clients (id, company_id, name, email) values ('$AR_CLIENT', '$AR_CO', 'Cliente Carrera', 'c@arrace.test');
    insert into public.documents (id, company_id, client_id, document_type, document_number, status, issue_date, due_date, subtotal, total)
      values ('$AR_INV', '$AR_CO', '$AR_CLIENT', 'invoice', 'FAC-AR-1', 'sent', public.ba_today() - 20, public.ba_today() - 10, 100, 100);" >/dev/null
  if [ "$2" = paid ]; then
    psqlq -d "$1" -c "insert into public.payments (id, company_id, document_id, amount, created_by) values ('$AR_PAY', '$AR_CO', '$AR_INV', 100, '$AR_OWNER')" >/dev/null
  fi
}
ar_session() { # $1 db, $2 sql, $3 delay before, $4 hold after
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$AR_OWNER","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select pg_sleep($3) \\g /dev/null
$2;
select pg_sleep($4) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
# "<ok sessions>|<errors>|<invoice status>|<active payments>/<voided>|<receivable = open balance>"
ar_pair() { # $1 db, $2 sql1, $3 sql2
  ar_session "$1" "$2" 0 1.5 >"$WORK/ar1.out" & local p1=$!
  ar_session "$1" "$3" 0.4 0 >"$WORK/ar2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/ar1.out" "$WORK/ar2.out" | grep -c SESSION_OK)|$(cat "$WORK/ar1.out" "$WORK/ar2.out" | grep -oE 'PAYMENT_ALREADY_VOIDED|PAYMENT_EXCEEDS_BALANCE|PAYMENT_NOT_ALLOWED' | sort | tr '\n' ',')|$(psqlq -d "$1" -tAc "select status from public.documents where id = '$AR_INV'")|$(psqlq -d "$1" -tAc "select count(*) filter (where voided_at is null) || '/' || count(*) filter (where voided_at is not null) from public.payments where document_id = '$AR_INV'")|$(psqlq -d "$1" -tAc "select receivable_cents || '=' || open_invoices_cents from public.ledger_integrity('$AR_CO')")"
}
ar_race_double_void() { # the same payment voided twice at once
  ar_race_setup "$1" paid
  local q="select public.payment_void('$AR_PAY', 'Cheque devuelto')"
  echo "$(ar_pair "$1" "$q" "$q")|$(psqlq -d "$1" -tAc "select count(*) from public.journal_entries where company_id = '$AR_CO' and source = 'payment_void'")"
}
ar_race_void_pay() { # voiding the payment while a new payment arrives
  ar_race_setup "$1" paid
  ar_pair "$1" "select public.payment_void('$AR_PAY', 'Cheque devuelto')" \
    "insert into public.payments (company_id, document_id, amount, created_by) values ('$AR_CO', '$AR_INV', 100, '$AR_OWNER')"
}
ar_race_overpay() { # two payments of 60 on an open balance of 100
  ar_race_setup "$1" open
  local q="insert into public.payments (company_id, document_id, amount, created_by) values ('$AR_CO', '$AR_INV', 60, '$AR_OWNER')"
  ar_pair "$1" "$q" "$q"
}
ar_race_promise() { # a promise of 100 and two payments of 50 at once → kept once
  ar_race_setup "$1" open
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$AR_OWNER\",\"role\":\"authenticated\"}', false);
    select public.ar_add_promise('$AR_INV', public.ba_today() + 3, 10000)" >/dev/null
  local q="insert into public.payments (company_id, document_id, amount, created_by) values ('$AR_CO', '$AR_INV', 50, '$AR_OWNER')"
  echo "$(ar_pair "$1" "$q" "$q")|$(psqlq -d "$1" -tAc "select status from public.payment_promises where document_id = '$AR_INV'")/$(psqlq -d "$1" -tAc "select count(*) from public.receivables_events where document_id = '$AR_INV' and action = 'promise_kept'")"
}
ar_race_refresh() { # two reminder refreshes at once → one reminder
  ar_race_setup "$1" open
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$AR_OWNER\",\"role\":\"authenticated\"}', false);
    select public.ar_save_settings('$AR_CO', true, '{10}', 'es', null, null, null, null)" >/dev/null
  local q="select public.ar_refresh('$AR_CO')"
  ar_pair "$1" "$q" "$q" >/dev/null
  echo "$(cat "$WORK/ar1.out" "$WORK/ar2.out" | grep -c SESSION_OK)|$(psqlq -d "$1" -tAc "select count(*) from public.collection_reminders where document_id = '$AR_INV'")"
}
