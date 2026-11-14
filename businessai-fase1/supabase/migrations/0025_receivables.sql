-- =====================================================================
-- BusinessAI · Migration 0025 · Finance: accounts receivable and collections
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a, 0015, 0023 and 0024.
--
-- NO PARALLEL BOOK. Receivables are computed from the invoices (0015), the
-- client payments (0015) and the ledger (0023); collections add only
-- follow-up data (status, notes, payment promises, reminders) that carries
-- no amount of its own in the books.
--
-- MONEY
--  * Invoice issued: Dr Accounts receivable / Cr revenue + sales tax (0023,
--    unchanged). Payment: Dr Cash / Cr Accounts receivable (0023,
--    unchanged; partial payments are several entries). Revenue is never
--    recognised again by a payment.
--  * NEW — payment void (bounced check, posting error): the payment row is
--    kept and marked voided (who, when, reason), a reversal entry
--    (source payment_void) restores the receivable, and a paid invoice goes
--    back to sent / overdue. A payment is voided once; payments are never
--    edited or deleted (maintenance included; only a company cascade).
--  * Balances never go negative: a payment is checked against the open
--    balance on the locked invoice row (0015) and a void only raises it.
--    Voided payments no longer count anywhere (balance, paid status,
--    receipts, ledger integrity): the 0015 / 0023 functions that summed
--    payments are replaced here and restored exactly by the rollback.
--
-- AGING (ar_invoice_balances / ar_aging, as of any date)
--   days past due = as_of − due date (issue date when there is none);
--   buckets 0–30 (not yet due included), 31–60, 61–90, 90+.
--   ar status: issued · partially_paid · overdue · paid.
--
-- COLLECTIONS
--  * invoice_collections: open · contacted · promised · disputed ·
--    escalated · on_hold (follow-up only; logged).
--  * collection_notes: internal, append-only.
--  * payment_promises: pending → kept (payments since the promise reach
--    the amount) | broken (date passed) | cancelled (with reason).
--  * collection_reminders: an outbox. ar_refresh queues reminders on the
--    configured days (relative to the due date, last 7 days only, one per
--    invoice and offset); paid or voided invoices cancel theirs. Sending
--    by email happens in the app only when an email provider is
--    configured; nothing is marked sent without it.
-- ROLES: receivables.view / manage and payments.void (owner, admin).
-- Rollback: supabase/rollback/0025_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.ledger_post(uuid, date, text, text, text, uuid, jsonb, text, uuid, text)') is null
     or to_regclass('public.bills') is null then
    raise exception 'BA0025: migrations 0023 and 0024 must be applied first';
  end if;
end $$;

insert into public.permissions (key, module, description_es, description_en) values
  ('receivables.view', 'receivables', 'Ver cuentas por cobrar, antigüedad, cobros e historial por cliente', 'View receivables, aging, collections and client history'),
  ('receivables.manage', 'receivables', 'Gestionar cobros: estados, notas, promesas y recordatorios', 'Manage collections: statuses, notes, promises and reminders'),
  ('payments.void', 'payments', 'Anular pagos de clientes con reversión', 'Void client payments with a reversal')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'receivables.view'), ('admin', 'receivables.view'),
  ('owner', 'receivables.manage'), ('admin', 'receivables.manage'),
  ('owner', 'payments.void'), ('admin', 'payments.void')
on conflict do nothing;

alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void', 'payment_void'));

-- ------------------------------------------------------- payment voids
alter table public.payments add column if not exists voided_at timestamptz;
alter table public.payments add column if not exists voided_by uuid;
alter table public.payments add column if not exists void_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_void_check' and conrelid = 'public.payments'::regclass) then
    alter table public.payments add constraint payments_void_check
      check ((voided_at is null) = (void_reason is null) and (void_reason is null or char_length(void_reason) between 3 and 300));
  end if;
end $$;

-- Payments are evidence: never edited or deleted; the void fields are set once.
create or replace function public.payment_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'PAYMENT_IMMUTABLE' using errcode = 'P0001', detail = 'Client payments are voided, not deleted.';
  end if;
  if old.voided_at is not null or new.voided_at is null
     or (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason']) <> (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'PAYMENT_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_payment_guard on public.payments;
create trigger ba_payment_guard before update or delete on public.payments for each row execute function public.payment_guard();
drop trigger if exists ba_payment_no_truncate on public.payments;
create trigger ba_payment_no_truncate before truncate on public.payments for each statement execute function public.ledger_no_truncate();

-- Paid amount of an invoice: payments that are not voided.
create or replace function public.invoice_paid(doc uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(p.amount), 0) from public.payments p where p.document_id = doc and p.voided_at is null
$$;

-- ---------------------------------- 0015 / 0023 functions: voided payments do not count
create or replace function public.document_transition_allowed(doc_type text, from_status text, to_status text)
returns boolean
language sql immutable set search_path = '' as $$
  select case
    when from_status = to_status then true
    when to_status = 'cancelled' then from_status <> 'cancelled'   -- void: more rules in the trigger
    when doc_type = 'invoice' then (from_status, to_status) in
      (('draft', 'sent'), ('sent', 'overdue'), ('sent', 'paid'), ('overdue', 'paid'),
       ('paid', 'sent'), ('paid', 'overdue'))   -- 0025: only when voided payments no longer cover it
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
       and exists (select 1 from public.payments p where p.document_id = old.id and p.voided_at is null) then
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
  -- 0025: back from paid only when voided payments no longer cover the total.
  if old.status = 'paid' and new.status in ('sent', 'overdue') and public.invoice_paid(old.id) >= old.total then
    raise exception 'DOCUMENT_TRANSITION' using errcode = 'P0001', hint = old.document_type || ':' || old.status || '->' || new.status;
  end if;
  if new.status = 'paid' then
    paid := public.invoice_paid(old.id);
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
  paid := public.invoice_paid(d.id);
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
     and public.invoice_paid(d.id) >= d.total;
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
  where p.id = pid::uuid and p.company_id = new.company_id and p.voided_at is null;
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
    (select coalesce(sum(public.ledger_cents(d.total) - coalesce(public.ledger_cents(public.invoice_paid(d.id)), 0)), 0)
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

-- ------------------------------------------------------------- tables
create table if not exists public.collection_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  reminders_enabled boolean not null default false,
  reminder_offsets integer[] not null default '{-3,0,7,30}'
    check (cardinality(reminder_offsets) between 1 and 10 and -60 <= all (reminder_offsets) and 365 >= all (reminder_offsets)),
  language text not null default 'es' check (language in ('es', 'en')),
  sender_name text check (sender_name is null or char_length(sender_name) <= 100),
  reply_to text check (reply_to is null or char_length(reply_to) <= 200),
  message_es text check (message_es is null or char_length(message_es) <= 2000),
  message_en text check (message_en is null or char_length(message_en) <= 2000),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.invoice_collections (
  document_id uuid primary key references public.documents(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'contacted', 'promised', 'disputed', 'escalated', 'on_hold')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.collection_notes (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null,
  document_id uuid,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists collection_notes_client_idx on public.collection_notes (client_id, created_at desc);
create index if not exists collection_notes_document_idx on public.collection_notes (document_id, created_at desc);

create table if not exists public.payment_promises (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  client_id uuid not null,
  promised_date date not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents < 1000000000000000),
  note text check (note is null or char_length(note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'kept', 'broken', 'cancelled')),
  created_by uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) between 3 and 300)
);
create index if not exists payment_promises_document_idx on public.payment_promises (document_id, created_at desc);
create index if not exists payment_promises_company_idx on public.payment_promises (company_id, status, promised_date);

create table if not exists public.collection_reminders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  client_id uuid not null,
  offset_days integer not null,
  scheduled_for date not null,
  channel text not null default 'email' check (channel in ('email')),
  to_email text check (to_email is null or char_length(to_email) <= 200),
  language text not null default 'es' check (language in ('es', 'en')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'sent_manual', 'failed', 'cancelled', 'no_email')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  sent_at timestamptz,
  sent_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, offset_days)
);
create index if not exists collection_reminders_company_idx on public.collection_reminders (company_id, status, scheduled_for);

create table if not exists public.receivables_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid,
  document_id uuid,
  entity text not null,
  entity_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists receivables_events_company_idx on public.receivables_events (company_id, created_at desc);
create index if not exists receivables_events_client_idx on public.receivables_events (client_id, created_at desc);
create index if not exists receivables_events_document_idx on public.receivables_events (document_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['collection_settings', 'invoice_collections', 'collection_notes', 'payment_promises', 'collection_reminders', 'receivables_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
    execute format('create policy ba_%s_select on public.%I for select to authenticated using (public.has_permission(company_id, ''receivables.view''))', t, t);
    execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    execute format('create trigger ba_company_immutable before update on public.%I for each row execute function public.forbid_company_change()', t);
  end loop;
  foreach t in array array['collection_notes', 'receivables_events'] loop
    execute format('drop trigger if exists ba_ar_append_only on public.%I', t);
    execute format('create trigger ba_ar_append_only before update or delete on public.%I for each row execute function public.ledger_append_only()', t);
    execute format('drop trigger if exists ba_ar_no_truncate on public.%I', t);
    execute format('create trigger ba_ar_no_truncate before truncate on public.%I for each statement execute function public.ledger_no_truncate()', t);
  end loop;
end $$;

-- Promises and reminders: resolved once; never deleted (company cascade
-- and draft invoice deletion aside).
create or replace function public.ar_record_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) or not exists (select 1 from public.documents d where d.id = old.document_id) then
      return old;
    end if;
    raise exception 'AR_RECORD_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.document_id <> old.document_id or new.client_id <> old.client_id or new.created_at <> old.created_at then
    raise exception 'AR_RECORD_IMMUTABLE' using errcode = 'P0001';
  end if;
  if tg_table_name = 'payment_promises' then
    if old.status <> 'pending' or new.amount_cents <> old.amount_cents or new.promised_date <> old.promised_date
       or new.created_by is distinct from old.created_by then
      raise exception 'AR_RECORD_IMMUTABLE' using errcode = 'P0001';
    end if;
  elsif old.status in ('sent', 'sent_manual', 'cancelled')
        or (old.status = 'no_email' and new.status not in ('no_email', 'sent_manual', 'cancelled')) then
    raise exception 'AR_RECORD_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_ar_record_guard on public.payment_promises;
create trigger ba_ar_record_guard before update or delete on public.payment_promises for each row execute function public.ar_record_guard();
drop trigger if exists ba_ar_record_guard on public.collection_reminders;
create trigger ba_ar_record_guard before update or delete on public.collection_reminders for each row execute function public.ar_record_guard();

-- ------------------------------------------------------------- helpers
create or replace function public.ar_log(target uuid, client uuid, doc uuid, ent text, ent_id text, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.receivables_events (company_id, client_id, document_id, entity, entity_id, action, details, actor)
  values (target, client, doc, ent, ent_id, act, coalesce(info, '{}'::jsonb), (select auth.uid()))
$$;

-- An issued invoice of the company, visible to the caller with the permission.
create or replace function public.ar_invoice(doc uuid, perm text)
returns public.documents language plpgsql stable security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = doc;
  if d.id is null or d.document_type <> 'invoice' or not public.has_permission(d.company_id, perm) then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if d.status in ('draft') then
    raise exception 'INVOICE_NOT_ISSUED' using errcode = 'P0001';
  end if;
  return d;
end $$;

-- ------------------------------------------------------------- balances and aging
-- One row per issued invoice as of a date: total, paid (payments up to that
-- day not voided by then), balance, days past due, bucket and status.
create or replace function public.ar_invoice_balances(target uuid, as_of date default null)
returns table (document_id uuid, client_id uuid, document_number text, issue_date date, due_date date, total_cents bigint, paid_cents bigint,
               balance_cents bigint, days_past_due integer, bucket text, ar_status text, collection_status text)
language sql stable security definer set search_path = '' as $$
  with a as (select coalesce(as_of, public.ba_today()) as d),
  inv as (
    select d.* from public.documents d, a
    where d.company_id = target and d.document_type = 'invoice' and d.total > 0 and d.issue_date <= a.d
      and (d.status in ('sent', 'overdue', 'paid')
           or (d.status = 'cancelled' and coalesce(d.metadata -> 'void' ->> 'previous_status', 'draft') <> 'draft'
               and ((d.metadata -> 'void' ->> 'voided_at')::timestamptz at time zone 'America/Puerto_Rico')::date > a.d))
      and (public.has_permission(target, 'receivables.view') or (select auth.uid()) is null)),
  pay as (
    select p.document_id, sum(public.ledger_cents(p.amount))::bigint as cents
    from public.payments p, a
    where p.company_id = target and (p.paid_at at time zone 'America/Puerto_Rico')::date <= a.d
      and (p.voided_at is null or (p.voided_at at time zone 'America/Puerto_Rico')::date > a.d)
    group by p.document_id),
  x as (
    select inv.id, inv.client_id, inv.document_number, inv.issue_date, inv.due_date, public.ledger_cents(inv.total) as total_cents,
           coalesce(pay.cents, 0) as paid_cents, (select d from a) - coalesce(inv.due_date, inv.issue_date) as dpd
    from inv left join pay on pay.document_id = inv.id)
  select x.id, x.client_id, x.document_number, x.issue_date, x.due_date, x.total_cents, x.paid_cents, x.total_cents - x.paid_cents,
         x.dpd,
         case when x.total_cents - x.paid_cents <= 0 then null
              when x.dpd <= 30 then '0_30' when x.dpd <= 60 then '31_60' when x.dpd <= 90 then '61_90' else '90_plus' end,
         case when x.total_cents - x.paid_cents <= 0 then 'paid'
              when x.dpd > 0 then 'overdue'
              when x.paid_cents > 0 then 'partially_paid' else 'issued' end,
         coalesce((select c.status from public.invoice_collections c where c.document_id = x.id), 'open')
  from x
$$;

create or replace function public.ar_aging(target uuid, as_of date default null)
returns table (client_id uuid, client_name text, b0_30 bigint, b31_60 bigint, b61_90 bigint, b90_plus bigint, total_cents bigint,
               overdue_cents bigint, not_due_cents bigint, invoices bigint, oldest_days integer)
language sql stable security definer set search_path = '' as $$
  select b.client_id, coalesce(c.name, '—'),
         coalesce(sum(b.balance_cents) filter (where b.bucket = '0_30'), 0)::bigint,
         coalesce(sum(b.balance_cents) filter (where b.bucket = '31_60'), 0)::bigint,
         coalesce(sum(b.balance_cents) filter (where b.bucket = '61_90'), 0)::bigint,
         coalesce(sum(b.balance_cents) filter (where b.bucket = '90_plus'), 0)::bigint,
         sum(b.balance_cents)::bigint,
         coalesce(sum(b.balance_cents) filter (where b.days_past_due > 0), 0)::bigint,
         coalesce(sum(b.balance_cents) filter (where b.days_past_due <= 0), 0)::bigint,
         count(*), max(b.days_past_due)
  from public.ar_invoice_balances(target, as_of) b
  left join public.clients c on c.id = b.client_id
  where b.balance_cents > 0
  group by b.client_id, c.name
  order by 8 desc, 7 desc
$$;

-- Per client and period: opening + invoiced − collected + voided payments
-- − voided invoices = closing (checked by the tests).
create or replace function public.ar_client_report(target uuid, from_date date, to_date date)
returns table (client_id uuid, client_name text, opening_cents bigint, invoiced_cents bigint, collected_cents bigint,
               payments_voided_cents bigint, invoices_voided_cents bigint, closing_cents bigint)
language sql stable security definer set search_path = '' as $$
  with ok as (select public.has_permission(target, 'receivables.view') or (select auth.uid()) is null as yes),
  op as (select b.client_id, sum(b.balance_cents) as c from public.ar_invoice_balances(target, from_date - 1) b group by 1),
  cl as (select b.client_id, sum(b.balance_cents) as c from public.ar_invoice_balances(target, to_date) b group by 1),
  inv as (select d.client_id, sum(public.ledger_cents(d.total)) as c from public.documents d
          where d.company_id = target and d.document_type = 'invoice' and d.total > 0 and d.issue_date between from_date and to_date
            and (d.status in ('sent', 'overdue', 'paid') or (d.status = 'cancelled' and coalesce(d.metadata -> 'void' ->> 'previous_status', 'draft') <> 'draft'))
          group by 1),
  col as (select d.client_id, sum(public.ledger_cents(p.amount)) as c from public.payments p join public.documents d on d.id = p.document_id
          where p.company_id = target and (p.paid_at at time zone 'America/Puerto_Rico')::date between from_date and to_date group by 1),
  pv as (select d.client_id, sum(public.ledger_cents(p.amount)) as c from public.payments p join public.documents d on d.id = p.document_id
         where p.company_id = target and p.voided_at is not null
           and (p.voided_at at time zone 'America/Puerto_Rico')::date between from_date and to_date group by 1),
  iv as (select d.client_id, sum(public.ledger_cents(d.total)) as c from public.documents d
         where d.company_id = target and d.document_type = 'invoice' and d.status = 'cancelled' and d.total > 0
           and coalesce(d.metadata -> 'void' ->> 'previous_status', 'draft') <> 'draft'
           and ((d.metadata -> 'void' ->> 'voided_at')::timestamptz at time zone 'America/Puerto_Rico')::date between from_date and to_date group by 1),
  ids as (select client_id from op union select client_id from cl union select client_id from inv union select client_id from col
          union select client_id from pv union select client_id from iv)
  select ids.client_id, coalesce(c.name, '—'), coalesce(op.c, 0)::bigint, coalesce(inv.c, 0)::bigint, coalesce(col.c, 0)::bigint,
         coalesce(pv.c, 0)::bigint, coalesce(iv.c, 0)::bigint, coalesce(cl.c, 0)::bigint
  from ids left join public.clients c on c.id = ids.client_id
  left join op on op.client_id is not distinct from ids.client_id left join cl on cl.client_id is not distinct from ids.client_id
  left join inv on inv.client_id is not distinct from ids.client_id left join col on col.client_id is not distinct from ids.client_id
  left join pv on pv.client_id is not distinct from ids.client_id left join iv on iv.client_id is not distinct from ids.client_id
  where (select yes from ok)
  order by 8 desc, 2
$$;

-- ------------------------------------------------------------- payment void
create or replace function public.payment_void(payment uuid, reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  p public.payments;
  d record;
  why text := btrim(coalesce(reason, ''));
  orig uuid;
  eid uuid;
  paid numeric;
begin
  select * into p from public.payments where id = payment;
  if p.id is null or not public.has_permission(p.company_id, 'payments.void') then
    raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  -- Same lock as a new payment (0015): voids and payments of one invoice
  -- run one at a time.
  update public.documents set updated_at = now() where id = p.document_id
  returning id, company_id, client_id, status, total, due_date, document_number into d;
  select * into p from public.payments where id = payment;          -- re-read under the lock
  if p.voided_at is not null then
    raise exception 'PAYMENT_ALREADY_VOIDED' using errcode = 'P0001';
  end if;
  perform public.ledger_post_payment(p.id);                          -- a payment from before the ledger: its real entry first
  select e.id into orig from public.journal_entries e where e.company_id = p.company_id and e.source = 'payment' and e.source_id = p.id;
  if orig is not null then
    eid := public.ledger_post(p.company_id, greatest(public.ba_today(), (p.paid_at at time zone 'America/Puerto_Rico')::date),
             d.document_number, coalesce(p.reference, d.document_number), 'payment_void', p.id, public.ledger_mirror_lines(orig), null, orig, why);
  end if;
  update public.payments set voided_at = now(), voided_by = (select auth.uid()), void_reason = why where id = p.id;
  paid := public.invoice_paid(d.id);
  if d.status = 'paid' and paid < d.total then
    update public.documents set status = case when d.due_date is not null and d.due_date < public.ba_today() then 'overdue' else 'sent' end
     where id = d.id;
  end if;
  perform public.ar_log(p.company_id, d.client_id, d.id, 'payments', p.id::text, 'payment_voided',
    jsonb_build_object('amount_cents', public.ledger_cents(p.amount), 'reason', why, 'entry_id', eid));
  return eid;
end $$;

-- ------------------------------------------------------------- collections
create or replace function public.ar_set_status(doc uuid, new_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents := public.ar_invoice(doc, 'receivables.manage');
begin
  if new_status not in ('open', 'contacted', 'promised', 'disputed', 'escalated', 'on_hold') then
    raise exception 'STATUS_INVALID' using errcode = 'P0001';
  end if;
  insert into public.invoice_collections as c (document_id, company_id, status, updated_by) values (d.id, d.company_id, new_status, (select auth.uid()))
  on conflict (document_id) do update set status = excluded.status, updated_at = now(), updated_by = excluded.updated_by;
  perform public.ar_log(d.company_id, d.client_id, d.id, 'invoice_collections', d.id::text, 'status', jsonb_build_object('status', new_status));
end $$;

create or replace function public.ar_add_note(target uuid, client uuid, doc uuid, body text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  nid bigint;
  d public.documents;
begin
  if not public.has_permission(target, 'receivables.manage') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if doc is not null then
    d := public.ar_invoice(doc, 'receivables.manage');
    if d.company_id <> target then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
    client := coalesce(client, d.client_id);
    if client is distinct from d.client_id then raise exception 'CLIENT_INVALID' using errcode = 'P0001'; end if;
  end if;
  if client is null or not exists (select 1 from public.clients c where c.id = client and c.company_id = target) then
    raise exception 'CLIENT_INVALID' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(body, ''))) not between 1 and 2000 then
    raise exception 'NOTE_INVALID' using errcode = 'P0001';
  end if;
  insert into public.collection_notes (company_id, client_id, document_id, body, created_by)
  values (target, client, doc, btrim(body), (select auth.uid())) returning id into nid;
  perform public.ar_log(target, client, doc, 'collection_notes', nid::text, 'note', '{}');
  return nid;
end $$;

create or replace function public.ar_add_promise(doc uuid, promised_date date, amount_cents bigint, note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  d public.documents := public.ar_invoice(doc, 'receivables.manage');
  bal bigint;
  pid uuid;
begin
  bal := public.ledger_cents(d.total) - public.ledger_cents(public.invoice_paid(d.id));
  if d.status not in ('sent', 'overdue') or bal <= 0 then
    raise exception 'INVOICE_NOT_OPEN' using errcode = 'P0001';
  end if;
  if amount_cents is null or amount_cents <= 0 or amount_cents > bal then
    raise exception 'AMOUNT_INVALID' using errcode = 'P0001', hint = bal::text;
  end if;
  if promised_date is null or promised_date < public.ba_today() or promised_date > public.ba_today() + 366 then
    raise exception 'DATE_INVALID' using errcode = 'P0001';
  end if;
  insert into public.payment_promises (company_id, document_id, client_id, promised_date, amount_cents, note, created_by)
  values (d.company_id, d.id, d.client_id, promised_date, amount_cents, nullif(btrim(coalesce(note, '')), ''), (select auth.uid()))
  returning id into pid;
  insert into public.invoice_collections (document_id, company_id, status, updated_by) values (d.id, d.company_id, 'promised', (select auth.uid()))
  on conflict (document_id) do update set status = 'promised', updated_at = now(), updated_by = excluded.updated_by;
  perform public.ar_log(d.company_id, d.client_id, d.id, 'payment_promises', pid::text, 'promise',
    jsonb_build_object('date', promised_date, 'amount_cents', amount_cents));
  return pid;
end $$;

create or replace function public.ar_cancel_promise(promise uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  pr public.payment_promises;
  why text := btrim(coalesce(reason, ''));
begin
  select * into pr from public.payment_promises where id = promise for update;
  if pr.id is null or not public.has_permission(pr.company_id, 'receivables.manage') then
    raise exception 'PROMISE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if pr.status <> 'pending' then
    raise exception 'PROMISE_RESOLVED' using errcode = 'P0001';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  update public.payment_promises set status = 'cancelled', resolved_at = now(), resolved_by = (select auth.uid()), cancel_reason = why where id = pr.id;
  perform public.ar_log(pr.company_id, pr.client_id, pr.document_id, 'payment_promises', pr.id::text, 'promise_cancelled', jsonb_build_object('reason', why));
end $$;

-- Pending promises of one invoice that the payments made since they were
-- given now cover → kept.
create or replace function public.ar_resolve_promises(doc uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  pr public.payment_promises;
  n integer := 0;
begin
  for pr in select * from public.payment_promises where document_id = doc and status = 'pending' for update loop
    if (select coalesce(sum(public.ledger_cents(p.amount)), 0) from public.payments p
        where p.document_id = doc and p.voided_at is null and p.created_at >= pr.created_at) >= pr.amount_cents then
      update public.payment_promises set status = 'kept', resolved_at = now() where id = pr.id;
      perform public.ar_log(pr.company_id, pr.client_id, doc, 'payment_promises', pr.id::text, 'promise_kept', '{}');
      n := n + 1;
    elsif pr.promised_date < public.ba_today() then
      update public.payment_promises set status = 'broken', resolved_at = now() where id = pr.id;
      perform public.ar_log(pr.company_id, pr.client_id, doc, 'payment_promises', pr.id::text, 'promise_broken', '{}');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.ar_on_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.ar_resolve_promises(new.document_id);
  return null;
end $$;
drop trigger if exists ba_ar_on_payment on public.payments;
create trigger ba_ar_on_payment after insert on public.payments for each row execute function public.ar_on_payment();

-- A paid or voided invoice: its pending reminders are cancelled.
create or replace function public.ar_on_invoice_settled()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.document_type = 'invoice' and new.status in ('paid', 'cancelled') and old.status is distinct from new.status then
    update public.collection_reminders set status = 'cancelled', last_error = case when new.status = 'paid' then 'paid' else 'voided' end, updated_at = now()
     where document_id = new.id and status in ('pending', 'failed');
  end if;
  return null;
end $$;
drop trigger if exists ba_ar_invoice_settled on public.documents;
create trigger ba_ar_invoice_settled after update of status on public.documents for each row execute function public.ar_on_invoice_settled();

-- Follow-up refresh: promises (kept / broken) and the reminder outbox.
create or replace function public.ar_refresh(target uuid)
returns table (promises_resolved integer, reminders_queued integer)
language plpgsql security definer set search_path = '' as $$
declare
  s public.collection_settings;
  r record;
  n_p integer := 0;
  n_r integer := 0;
  rid uuid;
  today date := public.ba_today();
begin
  -- Users with receivables.manage; maintenance / a future scheduler (no user) too.
  if (select auth.uid()) is not null and not public.has_permission(target, 'receivables.manage') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  for r in select distinct pp.document_id from public.payment_promises pp where pp.company_id = target and pp.status = 'pending' loop
    n_p := n_p + public.ar_resolve_promises(r.document_id);
  end loop;
  select * into s from public.collection_settings where company_id = target;
  if s.company_id is not null and s.reminders_enabled then
    for r in
      select b.document_id, b.client_id, coalesce(b.due_date, b.issue_date) + o.off as on_day, o.off, c.email
      from public.ar_invoice_balances(target, today) b
      cross join unnest(s.reminder_offsets) as o(off)
      join public.documents d on d.id = b.document_id and d.status in ('sent', 'overdue')
      left join public.clients c on c.id = b.client_id
      where b.balance_cents > 0
        and coalesce(b.due_date, b.issue_date) + o.off between today - 6 and today
        and coalesce((select ic.status from public.invoice_collections ic where ic.document_id = b.document_id), 'open') not in ('disputed', 'on_hold')
    loop
      insert into public.collection_reminders (company_id, document_id, client_id, offset_days, scheduled_for, to_email, language, status)
      values (target, r.document_id, r.client_id, r.off, r.on_day, nullif(btrim(coalesce(r.email, '')), ''), s.language,
              case when nullif(btrim(coalesce(r.email, '')), '') is null then 'no_email' else 'pending' end)
      on conflict (document_id, offset_days) do nothing
      returning id into rid;
      if rid is not null then
        n_r := n_r + 1;
        perform public.ar_log(target, r.client_id, r.document_id, 'collection_reminders', rid::text, 'reminder_queued', jsonb_build_object('offset', r.off));
      end if;
      rid := null;
    end loop;
  end if;
  return query select n_p, n_r;
end $$;

-- After an attempt in the app: sent (by the email provider), sent_manual
-- (phone, message…), failed (with the error) or cancelled.
create or replace function public.ar_mark_reminder(reminder uuid, new_status text, error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare rm public.collection_reminders;
begin
  select * into rm from public.collection_reminders where id = reminder for update;
  if rm.id is null or not public.has_permission(rm.company_id, 'receivables.manage') then
    raise exception 'REMINDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if new_status not in ('sent', 'sent_manual', 'failed', 'cancelled') then
    raise exception 'STATUS_INVALID' using errcode = 'P0001';
  end if;
  if rm.status not in ('pending', 'failed', 'no_email') or (new_status = 'sent' and rm.to_email is null) then
    raise exception 'REMINDER_CLOSED' using errcode = 'P0001';
  end if;
  update public.collection_reminders
     set status = new_status, attempts = attempts + case when new_status in ('sent', 'failed') then 1 else 0 end,
         last_error = case when new_status = 'failed' then left(coalesce(error, 'error'), 500) else last_error end,
         sent_at = case when new_status in ('sent', 'sent_manual') then now() end,
         sent_by = case when new_status in ('sent', 'sent_manual') then (select auth.uid()) end, updated_at = now()
   where id = rm.id;
  perform public.ar_log(rm.company_id, rm.client_id, rm.document_id, 'collection_reminders', rm.id::text, 'reminder_' || new_status,
    case when error is not null then jsonb_build_object('error', left(error, 200)) else '{}'::jsonb end);
end $$;

create or replace function public.ar_save_settings(target uuid, enabled boolean, offsets integer[], lang text, sender text, reply text,
  msg_es text, msg_en text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_permission(target, 'receivables.manage') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  insert into public.collection_settings as s (company_id, reminders_enabled, reminder_offsets, language, sender_name, reply_to, message_es, message_en, updated_by)
  values (target, coalesce(enabled, false), (select array_agg(distinct x order by x) from unnest(offsets) x), coalesce(lang, 'es'),
          nullif(btrim(coalesce(sender, '')), ''), nullif(btrim(coalesce(reply, '')), ''), nullif(btrim(coalesce(msg_es, '')), ''),
          nullif(btrim(coalesce(msg_en, '')), ''), (select auth.uid()))
  on conflict (company_id) do update set reminders_enabled = excluded.reminders_enabled, reminder_offsets = excluded.reminder_offsets,
    language = excluded.language, sender_name = excluded.sender_name, reply_to = excluded.reply_to, message_es = excluded.message_es,
    message_en = excluded.message_en, updated_at = now(), updated_by = excluded.updated_by;
  perform public.ar_log(target, null, null, 'collection_settings', target::text, 'updated',
    jsonb_build_object('enabled', enabled, 'offsets', offsets));
end $$;

-- ------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['payment_guard()', 'ar_record_guard()', 'ar_log(uuid, uuid, uuid, text, text, text, jsonb)', 'ar_invoice(uuid, text)',
    'ar_resolve_promises(uuid)', 'ar_on_payment()', 'ar_on_invoice_settled()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['invoice_paid(uuid)', 'ar_invoice_balances(uuid, date)', 'ar_aging(uuid, date)', 'ar_client_report(uuid, date, date)',
    'payment_void(uuid, text)', 'ar_set_status(uuid, text)', 'ar_add_note(uuid, uuid, uuid, text)', 'ar_add_promise(uuid, date, bigint, text)',
    'ar_cancel_promise(uuid, text)', 'ar_refresh(uuid)', 'ar_mark_reminder(uuid, text, text)',
    'ar_save_settings(uuid, boolean, integer[], text, text, text, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
-- The guards run as the caller (maintenance included).
grant execute on function public.payment_guard(), public.ar_record_guard() to authenticated;

-- ------------------------------------------------------------- self-check
do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in
        ('ba_payment_guard', 'ba_ar_record_guard', 'ba_ar_on_payment', 'ba_ar_invoice_settled', 'ba_ar_append_only')) <> 7 then
    raise exception 'BA0025 self-check failed: triggers missing';
  end if;
  if has_table_privilege('authenticated', 'public.payments', 'UPDATE') or has_table_privilege('authenticated', 'public.payments', 'DELETE')
     or has_any_column_privilege('authenticated', 'public.payments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.payment_promises', 'INSERT')
     or has_table_privilege('authenticated', 'public.collection_reminders', 'UPDATE')
     or has_table_privilege('anon', 'public.collection_notes', 'SELECT') then
    raise exception 'BA0025 self-check failed: privileges';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key in ('receivables.view', 'receivables.manage', 'payments.void')) then
    raise exception 'BA0025 self-check failed: role matrix';
  end if;
end $$;

commit;
