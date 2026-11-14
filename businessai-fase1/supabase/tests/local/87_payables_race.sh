#!/usr/bin/env bash
# Concurrency for payables (0024). Sourced by run.sh (psqlq / RUNAS / WORK /
# PORT defined); never touches Supabase.
PB_CO=e6000000-0000-4000-8000-000000000001
PB_OWNER=e5000000-0000-4000-8000-000000000001
PB_ADMIN=e5000000-0000-4000-8000-000000000002
PB_VENDOR=e7000000-0000-4000-8000-000000000001
PB_BILL=e8000000-0000-4000-8000-000000000001
pb_race_setup() { # $1 db: company, vendor and one bill of 100.00 pending approval (submitted by the admin)
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$PB_OWNER', 'owner@pbrace.test'), ('$PB_ADMIN', 'admin@pbrace.test') on conflict do nothing;
    delete from public.companies where id = '$PB_CO';
    insert into public.companies (id, name, created_by) values ('$PB_CO', 'Carrera Pagos', '$PB_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status)
      values ('$PB_CO', 'cus_pbr', 'sub_pbr', 'basic', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$PB_CO', '$PB_OWNER', 'owner'), ('$PB_CO', '$PB_ADMIN', 'admin');
    select public.payables_ensure('$PB_CO');
    insert into public.vendors (id, company_id, name) values ('$PB_VENDOR', '$PB_CO', 'Proveedor Carrera');
    insert into public.bills (id, company_id, vendor_id, bill_date, description) values ('$PB_BILL', '$PB_CO', '$PB_VENDOR', current_date - 1, 'Factura carrera');
    insert into public.bill_lines (company_id, bill_id, line_no, category_id, amount_cents)
      select '$PB_CO', '$PB_BILL', 1, id, 10000 from public.expense_categories where company_id = '$PB_CO' and name = 'Gastos generales';
    update public.bills set status = 'pending_approval', submitted_by = '$PB_ADMIN', submitted_at = now() where id = '$PB_BILL';" >/dev/null
}
pb_session() { # $1 db, $2 user, $3 sql, $4 delay before, $5 hold after
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
# Prints "<ok sessions>|<entries of source $4>|<errors>|<bill status/paid>".
pb_pair() { # $1 db, $2 sql1, $3 sql2, $4 source
  pb_session "$1" "$PB_OWNER" "$2" 0 1.5 >"$WORK/pb1.out" & local p1=$!
  pb_session "$1" "$PB_OWNER" "$3" 0.4 0 >"$WORK/pb2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/pb1.out" "$WORK/pb2.out" | grep -c SESSION_OK)|$(psqlq -d "$1" -tAc "select count(*) from public.journal_entries where company_id = '$PB_CO' and source = '$4'")|$(cat "$WORK/pb1.out" "$WORK/pb2.out" | grep -oE 'BILL_TRANSITION|PAYMENT_EXCEEDS_BALANCE|BILL_NOT_PAYABLE|BILL_HAS_PAYMENTS|BILL_VOIDED' | sort | tr '\n' ',')|$(psqlq -d "$1" -tAc "select status || '/' || paid_cents from public.bills where id = '$PB_BILL'")"
}
pb_cash() { echo "(select id from public.ledger_accounts where company_id = '$PB_CO' and code = '1000')"; }
pb_race_approve() { # the same bill approved twice at once
  pb_race_setup "$1"
  local q="select public.bill_approve('$PB_BILL')"
  pb_pair "$1" "$q" "$q" bill
}
pb_race_pay() { # $2 $3 amounts (cents), $4 $5 keys
  pb_race_setup "$1"
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$PB_OWNER\",\"role\":\"authenticated\"}', false); select public.bill_approve('$PB_BILL')" >/dev/null
  local q1="select public.bill_pay('$PB_BILL', $2, current_date, $(pb_cash), 'cash', null, nullif('${4:-}', ''))"
  local q2="select public.bill_pay('$PB_BILL', $3, current_date, $(pb_cash), 'cash', null, nullif('${5:-}', ''))"
  echo "$(pb_pair "$1" "$q1" "$q2" bill_payment)|$(psqlq -d "$1" -tAc "select payable_cents || '/' || open_bills_cents from public.payables_integrity('$PB_CO')")"
}
pb_race_void_pay() { # voiding the bill while a payment is being recorded
  pb_race_setup "$1"
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$PB_OWNER\",\"role\":\"authenticated\"}', false); select public.bill_approve('$PB_BILL')" >/dev/null
  local qv="select public.bill_void('$PB_BILL', 'Duplicada')"
  local qp="select public.bill_pay('$PB_BILL', 5000, current_date, $(pb_cash))"
  echo "$(pb_pair "$1" "$qv" "$qp" bill_payment)|$(psqlq -d "$1" -tAc "select payable_cents || '/' || open_bills_cents from public.payables_integrity('$PB_CO')")"
}
pb_race_recurring() { # two generations at once → one bill per period
  pb_race_setup "$1"
  psqlq -d "$1" -c "insert into public.recurring_expenses (company_id, vendor_id, category_id, description, amount_cents, frequency, start_date)
      select '$PB_CO', '$PB_VENDOR', id, 'Renta', 50000, 'monthly', (public.ba_today() - interval '5 months')::date
      from public.expense_categories where company_id = '$PB_CO' and name = 'Alquiler'" >/dev/null
  local q="select public.recurring_generate('$PB_CO')"
  pb_pair "$1" "$q" "$q" bill >/dev/null
  echo "$(cat "$WORK/pb1.out" "$WORK/pb2.out" | grep -c SESSION_OK)|$(psqlq -d "$1" -tAc "select count(*) || '/' || count(distinct recurring_period) from public.bills where company_id = '$PB_CO' and recurring_id is not null")"
}
