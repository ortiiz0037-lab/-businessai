#!/usr/bin/env bash
# Concurrency for inventory (0043). Sourced by run.sh (psqlq / RUNAS / WORK / PORT defined); never touches Supabase.
IV_CO=ed000000-0000-4000-8000-000000000001
IV_OWNER=ec000000-0000-4000-8000-000000000001
IV_BR=eb000000-0000-4000-8000-000000000001
IV_BR2=eb000000-0000-4000-8000-000000000002
iv_race_setup() { # $1 db: company, two branches, two tracked products, 10 units of the first at the first branch
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$IV_OWNER', 'owner@ivrace.test') on conflict do nothing;
    delete from public.companies where id = '$IV_CO';
    insert into public.companies (id, name, created_by) values ('$IV_CO', 'Carrera Inventario', '$IV_OWNER');
    insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('$IV_CO', 'cus_ivr', 'sub_ivr', 'pro', 'active');
    insert into public.memberships (company_id, user_id, role) values ('$IV_CO', '$IV_OWNER', 'owner');
    insert into public.branches (id, company_id, name, code) values ('$IV_BR', '$IV_CO', 'Uno', 'UNO'), ('$IV_BR2', '$IV_CO', 'Dos', 'DOS');
    select set_config('request.jwt.claims', '{\"sub\":\"$IV_OWNER\",\"role\":\"authenticated\"}', false);
    select public.catalog_save('$IV_CO', null, 'RACE-1', 'Producto 1', null, 'product', 'unidad', 100, null, true, null);
    select public.catalog_save('$IV_CO', null, 'RACE-2', 'Producto 2', null, 'product', 'unidad', 100, null, true, null);
    select public.inventory_adjust('$IV_CO', '$IV_BR', null, 'opening', jsonb_build_array(jsonb_build_object('item', (select id from public.catalog_items where code = 'RACE-1' and company_id = '$IV_CO'), 'qty', '10', 'unit_cost', '100')), 'Inicial', null, null, 'race-open-0001');" >/dev/null
}
iv_item() { echo "(select id from public.catalog_items where company_id = '$IV_CO' and code = '$1')"; }
iv_session() { # $1 db, $2 sql, $3 delay before, $4 hold after
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$IV_OWNER","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select pg_sleep($3) \\g /dev/null
$2;
select pg_sleep($4) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
iv_pair() { # $1 db, $2 sql1, $3 sql2 → "<ok sessions>|<errors>"
  iv_session "$1" "$2" 0 1.5 >"$WORK/iv1.out" & local p1=$!
  iv_session "$1" "$3" 0.4 0 >"$WORK/iv2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/iv1.out" "$WORK/iv2.out" | grep -c SESSION_OK)|$(cat "$WORK/iv1.out" "$WORK/iv2.out" | grep -oE 'INVENTORY_INSUFFICIENT|BARCODE_TAKEN|PO_OVER_RECEIPT|TRANSFER_TRANSITION_INVALID|COUNT_NOT_SUBMITTED|INVENTORY_DOCUMENT_ALREADY_ISSUED' | sort | tr '\n' ',')"
}
iv_oh() { psqlq -d "$1" -tAc "select public.inventory_on_hand('$2', $(iv_item "$3"), null)"; }
iv_sale() { echo "select public.inventory_move('$IV_CO', '$IV_BR', null, 'sale', jsonb_build_array(jsonb_build_object('item', $(iv_item RACE-1), 'qty', '$1')), 'Venta', null, '$2')"; }
iv_race_sales() { # two sales of 6 against 10 at once → one refused, stock 4 (never negative)
  iv_race_setup "$1"
  echo "$(iv_pair "$1" "$(iv_sale 6 race-sale-a001)" "$(iv_sale 6 race-sale-b001)")|$(iv_oh "$1" "$IV_BR" RACE-1)"
}
iv_race_same_request() { # the same sale submitted twice at once → applied once
  iv_race_setup "$1"
  echo "$(iv_pair "$1" "$(iv_sale 3 race-dup-0001)" "$(iv_sale 3 race-dup-0001)")|$(iv_oh "$1" "$IV_BR" RACE-1)|$(psqlq -d "$1" -tAc "select count(*) from public.inventory_movements where company_id = '$IV_CO' and kind = 'sale'")"
}
iv_race_barcode() { # the same code given to two products at once → one product owns it
  iv_race_setup "$1"
  echo "$(iv_pair "$1" "select public.catalog_barcode_add($(iv_item RACE-1), null, '4006381333931', 'ean13', true)" "select public.catalog_barcode_add($(iv_item RACE-2), null, '4006381333931', 'ean13', true)")|$(psqlq -d "$1" -tAc "select count(*) from public.catalog_barcodes where company_id = '$IV_CO'")"
}
iv_race_transfer() { # the same transfer dispatched twice at once → stock leaves once
  iv_race_setup "$1"
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$IV_OWNER\",\"role\":\"authenticated\"}', false);
    select public.inventory_transfer_step(public.inventory_transfer_request('$IV_CO', '$IV_BR', '$IV_BR2', jsonb_build_array(jsonb_build_object('item', $(iv_item RACE-1), 'qty', '4')), null, 'race-tr-0001'), 'approve')" >/dev/null
  local t="(select id from public.inventory_transfers where company_id = '$IV_CO')"
  echo "$(iv_pair "$1" "select public.inventory_transfer_step($t, 'dispatch')" "select public.inventory_transfer_step($t, 'dispatch')")|$(iv_oh "$1" "$IV_BR" RACE-1)"
}
iv_race_receive() { # two deliveries of 4 against an order of 5 at once → one refused (never over-received)
  iv_race_setup "$1"
  psqlq -d "$1" -c "select set_config('request.jwt.claims', '{\"sub\":\"$IV_OWNER\",\"role\":\"authenticated\"}', false);
    insert into public.vendors (company_id, name) values ('$IV_CO', 'Proveedor carrera');
    select public.purchase_order_transition(public.purchase_order_save('$IV_CO', null, (select id from public.vendors where company_id = '$IV_CO'), '$IV_BR', null, null,
      jsonb_build_array(jsonb_build_object('item', $(iv_item RACE-2), 'qty', '5', 'unit_cost', '100')), null), 'approve')" >/dev/null
  local po="(select id from public.purchase_orders where company_id = '$IV_CO')" ln="(select l.id from public.purchase_order_lines l join public.purchase_orders p on p.id = l.po_id where p.company_id = '$IV_CO')"
  echo "$(iv_pair "$1" "select public.purchase_order_receive($po, jsonb_build_array(jsonb_build_object('po_line', $ln, 'qty', '4')), null, 'race-rcv-a001')" \
                     "select public.purchase_order_receive($po, jsonb_build_array(jsonb_build_object('po_line', $ln, 'qty', '4')), null, 'race-rcv-b001')")|$(iv_oh "$1" "$IV_BR" RACE-2)"
}
