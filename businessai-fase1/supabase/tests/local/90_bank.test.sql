-- Bank accounts, statement import, matching and reconciliation (0026).
-- TEST-ONLY, local throw-away database with 0014a, 0015, 0023 … 0026. Schema bk.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema bk;
create table bk.ctx (key text primary key, val text not null);
create function bk.id(k text) returns uuid language sql stable as $$ select val::uuid from bk.ctx where key = k $$;
create table bk.failures (msg text);
create function bk.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into bk.failures values (msg); end if;
end $$;
grant usage on schema bk to authenticated;
grant select on bk.ctx to authenticated;
grant execute on all functions in schema bk to authenticated;
create function bk.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', bk.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function bk.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', bk.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function bk.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
create function bk.acct(co text, c text) returns uuid language sql volatile as $$ select id from public.ledger_accounts where company_id = bk.id(co) and code = c $$;
create function bk.bal(co text, c text) returns bigint language sql volatile as $$ select balance_cents from public.ledger_trial_balance(bk.id(co)) where code = c $$;
create function bk.d(n int) returns text language sql stable as $$ select (public.ba_today() + n)::text $$;
-- A statement row (normalized as the app sends it).
create function bk.row(day int, cents bigint, descr text, ref text default null, txn text default null) returns jsonb language sql stable as $$
  select jsonb_build_object('date', bk.d(day), 'description', descr, 'reference', ref, 'amount_cents', cents::text, 'bank_txn_id', txn, 'raw', jsonb_build_object('d', descr)) $$;
create function bk.sha(t text) returns text language sql immutable as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function bk.line(descr text) returns uuid language sql volatile as $$
  select id from public.bank_lines where description = descr and status <> 'excluded' order by created_at limit 1 $$;
-- The open journal line on 1010 of an entry (by source id or description).
create function bk.jl(src uuid) returns bigint language sql volatile as $$
  select l.id from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
  join public.ledger_accounts a on a.id = l.account_id where e.source_id = src and a.code in ('1010', '1000') limit 1 $$;
-- A paid invoice (member); payment dated `day`, into `deposit` (ledger code or null = cash).
create function bk.paid_invoice(inv text, total numeric, pay numeric, day int, deposit text, ref text, pay_key text) returns text language plpgsql as $$
declare msg text;
begin
  msg := bk.err('member', format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, total, issue_date, due_date)
    values (%L, %L, %L, %L, %L, %L, %L, %s, %s, %L, %L)', bk.id(inv), bk.id('A'), bk.id('c1'), bk.id('member'), 'invoice', 'x', 'sent', total, total, bk.d(-30), bk.d(-1)));
  if msg <> '' then return msg; end if;
  if pay is null then return ''; end if;
  return bk.err('member', format('insert into public.payments (id, company_id, document_id, amount, created_by, paid_at, reference, deposit_account_id) values (%L, %L, %L, %s, %L, %L, %L, %L)',
    bk.id(pay_key), bk.id('A'), bk.id(inv), pay, bk.id('member'), (public.ba_today() + day)::timestamp + interval '15 hours', ref, case when deposit is null then null else bk.acct('A', deposit) end));
end $$;

insert into bk.ctx values
  ('owner', 'a1000000-0000-4000-8000-0000000000b1'), ('admin', 'a1000000-0000-4000-8000-0000000000b2'),
  ('member', 'a1000000-0000-4000-8000-0000000000b3'), ('other', 'a1000000-0000-4000-8000-0000000000b4'),
  ('A', 'a2000000-0000-4000-8000-0000000000b1'), ('B', 'a2000000-0000-4000-8000-0000000000b2'), ('c1', 'a3000000-0000-4000-8000-0000000000b1'),
  ('i1', 'a4000000-0000-4000-8000-0000000000b1'), ('i2', 'a4000000-0000-4000-8000-0000000000b2'), ('i3', 'a4000000-0000-4000-8000-0000000000b3'),
  ('i4', 'a4000000-0000-4000-8000-0000000000b4'), ('i5', 'a4000000-0000-4000-8000-0000000000b5'), ('i6', 'a4000000-0000-4000-8000-0000000000b6'),
  ('p1', 'a5000000-0000-4000-8000-0000000000b1'), ('p2a', 'a5000000-0000-4000-8000-0000000000b2'), ('p2b', 'a5000000-0000-4000-8000-0000000000b3'),
  ('p3', 'a5000000-0000-4000-8000-0000000000b4'), ('p4', 'a5000000-0000-4000-8000-0000000000b5'), ('p5', 'a5000000-0000-4000-8000-0000000000b6'),
  ('p6', 'a5000000-0000-4000-8000-0000000000b7'), ('i7', 'a4000000-0000-4000-8000-0000000000b7'),
  ('v1', 'a6000000-0000-4000-8000-0000000000b1'), ('bill1', 'a7000000-0000-4000-8000-0000000000b1');
insert into auth.users (id, email) select val::uuid, key || '@bk.test' from bk.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (bk.id('A'), 'Banco A', bk.id('owner')), (bk.id('B'), 'Banco B', bk.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (bk.id('A'), 'cus_bk_a', 'sub_bk_a', 'pro', 'active'), (bk.id('B'), 'cus_bk_b', 'sub_bk_b', 'basic', 'active');
insert into public.memberships (company_id, user_id, role) values
  (bk.id('A'), bk.id('owner'), 'owner'), (bk.id('A'), bk.id('admin'), 'admin'), (bk.id('A'), bk.id('member'), 'member'), (bk.id('B'), bk.id('other'), 'owner');
insert into public.clients (id, company_id, name) values (bk.id('c1'), bk.id('A'), 'Cliente Banco');

-- ------------------------------------------------------------- bank accounts
do $$ begin
  perform bk.ok(bk.err('member', format('select public.bank_init(%L)', bk.id('A'))) like '%FORBIDDEN%', 'members do not set up banking');
  perform bk.ok(bk.err('admin', format('select public.bank_init(%L)', bk.id('A'))) = '' and bk.acct('A', '6500') is not null, 'the admin sets up banking (bank fees account 6500)');
  perform bk.ok(bk.err('other', format('select public.bank_init(%L)', bk.id('B'))) = '', 'company B too');
  perform bk.ok(bk.err('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', bk.id('A'), 'Operativa', 'Banco Popular', '12', bk.acct('A', '1010'))) like '%LAST4_INVALID%', 'only the last four digits');
  perform bk.ok(bk.err('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', bk.id('A'), 'Operativa', 'Banco Popular', '4821', bk.acct('A', '1200'))) like '%BANK_LEDGER_ACCOUNT_INVALID%', 'not on accounts receivable');
  perform bk.ok(bk.err('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L, %L)', bk.id('A'), 'Euros', null, null, bk.acct('A', '1010'), 'EUR')) like '%CURRENCY_NOT_SUPPORTED%', 'only the base currency for now');
  perform bk.ok(bk.err('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', bk.id('A'), 'Operativa', 'Banco Popular', '4821', bk.acct('A', '1010'))) = '', 'bank account Operativa ↔ 1010 Bank');
  perform bk.ok(bk.err('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', bk.id('A'), 'Otra', null, null, bk.acct('A', '1010'))) like '%bank_accounts_ledger_uidx%', 'one bank account per ledger account');
  perform bk.ok(bk.err('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', bk.id('A'), 'Caja', 'Depósitos', '0007', bk.acct('A', '1000'))) = '', 'bank account Caja ↔ 1000 Cash');
  perform bk.ok(bk.err('other', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', bk.id('B'), 'X', null, null, bk.acct('A', '1010'))) like '%BANK_LEDGER_ACCOUNT_INVALID%', 'isolation: B cannot link A''s ledger account');
  perform bk.ok(bk.val('other', format('select count(*) from public.bank_accounts where company_id = %L', bk.id('A'))) = '0', 'isolation: B sees no bank account of A');
  perform bk.ok(bk.val('member', format('select count(*) from public.bank_accounts where company_id = %L', bk.id('A'))) = '0', 'members see no bank accounts');
  perform bk.ok(bk.err('admin', format('insert into public.bank_accounts (company_id, name, ledger_account_id) values (%L, %L, %L)', bk.id('A'), 'X', bk.acct('A', '1500'))) like '%permission denied%', 'bank accounts only through the functions');
end $$;
insert into bk.ctx select 'ba1', id::text from public.bank_accounts where name = 'Operativa';
insert into bk.ctx select 'ba2', id::text from public.bank_accounts where name = 'Caja';

-- ------------------------------------------------------------- the books (earlier deliveries)
do $$ begin
  perform bk.ok(bk.paid_invoice('i6', 10, 10, -5, '1200', null, 'p6') like '%PAYMENT_ACCOUNT_INVALID%', 'a client payment is not deposited into receivables');
  perform bk.ok(bk.paid_invoice('i1', 500, 500, -15, '1010', 'DEP-881', 'p1') = '', 'client payment 500.00 deposited into the bank (-15 days)');
  perform bk.ok(bk.paid_invoice('i2', 200, 120, -12, '1010', null, 'p2a') = '' and bk.err('member', format('insert into public.payments (id, company_id, document_id, amount, created_by, paid_at, deposit_account_id) values (%L, %L, %L, 80, %L, %L, %L)',
                bk.id('p2b'), bk.id('A'), bk.id('i2'), bk.id('member'), (public.ba_today() - 12)::timestamp + interval '16 hours', bk.acct('A', '1010'))) = '', 'two payments 120 + 80 the same day (one bank deposit)');
  perform bk.ok(bk.paid_invoice('i3', 40, 40, -3, '1010', null, 'p3') = '' and bk.paid_invoice('i4', 40, 40, -3, '1010', null, 'p4') = '', 'two payments of 40 the same day (ambiguous)');
  perform bk.ok(bk.paid_invoice('i5', 75, 75, -2, '1010', null, 'p5') = '', 'a payment of 75 not yet in the bank (deposit in transit)');
  perform bk.ok((select string_agg(a.code || ':' || l.debit_cents, ',') from public.journal_entries e join public.journal_lines l on l.entry_id = e.id join public.ledger_accounts a on a.id = l.account_id
                 where e.source = 'payment' and e.source_id = bk.id('p1') and l.debit_cents > 0) = '1010:50000', 'the payment entry debits the bank account chosen (not cash)');
  perform bk.ok(bk.err('admin', format('select public.payables_init(%L)', bk.id('A'))) = ''
                and bk.err('admin', format('insert into public.vendors (id, company_id, name) values (%L, %L, %L)', bk.id('v1'), bk.id('A'), 'Proveedor Banco')) = '', 'payables and a vendor');
  perform bk.ok(bk.err('admin', format('select public.bill_save_draft(%L, %L, %L, %L, %L, null, %L, null, %L)', bk.id('A'), null, bk.id('v1'), 'F-1001', bk.d(-9), 'Materiales',
                  jsonb_build_array(jsonb_build_object('category_id', (select id from public.expense_categories where company_id = bk.id('A') and name = 'Gastos generales'), 'amount_cents', '30000')))) = '',
                'a vendor bill of 300.00');
  update bk.ctx set val = val where false;
  insert into bk.ctx select 'bill1x', id::text from public.bills where company_id = bk.id('A') and vendor_invoice_number = 'F-1001';
  perform bk.ok(bk.err('owner', format('select public.bill_submit(%L)', bk.id('bill1x'))) = '' and bk.err('owner', format('select public.bill_approve(%L)', bk.id('bill1x'))) = ''
                and bk.err('admin', format('select public.bill_pay(%L, 30000, %L, %L, %L, %L)', bk.id('bill1x'), bk.d(-8), bk.acct('A', '1010'), 'check', 'CK-1001')) = '', 'approved and paid from the bank by check 1001 (-8 days)');
  perform bk.ok(bk.err('owner', format('select public.ledger_post_manual(%L, %L, %L, %L, %L)', bk.id('A'), bk.d(-10), 'Aportación del dueño', 'TRF-55',
                jsonb_build_array(jsonb_build_object('account', bk.acct('A', '1010'), 'debit', 100000), jsonb_build_object('account', bk.acct('A', '3000'), 'credit', 100000)))) = '', 'owner contribution 1,000.00 into the bank (-10 days)');
  perform bk.ok(bk.paid_invoice('i7', 60, 60, -6, null, null, 'p6') = '', 'a client payment of 60.00 to cash (default, -6 days)');
end $$;

-- ------------------------------------------------------------- import
do $$ declare r record; rows jsonb; begin
  rows := jsonb_build_array(bk.row(-15, 50000, 'DEPOSITO REF DEP-881', 'DEP-881'), bk.row(-12, 20000, 'DEPOSITO SUCURSAL'), bk.row(-8, -30000, 'CHEQUE 1001', 'CK-1001'),
                            bk.row(-10, 100000, 'TRANSFERENCIA DUEÑO'), bk.row(-5, -1500, 'MONTHLY SERVICE FEE'), bk.row(-4, -2000, 'CARGO DESCONOCIDO'),
                            bk.row(-3, 4000, 'DEPOSITO A'), bk.row(-3, 4000, 'DEPOSITO B'), bk.row(-5, -1500, 'MONTHLY SERVICE FEE'));
  perform bk.ok(bk.err('member', format('select * from public.bank_import(%L, %L, %L, %L, %L)', bk.id('ba1'), 'estado.csv', bk.sha('file-1'), '{}', rows)) like '%BANK_ACCOUNT_NOT_FOUND%', 'members do not import');
  perform bk.ok(bk.err('other', format('select * from public.bank_import(%L, %L, %L, %L, %L)', bk.id('ba1'), 'estado.csv', bk.sha('file-1'), '{}', rows)) like '%BANK_ACCOUNT_NOT_FOUND%', 'isolation: B cannot import into A''s account');
  perform bk.ok(bk.err('admin', format('select * from public.bank_import(%L, %L, %L, %L, %L)', bk.id('ba1'), 'malo.csv', bk.sha('bad-1'), '{}',
                rows || jsonb_build_array(jsonb_build_object('date', '2026-13-40', 'description', 'X', 'amount_cents', '100')))) like '%IMPORT_ROW_INVALID%', 'an invalid date refuses the whole file');
  perform bk.ok(bk.err('admin', format('select * from public.bank_import(%L, %L, %L, %L, %L)', bk.id('ba1'), 'malo.csv', bk.sha('bad-2'), '{}',
                jsonb_build_array(jsonb_build_object('date', bk.d(-1), 'description', 'X', 'amount_cents', '10.50')))) like '%IMPORT_ROW_INVALID%', 'decimal amounts refused (integer cents)');
  perform bk.ok(bk.err('admin', format('select * from public.bank_import(%L, %L, %L, %L, %L)', bk.id('ba1'), 'malo.csv', bk.sha('bad-3'), '{}',
                jsonb_build_array(jsonb_build_object('date', bk.d(-1), 'description', '  ', 'amount_cents', '100')))) like '%IMPORT_ROW_INVALID%', 'a row without description refused');
  perform bk.ok(bk.err('admin', format('select * from public.bank_import(%L, %L, %L, %L, %L)', bk.id('ba1'), 'malo.csv', bk.sha('bad-4'), '{}',
                jsonb_build_array(jsonb_build_object('date', bk.d(-1), 'description', 'X', 'amount_cents', '0')))) like '%IMPORT_ROW_INVALID%', 'zero amounts refused');
  perform bk.ok((select count(*) from public.bank_lines) = 0 and (select count(*) from public.bank_imports) = 0, 'refused files left nothing behind');
  select * into r from public.bank_import(bk.id('ba1'), 'estado-oct.csv', bk.sha('file-1'), '{"date":"Fecha"}', rows);
  perform bk.ok(r.imported = 8 and r.duplicates = 1 and not r.already, format('valid file: 8 lines imported, the identical row inside the file is a duplicate (%s/%s)', r.imported, r.duplicates));
  select * into r from public.bank_import(bk.id('ba1'), 'estado-oct (copia).csv', bk.sha('file-1'), '{}', rows);
  perform bk.ok(r.already and r.imported = 0 and (select count(*) from public.bank_lines where bank_account_id = bk.id('ba1')) = 8, 'the same file again: recognised, nothing imported');
  select * into r from public.bank_import(bk.id('ba1'), 'solape.csv', bk.sha('file-2'), '{}', jsonb_build_array(bk.row(-15, 50000, 'DEPOSITO REF DEP-881', 'DEP-881'), bk.row(-8, -30000, 'CHEQUE 1001', 'CK-1001')));
  perform bk.ok(r.imported = 0 and r.duplicates = 2, 'an overlapping statement: its lines are recognised as already imported');
  select * into r from public.bank_import(bk.id('ba2'), 'caja.csv', bk.sha('file-3'), '{}', jsonb_build_array(bk.row(-6, 6000, 'DEPOSITO EFECTIVO'), bk.row(-6, 500, 'MONEDAS'), bk.row(-6, 500, 'MONEDAS')), true);
  perform bk.ok(r.imported = 3, 'identical rows stated as separate transactions are kept');
  select * into r from public.bank_import(bk.id('ba2'), 'ids.csv', bk.sha('file-4'), '{}', jsonb_build_array(bk.row(-6, 900, 'POS 1', null, 'TX-1'), bk.row(-6, 900, 'POS 1', null, 'TX-2')));
  perform bk.ok(r.imported = 2, 'bank transaction ids distinguish identical rows');
  select * into r from public.bank_import(bk.id('ba2'), 'ids2.csv', bk.sha('file-5'), '{}', jsonb_build_array(bk.row(-6, 900, 'POS 1 (texto distinto)', null, 'TX-1')));
  perform bk.ok(r.imported = 0 and r.duplicates = 1, 'the same bank transaction id in another file: duplicate');
  perform bk.ok(bk.merr(format('update public.bank_lines set amount_cents = 1 where id = %L', bk.line('CHEQUE 1001'))) like '%BANK_RECORD_IMMUTABLE%', 'statement lines are not edited (maintenance)');
  perform bk.ok(bk.merr(format('delete from public.bank_lines where id = %L', bk.line('CHEQUE 1001'))) like '%BANK_RECORD_IMMUTABLE%', 'nor deleted');
  perform bk.ok(bk.bal('A', '4000') = 92500 and bk.bal('A', '6000') = 30000, 'importing changed no revenue or expense');
end $$;

-- ------------------------------------------------------------- suggestions and matching
do $$ declare n int; g uuid; g2 uuid; begin
  perform bk.ok(bk.val('admin', format('select confidence || ''/'' || ambiguous from public.bank_suggestions(%L) where bank_line_id = %L', bk.id('ba1'), bk.line('DEPOSITO REF DEP-881'))) = '100/false',
                'exact: amount, date and reference → 100');
  perform bk.ok(bk.val('admin', format('select confidence || ''/'' || ambiguous from public.bank_suggestions(%L) where bank_line_id = %L', bk.id('ba1'), bk.line('CHEQUE 1001'))) = '100/false',
                'check 1001: amount, date and reference → 100');
  perform bk.ok(bk.val('admin', format('select confidence || ''/'' || ambiguous from public.bank_suggestions(%L) where bank_line_id = %L', bk.id('ba1'), bk.line('TRANSFERENCIA DUEÑO'))) = '95/false',
                'transfer: amount and date → 95');
  perform bk.ok(bk.val('admin', format('select bool_and(ambiguous) from public.bank_suggestions(%L) where bank_line_id in (%L, %L)', bk.id('ba1'), bk.line('DEPOSITO A'), bk.line('DEPOSITO B')))::boolean,
                'two deposits of 40 vs two payments of 40 the same day: ambiguous');
  perform bk.ok(bk.val('admin', format('select reason || ''/'' || cardinality(journal_line_ids) from public.bank_suggestions(%L) where bank_line_id = %L', bk.id('ba1'), bk.line('DEPOSITO SUCURSAL'))) = 'group_same_date/2',
                'one deposit = two payments of the same day: group suggestion');
  perform bk.ok(bk.val('admin', format('select reason from public.bank_suggestions(%L) where bank_line_id = %L', bk.id('ba1'), bk.line('MONTHLY SERVICE FEE'))) = 'bank_fee_or_unknown',
                'a service fee without a book line: identified as a bank charge');
  perform bk.ok(bk.err('member', format('select public.bank_auto_match(%L)', bk.id('ba1'))) like '%BANK_ACCOUNT_NOT_FOUND%', 'members do not match');
  n := bk.val('admin', format('select public.bank_auto_match(%L)', bk.id('ba1')))::int;
  perform bk.ok(n = 3, format('auto-match confirms only the 3 exact, unambiguous lines (%s)', n));
  perform bk.ok((select status from public.bank_lines where id = bk.line('DEPOSITO A')) = 'unmatched' and (select status from public.bank_lines where id = bk.line('DEPOSITO SUCURSAL')) = 'unmatched',
                'ambiguous and group suggestions are not confirmed automatically');
  perform bk.ok(bk.err('admin', format('select public.bank_match(%L, %L)', array[bk.line('DEPOSITO SUCURSAL')], array[bk.jl(bk.id('p2a'))])) like '%MATCH_AMOUNT_MISMATCH%', 'sums must be exactly equal');
  g := bk.val('admin', format('select public.bank_match(%L, %L, %L)', array[bk.line('DEPOSITO SUCURSAL')], array[bk.jl(bk.id('p2a')), bk.jl(bk.id('p2b'))], 'Depósito de dos cobros'))::uuid;
  perform bk.ok(g is not null and (select count(*) from public.bank_match_items where group_id = g) = 3, 'one bank line ↔ two payments (multiple match)');
  g2 := bk.val('admin', format('select public.bank_match(%L, %L)', array[bk.line('DEPOSITO SUCURSAL')], array[bk.jl(bk.id('p2b')), bk.jl(bk.id('p2a'))]))::uuid;
  perform bk.ok(g2 = g, 'the same match again returns the same group (idempotent)');
  perform bk.ok(bk.err('admin', format('select public.bank_match(%L, %L)', array[bk.line('DEPOSITO A')], array[bk.jl(bk.id('p2a'))])) like '%JOURNAL_LINE_NOT_AVAILABLE%', 'a book line is matched once');
  perform bk.ok(bk.err('admin', format('select public.bank_match(%L, %L)', array[bk.line('DEPOSITO A')], array[(select l.id from public.journal_lines l join public.journal_entries e on e.id = l.entry_id where e.source_id = bk.id('p3') and l.credit_cents > 0)]))
                like '%JOURNAL_LINE_NOT_AVAILABLE%', 'only book lines of the linked ledger account (not receivables)');
  perform bk.ok(bk.err('admin', format('select public.bank_match(%L, %L)', array[bk.line('DEPOSITO A'), bk.line('DEPOSITO EFECTIVO')], array[bk.jl(bk.id('p3'))])) like '%BANK_LINE_NOT_AVAILABLE%', 'only lines of the same bank account');
  perform bk.ok(bk.err('admin', format('select public.bank_match(%L, %L)', array[bk.line('DEPOSITO A')], array[bk.jl(bk.id('p3'))])) = ''
                and bk.err('admin', format('select public.bank_match(%L, %L)', array[bk.line('DEPOSITO B')], array[bk.jl(bk.id('p4'))])) = '', 'the ambiguous pair is matched by hand');
  perform bk.ok(bk.err('admin', format('select public.bank_unmatch(%L, %L)', g, '')) like '%REASON_REQUIRED%', 'unmatching needs a reason');
  perform bk.ok(bk.err('admin', format('select public.bank_unmatch(%L, %L)', g, 'Revisión')) = '', 'unmatched');
  perform bk.ok((select status from public.bank_lines where id = bk.line('DEPOSITO SUCURSAL')) = 'unmatched'
                and (select voided_at is not null from public.bank_match_groups where id = g), 'the line is free again and the group is kept as history');
  g := bk.val('admin', format('select public.bank_match(%L, %L, %L, %L, 60)', array[bk.line('DEPOSITO SUCURSAL')], array[bk.jl(bk.id('p2a')), bk.jl(bk.id('p2b'))], null, 'suggestion'))::uuid;
  perform bk.ok(g is not null, 'matched again from the suggestion');
  perform bk.ok(bk.merr(format('update public.bank_match_groups set note = %L where id = %L', 'x', g)) like '%BANK_RECORD_IMMUTABLE%', 'match groups are not edited');
  -- bank items not in the books
  perform bk.ok(bk.err('admin', format('select public.bank_line_post(%L, %L, %L)', bk.line('MONTHLY SERVICE FEE'), bk.acct('A', '6500'), 'Cargo mensual del banco')) = '', 'the fee is posted to 6500 and matched');
  perform bk.ok((select string_agg(a.code || ':' || l.debit_cents || '/' || l.credit_cents, ' ' order by l.line_no) from public.journal_entries e join public.journal_lines l on l.entry_id = e.id
                 join public.ledger_accounts a on a.id = l.account_id where e.source = 'bank_adjustment' and e.source_id = bk.line('MONTHLY SERVICE FEE')) = '6500:1500/0 1010:0/1500', 'balanced entry: Dr bank fees / Cr bank');
  perform bk.ok(bk.err('admin', format('select public.bank_line_post(%L, %L, %L)', bk.line('MONTHLY SERVICE FEE'), bk.acct('A', '6500'), 'otra vez')) like '%BANK_LINE_NOT_AVAILABLE%', 'a line is posted once');
end $$;

-- ------------------------------------------------------------- reconciliation of the bank account
do $$ declare rec uuid; s record; begin
  perform bk.ok(bk.err('member', format('select public.bank_reconciliation_create(%L, %L, %L, 0, 144500)', bk.id('ba1'), bk.d(-20), bk.d(-1))) like '%BANK_ACCOUNT_NOT_FOUND%', 'members do not reconcile');
  rec := bk.val('admin', format('select public.bank_reconciliation_create(%L, %L, %L, 0, 144500, %L)', bk.id('ba1'), bk.d(-20), bk.d(-1), 'Octubre'))::uuid;
  insert into bk.ctx values ('rec1', rec::text);
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_create(%L, %L, %L, 0, 1)', bk.id('ba1'), bk.d(-5), bk.d(-1))) like '%RECONCILIATION_OVERLAP%', 'periods of one account do not overlap');
  select * into s from public.bank_reconciliation_summary(rec);
  perform bk.ok(s.statement_difference_cents = 0 and s.unmatched_bank_count = 1 and s.uncleared_book_count = 1 and s.uncleared_book_cents = 7500,
                format('summary: statement complete, 1 unmatched bank line, deposit in transit 75.00 (%s/%s/%s)', s.statement_difference_cents, s.unmatched_bank_count, s.uncleared_book_cents));
  perform bk.ok(s.difference_cents = -2000, format('difference = the unknown charge not in the books: bank 20.00 below the books (%s)', s.difference_cents));
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec)) like '%UNMATCHED_LINES%', 'cannot close with unmatched lines');
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_adjust(%L, %L, %L)', rec, bk.acct('A', '6000'), 'Cargo no identificado')) like '%BANK_ACCOUNT_NOT_FOUND%',
                'admins do not authorise adjustments (owner only)');
  perform bk.ok(bk.err('owner', format('select public.bank_reconciliation_adjust(%L, %L, %L)', rec, bk.acct('A', '6000'), 'Cargo no identificado del banco')) like '%RECONCILIATION_INCOMPLETE%',
                'an adjustment does not replace matching the statement lines');
  perform bk.ok(bk.err('admin', format('select public.bank_line_post(%L, %L, %L)', bk.line('CARGO DESCONOCIDO'), bk.acct('A', '6000'), 'Cargo desconocido — en investigación')) = '', 'the unknown charge is posted');
  select * into s from public.bank_reconciliation_summary(rec);
  perform bk.ok(s.difference_cents = 0 and s.unmatched_bank_count = 0 and s.ledger_balance_cents = 152000 and s.adjusted_bank_cents = 152000,
                'now: statement 1,445.00 + in transit 75.00 = books 1,520.00, difference 0');
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec)) = '', 'closed');
  perform bk.ok((select status from public.bank_reconciliations where id = rec) = 'closed', 'status closed');
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec)) = '', 'closing again is harmless (idempotent)');
  perform bk.ok((select count(*) from public.bank_lines where reconciliation_id = rec) = 8, 'its 8 lines are locked to it');
  perform bk.ok(bk.err('admin', format('select public.bank_unmatch(%L, %L)', (select group_id from public.bank_match_items where bank_line_id = bk.line('CHEQUE 1001') and active), 'Error')) like '%BANK_LINE_RECONCILED%',
                'a reconciled match cannot be undone');
  perform bk.ok(bk.merr(format('update public.bank_lines set status = %L where id = %L', 'unmatched', bk.line('CHEQUE 1001'))) like '%BANK_LINE_RECONCILED%', 'not even by maintenance');
  perform bk.ok(bk.merr(format('update public.bank_reconciliations set statement_closing_cents = 1 where id = %L', rec)) like '%RECONCILIATION_CLOSED%', 'a closed reconciliation is not edited');
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_reopen(%L, %L)', rec, 'Revisar')) like '%BANK_ACCOUNT_NOT_FOUND%', 'admins do not reopen (owner only)');
  perform bk.ok(bk.err('owner', format('select public.bank_reconciliation_reopen(%L, %L)', rec, '')) like '%REASON_REQUIRED%', 'reopening needs a reason');
  perform bk.ok(bk.err('owner', format('select public.bank_reconciliation_reopen(%L, %L)', rec, 'Revisar el cheque 1001')) = '', 'the owner reopens with a reason');
  perform bk.ok((select count(*) from public.bank_lines where reconciliation_id = rec) = 0 and (select status from public.bank_reconciliations where id = rec) = 'open', 'lines unlocked, period open');
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec)) = '', 'closed again');
  -- continuity
  rec := bk.val('admin', format('select public.bank_reconciliation_create(%L, %L, %L, 100, 100)', bk.id('ba1'), bk.d(0), bk.d(0)))::uuid;
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec)) like '%STATEMENT_GAP%', 'the next period must open with the previous closing balance');
end $$;

-- ------------------------------------------------------------- cash account: incomplete statement, adjustment, latest-only reopen
do $$ declare rec uuid; rec2 uuid; s record; begin
  perform bk.ok(bk.err('admin', format('select public.bank_import_revert(%L, %L)', (select id from public.bank_imports where file_sha256 = bk.sha('file-4')), 'Mapeo equivocado')) = '',
                'an unmatched import is reverted (its lines kept, excluded)');
  perform bk.ok((select count(*) from public.bank_lines where status = 'excluded') = 2, 'its two lines are excluded, not deleted');
  perform bk.ok(bk.err('admin', format('select public.bank_import_revert(%L, %L)', (select id from public.bank_imports where file_sha256 = bk.sha('file-1')), 'x x x')) like '%IMPORT_HAS_MATCHES%',
                'an import with matched lines is not reverted');
  perform bk.ok(bk.err('admin', format('select public.bank_import_revert(%L, %L)', (select id from public.bank_imports where file_sha256 = bk.sha('file-3')), 'Monedas no son de este banco')) = '', 'the cash import is reverted too');
  perform bk.ok((select imported from public.bank_import(bk.id('ba2'), 'caja-bien.csv', bk.sha('file-3b'), '{}', jsonb_build_array(bk.row(-6, 6000, 'DEPOSITO EFECTIVO')))) = 1,
                'after a revert, the line can be imported again');
  perform bk.ok(bk.err('admin', format('select public.bank_match(%L, %L)', array[bk.line('DEPOSITO EFECTIVO')], array[bk.jl(bk.id('p6'))])) = '', 'cash deposit ↔ the 60.00 cash payment');
  rec := bk.val('admin', format('select public.bank_reconciliation_create(%L, %L, %L, 10000, 15000)', bk.id('ba2'), bk.d(-20), bk.d(-1)))::uuid;
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec)) like '%STATEMENT_INCOMPLETE%', 'opening + lines ≠ closing: a line is missing');
  perform bk.ok(bk.merr(format('delete from public.bank_reconciliations where id = %L', rec)) like '%BANK_RECORD_IMMUTABLE%', 'reconciliations are never deleted');
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_update(%L, 10000, 16000)', rec)) = '', 'the open reconciliation is corrected (closing 160.00), logged');
  select * into s from public.bank_reconciliation_summary(rec);
  perform bk.ok(s.difference_cents = 10000, format('opening balance 100.00 not in the books: difference %s', s.difference_cents));
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec)) like '%RECONCILIATION_NOT_BALANCED%', 'a difference cannot be closed');
  perform bk.ok(bk.err('owner', format('select public.bank_reconciliation_adjust(%L, %L, %L)', rec, bk.acct('A', '3000'), 'corto')) like '%ADJUSTMENT_REASON_REQUIRED%', 'an adjustment needs a documented reason');
  perform bk.ok(bk.err('owner', format('select public.bank_reconciliation_adjust(%L, %L, %L)', rec, bk.acct('A', '3000'), 'Saldo inicial de caja anterior al sistema')) = '', 'the owner adjusts against equity');
  perform bk.ok((select string_agg(a.code || ':' || l.debit_cents || '/' || l.credit_cents, ' ' order by l.line_no) from public.journal_entries e join public.journal_lines l on l.entry_id = e.id
                 join public.ledger_accounts a on a.id = l.account_id where e.source = 'bank_reconciliation' and e.source_id = rec) = '1000:10000/0 3000:0/10000', 'balanced adjustment entry, documented');
  perform bk.ok(bk.err('owner', format('select public.bank_reconciliation_adjust(%L, %L, %L)', rec, bk.acct('A', '3000'), 'Saldo inicial otra vez')) like '%RECONCILIATION_ALREADY_ADJUSTED%', 'adjusted once');
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec)) = '', 'now it closes');
  rec2 := bk.val('admin', format('select public.bank_reconciliation_create(%L, %L, %L, 16000, 16000)', bk.id('ba2'), bk.d(0), bk.d(0)))::uuid;
  perform bk.ok(bk.err('admin', format('select public.bank_reconciliation_close(%L)', rec2)) = '', 'the next empty period closes with continuity');
  perform bk.ok(bk.err('owner', format('select public.bank_reconciliation_reopen(%L, %L)', rec, 'Revisar')) like '%RECONCILIATION_NOT_LATEST%', 'only the latest closed period reopens');
  perform bk.ok(bk.err('admin', format('select public.bank_set_account_status(%L, %L)', bk.id('ba1'), 'archived')) like '%BANK_ACCOUNT_HAS_OPEN_RECONCILIATION%', 'an account with an open reconciliation is not archived');
  perform bk.ok(bk.val('owner', format('select unbalanced_entries = 0 and debit_cents = credit_cents and receivable_cents = open_invoices_cents from public.ledger_integrity(%L)', bk.id('A')))::boolean,
                'the ledger stays balanced and receivables reconciled');
  perform bk.ok(bk.val('owner', format('select payable_cents = open_bills_cents and posted_bill_cents = approved_bills_cents from public.payables_integrity(%L)', bk.id('A')))::boolean, 'payables still reconciled');
  perform bk.ok(bk.val('other', format('select count(*) from public.bank_reconciliation_summary(%L)', rec)) = '0' and bk.val('other', 'select count(*) from public.bank_lines') = '0'
                and bk.val('other', format('select count(*) from public.bank_suggestions(%L)', bk.id('ba1'))) = '0', 'isolation: B reads nothing of A');
  perform bk.ok(bk.err('other', format('select public.bank_reconciliation_close(%L)', rec2)) like '%BANK_ACCOUNT_NOT_FOUND%', 'isolation: B cannot close A''s reconciliations');
  perform bk.ok((select count(*) from public.bank_events where company_id = bk.id('A') and action in ('created', 'imported', 'reverted', 'matched', 'unmatched', 'auto_matched', 'posted', 'adjusted', 'closed', 'reopened')) >= 20,
                'history: accounts, imports, reverts, matches, postings, adjustments, closes and reopens');
  perform bk.ok(bk.merr(format('delete from public.bank_events where company_id = %L', bk.id('A'))) like '%LEDGER_IMMUTABLE%', 'the history is append-only');
end $$;

do $$ begin
  perform bk.ok(bk.merr(format('delete from public.companies where id = %L', bk.id('A'))) = '', 'deleting a whole company removes its banking data (cascade)');
  perform bk.ok((select count(*) from public.bank_lines) = 0 and (select count(*) from public.bank_accounts where company_id = bk.id('A')) = 0, 'nothing of A is left');
end $$;

do $$ begin
  if exists (select 1 from bk.failures) then
    raise exception 'BANK TESTS FAILED: %', (select string_agg(msg, ' | ') from bk.failures);
  end if;
  raise notice 'ALL BANK TESTS PASSED';
end $$;
