-- Document Studio (0028). TEST-ONLY, local throw-away database with every
-- migration up to 0028. Schema st.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema st;
create table st.ctx (key text primary key, val text not null);
create function st.id(k text) returns uuid language sql stable as $$ select val::uuid from st.ctx where key = k $$;
create table st.failures (msg text);
create function st.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into st.failures values (msg); end if;
end $$;
create function st.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', st.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function st.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', st.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function st.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
-- a minimal valid block document
create function st.content(txt text default 'Hola {{client.name}}') returns jsonb language sql immutable as $$
  select jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'heading', 'level', 1, 'text', 'Título'), jsonb_build_object('type', 'paragraph', 'text', txt)))
$$;
-- save as `who`: returns 'id|version' or the error
create function st.save(who text, co text, doc uuid, kind text, title text, content jsonb, client text default null, src text default null, emp text default null,
                        vend text default null, expected int default null) returns text language plpgsql as $$
declare r text;
begin
  begin
    r := st.val(who, format('select id || ''|'' || version from public.studio_save_document(%L, %L, %L, %L, null, %L, %L, %L, %L, %L, %L, null, null, %L)',
      st.id(co), doc, kind, title, content, '{}', st.id(client), st.id(src), st.id(emp), st.id(vend), expected));
  exception when others then r := sqlerrm; end;
  return r;
end $$;
grant usage on schema st to authenticated;
grant select on st.ctx to authenticated;
grant execute on all functions in schema st to authenticated;

insert into st.ctx values
  ('owner', 'c7000000-0000-4000-8000-000000000001'), ('admin', 'c7000000-0000-4000-8000-000000000002'),
  ('member', 'c7000000-0000-4000-8000-000000000003'), ('other', 'c7000000-0000-4000-8000-000000000004'),
  ('A', 'c8000000-0000-4000-8000-000000000001'), ('B', 'c8000000-0000-4000-8000-000000000002'),
  ('cl', 'c9000000-0000-4000-8000-000000000001'), ('clB', 'c9000000-0000-4000-8000-000000000002'),
  ('inv', 'ca000000-0000-4000-8000-000000000001'), ('quo', 'ca000000-0000-4000-8000-000000000002'), ('draftinv', 'ca000000-0000-4000-8000-000000000003'),
  ('emp', 'cb000000-0000-4000-8000-000000000001'), ('ven', 'cc000000-0000-4000-8000-000000000001');
insert into auth.users (id, email) select val::uuid, key || '@st.test' from st.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (st.id('A'), 'Estudio A', st.id('owner')), (st.id('B'), 'Estudio B', st.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (st.id('A'), 'cus_st_a', 'sub_st_a', 'pro', 'active'), (st.id('B'), 'cus_st_b', 'sub_st_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (st.id('A'), st.id('owner'), 'owner'), (st.id('A'), st.id('admin'), 'admin'), (st.id('A'), st.id('member'), 'member'), (st.id('B'), st.id('other'), 'owner');
insert into public.company_profiles (company_id, legal_name, email, address) values (st.id('A'), 'Estudio A LLC', 'hola@a.test', 'Calle 1');
insert into public.clients (id, company_id, name, email) values (st.id('cl'), st.id('A'), 'Cliente Estudio', 'c@a.test'), (st.id('clB'), st.id('B'), 'Cliente B', 'b@b.test');
insert into public.employees (id, company_id, first_name, last_name, position, hire_date) values (st.id('emp'), st.id('A'), 'Ana', 'Rivera', 'Contadora', '2024-03-01');
insert into public.vendors (id, company_id, name, tax_id) values (st.id('ven'), st.id('A'), 'Proveedor Estudio', '66-0000001');
select st.err('owner', format($q$insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date, items, metadata)
  values (%L, %L, %L, %L, 'invoice', 'x', 'sent', 300, 30, 330, public.ba_today(), public.ba_today() + 30, %L, '{"tax_rate":10}'),
         (%L, %L, %L, %L, 'quote', 'x', 'draft', 50, 0, 50, public.ba_today(), null, '[]', '{}'),
         (%L, %L, %L, %L, 'invoice', 'x', 'draft', 10, 0, 10, public.ba_today(), null, '[]', '{}')$q$,
  st.id('inv'), st.id('A'), st.id('cl'), st.id('owner'), '[{"description":"Diseño","quantity":2,"unit_price":100,"amount":200},{"description":"Hosting","quantity":1,"unit_price":100,"amount":100}]',
  st.id('quo'), st.id('A'), st.id('cl'), st.id('owner'), st.id('draftinv'), st.id('A'), st.id('cl'), st.id('owner')));
select st.err('owner', format('insert into public.payments (company_id, document_id, amount, created_by) values (%L, %L, 120, %L)', st.id('A'), st.id('inv'), st.id('owner')));

-- ------------------------------------------------------------- content and permissions
do $$ declare r text; d uuid; begin
  perform st.ok((select document_number from public.documents where id = st.id('inv')) <> 'x', 'setup: the invoice got its own number');
  perform st.ok(public.studio_valid_content(st.content()), 'a heading + paragraph document is valid');
  perform st.ok(not public.studio_valid_content('{"v":1,"blocks":[{"type":"script","text":"x"}]}'), 'unknown block types are rejected');
  perform st.ok(not public.studio_valid_content('{"v":1,"blocks":[{"type":"paragraph","text":"<script>alert(1)</script>"}]}'), 'markup is rejected');
  perform st.ok(not public.studio_valid_content('{"v":1,"blocks":[{"type":"paragraph","text":"<a href=\"javascript:x\">"}]}'), 'javascript: links are rejected');
  perform st.ok(not public.studio_valid_content('{"v":1,"blocks":[{"type":"paragraph","text":"<img src=x onerror=alert(1)>"}]}')
                and not public.studio_valid_content('{"v":1,"blocks":[{"type":"paragraph","text":"x\" onload=\"y"}]}'), 'event-handler attributes are rejected');
  perform st.ok(public.studio_valid_content('{"v":1,"blocks":[{"type":"paragraph","text":"Precio < 5 y a > b; describe la cláusula, alto/bajo"}]}'), 'ordinary text with < and > is still valid');
  perform st.ok(not public.studio_valid_content('{"v":1,"blocks":[{"type":"image","asset":"https://evil.test/x.png"}]}'), 'images cannot point to a URL');
  perform st.ok(not public.studio_valid_content('{"v":2,"blocks":[]}') and not public.studio_valid_content('[]'), 'unknown format versions are rejected');
  perform st.ok(not public.studio_valid_page('{"size":"tabloid"}') and not public.studio_valid_page('{"marginTop":2}') and public.studio_valid_page('{"size":"a4","font":"serif"}'), 'page settings are bounded');
  r := st.save('member', 'A', null, 'letter', 'Carta de bienvenida', st.content(), 'cl');
  perform st.ok(r ~ '^[0-9a-f-]{36}\|1$', 'a member creates a letter draft for a client');
  insert into st.ctx values ('letter', split_part(r, '|', 1));
  perform st.ok(st.save('member', 'A', null, 'letter', 'X', '{"v":1,"blocks":[{"type":"html","text":"x"}]}') like '%STUDIO_CONTENT_INVALID%', 'invalid content is refused');
  perform st.ok(st.save('member', 'A', null, 'letter', 'X', st.content(), 'clB') like '%STUDIO_REF_INVALID%', 'isolation: a client of another company cannot be bound');
  perform st.ok(st.save('member', 'A', null, 'certificate', 'X', st.content(), null, null, 'emp') like '%FORBIDDEN%', 'members cannot bind employees (workforce.manage)');
  perform st.ok(st.save('member', 'A', null, 'invoice', 'X', st.content(), null, 'quo') like '%STUDIO_REF_INVALID%', 'an invoice document cannot be bound to a quote');
  perform st.ok(st.save('other', 'A', null, 'letter', 'X', st.content()) like '%FORBIDDEN%', 'isolation: another company cannot create documents here');
  perform st.ok(st.save('member', 'A', null, 'letter', 'X', jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'image', 'asset', gen_random_uuid())))) like '%STUDIO_ASSET_INVALID%',
                'images must be an asset of the company');
  perform st.ok(st.merr(format('insert into public.studio_documents (company_id, kind, title, content) values (%L, %L, %L, %L)', st.id('A'), 'letter', 'x', '{"v":1,"blocks":[]}')) = ''
                and st.err('admin', format('insert into public.studio_documents (company_id, kind, title, content) values (%L, %L, %L, %L)', st.id('A'), 'letter', 'x', '{"v":1,"blocks":[]}')) like '%permission denied%',
                'users cannot insert directly (functions only)');
end $$;

-- ------------------------------------------------------------- versions and conflicts
do $$ declare d uuid := st.id('letter'); r text; begin
  r := st.save('member', 'A', d, 'letter', 'Carta de bienvenida v2', st.content('Segunda versión para {{client.name}}'), 'cl', null, null, null, 1);
  perform st.ok(r = d || '|2', 'saving with the right version → version 2');
  perform st.ok(st.save('admin', 'A', d, 'letter', 'Otra', st.content('pisando'), 'cl', null, null, null, 1) like '%STUDIO_CONFLICT%', 'saving over a newer version is refused (conflict)');
  perform st.ok((select count(*) from public.studio_versions where document_id = d) = 2, 'each save keeps a version');
  perform st.ok(st.err('member', format('select public.studio_restore_version(%L, 1, 2)', d)) = '', 'version 1 can be restored');
  perform st.ok((select version || '/' || (content -> 'blocks' -> 1 ->> 'text') from public.studio_documents where id = d) = '3/Hola {{client.name}}', 'the restore is a new version (3) with v1 content');
  r := st.val('member', format('select public.studio_duplicate(%L)', d));
  perform st.ok((select status || '/' || title from public.studio_documents where id = r::uuid) = 'draft/Copia de Carta de bienvenida', 'duplicate → a new draft (title of the restored version)');
end $$;

-- ------------------------------------------------------------- live data from the real tables
do $$ declare r text; data jsonb; begin
  r := st.save('member', 'A', null, 'invoice', 'Factura con diseño', jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'items'), jsonb_build_object('type', 'totals'))), null, 'inv');
  insert into st.ctx values ('sinv', split_part(r, '|', 1));
  data := st.val('member', format('select public.studio_data(%L)', st.id('sinv')))::jsonb;
  perform st.ok(data -> 'document' ->> 'total' = '330.00' and data -> 'client' ->> 'name' = 'Cliente Estudio' and jsonb_array_length(data -> 'payments') = 1
                and (data -> 'payments' -> 0 ->> 'amount')::numeric = 120 and data -> 'company' ->> 'legal_name' = 'Estudio A LLC',
                'studio_data reads total, client, payments and company from their own tables');
  perform st.ok(st.err('other', format('select public.studio_data(%L)', st.id('sinv'))) like '%STUDIO_NOT_FOUND%', 'isolation: another company cannot read the data');
  perform st.ok(st.val('other', format('select count(*) from public.studio_documents where company_id = %L', st.id('A'))) = '0', 'isolation: another company sees no studio documents');
end $$;

-- ------------------------------------------------------------- issuing
do $$ declare n text; ver int; begin
  ver := (select version from public.studio_documents where id = st.id('sinv'));
  perform st.ok(st.err('member', format('select public.studio_finalize(%L, %s)', st.id('sinv'), ver)) like '%STUDIO_NOT_FOUND%', 'members cannot issue (studio.issue)');
  perform st.ok(st.err('admin', format('select public.studio_finalize(%L, %s, %L)', st.id('sinv'), ver, '[{"description":"Diseño","quantity":2,"unit_price":100,"amount":999}]')) like '%STUDIO_ITEMS_INVALID%',
                'items that differ from the invoice are refused (no invented amounts)');
  perform st.ok(st.err('admin', format('select public.studio_finalize(%L, %s)', st.id('sinv'), ver + 5)) like '%STUDIO_CONFLICT%', 'issuing a stale version is refused');
  n := st.val('admin', format('select public.studio_finalize(%L, %s)', st.id('sinv'), ver));
  perform st.ok(n = (select document_number from public.documents where id = st.id('inv')), 'an invoice document uses the invoice''s own number (no second numbering)');
  perform st.ok((select (snapshot -> 'data' -> 'document' ->> 'total') || '/' || jsonb_array_length(snapshot -> 'items') from public.studio_documents where id = st.id('sinv')) = '330.00/2',
                'the issued copy freezes total and items read by the database');
  perform st.ok(st.save('admin', 'A', st.id('sinv'), 'invoice', 'cambio', st.content(), null, 'inv', null, null, ver + 1) like '%STUDIO_LOCKED%', 'an issued document cannot be edited');
  perform st.ok(st.merr(format('update public.studio_documents set title = %L where id = %L', 'x', st.id('sinv'))) like '%STUDIO_LOCKED%', 'not even by maintenance');
  perform st.ok(st.merr(format('update public.studio_documents set snapshot = %L where id = %L', '{}', st.id('sinv'))) like '%STUDIO_LOCKED%', 'its frozen data cannot be changed');
  perform st.ok(st.merr(format('delete from public.studio_documents where id = %L', st.id('sinv'))) like '%STUDIO_IMMUTABLE%', 'documents are never deleted');
  perform st.ok(st.err('admin', format('select public.studio_finalize(%L, %s)', st.id('sinv'), ver)) like '%STUDIO_TRANSITION%', 'issuing twice is refused');
  -- a draft invoice cannot be issued as a document
  perform st.ok(st.err('admin', format('select public.studio_finalize(%L, 1)', split_part(st.save('admin', 'A', null, 'invoice', 'Borrador', st.content(), null, 'draftinv'), '|', 1))) like '%STUDIO_SOURCE_DRAFT%',
                'a draft business invoice cannot be issued');
  perform st.ok(st.err('admin', format('select public.studio_finalize(%L, 1)', split_part(st.save('admin', 'A', null, 'invoice', 'Sin factura', st.content()), '|', 1))) like '%STUDIO_SOURCE_REQUIRED%',
                'an invoice document needs its business invoice');
end $$;

do $$ declare a text; b text; d1 uuid; d2 uuid; begin
  d1 := split_part(st.save('admin', 'A', null, 'letter', 'Carta 1', st.content(), 'cl'), '|', 1)::uuid;
  d2 := split_part(st.save('admin', 'A', null, 'letter', 'Carta 2', st.content(), 'cl'), '|', 1)::uuid;
  a := st.val('admin', format('select public.studio_finalize(%L, 1)', d1));
  b := st.val('admin', format('select public.studio_finalize(%L, 1)', d2));
  perform st.ok(a = 'CAR-' || extract(year from public.ba_today()) || '-0001' and b = 'CAR-' || extract(year from public.ba_today()) || '-0002', 'letters are numbered CAR-YYYY-0001, 0002…');
  perform st.ok(st.err('member', format('select public.studio_save_brand(%L, %L)', st.id('A'), '{"number_formats":{"letter":"L{YY}/{####}"}}')) like '%FORBIDDEN%', 'members cannot change the brand');
  perform st.ok(st.err('admin', format('select public.studio_save_brand(%L, %L)', st.id('A'),
                '{"number_formats":{"letter":"L{YY}/{####}"},"body_font":"serif","accent_color":"#1D4ED8","watermark_text":"CONFIDENCIAL","footer_text":"Gracias"}')) = '', 'an admin saves the brand');
  d1 := split_part(st.save('admin', 'A', null, 'letter', 'Carta 3', st.content(), 'cl'), '|', 1)::uuid;
  perform st.ok(st.val('admin', format('select public.studio_finalize(%L, 1)', d1)) = 'L' || right(extract(year from public.ba_today())::text, 2) || '/0003', 'the company''s number format is used');
  perform st.ok(st.err('admin', format('select public.studio_save_brand(%L, %L)', st.id('A'), '{"accent_color":"red"}')) <> '', 'brand colours must be #RRGGBB');
  perform st.ok(st.err('admin', format('select public.studio_save_brand(%L, %L)', st.id('A'), json_build_object('stamp_asset_id', gen_random_uuid()))) like '%STUDIO_ASSET_INVALID%', 'the stamp must be an image of the company');
end $$;

do $$ declare d uuid; begin
  d := split_part(st.save('admin', 'A', null, 'account_statement', 'Estado de cuenta', st.content(), 'cl'), '|', 1)::uuid;
  perform st.ok(st.val('admin', format('select public.studio_data(%L) -> ''statement'' -> 0 ->> ''balance_cents''', d)) = '21000', 'account statement: open balance from receivables (330 − 120 = 210.00)');
  perform st.ok(st.err('admin', format('select public.studio_finalize(%L, 1)', split_part(st.save('admin', 'A', null, 'account_statement', 'Sin cliente', st.content()), '|', 1))) like '%STUDIO_SOURCE_REQUIRED%',
                'an account statement needs a client');
  d := split_part(st.save('admin', 'A', null, 'certificate', 'Certificado de empleo', st.content('Certificamos que {{employee.full_name}} trabaja como {{employee.position}}'), null, null, 'emp'), '|', 1)::uuid;
  perform st.ok(st.val('admin', format('select public.studio_data(%L) -> ''employee'' ->> ''full_name''', d)) = 'Ana Rivera', 'certificates read the employee (admin has workforce.manage)');
  perform st.ok(st.err('member', format('select public.studio_data(%L)', d)) like '%FORBIDDEN%', 'a member cannot read an employee certificate''s data');
  d := split_part(st.save('admin', 'A', null, 'purchase_order', 'Orden de compra', st.content(), null, null, null, 'ven'), '|', 1)::uuid;
  perform st.ok(st.val('admin', format('select public.studio_data(%L) -> ''vendor'' ->> ''tax_id''', d)) = '66-0000001', 'purchase orders read the vendor');
end $$;

-- ------------------------------------------------------------- archive, record, events
do $$ begin
  perform st.ok(st.err('member', format('select public.studio_archive(%L, %L)', st.id('sinv'), 'Error')) like '%STUDIO_NOT_FOUND%', 'members cannot archive issued documents');
  perform st.ok(st.err('member', format('select public.studio_record(%L, %L)', st.id('letter'), 'email_prepared')) like '%STUDIO_TRANSITION%', 'e-mail is prepared only for issued documents');
  perform st.ok(st.err('member', format('select public.studio_record(%L, %L, %L)', st.id('sinv'), 'email_prepared', '{"to":"c@a.test","body":"secreto"}')) = '', 'e-mail preparation accepted');
  perform st.ok((select details ? 'body' from public.studio_events where document_id = st.id('sinv') and action = 'email_prepared') = false, 'e-mail preparation is logged (without the body)');
  perform st.ok(st.err('member', format('select public.studio_record(%L, %L)', st.id('sinv'), 'deleted')) like '%STUDIO_ACTION_INVALID%', 'only known actions are recorded');
  perform st.ok(st.err('admin', format('select public.studio_archive(%L, %L)', st.id('sinv'), 'x')) like '%REASON_REQUIRED%', 'archiving needs a reason');
  perform st.ok(st.err('admin', format('select public.studio_archive(%L, %L)', st.id('sinv'), 'Reemplazada')) = '', 'archive accepted');
  perform st.ok((select status || '/' || number from public.studio_documents where id = st.id('sinv')) = 'archived/' || (select document_number from public.documents where id = st.id('inv')),
                'an issued document is archived and keeps its number');
  perform st.ok(st.merr(format('update public.studio_documents set status = %L where id = %L', 'final', st.id('sinv'))) like '%STUDIO_LOCKED%', 'archived documents never come back');
  perform st.ok((select string_agg(action, ',' order by id) from public.studio_events where document_id = st.id('sinv')) = 'created,finalized,email_prepared,archived', 'the history records each step');
  perform st.ok(st.merr(format('delete from public.studio_events where document_id = %L', st.id('sinv'))) like '%LEDGER_IMMUTABLE%', 'the history is append-only');
end $$;

-- ------------------------------------------------------------- templates and assets
do $$ declare t uuid; begin
  perform st.ok(st.err('member', format('select public.studio_save_template(%L, null, %L, %L, null, %L, %L, %L)', st.id('A'), 'letter', 'Mi carta', 'business_letter', st.content(), '{}')) like '%FORBIDDEN%',
                'members cannot create company templates');
  t := st.val('admin', format('select public.studio_save_template(%L, null, %L, %L, %L, %L, %L, %L)', st.id('A'), 'letter', 'Carta corporativa', 'Con logo', 'business_letter', st.content(), '{"font":"serif"}'))::uuid;
  perform st.ok(t is not null, 'an admin customises a template for the company');
  perform st.ok(st.val('other', format('select count(*) from public.studio_templates where company_id = %L', st.id('A'))) = '0', 'isolation: another company does not see it');
  perform st.ok(st.err('other', format('select public.studio_save_template(%L, %L, %L, %L, null, null, %L, %L)', st.id('B'), t, 'letter', 'Robada', st.content(), '{}')) like '%STUDIO_NOT_FOUND%',
                'isolation: another company cannot modify it');
  perform st.ok(st.err('admin', format('select public.studio_save_template(%L, %L, %L, %L, null, null, %L, %L)', st.id('A'), t, 'letter', 'Carta corporativa', st.content('v2'), '{}')) = '', 'template edit accepted');
  perform st.ok((select version from public.studio_templates where id = t) = 2, 'editing a template bumps its version');
  perform st.ok(st.err('admin', format('select public.studio_archive_template(%L)', t)) = '', 'template archive accepted');
  perform st.ok((select status from public.studio_templates where id = t) = 'archived', 'templates are archived, not deleted');
  -- assets: the file must exist in the private bucket under the company folder
  perform st.ok(st.err('admin', format('select public.studio_register_asset(%L, %L, %L, %L, 10, 1, 1, %L)', st.id('A'), st.id('A') || '/' || gen_random_uuid() || '.png', 'x.png', 'image/png', repeat('a', 64))) like '%STUDIO_ASSET_INVALID%',
                'an image that was not uploaded cannot be registered');
  perform st.ok(st.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Studio-assets', st.id('A') || '/c0000000-0000-4000-8000-000000000001.png')) = '', 'a member uploads into the company folder');
  perform st.ok(st.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Studio-assets', st.id('B') || '/c0000000-0000-4000-8000-000000000002.png')) like '%row-level security%',
                'isolation: nobody uploads into another company''s folder');
  perform st.ok(st.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Studio-assets', st.id('A') || '/../evil.svg')) like '%row-level security%', 'only <uuid>.png/.jpg names');
  perform st.ok(st.val('member', format('select public.studio_register_asset(%L, %L, %L, %L, 1234, 300, 120, %L)', st.id('A'), st.id('A') || '/c0000000-0000-4000-8000-000000000001.png', 'sello.png', 'image/png', repeat('b', 64))) is not null,
                'the uploaded image is registered');
  perform st.ok(st.err('member', format('select public.studio_register_asset(%L, %L, %L, %L, 1, 1, 1, %L)', st.id('A'), st.id('A') || '/c0000000-0000-4000-8000-000000000001.png', 'gif.gif', 'image/gif', repeat('b', 64))) <> '',
                'only PNG / JPEG images');
  perform st.ok(st.val('other', format('select count(*) from storage.objects where bucket_id = %L', 'Studio-assets')) = '0', 'isolation: another company cannot list the images');
  perform st.ok((select public from storage.buckets where id = 'Studio-assets') = false, 'the image bucket is private');
end $$;

-- ------------------------------------------------------------- cascade
do $$ begin
  perform st.ok(st.merr(format('delete from public.companies where id = %L', st.id('A'))) = '', 'a whole company can still be deleted (issued documents included)');
  perform st.ok((select count(*) from public.studio_documents where company_id = st.id('A')) = 0 and (select count(*) from public.studio_versions where company_id = st.id('A')) = 0,
                'its studio documents and versions go with it');
end $$;

do $$ begin
  if exists (select 1 from st.failures) then
    raise exception 'STUDIO TESTS FAILED: %', (select string_agg(msg, ' | ') from st.failures);
  end if;
  raise notice 'ALL STUDIO TESTS PASSED';
end $$;
