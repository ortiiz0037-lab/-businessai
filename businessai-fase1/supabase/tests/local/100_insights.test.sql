-- Intelligence Center insights (0031). TEST-ONLY, local throw-away database with every
-- migration up to 0031. Schema at.
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
  ('owner', 'f1000000-0000-4000-8000-000000000001'), ('admin', 'f1000000-0000-4000-8000-000000000002'),
  ('member', 'f1000000-0000-4000-8000-000000000003'), ('other', 'f1000000-0000-4000-8000-000000000004'),
  ('A', 'f2000000-0000-4000-8000-000000000001'), ('B', 'f2000000-0000-4000-8000-000000000002');
insert into auth.users (id, email) select val::uuid, key || '@ins.test' from at.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (at.id('A'), 'Insights A', at.id('owner')), (at.id('B'), 'Insights B', at.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (at.id('A'), 'cus_in_a', 'sub_in_a', 'pro', 'active'), (at.id('B'), 'cus_in_b', 'sub_in_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (at.id('A'), at.id('owner'), 'owner'), (at.id('A'), at.id('admin'), 'admin'), (at.id('A'), at.id('member'), 'member'), (at.id('B'), at.id('other'), 'owner');

-- fixtures written as the database owner (the server path is covered by suite 98)
do $$ declare c uuid; cb uuid; begin
  insert into public.assistant_conversations (company_id, user_id, title) values (at.id('A'), at.id('member'), 'Conversación secreta del miembro') returning id into c;
  insert into public.assistant_conversations (company_id, user_id, title) values (at.id('B'), at.id('other'), 'B') returning id into cb;
  insert into public.assistant_turns (company_id, conversation_id, user_id, status, started_at, finished_at, provider, model, tier, router, calls, input_tokens, output_tokens, cache_read_tokens, cost_nanos, cost_status, latency_ms, verification) values
    (at.id('A'), c, at.id('member'), 'completed', now(), now(), 'anthropic', 'claude-opus-5-5', 'P2', '{"reason":"x"}', 2, 1000, 100, 4000, 6800000, 'estimated', 2000, 'verified'),
    (at.id('A'), c, at.id('member'), 'completed', now(), now(), 'anthropic', 'claude-opus-5-5', 'P2', '{"reason":"x","fallback_from":["a"]}', 2, 500, 50, 0, 3000000, 'estimated', 4000, 'regenerated'),
    (at.id('A'), c, at.id('owner'), 'completed', now(), now(), 'anthropic', 'claude-haiku-5-5', 'P0', '{"reason":"x"}', 1, 300, 20, 0, 40000, 'estimated', 500, 'none'),
    (at.id('A'), c, at.id('member'), 'error', now(), now(), 'anthropic', 'claude-opus-5-5', 'P2', '{"reason":"x"}', 1, 200, 0, 0, 800000, 'estimated', 9000, null),
    (at.id('A'), c, at.id('member'), 'completed', now() - interval '60 days', now(), 'anthropic', 'claude-opus-5-5', 'P2', '{}', 1, 1, 1, 0, 999999999, 'estimated', 1, 'fallback'),
    (at.id('B'), cb, at.id('other'), 'completed', now(), now(), 'anthropic', 'claude-opus-5-5', 'P2', '{}', 1, 1, 1, 0, 777, 'estimated', 1, 'verified');
  insert into public.assistant_messages (company_id, conversation_id, user_id, role, content) values (at.id('A'), c, at.id('member'), 'user', 'TEXTO PRIVADO DEL MIEMBRO');
  insert into public.assistant_events (company_id, user_id, conversation_id, event, detail) values
    (at.id('A'), at.id('member'), c, 'tool', '{"tool":"list_invoices","ok":true}'), (at.id('A'), at.id('member'), c, 'tool', '{"tool":"list_invoices","ok":true}'),
    (at.id('A'), at.id('member'), c, 'tool_denied', '{"tool":"list_bills","ok":false}'), (at.id('A'), at.id('member'), c, 'flagged', '{"tool":"search_clients"}'),
    (at.id('A'), at.id('owner'), null, 'budget_alert', '{"threshold":50}'), (at.id('B'), at.id('other'), cb, 'flagged', '{}');
  insert into at.ctx values ('from', to_char((now() at time zone 'America/Puerto_Rico')::date - 7, 'YYYY-MM-DD')), ('to', to_char((now() at time zone 'America/Puerto_Rico')::date, 'YYYY-MM-DD'));
end $$;

create function at.ins(who text, co text) returns jsonb language plpgsql as $$
begin return at.val(who, format('select public.assistant_insights(%L, %L, %L)::text', at.id(co), (select val from at.ctx where key = 'from'), (select val from at.ctx where key = 'to')))::jsonb; end $$;
grant execute on all functions in schema at to authenticated;

do $$ declare j jsonb; m jsonb; begin
  j := at.ins('owner', 'A');
  perform at.ok((j ->> 'turns')::int = 4, 'counts every turn of the period (and only of the period)');
  perform at.ok(j ->> 'cost_nanos' = '10640000', 'cost in exact nano-dollars, as text');
  perform at.ok((j -> 'by_status' ->> 'completed')::int = 3 and (j -> 'by_status' ->> 'error')::int = 1, 'outcomes by status');
  perform at.ok((j -> 'verification' ->> 'verified')::int = 1 and (j -> 'verification' ->> 'regenerated')::int = 1 and (j -> 'verification' ->> 'none')::int = 2, 'verification of figures');
  select x into m from jsonb_array_elements(j -> 'by_model') x where x ->> 'model' = 'claude-opus-5-5';
  perform at.ok((m ->> 'turns')::int = 3 and m ->> 'cost_nanos' = '10600000' and m ->> 'input_tokens' = '1700' and (m ->> 'fallbacks')::int = 1 and (m ->> 'avg_latency_ms')::int = 5000, 'per model: requests, cost, tokens, fallbacks, latency');
  perform at.ok((j -> 'by_tier' ->> 'P2')::int = 3 and (j -> 'by_tier' ->> 'P0')::int = 1, 'per precision tier');
  perform at.ok((j -> 'events' ->> 'flagged')::int = 1 and (j -> 'events' ->> 'tool_denied')::int = 1 and (j -> 'events' ->> 'budget_alert')::int = 1, 'security and limit events (of this company only)');
  perform at.ok((select (x ->> 'calls')::int from jsonb_array_elements(j -> 'tools') x where x ->> 'tool' = 'list_invoices') = 2, 'tool usage');
  perform at.ok(jsonb_array_length(j -> 'by_user') = 2 and (j -> 'by_user' -> 0 ->> 'user_id') = at.id('member')::text, 'per user, most active first');
  perform at.ok(j::text not like '%TEXTO PRIVADO%' and j::text not like '%secreta%', 'never the conversation text or titles');
  perform at.ok((at.ins('admin', 'A') ->> 'turns')::int = 4, 'the admin (assistant.audit) sees the same');
  perform at.ok(at.err('member', format('select public.assistant_insights(%L, %L, %L)', at.id('A'), '2026-01-01', '2026-01-31')) like '%FORBIDDEN%', 'a member cannot see the company''s insights');
  perform at.ok(at.err('other', format('select public.assistant_insights(%L, %L, %L)', at.id('A'), '2026-01-01', '2026-01-31')) like '%FORBIDDEN%', 'isolation: another company cannot either');
  perform at.ok((at.ins('other', 'B') ->> 'turns')::int = 1, 'each company sees its own');
  perform at.ok(at.err('owner', format('select public.assistant_insights(%L, %L, %L)', at.id('A'), '2024-01-01', '2026-01-31')) like '%ASSISTANT_INVALID%', 'the period is bounded (one year)');
  perform at.ok(at.err('owner', format('select public.assistant_insights(%L, %L, %L)', at.id('A'), '2026-02-01', '2026-01-01')) like '%ASSISTANT_INVALID%', 'an inverted period is refused');
end $$;

do $$ begin
  if exists (select 1 from at.failures) then
    raise exception 'INSIGHTS TESTS FAILED: %', (select string_agg(msg, ' | ') from at.failures);
  end if;
  raise notice 'ALL INSIGHTS TESTS PASSED';
end $$;
