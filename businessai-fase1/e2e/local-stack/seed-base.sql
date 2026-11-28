-- Test data for the STAGING-SHAPED local database (migrations 0001–0011 +
-- 0014a only, what the real businessai-staging project has today). Local
-- only, fictitious. Used by e2e/staging-shape.e2e.mjs.
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
insert into auth.users (id, email) values
  ('e1000000-0000-4000-8000-000000000001', 'owner@e2e.local'), ('e1000000-0000-4000-8000-000000000002', 'admin@e2e.local'),
  ('e1000000-0000-4000-8000-000000000003', 'member@e2e.local'), ('e1000000-0000-4000-8000-000000000004', 'other@e2e.local');
insert into public.companies (id, name, created_by) values
  ('e2000000-0000-4000-8000-000000000001', 'Demo Staging (QA)', 'e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000002', 'Otra Empresa E2E', 'e1000000-0000-4000-8000-000000000004');
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  ('e2000000-0000-4000-8000-000000000001', 'cus_e2e_local', 'sub_e2e_local', 'pro', 'active'),
  ('e2000000-0000-4000-8000-000000000002', 'cus_e2e_other', 'sub_e2e_other', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'owner'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'admin'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'member'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000004', 'owner');
insert into public.clients (id, company_id, name, email) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Demo · Cliente Uno', 'uno@e2e.local'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'Cliente de Otra Empresa', 'otra@e2e.local');
insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'invoice', 'DEMO-0001', 'sent', 1500, 0, 1500, current_date - 10, current_date + 20),
  ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000004',
   'invoice', 'OTRA-0001', 'sent', 900, 0, 900, current_date - 5, current_date + 25);
