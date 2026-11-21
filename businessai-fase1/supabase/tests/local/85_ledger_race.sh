#!/usr/bin/env bash
# Concurrency for the general ledger (0023). Sourced by run.sh (psqlq /
# RUNAS / WORK / PORT defined); never touches Supabase.
LG_CO=e2000000-0000-4000-8000-000000000001
LG_OWNER=e1000000-0000-4000-8000-000000000001
LG_INV=e4000000-0000-4000-8000-000000000001
lg_race_setup() { # $1 db: fresh company with an initialised ledger and one draft invoice of 100.00
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$LG_OWNER', 'owner@lgrace.test') on conflict do nothing;
    delete from public.companies where id = '$LG_CO';   -- cascade: the only way a ledger goes
    insert into public.companies (id, name, created_by) values ('$LG_CO', 'Carrera Libros', '$LG_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status)
      values ('$LG_CO', 'cus_lgr', 'sub_lgr', 'pro', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$LG_CO', '$LG_OWNER', 'owner');
    select public.ledger_ensure_chart('$LG_CO');
    insert into public.documents (id, company_id, document_type, document_number, status, issue_date, subtotal, total)
      values ('$LG_INV', '$LG_CO', 'invoice', 'FAC-LG-1', 'draft', current_date - 1, 100, 100);" >/dev/null
}
lg_session() { # $1 db, $2 isolation, $3 sql, $4 delay before, $5 hold after
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin isolation level $2;
select set_config('request.jwt.claims', '{"sub":"$LG_OWNER","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select count(*) from public.journal_entries \\g /dev/null
select pg_sleep($4) \\g /dev/null
$3;
select pg_sleep($5) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
# Two sessions run $2 and $3 at the same time (the first holds 1.5 s).
# Prints "<ok sessions>|<entries of source $5>|<errors>".
lg_pair() { # $1 db, $2 sql1, $3 sql2, $4 isolation, $5 source
  lg_session "$1" "$4" "$2" 0 1.5 >"$WORK/lg1.out" & local p1=$!
  lg_session "$1" "$4" "$3" 0.4 0 >"$WORK/lg2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/lg1.out" "$WORK/lg2.out" | grep -c SESSION_OK)|$(psqlq -d "$1" -tAc "select count(*) from public.journal_entries where company_id = '$LG_CO' and source = '$5'")|$(cat "$WORK/lg1.out" "$WORK/lg2.out" | grep -oE 'could not serialize[a-z ]*|ENTRY_ALREADY_REVERSED|PERIOD_CLOSED|PAYMENT_EXCEEDS_BALANCE|payments_idempotency_uidx' | sort | tr '\n' ',')"
}
lg_lines() { # manual entry lines (cents) between two accounts of the race company
  echo "jsonb_build_array(jsonb_build_object('account', (select id from public.ledger_accounts where company_id = '$LG_CO' and code = '$1'), 'debit', $3),
                          jsonb_build_object('account', (select id from public.ledger_accounts where company_id = '$LG_CO' and code = '$2'), 'credit', $3))"
}
lg_race_issue() { # the same draft issued twice at once → one entry
  lg_race_setup "$1"
  local q="update public.documents set status = 'sent' where id = '$LG_INV'"
  lg_pair "$1" "$q" "$q" 'read committed' invoice
}
lg_race_pay() { # $2 $3 amounts, $4 $5 idempotency keys → payments posted
  lg_race_setup "$1"
  psqlq -d "$1" -c "update public.documents set status = 'sent' where id = '$LG_INV'" >/dev/null
  local q1="insert into public.payments (company_id, document_id, amount, created_by, idempotency_key) values ('$LG_CO', '$LG_INV', $2, '$LG_OWNER', nullif('${4:-}', ''))"
  local q2="insert into public.payments (company_id, document_id, amount, created_by, idempotency_key) values ('$LG_CO', '$LG_INV', $3, '$LG_OWNER', nullif('${5:-}', ''))"
  echo "$(lg_pair "$1" "$q1" "$q2" 'read committed' payment)|$(psqlq -d "$1" -tAc "select receivable_cents || '/' || open_invoices_cents || '/' || unbalanced_entries from public.ledger_integrity('$LG_CO')")"
}
lg_race_manual_idem() { # the same manual entry (same key) submitted twice at once
  lg_race_setup "$1"
  local q="select public.ledger_post_manual('$LG_CO', current_date, 'Compra', null, $(lg_lines 6000 1000 1234), 'race-key-0001')"
  lg_pair "$1" "$q" "$q" 'read committed' manual
}
lg_race_numbers() { # two different manual entries at once → consecutive numbers
  lg_race_setup "$1"
  local q1="select public.ledger_post_manual('$LG_CO', current_date, 'Uno', null, $(lg_lines 6000 1000 100))"
  local q2="select public.ledger_post_manual('$LG_CO', current_date, 'Dos', null, $(lg_lines 6200 1000 200))"
  echo "$(lg_pair "$1" "$q1" "$q2" 'read committed' manual)|$(psqlq -d "$1" -tAc "select string_agg(entry_number::text, ',' order by entry_number) from public.journal_entries where company_id = '$LG_CO'")"
}
lg_race_reverse() { # the same entry reversed twice at once → one reversal
  lg_race_setup "$1"
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$LG_OWNER\",\"role\":\"authenticated\"}', false);
    select public.ledger_post_manual('$LG_CO', current_date, 'Para revertir', null, $(lg_lines 6000 1000 500))" >/dev/null
  local q="select public.ledger_reverse_entry((select id from public.journal_entries where company_id = '$LG_CO' and source = 'manual'), 'Duplicado')"
  lg_pair "$1" "$q" "$q" 'read committed' reversal
}
lg_race_close() { # $2 isolation: closing last month while an entry dated in it is being posted
  lg_race_setup "$1"
  local lm="(date_trunc('month', public.ba_today()) - interval '1 month')::date"
  local qc="select public.ledger_close_period('$LG_CO', $lm)"
  local qp="select public.ledger_post_manual('$LG_CO', $lm + 2, 'Tarde', null, $(lg_lines 6000 1000 700))"
  echo "$(lg_pair "$1" "$qc" "$qp" "$2" manual)|$(psqlq -d "$1" -tAc "select count(*) from public.journal_entries e join public.accounting_periods p on p.company_id = e.company_id and p.period_month = date_trunc('month', e.entry_date) and p.status = 'closed' where e.company_id = '$LG_CO' and e.created_at > p.closed_at")"
}
