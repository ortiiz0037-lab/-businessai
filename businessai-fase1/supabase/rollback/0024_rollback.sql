-- Rollback of 0024 (expenses, vendors, bills, payables). Emergency use only.
-- Refuses, changing nothing, while any vendor, bill, vendor payment,
-- attachment or recurring template exists: they are financial records and
-- the ledger holds their entries. It also refuses while the company's own
-- configuration or its history exists: categories other than the 5 defaults
-- (or a default renamed / archived), approval limits or settings other than
-- the defaults, and any history beyond what initialisation writes (e.g. a
-- vendor created and deleted, saved settings). Re-applying 0024 would not
-- bring those back. A module that was only initialised is removed, and the
-- 0023 pieces that 0024 changed are restored exactly (source constraint,
-- line trigger). The Finance-attachments bucket is kept (see below).
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
  if exists (select 1 from storage.buckets where id = 'Finance-attachments' and public) then
    raise exception 'BA0024 rollback: bucket Finance-attachments is public; nothing was changed.';
  end if;
  if to_regclass('public.payables_events') is not null then
    -- the 5 default categories of payables_ensure (name, English name, account code), active
    if exists (select 1 from public.expense_categories c left join public.ledger_accounts a on a.id = c.account_id
               where c.status <> 'active' or (c.name, coalesce(c.name_en, ''), coalesce(a.code, '')) not in (
                 ('Materiales y costo de ventas', 'Materials and cost of sales', '5000'), ('Gastos generales', 'General expenses', '6000'),
                 ('Alquiler', 'Rent', '6200'), ('Servicios públicos', 'Utilities', '6300'), ('Equipo (activo)', 'Equipment (asset)', '1500'))) then
      raise exception 'BA0024 rollback: custom, renamed or archived expense categories exist; nothing was changed.';
    end if;
    if exists (select 1 from public.approval_limits where not (role = 'admin' and max_cents is null)) then
      raise exception 'BA0024 rollback: approval limits were customised; nothing was changed.';
    end if;
    if exists (select 1 from public.payables_settings where allow_self_approval) then
      raise exception 'BA0024 rollback: payables settings were customised; nothing was changed.';
    end if;
    -- only what payables_ensure writes: 'initialized' and the 'created' rows of the default categories
    if exists (select 1 from public.payables_events e
               where not ((e.entity = 'payables' and e.action = 'initialized')
                       or (e.entity = 'expense_categories' and e.action = 'created' and e.details ->> 'name' in
                             ('Materiales y costo de ventas', 'Gastos generales', 'Alquiler', 'Servicios públicos', 'Equipo (activo)')))) then
      raise exception 'BA0024 rollback: payables history exists beyond the initialisation; nothing was changed.';
    end if;
  end if;
end $$;
drop policy if exists ba_finance_attachments_select on storage.objects;
drop policy if exists ba_finance_attachments_insert on storage.objects;
drop policy if exists ba_finance_attachments_delete on storage.objects;
-- The Finance-attachments bucket is KEPT: private (checked above), empty (checked above) and, with the
-- policies dropped, unusable by any user. Hosted Supabase refuses every direct DELETE on
-- storage.buckets (trigger protect_buckets_delete, supabase/storage migration
-- 0055-prevent-direct-deletes); a bucket is removed only through the Storage API
-- (deleteBucket, once empty), as a separate owner step. Re-applying 0024 reuses it as is.
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
