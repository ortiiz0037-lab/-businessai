-- Catalog of products and services (0039). TEST-ONLY, local throw-away
-- database with every migration up to 0039. Schema ct: create / update with
-- optimistic version, validation, unique codes per company (case-insensitive,
-- archived included), archive / restore, history, permissions (members read,
-- owner / admin manage), other companies, no direct writes, no deletes.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema ct;
create table ct.ctx (key text primary key, val text not null);
create function ct.id(k text) returns uuid language sql stable as $$ select val::uuid from ct.ctx where key = k $$;
create table ct.failures (msg text);
create function ct.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into ct.failures values (msg); end if;
end $$;
create function ct.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', ct.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function ct.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', ct.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- save as `who`: 'id|version' or the error
create function ct.save(who text, co text, item uuid, code text, name text, kind text default 'product', unit text default 'unidad',
                        price bigint default 1000, tax numeric default null, track boolean default false, expected int default null) returns text language plpgsql as $$
declare r text;
begin
  begin
    r := ct.val(who, format('select id || ''|'' || version from public.catalog_save(%L, %L, %L, %L, %L, %L, %L, %s, %L, %L, %L)',
      ct.id(co), item, code, name, 'Descripción', kind, unit, price, tax, track, expected));
  exception when others then r := sqlerrm; end;
  return r;
end $$;
grant usage on schema ct to authenticated;
grant select on ct.ctx to authenticated;
grant execute on all functions in schema ct to authenticated;
insert into ct.ctx values
  ('owner', 'f1100000-0000-4000-8000-000000000001'), ('admin', 'f1100000-0000-4000-8000-000000000002'),
  ('member', 'f1100000-0000-4000-8000-000000000003'), ('other', 'f1100000-0000-4000-8000-000000000004'),
  ('A', 'f1200000-0000-4000-8000-000000000001'), ('B', 'f1200000-0000-4000-8000-000000000002');
insert into auth.users (id, email) select val::uuid, key || '@ct.test' from ct.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (ct.id('A'), 'Catálogo A', ct.id('owner')), (ct.id('B'), 'Catálogo B', ct.id('other'));
insert into public.memberships (company_id, user_id, role) values
  (ct.id('A'), ct.id('owner'), 'owner'), (ct.id('A'), ct.id('admin'), 'admin'), (ct.id('A'), ct.id('member'), 'member'), (ct.id('B'), ct.id('other'), 'owner');

do $$
declare r text; i uuid; s uuid; v int;
begin
  -- create
  r := ct.save('admin', 'A', null, 'MAT-01', 'Cemento gris', 'product', 'saco', 1250, 11.5, true);
  perform ct.ok(r ~ '^[0-9a-f-]{36}\|1$', 'an admin creates a product (version 1): ' || r);
  i := split_part(r, '|', 1)::uuid;
  perform ct.ok((select price_cents = 1250 and tax_rate = 11.5 and unit = 'saco' and track_inventory and status = 'active' from public.catalog_items where id = i), 'price in cents, own tax rate, unit, stock flag');
  r := ct.save('owner', 'A', null, 'SRV-01', 'Instalación', 'service', 'hora', 4500);
  perform ct.ok(r ~ '\|1$', 'the owner creates a service');
  s := split_part(r, '|', 1)::uuid;
  perform ct.ok((select tax_rate is null from public.catalog_items where id = s), 'no own tax rate: the document''s rate applies');
  -- validation
  perform ct.ok(ct.save('admin', 'A', null, 'mat-01', 'Otro') like '%CATALOG_CODE_TAKEN%', 'codes are unique per company, case-insensitive');
  perform ct.ok(ct.save('admin', 'A', null, '', 'Sin código') like '%CATALOG_INVALID%'
                and ct.save('admin', 'A', null, 'A B', 'Espacio') like '%CATALOG_INVALID%'
                and ct.save('admin', 'A', null, 'X1', '  ') like '%CATALOG_INVALID%'
                and ct.save('admin', 'A', null, 'X2', 'Precio', 'product', 'u', -1) like '%CATALOG_INVALID%'
                and ct.save('admin', 'A', null, 'X3', 'Impuesto', 'product', 'u', 1, 101) like '%CATALOG_INVALID%'
                and ct.save('admin', 'A', null, 'X4', 'Tipo', 'kit') like '%CATALOG_INVALID%'
                and ct.save('admin', 'A', null, 'X5', 'Servicio con stock', 'service', 'h', 1, null, true) like '%CATALOG_INVALID%',
                'invalid code, name, negative price, tax over 100%, unknown kind and a service with stock are refused');
  perform ct.ok(ct.save('other', 'B', null, 'MAT-01', 'Cemento B') ~ '\|1$', 'another company may use the same code');
  -- update with optimistic version
  perform ct.ok(ct.save('admin', 'A', i, 'MAT-01', 'Cemento gris 42.5kg', 'product', 'saco', 1300, 11.5, true, 1) ~ '\|2$', 'update with the right version → version 2');
  perform ct.ok(ct.save('admin', 'A', i, 'MAT-01', 'Cemento viejo', 'product', 'saco', 1, 11.5, true, 1) like '%CATALOG_CONFLICT%', 'a stale version is refused (no lost update)');
  perform ct.ok((select changes ? 'price_cents' and changes ? 'name' and not changes ? 'unit' from public.catalog_events where item_id = i and action = 'updated'),
                'history records only what changed (price, name)');
  perform ct.ok(ct.save('admin', 'B', i, 'MAT-01', 'Robo', 'product', 'saco', 1, null, false, 2) like '%FORBIDDEN%'
                and ct.save('admin', 'A', ct.id('B'), 'Z', 'No existe', 'product', 'u', 1, null, false, 1) like '%CATALOG_NOT_FOUND%', 'not in another company');
  -- permissions
  perform ct.ok(ct.save('member', 'A', null, 'M-1', 'Miembro') like '%FORBIDDEN%', 'a member cannot create items');
  perform ct.ok(ct.val('member', format('select count(*) from public.catalog_items where company_id = %L', ct.id('A'))) = '2', 'a member reads the catalog (to use it in documents)');
  perform ct.ok(ct.val('member', format('select count(*) from public.catalog_events where company_id = %L', ct.id('A'))) = '0', 'but not its history');
  perform ct.ok(ct.val('other', format('select count(*) from public.catalog_items where company_id = %L', ct.id('A'))) = '0', 'another company reads nothing');
  perform ct.ok(ct.err('owner', format('insert into public.catalog_items (company_id, code, name) values (%L, %L, %L)', ct.id('A'), 'D-1', 'Directo')) <> ''
                and ct.err('owner', format('update public.catalog_items set price_cents = 1 where id = %L', i)) <> ''
                and ct.err('owner', format('delete from public.catalog_items where id = %L', i)) <> '', 'no direct insert, update or delete (only the functions)');
  -- archive / restore
  perform ct.ok(ct.err('member', format('select public.catalog_set_status(%L, %L, 2)', i, 'archived')) like '%CATALOG_NOT_FOUND%', 'a member cannot archive');
  v := ct.val('admin', format('select public.catalog_set_status(%L, %L, 2)', i, 'archived'))::int;
  perform ct.ok(v = 3 and (select status from public.catalog_items where id = i) = 'archived', 'archived (version 3)');
  perform ct.ok(ct.save('admin', 'A', i, 'MAT-01', 'Editar archivado', 'product', 'saco', 1, null, true, 3) like '%CATALOG_ARCHIVED%', 'an archived item is not edited');
  perform ct.ok(ct.save('admin', 'A', null, 'MAT-01', 'Reusar código') like '%CATALOG_CODE_TAKEN%', 'its code is not reused for something else');
  perform ct.ok(ct.val('admin', format('select public.catalog_set_status(%L, %L, 3)', i, 'active'))::int = 4, 'restored (version 4)');
  perform ct.ok((select array_agg(action order by id) from public.catalog_events where item_id = i) = array['created', 'updated', 'archived', 'restored'], 'full history: created, updated, archived, restored');
  -- deletes: never while the company exists; history is append-only
  begin delete from public.catalog_items where id = s; perform ct.ok(false, 'an item is never deleted');
  exception when others then perform ct.ok(sqlerrm like '%CATALOG_IMMUTABLE%', 'an item is never deleted (archive it)'); end;
  begin update public.catalog_events set action = 'created' where item_id = i; perform ct.ok(false, 'history is append-only');
  exception when others then perform ct.ok(sqlerrm like '%CATALOG_IMMUTABLE%', 'history is append-only'); end;
end $$;

-- deleting a company removes its catalog (cascade allowed once the company is gone)
do $$ begin
  delete from public.companies where id = ct.id('B');
  perform ct.ok(not exists (select 1 from public.catalog_items where company_id = ct.id('B')), 'deleting the company removes its catalog');
exception when others then perform ct.ok(false, 'deleting the company removes its catalog: ' || sqlerrm);
end $$;

do $$ begin
  if exists (select 1 from ct.failures) then raise exception 'CATALOG TESTS FAILED: %', (select string_agg(msg, '; ') from ct.failures); end if;
  raise notice 'ALL CATALOG TESTS PASSED';
end $$;
