-- Rollback of 0042 (banking, payments & receipt capture). Refuses, changing
-- nothing, while any bank connection, provider sync, deposit allocation, receipt
-- capture, branch on a bank account / line / payment, payment note or evidence,
-- or file in the Banking-evidence bucket exists (financial history is never
-- dropped by a rollback). Restores the 0026 bank_record_guard.
-- Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.bank_connections) or exists (select 1 from public.bank_line_allocations) or exists (select 1 from public.receipt_captures)
     or exists (select 1 from public.bank_imports where source <> 'file') or exists (select 1 from public.bank_accounts where branch_id is not null)
     or exists (select 1 from public.bank_lines where branch_id is not null)
     or exists (select 1 from public.payments where branch_id is not null or notes is not null or evidence_capture_id is not null)
     or exists (select 1 from storage.objects where bucket_id = 'Banking-evidence') then
    raise exception 'BA0042 rollback: banking connections, deposit applications, receipts or branch assignments exist; nothing was changed.';
  end if;
end $$;
drop policy if exists ba_banking_evidence_select on storage.objects;
drop policy if exists ba_banking_evidence_insert on storage.objects;
drop policy if exists ba_banking_evidence_delete on storage.objects;
delete from storage.buckets where id = 'Banking-evidence';
drop function if exists public.bank_connection_save(uuid, text, text, bigint, uuid, text);
drop function if exists public.bank_link_provider_account(uuid, uuid);
drop function if exists public.bank_sync_context(uuid, text, bigint, uuid, text);
drop function if exists public.bank_sync_apply(uuid, text, text, bigint, uuid, text);
drop function if exists public.bank_webhook_record(text, text, text, text, bigint, uuid, text);
drop function if exists public.bank_connection_disconnect(uuid, text, bigint, uuid, text);
drop function if exists public.bank_account_set_branch(uuid, uuid);
drop function if exists public.bank_line_set_branch(uuid, uuid);
drop function if exists public.bank_apply_deposit(uuid, jsonb, text, text);
drop function if exists public.bank_link_payment(uuid, uuid, integer, jsonb);
drop function if exists public.bank_allocation_void(uuid, text);
drop function if exists public.bank_settle_deposit(public.bank_lines, public.bank_accounts);
drop function if exists public.bank_payment_journal_line(uuid, uuid);
drop function if exists public.receipt_register(uuid, text, text, text, integer, text, uuid);
drop function if exists public.receipt_set_extraction(uuid, text, text, text, jsonb);
drop function if exists public.receipt_confirm(uuid, jsonb, uuid, uuid);
drop function if exists public.receipt_discard(uuid);
drop function if exists public.bank_set_server_key(text, text);
drop function if exists public.bank_retire_server_key(text, timestamptz);
drop trigger if exists ba_payment_s6_guard on public.payments;
drop function if exists public.payment_s6_guard();
alter table public.payments drop constraint if exists payments_evidence_fk;
alter table public.payments drop constraint if exists payments_branch_fk;
alter table public.payments drop constraint if exists payments_notes_check;
alter table public.payments drop column if exists evidence_capture_id, drop column if exists notes, drop column if exists branch_id;
drop table if exists public.bank_line_allocations;
drop function if exists public.bank_allocation_guard();
drop table if exists public.receipt_captures;
drop function if exists public.receipt_guard();
drop function if exists public.can_capture_evidence(uuid);
drop table if exists public.bank_webhook_events;
drop table if exists public.bank_sync_runs;
drop table if exists public.bank_provider_accounts;
drop table if exists public.bank_connections;
drop table if exists ba_private.bank_connection_secrets;
drop table if exists ba_private.bank_nonces;
drop table if exists ba_private.bank_server_keys;
drop function if exists ba_private.bank_verify(text, text, text, bigint, uuid);
alter table public.bank_lines drop constraint if exists bank_lines_branch_fk;
alter table public.bank_lines drop column if exists branch_id;
alter table public.bank_accounts drop constraint if exists bank_accounts_branch_fk;
alter table public.bank_accounts drop column if exists branch_id;
alter table public.bank_imports drop constraint if exists bank_imports_source_check;
alter table public.bank_imports drop column if exists sync_run_id, drop column if exists source;
create or replace function public.bank_record_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(old, new));
  frozen boolean;
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone((r ->> 'company_id')::uuid) then return old; end if;
    raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  if tg_table_name = 'bank_lines' then
    if (to_jsonb(new) - array['status', 'reconciliation_id']) <> (to_jsonb(old) - array['status', 'reconciliation_id']) then
      raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
    frozen := old.reconciliation_id is not null and public.bank_rec_closed(old.reconciliation_id);
    if frozen and (new.status <> old.status or new.reconciliation_id is distinct from old.reconciliation_id) then
      raise exception 'BANK_LINE_RECONCILED' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'bank_match_groups' then
    if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason', 'reconciliation_id']) <> (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason', 'reconciliation_id'])
       or (old.voided_at is not null and new.voided_at is distinct from old.voided_at) then
      raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
    if old.reconciliation_id is not null and public.bank_rec_closed(old.reconciliation_id) and new.voided_at is not null and old.voided_at is null then
      raise exception 'BANK_LINE_RECONCILED' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'bank_match_items' then
    if (to_jsonb(new) - 'active') <> (to_jsonb(old) - 'active') or (old.active = false and new.active) then
      raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
  elsif tg_table_name = 'bank_imports' then
    if (to_jsonb(new) - array['status', 'reverted_at', 'reverted_by', 'revert_reason']) <> (to_jsonb(old) - array['status', 'reverted_at', 'reverted_by', 'revert_reason'])
       or old.status = 'reverted' then
      raise exception 'BANK_RECORD_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
  end if;
  return new;
end $$;
commit;
