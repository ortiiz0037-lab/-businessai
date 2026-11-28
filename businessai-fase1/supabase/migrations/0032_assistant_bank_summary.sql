-- =====================================================================
-- BusinessAI · Migration 0032 · Bank summary for the assistant
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0026 and 0030.
--
-- Read-only, per bank account and computed in SQL over every row (no
-- truncated pages): statement lines (total, unmatched count and amount),
-- the posted ledger balance of the linked account at a date, and the last
-- reconciliation with its difference. Runs with the caller's rights
-- (SECURITY INVOKER: RLS + bank.view / accounting.view); money in cents as
-- text. Used by the assistant tool get_bank_overview.
-- Rollback: supabase/rollback/0032_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.bank_reconciliations') is null or to_regclass('public.assistant_turns') is null then
    raise exception 'BA0032: migrations 0026 and 0030 must be applied first';
  end if;
end $$;

create or replace function public.assistant_bank_summary(target uuid, at_date date default null)
returns table (account_id uuid, account_name text, bank_name text, currency text, status text,
               lines_count bigint, unmatched_count bigint, unmatched_cents text, last_line_date date,
               ledger_balance_cents text, last_rec_period_end date, last_rec_status text, last_rec_difference_cents text, as_of date)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare d date := coalesce(at_date, public.ba_today());
begin
  if not public.has_permission(target, 'bank.view') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return query
    select a.id, a.name, a.bank_name, a.currency, a.status,
           (select count(*) from public.bank_lines l where l.bank_account_id = a.id and l.txn_date <= d),
           (select count(*) from public.bank_lines l where l.bank_account_id = a.id and l.status = 'unmatched' and l.txn_date <= d),
           (select coalesce(sum(l.amount_cents), 0) from public.bank_lines l where l.bank_account_id = a.id and l.status = 'unmatched' and l.txn_date <= d)::text,
           (select max(l.txn_date) from public.bank_lines l where l.bank_account_id = a.id and l.txn_date <= d),
           -- the posted ledger balance is shown only with accounting.view (otherwise null)
           case when public.has_permission(target, 'accounting.view') then
             (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) from public.journal_lines jl join public.journal_entries je on je.id = jl.entry_id
               where jl.account_id = a.ledger_account_id and je.company_id = target and je.entry_date <= d)::text end,
           r.period_end, r.status, r.difference_cents::text, d
      from public.bank_accounts a
      left join lateral (select x.period_end, x.status, x.difference_cents from public.bank_reconciliations x
                          where x.bank_account_id = a.id order by x.period_end desc, x.created_at desc limit 1) r on true
     where a.company_id = target
     order by a.name;
end $$;

revoke all on function public.assistant_bank_summary(uuid, date) from public, anon;
grant execute on function public.assistant_bank_summary(uuid, date) to authenticated, service_role;

do $$ begin
  if has_function_privilege('anon', 'public.assistant_bank_summary(uuid, date)', 'EXECUTE') then
    raise exception 'BA0032 self-check failed: privileges';
  end if;
end $$;

commit;
