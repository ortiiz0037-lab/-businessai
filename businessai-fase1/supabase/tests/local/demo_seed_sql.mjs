// TEST-ONLY: prints the SQL equivalent of scripts/staging/demo-company.mjs
// "create" (same data generator, same tables and columns) for the local
// harness, so the demo data is checked against the real schema, triggers and
// constraints. Fixed ids; the owner and the tester are local test users.
import { buildDemoData, DEMO_COMPANY_NAME } from '../../../scripts/staging/demo-data.mjs'

let n = 0
const id = () => `d0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const OWNER = 'd1000000-0000-4000-8000-000000000001'
const TESTER = 'd1000000-0000-4000-8000-000000000002'
const COMPANY = 'd2000000-0000-4000-8000-000000000001'
const data = buildDemoData(new Date(), id)
const TAG = '$json' + '$'
const j = (v) => `${TAG}${JSON.stringify(v)}${TAG}::jsonb`

console.log(`begin;
insert into auth.users (id, email) values ('${OWNER}', 'demo-owner@businessai-demo.example.test'), ('${TESTER}', 'tester@local.test');
insert into public.companies (id, name, created_by) values ('${COMPANY}', '${DEMO_COMPANY_NAME}', '${OWNER}');
insert into public.memberships (company_id, user_id, role) values ('${COMPANY}', '${OWNER}', 'owner');
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status)
  values ('${COMPANY}', 'cus_demo_qa_local', 'sub_demo_qa_local', 'premium', 'active');
insert into public.clients (id, company_id, name, business_name, email, city, state, status, notes, created_at)
  select x.id, '${COMPANY}', x.name, x.business_name, x.email, x.city, x.state, x.status, x.notes, x.created_at
  from jsonb_to_recordset(${j(data.clients)}) as x(id uuid, name text, business_name text, email text, city text, state text, status text, notes text, created_at timestamptz);
insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, title, status, issue_date, due_date, subtotal, tax, total, notes, items, metadata, created_at)
  select x.id, '${COMPANY}', x.client_id, '${OWNER}', x.document_type, x.document_number, x.title, x.status, x.issue_date, x.due_date, x.subtotal, x.tax, x.total, x.notes, x.items, x.metadata, x.created_at
  from jsonb_to_recordset(${j(data.documents)}) as x(id uuid, client_id uuid, document_type text, document_number text, title text, status text, issue_date date, due_date date, subtotal numeric, tax numeric, total numeric, notes text, items jsonb, metadata jsonb, created_at timestamptz);
insert into public.payments (id, company_id, document_id, amount, payment_method, reference, paid_at, created_by, created_at)
  select x.id, '${COMPANY}', x.document_id, x.amount, x.payment_method, x.reference, x.paid_at, '${OWNER}', x.created_at
  from jsonb_to_recordset(${j(data.payments)}) as x(id uuid, document_id uuid, amount numeric, payment_method text, reference text, paid_at timestamptz, created_at timestamptz);
insert into public.memberships (company_id, user_id, role) values ('${COMPANY}', '${TESTER}', 'admin');
commit;
-- counts: ${data.clients.length} ${data.documents.length} ${data.payments.length}`)
