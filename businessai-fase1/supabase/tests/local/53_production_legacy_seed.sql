-- Scenario 53 · data as the CURRENT production app leaves it, on the inspected production shape (before 0005):
-- two companies, owners and a member, clients, issued and draft documents, a quote, a payment, a deletion audit row.
-- Company L1 has an active Stripe subscription (Pro); company L2 has none (the 0010 decision of RUNBOOK §9.0).
-- TEST-ONLY, local throw-away database. Written as postgres (the old policies would allow the same).
\set ON_ERROR_STOP 1
insert into auth.users (id, email) values
  ('c5300000-0000-4000-8000-000000000001', 'owner-l1@legacy.test'),
  ('c5300000-0000-4000-8000-000000000002', 'member-l1@legacy.test'),
  ('c5300000-0000-4000-8000-000000000003', 'owner-l2@legacy.test');
insert into public.companies (id, name, created_by) values
  ('c5310000-0000-4000-8000-000000000001', 'Legado Uno', 'c5300000-0000-4000-8000-000000000001'),
  ('c5310000-0000-4000-8000-000000000002', 'Legado Dos', 'c5300000-0000-4000-8000-000000000003');
insert into public.memberships (company_id, user_id, role) values
  ('c5310000-0000-4000-8000-000000000001', 'c5300000-0000-4000-8000-000000000001', 'owner'),
  ('c5310000-0000-4000-8000-000000000001', 'c5300000-0000-4000-8000-000000000002', 'member'),
  ('c5310000-0000-4000-8000-000000000002', 'c5300000-0000-4000-8000-000000000003', 'owner');
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  ('c5310000-0000-4000-8000-000000000001', 'cus_legacy_l1', 'sub_legacy_l1', 'pro', 'active');
insert into public.company_profiles (company_id, legal_name, email) values
  ('c5310000-0000-4000-8000-000000000001', 'Legado Uno LLC', 'facturas@legacy.test');
insert into public.clients (id, company_id, name, email) values
  ('c5320000-0000-4000-8000-000000000001', 'c5310000-0000-4000-8000-000000000001', 'Cliente Antiguo A', 'a@legacy.test'),
  ('c5320000-0000-4000-8000-000000000002', 'c5310000-0000-4000-8000-000000000001', 'Cliente Antiguo B', null),
  ('c5320000-0000-4000-8000-000000000003', 'c5310000-0000-4000-8000-000000000002', 'Cliente de Dos', null);
insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, issue_date, due_date, subtotal, tax, total, items) values
  ('c5330000-0000-4000-8000-000000000001', 'c5310000-0000-4000-8000-000000000001', 'c5320000-0000-4000-8000-000000000001', 'c5300000-0000-4000-8000-000000000001',
   'invoice', 'FAC-0001', 'sent', current_date - 40, current_date - 10, 100.00, 11.50, 111.50, '[{"description":"Servicio","quantity":1,"unit_price":100}]'),
  ('c5330000-0000-4000-8000-000000000002', 'c5310000-0000-4000-8000-000000000001', 'c5320000-0000-4000-8000-000000000002', 'c5300000-0000-4000-8000-000000000001',
   'invoice', 'FAC-0002', 'paid', current_date - 20, current_date + 10, 50.00, 0, 50.00, '[]'),
  ('c5330000-0000-4000-8000-000000000003', 'c5310000-0000-4000-8000-000000000001', 'c5320000-0000-4000-8000-000000000001', 'c5300000-0000-4000-8000-000000000002',
   'quote', 'COT-0001', 'draft', current_date, null, 75.00, 0, 75.00, '[]'),
  ('c5330000-0000-4000-8000-000000000004', 'c5310000-0000-4000-8000-000000000002', 'c5320000-0000-4000-8000-000000000003', 'c5300000-0000-4000-8000-000000000003',
   'invoice', '0001', 'sent', current_date - 5, current_date + 25, 20.00, 0, 20.00, '[]');
insert into public.payments (company_id, document_id, amount, payment_method, paid_at, created_by) values
  ('c5310000-0000-4000-8000-000000000001', 'c5330000-0000-4000-8000-000000000002', 50.00, 'transfer', now() - interval '15 days', 'c5300000-0000-4000-8000-000000000001');
