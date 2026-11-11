-- =====================================================================
-- BusinessAI · Migration 0015 · Document lifecycle, payments and receipts
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Staging first, with the owner's
-- authorization (staging:migrate); Production only with its own approval.
-- Requires 0014a (has_permission and the role matrix).
--
-- 1. Consecutive numbering: when a document is inserted WITHOUT a number,
--    the database assigns <PREFIX>-<YEAR>-<0001…> per company, document
--    type and year (FAC invoice, COT quote, RCB receipt, OT work order,
--    CARTA letter, REC payment reminder). The counter lives in
--    public.document_counters and moves in the same transaction as the
--    insert, so a failed insert leaves no gap. Documents that bring their
--    own number (older app versions, imports) keep it.
-- 2. Quote statuses: 'accepted' and 'rejected' join draft / sent / paid /
--    overdue / cancelled.
-- 3. Traceability (owner decision: issued documents are voided, never
--    deleted). For signed-in users:
--      * only DRAFT documents can be deleted (DOCUMENT_ISSUED);
--      * an issued document cannot go back to draft (DOCUMENT_ISSUED);
--      * a voided (cancelled) document cannot be reopened (DOCUMENT_CANCELLED);
--      * voiding requires the new permission documents.void (owner, admin).
--    Server-side maintenance (service_role, SQL Editor: no auth.uid()) is
--    not restricted.
-- 4. Payments: only on issued invoices (sent / overdue) and never above the
--    open balance (PAYMENT_NOT_ALLOWED / PAYMENT_EXCEEDS_BALANCE), with the
--    invoice row locked so concurrent payments cannot overpay. When the
--    payments reach the total, the invoice becomes 'paid'.
-- 5. Receipts: a receipt must point to a payment of the same company
--    (metadata.payment_id) for exactly its amount; one receipt per payment.
-- 6. Roles (owner decision): the owner keeps the subscription. 'admin'
--    loses billing.manage (the app checks it on Checkout and the Portal).
--
-- Nothing is deleted or rewritten: existing documents, numbers, statuses
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

-- ------------------------------------------------- 2. consecutive numbers
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
  y integer;
  n integer;
  candidate text;
begin
  if new.document_number is not null and btrim(new.document_number) <> '' then
    return new;                                   -- number supplied: keep it
  end if;
  y := extract(year from coalesce(new.issue_date, (now() at time zone 'America/Puerto_Rico')::date))::integer;
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

-- ------------------------------------------------- 3. void permission
insert into public.permissions (key, module, description_es, description_en) values
  ('documents.void', 'documents', 'Anular documentos emitidos', 'Void issued documents')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'documents.void'), ('admin', 'documents.void')
on conflict do nothing;

-- ----------------------------------------- 4. traceability of documents
create or replace function public.protect_issued_documents()
returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is null then
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
  if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    raise exception 'DOCUMENT_CANCELLED' using errcode = 'P0001', hint = new.status;
  end if;
  if old.status <> 'draft' and new.status = 'draft' then
    raise exception 'DOCUMENT_ISSUED' using errcode = 'P0001', hint = old.status;
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled'
     and not public.has_permission(new.company_id, 'documents.void') then
    raise exception 'DOCUMENT_VOID_FORBIDDEN' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.protect_issued_documents() from public, anon, authenticated;

drop trigger if exists ba_protect_issued_documents on public.documents;
create trigger ba_protect_issued_documents before update or delete on public.documents
  for each row execute function public.protect_issued_documents();

-- ----------------------------------------------------------- 5. payments
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
  -- reject it with its usual error, revealing nothing about the invoice.
  if new.created_by is distinct from (select auth.uid())
     or not public.has_permission(new.company_id, 'payments.record') then
    return new;
  end if;
  -- Lock the invoice: concurrent payments are serialised.
  select id, company_id, document_type, status, total into d
  from public.documents where id = new.document_id for update;
  if not found or d.company_id <> new.company_id then
    return new;                                   -- RLS / the foreign key reject it as usual
  end if;
  if d.document_type <> 'invoice' or d.status not in ('sent', 'overdue') then
    raise exception 'PAYMENT_NOT_ALLOWED'
      using errcode = 'P0001', hint = d.document_type || ':' || d.status;
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

-- ----------------------------------------------------------- 6. receipts
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
  select p.company_id, p.amount into pay from public.payments p where p.id = pid::uuid;
  if not found or pay.company_id <> new.company_id then
    raise exception 'RECEIPT_PAYMENT_REQUIRED' using errcode = 'P0001';
  end if;
  if new.total <> pay.amount then
    raise exception 'RECEIPT_AMOUNT_MISMATCH' using errcode = 'P0001', hint = pay.amount::text;
  end if;
  return new;
end $$;
revoke all on function public.check_receipt() from public, anon, authenticated;

drop trigger if exists ba_check_receipt on public.documents;
create trigger ba_check_receipt before insert on public.documents
  for each row execute function public.check_receipt();

create unique index if not exists documents_receipt_payment_uidx
  on public.documents (company_id, (metadata ->> 'payment_id'))
  where document_type = 'receipt' and metadata ? 'payment_id';

-- --------------------------------------- 7. the owner keeps the billing
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
         'ba_check_payment', 'ba_settle_invoice')) <> 5 then
    raise exception 'BA0015 self-check failed: triggers missing';
  end if;
  if has_table_privilege('authenticated', 'public.document_counters', 'SELECT')
     or has_table_privilege('anon', 'public.document_counters', 'SELECT') then
    raise exception 'BA0015 self-check failed: document_counters readable by API roles';
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
