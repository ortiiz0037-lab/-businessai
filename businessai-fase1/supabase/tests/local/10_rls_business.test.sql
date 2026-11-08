-- RLS test suite on the INSPECTED schema (01_business_fixture.sql) after
-- migrations 0005 (tables) and 0007 (storage). Every DO block is one transaction: `set local role` +
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

-- Each owner creates data through RLS with the same columns the app sends.
do $$ declare cl uuid; doc uuid; doc2 uuid; pay uuid; begin
  perform t.as_user('userA'); set local role authenticated;
  insert into public.clients (company_id, name, status) values (t.id('coA'), 'Cliente A', 'active') returning id into cl;
  insert into public.documents (company_id, document_type, title, document_number, client_id, issue_date,
                                subtotal, tax, total, status, notes)
    values (t.id('coA'), 'invoice', 'Factura - Cliente A', 'FAC-2026-AAAA0001', cl, current_date,
            100, 0, 100, 'sent', 'n') returning id into doc;
  insert into public.documents (company_id, document_type, title, document_number, client_id, status)
    values (t.id('coA'), 'quote', 'Cotización sin pagos', 'COT-2026-AAAA0002', cl, 'draft') returning id into doc2;
  insert into public.payments (company_id, document_id, amount, payment_method, created_by)
    values (t.id('coA'), doc, 100, 'manual', t.id('userA')) returning id into pay;
  reset role;
  insert into t.ctx values ('clA', cl), ('docA', doc), ('docA2', doc2), ('payA', pay);
end $$;
do $$ declare cl uuid; doc uuid; pay uuid; begin
  perform t.as_user('userB'); set local role authenticated;
  insert into public.clients (company_id, name) values (t.id('coB'), 'Cliente B') returning id into cl;
  insert into public.documents (company_id, document_type, title, document_number, client_id, total, status)
    values (t.id('coB'), 'invoice', 'Factura - Cliente B', 'FAC-2026-BBBB0001', cl, 200, 'sent') returning id into doc;
  insert into public.payments (company_id, document_id, amount, payment_method, created_by)
    values (t.id('coB'), doc, 200, 'manual', t.id('userB')) returning id into pay;
  reset role;
  insert into t.ctx values ('clB', cl), ('docB', doc), ('payB', pay);
end $$;

-- ------------------------------------------------------------- app flows
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  update public.documents set status = 'paid' where id = t.id('docA'); get diagnostics n = row_count;
  perform t.ok(n = 1, 'app flow: owner marks own invoice as paid');
  update public.clients set notes = 'ok' where id = t.id('clA'); get diagnostics n = row_count;
  perform t.ok(n = 1, 'app flow: member company can edit its client');
  perform t.ok((select count(*) from public.payments where document_id = t.id('docA')) = 1,
               'app flow: payments page reads the payment of its document');
end $$;

-- ------------------------------------------------------------- isolation
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  perform t.ok((select array_agg(id) from public.clients)   = array[t.id('clA')],  'A sees only its own clients');
  perform t.ok((select count(*) from public.documents where company_id <> t.id('coA')) = 0, 'A sees only its own documents');
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
    insert into public.documents (company_id, document_type, document_number) values (t.id('coB'), 'invoice', 'X-1');
    perform t.ok(false, 'A cannot insert a document into B');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot insert a document into B'); end;

  begin
    insert into public.documents (company_id, client_id, document_type, document_number)
      values (t.id('coA'), t.id('clB'), 'invoice', 'X-2');
    perform t.ok(false, 'A cannot attach B''s client to its own document');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot attach B''s client to its own document'); end;

  begin
    insert into public.documents (company_id, document_type, document_number, created_by)
      values (t.id('coA'), 'invoice', 'X-3', t.id('userB'));
    perform t.ok(false, 'A cannot create a document as another user (existing rule kept)');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot create a document as another user (existing rule kept)'); end;

  begin
    insert into public.payments (company_id, document_id, amount, created_by)
      values (t.id('coA'), t.id('docB'), 1, t.id('userA'));
    perform t.ok(false, 'A cannot record a payment against B''s document');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot record a payment against B''s document'); end;

  begin
    insert into public.payments (company_id, document_id, amount, created_by)
      values (t.id('coA'), t.id('docA'), 1, t.id('userB'));
    perform t.ok(false, 'A cannot record a payment as another user');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot record a payment as another user'); end;

  begin
    insert into public.payments (company_id, document_id, amount)
      values (t.id('coA'), t.id('docA'), 1);
    perform t.ok(false, 'A cannot record a payment without created_by');
  exception when insufficient_privilege then perform t.ok(true, 'A cannot record a payment without created_by'); end;

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
do $$ begin
  perform t.ok((select amount from public.payments where id = t.id('payA')) = 100, 'payment A unchanged (verified as superuser)');
  perform t.ok(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payments'
                           and cmd in ('UPDATE', 'DELETE', 'ALL')), 'payments has no update/delete/all policy');
end $$;

-- ----------------------------------------------------------------- roles
do $$ declare n int; begin
  perform t.as_user('userC'); set local role authenticated;
  perform t.ok(exists (select 1 from public.documents where id = t.id('docA')), 'member C reads company A documents');
  perform t.ok(not exists (select 1 from public.documents where id = t.id('docB')), 'member C cannot read company B documents');
  insert into public.clients (company_id, name) values (t.id('coA'), 'Cliente de C');
  perform t.ok(true, 'member C can create a client in A');
  delete from public.documents where id = t.id('docA2'); get diagnostics n = row_count;
  perform t.ok(n = 0, 'member C cannot delete documents (owner/admin only)');
  delete from public.clients where id = t.id('clA');     get diagnostics n = row_count;
  perform t.ok(n = 0, 'member C cannot delete clients (owner/admin only)');
end $$;

-- ------------------------------------------------- document_deletion_audit
do $$ begin
  perform t.ok((select count(*) from pg_policies where schemaname = 'public'
                and tablename = 'document_deletion_audit') = 2, 'audit: duplicate policies removed (2 remain)');
  perform t.ok((select array_agg(policyname order by policyname) from pg_policies where schemaname = 'public'
                and tablename = 'document_deletion_audit') = array['audit_insert_company', 'audit_select_company']::name[],
               'audit: audit_insert_company and audit_select_company kept');
end $$;
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  insert into public.document_deletion_audit (company_id, document_id, reason, deleted_by)
    values (t.id('coA'), gen_random_uuid(), 'test', t.id('userA'));
  perform t.ok(true, 'audit: member records a deletion in its company');
  begin
    insert into public.document_deletion_audit (company_id, document_id, reason, deleted_by)
      values (t.id('coB'), gen_random_uuid(), 'test', t.id('userA'));
    perform t.ok(false, 'audit: cannot write into another company');
  exception when insufficient_privilege then perform t.ok(true, 'audit: cannot write into another company'); end;
  begin
    insert into public.document_deletion_audit (company_id, document_id, reason, deleted_by)
      values (t.id('coA'), gen_random_uuid(), 'test', t.id('userB'));
    perform t.ok(false, 'audit: cannot record as another user');
  exception when insufficient_privilege then perform t.ok(true, 'audit: cannot record as another user'); end;
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
  perform t.ok((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
                and policyname not like 'ba\_%') = 0, 'storage: all 11 previous Company-assets policies replaced');
  perform t.ok(not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                and (coalesce(qual, '') || coalesce(with_check, '')) ~ '''(company-assets|COMPANY-ASSETS)'''),
               'storage: no policy targets a wrong-case bucket id');
end $$;
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  insert into storage.objects (bucket_id, name, owner) values ('Company-assets', t.id('coA') || '/logo-1.png', t.id('userA'));
  perform t.ok(true, 'owner A uploads into its company folder (as today)');
  perform t.ok(exists (select 1 from storage.objects where name = t.id('coA') || '/logo-1.png'),
               'owner A can read its company assets (as today)');
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
  begin
    insert into storage.objects (bucket_id, name) values ('company-assets', t.id('coA') || '/x.png');
    perform t.ok(false, 'A cannot write to a wrong-case bucket id');
  exception when insufficient_privilege or foreign_key_violation then
    perform t.ok(true, 'A cannot write to a wrong-case bucket id'); end;
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
  perform t.ok(not exists (select 1 from storage.objects where name = t.id('coA') || '/logo-1.png'),
               'member C cannot list company A assets (owner/admin only, as today)');
  begin
    insert into storage.objects (bucket_id, name) values ('Company-assets', t.id('coA') || '/logo-c.png');
    perform t.ok(false, 'member C cannot upload branding (owner/admin only, as today)');
  exception when insufficient_privilege then perform t.ok(true, 'member C cannot upload branding (owner/admin only, as today)'); end;
end $$;

-- ------------------------------------------------ TRUNCATE (bypasses RLS)
do $$ declare tb text; begin
  perform t.as_user('userA'); set local role authenticated;
  foreach tb in array array['clients','documents','payments','companies','memberships',
                            'company_profiles','company_subscriptions','stripe_events',
                            'document_deletion_audit'] loop
    begin
      execute format('truncate table public.%I cascade', tb);
      perform t.ok(false, 'authenticated cannot truncate ' || tb);
    exception when insufficient_privilege then perform t.ok(true, 'authenticated cannot truncate ' || tb); end;
  end loop;
end $$;
do $$ declare tb text; begin
  set local role anon;
  foreach tb in array array['clients','documents','payments','document_deletion_audit'] loop
    begin
      execute format('truncate table public.%I cascade', tb);
      perform t.ok(false, 'anon cannot truncate ' || tb);
    exception when insufficient_privilege then perform t.ok(true, 'anon cannot truncate ' || tb); end;
  end loop;
end $$;
do $$ begin
  perform t.ok((select count(*) from public.payments) >= 2, 'payments still present after truncate attempts');
end $$;

-- -------------------------------------------- functions (unchanged by 0005)
do $$ begin
  perform t.ok(has_function_privilege('anon', 'public.can_edit_company_profile(uuid)', 'EXECUTE'),
               'can_edit_company_profile grants untouched by 0005 (pending source review)');
  perform t.ok(not has_function_privilege('anon', 'public.is_company_member(uuid)', 'EXECUTE'),
               'anon still cannot execute is_company_member');
end $$;

-- ------------------------------------------------- existing tables (0001/0003/0004)
do $$ begin
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
