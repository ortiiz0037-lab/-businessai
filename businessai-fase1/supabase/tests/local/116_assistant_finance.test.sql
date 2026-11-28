-- Assistant S4 proposals (0040). TEST-ONLY, local throw-away database with
-- every migration up to 0040. Schema af: the two new proposal kinds are
-- accepted only on the proposer's own open turn and only with Studio AND the
-- module that owns the record (documents.view / payables.view); unknown kinds
-- are refused; proposals are drafts (level 'draft'); nothing is written to
-- Finance.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema af;
create table af.ctx (key text primary key, val text not null);
create function af.id(k text) returns uuid language sql stable as $$ select val::uuid from af.ctx where key = k $$;
create table af.failures (msg text);
create function af.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into af.failures values (msg); end if;
end $$;
create function af.call(who text, stmt text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', af.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt into r; exception when others then r := 'ERR:' || sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function af.propose(who text, turn text, kind text) returns text language sql as $$
  select af.call(who, format('select public.assistant_propose(%L, %L, %L, %L)::text', af.id(turn), kind, 'Propuesta ' || kind, '{"invoice_id":"x"}'))
$$;
grant usage on schema af to authenticated;
grant select on af.ctx to authenticated;
grant execute on all functions in schema af to authenticated;
insert into af.ctx values
  ('owner', 'f2100000-0000-4000-8000-000000000001'), ('member', 'f2100000-0000-4000-8000-000000000003'), ('other', 'f2100000-0000-4000-8000-000000000004'),
  ('A', 'f2200000-0000-4000-8000-000000000001'), ('B', 'f2200000-0000-4000-8000-000000000002'),
  ('cO', 'f2300000-0000-4000-8000-000000000001'), ('cM', 'f2300000-0000-4000-8000-000000000003'), ('cX', 'f2300000-0000-4000-8000-000000000004'),
  ('tO', 'f2400000-0000-4000-8000-000000000001'), ('tM', 'f2400000-0000-4000-8000-000000000003'), ('tX', 'f2400000-0000-4000-8000-000000000004'),
  ('tDone', 'f2400000-0000-4000-8000-000000000009');
insert into auth.users (id, email) select val::uuid, key || '@af.test' from af.ctx where key in ('owner', 'member', 'other');
insert into public.companies (id, name, created_by) values (af.id('A'), 'Asistente A', af.id('owner')), (af.id('B'), 'Asistente B', af.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (af.id('A'), 'cus_af_a', 'sub_af_a', 'premium', 'active'), (af.id('B'), 'cus_af_b', 'sub_af_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values (af.id('A'), af.id('owner'), 'owner'), (af.id('A'), af.id('member'), 'member'), (af.id('B'), af.id('other'), 'owner');
insert into public.assistant_conversations (id, company_id, user_id, title) values
  (af.id('cO'), af.id('A'), af.id('owner'), 'Cobros'), (af.id('cM'), af.id('A'), af.id('member'), 'Miembro'), (af.id('cX'), af.id('B'), af.id('other'), 'Otra');
-- open turns as the server would start them (0030 signs this; the test inserts directly as the superuser)
insert into public.assistant_turns (id, company_id, conversation_id, user_id) values
  (af.id('tO'), af.id('A'), af.id('cO'), af.id('owner')), (af.id('tM'), af.id('A'), af.id('cM'), af.id('member')), (af.id('tX'), af.id('B'), af.id('cX'), af.id('other'));
insert into public.assistant_turns (id, company_id, conversation_id, user_id, status) values (af.id('tDone'), af.id('A'), af.id('cO'), af.id('owner'), 'completed');

do $$
declare r text; before bigint := (select count(*) from public.payments) + (select count(*) from public.bill_payments) + (select count(*) from public.journal_entries);
begin
  r := af.propose('owner', 'tO', 'studio_collection_letter');
  perform af.ok(r ~ '^[0-9a-f-]{36}$', 'the owner may propose a collection letter: ' || r);
  perform af.ok((select level || '/' || status from public.assistant_actions where id = r::uuid) = 'draft/proposed', 'it is a draft proposal, waiting for confirmation');
  r := af.propose('owner', 'tO', 'studio_payment_voucher');
  perform af.ok(r ~ '^[0-9a-f-]{36}$', 'and a payment voucher: ' || r);
  perform af.ok(af.propose('member', 'tM', 'studio_payment_voucher') like '%FORBIDDEN%', 'a member (no payables.view) cannot propose a payment voucher');
  r := af.propose('member', 'tM', 'studio_collection_letter');
  perform af.ok((r ~ '^[0-9a-f-]{36}$') = (af.call('member', format('select public.has_permission(%L, %L)::text', af.id('A'), 'documents.view')) = 'true')
                and (r ~ '^[0-9a-f-]{36}$' or r like '%FORBIDDEN%'), 'a member proposes a collection letter exactly when it holds documents.view: ' || r);
  perform af.ok(af.propose('owner', 'tO', 'pay_bill') like '%ASSISTANT_INVALID%', 'an unknown kind (e.g. paying) is refused');
  perform af.ok(af.propose('owner', 'tM', 'studio_collection_letter') like '%ASSISTANT_NOT_FOUND%', 'not on another user''s turn');
  perform af.ok(af.propose('owner', 'tDone', 'studio_collection_letter') like '%ASSISTANT_NOT_FOUND%', 'not on a finished turn');
  perform af.ok(af.propose('other', 'tO', 'studio_collection_letter') like '%ASSISTANT_NOT_FOUND%', 'another company cannot use the turn');
  perform af.ok(af.call('member', format('select count(*)::text from public.assistant_actions where company_id = %L and kind = %L', af.id('A'), 'studio_payment_voucher')) = '0',
                'a member does not see the owner''s proposals');
  perform af.ok(af.call('owner', format('insert into public.assistant_actions (company_id, conversation_id, user_id, kind, level, summary, payload) values (%L, %L, %L, %L, %L, %L, %L) returning id::text',
                af.id('A'), af.id('cO'), af.id('owner'), 'studio_payment_voucher', 'draft', 'x', '{}')) like 'ERR:%', 'proposals are not written directly');
  perform af.ok((select count(*) from public.payments) + (select count(*) from public.bill_payments) + (select count(*) from public.journal_entries) = before, 'no payment or ledger entry was written');
end $$;

do $$ begin
  if exists (select 1 from af.failures) then raise exception 'ASSISTANT FINANCE TESTS FAILED: %', (select string_agg(msg, '; ') from af.failures); end if;
  raise notice 'ALL ASSISTANT FINANCE TESTS PASSED';
end $$;
