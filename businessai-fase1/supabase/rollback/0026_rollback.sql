-- Rollback of 0026 (bank accounts and reconciliation). Emergency use only.
-- Refuses, changing nothing, while any bank account, statement line,
-- reconciliation, bank entry in the ledger or client payment with a deposit
-- account exists. Restores ledger_post_payment (0023) and the 0025 ledger
-- source constraint exactly. A ledger account created for bank fees (6500)
-- is ledger data and stays.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.bank_accounts') is not null then
    if exists (select 1 from public.bank_accounts) or exists (select 1 from public.bank_lines) or exists (select 1 from public.bank_reconciliations)
       or exists (select 1 from public.bank_events) then
      raise exception 'BA0026 rollback: bank accounts or bank records exist; nothing was changed.';
    end if;
  end if;
  if exists (select 1 from public.journal_entries where source in ('bank_adjustment', 'bank_reconciliation')) then
    raise exception 'BA0026 rollback: bank entries exist in the ledger; nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'deposit_account_id') then
    if exists (select 1 from public.payments where deposit_account_id is not null) then
      raise exception 'BA0026 rollback: client payments with a deposit account exist; nothing was changed.';
    end if;
  end if;
end $$;
drop function if exists public.bank_init(uuid);
drop function if exists public.bank_reconciliation_reopen(uuid, text);
drop function if exists public.bank_reconciliation_close(uuid);
drop function if exists public.bank_reconciliation_adjust(uuid, uuid, text);
drop function if exists public.bank_reconciliation_summary(uuid);
drop function if exists public.bank_reconciliation_update(uuid, bigint, bigint, text);
drop function if exists public.bank_reconciliation_create(uuid, date, date, bigint, bigint, text);
drop function if exists public.bank_line_post(uuid, uuid, text);
drop function if exists public.bank_auto_match(uuid);
drop function if exists public.bank_suggestions(uuid);
drop function if exists public.bank_unmatch(uuid, text);
drop function if exists public.bank_match(uuid[], bigint[], text, text, integer);
drop function if exists public.bank_open_journal_lines(uuid, date, date);
drop function if exists public.bank_import_revert(uuid, text);
drop function if exists public.bank_import(uuid, text, text, jsonb, jsonb, boolean);
drop function if exists public.bank_set_account_status(uuid, text);
drop function if exists public.bank_save_account(uuid, uuid, text, text, text, uuid, text);
drop function if exists public.bank_journal_amount(bigint);
drop function if exists public.bank_account_for(uuid, text, boolean);
alter table if exists public.bank_events disable trigger ba_bank_append_only;
drop table if exists public.bank_match_items;
drop table if exists public.bank_match_groups;
drop table if exists public.bank_lines;
drop table if exists public.bank_imports;
drop table if exists public.bank_reconciliations;
drop table if exists public.bank_accounts;
drop table if exists public.bank_events;
drop function if exists public.bank_rec_guard();
drop function if exists public.bank_record_guard();
drop function if exists public.bank_rec_closed(uuid);
drop function if exists public.bank_lock(uuid);
drop function if exists public.bank_log(uuid, uuid, text, text, text, jsonb);
-- 0023 posting of client payments, exactly as it was.
create or replace function public.ledger_post_payment(pay uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  pr record;
  amt bigint;
begin
  select py.id, py.company_id, py.document_id, py.amount, py.reference, py.paid_at, d.document_number, d.client_id
    into pr from public.payments py join public.documents d on d.id = py.document_id where py.id = pay;
  if pr.id is null then return null; end if;
  perform public.ledger_post_invoice(pr.document_id);  -- an invoice from before the ledger: its real issue first
  amt := public.ledger_cents(pr.amount);
  return public.ledger_post(pr.company_id, (pr.paid_at at time zone 'America/Puerto_Rico')::date,
    pr.document_number, coalesce(nullif(btrim(pr.reference), ''), pr.document_number), 'payment', pr.id,
    jsonb_build_array(
      jsonb_build_object('key', 'cash', 'debit', amt, 'client_id', pr.client_id, 'document_id', pr.document_id),
      jsonb_build_object('key', 'accounts_receivable', 'credit', amt, 'client_id', pr.client_id, 'document_id', pr.document_id)));
end $$;

drop trigger if exists ba_payment_deposit_guard on public.payments;
drop function if exists public.payment_deposit_guard();
alter table public.payments drop column if exists deposit_account_id;
delete from public.role_permissions where permission_key like 'bank.%';
delete from public.permissions where key like 'bank.%';
alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void', 'payment_void'));
commit;
