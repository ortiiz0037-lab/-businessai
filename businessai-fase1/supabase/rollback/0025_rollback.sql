-- Rollback of 0025 (accounts receivable and collections). Emergency use only.
-- Refuses, changing nothing, while any payment is voided or any collection
-- record exists (notes, promises, reminders, statuses, settings, events):
-- they are financial history. Restores the 0015 / 0023 functions and the
-- 0024 ledger source constraint exactly as they were.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'voided_at') then
    if exists (select 1 from public.payments where voided_at is not null) then
      raise exception 'BA0025 rollback: voided payments exist; nothing was changed.';
    end if;
  end if;
  if to_regclass('public.receivables_events') is not null then
    if exists (select 1 from public.receivables_events) or exists (select 1 from public.collection_notes) or exists (select 1 from public.payment_promises)
       or exists (select 1 from public.collection_reminders) or exists (select 1 from public.invoice_collections) then
      raise exception 'BA0025 rollback: collection records exist; nothing was changed.';
    end if;
  end if;
end $$;
drop trigger if exists ba_ar_on_payment on public.payments;
drop trigger if exists ba_ar_invoice_settled on public.documents;
drop trigger if exists ba_payment_guard on public.payments;
drop trigger if exists ba_payment_no_truncate on public.payments;
drop function if exists public.ar_save_settings(uuid, boolean, integer[], text, text, text, text, text);
drop function if exists public.ar_mark_reminder(uuid, text, text);
drop function if exists public.ar_refresh(uuid);
drop function if exists public.ar_on_invoice_settled();
drop function if exists public.ar_on_payment();
drop function if exists public.ar_resolve_promises(uuid);
drop function if exists public.ar_cancel_promise(uuid, text);
drop function if exists public.ar_add_promise(uuid, date, bigint, text);
drop function if exists public.ar_add_note(uuid, uuid, uuid, text);
drop function if exists public.ar_set_status(uuid, text);
drop function if exists public.payment_void(uuid, text);
drop function if exists public.ar_client_report(uuid, date, date);
drop function if exists public.ar_aging(uuid, date);
drop function if exists public.ar_invoice_balances(uuid, date);
drop function if exists public.ar_invoice(uuid, text);
drop table if exists public.collection_settings;
drop table if exists public.invoice_collections;
drop table if exists public.collection_notes;
drop table if exists public.payment_promises;
drop table if exists public.collection_reminders;
drop table if exists public.receivables_events;
drop function if exists public.ar_record_guard();
drop function if exists public.ar_log(uuid, uuid, uuid, text, text, text, jsonb);
-- 0015 / 0023 functions exactly as they were (they no longer use invoice_paid).
create or replace function public.document_transition_allowed(doc_type text, from_status text, to_status text)
returns boolean
language sql immutable set search_path = '' as $$
  select case
    when from_status = to_status then true
    when to_status = 'cancelled' then from_status <> 'cancelled'   -- void: more rules in the trigger
    when doc_type = 'invoice' then (from_status, to_status) in
      (('draft', 'sent'), ('sent', 'overdue'), ('sent', 'paid'), ('overdue', 'paid'))
    when doc_type = 'quote' then (from_status, to_status) in
      (('draft', 'sent'), ('sent', 'accepted'), ('sent', 'rejected'))
    when doc_type = 'receipt' then false
    else (from_status, to_status) in (('draft', 'sent'))
  end
$$;

create or replace function public.protect_issued_documents()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  paid numeric;
  reason text;
  frozen text[] := array['status', 'updated_at', 'metadata'];
begin
  if uid is null then
    return coalesce(new, old);                    -- server-side maintenance
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'DOCUMENT_ISSUED'
        using errcode = 'P0001', hint = old.status,
              detail = 'Issued documents are voided, not deleted.';
    end if;
    return old;
  end if;

  -- Identity of a document: never changes.
  if new.id <> old.id or new.document_type <> old.document_type
     or new.document_number is distinct from old.document_number
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'DOCUMENT_FIELD_LOCKED' using errcode = 'P0001';
  end if;

  if new.status = old.status then
    if old.status = 'draft' then
      if (new.metadata ? 'void') and not (old.metadata ? 'void') then
        raise exception 'DOCUMENT_FIELD_LOCKED' using errcode = 'P0001';
      end if;
      return new;                                 -- drafts are editable
    end if;
    if (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
      raise exception 'DOCUMENT_ISSUED' using errcode = 'P0001', hint = old.status,
        detail = 'Issued documents cannot be edited.';
    end if;
    return new;
  end if;

  if old.status = 'cancelled' then
    raise exception 'DOCUMENT_CANCELLED' using errcode = 'P0001', hint = new.status;
  end if;
  if new.status = 'draft' then
    raise exception 'DOCUMENT_ISSUED' using errcode = 'P0001', hint = old.status;
  end if;
  if not public.document_transition_allowed(old.document_type, old.status, new.status) then
    raise exception 'DOCUMENT_TRANSITION' using errcode = 'P0001',
      hint = old.document_type || ':' || old.status || '->' || new.status;
  end if;
  -- Leaving draft may carry the last edits; afterwards only the status moves.
  if old.status <> 'draft' and (to_jsonb(new) - frozen) <> (to_jsonb(old) - frozen) then
    raise exception 'DOCUMENT_ISSUED' using errcode = 'P0001', hint = old.status,
      detail = 'Issued documents cannot be edited.';
  end if;

  if new.status = 'cancelled' then
    if not public.has_permission(new.company_id, 'documents.void') then
      raise exception 'DOCUMENT_VOID_FORBIDDEN' using errcode = 'P0001';
    end if;
    if old.status <> 'draft'
       and (coalesce(new.metadata, '{}'::jsonb) - 'void') <> (coalesce(old.metadata, '{}'::jsonb) - 'void') then
      raise exception 'DOCUMENT_ISSUED' using errcode = 'P0001', hint = old.status;
    end if;
    if old.document_type = 'invoice'
       and exists (select 1 from public.payments p where p.document_id = old.id) then
      raise exception 'DOCUMENT_HAS_PAYMENTS' using errcode = 'P0001',
        detail = 'An invoice with payments cannot be voided; issue a credit note.';
    end if;
    reason := btrim(coalesce(new.metadata -> 'void' ->> 'reason', ''));
    if char_length(reason) < 3 or char_length(reason) > 300 then
      raise exception 'VOID_REASON_REQUIRED' using errcode = 'P0001';
    end if;
    -- The database writes who, when and from which status: not the client.
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('void', jsonb_build_object(
      'reason', reason, 'voided_at', now(), 'voided_by', uid, 'previous_status', old.status));
    return new;
  end if;

  if old.status <> 'draft' and new.metadata is distinct from old.metadata then
    raise exception 'DOCUMENT_ISSUED' using errcode = 'P0001', hint = old.status;
  end if;
  if new.status = 'paid' then
    select coalesce(sum(p.amount), 0) into paid from public.payments p where p.document_id = old.id;
    if paid < new.total then
      raise exception 'DOCUMENT_NOT_PAID' using errcode = 'P0001', hint = (new.total - paid)::text;
    end if;
  end if;
  if new.status = 'overdue' and (new.due_date is null or new.due_date >= public.ba_today()) then
    raise exception 'DOCUMENT_NOT_OVERDUE' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function public.check_payment()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  d record;
  paid numeric;
begin
  if (select auth.uid()) is null then
    return new;                                   -- server-side maintenance
  end if;
  -- Not allowed to record payments here (or as someone else): let RLS
  -- reject it with its usual error, revealing and locking nothing.
  if new.created_by is distinct from (select auth.uid())
     or not public.has_permission(new.company_id, 'payments.record') then
    return new;
  end if;
  -- WRITE the invoice row (not only lock it): concurrent payments wait for
  -- each other, and a REPEATABLE READ / SERIALIZABLE transaction that read
  -- an older balance fails (40001) instead of overpaying.
  update public.documents set updated_at = now()
   where id = new.document_id and company_id = new.company_id
  returning id, document_type, status, total, issue_date into d;
  if not found then
    return new;                                   -- RLS / the foreign key reject it as usual
  end if;
  if d.document_type <> 'invoice' or d.status not in ('sent', 'overdue') then
    raise exception 'PAYMENT_NOT_ALLOWED'
      using errcode = 'P0001', hint = d.document_type || ':' || d.status;
  end if;
  if new.paid_at is null then
    new.paid_at := now();
  end if;
  -- One day of tolerance: issue_date may come from the server's UTC date
  -- (column default) while payments are dated in Puerto Rico time.
  if (new.paid_at at time zone 'America/Puerto_Rico')::date < d.issue_date - 1
     or new.paid_at > now() + interval '1 day' then
    raise exception 'PAYMENT_DATE_INVALID' using errcode = 'P0001', hint = d.issue_date::text;
  end if;
  select coalesce(sum(p.amount), 0) into paid from public.payments p where p.document_id = d.id;
  if paid + new.amount > d.total then
    raise exception 'PAYMENT_EXCEEDS_BALANCE'
      using errcode = 'P0001', hint = greatest(d.total - paid, 0)::text;
  end if;
  return new;
end $$;

create or replace function public.settle_invoice()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.documents d
     set status = 'paid', updated_at = now()
   where d.id = new.document_id
     and d.document_type = 'invoice'
     and d.status in ('sent', 'overdue')
     and (select coalesce(sum(p.amount), 0) from public.payments p where p.document_id = d.id) >= d.total;
  return null;
end $$;

create or replace function public.check_receipt()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pay record;
  pid text;
begin
  if new.document_type <> 'receipt' or (select auth.uid()) is null then
    return new;
  end if;
  -- Not allowed to create documents here: let RLS reject it as usual.
  if not public.has_permission(new.company_id, 'documents.create') then
    return new;
  end if;
  pid := new.metadata ->> 'payment_id';
  if pid is null or pid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'RECEIPT_PAYMENT_REQUIRED' using errcode = 'P0001';
  end if;
  select p.company_id, p.amount, d.client_id into pay
  from public.payments p join public.documents d on d.id = p.document_id
  where p.id = pid::uuid and p.company_id = new.company_id;
  if not found then
    raise exception 'RECEIPT_PAYMENT_REQUIRED' using errcode = 'P0001';
  end if;
  if new.total <> pay.amount then
    raise exception 'RECEIPT_AMOUNT_MISMATCH' using errcode = 'P0001', hint = pay.amount::text;
  end if;
  -- The receipt is for the invoice's client.
  if new.client_id is null then
    new.client_id := pay.client_id;
  elsif new.client_id is distinct from pay.client_id then
    raise exception 'RECEIPT_CLIENT_MISMATCH' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function public.ledger_integrity(target uuid)
returns table (debit_cents bigint, credit_cents bigint, unbalanced_entries bigint,
               receivable_cents bigint, open_invoices_cents bigint, unposted_invoices bigint, unposted_payments bigint)
language sql stable set search_path = '' as $$
  select
    (select coalesce(sum(l.debit_cents), 0) from public.journal_lines l where l.company_id = target)::bigint,
    (select coalesce(sum(l.credit_cents), 0) from public.journal_lines l where l.company_id = target)::bigint,
    (select count(*) from (select l.entry_id from public.journal_lines l where l.company_id = target
                           group by l.entry_id having sum(l.debit_cents) <> sum(l.credit_cents)) u),
    (select coalesce(sum(l.debit_cents - l.credit_cents), 0) from public.journal_lines l
       join public.ledger_accounts a on a.id = l.account_id
      where l.company_id = target and a.system_key = 'accounts_receivable')::bigint,
    (select coalesce(sum(public.ledger_cents(d.total) - coalesce((select public.ledger_cents(sum(p.amount)) from public.payments p where p.document_id = d.id), 0)), 0)
       from public.documents d
      where d.company_id = target and d.document_type = 'invoice' and d.status in ('sent', 'overdue', 'paid')
        and exists (select 1 from public.journal_entries e where e.company_id = target and e.source = 'invoice' and e.source_id = d.id))::bigint,
    (select count(*) from public.documents d
      where d.company_id = target and d.document_type = 'invoice' and d.status in ('sent', 'overdue', 'paid') and d.total > 0
        and not exists (select 1 from public.journal_entries e where e.company_id = target and e.source = 'invoice' and e.source_id = d.id)),
    (select count(*) from public.payments p
      where p.company_id = target
        and not exists (select 1 from public.journal_entries e where e.company_id = target and e.source = 'payment' and e.source_id = p.id))
  where public.has_permission(target, 'accounting.view') or (select auth.uid()) is null
$$;

drop function if exists public.invoice_paid(uuid);
drop function if exists public.payment_guard();
alter table public.payments drop constraint if exists payments_void_check;
alter table public.payments drop column if exists void_reason;
alter table public.payments drop column if exists voided_by;
alter table public.payments drop column if exists voided_at;
delete from public.role_permissions where permission_key in ('receivables.view', 'receivables.manage', 'payments.void');
delete from public.permissions where key in ('receivables.view', 'receivables.manage', 'payments.void');
alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void'));
commit;
