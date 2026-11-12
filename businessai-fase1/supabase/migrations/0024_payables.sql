-- =====================================================================
-- BusinessAI · Migration 0024 · Finance: expenses, vendors, bills, payables
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a, 0015 and 0023.
--
-- THE LEDGER (0023) STAYS THE ONLY BOOK. Bills are source documents; every
-- money effect is a journal entry posted through public.ledger_post:
--   approve bill         Dr expense / asset account of each category
--                        Cr Accounts payable                 (date: bill date)
--   pay (partial/total)  Dr Accounts payable  Cr Cash / Bank   (date: paid on)
--   void approved bill   reversal of the approval entry (only without payments)
--   void a payment       reversal of the payment entry
--   draft / pending / rejected / voided-before-approval: nothing posted.
-- One entry per event: (company, source, source_id) is unique in the
-- ledger, and every transition runs on the locked bill row.
--
-- Foreign keys between company rows are DEFERRABLE INITIALLY DEFERRED: the
-- guards refuse deleting a used vendor / category at once, while deleting a
-- whole company can remove rows in any order (cascade).
-- MODEL
--  * vendors (history = their bills, payments and events), expense
--    categories (each one points to a ledger account: expense or asset).
--  * bills + bill_lines (integer cents). A vendor invoice number is unique
--    per vendor (voided bills excepted). Editable only while draft; after
--    submission the content is frozen (rejecting returns it to draft).
--  * statuses: draft → pending_approval → approved ⇄ scheduled →
--    partially_paid → paid; voided from draft, pending, approved or
--    scheduled (approved/scheduled without payments: reversal entry).
--  * bill_payments: never above the open balance, idempotency key per
--    company, voided (with reason) instead of deleted.
--  * approval: payables.approve AND the role's approval limit
--    (approval_limits; the owner is always unlimited). The submitter does
--    not approve their own bill unless they are the owner or the company
--    allows self-approval.
--  * recurring_expenses: generation only on request, only for dates up to
--    today, one bill per (template, period) — repeated or simultaneous runs
--    never duplicate.
--  * bill_attachments + private bucket Finance-attachments: path
--    <company>/<bill>/<file>; storage policies by permission and company;
--    attachments are evidence: removable only while the bill is a draft.
--  * payables_events: append-only history with the actor.
-- ROLES: payables.view (owner, admin), payables.create (all), payables.approve
--   (all, limited by approval_limits: member has no limit row by default),
--   payables.pay and payables.manage (owner, admin), payables.settings (owner).
-- PLANS: available on Basic, Pro and Premium (no plan feature).
-- Rollback: supabase/rollback/0024_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.ledger_post(uuid, date, text, text, text, uuid, jsonb, text, uuid, text)') is null then
    raise exception 'BA0024: migration 0023 (ledger) must be applied first';
  end if;
end $$;

-- ------------------------------------------------------------ permissions
insert into public.permissions (key, module, description_es, description_en) values
  ('payables.view', 'payables', 'Ver todos los gastos, facturas de proveedores y pagos', 'View every expense, vendor bill and payment'),
  ('payables.create', 'payables', 'Registrar gastos y facturas de proveedores (borradores) y proveedores', 'Record expenses and vendor bills (drafts) and vendors'),
  ('payables.approve', 'payables', 'Aprobar gastos dentro del límite de su rol', 'Approve expenses within the limit of their role'),
  ('payables.pay', 'payables', 'Registrar y anular pagos a proveedores', 'Record and void vendor payments'),
  ('payables.manage', 'payables', 'Gestionar proveedores, categorías, recurrentes y anulaciones', 'Manage vendors, categories, recurring expenses and voids'),
  ('payables.settings', 'payables', 'Configurar límites de aprobación', 'Configure approval limits')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values
  ('owner', 'payables.view'), ('admin', 'payables.view'),
  ('owner', 'payables.create'), ('admin', 'payables.create'), ('member', 'payables.create'),
  ('owner', 'payables.approve'), ('admin', 'payables.approve'), ('member', 'payables.approve'),
  ('owner', 'payables.pay'), ('admin', 'payables.pay'),
  ('owner', 'payables.manage'), ('admin', 'payables.manage'),
  ('owner', 'payables.settings')
on conflict do nothing;

-- The ledger learns the new sources (0023 constraint widened).
alter table public.journal_entries drop constraint if exists journal_entries_source_check;
alter table public.journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'invoice', 'invoice_void', 'payment', 'reversal', 'bill', 'bill_void', 'bill_payment', 'bill_payment_void'));

-- Lines of any reversal may use an archived account (the original did).
create or replace function public.ledger_line_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  e public.journal_entries;
  a public.ledger_accounts;
begin
  select * into e from public.journal_entries where id = new.entry_id;
  if e.id is null or e.company_id <> new.company_id then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'P0001';
  end if;
  if e.posted_txid <> txid_current() then
    raise exception 'LEDGER_IMMUTABLE' using errcode = 'P0001',
      detail = 'Lines are added only when the entry is posted.';
  end if;
  select * into a from public.ledger_accounts where id = new.account_id;
  if a.id is null or a.company_id <> new.company_id then
    raise exception 'ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  if a.status <> 'active' and e.reverses_entry_id is null then
    raise exception 'ACCOUNT_ARCHIVED' using errcode = 'P0001', hint = a.code;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------- tables
create table if not exists public.payables_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  allow_self_approval boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- Who may approve how much. The owner is always unlimited (not stored).
-- No row for a role = that role cannot approve. max_cents null = unlimited.
create table if not exists public.approval_limits (
  company_id uuid not null references public.companies(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  max_cents bigint check (max_cents is null or (max_cents >= 0 and max_cents < 1000000000000000)),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (company_id, role)
);

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  tax_id text check (tax_id is null or char_length(tax_id) <= 40),
  email text check (email is null or char_length(email) <= 200),
  phone text check (phone is null or char_length(phone) <= 40),
  address text check (address is null or char_length(address) <= 400),
  notes text check (notes is null or char_length(notes) <= 1000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index if not exists vendors_name_uidx on public.vendors (company_id, lower(btrim(name)));

create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  name_en text check (name_en is null or char_length(btrim(name_en)) between 1 and 120),
  account_id uuid not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, account_id) references public.ledger_accounts (company_id, id) deferrable initially deferred
);
create unique index if not exists expense_categories_name_uidx on public.expense_categories (company_id, lower(btrim(name)));

create table if not exists public.recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vendor_id uuid not null,
  category_id uuid not null,
  description text not null check (char_length(btrim(description)) between 1 and 300),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents < 1000000000000000),
  frequency text not null check (frequency in ('weekly', 'monthly', 'quarterly', 'yearly')),
  start_date date not null,
  end_date date,
  next_date date not null,
  due_days integer not null default 0 check (due_days between 0 and 365),
  auto_submit boolean not null default false,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (end_date is null or end_date >= start_date),
  foreign key (company_id, vendor_id) references public.vendors (company_id, id) deferrable initially deferred,
  foreign key (company_id, category_id) references public.expense_categories (company_id, id) deferrable initially deferred
);

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vendor_id uuid not null,
  vendor_invoice_number text check (vendor_invoice_number is null or char_length(btrim(vendor_invoice_number)) between 1 and 60),
  bill_date date not null,
  due_date date,
  description text not null check (char_length(btrim(description)) between 1 and 300),
  notes text check (notes is null or char_length(notes) <= 1000),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  total_cents bigint not null default 0 check (total_cents >= 0),
  paid_cents bigint not null default 0 check (paid_cents >= 0),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'scheduled', 'partially_paid', 'paid', 'voided')),
  scheduled_for date,
  submitted_by uuid, submitted_at timestamptz,
  approved_by uuid, approved_at timestamptz,
  rejected_by uuid, rejected_at timestamptz, rejection_reason text,
  voided_by uuid, voided_at timestamptz, void_reason text,
  recurring_id uuid,
  recurring_period date,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (paid_cents <= total_cents),
  check (due_date is null or due_date >= bill_date),
  foreign key (company_id, vendor_id) references public.vendors (company_id, id) deferrable initially deferred,
  foreign key (company_id, recurring_id) references public.recurring_expenses (company_id, id) deferrable initially deferred
);
create unique index if not exists bills_vendor_invoice_uidx on public.bills (company_id, vendor_id, lower(btrim(vendor_invoice_number)))
  where vendor_invoice_number is not null and status <> 'voided';
create unique index if not exists bills_recurring_uidx on public.bills (recurring_id, recurring_period) where recurring_id is not null;
create unique index if not exists bills_idem_uidx on public.bills (company_id, idempotency_key) where idempotency_key is not null;
create index if not exists bills_company_status_idx on public.bills (company_id, status, due_date);
create index if not exists bills_vendor_idx on public.bills (vendor_id, bill_date desc);

create table if not exists public.bill_lines (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  bill_id uuid not null,
  line_no smallint not null check (line_no between 1 and 100),
  category_id uuid not null,
  description text check (description is null or char_length(description) <= 300),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents < 1000000000000000),
  account_id uuid,                                  -- ledger account used at approval (snapshot)
  unique (bill_id, line_no),
  foreign key (company_id, bill_id) references public.bills (company_id, id) on delete cascade,
  foreign key (company_id, category_id) references public.expense_categories (company_id, id) deferrable initially deferred
);
create index if not exists bill_lines_category_idx on public.bill_lines (category_id);

create table if not exists public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  bill_id uuid not null,
  paid_on date not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents < 1000000000000000),
  account_id uuid not null,
  method text check (method is null or method in ('cash', 'check', 'transfer', 'card', 'ach', 'other')),
  reference text check (reference is null or char_length(reference) <= 100),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_by uuid, voided_at timestamptz, void_reason text,
  unique (company_id, id),
  foreign key (company_id, bill_id) references public.bills (company_id, id) on delete cascade,
  foreign key (company_id, account_id) references public.ledger_accounts (company_id, id) deferrable initially deferred
);
create unique index if not exists bill_payments_idem_uidx on public.bill_payments (company_id, idempotency_key) where idempotency_key is not null;
create index if not exists bill_payments_bill_idx on public.bill_payments (bill_id);

create table if not exists public.bill_attachments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  bill_id uuid not null,
  storage_path text not null unique check (char_length(storage_path) <= 400),
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  foreign key (company_id, bill_id) references public.bills (company_id, id) on delete cascade
);
create index if not exists bill_attachments_bill_idx on public.bill_attachments (bill_id);

create table if not exists public.payables_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  entity text not null,
  entity_id text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists payables_events_company_idx on public.payables_events (company_id, created_at desc);
create index if not exists payables_events_entity_idx on public.payables_events (entity_id, created_at desc);

-- -------------------------------------------------------------- privileges
do $$
declare t text;
begin
  foreach t in array array['payables_settings', 'approval_limits', 'vendors', 'expense_categories', 'recurring_expenses',
                           'bills', 'bill_lines', 'bill_payments', 'bill_attachments', 'payables_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    execute format('create trigger ba_company_immutable before update on public.%I for each row execute function public.forbid_company_change()', t);
  end loop;
end $$;
grant insert (id, company_id, name, tax_id, email, phone, address, notes) on public.vendors to authenticated;
grant update (name, tax_id, email, phone, address, notes, status) on public.vendors to authenticated;
grant delete on public.vendors to authenticated;
grant insert (id, company_id, name, name_en, account_id) on public.expense_categories to authenticated;
grant update (name, name_en, account_id, status) on public.expense_categories to authenticated;
grant delete on public.expense_categories to authenticated;
grant insert (id, company_id, vendor_id, category_id, description, amount_cents, frequency, start_date, end_date, due_days, auto_submit) on public.recurring_expenses to authenticated;
grant update (vendor_id, category_id, description, amount_cents, end_date, due_days, auto_submit, status) on public.recurring_expenses to authenticated;
grant delete on public.recurring_expenses to authenticated;
grant insert (id, company_id, vendor_id, vendor_invoice_number, bill_date, due_date, description, notes, idempotency_key) on public.bills to authenticated;
grant update (vendor_id, vendor_invoice_number, bill_date, due_date, description, notes) on public.bills to authenticated;
grant delete on public.bills to authenticated;
grant insert (company_id, bill_id, line_no, category_id, description, amount_cents) on public.bill_lines to authenticated;
grant update (category_id, description, amount_cents) on public.bill_lines to authenticated;
grant delete on public.bill_lines to authenticated;
grant insert (company_id, bill_id, storage_path, file_name, content_type, size_bytes) on public.bill_attachments to authenticated;
grant delete on public.bill_attachments to authenticated;

-- Visibility of a bill: every bill with payables.view; one's own with payables.create.
create or replace function public.bill_visible(bill uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bills b where b.id = bill
                 and (public.has_permission(b.company_id, 'payables.view')
                      or (public.has_permission(b.company_id, 'payables.create') and b.created_by = (select auth.uid()))))
$$;

do $$
declare t text;
begin
  foreach t in array array['payables_settings', 'approval_limits', 'vendors', 'expense_categories'] loop
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
    execute format('create policy ba_%s_select on public.%I for select to authenticated using (public.has_permission(company_id, ''payables.view'') or public.has_permission(company_id, ''payables.create''))', t, t);
  end loop;
  foreach t in array array['recurring_expenses', 'bill_payments', 'payables_events'] loop
    execute format('drop policy if exists ba_%s_select on public.%I', t, t);
    execute format('create policy ba_%s_select on public.%I for select to authenticated using (public.has_permission(company_id, ''payables.view''))', t, t);
  end loop;
end $$;
drop policy if exists ba_vendors_insert on public.vendors;
create policy ba_vendors_insert on public.vendors for insert to authenticated with check (public.has_permission(company_id, 'payables.create'));
drop policy if exists ba_vendors_update on public.vendors;
create policy ba_vendors_update on public.vendors for update to authenticated
  using (public.has_permission(company_id, 'payables.manage')) with check (public.has_permission(company_id, 'payables.manage'));
drop policy if exists ba_vendors_delete on public.vendors;
create policy ba_vendors_delete on public.vendors for delete to authenticated using (public.has_permission(company_id, 'payables.manage'));
drop policy if exists ba_expense_categories_write on public.expense_categories;
drop policy if exists ba_expense_categories_insert on public.expense_categories;
create policy ba_expense_categories_insert on public.expense_categories for insert to authenticated with check (public.has_permission(company_id, 'payables.manage'));
drop policy if exists ba_expense_categories_update on public.expense_categories;
create policy ba_expense_categories_update on public.expense_categories for update to authenticated
  using (public.has_permission(company_id, 'payables.manage')) with check (public.has_permission(company_id, 'payables.manage'));
drop policy if exists ba_expense_categories_delete on public.expense_categories;
create policy ba_expense_categories_delete on public.expense_categories for delete to authenticated using (public.has_permission(company_id, 'payables.manage'));
drop policy if exists ba_recurring_expenses_insert on public.recurring_expenses;
create policy ba_recurring_expenses_insert on public.recurring_expenses for insert to authenticated with check (public.has_permission(company_id, 'payables.manage'));
drop policy if exists ba_recurring_expenses_update on public.recurring_expenses;
create policy ba_recurring_expenses_update on public.recurring_expenses for update to authenticated
  using (public.has_permission(company_id, 'payables.manage')) with check (public.has_permission(company_id, 'payables.manage'));
drop policy if exists ba_recurring_expenses_delete on public.recurring_expenses;
create policy ba_recurring_expenses_delete on public.recurring_expenses for delete to authenticated using (public.has_permission(company_id, 'payables.manage'));

drop policy if exists ba_bills_select on public.bills;
create policy ba_bills_select on public.bills for select to authenticated
  using (public.has_permission(company_id, 'payables.view') or (public.has_permission(company_id, 'payables.create') and created_by = (select auth.uid())));
drop policy if exists ba_bills_insert on public.bills;
create policy ba_bills_insert on public.bills for insert to authenticated
  with check (public.has_permission(company_id, 'payables.create'));
drop policy if exists ba_bills_update on public.bills;
create policy ba_bills_update on public.bills for update to authenticated
  using (public.has_permission(company_id, 'payables.manage') or (public.has_permission(company_id, 'payables.create') and created_by = (select auth.uid())))
  with check (public.has_permission(company_id, 'payables.manage') or (public.has_permission(company_id, 'payables.create') and created_by = (select auth.uid())));
drop policy if exists ba_bills_delete on public.bills;
create policy ba_bills_delete on public.bills for delete to authenticated
  using (public.has_permission(company_id, 'payables.manage') or (public.has_permission(company_id, 'payables.create') and created_by = (select auth.uid())));
drop policy if exists ba_bill_lines_select on public.bill_lines;
create policy ba_bill_lines_select on public.bill_lines for select to authenticated using (public.bill_visible(bill_id));
drop policy if exists ba_bill_lines_write on public.bill_lines;
create policy ba_bill_lines_write on public.bill_lines for all to authenticated
  using (public.bill_visible(bill_id) and exists (select 1 from public.bills b where b.id = bill_id and b.company_id = bill_lines.company_id
         and (public.has_permission(b.company_id, 'payables.manage') or b.created_by = (select auth.uid()))))
  with check (public.bill_visible(bill_id) and exists (select 1 from public.bills b where b.id = bill_id and b.company_id = bill_lines.company_id
         and (public.has_permission(b.company_id, 'payables.manage') or b.created_by = (select auth.uid()))));
drop policy if exists ba_bill_attachments_select on public.bill_attachments;
create policy ba_bill_attachments_select on public.bill_attachments for select to authenticated using (public.bill_visible(bill_id));
drop policy if exists ba_bill_attachments_insert on public.bill_attachments;
create policy ba_bill_attachments_insert on public.bill_attachments for insert to authenticated
  with check (public.bill_visible(bill_id) and storage_path like company_id::text || '/' || bill_id::text || '/%');
drop policy if exists ba_bill_attachments_delete on public.bill_attachments;
create policy ba_bill_attachments_delete on public.bill_attachments for delete to authenticated using (public.bill_visible(bill_id));

-- ---------------------------------------------------------------- helpers
create or replace function public.payables_log(target uuid, ent text, ent_id text, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.payables_events (company_id, entity, entity_id, action, details, actor)
  values (target, ent, ent_id, act, coalesce(info, '{}'::jsonb), (select auth.uid()))
$$;

-- Ledger chart, settings, approval limits and default categories.
create or replace function public.payables_ensure(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.payables_settings s where s.company_id = target) then return; end if;
  perform public.ledger_ensure_chart(target);
  insert into public.payables_settings (company_id) values (target) on conflict do nothing;
  if not found then return; end if;
  insert into public.approval_limits (company_id, role, max_cents) values (target, 'admin', null) on conflict do nothing;
  insert into public.expense_categories (company_id, name, name_en, account_id)
  select target, v.name, v.name_en, a.id
  from (values ('Materiales y costo de ventas', 'Materials and cost of sales', '5000'),
               ('Gastos generales', 'General expenses', '6000'),
               ('Alquiler', 'Rent', '6200'),
               ('Servicios públicos', 'Utilities', '6300'),
               ('Equipo (activo)', 'Equipment (asset)', '1500')) v(name, name_en, code)
  join public.ledger_accounts a on a.company_id = target and a.code = v.code and a.status = 'active'
  on conflict do nothing;
  perform public.payables_log(target, 'payables', target::text, 'initialized', '{}');
end $$;

create or replace function public.payables_init(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_permission(target, 'payables.manage') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  perform public.payables_ensure(target);
end $$;

-- Helpers for the triggers that run as the caller (SECURITY INVOKER).
create or replace function public.payables_company_gone(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.companies c where c.id = target)
$$;
create or replace function public.ledger_base_currency(target uuid)
returns text language sql stable security definer set search_path = '' as $$
  select s.base_currency from public.ledger_settings s where s.company_id = target
$$;
create or replace function public.bill_status(bill uuid)
returns text language sql stable security definer set search_path = '' as $$
  select b.status from public.bills b where b.id = bill
$$;
create or replace function public.category_active(category uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select c.status = 'active' from public.expense_categories c where c.id = category), false)
$$;
create or replace function public.category_in_company(category uuid, target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.expense_categories c where c.id = category and c.company_id = target)
$$;

-- ------------------------------------------------------- guards (tables)
-- Vendors: never deleted while they have bills or recurring templates.
create or replace function public.vendor_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if public.ledger_company_gone(old.company_id) then return old; end if;
    if exists (select 1 from public.bills b where b.vendor_id = old.id)
       or exists (select 1 from public.recurring_expenses r where r.vendor_id = old.id) then
      raise exception 'VENDOR_IN_USE' using errcode = 'P0001', detail = 'A vendor with bills is archived, not deleted.';
    end if;
    return old;
  end if;
  if new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
    raise exception 'VENDOR_FIELD_LOCKED' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ba_vendor_guard on public.vendors;
create trigger ba_vendor_guard before insert or update or delete on public.vendors for each row execute function public.vendor_guard();

create or replace function public.category_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare a public.ledger_accounts;
begin
  if tg_op = 'DELETE' then
    if public.ledger_company_gone(old.company_id) then return old; end if;
    if exists (select 1 from public.bill_lines l where l.category_id = old.id)
       or exists (select 1 from public.recurring_expenses r where r.category_id = old.id) then
      raise exception 'CATEGORY_IN_USE' using errcode = 'P0001', detail = 'A category in use is archived, not deleted.';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
  elsif new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
    raise exception 'CATEGORY_FIELD_LOCKED' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' or new.account_id <> old.account_id then
    select * into a from public.ledger_accounts where id = new.account_id;
    if a.id is null or a.company_id <> new.company_id or a.status <> 'active' or a.type not in ('expense', 'asset') then
      raise exception 'CATEGORY_ACCOUNT_INVALID' using errcode = 'P0001',
        detail = 'A category posts to an active expense or asset account of the company.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ba_category_guard on public.expense_categories;
create trigger ba_category_guard before insert or update or delete on public.expense_categories for each row execute function public.category_guard();

-- Bills. SECURITY INVOKER on purpose: current_user tells a user's direct
-- write ('authenticated') from the 0024 functions (definer).
create or replace function public.bill_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  direct boolean := current_user = 'authenticated';
  workflow text[] := array['status', 'paid_cents', 'scheduled_for', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at',
                           'rejected_by', 'rejected_at', 'rejection_reason', 'voided_by', 'voided_at', 'void_reason', 'updated_at', 'total_cents'];
begin
  if tg_op = 'INSERT' then
    if direct or (select auth.uid()) is not null then
      new.created_by := (select auth.uid());
      if direct then
        new.status := 'draft'; new.paid_cents := 0; new.total_cents := 0;
        new.recurring_id := null; new.recurring_period := null;
      end if;
    end if;
    new.created_at := now(); new.updated_at := now();
    if new.due_date is null then new.due_date := new.bill_date; end if;
    new.currency := coalesce(public.ledger_base_currency(new.company_id), 'USD');
    return new;
  end if;
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    if old.status <> 'draft' then
      raise exception 'BILL_NOT_DRAFT' using errcode = 'P0001', hint = old.status,
        detail = 'Submitted bills are voided, not deleted.';
    end if;
    return old;
  end if;
  -- identity never changes
  if new.id <> old.id or new.created_by is distinct from old.created_by or new.created_at <> old.created_at
     or new.currency <> old.currency or new.recurring_id is distinct from old.recurring_id
     or new.recurring_period is distinct from old.recurring_period or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'BILL_FIELD_LOCKED' using errcode = 'P0001';
  end if;
  if old.status = 'voided' then
    raise exception 'BILL_VOIDED' using errcode = 'P0001';
  end if;
  -- After submission the content is frozen for everyone (maintenance too).
  if old.status <> 'draft' and (to_jsonb(new) - workflow) <> (to_jsonb(old) - workflow) then
    raise exception 'BILL_LOCKED' using errcode = 'P0001', hint = old.status,
      detail = 'A submitted bill is not edited; reject it back to draft or void it.';
  end if;
  if old.status <> 'draft' and new.total_cents <> old.total_cents then
    raise exception 'BILL_LOCKED' using errcode = 'P0001', hint = old.status;
  end if;
  -- Workflow fields only through the 0024 functions.
  if direct and (to_jsonb(new) - array['vendor_id', 'vendor_invoice_number', 'bill_date', 'due_date', 'description', 'notes', 'updated_at'])
                <> (to_jsonb(old) - array['vendor_id', 'vendor_invoice_number', 'bill_date', 'due_date', 'description', 'notes', 'updated_at']) then
    raise exception 'BILL_FIELD_LOCKED' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ba_bill_guard on public.bills;
create trigger ba_bill_guard before insert or update or delete on public.bills for each row execute function public.bill_guard();

-- Lines: only while the bill is a draft (the approval snapshot of the
-- ledger account excepted). Keeps total_cents = sum of lines.
create or replace function public.bill_line_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  r public.bill_lines := coalesce(new, old);
  st text;
begin
  st := public.bill_status(r.bill_id);
  if tg_op = 'DELETE' and (st is null or public.payables_company_gone(old.company_id)) then
    return old;                                   -- the bill (draft) or the company is being deleted
  end if;
  if tg_op = 'UPDATE' and st = 'pending_approval' and current_user <> 'authenticated'
     and old.account_id is null and new.account_id is not null
     and (to_jsonb(new) - 'account_id') = (to_jsonb(old) - 'account_id') then
    return new;                                   -- approval records the ledger account used
  end if;
  if st is distinct from 'draft' then
    raise exception 'BILL_LOCKED' using errcode = 'P0001', hint = coalesce(st, 'missing');
  end if;
  if tg_op <> 'DELETE' then
    if not public.category_in_company(new.category_id, new.company_id) then
      raise exception 'CATEGORY_INVALID' using errcode = 'P0001';
    end if;
    if not public.category_active(new.category_id) and (tg_op = 'INSERT' or new.category_id <> old.category_id) then
      raise exception 'CATEGORY_ARCHIVED' using errcode = 'P0001';
    end if;
    if current_user = 'authenticated' then new.account_id := null; end if;
    return new;
  end if;
  return old;
end $$;
drop trigger if exists ba_bill_line_guard on public.bill_lines;
create trigger ba_bill_line_guard before insert or update or delete on public.bill_lines for each row execute function public.bill_line_guard();

create or replace function public.bill_line_total()
returns trigger language plpgsql security definer set search_path = '' as $$
declare bid uuid := coalesce(new.bill_id, old.bill_id);
begin
  update public.bills b set total_cents = coalesce((select sum(l.amount_cents) from public.bill_lines l where l.bill_id = bid), 0)
   where b.id = bid and b.status = 'draft';
  return null;
end $$;
drop trigger if exists ba_bill_line_total on public.bill_lines;
create trigger ba_bill_line_total after insert or update or delete on public.bill_lines for each row execute function public.bill_line_total();

-- Payments: rows change only through the functions (void fields once).
create or replace function public.bill_payment_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.payables_company_gone(old.company_id) then return old; end if;
    raise exception 'PAYMENT_IMMUTABLE' using errcode = 'P0001', detail = 'Vendor payments are voided, not deleted.';
  end if;
  if old.voided_at is not null
     or (to_jsonb(new) - array['voided_by', 'voided_at', 'void_reason']) <> (to_jsonb(old) - array['voided_by', 'voided_at', 'void_reason'])
     or new.voided_at is null then
    raise exception 'PAYMENT_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_bill_payment_guard on public.bill_payments;
create trigger ba_bill_payment_guard before update or delete on public.bill_payments for each row execute function public.bill_payment_guard();

-- Attachments: evidence. Removed only while the bill is a draft.
create or replace function public.bill_attachment_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  select b.status into st from public.bills b where b.id = coalesce(new.bill_id, old.bill_id);
  if tg_op = 'INSERT' then
    if st is null or st = 'voided' then
      raise exception 'BILL_VOIDED' using errcode = 'P0001';
    end if;
    new.uploaded_by := coalesce((select auth.uid()), new.uploaded_by);
    new.created_at := now();
    if (select auth.uid()) is not null and not exists (
         select 1 from storage.objects o where o.bucket_id = 'Finance-attachments' and o.name = new.storage_path) then
      raise exception 'ATTACHMENT_FILE_MISSING' using errcode = 'P0001';
    end if;
    perform public.payables_log(new.company_id, 'bills', new.bill_id::text, 'attachment_added', jsonb_build_object('file', new.file_name));
    return new;
  end if;
  if st is null or public.ledger_company_gone(old.company_id) then return old; end if;
  if st <> 'draft' then
    raise exception 'ATTACHMENT_LOCKED' using errcode = 'P0001', detail = 'Attachments of a submitted bill are kept as evidence.';
  end if;
  perform public.payables_log(old.company_id, 'bills', old.bill_id::text, 'attachment_removed', jsonb_build_object('file', old.file_name));
  return old;
end $$;
drop trigger if exists ba_bill_attachment_guard on public.bill_attachments;
create trigger ba_bill_attachment_guard before insert or delete on public.bill_attachments for each row execute function public.bill_attachment_guard();

create or replace function public.recurring_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.ledger_company_gone(old.company_id) then return old; end if;
    if exists (select 1 from public.bills b where b.recurring_id = old.id) then
      raise exception 'RECURRING_IN_USE' using errcode = 'P0001', detail = 'A template that generated bills is paused, not deleted.';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
    new.next_date := new.start_date;
  elsif new.start_date <> old.start_date or new.frequency <> old.frequency or new.created_by is distinct from old.created_by then
    raise exception 'RECURRING_FIELD_LOCKED' using errcode = 'P0001';
  elsif current_user = 'authenticated' and new.next_date <> old.next_date then
    raise exception 'RECURRING_FIELD_LOCKED' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ba_recurring_guard on public.recurring_expenses;
create trigger ba_recurring_guard before insert or update or delete on public.recurring_expenses for each row execute function public.recurring_guard();

-- History of vendors and categories.
create or replace function public.payables_row_log()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  if public.ledger_company_gone((r ->> 'company_id')::uuid) then return null; end if;
  perform public.payables_log((r ->> 'company_id')::uuid, tg_table_name, r ->> 'id',
    case tg_op when 'INSERT' then 'created' when 'DELETE' then 'deleted' else 'updated' end,
    jsonb_build_object('name', coalesce(r ->> 'name', r ->> 'description'), 'status', r ->> 'status'));
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['vendors', 'expense_categories', 'recurring_expenses'] loop
    execute format('drop trigger if exists ba_payables_row_log on public.%I', t);
    execute format('create trigger ba_payables_row_log after insert or update or delete on public.%I for each row execute function public.payables_row_log()', t);
  end loop;
end $$;

-- Draft bills (inserted / deleted) are logged too.
create or replace function public.bill_row_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.payables_log(new.company_id, 'bills', new.id::text, 'created',
      jsonb_build_object('vendor_id', new.vendor_id, 'recurring_id', new.recurring_id, 'period', new.recurring_period));
  elsif not public.ledger_company_gone(old.company_id) then
    perform public.payables_log(old.company_id, 'bills', old.id::text, 'deleted', jsonb_build_object('status', old.status));
  end if;
  return null;
end $$;
drop trigger if exists ba_bill_row_log on public.bills;
create trigger ba_bill_row_log after insert or delete on public.bills for each row execute function public.bill_row_log();

-- Append-only history (only a company cascade removes it).
drop trigger if exists ba_payables_append_only on public.payables_events;
create trigger ba_payables_append_only before update or delete on public.payables_events for each row execute function public.ledger_append_only();
drop trigger if exists ba_payables_no_truncate on public.payables_events;
create trigger ba_payables_no_truncate before truncate on public.payables_events for each statement execute function public.ledger_no_truncate();
drop trigger if exists ba_payables_no_truncate on public.bill_payments;
create trigger ba_payables_no_truncate before truncate on public.bill_payments for each statement execute function public.ledger_no_truncate();

-- ---------------------------------------------------------------- workflow
create or replace function public.payables_role(target uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m
  where m.company_id = target and m.user_id = (select auth.uid()) and m.status = 'active'
$$;

-- Largest amount the caller may approve (null = unlimited, -1 = none).
create or replace function public.payables_approval_limit(target uuid)
returns bigint language plpgsql stable security definer set search_path = '' as $$
declare
  r text := public.payables_role(target);
  lim public.approval_limits;
begin
  if r is null or not public.has_permission(target, 'payables.approve') then return -1; end if;
  if r = 'owner' then return null; end if;
  select * into lim from public.approval_limits where company_id = target and role = r;
  if lim.company_id is null then return -1; end if;
  return lim.max_cents;
end $$;

create or replace function public.bill_lock(bill uuid)
returns public.bills language plpgsql security definer set search_path = '' as $$
declare b public.bills;
begin
  select * into b from public.bills where id = bill for update;
  if b.id is null or not public.bill_visible(bill) then
    raise exception 'BILL_NOT_FOUND' using errcode = 'P0001';
  end if;
  return b;
end $$;

-- A draft and its lines in one transaction (create or replace the lines).
-- lines: [{"category_id": uuid, "description": text, "amount_cents": "integer"}]
create or replace function public.bill_save_draft(target uuid, bill uuid, vendor uuid, invoice_number text, bill_date date, due_date date,
  description text, notes text, lines jsonb, idempotency_key text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  b public.bills;
  bid uuid := bill;
  ln jsonb;
  i integer := 0;
begin
  if not public.has_permission(target, 'payables.create') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) < 1 or jsonb_array_length(lines) > 100 then
    raise exception 'BILL_EMPTY' using errcode = 'P0001';
  end if;
  for ln in select * from jsonb_array_elements(lines) loop
    if coalesce(ln ->> 'amount_cents', '') !~ '^[0-9]{1,15}$' or (ln ->> 'amount_cents')::bigint <= 0 then
      raise exception 'AMOUNT_INVALID' using errcode = 'P0001';
    end if;
  end loop;
  if not exists (select 1 from public.vendors v where v.id = vendor and v.company_id = target and v.status = 'active') then
    raise exception 'VENDOR_INVALID' using errcode = 'P0001';
  end if;
  if bid is null then
    if idempotency_key is not null then
      select x.id into bid from public.bills x where x.company_id = target and x.idempotency_key = idempotency_key;
      if bid is not null then return bid; end if;        -- the same form again
    end if;
    insert into public.bills (company_id, vendor_id, vendor_invoice_number, bill_date, due_date, description, notes, idempotency_key)
    values (target, vendor, nullif(btrim(coalesce(invoice_number, '')), ''), bill_date, due_date, btrim(description),
            nullif(btrim(coalesce(notes, '')), ''), idempotency_key)
    returning id into bid;
  else
    b := public.bill_lock(bid);
    if b.company_id <> target or not (public.has_permission(target, 'payables.manage') or b.created_by = (select auth.uid())) then
      raise exception 'FORBIDDEN' using errcode = 'P0001';
    end if;
    if b.status <> 'draft' then
      raise exception 'BILL_LOCKED' using errcode = 'P0001', hint = b.status;
    end if;
    update public.bills x set vendor_id = vendor, vendor_invoice_number = nullif(btrim(coalesce(invoice_number, '')), ''),
           bill_date = bill_save_draft.bill_date, due_date = bill_save_draft.due_date, description = btrim(bill_save_draft.description),
           notes = nullif(btrim(coalesce(bill_save_draft.notes, '')), '')
     where x.id = bid;
    delete from public.bill_lines l where l.bill_id = bid;
  end if;
  for ln in select * from jsonb_array_elements(lines) loop
    i := i + 1;
    insert into public.bill_lines (company_id, bill_id, line_no, category_id, description, amount_cents)
    values (target, bid, i, (ln ->> 'category_id')::uuid, nullif(btrim(coalesce(ln ->> 'description', '')), ''), (ln ->> 'amount_cents')::bigint);
  end loop;
  return bid;
end $$;

create or replace function public.bill_submit(bill uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bills := public.bill_lock(bill);
begin
  if not (public.has_permission(b.company_id, 'payables.manage')
          or (public.has_permission(b.company_id, 'payables.create') and b.created_by = (select auth.uid()))) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if b.status <> 'draft' then
    raise exception 'BILL_TRANSITION' using errcode = 'P0001', hint = b.status || '->pending_approval';
  end if;
  if b.total_cents <= 0 or not exists (select 1 from public.bill_lines l where l.bill_id = b.id) then
    raise exception 'BILL_EMPTY' using errcode = 'P0001';
  end if;
  update public.bills set status = 'pending_approval', submitted_by = (select auth.uid()), submitted_at = now(),
         rejected_by = null, rejected_at = null, rejection_reason = null
   where id = b.id;
  perform public.payables_log(b.company_id, 'bills', b.id::text, 'submitted', jsonb_build_object('total_cents', b.total_cents));
end $$;

create or replace function public.bill_approve(bill uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  b public.bills := public.bill_lock(bill);
  lim bigint;
  self_ok boolean;
  ln jsonb;
  eid uuid;
begin
  if b.status <> 'pending_approval' then
    raise exception 'BILL_TRANSITION' using errcode = 'P0001', hint = b.status || '->approved';
  end if;
  lim := public.payables_approval_limit(b.company_id);
  if lim = -1 then
    raise exception 'APPROVAL_FORBIDDEN' using errcode = 'P0001';
  end if;
  if lim is not null and b.total_cents > lim then
    raise exception 'APPROVAL_LIMIT_EXCEEDED' using errcode = 'P0001', hint = lim::text;
  end if;
  select coalesce(s.allow_self_approval, false) into self_ok from public.payables_settings s where s.company_id = b.company_id;
  if (b.submitted_by = (select auth.uid()) or b.created_by = (select auth.uid()))
     and public.payables_role(b.company_id) <> 'owner' and not coalesce(self_ok, false) then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0001';
  end if;
  -- Snapshot of the ledger account of each line, then one entry:
  -- Dr each account (summed) / Cr accounts payable.
  update public.bill_lines l set account_id = c.account_id
    from public.expense_categories c where c.id = l.category_id and l.bill_id = b.id;
  select jsonb_agg(jsonb_build_object('account', x.account_id, 'debit', x.cents, 'document_id', b.id) order by x.first_line) into ln
  from (select l.account_id, sum(l.amount_cents) as cents, min(l.line_no) as first_line
        from public.bill_lines l where l.bill_id = b.id group by l.account_id) x;
  ln := ln || jsonb_build_array(jsonb_build_object('key', 'accounts_payable', 'credit', b.total_cents, 'document_id', b.id));
  eid := public.ledger_post(b.company_id, b.bill_date, b.description,
           coalesce(b.vendor_invoice_number, (select v.name from public.vendors v where v.id = b.vendor_id)), 'bill', b.id, ln);
  if eid is null then
    raise exception 'BILL_ALREADY_POSTED' using errcode = 'P0001';
  end if;
  update public.bills set status = case when scheduled_for is not null then 'scheduled' else 'approved' end,
         approved_by = (select auth.uid()), approved_at = now()
   where id = b.id;
  perform public.payables_log(b.company_id, 'bills', b.id::text, 'approved', jsonb_build_object('entry_id', eid, 'total_cents', b.total_cents));
  return eid;
end $$;

create or replace function public.bill_reject(bill uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b public.bills := public.bill_lock(bill);
  why text := btrim(coalesce(reason, ''));
begin
  if b.status <> 'pending_approval' then
    raise exception 'BILL_TRANSITION' using errcode = 'P0001', hint = b.status || '->draft';
  end if;
  if public.payables_approval_limit(b.company_id) = -1 then
    raise exception 'APPROVAL_FORBIDDEN' using errcode = 'P0001';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  update public.bills set status = 'draft', rejected_by = (select auth.uid()), rejected_at = now(), rejection_reason = why,
         submitted_by = null, submitted_at = null
   where id = b.id;
  perform public.payables_log(b.company_id, 'bills', b.id::text, 'rejected', jsonb_build_object('reason', why));
end $$;

create or replace function public.bill_schedule(bill uuid, pay_on date)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bills := public.bill_lock(bill);
begin
  if not public.has_permission(b.company_id, 'payables.pay') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if b.status not in ('approved', 'scheduled', 'partially_paid') then
    raise exception 'BILL_TRANSITION' using errcode = 'P0001', hint = b.status || '->scheduled';
  end if;
  if pay_on is not null and pay_on < public.ba_today() then
    raise exception 'DATE_INVALID' using errcode = 'P0001';
  end if;
  update public.bills set scheduled_for = pay_on,
         status = case when b.status = 'partially_paid' then 'partially_paid' when pay_on is null then 'approved' else 'scheduled' end
   where id = b.id;
  perform public.payables_log(b.company_id, 'bills', b.id::text, 'scheduled', jsonb_build_object('pay_on', pay_on));
end $$;

create or replace function public.bill_pay(bill uuid, amount_cents bigint, paid_on date, account uuid,
  method text default null, reference text default null, idempotency_key text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  b public.bills := public.bill_lock(bill);
  a public.ledger_accounts;
  pid uuid;
  eid uuid;
  newpaid bigint;
begin
  if not public.has_permission(b.company_id, 'payables.pay') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if idempotency_key is not null then
    select p.id into pid from public.bill_payments p where p.company_id = b.company_id and p.idempotency_key = idempotency_key;
    if pid is not null then return pid; end if;   -- the same submission again
  end if;
  if b.status not in ('approved', 'scheduled', 'partially_paid') then
    raise exception 'BILL_NOT_PAYABLE' using errcode = 'P0001', hint = b.status;
  end if;
  if amount_cents is null or amount_cents <= 0 then
    raise exception 'AMOUNT_INVALID' using errcode = 'P0001';
  end if;
  if b.paid_cents + amount_cents > b.total_cents then
    raise exception 'PAYMENT_EXCEEDS_BALANCE' using errcode = 'P0001', hint = (b.total_cents - b.paid_cents)::text;
  end if;
  if paid_on is null or paid_on > public.ba_today() + 1 then
    raise exception 'DATE_INVALID' using errcode = 'P0001';
  end if;
  select * into a from public.ledger_accounts where id = account;
  -- Paid from cash or from an asset account of the company's own (bank…).
  if a.id is null or a.company_id <> b.company_id or a.type <> 'asset' or a.status <> 'active'
     or (a.system_key is not null and a.system_key <> 'cash') then
    raise exception 'PAYMENT_ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  insert into public.bill_payments (company_id, bill_id, paid_on, amount_cents, account_id, method, reference, idempotency_key, created_by)
  values (b.company_id, b.id, paid_on, amount_cents, a.id, method, nullif(btrim(coalesce(reference, '')), ''), idempotency_key, (select auth.uid()))
  returning id into pid;
  eid := public.ledger_post(b.company_id, paid_on, b.description,
    coalesce(nullif(btrim(coalesce(reference, '')), ''), b.vendor_invoice_number), 'bill_payment', pid,
    jsonb_build_array(jsonb_build_object('key', 'accounts_payable', 'debit', amount_cents, 'document_id', b.id),
                      jsonb_build_object('account', a.id, 'credit', amount_cents, 'document_id', b.id)));
  newpaid := b.paid_cents + amount_cents;
  update public.bills set paid_cents = newpaid,
         status = case when newpaid = b.total_cents then 'paid' else 'partially_paid' end
   where id = b.id;
  perform public.payables_log(b.company_id, 'bills', b.id::text, 'paid',
    jsonb_build_object('payment_id', pid, 'entry_id', eid, 'amount_cents', amount_cents, 'paid_cents', newpaid));
  return pid;
end $$;

create or replace function public.bill_payment_void(payment uuid, reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  p public.bill_payments;
  b public.bills;
  orig uuid;
  eid uuid;
  why text := btrim(coalesce(reason, ''));
  newpaid bigint;
begin
  select * into p from public.bill_payments where id = payment;
  if p.id is null or not public.has_permission(p.company_id, 'payables.pay') then
    raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  b := public.bill_lock(p.bill_id);
  select * into p from public.bill_payments where id = payment;   -- re-read under the bill lock
  if p.voided_at is not null then
    raise exception 'PAYMENT_ALREADY_VOIDED' using errcode = 'P0001';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  select e.id into orig from public.journal_entries e where e.company_id = p.company_id and e.source = 'bill_payment' and e.source_id = p.id;
  eid := public.ledger_post(p.company_id, greatest(public.ba_today(), p.paid_on), b.description, p.reference, 'bill_payment_void', p.id,
           public.ledger_mirror_lines(orig), null, orig, why);
  update public.bill_payments set voided_by = (select auth.uid()), voided_at = now(), void_reason = why where id = p.id;
  newpaid := b.paid_cents - p.amount_cents;
  update public.bills set paid_cents = newpaid,
         status = case when newpaid > 0 then 'partially_paid' when scheduled_for is not null then 'scheduled' else 'approved' end
   where id = b.id;
  perform public.payables_log(b.company_id, 'bills', b.id::text, 'payment_voided',
    jsonb_build_object('payment_id', p.id, 'entry_id', eid, 'amount_cents', p.amount_cents, 'reason', why));
  return eid;
end $$;

create or replace function public.bill_void(bill uuid, reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  b public.bills := public.bill_lock(bill);
  why text := btrim(coalesce(reason, ''));
  orig public.journal_entries;
  eid uuid;
begin
  if not (public.has_permission(b.company_id, 'payables.manage')
          or (b.status = 'draft' and b.created_by = (select auth.uid()))) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if b.status = 'voided' then
    raise exception 'BILL_VOIDED' using errcode = 'P0001';
  end if;
  if b.paid_cents > 0 then
    raise exception 'BILL_HAS_PAYMENTS' using errcode = 'P0001', detail = 'Void its payments first.';
  end if;
  if char_length(why) < 3 or char_length(why) > 300 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  select * into orig from public.journal_entries e where e.company_id = b.company_id and e.source = 'bill' and e.source_id = b.id;
  if orig.id is not null then
    eid := public.ledger_post(b.company_id, greatest(public.ba_today(), orig.entry_date), b.description, b.vendor_invoice_number,
             'bill_void', b.id, public.ledger_mirror_lines(orig.id), null, orig.id, why);
  end if;
  update public.bills set status = 'voided', voided_by = (select auth.uid()), voided_at = now(), void_reason = why where id = b.id;
  perform public.payables_log(b.company_id, 'bills', b.id::text, 'voided', jsonb_build_object('reason', why, 'entry_id', eid));
  return eid;
end $$;

-- ---------------------------------------------------------------- settings
create or replace function public.payables_save_settings(target uuid, self_approval boolean, admin_limit bigint, admin_can boolean,
  member_limit bigint, member_can boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_permission(target, 'payables.settings') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if (admin_limit is not null and admin_limit < 0) or (member_limit is not null and member_limit < 0) then
    raise exception 'AMOUNT_INVALID' using errcode = 'P0001';
  end if;
  perform public.payables_ensure(target);
  update public.payables_settings set allow_self_approval = coalesce(self_approval, false), updated_at = now(), updated_by = (select auth.uid())
   where company_id = target;
  delete from public.approval_limits where company_id = target;
  if admin_can then
    insert into public.approval_limits (company_id, role, max_cents, updated_by) values (target, 'admin', admin_limit, (select auth.uid()));
  end if;
  if member_can then
    insert into public.approval_limits (company_id, role, max_cents, updated_by) values (target, 'member', member_limit, (select auth.uid()));
  end if;
  perform public.payables_log(target, 'payables_settings', target::text, 'updated',
    jsonb_build_object('self_approval', self_approval, 'admin', case when admin_can then coalesce(admin_limit::text, 'unlimited') else 'none' end,
                       'member', case when member_can then coalesce(member_limit::text, 'unlimited') else 'none' end));
end $$;

-- ---------------------------------------------------------------- recurring
create or replace function public.recurring_next(d date, freq text)
returns date language sql immutable set search_path = '' as $$
  select case freq when 'weekly' then d + 7
                   when 'monthly' then (d + interval '1 month')::date
                   when 'quarterly' then (d + interval '3 months')::date
                   else (d + interval '1 year')::date end
$$;

-- Generates the bills due up to today (never future periods), at most 36
-- per template per call. One bill per (template, period): repeated or
-- simultaneous runs create nothing twice. Returns the number created.
create or replace function public.recurring_generate(target uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r public.recurring_expenses;
  d date;
  n integer := 0;
  k integer;
  bid uuid;
  today date := public.ba_today();
begin
  if not public.has_permission(target, 'payables.manage') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  perform public.payables_ensure(target);
  for r in select * from public.recurring_expenses where company_id = target and status = 'active' and next_date <= today
           order by created_at for update loop
    d := r.next_date;
    k := 0;
    while d <= today and (r.end_date is null or d <= r.end_date) and k < 36 loop
      insert into public.bills (company_id, vendor_id, bill_date, due_date, description, recurring_id, recurring_period)
      values (target, r.vendor_id, d, d + r.due_days, r.description, r.id, d)
      on conflict (recurring_id, recurring_period) where recurring_id is not null do nothing
      returning id into bid;
      if bid is not null then
        insert into public.bill_lines (company_id, bill_id, line_no, category_id, description, amount_cents)
        values (target, bid, 1, r.category_id, r.description, r.amount_cents);
        if r.auto_submit then perform public.bill_submit(bid); end if;
        n := n + 1;
      end if;
      bid := null;
      d := public.recurring_next(d, r.frequency);
      k := k + 1;
    end loop;
    update public.recurring_expenses set next_date = d where id = r.id;
  end loop;
  perform public.payables_log(target, 'recurring_expenses', target::text, 'generated', jsonb_build_object('bills', n, 'up_to', today));
  return n;
end $$;

-- ---------------------------------------------------------------- reports
-- From the approved, not voided bills (each one is exactly one entry in
-- the ledger). SECURITY INVOKER: the caller's RLS decides what is read.
create or replace function public.payables_report(target uuid, from_date date, to_date date, dim text)
returns table (key text, label text, bills bigint, total_cents bigint, paid_cents bigint)
language sql stable set search_path = '' as $$
  with b as (
    select * from public.bills
    where company_id = target and status in ('approved', 'scheduled', 'partially_paid', 'paid')
      and bill_date between from_date and to_date and public.has_permission(target, 'payables.view')),
  l as (select bl.*, b.bill_date, b.vendor_id from public.bill_lines bl join b on b.id = bl.bill_id)
  select x.key, x.label, x.bills, x.total_cents, x.paid_cents from (
    select c.id::text as key, c.name as label, count(distinct l.bill_id) as bills, sum(l.amount_cents)::bigint as total_cents, null::bigint as paid_cents
      from l join public.expense_categories c on c.id = l.category_id where dim = 'category' group by c.id, c.name
    union all
    select v.id::text, v.name, count(*), sum(b.total_cents)::bigint, sum(b.paid_cents)::bigint
      from b join public.vendors v on v.id = b.vendor_id where dim = 'vendor' group by v.id, v.name
    union all
    select to_char(date_trunc('month', b.bill_date), 'YYYY-MM'), to_char(date_trunc('month', b.bill_date), 'YYYY-MM'), count(*),
           sum(b.total_cents)::bigint, sum(b.paid_cents)::bigint
      from b where dim = 'month' group by 1, 2) x
  order by x.total_cents desc, x.label
$$;

-- Accounts payable in the ledger = open balance of the approved bills;
-- ledger debits from bill entries = approved bill totals.
create or replace function public.payables_integrity(target uuid)
returns table (payable_cents bigint, open_bills_cents bigint, posted_bill_cents bigint, approved_bills_cents bigint, unposted_bills bigint)
language sql stable set search_path = '' as $$
  select
    (select coalesce(sum(l.credit_cents - l.debit_cents), 0) from public.journal_lines l
       join public.ledger_accounts a on a.id = l.account_id
      where l.company_id = target and a.system_key = 'accounts_payable')::bigint,
    (select coalesce(sum(b.total_cents - b.paid_cents), 0) from public.bills b
      where b.company_id = target and b.status in ('approved', 'scheduled', 'partially_paid', 'paid'))::bigint,
    (select coalesce(sum(l.debit_cents), 0) from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
      where e.company_id = target and e.source = 'bill')::bigint
    - (select coalesce(sum(l.credit_cents), 0) from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
         join public.ledger_accounts a on a.id = l.account_id
        where e.company_id = target and e.source = 'bill_void' and a.system_key is distinct from 'accounts_payable')::bigint,
    (select coalesce(sum(b.total_cents), 0) from public.bills b
      where b.company_id = target and b.status in ('approved', 'scheduled', 'partially_paid', 'paid'))::bigint,
    (select count(*) from public.bills b
      where b.company_id = target and b.status in ('approved', 'scheduled', 'partially_paid', 'paid')
        and not exists (select 1 from public.journal_entries e where e.company_id = target and e.source = 'bill' and e.source_id = b.id))
  where public.has_permission(target, 'payables.view') or (select auth.uid()) is null
$$;

-- ------------------------------------------------------------- storage
do $$
declare b record;
begin
  select * into b from storage.buckets where id = 'Finance-attachments';
  if not found then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('Finance-attachments', 'Finance-attachments', false, 10485760,
            array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']);
  elsif b.public then
    raise exception 'BA0024: bucket Finance-attachments exists but is PUBLIC; make it private first';
  else
    update storage.buckets set file_size_limit = 10485760,
           allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']
     where id = 'Finance-attachments';
  end if;
end $$;

-- <company>/<bill>/<file>: the bill must belong to that company and be visible.
create or replace function public.finance_object_bill(object_name text)
returns uuid language sql stable security definer set search_path = '' as $$
  select b.id from public.bills b
  where array_length(string_to_array(object_name, '/'), 1) = 3
    and (string_to_array(object_name, '/'))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and b.id = ((string_to_array(object_name, '/'))[2])::uuid
    and b.company_id = public.storage_company_id(object_name)
$$;

drop policy if exists ba_finance_attachments_select on storage.objects;
drop policy if exists ba_finance_attachments_insert on storage.objects;
drop policy if exists ba_finance_attachments_delete on storage.objects;
create policy ba_finance_attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'Finance-attachments' and public.bill_visible(public.finance_object_bill(name)));
create policy ba_finance_attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'Finance-attachments' and public.bill_visible(public.finance_object_bill(name))
              and exists (select 1 from public.bills b where b.id = public.finance_object_bill(name) and b.status <> 'voided'));
-- Only files not (or no longer) registered as an attachment: an upload whose
-- record failed, or one removed from a draft.
create policy ba_finance_attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'Finance-attachments' and public.bill_visible(public.finance_object_bill(name))
         and not exists (select 1 from public.bill_attachments a where a.storage_path = name));

-- ---------------------------------------------------------- function grants
do $$
declare f text;
begin
  foreach f in array array[
    'payables_log(uuid, text, text, text, jsonb)', 'payables_ensure(uuid)', 'vendor_guard()', 'category_guard()', 'bill_guard()',
    'bill_line_guard()', 'bill_line_total()', 'bill_payment_guard()', 'bill_attachment_guard()', 'recurring_guard()',
    'payables_row_log()', 'bill_row_log()', 'bill_lock(uuid)', 'recurring_next(date, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'bill_visible(uuid)', 'finance_object_bill(text)', 'payables_company_gone(uuid)', 'bill_status(uuid)', 'category_active(uuid)', 'category_in_company(uuid, uuid)',
    'ledger_base_currency(uuid)', 'payables_role(uuid)', 'payables_approval_limit(uuid)', 'payables_init(uuid)',
    'bill_save_draft(uuid, uuid, uuid, text, date, date, text, text, jsonb, text)', 'bill_submit(uuid)', 'bill_approve(uuid)', 'bill_reject(uuid, text)', 'bill_schedule(uuid, date)',
    'bill_pay(uuid, bigint, date, uuid, text, text, text)', 'bill_payment_void(uuid, text)', 'bill_void(uuid, text)',
    'payables_save_settings(uuid, boolean, bigint, boolean, bigint, boolean)', 'recurring_generate(uuid)',
    'payables_report(uuid, date, date, text)', 'payables_integrity(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
-- bill_guard / bill_line_guard / bill_payment_guard run as the caller.
grant execute on function public.bill_guard(), public.bill_line_guard(), public.bill_payment_guard() to authenticated;

-- ------------------------------------------------------------ self-check
do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in
        ('ba_vendor_guard', 'ba_category_guard', 'ba_bill_guard', 'ba_bill_line_guard', 'ba_bill_line_total', 'ba_bill_payment_guard',
         'ba_bill_attachment_guard', 'ba_recurring_guard', 'ba_bill_row_log', 'ba_payables_append_only')) <> 10 then
    raise exception 'BA0024 self-check failed: triggers missing';
  end if;
  if has_table_privilege('authenticated', 'public.bill_payments', 'INSERT')
     or has_table_privilege('authenticated', 'public.payables_events', 'INSERT')
     or has_column_privilege('authenticated', 'public.bills', 'status', 'UPDATE')
     or has_column_privilege('authenticated', 'public.bills', 'paid_cents', 'UPDATE')
     or has_column_privilege('authenticated', 'public.bills', 'total_cents', 'UPDATE')
     or has_column_privilege('authenticated', 'public.bill_lines', 'account_id', 'UPDATE')
     or has_table_privilege('anon', 'public.bills', 'SELECT') then
    raise exception 'BA0024 self-check failed: privileges';
  end if;
  if (select public from storage.buckets where id = 'Finance-attachments') is distinct from false then
    raise exception 'BA0024 self-check failed: Finance-attachments must be private';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key in ('payables.view', 'payables.pay', 'payables.manage', 'payables.settings'))
     or (select count(*) from public.role_permissions where permission_key = 'payables.settings') <> 1 then
    raise exception 'BA0024 self-check failed: role matrix';
  end if;
end $$;

commit;
