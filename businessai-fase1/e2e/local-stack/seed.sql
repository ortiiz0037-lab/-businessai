-- Test data for the authenticated browser test (local only). Every write
-- goes through the same functions / RLS the app uses, as the owner.
create schema if not exists e2e;
create or replace function e2e.as_user(uid uuid, stmt text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute stmt into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create or replace function e2e.acct(c text) returns uuid language sql stable as $$
  select id from public.ledger_accounts where company_id = 'e2000000-0000-4000-8000-000000000001' and code = c $$;
create or replace function e2e.je(d date, descr text, lines jsonb) returns void language plpgsql as $$
begin
  perform e2e.as_user('e1000000-0000-4000-8000-000000000001', format('select public.ledger_post_manual(%L, %L, %L, null, %L)::text',
    'e2000000-0000-4000-8000-000000000001', d, descr,
    (select jsonb_agg(jsonb_build_object('account', e2e.acct(x ->> 0), 'debit', (x ->> 1)::bigint, 'credit', (x ->> 2)::bigint)) from jsonb_array_elements(lines) x)));
end $$;

insert into auth.users (id, email) values
  ('e1000000-0000-4000-8000-000000000001', 'owner@e2e.local'), ('e1000000-0000-4000-8000-000000000002', 'admin@e2e.local'),
  ('e1000000-0000-4000-8000-000000000003', 'member@e2e.local'), ('e1000000-0000-4000-8000-000000000004', 'other@e2e.local');
insert into public.companies (id, name, created_by) values
  ('e2000000-0000-4000-8000-000000000001', 'Finanzas E2E', 'e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000002', 'Otra Empresa E2E', 'e1000000-0000-4000-8000-000000000004');
-- plan row only (no Stripe call happens locally)
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  ('e2000000-0000-4000-8000-000000000001', 'cus_e2e_local', 'sub_e2e_local', 'pro', 'active'),
  ('e2000000-0000-4000-8000-000000000002', 'cus_e2e_other', 'sub_e2e_other', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'owner'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'admin'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'member'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000004', 'owner');
insert into public.departments (company_id, name) values ('e2000000-0000-4000-8000-000000000001', 'Ventas');
insert into public.clients (id, company_id, name, email) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Cliente Uno', 'uno@e2e.local');

select e2e.as_user('e1000000-0000-4000-8000-000000000001', $q$select public.ledger_init('e2000000-0000-4000-8000-000000000001')::text$q$);
select e2e.as_user('e1000000-0000-4000-8000-000000000001', $q$select public.payables_init('e2000000-0000-4000-8000-000000000001')::text$q$);

-- books: capital last year, then monthly sales / costs for the last 7 months
do $$ declare m int; d date; begin
  perform e2e.je(make_date(extract(year from public.ba_today())::int - 1, 2, 1), 'Capital inicial', '[["1010",2000000,0],["3000",0,2000000]]');
  perform e2e.je(make_date(extract(year from public.ba_today())::int - 1, 6, 15), 'Venta año anterior', '[["1010",400000,0],["4000",0,400000]]');
  for m in reverse 6..0 loop
    d := (date_trunc('month', public.ba_today()) - make_interval(months => m))::date + 4;
    if d > public.ba_today() then d := public.ba_today(); end if;
    perform e2e.je(d, 'Ventas del mes', format('[["1010",%s,0],["4000",0,%s]]', 300000 + (6 - m) * 10000, 300000 + (6 - m) * 10000)::jsonb);
    perform e2e.je(d, 'Costo de ventas', '[["5000",90000,0],["1010",0,90000]]');
    perform e2e.je(d, 'Renta', '[["6200",80000,0],["1010",0,80000]]');
  end loop;
end $$;

-- receivables: one overdue invoice and one current, a partial payment
select e2e.as_user('e1000000-0000-4000-8000-000000000001', format($q$insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date)
  values ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'invoice', 'x', 'sent', 1500, 0, 1500, %L, %L),
         ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'invoice', 'x', 'sent', 800, 0, 800, %L, %L)
  returning 'ok'$q$, public.ba_today() - 60, public.ba_today() - 30, public.ba_today() - 5, public.ba_today() + 25));
select e2e.as_user('e1000000-0000-4000-8000-000000000001', $q$insert into public.payments (company_id, document_id, amount, created_by)
  values ('e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 500, 'e1000000-0000-4000-8000-000000000001') returning 'ok'$q$);

-- payables: a vendor and an approved bill due next week
insert into public.vendors (id, company_id, name) values ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Proveedor E2E');
do $$ declare bid uuid; begin
  bid := e2e.as_user('e1000000-0000-4000-8000-000000000001', format('select public.bill_save_draft(%L, null, %L, %L, public.ba_today(), public.ba_today() + 7, %L, null, %L)::text',
    'e2000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'P-100', 'Suministros',
    jsonb_build_array(jsonb_build_object('category_id', (select id from public.expense_categories where company_id = 'e2000000-0000-4000-8000-000000000001' order by name limit 1),
      'amount_cents', '45000', 'description', 'Material'))))::uuid;
  perform e2e.as_user('e1000000-0000-4000-8000-000000000001', format('select public.bill_submit(%L)::text', bid));
  perform e2e.as_user('e1000000-0000-4000-8000-000000000001', format('select public.bill_approve(%L)::text', bid));
end $$;
