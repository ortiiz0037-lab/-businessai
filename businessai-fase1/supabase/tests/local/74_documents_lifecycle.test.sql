-- Document lifecycle (0015, revision 2) test suite. TEST-ONLY, local throw-away
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
  (l.id('B'), l.id('other'), 'owner'), (l.id('B'), l.id('owner'), 'admin');  -- owner of A is also admin of B (C2)
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

create function l.ev(doc uuid, e text) returns int language sql stable as $$
  select count(*)::int from public.document_events where document_id = doc and event = e $$;
create function l.upd(who text, doc text, set_clause text) returns text language sql as $$
  select l.err(who, format('update public.documents set %s where id = %L', set_clause, l.id(doc))) $$;
create function l.pay(who text, company text, doc text, amount numeric, extra text default '') returns text language plpgsql as $$
begin
  return l.err(who, format('insert into public.payments (company_id, document_id, amount, created_by%s) values (%L, %L, %s, %L%s)',
    case when extra = '' then '' else ', ' || split_part(extra, '=', 1) end,
    l.id(company), l.id(doc), amount, l.id(who),
    case when extra = '' then '' else ', ' || quote_literal(split_part(extra, '=', 2)) end));
end $$;
create function l.y() returns text language sql stable as $$ select extract(year from public.ba_today())::text $$;

-- ------------------------------------------------------------ numbering (I1, M6)
do $$ begin
  perform l.ok(l.doc('owner', 'inv1', 'A', 'invoice', 100) = '', 'owner creates an invoice without a number');
  perform l.ok(l.num(l.id('inv1')) = 'FAC-' || l.y() || '-0001', 'first invoice of the year → FAC-<year>-0001');
  perform l.ok(l.doc('member', 'inv2', 'A', 'invoice', 50) = '', 'member creates a second invoice');
  perform l.ok(l.num(l.id('inv2')) = 'FAC-' || l.y() || '-0002', 'second invoice → consecutive');
  perform l.doc('owner', 'q1', 'A', 'quote', 80);
  perform l.ok(l.num(l.id('q1')) = 'COT-' || l.y() || '-0001', 'quotes have their own sequence');
  perform l.doc('other', 'invB', 'B', 'invoice', 10);
  perform l.ok(l.num(l.id('invB')) = 'FAC-' || l.y() || '-0001', 'another company has its own sequence');
  -- I1: a number sent by a user is replaced, never trusted.
  perform l.doc('owner', 'forged', 'A', 'invoice', 10, 'draft', 'FAC-1999-0001');
  perform l.ok(l.num(l.id('forged')) = 'FAC-' || l.y() || '-0003', 'I1: a number sent by a signed-in user is replaced by the next consecutive');
  -- A number already taken (imported without a user) is skipped.
  insert into public.documents (company_id, document_type, document_number, total) values (l.id('A'), 'invoice', 'FAC-' || l.y() || '-0004', 5);
  perform l.ok(l.num((select id from public.documents where document_number = 'FAC-' || l.y() || '-0004')) is not null,
               'maintenance (no user) keeps an imported number');
  perform l.doc('owner', 'inv5', 'A', 'invoice', 10);
  perform l.ok(l.num(l.id('inv5')) = 'FAC-' || l.y() || '-0005', 'a number already taken is skipped');
  -- M6: the year is the creation year, not the (editable) issue date.
  perform l.doc('owner', 'back', 'A', 'invoice', 10, 'draft', null, date '2019-06-01');
  perform l.ok(l.num(l.id('back')) = 'FAC-' || l.y() || '-0006', 'M6: an old issue date does not open another year''s sequence');
  perform l.ok(l.upd('owner', 'inv5', format('document_number = %L', 'X-1')) like '%DOCUMENT_FIELD_LOCKED%',
               'I1: the number of a draft cannot be changed');
  perform l.ok(l.upd('owner', 'inv5', format('document_type = %L', 'quote')) like '%DOCUMENT_FIELD_LOCKED%',
               'the type of a draft cannot be changed');
  perform l.ok(l.doc('member', 'bad', 'B', 'invoice', 10) <> '', 'insert into another company is refused');
  perform l.doc('other', 'invB2', 'B', 'invoice', 10);
  perform l.ok(l.num(l.id('invB2')) = 'FAC-' || l.y() || '-0002', 'a refused insert leaves no gap');
  perform l.ok(public.document_number_prefix('invoice') = 'FAC' and public.document_number_prefix('quote') = 'COT'
               and public.document_number_prefix('receipt') = 'RCB' and public.document_number_prefix('work_order') = 'OT'
               and public.document_number_prefix('letter') = 'CARTA' and public.document_number_prefix('payment_reminder') = 'REC',
               'prefixes match the app (lib/documents/numbering NUMBER_PREFIX)');
  perform l.doc('member', 'wo1', 'A', 'work_order', 0);
  perform l.ok(l.num(l.id('wo1')) = 'OT-' || l.y() || '-0001', 'work orders: OT-<year>-0001');
  perform l.ok(l.err('owner', 'select * from public.document_counters') like '%permission denied%',
               'document_counters is not readable by signed-in users');
  perform l.ok(l.doc('owner', 'paidins', 'A', 'invoice', 10, 'paid') like '%DOCUMENT_STATUS_INVALID%',
               'a document cannot be created already paid');
  perform l.ok(l.doc('owner', 'accins', 'A', 'quote', 10, 'accepted') like '%DOCUMENT_STATUS_INVALID%',
               'a quote cannot be created already accepted');
end $$;

-- --------------------------------------------- drafts, transitions (I2)
do $$ begin
  perform l.ok(l.upd('member', 'inv2', 'total = 55, subtotal = 55') = '', 'a draft can be edited');
  perform l.ok(l.upd('owner', 'q1', format('status = %L', 'accepted')) like '%DOCUMENT_TRANSITION%', 'I2: a draft quote cannot jump to accepted');
  perform l.ok(l.upd('owner', 'q1', format('status = %L', 'paid')) like '%DOCUMENT_TRANSITION%', 'I2: a quote can never be paid');
  perform l.ok(l.upd('owner', 'inv5', format('status = %L', 'accepted')) like '%DOCUMENT_TRANSITION%', 'I2: an invoice can never be accepted');
  perform l.ok(l.upd('owner', 'q1', format('status = %L', 'sent')) = '', 'a quote can be sent');
  perform l.ok(l.upd('member', 'q1', format('status = %L', 'accepted')) = '', 'a sent quote can be accepted');
  perform l.ok(l.st(l.id('q1')) = 'accepted', 'the quote is accepted');
  perform l.ok(l.upd('owner', 'q1', format('status = %L', 'rejected')) like '%DOCUMENT_TRANSITION%', 'I2: an accepted quote cannot be rejected');
  perform l.doc('owner', 'q2', 'A', 'quote', 5, 'sent');
  perform l.ok(l.upd('owner', 'q2', format('status = %L', 'rejected')) = '', 'a sent quote can be rejected');
  perform l.ok(l.upd('owner', 'q2', format('status = %L', 'unknown')) ~ 'documents_status_check|DOCUMENT_TRANSITION', 'unknown statuses are refused');
  perform l.ok(l.upd('owner', 'inv5', format('status = %L', 'paid')) like '%DOCUMENT_TRANSITION%', 'I2: a draft invoice cannot be marked paid');
  perform l.ok(l.upd('owner', 'inv5', format('status = %L', 'sent')) = '', 'an invoice is issued');
  perform l.ok(l.upd('owner', 'inv5', format('status = %L', 'paid')) like '%DOCUMENT_NOT_PAID%', 'I2: an invoice without payments cannot be marked paid');
  perform l.ok(l.upd('owner', 'inv5', format('status = %L', 'overdue')) like '%DOCUMENT_NOT_OVERDUE%', 'an invoice without a past due date is not overdue');
  perform l.ok(l.rows('member', format('delete from public.documents where id = %L', l.id('back'))) = 0, 'member cannot delete a draft (RLS)');
  perform l.ok(l.rows('admin', format('delete from public.documents where id = %L', l.id('back'))) = 1, 'admin deletes a draft');
  perform l.ok(l.ev(l.id('back'), 'deleted') = 1, 'the draft deletion is recorded in document_events');
end $$;

-- ------------------------------------------- issued documents frozen (C1)
do $$ begin
  perform l.ok(l.upd('owner', 'inv1', format('status = %L', 'sent')) = '', 'invoice 1 issued (total 100)');
  perform l.ok(l.upd('owner', 'inv1', 'total = 1') like '%DOCUMENT_ISSUED%', 'C1: the total of an issued invoice cannot change');
  perform l.ok(l.upd('owner', 'inv1', format('title = %L', 'x')) like '%DOCUMENT_ISSUED%', 'C1: no field of an issued invoice changes');
  perform l.ok(l.upd('owner', 'inv1', format('items = %L', '[{"description":"x","amount":1}]')) like '%DOCUMENT_ISSUED%', 'C1: the items of an issued invoice cannot change');
  perform l.ok(l.upd('owner', 'inv1', format('metadata = %L', '{"a":1}')) like '%DOCUMENT_ISSUED%', 'C1: the metadata of an issued invoice cannot change');
  perform l.ok(l.upd('owner', 'inv1', format('status = %L, total = 1', 'overdue')) like '%DOCUMENT_ISSUED%' or
               l.upd('owner', 'inv1', format('status = %L, total = 1', 'overdue')) like '%DOCUMENT_NOT_OVERDUE%',
               'C1: a status change cannot carry other changes');
  perform l.ok(l.upd('owner', 'inv1', 'updated_at = now()') = '', 'touching updated_at alone is harmless');
  perform l.ok(l.err('owner', format('delete from public.documents where id = %L', l.id('inv1'))) like '%DOCUMENT_ISSUED%',
               'an issued invoice cannot be deleted, not even by the owner');
  perform l.ok(l.upd('owner', 'inv1', format('status = %L', 'draft')) like '%DOCUMENT_ISSUED%', 'an issued document cannot go back to draft');
  perform l.ok(l.ev(l.id('inv1'), 'created') = 1 and l.ev(l.id('inv1'), 'status') = 1, 'creation and issue are recorded');
end $$;

-- ---------------------------------------------- company isolation (C2)
do $$ begin
  perform l.ok(l.upd('owner', 'inv1', format('company_id = %L', l.id('B'))) like '%COMPANY_IMMUTABLE%',
               'C2: a user of two companies cannot move an issued invoice to the other company');
  perform l.ok(l.upd('owner', 'inv2', format('company_id = %L, client_id = %L', l.id('B'), l.id('cB'))) like '%COMPANY_IMMUTABLE%',
               'C2: nor a draft');
  perform l.ok(l.err('owner', format('update public.clients set company_id = %L where id = %L', l.id('B'), l.id('cA'))) like '%COMPANY_IMMUTABLE%',
               'C2: nor a client');
  perform l.ok((select company_id from public.documents where id = l.id('inv1')) = l.id('A')
               and (select company_id from public.clients where id = l.id('cA')) = l.id('A'), 'C2: rows stay in their company');
  perform l.ok(l.upd('owner', 'inv2', format('client_id = %L', l.id('cB'))) <> '', 'a draft cannot point to another company''s client');
end $$;

-- ----------------------------------------------------------- payments
do $$ declare pid uuid := gen_random_uuid(); begin
  perform l.ok(l.pay('member', 'A', 'inv2', 10) like '%PAYMENT_NOT_ALLOWED%', 'no payment on a draft invoice');
  perform l.ok(l.pay('owner', 'A', 'q1', 10) like '%PAYMENT_NOT_ALLOWED%', 'no payment on a quote');
  perform l.ok(l.pay('owner', 'A', 'inv1', 10, 'paid_at=2001-01-01 12:00-04') like '%PAYMENT_DATE_INVALID%', 'M7: no payment dated before the invoice');
  perform l.ok(l.pay('owner', 'A', 'inv1', 10, 'paid_at=' || (now() + interval '3 days')::text) like '%PAYMENT_DATE_INVALID%', 'M7: no payment dated in the future');
  perform l.ok(l.err('member', format('insert into public.payments (id, company_id, document_id, amount, payment_method, reference, created_by, idempotency_key) values (%L, %L, %L, 40, %L, %L, %L, %L)',
               pid, l.id('A'), l.id('inv1'), 'check', 'CHK-1', l.id('member'), 'form-key-0001')) = '',
               'member records a partial payment (40 of 100) with an idempotency key');
  insert into l.ctx values ('pay1', pid);
  perform l.ok(l.err('member', format('insert into public.payments (company_id, document_id, amount, created_by, idempotency_key) values (%L, %L, 40, %L, %L)',
               l.id('A'), l.id('inv1'), l.id('member'), 'form-key-0001')) like '%payments_idempotency_uidx%',
               'I5: the same submission twice is refused (idempotency key)');
  perform l.ok((select count(*) from public.payments where document_id = l.id('inv1')) = 1, 'I5: one payment stored');
  perform l.ok(l.st(l.id('inv1')) = 'sent', 'a partial payment keeps the invoice open');
  perform l.ok(l.upd('admin', 'inv1', format('status = %L, metadata = %L', 'cancelled', '{"void":{"reason":"error de cliente"}}')) like '%DOCUMENT_HAS_PAYMENTS%',
               'I3: an invoice with payments cannot be voided');
  perform l.ok(l.pay('owner', 'A', 'inv1', 70) like '%PAYMENT_EXCEEDS_BALANCE%', 'a payment above the open balance (60) is refused');
  perform l.ok(l.pay('owner', 'A', 'inv1', 60) = '', 'the remaining 60 is accepted');
  perform l.ok(l.st(l.id('inv1')) = 'paid', 'when payments reach the total the invoice becomes paid');
  perform l.ok(l.ev(l.id('inv1'), 'status') = 2, 'the settlement is recorded');
  perform l.ok(l.pay('owner', 'A', 'inv1', 1) like '%PAYMENT_NOT_ALLOWED%', 'no payment on a paid invoice');
  perform l.ok(l.upd('owner', 'inv1', format('status = %L', 'sent')) like '%DOCUMENT_TRANSITION%', 'C1: a paid invoice cannot go back to sent');
  perform l.ok(l.err('owner', format('update public.payments set amount = 1 where id = %L', l.id('pay1'))) like '%permission denied%', 'payments stay immutable');
  perform l.ok(l.err('owner', format('delete from public.payments where id = %L', l.id('pay1'))) like '%permission denied%', 'payments cannot be deleted');
end $$;

-- ------------------------------------------------------------ receipts
do $$ declare pidB uuid := gen_random_uuid(); rid uuid := gen_random_uuid(); begin
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, client_id, document_type, status, total, subtotal, tax, created_by) values (%L, %L, %L, %L, 40, 40, 0, %L)',
    l.id('A'), l.id('cA'), 'receipt', 'paid', l.id('owner'))) like '%RECEIPT_PAYMENT_REQUIRED%', 'a receipt needs a payment');
  perform l.doc('other', 'invB3', 'B', 'invoice', 30, 'sent');
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
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, client_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, %L, 40, 40, 0, %L, %L)',
    l.id('A'), l.id('cA'), 'receipt', 'draft', json_build_object('payment_id', l.id('pay1')), l.id('owner'))) like '%RECEIPT_STATUS%',
    'a receipt is created paid');
  insert into public.clients (id, company_id, name) values ('5c000000-0000-4000-8000-0000000000c2', l.id('A'), 'Otro cliente A');
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, client_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, %L, 40, 40, 0, %L, %L)',
    l.id('A'), '5c000000-0000-4000-8000-0000000000c2', 'receipt', 'paid', json_build_object('payment_id', l.id('pay1')), l.id('owner'))) like '%RECEIPT_CLIENT_MISMATCH%',
    'I11: a receipt cannot name a client other than the invoice''s');
  perform l.ok(l.err('member', format(
    'insert into public.documents (id, company_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, %L, 40, 40, 0, %L, %L)',
    rid, l.id('A'), 'receipt', 'paid', json_build_object('payment_id', l.id('pay1')), l.id('member'))) = '',
    'member creates the receipt of a payment');
  insert into l.ctx values ('r1', rid);
  perform l.ok((select client_id from public.documents where id = rid) = l.id('cA'), 'I11: the receipt takes the invoice''s client');
  perform l.ok(l.num(rid) = 'RCB-' || l.y() || '-0001', 'receipts are numbered RCB-<year>-0001');
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, 40, 40, 0, %L, %L)',
    l.id('A'), 'receipt', 'paid', json_build_object('payment_id', l.id('pay1')), l.id('owner'))) like '%documents_receipt_payment_uidx%',
    'one valid receipt per payment');
  perform l.ok(l.upd('owner', 'r1', 'total = 1') like '%DOCUMENT_ISSUED%', 'C1: a receipt total cannot change');
  perform l.ok(l.upd('owner', 'r1', format('metadata = %L', json_build_object('payment_id', pidB))) like '%DOCUMENT_ISSUED%', 'C1: a receipt payment cannot change');
  perform l.ok(l.upd('owner', 'r1', format('status = %L', 'sent')) like '%DOCUMENT_TRANSITION%', 'a receipt status cannot move except voiding');
  perform l.ok(l.upd('member', 'r1', format('status = %L, metadata = metadata || %L', 'cancelled', '{"void":{"reason":"monto mal escrito"}}')) like '%DOCUMENT_VOID_FORBIDDEN%',
               'member cannot void a receipt');
  perform l.ok(l.upd('owner', 'r1', format('status = %L', 'cancelled')) like '%VOID_REASON_REQUIRED%', 'voiding needs a reason');
  perform l.ok(l.upd('owner', 'r1', format('status = %L, metadata = metadata || %L', 'cancelled',
               json_build_object('void', json_build_object('reason', 'nombre incorrecto', 'voided_by', l.id('member'), 'voided_at', '2000-01-01')))) = '',
               'owner voids the receipt with a reason');
  perform l.ok((select metadata -> 'void' ->> 'voided_by' from public.documents where id = rid) = l.id('owner')::text
               and (select metadata -> 'void' ->> 'previous_status' from public.documents where id = rid) = 'paid'
               and (select metadata -> 'void' ->> 'voided_at' from public.documents where id = rid) not like '2000%',
               'the database writes who voided it, when and the previous status (client values ignored)');
  perform l.ok(l.ev(rid, 'voided') = 1 and (select reason from public.document_events where document_id = rid and event = 'voided') = 'nombre incorrecto',
               'the void and its reason are in document_events');
  perform l.ok(l.err('owner', format(
    'insert into public.documents (company_id, document_type, status, total, subtotal, tax, metadata, created_by) values (%L, %L, %L, 40, 40, 0, %L, %L)',
    l.id('A'), 'receipt', 'paid', json_build_object('payment_id', l.id('pay1')), l.id('owner'))) = '',
    'I7: after voiding, the payment can get a new receipt');
  perform l.ok(l.upd('owner', 'r1', format('status = %L', 'paid')) like '%DOCUMENT_CANCELLED%', 'a voided receipt cannot be reopened');
  perform l.ok(l.err('owner', format('delete from public.documents where id = %L', rid)) like '%DOCUMENT_ISSUED%', 'a voided document cannot be deleted');
end $$;

-- --------------------------------------------- voiding without payments
do $$ begin
  perform l.ok(l.upd('admin', 'q2', format('status = %L, metadata = %L', 'cancelled', '{"void":{"reason":"duplicada"}}')) = '',
               'admin voids a rejected quote');
  perform l.ok(l.upd('owner', 'inv5', format('status = %L, metadata = %L', 'cancelled', '{"void":{"reason":"sin pagos"}}')) = '',
               'an issued invoice without payments can be voided');
  perform l.ok(l.upd('owner', 'inv5', format('status = %L', 'sent')) like '%DOCUMENT_CANCELLED%', 'a voided document cannot be reopened');
  perform l.ok(l.pay('owner', 'A', 'inv5', 1) like '%PAYMENT_NOT_ALLOWED%', 'no payment on a voided invoice');
  perform l.ok(l.err('member', 'insert into public.document_events (company_id, document_id, event) values ('''
               || l.id('A') || ''', ''' || l.id('inv5') || ''', ''deleted'')') like '%permission denied%',
               'document_events cannot be written through the API');
  perform l.ok(l.err('owner', format('delete from public.document_events where document_id = %L', l.id('inv5'))) like '%permission denied%',
               'document_events cannot be deleted through the API');
  perform l.as_user('other');
  set local role authenticated;
  perform l.ok((select count(*) from public.document_events where company_id = l.id('A')) = 0, 'outsiders do not see company A history');
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- --------------------------------------------------- roles and maintenance
do $$ begin
  perform l.ok(exists (select 1 from public.role_permissions where role = 'owner' and permission_key = 'billing.manage')
               and not exists (select 1 from public.role_permissions where role = 'admin' and permission_key = 'billing.manage'),
               'billing.manage: owner only');
  perform l.ok((select count(*) from public.role_permissions where permission_key = 'documents.void') = 2
               and not exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'documents.void'),
               'documents.void: owner and admin');
  -- (the accounting permissions of 0023, when present, are checked by its own suite)
  perform l.ok((select count(*) from public.permissions where key not like 'accounting.%' and key not like 'payables.%' and key not like 'receivables.%' and key <> 'payments.void' and key not like 'bank.%' and key not like 'budgets.%' and key not like 'studio.%') = 19
               and (select count(*) from public.role_permissions where permission_key not like 'accounting.%' and permission_key not like 'payables.%' and permission_key not like 'receivables.%' and permission_key <> 'payments.void' and permission_key not like 'bank.%' and permission_key not like 'budgets.%' and permission_key not like 'studio.%') = 50,
               'catalog 19 permissions; matrix owner 19, admin 18, member 13 (50 rows)');
end $$;
do $$ begin
  perform set_config('request.jwt.claims', '', true);
  if to_regprocedure('public.payment_guard()') is null then
    delete from public.payments where document_id = l.id('invB3');
    delete from public.documents where id = l.id('invB3');
    perform l.ok(not exists (select 1 from public.documents where id = l.id('invB3')),
                 'server-side maintenance (no signed-in user) can still delete an issued document');
  else
    -- 0025: client payments are evidence (their entries are in the ledger):
    -- not even maintenance deletes them; they are voided with a reversal.
    begin
      delete from public.payments where document_id = l.id('invB3');
      perform l.ok(not exists (select 1 from public.payments where document_id = l.id('invB3')), 'with 0025: maintenance cannot delete client payments');
    exception when others then
      perform l.ok(sqlerrm like '%PAYMENT_IMMUTABLE%', 'with 0025: maintenance cannot delete client payments');
    end;
  end if;
  begin
    update public.documents set company_id = l.id('B') where id = l.id('inv1');
    perform l.ok(false, 'maintenance cannot move a document either');
  exception when others then
    perform l.ok(sqlerrm like '%COMPANY_IMMUTABLE%', 'maintenance cannot move a document either');
  end;
end $$;

do $$ begin
  if exists (select 1 from l.failures) then
    raise exception 'LIFECYCLE TESTS FAILED: %', (select string_agg(msg, '; ') from l.failures);
  end if;
  raise notice 'ALL LIFECYCLE TESTS PASSED';
end $$;
