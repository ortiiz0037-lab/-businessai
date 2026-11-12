-- Expenses, vendors, bills, approvals, payments, attachments, recurring (0024).
-- TEST-ONLY, local throw-away database with 0014a … 0024. Schema pb.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema pb;
create table pb.ctx (key text primary key, val text not null);
create function pb.id(k text) returns uuid language sql stable as $$ select val::uuid from pb.ctx where key = k $$;
create table pb.failures (msg text);
create function pb.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into pb.failures values (msg); end if;
end $$;
grant usage on schema pb to authenticated;
grant select on pb.ctx to authenticated;
grant execute on all functions in schema pb to authenticated;
create function pb.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pb.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function pb.val(who text, q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pb.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function pb.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
create function pb.cat(co text, n text) returns uuid language sql stable as $$
  select id from public.expense_categories where company_id = pb.id(co) and name = n $$;
create function pb.acct(co text, c text) returns uuid language sql stable as $$
  select id from public.ledger_accounts where company_id = pb.id(co) and code = c $$;
create function pb.bal(co text, c text) returns bigint language sql volatile as $$
  select balance_cents from public.ledger_trial_balance(pb.id(co)) where code = c $$;
create function pb.entries(co text, src text) returns bigint language sql volatile as $$
  select count(*) from public.journal_entries where company_id = pb.id(co) and source = src $$;
create function pb.lines(src text, sid uuid) returns text language sql volatile as $$
  select string_agg(a.code || ':' || l.debit_cents || '/' || l.credit_cents, ' ' order by l.line_no)
  from public.journal_entries e join public.journal_lines l on l.entry_id = e.id join public.ledger_accounts a on a.id = l.account_id
  where e.source = src and e.source_id = sid $$;
create function pb.st(b text) returns text language sql volatile as $$ select status || '/' || paid_cents || '/' || total_cents from public.bills where id = pb.id(b) $$;
-- A draft bill with lines (as a user).
create function pb.draft(who text, co text, b text, vendor text, inv text, lines jsonb, on_day date default null) returns text language plpgsql as $$
declare msg text;
begin
  msg := pb.err(who, format('insert into public.bills (id, company_id, vendor_id, vendor_invoice_number, bill_date, description) values (%L, %L, %L, %L, %L, %L)',
           pb.id(b), pb.id(co), pb.id(vendor), inv, coalesce(on_day, public.ba_today() - 3), 'Factura ' || coalesce(inv, b)));
  if msg <> '' then return msg; end if;
  return pb.err(who, format('insert into public.bill_lines (company_id, bill_id, line_no, category_id, amount_cents, description)
    select %L, %L, row_number() over (), (x->>''cat'')::uuid, (x->>''cents'')::bigint, x->>''d'' from jsonb_array_elements(%L::jsonb) x', pb.id(co), pb.id(b), lines));
end $$;

insert into pb.ctx values
  ('owner', 'd1000000-0000-4000-8000-000000000001'), ('admin', 'd1000000-0000-4000-8000-000000000002'),
  ('member', 'd1000000-0000-4000-8000-000000000003'), ('other', 'd1000000-0000-4000-8000-000000000004'),
  ('A', 'd2000000-0000-4000-8000-000000000001'), ('B', 'd2000000-0000-4000-8000-000000000002'),
  ('v1', 'd3000000-0000-4000-8000-000000000001'), ('v2', 'd3000000-0000-4000-8000-000000000002'), ('vB', 'd3000000-0000-4000-8000-000000000003'),
  ('b1', 'd4000000-0000-4000-8000-000000000001'), ('b2', 'd4000000-0000-4000-8000-000000000002'), ('b3', 'd4000000-0000-4000-8000-000000000003'),
  ('b4', 'd4000000-0000-4000-8000-000000000004'), ('b5', 'd4000000-0000-4000-8000-000000000005'), ('b6', 'd4000000-0000-4000-8000-000000000006'),
  ('b7', 'd4000000-0000-4000-8000-000000000007'), ('bB', 'd4000000-0000-4000-8000-000000000011'),
  ('r1', 'd5000000-0000-4000-8000-000000000001'), ('r2', 'd5000000-0000-4000-8000-000000000002');
insert into auth.users (id, email) select val::uuid, key || '@pb.test' from pb.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (pb.id('A'), 'Pagos A', pb.id('owner')), (pb.id('B'), 'Pagos B', pb.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (pb.id('A'), 'cus_pb_a', 'sub_pb_a', 'basic', 'active'), (pb.id('B'), 'cus_pb_b', 'sub_pb_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (pb.id('A'), pb.id('owner'), 'owner'), (pb.id('A'), pb.id('admin'), 'admin'), (pb.id('A'), pb.id('member'), 'member'),
  (pb.id('B'), pb.id('other'), 'owner');

-- ------------------------------------------------------------- setup and vendors
do $$ begin
  perform pb.ok(pb.err('member', format('select public.payables_init(%L)', pb.id('A'))) like '%FORBIDDEN%', 'a member cannot initialise payables');
  perform pb.ok(pb.err('admin', format('select public.payables_init(%L)', pb.id('A'))) = '', 'an admin initialises payables (Basic plan)');
  perform pb.ok((select count(*) from public.expense_categories where company_id = pb.id('A')) = 5, 'five default categories, each on a ledger account');
  perform pb.ok((select count(*) from public.ledger_accounts where company_id = pb.id('A')) = 16, 'the ledger chart was created with them (one book)');
  perform pb.ok(pb.err('other', format('select public.payables_init(%L)', pb.id('B'))) = '', 'company B too (Pro plan)');
  perform pb.ok(pb.err('member', format('insert into public.vendors (id, company_id, name, tax_id) values (%L, %L, %L, %L)', pb.id('v1'), pb.id('A'), 'Ferretería Uno', '66-1234567')) = '', 'a member registers a vendor');
  perform pb.ok(pb.err('admin', format('insert into public.vendors (id, company_id, name) values (%L, %L, %L)', pb.id('v2'), pb.id('A'), 'Arrendador Dos')) = '', 'an admin registers another');
  perform pb.ok(pb.err('admin', format('insert into public.vendors (company_id, name) values (%L, %L)', pb.id('A'), '  ferretería uno ')) like '%vendors_name_uidx%', 'vendor names are unique per company');
  perform pb.ok(pb.err('member', format('update public.vendors set name = %L where id = %L', 'X', pb.id('v1'))) = '' and (select name from public.vendors where id = pb.id('v1')) = 'Ferretería Uno',
                'members do not edit vendors');
  perform pb.ok(pb.err('other', format('insert into public.vendors (id, company_id, name) values (%L, %L, %L)', pb.id('vB'), pb.id('B'), 'Proveedor B')) = '', 'company B vendor');
  perform pb.ok(pb.val('other', format('select count(*) from public.vendors where company_id = %L', pb.id('A'))) = '0', 'isolation: B sees no vendor of A');
  perform pb.ok(pb.err('admin', format('insert into public.expense_categories (company_id, name, account_id) values (%L, %L, %L)', pb.id('A'), 'Préstamo', pb.acct('A', '2500'))) like '%CATEGORY_ACCOUNT_INVALID%',
                'a category posts only to an expense or asset account');
  perform pb.ok(pb.err('admin', format('insert into public.expense_categories (company_id, name, account_id) values (%L, %L, %L)', pb.id('A'), 'Cuenta de B', pb.acct('B', '6000'))) <> '',
                'isolation: no category on another company''s account');
  perform pb.ok(pb.err('member', format('insert into public.expense_categories (company_id, name, account_id) values (%L, %L, %L)', pb.id('A'), 'Viajes', pb.acct('A', '6000'))) like '%row-level security%',
                'members do not create categories');
  perform pb.ok(pb.err('admin', format('insert into public.expense_categories (company_id, name, name_en, account_id) values (%L, %L, %L, %L)', pb.id('A'), 'Viajes', 'Travel', pb.acct('A', '6000'))) = '',
                'an admin adds a custom category');
end $$;

-- ------------------------------------------------------------- drafts and submission
do $$ begin
  perform pb.ok(pb.draft('member', 'A', 'b1', 'v1', 'F-100', jsonb_build_array(
                  jsonb_build_object('cat', pb.cat('A', 'Materiales y costo de ventas'), 'cents', 7550, 'd', 'Tornillos'),
                  jsonb_build_object('cat', pb.cat('A', 'Gastos generales'), 'cents', 2450, 'd', 'Limpieza'))) = '', 'a member records a bill with two lines');
  perform pb.ok(pb.st('b1') = 'draft/0/10000', 'draft, total = sum of the lines (100.00)');
  perform pb.ok((select count(*) from public.journal_entries where company_id = pb.id('A')) = 0, 'a draft posts nothing');
  perform pb.ok(pb.err('member', format('update public.bill_lines set amount_cents = 8000 where bill_id = %L and line_no = 1', pb.id('b1'))) = '' and pb.st('b1') = 'draft/0/10450', 'editing a draft line updates the total');
  perform pb.ok(pb.err('member', format('update public.bills set status = %L where id = %L', 'approved', pb.id('b1'))) like '%permission denied%', 'the status is not written directly');
  perform pb.ok(pb.err('member', format('update public.bills set total_cents = 1 where id = %L', pb.id('b1'))) like '%permission denied%', 'nor the total');
  perform pb.ok(pb.err('member', format('insert into public.bills (company_id, vendor_id, bill_date, description, status) values (%L, %L, current_date, %L, %L)', pb.id('A'), pb.id('v1'), 'X', 'paid')) like '%permission denied%',
                'a bill cannot be created in another status');
  perform pb.ok(pb.err('member', format('select public.bill_submit(%L)', pb.id('b1'))) = '' and pb.st('b1') = 'pending_approval/0/10450', 'the member submits it');
  perform pb.ok(pb.err('member', format('update public.bill_lines set amount_cents = 1 where bill_id = %L', pb.id('b1'))) like '%BILL_LOCKED%', 'submitted: lines are frozen');
  perform pb.ok(pb.err('member', format('update public.bills set description = %L where id = %L', 'cambio', pb.id('b1'))) like '%BILL_LOCKED%', 'submitted: the bill is frozen');
  perform pb.ok(pb.merr(format('update public.bills set description = %L where id = %L', 'cambio', pb.id('b1'))) like '%BILL_LOCKED%', 'not even maintenance edits a submitted bill');
  perform pb.ok(pb.err('member', format('delete from public.bills where id = %L', pb.id('b1'))) like '%BILL_NOT_DRAFT%', 'a submitted bill is not deleted');
  perform pb.ok((select count(*) from public.journal_entries where company_id = pb.id('A')) = 0, 'pending approval posts nothing');
  perform pb.ok(pb.draft('member', 'A', 'b7', 'v1', 'F-100', jsonb_build_array(jsonb_build_object('cat', pb.cat('A', 'Gastos generales'), 'cents', 100))) like '%bills_vendor_invoice_uidx%',
                'the same vendor invoice number cannot be recorded twice');
end $$;

-- ------------------------------------------------------------- approval
do $$ begin
  perform pb.ok(pb.err('member', format('select public.bill_approve(%L)', pb.id('b1'))) like '%APPROVAL_FORBIDDEN%', 'members have no approval limit by default');
  perform pb.ok(pb.err('other', format('select public.bill_approve(%L)', pb.id('b1'))) like '%BILL_NOT_FOUND%', 'isolation: B cannot approve A''s bill');
  perform pb.ok(pb.err('admin', format('select public.bill_reject(%L, %L)', pb.id('b1'), '')) like '%REASON_REQUIRED%', 'rejecting needs a reason');
  perform pb.ok(pb.err('admin', format('select public.bill_reject(%L, %L)', pb.id('b1'), 'Falta el recibo')) = '' and pb.st('b1') = 'draft/0/10450', 'the admin rejects it back to draft');
  perform pb.ok((select rejection_reason from public.bills where id = pb.id('b1')) = 'Falta el recibo', 'the reason is kept');
  perform pb.ok(pb.err('member', format('update public.bill_lines set amount_cents = 7550 where bill_id = %L and line_no = 1', pb.id('b1'))) = ''
                and pb.err('member', format('select public.bill_submit(%L)', pb.id('b1'))) = '', 'corrected and submitted again (100.00)');
  perform pb.ok(pb.err('admin', format('select public.bill_approve(%L)', pb.id('b1'))) = '', 'the admin approves it');
  perform pb.ok((select status || '/' || (approved_by = pb.id('admin'))::text from public.bills where id = pb.id('b1')) = 'approved/true', 'approved, with the approver');
  perform pb.ok(pb.lines('bill', pb.id('b1')) = '5000:7550/0 6000:2450/0 2000:0/10000', 'Dr expense accounts by category / Cr accounts payable');
  perform pb.ok((select count(*) from public.bill_lines where bill_id = pb.id('b1') and account_id is not null) = 2, 'the ledger account used is recorded on each line');
  perform pb.ok((select entry_date from public.journal_entries where source = 'bill' and source_id = pb.id('b1')) = public.ba_today() - 3, 'dated on the bill date (accrual)');
  perform pb.ok(pb.err('owner', format('select public.bill_approve(%L)', pb.id('b1'))) like '%BILL_TRANSITION%' and pb.entries('A', 'bill') = 1, 'approving again: refused, one entry');
  perform pb.ok(pb.merr(format('select public.ledger_post(%L, current_date, %L, null, %L, %L, %L)', pb.id('A'), 'x', 'bill', pb.id('b1'),
                jsonb_build_array(jsonb_build_object('key', 'cash', 'debit', 1), jsonb_build_object('key', 'accounts_payable', 'credit', 1)))) = '' and pb.entries('A', 'bill') = 1,
                'the ledger never posts the same bill twice');
end $$;

-- ------------------------------------------------------------- limits and self-approval
do $$ begin
  perform pb.ok(pb.err('admin', format('select public.payables_save_settings(%L, false, 10000, true, 2000, true)', pb.id('A'))) like '%FORBIDDEN%', 'only the owner sets approval limits');
  perform pb.ok(pb.err('owner', format('select public.payables_save_settings(%L, false, 10000, true, 2000, true)', pb.id('A'))) = '', 'owner: admin up to 100.00, member up to 20.00, no self-approval');
  perform pb.ok(pb.draft('member', 'A', 'b2', 'v2', 'R-11', jsonb_build_array(jsonb_build_object('cat', pb.cat('A', 'Alquiler'), 'cents', 150000))) = ''
                and pb.err('member', format('select public.bill_submit(%L)', pb.id('b2'))) = '', 'rent bill of 1,500.00 submitted');
  perform pb.ok(pb.err('admin', format('select public.bill_approve(%L)', pb.id('b2'))) like '%APPROVAL_LIMIT_EXCEEDED%', 'above the admin limit: refused');
  perform pb.ok(pb.st('b2') like 'pending_approval/%', 'still pending, nothing posted');
  perform pb.ok(pb.err('owner', format('select public.bill_approve(%L)', pb.id('b2'))) = '', 'the owner (unlimited) approves it');
  perform pb.ok(pb.draft('member', 'A', 'b3', 'v1', 'F-101', jsonb_build_array(jsonb_build_object('cat', pb.cat('A', 'Gastos generales'), 'cents', 1500))) = ''
                and pb.err('member', format('select public.bill_submit(%L)', pb.id('b3'))) = '', 'a small bill (15.00) by the member');
  perform pb.ok(pb.err('member', format('select public.bill_approve(%L)', pb.id('b3'))) like '%SELF_APPROVAL_FORBIDDEN%', 'within the limit, but nobody approves their own bill');
  perform pb.ok(pb.err('admin', format('select public.bill_approve(%L)', pb.id('b3'))) = '', 'the admin approves it');
  perform pb.ok(pb.draft('admin', 'A', 'b4', 'v2', 'R-12', jsonb_build_array(jsonb_build_object('cat', pb.cat('A', 'Servicios públicos'), 'cents', 5000))) = ''
                and pb.err('admin', format('select public.bill_submit(%L)', pb.id('b4'))) = '', 'the admin records and submits a utilities bill');
  perform pb.ok(pb.err('admin', format('select public.bill_approve(%L)', pb.id('b4'))) like '%SELF_APPROVAL_FORBIDDEN%', 'the admin cannot approve it');
  perform pb.ok(pb.err('owner', format('select public.payables_save_settings(%L, true, 10000, true, 2000, true)', pb.id('A'))) = ''
                and pb.err('admin', format('select public.bill_approve(%L)', pb.id('b4'))) = '', 'with self-approval allowed by the owner, it can');
  perform pb.ok(pb.val('member', format('select count(*) from public.bills where company_id = %L', pb.id('A'))) = '3', 'members see only the bills they recorded');
  perform pb.ok(pb.val('member', format('select count(*) from public.bill_payments where company_id = %L', pb.id('A'))) = '0', 'members do not see payments');
end $$;

-- ------------------------------------------------------------- payments
do $$ declare p1 uuid; p1b uuid; p2 uuid; begin
  perform pb.ok(pb.err('member', format('select public.bill_pay(%L, 4000, current_date, %L)', pb.id('b1'), pb.acct('A', '1000'))) like '%FORBIDDEN%', 'members do not pay');
  perform pb.ok(pb.err('admin', format('select public.bill_pay(%L, 4000, current_date, %L)', pb.id('b1'), pb.acct('A', '1200'))) like '%PAYMENT_ACCOUNT_INVALID%', 'not from accounts receivable');
  perform pb.ok(pb.err('admin', format('select public.bill_pay(%L, 4000, current_date, %L)', pb.id('b1'), pb.acct('A', '6000'))) like '%PAYMENT_ACCOUNT_INVALID%', 'not from an expense account');
  p1 := pb.val('admin', format('select public.bill_pay(%L, 4000, current_date, %L, %L, %L, %L)', pb.id('b1'), pb.acct('A', '1000'), 'check', 'CK-1', 'pay-key-0001'))::uuid;
  perform pb.ok(p1 is not null and pb.st('b1') = 'partially_paid/4000/10000', 'partial payment of 40.00: partially paid');
  perform pb.ok(pb.lines('bill_payment', p1) = '2000:4000/0 1000:0/4000', 'Dr accounts payable / Cr cash');
  p1b := pb.val('admin', format('select public.bill_pay(%L, 4000, current_date, %L, %L, %L, %L)', pb.id('b1'), pb.acct('A', '1000'), 'check', 'CK-1', 'pay-key-0001'))::uuid;
  perform pb.ok(p1b = p1 and pb.entries('A', 'bill_payment') = 1 and pb.st('b1') = 'partially_paid/4000/10000', 'the same payment submitted again: same payment, one entry');
  perform pb.ok(pb.err('admin', format('select public.bill_pay(%L, 6001, current_date, %L)', pb.id('b1'), pb.acct('A', '1000'))) like '%PAYMENT_EXCEEDS_BALANCE%', 'overpayment refused');
  perform pb.ok(pb.err('admin', format('select public.bill_pay(%L, 0, current_date, %L)', pb.id('b1'), pb.acct('A', '1000'))) like '%AMOUNT_INVALID%', 'zero refused');
  p2 := pb.val('admin', format('select public.bill_pay(%L, 6000, current_date, %L, %L)', pb.id('b1'), pb.acct('A', '1010'), 'transfer'))::uuid;
  perform pb.ok(pb.st('b1') = 'paid/10000/10000' and pb.lines('bill_payment', p2) = '2000:6000/0 1010:0/6000', 'the rest from the bank: paid');
  perform pb.ok(pb.err('admin', format('select public.bill_pay(%L, 1, current_date, %L)', pb.id('b1'), pb.acct('A', '1000'))) like '%BILL_NOT_PAYABLE%', 'a paid bill takes no more payments');
  perform pb.ok(pb.err('admin', format('select public.bill_pay(%L, 100, current_date, %L)', pb.id('b7'), pb.acct('A', '1000'))) like '%BILL_NOT_FOUND%', 'unknown bill');
  perform pb.ok(pb.bal('A', '2000') = 150000 + 1500 + 5000 and pb.bal('A', '5000') = 7550 and pb.bal('A', '6000') = 2450 + 1500,
                'payable 1,565.00 left; expenses recorded once (payments did not add expense)');
  perform pb.ok(pb.bal('A', '1000') = -4000 and pb.bal('A', '1010') = -6000, 'cash and bank reduced by the payments');
  perform pb.ok(pb.merr(format('update public.bill_payments set amount_cents = 1 where id = %L', p1)) like '%PAYMENT_IMMUTABLE%', 'payments are not edited (maintenance)');
  perform pb.ok(pb.merr(format('delete from public.bill_payments where id = %L', p1)) like '%PAYMENT_IMMUTABLE%', 'nor deleted');
  -- void a payment
  perform pb.ok(pb.err('admin', format('select public.bill_payment_void(%L, %L)', p2, 'x')) like '%REASON_REQUIRED%', 'voiding a payment needs a reason');
  perform pb.ok(pb.err('admin', format('select public.bill_payment_void(%L, %L)', p2, 'Transferencia devuelta')) = '', 'the bank payment is voided');
  perform pb.ok(pb.st('b1') = 'partially_paid/4000/10000' and pb.lines('bill_payment_void', p2) = '2000:0/6000 1010:6000/0', 'reversal posted; the bill is partially paid again');
  perform pb.ok(pb.lines('bill_payment', p2) = '2000:6000/0 1010:0/6000', 'the original payment entry is kept');
  perform pb.ok(pb.err('admin', format('select public.bill_payment_void(%L, %L)', p2, 'Otra vez')) like '%PAYMENT_ALREADY_VOIDED%', 'a payment is voided once');
  perform pb.ok(pb.err('admin', format('select public.bill_void(%L, %L)', pb.id('b1'), 'Duplicada')) like '%BILL_HAS_PAYMENTS%', 'a bill with payments is not voided');
end $$;

-- ------------------------------------------------------------- voids, schedule, drafts
do $$ begin
  perform pb.ok(pb.err('admin', format('select public.bill_payment_void(%L, %L)', (select id from public.bill_payments where bill_id = pb.id('b1') and voided_at is null), 'Error de registro')) = ''
                and pb.st('b1') = 'approved/0/10000', 'its last payment voided: approved, nothing paid');
  perform pb.ok(pb.err('member', format('select public.bill_void(%L, %L)', pb.id('b1'), 'No procede')) like '%FORBIDDEN%', 'members do not void submitted bills');
  perform pb.ok(pb.err('admin', format('select public.bill_void(%L, %L)', pb.id('b1'), 'Factura duplicada del proveedor')) = '', 'the admin voids the approved bill');
  perform pb.ok(pb.lines('bill_void', pb.id('b1')) = '5000:0/7550 6000:0/2450 2000:10000/0' and pb.lines('bill', pb.id('b1')) = '5000:7550/0 6000:2450/0 2000:0/10000',
                'reversal of the approval entry; the original kept');
  perform pb.ok(pb.bal('A', '5000') = 0 and pb.bal('A', '1000') = 0, 'expense and cash back to zero');
  perform pb.ok(pb.err('admin', format('select public.bill_void(%L, %L)', pb.id('b1'), 'Otra vez')) like '%BILL_VOIDED%', 'a voided bill stays voided');
  perform pb.ok(pb.merr(format('update public.bills set status = %L where id = %L', 'approved', pb.id('b1'))) like '%BILL_VOIDED%', 'not even maintenance revives it');
  perform pb.ok(pb.draft('member', 'A', 'b7', 'v1', 'F-100', jsonb_build_array(jsonb_build_object('cat', pb.cat('A', 'Gastos generales'), 'cents', 100))) = '',
                'after the void, the vendor invoice number can be recorded again');
  perform pb.ok(pb.err('member', format('select public.bill_void(%L, %L)', pb.id('b7'), 'Borrador de prueba')) = '' and pb.entries('A', 'bill_void') = 1, 'voiding a draft posts nothing');
  perform pb.ok(pb.err('admin', format('select public.bill_schedule(%L, %L)', pb.id('b2'), public.ba_today() - 1)) like '%DATE_INVALID%', 'no payment scheduled in the past');
  perform pb.ok(pb.err('member', format('select public.bill_schedule(%L, %L)', pb.id('b2'), public.ba_today() + 10)) like '%FORBIDDEN%', 'members do not schedule');
  perform pb.ok(pb.err('admin', format('select public.bill_schedule(%L, %L)', pb.id('b2'), public.ba_today() + 10)) = '' and pb.st('b2') = 'scheduled/0/150000', 'the rent is scheduled');
  perform pb.ok(pb.err('admin', format('select public.bill_pay(%L, 50000, current_date, %L)', pb.id('b2'), pb.acct('A', '1010'))) = '' and pb.st('b2') = 'partially_paid/50000/150000',
                'a partial payment of a scheduled bill');
  perform pb.ok(pb.draft('member', 'A', 'b5', 'v1', null, jsonb_build_array(jsonb_build_object('cat', pb.cat('A', 'Viajes'), 'cents', 900))) = ''
                and pb.err('member', format('delete from public.bills where id = %L', pb.id('b5'))) = '', 'a draft can be deleted (logged)');
  perform pb.ok(exists (select 1 from public.payables_events where entity = 'bills' and entity_id = pb.id('b5')::text and action = 'deleted'), 'the deletion is in the history');
  perform pb.ok(pb.err('admin', format('delete from public.vendors where id = %L', pb.id('v1'))) like '%VENDOR_IN_USE%', 'a vendor with bills is not deleted');
  perform pb.ok(pb.err('admin', format('update public.vendors set status = %L where id = %L', 'archived', pb.id('v1'))) = '', 'it is archived');
  perform pb.ok(pb.err('admin', format('delete from public.expense_categories where id = %L', pb.cat('A', 'Alquiler'))) like '%CATEGORY_IN_USE%', 'a category in use is not deleted');
end $$;

-- ------------------------------------------------------------- closed period
do $$ declare lm date := (date_trunc('month', public.ba_today()) - interval '1 month')::date; begin
  perform pb.ok(pb.draft('admin', 'A', 'b6', 'v2', 'R-09', jsonb_build_array(jsonb_build_object('cat', pb.cat('A', 'Alquiler'), 'cents', 3000)), lm + 4) = ''
                and pb.err('admin', format('select public.bill_submit(%L)', pb.id('b6'))) = '', 'a bill dated last month, submitted');
  perform pb.ok(pb.err('owner', format('select public.ledger_close_period(%L, %L)', pb.id('A'), lm)) = '', 'last month is closed');
  perform pb.ok(pb.err('owner', format('select public.bill_approve(%L)', pb.id('b6'))) like '%PERIOD_CLOSED%' and pb.st('b6') like 'pending_approval/%',
                'approving a bill dated in a closed month: refused, nothing changed');
  perform pb.ok(pb.err('admin', format('select public.bill_pay(%L, 1000, %L, %L)', pb.id('b2'), lm + 5, pb.acct('A', '1000'))) like '%PERIOD_CLOSED%' and pb.st('b2') = 'partially_paid/50000/150000',
                'a payment dated in a closed month: refused, nothing changed');
end $$;

-- ------------------------------------------------------------- attachments
do $$ declare path text := pb.id('A') || '/' || pb.id('b2') || '/recibo.pdf'; bpath text := pb.id('B') || '/' || pb.id('b2') || '/x.pdf'; begin
  perform pb.ok(pb.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Finance-attachments', path)) = '', 'the member uploads a receipt for their bill');
  perform pb.ok(pb.err('member', format('insert into public.bill_attachments (company_id, bill_id, storage_path, file_name, content_type, size_bytes) values (%L, %L, %L, %L, %L, 2048)',
                pb.id('A'), pb.id('b2'), path, 'recibo.pdf', 'application/pdf')) = '', 'and attaches it (even after approval: evidence can be added)');
  perform pb.ok(pb.err('member', format('insert into public.bill_attachments (company_id, bill_id, storage_path, file_name, content_type, size_bytes) values (%L, %L, %L, %L, %L, 2048)',
                pb.id('A'), pb.id('b2'), pb.id('A') || '/' || pb.id('b2') || '/nada.pdf', 'nada.pdf', 'application/pdf')) like '%ATTACHMENT_FILE_MISSING%', 'an attachment needs its uploaded file');
  perform pb.ok(pb.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Finance-attachments', pb.id('A') || '/' || pb.id('b2') || '/x.exe')) = ''
                and pb.err('member', format('insert into public.bill_attachments (company_id, bill_id, storage_path, file_name, content_type, size_bytes) values (%L, %L, %L, %L, %L, 2048)',
                pb.id('A'), pb.id('b2'), pb.id('A') || '/' || pb.id('b2') || '/x.exe', 'x.exe', 'application/x-msdownload')) like '%check%', 'only PDF and images (the bucket also limits types and 10 MB)');
  perform pb.ok(pb.err('other', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Finance-attachments', bpath)) like '%row-level security%',
                'isolation: B cannot upload into A''s bill (even under its own company folder)');
  perform pb.ok(pb.err('other', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Finance-attachments', pb.id('A') || '/' || pb.id('b2') || '/y.pdf')) like '%row-level security%',
                'isolation: B cannot upload into A''s folder');
  perform pb.ok(pb.val('other', format('select count(*) from storage.objects where name = %L', path)) = '0' and pb.val('other', 'select count(*) from public.bill_attachments') = '0',
                'isolation: B sees neither the file nor the record');
  perform pb.ok(pb.val('admin', format('select count(*) from storage.objects where name = %L', path)) = '1', 'the admin of A sees the file');
  perform pb.ok(pb.err('member', format('delete from public.bill_attachments where storage_path = %L', path)) like '%ATTACHMENT_LOCKED%', 'an attachment of a submitted bill is kept');
  perform pb.ok(pb.err('admin', format('delete from storage.objects where name = %L', path)) = '' and (select count(*) from storage.objects where name = path) = 1,
                'its file cannot be deleted from storage either');
  perform pb.ok(pb.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Finance-attachments', pb.id('A') || '/' || pb.id('b7') || '/z.pdf')) like '%row-level security%',
                'no uploads to a voided bill');
end $$;

-- ------------------------------------------------------------- recurring expenses
do $$ declare n int; begin
  perform pb.ok(pb.err('member', format('insert into public.recurring_expenses (company_id, vendor_id, category_id, description, amount_cents, frequency, start_date) values (%L, %L, %L, %L, 120000, %L, %L)',
                pb.id('A'), pb.id('v2'), pb.cat('A', 'Alquiler'), 'Renta mensual', 'monthly', public.ba_today())) like '%row-level security%', 'members do not create recurring expenses');
  perform pb.ok(pb.err('admin', format('insert into public.recurring_expenses (id, company_id, vendor_id, category_id, description, amount_cents, frequency, start_date, due_days) values (%L, %L, %L, %L, %L, 120000, %L, %L, 5)',
                pb.id('r1'), pb.id('A'), pb.id('v2'), pb.cat('A', 'Alquiler'), 'Renta mensual', 'monthly', (public.ba_today() - interval '2 months')::date)) = '', 'monthly rent starting two months ago');
  perform pb.ok(pb.err('admin', format('insert into public.recurring_expenses (id, company_id, vendor_id, category_id, description, amount_cents, frequency, start_date, auto_submit) values (%L, %L, %L, %L, %L, 3500, %L, %L, true)',
                pb.id('r2'), pb.id('A'), pb.id('v2'), pb.cat('A', 'Servicios públicos'), 'Internet', 'weekly', public.ba_today() + 3)) = '', 'weekly internet starting in three days (auto-submit)');
  perform pb.ok(pb.err('admin', format('update public.recurring_expenses set next_date = %L where id = %L', public.ba_today() - 400, pb.id('r1'))) like '%permission denied%', 'the next date is not set by hand');
  n := pb.val('admin', format('select public.recurring_generate(%L)', pb.id('A')))::int;
  perform pb.ok(n = 3, format('generation: three rent bills up to today, none in the future (%s)', n));
  perform pb.ok((select count(*) from public.bills where recurring_id = pb.id('r2')) = 0, 'nothing for a template that starts in the future');
  perform pb.ok((select bool_and(status = 'draft' and total_cents = 120000 and due_date = bill_date + 5) from public.bills where recurring_id = pb.id('r1')), 'drafts of 1,200.00 due 5 days after');
  perform pb.ok(pb.val('admin', format('select public.recurring_generate(%L)', pb.id('A')))::int = 0 and (select count(*) from public.bills where recurring_id = pb.id('r1')) = 3,
                'generating again creates nothing (one bill per template and period)');
  perform pb.ok((select next_date > public.ba_today() from public.recurring_expenses where id = pb.id('r1')), 'the next date moved past today');
  perform pb.ok(pb.merr(format('insert into public.bills (company_id, vendor_id, bill_date, description, recurring_id, recurring_period) values (%L, %L, %L, %L, %L, %L)',
                pb.id('A'), pb.id('v2'), (public.ba_today() - interval '2 months')::date, 'dup', pb.id('r1'), (public.ba_today() - interval '2 months')::date)) like '%bills_recurring_uidx%',
                'not even maintenance creates the same period twice');
  perform pb.ok((select count(*) from public.journal_entries where source = 'bill' and source_id in (select id from public.bills where recurring_id = pb.id('r1'))) = 0, 'generated drafts post nothing');
  perform pb.ok(pb.err('admin', format('delete from public.recurring_expenses where id = %L', pb.id('r1'))) like '%RECURRING_IN_USE%', 'a template with bills is paused, not deleted');
  perform pb.ok(pb.err('member', format('select public.recurring_generate(%L)', pb.id('A'))) like '%FORBIDDEN%', 'members do not generate');
  perform pb.ok(pb.err('admin', format('insert into public.bills (company_id, vendor_id, bill_date, description, idempotency_key) values (%L, %L, current_date, %L, %L)', pb.id('A'), pb.id('v2'), 'Uno', 'bill-form-0001')) = ''
                and pb.err('admin', format('insert into public.bills (company_id, vendor_id, bill_date, description, idempotency_key) values (%L, %L, current_date, %L, %L)', pb.id('A'), pb.id('v2'), 'Uno', 'bill-form-0001')) like '%bills_idem_uidx%',
                'the same bill form submitted twice: one bill');
end $$;

-- ------------------------------------------------------------- reports and integrity
do $$ begin
  perform pb.ok(pb.val('admin', format('select string_agg(label || ''='' || total_cents, '','' order by label) from public.payables_report(%L, current_date - 60, current_date, %L)', pb.id('A'), 'category'))
                = 'Alquiler=150000,Gastos generales=1500,Servicios públicos=5000', 'by category: approved bills only (voided and drafts excluded)');
  perform pb.ok(pb.val('admin', format('select string_agg(label || ''='' || total_cents || ''/'' || paid_cents, '','' order by label) from public.payables_report(%L, current_date - 60, current_date, %L)', pb.id('A'), 'vendor'))
                = 'Arrendador Dos=155000/50000,Ferretería Uno=1500/0', 'by vendor: totals and paid');
  perform pb.ok(pb.val('admin', format('select sum(total_cents) from public.payables_report(%L, current_date - 60, current_date, %L)', pb.id('A'), 'month'))::bigint = 156500, 'by month');
  perform pb.ok(pb.val('member', format('select count(*) from public.payables_report(%L, current_date - 60, current_date, %L)', pb.id('A'), 'vendor')) = '0', 'members read no reports');
  perform pb.ok(pb.val('admin', format('select payable_cents = open_bills_cents and posted_bill_cents = approved_bills_cents and unposted_bills = 0 and payable_cents = 106500 from public.payables_integrity(%L)', pb.id('A')))::boolean,
                'integrity: accounts payable 1,065.00 = open approved bills; ledger expense = approved bills');
  perform pb.ok(pb.val('owner', format('select sum(debit_cents) = sum(credit_cents) from public.ledger_trial_balance(%L)', pb.id('A')))::boolean, 'the trial balance still balances');
  perform pb.ok(pb.val('other', format('select count(*) from public.payables_integrity(%L)', pb.id('A'))) = '0', 'isolation: B reads nothing of A');
  perform pb.ok((select count(*) from public.payables_events where company_id = pb.id('A') and action in ('submitted', 'approved', 'rejected', 'paid', 'payment_voided', 'voided', 'scheduled', 'generated', 'attachment_added')) >= 14,
                'history: submissions, approvals, rejections, payments, voids, schedules, generation, attachments');
  perform pb.ok(pb.merr(format('update public.payables_events set action = %L where company_id = %L', 'x', pb.id('A'))) like '%LEDGER_IMMUTABLE%', 'the history is append-only');
end $$;

-- ------------------------------------------------------------- atomic draft save (app path)
do $$ declare bid uuid; bid2 uuid; lns jsonb; begin
  lns := jsonb_build_array(jsonb_build_object('category_id', pb.cat('A', 'Gastos generales'), 'amount_cents', '1234', 'description', 'Papel'),
                           jsonb_build_object('category_id', pb.cat('A', 'Viajes'), 'amount_cents', '766'));
  bid := pb.val('member', format('select public.bill_save_draft(%L, null, %L, %L, current_date, null, %L, null, %L, %L)', pb.id('A'), pb.id('v2'), 'S-1', 'Oficina', lns, 'save-key-0001'))::uuid;
  perform pb.ok(bid is not null and (select total_cents from public.bills where id = bid) = 2000, 'bill_save_draft: bill and lines in one call (20.00)');
  bid2 := pb.val('member', format('select public.bill_save_draft(%L, null, %L, %L, current_date, null, %L, null, %L, %L)', pb.id('A'), pb.id('v2'), 'S-1', 'Oficina', lns, 'save-key-0001'))::uuid;
  perform pb.ok(bid2 = bid and (select count(*) from public.bills where vendor_invoice_number = 'S-1') = 1, 'the same form twice: one bill');
  perform pb.ok(pb.err('member', format('select public.bill_save_draft(%L, %L, %L, %L, current_date, null, %L, null, %L)', pb.id('A'), bid, pb.id('v2'), 'S-1', 'Oficina',
                jsonb_build_array(jsonb_build_object('category_id', pb.cat('A', 'Gastos generales'), 'amount_cents', '500')))) = '', 'the draft is edited');
  perform pb.ok((select total_cents from public.bills where id = bid) = 500 and (select count(*) from public.bill_lines where bill_id = bid) = 1, 'editing the draft replaced its lines');
  perform pb.ok(pb.err('member', format('select public.bill_save_draft(%L, null, %L, null, current_date, null, %L, null, %L)', pb.id('A'), pb.id('v2'), 'X',
                jsonb_build_array(jsonb_build_object('category_id', pb.cat('A', 'Gastos generales'), 'amount_cents', '10.5')))) like '%AMOUNT_INVALID%', 'integer cents only');
  perform pb.ok(pb.err('member', format('select public.bill_save_draft(%L, null, %L, null, current_date, null, %L, null, %L)', pb.id('A'), pb.id('vB'), 'X',
                jsonb_build_array(jsonb_build_object('category_id', pb.cat('A', 'Gastos generales'), 'amount_cents', '100')))) like '%VENDOR_INVALID%', 'isolation: no vendor of another company');
  perform pb.ok(pb.err('member', format('select public.bill_save_draft(%L, null, %L, null, current_date, null, %L, null, %L)', pb.id('A'), pb.id('v2'), 'X',
                jsonb_build_array(jsonb_build_object('category_id', pb.cat('B', 'Gastos generales'), 'amount_cents', '100')))) like '%CATEGORY_INVALID%', 'isolation: no category of another company');
  perform pb.ok(pb.err('member', format('select public.bill_submit(%L)', bid)) = ''
                and pb.err('member', format('select public.bill_save_draft(%L, %L, %L, null, current_date, null, %L, null, %L)', pb.id('A'), bid, pb.id('v2'), 'X',
                jsonb_build_array(jsonb_build_object('category_id', pb.cat('A', 'Gastos generales'), 'amount_cents', '100')))) like '%BILL_LOCKED%', 'a submitted bill is not saved as a draft');
  perform pb.ok(pb.err('other', format('select public.bill_save_draft(%L, %L, %L, null, current_date, null, %L, null, %L)', pb.id('B'), bid, pb.id('vB'), 'X',
                jsonb_build_array(jsonb_build_object('category_id', pb.cat('B', 'Gastos generales'), 'amount_cents', '100')))) like '%BILL_NOT_FOUND%', 'isolation: B cannot overwrite A''s bill');
end $$;

-- ------------------------------------------------------------- company deletion
do $$ begin
  perform pb.ok(pb.draft('other', 'B', 'bB', 'vB', 'B-1', jsonb_build_array(jsonb_build_object('cat', pb.cat('B', 'Gastos generales'), 'cents', 2500))) = ''
                and pb.err('other', format('select public.bill_submit(%L)', pb.id('bB'))) = '' and pb.err('other', format('select public.bill_approve(%L)', pb.id('bB'))) = ''
                and pb.err('other', format('select public.bill_pay(%L, 2500, current_date, %L)', pb.id('bB'), pb.acct('B', '1000'))) = '', 'B: a bill approved by its owner and paid');
  perform pb.ok(pb.merr(format('delete from public.companies where id = %L', pb.id('B'))) = '', 'deleting a whole company removes its payables and ledger (cascade)');
  perform pb.ok((select count(*) from public.bills where company_id = pb.id('B')) + (select count(*) from public.vendors where company_id = pb.id('B')) = 0, 'nothing of B is left');
  perform pb.ok((select count(*) from public.bills where company_id = pb.id('A')) > 0, 'A is untouched');
end $$;

do $$ begin
  if exists (select 1 from pb.failures) then
    raise exception 'PAYABLES TESTS FAILED: %', (select string_agg(msg, ' | ') from pb.failures);
  end if;
  raise notice 'ALL PAYABLES TESTS PASSED';
end $$;
