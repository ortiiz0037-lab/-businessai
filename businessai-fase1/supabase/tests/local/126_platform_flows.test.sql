-- S9 · Whole platform (0001 … 0045 together): complete flows across modules and a generic
-- multi-tenant sweep over EVERY table, as a real user of another company, of another branch and
-- without a session.
--   A. sign-up user → company (create_company) → plan → client → first invoice (issued: the client
--      and issuer are kept as they were, 0045) → ledger
--   B. product → barcode → opening stock → POS register / shift → sale (stock once) → refund
--      (customer_return) → ledger balanced
--   C. purchase order → approval → receipt (stock) → the received goods sold at the POS → vendor bill
--      linked once (no duplicated expense) → bill approved and paid from the bank (ledger)
--   D. invoice → bank deposit imported → applied to the invoice (payment, receivables) → bank line
--      matched (reconciled) → the deposit cannot be applied twice
--   E. plans: Basic / Pro / Premium limits (employees 3 / 25 / 100, branches 1 / 3 / 10, payroll only
--      Pro and Premium) enforced by the database; employees do not take admin seats; a cancelled
--      subscription loses the paid features
--   F. statements derive from the ledger (trial balance = sum of journal lines; balanced)
--   G. security sweep: every public table with company_id is invisible to another company; nothing is
--      readable without a session; every public table has RLS; no SECURITY DEFINER without a search
--      path; ba_private is closed; private buckets stay private; branch scope of inventory / POS.
-- TEST-ONLY, local throw-away database. Schema pf.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema pf;
create table pf.ctx (key text primary key, val text not null);
create function pf.id(k text) returns uuid language sql stable as $$ select val::uuid from pf.ctx where key = k $$;
create function pf.v(k text) returns text language sql stable as $$ select val from pf.ctx where key = k $$;
create table pf.failures (msg text);
create function pf.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into pf.failures values (msg); end if;
end $$;
grant usage on schema pf to authenticated, anon;
grant select on pf.ctx to authenticated, anon;
create function pf.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  if who is null then perform set_config('request.jwt.claims', '{"role":"anon"}', true); set local role anon;
  else perform set_config('request.jwt.claims', json_build_object('sub', pf.id(who), 'role', 'authenticated')::text, true); set local role authenticated; end if;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function pf.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  if who is null then perform set_config('request.jwt.claims', '{"role":"anon"}', true); set local role anon;
  else perform set_config('request.jwt.claims', json_build_object('sub', pf.id(who), 'role', 'authenticated')::text, true); set local role authenticated; end if;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function pf.oh(br text, item text) returns numeric language plpgsql volatile as $$
begin return public.inventory_on_hand(pf.id(br), pf.id(item), null); end $$;
create function pf.balanced(target uuid) returns boolean language sql stable as $$
  select not exists (select 1 from public.journal_entries e where e.company_id = target
    and (select sum(debit_cents) from public.journal_lines l where l.entry_id = e.id) <> (select sum(credit_cents) from public.journal_lines l where l.entry_id = e.id)) $$;
create function pf.d(n integer) returns text language sql stable as $$ select (public.ba_today() + n)::text $$;
grant execute on all functions in schema pf to authenticated, anon;

insert into pf.ctx values
  ('owner', 'f1000000-0000-4000-8000-0000000000a1'), ('admin', 'f1000000-0000-4000-8000-0000000000a2'),
  ('member', 'f1000000-0000-4000-8000-0000000000a3'), ('member2', 'f1000000-0000-4000-8000-0000000000a5'),
  ('other', 'f1000000-0000-4000-8000-0000000000a4'), ('basic', 'f1000000-0000-4000-8000-0000000000a6');
insert into auth.users (id, email) select val::uuid, key || '@pf.test' from pf.ctx where key in ('owner', 'admin', 'member', 'member2', 'other', 'basic');

-- ------------------------------------------------------------- A. sign-up → company → first invoice
do $$
declare co text; e text; inv uuid; snap jsonb;
begin
  -- the signed-up user creates the company through the same function the onboarding uses
  co := pf.val('owner', format('select public.create_company(%L)::text', 'Ferretería Integral'));
  insert into pf.ctx values ('A', co);
  co := pf.val('other', format('select public.create_company(%L)::text', 'Otra Empresa'));
  insert into pf.ctx values ('B', co);
  co := pf.val('basic', format('select public.create_company(%L)::text', 'Negocio Básico'));
  insert into pf.ctx values ('C', co);
  perform pf.ok((select role from public.memberships where company_id = pf.id('A') and user_id = pf.id('owner')) = 'owner', 'A: create_company makes the user its owner');
  -- the subscription is written by the Stripe webhook in real life (service role); here directly
  insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
    (pf.id('A'), 'cus_pf_a', 'sub_pf_a', 'pro', 'active'), (pf.id('B'), 'cus_pf_b', 'sub_pf_b', 'premium', 'active'), (pf.id('C'), 'cus_pf_c', 'sub_pf_c', 'basic', 'active');
  insert into public.memberships (company_id, user_id, role) values (pf.id('A'), pf.id('admin'), 'admin'), (pf.id('A'), pf.id('member'), 'member'), (pf.id('A'), pf.id('member2'), 'member');
  -- company profile and two branches (Pro: up to 3)
  insert into public.company_profiles (company_id, legal_name, display_name, phone, address) values (pf.id('A'), 'Ferretería Integral LLC', 'Ferretería Integral', '787-555-0100', 'Calle Uno 1, San Juan');
  insert into pf.ctx values ('SJ', pf.val('owner', format('select public.crm_save_branch(%L, null, %L, %L, %L)::text', pf.id('A'), 'San Juan', 'SJU', null)));
  insert into pf.ctx values ('PC', pf.val('owner', format('select public.crm_save_branch(%L, null, %L, %L, %L)::text', pf.id('A'), 'Ponce', 'PCE', null)));
  insert into pf.ctx values ('BB', pf.val('other', format('select public.crm_save_branch(%L, null, %L, %L, %L)::text', pf.id('B'), 'Bayamón', 'BAY', null)));
  insert into public.branch_members (company_id, branch_id, user_id) values (pf.id('A'), pf.id('SJ'), pf.id('member')), (pf.id('A'), pf.id('PC'), pf.id('member2'));
  perform pf.ok(pf.id('SJ') is not null and pf.id('PC') is not null, 'A: two branches on the Pro plan');
  -- the first client and the first invoice (issued directly, as the documents screen does)
  insert into pf.ctx values ('c1', pf.val('member', format('insert into public.clients (company_id, name, email, address) values (%L, %L, %L, %L) returning id::text',
    pf.id('A'), 'Constructora Rivera', 'pagos@rivera.test', 'Ave. Central 10')));
  inv := gen_random_uuid(); insert into pf.ctx values ('inv1', inv);
  e := pf.err('member', format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date, items)
    values (%L, %L, %L, %L, %L, %L, %L, 100, 11.50, 111.50, %L, %L, %L)', inv, pf.id('A'), pf.id('c1'), pf.id('member'), 'invoice', 'x', 'sent', pf.d(0), pf.d(30),
    jsonb_build_array(jsonb_build_object('description', 'Cemento', 'quantity', 2, 'unit_price', 50))));
  perform pf.ok(e = '', 'A: the first invoice is issued ' || e);
  select metadata -> 'issued' into snap from public.documents where id = inv;
  perform pf.ok(snap -> 'client' ->> 'name' = 'Constructora Rivera' and snap -> 'company' ->> 'legal_name' = 'Ferretería Integral LLC' and snap ? 'at',
    'A: the issued invoice keeps the client and the issuer as they were (0045 snapshot)');
  perform pf.ok((select count(*) from public.journal_entries where source = 'invoice' and source_id = inv) = 1, 'A: the invoice is in the ledger (receivable, revenue, sales tax)');
  -- later changes do not alter the issued invoice
  perform pf.err('member', format('update public.clients set name = %L, address = %L where id = %L', 'Rivera Holdings', 'Otra dirección 99', pf.id('c1')));
  update public.company_profiles set legal_name = 'Ferretería Nueva LLC' where company_id = pf.id('A');
  perform pf.ok((select metadata -> 'issued' -> 'client' ->> 'name' from public.documents where id = inv) = 'Constructora Rivera'
                and (select metadata -> 'issued' -> 'company' ->> 'legal_name' from public.documents where id = inv) = 'Ferretería Integral LLC'
                and (select (items -> 0 ->> 'unit_price')::numeric from public.documents where id = inv) = 50,
    'A: renaming the client and the company later does not change the issued invoice');
  perform pf.ok(pf.err('member', format('update public.documents set metadata = metadata - %L where id = %L', 'issued', inv)) like '%DOCUMENT_ISSUED%',
    'A: nobody removes or edits the snapshot of an issued document');
  -- a draft has no snapshot until it is issued
  inv := gen_random_uuid(); insert into pf.ctx values ('inv2', inv);
  perform pf.err('member', format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, total, issue_date, due_date)
    values (%L, %L, %L, %L, %L, %L, %L, 200, 200, %L, %L)', inv, pf.id('A'), pf.id('c1'), pf.id('member'), 'invoice', 'x', 'draft', pf.d(0), pf.d(30)));
  perform pf.ok(not ((select metadata from public.documents where id = inv) ? 'issued'), 'A: a draft has no snapshot');
  e := pf.err('member', format('update public.documents set status = %L where id = %L', 'sent', inv));
  perform pf.ok(e = '' and (select metadata -> 'issued' -> 'client' ->> 'name' from public.documents where id = inv) = 'Rivera Holdings', 'A: issuing the draft takes the snapshot at that moment ' || e);
end $$;

-- ------------------------------------------------------------- B. product → POS sale → refund
do $$
declare r jsonb; e text; l1 bigint;
begin
  insert into pf.ctx values ('P1', pf.val('admin', format('select id::text from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, true, null)', pf.id('A'), 'TAL-1', 'Taladro', 'product', 'unidad', 8000)));
  perform pf.ok(pf.err('admin', format('select public.catalog_barcode_add(%L, null, %L, %L, true)', pf.id('P1'), '036000291452', 'upca')) = '', 'B: the product gets a UPC-A barcode');
  perform pf.ok(pf.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', pf.id('A'), pf.id('SJ'), 'opening',
    jsonb_build_array(jsonb_build_object('item', pf.id('P1'), 'qty', '5', 'unit_cost', '5000')), 'Inventario inicial', 'pf-open-0001')) = '' and pf.oh('SJ', 'P1') = 5, 'B: opening stock 5 at San Juan');
  perform pf.err('admin', format('select public.pos_tax_rate_save(%L, null, %L, %L, 11.5, true)', pf.id('A'), 'IVU', 'IVU 11.5%'));
  insert into pf.ctx values ('R1', pf.val('admin', format('select public.pos_register_save(%L, null, %L, %L, %L)::text', pf.id('A'), pf.id('SJ'), 'C1', 'Caja 1')));
  insert into pf.ctx values ('SH', pf.val('member', format('select (public.pos_shift_open(%L, 5000, %L)) ->> %L', pf.id('R1'), 'pf-shift-0001', 'id')));
  -- the scanned code resolves to the product (as the register does)
  perform pf.ok(pf.val('member', format('select item_id::text from public.inventory_lookup(%L, %L)', pf.id('A'), '036000291452')) = pf.v('P1'), 'B: the scanned barcode finds the product');
  r := pf.val('member', format('select public.pos_sale_create(%L, %L, %L)::text', pf.id('A'), jsonb_build_object('branch', pf.id('SJ'), 'register', pf.id('R1'), 'shift', pf.id('SH'),
         'lines', jsonb_build_array(jsonb_build_object('item', pf.id('P1'), 'qty', '2')), 'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', '17840', 'tendered_cents', '20000'))), 'pf-sale-0001'))::jsonb;
  insert into pf.ctx values ('S1', r ->> 'id');
  perform pf.ok((r ->> 'total_cents')::bigint = 17840 and pf.oh('SJ', 'P1') = 3, 'B: POS sale of 2 (160.00 + IVU = 178.40): stock 5 → 3');
  r := pf.val('member', format('select public.pos_sale_create(%L, %L, %L)::text', pf.id('A'), jsonb_build_object('branch', pf.id('SJ'), 'register', pf.id('R1'), 'shift', pf.id('SH'),
         'lines', jsonb_build_array(jsonb_build_object('item', pf.id('P1'), 'qty', '2')), 'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', '17840'))), 'pf-sale-0001'))::jsonb;
  perform pf.ok((r ->> 'already')::boolean and pf.oh('SJ', 'P1') = 3 and (select count(*) from public.inventory_movements where source_type = 'pos_sale' and company_id = pf.id('A')) = 1,
    'B: the same sale submitted again discounts nothing more (one movement)');
  select id into l1 from public.pos_sale_lines where sale_id = pf.id('S1');
  r := pf.val('admin', format('select public.pos_refund_create(%L, %L, null, %L)::text', pf.id('S1'), jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line', l1::text, 'qty', '1')),
         'method', 'transfer', 'reference', 'TRF-9', 'reason', 'Defecto de fábrica', 'restock', true), 'pf-ref-0001'))::jsonb;
  perform pf.ok((r ->> 'amount_cents')::bigint = 8920 and pf.oh('SJ', 'P1') = 4
                and (select count(*) from public.inventory_movements where kind = 'customer_return' and source_type = 'pos_refund' and company_id = pf.id('A')) = 1,
    'B: the refund of one unit (89.20) generates its customer_return movement: stock 3 → 4');
  perform pf.ok((select count(*) from public.journal_entries where company_id = pf.id('A') and source in ('pos_sale', 'pos_refund')) = 2 and pf.balanced(pf.id('A')), 'B: sale and refund are in the ledger, balanced');
  perform pf.ok((select count(*) from public.inventory_verify(pf.id('A'))) = 0, 'B: inventory caches equal the ledger of movements');
end $$;

-- ------------------------------------------------------------- C. purchase → receipt → POS → bill (no duplicates)
do $$
declare po uuid; l1 uuid; r jsonb; bid uuid; e text; bank_acct uuid;
begin
  insert into public.vendors (id, company_id, name) values ('f3000000-0000-4000-8000-0000000000a1', pf.id('A'), 'Distribuidora Caribe');
  insert into pf.ctx values ('v1', 'f3000000-0000-4000-8000-0000000000a1');
  po := pf.val('member', format('select public.purchase_order_save(%L, null, %L, %L, null, %L, %L, null)::text', pf.id('A'), pf.id('v1'), pf.id('SJ'), 'Reposición',
          jsonb_build_array(jsonb_build_object('item', pf.id('P1'), 'qty', '10', 'unit_cost', '5200'))))::uuid;
  perform pf.val('member', format('select public.purchase_order_transition(%L, %L)', po, 'submit'));
  perform pf.ok(pf.val('admin', format('select public.purchase_order_transition(%L, %L)', po, 'approve')) = 'approved', 'C: the purchase order is approved');
  select id into l1 from public.purchase_order_lines where po_id = po;
  r := pf.val('member', format('select public.purchase_order_receive(%L, %L, %L, %L)::text', po, jsonb_build_array(jsonb_build_object('po_line', l1, 'qty', '10')), 'Entrega completa', 'pf-rcv-0001'))::jsonb;
  perform pf.ok(r ->> 'status' = 'received' and pf.oh('SJ', 'P1') = 14, 'C: the receipt updates stock 4 → 14');
  perform pf.ok(pf.val('member', format('select public.purchase_order_receive(%L, %L, null, %L)::text', po, jsonb_build_array(jsonb_build_object('po_line', l1, 'qty', '10')), 'pf-rcv-0001'))::jsonb ->> 'already' = 'true'
                and pf.oh('SJ', 'P1') = 14, 'C: the same receipt again changes nothing');
  r := pf.val('member', format('select public.pos_sale_create(%L, %L, %L)::text', pf.id('A'), jsonb_build_object('branch', pf.id('SJ'), 'register', pf.id('R1'), 'shift', pf.id('SH'),
         'lines', jsonb_build_array(jsonb_build_object('item', pf.id('P1'), 'qty', '10')), 'payments', jsonb_build_array(jsonb_build_object('method', 'ath_movil', 'amount_cents', '89200', 'reference', 'ATH-1'))), 'pf-sale-0002'))::jsonb;
  perform pf.ok((r ->> 'total_cents')::bigint = 89200 and pf.oh('SJ', 'P1') = 4, 'C: the received goods are sold at the POS: 14 → 4');
  -- the vendor bill: created once in Payables, linked once to the order
  perform pf.err('owner', format('select public.payables_init(%L)', pf.id('A')));
  bid := pf.val('admin', format('select public.bill_save_draft(%L, null, %L, %L, %L, null, %L, null, %L, %L)::text', pf.id('A'), pf.id('v1'), 'FAC-500', pf.d(0), 'Mercancía de la orden',
          jsonb_build_array(jsonb_build_object('category_id', (select id from public.expense_categories where company_id = pf.id('A') order by name limit 1), 'amount_cents', '52000', 'description', 'Taladros')), 'pf-bill-0001'))::uuid;
  insert into pf.ctx values ('bill', bid);
  perform pf.ok(pf.err('admin', format('select public.purchase_order_link_bill(%L, %L)', po, bid)) = '', 'C: the vendor bill is linked to the order');
  perform pf.ok(pf.val('admin', format('select public.bill_save_draft(%L, null, %L, %L, %L, null, %L, null, %L, %L)::text', pf.id('A'), pf.id('v1'), 'FAC-500', pf.d(0), 'Otra vez',
          jsonb_build_array(jsonb_build_object('category_id', (select id from public.expense_categories where company_id = pf.id('A') order by name limit 1), 'amount_cents', '52000', 'description', 'Taladros')), 'pf-bill-0001'))::uuid = bid
                and (select count(*) from public.bills where company_id = pf.id('A')) = 1, 'C: the same bill submitted again is the same bill (no duplicated expense)');
  e := pf.err('admin', format('select public.bill_submit(%L)', bid)) || pf.err('owner', format('select public.bill_approve(%L)', bid));
  perform pf.ok(e = '' and (select count(*) from public.journal_entries where source = 'bill' and source_id = bid) = 1, 'C: the approved bill is posted to the ledger once ' || e);
  perform pf.ok(pf.err('admin', format('select public.bank_init(%L)', pf.id('A'))) = '', 'C: banking initialised');
  bank_acct := pf.val('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)::text', pf.id('A'), 'Operativa', 'Banco Popular', '4821',
                 (select id from public.ledger_accounts where company_id = pf.id('A') and code = '1010')))::uuid;
  insert into pf.ctx values ('ba', bank_acct);
  e := pf.err('admin', format('select public.bill_pay(%L, 52000, %L, %L, %L, %L, %L)', bid, pf.d(0), (select id from public.ledger_accounts where company_id = pf.id('A') and code = '1010'), 'check', 'CK-1', 'pf-pay-bill-1'));
  perform pf.ok(e = '' and (select status from public.bills where id = bid) = 'paid', 'C: the bill is paid from the bank account ' || e);
  perform pf.ok(pf.err('admin', format('select public.bill_pay(%L, 52000, %L, %L, %L, %L, %L)', bid, pf.d(0), (select id from public.ledger_accounts where company_id = pf.id('A') and code = '1010'), 'check', 'CK-1', 'pf-pay-bill-1')) = ''
                and (select count(*) from public.bill_payments where bill_id = bid) = 1, 'C: the same payment again is not paid twice');
end $$;

-- ------------------------------------------------------------- D. invoice → bank deposit → payment → reconciliation
do $$
declare line uuid; r text; e text;
begin
  perform pf.val('admin', format('select (public.bank_import(%L, %L, %L, %L, %L)).imported::text', pf.id('ba'), 'estado-nov.csv', encode(sha256('pf-bank-1'::bytea), 'hex'), '{}',
          jsonb_build_array(jsonb_build_object('date', pf.d(0), 'description', 'DEPOSITO CONSTRUCTORA RIVERA', 'amount_cents', '11150'),
                            jsonb_build_object('date', pf.d(0), 'description', 'CHEQUE CK-1', 'amount_cents', '-52000', 'reference', 'CK-1'))));
  select id into line from public.bank_lines where bank_account_id = pf.id('ba') and amount_cents = 11150;
  perform pf.ok(line is not null, 'D: the bank statement is imported (deposit and the check)');
  r := pf.val('admin', format('select public.bank_apply_deposit(%L, %L, %L)::text', line, jsonb_build_array(jsonb_build_object('document_id', pf.id('inv1'), 'amount_cents', 11150)), 'pf-dep-0001'));
  perform pf.ok((select status from public.documents where id = pf.id('inv1')) = 'paid'
                and (select count(*) from public.payments where document_id = pf.id('inv1')) = 1
                and (select status from public.bank_lines where id = line) = 'matched', 'D: the deposit pays the invoice (receivables) and the bank line is reconciled');
  perform pf.ok(pf.err('admin', format('select public.bank_apply_deposit(%L, %L, %L)', line, jsonb_build_array(jsonb_build_object('document_id', pf.id('inv2'), 'amount_cents', 100)), 'pf-dep-0002')) <> ''
                and (select count(*) from public.payments where company_id = pf.id('A')) = 1, 'D: a reconciled deposit cannot be applied again');
  -- the check of C, matched against its journal line
  e := pf.err('admin', format('select public.bank_match(array[%L]::uuid[], array[(select l.id from public.journal_lines l join public.journal_entries j on j.id = l.entry_id
        where j.company_id = %L and j.source = %L and l.credit_cents = 52000 limit 1)]::bigint[])', (select id from public.bank_lines where bank_account_id = pf.id('ba') and amount_cents = -52000), pf.id('A'), 'bill_payment'));
  perform pf.ok(e = '' and (select count(*) from public.bank_lines where bank_account_id = pf.id('ba') and status = 'unmatched') = 0, 'D: the bill check is matched too: nothing left to reconcile ' || e);
end $$;

-- ------------------------------------------------------------- E. plans and limits (database-enforced)
do $$
declare e text; i integer;
begin
  perform pf.ok((select string_agg(plan || ':' || feature || ':' || coalesce(max_allowed::text, '∞'), ' ' order by plan, feature) from public.billing_plan_features where feature in ('employees', 'branches', 'payroll'))
                = 'basic:branches:1 basic:employees:3 premium:branches:10 premium:employees:100 premium:payroll:∞ pro:branches:3 pro:employees:25 pro:payroll:∞',
    'E: plan limits as approved — employees 3 / 25 / 100, branches 1 / 3 / 10, payroll Pro and Premium only');
  perform pf.ok((select string_agg(plan || ':' || max_members, ' ' order by sort_order) from public.billing_plans) = 'basic:1 pro:3 premium:10', 'E: admin seats per plan (members) 1 / 3 / 10');
  -- Basic: one branch, three employees, no payroll
  perform pf.ok(pf.err('basic', format('select public.crm_save_branch(%L, null, %L, %L, null)', pf.id('C'), 'Única', 'UNI')) = '', 'E: Basic creates its one branch');
  perform pf.ok(pf.err('basic', format('select public.crm_save_branch(%L, null, %L, %L, null)', pf.id('C'), 'Segunda', 'SEG')) like '%PLAN_LIMIT_BRANCHES%', 'E: Basic cannot create a second branch (server)');
  for i in 1..3 loop
    e := pf.err('basic', format('insert into public.employees (company_id, first_name, last_name) values (%L, %L, %L)', pf.id('C'), 'Empleado', i::text));
    exit when e <> '';
  end loop;
  perform pf.ok(e = '' and (select count(*) from public.employees where company_id = pf.id('C')) = 3, 'E: Basic adds three employees ' || e);
  perform pf.ok(pf.err('basic', format('insert into public.employees (company_id, first_name, last_name) values (%L, %L, %L)', pf.id('C'), 'Empleado', '4')) like '%PLAN_LIMIT_EMPLOYEES%',
    'E: the fourth employee is refused by the database');
  perform pf.ok((select count(*) from public.memberships where company_id = pf.id('C')) = 1, 'E: employees do not take admin seats (still one member)');
  perform pf.ok(not coalesce((select available from public.company_feature(pf.id('C'), 'payroll')), false) and coalesce((select available from public.company_feature(pf.id('A'), 'payroll')), false),
    'E: payroll is unavailable on Basic and available on Pro');
  perform pf.ok(pf.err('owner', format('select public.crm_save_branch(%L, null, %L, %L, null)', pf.id('A'), 'Caguas', 'CAG')) = ''
                and pf.err('owner', format('select public.crm_save_branch(%L, null, %L, %L, null)', pf.id('A'), 'Mayagüez', 'MAY')) like '%PLAN_LIMIT_BRANCHES%', 'E: Pro stops at three branches');
  -- payment failure: past_due keeps access (grace), a cancelled subscription loses paid features
  update public.company_subscriptions set status = 'past_due' where company_id = pf.id('C');
  perform pf.ok(coalesce((select available from public.company_feature(pf.id('C'), 'employees')), false), 'E: a failed payment (past_due) keeps access during the grace period');
  update public.company_subscriptions set status = 'canceled' where company_id = pf.id('C');
  perform pf.ok(pf.err('basic', format('insert into public.employees (company_id, first_name, last_name) values (%L, %L, %L)', pf.id('C'), 'Nuevo', 'X')) like '%PLAN%'
                and (select count(*) from public.employees where company_id = pf.id('C')) = 3, 'E: a cancelled subscription cannot add employees; existing data is kept');
  perform pf.ok(pf.err('basic', format('update public.company_subscriptions set plan = %L, status = %L where company_id = %L', 'premium', 'active', pf.id('C'))) like '%permission denied%'
                or (select plan from public.company_subscriptions where company_id = pf.id('C')) = 'basic', 'E: a user cannot change their own plan or status (only the Stripe webhook does)');
end $$;

-- ------------------------------------------------------------- F. statements derive from the ledger
do $$
declare tb bigint; ar bigint;
begin
  select coalesce(sum(l.debit_cents), 0) - coalesce(sum(l.credit_cents), 0) into tb from public.journal_lines l where l.company_id = pf.id('A');
  perform pf.ok(tb = 0 and pf.balanced(pf.id('A')), 'F: every entry of A balances (trial balance 0)');
  select coalesce(sum(l.debit_cents - l.credit_cents), 0) into ar from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id where a.company_id = pf.id('A') and a.system_key = 'accounts_receivable';
  perform pf.ok(ar = 20000, 'F: accounts receivable in the ledger = the open invoice inv2 (200.00) after inv1 was paid: ' || ar);
  perform pf.ok((select count(*) from public.journal_entries where company_id = pf.id('A') and source in ('invoice', 'payment', 'bill', 'bill_payment', 'pos_sale', 'pos_refund')) >= 7,
    'F: invoices, payments, bills, POS sales and refunds all reach the same ledger');
end $$;

-- ------------------------------------------------------------- G. security sweep over every table
do $$
declare t record; n bigint; bad text := ''; nobad text := ''; tables integer := 0; anon_bad text := ''; e text;
begin
  -- another company (B's owner, every permission in B) sees no row of A in ANY table with company_id
  for t in select c.table_name from information_schema.columns c join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
           where c.table_schema = 'public' and c.column_name = 'company_id' and x.table_type = 'BASE TABLE' order by 1 loop
    tables := tables + 1;
    begin
      n := pf.val('other', format('select count(*)::text from public.%I where company_id = %L', t.table_name, pf.id('A')))::bigint;
    exception when others then n := 0; end;   -- permission denied: not readable at all
    if n > 0 then bad := bad || t.table_name || '(' || n || ') '; end if;
    begin
      n := pf.val(null, format('select count(*)::text from public.%I', t.table_name))::bigint;
    exception when others then n := 0; end;
    if n > 0 and t.table_name not in ('billing_plans', 'billing_plan_features') then anon_bad := anon_bad || t.table_name || '(' || n || ') '; end if;
  end loop;
  perform pf.ok(bad = '' and tables > 120, format('G: another company sees no row of A in any of the %s tables with company_id %s', tables, bad));
  perform pf.ok(anon_bad = '', 'G: without a session no company data is readable ' || anon_bad);
  -- RLS on every public table; no write grant to anon anywhere
  select string_agg(c.relname, ' ') into nobad from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  perform pf.ok(nobad is null, 'G: row level security is enabled on every public table ' || coalesce(nobad, ''));
  select string_agg(c.relname, ' ') into nobad from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r'
    and (has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE') or has_table_privilege('anon', c.oid, 'TRUNCATE'));
  perform pf.ok(nobad is null, 'G: anonymous callers cannot write any table ' || coalesce(nobad, ''));
  -- the money ledgers cannot be written directly by signed-in users
  select string_agg(x, ' ') into nobad from unnest(array['journal_entries', 'journal_lines', 'inventory_movements', 'inventory_stock', 'pos_sales', 'pos_sale_lines', 'pos_payments', 'pos_cash_movements',
    'bank_line_allocations', 'payroll_runs', 'company_subscriptions', 'billing_plan_features']) x
    where has_table_privilege('authenticated', 'public.' || x, 'INSERT') or has_table_privilege('authenticated', 'public.' || x, 'UPDATE') or has_table_privilege('authenticated', 'public.' || x, 'DELETE');
  perform pf.ok(nobad is null, 'G: ledger, stock, POS, bank allocations, payroll runs and subscriptions are not writable directly ' || coalesce(nobad, ''));
  -- SECURITY DEFINER functions always fix their search_path; ba_private is closed
  select string_agg(p.proname, ' ') into nobad from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
    where n2.nspname in ('public', 'ba_private') and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=%', false);
  perform pf.ok(nobad is null, 'G: every SECURITY DEFINER function sets its search_path ' || coalesce(nobad, ''));
  perform pf.ok(not has_schema_privilege('anon', 'ba_private', 'USAGE') and not has_schema_privilege('authenticated', 'ba_private', 'USAGE')
                and pf.err('admin', 'select count(*) from ba_private.pos_integration_secrets') like '%permission denied%', 'G: ba_private (encrypted tokens, server keys) is closed to the API');
  select string_agg(p.oid::regprocedure::text, ' ') into nobad from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
    where n2.nspname = 'ba_private' and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  perform pf.ok(nobad is null, 'G: no private function is executable by API roles ' || coalesce(nobad, ''));
  -- private buckets stay private (only the logo bucket is public)
  select string_agg(id, ' ' order by id) into nobad from storage.buckets where public;
  perform pf.ok(coalesce(nobad, '') in ('', 'Company-assets'), 'G: only the company logo bucket is public; signatures, attachments, HR documents and bank evidence are private: ' || coalesce(nobad, 'none'));
  -- branch scope: a Ponce member sees no San Juan stock, sales or registers and cannot sell there
  perform pf.ok(pf.val('member2', format('select count(*)::text from public.inventory_stock where branch_id = %L', pf.id('SJ'))) = '0'
                and pf.val('member2', format('select count(*)::text from public.pos_sales where branch_id = %L', pf.id('SJ'))) = '0'
                and pf.val('member2', format('select count(*)::text from public.pos_registers where branch_id = %L', pf.id('SJ'))) = '0'
                and pf.val('member2', format('select count(*)::text from public.purchase_orders where branch_id = %L', pf.id('SJ'))) = '0',
    'G: branch scope — a Ponce member sees no San Juan stock, sales, registers or purchase orders');
  perform pf.ok(pf.val('member', format('select count(*)::text from public.pos_sales where branch_id = %L', pf.id('SJ'))) <> '0', 'G: … while the San Juan member does');
  perform pf.ok(pf.err('member2', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', pf.id('A'), pf.id('SJ'), 'adjustment_out',
                jsonb_build_array(jsonb_build_object('item', pf.id('P1'), 'qty', '1')), 'Intento', 'pf-x-0001')) like '%BRANCH_FORBIDDEN%'
                and pf.err('member2', format('select public.pos_shift_open(%L, 0, %L)', pf.id('R1'), 'pf-x-0002')) like '%BRANCH_FORBIDDEN%', 'G: and cannot move San Juan stock or open its register');
  -- a member of A cannot act on B through the functions either
  perform pf.ok(pf.err('member', format('select public.pos_report(%L, %L, %L)', pf.id('B'), pf.d(-1), pf.d(0))) like '%FORBIDDEN%'
                and pf.err('member', format('select public.inventory_levels(%L, null)', pf.id('B'))) = ''
                and pf.val('member', format('select count(*)::text from public.inventory_levels(%L, null)', pf.id('B'))) = '0', 'G: functions refuse or return nothing for another company');
  -- audit trails exist for the important operations of the flows
  perform pf.ok((select count(*) from public.document_events where company_id = pf.id('A')) > 0 and (select count(*) from public.inventory_events where company_id = pf.id('A')) > 0
                and (select count(*) from public.pos_events where company_id = pf.id('A')) > 0 and (select count(*) from public.ledger_events where company_id = pf.id('A')) > 0,
    'G: documents, inventory, POS and ledger operations are audited');
end $$;

-- ------------------------------------------------------------- account deletion request (store requirement)
do $$
declare r jsonb;
begin
  r := pf.val('member2', 'select public.account_deletion_request(''Ya no trabajo aquí'')::text')::jsonb;
  perform pf.ok(r ->> 'status' = 'pending' and (r ->> 'sole_owner_of')::int = 0, 'H: a member asks to delete their account from the app');
  r := pf.val('basic', 'select public.account_deletion_request(null)::text')::jsonb;
  perform pf.ok((r ->> 'sole_owner_of')::int = 1, 'H: the sole owner of a company is told the company must be transferred or closed first');
  perform pf.ok(pf.val('member2', 'select count(*)::text from public.account_deletion_requests') = '1' and pf.val('other', 'select count(*)::text from public.account_deletion_requests') = '0',
    'H: each user sees only their own request');
  perform pf.ok(pf.err('member2', 'select public.account_deletion_cancel()') = '', 'H: cancel runs');
  perform pf.ok((select status from public.account_deletion_requests where user_id = pf.id('member2')) = 'cancelled', 'H: and can cancel it while pending');
  perform pf.ok(pf.err(null, 'select public.account_deletion_request(null)') <> '' and pf.err('member2', format('insert into public.account_deletion_requests (user_id) values (%L)', pf.id('other'))) like '%permission denied%',
    'H: nobody requests for someone else; anonymous callers cannot');
  perform pf.ok((select count(*) from public.documents where company_id = pf.id('A')) = 2, 'H: a request deletes no business data');
end $$;

do $$
begin
  if exists (select 1 from pf.failures) then raise exception 'PLATFORM FLOW TESTS FAILED: %', (select string_agg(msg, '; ') from pf.failures); end if;
  raise notice 'ALL PLATFORM FLOW TESTS PASSED';
end $$;
