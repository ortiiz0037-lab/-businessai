-- Document lifecycle (0015) test suite. TEST-ONLY, local throw-away
-- database with 0001–0011 + 0014a + 0015. Standalone fixture (schema l).
-- Numbering, statuses, no deletion of issued documents, voiding, payments
-- (balance, concurrency lock, settlement), receipts and the owner-only
-- billing permission.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema l;
create table l.ctx (key text primary key, id uuid not null);
create function l.id(k text) returns uuid language sql stable as $$ select id from l.ctx where key = k $$;
grant usage on schema l to anon, authenticated;
grant select on l.ctx to anon, authenticated;
grant execute on function l.id(text) to anon, authenticated;
create table l.failures (msg text);
create function l.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into l.failures values (msg); end if;
end $$;
grant insert on l.failures to anon, authenticated;
grant execute on function l.ok(boolean, text) to anon, authenticated;
create function l.as_user(k text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', l.id(k), 'role', 'authenticated')::text, true);
end $$;
grant execute on function l.as_user(text) to authenticated;
-- Error text of a statement run as a user ('' when it succeeds).
create function l.err(k text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform l.as_user(k);
  set local role authenticated;
  begin
    execute stmt;
  exception when others then msg := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
-- Rows affected by a statement run as a user.
create function l.rows(k text, stmt text) returns int language plpgsql as $$
declare n int;
begin
  perform l.as_user(k);
  set local role authenticated;
  execute stmt;
  get diagnostics n = row_count;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
create function l.num(doc uuid) returns text language sql stable as $$ select document_number from public.documents where id = doc $$;
create function l.st(doc uuid) returns text language sql stable as $$ select status from public.documents where id = doc $$;

insert into auth.users (id, email) values
  ('5a000000-0000-4000-8000-0000000000a1', 'l-owner@example.test'),
  ('5a000000-0000-4000-8000-0000000000a2', 'l-admin@example.test'),
  ('5a000000-0000-4000-8000-0000000000a3', 'l-member@example.test'),
  ('5b000000-0000-4000-8000-0000000000b1', 'l-other@example.test');
insert into l.ctx values
  ('owner', '5a000000-0000-4000-8000-0000000000a1'), ('admin', '5a000000-0000-4000-8000-0000000000a2'),
  ('member', '5a000000-0000-4000-8000-0000000000a3'), ('other', '5b000000-0000-4000-8000-0000000000b1'),
  ('A', '5c000000-0000-4000-8000-000000000001'), ('B', '5d000000-0000-4000-8000-000000000001'),
  ('cA', '5c000000-0000-4000-8000-0000000000c1'), ('cB', '5d000000-0000-4000-8000-0000000000c1');
insert into public.companies (id, name, created_by) values
  (l.id('A'), 'Ciclo A', l.id('owner')), (l.id('B'), 'Ciclo B', l.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (l.id('A'), 'cus_life_a', 'sub_life_a', 'premium', 'active'), (l.id('B'), 'cus_life_b', 'sub_life_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values
  (l.id('A'), l.id('owner'), 'owner'), (l.id('A'), l.id('admin'), 'admin'), (l.id('A'), l.id('member'), 'member'),
  (l.id('B'), l.id('other'), 'owner');
insert into public.clients (id, company_id, name) values (l.id('cA'), l.id('A'), 'Cliente A'), (l.id('cB'), l.id('B'), 'Cliente B');

-- Helper: insert a document as a user and remember its id.
create function l.doc(who text, k text, company text, doc_type text, total numeric, status text default 'draft',
                      number text default null, issue date default date '2026-03-01') returns text language plpgsql as $$
declare new_id uuid := gen_random_uuid(); msg text;
begin
  msg := l.err(who, format(
    'insert into public.documents (id, company_id, client_id, document_type, document_number, status, issue_date, subtotal, tax, total, created_by)
     values (%L, %L, %L, %L, %L, %L, %L, %s, 0, %s, %L)',
    new_id, l.id(company), l.id('c' || company), doc_type, number, status, issue, total, total, l.id(who)));
  if msg = '' then insert into l.ctx values (k, new_id); else raise notice 'document % not created: %', k, msg; end if;
  return msg;
end $$;

-- ------------------------------------------------------------ numbering
do $$ begin
  perform l.ok(l.doc('owner', 'inv1', 'A', 'invoice', 100) = '', 'owner creates an invoice without a number');
  perform l.ok(l.num(l.id('inv1')) = 'FAC-2026-0001', 'first invoice of 2026 → FAC-2026-0001');
  perform l.ok(l.doc('member', 'inv2', 'A', 'invoice', 50) = '', 'member creates a second invoice');
  perform l.ok(l.num(l.id('inv2')) = 'FAC-2026-0002', 'second invoice → FAC-2026-0002 (consecutive)');
  perform l.doc('owner', 'q1', 'A', 'quote', 80);
  perform l.ok(l.num(l.id('q1')) = 'COT-2026-0001', 'quotes have their own sequence → COT-2026-0001');
  perform l.doc('other', 'invB', 'B', 'invoice', 10);
  perform l.ok(l.num(l.id('invB')) = 'FAC-2026-0001', 'another company has its own sequence → FAC-2026-0001');
  perform l.doc('owner', 'old', 'A', 'invoice', 10, 'draft', 'FAC-2026-0003');
  perform l.ok(l.num(l.id('old')) = 'FAC-2026-0003', 'a supplied number is kept');
  perform l.doc('owner', 'inv4', 'A', 'invoice', 10);
  perform l.ok(l.num(l.id('inv4')) = 'FAC-2026-0004', 'a number already taken is skipped → FAC-2026-0004');
  perform l.doc('owner', 'inv25', 'A', 'invoice', 10, 'draft', null, date '2025-12-31');
  perform l.ok(l.num(l.id('inv25')) = 'FAC-2025-0001', 'the year comes from the issue date → FAC-2025-0001');
  -- A refused insert (member of A writing into B) must not consume a number.
  perform l.ok(l.doc('member', 'bad', 'B', 'invoice', 10) <> '', 'insert into another company is refused');
  perform l.doc('other', 'invB2', 'B', 'invoice', 10);
  perform l.ok(l.num(l.id('invB2')) = 'FAC-2026-0002', 'a refused insert leaves no gap → FAC-2026-0002');
  perform l.ok(l.err('owner', 'select * from public.document_counters') like '%permission denied%',
               'document_counters is not readable by signed-in users');
end $$;

-- -------------------------------------------------- statuses and delete
do $$ begin
  perform l.ok(l.err('owner', format('update public.documents set status = %L where id = %L', 'sent', l.id('q1'))) = '',
               'a quote can be sent');
  perform l.ok(l.err('member', format('update public.documents set status = %L where id = %L', 'accepted', l.id('q1'))) = '',
               'a quote can be accepted (no error)');
  perform l.ok(l.st(l.id('q1')) = 'accepted', 'the quote is accepted');
  perform l.doc('owner', 'q2', 'A', 'quote', 5, 'sent');
  perform l.ok(l.err('owner', format('update public.documents set status = %L where id = %L', 'rejected', l.id('q2'))) = '',
               'a quote can be rejected (no error)');
  perform l.ok(l.st(l.id('q2')) = 'rejected', 'the quote is rejected');
  perform l.ok(l.err('owner', format('update public.documents set status = %L where id = %L', 'unknown', l.id('q2'))) like '%documents_status_check%',
               'unknown statuses are still refused');
  perform l.ok(l.rows('member', format('delete from public.documents where id = %L', l.id('old'))) = 0,
               'member cannot delete a draft (RLS, as before)');
  perform l.ok(l.rows('admin', format('delete from public.documents where id = %L', l.id('old'))) = 1,
               'admin deletes a draft');
  perform l.ok(l.err('owner', format('update public.documents set status = %L where id = %L', 'sent', l.id('inv1'))) = '',
               'an invoice is issued (sent)');
  perform l.ok(l.err('owner', format('delete from public.documents where id = %L', l.id('inv1'))) like '%DOCUMENT_ISSUED%',
               'an issued invoice cannot be deleted, not even by the owner');
  perform l.ok(l.err('owner', format('update public.documents set status = %L where id = %L', 'draft', l.id('inv1'))) like '%DOCUMENT_ISSUED%',
               'an issued document cannot go back to draft');
  perform l.ok(l.err('member', format('update public.documents set status = %L where id = %L', 'cancelled', l.id('q2'))) like '%DOCUMENT_VOID_FORBIDDEN%',
               'member cannot void a document');
  perform l.ok(l.err('admin', format('update public.documents set status = %L where id = %L', 'cancelled', l.id('q2'))) = '',
               'admin voids a document (no error)');
  perform l.ok(l.st(l.id('q2')) = 'cancelled', 'the voided document is cancelled');
  perform l.ok(l.err('owner', format('update public.documents set status = %L where id = %L', 'sent', l.id('q2'))) like '%DOCUMENT_CANCELLED%',
               'a voided document cannot be reopened');
  perform l.ok(l.err('owner', format('delete from public.documents where id = %L', l.id('q2'))) like '%DOCUMENT_ISSUED%',
               'a voided document cannot be deleted');
end $$;

-- ----------------------------------------------------------- payments
do $$ declare pid uuid := gen_random_uuid(); begin
  perform l.ok(l.err('member', format('insert into public.payments (company_id, document_id, amount, created_by) values (%L, %L, 10, %L)',
               l.id('A'), l.id('inv2'), l.id('member'))) like '%PAYMENT_NOT_ALLOWED%', 'no payment on a draft invoice');
  perform l.ok(l.err('owner', format('insert into public.payments (company_id, document_id, amount, created_by) values (%L, %L, 10, %L)',
               l.id('A'), l.id('q1'), l.id('owner'))) like '%PAYMENT_NOT_ALLOWED%', 'no payment on a quote');
  perform l.ok(l.err('member', format('insert into public.payments (id, company_id, document_id, amount, payment_method, reference, paid_at, created_by) values (%L, %L, %L, 40, %L, %L, %L, %L)',
               pid, l.id('A'), l.id('inv1'), 'check', 'CHK-1', '2026-03-05 12:00-04', l.id('member'))) = '',
               'member records a partial payment (40 of 100) with method, reference and date');
  insert into l.ctx values ('pay1', pid);
  perform l.ok(l.st(l.id('inv1')) = 'sent', 'a partial payment keeps the invoice open (sent)');
  perform l.ok(l.err('owner', format('insert into public.payments (company_id, document_id, amount, created_by) values (%L, %L, 70, %L)',
               l.id('A'), l.id('inv1'), l.id('owner'))) like '%PAYMENT_EXCEEDS_BALANCE%', 'a payment above the open balance (60) is refused');
  perform l.ok(l.err('owner', format('insert into public.payments (company_id, document_id, amount, created_by) values (%L, %L, 60, %L)',
               l.id('A'), l.id('inv1'), l.id('owner'))) = '', 'the remaining 60 is accepted');
  perform l.ok(l.st(l.id('inv1')) = 'paid', 'when payments reach the total the invoice becomes paid');
  perform l.ok(l.err('owner', format('insert into public.payments (company_id, document_id, amount, created_by) values (%L, %L, 1, %L)',
               l.id('A'), l.id('inv1'), l.id('owner'))) like '%PAYMENT_NOT_ALLOWED%', 'no payment on a paid invoice');
  perform l.ok(l.err('owner', format('update public.payments set amount = 1 where id = %L', l.id('pay1'))) like '%permission denied%',
               'payments stay immutable');
end $$;

-- ------------------------------------------------------------ receipts
do $$ declare pidB uuid := gen_random_uuid(); begin
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, client_id, document_type, status, total, subtotal, tax, created_by) values (%L, %L, %L, %L, 40, 40, 0, %L)',
    l.id('A'), l.id('cA'), 'receipt', 'paid', l.id('owner'))) like '%RECEIPT_PAYMENT_REQUIRED%', 'a receipt needs a payment');
  -- payment of company B
  perform l.doc('other', 'invB3', 'B', 'invoice', 30, 'sent');
  perform l.ok(l.st(l.id('invB3')) = 'sent', 'company B issues an invoice');
  perform l.ok(l.err('other', format('insert into public.payments (id, company_id, document_id, amount, created_by) values (%L, %L, %L, 30, %L)',
               pidB, l.id('B'), l.id('invB3'), l.id('other'))) = '', 'company B records a payment');
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, client_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, %L, 30, 30, 0, %L, %L)',
    l.id('A'), l.id('cA'), 'receipt', 'paid', json_build_object('payment_id', pidB), l.id('owner'))) like '%RECEIPT_PAYMENT_REQUIRED%',
    'a receipt cannot use another company''s payment');
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, client_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, %L, 99, 99, 0, %L, %L)',
    l.id('A'), l.id('cA'), 'receipt', 'paid', json_build_object('payment_id', l.id('pay1')), l.id('owner'))) like '%RECEIPT_AMOUNT_MISMATCH%',
    'a receipt must be for the exact payment amount');
  perform l.ok(l.err('member', format(
    'insert into public.documents (company_id, client_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, %L, 40, 40, 0, %L, %L)',
    l.id('A'), l.id('cA'), 'receipt', 'paid', json_build_object('payment_id', l.id('pay1')), l.id('member'))) = '',
    'member creates the receipt of a payment');
  perform l.ok((select document_number from public.documents where document_type = 'receipt' and company_id = l.id('A')) = 'RCB-2026-0001',
               'receipts are numbered RCB-2026-0001');
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, client_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, %L, 40, 40, 0, %L, %L)',
    l.id('A'), l.id('cA'), 'receipt', 'paid', json_build_object('payment_id', l.id('pay1')), l.id('owner'))) like '%documents_receipt_payment_uidx%',
    'one receipt per payment');
end $$;

-- --------------------------------------------------- roles and maintenance
do $$ begin
  perform l.ok(exists (select 1 from public.role_permissions where role = 'owner' and permission_key = 'billing.manage')
               and not exists (select 1 from public.role_permissions where role = 'admin' and permission_key = 'billing.manage'),
               'billing.manage: owner only');
  perform l.ok((select count(*) from public.role_permissions where permission_key = 'documents.void') = 2
               and not exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'documents.void'),
               'documents.void: owner and admin');
  perform l.ok((select count(*) from public.permissions) = 19 and (select count(*) from public.role_permissions) = 50,
               'catalog 19 permissions; matrix owner 19, admin 18, member 13 (50 rows)');
end $$;
do $$ begin
  perform set_config('request.jwt.claims', '', true);
  delete from public.payments where document_id = l.id('invB3');
  delete from public.documents where id = l.id('invB3');
  perform l.ok(not exists (select 1 from public.documents where id = l.id('invB3')),
               'server-side maintenance (no signed-in user) can still delete an issued document');
end $$;

do $$ begin
  if exists (select 1 from l.failures) then
    raise exception 'LIFECYCLE TESTS FAILED: %', (select string_agg(msg, '; ') from l.failures);
  end if;
  raise notice 'ALL LIFECYCLE TESTS PASSED';
end $$;
