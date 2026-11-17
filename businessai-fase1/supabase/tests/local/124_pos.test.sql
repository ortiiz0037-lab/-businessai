-- Point of sale and register integrations (0044): pricing on the server (catalog price, line and cart
-- discounts, taxes), shifts and the cash drawer, discounts / voids / refunds with approvals and one-time
-- supervisor codes, inventory (S7) once per line with compensations, the ledger (0023), immutability,
-- external sales (signed webhooks and syncs, idempotency, out-of-order versions, validation before stock,
-- refunds and voids from the provider, blocked stock), CSV import, processor settlements reconciled
-- with the bank (0026), reports, branch scope, isolation, company deletion.
-- TEST-ONLY, local throw-away database with 0014a … 0044. Schema ps.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema ps;
create table ps.ctx (key text primary key, val text not null);
create function ps.id(k text) returns uuid language sql stable as $$ select val::uuid from ps.ctx where key = k $$;
create function ps.v(k text) returns text language sql stable as $$ select val from ps.ctx where key = k $$;
create table ps.failures (msg text);
create function ps.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into ps.failures values (msg); end if;
end $$;
grant usage on schema ps to authenticated, anon;
grant select on ps.ctx to authenticated, anon;
grant execute on all functions in schema ps to authenticated, anon;
-- run a statement as a user (or anon when who is null): '' or the error
create function ps.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  if who is null then perform set_config('request.jwt.claims', '{"role":"anon"}', true); set local role anon;
  else perform set_config('request.jwt.claims', json_build_object('sub', ps.id(who), 'role', 'authenticated')::text, true); set local role authenticated; end if;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function ps.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  if who is null then perform set_config('request.jwt.claims', '{"role":"anon"}', true); set local role anon;
  else perform set_config('request.jwt.claims', json_build_object('sub', ps.id(who), 'role', 'authenticated')::text, true); set local role authenticated; end if;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function ps.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
create function ps.oh(br text, item text, variant text default null) returns numeric language plpgsql volatile as $$
begin
  return public.inventory_on_hand(ps.id(br), ps.id(item), case when variant is null then null else ps.id(variant) end);
end $$;
-- the server's signature (the test plays the server: same key as POS_SERVER_KEYS)
create function ps.mac(msg text) returns text language sql volatile as $$
  select encode(ba_private.hmac_sha256(decode('c2VydmVyLWtleS1mb3ItdGhlLXBvcy10ZXN0cy0wMTIzNDU2Nzg5', 'base64'), convert_to(msg, 'UTF8')), 'hex') $$;
create function ps.now() returns bigint language sql volatile as $$ select extract(epoch from now())::bigint $$;
-- a signed call: parts of the message with {ts} {nonce} placeholders, then the SQL with the same placeholders + {mac}
create function ps.signed(who text, parts text[], stmt text) returns text language plpgsql volatile as $$
declare ts bigint := ps.now(); n uuid := gen_random_uuid(); msg text; q text;
begin
  msg := replace(replace(array_to_string(parts, '|'), '{ts}', ts::text), '{nonce}', n::text);
  q := replace(replace(replace(stmt, '{ts}', ts::text), '{nonce}', quote_literal(n::text)), '{mac}', quote_literal(ps.mac(msg)));
  return ps.val(who, q);
end $$;
create function ps.signed_err(who text, parts text[], stmt text) returns text language plpgsql volatile as $$
declare ts bigint := ps.now(); n uuid := gen_random_uuid(); msg text; q text;
begin
  msg := replace(replace(array_to_string(parts, '|'), '{ts}', ts::text), '{nonce}', n::text);
  q := replace(replace(replace(stmt, '{ts}', ts::text), '{nonce}', quote_literal(n::text)), '{mac}', quote_literal(ps.mac(msg)));
  return ps.err(who, q);
end $$;
create function ps.sha(t text) returns text language sql immutable as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
-- a batch of external sales through the signed sync function (as the server, no user)
create function ps.ingest(integ text, sales jsonb, trig text default 'webhook') returns jsonb language plpgsql volatile as $$
declare p text := jsonb_build_object('trigger', trig, 'status', 'succeeded', 'sales', sales)::text;
begin
  return ps.signed(null, array['pos_ingest', 'v1', 'k1', ps.v(integ), '{ts}', '{nonce}', ps.sha(p)],
                   format('select public.pos_ingest_batch(%L, %L, %L, {ts}, {nonce}::uuid, {mac})::text', ps.v(integ), p, 'k1'))::jsonb;
end $$;
create function ps.sale(who text, payload jsonb, idem text) returns jsonb language plpgsql volatile as $$
begin
  return ps.val(who, format('select public.pos_sale_create(%L, %L, %L)::text', ps.id('A'), payload, idem))::jsonb;
end $$;
create function ps.sale_err(who text, payload jsonb, idem text) returns text language plpgsql volatile as $$
begin
  return ps.err(who, format('select public.pos_sale_create(%L, %L, %L)', ps.id('A'), payload, idem));
end $$;
create function ps.cart(reg text, shift text, lines jsonb, payments jsonb, extra jsonb default '{}') returns jsonb language sql stable as $$
  select jsonb_build_object('branch', (select branch_id from public.pos_registers where id = ps.id(reg)), 'register', ps.id(reg), 'shift', ps.v(shift), 'lines', lines, 'payments', payments) || extra $$;
create function ps.ln(item text, qty numeric, variant text default null, extra jsonb default '{}') returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('item', ps.id(item), 'variant', case when variant is null then null else ps.id(variant) end, 'qty', qty::text)) || extra $$;
create function ps.cash(amount bigint, tendered bigint default null) returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('method', 'cash', 'amount_cents', amount::text, 'tendered_cents', tendered::text))) $$;
create function ps.balanced(target uuid) returns boolean language sql stable as $$
  select not exists (select 1 from public.journal_entries e where e.company_id = target
                       and (select sum(debit_cents) from public.journal_lines l where l.entry_id = e.id) <> (select sum(credit_cents) from public.journal_lines l where l.entry_id = e.id)) $$;
create function ps.acct_bal(target uuid, sk text) returns bigint language sql stable as $$
  select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id
  where a.company_id = target and a.system_key = sk $$;
grant execute on all functions in schema ps to authenticated, anon;

insert into ps.ctx values
  ('owner', 'd1000000-0000-4000-8000-0000000000e1'), ('admin', 'd1000000-0000-4000-8000-0000000000e2'),
  ('member', 'd1000000-0000-4000-8000-0000000000e3'), ('member2', 'd1000000-0000-4000-8000-0000000000e5'), ('other', 'd1000000-0000-4000-8000-0000000000e4'),
  ('A', 'd2000000-0000-4000-8000-0000000000e1'), ('B', 'd2000000-0000-4000-8000-0000000000e2'),
  ('SJ', 'd3000000-0000-4000-8000-0000000000e1'), ('PC', 'd3000000-0000-4000-8000-0000000000e2'), ('BB', 'd3000000-0000-4000-8000-0000000000e3'),
  ('c1', 'd5000000-0000-4000-8000-0000000000e1'), ('cB', 'd5000000-0000-4000-8000-0000000000e2');
insert into auth.users (id, email) select val::uuid, key || '@ps.test' from ps.ctx where key in ('owner', 'admin', 'member', 'member2', 'other');
insert into public.companies (id, name, created_by) values (ps.id('A'), 'Tienda POS A', ps.id('owner')), (ps.id('B'), 'Tienda POS B', ps.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (ps.id('A'), 'cus_ps_a', 'sub_ps_a', 'pro', 'active'), (ps.id('B'), 'cus_ps_b', 'sub_ps_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (ps.id('A'), ps.id('owner'), 'owner'), (ps.id('A'), ps.id('admin'), 'admin'), (ps.id('A'), ps.id('member'), 'member'), (ps.id('A'), ps.id('member2'), 'member'),
  (ps.id('B'), ps.id('other'), 'owner');
insert into public.branches (id, company_id, name, code) values (ps.id('SJ'), ps.id('A'), 'San Juan', 'SJU'), (ps.id('PC'), ps.id('A'), 'Ponce', 'PCE'), (ps.id('BB'), ps.id('B'), 'Bayamón', 'BAY');
insert into public.branch_members (company_id, branch_id, user_id) values (ps.id('A'), ps.id('SJ'), ps.id('member')), (ps.id('A'), ps.id('PC'), ps.id('member2'));
insert into public.clients (id, company_id, name) values (ps.id('c1'), ps.id('A'), 'Cliente POS'), (ps.id('cB'), ps.id('B'), 'Cliente B');
select public.pos_set_server_key('k1', 'c2VydmVyLWtleS1mb3ItdGhlLXBvcy10ZXN0cy0wMTIzNDU2Nzg5');

-- ------------------------------------------------------------- catalog, stock, configuration
do $$
declare r text;
begin
  r := ps.val('admin', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, true, null)', ps.id('A'), 'P-001', 'Café molido', 'product', 'unidad', 1000));
  insert into ps.ctx values ('P1', r);
  r := ps.val('admin', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, true, null)', ps.id('A'), 'CAM-001', 'Camiseta', 'product', 'unidad', 1500));
  insert into ps.ctx values ('P2', r);
  r := ps.val('admin', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, false, null)', ps.id('A'), 'SRV-1', 'Instalación', 'service', 'hora', 5000));
  insert into ps.ctx values ('S1', r);
  r := ps.val('admin', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, 4, true, null)', ps.id('A'), 'PAN-1', 'Pan sobao', 'product', 'unidad', 999));
  insert into ps.ctx values ('P3', r);
  r := ps.val('admin', format('select public.catalog_variant_save(%L, null, %L, %L, null, 900)', ps.id('P2'), 'CAM-001-R-M', '{"color":"Rojo","talla":"M"}'));
  insert into ps.ctx values ('V1', r);
  r := ps.val('admin', format('select public.catalog_variant_save(%L, null, %L, %L, 1600, 950)', ps.id('P2'), 'CAM-001-A-L', '{"color":"Azul","talla":"L"}'));
  insert into ps.ctx values ('V2', r);
  perform ps.ok(ps.err('admin', format('select public.catalog_barcode_add(%L, null, %L, %L, true)', ps.id('P1'), '4006381333931', 'ean13')) = '', 'a barcode for the coffee');
  perform ps.ok(ps.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', ps.id('A'), ps.id('SJ'), 'opening',
                jsonb_build_array(jsonb_build_object('item', ps.id('P1'), 'qty', '20', 'unit_cost', '400'), jsonb_build_object('item', ps.id('P2'), 'variant', ps.id('V1'), 'qty', '5', 'unit_cost', '900'),
                                  jsonb_build_object('item', ps.id('P3'), 'qty', '50', 'unit_cost', '300')), 'Inventario inicial', 'ps-open-0001')) = ''
                and ps.oh('SJ', 'P1') = 20 and ps.oh('SJ', 'P2', 'V1') = 5, 'opening stock at San Juan (S7)');
  -- configuration
  perform ps.ok(ps.err('member', format('select public.pos_settings_save(%L, %L)', ps.id('A'), '{"max_discount_pct":"50"}')) like '%FORBIDDEN%', 'members do not configure the POS');
  perform ps.ok(ps.err('admin', format('select public.pos_settings_save(%L, %L)', ps.id('A'), '{"max_discount_pct":"10","require_shift":true,"receipt_footer":"Gracias"}')) = '',
    'settings: discounts above 10 % need approval');
  r := ps.val('admin', format('select public.pos_tax_rate_save(%L, null, %L, %L, 11.5, true)', ps.id('A'), 'IVU', 'IVU 11.5%'));
  insert into ps.ctx values ('T1', r);
  r := ps.val('admin', format('select public.pos_tax_rate_save(%L, null, %L, %L, 0, false)', ps.id('A'), 'EXENTO', 'Exento'));
  insert into ps.ctx values ('T0', r);
  perform ps.ok(ps.err('admin', format('select public.pos_item_tax_set(%L, %L, %L)', ps.id('A'), ps.id('S1'), ps.id('T0'))) = '', 'the service is tax exempt (rate per product)');
  perform ps.ok(ps.err('admin', format('select public.pos_tax_rate_save(%L, null, %L, %L, 101, false)', ps.id('A'), 'MAL', 'Mal')) like '%POS_INVALID%', 'a rate above 100 % is refused');
  r := ps.val('admin', format('select public.pos_register_save(%L, null, %L, %L, %L)', ps.id('A'), ps.id('SJ'), 'CAJA1', 'Caja 1'));
  insert into ps.ctx values ('R1', r);
  r := ps.val('admin', format('select public.pos_register_save(%L, null, %L, %L, %L)', ps.id('A'), ps.id('PC'), 'CAJA2', 'Caja Ponce'));
  insert into ps.ctx values ('R2', r);
  r := ps.val('admin', format('select public.pos_register_save(%L, null, %L, %L, %L)', ps.id('A'), ps.id('SJ'), 'CAJA3', 'Caja 3'));
  insert into ps.ctx values ('R3', r);
  perform ps.ok(ps.err('member', format('select public.pos_register_save(%L, null, %L, %L, %L)', ps.id('A'), ps.id('SJ'), 'X1', 'X')) like '%FORBIDDEN%', 'members do not create registers');
  perform ps.ok(ps.err('admin', format('select public.pos_register_assign(%L, %L, true)', ps.id('R2'), ps.id('admin'))) = '', 'the Ponce register is assigned to the admin only');
end $$;

-- ------------------------------------------------------------- pricing on the server
do $$
declare q jsonb;
begin
  q := ps.val('member', format('select public.pos_quote(%L, %L, null, 5)::text', ps.id('A'), jsonb_build_array(ps.ln('P1', 2), ps.ln('P2', 1, 'V1'))))::jsonb;
  perform ps.ok((q ->> 'subtotal_cents')::bigint = 3500 and (q ->> 'discount_cents')::bigint = 175 and (q ->> 'tax_cents')::bigint = 383 and (q ->> 'total_cents')::bigint = 3708,
    'quote: 2 × 10.00 + 15.00 (variant takes the catalog price), 5 % cart discount allocated 100 / 75, IVU 11.5 % rounded per line = 37.08');
  perform ps.ok((q -> 'lines' -> 1 ->> 'name') like 'Camiseta · %Rojo%' and (q -> 'lines' -> 0 ->> 'tax_name') = 'IVU 11.5%', 'lines keep the name with the variant and the tax name');
  q := ps.val('member', format('select public.pos_quote(%L, %L)::text', ps.id('A'), jsonb_build_array(ps.ln('P3', 1), ps.ln('S1', 1), ps.ln('P2', 1, 'V2'))))::jsonb;
  perform ps.ok((q -> 'lines' -> 0 ->> 'tax_cents')::bigint = 40 and (q -> 'lines' -> 1 ->> 'tax_cents')::bigint = 0 and (q -> 'lines' -> 2 ->> 'unit_price_cents')::bigint = 1600
                and (q -> 'lines' -> 2 ->> 'tax_cents')::bigint = 184,
    'tax resolution: catalog rate 4 % (39.96 → 0.40), product rate Exento for the service, default IVU; the variant has its own price 16.00');
  q := ps.val('member', format('select public.pos_quote(%L, %L, 1)::text', ps.id('A'), jsonb_build_array(ps.ln('P1', 1), ps.ln('P1', 1), ps.ln('P1', 1))))::jsonb;
  perform ps.ok((q ->> 'discount_cents')::bigint = 1 and (q -> 'lines' -> 0 ->> 'discount_cents')::bigint = 1 and (q -> 'lines' -> 1 ->> 'discount_cents')::bigint = 0,
    'a cart discount of 1 cent over three equal lines goes to the first line (largest remainder, no cent lost or invented)');
  perform ps.ok(ps.err('member', format('select public.pos_quote(%L, %L)', ps.id('A'), jsonb_build_array(ps.ln('P2', 1)))) like '%INVENTORY_VARIANT_REQUIRED%', 'a product with variants needs the variant');
  perform ps.ok(ps.err('member', format('select public.pos_quote(%L, %L)', ps.id('A'), jsonb_build_array(ps.ln('P1', 1.5)))) like '%POS_QTY_INVALID%', 'units are sold whole');
  perform ps.ok(ps.err('member', format('select public.pos_quote(%L, %L)', ps.id('A'), jsonb_build_array(ps.ln('P1', 1, null, '{"discount_cents":"5000"}')))) like '%POS_DISCOUNT_INVALID%',
    'a discount above the line is refused');
  perform ps.ok(ps.err('other', format('select public.pos_quote(%L, %L)', ps.id('A'), jsonb_build_array(ps.ln('P1', 1)))) like '%FORBIDDEN%', 'isolation: B cannot price A''s catalog');
end $$;

-- ------------------------------------------------------------- shifts
do $$
declare r jsonb;
begin
  perform ps.ok(ps.sale_err('member', ps.cart('R1', 'none', jsonb_build_array(ps.ln('P1', 1)), ps.cash(1115)), 'ps-noshift-01') like '%POS_SHIFT_REQUIRED%', 'no sale without an open shift');
  r := ps.val('member', format('select public.pos_shift_open(%L, 10000, %L)::text', ps.id('R1'), 'ps-shift-m-01'))::jsonb;
  insert into ps.ctx values ('SH1', r ->> 'id');
  perform ps.ok(r ->> 'number' = 'TU-000001' and (select status from public.pos_shifts where id = ps.id('SH1')) = 'open', 'the member opens a shift on Caja 1 with a float of 100.00');
  perform ps.ok((ps.val('member', format('select public.pos_shift_open(%L, 10000, %L)::text', ps.id('R1'), 'ps-shift-m-01'))::jsonb ->> 'already')::boolean, 'the same request again: the same shift');
  perform ps.ok(ps.err('member', format('select public.pos_shift_open(%L, 0, %L)', ps.id('R3'), 'ps-shift-m-02')) like '%POS_SHIFT_ALREADY_OPEN%', 'one open shift per cashier');
  perform ps.ok(ps.err('admin', format('select public.pos_shift_open(%L, 0, %L)', ps.id('R1'), 'ps-shift-a-00')) like '%POS_SHIFT_ALREADY_OPEN%', 'one open shift per register');
  perform ps.ok(ps.err('member2', format('select public.pos_shift_open(%L, 0, %L)', ps.id('R1'), 'ps-shift-m2-01')) like '%BRANCH_FORBIDDEN%', 'a Ponce member cannot open a San Juan register');
  perform ps.ok(ps.err('member2', format('select public.pos_shift_open(%L, 0, %L)', ps.id('R2'), 'ps-shift-m2-02')) like '%POS_REGISTER_NOT_ASSIGNED%', 'nor a register assigned to someone else');
end $$;

-- ------------------------------------------------------------- native sales, inventory and ledger
do $$
declare r jsonb; e text; ent uuid;
begin
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 2), ps.ln('P2', 1, 'V1')), ps.cash(3708, 4000), jsonb_build_object('cart_discount_pct', '5', 'client', ps.v('c1'))), 'ps-sale-0001');
  insert into ps.ctx values ('S1x', r ->> 'id');
  perform ps.ok(r ->> 'number' = 'POS-000001' and (r ->> 'total_cents')::bigint = 3708 and (r ->> 'change_cents')::bigint = 292, 'a cash sale of 37.08 with 40.00 tendered: change 2.92');
  perform ps.ok(ps.oh('SJ', 'P1') = 18 and ps.oh('SJ', 'P2', 'V1') = 4, 'stock left the branch once per line (S7 ledger)');
  perform ps.ok((select count(*) from public.inventory_movements where source_type = 'pos_sale' and source_id = ps.id('S1x')) = 2
                and (select count(*) from public.pos_sale_lines where sale_id = ps.id('S1x') and movement_id is not null) = 2, 'each tracked line keeps its movement');
  perform ps.ok(((ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 2), ps.ln('P2', 1, 'V1')), ps.cash(3708, 4000), '{"cart_discount_pct":"5"}'), 'ps-sale-0001')) ->> 'already')::boolean
                and ps.oh('SJ', 'P1') = 18 and (select count(*) from public.pos_sales where company_id = ps.id('A')) = 1, 'the same sale submitted again: no second sale, no second outflow');
  select ledger_entry_id into ent from public.pos_sales where id = ps.id('S1x');
  perform ps.ok((select string_agg(a.system_key || ':' || l.debit_cents || '/' || l.credit_cents, ',' order by l.line_no) from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id where l.entry_id = ent)
                = 'cash:3708/0,sales_revenue:0/3325,sales_tax_payable:0/383', 'ledger: Dr cash 37.08, Cr revenue 33.25, Cr sales tax 3.83');
  perform ps.ok((select sum(amount_cents) from public.pos_cash_movements where shift_id = ps.id('SH1')) = 13708, 'the drawer expects float + cash sale (net of change) = 137.08');
  -- refusals
  perform ps.ok(ps.sale_err('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(1000)), 'ps-sale-bad1') like '%POS_PAYMENTS_MISMATCH%', 'payments must equal the server''s total');
  perform ps.ok(ps.sale_err('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), '[{"method":"card","amount_cents":"1115"}]'), 'ps-sale-bad2') like '%card_requires_terminal%'
                or ps.sale_err('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), '[{"method":"card","amount_cents":"1115"}]'), 'ps-sale-bad2') like '%POS_PAYMENT_METHOD_INVALID%',
    'an integrated card payment is not simulated: it needs a processor terminal');
  perform ps.ok(ps.sale_err('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), '[{"method":"ath_movil","amount_cents":"1115"}]'), 'ps-sale-bad3') like '%POS_PAYMENT_REFERENCE_REQUIRED%',
    'ATH Móvil needs its reference number');
  perform ps.ok(ps.sale_err('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 30)), ps.cash(33450)), 'ps-sale-bad4') like '%POS_STOCK_UNAVAILABLE%' and ps.oh('SJ', 'P1') = 18,
    'more than the available stock is refused (nothing moved)');
  perform ps.ok(ps.sale_err('member2', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(1115)), 'ps-sale-bad5') like '%BRANCH_FORBIDDEN%', 'a Ponce member cannot sell in San Juan');
  perform ps.ok(ps.sale_err('member', ps.cart('R1', 'SH1', jsonb_build_array(jsonb_build_object('item', ps.id('P1'), 'qty', '1')), ps.cash(1115), jsonb_build_object('client', ps.v('cB'))), 'ps-sale-bad6')
                like '%POS_CLIENT_INVALID%', 'a client of another company is refused');
  -- reservations count: 15 reserved of the 18 on hand leave 3 available
  perform ps.ok(ps.err('admin', format('select public.inventory_reserve(%L, %L, %L, null, 15, %L, %L, null, %L)', ps.id('A'), ps.id('SJ'), ps.id('P1'), 'reserved', 'Pedido', 'ps-res-0001')) = '', 'an order reserves 15');
  perform ps.ok(ps.sale_err('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 4)), ps.cash(4460)), 'ps-sale-bad7') like '%POS_STOCK_UNAVAILABLE%', 'reserved stock is not sold (available = on hand − reserved)');
  update public.inventory_reservations set status = 'released' where idem_key = 'ps-res-0001';
  -- ATH Móvil and an external card terminal, with references; the service has no stock
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('S1', 1), ps.ln('P3', 2)),
        '[{"method":"ath_movil","amount_cents":"3000","reference":"ATH-778812"},{"method":"card_external","amount_cents":"4078","reference":"AUTH 0012","card_last4":"4242","card_brand":"Visa"}]'), 'ps-sale-0002');
  insert into ps.ctx values ('S2x', r ->> 'id');
  perform ps.ok((r ->> 'total_cents')::bigint = 7078 and ps.oh('SJ', 'P3') = 48 and (select count(*) from public.pos_payments where sale_id = ps.id('S2x')) = 2
                and (select card_last4 from public.pos_payments where sale_id = ps.id('S2x') and method = 'card_external') = '4242',
    'split payment: ATH Móvil + card on a stand-alone terminal (last four only, no card data)');
  perform ps.ok(ps.acct_bal(ps.id('A'), 'pos_clearing') = 7078, 'non-cash payments wait in «POS funds to deposit» until the deposit');
end $$;

-- ------------------------------------------------------------- discounts and approvals
do $$
declare r jsonb; code text; i integer;
begin
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(892), '{"cart_discount_pct":"20","discount_reason":"Cliente frecuente"}'), 'ps-sale-0003');
  perform ps.ok(r ->> 'error' = 'POS_APPROVAL_REQUIRED' and (select count(*) from public.pos_sales where idem_key = 'ps-sale-0003') = 0, 'a 20 % discount by a member needs approval (nothing written)');
  perform ps.ok(ps.err('member', format('select public.pos_approval_issue(%L, %L, %L, null, 25)', ps.id('A'), ps.id('SJ'), 'discount')) like '%FORBIDDEN%', 'members do not issue supervisor codes');
  code := ps.val('admin', format('select (public.pos_approval_issue(%L, %L, %L, null, 25)) ->> %L', ps.id('A'), ps.id('SJ'), 'discount', 'code'));
  perform ps.ok(code ~ '^[0-9]{8}$' and not exists (select 1 from public.pos_approval_codes where code_hash like '%' || code || '%'), 'the admin issues an 8-digit code (only its hash is stored)');
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(892), jsonb_build_object('cart_discount_pct', '20', 'discount_reason', 'Cliente frecuente', 'approval_code', code)), 'ps-sale-0003');
  insert into ps.ctx values ('S3x', r ->> 'id');
  perform ps.ok((r ->> 'total_cents')::bigint = 892 and (select discount_approved_by from public.pos_sales where id = ps.id('S3x')) = ps.id('admin'), 'with the code: sold at 20 % off, approved by the admin');
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(892), jsonb_build_object('cart_discount_pct', '20', 'discount_reason', 'Otra vez', 'approval_code', code)), 'ps-sale-0004');
  perform ps.ok(r ->> 'error' = 'POS_APPROVAL_REQUIRED', 'a code is used once');
  code := ps.val('admin', format('select (public.pos_approval_issue(%L, %L, %L, null, 15)) ->> %L', ps.id('A'), ps.id('SJ'), 'discount', 'code'));
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(892), jsonb_build_object('cart_discount_pct', '20', 'discount_reason', 'Otra vez', 'approval_code', code)), 'ps-sale-0004');
  perform ps.ok(r ->> 'error' = 'POS_APPROVAL_REQUIRED', 'a code is limited to what the approver allowed (15 % < 20 %)');
  perform ps.ok(ps.sale_err('admin', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(892), '{"cart_discount_pct":"20"}'), 'ps-sale-0005') like '%POS_SHIFT_NOT_OPEN%',
    'nobody sells on another cashier''s shift');
  -- brute force: 5 failures in 10 minutes lock the user, even with a valid code afterwards
  code := ps.val('admin', format('select (public.pos_approval_issue(%L, null, %L, null, 50)) ->> %L', ps.id('A'), 'discount', 'code'));
  for i in 1..5 loop
    r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(892), jsonb_build_object('cart_discount_pct', '20', 'discount_reason', 'x prueba', 'approval_code', lpad(i::text, 8, '9'))), 'ps-brute-000' || i);
  end loop;
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(892), jsonb_build_object('cart_discount_pct', '20', 'discount_reason', 'x prueba', 'approval_code', code)), 'ps-brute-0009');
  perform ps.ok(r ->> 'error' = 'POS_APPROVAL_REQUIRED' and (select count(*) from public.pos_events where actor = ps.id('member') and action = 'approval_failed') >= 5
                and exists (select 1 from public.pos_events where actor = ps.id('member') and action = 'approval_locked'),
    'five wrong codes lock the cashier for 10 minutes; the failures are logged (not rolled back)');
  -- test cleanup only (superuser, triggers bypassed): unlock the member for the rest of the suite
  set local session_replication_role = replica;
  delete from public.pos_events where actor = ps.id('member') and action in ('approval_failed', 'approval_locked');
  set local session_replication_role = origin;
end $$;

-- ------------------------------------------------------------- history is never altered
do $$
declare v integer;
begin
  select version into v from public.catalog_items where id = ps.id('P1');
  perform ps.val('admin', format('select id from public.catalog_save(%L, %L, %L, %L, null, %L, %L, %s, null, true, %s)', ps.id('A'), ps.id('P1'), 'P-001', 'Café molido', 'product', 'unidad', 1250, v));
  perform ps.ok((select unit_price_cents from public.pos_sale_lines where sale_id = ps.id('S1x') and line_no = 1) = 1000 and (select total_cents from public.pos_sales where id = ps.id('S1x')) = 3708,
    'a later price change (12.50) does not alter the past sale (10.00 as sold)');
  perform ps.ok(ps.err('member', format('insert into public.pos_sales (company_id, number, source, branch_id, occurred_at, subtotal_cents, total_cents) values (%L, %L, %L, %L, now(), 1, 1)',
                ps.id('A'), 'X', 'native', ps.id('SJ'))) like '%permission denied%', 'sales are written only through the functions');
  perform ps.ok(ps.merr(format('update public.pos_sales set total_cents = 1, subtotal_cents = 1, tax_cents = 0, discount_cents = 0 where id = %L', ps.id('S1x'))) like '%POS_IMMUTABLE%'
                and ps.merr(format('update public.pos_sale_lines set unit_price_cents = 1 where sale_id = %L', ps.id('S1x'))) like '%POS_IMMUTABLE%'
                and ps.merr(format('delete from public.pos_cash_movements where shift_id = %L', ps.id('SH1'))) like '%POS_IMMUTABLE%'
                and ps.merr(format('update public.pos_payments set amount_cents = 1 where sale_id = %L', ps.id('S1x'))) like '%POS_IMMUTABLE%',
    'amounts of sales, lines, payments and the drawer cannot be edited, even by the database owner');
end $$;

-- ------------------------------------------------------------- voids
do $$
declare r jsonb; e text; before_cash bigint;
begin
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 3)), ps.cash(4181)), 'ps-sale-0010');
  insert into ps.ctx values ('S4x', r ->> 'id');
  perform ps.ok((r ->> 'total_cents')::bigint = 4181 and ps.oh('SJ', 'P1') = 14, 'a sale of 3 coffees at the new price (12.50 + IVU)');
  r := ps.val('member', format('select public.pos_sale_void(%L, %L)::text', ps.id('S4x'), 'Error de cobro'))::jsonb;
  perform ps.ok(r ->> 'error' = 'POS_APPROVAL_REQUIRED' and (select status from public.pos_sales where id = ps.id('S4x')) = 'completed', 'a member cannot void without approval');
  select sum(amount_cents) into before_cash from public.pos_cash_movements where shift_id = ps.id('SH1');
  perform ps.ok(ps.err('admin', format('select public.pos_sale_void(%L, %L)', ps.id('S4x'), 'x')) like '%REASON_REQUIRED%', 'a void needs a reason');
  r := ps.val('admin', format('select public.pos_sale_void(%L, %L)::text', ps.id('S4x'), 'Error de cobro'))::jsonb;
  perform ps.ok(r ->> 'status' = 'voided' and ps.oh('SJ', 'P1') = 17
                and (select count(*) from public.inventory_movements m where m.source_type = 'pos_void' and m.source_id = ps.id('S4x') and m.kind = 'correction') = 1
                and (select sum(amount_cents) from public.pos_cash_movements where shift_id = ps.id('SH1')) = before_cash - 4181,
    'the admin voids it: a compensating stock movement and the cash leaves the expected drawer');
  perform ps.ok((select count(*) from public.journal_entries where source = 'pos_sale_void' and source_id = ps.id('S4x') and reverses_entry_id is not null) = 1
                and (select status from public.pos_payments where sale_id = ps.id('S4x')) = 'voided', 'the ledger entry is reversed and the payment voided');
  perform ps.ok((ps.val('admin', format('select public.pos_sale_void(%L, %L)::text', ps.id('S4x'), 'Otra vez'))::jsonb ->> 'already')::boolean and ps.oh('SJ', 'P1') = 17,
    'voiding again changes nothing');
  perform ps.ok(ps.err('admin', format('select public.pos_refund_create(%L, %L, null, %L)', ps.id('S4x'), '{"lines":[],"method":"cash","reason":"No"}', 'ps-ref-void1')) like '%POS_REFUND_NOT_ALLOWED%',
    'a voided sale cannot be refunded');
end $$;

-- ------------------------------------------------------------- refunds
do $$
declare r jsonb; l1 bigint; code text;
begin
  r := ps.sale('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 3)), ps.cash(4181)), 'ps-sale-0011');
  insert into ps.ctx values ('S5x', r ->> 'id');
  select id into l1 from public.pos_sale_lines where sale_id = ps.id('S5x');
  r := ps.val('member', format('select public.pos_refund_create(%L, %L, null, %L)::text', ps.id('S5x'), jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line', l1::text, 'qty', '1')),
        'method', 'cash', 'reason', 'Producto abierto', 'restock', true), 'ps-ref-0001'))::jsonb;
  perform ps.ok(r ->> 'error' = 'POS_APPROVAL_REQUIRED', 'a member refunds only with approval');
  code := ps.val('admin', format('select (public.pos_approval_issue(%L, %L, %L, 2000, null)) ->> %L', ps.id('A'), ps.id('SJ'), 'refund', 'code'));
  r := ps.val('member', format('select public.pos_refund_create(%L, %L, %L, %L)::text', ps.id('S5x'), jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line', l1::text, 'qty', '1')),
        'method', 'cash', 'reason', 'Producto abierto', 'restock', true), code, 'ps-ref-0001'))::jsonb;
  perform ps.ok((r ->> 'amount_cents')::bigint = 1394 and ps.oh('SJ', 'P1') = 15 and (select refunded_qty from public.pos_sale_lines where id = l1) = 1
                and (select status from public.pos_sales where id = ps.id('S5x')) = 'partially_refunded', 'one of three refunded with a refund code: 13.94 back, the unit returns to stock');
  perform ps.ok(((ps.val('member', format('select public.pos_refund_create(%L, %L, %L, %L)::text', ps.id('S5x'), jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line', l1::text, 'qty', '1')),
        'method', 'cash', 'reason', 'Producto abierto'), code, 'ps-ref-0001'))::jsonb) ->> 'already')::boolean and ps.oh('SJ', 'P1') = 15, 'the same refund again: nothing new');
  perform ps.ok(ps.err('admin', format('select public.pos_refund_create(%L, %L, null, %L)', ps.id('S5x'), jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line', l1::text, 'qty', '3')),
        'method', 'ath_movil', 'reference', 'ATH-X', 'reason', 'Demasiado'), 'ps-ref-0002')) like '%POS_REFUND_EXCEEDS%', 'never more than what is left to refund');
  r := ps.val('admin', format('select public.pos_refund_create(%L, %L, null, %L)::text', ps.id('S5x'), jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('line', l1::text, 'qty', '2')),
        'method', 'ath_movil', 'reference', 'ATH-REV-1', 'reason', 'Dañados', 'restock', false), 'ps-ref-0003'))::jsonb;
  perform ps.ok((r ->> 'amount_cents')::bigint = 2787 and (select sum(amount_cents) from public.pos_refunds where sale_id = ps.id('S5x')) = 4181
                and (select status from public.pos_sales where id = ps.id('S5x')) = 'refunded' and ps.oh('SJ', 'P1') = 15,
    'the last two (damaged, not restocked) take the exact remainder: refunds add up to the sale, 41.81');
  perform ps.ok((select status from public.pos_payments where sale_id = ps.id('S5x')) = 'refunded', 'the payment shows as refunded');
  perform ps.ok(ps.merr(format('update public.pos_refunds set amount_cents = 1 where sale_id = %L', ps.id('S5x'))) like '%POS_IMMUTABLE%', 'refunds are written once');
  perform ps.ok(ps.balanced(ps.id('A')) and (select count(*) from public.journal_entries where source = 'pos_refund' and company_id = ps.id('A')) = 2, 'each refund posts its own balanced entry');
end $$;

-- ------------------------------------------------------------- cash drawer and closing
do $$
declare r jsonb; code text; expected bigint; e text;
begin
  perform ps.ok((ps.val('member', format('select public.pos_cash_move(%L, %L, 500, %L, null, %L)::text', ps.id('SH1'), 'paid_in', 'Cambio del banco', 'ps-cash-0001'))::jsonb ->> 'already') = 'false',
    'a paid in of 5.00 needs no approval');
  r := ps.val('member', format('select public.pos_cash_move(%L, %L, 2000, %L, null, %L)::text', ps.id('SH1'), 'paid_out', 'Compra de hielo', 'ps-cash-0002'))::jsonb;
  perform ps.ok(r ->> 'error' = 'POS_APPROVAL_REQUIRED', 'a paid out needs approval');
  code := ps.val('admin', format('select (public.pos_approval_issue(%L, %L, %L, 5000, null)) ->> %L', ps.id('A'), ps.id('SJ'), 'cash_out', 'code'));
  r := ps.val('member', format('select public.pos_cash_move(%L, %L, 2000, %L, %L, %L)::text', ps.id('SH1'), 'paid_out', 'Compra de hielo', code, 'ps-cash-0002'))::jsonb;
  perform ps.ok(r ->> 'already' = 'false' and (select approved_by from public.pos_cash_movements where idem_key = 'ps-cash-0002') = ps.id('admin'), 'with a cash-out code: paid out, approver recorded');
  perform ps.ok(ps.err('admin', format('select public.pos_cash_move(%L, %L, 99999999, %L, null, %L)', ps.id('SH1'), 'drop', 'Al banco', 'ps-cash-0003')) like '%POS_CASH_INSUFFICIENT%',
    'a drop cannot take more than the drawer holds');
  perform ps.ok(ps.err('admin', format('select public.pos_cash_move(%L, %L, 5000, %L, null, %L)', ps.id('SH1'), 'drop', 'Depósito a la caja fuerte', 'ps-cash-0004')) = '', 'an approver drops 50.00 to the safe');
  select sum(amount_cents) into expected from public.pos_cash_movements where shift_id = ps.id('SH1');
  insert into ps.ctx values ('exp1', expected::text);
  perform ps.ok(ps.err('member', format('select public.pos_shift_close(%L, %s, null, null)', ps.id('SH1'), expected - 100)) like '%REASON_REQUIRED%', 'a difference needs the cashier''s note');
  r := ps.val('member', format('select public.pos_shift_close(%L, %s, %L, %L)::text', ps.id('SH1'), expected - 100, '{"2000":3,"100":4}', 'Faltó un dólar'))::jsonb;
  perform ps.ok(r ->> 'status' = 'pending_review' and (r ->> 'difference_cents')::bigint = -100 and (r ->> 'expected_cents')::bigint = expected,
    'closing with 1.00 short: recorded as counted, waiting for review (never corrected)');
  perform ps.ok(ps.sale_err('member', ps.cart('R1', 'SH1', jsonb_build_array(ps.ln('P1', 1)), ps.cash(1394)), 'ps-sale-0020') like '%POS_SHIFT_NOT_OPEN%', 'no sales on a closed shift');
  perform ps.ok(ps.merr(format('update public.pos_shifts set counted_cash_cents = %s, difference_cents = 0 where id = %L', expected, ps.id('SH1'))) like '%POS_IMMUTABLE%', 'the count cannot be edited afterwards');
  perform ps.ok(ps.err('member', format('select public.pos_shift_review(%L, %L)', ps.id('SH1'), 'Visto')) like '%FORBIDDEN%', 'members do not review differences');
  r := ps.val('owner', format('select public.pos_shift_review(%L, %L)::text', ps.id('SH1'), 'Revisado con la cajera'))::jsonb;
  perform ps.ok(r ->> 'status' = 'reviewed' and ps.acct_bal(ps.id('A'), 'cash_over_short') = 100, 'the owner reviews it: posted to cash over / short (1.00)');
  -- the admin cannot review their own difference
  r := ps.val('admin', format('select public.pos_shift_open(%L, 0, %L)::text', ps.id('R3'), 'ps-shift-a-01'))::jsonb;
  insert into ps.ctx values ('SH2', r ->> 'id');
  perform ps.val('admin', format('select public.pos_shift_close(%L, 50, null, %L)::text', ps.id('SH2'), 'Sobraron 50 centavos'));
  perform ps.ok(ps.err('admin', format('select public.pos_shift_review(%L, %L)', ps.id('SH2'), 'Mío')) like '%POS_SELF_APPROVAL%', 'an admin does not review their own difference');
  e := ps.err('owner', format('select public.pos_shift_review(%L, %L)', ps.id('SH2'), 'Sobrante revisado'));
  perform ps.ok(e = '' and  ps.acct_bal(ps.id('A'), 'cash_over_short') = 50,
    'the owner reviews the 0.50 over');
end $$;

-- ------------------------------------------------------------- external integrations (signed)
do $$
declare p text; r jsonb; e text;
begin
  p := '{"provider":"square","environment":"test_double","external_account_id":"MERCHANT-1","display_name":"Square tienda","token_ciphertext":"k1.aaaaaaaaaaaaaaaa.bbbbbbbb.cccccccc","key_version":"k1"}';
  perform ps.ok(ps.err('admin', format('select public.pos_integration_connect(%L, %L, %L, %s, %L, %L)', ps.id('A'), p, 'k1', ps.now(), gen_random_uuid(), repeat('0', 64))) like '%POS_SERVER_AUTH%',
    'connecting needs the server''s signature');
  e := ps.signed_err('member', array['pos_connect', 'v1', 'k1', ps.v('member'), ps.v('A'), '{ts}', '{nonce}', ps.sha(p)],
                     format('select public.pos_integration_connect(%L, %L, %L, {ts}, {nonce}::uuid, {mac})', ps.id('A'), p, 'k1'));
  perform ps.ok(e like '%FORBIDDEN%', 'members do not connect integrations (even with a valid signature)');
  insert into ps.ctx values ('I1', ps.signed('admin', array['pos_connect', 'v1', 'k1', ps.v('admin'), ps.v('A'), '{ts}', '{nonce}', ps.sha(p)],
                     format('select public.pos_integration_connect(%L, %L, %L, {ts}, {nonce}::uuid, {mac})', ps.id('A'), p, 'k1')));
  perform ps.ok(ps.id('I1') is not null and (select token_ciphertext from ba_private.pos_integration_secrets where integration_id = ps.id('I1')) like 'k1.%'
                and ps.err('admin', 'select count(*) from ba_private.pos_integration_secrets') like '%permission denied%', 'the admin connects Square; the encrypted token is not readable by users');
  e := ps.signed_err('other', array['pos_connect', 'v1', 'k1', ps.v('other'), ps.v('B'), '{ts}', '{nonce}', ps.sha(p)],
                     format('select public.pos_integration_connect(%L, %L, %L, {ts}, {nonce}::uuid, {mac})', ps.id('B'), p, 'k1'));
  perform ps.ok(e like '%POS_INTEGRATION_TAKEN%', 'the same merchant account cannot be connected to another company');
  perform ps.ok(ps.err('admin', format('select public.pos_location_map(%L, %L, %L)', ps.id('I1'), 'LOC-SJ', ps.id('SJ'))) = ''
                and ps.err('admin', format('select public.pos_item_map(%L, %L, %L, null)', ps.id('I1'), 'SQ-ITEM-COFFEE', ps.id('P1'))) = '', 'the Square location maps to San Juan and its item to the coffee');
  perform ps.ok(ps.err('other', format('select public.pos_location_map(%L, %L, %L)', ps.id('I1'), 'LOC-X', ps.id('SJ'))) like '%FORBIDDEN%', 'isolation: B cannot map A''s integration');
  -- webhooks: idempotent by event id; unknown accounts are recorded and ignored
  p := '{"account_id":"MERCHANT-1","event_type":"order.updated","object_type":"order","object_id":"ORD-1","version":"1"}';
  r := ps.signed(null, array['pos_webhook', 'v1', 'k1', 'square', 'evt-000000001', '{ts}', '{nonce}', ps.sha(p)],
                 format('select public.pos_webhook_record(%L, %L, %L, %L, {ts}, {nonce}::uuid, {mac})::text', 'square', 'evt-000000001', p, 'k1'))::jsonb;
  insert into ps.ctx values ('E1', r ->> 'event_id');
  perform ps.ok(r ->> 'status' = 'received' and (r ->> 'integration_id')::uuid = ps.id('I1'), 'a signed Square webhook is recorded for the integration');
  r := ps.signed(null, array['pos_webhook', 'v1', 'k1', 'square', 'evt-000000001', '{ts}', '{nonce}', ps.sha(p)],
                 format('select public.pos_webhook_record(%L, %L, %L, %L, {ts}, {nonce}::uuid, {mac})::text', 'square', 'evt-000000001', p, 'k1'))::jsonb;
  perform ps.ok((r ->> 'already')::boolean and (select count(*) from public.pos_sync_events where event_key = 'evt-000000001') = 1, 'the same event delivered twice is recorded once');
  r := ps.signed(null, array['pos_webhook', 'v1', 'k1', 'square', 'evt-000000002', '{ts}', '{nonce}', ps.sha(replace(p, 'MERCHANT-1', 'MERCHANT-X'))],
                 format('select public.pos_webhook_record(%L, %L, %L, %L, {ts}, {nonce}::uuid, {mac})::text', 'square', 'evt-000000002', replace(p, 'MERCHANT-1', 'MERCHANT-X'), 'k1'))::jsonb;
  perform ps.ok(r ->> 'status' = 'ignored', 'an event of an unknown merchant is ignored (kept for the record)');
  perform ps.ok(ps.err(null, format('select public.pos_webhook_record(%L, %L, %L, %L, %s, %L, %L)', 'square', 'evt-000000003', p, 'k1', ps.now(), gen_random_uuid(), ps.mac('forged'))) like '%POS_SERVER_AUTH%',
    'a forged signature is refused');
end $$;

do $$
declare r jsonb; o jsonb; ent uuid;
begin
  o := jsonb_build_object('external_id', 'ORD-1', 'version', '1', 'state', 'completed', 'occurred_at', now() - interval '1 hour', 'location_id', 'LOC-SJ', 'register_ref', 'DEVICE-7',
         'cashier_ref', 'Ana (Square)', 'total_cents', '2230',
         'lines', jsonb_build_array(jsonb_build_object('external_line_id', 'L1', 'item_ref', 'SQ-ITEM-COFFEE', 'name', 'Café molido', 'qty', '2', 'unit_price_cents', '1000', 'tax_cents', '230', 'tax_rate', '11.5')),
         'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount_cents', '2230', 'provider_payment_id', 'PAY-1', 'card_brand', 'VISA', 'card_last4', '1111')));
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('event_id', ps.v('E1'))));
  perform ps.ok(r -> 'results' -> 0 ->> 'outcome' = 'created' and ps.oh('SJ', 'P1') = 13 and (select status from public.pos_sync_events where id = ps.v('E1')::bigint) = 'applied',
    'the Square order is imported: stock leaves San Juan once, the webhook event is applied');
  insert into ps.ctx values ('X1', (r -> 'results' -> 0 ->> 'sale_id'));
  perform ps.ok((select source || '/' || cashier_ref from public.pos_sales where id = ps.id('X1')) = 'external/Ana (Square)'
                and exists (select 1 from public.pos_registers where integration_id = ps.id('I1') and external_ref = 'DEVICE-7' and kind = 'external'),
    'the external cashier and the device (as an external register) are kept');
  r := ps.ingest('I1', jsonb_build_array(o));
  perform ps.ok(r -> 'results' -> 0 ->> 'outcome' = 'duplicate' and ps.oh('SJ', 'P1') = 13 and (select count(*) from public.pos_sales where integration_id = ps.id('I1')) = 1,
    'the same order synced again: no duplicate sale, no second outflow');
  -- refund in version 3, then an older version 2 arrives late
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('version', '3', 'refunds', jsonb_build_array(jsonb_build_object('external_id', 'RF-1', 'method', 'card', 'reason', 'Devuelto',
          'lines', jsonb_build_array(jsonb_build_object('external_line_id', 'L1', 'qty', '1')))))));
  perform ps.ok(r -> 'results' -> 0 ->> 'outcome' = 'updated' and ps.oh('SJ', 'P1') = 14 and (select refunded_cents from public.pos_sales where id = ps.id('X1')) = 1115,
    'version 3 brings a refund of one unit: 11.15 back, the unit returns');
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('version', '2', 'state', 'voided')));
  perform ps.ok(r -> 'results' -> 0 ->> 'outcome' = 'stale' and (select status from public.pos_sales where id = ps.id('X1')) = 'partially_refunded', 'an older version arriving late changes nothing (out of order)');
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('version', '3', 'refunds', jsonb_build_array(jsonb_build_object('external_id', 'RF-1', 'method', 'card', 'reason', 'Devuelto',
          'lines', jsonb_build_array(jsonb_build_object('external_line_id', 'L1', 'qty', '1')))))));
  perform ps.ok(ps.oh('SJ', 'P1') = 14 and (select count(*) from public.pos_refunds where sale_id = ps.id('X1')) = 1, 'the same refund again: once');
  -- validation before stock
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('external_id', 'ORD-2', 'lines', jsonb_build_array(jsonb_build_object('external_line_id', 'L1', 'item_ref', 'SQ-UNKNOWN', 'sku', 'NOPE-9',
          'name', 'Desconocido', 'qty', '1', 'unit_price_cents', '2000', 'tax_cents', '230')), 'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount_cents', '2230', 'provider_payment_id', 'PAY-2')))));
  perform ps.ok(r -> 'results' -> 0 ->> 'outcome' = 'needs_review' and r -> 'results' -> 0 ->> 'error' = 'item_unmapped' and ps.oh('SJ', 'P1') = 14
                and not exists (select 1 from public.pos_sales where external_id = 'ORD-2'), 'an unknown product: needs review, nothing written, no stock guessed');
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('external_id', 'ORD-3', 'location_id', 'LOC-UNKNOWN')));
  perform ps.ok(r -> 'results' -> 0 ->> 'error' = 'location_unmapped', 'an unmapped location: needs review');
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('external_id', 'ORD-4', 'total_cents', '9999')));
  perform ps.ok(r -> 'results' -> 0 ->> 'error' = 'totals_mismatch' and not exists (select 1 from public.pos_registers where name like '%ORD-4%'), 'totals that do not add up: needs review');
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('external_id', 'ORD-5', 'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount_cents', '2230', 'provider_payment_id', 'PAY-1')))));
  perform ps.ok(r -> 'results' -> 0 ->> 'error' = 'payment_duplicate', 'a provider payment already recorded on another sale: needs review');
  perform ps.ok((select count(*) from public.pos_sync_runs where integration_id = ps.id('I1') and status = 'partial') >= 1, 'each sync is in the history with its counts');
  -- an order voided at the provider
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('external_id', 'ORD-6', 'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', '2230')))));
  perform ps.ok(ps.oh('SJ', 'P1') = 12, 'ORD-6 sold 2 more');
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('external_id', 'ORD-6', 'version', '5', 'state', 'voided', 'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', '2230')))));
  perform ps.ok(r -> 'results' -> 0 ->> 'outcome' = 'updated' and ps.oh('SJ', 'P1') = 14 and (select status from public.pos_sales where external_id = 'ORD-6') = 'voided'
                and (select count(*) from public.journal_entries where source = 'pos_sale_void' and source_id = (select id from public.pos_sales where external_id = 'ORD-6')) = 1,
    'voided at the provider: compensating stock and a reversing entry');
  -- stock not available: kept as a sale, inventory blocked until an approver posts it
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('external_id', 'ORD-7', 'total_cents', '22300',
         'lines', jsonb_build_array(jsonb_build_object('external_line_id', 'L1', 'item_ref', 'SQ-ITEM-COFFEE', 'name', 'Café molido', 'qty', '20', 'unit_price_cents', '1000', 'tax_cents', '2300')),
         'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount_cents', '22300', 'provider_payment_id', 'PAY-7')))));
  insert into ps.ctx values ('X7', (r -> 'results' -> 0 ->> 'sale_id'));
  perform ps.ok((select inventory_status from public.pos_sales where id = ps.id('X7')) = 'blocked' and ps.oh('SJ', 'P1') = 14, 'an external sale beyond the stock is kept, its inventory blocked (no negative stock)');
  perform ps.ok(ps.err('member', format('select public.pos_sale_post_inventory(%L)', ps.id('X7'))) like '%FORBIDDEN%', 'members do not release blocked stock');
  perform ps.ok(ps.val('admin', format('select public.pos_sale_post_inventory(%L)::text', ps.id('X7')))::jsonb ->> 'error' = 'POS_STOCK_UNAVAILABLE', 'still not available: stays blocked');
  perform ps.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', ps.id('A'), ps.id('SJ'), 'adjustment_in',
                jsonb_build_array(jsonb_build_object('item', ps.id('P1'), 'qty', '10', 'unit_cost', '400')), 'Recepción sin orden', 'ps-adj-0001'));
  perform ps.ok(ps.val('admin', format('select public.pos_sale_post_inventory(%L)::text', ps.id('X7')))::jsonb ->> 'status' = 'posted' and ps.oh('SJ', 'P1') = 4,
    'after the adjustment the approver posts it: 20 leave');
  -- retry: an event that needed review is queued again and appears in the due list
  perform ps.ok(ps.err('admin', format('select public.pos_sync_retry(%L)', (select id from public.pos_sync_events where object_id = 'ORD-2' order by id desc limit 1))) = '', 'retry requested after fixing the mapping');
  perform ps.ok(ps.signed(null, array['pos_due', 'v1', 'k1', '{ts}', '{nonce}'], format('select public.pos_sync_due(%L, {ts}, {nonce}::uuid, {mac})::text', 'k1'))::jsonb @> '[{"object_id":"ORD-2"}]',
    'the recovery job sees the event to fetch again');
  perform ps.ok(ps.err('admin', format('select public.pos_item_map(%L, %L, %L, null)', ps.id('I1'), 'SQ-UNKNOWN', ps.id('P3'))) = '', 'the unknown product is mapped');
  r := ps.ingest('I1', jsonb_build_array(o || jsonb_build_object('external_id', 'ORD-2', 'event_id', (select id from public.pos_sync_events where object_id = 'ORD-2' order by id desc limit 1)::text,
          'lines', jsonb_build_array(jsonb_build_object('external_line_id', 'L1', 'item_ref', 'SQ-UNKNOWN', 'name', 'Pan', 'qty', '1', 'unit_price_cents', '2000', 'tax_cents', '230')),
          'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount_cents', '2230', 'provider_payment_id', 'PAY-2')))), 'recovery');
  perform ps.ok(r -> 'results' -> 0 ->> 'outcome' = 'created' and ps.oh('SJ', 'P3') = 47, 'the recovered order is applied');
  -- a nonce cannot be replayed
  perform ps.ok(ps.merr($q$ select ba_private.pos_verify('k1', 'x', ps.mac('x'), extract(epoch from now())::bigint, 'aaaaaaaa-0000-4000-8000-000000000001');
                           select ba_private.pos_verify('k1', 'x', ps.mac('x'), extract(epoch from now())::bigint, 'aaaaaaaa-0000-4000-8000-000000000001') $q$) like '%POS_SERVER_AUTH%',
    'a signature cannot be replayed (single-use nonce)');
end $$;

-- ------------------------------------------------------------- CSV of a traditional register
do $$
declare r jsonb; rows jsonb;
begin
  rows := jsonb_build_array(
    jsonb_build_object('external_id', 'Z-0001', 'occurred_at', now() - interval '2 hours', 'location_id', 'CAJA-VIEJA', 'lines',
      jsonb_build_array(jsonb_build_object('external_line_id', '1', 'sku', '4006381333931', 'name', 'Cafe', 'qty', '1', 'unit_price_cents', '1000', 'tax_cents', '115')),
      'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', '1115'))),
    jsonb_build_object('external_id', 'Z-0002', 'occurred_at', now() - interval '2 hours', 'location_id', 'CAJA-VIEJA', 'lines',
      jsonb_build_array(jsonb_build_object('external_line_id', '1', 'name', 'Departamento 3', 'qty', '1', 'unit_price_cents', '500', 'catalog_required', false)),
      'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', '500'))));
  r := ps.val('admin', format('select public.pos_import_sales(%L, null, %L, %L, %L)::text', ps.id('A'), 'cierre-z.csv', ps.sha('file-1'), rows))::jsonb;
  insert into ps.ctx values ('ICSV', r ->> 'integration');
  perform ps.ok(r -> 'counts' ->> 'needs_review' = '2', 'a CSV from a register whose location is not mapped: both rows wait for review');
  perform ps.ok(ps.err('admin', format('select public.pos_location_map(%L, %L, %L)', ps.id('ICSV'), 'CAJA-VIEJA', ps.id('PC'))) = '', 'the old register is mapped to Ponce');
  r := ps.val('admin', format('select public.pos_import_sales(%L, %L, %L, %L, %L)::text', ps.id('A'), ps.id('ICSV'), 'cierre-z.csv', ps.sha('file-1'), rows))::jsonb;
  perform ps.ok((r ->> 'already')::boolean, 'the same file again is recognised (no double import)');
  r := ps.val('admin', format('select public.pos_import_sales(%L, %L, %L, %L, %L)::text', ps.id('A'), ps.id('ICSV'), 'cierre-z-corregido.csv', ps.sha('file-2'), rows))::jsonb;
  perform ps.ok(r -> 'counts' ->> 'created' = '2' and (select inventory_status from public.pos_sales where external_id = 'Z-0001') = 'blocked' and ps.oh('PC', 'P1') = 0,
    'after mapping both sales are recorded (found by barcode); Ponce has no coffee, so Z-0001 waits with its inventory blocked (never negative)');
  perform ps.ok((select inventory_status from public.pos_sales where external_id = 'Z-0002') = 'not_required', 'a department sale without catalog product is accepted (no stock involved)');
  r := ps.val('admin', format('select public.pos_import_sales(%L, %L, %L, %L, %L)::text', ps.id('A'), ps.id('ICSV'), 'cierre-z-3.csv', ps.sha('file-3'), rows))::jsonb;
  perform ps.ok(r -> 'counts' ->> 'duplicate' = '2' and (select count(*) from public.pos_sales where integration_id = ps.id('ICSV')) = 2, 'another file with the same sales: duplicates, nothing new');
  perform ps.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', ps.id('A'), ps.id('PC'), 'opening',
                jsonb_build_array(jsonb_build_object('item', ps.id('P1'), 'qty', '5', 'unit_cost', '400')), 'Inicial Ponce', 'ps-open-pc01'));
  perform ps.ok(ps.val('admin', format('select public.pos_sale_post_inventory(%L)::text', (select id from public.pos_sales where external_id = 'Z-0001')))::jsonb ->> 'status' = 'posted'
                and ps.oh('PC', 'P1') = 4, 'with stock at Ponce the approver posts it: one leaves');
  perform ps.ok(ps.err('member', format('select public.pos_import_sales(%L, null, %L, %L, %L)', ps.id('A'), 'x.csv', ps.sha('file-9'), rows)) like '%FORBIDDEN%', 'members do not import');
end $$;

-- ------------------------------------------------------------- settlements and the bank
do $$
declare p text; r jsonb; acct uuid; ba uuid; line uuid;
begin
  p := jsonb_build_object('payout_id', 'PO-1', 'payout_date', public.ba_today()::text, 'gross_cents', '2230', 'fees_cents', '65', 'net_cents', '2165', 'status', 'paid',
                          'payment_ids', jsonb_build_array('PAY-1'))::text;
  r := ps.signed(null, array['pos_settle', 'v1', 'k1', ps.v('I1'), '{ts}', '{nonce}', ps.sha(p)],
                 format('select public.pos_settlement_record(%L, %L, %L, {ts}, {nonce}::uuid, {mac})::text', ps.id('I1'), p, 'k1'))::jsonb;
  insert into ps.ctx values ('ST1', r ->> 'settlement');
  perform ps.ok((r ->> 'payments_linked')::int = 1 and (select settlement_id from public.pos_payments where provider_payment_id = 'PAY-1') = ps.id('ST1')
                and exists (select 1 from public.pos_payment_events e join public.pos_payments p2 on p2.id = e.payment_id where p2.provider_payment_id = 'PAY-1' and e.kind = 'settled'),
    'the processor payout links its payment (sale → capture → settlement kept apart)');
  perform ps.ok(ps.err('admin', format('select public.bank_init(%L)', ps.id('A'))) = '', 'banking initialised');
  select id into acct from public.ledger_accounts where company_id = ps.id('A') and code = '1010';
  ba := ps.val('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', ps.id('A'), 'Operativa', 'Banco Popular', '4821', acct))::uuid;
  perform ps.val('admin', format('select (public.bank_import(%L, %L, %L, %L, %L)).imported::text', ba, 'estado.csv', ps.sha('bank-1'), '{}',
                jsonb_build_array(jsonb_build_object('date', public.ba_today()::text, 'description', 'SQUARE PAYOUT PO-1', 'amount_cents', '2165'))));
  select id into line from public.bank_lines where bank_account_id = ba;
  perform ps.ok(ps.err('member', format('select public.pos_settlement_reconcile(%L, %L)', ps.id('ST1'), line)) like '%FORBIDDEN%', 'members do not reconcile');
  r := ps.val('admin', format('select public.pos_settlement_reconcile(%L, %L)::text', ps.id('ST1'), line))::jsonb;
  perform ps.ok(r ->> 'entry' is not null and (select status from public.bank_lines where id = line) = 'matched' and ps.acct_bal(ps.id('A'), 'processor_fees') = 65
                and (select bank_line_id from public.pos_settlements where id = ps.id('ST1')) = line,
    'deposit reconciled: Dr bank 21.65 + fees 0.65, Cr POS funds to deposit 22.30; the bank line is matched');
  perform ps.ok((ps.val('admin', format('select public.pos_settlement_reconcile(%L, %L)::text', ps.id('ST1'), line))::jsonb ->> 'already')::boolean, 'reconciling again changes nothing');
end $$;

-- ------------------------------------------------------------- reports
do $$
declare r jsonb; expect_total bigint; expect_ref bigint;
begin
  r := ps.val('admin', format('select public.pos_report(%L, %L, %L)::text', ps.id('A'), public.ba_today() - 1, public.ba_today()))::jsonb;
  select sum(total_cents) into expect_total from public.pos_sales where company_id = ps.id('A') and status <> 'voided';
  select sum(amount_cents) into expect_ref from public.pos_refunds where company_id = ps.id('A');
  perform ps.ok((r -> 'totals' ->> 'total_cents')::bigint = expect_total and (r -> 'totals' ->> 'refunded_cents')::bigint = expect_ref
                and (r -> 'totals' ->> 'net_cents')::bigint = expect_total - expect_ref and (r -> 'totals' ->> 'voided')::int = 2,
    'report: confirmed sales only (two voids excluded), refunds subtracted');
  perform ps.ok(jsonb_array_length(r -> 'payment_methods') >= 4 and jsonb_array_length(r -> 'cash_differences') = 2 and (r -> 'sync' ->> 'needs_review')::int >= 1
                and jsonb_array_length(r -> 'taxes') >= 2 and (r -> 'top_products' -> 0 ->> 'name') is not null,
    'by method, taxes, top products, cash differences and pending sync items');
  perform ps.ok((select sum((d ->> 'total_cents')::bigint) from jsonb_array_elements(r -> 'daily') d) = expect_total, 'daily totals add up to the period total');
  r := ps.val('member2', format('select public.pos_report(%L, %L, %L)::text', ps.id('A'), public.ba_today() - 1, public.ba_today()))::jsonb;
  perform ps.ok((r -> 'totals' ->> 'total_cents')::bigint = (select coalesce(sum(total_cents), 0) from public.pos_sales where branch_id = ps.id('PC') and status <> 'voided'),
    'a Ponce member''s report covers Ponce only');
  perform ps.ok(ps.err('other', format('select public.pos_report(%L, %L, %L)', ps.id('A'), public.ba_today() - 1, public.ba_today())) like '%FORBIDDEN%', 'isolation: B cannot report on A');
end $$;

-- ------------------------------------------------------------- scope, isolation, consistency
do $$
begin
  perform ps.ok(ps.val('member2', format('select count(*) from public.pos_sales where company_id = %L and branch_id = %L', ps.id('A'), ps.id('SJ'))) = '0'
                and ps.val('member', format('select count(*) from public.pos_sales where company_id = %L and branch_id = %L', ps.id('A'), ps.id('SJ'))) <> '0', 'members see only their branch''s sales');
  perform ps.ok(ps.val('other', format('select count(*) from public.pos_sales where company_id = %L', ps.id('A'))) = '0'
                and ps.val('other', format('select count(*) from public.pos_payments p join public.pos_sales s on s.id = p.sale_id where s.company_id = %L', ps.id('A'))) = '0'
                and ps.val('other', format('select count(*) from public.pos_sync_events where company_id = %L', ps.id('A'))) = '0', 'isolation: another company sees nothing of A');
  perform ps.ok(ps.val('member', format('select count(*) from public.pos_integrations where company_id = %L', ps.id('A'))) = '0', 'members do not see integrations');
  perform ps.ok(ps.err('member', 'select count(*) from public.pos_approval_codes') like '%permission denied%', 'approval codes are not readable');
  perform ps.ok(ps.err(null, format('select public.pos_sale_create(%L, %L, %L)', ps.id('A'), '{}', 'anon-sale-01')) like '%permission denied%'
                or ps.err(null, format('select public.pos_sale_create(%L, %L, %L)', ps.id('A'), '{}', 'anon-sale-01')) like '%FORBIDDEN%', 'anonymous callers cannot sell');
  perform ps.ok((select count(*) from public.inventory_verify(ps.id('A'))) = 0, 'after everything the inventory caches still equal the ledger');
  perform ps.ok(ps.balanced(ps.id('A')), 'every journal entry balances');
  perform ps.ok((select count(*) from public.pos_sales s where s.company_id = ps.id('A') and s.total_cents > 0 and s.ledger_entry_id is null) = 0, 'every sale with an amount has its ledger entry');
  perform ps.ok((select count(*) from public.pos_events where company_id = ps.id('A')) > 20, 'every operation is in the audit trail');
end $$;

-- ------------------------------------------------------------- deleting a company removes its POS data
do $$
declare e text; r text;
begin
  r := ps.val('other', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, false, null)', ps.id('B'), 'X-1', 'Cosa', 'service', 'unidad', 100));
  r := ps.val('other', format('select public.pos_register_save(%L, null, %L, %L, %L)', ps.id('B'), ps.id('BB'), 'C1', 'Caja B'));
  perform ps.val('other', format('select public.pos_shift_open(%L, 0, %L)::text', r, 'ps-shift-b-01'));
  e := ps.merr(format('delete from public.companies where id = %L', ps.id('B')));
  perform ps.ok(e = '' and (select count(*) from public.pos_shifts where company_id = ps.id('B')) = 0, 'deleting company B cascades through its POS data');
  e := ps.merr(format('delete from public.companies where id = %L', ps.id('A')));
  perform ps.ok(e = '' and (select count(*) from public.pos_sales where company_id = ps.id('A')) = 0 and (select count(*) from public.pos_location_maps where company_id = ps.id('A')) = 0
                and (select count(*) from public.pos_settlements where company_id = ps.id('A')) = 0, 'deleting company A (sales, refunds, integrations, mappings, settlements, ledger) cascades too: ' || e);
end $$;

do $$
begin
  if exists (select 1 from ps.failures) then raise exception 'POS TESTS FAILED: %', (select string_agg(msg, '; ') from ps.failures); end if;
  raise notice 'ALL POS TESTS PASSED';
end $$;
