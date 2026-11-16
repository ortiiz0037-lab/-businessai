-- Inventory, barcodes, purchasing and replenishment (0043): codes and check digits, one code
-- per product, lookup, the movement ledger (no negative stock, idempotency, immutability,
-- compensating corrections), approvals, purchase orders with partial receipts and the vendor
-- bill, transfers (in transit until received, differences), counts, reservations, average and
-- FIFO cost, revaluation, replenishment data, issue from an invoice, branch scope, isolation.
-- TEST-ONLY, local throw-away database with 0014a … 0043. Schema iv.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema iv;
create table iv.ctx (key text primary key, val text not null);
create function iv.id(k text) returns uuid language sql stable as $$ select val::uuid from iv.ctx where key = k $$;
create table iv.failures (msg text);
create function iv.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into iv.failures values (msg); end if;
end $$;
grant usage on schema iv to authenticated;
grant select on iv.ctx to authenticated;
grant execute on all functions in schema iv to authenticated;
create function iv.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', iv.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function iv.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', iv.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function iv.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
-- plpgsql (not inlined): each call reads the stock after the statements before it
create function iv.oh(br text, item text, variant text default null) returns numeric language plpgsql volatile as $$
begin
  return public.inventory_on_hand(iv.id(br), iv.id(item), case when variant is null then null else iv.id(variant) end);
end $$;
create function iv.line(item text, qty numeric, variant text default null, cost numeric default null) returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('item', iv.id(item), 'variant', case when variant is null then null else iv.id(variant) end, 'qty', qty::text,
         'unit_cost', case when cost is null then null else cost::text end)) $$;
create function iv.lv(who text, br text, item text, col text) returns numeric language plpgsql volatile as $$
declare r numeric;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', iv.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute format('select %I from public.inventory_levels(%L, %L) where item_id = %L and variant_key = %L', col, iv.id('A'), iv.id(br), iv.id(item), '00000000-0000-0000-0000-000000000000') into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return coalesce(r, 0);
end $$;

insert into iv.ctx values
  ('owner', 'c1000000-0000-4000-8000-0000000000d1'), ('admin', 'c1000000-0000-4000-8000-0000000000d2'),
  ('member', 'c1000000-0000-4000-8000-0000000000d3'), ('other', 'c1000000-0000-4000-8000-0000000000d4'),
  ('A', 'c2000000-0000-4000-8000-0000000000d1'), ('B', 'c2000000-0000-4000-8000-0000000000d2'),
  ('SJ', 'c3000000-0000-4000-8000-0000000000d1'), ('PC', 'c3000000-0000-4000-8000-0000000000d2'), ('BB', 'c3000000-0000-4000-8000-0000000000d3'),
  ('v1', 'c4000000-0000-4000-8000-0000000000d1'), ('vB', 'c4000000-0000-4000-8000-0000000000d2'), ('c1', 'c5000000-0000-4000-8000-0000000000d1'),
  ('inv1', 'c6000000-0000-4000-8000-0000000000d1');
insert into auth.users (id, email) select val::uuid, key || '@iv.test' from iv.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (iv.id('A'), 'Tienda A', iv.id('owner')), (iv.id('B'), 'Tienda B', iv.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (iv.id('A'), 'cus_iv_a', 'sub_iv_a', 'pro', 'active'), (iv.id('B'), 'cus_iv_b', 'sub_iv_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (iv.id('A'), iv.id('owner'), 'owner'), (iv.id('A'), iv.id('admin'), 'admin'), (iv.id('A'), iv.id('member'), 'member'), (iv.id('B'), iv.id('other'), 'owner');
insert into public.branches (id, company_id, name, code) values (iv.id('SJ'), iv.id('A'), 'San Juan', 'SJU'), (iv.id('PC'), iv.id('A'), 'Ponce', 'PCE'), (iv.id('BB'), iv.id('B'), 'Bayamón', 'BAY');
-- the member works at San Juan only
insert into public.branch_members (company_id, branch_id, user_id) values (iv.id('A'), iv.id('SJ'), iv.id('member'));
insert into public.vendors (id, company_id, name) values (iv.id('v1'), iv.id('A'), 'Distribuidora Uno'), (iv.id('vB'), iv.id('B'), 'Proveedor B');
insert into public.clients (id, company_id, name) values (iv.id('c1'), iv.id('A'), 'Cliente Inventario');

-- ------------------------------------------------------------- codes and check digits
do $$
declare e text;
begin
  perform iv.ok(public.ba_gtin_valid('4006381333931') and not public.ba_gtin_valid('4006381333932'), 'EAN-13 check digit');
  perform iv.ok(public.ba_gtin_valid('036000291452') and public.ba_gtin_valid('96385074') and public.ba_gtin_valid('10012345678902'), 'UPC-A, EAN-8 and GTIN-14 check digits');
  perform iv.ok(public.ba_upce_valid('04252614') and not public.ba_upce_valid('04252615'), 'UPC-E expanded to UPC-A and checked');
  perform iv.ok(public.ba_barcode_valid('ABC-123', 'code39') and public.ba_barcode_valid('Lote 7/a', 'code128') and not public.ba_barcode_valid('abc', 'code39'), 'Code 39 / Code 128 character sets');
end $$;

-- ------------------------------------------------------------- catalog: products, variants, barcodes
do $$
declare e text; r text;
begin
  r := iv.val('admin', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, true, null)', iv.id('A'), 'P-001', 'Tornillo 1/4', 'product', 'unidad', 25));
  insert into iv.ctx values ('P1', r);
  r := iv.val('admin', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, true, null)', iv.id('A'), 'CAM-001', 'Camiseta', 'product', 'unidad', 1500));
  insert into iv.ctx values ('P2', r);
  r := iv.val('admin', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, false, null)', iv.id('A'), 'SRV-1', 'Instalación', 'service', 'hora', 5000));
  insert into iv.ctx values ('S1', r);
  r := iv.val('other', format('select id from public.catalog_save(%L, null, %L, %L, null, %L, %L, %s, null, true, null)', iv.id('B'), 'P-001', 'Tornillo de B', 'product', 'unidad', 30));
  insert into iv.ctx values ('PB', r);
  perform iv.ok(iv.id('P1') is not null and iv.id('P2') is not null and iv.id('PB') is not null, 'products in the catalog (the same code may exist in another company)');
  r := iv.err('admin', format('select public.catalog_set_cost(%L, null, 500, %L)', iv.id('P1'), 'Lista del proveedor'));
  perform iv.ok(r = ''
    and (select cost_cents from public.catalog_items where id = iv.id('P1')) = 500 and (select count(*) from public.inventory_cost_history where item_id = iv.id('P1') and source = 'manual') = 1,
    'acquisition cost with history');
  perform iv.ok(iv.err('member', format('select public.catalog_set_cost(%L, null, 1, null)', iv.id('P1'))) like '%CATALOG_NOT_FOUND%', 'members do not change costs');
  -- barcodes
  perform iv.ok(iv.err('admin', format('select public.catalog_barcode_add(%L, null, %L, %L, true)', iv.id('P1'), '4006381333931', 'ean13')) = '', 'an EAN-13 barcode for the product');
  perform iv.ok(iv.err('admin', format('select public.catalog_barcode_add(%L, null, %L, %L, false)', iv.id('P1'), '036000291452', 'upca')) = '', 'an alternative UPC-A code for the same product');
  perform iv.ok(iv.err('admin', format('select public.catalog_barcode_add(%L, null, %L, %L, false)', iv.id('P2'), '4006381333931', 'ean13')) like '%BARCODE_TAKEN%',
    'the same code cannot identify another product of the company');
  perform iv.ok(iv.err('admin', format('select public.catalog_barcode_add(%L, null, %L, %L, false)', iv.id('P2'), '4006381333932', 'ean13')) like '%BARCODE_INVALID%', 'a wrong check digit is refused');
  perform iv.ok(iv.err('admin', format('select public.catalog_barcode_add(%L, null, %L, %L, false)', iv.id('P2'), 'CAM-001', 'code128')) = '', 'a product may use its own code as barcode');
  perform iv.ok(iv.err('admin', format('select public.catalog_barcode_add(%L, null, %L, %L, false)', iv.id('P2'), 'P-001', 'code128')) like '%BARCODE_TAKEN%', 'not another product''s code');
  perform iv.ok(iv.err('member', format('select public.catalog_barcode_add(%L, null, %L, %L, false)', iv.id('P1'), '96385074', 'ean8')) like '%CATALOG_NOT_FOUND%', 'members do not manage barcodes');
  perform iv.ok(iv.err('other', format('select public.catalog_barcode_add(%L, null, %L, %L, false)', iv.id('PB'), '4006381333931', 'ean13')) = '', 'another company may use the same barcode for its own product');
  perform iv.ok(iv.err('admin', 'insert into public.catalog_barcodes (company_id, item_id, code, symbology) values (''' || iv.id('A') || ''', ''' || iv.id('P1') || ''', ''96385074'', ''ean8'')') like '%permission denied%',
    'barcodes are written only through the functions');
  -- variants
  r := iv.val('admin', format('select public.catalog_variant_save(%L, null, %L, %L, null, 900)', iv.id('P2'), 'CAM-001-R-M', '{"color":"Rojo","talla":"M"}'));
  insert into iv.ctx values ('V1', r);
  r := iv.val('admin', format('select public.catalog_variant_save(%L, null, %L, %L, 1600, 950)', iv.id('P2'), 'CAM-001-A-L', '{"color":"Azul","talla":"L"}'));
  insert into iv.ctx values ('V2', r);
  perform iv.ok(iv.id('V1') is not null and iv.id('V2') is not null, 'variants (color, size) with their own SKU, price and cost');
  perform iv.ok(iv.err('admin', format('select public.catalog_variant_save(%L, null, %L, %L, null, null)', iv.id('P2'), 'P-001', '{}')) like '%CATALOG_CODE_TAKEN%', 'a variant SKU cannot be another product''s code');
  perform iv.ok(iv.err('admin', format('select public.catalog_variant_save(%L, null, %L, %L, null, null)', iv.id('S1'), 'SRV-1-X', '{}')) like '%CATALOG_INVALID%', 'services have no variants');
  perform iv.ok(iv.err('admin', format('select * from public.catalog_save(%L, null, %L, %L, null, %L, %L, 1, null, true, null)', iv.id('A'), 'CAM-001-R-M', 'Choque', 'product', 'unidad')) like '%CATALOG_CODE_TAKEN%',
    'a new catalog code cannot reuse a variant SKU');
  perform iv.ok(iv.err('admin', format('select public.catalog_barcode_add(%L, %L, %L, %L, true)', iv.id('P2'), iv.id('V1'), '96385074', 'ean8')) = '', 'a barcode for one variant');
end $$;

-- ------------------------------------------------------------- lookup (scanner)
do $$
declare e text;
begin
  perform iv.ok(iv.val('member', format('select item_id || ''/'' || matched_by from public.inventory_lookup(%L, %L)', iv.id('A'), '4006381333931')) = iv.id('P1') || '/barcode', 'scan → the product, by barcode');
  perform iv.ok(iv.val('member', format('select coalesce(variant_id::text, ''-'') || ''/'' || matched_by from public.inventory_lookup(%L, %L)', iv.id('A'), '96385074')) = iv.id('V1') || '/barcode', 'scan → the variant');
  perform iv.ok(iv.val('member', format('select variant_id || ''/'' || matched_by from public.inventory_lookup(%L, %L)', iv.id('A'), 'cam-001-a-l')) = iv.id('V2') || '/sku', 'SKU, case-insensitive');
  perform iv.ok(iv.val('member', format('select item_id || ''/'' || matched_by from public.inventory_lookup(%L, %L)', iv.id('A'), ' P-001 ')) = iv.id('P1') || '/code', 'catalog code');
  perform iv.ok(iv.val('member', format('select count(*) from public.inventory_lookup(%L, %L)', iv.id('A'), '0000000000000')) = '0', 'an unknown code finds nothing');
  perform iv.ok(iv.val('other', format('select count(*) from public.inventory_lookup(%L, %L)', iv.id('A'), '036000291452')) = '0', 'isolation: another company does not find A''s codes');
end $$;

-- ------------------------------------------------------------- movements: opening, sales, protection, idempotency, immutability
do $$
declare e text; r text;
begin
  r := iv.val('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)::text', iv.id('A'), iv.id('SJ'), 'opening',
         jsonb_build_array(iv.line('P1', 10, null, 500)), 'Inventario inicial', 'open-sj-p1-0001'));
  perform iv.ok(r::jsonb ->> 'status' = 'approved' and iv.oh('SJ', 'P1') = 10, 'an approver records opening stock directly (10 at San Juan)');
  perform iv.ok(iv.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('A'), iv.id('SJ'), 'opening',
         jsonb_build_array(iv.line('P2', 5)), 'Inicial', 'open-sj-p2-0001')) like '%INVENTORY_VARIANT_REQUIRED%', 'a product with variants needs the variant');
  perform iv.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('A'), iv.id('SJ'), 'opening',
         jsonb_build_array(iv.line('P2', 6, 'V1', 900), iv.line('P2', 4, 'V2', 950)), 'Inicial', 'open-sj-p2-0002'));
  perform iv.ok(iv.oh('SJ', 'P2', 'V1') = 6 and iv.oh('SJ', 'P2', 'V2') = 4, 'stock per variant');
  perform iv.ok(iv.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('A'), iv.id('SJ'), 'opening',
         jsonb_build_array(iv.line('S1', 1)), 'x x x', 'open-sj-s1-0001')) like '%INVENTORY_ITEM_INVALID%', 'services hold no stock');
  -- sales by the member at their branch
  r := iv.val('member', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)::text', iv.id('A'), iv.id('SJ'), 'sale', jsonb_build_array(iv.line('P1', 3)), 'Venta mostrador', 'sale-0001'));
  perform iv.ok(r::jsonb ->> 'already' = 'false' and iv.oh('SJ', 'P1') = 7, 'a member records a sale at their branch (10 → 7)');
  r := iv.val('member', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)::text', iv.id('A'), iv.id('SJ'), 'sale', jsonb_build_array(iv.line('P1', 3)), 'Venta mostrador', 'sale-0001'));
  perform iv.ok(r::jsonb ->> 'already' = 'true' and iv.oh('SJ', 'P1') = 7, 'the same request repeated is applied once');
  perform iv.ok(iv.err('member', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)', iv.id('A'), iv.id('SJ'), 'sale', jsonb_build_array(iv.line('P1', 8)), 'x', 'sale-0002')) like '%INVENTORY_INSUFFICIENT%'
    and iv.oh('SJ', 'P1') = 7, 'never below zero');
  perform iv.ok(iv.err('member', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)', iv.id('A'), iv.id('PC'), 'sale', jsonb_build_array(iv.line('P1', 1)), 'x', 'sale-0003')) like '%BRANCH_FORBIDDEN%',
    'a member assigned to San Juan cannot move Ponce stock');
  perform iv.ok(iv.err('member', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)', iv.id('A'), iv.id('SJ'), 'adjustment_in', jsonb_build_array(iv.line('P1', 1)), 'x', 'sale-0004')) like '%INVENTORY_KIND_NOT_DIRECT%',
    'adjustments do not go through direct movements');
  perform iv.ok(iv.err('other', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)', iv.id('A'), iv.id('SJ'), 'sale', jsonb_build_array(iv.line('P1', 1)), 'x', 'sale-0005')) like '%FORBIDDEN%',
    'isolation: another company cannot move A''s stock');
  perform iv.ok(iv.err('admin', 'insert into public.inventory_movements (company_id, branch_id, item_id, kind, quantity) values (''' || iv.id('A') || ''', ''' || iv.id('SJ') || ''', ''' || iv.id('P1') || ''', ''adjustment_in'', 100)') like '%permission denied%',
    'movements are written only through the functions');
  perform iv.ok(iv.merr('update public.inventory_movements set quantity = 1') like '%INVENTORY_IMMUTABLE%' and iv.merr('delete from public.inventory_movements') like '%INVENTORY_IMMUTABLE%',
    'history is never edited or deleted');
  -- customer return
  perform iv.val('member', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)::text', iv.id('A'), iv.id('SJ'), 'customer_return', jsonb_build_array(iv.line('P1', 1)), 'Devolución cliente', 'ret-0001'));
  perform iv.ok(iv.oh('SJ', 'P1') = 8, 'a customer return enters stock (7 → 8)');
end $$;

-- ------------------------------------------------------------- adjustments with approval; corrections
do $$
declare e text; r text; aid uuid; mid bigint;
begin
  r := iv.val('member', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)::text', iv.id('A'), iv.id('SJ'), 'damaged', jsonb_build_array(iv.line('P1', 1)), 'Caja mojada', 'dmg-0001'));
  aid := (r::jsonb ->> 'id')::uuid;
  perform iv.ok(r::jsonb ->> 'status' = 'pending' and iv.oh('SJ', 'P1') = 8, 'a member''s damaged goods report waits for approval (stock unchanged)');
  perform iv.ok(iv.err('member', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('A'), iv.id('SJ'), 'lost', jsonb_build_array(iv.line('P1', 1)), 'x', 'lost-0001')) like '%REASON_REQUIRED%',
    'a reason is required');
  perform iv.ok(iv.err('member', format('select public.inventory_adjustment_decide(%L, true, null)', aid)) like '%FORBIDDEN%', 'members do not approve adjustments');
  perform iv.ok(iv.err('admin', format('select public.inventory_adjustment_decide(%L, false, null)', aid)) like '%REASON_REQUIRED%', 'rejecting needs a note');
  e := iv.err('admin', format('select public.inventory_adjustment_decide(%L, true, %L)', aid, 'Visto'));
  perform iv.ok(e = '' and iv.oh('SJ', 'P1') = 7
    and (select status || '/' || decided_by from public.inventory_adjustments where id = aid) = 'approved/' || iv.id('admin'), 'approved: the stock leaves (8 → 7), with who decided');
  perform iv.ok(iv.err('admin', format('select public.inventory_adjustment_decide(%L, true, null)', aid)) like '%INVENTORY_ALREADY_DECIDED%', 'decided once');
  -- correct the customer return (compensating movement)
  mid := (select id from public.inventory_movements where kind = 'customer_return' and item_id = iv.id('P1'));
  perform iv.ok(iv.err('member', format('select public.inventory_correct(%s, %L)', mid, 'Error de registro')) like '%FORBIDDEN%', 'members do not correct movements');
  e := iv.err('admin', format('select public.inventory_correct(%s, %L)', mid, 'Registrada por error'));
  perform iv.ok(e = '' and iv.oh('SJ', 'P1') = 6
    and (select count(*) from public.inventory_movements where corrects_id = mid and kind = 'correction' and quantity = -1) = 1, 'a correction is a new, compensating movement (7 → 6)');
  perform iv.ok(iv.err('admin', format('select public.inventory_correct(%s, %L)', mid, 'Otra vez')) like '%INVENTORY_ALREADY_CORRECTED%', 'a movement is corrected once');
end $$;

-- ------------------------------------------------------------- purchase orders, partial receipts, vendor bill
do $$
declare e text; r text; po uuid; l1 uuid; l2 uuid; bid uuid; po2 uuid;
begin
  po := iv.val('member', format('select public.purchase_order_save(%L, null, %L, %L, current_date + 5, %L, %L, null)', iv.id('A'), iv.id('v1'), iv.id('SJ'), 'Pedido semanal',
          jsonb_build_array(jsonb_build_object('item', iv.id('P1'), 'qty', '5', 'unit_cost', '600'), jsonb_build_object('item', iv.id('P2'), 'variant', iv.id('V2'), 'qty', '4', 'unit_cost', '950'))))::uuid;
  insert into iv.ctx values ('PO1', po);
  perform iv.ok((select number || '/' || status from public.purchase_orders where id = po) = 'OC-000001/draft', 'a member drafts a purchase order (OC-000001)');
  perform iv.ok(iv.err('member', format('select public.purchase_order_save(%L, null, %L, %L, null, null, %L, null)', iv.id('A'), iv.id('v1'), iv.id('SJ'),
          jsonb_build_array(jsonb_build_object('item', iv.id('P2'), 'qty', '1', 'unit_cost', '1')))) like '%INVENTORY_VARIANT_REQUIRED%', 'a purchase line of a product with variants names the variant');
  perform iv.ok(iv.err('member', format('select public.purchase_order_receive(%L, %L, null, %L)', po, '[]', 'rcv-0000-x')) like '%PO_NOT_RECEIVABLE%', 'a draft cannot be received');
  perform iv.ok(iv.val('member', format('select public.purchase_order_transition(%L, %L)', po, 'submit')) = 'pending_approval', 'submitted for approval');
  perform iv.ok(iv.err('member', format('select public.purchase_order_transition(%L, %L)', po, 'approve')) like '%FORBIDDEN%', 'members do not approve purchase orders');
  perform iv.ok(iv.val('admin', format('select public.purchase_order_transition(%L, %L)', po, 'approve')) = 'approved', 'the admin approves it (issued)');
  perform iv.ok(iv.lv('admin', 'SJ', 'P1', 'on_order') = 5, 'on order: 5');
  select id into l1 from public.purchase_order_lines where po_id = po and line_no = 1;
  select id into l2 from public.purchase_order_lines where po_id = po and line_no = 2;
  -- first delivery: 2 good + 1 damaged of P1
  r := iv.val('member', format('select public.purchase_order_receive(%L, %L, %L, %L)::text', po, jsonb_build_array(jsonb_build_object('po_line', l1, 'qty', '2', 'damaged', '1', 'note', 'Caja rota')), 'Primera entrega', 'rcv-0001-a'));
  perform iv.ok(r::jsonb ->> 'status' = 'partially_received' and iv.oh('SJ', 'P1') = 8, 'partial receipt: 2 good enter stock (6 → 8), the damaged one is recorded, not stocked');
  perform iv.ok(iv.val('member', format('select public.purchase_order_receive(%L, %L, null, %L)::text', po, jsonb_build_array(jsonb_build_object('po_line', l1, 'qty', '2')), 'rcv-0001-a'))::jsonb ->> 'already' = 'true'
    and iv.oh('SJ', 'P1') = 8, 'the same receipt submitted twice counts once');
  perform iv.ok(iv.err('member', format('select public.purchase_order_receive(%L, %L, null, %L)', po, jsonb_build_array(jsonb_build_object('po_line', l1, 'qty', '3')), 'rcv-0002-a')) like '%PO_OVER_RECEIPT%',
    'never more than ordered (5 ordered, 3 accounted for, 3 more refused)');
  perform iv.ok((select round(avg_cost_cents, 2) from public.inventory_stock where branch_id = iv.id('SJ') and item_id = iv.id('P1')) = 525.00,
    'weighted average cost: (6 × 500 + 2 × 600) / 8 = 525');
  r := iv.val('member', format('select public.purchase_order_receive(%L, %L, null, %L)::text', po, jsonb_build_array(jsonb_build_object('po_line', l1, 'qty', '2'), jsonb_build_object('po_line', l2, 'qty', '4')), 'rcv-0003-a'));
  perform iv.ok(r::jsonb ->> 'status' = 'received' and iv.oh('SJ', 'P1') = 10 and iv.oh('SJ', 'P2', 'V2') = 8 and iv.lv('admin', 'SJ', 'P1', 'on_order') = 0,
    'second delivery completes the order; nothing left on order');
  perform iv.ok((select count(*) from public.inventory_receipts where po_id = po) = 2 and (select count(*) from public.inventory_cost_history where source = 'receipt' and item_id = iv.id('P1')) = 2,
    'two receipts and their cost history');
  -- the vendor bill of Payables (linked, not created)
  perform public.payables_init(iv.id('A')) from (select set_config('request.jwt.claims', json_build_object('sub', iv.id('owner'), 'role', 'authenticated')::text, true)) x;
  perform set_config('request.jwt.claims', '', true);
  bid := iv.val('admin', format('select public.bill_save_draft(%L, null, %L, %L, current_date, null, %L, null, %L, %L)', iv.id('A'), iv.id('v1'), 'F-77', 'Mercancía OC-000001',
          jsonb_build_array(jsonb_build_object('category_id', (select id from public.expense_categories where company_id = iv.id('A') order by name limit 1), 'amount_cents', '4000', 'description', 'Mercancía')), 'bill-po-0001'))::uuid;
  perform iv.ok(iv.err('member', format('select public.purchase_order_link_bill(%L, %L)', po, bid)) like '%FORBIDDEN%', 'members do not link bills');
  e := iv.err('admin', format('select public.purchase_order_link_bill(%L, %L)', po, bid));
  perform iv.ok(e = '' and (select count(*) from public.bills where company_id = iv.id('A')) = 1,
    'the vendor bill is linked to the order (no bill or payment created)');
  po2 := iv.val('admin', format('select public.purchase_order_save(%L, null, %L, %L, null, null, %L, null)', iv.id('A'), iv.id('v1'), iv.id('SJ'), jsonb_build_array(jsonb_build_object('item', iv.id('P1'), 'qty', '1', 'unit_cost', '600'))))::uuid;
  perform iv.ok(iv.err('admin', format('select public.purchase_order_link_bill(%L, %L)', po2, bid)) like '%PO_BILL_ALREADY_LINKED%', 'one bill, one order: no duplicated expense');
  perform iv.ok(iv.err('admin', format('select public.purchase_order_transition(%L, %L)', po, 'cancel')) like '%PO_TRANSITION_INVALID%', 'a received order cannot be cancelled');
  perform iv.ok(iv.val('admin', format('select public.purchase_order_transition(%L, %L, %L)', po2, 'cancel', 'Ya no')) = 'cancelled', 'an order without receipts can be cancelled');
end $$;

-- ------------------------------------------------------------- transfers: in transit until received
do $$
declare e text; t uuid; tl uuid;
begin
  t := iv.val('member', format('select public.inventory_transfer_request(%L, %L, %L, %L, %L, %L)', iv.id('A'), iv.id('SJ'), iv.id('PC'), jsonb_build_array(iv.line('P1', 3)), 'Reponer Ponce', 'tr-req-0001'))::uuid;
  perform iv.ok((select status || '/' || number from public.inventory_transfers where id = t) = 'requested/TR-000001', 'a member requests a transfer San Juan → Ponce');
  perform iv.ok(iv.val('member', format('select public.inventory_transfer_request(%L, %L, %L, %L, null, %L)', iv.id('A'), iv.id('SJ'), iv.id('PC'), jsonb_build_array(iv.line('P1', 3)), 'tr-req-0001'))::uuid = t,
    'a repeated request is the same transfer');
  perform iv.ok(iv.err('member', format('select public.inventory_transfer_step(%L, %L)', t, 'approve')) like '%FORBIDDEN%', 'members do not approve transfers');
  perform iv.ok(iv.err('member', format('select public.inventory_transfer_step(%L, %L)', t, 'dispatch')) like '%TRANSFER_TRANSITION_INVALID%', 'not dispatched before approval');
  perform iv.ok(iv.val('admin', format('select public.inventory_transfer_step(%L, %L)', t, 'approve')) = 'approved' and iv.lv('admin', 'SJ', 'P1', 'committed') = 3
    and iv.lv('admin', 'SJ', 'P1', 'available') = 7, 'approved: 3 committed at San Juan, 7 available');
  select id into tl from public.inventory_transfer_lines where transfer_id = t;
  perform iv.ok(iv.val('member', format('select public.inventory_transfer_step(%L, %L, %L)', t, 'prepare', jsonb_build_array(jsonb_build_object('line', tl, 'qty', '3')))) = 'prepared', 'prepared (picked) at the origin');
  perform iv.ok(iv.val('member', format('select public.inventory_transfer_step(%L, %L)', t, 'dispatch')) = 'in_transit' and iv.oh('SJ', 'P1') = 7 and iv.oh('PC', 'P1') = 0
    and iv.lv('admin', 'PC', 'P1', 'in_transit') = 3, 'dispatched: out of San Juan (10 → 7), in transit to Ponce, NOT in Ponce stock yet');
  perform iv.ok(iv.err('member', format('select public.inventory_transfer_step(%L, %L)', t, 'receive')) like '%BRANCH_FORBIDDEN%', 'a San Juan member cannot receive at Ponce');
  perform iv.ok(iv.err('admin', format('select public.inventory_transfer_step(%L, %L, %L)', t, 'receive', jsonb_build_array(jsonb_build_object('line', tl, 'qty', '2')))) like '%TRANSFER_DIFFERENCE_NOTE_REQUIRED%',
    'a difference needs a note');
  perform iv.ok(iv.err('admin', format('select public.inventory_transfer_step(%L, %L, %L)', t, 'receive', jsonb_build_array(jsonb_build_object('line', tl, 'qty', '4')))) like '%TRANSFER_OVER_RECEIPT%',
    'never more than dispatched');
  perform iv.ok(iv.val('admin', format('select public.inventory_transfer_step(%L, %L, %L, %L)', t, 'receive', jsonb_build_array(jsonb_build_object('line', tl, 'qty', '2', 'damaged', '1')), '1 llegó roto')) = 'received'
    and iv.oh('PC', 'P1') = 2 and iv.lv('admin', 'PC', 'P1', 'in_transit') = 0, 'received with a difference: 2 enter Ponce, 1 damaged recorded with its note');
  perform iv.ok((select dispatched_by || '/' || received_by from public.inventory_transfers where id = t) = iv.id('member') || '/' || iv.id('admin'), 'who dispatched and who received');
  perform iv.ok((select unit_cost_cents from public.inventory_movements where kind = 'transfer_in' and source_id = t) = (select unit_cost_cents from public.inventory_movements where kind = 'transfer_out' and source_id = t),
    'the goods travel at their cost');
end $$;

-- ------------------------------------------------------------- physical count (partial and by scanning)
do $$
declare e text; c uuid;
begin
  c := iv.val('member', format('select public.inventory_count_start(%L, %L, null, %L, %L)', iv.id('A'), iv.id('SJ'), 'partial', 'Pasillo 3'))::uuid;
  perform iv.val('member', format('select public.inventory_count_record(%L, %L, null, 5, %L)', c, iv.id('P1'), 'set'));
  perform iv.val('member', format('select public.inventory_count_record(%L, %L, %L, 1, %L)', c, iv.id('P2'), iv.id('V1'), 'add'));
  perform iv.val('member', format('select public.inventory_count_record(%L, %L, %L, 1, %L)', c, iv.id('P2'), iv.id('V1'), 'add'));
  perform iv.ok((select counted_qty || '/' || scans from public.inventory_count_lines where count_id = c and item_id = iv.id('P2')) = '2.000/2', 'scanning adds one per scan');
  perform iv.ok(iv.err('member', format('select public.inventory_count_record(%L, %L, null, 1, %L)', c, iv.id('P2'), 'add')) like '%INVENTORY_VARIANT_REQUIRED%', 'counting a product with variants needs the variant');
  e := iv.val('member', format('select public.inventory_count_step(%L, %L)', c, 'submit'));
  perform iv.ok(e = 'submitted'
    and (select difference_qty from public.inventory_count_lines where count_id = c and item_id = iv.id('P1')) = -2, 'submitted: P1 counted 5 against 7 (difference −2)');
  perform iv.ok(iv.oh('SJ', 'P1') = 7, 'nothing changes before approval');
  perform iv.ok(iv.err('member', format('select public.inventory_count_step(%L, %L)', c, 'approve')) like '%FORBIDDEN%', 'members do not approve counts');
  -- a sale between submission and approval is respected
  perform iv.val('member', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)::text', iv.id('A'), iv.id('SJ'), 'sale', jsonb_build_array(iv.line('P1', 1)), 'Venta', 'sale-0010'));
  perform iv.ok(iv.val('admin', format('select public.inventory_count_step(%L, %L)', c, 'approve')) = 'approved' and iv.oh('SJ', 'P1') = 5 and iv.oh('SJ', 'P2', 'V1') = 2,
    'approved: stock equals what was counted (P1 5, red M 2)');
  perform iv.ok((select count(*) from public.inventory_movements where kind = 'count' and source_id = c) = 2, 'one count movement per difference, with its count as source');
  perform iv.ok(iv.err('admin', format('select public.inventory_count_step(%L, %L)', c, 'approve')) like '%COUNT_NOT_SUBMITTED%', 'approved once');
end $$;

-- ------------------------------------------------------------- reservations, negative stock setting, revaluation, FIFO
do $$
declare e text; rid uuid; fifo_before bigint;
begin
  perform iv.ok(iv.err('member', format('select public.inventory_reserve(%L, %L, %L, null, 9, %L, %L, null, %L)', iv.id('A'), iv.id('SJ'), iv.id('P1'), 'reserved', 'Pedido', 'res-0001')) like '%INVENTORY_INSUFFICIENT%',
    'a reservation cannot exceed what is available');
  rid := iv.val('member', format('select public.inventory_reserve(%L, %L, %L, null, 2, %L, %L, null, %L)', iv.id('A'), iv.id('SJ'), iv.id('P1'), 'reserved', 'Pedido web', 'res-0002'))::uuid;
  perform iv.ok(iv.lv('admin', 'SJ', 'P1', 'reserved') = 2 and iv.lv('admin', 'SJ', 'P1', 'available') = 3 and iv.oh('SJ', 'P1') = 5, 'reserved 2: available 3, on hand still 5');
  perform iv.err('member', format('select public.inventory_release(%L)', rid));
  perform iv.ok(iv.lv('admin', 'SJ', 'P1', 'available') = 5, 'released');
  perform iv.ok(iv.err('member', format('select public.inventory_settings_save(%L, true, %L)', iv.id('A'), 'fifo')) like '%FORBIDDEN%', 'members do not configure inventory');
  perform iv.ok(iv.err('admin', format('select public.inventory_settings_save(%L, false, %L)', iv.id('A'), 'fifo')) = '', 'the admin chooses FIFO for reports');
  -- FIFO layers: P1 at SJ had 10 @500, +2 @600, +2 @600 and outflows; remaining layers equal stock
  perform iv.ok((select count(*) from public.inventory_verify(iv.id('A'))) = 0, 'caches and FIFO layers equal the ledger');
  fifo_before := (select sum(qty_remaining * unit_cost_cents) from public.inventory_cost_layers where branch_id = iv.id('SJ') and item_id = iv.id('P1'));
  -- exact FIFO vs average on a clean product: 5 @ 1.00 then 5 @ 2.00, sell 6
  perform iv.ok(iv.err('admin', format('select * from public.catalog_save(%L, null, %L, %L, null, %L, %L, 300, null, true, null)', iv.id('A'), 'FIFO-1', 'Pintura', 'product', 'galón')) = '', 'a product for the FIFO check');
  insert into iv.ctx select 'P4', id::text from public.catalog_items where code = 'FIFO-1';
  perform iv.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('A'), iv.id('PC'), 'adjustment_in', jsonb_build_array(iv.line('P4', 5, null, 100)), 'Lote 1', 'fifo-lot-0001'));
  perform iv.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('A'), iv.id('PC'), 'adjustment_in', jsonb_build_array(iv.line('P4', 5, null, 200)), 'Lote 2', 'fifo-lot-0002'));
  perform iv.err('admin', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)', iv.id('A'), iv.id('PC'), 'sale', jsonb_build_array(iv.line('P4', 6)), 'Venta', 'fifo-sale-0001'));
  perform iv.ok((select fifo_cost_cents || '/' || avg_cost_cents from public.inventory_movements where idem_key = 'mv:fifo-sale-0001:1') = '-700/-' || round(6 * (select unit_cost_cents from public.inventory_movements where idem_key = 'mv:fifo-sale-0001:1'))::text,
    'a sale of 6 costs 7.00 under FIFO (5 × 1.00 + 1 × 2.00) and its average cost under the average method');
  perform iv.ok((select sum(qty_remaining)::numeric(14,3) || '/' || sum(qty_remaining * unit_cost_cents)::numeric(16,2) from public.inventory_cost_layers where item_id = iv.id('P4') and qty_remaining > 0)
    = '4.000/800.00', 'remaining FIFO layers: 4 of the second lot at 2.00');
  perform iv.ok((select round(avg_cost_cents) from public.inventory_stock where item_id = iv.id('P4')) = 150, 'average cost stays 1.50 after the sale');
  perform iv.ok(iv.err('member', format('select public.inventory_revalue(%L, %L, %L, null, 700, %L)', iv.id('A'), iv.id('SJ'), iv.id('P1'), 'Nuevo costo')) like '%FORBIDDEN%', 'members do not revalue');
  e := iv.err('admin', format('select public.inventory_revalue(%L, %L, %L, null, 700, %L)', iv.id('A'), iv.id('SJ'), iv.id('P1'), 'Ajuste de costo del proveedor'));
  perform iv.ok(e = ''
    and (select avg_cost_cents from public.inventory_stock where branch_id = iv.id('SJ') and item_id = iv.id('P1')) = 700
    and (select bool_and(unit_cost_cents = 700) from public.inventory_cost_layers where branch_id = iv.id('SJ') and item_id = iv.id('P1') and qty_remaining > 0)
    and (select count(*) from public.inventory_cost_history where source = 'revaluation') = 1 and iv.oh('SJ', 'P1') = 5, 'revaluation: new cost for average and layers, quantity unchanged, history kept');
  perform iv.ok(iv.val('member', format('select count(*) from public.inventory_cost_layers where company_id = %L', iv.id('A'))) = '0'
    and iv.val('member', format('select count(*) from public.inventory_levels(%L, null) where avg_cost_cents is not null', iv.id('A'))) = '0', 'costs are hidden from members (quantities only)');
  -- negative stock only when the company allows it
  perform iv.err('admin', format('select public.inventory_settings_save(%L, true, %L)', iv.id('A'), 'average'));
  perform iv.ok(iv.err('admin', format('select public.inventory_move(%L, %L, null, %L, %L, %L, null, %L)', iv.id('A'), iv.id('SJ'), 'sale', jsonb_build_array(iv.line('P1', 6)), 'Venta', 'sale-neg-01')) = ''
    and iv.oh('SJ', 'P1') = -1, 'with negative stock explicitly allowed, a sale may exceed stock (−1)');
  perform iv.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('A'), iv.id('SJ'), 'adjustment_in', jsonb_build_array(iv.line('P1', 1)), 'Cuadre', 'adj-in-0001'));
  perform iv.err('admin', format('select public.inventory_settings_save(%L, false, %L)', iv.id('A'), 'average'));
end $$;

-- ------------------------------------------------------------- issue an invoice; replenishment data; drafts from suggestions
do $$
declare e text; r text; ids jsonb;
begin
  perform iv.err('admin', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('A'), iv.id('SJ'), 'adjustment_in', jsonb_build_array(iv.line('P1', 4, null, 700)), 'Llegada', 'adj-in-0002'));
  perform iv.ok(iv.err('member', format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, total, issue_date, due_date, items)
    values (%L, %L, %L, %L, %L, %L, %L, 50, 50, current_date, current_date + 30, %L)', iv.id('inv1'), iv.id('A'), iv.id('c1'), iv.id('member'), 'invoice', 'x', 'sent',
    jsonb_build_array(jsonb_build_object('description', 'Tornillo', 'quantity', 2, 'unit_price', 25, 'amount', 50, 'catalog_item_id', iv.id('P1'), 'code', 'P-001'),
                      jsonb_build_object('description', 'Instalación', 'quantity', 1, 'unit_price', 0, 'amount', 0, 'catalog_item_id', iv.id('S1'))))) = '', 'an invoice with a tracked product and a service');
  r := iv.val('member', format('select public.inventory_issue_document(%L, %L, %L)::text', iv.id('A'), iv.id('SJ'), iv.id('inv1')));
  perform iv.ok(r::jsonb ->> 'lines' = '1' and iv.oh('SJ', 'P1') = 2, 'the invoice''s tracked lines leave stock (4 → 2); the service is ignored');
  perform iv.ok(iv.err('member', format('select public.inventory_issue_document(%L, %L, %L)', iv.id('A'), iv.id('SJ'), iv.id('inv1'))) like '%INVENTORY_DOCUMENT_ALREADY_ISSUED%', 'once per invoice');
  -- settings and replenishment data
  perform iv.ok(iv.err('member', format('select public.inventory_item_settings_save(%L, %L, %L, null, 2, 20, 5, 10, %L, 7)', iv.id('A'), iv.id('SJ'), iv.id('P1'), iv.id('v1'))) like '%FORBIDDEN%',
    'members do not set reorder rules');
  perform iv.ok(iv.err('admin', format('select public.inventory_item_settings_save(%L, %L, %L, null, 2, 20, 5, 10, %L, 7)', iv.id('A'), iv.id('SJ'), iv.id('P1'), iv.id('v1'))) = '', 'reorder rules: min 2, max 20, reorder at 5, lead time 7 days');
  perform iv.ok(iv.err('admin', format('select public.inventory_item_settings_save(%L, %L, %L, null, 2, 3, 5, null, null, null)', iv.id('A'), iv.id('SJ'), iv.id('P1'))) like '%check%', 'max below the reorder point is refused');
  r := iv.val('admin', format('select row_to_json(x)::text from public.inventory_replenishment_data(%L, %L) x where item_id = %L', iv.id('A'), iv.id('SJ'), iv.id('P1')));
  perform iv.ok((r::json ->> 'available')::numeric = 2 and (r::json ->> 'reorder_point')::numeric = 5 and (r::json ->> 'sold_90d')::numeric > 0 and (r::json ->> 'lead_time_days')::int = 7
    and r::json ->> 'preferred_vendor_id' = iv.id('v1')::text, 'replenishment data: available, rule, recorded sales and lead time');
  perform iv.ok(iv.val('admin', format('select coalesce(sold_90d::text, ''null'') from public.inventory_replenishment_data(%L, %L) where item_id = %L', iv.id('A'), iv.id('PC'), iv.id('P1'))) = 'null',
    'no recorded sales → no velocity (nothing invented)');
  ids := iv.val('member', format('select public.purchase_orders_from_suggestions(%L, %L)::text', iv.id('A'),
           jsonb_build_array(jsonb_build_object('vendor', iv.id('v1'), 'branch', iv.id('SJ'), 'item', iv.id('P1'), 'qty', '18', 'unit_cost', '700'))))::jsonb;
  perform iv.ok(jsonb_array_length(ids) = 1 and (select status || '/' || source from public.purchase_orders where id = (ids ->> 0)::uuid) = 'draft/replenishment',
    'suggestions become a draft purchase order per vendor (approval still required)');
end $$;

-- ------------------------------------------------------------- branch scope and isolation
do $$
declare e text;
begin
  perform iv.ok(iv.val('member', format('select count(*) from public.inventory_stock where company_id = %L and branch_id = %L', iv.id('A'), iv.id('PC'))) = '0'
    and iv.val('member', format('select count(*) from public.inventory_stock where company_id = %L and branch_id = %L', iv.id('A'), iv.id('SJ'))) <> '0', 'a member sees only their branch''s stock');
  perform iv.ok(iv.val('admin', format('select count(distinct branch_id) from public.inventory_stock where company_id = %L', iv.id('A'))) = '2', 'the admin sees every branch');
  perform iv.ok(iv.val('other', format('select count(*) from public.inventory_movements where company_id = %L', iv.id('A'))) = '0'
    and iv.val('other', format('select count(*) from public.purchase_orders where company_id = %L', iv.id('A'))) = '0'
    and iv.val('other', format('select count(*) from public.inventory_levels(%L, null)', iv.id('A'))) = '0', 'isolation: another company sees nothing of A');
  perform iv.ok(iv.err('other', format('select public.purchase_order_transition(%L, %L)', iv.id('PO1'), 'close')) like '%FORBIDDEN%', 'nor acts on its orders');
  perform iv.ok((select count(*) from public.inventory_events where company_id = iv.id('A')) > 15, 'every operation is in the audit trail');
  perform iv.ok((select count(*) from public.inventory_verify(iv.id('A'))) = 0, 'after everything, the caches still equal the ledger');
end $$;

-- ------------------------------------------------------------- deleting a company removes its inventory
do $$
declare e text;
begin
  perform iv.err('other', format('select public.inventory_adjust(%L, %L, null, %L, %L, %L, null, null, %L)', iv.id('B'), iv.id('BB'), 'opening', jsonb_build_array(iv.line('PB', 3, null, 100)), 'Inicial B', 'open-b-0001'));
  perform iv.ok(public.inventory_on_hand(iv.id('BB'), iv.id('PB'), null) = 3, 'company B has stock');
  e := iv.merr(format('delete from public.companies where id = %L', iv.id('B')));
  perform iv.ok(e = '' and (select count(*) from public.inventory_movements where company_id = iv.id('B')) = 0,
    'deleting company B cascades through its inventory');
end $$;

do $$
declare e text;
begin
  if exists (select 1 from iv.failures) then raise exception 'INVENTORY TESTS FAILED: %', (select string_agg(msg, '; ') from iv.failures); end if;
  raise notice 'ALL INVENTORY TESTS PASSED';
end $$;
