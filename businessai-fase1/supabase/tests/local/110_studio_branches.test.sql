-- Document Studio branches (0037). TEST-ONLY, local throw-away database with
-- every migration up to 0037. Schema sb: a draft is issued from a branch of
-- its company; the branch reaches the merge data, the frozen snapshot and the
-- number ({SUC}); only active branches of the same company; with CRM branch
-- scoping a member uses only its branches; issued documents are locked.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema sb;
create table sb.ctx (key text primary key, val text not null);
create function sb.id(k text) returns uuid language sql stable as $$ select val::uuid from sb.ctx where key = k $$;
create table sb.failures (msg text);
create function sb.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into sb.failures values (msg); end if;
end $$;
create function sb.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', sb.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function sb.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', sb.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function sb.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
-- a minimal valid block document
create function sb.content(txt text default 'Hola {{client.name}}') returns jsonb language sql immutable as $$
  select jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'heading', 'level', 1, 'text', 'Título'), jsonb_build_object('type', 'paragraph', 'text', txt)))
$$;
-- save as `who`: returns 'id|version' or the error
create function sb.save(who text, co text, doc uuid, kind text, title text, content jsonb, client text default null, src text default null, emp text default null,
                        vend text default null, expected int default null) returns text language plpgsql as $$
declare r text;
begin
  begin
    r := sb.val(who, format('select id || ''|'' || version from public.studio_save_document(%L, %L, %L, %L, null, %L, %L, %L, %L, %L, %L, null, null, %L)',
      sb.id(co), doc, kind, title, content, '{}', sb.id(client), sb.id(src), sb.id(emp), sb.id(vend), expected));
  exception when others then r := sqlerrm; end;
  return r;
end $$;
grant usage on schema sb to authenticated;
grant select on sb.ctx to authenticated;
grant execute on all functions in schema sb to authenticated;
insert into sb.ctx values
  ('owner', 'd7000000-0000-4000-8000-000000000001'), ('admin', 'd7000000-0000-4000-8000-000000000002'),
  ('member', 'd7000000-0000-4000-8000-000000000003'), ('other', 'd7000000-0000-4000-8000-000000000004'),
  ('A', 'd8000000-0000-4000-8000-000000000001'), ('B', 'd8000000-0000-4000-8000-000000000002'),
  ('CEN', 'd9000000-0000-4000-8000-000000000001'), ('PON', 'd9000000-0000-4000-8000-000000000002'),
  ('OLD', 'd9000000-0000-4000-8000-000000000003'), ('BX', 'd9000000-0000-4000-8000-000000000004');
insert into auth.users (id, email) select val::uuid, key || '@sb.test' from sb.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (sb.id('A'), 'Sucursales A', sb.id('owner')), (sb.id('B'), 'Sucursales B', sb.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (sb.id('A'), 'cus_sb_a', 'sub_sb_a', 'premium', 'active'), (sb.id('B'), 'cus_sb_b', 'sub_sb_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values
  (sb.id('A'), sb.id('owner'), 'owner'), (sb.id('A'), sb.id('admin'), 'admin'), (sb.id('A'), sb.id('member'), 'member'), (sb.id('B'), sb.id('other'), 'owner');
insert into public.branches (id, company_id, name, code, address) values
  (sb.id('CEN'), sb.id('A'), 'Central', 'CEN', 'Calle Comercio 1, San Juan'), (sb.id('PON'), sb.id('A'), 'Ponce', 'PON', 'Calle Reina 5, Ponce'),
  (sb.id('OLD'), sb.id('A'), 'Cerrada', 'OLD', null), (sb.id('BX'), sb.id('B'), 'Otra', 'BX', null);
update public.branches set archived_at = now() where id = sb.id('OLD');
create function sb.doc(who text, title text) returns uuid language sql as $$ select split_part(sb.save(who, 'A', null, 'letter', title, sb.content('Desde {{branch.name}} ({{branch.code}}): {{branch.address}}')), '|', 1)::uuid $$;
create function sb.ver(d uuid) returns int language sql stable as $$ select version from public.studio_documents where id = d $$;
grant execute on all functions in schema sb to authenticated;

do $$ declare d uuid; d2 uuid; v int; n1 text; n2 text; begin
  d := sb.doc('admin', 'Carta desde sucursal');
  v := sb.ver(d);
  -- (the check reads the row in a separate statement: one expression shares one snapshot)
  n1 := sb.val('admin', format('select public.studio_set_branch(%L, %L)', d, sb.id('CEN')));
  perform sb.ok(n1::int = v + 1 and (select branch_id from public.studio_documents where id = d) = sb.id('CEN'), 'the admin sets the branch of a draft (version + 1)');
  perform sb.ok(sb.val('admin', format('select public.studio_set_branch(%L, %L)', d, sb.id('CEN')))::int = v + 1, 'setting the same branch again changes nothing');
  perform sb.ok(sb.err('admin', format('select public.studio_set_branch(%L, %L)', d, sb.id('BX'))) like '%STUDIO_BRANCH_INVALID%', 'a branch of another company is refused');
  perform sb.ok(sb.err('admin', format('select public.studio_set_branch(%L, %L)', d, sb.id('OLD'))) like '%STUDIO_BRANCH_INVALID%', 'an archived branch is refused');
  perform sb.ok(sb.err('other', format('select public.studio_set_branch(%L, %L)', d, sb.id('BX'))) like '%STUDIO_NOT_FOUND%', 'another company cannot touch the document');
  perform sb.ok(sb.err('admin', format('update public.studio_documents set branch_id = %L where id = %L', sb.id('PON'), d)) like '%permission denied%', 'no direct writes');
  perform sb.ok(sb.val('admin', format('select public.studio_data(%L) -> ''branch'' ->> ''code''', d)) = 'CEN'
                and sb.val('member', format('select public.studio_data(%L) -> ''branch'' ->> ''address''', d)) = 'Calle Comercio 1, San Juan', 'the merge data include the branch (name, code, address)');
  -- branch scoping (0035): the member, assigned to Ponce, may only use Ponce; the admin (branches.manage) any
  insert into public.crm_settings (company_id, branch_scoping) values (sb.id('A'), true) on conflict (company_id) do update set branch_scoping = true;
  insert into public.branch_members (company_id, branch_id, user_id) values (sb.id('A'), sb.id('PON'), sb.id('member'));
  d2 := sb.doc('member', 'Carta del miembro');
  perform sb.ok(sb.err('member', format('select public.studio_set_branch(%L, %L)', d2, sb.id('CEN'))) like '%STUDIO_BRANCH_FORBIDDEN%', 'with branch scoping a member cannot use a branch it is not assigned to');
  perform sb.ok(sb.err('member', format('select public.studio_set_branch(%L, %L)', d2, sb.id('PON'))) = '', 'it uses its own branch');
  perform sb.ok(sb.err('admin', format('select public.studio_set_branch(%L, %L)', d2, sb.id('CEN'))) = '', 'the admin (branches.manage) may set any active branch');
  n2 := sb.err('member', format('select public.studio_set_branch(%L, null)', d2));
  perform sb.ok(n2 = '' and (select branch_id from public.studio_documents where id = d2) is null, 'the branch can be removed from a draft');
  update public.crm_settings set branch_scoping = false where company_id = sb.id('A');
  -- numbering with {SUC} and the frozen snapshot
  update public.studio_brand set number_formats = jsonb_build_object('letter', 'CAR-{SUC}-{YYYY}-{####}') where company_id = sb.id('A');
  if not found then insert into public.studio_brand (company_id, number_formats) values (sb.id('A'), jsonb_build_object('letter', 'CAR-{SUC}-{YYYY}-{####}')); end if;
  n1 := sb.val('owner', format('select public.studio_finalize(%L, %s)', d, sb.ver(d)));
  perform sb.ok(n1 = 'CAR-CEN-' || extract(year from public.ba_today())::int || '-0001', 'issued from Central: the number carries the branch code (' || n1 || ')');
  perform sb.ok((select snapshot -> 'data' -> 'branch' ->> 'name' from public.studio_documents where id = d) = 'Central', 'the issued snapshot keeps the branch');
  n2 := sb.val('owner', format('select public.studio_finalize(%L, %s)', d2, sb.ver(d2)));
  perform sb.ok(n2 = 'CAR-' || extract(year from public.ba_today())::int || '-0002', 'without a branch the token and its separator disappear (' || n2 || ')');
  perform sb.ok(sb.err('admin', format('select public.studio_set_branch(%L, %L)', d, sb.id('PON'))) like '%STUDIO_LOCKED%', 'an issued document keeps its branch (locked)');
  update public.branches set name = 'Central renombrada' where id = sb.id('CEN');
  perform sb.ok((select snapshot -> 'data' -> 'branch' ->> 'name' from public.studio_documents where id = d) = 'Central', 'renaming the branch later does not change what was issued');
  perform sb.ok((select count(*) from public.studio_events where document_id = d and action = 'branch_set') = 1, 'the change is in the document history');
  begin delete from public.branches where id = sb.id('CEN'); perform sb.ok(false, 'a branch with documents cannot be deleted');
  exception when others then perform sb.ok(sqlstate = '23503', 'a branch with documents cannot be deleted (archive it instead)'); end;
end $$;

do $$ begin
  if exists (select 1 from sb.failures) then raise exception 'STUDIO BRANCH TESTS FAILED: %', (select string_agg(msg, '; ') from sb.failures); end if;
  raise notice 'ALL STUDIO BRANCH TESTS PASSED';
end $$;
