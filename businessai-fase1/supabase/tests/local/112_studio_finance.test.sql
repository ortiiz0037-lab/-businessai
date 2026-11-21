-- Document Studio collections and payments (0038). TEST-ONLY, local throw-away
-- database with every migration up to 0038. Schema sf: collection letters
-- about an issued invoice (balance, days, promise, ageing, own CC number),
-- payment vouchers about a real vendor payment (CP number), purchase orders
-- linked to an expense, traceability, permissions, and NO new financial
-- records (payments, bills and ledger entries are only read).
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema sf;
create table sf.ctx (key text primary key, val text not null);
create function sf.id(k text) returns uuid language sql stable as $$ select val::uuid from sf.ctx where key = k $$;
create table sf.failures (msg text);
create function sf.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into sf.failures values (msg); end if;
end $$;
create function sf.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', sf.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function sf.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', sf.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function sf.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
-- a minimal valid block document
create function sf.content(txt text default 'Hola {{client.name}}') returns jsonb language sql immutable as $$
  select jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'heading', 'level', 1, 'text', 'Título'), jsonb_build_object('type', 'paragraph', 'text', txt)))
$$;
-- save as `who`: returns 'id|version' or the error
create function sf.save(who text, co text, doc uuid, kind text, title text, content jsonb, client text default null, src text default null, emp text default null,
                        vend text default null, expected int default null) returns text language plpgsql as $$
declare r text;
begin
  begin
    r := sf.val(who, format('select id || ''|'' || version from public.studio_save_document(%L, %L, %L, %L, null, %L, %L, %L, %L, %L, %L, null, null, %L)',
      sf.id(co), doc, kind, title, content, '{}', sf.id(client), sf.id(src), sf.id(emp), sf.id(vend), expected));
  exception when others then r := sqlerrm; end;
  return r;
end $$;
grant usage on schema sf to authenticated;
grant select on sf.ctx to authenticated;
grant execute on all functions in schema sf to authenticated;
insert into sf.ctx values
  ('owner', 'f7000000-0000-4000-8000-000000000001'), ('admin', 'f7000000-0000-4000-8000-000000000002'),
  ('member', 'f7000000-0000-4000-8000-000000000003'), ('other', 'f7000000-0000-4000-8000-000000000004'),
  ('A', 'f8000000-0000-4000-8000-000000000001'), ('B', 'f8000000-0000-4000-8000-000000000002'),
  ('cl', 'f9000000-0000-4000-8000-000000000001'), ('inv', 'fa000000-0000-4000-8000-000000000001'),
  ('V', 'fb000000-0000-4000-8000-000000000001'), ('VB', 'fb000000-0000-4000-8000-000000000002'),
  ('b1', 'fc000000-0000-4000-8000-000000000001'), ('b2', 'fc000000-0000-4000-8000-000000000002'), ('bB', 'fc000000-0000-4000-8000-000000000003');
insert into auth.users (id, email) select val::uuid, key || '@sf.test' from sf.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (sf.id('A'), 'Cobros A', sf.id('owner')), (sf.id('B'), 'Cobros B', sf.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (sf.id('A'), 'cus_sf_a', 'sub_sf_a', 'premium', 'active'), (sf.id('B'), 'cus_sf_b', 'sub_sf_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values
  (sf.id('A'), sf.id('owner'), 'owner'), (sf.id('A'), sf.id('admin'), 'admin'), (sf.id('A'), sf.id('member'), 'member'), (sf.id('B'), sf.id('other'), 'owner');
insert into public.clients (id, company_id, name, email) values (sf.id('cl'), sf.id('A'), 'Cliente Cobros', 'cobros@cliente.test');
create function sf.acct(co text, acct_code text) returns uuid language sql stable as $$ select a.id from public.ledger_accounts a where a.company_id = sf.id(co) and a.code = acct_code $$;
create function sf.v(k text) returns text language sql stable as $$ select val from sf.ctx where key = k $$;
create function sf.cat(co text) returns uuid language sql stable as $$ select id from public.expense_categories where company_id = sf.id(co) order by name limit 1 $$;
create function sf.n() returns text language sql stable as $$
  select (select count(*) from public.bill_payments) || '/' || (select count(*) from public.payments) || '/' || (select count(*) from public.journal_entries) || '/' || (select count(*) from public.bills) $$;
grant execute on all functions in schema sf to authenticated;

-- ---------------------------------------------------------------- real finance records (through their own modules)
do $$ declare pay text; begin
  perform sf.val('owner', format('select public.payables_init(%L)::text', sf.id('A')));
  perform sf.val('other', format('select public.payables_init(%L)::text', sf.id('B')));
  perform sf.ok(sf.err('owner', format('insert into public.vendors (id, company_id, name, tax_id) values (%L, %L, %L, %L)', sf.id('V'), sf.id('A'), 'Suplidora Cobros', '66-7654321')) = ''
            and sf.err('other', format('insert into public.vendors (id, company_id, name) values (%L, %L, %L)', sf.id('VB'), sf.id('B'), 'Suplidora B')) = '', 'setup: vendors');
  foreach pay in array array['b1', 'b2'] loop
    perform sf.err('owner', format('insert into public.bills (id, company_id, vendor_id, vendor_invoice_number, bill_date, description) values (%L, %L, %L, %L, %L, %L)',
      sf.id(pay), sf.id('A'), sf.id('V'), 'SC-' || pay, public.ba_today() - 3, 'Compra ' || pay));
    perform sf.err('owner', format('insert into public.bill_lines (company_id, bill_id, line_no, category_id, amount_cents, description) values (%L, %L, 1, %L, 10000, %L)', sf.id('A'), sf.id(pay), sf.cat('A'), 'Materiales'));
    perform sf.err('owner', format('select public.bill_submit(%L)', sf.id(pay)));
    perform sf.err('owner', format('select public.bill_approve(%L)', sf.id(pay)));
  end loop;
  perform sf.err('other', format('insert into public.bills (id, company_id, vendor_id, bill_date, description) values (%L, %L, %L, %L, %L)', sf.id('bB'), sf.id('B'), sf.id('VB'), public.ba_today(), 'Otra'));
  insert into sf.ctx values ('p1', sf.val('owner', format('select public.bill_pay(%L, 4000, %L, %L, %L, %L)', sf.id('b1'), public.ba_today(), sf.acct('A', '1010'), 'check', 'CHK-9')));
  insert into sf.ctx values ('p2', sf.val('owner', format('select public.bill_pay(%L, 2500, %L, %L, %L, %L)', sf.id('b2'), public.ba_today(), sf.acct('A', '1010'), 'transfer', 'TRF-2')));
  insert into sf.ctx values ('pv', sf.val('owner', format('select public.bill_pay(%L, 1000, %L, %L, %L, %L)', sf.id('b1'), public.ba_today(), sf.acct('A', '1010'), 'cash', null)));
  perform sf.err('owner', format('select public.bill_payment_void(%L, %L)', sf.id('pv'), 'Pago duplicado'));
  perform sf.err('owner', format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date) values (%L, %L, %L, %L, %L, %L, %L, 1000, 0, 1000, %L, %L)',
    sf.id('inv'), sf.id('A'), sf.id('cl'), sf.id('owner'), 'invoice', 'x', 'sent', public.ba_today() - 40, public.ba_today() - 10));
  perform sf.err('owner', format('insert into public.payments (company_id, document_id, amount, created_by) values (%L, %L, 200, %L)', sf.id('A'), sf.id('inv'), sf.id('owner')));
  perform sf.err('owner', format('select public.ar_add_promise(%L, %L, 30000)', sf.id('inv'), public.ba_today() + 5));
  perform sf.ok((select status from public.bills where id = sf.id('b1')) = 'partially_paid' and (select count(*) from public.bill_payments where bill_id = sf.id('b1')) = 2,
    'setup: an approved expense paid in part (one payment voided), an issued invoice with a payment and a promise');
  insert into sf.ctx values ('counts', sf.n());
end $$;

-- ---------------------------------------------------------------- collection letter
do $$ declare r text; d uuid; num text; begin
  r := sf.save('admin', 'A', null, 'collection_letter', 'Aviso de cobro', sf.content('Saldo {{collection.balance}}'), null, 'inv');
  d := split_part(r, '|', 1)::uuid; insert into sf.ctx values ('cl1', d);
  perform sf.ok(d is not null, 'a collection letter is a draft about the invoice');
  perform sf.ok(sf.val('admin', format('select (public.studio_data(%L) -> ''collection'' ->> ''balance_cents'') || ''/'' || (public.studio_data(%L) -> ''collection'' ->> ''days_past_due'') || ''/'' || (public.studio_data(%L) -> ''collection'' ->> ''promise_cents'')', d, d, d)) = '80000/10/30000',
    'its data: balance 800.00, 10 days past due, pending promise 300.00 (read from receivables)');
  perform sf.ok(sf.val('admin', format('select (public.studio_data(%L) -> ''aging'' ->> ''d1_30_cents'') || ''/'' || (public.studio_data(%L) -> ''aging'' ->> ''total_cents'')', d, d)) = '80000/80000',
    'and the client ageing (1–30 days: 800.00)');
  perform sf.ok(sf.save('admin', 'A', null, 'collection_letter', 'Sin factura', sf.content(), 'cl') like '%|%', 'a draft without the invoice can be saved…');
  num := sf.val('owner', format('select public.studio_finalize(%L, %s)', d, (select version from public.studio_documents where id = d)));
  perform sf.ok(num = 'CC-' || extract(year from public.ba_today())::int || '-0001', 'issued with its own number (' || num || '), not the invoice''s');
  perform sf.ok((select snapshot -> 'data' -> 'collection' ->> 'balance_cents' from public.studio_documents where id = d) = '80000', 'the snapshot keeps the balance as it was');
end $$;
do $$ declare d uuid := split_part(sf.save('admin', 'A', null, 'collection_letter', 'Sin factura 2', sf.content(), 'cl'), '|', 1)::uuid; begin
  perform sf.ok(sf.err('owner', format('select public.studio_finalize(%L, %s)', d, (select version from public.studio_documents where id = d))) like '%STUDIO_SOURCE_REQUIRED%', '… but not issued without it');
end $$;

-- ---------------------------------------------------------------- payment voucher
do $$ declare d uuid; v int; num text; begin
  d := split_part(sf.save('admin', 'A', null, 'payment_voucher', 'Comprobante de pago', sf.content('Pagado {{payment.amount}}')), '|', 1)::uuid; insert into sf.ctx values ('cp1', d);
  v := (select version from public.studio_documents where id = d);
  perform sf.ok(sf.err('member', format('select public.studio_set_finance_link(%L, %L, %L)', d, sf.id('b1'), sf.id('p1'))) like '%FORBIDDEN%', 'a member (no payables.view) cannot link an expense');
  perform sf.ok(sf.err('admin', format('select public.studio_set_finance_link(%L, %L, %L)', d, sf.id('b1'), sf.id('p2'))) like '%STUDIO_REF_INVALID%', 'a payment of another expense is refused');
  perform sf.ok(sf.err('admin', format('select public.studio_set_finance_link(%L, %L, %L)', d, sf.id('b1'), sf.id('pv'))) like '%STUDIO_REF_INVALID%', 'a voided payment is refused');
  perform sf.ok(sf.err('admin', format('select public.studio_set_finance_link(%L, %L, null)', d, sf.id('bB'))) like '%STUDIO_REF_INVALID%', 'an expense of another company is refused');
  perform sf.ok(sf.err('admin', format('select public.studio_set_finance_link(%L, %L, %L)', d, sf.id('b1'), sf.id('p1'))) = '', 'the admin links the voucher to the expense and its payment');
  perform sf.ok((select vendor_id from public.studio_documents where id = d) = sf.id('V') and (select version from public.studio_documents where id = d) = v + 1, 'the vendor comes from the expense (version + 1)');
  perform sf.ok(sf.val('admin', format('select (public.studio_data(%L) -> ''bill_payment'' ->> ''amount_cents'') || ''/'' || (public.studio_data(%L) -> ''bill_payment'' ->> ''method'') || ''/'' || jsonb_array_length(public.studio_data(%L) -> ''bill'' -> ''lines'') || ''/'' || (public.studio_data(%L) -> ''vendor'' ->> ''name'')', d, d, d, d))
                = '4000/check/1/Suplidora Cobros', 'its data: the payment (40.00, check), the expense lines, the vendor');
  perform sf.ok(sf.err('admin', format('update public.studio_documents set bill_payment_id = %L where id = %L', sf.id('p2'), d)) like '%permission denied%', 'no direct writes');
  num := sf.val('owner', format('select public.studio_finalize(%L, %s)', d, (select version from public.studio_documents where id = d)));
  perform sf.ok(num = 'CP-' || extract(year from public.ba_today())::int || '-0001', 'the voucher is issued (' || num || ')');
  perform sf.ok(sf.err('admin', format('select public.studio_set_finance_link(%L, null, null)', d)) like '%STUDIO_LOCKED%', 'an issued voucher keeps its link');
end $$;
do $$ declare d uuid := split_part(sf.save('admin', 'A', null, 'payment_voucher', 'Vale vacío', sf.content()), '|', 1)::uuid; begin
  perform sf.ok(sf.err('owner', format('select public.studio_finalize(%L, %s)', d, (select version from public.studio_documents where id = d))) like '%STUDIO_SOURCE_REQUIRED%', 'a voucher without a payment is not issued');
  perform sf.ok(sf.err('admin', format('select public.studio_set_finance_link(%L, %L, null)', split_part(sf.save('admin', 'A', null, 'letter', 'Carta', sf.content()), '|', 1), sf.id('b1'))) like '%STUDIO_REF_INVALID%', 'a letter cannot be linked to an expense');
end $$;

-- ---------------------------------------------------------------- purchase order, statement, traceability, no new money
do $$ declare d uuid; begin
  d := split_part(sf.save('admin', 'A', null, 'purchase_order', 'Orden de compra', sf.content()), '|', 1)::uuid;
  perform sf.ok(sf.err('admin', format('select public.studio_set_finance_link(%L, %L, %L)', d, sf.id('b2'), sf.id('p2'))) like '%STUDIO_REF_INVALID%', 'a purchase order links an expense, not a payment');
  perform sf.ok(sf.err('admin', format('select public.studio_set_finance_link(%L, %L, null)', d, sf.id('b2'))) = ''
                and sf.val('admin', format('select public.studio_data(%L) -> ''bill'' ->> ''total_cents''', d)) = '10000', 'a purchase order linked to its expense reads the expense total');
  d := split_part(sf.save('admin', 'A', null, 'account_statement', 'Estado', sf.content(), 'cl'), '|', 1)::uuid;
  perform sf.ok(sf.val('admin', format('select public.studio_data(%L) -> ''aging'' ->> ''total_cents''', d)) = '80000', 'an account statement now carries the client ageing');
  perform sf.ok(sf.val('owner', format('select count(*) from public.studio_finance_links(%L, %L, null)', sf.id('A'), sf.id('b1'))) = '1'
                and sf.val('owner', format('select count(*) from public.studio_finance_links(%L, null, %L)', sf.id('A'), sf.id('inv'))) = '1', 'traceability: the expense and the invoice list their Studio documents');
  perform sf.ok(sf.val('member', format('select count(*) from public.studio_finance_links(%L, %L, null)', sf.id('A'), sf.id('b1'))) = '0'
                and sf.val('other', format('select count(*) from public.studio_finance_links(%L, %L, null)', sf.id('A'), sf.id('b1'))) = '0', 'not for a member without payables.view, nor another company');
  perform sf.ok(sf.save('admin', 'A', null, 'account_statement', 'Bloques', jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'bill'), jsonb_build_object('type', 'aging'))), 'cl') ~ '^[0-9a-f-]{36}\|1$',
                'the editor saves the new expense and ageing blocks');
  perform sf.ok(sf.save('admin', 'A', null, 'letter', 'Malo', jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'billx')))) like '%STUDIO_CONTENT_INVALID%', 'unknown blocks are still refused');
  perform sf.ok(sf.n() = sf.v('counts'), 'no payment, invoice payment, ledger entry or expense was created by Studio (' || sf.n() || ')');
  begin delete from public.bill_payments where id = sf.id('p1'); perform sf.ok(false, 'a payment with a voucher cannot be deleted');
  exception when others then perform sf.ok(true, 'a payment with a voucher cannot be deleted'); end;
end $$;

do $$ begin
  if exists (select 1 from sf.failures) then raise exception 'STUDIO FINANCE TESTS FAILED: %', (select string_agg(msg, '; ') from sf.failures); end if;
  raise notice 'ALL STUDIO FINANCE TESTS PASSED';
end $$;
