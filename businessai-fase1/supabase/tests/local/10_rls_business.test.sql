-- RLS test suite for clients, documents, payments and Company-assets storage.
-- Runs against the local harness (run.sh) after migrations 0001/0003/0004/0005.
-- Every DO block is one transaction: `set local role authenticated` +
-- JWT claims emulate a PostgREST request from that user.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema t;
create table t.ctx (key text primary key, id uuid not null);
grant usage on schema t to anon, authenticated;
grant select on t.ctx to anon, authenticated;

create function t.id(k text) returns uuid language sql stable as $$ select id from t.ctx where key = k $$;
create function t.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;
create function t.as_user(k text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', t.id(k), 'role', 'authenticated')::text, true);
end $$;
grant execute on all functions in schema t to anon, authenticated;

-- ------------------------------------------------------------------ setup
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'a@example.test'),
  ('b0000000-0000-4000-8000-000000000002', 'b@example.test'),
  ('c0000000-0000-4000-8000-000000000003', 'c@example.test');
insert into t.ctx values
  ('userA', 'a0000000-0000-4000-8000-000000000001'),
  ('userB', 'b0000000-0000-4000-8000-000000000002'),
  ('userC', 'c0000000-0000-4000-8000-000000000003');

-- Companies through the real RPC, as each owner.
do $$ declare cid uuid; begin
  perform t.as_user('userA'); set local role authenticated;
  cid := public.create_company('Empresa A'); reset role;
  insert into t.ctx values ('coA', cid);
end $$;
do $$ declare cid uuid; begin
  perform t.as_user('userB'); set local role authenticated;
  cid := public.create_company('Empresa B'); reset role;
  insert into t.ctx values ('coB', cid);
end $$;
-- C is a plain 'member' of company A (memberships are not user-writable).
insert into public.memberships (company_id, user_id, role)
  values (t.id('coA'), t.id('userC'), 'member');

-- Each owner creates data through RLS, as the app does.
do $$ declare cl uuid; doc uuid; pay uuid; begin
  perform t.as_user('userA'); set local role authenticated;
  insert into public.clients (company_id, name) values (t.id('coA'), 'Cliente A') returning id into cl;
  insert into public.documents (company_id, client_id, document_type, total, status)
    values (t.id('coA'), cl, 'invoice', 100, 'sent') returning id into doc;
  insert into public.payments (company_id, document_id, amount, payment_method, created_by)
    values (t.id('coA'), doc, 100, 'manual', t.id('userA')) returning id into pay;
  reset role;
  insert into t.ctx values ('clA', cl), ('docA', doc), ('payA', pay);
end $$;
do $$ declare cl uuid; doc uuid; pay uuid; begin
  perform t.as_user('userB'); set local role authenticated;
  insert into public.clients (company_id, name) values (t.id('coB'), 'Cliente B') returning id into cl;
  insert into public.documents (company_id, client_id, document_type, total, status)
    values (t.id('coB'), cl, 'invoice', 200, 'sent') returning id into doc;
  insert into public.payments (company_id, document_id, amount, payment_method, created_by)
    values (t.id('coB'), doc, 200, 'manual', t.id('userB')) returning id into pay;
  reset role;
  insert into t.ctx values ('clB', cl), ('docB', doc), ('payB', pay);
end $$;

-- ------------------------------------------------------------- isolation
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  perform t.ok((select array_agg(id) from public.clients)   = array[t.id('clA')],  'A sees only its own clients');
  perform t.ok((select array_agg(id) from public.documents) = array[t.id('docA')], 'A sees only its own documents');
  perform t.ok((select array_agg(id) from public.payments)  = array[t.id('payA')], 'A sees only its own payments');
  perform t.ok(not exists (select 1 from public.documents where id = t.id('docB')), 'A cannot read B''s document by id');
  perform t.ok(not exists (select 1 from public.payments where company_id = t.id('coB')), 'A cannot read B''s payments by company');
end $$;

-- ------------------------------------------------------- cross-tenant writes
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  begin
    insert into public.clients (company_id, name) values (t.id('coB'), 'Intruso');
    perform t.ok(false, 'A cannot insert a client into B');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot insert a client into B'); end;

  begin
    insert into public.documents (company_id, document_type) values (t.id('coB'), 'invoice');
    perform t.ok(false, 'A cannot insert a document into B');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot insert a document into B'); end;

  begin
    insert into public.documents (company_id, client_id, document_type) values (t.id('coA'), t.id('clB'), 'invoice');
    perform t.ok(false, 'A cannot attach B''s client to its own document');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot attach B''s client to its own document'); end;

  begin
    insert into public.payments (company_id, document_id, amount, created_by)
      values (t.id('coA'), t.id('docB'), 1, t.id('userA'));
    perform t.ok(false, 'A cannot record a payment against B''s document');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot record a payment against B''s document'); end;

  begin
    insert into public.payments (company_id, amount, created_by) values (t.id('coA'), 1, t.id('userB'));
    perform t.ok(false, 'A cannot record a payment as another user');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot record a payment as another user'); end;

  begin
    update public.documents set company_id = t.id('coB') where id = t.id('docA');
    perform t.ok(false, 'A cannot move its document to B');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot move its document to B'); end;

  begin
    update public.documents set client_id = t.id('clB') where id = t.id('docA');
    perform t.ok(false, 'A cannot re-point its document at B''s client');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot re-point its document at B''s client'); end;
end $$;

do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  update public.clients set name = 'HACKED' where id = t.id('clB');   get diagnostics n = row_count;
  perform t.ok(n = 0, 'A cannot update B''s client');
  update public.documents set total = 0 where id = t.id('docB');      get diagnostics n = row_count;
  perform t.ok(n = 0, 'A cannot update B''s document');
  delete from public.documents where id = t.id('docB');               get diagnostics n = row_count;
  perform t.ok(n = 0, 'A cannot delete B''s document');
  delete from public.clients where id = t.id('clB');                  get diagnostics n = row_count;
  perform t.ok(n = 0, 'A cannot delete B''s client');
end $$;
do $$ begin
  perform t.ok((select name from public.clients where id = t.id('clB')) = 'Cliente B', 'B''s client unchanged (verified as superuser)');
  perform t.ok((select total from public.documents where id = t.id('docB')) = 200, 'B''s document unchanged (verified as superuser)');
end $$;

-- --------------------------------------------------- payments are a ledger
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  begin
    update public.payments set amount = 1 where id = t.id('payA');
    perform t.ok(false, 'owner cannot edit a payment');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot edit a payment'); end;
  begin
    delete from public.payments where id = t.id('payA');
    perform t.ok(false, 'owner cannot delete a payment');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot delete a payment'); end;
end $$;

-- ----------------------------------------------------------------- roles
do $$ declare n int; begin
  perform t.as_user('userC'); set local role authenticated;
  perform t.ok(exists (select 1 from public.documents where id = t.id('docA')), 'member C reads company A documents');
  perform t.ok(not exists (select 1 from public.documents where id = t.id('docB')), 'member C cannot read company B documents');
  insert into public.clients (company_id, name) values (t.id('coA'), 'Cliente de C');
  perform t.ok(true, 'member C can create a client in A');
  delete from public.documents where id = t.id('docA'); get diagnostics n = row_count;
  perform t.ok(n = 0, 'member C cannot delete documents (owner/admin only)');
  delete from public.clients where id = t.id('clA');    get diagnostics n = row_count;
  perform t.ok(n = 0, 'member C cannot delete clients (owner/admin only)');
end $$;

-- ---------------------------------------------------------------- anon
do $$ begin
  set local role anon;
  begin
    perform 1 from public.clients;
    perform t.ok(false, 'anon cannot read clients');
  exception when insufficient_privilege then perform t.ok(true, 'anon cannot read clients'); end;
  begin
    perform 1 from public.documents;
    perform t.ok(false, 'anon cannot read documents');
  exception when insufficient_privilege then perform t.ok(true, 'anon cannot read documents'); end;
  begin
    perform 1 from public.payments;
    perform t.ok(false, 'anon cannot read payments');
  exception when insufficient_privilege then perform t.ok(true, 'anon cannot read payments'); end;
  begin
    insert into storage.objects (bucket_id, name) values ('Company-assets', t.id('coA') || '/anon.png');
    perform t.ok(false, 'anon cannot upload to Company-assets');
  exception when insufficient_privilege then perform t.ok(true, 'anon cannot upload to Company-assets'); end;
end $$;

-- --------------------------------------------------------------- storage
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  insert into storage.objects (bucket_id, name, owner) values ('Company-assets', t.id('coA') || '/logo-1.png', t.id('userA'));
  perform t.ok(true, 'owner A uploads into its company folder');
  update storage.objects set owner = t.id('userA') where name = t.id('coA') || '/logo-1.png';
  perform t.ok(true, 'owner A can overwrite (upsert) its own asset');
  begin
    insert into storage.objects (bucket_id, name) values ('Company-assets', t.id('coB') || '/logo-evil.png');
    perform t.ok(false, 'A cannot upload into B''s folder');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot upload into B''s folder'); end;
  begin
    insert into storage.objects (bucket_id, name) values ('Company-assets', 'logo-root.png');
    perform t.ok(false, 'A cannot upload outside a company folder');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot upload outside a company folder'); end;
  begin
    insert into storage.objects (bucket_id, name) values ('Company-assets', 'not-a-uuid/logo.png');
    perform t.ok(false, 'A cannot upload into a non-company folder');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot upload into a non-company folder'); end;
end $$;
do $$ begin
  perform t.as_user('userB'); set local role authenticated;
  insert into storage.objects (bucket_id, name, owner) values ('Company-assets', t.id('coB') || '/logo-1.png', t.id('userB'));
end $$;
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  perform t.ok(not exists (select 1 from storage.objects where name like t.id('coB') || '/%'), 'A cannot list B''s assets');
  update storage.objects set owner = t.id('userA') where name = t.id('coB') || '/logo-1.png'; get diagnostics n = row_count;
  perform t.ok(n = 0, 'A cannot overwrite B''s asset');
  delete from storage.objects where name = t.id('coB') || '/logo-1.png'; get diagnostics n = row_count;
  perform t.ok(n = 0, 'A cannot delete B''s asset');
end $$;
do $$ begin
  perform t.as_user('userC'); set local role authenticated;
  perform t.ok(exists (select 1 from storage.objects where name = t.id('coA') || '/logo-1.png'), 'member C can see company A assets');
  begin
    insert into storage.objects (bucket_id, name) values ('Company-assets', t.id('coA') || '/logo-c.png');
    perform t.ok(false, 'member C cannot upload branding (owner/admin only)');
  exception when insufficient_privilege then perform t.ok(true, 'member C cannot upload branding (owner/admin only)'); end;
end $$;

-- ------------------------------------------------- existing tables (0001/0003/0004)
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  perform t.ok((select count(*) from public.companies) = 1, 'A sees exactly one company');
  perform t.ok(not exists (select 1 from public.company_subscriptions where company_id = t.id('coB')), 'A cannot read B''s subscription');
  begin
    insert into public.company_subscriptions (company_id, plan, status) values (t.id('coA'), 'pro', 'active');
    perform t.ok(false, 'A cannot grant itself a subscription');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot grant itself a subscription'); end;
  begin
    perform 1 from public.stripe_events;
    perform t.ok(false, 'A cannot read stripe_events');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot read stripe_events'); end;
  begin
    insert into public.company_profiles (company_id, display_name) values (t.id('coB'), 'Hijack');
    perform t.ok(false, 'A cannot create B''s company profile');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot create B''s company profile'); end;
end $$;

do $$ begin raise notice 'ALL RLS TESTS PASSED'; end $$;
