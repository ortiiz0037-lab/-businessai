-- Rollback of 0027 (financial statements, budgets, assumptions). Emergency use only.
-- Refuses, changing nothing, while any budget, budget history, saved
-- assumption or account classification exists. Statements are computed
-- (nothing stored), so nothing else is lost.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.budgets') is not null then
    if exists (select 1 from public.budgets) or exists (select 1 from public.budget_events) or exists (select 1 from public.fs_assumptions) then
      raise exception 'BA0027 rollback: budgets, budget history or assumptions exist; nothing was changed.';
    end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledger_accounts' and column_name = 'statement_class') then
    if exists (select 1 from public.ledger_accounts where statement_class is not null) then
      raise exception 'BA0027 rollback: accounts have a statement classification; nothing was changed.';
    end if;
  end if;
end $$;
drop function if exists public.fs_save_assumptions(uuid, numeric, numeric, numeric, numeric, integer);
drop function if exists public.budget_vs_actual(uuid, date);
drop function if exists public.budget_new_version(uuid, text);
drop function if exists public.budget_archive(uuid, text);
drop function if exists public.budget_publish(uuid);
drop function if exists public.budget_approve(uuid, text);
drop function if exists public.budget_fill_from_actuals(uuid, integer, numeric);
drop function if exists public.budget_set_lines(uuid, uuid, uuid, bigint[], text);
drop function if exists public.budget_set_line(uuid, uuid, uuid, integer, bigint, text);
drop function if exists public.budget_update(uuid, text, text, integer, integer, integer, integer);
drop function if exists public.budget_create(uuid, text, integer, text, text, uuid, text);
drop function if exists public.budget_for(uuid, text);
alter table if exists public.budget_events disable trigger ba_budget_append_only;
drop table if exists public.budget_lines;
drop table if exists public.budgets;
drop table if exists public.budget_events;
drop table if exists public.fs_assumptions;
drop function if exists public.budget_log(uuid, uuid, text, jsonb);
drop function if exists public.budget_guard();
drop function if exists public.fs_monthly(uuid, date, integer);
drop function if exists public.fs_data_quality(uuid, date, date);
drop function if exists public.fs_cash_flow(uuid, date, date);
drop function if exists public.fs_balance_sheet(uuid, date);
drop function if exists public.fs_income_statement(uuid, date, date);
drop function if exists public.fs_account_balances(uuid, date, date);
drop function if exists public.fs_class(uuid);
revoke update (statement_class) on public.ledger_accounts from authenticated;
alter table public.ledger_accounts drop constraint if exists ledger_accounts_statement_class_check;
alter table public.ledger_accounts drop column if exists statement_class;
delete from public.role_permissions where permission_key like 'budgets.%';
delete from public.permissions where key like 'budgets.%';
commit;
