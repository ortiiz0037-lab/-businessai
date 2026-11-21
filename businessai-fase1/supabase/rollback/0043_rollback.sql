-- Rollback of 0043 (inventory, barcodes, purchasing, replenishment). Refuses,
-- changing nothing, while any inventory record, variant, barcode, purchase order
-- or catalog cost exists: stock history is business data and is never deleted by
-- a rollback. Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.inventory_movements) or exists (select 1 from public.purchase_orders) or exists (select 1 from public.inventory_transfers)
     or exists (select 1 from public.inventory_counts) or exists (select 1 from public.inventory_adjustments) or exists (select 1 from public.inventory_reservations)
     or exists (select 1 from public.catalog_variants) or exists (select 1 from public.catalog_barcodes) or exists (select 1 from public.inventory_item_settings)
     or exists (select 1 from public.inventory_locations) or exists (select 1 from public.inventory_settings) or exists (select 1 from public.inventory_cost_history)
     or exists (select 1 from public.catalog_items where cost_cents is not null) then
    raise exception 'BA0043 rollback: inventory data exists; nothing was changed.';
  end if;
end $$;
drop trigger if exists ba_catalog_items_code_guard on public.catalog_items;
drop function if exists ba_private.inv_apply_adjustment(public.inventory_adjustments);
drop table if exists public.inventory_events;
drop table if exists public.inventory_document_issues;
drop table if exists public.inventory_adjustments;
drop table if exists public.inventory_count_lines;
drop table if exists public.inventory_counts;
drop table if exists public.inventory_transfer_lines;
drop table if exists public.inventory_transfers;
drop table if exists public.inventory_receipt_lines;
drop table if exists public.inventory_receipts;
drop table if exists public.purchase_order_bills;
drop table if exists public.purchase_order_lines;
drop table if exists public.purchase_orders;
drop table if exists public.inventory_counters;
drop table if exists public.inventory_reservations;
drop table if exists public.inventory_cost_history;
drop table if exists public.inventory_cost_layers;
drop table if exists public.inventory_location_stock;
drop table if exists public.inventory_stock;
drop table if exists public.inventory_movements;
drop table if exists public.inventory_item_settings;
drop table if exists public.inventory_locations;
drop table if exists public.inventory_settings;
drop table if exists public.catalog_barcodes;
drop table if exists public.catalog_variants;
drop function if exists public.inventory_verify(uuid);
drop function if exists public.inventory_replenishment_data(uuid, uuid);
drop function if exists public.inventory_count_step(uuid, text);
drop function if exists public.inventory_count_record(uuid, uuid, uuid, numeric, text);
drop function if exists public.inventory_count_start(uuid, uuid, uuid, text, text);
drop function if exists public.inventory_transfer_step(uuid, text, jsonb, text);
drop function if exists public.inventory_transfer_request(uuid, uuid, uuid, jsonb, text, text);
drop function if exists public.purchase_orders_from_suggestions(uuid, jsonb);
drop function if exists public.purchase_order_link_bill(uuid, uuid);
drop function if exists public.purchase_order_receive(uuid, jsonb, text, text);
drop function if exists public.purchase_order_transition(uuid, text, text);
drop function if exists public.purchase_order_save(uuid, uuid, uuid, uuid, date, text, jsonb, integer);
drop function if exists public.inventory_levels(uuid, uuid);
drop function if exists ba_private.inv_levels_base(uuid, uuid);
drop function if exists public.inventory_release(uuid, boolean);
drop function if exists public.inventory_reserve(uuid, uuid, uuid, uuid, numeric, text, text, uuid, text);
drop function if exists public.inventory_revalue(uuid, uuid, uuid, uuid, numeric, text);
drop function if exists public.inventory_correct(bigint, text);
drop function if exists public.inventory_adjustment_decide(uuid, boolean, text);
drop function if exists public.inventory_adjust(uuid, uuid, uuid, text, jsonb, text, uuid, uuid, text);
drop function if exists public.inventory_issue_document(uuid, uuid, uuid);
drop function if exists public.inventory_move(uuid, uuid, uuid, text, jsonb, text, uuid, text);
drop function if exists public.inventory_item_settings_save(uuid, uuid, uuid, uuid, numeric, numeric, numeric, numeric, uuid, integer);
drop function if exists public.inventory_location_save(uuid, uuid, uuid, text, text, boolean);
drop function if exists public.inventory_settings_save(uuid, boolean, text);
drop function if exists public.inventory_lookup(uuid, text);
drop function if exists public.catalog_barcode_remove(uuid);
drop function if exists public.catalog_barcode_add(uuid, uuid, text, text, boolean);
drop function if exists public.catalog_variant_set_status(uuid, text);
drop function if exists public.catalog_variant_save(uuid, uuid, text, jsonb, bigint, bigint);
drop function if exists public.catalog_set_cost(uuid, uuid, bigint, text);
drop function if exists ba_private.inv_require(uuid, text, uuid);
drop function if exists ba_private.inv_check_item(uuid, uuid, uuid);
drop function if exists ba_private.inv_lines(jsonb);
drop function if exists ba_private.inv_post(uuid, uuid, uuid, uuid, uuid, text, numeric, numeric, text, text, uuid, uuid, bigint, text, timestamptz);
drop function if exists public.inventory_on_hand(uuid, uuid, uuid, uuid);
drop function if exists ba_private.inv_vkey(uuid);
drop function if exists ba_private.inv_next(uuid, text, text);
drop function if exists ba_private.inv_log(uuid, text, text, text, jsonb);
drop function if exists public.catalog_code_conflict(uuid, text, uuid, uuid, uuid);
drop function if exists public.inventory_branch_ok(uuid, uuid);
drop function if exists public.ba_barcode_valid(text, text);
drop function if exists public.ba_upce_valid(text);
drop function if exists public.ba_gtin_valid(text);
drop function if exists public.inventory_guard();
drop function if exists public.catalog_items_code_guard();
alter table public.catalog_items drop constraint if exists catalog_items_cost_check;
alter table public.catalog_items drop column if exists cost_cents;
delete from public.role_permissions where permission_key in ('inventory.view', 'inventory.operate', 'inventory.approve');
delete from public.permissions where key in ('inventory.view', 'inventory.operate', 'inventory.approve');
commit;
