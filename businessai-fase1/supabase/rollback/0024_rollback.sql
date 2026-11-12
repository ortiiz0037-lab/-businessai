-- Rollback of 0024 (expenses, vendors, bills, payables). Emergency use only.
-- Refuses, changing nothing, while any vendor, bill, vendor payment,
-- attachment or recurring template exists: they are financial records and
-- the ledger holds their entries. A module that was only initialised
-- (settings, limits, default categories) is removed, and the 0023 pieces
-- that 0024 changed are restored exactly (source constraint, line trigger).
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.bills') is not null then
    if exists (select 1 from public.bills) or exists (select 1 from public.vendors) or exists (select 1 from public.recurring_expenses) then
      raise exception 'BA0024 rollback: vendors, bills or recurring expenses exist; nothing was changed.';
    end if;
  end if;
  if exists (select 1 from public.journal_entries where source in ('bill', 'bill_void', 'bill_payment', 'bill_payment_void')) then
    raise exception 'BA0024 rollback: payable entries exist in the ledger; nothing was changed.';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'Finance-attachments') then
    raise exception 'BA0024 rollback: attachment files exist; nothing was changed.';
  end if;
end $$;
drop policy if exists ba_finance_attachments_select on storage.objects;
drop policy if exists ba_finance_attachments_insert on storage.objects;
drop policy if exists ba_finance_attachments_delete on storage.objects;
delete from storage.buckets where id = 'Finance-attachments';
drop function if exists public.payables_integrity(uuid);
drop function if exists public.payables_report(uuid, date, date, text);
drop function if exists public.recurring_generate(uuid);
drop function if exists public.payables_save_settings(uuid, boolean, bigint, boolean, bigint, boolean);
drop function if exists public.bill_void(uuid, text);
drop function if exists public.bill_payment_void(uuid, text);
drop function if exists public.bill_pay(uuid, bigint, date, uuid, text, text, text);
drop function if exists public.bill_schedule(uuid, date);
drop function if exists public.bill_reject(uuid, text);
drop function if exists public.bill_approve(uuid);
drop function if exists public.bill_submit(uuid);
drop function if exists public.bill_save_draft(uuid, uuid, uuid, text, date, date, text, text, jsonb, text);
drop function if exists public.bill_lock(uuid);
drop function if exists public.payables_approval_limit(uuid);
drop function if exists public.payables_role(uuid);
drop function if exists public.finance_object_bill(text);
drop function if exists public.payables_init(uuid);
alter table if exists public.payables_events disable trigger ba_payables_append_only;
drop table if exists public.bill_attachments;
drop table if exists public.bill_payments;
drop table if exists public.bill_lines;
drop table if exists public.bills;
drop table if exists public.recurring_expenses;
drop table if exists public.expense_categories;
drop table if exists public.vendors;
drop table if exists public.approval_limits;
drop table if exists public.payables_settings;
drop table if exists public.payables_events;
drop function if exists public.recurring_next(date, text);
drop function if exists public.bill_row_log();
drop function if exists public.payables_row_log();
drop function if exists public.recurring_guard();
drop function if exists public.bill_attachment_guard();
drop function if exists public.bill_payment_guard();
drop function if exists public.bill_line_total();
drop function if exists public.bill_line_guard();
drop function if exists public.bill_guard();
drop function if exists public.category_guard();
drop function if exists public.vendor_guard();
drop function if exists public.category_active(uuid);
drop function if exists public.category_in_company(uuid, uuid);
drop function if exists public.bill_status(uuid);
drop function if exists public.ledger_base_currency(uuid);
drop function if exists public.payables_company_gone(uuid);
drop function if exists public.payables_ensure(uuid);
drop function if exists public.bill_visible(uuid);
drop function if exists public.payables_log(uuid, text, text, text, jsonb);
delete from public.role_permissions where permission_key like 'payables.%';
delete from public.permissions where key like 'payables.%';
-- 0023 as it was.
alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal'));
create or replace function public.ledger_line_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  e public.journal_entries;
  a public.ledger_accounts;
begin
  select * into e from public.journal_entries where id = new.entry_id;
  if e.id is null or e.company_id <> new.company_id then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'P0001';
  end if;
  if e.posted_txid <> txid_current() then
    raise exception 'LEDGER_IMMUTABLE' using errcode = 'P0001',
      detail = 'Lines are added only when the entry is posted.';
  end if;
  select * into a from public.ledger_accounts where id = new.account_id;
  if a.id is null or a.company_id <> new.company_id then
    raise exception 'ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  if a.status <> 'active' and e.source <> 'reversal' and e.source <> 'invoice_void' then
    raise exception 'ACCOUNT_ARCHIVED' using errcode = 'P0001', hint = a.code;
  end if;
  return new;
end $$;
commit;
