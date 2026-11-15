-- Advanced Document Studio (0041). TEST-ONLY, local throw-away database with
-- every migration up to 0041. Schema sa: the nine typefaces are accepted in
-- documents and the corporate identity (unknown ones refused); formatted
-- content and table options are stored as content (no markup accepted); a new
-- version is recorded on every save; the assistant 'studio_edit' proposal needs
-- studio.edit, the proposer's own open turn, and writes nothing else.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema sa;
create table sa.ctx (key text primary key, val text not null);
create function sa.id(k text) returns uuid language sql stable as $$ select val::uuid from sa.ctx where key = k $$;
create table sa.failures (msg text);
create function sa.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into sa.failures values (msg); end if;
end $$;
create function sa.call(who text, stmt text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', sa.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt into r; exception when others then r := 'ERR:' || sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function sa.save(who text, doc uuid, content jsonb, page jsonb, expected int default null) returns text language sql as $$
  select sa.call(who, format('select id || ''|'' || version from public.studio_save_document(%L, %L, %L, %L, null, %L, %L, null, null, null, null, null, null, %L, %L)',
    sa.id('A'), doc, 'letter', 'Carta', content, page, expected, 'user'))
$$;
grant usage on schema sa to authenticated;
grant select on sa.ctx to authenticated;
grant execute on all functions in schema sa to authenticated;
insert into sa.ctx values
  ('owner', 'f3100000-0000-4000-8000-000000000001'), ('member', 'f3100000-0000-4000-8000-000000000003'), ('other', 'f3100000-0000-4000-8000-000000000004'),
  ('A', 'f3200000-0000-4000-8000-000000000001'), ('B', 'f3200000-0000-4000-8000-000000000002'),
  ('cO', 'f3300000-0000-4000-8000-000000000001'), ('cX', 'f3300000-0000-4000-8000-000000000004'),
  ('tO', 'f3400000-0000-4000-8000-000000000001'), ('tX', 'f3400000-0000-4000-8000-000000000004');
insert into auth.users (id, email) select val::uuid, key || '@sa.test' from sa.ctx where key in ('owner', 'member', 'other');
insert into public.companies (id, name, created_by) values (sa.id('A'), 'Studio A', sa.id('owner')), (sa.id('B'), 'Studio B', sa.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (sa.id('A'), 'cus_sa_a', 'sub_sa_a', 'premium', 'active'), (sa.id('B'), 'cus_sa_b', 'sub_sa_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values (sa.id('A'), sa.id('owner'), 'owner'), (sa.id('A'), sa.id('member'), 'member'), (sa.id('B'), sa.id('other'), 'owner');
insert into public.assistant_conversations (id, company_id, user_id, title) values (sa.id('cO'), sa.id('A'), sa.id('owner'), 'Studio'), (sa.id('cX'), sa.id('B'), sa.id('other'), 'Otra');
insert into public.assistant_turns (id, company_id, conversation_id, user_id) values (sa.id('tO'), sa.id('A'), sa.id('cO'), sa.id('owner')), (sa.id('tX'), sa.id('B'), sa.id('cX'), sa.id('other'));

do $$
declare r text; d uuid; c jsonb;
  money_before bigint := (select count(*) from public.payments) + (select count(*) from public.bill_payments) + (select count(*) from public.journal_entries) + (select count(*) from public.documents);
begin
  c := jsonb_build_object('v', 1, 'blocks', jsonb_build_array(
    jsonb_build_object('type', 'paragraph', 'text', 'Precio {c=#c0392b;s=14;f=lora;u|**especial**} y {h=#FFF59D;x|antes}'),
    jsonb_build_object('type', 'table', 'header', true, 'rows', jsonb_build_array(jsonb_build_array('A', 'B')), 'align', jsonb_build_array('left', 'right'), 'style', 'grid', 'total', true)));
  -- typefaces in documents
  foreach r in array array['lato', 'montserrat', 'plex-sans', 'plex-serif', 'lora', 'playfair', 'mono', 'sans', 'serif'] loop
    perform sa.ok(sa.save('member', null, c, jsonb_build_object('font', r)) ~ '^[0-9a-f-]{36}\|1$', 'a document may use the typeface ' || r);
  end loop;
  perform sa.ok(sa.save('member', null, c, '{"font": "comic-sans"}') like '%STUDIO_CONTENT_INVALID%', 'an unknown typeface is refused');
  r := sa.save('member', null, c, '{"font": "lora"}'); d := split_part(r, '|', 1)::uuid;
  perform sa.ok((select content -> 'blocks' -> 1 ->> 'style' from public.studio_documents where id = d) = 'grid'
                and (select content -> 'blocks' -> 0 ->> 'text' from public.studio_documents where id = d) like '%{c=#c0392b;s=14;f=lora;u|%', 'formatting spans and table options are stored as content');
  perform sa.ok(sa.save('member', null, jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'paragraph', 'text', '{c=#000000|<script>x</script>}'))), '{}') like '%STUDIO_CONTENT_INVALID%',
                'markup is still refused inside a span');
  -- versions: every save is a new version (the comparison reads them)
  perform sa.ok(sa.save('member', d, jsonb_build_object('v', 1, 'blocks', jsonb_build_array(jsonb_build_object('type', 'paragraph', 'text', 'Segunda versión'))), '{"font": "mono"}', 1) ~ '\|2$', 'an edit makes version 2');
  perform sa.ok((select count(*) from public.studio_versions where document_id = d) >= 2, 'both versions are kept in the history');
  perform sa.ok(sa.call('other', format('select count(*)::text from public.studio_versions where document_id = %L', d)) = '0', 'another company cannot read the versions');
  -- corporate identity
  perform sa.ok(sa.call('owner', format('select public.studio_save_brand(%L, %L)::text', sa.id('A'), '{"heading_font": "playfair", "body_font": "plex-sans"}')) not like 'ERR:%', 'the identity may use the new typefaces');
  perform sa.ok((select heading_font || '/' || body_font from public.studio_brand where company_id = sa.id('A')) = 'playfair/plex-sans', 'stored as chosen');
  perform sa.ok(sa.call('owner', format('select public.studio_save_brand(%L, %L)::text', sa.id('A'), '{"heading_font": "papyrus"}')) like 'ERR:%', 'an unknown identity typeface is refused');
  -- assistant draft edits
  r := sa.call('owner', format('select public.assistant_propose(%L, %L, %L, %L)::text', sa.id('tO'), 'studio_edit', 'Añadir párrafo', jsonb_build_object('document_id', d, 'version', 2)));
  perform sa.ok(r ~ '^[0-9a-f-]{36}$' and (select level || '/' || status from public.assistant_actions where id = r::uuid) = 'draft/proposed', 'an edit of a draft is PROPOSED (pending confirmation): ' || r);
  perform sa.ok(sa.call('owner', format('select public.assistant_propose(%L, %L, %L, %L)::text', sa.id('tX'), 'studio_edit', 'x', '{}')) like '%ASSISTANT_NOT_FOUND%', 'not on another user''s turn');
  perform sa.ok(sa.call('owner', format('select public.assistant_propose(%L, %L, %L, %L)::text', sa.id('tO'), 'studio_issue', 'x', '{}')) like '%ASSISTANT_INVALID%', 'issuing is not a proposal kind');
  perform sa.ok((select count(*) from public.payments) + (select count(*) from public.bill_payments) + (select count(*) from public.journal_entries) + (select count(*) from public.documents) = money_before,
                'no payment, ledger entry or business document was written');
end $$;

do $$ begin
  if exists (select 1 from sa.failures) then raise exception 'STUDIO ADVANCED TESTS FAILED: %', (select string_agg(msg, '; ') from sa.failures); end if;
  raise notice 'ALL STUDIO ADVANCED TESTS PASSED';
end $$;
