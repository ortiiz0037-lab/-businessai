-- Application compatibility probe. Replays, as the API roles, every database
-- and storage operation the application performs (new code in PR #1 and the
-- code currently on main), and records the outcome. run.sh executes it on
-- the inspected state and after each migration and compares the outcomes
-- with supabase/tests/local/app_compat_expected.txt.
-- Output lines: <operation>|<outcome>  (ok, zero_rows, or the SQLSTATE name)
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create schema c;
create table c.ctx (key text primary key, id uuid not null);
create table c.result (n serial, op text not null, outcome text not null);
grant usage on schema c to anon, authenticated;
grant select on c.ctx to anon, authenticated;
grant insert on c.result to anon, authenticated;
grant usage on sequence c.result_n_seq to anon, authenticated;
create function c.id(k text) returns uuid language sql stable as $$ select id from c.ctx where key = k $$;
create function c.as_user(k text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', c.id(k), 'role', 'authenticated')::text, true);
end $$;
create function c.rec(op text, outcome text) returns void language sql as $$
  insert into c.result (op, outcome) values (op, outcome)
$$;
grant execute on all functions in schema c to anon, authenticated;

insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'owner@example.test'),
  ('c1000000-0000-4000-8000-000000000003', 'member@example.test'),
  ('d1000000-0000-4000-8000-000000000004', 'new@example.test');
insert into c.ctx values ('owner', 'a1000000-0000-4000-8000-000000000001'),
                         ('member', 'c1000000-0000-4000-8000-000000000003'),
                         ('newuser', 'd1000000-0000-4000-8000-000000000004');

-- onboarding: rpc('create_company')
do $$ declare cid uuid; begin
  perform c.as_user('owner'); set local role authenticated;
  cid := public.create_company('Empresa Compat'); reset role;
  insert into c.ctx values ('co', cid);
  perform c.rec('rpc create_company', 'ok');
exception when others then reset role; perform c.rec('rpc create_company', sqlstate); end $$;
insert into public.memberships (company_id, user_id, role) values (c.id('co'), c.id('member'), 'member');

-- Each operation: one transaction, outcome recorded.
do $$ begin perform c.as_user('owner'); set local role authenticated;
  perform 1 from public.memberships where user_id = c.id('owner') order by created_at limit 1;
  perform c.rec('session: memberships of user', 'ok');
exception when others then perform c.rec('session: memberships of user', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  -- settings save = PostgREST upsert (insert ... on conflict do update)
  insert into public.company_profiles (company_id, display_name, legal_name, state, primary_color, secondary_color)
    values (c.id('co'), 'Empresa Compat', null, 'Puerto Rico', '#2563EB', '#0F172A')
    on conflict (company_id) do update set display_name = excluded.display_name;
  insert into public.company_profiles (company_id, display_name)
    values (c.id('co'), 'Empresa Compat 2')
    on conflict (company_id) do update set display_name = excluded.display_name;
  perform c.rec('settings: upsert company profile (twice)', 'ok');
exception when others then perform c.rec('settings: upsert company profile (twice)', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  select count(*) into n from public.company_profiles where company_id = c.id('co');
  perform c.rec('settings/documents: read company profile', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('settings/documents: read company profile', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  select count(*) into n from public.companies where id = c.id('co');
  perform c.rec('dashboard: read company name', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('dashboard: read company name', sqlstate); end $$;

do $$ declare cl uuid; begin perform c.as_user('owner'); set local role authenticated;
  insert into public.clients (company_id, name, business_name, email, status)
    values (c.id('co'), 'Cliente Compat', 'Negocio', 'c@example.test', 'active') returning id into cl;
  reset role; insert into c.ctx values ('client', cl);
  perform c.rec('clients: create', 'ok');
exception when others then reset role; perform c.rec('clients: create', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  select count(*) into n from public.clients
   where company_id = c.id('co') and (name ilike '%compat%' or email ilike '%compat%');
  perform c.rec('clients: list + search', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('clients: list + search', sqlstate); end $$;

do $$ declare d uuid; d2 uuid; begin perform c.as_user('owner'); set local role authenticated;
  insert into public.documents (company_id, document_type, title, document_number, client_id, issue_date,
                                due_date, subtotal, tax, total, status, notes)
    values (c.id('co'), 'invoice', 'Factura - Negocio', 'FAC-2026-COMPAT01', c.id('client'), current_date,
            null, 100, 11.5, 111.5, 'draft', 'FACTURA — PARTIDAS') returning id into d;
  insert into public.documents (company_id, document_type, title, document_number, status, notes)
    values (c.id('co'), 'letter', 'Carta', 'CARTA-2026-COMPAT02', 'draft', 'Hola') returning id into d2;
  reset role; insert into c.ctx values ('invoice', d), ('letter', d2);
  perform c.rec('documents: create invoice + letter', 'ok');
exception when others then reset role; perform c.rec('documents: create invoice + letter', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  select count(*) into n from public.documents where id = c.id('invoice');
  perform c.rec('documents: open by id (RLS, no company filter)', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('documents: open by id (RLS, no company filter)', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  update public.documents set status = 'sent' where id = c.id('invoice') and company_id = c.id('co');
  get diagnostics n = row_count;
  perform c.rec('documents: mark as sent', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('documents: mark as sent', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  perform 1 from public.payments where company_id = c.id('co') and document_id = c.id('invoice') limit 1;
  insert into public.payments (company_id, document_id, amount, payment_method, created_by)
    values (c.id('co'), c.id('invoice'), 111.5, 'manual', c.id('owner'));
  update public.documents set status = 'paid' where id = c.id('invoice') and company_id = c.id('co');
  get diagnostics n = row_count;
  perform c.rec('documents: mark as paid (records payment)', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('documents: mark as paid (records payment)', sqlstate); end $$;

do $$ declare n int; m int; begin perform c.as_user('owner'); set local role authenticated;
  select count(*) into n from public.payments where company_id = c.id('co');
  select count(*) into m from public.documents where company_id = c.id('co') and id = any (array[c.id('invoice')]);
  perform c.rec('payments page: list + linked documents', case when n = 1 and m = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('payments page: list + linked documents', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('member'); set local role authenticated;
  select count(*) into n from public.documents where company_id = c.id('co');
  perform c.rec('member: read company documents', case when n = 2 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('member: read company documents', sqlstate); end $$;

-- delete with `.delete().select('id')` (DELETE ... RETURNING)
do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  with del as (delete from public.documents where id = c.id('letter') and company_id = c.id('co') returning id)
  select count(*) into n from del;
  perform c.rec('documents: delete one without payments', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('documents: delete one without payments', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  with del as (delete from public.documents where id = c.id('invoice') and company_id = c.id('co') returning id)
  select count(*) into n from del;
  perform c.rec('documents: delete one WITH payments', case when n = 1 then 'ok-erased' else 'zero_rows' end);
exception when others then perform c.rec('documents: delete one WITH payments', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
    values ('Company-assets', c.id('co') || '/logo-0b6e1c2a-0000-4000-8000-000000000001.png', c.id('owner'));
  update public.company_profiles set logo_url = 'https://x.supabase.co/storage/v1/object/public/Company-assets/logo.png'
   where company_id = c.id('co');
  get diagnostics n = row_count;
  perform c.rec('branding: upload logo + save logo_url', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('branding: upload logo + save logo_url', sqlstate); end $$;

do $$ begin perform c.as_user('owner'); set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
    values ('Company-assets', c.id('co') || '/signature-1731000000000.png', c.id('owner'));
  perform c.rec('main code: upload signature to public bucket', 'ok');
exception when others then perform c.rec('main code: upload signature to public bucket', sqlstate); end $$;

do $$ declare n int; begin perform c.as_user('owner'); set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
    values ('Company-signatures', c.id('co') || '/signature-0b6e1c2a-0000-4000-8000-000000000002.png', c.id('owner'));
  update public.company_profiles
     set signature_url = 'private:Company-signatures/' || c.id('co') || '/signature-0b6e1c2a-0000-4000-8000-000000000002.png'
   where company_id = c.id('co');
  get diagnostics n = row_count;
  perform c.rec('PR code: upload signature to private bucket', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('PR code: upload signature to private bucket', sqlstate); end $$;

-- createSignedUrl requires SELECT on the object for the requester.
do $$ declare n int; begin perform c.as_user('member'); set local role authenticated;
  select count(*) into n from storage.objects where bucket_id = 'Company-signatures' and name like c.id('co') || '/%';
  perform c.rec('PR code: member can sign the signature (documents)', case when n = 1 then 'ok' else 'zero_rows' end);
exception when others then perform c.rec('PR code: member can sign the signature (documents)', sqlstate); end $$;

do $$ begin perform c.as_user('owner'); set local role authenticated;
  perform 1 from storage.buckets;
  perform c.rec('branding: storage diagnostic (listBuckets)', 'ok');
exception when others then perform c.rec('branding: storage diagnostic (listBuckets)', sqlstate); end $$;

reset role;
\pset format unaligned
\pset tuples_only on
select op || '|' || outcome from c.result order by n;
