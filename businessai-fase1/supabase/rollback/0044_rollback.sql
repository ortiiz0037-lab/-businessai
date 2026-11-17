-- Rollback of 0044 (point of sale and register integrations). Refuses, changing
-- nothing, while any POS record exists (sales, shifts, registers, integrations,
-- tax rates, settings): sales history is business data and is never deleted by a
-- rollback. Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.pos_sales) or exists (select 1 from public.pos_shifts) or exists (select 1 from public.pos_registers)
     or exists (select 1 from public.pos_integrations) or exists (select 1 from public.pos_tax_rates) or exists (select 1 from public.pos_settings)
     or exists (select 1 from public.pos_settlements) or exists (select 1 from public.pos_sync_events) or exists (select 1 from public.pos_approval_codes)
     or exists (select 1 from public.journal_entries where source in ('pos_sale', 'pos_sale_void', 'pos_refund', 'pos_settlement', 'pos_cash_difference'))
     or exists (select 1 from public.inventory_movements where source_type in ('pos_sale', 'pos_refund', 'pos_void'))
     or exists (select 1 from public.ledger_accounts where system_key in ('pos_clearing', 'processor_fees', 'cash_over_short')) then
    raise exception 'BA0044 rollback: point-of-sale data exists; nothing was changed.';
  end if;
end $$;
drop function if exists ba_private.pos_ingest_record(public.pos_integrations, jsonb, bigint, text);
drop function if exists ba_private.pos_ingest_one(public.pos_integrations, jsonb);
drop function if exists ba_private.pos_void_apply(public.pos_sales, text, uuid);
drop function if exists ba_private.pos_post_inventory(public.pos_sales, boolean);
drop function if exists ba_private.pos_post_sale(public.pos_sales);
drop function if exists ba_private.pos_refund_apply(public.pos_sales, jsonb, text, text, boolean, text, uuid, uuid, text, timestamptz, text);
drop table if exists public.pos_events;
drop table if exists public.pos_sync_runs;
drop table if exists public.pos_sync_events;
drop table if exists public.pos_approval_codes;
drop table if exists public.pos_cash_movements;
drop table if exists public.pos_refund_lines;
drop table if exists public.pos_refunds;
drop table if exists public.pos_payment_events;
drop table if exists public.pos_payments;
drop table if exists public.pos_settlements;
drop table if exists public.pos_sale_lines;
drop table if exists public.pos_sales;
drop table if exists public.pos_shifts;
drop table if exists public.pos_counters;
drop table if exists public.pos_register_users;
drop table if exists public.pos_registers;
drop table if exists public.pos_item_maps;
drop table if exists public.pos_location_maps;
drop table if exists public.pos_integrations;
drop table if exists public.pos_item_taxes;
drop table if exists public.pos_tax_rates;
drop table if exists public.pos_settings;
drop function if exists public.pos_report(uuid, date, date, uuid);
drop function if exists public.pos_settlement_reconcile(uuid, uuid);
drop function if exists public.pos_settlement_record(uuid, text, text, bigint, uuid, text);
drop function if exists public.pos_import_sales(uuid, uuid, text, text, jsonb);
drop function if exists public.pos_sync_retry(bigint);
drop function if exists public.pos_sync_due(text, bigint, uuid, text, integer);
drop function if exists public.pos_ingest_batch(uuid, text, text, bigint, uuid, text);
drop function if exists public.pos_webhook_record(text, text, text, text, bigint, uuid, text);
drop function if exists public.pos_bridge_resolve(text, text, bigint, uuid, text);
drop function if exists public.pos_bridge_token_issue(uuid);
drop function if exists public.pos_item_map(uuid, text, uuid, uuid);
drop function if exists public.pos_location_map(uuid, text, uuid);
drop function if exists public.pos_integration_disconnect(uuid);
drop function if exists public.pos_integration_context(uuid, text, bigint, uuid, text);
drop function if exists public.pos_integration_connect(uuid, text, text, bigint, uuid, text);
drop function if exists public.pos_sale_post_inventory(uuid);
drop function if exists public.pos_refund_create(uuid, jsonb, text, text);
drop function if exists public.pos_sale_void(uuid, text, text);
drop function if exists public.pos_sale_create(uuid, jsonb, text);
drop function if exists public.pos_quote(uuid, jsonb, bigint, numeric);
drop function if exists public.pos_shift_review(uuid, text);
drop function if exists public.pos_shift_close(uuid, bigint, jsonb, text);
drop function if exists public.pos_cash_move(uuid, text, bigint, text, text, text);
drop function if exists ba_private.pos_expected_cash(uuid);
drop function if exists public.pos_shift_open(uuid, bigint, text);
drop function if exists public.pos_approval_issue(uuid, uuid, text, bigint, numeric, integer);
drop function if exists public.pos_register_assign(uuid, uuid, boolean);
drop function if exists public.pos_register_save(uuid, uuid, uuid, text, text, boolean);
drop function if exists public.pos_item_tax_set(uuid, uuid, uuid);
drop function if exists public.pos_tax_rate_save(uuid, uuid, text, text, numeric, boolean, boolean);
drop function if exists public.pos_settings_save(uuid, jsonb);
drop function if exists ba_private.pos_take_approval(uuid, uuid, text, text, bigint, numeric, text);
drop function if exists ba_private.pos_price(uuid, jsonb, bigint, numeric);
drop function if exists ba_private.pos_available(uuid, uuid, uuid, uuid);
drop function if exists ba_private.pos_account(uuid, text);
drop function if exists ba_private.pos_require(uuid, text, uuid);
drop function if exists ba_private.pos_next(uuid, text, text);
drop function if exists ba_private.pos_log(uuid, text, text, text, jsonb);
drop function if exists public.pos_branch_ok(uuid, uuid);
drop function if exists public.pos_retire_server_key(text, timestamptz);
drop function if exists public.pos_set_server_key(text, text);
drop function if exists ba_private.pos_verify(text, text, text, bigint, uuid);
drop function if exists public.pos_refund_guard();
drop function if exists public.pos_guard();
drop table if exists ba_private.pos_bridge_tokens;
drop table if exists ba_private.pos_integration_secrets;
drop table if exists ba_private.pos_nonces;
drop table if exists ba_private.pos_server_keys;
-- the sources of 0043 / 0034 as they were
alter table public.inventory_movements drop constraint if exists inventory_movements_source_type_check;
alter table public.inventory_movements add constraint inventory_movements_source_type_check
  check (source_type is null or source_type in ('purchase_receipt', 'transfer', 'count', 'adjustment', 'document', 'manual', 'correction'));
alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void', 'payment_void',
                    'bank_adjustment', 'bank_reconciliation', 'payroll', 'payroll_void', 'payroll_payment', 'payroll_payment_void'));
delete from public.role_permissions where permission_key in ('pos.view', 'pos.sell', 'pos.approve', 'pos.manage');
delete from public.permissions where key in ('pos.view', 'pos.sell', 'pos.approve', 'pos.manage');
commit;
