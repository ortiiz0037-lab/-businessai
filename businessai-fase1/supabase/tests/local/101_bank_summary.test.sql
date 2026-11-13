-- Bank summary for the assistant (0032). TEST-ONLY, local throw-away database with every
-- migration up to 0032. Schema at.
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
  ('owner', 'f3000000-0000-4000-8000-000000000001'), ('admin', 'f3000000-0000-4000-8000-000000000002'),
  ('member', 'f3000000-0000-4000-8000-000000000003'), ('other', 'f3000000-0000-4000-8000-000000000004'),
  ('A', 'f4000000-0000-4000-8000-000000000001'), ('B', 'f4000000-0000-4000-8000-000000000002');
insert into auth.users (id, email) select val::uuid, key || '@bank.test' from at.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (at.id('A'), 'Bank A', at.id('owner')), (at.id('B'), 'Bank B', at.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (at.id('A'), 'cus_bk_a', 'sub_bk_a', 'pro', 'active'), (at.id('B'), 'cus_bk_b', 'sub_bk_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (at.id('A'), at.id('owner'), 'owner'), (at.id('A'), at.id('admin'), 'admin'), (at.id('A'), at.id('member'), 'member'), (at.id('B'), at.id('other'), 'owner');
create function at.acct(co uuid, c text) returns uuid language sql stable as $$ select id from public.ledger_accounts where company_id = co and code = c $$;
grant execute on function at.acct(uuid, text) to authenticated;

-- fixtures through the product's own functions, as the owner
do $$ declare acc uuid; rows jsonb; begin
  perform at.val('owner', format('select public.ledger_init(%L)::text', at.id('A')));
  perform at.val('owner', format('select public.ledger_post_manual(%L, %L, %L, null, %L)::text', at.id('A'), public.ba_today() - 30, 'Capital', jsonb_build_array(
    jsonb_build_object('account', at.acct(at.id('A'), '1010'), 'debit', 1000001, 'credit', 0), jsonb_build_object('account', at.acct(at.id('A'), '3000'), 'debit', 0, 'credit', 1000001))));
  perform at.val('owner', format('select public.ledger_post_manual(%L, %L, %L, null, %L)::text', at.id('A'), public.ba_today() - 1, 'Gasto', jsonb_build_array(
    jsonb_build_object('account', at.acct(at.id('A'), '6200'), 'debit', 2500, 'credit', 0), jsonb_build_object('account', at.acct(at.id('A'), '1010'), 'debit', 0, 'credit', 2500))));
  perform at.val('owner', format('select public.bank_init(%L)::text', at.id('A')));
  acc := at.val('owner', format('select public.bank_save_account(%L, null, %L, %L, %L, %L, %L)::text', at.id('A'), 'Operativa', 'Banco Prueba', '1234', at.acct(at.id('A'), '1010'), 'USD'))::uuid;
  insert into at.ctx values ('acc', acc);
  rows := jsonb_build_array(
    jsonb_build_object('date', to_char(public.ba_today() - 20, 'YYYY-MM-DD'), 'amount_cents', '55000', 'description', 'Depósito'),
    jsonb_build_object('date', to_char(public.ba_today() - 10, 'YYYY-MM-DD'), 'amount_cents', '-23041', 'description', 'Pago'),
    jsonb_build_object('date', to_char(public.ba_today() - 2, 'YYYY-MM-DD'), 'amount_cents', '-1', 'description', 'Comisión'));
  perform at.val('owner', format('select public.bank_import(%L, %L, %L, %L, %L)::text', acc, 'extracto.csv', repeat('b', 64), '{}', rows));
  perform at.val('owner', format('select public.bank_reconciliation_create(%L, %L, %L, 0, 0)::text', acc, date_trunc('month', public.ba_today())::date, public.ba_today()));
end $$;

create function at.bank(who text, co text, d date default null) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', at.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into r from public.assistant_bank_summary(at.id(co), d) x;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant execute on function at.bank(text, text, date) to authenticated;

do $$ declare j jsonb; a jsonb; begin
  j := at.bank('owner', 'A'); a := j -> 0;
  perform at.ok(jsonb_array_length(j) = 1, 'one bank account');
  perform at.ok((a ->> 'lines_count')::int = 3 and (a ->> 'unmatched_count')::int = 3, 'every line counted (3), all unmatched');
  perform at.ok(a ->> 'unmatched_cents' = '31958', 'unmatched amount exact in cents, as text (55000 − 23041 − 1)');
  perform at.ok(a ->> 'ledger_balance_cents' = '997501', 'posted ledger balance of the linked account (1,000,001 − 2,500)');
  perform at.ok(a ->> 'last_rec_status' = 'open' and (a ->> 'last_rec_period_end')::date = public.ba_today(), 'last reconciliation and its status');
  perform at.ok((a ->> 'last_line_date')::date = public.ba_today() - 2 and (a ->> 'as_of')::date = public.ba_today(), 'last line date and as-of default to today');
  -- as of an earlier date: later lines and entries are excluded
  a := at.bank('owner', 'A', public.ba_today() - 15) -> 0;
  perform at.ok((a ->> 'lines_count')::int = 1 and a ->> 'unmatched_cents' = '55000' and a ->> 'ledger_balance_cents' = '1000001' and (a ->> 'last_line_date')::date = public.ba_today() - 20, 'as-of date bounds lines, ledger and last line');
  -- a line no longer unmatched leaves the unmatched totals
  update public.bank_lines set status = 'excluded' where bank_account_id = at.id('acc') and amount_cents = -1;
  a := at.bank('owner', 'A') -> 0;
  perform at.ok((a ->> 'unmatched_count')::int = 2 and a ->> 'unmatched_cents' = '31959' and (a ->> 'lines_count')::int = 3, 'excluded line: still a statement line, no longer unmatched');
  perform at.ok(at.err('member', format('select public.assistant_bank_summary(%L)', at.id('A'))) like '%FORBIDDEN%', 'bank.view is required (a member cannot)');
  perform at.ok(at.err('other', format('select public.assistant_bank_summary(%L)', at.id('A'))) like '%FORBIDDEN%', 'isolation: another company cannot read it');
  perform at.ok(at.bank('other', 'B') = '[]'::jsonb, 'each company sees only its own accounts');
  -- the ledger balance needs accounting.view: without it the bank figures remain, the ledger balance is null
  delete from public.role_permissions where role = 'admin' and permission_key = 'accounting.view';
  a := at.bank('admin', 'A') -> 0;
  perform at.ok(a ->> 'unmatched_cents' = '31959' and a -> 'ledger_balance_cents' = 'null'::jsonb, 'without accounting.view the ledger balance is withheld');
  insert into public.role_permissions (role, permission_key) values ('admin', 'accounting.view');
  perform at.ok(not has_function_privilege('anon', 'public.assistant_bank_summary(uuid, date)', 'EXECUTE'), 'anon cannot execute');
  perform at.ok(not (select prosecdef from pg_proc where oid = 'public.assistant_bank_summary(uuid, date)'::regprocedure), 'SECURITY INVOKER (RLS applies)');
  perform at.ok((select 'search_path=""' = any(proconfig) from pg_proc where oid = 'public.assistant_bank_summary(uuid, date)'::regprocedure), 'fixed empty search_path');
end $$;

do $$ begin
  if exists (select 1 from at.failures) then
    raise exception 'BANK SUMMARY TESTS FAILED: %', (select string_agg(msg, ' | ') from at.failures);
  end if;
  raise notice 'ALL BANK SUMMARY TESTS PASSED';
end $$;
