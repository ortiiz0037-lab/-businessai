-- BusinessAI Assistant (0029). TEST-ONLY, local throw-away database with every
-- migration up to 0029. Schema at.
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
grant execute on all functions in schema at to authenticated;

insert into at.ctx values
  ('owner', 'd7000000-0000-4000-8000-000000000001'), ('admin', 'd7000000-0000-4000-8000-000000000002'),
  ('member', 'd7000000-0000-4000-8000-000000000003'), ('other', 'd7000000-0000-4000-8000-000000000004'),
  ('A', 'd8000000-0000-4000-8000-000000000001'), ('B', 'd8000000-0000-4000-8000-000000000002'), ('C', 'd8000000-0000-4000-8000-000000000003');
insert into auth.users (id, email) select val::uuid, key || '@at.test' from at.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (at.id('A'), 'Asistente A', at.id('owner')), (at.id('B'), 'Asistente B', at.id('other')), (at.id('C'), 'Sin plan', at.id('owner'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (at.id('A'), 'cus_at_a', 'sub_at_a', 'basic', 'active'), (at.id('B'), 'cus_at_b', 'sub_at_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (at.id('A'), at.id('owner'), 'owner'), (at.id('A'), at.id('admin'), 'admin'), (at.id('A'), at.id('member'), 'member'),
  (at.id('B'), at.id('other'), 'owner'), (at.id('C'), at.id('owner'), 'owner');

-- ------------------------------------------------------------- permissions and plan
do $$ begin
  perform at.ok((select count(*) from public.role_permissions where permission_key = 'assistant.use') = 3, 'assistant.use: owner, admin and member');
  perform at.ok((select array_agg(role order by role) from public.role_permissions where permission_key = 'assistant.audit') = array['admin', 'owner'], 'assistant.audit: owner and admin only');
  perform at.ok(at.val('member', format('select allowed::text || reason from public.assistant_status(%L)', at.id('A'))) = 'trueok', 'a member of a company with a plan may use the assistant');
  perform at.ok(at.val('owner', format('select allowed::text || reason from public.assistant_status(%L)', at.id('C'))) = 'falseno_plan', 'deny by default: no active subscription, no assistant');
  perform at.ok(at.val('other', format('select allowed::text || reason from public.assistant_status(%L)', at.id('A'))) = 'falseforbidden', 'isolation: a user of another company is refused');
  perform at.ok(at.val('other', format('select allowed::text || reason from public.assistant_consume(%L)', at.id('A'))) = 'falseforbidden', 'isolation: and cannot consume its quota');
  perform at.ok(at.err('other', format('select public.assistant_start_conversation(%L, %L, %L)', at.id('A'), 'x', 'es')) like '%FORBIDDEN%', 'isolation: nor open a conversation there');
  perform at.ok(at.err('owner', format('select public.assistant_start_conversation(%L, %L, %L)', at.id('C'), 'x', 'es')) = '', 'conversations are kept even without a plan (history stays readable)');
end $$;

-- ------------------------------------------------------------- conversations are private
do $$ declare c uuid; begin
  c := at.val('member', format('select public.assistant_start_conversation(%L, %L, %L)', at.id('A'), 'Cobros de octubre', 'es'))::uuid;
  insert into at.ctx values ('conv', c);
  perform at.ok(at.val('member', format('select public.assistant_add_message(%L, %L, %L, %L, %L)', c, 'user', '¿Qué facturas están vencidas?', '[]', '/receivables'))::bigint > 0, 'the author adds a message');
  perform at.ok(at.val('member', format('select public.assistant_add_message(%L, %L, %L, %L)', c, 'assistant', 'Hay 2 facturas vencidas.', '[{"name":"list_invoices","ok":true}]'))::bigint > 0, 'and the answer with its tool trace');
  perform at.ok(at.val('member', format('select count(*)::text from public.assistant_messages where conversation_id = %L', c)) = '2', 'the author reads the conversation');
  perform at.ok(at.val('owner', format('select count(*)::text from public.assistant_messages where conversation_id = %L', c)) = '0'
                and at.val('owner', format('select count(*)::text from public.assistant_conversations where id = %L', c)) = '0', 'privacy: not even the owner reads a member''s conversation');
  perform at.ok(at.val('other', format('select count(*)::text from public.assistant_conversations where id = %L', c)) = '0', 'isolation: another company sees nothing');
  perform at.ok(at.err('owner', format('select public.assistant_add_message(%L, %L, %L)', c, 'user', 'inyectado')) like '%ASSISTANT_NOT_FOUND%', 'nobody else can write into it');
  perform at.ok(at.err('owner', format('select public.assistant_rename_conversation(%L, %L)', c, 'x')) like '%ASSISTANT_NOT_FOUND%', 'nor rename it');
  perform at.ok(at.err('member', format('select public.assistant_add_message(%L, %L, %L)', c, 'system', 'x')) like '%ASSISTANT_INVALID%', 'only user / assistant roles');
  perform at.ok(at.err('member', format('select public.assistant_add_message(%L, %L, %L)', c, 'user', repeat('x', 20001))) like '%ASSISTANT_INVALID%', 'messages are bounded');
  perform at.ok(at.err('member', format('insert into public.assistant_messages (company_id, conversation_id, user_id, role, content) values (%L, %L, %L, %L, %L)', at.id('A'), c, at.id('member'), 'assistant', 'x')) like '%permission denied%',
                'no direct inserts (functions only)');
  perform at.ok(at.err('member', format('update public.assistant_conversations set title = %L where id = %L', 'x', c)) like '%permission denied%'
                and at.err('member', format('delete from public.assistant_conversations where id = %L', c)) like '%permission denied%', 'no direct updates or deletes');
  perform at.ok(at.merr(format('update public.assistant_messages set content = %L where conversation_id = %L', 'x', c)) like '%LEDGER_IMMUTABLE%', 'messages are append-only even for the database owner');
  perform at.ok(at.err('member', format('select public.assistant_rename_conversation(%L, %L)', c, 'Cobros')) = '', 'the author renames it');
  perform at.ok((select title from public.assistant_conversations where id = c) = 'Cobros', 'the new title is stored');
  perform at.ok(at.err('member', format('select public.assistant_archive_conversation(%L, true)', c)) = '', 'the author archives it');
  perform at.ok(at.err('member', format('select public.assistant_add_message(%L, %L, %L)', c, 'user', 'x')) like '%ASSISTANT_LOCKED%', 'an archived conversation takes no new messages');
  perform at.ok(at.err('member', format('select public.assistant_archive_conversation(%L, false)', c)) = '', 'and can be restored');
end $$;

-- ------------------------------------------------------------- actions need the author's confirmation
do $$ declare c uuid := at.id('conv'); a uuid; b uuid; r text; begin
  perform at.ok(at.err('member', format('select public.assistant_propose_action(%L, %L, %L, %L)', c, 'pay_invoice', 'Pagar', '{}')) like '%ASSISTANT_INVALID%', 'unknown action kinds are refused');
  a := at.val('member', format('select public.assistant_propose_action(%L, %L, %L, %L)', c, 'studio_draft', 'Carta de cobro a Cliente X', '{"kind":"letter"}'))::uuid;
  perform at.ok((select status || level from public.assistant_actions where id = a) = 'proposeddraft', 'a proposal is stored as proposed, its level fixed by the database');
  perform at.ok(at.err('owner', format('select * from public.assistant_decide_action(%L, %L)', a, 'confirm')) like '%ASSISTANT_NOT_FOUND%', 'only the author can confirm it (not even the owner)');
  perform at.ok(at.err('other', format('select * from public.assistant_decide_action(%L, %L)', a, 'confirm')) like '%ASSISTANT_NOT_FOUND%', 'isolation: nor another company');
  perform at.ok(at.err('member', format('select public.assistant_finish_action(%L, true)', a)) like '%ASSISTANT_ALREADY_DECIDED%', 'an unconfirmed action cannot be marked executed');
  r := at.val('member', format('select status || (payload ->> %L) from public.assistant_decide_action(%L, %L)', 'kind', a, 'confirm'));
  perform at.ok(r = 'confirmedletter', 'the author confirms it and receives the payload to execute');
  perform at.ok(at.err('member', format('select * from public.assistant_decide_action(%L, %L)', a, 'confirm')) like '%ASSISTANT_ALREADY_DECIDED%', 'a confirmation is valid once (no replay)');
  perform at.ok(at.err('member', format('select public.assistant_finish_action(%L, true, %L)', a, '{"document_id":"x"}')) = '', 'the result is recorded');
  perform at.ok((select status from public.assistant_actions where id = a) = 'executed', 'the action is executed');
  perform at.ok(at.err('member', format('select public.assistant_finish_action(%L, false)', a)) like '%ASSISTANT_ALREADY_DECIDED%', 'and its result cannot be rewritten');
  b := at.val('member', format('select public.assistant_propose_action(%L, %L, %L, %L)', c, 'studio_draft', 'Otro', '{}'))::uuid;
  perform at.ok(at.val('member', format('select status from public.assistant_decide_action(%L, %L)', b, 'cancel')) = 'cancelled', 'a proposal can be cancelled');
  b := at.val('member', format('select public.assistant_propose_action(%L, %L, %L, %L)', c, 'studio_draft', 'Caduca', '{}'))::uuid;
  update public.assistant_actions set expires_at = now() - interval '1 second' where id = b;
  perform at.ok(at.val('member', format('select status from public.assistant_decide_action(%L, %L)', b, 'confirm')) = 'expired', 'an expired proposal cannot be confirmed');
  perform at.ok(at.err('member', format('update public.assistant_actions set status = %L where id = %L', 'confirmed', b)) like '%permission denied%', 'statuses change only through the functions');
  perform at.ok((select array_agg(event order by id) from public.assistant_events where action_id = a) = array['action_proposed', 'action_confirmed', 'action_executed'], 'every step is audited');
  perform at.ok(at.err('member', format('select public.assistant_log(%L, %L, %L)', at.id('A'), c, 'action_executed')) like '%ASSISTANT_INVALID%', 'the app cannot forge action audit events');
  perform at.ok(at.err('member', format('select public.assistant_log(%L, %L, %L, %L)', at.id('A'), c, 'tool', '{"tool":"list_invoices"}')) = '', 'the app logs the tools used');
  perform at.ok(at.err('owner', format('select public.assistant_log(%L, %L, %L)', at.id('A'), c, 'tool')) like '%ASSISTANT_NOT_FOUND%', 'only into the caller''s own conversation');
end $$;

-- the studio action needs studio.edit: remove it from members for one check
do $$ declare c uuid := at.id('conv'); begin
  delete from public.role_permissions where role = 'member' and permission_key = 'studio.edit';
  perform at.ok(at.err('member', format('select public.assistant_propose_action(%L, %L, %L, %L)', c, 'studio_draft', 'x', '{}')) like '%FORBIDDEN%', 'a proposal needs the permission of the action itself');
  insert into public.role_permissions (role, permission_key) values ('member', 'studio.edit');
end $$;

-- ------------------------------------------------------------- audit trail
do $$ declare c uuid := at.id('conv'); begin
  perform at.ok(at.val('admin', format('select count(*)::text from public.assistant_events where company_id = %L', at.id('A')))::int >= 5, 'assistant.audit reads the company audit trail');
  perform at.ok(at.val('admin', format('select count(*)::text from public.assistant_messages where conversation_id = %L', c)) = '0', 'but not the conversation text');
  perform at.ok(at.val('other', format('select count(*)::text from public.assistant_events where company_id = %L', at.id('A'))) = '0', 'isolation: another company reads no audit events');
  perform at.ok(at.merr('delete from public.assistant_events') like '%LEDGER_IMMUTABLE%', 'the audit trail is append-only');
  perform at.ok(not exists (select 1 from public.assistant_events where detail ? 'content' or detail::text like '%vencidas%'), 'the audit trail holds no conversation text');
end $$;

-- ------------------------------------------------------------- limits
do $$ declare i int; begin
  update public.assistant_limits set per_minute = 3 where plan = 'basic';
  for i in 1..3 loop perform at.val('admin', format('select reason from public.assistant_consume(%L)', at.id('A'))); end loop;
  perform at.ok(at.val('admin', format('select allowed::text || reason from public.assistant_consume(%L)', at.id('A'))) = 'falselimit_minute', 'a burst over the per-minute limit is refused');
  update public.assistant_usage set minute_start = now() - interval '2 minutes' where user_id = at.id('admin');
  perform at.ok(at.val('admin', format('select allowed::text from public.assistant_consume(%L)', at.id('A'))) = 'true', 'the minute window resets');
  update public.assistant_limits set per_minute = 120, user_daily_requests = 4 where plan = 'basic';
  perform at.ok(at.val('admin', format('select allowed::text || reason from public.assistant_consume(%L)', at.id('A'))) = 'falselimit_user', 'the daily limit per user applies');
  perform at.ok(at.val('member', format('select allowed::text from public.assistant_consume(%L)', at.id('A'))) = 'true', 'per user: another member still has quota');
  update public.assistant_limits set user_daily_requests = 100, company_daily_requests = 5 where plan = 'basic';
  perform at.ok(at.val('member', format('select allowed::text || reason from public.assistant_consume(%L)', at.id('A'))) = 'falselimit_company', 'the daily limit per company applies');
  update public.assistant_limits set company_daily_requests = 100, company_monthly_tokens = 1000 where plan = 'basic';
  perform at.ok(at.err('member', format('select public.assistant_record_usage(%L, 900, 200)', at.id('A'))) = '', 'tokens are recorded');
  perform at.ok(at.val('member', format('select allowed::text || reason from public.assistant_consume(%L)', at.id('A'))) = 'falselimit_tokens', 'the monthly token budget applies');
  perform at.ok(at.err('member', format('select public.assistant_record_usage(%L, -5, 0)', at.id('A'))) like '%ASSISTANT_INVALID%', 'usage cannot be decreased');
  perform at.ok(at.val('other', format('select allowed::text from public.assistant_consume(%L)', at.id('B'))) = 'true', 'isolation: another company has its own quota');
  perform at.ok(at.val('admin', format('select count(*)::text from public.assistant_usage where company_id = %L', at.id('A')))::int = 2, 'usage: assistant.audit sees the whole company');
  perform at.ok(at.val('member', format('select count(*)::text from public.assistant_usage where company_id = %L', at.id('A'))) = '1', 'usage: a member sees only their own');
  perform at.ok((select count(*) from public.assistant_events where event = 'limit' and company_id = at.id('A')) >= 4, 'refusals for limits are audited');
  update public.assistant_limits set per_minute = 6, user_daily_requests = 30, company_daily_requests = 100, company_monthly_tokens = 2000000 where plan = 'basic';
end $$;

-- ------------------------------------------------------------- cascade
do $$ begin
  perform at.ok(at.merr(format('delete from public.companies where id = %L', at.id('A'))) = '', 'a whole company can still be deleted');
  perform at.ok((select count(*) from public.assistant_conversations where company_id = at.id('A')) = 0 and (select count(*) from public.assistant_events where company_id = at.id('A')) = 0
                and (select count(*) from public.assistant_messages where company_id = at.id('A')) = 0, 'its conversations, messages and audit trail go with it');
  perform at.ok(exists (select 1 from public.assistant_usage where company_id = at.id('B')), 'the other company keeps its data');
end $$;

do $$ begin
  if exists (select 1 from at.failures) then
    raise exception 'ASSISTANT TESTS FAILED: %', (select string_agg(msg, ' | ') from at.failures);
  end if;
  raise notice 'ALL ASSISTANT TESTS PASSED';
end $$;
