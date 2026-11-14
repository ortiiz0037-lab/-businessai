-- BusinessAI Intelligence Engine core (0030). TEST-ONLY, local throw-away database with every
-- migration up to 0030. Schema at.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema at;
create table at.ctx (key text primary key, val text not null);
create function at.id(k text) returns uuid language sql stable as $$ select val::uuid from at.ctx where key = k $$;
create table at.failures (msg text);
create function at.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into at.failures values (msg); end if;
end $$;
create function at.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', at.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function at.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', at.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function at.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
grant usage on schema at to authenticated;
grant select on at.ctx to authenticated;
create function at.ok(cond boolean, msg text, extra text) returns void language plpgsql as $$
begin perform at.ok(cond, case when coalesce(cond, false) then msg else msg || ' — ' || coalesce(extra, 'null') end); end $$;
grant execute on all functions in schema at to authenticated;

-- signatures are computed here by the test (as the database owner) with the test key
create function at.mac(msg text) returns text language sql as $$ select encode(ba_private.hmac_sha256(decode((select val from at.ctx where key = 'secret'), 'base64'), convert_to(msg, 'UTF8')), 'hex') $$;
create function at.now() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
-- begin a turn as `who` with a valid signature; returns 'turn|conv|allowed|reason' or the error
create function at.begin(who text, co text, conv uuid, txt text, nonce uuid default gen_random_uuid(), ts bigint default null, keyid text default 'k1', bad boolean default false) returns text language plpgsql as $$
declare t bigint := coalesce(ts, at.now()); m text; r text; h text;
begin
  m := at.mac(concat_ws('|', 'begin', 'v1', keyid, at.id(who)::text, at.id(co)::text, coalesce(conv::text, ''), nonce::text, t::text, ba_private.sha_hex(txt)));
  if bad then m := at.mac('tampered'); end if;
  begin
    r := at.val(who, format('select coalesce(turn_id::text, ''-'') || ''|'' || coalesce(conversation_id::text, ''-'') || ''|'' || allowed || ''|'' || reason from public.assistant_begin_turn(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
      at.id(co), conv, 'Prueba', 'es', txt, '/dashboard', keyid, nonce, t, m));
  exception when others then get stacked diagnostics h = pg_exception_hint; r := sqlerrm || ' ' || coalesce(h, ''); end;
  return r;
end $$;
create function at.finish(who text, turn uuid, payload text, keyid text default 'k1', mac_payload text default null) returns text language plpgsql as $$
declare m text; r text;
begin
  m := at.mac(concat_ws('|', 'finish', 'v1', keyid, at.id(who)::text, turn::text, ba_private.sha_hex(coalesce(mac_payload, payload))));
  begin r := coalesce(at.val(who, format('select public.assistant_finish_turn(%L, %L, %L, %L)::text', turn, payload, keyid, m)), 'null');
  exception when others then r := sqlerrm; end;
  return r;
end $$;
create function at.claim(who text, act uuid, ts bigint default null) returns text language plpgsql as $$
declare t bigint := coalesce(ts, at.now()); r text;
begin
  begin r := coalesce(at.val(who, format('select attempt || ''|'' || kind from public.assistant_claim_action(%L, %L, %L, %L)', act, 'k1', t,
    at.mac(concat_ws('|', 'claim', 'v1', 'k1', at.id(who)::text, act::text, t::text)))), 'none');
  exception when others then r := sqlerrm; end;
  return r;
end $$;
create function at.complete(who text, act uuid, ok boolean, res text, err text default null) returns text language plpgsql as $$
declare t bigint := at.now(); r text := '';
begin
  begin perform at.val(who, format('select public.assistant_complete_action(%L, %L, %L, %L, %L, %L, %L)::text', act, ok, res, err, 'k1', t,
    at.mac(concat_ws('|', 'complete', 'v1', 'k1', at.id(who)::text, act::text, ok::text, t::text, ba_private.sha_hex(res), ba_private.sha_hex(err)))));
  exception when others then r := sqlerrm; end;
  return r;
end $$;
grant execute on all functions in schema at to authenticated;

insert into at.ctx values
  ('owner', 'e7000000-0000-4000-8000-000000000001'), ('admin', 'e7000000-0000-4000-8000-000000000002'),
  ('member', 'e7000000-0000-4000-8000-000000000003'), ('other', 'e7000000-0000-4000-8000-000000000004'),
  ('A', 'e8000000-0000-4000-8000-000000000001'), ('B', 'e8000000-0000-4000-8000-000000000002'),
  ('cl', 'e9000000-0000-4000-8000-000000000001'), ('ven', 'ea000000-0000-4000-8000-000000000001'),
  ('secret', encode(sha256('businessai-local-test-only-key'::bytea), 'base64'));
insert into auth.users (id, email) select val::uuid, key || '@it.test' from at.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (at.id('A'), 'Inteligencia A', at.id('owner')), (at.id('B'), 'Inteligencia B', at.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (at.id('A'), 'cus_it_a', 'sub_it_a', 'pro', 'active'), (at.id('B'), 'cus_it_b', 'sub_it_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (at.id('A'), at.id('owner'), 'owner'), (at.id('A'), at.id('admin'), 'admin'), (at.id('A'), at.id('member'), 'member'), (at.id('B'), at.id('other'), 'owner');
insert into public.clients (id, company_id, name) values (at.id('cl'), at.id('A'), 'Cliente Inteligente');

-- ------------------------------------------------------------- privileges: no forging from the REST API
do $$ declare c uuid; begin
  c := at.val('member', format('select public.assistant_start_conversation(%L, %L, %L)', at.id('A'), 'x', 'es'))::uuid;
  insert into at.ctx values ('c0', c);
  perform at.ok(at.err('member', format('select public.assistant_log(%L, %L, %L, %L)', at.id('A'), c, 'tool', '{"tool":"fake"}')) like '%permission denied%', 'A2: a user can no longer write audit events');
  perform at.ok(at.err('member', format('select * from public.assistant_consume(%L)', at.id('A'))) like '%permission denied%', 'A3: nor consume quota');
  perform at.ok(at.err('member', format('select public.assistant_record_usage(%L, 1, 1)', at.id('A'))) like '%permission denied%', 'A3: nor record usage');
  perform at.ok(at.err('member', format('select public.assistant_add_message(%L, %L, %L)', c, 'assistant', 'falso')) like '%permission denied%', 'A4: nor append messages (assistant role or any)');
  perform at.ok(at.err('member', format('select public.assistant_propose_action(%L, %L, %L, %L)', c, 'studio_draft', 'x', '{}')) like '%permission denied%'
                and at.err('member', format('select * from public.assistant_decide_action(%L, %L)', gen_random_uuid(), 'confirm')) like '%permission denied%', 'the 0029 action functions are server-only too');
  perform at.ok(at.err('owner', format('select public.assistant_set_server_key(%L, %L)', 'evil', encode(sha256('x'::bytea), 'base64'))) like '%permission denied%', 'nobody but the database owner registers server keys');
  perform at.ok(at.err('owner', 'select count(*) from ba_private.assistant_server_keys') like '%permission denied%', 'server keys are unreadable');
  perform at.ok(at.err('owner', 'select ba_private.hmac_sha256(''a''::bytea, ''b''::bytea)') like '%permission denied%', 'the private functions are not callable');
  perform at.ok(at.err('member', format('insert into public.assistant_turns (company_id, conversation_id, user_id) values (%L, %L, %L)', at.id('A'), c, at.id('member'))) like '%permission denied%', 'turns are not writable directly');
end $$;

-- ------------------------------------------------------------- closed by default, keys, signatures, replay
do $$ declare r text; n uuid := gen_random_uuid(); begin
  perform at.ok(at.val('member', 'select public.assistant_server_ready()::text') = 'false', 'closed by default: no server key registered');
  perform at.ok(at.begin('member', 'A', null, 'hola') like '%ASSISTANT_SERVER_AUTH%', 'without a key no turn can start');
  perform public.assistant_set_server_key('k1', (select val from at.ctx where key = 'secret'));
  perform at.ok(at.val('member', 'select public.assistant_server_ready()::text') = 'true', 'a registered key opens it');
  r := at.begin('member', 'A', null, '¿Cuánto me deben?', n);
  perform at.ok(split_part(r, '|', 3) = 'true', 'a correctly signed request starts a turn', r);
  insert into at.ctx values ('t1', split_part(r, '|', 1)), ('c1', split_part(r, '|', 2));
  perform at.ok(at.begin('member', 'A', null, '¿Cuánto me deben?', n) like '%replay%', 'the same nonce cannot be replayed');
  perform at.ok(at.begin('member', 'A', null, 'hola', bad => true) like '%ASSISTANT_SERVER_AUTH%', 'a wrong signature is refused');
  perform at.ok(at.begin('member', 'A', null, 'hola', ts => at.now() - 600) like '%stale%', 'an old timestamp is refused');
  perform at.ok(at.begin('member', 'A', null, 'hola', keyid => 'nokey') like '%ASSISTANT_SERVER_AUTH%', 'an unknown key id is refused');
end $$;
do $$ declare n uuid := gen_random_uuid(); t bigint := at.now(); begin
  -- a signature made for the member is presented by the admin
  perform at.ok(at.err('admin', format('select * from public.assistant_begin_turn(%L, null, %L, %L, %L, null, %L, %L, %L, %L)', at.id('A'), 'x', 'es', 'hola', 'k1', n, t,
    at.mac(concat_ws('|', 'begin', 'v1', 'k1', at.id('member')::text, at.id('A')::text, '', n::text, t::text, ba_private.sha_hex('hola'))))) like '%ASSISTANT_SERVER_AUTH%',
    'a signature bound to another user is refused');
end $$;
do $$ begin
  perform at.ok(at.begin('other', 'A', null, 'hola') like '%FORBIDDEN%', 'isolation: a user of another company cannot start a turn there');
  perform at.ok(at.begin('owner', 'A', at.id('c1'), 'hola') like '%ASSISTANT_NOT_FOUND%', 'privacy: nobody else can continue a member''s conversation');
  perform at.ok(at.begin('member', 'A', null, repeat('x', 4001)) like '%ASSISTANT_INVALID%', 'messages are bounded');
  perform at.ok((select count(*) from public.assistant_messages where turn_id = at.id('t1') and role = 'user') = 1, 'the user''s message is stored with its turn');
  perform at.ok(at.val('member', format('select status from public.assistant_turns where id = %L', at.id('t1'))) = 'open', 'the author sees the open turn');
  perform at.ok(at.val('other', format('select count(*)::text from public.assistant_turns where id = %L', at.id('t1'))) = '0', 'isolation: another company does not');
end $$;

-- ------------------------------------------------------------- finishing a turn
do $$ declare p text; r text; begin
  p := '{"status":"completed","answer":"Le deben 100.00","provider":"anthropic","model":"claude-opus-5-5","tier":"P2","router":{"reason":"finance"},'
    || '"usage":{"input":1200,"output":300,"cache_read":4000,"cache_write":0,"calls":2},"cost_nanos":12600000,"cost_status":"estimated","latency_ms":2100,'
    || '"verification":"verified","trace":[{"name":"list_invoices","ok":true}],"events":[{"event":"tool","detail":{"tool":"list_invoices","ok":true}},{"event":"action_executed","detail":{}}]}';
  perform at.ok(at.finish('member', at.id('t1'), p, mac_payload => replace(p, '100.00', '999.00')) like '%ASSISTANT_SERVER_AUTH%', 'a payload changed after signing is refused');
  perform at.ok(at.finish('owner', at.id('t1'), p) like '%ASSISTANT_NOT_FOUND%', 'another user cannot finish the turn');
  r := at.finish('member', at.id('t1'), p);
  perform at.ok(r ~ '^\d+$', 'the server finishes the turn', r);
  perform at.ok(at.finish('member', at.id('t1'), p) like '%ASSISTANT_ALREADY_DECIDED%', 'a turn is finished once (no replay)');
  perform at.ok((select provider || '/' || model || '/' || tier || '/' || cost_nanos || '/' || cache_read_tokens || '/' || verification from public.assistant_turns where id = at.id('t1'))
                = 'anthropic/claude-opus-5-5/P2/12600000/4000/verified', 'A10: provider, model, tier, cost, cache tokens and verification are recorded');
  perform at.ok((select role || ':' || content from public.assistant_messages where turn_id = at.id('t1') and role = 'assistant') = 'assistant:Le deben 100.00', 'the answer is stored by the server');
  perform at.ok((select cost_nanos || '/' || input_tokens || '/' || cache_read_tokens from public.assistant_usage where user_id = at.id('member')) = '12600000/1200/4000', 'usage and cost are accumulated');
  perform at.ok(not exists (select 1 from public.assistant_events where event = 'action_executed' and company_id = at.id('A')), 'the payload cannot inject action audit events');
  perform at.ok(exists (select 1 from public.assistant_events where event = 'tool' and detail ->> 'turn' = at.id('t1')::text), 'tool events are audited with their turn');
  perform at.ok(at.val('admin', format('select model from public.assistant_turns where id = %L', at.id('t1'))) = 'claude-opus-5-5', 'assistant.audit reads turn metadata');
  perform at.ok(at.val('admin', format('select count(*)::text from public.assistant_messages where turn_id = %L', at.id('t1'))) = '0', 'but never the conversation text');
end $$;
do $$ declare r text; t uuid; begin
  -- A5: a turn that fails after several provider calls still records its usage and cost
  r := at.begin('member', 'A', at.id('c1'), 'otra pregunta'); t := split_part(r, '|', 1)::uuid;
  perform at.ok(at.finish('member', t, '{"status":"error","answer":"El proveedor falló.","error_code":"overloaded","usage":{"input":900,"output":50,"calls":3},"cost_nanos":4600000,"cost_status":"estimated"}') ~ '^\d+$',
                'A5: an error turn is finished');
  perform at.ok((select status || '/' || calls || '/' || cost_nanos from public.assistant_turns where id = t) = 'error/3/4600000', 'A5: its usage and cost are kept');
  r := at.begin('member', 'A', at.id('c1'), 'cancelada'); t := split_part(r, '|', 1)::uuid;
  perform at.ok(at.finish('member', t, '{"status":"cancelled","answer":"","usage":{"input":10,"output":0,"calls":1},"cost_nanos":40000}') = 'null', 'a cancelled turn without text adds no message');
  perform at.ok((select status from public.assistant_turns where id = t) = 'cancelled', 'and is recorded as cancelled');
  perform at.ok(at.finish('member', (split_part(at.begin('member', 'A', at.id('c1'), 'x'), '|', 1))::uuid, '{"status":"hacked","answer":"x"}') like '%ASSISTANT_INVALID%', 'unknown statuses are refused');
  perform at.ok(at.finish('member', (select id from public.assistant_turns where status = 'open' and user_id = at.id('member') limit 1), '{"status":"completed","answer":"x","usage":{"input":-5}}') like '%ASSISTANT_INVALID%', 'negative usage is refused');
end $$;

-- abandoned turns
do $$ declare r text; begin
  update public.assistant_turns set expires_at = now() - interval '1 minute' where user_id = at.id('member') and status = 'open';
  r := at.begin('member', 'A', at.id('c1'), 'tras abandono');
  perform at.ok(not exists (select 1 from public.assistant_turns where user_id = at.id('member') and status = 'open' and expires_at < now())
                and exists (select 1 from public.assistant_turns where user_id = at.id('member') and status = 'abandoned'), 'expired open turns are marked abandoned');
  perform at.ok(exists (select 1 from public.assistant_events where event = 'turn_abandoned'), 'and audited');
  insert into at.ctx values ('t2', split_part(r, '|', 1));
end $$;

-- ------------------------------------------------------------- proposals and actions (A6)
do $$ declare a uuid; k uuid := gen_random_uuid(); begin
  perform at.ok(at.err('member', format('select public.assistant_propose(%L, %L, %L, %L)', at.id('t1'), 'studio_draft', 'x', '{}')) like '%ASSISTANT_NOT_FOUND%', 'no proposals on a finished turn');
  perform at.ok(at.err('owner', format('select public.assistant_propose(%L, %L, %L, %L)', at.id('t2'), 'studio_draft', 'x', '{}')) like '%ASSISTANT_NOT_FOUND%', 'nor on another user''s turn');
  a := at.val('member', format('select public.assistant_propose(%L, %L, %L, %L)', at.id('t2'), 'studio_draft', 'Carta', '{"kind":"letter"}'))::uuid;
  insert into at.ctx values ('a1', a);
  perform at.ok((select turn_id from public.assistant_actions where id = a) = at.id('t2'), 'a proposal belongs to its turn');
  perform at.ok(at.claim('member', a) like '%ASSISTANT_ACTION_BUSY%', 'a proposal cannot be executed before it is confirmed');
  perform at.ok(at.val('member', format('select status from public.assistant_decide(%L, %L, %L)', a, 'confirm', k)) = 'confirmed', 'the author confirms');
  perform at.ok(at.val('member', format('select status from public.assistant_decide(%L, %L, %L)', a, 'confirm', k)) = 'confirmed', 'the same request repeated is answered the same (idempotent)');
  perform at.ok(at.err('member', format('select * from public.assistant_decide(%L, %L, %L)', a, 'cancel', gen_random_uuid())) like '%ASSISTANT_ALREADY_DECIDED%', 'a different decision afterwards is refused');
  perform at.ok(at.err('owner', format('select * from public.assistant_decide(%L, %L, %L)', a, 'cancel', k)) like '%ASSISTANT_NOT_FOUND%', 'only the author decides');
  perform at.ok(at.err('member', format('select * from public.assistant_claim_action(%L, %L, %L, %L)', a, 'k1', at.now(), repeat('0', 64))) like '%ASSISTANT_SERVER_AUTH%', 'execution needs the server signature');
  perform at.ok(at.claim('member', a) = '1|studio_draft', 'the server takes it (attempt 1)');
  perform at.ok(at.claim('member', a) like '%ASSISTANT_ACTION_BUSY%', 'a second worker cannot take it while leased');
  update public.assistant_actions set lease_until = now() - interval '1 second' where id = a;
  perform at.ok(at.claim('member', a) = '2|studio_draft', 'a stuck execution is taken again after its lease (attempt 2)');
  perform at.ok(at.complete('member', a, true, '{"link":"/studio/x"}') = '', 'its result is recorded');
  perform at.ok((select status || '/' || attempts from public.assistant_actions where id = a) = 'executed/2', 'executed after two attempts');
  perform at.ok(at.complete('member', a, false, null, 'x') like '%ASSISTANT_ALREADY_DECIDED%', 'the result cannot be rewritten');
  perform at.ok(at.claim('member', a) like '%ASSISTANT_ACTION_BUSY%', 'an executed action cannot run again');
end $$;
do $$ declare a uuid; r text; begin
  a := at.val('member', format('select public.assistant_propose(%L, %L, %L, %L)', at.id('t2'), 'studio_draft', 'Otra', '{}'))::uuid;
  perform at.val('member', format('select status from public.assistant_decide(%L, %L, %L)', a, 'confirm', gen_random_uuid()));
  update public.assistant_actions set attempts = 3, status = 'executing', lease_until = now() - interval '1 second' where id = a;
  r := at.claim('member', a);
  perform at.ok(r = 'none' and (select status || '/' || error from public.assistant_actions where id = a) = 'failed/too_many_attempts', 'after three attempts the action is marked failed (committed, nothing returned)',
                r || ' ' || (select status || '/' || coalesce(error, '-') from public.assistant_actions where id = a));
end $$;

-- ------------------------------------------------------------- access map in one call (A8)
do $$ declare j jsonb; begin
  j := at.val('member', format('select public.assistant_access(%L, %L)::text', at.id('A'), '{clients.view,receivables.view,studio.edit,assistant.audit}'))::jsonb;
  perform at.ok((j -> 'perms' ->> 'clients.view') = 'true' and (j -> 'perms' ->> 'receivables.view') = 'false' and (j -> 'perms' ->> 'assistant.audit') = 'false', 'A8: the member''s permission map in one call');
  perform at.ok((j ->> 'member') = 'true' and (j -> 'workforce' ->> 'manages') = 'false' and jsonb_typeof(j -> 'features') = 'object', 'with membership, workforce scope and plan features');
  j := at.val('other', format('select public.assistant_access(%L, %L)::text', at.id('A'), '{clients.view}'))::jsonb;
  perform at.ok((j ->> 'member') = 'false' and (j -> 'perms' ->> 'clients.view') = 'false', 'isolation: another company gets no permissions there');
  perform at.ok(at.err('member', format('select public.assistant_access(%L, %L)', at.id('A'), (select array_agg('k' || g)::text from generate_series(1, 61) g))) like '%FORBIDDEN%', 'the key list is bounded');
end $$;

-- ------------------------------------------------------------- complete aggregates (A7)
do $$ declare i int; begin
  for i in 1..3 loop
    perform at.err('owner', format($q$insert into public.documents (company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date)
      values (%L, %L, %L, 'invoice', 'x', 'sent', %s, 0, %s, %L, %L)$q$, at.id('A'), at.id('cl'), at.id('owner'), (array[0.10, 0.20, 1000.05])[i], (array[0.10, 0.20, 1000.05])[i],
      '2026-11-02', case when i = 3 then '2026-01-15' else '2099-01-01' end));
  end loop;
  perform at.ok((select count(*) from public.documents where company_id = at.id('A')) = 3, 'setup: three invoices');
  perform at.ok(at.val('owner', format('select invoices || ''/'' || total_cents from public.assistant_invoiced(%L, %L, %L)', at.id('A'), '2026-11-01', '2026-11-30')) = '3/100035',
                'invoiced total in exact cents (0.10 + 0.20 + 1000.05 = 1000.35)');
  perform at.ok(at.val('owner', format('select open_count || ''/'' || open_cents || ''/'' || overdue_count || ''/'' || overdue_cents from public.assistant_ar_summary(%L)', at.id('A'))) = '3/100035/1/100005',
                'receivables summary over every invoice, overdue separated');
  perform at.ok(at.val('owner', format('select open_cents from public.assistant_ar_summary(%L, %L)', at.id('A'), gen_random_uuid())) = '0', 'filtered by client');
  perform at.ok(at.err('member', format('select * from public.assistant_ar_summary(%L)', at.id('A'))) like '%FORBIDDEN%', 'a member without receivables.view is refused');
  perform at.ok(at.err('other', format('select * from public.assistant_invoiced(%L, %L, %L)', at.id('A'), '2026-11-01', '2026-11-30')) like '%FORBIDDEN%', 'isolation: another company is refused');
end $$;
do $$ declare d uuid; begin
  select id into d from public.documents where company_id = at.id('A') and total = 1000.05;
  -- 2026-11-01 03:30 UTC is still October 31 in Puerto Rico
  insert into public.payments (company_id, document_id, amount, paid_at, created_by) values
    (at.id('A'), d, 10.10, '2026-11-01 03:30:00+00', at.id('owner')), (at.id('A'), d, 20.20, '2026-11-01 04:30:00+00', at.id('owner')),
    (at.id('A'), d, 5.00, '2026-11-15 12:00:00+00', at.id('owner'));
  update public.payments set voided_at = now(), void_reason = 'error de captura' where amount = 5.00 and company_id = at.id('A');
  perform at.ok(at.val('owner', format('select payments || ''/'' || total_cents from public.assistant_collected(%L, %L, %L)', at.id('A'), '2026-11-01', '2026-11-30')) = '1/2020',
                'collected uses Puerto Rico calendar days and excludes voided payments');
  perform at.ok(at.err('owner', format('select * from public.assistant_collected(%L, %L, %L)', at.id('A'), '2026-11-30', '2026-11-01')) like '%ASSISTANT_INVALID%', 'an inverted range is refused');
exception when others then perform at.ok(false, 'payments setup: ' || sqlerrm);
end $$;
do $$ begin
  insert into public.vendors (id, company_id, name) values (at.id('ven'), at.id('A'), 'Proveedor Inteligente');
  insert into public.bills (company_id, vendor_id, bill_date, due_date, description, currency, total_cents, paid_cents, status) values
    (at.id('A'), at.id('ven'), '2026-10-01', '2026-10-15', 'Renta', 'USD', 150000, 50000, 'partially_paid'),
    (at.id('A'), at.id('ven'), '2026-11-01', '2099-12-01', 'Materiales', 'USD', 20001, 0, 'approved'),
    (at.id('A'), at.id('ven'), '2026-11-01', '2099-12-01', 'Licencia', 'EUR', 9999, 0, 'approved'),
    (at.id('A'), at.id('ven'), '2026-11-01', null, 'Borrador', 'USD', 777, 0, 'draft');
  perform at.ok(at.val('owner', format('select string_agg(currency || '':'' || open_count || ''/'' || open_cents || ''/'' || overdue_cents, '' '' order by currency) from public.assistant_ap_summary(%L)', at.id('A')))
                = 'USD:3/130000/100000', 'payables summary over every open bill, grouped by currency (0024 keeps bills in the base currency), drafts excluded',
                at.val('owner', format('select string_agg(currency || '':'' || open_count || ''/'' || open_cents || ''/'' || overdue_cents, '' '' order by currency) from public.assistant_ap_summary(%L)', at.id('A')))
                || ' rows=' || (select string_agg(status || ':' || total_cents, ',') from public.bills where company_id = at.id('A')));
exception when others then perform at.ok(false, 'payables setup: ' || sqlerrm);
end $$;

-- ------------------------------------------------------------- budget and burst limits
do $$ declare r text; i int; begin
  update public.assistant_limits set company_monthly_budget_nanos = 40000000 where plan = 'pro';   -- USD 0.04; 0.01724 already spent (43 %)
  r := at.begin('member', 'A', at.id('c1'), 'presupuesto');
  perform at.ok(at.finish('member', split_part(r, '|', 1)::uuid, '{"status":"completed","answer":"ok","usage":{"input":1,"output":1,"calls":1},"cost_nanos":30000000,"cost_status":"estimated"}') ~ '^\d+$', 'a turn crosses the budget');
  perform at.ok((select string_agg(detail ->> 'threshold', ',' order by id) from public.assistant_events where event = 'budget_alert' and company_id = at.id('A')) = '50,80,100',
                'budget alerts at 50, 80 and 100 % (each once)');
  perform at.ok(at.begin('admin', 'A', null, 'otra') like '%|false|limit_budget', 'over the monthly budget no new turn starts (for anyone in the company)');
  perform at.ok(exists (select 1 from public.assistant_events where event = 'limit' and detail ->> 'reason' = 'limit_budget'), 'the refusal is audited');
  perform at.ok(at.val('admin', format('select reason || ''/'' || cost_nanos || ''/'' || budget_nanos from public.assistant_quota(%L)', at.id('A'))) = 'limit_budget/47240000/40000000', 'the quota shows cost against budget');
  perform at.ok(at.val('member', format('select reason || ''/'' || coalesce(cost_nanos::text, ''hidden'') from public.assistant_quota(%L)', at.id('A'))) = 'limit_budget/hidden', 'members see the limit, not the company''s AI spend');
  update public.assistant_limits set company_monthly_budget_nanos = 25000000000, company_per_minute = 2, per_minute = 100 where plan = 'pro';
  update public.assistant_usage set minute_start = now() - interval '5 minutes' where company_id = at.id('A');
  perform at.ok(split_part(at.begin('admin', 'A', null, 'uno'), '|', 3) = 'true' and split_part(at.begin('owner', 'A', null, 'dos'), '|', 3) = 'true', 'two users within the company burst');
  perform at.ok(at.begin('member', 'A', at.id('c1'), 'tres') like '%|false|limit_company_minute', 'A12: a company-wide burst limit protects the shared budget');
  perform at.ok(split_part(at.begin('other', 'B', null, 'otra empresa'), '|', 3) = 'true', 'isolation: another company is not affected');
  update public.assistant_limits set company_per_minute = 20, per_minute = 6, company_monthly_budget_nanos = 25000000000 where plan = 'pro';
end $$;

-- ------------------------------------------------------------- key rotation
do $$ begin
  perform public.assistant_set_server_key('k2', encode(sha256('second-local-test-key'::bytea), 'base64'));
  perform public.assistant_retire_server_key('k1', now() + interval '1 hour');
  update public.assistant_usage set minute_start = now() - interval '5 minutes';
  perform at.ok(split_part(at.begin('member', 'A', at.id('c1'), 'en gracia'), '|', 3) = 'true', 'rotation: the old key still works during its grace period');
  perform public.assistant_retire_server_key('k1', now() - interval '1 second');
  perform at.ok(at.begin('member', 'A', at.id('c1'), 'retirada') like '%ASSISTANT_SERVER_AUTH%', 'rotation: a retired key is refused');
end $$;

-- ------------------------------------------------------------- cascade
do $$ begin
  perform at.ok(at.merr(format('delete from public.companies where id = %L', at.id('A'))) = '', 'a whole company can still be deleted');
  perform at.ok((select count(*) from public.assistant_turns where company_id = at.id('A')) = 0, 'its turns go with it');
end $$;

do $$ begin
  if exists (select 1 from at.failures) then
    raise exception 'INTELLIGENCE TESTS FAILED: %', (select string_agg(msg, ' | ') from at.failures);
  end if;
  raise notice 'ALL INTELLIGENCE TESTS PASSED';
end $$;
