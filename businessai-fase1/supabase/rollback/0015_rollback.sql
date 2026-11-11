-- Rollback of 0015 (document lifecycle, payments and receipts), revision 2.
-- Restores the 0014a state: no numbering, transition, immutability,
-- company or payment guards, the five original statuses, admin with
-- billing.manage, no documents.void permission. Emergency use only.
--
-- Kept on purpose (business data): every document keeps the number, status
-- and void record it has; every receipt and payment stays.
--   * document_counters is dropped (numbers already assigned stay; a later
--     re-apply skips numbers already taken).
--   * payments.idempotency_key is dropped (only used to reject repeated
--     form submissions).
--   * document_events (history) is dropped ONLY when it is empty; with
--     history it is kept, read-only as before, and a re-apply reuses it.
-- Refuses to run, changing nothing, while a document is 'accepted' or
-- 'rejected': the original status constraint would not accept it. Decide
-- what those quotes should be first.
begin;
set local lock_timeout = '5s';

do $$ begin
  if exists (select 1 from public.documents where status in ('accepted', 'rejected')) then
    raise exception 'BA0015 rollback: accepted/rejected quotes exist; nothing was changed.';
  end if;
end $$;

drop trigger if exists ba_assign_document_number on public.documents;
drop trigger if exists ba_protect_issued_documents on public.documents;
drop trigger if exists ba_check_receipt on public.documents;
drop trigger if exists ba_check_document_insert on public.documents;
drop trigger if exists ba_log_document_event on public.documents;
drop trigger if exists ba_check_payment on public.payments;
drop trigger if exists ba_settle_invoice on public.payments;
do $$
declare
  t text;
begin
  foreach t in array array['clients', 'documents', 'payments', 'memberships', 'company_profiles', 'document_deletion_audit']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    end if;
  end loop;
end $$;
drop function if exists public.assign_document_number();
drop function if exists public.protect_issued_documents();
drop function if exists public.check_receipt();
drop function if exists public.check_document_insert();
drop function if exists public.log_document_event();
drop function if exists public.check_payment();
drop function if exists public.settle_invoice();
drop function if exists public.forbid_company_change();
drop function if exists public.document_transition_allowed(text, text, text);
drop function if exists public.document_number_prefix(text);
drop function if exists public.ba_today();
drop index if exists public.documents_receipt_payment_uidx;
drop index if exists public.payments_idempotency_uidx;
alter table public.payments drop constraint if exists payments_idempotency_key_check;
alter table public.payments drop column if exists idempotency_key;
drop table if exists public.document_counters;
do $$ begin
  if to_regclass('public.document_events') is not null
     and not exists (select 1 from public.document_events) then
    drop table public.document_events;
  elsif to_regclass('public.document_events') is not null then
    raise notice 'BA0015 rollback: document_events has history and is kept.';
  end if;
end $$;

alter table public.documents drop constraint if exists documents_status_check;
alter table public.documents add constraint documents_status_check
  check (status = any (array['draft', 'sent', 'paid', 'overdue', 'cancelled']));

delete from public.role_permissions where permission_key = 'documents.void';
delete from public.permissions where key = 'documents.void';
insert into public.role_permissions (role, permission_key) values ('admin', 'billing.manage')
on conflict do nothing;
commit;
