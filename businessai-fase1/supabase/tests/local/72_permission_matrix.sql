-- Permission matrix probe (E3 · 0014a). TEST-ONLY, local throw-away database.
--
-- Runs every relevant operation, as each kind of actor, against real rows and
-- records what RLS and the grants actually allow. It does not inspect policy
-- text: it observes behaviour. run.sh executes it on the state before 0014a
-- and after 0014a (and after re-applying / rolling it back) and requires the
-- outputs to be identical to permission_matrix_expected.txt.
--
-- Actors: oa (owner of A), aa (admin of A), ma (member of A), ob (owner of
-- company B only), x (signed in, no company), anon (not signed in).
-- Every operation runs in a subtransaction that is always rolled back, so all
-- actors see exactly the same data.
-- Output: <actor>|<operation>|<outcome>   outcome = value | rows=N | error SQLSTATE
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create schema m;
create table m.ctx (key text primary key, id uuid not null);
create table m.result (n serial, actor text not null, op text not null, outcome text not null);
create function m.id(k text) returns uuid language sql stable as $$ select id from m.ctx where key = k $$;
grant usage on schema m to anon, authenticated;
grant select on m.ctx to anon, authenticated;
grant execute on function m.id(text) to anon, authenticated;

create function m.run(actor text, op text, q text) returns void language plpgsql as $$
declare v text; n bigint;
begin
  begin
    if actor = 'anon' then
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      execute 'set local role anon';
    else
      perform set_config('request.jwt.claims',
                         json_build_object('sub', m.id(actor), 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
    end if;
    if q ~* '^\s*select' then
      execute q into v;
    else
      execute q;
      get diagnostics n = row_count;
      v := 'rows=' || n;
    end if;
    raise exception 'm_undo' using detail = coalesce(v, 'null');
  exception when others then
    if sqlerrm = 'm_undo' then get stacked diagnostics v = pg_exception_detail;
    else v := 'error ' || sqlstate; end if;
  end;
  insert into m.result (actor, op, outcome) values (actor, op, v);
end $$;

-- ------------------------------------------------------------ fixture
insert into auth.users (id, email) values
  ('0a000000-0000-4000-8000-0000000000a1', 'oa@example.test'),
  ('0a000000-0000-4000-8000-0000000000a2', 'aa@example.test'),
  ('0a000000-0000-4000-8000-0000000000a3', 'ma@example.test'),
  ('0b000000-0000-4000-8000-0000000000b1', 'ob@example.test'),
  ('0c000000-0000-4000-8000-0000000000c1', 'x@example.test');
insert into m.ctx values
  ('oa', '0a000000-0000-4000-8000-0000000000a1'), ('aa', '0a000000-0000-4000-8000-0000000000a2'),
  ('ma', '0a000000-0000-4000-8000-0000000000a3'), ('ob', '0b000000-0000-4000-8000-0000000000b1'),
  ('x',  '0c000000-0000-4000-8000-0000000000c1'),
  ('A',  'aaaaaaaa-0000-4000-8000-000000000001'), ('B',  'bbbbbbbb-0000-4000-8000-000000000001'),
  ('cA1', 'aaaaaaaa-0000-4000-8000-0000000000c1'), ('cA2', 'aaaaaaaa-0000-4000-8000-0000000000c2'),
  ('cB1', 'bbbbbbbb-0000-4000-8000-0000000000c1'),
  ('dA1', 'aaaaaaaa-0000-4000-8000-0000000000d1'), ('dA2', 'aaaaaaaa-0000-4000-8000-0000000000d2'),
  ('dB1', 'bbbbbbbb-0000-4000-8000-0000000000d1'), ('dB2', 'bbbbbbbb-0000-4000-8000-0000000000d2'),
  ('pA1', 'aaaaaaaa-0000-4000-8000-0000000000f1'), ('pB1', 'bbbbbbbb-0000-4000-8000-0000000000f1'),
  ('aA',  'aaaaaaaa-0000-4000-8000-0000000000e1'), ('aB',  'bbbbbbbb-0000-4000-8000-0000000000e1');

insert into public.companies (id, name, created_by) values
  (m.id('A'), 'Empresa A', m.id('oa')), (m.id('B'), 'Empresa B', m.id('ob'));
-- Subscriptions first: 0010/0011 triggers check the plan on writes and members.
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (m.id('A'), 'cus_matrix_a', 'sub_matrix_a', 'premium', 'active'),
  (m.id('B'), 'cus_matrix_b', 'sub_matrix_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values
  (m.id('A'), m.id('oa'), 'owner'), (m.id('A'), m.id('aa'), 'admin'), (m.id('A'), m.id('ma'), 'member'),
  (m.id('B'), m.id('ob'), 'owner');
insert into public.company_profiles (company_id, display_name) values
  (m.id('A'), 'Empresa A'), (m.id('B'), 'Empresa B');
insert into public.clients (id, company_id, name) values
  (m.id('cA1'), m.id('A'), 'Cliente A1'), (m.id('cA2'), m.id('A'), 'Cliente A2'), (m.id('cB1'), m.id('B'), 'Cliente B1');
insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, title, total) values
  (m.id('dA1'), m.id('A'), m.id('cA1'), m.id('oa'), 'invoice', 'FAC-A-1', 'Factura A1', 100),
  (m.id('dA2'), m.id('A'), null, m.id('oa'), 'letter', 'CARTA-A-2', 'Carta A2', 0),
  (m.id('dB1'), m.id('B'), m.id('cB1'), m.id('ob'), 'invoice', 'FAC-B-1', 'Factura B1', 50),
  (m.id('dB2'), m.id('B'), null, m.id('ob'), 'letter', 'CARTA-B-2', 'Carta B2', 0);
insert into public.payments (id, company_id, document_id, amount, payment_method, created_by) values
  (m.id('pA1'), m.id('A'), m.id('dA1'), 100, 'manual', m.id('oa')),
  (m.id('pB1'), m.id('B'), m.id('dB1'), 50, 'manual', m.id('ob'));
insert into public.document_deletion_audit (id, company_id, document_id, reason, deleted_by) values
  (m.id('aA'), m.id('A'), gen_random_uuid(), 'prueba', m.id('oa')),
  (m.id('aB'), m.id('B'), gen_random_uuid(), 'prueba', m.id('ob'));
insert into storage.objects (bucket_id, name, owner) values
  ('Company-assets', m.id('A') || '/logo.png', m.id('oa')), ('Company-assets', m.id('B') || '/logo.png', m.id('ob')),
  ('Company-signatures', m.id('A') || '/sig.png', m.id('oa')), ('Company-signatures', m.id('B') || '/sig.png', m.id('ob'));

-- ---------------------------------------------------------- operations
create temporary table ops (n serial, op text not null, q text not null);
insert into ops (op, q) values
  -- Visibility: rows of A / rows of B.
  ('select companies A/B', $q$select (select count(*) from public.companies where id = m.id('A')) || '/' || (select count(*) from public.companies where id = m.id('B'))$q$),
  ('select memberships A/B', $q$select (select count(*) from public.memberships where company_id = m.id('A')) || '/' || (select count(*) from public.memberships where company_id = m.id('B'))$q$),
  ('select company_profiles A/B', $q$select (select count(*) from public.company_profiles where company_id = m.id('A')) || '/' || (select count(*) from public.company_profiles where company_id = m.id('B'))$q$),
  ('select company_subscriptions A/B', $q$select (select count(*) from public.company_subscriptions where company_id = m.id('A')) || '/' || (select count(*) from public.company_subscriptions where company_id = m.id('B'))$q$),
  ('select clients A/B', $q$select (select count(*) from public.clients where company_id = m.id('A')) || '/' || (select count(*) from public.clients where company_id = m.id('B'))$q$),
  ('select documents A/B', $q$select (select count(*) from public.documents where company_id = m.id('A')) || '/' || (select count(*) from public.documents where company_id = m.id('B'))$q$),
  ('select payments A/B', $q$select (select count(*) from public.payments where company_id = m.id('A')) || '/' || (select count(*) from public.payments where company_id = m.id('B'))$q$),
  ('select document_deletion_audit A/B', $q$select (select count(*) from public.document_deletion_audit where company_id = m.id('A')) || '/' || (select count(*) from public.document_deletion_audit where company_id = m.id('B'))$q$),
  ('select storage logo A/B', $q$select (select count(*) from storage.objects where bucket_id = 'Company-assets' and name like m.id('A') || '/%') || '/' || (select count(*) from storage.objects where bucket_id = 'Company-assets' and name like m.id('B') || '/%')$q$),
  ('select storage signature A/B', $q$select (select count(*) from storage.objects where bucket_id = 'Company-signatures' and name like m.id('A') || '/%') || '/' || (select count(*) from storage.objects where bucket_id = 'Company-signatures' and name like m.id('B') || '/%')$q$),
  ('select billing_plans', $q$select count(*)::text from public.billing_plans$q$),
  ('rpc company_billing_state(A)', $q$select coalesce(string_agg(state || ':' || can_write, ','), 'none') from public.company_billing_state(m.id('A'))$q$),
  ('rpc company_usage(A)', $q$select count(*)::text from public.company_usage(m.id('A'))$q$),
  ('rpc create_company', $q$select (public.create_company('Empresa nueva') is not null)::text$q$),
  -- Writes in company A.
  ('update company A', $q$update public.companies set name = 'Empresa A editada' where id = m.id('A')$q$),
  ('update company_profile A', $q$update public.company_profiles set display_name = 'Editada' where company_id = m.id('A')$q$),
  ('upsert company_profile A', $q$insert into public.company_profiles (company_id, display_name) values (m.id('A'), 'Upsert') on conflict (company_id) do update set display_name = excluded.display_name$q$),
  ('update client A', $q$update public.clients set name = 'Editado' where id = m.id('cA1')$q$),
  ('update document A (title, status)', $q$update public.documents set title = 'Editada', status = 'sent' where id = m.id('dA1')$q$),
  ('update payment A', $q$update public.payments set amount = 1 where id = m.id('pA1')$q$),
  ('update membership role in A', $q$update public.memberships set role = 'owner' where company_id = m.id('A') and user_id = m.id('ma')$q$),
  ('insert client A', $q$insert into public.clients (company_id, name) values (m.id('A'), 'Nuevo')$q$),
  ('insert document A', $q$insert into public.documents (company_id, client_id, created_by, document_type, document_number) values (m.id('A'), m.id('cA1'), (select auth.uid()), 'invoice', 'FAC-A-NEW')$q$),
  ('insert document A with client of B', $q$insert into public.documents (company_id, client_id, created_by, document_type, document_number) values (m.id('A'), m.id('cB1'), (select auth.uid()), 'invoice', 'FAC-A-XB')$q$),
  ('insert payment A', $q$insert into public.payments (company_id, document_id, amount, payment_method, created_by) values (m.id('A'), m.id('dA1'), 5, 'manual', (select auth.uid()))$q$),
  ('insert payment A as another user', $q$insert into public.payments (company_id, document_id, amount, payment_method, created_by) values (m.id('A'), m.id('dA1'), 5, 'manual', m.id('oa'))$q$),
  ('insert deletion audit A', $q$insert into public.document_deletion_audit (company_id, document_id, reason, deleted_by) values (m.id('A'), gen_random_uuid(), 'r', (select auth.uid()))$q$),
  ('insert storage logo A', $q$insert into storage.objects (bucket_id, name, owner) values ('Company-assets', m.id('A') || '/new.png', (select auth.uid()))$q$),
  ('insert storage signature A', $q$insert into storage.objects (bucket_id, name, owner) values ('Company-signatures', m.id('A') || '/new.png', (select auth.uid()))$q$),
  ('insert company directly', $q$insert into public.companies (name, created_by) values ('Directa', (select auth.uid()))$q$),
  ('insert membership into A', $q$insert into public.memberships (company_id, user_id, role) values (m.id('A'), (select auth.uid()), 'owner')$q$),
  ('delete client A', $q$delete from public.clients where id = m.id('cA2')$q$),
  ('delete document A', $q$delete from public.documents where id = m.id('dA2')$q$),
  ('delete payment A', $q$delete from public.payments where id = m.id('pA1')$q$),
  ('delete deletion audit A', $q$delete from public.document_deletion_audit where id = m.id('aA')$q$),
  ('delete storage logo A', $q$delete from storage.objects where bucket_id = 'Company-assets' and name = m.id('A') || '/logo.png'$q$),
  ('delete storage signature A', $q$delete from storage.objects where bucket_id = 'Company-signatures' and name = m.id('A') || '/sig.png'$q$),
  ('delete company A', $q$delete from public.companies where id = m.id('A')$q$),
  ('delete membership in A', $q$delete from public.memberships where company_id = m.id('A') and user_id = m.id('ma')$q$),
  -- Writes into company B (cross-company for everybody except ob).
  ('update client B', $q$update public.clients set name = 'Editado' where id = m.id('cB1')$q$),
  ('insert client B', $q$insert into public.clients (company_id, name) values (m.id('B'), 'Nuevo')$q$),
  ('delete document B', $q$delete from public.documents where id = m.id('dB2')$q$),
  ('insert storage signature B', $q$insert into storage.objects (bucket_id, name, owner) values ('Company-signatures', m.id('B') || '/new.png', (select auth.uid()))$q$);

do $$
declare a text; o record;
begin
  foreach a in array array['oa', 'aa', 'ma', 'ob', 'x', 'anon'] loop
    for o in select * from ops order by n loop
      perform m.run(a, o.op, o.q);
    end loop;
  end loop;
end $$;

reset role;
\pset format unaligned
\pset tuples_only on
select actor || '|' || op || '|' || outcome from m.result order by n;
