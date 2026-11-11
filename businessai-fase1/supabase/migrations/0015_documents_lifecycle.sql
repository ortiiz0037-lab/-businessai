-- =====================================================================
-- BusinessAI · Migration 0015 · Document lifecycle, payments and receipts
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Staging first, with the owner's
-- authorization (staging:migrate with this migration explicitly approved);
-- Production only with its own approval. Requires 0014a.
--
-- Revision 2 (after the independent review of 8157f87): every rule below is
-- enforced by PostgreSQL for signed-in users, whatever client writes.
-- Server-side maintenance (service_role / SQL Editor: no auth.uid()) is not
-- restricted, except that a row never changes company.
--
-- 1. Company isolation: company_id never changes on clients, documents,
--    payments, memberships, company_profiles or document_deletion_audit
--    (COMPANY_IMMUTABLE) — a user of two companies cannot move rows.
-- 2. Numbering: the database assigns <PREFIX>-<YEAR>-<0001…> per company,
--    type and year, YEAR being the creation year in Puerto Rico time. A
--    number sent by a signed-in user is ignored and replaced (old app
--    versions keep working, forged numbers are impossible). Imports without
--    a user keep their number. Nobody changes a number or a type later.
-- 3. Statuses and transitions (per type, function document_transition_allowed):
--      invoice  draft→sent, sent→overdue (only past due), sent/overdue→paid
--               (only when payments cover the total)
--      quote    draft→sent, sent→accepted, sent→rejected
--      receipt  created 'paid'
--      others   draft→sent
--      any      →cancelled (void) with documents.void and a reason;
--               an invoice with payments cannot be voided
--               (DOCUMENT_HAS_PAYMENTS: a credit note is needed).
--    New documents start as draft or sent (receipts: paid).
-- 4. Immutability: a non-draft document keeps every field; only its status
--    moves along (3), plus the void record in metadata.void, which the
--    database writes itself (reason, voided_at, voided_by, previous_status).
--    Issued documents are never deleted (DOCUMENT_ISSUED).
-- 5. Traceability: public.document_events records every creation, status
--    change, void (with reason) and draft deletion, written by a trigger;
--    readable with documents.view, writable by nobody through the API.
-- 6. Payments: only on issued invoices (sent / overdue), dated between the
--    issue date and tomorrow, never above the open balance. The payment
--    writes the invoice row first, so concurrent payments are serialised
--    under READ COMMITTED and fail with a serialization error (40001)
--    under REPEATABLE READ / SERIALIZABLE instead of overpaying.
--    payments.idempotency_key (unique per company) makes a repeated
--    submission a no-op. When payments reach the total the invoice is paid.
-- 7. Receipts: for a payment of the same company, for exactly its amount,
--    for the invoice's client; one valid receipt per payment (a voided
--    receipt can be reissued).
-- 8. Roles: documents.void (owner, admin); billing.manage owner-only.
--
-- Nothing existing is deleted or rewritten: documents, numbers, statuses
-- and payments stay as they are.
-- Rollback: supabase/rollback/0015_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------------------- 0. guards
do $$
declare
  type_def text;
begin
  if to_regprocedure('public.has_permission(uuid, text)') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.permissions') is null then
    raise exception 'BA0015: migration 0014a (permissions) must be applied first';
  end if;
  if to_regclass('public.documents') is null or to_regclass('public.payments') is null then
    raise exception 'BA0015: documents and payments must exist';
  end if;
  select string_agg(pg_get_constraintdef(c.oid), ' ') into type_def
  from pg_constraint c
  where c.conrelid = 'public.documents'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%document_type%';
  if type_def is null or type_def not ilike '%receipt%' then
    raise exception 'BA0015: documents.document_type does not accept receipt: %', coalesce(type_def, 'no check');
  end if;
end $$;

-- ----------------------------------------------------- 1. status values
do $$
declare
  r record;
begin
  for r in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.documents'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%status%'
      and pg_get_constraintdef(c.oid) ilike '%draft%'
  loop
    execute format('alter table public.documents drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.documents add constraint documents_status_check
  check (status = any (array['draft', 'sent', 'paid', 'overdue', 'cancelled', 'accepted', 'rejected']));

-- Business date (existing companies: America/Puerto_Rico).
create or replace function public.ba_today()
returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Puerto_Rico')::date
$$;
revoke all on function public.ba_today() from public, anon;
grant execute on function public.ba_today() to authenticated, service_role;

-- -------------------------------------------- 2. company never changes
create or replace function public.forbid_company_change()
returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'COMPANY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  return new;
end $$;
revoke all on function public.forbid_company_change() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['clients', 'documents', 'payments', 'memberships', 'company_profiles', 'document_deletion_audit']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists ba_company_immutable on public.%I', t);
      execute format('create trigger ba_company_immutable before update on public.%I
                        for each row execute function public.forbid_company_change()', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------- 3. consecutive numbers
create table if not exists public.document_counters (
  company_id uuid not null references public.companies(id) on delete cascade,
  document_type text not null,
  year integer not null check (year between 2000 and 2200),
  last_number integer not null default 0 check (last_number >= 0),
  updated_at timestamptz not null default now(),
  primary key (company_id, document_type, year)
);
alter table public.document_counters enable row level security;
-- Written only by the numbering trigger; no API role reads or writes it.
revoke all on public.document_counters from public, anon, authenticated;
grant all on public.document_counters to service_role;

create or replace function public.document_number_prefix(doc_type text)
returns text
language sql immutable set search_path = '' as $$
  select case doc_type
    when 'invoice' then 'FAC'
    when 'quote' then 'COT'
    when 'receipt' then 'RCB'
    when 'work_order' then 'OT'
    when 'letter' then 'CARTA'
    when 'payment_reminder' then 'REC'
    when 'contract' then 'CON'
    when 'report' then 'REP'
    else 'DOC'
  end
$$;
revoke all on function public.document_number_prefix(text) from public, anon;
grant execute on function public.document_number_prefix(text) to authenticated, service_role;

create or replace function public.assign_document_number()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  y integer;
  n integer;
  candidate text;
begin
  if uid is null then
    -- Imports / maintenance keep the number they bring.
    if new.document_number is not null and btrim(new.document_number) <> '' then
      return new;
    end if;
  elsif not public.has_permission(new.company_id, 'documents.create') then
    -- Not allowed here: touch nothing of that company; RLS rejects the row.
    return new;
  end if;
  -- A number sent by a signed-in user is never trusted: always replaced.
  y := extract(year from public.ba_today())::integer;
  loop
    insert into public.document_counters as c (company_id, document_type, year, last_number)
    values (new.company_id, new.document_type, y, 1)
    on conflict (company_id, document_type, year)
      do update set last_number = c.last_number + 1, updated_at = now()
    returning c.last_number into n;
    candidate := public.document_number_prefix(new.document_type) || '-' || y || '-'
                 || case when n < 10000 then lpad(n::text, 4, '0') else n::text end;
    -- Skip a number already taken (e.g. typed by hand before this migration).
    exit when not exists (select 1 from public.documents d
                          where d.company_id = new.company_id and d.document_number = candidate);
  end loop;
  new.document_number := candidate;
  return new;
end $$;
revoke all on function public.assign_document_number() from public, anon, authenticated;

drop trigger if exists ba_assign_document_number on public.documents;
create trigger ba_assign_document_number before insert on public.documents
  for each row execute function public.assign_document_number();

-- ------------------------------------------------- 4. void permission
insert into public.permissions (key, module, description_es, description_en) values
  ('documents.void', 'documents', 'Anular documentos emitidos', 'Void issued documents')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'documents.void'), ('admin', 'documents.void')
on conflict do nothing;

-- ---------------------------------------------------- 5. transitions
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
revoke all on function public.document_transition_allowed(text, text, text) from public, anon;
grant execute on function public.document_transition_allowed(text, text, text) to authenticated, service_role;

-- New documents: draft or sent (receipts: paid), no void record.
create or replace function public.check_document_insert()
returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if new.document_type = 'receipt' then
    if new.status <> 'paid' then
      raise exception 'RECEIPT_STATUS' using errcode = 'P0001', hint = new.status;
    end if;
  elsif new.status not in ('draft', 'sent') then
    raise exception 'DOCUMENT_STATUS_INVALID' using errcode = 'P0001', hint = new.status;
  end if;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) - 'void';
  return new;
end $$;
revoke all on function public.check_document_insert() from public, anon, authenticated;

drop trigger if exists ba_check_document_insert on public.documents;
create trigger ba_check_document_insert before insert on public.documents
  for each row execute function public.check_document_insert();

-- ----------------------------------- 6. immutability and traceability
-- SECURITY DEFINER: the payment checks must see every payment of the
-- invoice even when the user cannot read payments. It only reads the row
-- being changed (RLS already allowed the change) and its payments.
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
revoke all on function public.protect_issued_documents() from public, anon, authenticated;

drop trigger if exists ba_protect_issued_documents on public.documents;
create trigger ba_protect_issued_documents before update or delete on public.documents
  for each row execute function public.protect_issued_documents();

-- History: creations, status changes, voids and draft deletions.
create table if not exists public.document_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid not null,
  document_number text,
  document_type text,
  event text not null check (event in ('created', 'status', 'voided', 'deleted')),
  from_status text,
  to_status text,
  reason text,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists document_events_document_idx on public.document_events (document_id, created_at);
create index if not exists document_events_company_idx on public.document_events (company_id, created_at desc);
alter table public.document_events enable row level security;
revoke all on public.document_events from public, anon, authenticated;
grant select on public.document_events to authenticated;
grant all on public.document_events to service_role;
drop policy if exists ba_document_events_select on public.document_events;
create policy ba_document_events_select on public.document_events for select to authenticated
  using (public.has_permission(company_id, 'documents.view'));

create or replace function public.log_document_event()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.document_events (company_id, document_id, document_number, document_type, event, to_status, actor)
    values (new.company_id, new.id, new.document_number, new.document_type, 'created', new.status, (select auth.uid()));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into public.document_events (company_id, document_id, document_number, document_type, event,
                                          from_status, to_status, reason, actor)
      values (new.company_id, new.id, new.document_number, new.document_type,
              case when new.status = 'cancelled' then 'voided' else 'status' end,
              old.status, new.status,
              case when new.status = 'cancelled' then new.metadata -> 'void' ->> 'reason' end,
              (select auth.uid()));
    end if;
  else
    insert into public.document_events (company_id, document_id, document_number, document_type, event, from_status, actor)
    values (old.company_id, old.id, old.document_number, old.document_type, 'deleted', old.status, (select auth.uid()));
  end if;
  return null;
end $$;
revoke all on function public.log_document_event() from public, anon, authenticated;

drop trigger if exists ba_log_document_event on public.documents;
create trigger ba_log_document_event after insert or update or delete on public.documents
  for each row execute function public.log_document_event();

-- ----------------------------------------------------------- 7. payments
alter table public.payments add column if not exists idempotency_key text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_idempotency_key_check'
                   and conrelid = 'public.payments'::regclass) then
    alter table public.payments add constraint payments_idempotency_key_check
      check (idempotency_key is null or char_length(idempotency_key) between 8 and 100);
  end if;
end $$;
create unique index if not exists payments_idempotency_uidx
  on public.payments (company_id, idempotency_key) where idempotency_key is not null;

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
revoke all on function public.check_payment() from public, anon, authenticated;

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
revoke all on function public.settle_invoice() from public, anon, authenticated;

drop trigger if exists ba_check_payment on public.payments;
create trigger ba_check_payment before insert on public.payments
  for each row execute function public.check_payment();
drop trigger if exists ba_settle_invoice on public.payments;
create trigger ba_settle_invoice after insert on public.payments
  for each row execute function public.settle_invoice();

-- ----------------------------------------------------------- 8. receipts
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
revoke all on function public.check_receipt() from public, anon, authenticated;

drop trigger if exists ba_check_receipt on public.documents;
create trigger ba_check_receipt before insert on public.documents
  for each row execute function public.check_receipt();

-- One valid receipt per payment; a voided receipt can be reissued.
drop index if exists public.documents_receipt_payment_uidx;
create unique index documents_receipt_payment_uidx
  on public.documents (company_id, (metadata ->> 'payment_id'))
  where document_type = 'receipt' and status <> 'cancelled' and metadata ? 'payment_id';

-- --------------------------------------- 9. the owner keeps the billing
delete from public.role_permissions where role = 'admin' and permission_key = 'billing.manage';

-- ------------------------------------------------------------ self-check
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.documents'::regclass and conname = 'documents_status_check'
                   and pg_get_constraintdef(oid) ilike '%accepted%' and pg_get_constraintdef(oid) ilike '%rejected%') then
    raise exception 'BA0015 self-check failed: status constraint';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in
        ('ba_assign_document_number', 'ba_protect_issued_documents', 'ba_check_receipt',
         'ba_check_payment', 'ba_settle_invoice', 'ba_check_document_insert', 'ba_log_document_event')) <> 7 then
    raise exception 'BA0015 self-check failed: triggers missing';
  end if;
  if not exists (select 1 from pg_trigger where not tgisinternal and tgname = 'ba_company_immutable'
                   and tgrelid = 'public.documents'::regclass)
     or not exists (select 1 from pg_trigger where not tgisinternal and tgname = 'ba_company_immutable'
                   and tgrelid = 'public.clients'::regclass)
     or not exists (select 1 from pg_trigger where not tgisinternal and tgname = 'ba_company_immutable'
                   and tgrelid = 'public.payments'::regclass) then
    raise exception 'BA0015 self-check failed: company immutability triggers missing';
  end if;
  if has_table_privilege('authenticated', 'public.document_counters', 'SELECT')
     or has_table_privilege('anon', 'public.document_counters', 'SELECT')
     or has_table_privilege('authenticated', 'public.document_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.document_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.document_events', 'DELETE')
     or has_table_privilege('anon', 'public.document_events', 'SELECT') then
    raise exception 'BA0015 self-check failed: counters/events privileges';
  end if;
  if exists (select 1 from public.role_permissions where role = 'admin' and permission_key = 'billing.manage')
     or not exists (select 1 from public.role_permissions where role = 'owner' and permission_key = 'billing.manage') then
    raise exception 'BA0015 self-check failed: billing.manage must be owner-only';
  end if;
  if (select count(*) from public.role_permissions where permission_key = 'documents.void') <> 2
     or exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'documents.void') then
    raise exception 'BA0015 self-check failed: documents.void must be owner + admin';
  end if;
end $$;

commit;
