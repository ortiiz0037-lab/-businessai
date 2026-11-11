-- Rollback of 0015 (document lifecycle, payments and receipts).
-- Restores the 0014a state: no numbering trigger, no traceability or
-- payment guards, the five original statuses, admin with billing.manage,
-- no documents.void permission. Emergency use only.
--
-- Kept on purpose (business data): every document keeps the number it was
-- given and every receipt and payment stays. The counters table is dropped
-- (numbers already assigned are not affected).
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
drop trigger if exists ba_check_payment on public.payments;
drop trigger if exists ba_settle_invoice on public.payments;
drop function if exists public.assign_document_number();
drop function if exists public.protect_issued_documents();
drop function if exists public.check_receipt();
drop function if exists public.check_payment();
drop function if exists public.settle_invoice();
drop function if exists public.document_number_prefix(text);
drop index if exists public.documents_receipt_payment_uidx;
drop table if exists public.document_counters;

alter table public.documents drop constraint if exists documents_status_check;
alter table public.documents add constraint documents_status_check
  check (status = any (array['draft', 'sent', 'paid', 'overdue', 'cancelled']));

delete from public.role_permissions where permission_key = 'documents.void';
delete from public.permissions where key = 'documents.void';
insert into public.role_permissions (role, permission_key) values ('admin', 'billing.manage')
on conflict do nothing;
commit;
