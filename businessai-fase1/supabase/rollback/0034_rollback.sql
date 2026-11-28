-- Rollback of 0034 (payroll). Refuses, changing nothing, while any payroll
-- data exists (runs, settings, items, assignments, compensation recorded by a
-- user, events) or the ledger holds payroll entries. The compensation rows
-- copied from the existing employee pay rates (created_by null) are dropped
-- with the table: the original rates stay in employees.hourly_rate.
-- Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.payroll_runs') is not null and (
       exists (select 1 from public.payroll_runs) or exists (select 1 from public.payroll_settings)
    or exists (select 1 from public.payroll_items) or exists (select 1 from public.employee_payroll_items)
    or exists (select 1 from public.employee_compensation where created_by is not null) or exists (select 1 from public.payroll_events)) then
    raise exception 'BA0034 rollback: payroll data exists; nothing was changed.';
  end if;
  if exists (select 1 from public.journal_entries where source in ('payroll', 'payroll_void', 'payroll_payment', 'payroll_payment_void')) then
    raise exception 'BA0034 rollback: payroll entries exist in the ledger; nothing was changed.';
  end if;
end $$;

drop function if exists public.payroll_save_settings(uuid, uuid, uuid, uuid, uuid, text[], boolean);
drop function if exists public.payroll_discard(uuid);
drop function if exists public.payroll_reverse(uuid, text);
drop function if exists public.payroll_record_payment(uuid, date, text);
drop function if exists public.payroll_approve(uuid, integer);
drop function if exists public.payroll_prepare(uuid, jsonb);
drop function if exists public.payroll_remove_adjustment(uuid);
drop function if exists public.payroll_add_adjustment(uuid, uuid, uuid, bigint, text);
drop function if exists public.payroll_create_correction(uuid, date);
drop function if exists public.payroll_create_run(uuid, text, date, date, date, text);
drop function if exists public.end_payroll_item(uuid, date);
drop function if exists public.assign_payroll_item(uuid, uuid, bigint, integer, date);
drop function if exists public.payroll_save_item(uuid, text, text, text, text, bigint, integer);
drop function if exists public.set_compensation(uuid, date, text, text, bigint, bigint, bigint, text);
-- returns the row type of employee_compensation / payroll_settings: dropped before the tables
drop function if exists public.payroll_compensation_at(uuid, date);
drop function if exists public.payroll_ensure_settings(uuid);

-- the read policies reference each other's tables
drop policy if exists ba_payroll_runs_select on public.payroll_runs;
drop policy if exists ba_payroll_lines_select on public.payroll_lines;
drop policy if exists ba_payroll_line_items_select on public.payroll_line_items;
drop table if exists public.payroll_line_items;
drop table if exists public.payroll_lines;
drop table if exists public.payroll_adjustments;
drop table if exists public.payroll_runs;
drop table if exists public.payroll_events;
drop table if exists public.payroll_tax_rules;
drop table if exists public.employee_payroll_items;
drop table if exists public.payroll_items;
drop table if exists public.employee_compensation;
drop table if exists public.payroll_settings;

drop function if exists public.payroll_self_line(uuid);
drop function if exists public.payroll_self_in_run(uuid);
drop function if exists public.payroll_run_published(uuid);
drop function if exists public.payroll_assignment_guard();
drop function if exists public.payroll_guard();
drop function if exists public.payroll_leave_minutes(uuid, date, date, text[]);
drop function if exists public.wf_worked_minutes(uuid, date, date);
drop function if exists public.payroll_period_ok(text, date, date);
drop function if exists public.payroll_periods_per_year(text);
drop function if exists public.payroll_round(numeric);
drop function if exists public.payroll_can(uuid, text);
drop function if exists public.payroll_log(uuid, uuid, uuid, text, jsonb);

alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void', 'payment_void',
                    'bank_adjustment', 'bank_reconciliation'));

delete from public.role_permissions where permission_key in ('payroll.view', 'payroll.manage', 'payroll.approve');
delete from public.permissions where key in ('payroll.view', 'payroll.manage', 'payroll.approve');
commit;
