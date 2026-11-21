-- S9.2 · Page boundaries of the reads the app now does in pages (the Supabase API returns at most
-- 1 000 rows per request). For each set-returning function and order used by the app
-- (src: fetchAllPages(... .order(...).range(a, b))), the pages are read exactly as PostgREST does
-- (LIMIT / OFFSET over the function call) and must add up to the full result: no row lost, none
-- repeated, totals identical — at 999, 1 000, 1 001 and several pages. The ledger activity keeps
-- its own chronological order (date, entry, line) through the pages, including several lines of one
-- entry on the same account, and its last running balance equals the account balance.
-- TEST-ONLY, local throw-away database with 0014a … 0045. Schema pg9.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema pg9;
create table pg9.failures (msg text);
create function pg9.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg; else raise notice 'FAIL: %', msg; insert into pg9.failures values (msg); end if;
end $$;
-- run a query as the owner (RLS and permission checks of the functions apply)
create function pg9.as_owner(q text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
grant usage on schema pg9 to authenticated;
grant execute on all functions in schema pg9 to authenticated;
-- every page of `fn_call` ordered by `ord` (what fetchAllPages + PostgREST do), as one json array
create function pg9.paged(fn_call text, ord text, total integer) returns jsonb language plpgsql as $$
declare res jsonb := '[]'::jsonb; page jsonb; off integer := 0;
begin
  loop
    page := pg9.as_owner(format('select coalesce(jsonb_agg(to_jsonb(s)), ''[]'') from (select * from %s %s limit 1000 offset %s) s', fn_call, ord, off));
    res := res || page;
    exit when jsonb_array_length(page) < 1000;
    off := off + 1000;
    if off > total + 2000 then exit; end if;
  end loop;
  return res;
end $$;
create function pg9.full(fn_call text, ord text) returns jsonb language sql as $$
  select pg9.as_owner(format('select coalesce(jsonb_agg(to_jsonb(s)), ''[]'') from (select * from %s %s) s', fn_call, ord)) $$;

insert into auth.users (id, email) values ('a9000000-0000-4000-8000-000000000001', 'owner@pg9.test');
insert into public.companies (id, name, created_by) values ('a9100000-0000-4000-8000-000000000001', 'Paginación', 'a9000000-0000-4000-8000-000000000001');
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('a9100000-0000-4000-8000-000000000001', 'cus_pg9', 'sub_pg9', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values ('a9100000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'owner');
insert into public.branches (id, company_id, name, code) values ('a9200000-0000-4000-8000-000000000001', 'a9100000-0000-4000-8000-000000000001', 'Única', 'UNI');
insert into public.clients (id, company_id, name) select ('a9300000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'a9100000-0000-4000-8000-000000000001', 'Cliente ' || g from generate_series(1, 1001) g;

-- ------------------------------------------------------------- open invoices: 999 → 1 000 → 1 001 → 2 500
do $$
declare target integer; n integer; full_rows jsonb; paged_rows jsonb; co text := 'a9100000-0000-4000-8000-000000000001';
begin
  foreach target in array array[999, 1000, 1001, 2500] loop
    select count(*) into n from public.documents where company_id = co::uuid;
    insert into public.documents (company_id, client_id, document_type, document_number, status, subtotal, total, issue_date, due_date)
    select co::uuid, ('a9300000-0000-4000-8000-' || lpad((1 + (g % 1001))::text, 12, '0'))::uuid, 'invoice', 'PG-' || g, 'sent', 10 + (g % 7), 10 + (g % 7), public.ba_today() - (g % 120), public.ba_today() + 30 - (g % 90)
    from generate_series(n + 1, target) g;
    full_rows := pg9.full(format('public.ar_invoice_balances(%L, null)', co), 'order by document_id');
    paged_rows := pg9.paged(format('public.ar_invoice_balances(%L, null)', co), 'order by document_id', target);
    perform pg9.ok(jsonb_array_length(full_rows) = target and paged_rows = full_rows
                   and (select count(distinct x ->> 'document_id') from jsonb_array_elements(paged_rows) x) = target,
      format('ar_invoice_balances, %s open invoices: the pages hold every invoice once (%s rows)', target, jsonb_array_length(paged_rows)));
    perform pg9.ok((select sum((x ->> 'balance_cents')::bigint) from jsonb_array_elements(paged_rows) x)
                   = (select sum(round(total * 100))::bigint from public.documents where company_id = co::uuid and status = 'sent'),
      format('… and the receivable total from the pages equals the invoices (%s)', target));
  end loop;
end $$;

-- ------------------------------------------------------------- aging by client (1 001 clients, the app's order + tiebreaker)
do $$
declare co text := 'a9100000-0000-4000-8000-000000000001'; f jsonb; p jsonb; ord text := 'order by overdue_cents desc, total_cents desc, client_id';
begin
  f := pg9.full(format('public.ar_aging(%L, null)', co), ord);
  p := pg9.paged(format('public.ar_aging(%L, null)', co), ord, 1001);
  perform pg9.ok(jsonb_array_length(f) = 1001 and p = f, 'ar_aging, 1 001 clients: pages equal the full result, most overdue first');
  perform pg9.ok((select sum((x ->> 'total_cents')::bigint) from jsonb_array_elements(p) x) = (select sum(round(total * 100))::bigint from public.documents where company_id = co::uuid and status = 'sent'),
    'ar_aging: the aging total from the pages equals the open invoices');
  -- without the tiebreaker the order is not total (many clients share the same amounts): the test shows why it is needed
  perform pg9.ok((select count(*) from (select (x ->> 'overdue_cents'), (x ->> 'total_cents') from jsonb_array_elements(f) x group by 1, 2 having count(*) > 1) d) > 0,
    'ar_aging: many clients share the same amounts (the client_id tiebreaker is required for stable pages)');
end $$;

-- ------------------------------------------------------------- ledger activity: chronological, several lines of one entry on one account
do $$
declare co uuid := 'a9100000-0000-4000-8000-000000000001'; acct uuid; f jsonb; p jsonb; bal bigint; i integer;
begin
  select id into acct from public.ledger_accounts where company_id = co and system_key = 'accounts_receivable';
  -- entries with two lines on the same account (receivable) inside one entry
  perform set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  for i in 1..30 loop
    perform public.ledger_post(co, public.ba_today() - 1, 'Reclasificación ' || i, null, 'manual', null,
      jsonb_build_array(jsonb_build_object('account', acct, 'debit', 100 + i), jsonb_build_object('account', acct, 'debit', 7),
                        jsonb_build_object('key', 'sales_revenue', 'credit', 107 + i)), 'pg9-multi-' || lpad(i::text, 4, '0'));
  end loop;
  perform set_config('request.jwt.claims', '', true);
  f := pg9.full(format('public.ledger_account_activity(%L, %L, %L)', acct, public.ba_today() - 400, public.ba_today() + 1), '');
  p := pg9.paged(format('public.ledger_account_activity(%L, %L, %L)', acct, public.ba_today() - 400, public.ba_today() + 1), '', 2600);
  perform pg9.ok(jsonb_array_length(f) > 2500 and p = f, format('ledger_account_activity, %s rows: pages in the function''s own order equal the full result', jsonb_array_length(f)));
  select coalesce(sum(l.debit_cents - l.credit_cents), 0) into bal from public.journal_lines l where l.account_id = acct;
  perform pg9.ok((p -> (jsonb_array_length(p) - 1) ->> 'balance_cents')::bigint = bal, 'ledger_account_activity: the last running balance of the pages equals the account balance');
  perform pg9.ok(not exists (select 1 from jsonb_array_elements(p) with ordinality a(x, n) join jsonb_array_elements(p) with ordinality b(y, m) on m = n + 1
                              where (x ->> 'entry_date') > (y ->> 'entry_date') and x ->> 'source' <> 'opening'), 'ledger_account_activity: dates never go backwards across pages');
end $$;

-- ------------------------------------------------------------- inventory levels: 1 001 stock keys
do $$
declare co uuid := 'a9100000-0000-4000-8000-000000000001'; br uuid := 'a9200000-0000-4000-8000-000000000001'; f jsonb; p jsonb;
begin
  insert into public.catalog_items (id, company_id, code, name, kind, unit, price_cents, track_inventory)
  select ('a9400000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, co, 'SKU-' || g, 'Producto ' || g, 'product', 'unidad', 100, true from generate_series(1, 1001) g;
  perform ba_private.inv_post(co, br, null, ('a9400000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, null, 'opening', g, 50, 'inicial', 'manual', null, null, null, 'pg9-open-' || g)
  from generate_series(1, 1001) g;
  f := pg9.full(format('public.inventory_levels(%L, null)', co), 'order by branch_id, item_id, variant_key');
  p := pg9.paged(format('public.inventory_levels(%L, null)', co), 'order by branch_id, item_id, variant_key', 1001);
  perform pg9.ok(jsonb_array_length(f) = 1001 and p = f, 'inventory_levels, 1 001 stock keys: pages equal the full result');
  perform pg9.ok((select sum((x ->> 'on_hand')::numeric * (x ->> 'avg_cost_cents')::numeric) from jsonb_array_elements(p) x) = (select sum(g) * 50 from generate_series(1, 1001) g),
    'inventory value from the pages = Σ on hand × average cost (no key lost)');
end $$;

do $$ begin
  if exists (select 1 from pg9.failures) then raise exception 'PAGINATION TESTS FAILED: %', (select string_agg(msg, '; ') from pg9.failures); end if;
  raise notice 'ALL PAGINATION TESTS PASSED';
end $$;
