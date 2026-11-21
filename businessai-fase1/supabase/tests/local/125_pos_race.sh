#!/usr/bin/env bash
# Concurrency for the point of sale (0044). Sourced by run.sh (psqlq / RUNAS / WORK / PORT defined); never touches Supabase.
PS_CO=fd000000-0000-4000-8000-000000000001
PS_OWNER=fc000000-0000-4000-8000-000000000001
PS_ADMIN=fc000000-0000-4000-8000-000000000002
PS_BR=fb000000-0000-4000-8000-000000000001
PS_R1=fa000000-0000-4000-8000-000000000001
PS_R2=fa000000-0000-4000-8000-000000000002
PS_KEY=c2VydmVyLWtleS1mb3ItdGhlLXBvcy1yYWNlLTAxMjM0NTY3ODk=
ps_race_setup() { # $1 db: company, a branch, two registers with a shift each (owner, admin), 10 units of RACE-P, a Square integration
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$PS_OWNER', 'owner@psrace.test'), ('$PS_ADMIN', 'admin@psrace.test') on conflict do nothing;
    delete from public.companies where id = '$PS_CO';
    insert into public.companies (id, name, created_by) values ('$PS_CO', 'Carrera POS', '$PS_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$PS_CO', 'cus_psr', 'sub_psr', 'pro', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$PS_CO', '$PS_OWNER', 'owner'), ('$PS_CO', '$PS_ADMIN', 'admin');
    insert into public.branches (id, company_id, name, code) values ('$PS_BR', '$PS_CO', 'Uno', 'UNO');
    select public.pos_set_server_key('kr', '$PS_KEY');
    select set_config('request.jwt.claims', '{\"sub\":\"$PS_OWNER\",\"role\":\"authenticated\"}', false);
    select public.catalog_save('$PS_CO', null, 'RACE-P', 'Producto', null, 'product', 'unidad', 1000, 0, true, null);
    select public.inventory_adjust('$PS_CO', '$PS_BR', null, 'opening', jsonb_build_array(jsonb_build_object('item', (select id from public.catalog_items where code = 'RACE-P' and company_id = '$PS_CO'), 'qty', '10', 'unit_cost', '100')), 'Inicial', null, null, 'psr-open-0001');
    insert into public.pos_registers (id, company_id, branch_id, code, name) values ('$PS_R1', '$PS_CO', '$PS_BR', 'R1', 'Caja 1'), ('$PS_R2', '$PS_CO', '$PS_BR', 'R2', 'Caja 2');
    select public.pos_shift_open('$PS_R1', 0, 'psr-shift-owner');
    select set_config('request.jwt.claims', '{\"sub\":\"$PS_ADMIN\",\"role\":\"authenticated\"}', false);
    select public.pos_shift_open('$PS_R2', 0, 'psr-shift-admin');
    insert into public.pos_integrations (id, company_id, provider, environment, display_name, external_account_id) values ('f9000000-0000-4000-8000-000000000001', '$PS_CO', 'square', 'test_double', 'Square', 'M-RACE');
    insert into public.pos_location_maps (integration_id, company_id, external_location_id, branch_id) values ('f9000000-0000-4000-8000-000000000001', '$PS_CO', 'L1', '$PS_BR');" >/dev/null
}
ps_session() { # $1 db, $2 user (empty: no user), $3 sql, $4 delay before, $5 hold after
  local claims="{\"sub\":\"$2\",\"role\":\"authenticated\"}"; [ -z "$2" ] && claims='{"role":"anon"}'
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '$claims', true) \\g /dev/null
select pg_sleep($4) \\g /dev/null
$3;
select pg_sleep($5) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
ps_pair() { # $1 db, $2 user1, $3 sql1, $4 user2, $5 sql2 → "<ok sessions>|<errors>"
  ps_session "$1" "$2" "$3" 0 1.5 >"$WORK/ps1.out" & local p1=$!
  ps_session "$1" "$4" "$5" 0.4 0 >"$WORK/ps2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/ps1.out" "$WORK/ps2.out" | grep -c SESSION_OK)|$(cat "$WORK/ps1.out" "$WORK/ps2.out" | grep -oE 'POS_STOCK_UNAVAILABLE|POS_REFUND_EXCEEDS|POS_REFUND_NOT_ALLOWED|POS_SHIFT_ALREADY_OPEN|POS_SERVER_AUTH' | sort | tr '\n' ',')"
}
ps_item() { echo "(select id from public.catalog_items where company_id = '$PS_CO' and code = 'RACE-P')"; }
ps_oh() { psqlq -d "$1" -tAc "select public.inventory_on_hand('$PS_BR', $(ps_item), null)"; }
ps_sale() { # $1 register, $2 shift idem, $3 qty, $4 idem
  echo "select public.pos_sale_create('$PS_CO', jsonb_build_object('branch', '$PS_BR', 'register', '$1', 'shift', (select id from public.pos_shifts where idem_key = '$2'),
    'lines', jsonb_build_array(jsonb_build_object('item', $(ps_item), 'qty', '$3')), 'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', ($3 * 1000)::text))), '$4')"
}
ps_race_sales() { # two cashiers sell 6 of the last 10 at once → one refused, stock 4 (never negative)
  ps_race_setup "$1"
  echo "$(ps_pair "$1" "$PS_OWNER" "$(ps_sale "$PS_R1" psr-shift-owner 6 psr-sale-a001)" "$PS_ADMIN" "$(ps_sale "$PS_R2" psr-shift-admin 6 psr-sale-b001)")|$(ps_oh "$1")"
}
ps_race_same_sale() { # the same sale submitted twice at once (double tap) → one sale, one outflow
  ps_race_setup "$1"
  echo "$(ps_pair "$1" "$PS_OWNER" "$(ps_sale "$PS_R1" psr-shift-owner 3 psr-dup-0001)" "$PS_OWNER" "$(ps_sale "$PS_R1" psr-shift-owner 3 psr-dup-0001)")|$(ps_oh "$1")|$(psqlq -d "$1" -tAc "select count(*) from public.pos_sales where company_id = '$PS_CO'")"
}
ps_race_refund() { # two refunds of the 2 units left of a sale at once → one refused
  ps_race_setup "$1"
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$PS_OWNER\",\"role\":\"authenticated\"}', false); $(ps_sale "$PS_R1" psr-shift-owner 2 psr-sale-r001)" >/dev/null
  local s="(select id from public.pos_sales where idem_key = 'psr-sale-r001')" l="(select id::text from public.pos_sale_lines where sale_id = (select id from public.pos_sales where idem_key = 'psr-sale-r001'))"
  local body="jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line', $l, 'qty', '2')), 'method', 'other', 'reason', 'Devuelto')"
  echo "$(ps_pair "$1" "$PS_OWNER" "select public.pos_refund_create($s, $body, null, 'psr-ref-a001')" "$PS_ADMIN" "select public.pos_refund_create($s, $body, null, 'psr-ref-b001')")|$(ps_oh "$1")|$(psqlq -d "$1" -tAc "select count(*) from public.pos_refunds where company_id = '$PS_CO'")"
}
ps_race_external() { # the same Square order delivered by a webhook and a sync at once → one sale, one outflow
  ps_race_setup "$1"
  local sale="{\"external_id\":\"O-1\",\"version\":\"1\",\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"location_id\":\"L1\",\"lines\":[{\"external_line_id\":\"a\",\"sku\":\"RACE-P\",\"name\":\"P\",\"qty\":\"2\",\"unit_price_cents\":\"1000\"}],\"payments\":[{\"method\":\"card\",\"amount_cents\":\"2000\",\"provider_payment_id\":\"PX-1\"}]}"
  local call
  call() { # $1 trigger
    local p="{\"trigger\":\"$1\",\"status\":\"succeeded\",\"sales\":[$sale]}"
    echo "select public.pos_ingest_batch('f9000000-0000-4000-8000-000000000001', '$p', 'kr', extract(epoch from now())::bigint, n, encode(ba_private.hmac_sha256(decode('$PS_KEY', 'base64'),
      convert_to(concat_ws('|', 'pos_ingest', 'v1', 'kr', 'f9000000-0000-4000-8000-000000000001', extract(epoch from now())::bigint::text, n::text, ba_private.sha_hex('$p')), 'UTF8')), 'hex'))
      from (select gen_random_uuid() n) x"
  }
  echo "$(ps_pair "$1" "" "$(call webhook)" "" "$(call scheduled)")|$(ps_oh "$1")|$(psqlq -d "$1" -tAc "select count(*) from public.pos_sales where company_id = '$PS_CO'")"
}
ps_race_shift() { # two shifts opened on the same register at once → one refused
  ps_race_setup "$1"
  psqlq -d "$1" -c "insert into public.pos_registers (id, company_id, branch_id, code, name) values ('fa000000-0000-4000-8000-000000000003', '$PS_CO', '$PS_BR', 'R3', 'Caja 3');
    update public.pos_shifts set status = 'closed', closed_at = now(), expected_cash_cents = 0, counted_cash_cents = 0, difference_cents = 0 where company_id = '$PS_CO'" >/dev/null
  echo "$(ps_pair "$1" "$PS_OWNER" "select public.pos_shift_open('fa000000-0000-4000-8000-000000000003', 0, 'psr-sh-a001')" "$PS_ADMIN" "select public.pos_shift_open('fa000000-0000-4000-8000-000000000003', 0, 'psr-sh-b001')")|$(psqlq -d "$1" -tAc "select count(*) from public.pos_shifts where status = 'open' and register_id = 'fa000000-0000-4000-8000-000000000003'")"
}
