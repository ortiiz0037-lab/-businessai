-- Banking, payments & receipt capture (0042): provider connections (token stored
-- encrypted, never readable), signed syncs and webhooks (idempotent), deposits
-- applied to invoices with human decisions (split, partial, several deposits,
-- existing payments, no duplicates), branches, manual payments with evidence,
-- receipt captures in a private bucket, isolation, rollback guards.
-- TEST-ONLY, local throw-away database with 0014a … 0042. Schema bn.
-- The provider here is a TEST DOUBLE: no real bank, transaction or OCR result.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema bn;
create table bn.ctx (key text primary key, val text not null);
create function bn.id(k text) returns uuid language sql stable as $$ select val::uuid from bn.ctx where key = k $$;
create table bn.failures (msg text);
create function bn.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into bn.failures values (msg); end if;
end $$;
grant usage on schema bn to authenticated, anon;
grant select on bn.ctx to authenticated, anon;
grant execute on all functions in schema bn to authenticated, anon;
create function bn.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', bn.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function bn.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', bn.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function bn.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
-- the server without a user (webhooks, automatic syncs): role anon, no claims
create function bn.anon(q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin execute q into r; exception when others then r := 'ERR:' || sqlerrm; end;
  reset role;
  return r;
end $$;
create function bn.acct(co text, c text) returns uuid language sql volatile as $$ select id from public.ledger_accounts where company_id = bn.id(co) and code = c $$;
create function bn.bal(co text, c text) returns bigint language sql volatile as $$ select balance_cents from public.ledger_trial_balance(bn.id(co)) where code = c $$;
create function bn.d(n int) returns text language sql stable as $$ select (public.ba_today() + n)::text $$;
create function bn.sha(t text) returns text language sql immutable as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function bn.mac(msg text) returns text language sql as $$
  select encode(ba_private.hmac_sha256(decode((select val from bn.ctx where key = 'secret'), 'base64'), convert_to(msg, 'UTF8')), 'hex') $$;
create function bn.now() returns bigint language sql stable as $$ select extract(epoch from now())::bigint $$;
-- signed calls (as the server computes them)
create function bn.connect_sql(who text, co text, payload text, n uuid default gen_random_uuid(), t bigint default null, k text default 'k1') returns text language sql as $$
  select format('select public.bank_connection_save(%L, %L, %L, %s, %L, %L)', bn.id(co), payload, k, coalesce(t, bn.now()), n,
    bn.mac(concat_ws('|', 'bank_connect', 'v1', k, lower(bn.id(who)::text), bn.id(co)::text, coalesce(t, bn.now())::text, n::text, ba_private.sha_hex(payload)))) $$;
create function bn.ctx_sql(conn uuid, n uuid default gen_random_uuid()) returns text language sql as $$
  select format('select public.bank_sync_context(%L, %L, %s, %L, %L)::text', conn, 'k1', bn.now(), n,
    bn.mac(concat_ws('|', 'bank_ctx', 'v1', 'k1', conn::text, bn.now()::text, n::text))) $$;
create function bn.apply_sql(conn uuid, payload text, n uuid default gen_random_uuid()) returns text language sql as $$
  select format('select public.bank_sync_apply(%L, %L, %L, %s, %L, %L)::text', conn, payload, 'k1', bn.now(), n,
    bn.mac(concat_ws('|', 'bank_apply', 'v1', 'k1', conn::text, bn.now()::text, n::text, ba_private.sha_hex(payload)))) $$;
create function bn.hook_sql(payload text, n uuid default gen_random_uuid()) returns text language sql as $$
  select format('select public.bank_webhook_record(%L, %L, %L, %L, %s, %L, %L)::text', 'plaid', bn.sha(payload), payload, 'k1', bn.now(), n,
    bn.mac(concat_ws('|', 'bank_webhook', 'v1', 'k1', 'plaid', bn.sha(payload), bn.now()::text, n::text, ba_private.sha_hex(payload)))) $$;
create function bn.disc_sql(who text, conn uuid, n uuid default gen_random_uuid()) returns text language sql as $$
  select format('select public.bank_connection_disconnect(%L, %L, %s, %L, %L)', conn, 'k1', bn.now(), n,
    bn.mac(concat_ws('|', 'bank_disconnect', 'v1', 'k1', lower(bn.id(who)::text), conn::text, bn.now()::text, n::text))) $$;
create function bn.txn(day int, cents bigint, descr text, txid text, ref text default null) returns jsonb language sql stable as $$
  select jsonb_build_object('date', bn.d(day), 'amount_cents', cents::text, 'description', descr, 'reference', ref, 'bank_txn_id', txid, 'raw', jsonb_build_object('test_double', true)) $$;
create function bn.line(txid text) returns uuid language sql volatile as $$ select id from public.bank_lines where bank_txn_id = txid order by created_at desc limit 1 $$;
create function bn.invoice(who text, co text, inv text, total numeric) returns text language sql as $$
  select bn.err(who, format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, total, issue_date, due_date)
    values (%L, %L, %L, %L, %L, %L, %L, %s, %s, %L, %L)', bn.id(inv), bn.id(co), bn.id('c_' || co), bn.id(who), 'invoice', 'x', 'sent', total, total, bn.d(-30), bn.d(-1))) $$;
create function bn.balance_due(inv text) returns numeric language sql volatile as $$
  select d.total - coalesce((select sum(p.amount) from public.payments p where p.document_id = d.id and p.voided_at is null), 0) from public.documents d where d.id = bn.id(inv) $$;

insert into bn.ctx values
  ('owner', 'b1000000-0000-4000-8000-0000000000c1'), ('admin', 'b1000000-0000-4000-8000-0000000000c2'),
  ('member', 'b1000000-0000-4000-8000-0000000000c3'), ('other', 'b1000000-0000-4000-8000-0000000000c4'),
  ('A', 'b2000000-0000-4000-8000-0000000000c1'), ('B', 'b2000000-0000-4000-8000-0000000000c2'),
  ('c_A', 'b3000000-0000-4000-8000-0000000000c1'), ('c_B', 'b3000000-0000-4000-8000-0000000000c2'),
  ('i1', 'b4000000-0000-4000-8000-0000000000c1'), ('i2', 'b4000000-0000-4000-8000-0000000000c2'), ('i3', 'b4000000-0000-4000-8000-0000000000c3'),
  ('i4', 'b4000000-0000-4000-8000-0000000000c4'), ('i5', 'b4000000-0000-4000-8000-0000000000c5'), ('iB', 'b4000000-0000-4000-8000-0000000000c9'),
  ('p5', 'b5000000-0000-4000-8000-0000000000c5'), ('pcash', 'b5000000-0000-4000-8000-0000000000c6'), ('pev', 'b5000000-0000-4000-8000-0000000000c7'),
  ('brA', 'b6000000-0000-4000-8000-0000000000c1'), ('brB', 'b6000000-0000-4000-8000-0000000000c2'),
  ('r1', 'b7000000-0000-4000-8000-0000000000c1'), ('r2', 'b7000000-0000-4000-8000-0000000000c2'), ('rB', 'b7000000-0000-4000-8000-0000000000c3'),
  ('secret', encode(sha256('bank-local-test-key-0042'::bytea), 'base64'));
insert into auth.users (id, email) select val::uuid, key || '@bn.test' from bn.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (bn.id('A'), 'Banca A', bn.id('owner')), (bn.id('B'), 'Banca B', bn.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (bn.id('A'), 'cus_bn_a', 'sub_bn_a', 'pro', 'active'), (bn.id('B'), 'cus_bn_b', 'sub_bn_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (bn.id('A'), bn.id('owner'), 'owner'), (bn.id('A'), bn.id('admin'), 'admin'), (bn.id('A'), bn.id('member'), 'member'), (bn.id('B'), bn.id('other'), 'owner');
insert into public.clients (id, company_id, name) values (bn.id('c_A'), bn.id('A'), 'Panadería La Esquina'), (bn.id('c_B'), bn.id('B'), 'Cliente B');
insert into public.branches (id, company_id, name, code) values (bn.id('brA'), bn.id('A'), 'San Juan', 'SJU'), (bn.id('brB'), bn.id('B'), 'Ponce', 'PCE');

-- ------------------------------------------------------------- setup: banking (0026) + accounts
do $$
declare r text;
begin
  perform bn.ok(bn.err('admin', format('select public.bank_init(%L)', bn.id('A'))) = '', 'company A sets up banking');
  perform bn.ok(bn.err('other', format('select public.bank_init(%L)', bn.id('B'))) = '', 'company B too');
  r := bn.val('admin', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', bn.id('A'), 'Operativa', 'Banco Popular', '4821', bn.acct('A', '1010')));
  insert into bn.ctx values ('ba1', r);
  r := bn.val('other', format('select public.bank_save_account(%L, null, %L, %L, %L, %L)', bn.id('B'), 'Cuenta B', 'FirstBank', '1111', bn.acct('B', '1010')));
  insert into bn.ctx values ('baB', r);
  perform bn.ok(bn.id('ba1') is not null and bn.id('baB') is not null, 'one bank account per company');
end $$;

-- ------------------------------------------------------------- server keys and private data
do $$ begin
  perform bn.ok(bn.err('owner', format('select public.bank_set_server_key(%L, %L)', 'evil', encode(sha256('x'::bytea), 'base64'))) like '%permission denied%', 'nobody but the database owner registers bank server keys');
  perform bn.ok(bn.anon(format('select public.bank_set_server_key(%L, %L)', 'evil', encode(sha256('x'::bytea), 'base64'))) like 'ERR:%permission denied%', 'not anonymous callers either');
  perform bn.ok(bn.err('owner', 'select count(*) from ba_private.bank_connection_secrets') like '%permission denied%', 'the encrypted provider tokens are not readable by users');
  perform bn.ok(bn.err('owner', 'select ba_private.bank_verify(''k'', ''m'', ''x'', 1, gen_random_uuid())') like '%permission denied%', 'the private verifier is not callable');
  perform public.bank_set_server_key('k1', (select val from bn.ctx where key = 'secret'));
end $$;

-- ------------------------------------------------------------- connections (provider double; token ciphertext only)
do $$
declare
  pay text := '{"provider":"plaid","environment":"test_double","item_id":"item-test-A","institution_id":"ins_test","institution_name":"Banco de prueba (doble)","token_ciphertext":"v1.TESTDOUBLEciphertext000000","key_version":"v1","accounts":[{"id":"acc-chk","name":"Cheques","mask":"4821","type":"depository","subtype":"checking","currency":"USD"},{"id":"acc-sav","name":"Ahorros","mask":"9999","type":"depository","subtype":"savings","currency":"USD"}]}';
  n uuid := gen_random_uuid(); r text; cid uuid;
begin
  perform bn.ok(bn.err('member', bn.connect_sql('member', 'A', pay)) like '%FORBIDDEN%', 'members do not connect banks');
  perform bn.ok(bn.err('other', bn.connect_sql('other', 'A', pay)) like '%FORBIDDEN%', 'isolation: B cannot connect a bank to A');
  -- a signature for another user, a stale timestamp, a wrong key, a tampered payload
  perform bn.ok(bn.err('admin', bn.connect_sql('owner', 'A', pay)) like '%BANK_SERVER_AUTH%', 'the signature binds the user');
  perform bn.ok(bn.err('admin', bn.connect_sql('admin', 'A', pay, gen_random_uuid(), bn.now() - 600)) like '%BANK_SERVER_AUTH%', 'a stale signature is refused');
  perform bn.ok(bn.err('admin', bn.connect_sql('admin', 'A', pay, gen_random_uuid(), null, 'nokey')) like '%BANK_SERVER_AUTH%', 'an unknown server key is refused');
  perform bn.ok(bn.err('admin', replace(bn.connect_sql('admin', 'A', pay), 'Cheques', 'Cheques2')) like '%BANK_SERVER_AUTH%', 'a payload changed after signing is refused');
  r := bn.val('admin', bn.connect_sql('admin', 'A', pay, n));
  insert into bn.ctx values ('conn', r);
  perform bn.ok(bn.id('conn') is not null, 'the admin connects a bank through the provider flow (only a token ciphertext reaches the database)');
  perform bn.ok(bn.err('admin', bn.connect_sql('admin', 'A', pay, n)) like '%BANK_SERVER_AUTH%', 'a replayed nonce is refused');
  perform bn.ok((select token_ciphertext from ba_private.bank_connection_secrets where connection_id = bn.id('conn')) = 'v1.TESTDOUBLEciphertext000000', 'the token is stored only encrypted, in the private schema');
  perform bn.ok(bn.val('admin', 'select count(*) from public.bank_provider_accounts') = '2' and bn.val('admin', 'select string_agg(mask, '','' order by mask) from public.bank_provider_accounts') = '4821,9999',
    'the provider accounts are listed with masked numbers only');
  perform bn.ok(bn.val('admin', 'select environment || ''/'' || status from public.bank_connections') = 'test_double/active', 'a test-double connection is labelled as such');
  perform bn.ok(bn.val('member', 'select count(*) from public.bank_connections') = '0' and bn.val('other', 'select count(*) from public.bank_connections') = '0',
    'members and other companies do not see the connection');
  perform bn.ok(bn.err('admin', 'insert into public.bank_connections (company_id, provider, environment, item_id) values (''' || bn.id('A') || ''', ''plaid'', ''sandbox'', ''x'')') like '%permission denied%',
    'connections are written only through the signed functions');
  -- the same item from company B: refused
  perform bn.ok(bn.err('other', bn.connect_sql('other', 'B', pay)) like '%BANK_CONNECTION_INVALID%', 'an item connected to A cannot be attached to B');
  -- reconnection (update mode) keeps the connection and replaces the token
  update public.bank_connections set status = 'login_required', error_code = 'ITEM_LOGIN_REQUIRED' where id = bn.id('conn');
  r := bn.val('admin', bn.connect_sql('admin', 'A', replace(pay, 'TESTDOUBLEciphertext000000', 'TESTDOUBLEciphertext111111')));
  perform bn.ok(r = bn.id('conn')::text
    and (select status from public.bank_connections where id = bn.id('conn')) = 'active'
    and (select token_ciphertext from ba_private.bank_connection_secrets where connection_id = bn.id('conn')) like '%111111', 'reconnecting the same item restores it (no duplicate connection)');
  perform bn.ok((select count(*) from public.bank_connections) = 1 and (select count(*) from public.bank_provider_accounts) = 2, 'still one connection, two provider accounts');
  -- link the checking account to BusinessAI's bank account
  insert into bn.ctx select 'pa_chk', id::text from public.bank_provider_accounts where provider_account_id = 'acc-chk';
  insert into bn.ctx select 'pa_sav', id::text from public.bank_provider_accounts where provider_account_id = 'acc-sav';
  perform bn.ok(bn.err('member', format('select public.bank_link_provider_account(%L, %L)', bn.id('pa_chk'), bn.id('ba1'))) like '%BANK_ACCOUNT_NOT_FOUND%', 'members do not link accounts');
  perform bn.ok(bn.err('admin', format('select public.bank_link_provider_account(%L, %L)', bn.id('pa_chk'), bn.id('baB'))) like '%BANK_ACCOUNT_NOT_FOUND%', 'isolation: not to another company''s account');
  perform bn.ok(bn.err('admin', format('select public.bank_link_provider_account(%L, %L)', bn.id('pa_chk'), bn.id('ba1'))) = '', 'the admin links the checking account');
  perform bn.ok(bn.err('admin', format('select public.bank_link_provider_account(%L, %L)', bn.id('pa_sav'), bn.id('ba1'))) like '%duplicate key%', 'one provider account per bank account');
  perform bn.ok((select sync_cursor is null from public.bank_connections where id = bn.id('conn')), 'linking an account restarts the sync from the beginning (its history is not skipped)');
end $$;

-- ------------------------------------------------------------- sync (server, no user): idempotent by transaction id
do $$
declare r text; p text;
begin
  r := bn.anon(bn.ctx_sql(bn.id('conn')));
  perform bn.ok(r::jsonb ->> 'token_ciphertext' like 'v1.%' and jsonb_array_length(r::jsonb -> 'accounts') = 1 and r::jsonb ->> 'cursor' is null, 'the signed server reads the sync context (ciphertext, linked accounts, cursor)');
  perform bn.ok(bn.anon(replace(bn.ctx_sql(bn.id('conn')), 'bank_sync_context(', 'bank_sync_context(')) not like 'ERR:%', 'signed context call works without a user');
  perform bn.ok(bn.anon(format('select public.bank_sync_context(%L, %L, %s, %L, %L)::text', bn.id('conn'), 'k1', bn.now(), gen_random_uuid(), repeat('0', 64))) like 'ERR:%BANK_SERVER_AUTH%',
    'without the server signature nobody reads the context');
  perform bn.ok(bn.err('member', bn.ctx_sql(bn.id('conn'))) like '%FORBIDDEN%', 'a signed call from a member session is still refused');
  p := jsonb_build_object('trigger', 'initial', 'status', 'succeeded', 'cursor', 'cur-1', 'pending_skipped', 1,
    'accounts', jsonb_build_array(jsonb_build_object('bank_account_id', bn.id('ba1'), 'rows', jsonb_build_array(
      bn.txn(-3, 15000, 'DEPOSITO ATH MOVIL PANADERIA LA ESQUINA', 'tx-1', 'FAC-0001'),
      bn.txn(-2, 8000, 'TRANSFERENCIA RECIBIDA', 'tx-2'),
      bn.txn(-2, -2500, 'CARGO SERVICIO', 'tx-3'),
      bn.txn(-1, 10000, 'DEPOSITO', 'tx-4'),
      bn.txn(-1, 4000, 'DEPOSITO CHEQUE', 'tx-5'))))) ::text;
  r := bn.anon(bn.apply_sql(bn.id('conn'), p));
  perform bn.ok(r::jsonb ->> 'added' = '5' and r::jsonb ->> 'duplicates' = '0', 'the first sync adds five transactions');
  r := bn.anon(bn.apply_sql(bn.id('conn'), p));
  perform bn.ok(r::jsonb ->> 'added' = '0' and r::jsonb ->> 'duplicates' = '5', 'the same sync again (webhook retried, repeated import) adds nothing');
  perform bn.ok((select count(*) from public.bank_lines where bank_account_id = bn.id('ba1')) = 5, 'five bank lines, no duplicates');
  perform bn.ok((select count(*) from public.bank_imports where source = 'provider' and bank_account_id = bn.id('ba1')) = 2
    and (select string_agg(imported_count || '/' || duplicate_count, ',' order by created_at) from public.bank_imports where source = 'provider') in ('5/0,0/5', '0/5,5/0'),
    'each sync run is an import with its counts');
  perform bn.ok((select sync_cursor from public.bank_connections where id = bn.id('conn')) = 'cur-1' and (select last_success_at is not null from public.bank_connections where id = bn.id('conn')),
    'the cursor and the last successful sync are kept');
  perform bn.ok(bn.val('admin', 'select count(*) || ''/'' || sum(added) || ''/'' || sum(duplicates) from public.bank_sync_runs') = '2/5/5', 'the sync history is visible to the admin');
  perform bn.ok(bn.val('member', 'select count(*) from public.bank_sync_runs') = '0', 'not to members');
  -- an account of another company in the payload: refused, nothing written
  perform bn.ok(bn.anon(bn.apply_sql(bn.id('conn'), jsonb_build_object('trigger', 'manual', 'status', 'succeeded', 'accounts', jsonb_build_array(jsonb_build_object('bank_account_id', bn.id('baB'),
    'rows', jsonb_build_array(bn.txn(-1, 100, 'X', 'tx-evil')))))::text)) like 'ERR:%BANK_SYNC_INVALID%', 'a sync cannot write into an account the connection does not feed');
  perform bn.ok((select count(*) from public.bank_lines where bank_txn_id = 'tx-evil') = 0, 'nothing was written');
  perform bn.ok(bn.anon(bn.apply_sql(bn.id('conn'), jsonb_build_object('trigger', 'manual', 'status', 'succeeded', 'accounts', jsonb_build_array(jsonb_build_object('bank_account_id', bn.id('ba1'),
    'rows', jsonb_build_array(bn.txn(-1, 0, 'CERO', 'tx-zero')))))::text)) like 'ERR:%BANK_SYNC_INVALID%', 'zero-amount rows are invalid');
  -- removed by the bank: an unmatched line is excluded
  r := bn.anon(bn.apply_sql(bn.id('conn'), jsonb_build_object('trigger', 'webhook', 'status', 'succeeded', 'cursor', 'cur-2', 'removed', jsonb_build_array('tx-2'))::text));
  perform bn.ok(r::jsonb ->> 'removed' = '1' and (select status from public.bank_lines where bank_txn_id = 'tx-2') = 'excluded', 'a transaction removed by the bank is excluded');
  -- a failed sync: login required, then a good one restores it
  r := bn.anon(bn.apply_sql(bn.id('conn'), '{"trigger":"manual","status":"failed","error_code":"ITEM_LOGIN_REQUIRED"}'));
  perform bn.ok((select status || '/' || error_code || '/' || sync_cursor from public.bank_connections where id = bn.id('conn')) = 'login_required/ITEM_LOGIN_REQUIRED/cur-2',
    'a failed sync records the error and keeps the cursor');
  r := bn.anon(bn.apply_sql(bn.id('conn'), '{"trigger":"manual","status":"succeeded","cursor":"cur-3"}'));
  perform bn.ok((select status || '/' || coalesce(error_code, '-') from public.bank_connections where id = bn.id('conn')) = 'active/-', 'a later successful sync restores the connection');
  -- lines cannot be edited, the branch can
  perform bn.ok(bn.merr(format('update public.bank_lines set amount_cents = 1 where id = %L', bn.line('tx-1'))) like '%BANK_RECORD_IMMUTABLE%', 'synced lines are immutable');
end $$;

-- ------------------------------------------------------------- webhooks: idempotent, status changes
do $$
declare r text; h text;
begin
  h := '{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"item-test-A"}';
  r := bn.anon(bn.hook_sql(h));
  perform bn.ok(r::jsonb ->> 'outcome' = 'sync_requested' and r::jsonb ->> 'connection_id' = bn.id('conn')::text, 'a webhook asking for a sync is recorded for its connection');
  r := bn.anon(bn.hook_sql(h));
  perform bn.ok(r::jsonb ->> 'already' = 'true' and (select count(*) from public.bank_webhook_events) = 1, 'the same webhook delivered twice is recorded once');
  perform bn.ok(bn.anon(format('select public.bank_webhook_record(%L, %L, %L, %L, %s, %L, %L)::text', 'plaid', bn.sha(h || ' '), h || ' ', 'k1', bn.now(), gen_random_uuid(), repeat('a', 64))) like 'ERR:%BANK_SERVER_AUTH%',
    'an unsigned webhook is refused (the server verifies the provider signature first, then signs)');
  r := bn.anon(bn.hook_sql('{"webhook_type":"ITEM","webhook_code":"ERROR","item_id":"item-test-A","error_code":"ITEM_LOGIN_REQUIRED"}'));
  perform bn.ok((select status || '/' || error_code from public.bank_connections where id = bn.id('conn')) = 'login_required/ITEM_LOGIN_REQUIRED', 'ITEM_LOGIN_REQUIRED → reconnection needed');
  r := bn.anon(bn.hook_sql('{"webhook_type":"ITEM","webhook_code":"LOGIN_REPAIRED","item_id":"item-test-A"}'));
  perform bn.ok((select status from public.bank_connections where id = bn.id('conn')) = 'active', 'LOGIN_REPAIRED → active again');
  r := bn.anon(bn.hook_sql('{"webhook_type":"ITEM","webhook_code":"PENDING_DISCONNECT","item_id":"item-test-A"}'));
  perform bn.ok((select status from public.bank_connections where id = bn.id('conn')) = 'pending_disconnect', 'PENDING_DISCONNECT is shown');
  r := bn.anon(bn.hook_sql('{"webhook_type":"ITEM","webhook_code":"USER_PERMISSION_REVOKED","item_id":"item-test-A"}'));
  perform bn.ok((select status from public.bank_connections where id = bn.id('conn')) = 'revoked', 'permissions revoked by the client → revoked');
  r := bn.anon(bn.hook_sql('{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"item-unknown"}'));
  perform bn.ok(r::jsonb ->> 'outcome' = 'unknown_item' and (select company_id is null from public.bank_webhook_events where webhook_code = 'SYNC_UPDATES_AVAILABLE' and connection_id is null),
    'an unknown item is recorded without a company');
  perform bn.ok(bn.val('admin', 'select count(*) from public.bank_webhook_events') = '5' and bn.val('other', 'select count(*) from public.bank_webhook_events') = '0',
    'the admin sees the company''s webhook history; other companies do not (nor unknown items)');
  update public.bank_connections set status = 'active' where id = bn.id('conn');
end $$;

-- ------------------------------------------------------------- branches
do $$
declare e text;
begin
  perform bn.ok(bn.err('admin', format('select public.bank_account_set_branch(%L, %L)', bn.id('ba1'), bn.id('brB'))) like '%BRANCH_INVALID%', 'not another company''s branch');
  perform bn.ok(bn.err('member', format('select public.bank_account_set_branch(%L, %L)', bn.id('ba1'), bn.id('brA'))) like '%BANK_ACCOUNT_NOT_FOUND%', 'members do not assign branches');
  e := bn.err('admin', format('select public.bank_account_set_branch(%L, %L)', bn.id('ba1'), bn.id('brA')));
  perform bn.ok(e = '' and (select branch_id from public.bank_accounts where id = bn.id('ba1')) = bn.id('brA'),
    'the admin assigns the account to a branch');
  e := bn.err('admin', format('select public.bank_line_set_branch(%L, %L)', bn.line('tx-3'), bn.id('brA')));
  perform bn.ok(e = '' and (select branch_id from public.bank_lines where id = bn.line('tx-3')) = bn.id('brA'),
    'a single transaction can be assigned to a branch (the rest of the line stays immutable)');
  perform bn.ok(bn.err('other', format('select public.bank_line_set_branch(%L, null)', bn.line('tx-3'))) like '%BANK_ACCOUNT_NOT_FOUND%', 'isolation: B cannot touch A''s lines');
end $$;

-- ------------------------------------------------------------- deposits applied to invoices (human decision)
do $$
declare r text; e text; ar_before bigint; cash_before bigint; jl_count bigint;
begin
  perform bn.ok(bn.invoice('member', 'A', 'i1', 100) = '' and bn.invoice('member', 'A', 'i2', 50) = '' and bn.invoice('member', 'A', 'i3', 200) = ''
    and bn.invoice('member', 'A', 'i4', 60) = '' and bn.invoice('member', 'A', 'i5', 40) = '' and bn.invoice('other', 'B', 'iB', 80) = '', 'open invoices');
  ar_before := bn.bal('A', '1200'); cash_before := bn.bal('A', '1010');
  -- permissions and validations
  perform bn.ok(bn.err('member', format('select public.bank_apply_deposit(%L, %L, %L)', bn.line('tx-1'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i1'), 'amount_cents', 10000)), 'decision-0001')) like '%BANK_ACCOUNT_NOT_FOUND%',
    'members do not apply deposits');
  perform bn.ok(bn.err('other', format('select public.bank_apply_deposit(%L, %L, %L)', bn.line('tx-1'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i1'), 'amount_cents', 10000)), 'decision-0001')) like '%BANK_ACCOUNT_NOT_FOUND%',
    'isolation: B cannot apply A''s deposits');
  perform bn.ok(bn.err('admin', format('select public.bank_apply_deposit(%L, %L, %L)', bn.line('tx-1'), jsonb_build_array(jsonb_build_object('document_id', bn.id('iB'), 'amount_cents', 10000)), 'decision-0001')) like '%DEPOSIT_INVALID%',
    'not to another company''s invoice');
  perform bn.ok(bn.err('admin', format('select public.bank_apply_deposit(%L, %L, %L)', bn.line('tx-3'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i1'), 'amount_cents', 2500)), 'decision-0002')) like '%BANK_LINE_NOT_DEPOSIT%',
    'a debit is not a deposit');
  perform bn.ok(bn.err('admin', format('select public.bank_apply_deposit(%L, %L, %L)', bn.line('tx-1'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i1'), 'amount_cents', 10000), jsonb_build_object('document_id', bn.id('i3'), 'amount_cents', 6000)), 'decision-0003')) like '%DEPOSIT_OVER_APPLIED%',
    'never more than the deposit');
  perform bn.ok(bn.err('admin', format('select public.bank_apply_deposit(%L, %L, %L)', bn.line('tx-1'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i1'), 'amount_cents', 0)), 'decision-0004')) like '%DEPOSIT_INVALID%',
    'amounts must be positive');
  perform bn.ok(bn.err('admin', format('select public.bank_apply_deposit(%L, %L, %L)', bn.line('tx-1'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i2'), 'amount_cents', 9000), jsonb_build_object('document_id', bn.id('i1'), 'amount_cents', 6000)), 'decision-0005')) <> ''
    and (select count(*) from public.payments where document_id in (bn.id('i1'), bn.id('i2'))) = 0, 'more than an invoice''s balance is refused by Receivables, and nothing is written');
  -- one deposit split across two invoices ($150 = $100 + $50)
  r := bn.val('admin', format('select public.bank_apply_deposit(%L, %L, %L, %L)::text', bn.line('tx-1'), jsonb_build_array(
         jsonb_build_object('document_id', bn.id('i1'), 'amount_cents', 10000, 'confidence', 95, 'reasons', jsonb_build_array('reference_invoice', 'client_name')),
         jsonb_build_object('document_id', bn.id('i2'), 'amount_cents', 5000, 'confidence', 80, 'reasons', jsonb_build_array('amount_sum'))), 'decision-1001', 'ath_movil'));
  perform bn.ok(jsonb_array_length(r::jsonb -> 'payments') = 2 and r::jsonb ->> 'matched_group' is not null and r::jsonb ->> 'remaining_cents' = '0',
    'one deposit applied to two invoices: two payments, the line is matched');
  perform bn.ok((select status from public.documents where id = bn.id('i1')) = 'paid' and (select status from public.documents where id = bn.id('i2')) = 'paid', 'both invoices are paid (by Receivables, not by the bank screen)');
  perform bn.ok((select status from public.bank_lines where id = bn.line('tx-1')) = 'matched', 'the bank line is matched');
  perform bn.ok((select string_agg(payment_method || ':' || coalesce(branch_id::text, '-'), ',') from public.payments where document_id = bn.id('i1')) = 'ath_movil:' || bn.id('brA'),
    'the payment carries the method and the account''s branch');
  perform bn.ok(bn.bal('A', '1200') = ar_before - 15000 and bn.bal('A', '1010') = cash_before + 15000, 'the ledger moved once: bank +150, receivables −150');
  -- the same decision again (double click, retried request): nothing new
  r := bn.val('admin', format('select public.bank_apply_deposit(%L, %L, %L)::text', bn.line('tx-1'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i1'), 'amount_cents', 10000), jsonb_build_object('document_id', bn.id('i2'), 'amount_cents', 5000)), 'decision-1001'));
  perform bn.ok(r::jsonb ->> 'already' = 'true' and (select count(*) from public.payments where document_id in (bn.id('i1'), bn.id('i2'))) = 2, 'the same decision repeated creates no duplicate payment');
  perform bn.ok(bn.err('admin', format('select public.bank_apply_deposit(%L, %L, %L)', bn.line('tx-1'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i3'), 'amount_cents', 100)), 'decision-1002')) like '%BANK_LINE_NOT_AVAILABLE%',
    'a matched deposit cannot be applied again');
  -- several deposits for one invoice ($200 = $100 + $40 + $60 partial payments over time)
  r := bn.val('admin', format('select public.bank_apply_deposit(%L, %L, %L)::text', bn.line('tx-4'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i3'), 'amount_cents', 10000)), 'decision-2001'));
  perform bn.ok(r::jsonb ->> 'matched_group' is not null and (select status from public.documents where id = bn.id('i3')) = 'sent' and bn.balance_due('i3') = 100,
    'a deposit pays part of an invoice (still open, balance 100)');
  r := bn.val('admin', format('select public.bank_apply_deposit(%L, %L, %L)::text', bn.line('tx-5'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i3'), 'amount_cents', 4000)), 'decision-2002'));
  perform bn.ok(bn.balance_due('i3') = 60 and (select count(*) from public.bank_line_allocations where payment_id in (select id from public.payments where document_id = bn.id('i3'))) = 2,
    'a second deposit for the same invoice: two allocations, balance 60');
  -- a partially applied deposit stays open until the rest is decided
  r := bn.anon(bn.apply_sql(bn.id('conn'), jsonb_build_object('trigger', 'manual', 'status', 'succeeded', 'accounts', jsonb_build_array(jsonb_build_object('bank_account_id', bn.id('ba1'), 'rows', jsonb_build_array(
         bn.txn(0, 10000, 'DEPOSITO MIXTO', 'tx-6'), bn.txn(0, 7000, 'DEPOSITO', 'tx-7')))))::text));
  r := bn.val('admin', format('select public.bank_apply_deposit(%L, %L, %L)::text', bn.line('tx-6'), jsonb_build_array(jsonb_build_object('document_id', bn.id('i3'), 'amount_cents', 6000)), 'decision-3001'));
  perform bn.ok(r::jsonb ->> 'matched_group' is null and r::jsonb ->> 'remaining_cents' = '4000' and (select status from public.bank_lines where id = bn.line('tx-6')) = 'unmatched'
    and (select status from public.documents where id = bn.id('i3')) = 'paid', 'a partial application: invoice paid, $40 of the deposit still to decide (line open)');
  -- the rest: a payment already recorded into this bank (no new payment)
  perform bn.ok(bn.err('member', format('insert into public.payments (id, company_id, document_id, amount, created_by, paid_at, reference, deposit_account_id, branch_id, notes) values (%L, %L, %L, 40, %L, now(), %L, %L, %L, %L)',
    bn.id('p5'), bn.id('A'), bn.id('i5'), bn.id('member'), 'CHK-77', bn.acct('A', '1010'), bn.id('brA'), 'Cheque entregado en tienda')) = '', 'a member records a manual payment with branch and notes');
  perform bn.ok(bn.err('member', format('insert into public.payments (id, company_id, document_id, amount, created_by, paid_at) values (%L, %L, %L, 10, %L, now())',
    bn.id('pcash'), bn.id('A'), bn.id('i4'), bn.id('member'))) = '', 'and a cash payment');
  perform bn.ok(bn.err('admin', format('select public.bank_link_payment(%L, %L)', bn.line('tx-6'), bn.id('pcash'))) like '%BANK_PAYMENT_NOT_IN_BANK%', 'a cash payment was not deposited into this bank: not linkable');
  r := bn.val('admin', format('select public.bank_link_payment(%L, %L, 90, %L)::text', bn.line('tx-6'), bn.id('p5'), '["amount","reference"]'));
  perform bn.ok(r::jsonb ->> 'matched_group' is not null and (select status from public.bank_lines where id = bn.line('tx-6')) = 'matched'
    and (select count(*) from public.payments where document_id = bn.id('i5')) = 1, 'the rest is linked to the existing payment: matched, no duplicate payment');
  perform bn.ok(bn.err('admin', format('select public.bank_link_payment(%L, %L)', bn.line('tx-7'), bn.id('p5'))) like '%PAYMENT_ALREADY_LINKED%', 'a payment is linked to one deposit only');
  -- undo (traceable): the allocation is voided and the match undone; the payment stays (voided via Receivables)
  perform bn.ok(bn.err('admin', format('select public.bank_allocation_void(%L, %L)', (select id from public.bank_line_allocations where payment_id = bn.id('p5')), 'x')) like '%REASON_REQUIRED%', 'a reason is required');
  e := bn.err('admin', format('select public.bank_allocation_void(%L, %L)', (select id from public.bank_line_allocations where payment_id = bn.id('p5')), 'Era otro cheque'));
  perform bn.ok(e = ''
    and (select status from public.bank_lines where id = bn.line('tx-6')) = 'unmatched' and (select count(*) from public.payments where id = bn.id('p5') and voided_at is null) = 1,
    'undoing a link reopens the deposit and keeps the payment');
  perform bn.ok(bn.err('admin', format('select public.bank_link_payment(%L, %L)', bn.line('tx-7'), bn.id('p5'))) = '', 'the payment can then be linked to the right deposit');
  perform bn.ok(bn.merr(format('update public.bank_line_allocations set amount_cents = 1 where payment_id = %L', bn.id('p5'))) like '%BANK_RECORD_IMMUTABLE%'
    and bn.merr(format('delete from public.bank_line_allocations where payment_id = %L', bn.id('p5'))) like '%BANK_RECORD_IMMUTABLE%', 'allocations are never edited or deleted');
  perform bn.ok(bn.err('admin', format('update public.bank_line_allocations set confidence = 1 where payment_id = %L', bn.id('p5'))) like '%permission denied%', 'nor written directly by users');
  perform bn.ok(bn.val('admin', 'select count(*) from public.bank_line_allocations') = '7' and bn.val('member', 'select count(*) from public.bank_line_allocations') = '0'
    and bn.val('other', 'select count(*) from public.bank_line_allocations') = '0', 'the decisions are visible to the bank team only');
  perform bn.ok((select count(*) from public.bank_events where action in ('deposit_applied', 'payment_linked', 'voided')) >= 6, 'every decision is in the audit trail');
  -- the ledger balances
  select count(*) into jl_count from public.journal_entries e where e.company_id = bn.id('A') and (select sum(debit_cents) - sum(credit_cents) from public.journal_lines l where l.entry_id = e.id) <> 0;
  perform bn.ok(jl_count = 0, 'every journal entry balances');
end $$;

-- ------------------------------------------------------------- receipt captures (private evidence)
do $$
declare r text; e text; path1 text := bn.id('A') || '/receipts/' || bn.id('r1') || '.jpg'; path2 text := bn.id('A') || '/receipts/' || bn.id('r2') || '.pdf';
        pathB text := bn.id('B') || '/receipts/' || bn.id('rB') || '.png'; cap uuid;
begin
  perform bn.ok((select public = false from storage.buckets where id = 'Banking-evidence'), 'the evidence bucket is private');
  perform bn.ok(bn.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Banking-evidence', path1)) = '', 'a member uploads a receipt photo');
  perform bn.ok(bn.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Banking-evidence', bn.id('A') || '/receipts/x.exe')) like '%row-level security%', 'only receipt paths and image / PDF names');
  perform bn.ok(bn.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Banking-evidence', pathB)) like '%row-level security%', 'isolation: not into another company''s folder');
  perform bn.ok(bn.err('other', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Banking-evidence', pathB)) = '', 'company B uploads its own');
  perform bn.ok(bn.err('member', format('select public.receipt_register(%L, %L, %L, %L, %s, %L)', bn.id('A'), path2, 'r.pdf', 'application/pdf', 1000, bn.sha('pdf'))) like '%RECEIPT_INVALID%',
    'a receipt is registered only for an uploaded file');
  perform bn.ok(bn.err('member', format('select public.receipt_register(%L, %L, %L, %L, %s, %L)', bn.id('A'), pathB, 'r.png', 'image/png', 1000, bn.sha('png'))) like '%RECEIPT_INVALID%',
    'nor for another company''s file');
  r := bn.val('member', format('select public.receipt_register(%L, %L, %L, %L, %s, %L, %L)::text', bn.id('A'), path1, 'IMG_0001.jpg', 'image/jpeg', 204800, bn.sha('photo-1'), bn.id('brA')));
  cap := (r::jsonb ->> 'id')::uuid; insert into bn.ctx values ('cap1', cap::text);
  perform bn.ok(r::jsonb ->> 'duplicate' = 'false', 'the member registers the capture');
  -- the same photo uploaded again under another name: the existing capture
  perform bn.err('member', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'Banking-evidence', path2));
  r := bn.val('member', format('select public.receipt_register(%L, %L, %L, %L, %s, %L)::text', bn.id('A'), path2, 'IMG_0001 copia.pdf', 'application/pdf', 204800, bn.sha('photo-1')));
  perform bn.ok(r::jsonb ->> 'duplicate' = 'true' and (r::jsonb ->> 'id')::uuid = cap, 'the same file twice is the same receipt (no duplicate)');
  e := bn.err('member', format('delete from storage.objects where name = %L', path2));
  perform bn.ok(e = '' and (select count(*) from storage.objects where name = path2) = 0,
    'an unregistered upload can be removed');
  e := bn.err('member', format('delete from storage.objects where name = %L', path1));
  perform bn.ok(e = '' and (select count(*) from storage.objects where name = path1) = 1,
    'a registered original is never deleted');
  -- OCR suggestions: what was not recognized stays null (never invented)
  perform bn.ok(bn.err('member', format('select public.receipt_set_extraction(%L, %L, %L, null, %L)', cap, 'test_double', 'succeeded',
    '{"merchant":{"value":"Ferretería Central","confidence":0.93},"total_cents":{"value":4815,"confidence":0.9},"tax_cents":{"value":540,"confidence":0.7},"receipt_number":null,"date":{"value":"2026-11-10","confidence":0.88}}')) = '',
    'the OCR suggestion is stored as a suggestion');
  perform bn.ok((select extracted -> 'receipt_number' = 'null'::jsonb and status = 'captured' and confirmed is null from public.receipt_captures where id = cap), 'unrecognized fields are null; nothing is confirmed yet');
  perform bn.ok(bn.val('member', 'select count(*) from public.receipt_captures') = '1' and bn.val('other', 'select count(*) from public.receipt_captures') = '0', 'the author sees their capture; other companies do not');
  perform bn.ok(bn.err('other', format('select public.receipt_confirm(%L, %L)', cap, '{"date":"2026-11-10","total_cents":"4815","currency":"USD"}')) like '%RECEIPT_NOT_FOUND%', 'isolation: B cannot confirm A''s receipt');
  perform bn.ok(bn.err('member', format('select public.receipt_confirm(%L, %L)', cap, '{"date":"10/11/2026","total_cents":"48.15"}')) like '%RECEIPT_INVALID%', 'confirmed data is validated (date, amount in cents, currency)');
  e := bn.err('member', format('select public.receipt_confirm(%L, %L)', cap, '{"date":"2026-11-10","total_cents":"4815","tax_cents":"540","currency":"USD","merchant":"Ferretería Central","payment_method":"debit_card"}'));
  perform bn.ok(e = ''
    and (select status from public.receipt_captures where id = cap) = 'confirmed', 'the person corrects and confirms the data');
  perform bn.ok(bn.err('member', format('select public.receipt_set_extraction(%L, %L, %L, null, %L)', cap, 'x', 'succeeded', '{}')) like '%RECEIPT_LOCKED%'
    and bn.merr(format('update public.receipt_captures set extracted = %L where id = %L', '{}', cap)) like '%RECEIPT_IMMUTABLE%', 'a confirmed receipt is final');
  perform bn.ok(bn.err('member', format('update public.receipt_captures set status = %L where id = %L', 'discarded', cap)) like '%permission denied%', 'captures are written only through the functions');
  -- a payment with evidence: same company only
  perform bn.ok(bn.err('other', format('insert into public.payments (company_id, document_id, amount, created_by, paid_at, evidence_capture_id) values (%L, %L, 5, %L, now(), %L)',
    bn.id('B'), bn.id('iB'), bn.id('other'), cap)) like '%EVIDENCE_INVALID%', 'evidence of another company is refused');
  perform bn.ok(bn.err('other', format('insert into public.payments (company_id, document_id, amount, created_by, paid_at, branch_id) values (%L, %L, 5, %L, now(), %L)',
    bn.id('B'), bn.id('iB'), bn.id('other'), bn.id('brA'))) like '%BRANCH_INVALID%', 'a branch of another company is refused');
  perform bn.ok(bn.err('member', format('insert into public.payments (id, company_id, document_id, amount, created_by, paid_at, evidence_capture_id, payment_method) values (%L, %L, %L, 20, %L, now(), %L, %L)',
    bn.id('pev'), bn.id('A'), bn.id('i4'), bn.id('member'), cap, 'check')) = '', 'a manual payment with photo evidence');
  perform bn.ok(bn.merr(format('update public.payments set notes = %L where id = %L', 'cambio', bn.id('pev'))) <> '', 'payments stay immutable (notes and evidence are set when recorded)');
end $$;

-- ------------------------------------------------------------- disconnect safely; history stays
do $$
declare r text;
begin
  perform bn.ok(bn.err('member', bn.disc_sql('member', bn.id('conn'))) like '%BANK_CONNECTION_NOT_FOUND%', 'members do not disconnect');
  perform bn.ok(bn.err('admin', bn.disc_sql('owner', bn.id('conn'))) like '%BANK_SERVER_AUTH%', 'the disconnect signature binds the user');
  r := bn.err('admin', bn.disc_sql('admin', bn.id('conn')));
  perform bn.ok(r = '', 'the admin disconnects');
  perform bn.ok((select status from public.bank_connections where id = bn.id('conn')) = 'disconnected' and (select count(*) from ba_private.bank_connection_secrets) = 0,
    'disconnected: the token is erased');
  perform bn.ok((select count(*) from public.bank_lines where bank_account_id = bn.id('ba1')) = 7 and (select count(*) from public.bank_sync_runs) > 0, 'the transactions and the sync history stay');
  r := bn.anon(bn.ctx_sql(bn.id('conn')));
  perform bn.ok(r::jsonb ->> 'token_ciphertext' is null and r::jsonb ->> 'status' = 'disconnected', 'nothing left to sync with');
  r := bn.anon(bn.hook_sql('{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"item-test-A","n":2}'));
  perform bn.ok(r::jsonb ->> 'outcome' = 'ignored', 'webhooks for a disconnected item are ignored');
end $$;

-- ------------------------------------------------------------- deleting a company removes its banking data
do $$ begin
  perform bn.ok(bn.merr(format('delete from public.companies where id = %L', bn.id('B'))) = '', 'company B can be deleted');
  perform bn.ok((select count(*) from public.receipt_captures where company_id = bn.id('B')) = 0,
    'deleting company B cascades through its banking data');
end $$;

do $$ begin
  if exists (select 1 from bn.failures) then raise exception 'BANKING TESTS FAILED: %', (select string_agg(msg, '; ') from bn.failures); end if;
  raise notice 'ALL BANKING TESTS PASSED';
end $$;
