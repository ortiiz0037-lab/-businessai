-- Rollback of 0023 (double-entry general ledger). Emergency use only.
-- Refuses, changing nothing, while any journal entry, accounting period or
-- custom account exists: posted accounting records are evidence and are
-- never dropped by a rollback. Export the reports first if ever needed.
-- A ledger that was only initialised (default chart, no entries) is removed.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.journal_entries') is not null then
    if exists (select 1 from public.journal_entries) then
      raise exception 'BA0023 rollback: journal entries exist; nothing was changed.';
    end if;
  end if;
  if to_regclass('public.accounting_periods') is not null then
    if exists (select 1 from public.accounting_periods) then
      raise exception 'BA0023 rollback: accounting periods exist; nothing was changed.';
    end if;
  end if;
  if to_regclass('public.ledger_accounts') is not null then
    if exists (select 1 from public.ledger_accounts where system_key is null and created_by is not null) then
      raise exception 'BA0023 rollback: custom accounts exist; nothing was changed.';
    end if;
  end if;
end $$;
drop trigger if exists ba_ledger_document on public.documents;
drop trigger if exists ba_ledger_payment on public.payments;
drop function if exists public.ledger_on_document();
drop function if exists public.ledger_on_payment();
drop function if exists public.ledger_integrity(uuid);
drop function if exists public.ledger_account_activity(uuid, date, date);
drop function if exists public.ledger_trial_balance(uuid, date);
drop function if exists public.ledger_import_history(uuid);
drop function if exists public.ledger_reopen_period(uuid, date, text);
drop function if exists public.ledger_close_period(uuid, date);
drop function if exists public.ledger_reverse_entry(uuid, text, date);
drop function if exists public.ledger_post_manual(uuid, date, text, text, jsonb, text);
drop function if exists public.ledger_post_payment(uuid);
drop function if exists public.ledger_post_invoice_void(uuid);
drop function if exists public.ledger_post_invoice(uuid);
drop function if exists public.ledger_mirror_lines(uuid);
drop function if exists public.ledger_post(uuid, date, text, text, text, uuid, jsonb, text, uuid, text);
-- The tables go with their triggers (append-only included: no rows remain
-- in entries / lines; events and accounts of an initialised-only ledger go).
alter table if exists public.ledger_events disable trigger ba_ledger_append_only;
drop table if exists public.journal_lines;
drop table if exists public.journal_entries;
drop table if exists public.accounting_periods;
drop table if exists public.ledger_counters;
drop table if exists public.ledger_events;
drop table if exists public.ledger_accounts;
drop table if exists public.ledger_settings;
drop function if exists public.ledger_period_guard();
drop function if exists public.ledger_no_truncate();
drop function if exists public.ledger_append_only();
drop function if exists public.ledger_line_before_insert();
drop function if exists public.ledger_entry_balanced();
drop function if exists public.ledger_entry_before_insert();
drop function if exists public.ledger_account_log();
drop function if exists public.ledger_account_guard();
drop function if exists public.ledger_system_account(uuid, text);
drop function if exists public.ledger_init(uuid);
drop function if exists public.ledger_ensure_chart(uuid);
drop function if exists public.ledger_cents(numeric);
drop function if exists public.ledger_period_closed(uuid, date);
drop function if exists public.ledger_lock(uuid);
drop function if exists public.ledger_log(uuid, text, text, text, jsonb);
drop function if exists public.ledger_company_gone(uuid);
delete from public.role_permissions where permission_key like 'accounting.%';
delete from public.permissions where key like 'accounting.%';
commit;
