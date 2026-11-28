-- CRM (0019) test suite: archive, history protection, client events,
-- document language, isolation. TEST-ONLY, local throw-away database
-- with 0014a + 0015 + 0019 (0016–0018 optional). Standalone (schema cr).
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema cr;
create table cr.ctx (key text primary key, id uuid not null);
create function cr.id(k text) returns uuid language sql stable as $$ select id from cr.ctx where key = k $$;
create table cr.failures (msg text);
create function cr.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into cr.failures values (msg); end if;
end $$;
grant usage on schema cr to authenticated;
grant select on cr.ctx to authenticated;
grant execute on all functions in schema cr to authenticated;
grant insert on cr.failures to authenticated;
create function cr.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', cr.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function cr.val(who text, q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', cr.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

insert into cr.ctx values
  ('owner', 'd1000000-0000-4000-8000-000000000001'), ('member', 'd1000000-0000-4000-8000-000000000002'),
  ('other', 'd1000000-0000-4000-8000-000000000003'),
  ('A', 'd2000000-0000-4000-8000-000000000001'), ('B', 'd2000000-0000-4000-8000-000000000002'),
  ('c1', 'd3000000-0000-4000-8000-000000000001'), ('c2', 'd3000000-0000-4000-8000-000000000002'),
  ('cB', 'd3000000-0000-4000-8000-000000000009');
insert into auth.users (id) select id from cr.ctx where key in ('owner', 'member', 'other');
insert into public.companies (id, name, created_by) values (cr.id('A'), 'CRM A', cr.id('owner')), (cr.id('B'), 'CRM B', cr.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (cr.id('A'), 'cus_cr_a', 'sub_cr_a', 'premium', 'active'), (cr.id('B'), 'cus_cr_b', 'sub_cr_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values
  (cr.id('A'), cr.id('owner'), 'owner'), (cr.id('A'), cr.id('member'), 'member'), (cr.id('B'), cr.id('other'), 'owner');

do $$ begin
  perform cr.ok(cr.err('member', format('insert into public.clients (id, company_id, name, archived_at) values (%L, %L, %L, now())',
                cr.id('c1'), cr.id('A'), 'Cliente Uno')) = '', 'a member creates a client');
  perform cr.ok((select archived_at from public.clients where id = cr.id('c1')) is null, 'a new client cannot be created already archived');
  perform cr.err('owner', format('insert into public.clients (id, company_id, name) values (%L, %L, %L)', cr.id('c2'), cr.id('A'), 'Cliente Dos'));
  perform cr.err('other', format('insert into public.clients (id, company_id, name) values (%L, %L, %L)', cr.id('cB'), cr.id('B'), 'Cliente B'));
  perform cr.ok(cr.err('member', format('update public.clients set phone = %L, email = %L where id = %L', '787-555-0000', 'uno@example.test', cr.id('c1'))) = '',
                'a member edits a client');
  perform cr.ok((select fields from public.client_events where client_id = cr.id('c1') and event = 'updated') = array['email', 'phone'],
                'the history records which fields changed');
  perform cr.ok(cr.err('member', format('update public.clients set archived_at = now() where id = %L', cr.id('c1'))) like '%CLIENT_ARCHIVE_FORBIDDEN%',
                'a member cannot archive');
  perform cr.ok(cr.err('owner', format('update public.clients set archived_at = %L, archived_by = %L where id = %L', '2000-01-01', cr.id('member'), cr.id('c1'))) = '',
                'the owner archives a client');
  perform cr.ok((select archived_at > now() - interval '1 minute' and archived_by = cr.id('owner') from public.clients where id = cr.id('c1')),
                'the database writes who archived it and when (client values ignored)');
  perform cr.ok(cr.err('owner', format('insert into public.documents (company_id, client_id, document_type, total, created_by) values (%L, %L, %L, 10, %L)',
                cr.id('A'), cr.id('c1'), 'invoice', cr.id('owner'))) like '%CLIENT_ARCHIVED%', 'an archived client gets no new documents');
  perform cr.ok(cr.err('owner', format('update public.clients set archived_at = null where id = %L', cr.id('c1'))) = '', 'the owner restores the client');
  perform cr.ok((select array_agg(event order by id) from public.client_events where client_id = cr.id('c1')) = array['created', 'updated', 'archived', 'restored'],
                'history: created, updated, archived, restored');
  perform cr.ok(cr.err('owner', format('insert into public.documents (company_id, client_id, document_type, total, created_by, language) values (%L, %L, %L, 10, %L, %L)',
                cr.id('A'), cr.id('c1'), 'invoice', cr.id('owner'), 'en')) = '', 'a document is created in English for the restored client');
  perform cr.ok((select language from public.documents where client_id = cr.id('c1')) = 'en', 'the document keeps its language');
  perform cr.ok(cr.err('owner', format('insert into public.documents (company_id, document_type, total, created_by, language) values (%L, %L, 10, %L, %L)',
                cr.id('A'), 'quote', cr.id('owner'), 'fr')) like '%documents_language_check%', 'only Spanish or English');
  perform cr.ok(cr.err('owner', format('delete from public.clients where id = %L', cr.id('c1'))) like '%CLIENT_HAS_HISTORY%',
                'a client with documents cannot be deleted, not even by the owner');
  perform cr.ok(cr.err('owner', format('delete from public.clients where id = %L', cr.id('c2'))) = '', 'a client without documents can be deleted');
  perform cr.ok(exists (select 1 from public.client_events where client_id = cr.id('c2') and event = 'deleted'), 'the deletion is recorded');
  perform cr.ok(cr.val('other', format('select count(*) from public.client_events where company_id = %L', cr.id('A'))) = '0',
                'isolation: B reads no client history of A');
  perform cr.ok(cr.err('owner', format('update public.clients set archived_at = now() where id = %L', cr.id('cB'))) = ''
                and (select archived_at from public.clients where id = cr.id('cB')) is null, 'isolation: A cannot archive B''s client (0 rows)');
  perform cr.ok(cr.err('member', format('delete from public.client_events where client_id = %L', cr.id('c1'))) like '%permission denied%',
                'the client history cannot be deleted through the API');
end $$;

do $$ begin
  if exists (select 1 from cr.failures) then
    raise exception 'CRM TESTS FAILED: %', (select string_agg(msg, '; ') from cr.failures);
  end if;
  raise notice 'ALL CRM TESTS PASSED';
end $$;
