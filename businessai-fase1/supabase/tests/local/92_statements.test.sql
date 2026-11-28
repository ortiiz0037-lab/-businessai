-- Financial statements, budgets and budget vs actual (0027). TEST-ONLY,
-- local throw-away database with 0014a, 0015, 0020, 0023 … 0027. Schema fs.
-- PY = two years ago, CY = last year: every date is in the past.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema fs;
create table fs.ctx (key text primary key, val text not null);
create function fs.id(k text) returns uuid language sql stable as $$ select val::uuid from fs.ctx where key = k $$;
create table fs.failures (msg text);
create function fs.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into fs.failures values (msg); end if;
end $$;
grant usage on schema fs to authenticated;
grant select on fs.ctx to authenticated;
grant execute on all functions in schema fs to authenticated;
create function fs.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', fs.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function fs.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', fs.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function fs.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
create function fs.cy() returns int language sql stable as $$ select extract(year from public.ba_today())::int - 1 $$;
create function fs.py() returns int language sql stable as $$ select extract(year from public.ba_today())::int - 2 $$;
create function fs.dt(y int, m int, d int) returns date language sql immutable as $$ select make_date(y, m, d) $$;
create function fs.acct(co text, c text) returns uuid language sql volatile as $$ select id from public.ledger_accounts where company_id = fs.id(co) and code = c $$;
-- A manual entry by the owner: pairs of (code, debit, credit).
create function fs.je(co text, who text, d date, descr text, lines jsonb) returns text language plpgsql as $$
begin
  return fs.err(who, format('select public.ledger_post_manual(%L, %L, %L, null, %L)', fs.id(co), d, descr,
    (select jsonb_agg(jsonb_build_object('account', fs.acct(co, x ->> 0), 'debit', (x ->> 1)::bigint, 'credit', (x ->> 2)::bigint)) from jsonb_array_elements(lines) x)));
end $$;
-- Section total of a statement (as the owner).
create function fs.sec(fn text, co text, section text, a date, b date default null) returns bigint language plpgsql volatile as $$
begin
  return coalesce(fs.val('owner', format('select sum(amount_cents) from public.%s(%L, %L%s) where section = %L', fn, fs.id(co), a,
    case when b is null then '' else format(', %L', b) end, section))::bigint, 0);
end $$;

insert into fs.ctx values
  ('owner', 'b1000000-0000-4000-8000-0000000000c1'), ('admin', 'b1000000-0000-4000-8000-0000000000c2'),
  ('member', 'b1000000-0000-4000-8000-0000000000c3'), ('other', 'b1000000-0000-4000-8000-0000000000c4'),
  ('A', 'b2000000-0000-4000-8000-0000000000c1'), ('B', 'b2000000-0000-4000-8000-0000000000c2'), ('C', 'b2000000-0000-4000-8000-0000000000c3'),
  ('dep', 'b3000000-0000-4000-8000-0000000000c1');
insert into auth.users (id, email) select val::uuid, key || '@fs.test' from fs.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (fs.id('A'), 'Estados A', fs.id('owner')), (fs.id('B'), 'Estados B', fs.id('other')), (fs.id('C'), 'Vacía C', fs.id('other'));
insert into public.memberships (company_id, user_id, role) values
  (fs.id('A'), fs.id('owner'), 'owner'), (fs.id('A'), fs.id('admin'), 'admin'), (fs.id('A'), fs.id('member'), 'member'),
  (fs.id('B'), fs.id('other'), 'owner'), (fs.id('C'), fs.id('other'), 'owner');
insert into public.departments (id, company_id, name) values (fs.id('dep'), fs.id('A'), 'Ventas');

-- ------------------------------------------------------------- the books
do $$ declare py int := fs.py(); cy int := fs.cy(); begin
  perform fs.ok(fs.err('owner', format('select public.ledger_init(%L)', fs.id('A'))) = '', 'company A: ledger');
  perform fs.ok(fs.err('admin', format('insert into public.ledger_accounts (company_id, code, name, type) values (%L, %L, %L, %L), (%L, %L, %L, %L), (%L, %L, %L, %L), (%L, %L, %L, %L), (%L, %L, %L, %L)',
                fs.id('A'), '8100', 'Gastos financieros', 'expense', fs.id('A'), '9100', 'Impuesto sobre ingresos', 'expense', fs.id('A'), '2200', 'Impuesto sobre ingresos por pagar', 'liability',
                fs.id('A'), '1590', 'Depreciación acumulada', 'asset', fs.id('A'), '6900', 'Depreciación', 'expense')) = '', 'accounts: interest, income tax, tax payable, accumulated depreciation, depreciation');
  perform fs.ok(fs.err('admin', format('update public.ledger_accounts set statement_class = %L where id = %L', 'operating_revenue', fs.acct('A', '1590'))) like '%statement_class_check%',
                'a class must fit the account type');
  perform fs.ok(fs.err('member', format('update public.ledger_accounts set statement_class = %L where id = %L', 'accumulated_depreciation', fs.acct('A', '1590'))) = ''
                and (select statement_class from public.ledger_accounts where id = fs.acct('A', '1590')) is null, 'members do not classify accounts');
  perform fs.ok(fs.err('admin', format('update public.ledger_accounts set statement_class = %L where id = %L', 'accumulated_depreciation', fs.acct('A', '1590'))) = '', 'the admin classifies 1590');
  perform fs.ok((select public.fs_class(fs.acct('A', '1010'))) = 'cash' and public.fs_class(fs.acct('A', '1500')) = 'non_current_asset' and public.fs_class(fs.acct('A', '4900')) = 'other_income'
                and public.fs_class(fs.acct('A', '5000')) = 'cost_of_sales' and public.fs_class(fs.acct('A', '8100')) = 'other_expense' and public.fs_class(fs.acct('A', '9100')) = 'income_tax'
                and public.fs_class(fs.acct('A', '2500')) = 'non_current_liability' and public.fs_class(fs.acct('A', '3100')) = 'retained_earnings', 'derived classes from code and system keys');
  -- previous year
  perform fs.ok(fs.je('A', 'owner', fs.dt(py, 3, 1), 'Capital inicial', '[["1010",1000000,0],["3000",0,1000000]]') = ''
                and fs.je('A', 'owner', fs.dt(py, 6, 15), 'Venta', '[["1200",300000,0],["4000",0,300000]]') = ''
                and fs.je('A', 'owner', fs.dt(py, 7, 1), 'Cobro', '[["1010",200000,0],["1200",0,200000]]') = ''
                and fs.je('A', 'owner', fs.dt(py, 8, 1), 'Renta', '[["6200",50000,0],["1010",0,50000]]') = '', 'previous year: capital, sale, collection, rent');
  -- current (last) year
  perform fs.ok(fs.je('A', 'owner', fs.dt(cy, 1, 10), 'Venta', '[["1200",500000,0],["4000",0,470000],["4900",0,30000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 1, 20), 'Costo', '[["5000",120000,0],["2000",0,120000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 2, 5), 'Cobro', '[["1010",400000,0],["1200",0,400000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 2, 10), 'Pago proveedor', '[["2000",100000,0],["1010",0,100000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 3, 1), 'Equipo', '[["1500",250000,0],["1010",0,250000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 3, 2), 'Préstamo', '[["1010",300000,0],["2500",0,300000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 4, 1), 'Nómina', '[["6100",80000,0],["1010",0,80000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 5, 1), 'Intereses', '[["8100",5000,0],["1010",0,5000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 6, 1), 'Impuesto', '[["9100",40000,0],["2200",0,40000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 7, 1), 'Depreciación', '[["6900",25000,0],["1590",0,25000]]') = ''
                and fs.je('A', 'owner', fs.dt(cy, 8, 1), 'Retiro del dueño', '[["3000",20000,0],["1010",0,20000]]') = '', 'last year: 11 entries');
end $$;

-- ------------------------------------------------------------- income statement
do $$ declare cy int := fs.cy(); py int := fs.py(); a date := fs.dt(fs.cy(), 1, 1); b date := fs.dt(fs.cy(), 12, 31); begin
  perform fs.ok(fs.sec('fs_income_statement', 'A', 'operating_revenue', a, b) = 470000 and fs.sec('fs_income_statement', 'A', 'other_income', a, b) = 30000, 'operating revenue 4,700.00 · other income 300.00');
  perform fs.ok(fs.sec('fs_income_statement', 'A', 'cost_of_sales', a, b) = 120000, 'cost of sales 1,200.00 (gross profit 3,500.00)');
  perform fs.ok(fs.sec('fs_income_statement', 'A', 'operating_expense', a, b) = 105000, 'operating expenses 1,050.00 (payroll + depreciation)');
  perform fs.ok(fs.sec('fs_income_statement', 'A', 'other_expense', a, b) = 5000 and fs.sec('fs_income_statement', 'A', 'income_tax', a, b) = 40000, 'other expense 50.00 · income tax 400.00');
  perform fs.ok(fs.sec('fs_income_statement', 'A', 'operating_revenue', a, b) + fs.sec('fs_income_statement', 'A', 'other_income', a, b)
                - fs.sec('fs_income_statement', 'A', 'cost_of_sales', a, b) - fs.sec('fs_income_statement', 'A', 'operating_expense', a, b)
                - fs.sec('fs_income_statement', 'A', 'other_expense', a, b) - fs.sec('fs_income_statement', 'A', 'income_tax', a, b) = 230000, 'net income 2,300.00');
  perform fs.ok(fs.sec('fs_income_statement', 'A', 'operating_revenue', fs.dt(py, 1, 1), fs.dt(py, 12, 31)) = 300000
                and fs.sec('fs_income_statement', 'A', 'operating_expense', fs.dt(py, 1, 1), fs.dt(py, 12, 31)) = 50000, 'previous year: revenue 3,000.00, expenses 500.00 (comparison)');
  perform fs.ok(fs.sec('fs_income_statement', 'A', 'operating_revenue', fs.dt(cy, 2, 1), fs.dt(cy, 2, 28)) = 0, 'a month without sales: zero, not an error');
  perform fs.ok(fs.val('owner', format('select count(*) from public.fs_income_statement(%L, %L, %L) where amount_cents <> 0', fs.id('A'), fs.dt(py - 5, 1, 1), fs.dt(py - 5, 12, 31))) = '0',
                'a period without data: all lines zero');
  perform fs.ok(fs.val('member', format('select count(*) from public.fs_income_statement(%L, %L, %L)', fs.id('A'), a, b)) = '0', 'members read no statements');
  perform fs.ok(fs.val('other', format('select count(*) from public.fs_income_statement(%L, %L, %L)', fs.id('A'), a, b)) = '0', 'isolation: B reads no statement of A');
end $$;

-- ------------------------------------------------------------- balance sheet
do $$ declare e date := fs.dt(fs.cy(), 12, 31); assets bigint; liab bigint; eq bigint; begin
  assets := fs.sec('fs_balance_sheet', 'A', 'cash', e) + fs.sec('fs_balance_sheet', 'A', 'current_asset', e) + fs.sec('fs_balance_sheet', 'A', 'non_current_asset', e) + fs.sec('fs_balance_sheet', 'A', 'accumulated_depreciation', e);
  liab := fs.sec('fs_balance_sheet', 'A', 'current_liability', e) + fs.sec('fs_balance_sheet', 'A', 'non_current_liability', e);
  eq := fs.sec('fs_balance_sheet', 'A', 'equity', e) + fs.sec('fs_balance_sheet', 'A', 'retained_earnings', e) + fs.sec('fs_balance_sheet', 'A', 'prior_results', e) + fs.sec('fs_balance_sheet', 'A', 'current_result', e);
  perform fs.ok(fs.sec('fs_balance_sheet', 'A', 'cash', e) = 1395000 and fs.sec('fs_balance_sheet', 'A', 'current_asset', e) = 200000, 'cash 13,950.00 · receivables 2,000.00');
  perform fs.ok(fs.sec('fs_balance_sheet', 'A', 'non_current_asset', e) = 250000 and fs.sec('fs_balance_sheet', 'A', 'accumulated_depreciation', e) = -25000, 'equipment 2,500.00 less accumulated depreciation 250.00');
  perform fs.ok(assets = 1820000, format('total assets 18,200.00 (%s)', assets));
  perform fs.ok(fs.sec('fs_balance_sheet', 'A', 'current_liability', e) = 60000 and fs.sec('fs_balance_sheet', 'A', 'non_current_liability', e) = 300000, 'current liabilities 600.00 · loan 3,000.00');
  perform fs.ok(fs.sec('fs_balance_sheet', 'A', 'equity', e) = 980000 and fs.sec('fs_balance_sheet', 'A', 'prior_results', e) = 250000 and fs.sec('fs_balance_sheet', 'A', 'current_result', e) = 230000,
                'equity 9,800.00 · prior results 2,500.00 · current result 2,300.00');
  perform fs.ok(assets = liab + eq, format('assets = liabilities + equity (%s = %s + %s)', assets, liab, eq));
  -- the accounting equation holds at every month end
  perform fs.ok((select bool_and(
                  (select coalesce(sum(case when section in ('cash', 'current_asset', 'non_current_asset', 'accumulated_depreciation') then amount_cents else -amount_cents end), 0)
                   from public.fs_balance_sheet(fs.id('A'), (make_date(fs.cy(), m, 1) + interval '1 month - 1 day')::date)) = 0) from generate_series(1, 12) m),
                'the balance sheet balances at all twelve month ends');
  perform fs.ok(fs.sec('fs_balance_sheet', 'A', 'current_result', fs.dt(fs.cy(), 6, 30)) = 470000 + 30000 - 120000 - 80000 - 5000 - 40000, 'mid-year current result 2,550.00');
end $$;

-- ------------------------------------------------------------- cash flow
do $$ declare a date := fs.dt(fs.cy(), 1, 1); b date := fs.dt(fs.cy(), 12, 31); total bigint; begin
  perform fs.ok(fs.sec('fs_cash_flow', 'A', 'net_income', a, b) = 230000, 'starts from net income 2,300.00');
  perform fs.ok(fs.sec('fs_cash_flow', 'A', 'non_cash', a, b) = 25000, 'depreciation added back (only because it was recorded)');
  perform fs.ok(fs.sec('fs_cash_flow', 'A', 'working_capital', a, b) = -100000 + 20000 + 40000, 'working capital: receivables −1,000.00, payables +200.00, tax payable +400.00');
  perform fs.ok(fs.sec('fs_cash_flow', 'A', 'investing', a, b) = -250000 and fs.sec('fs_cash_flow', 'A', 'financing', a, b) = 300000 - 20000, 'investing −2,500.00 · financing +2,800.00');
  total := fs.sec('fs_cash_flow', 'A', 'net_income', a, b) + fs.sec('fs_cash_flow', 'A', 'non_cash', a, b) + fs.sec('fs_cash_flow', 'A', 'working_capital', a, b)
           + fs.sec('fs_cash_flow', 'A', 'investing', a, b) + fs.sec('fs_cash_flow', 'A', 'financing', a, b);
  perform fs.ok(total = 245000 and fs.sec('fs_cash_flow', 'A', 'cash_closing', a, b) - fs.sec('fs_cash_flow', 'A', 'cash_opening', a, b) = total
                and fs.sec('fs_cash_flow', 'A', 'cash_opening', a, b) = 1150000, 'net change in cash 2,450.00 = closing 13,950.00 − opening 11,500.00');
  perform fs.ok(fs.sec('fs_cash_flow', 'A', 'non_cash', fs.dt(fs.py(), 1, 1), fs.dt(fs.py(), 12, 31)) = 0, 'no depreciation invented when none was recorded');
end $$;

-- ------------------------------------------------------------- data quality, monthly series, empty and incomplete companies
do $$ declare q record; begin
  select * into q from public.fs_data_quality(fs.id('A'), fs.dt(fs.cy(), 1, 1), fs.dt(fs.cy(), 12, 31));
  perform fs.ok(q.opening_balance_recorded and q.negative_cash_accounts = 0 and q.unbalanced_entries = 0 and q.months_in_range = 12 and q.closed_months = 0,
                'company A: opening capital recorded, no negative cash, 12 open months');
  perform fs.ok(fs.err('owner', format('select public.ledger_close_period(%L, %L)', fs.id('A'), fs.dt(fs.cy(), 1, 1))) = '', 'January of last year is closed');
  perform fs.ok((select closed_months from public.fs_data_quality(fs.id('A'), fs.dt(fs.cy(), 1, 1), fs.dt(fs.cy(), 12, 31))) = 1, 'quality reports 1 closed month');
  perform fs.ok((select string_agg(revenue_cents || '/' || cost_of_sales_cents || '/' || net_cents || '/' || closed, ',' order by month) from public.fs_monthly(fs.id('A'), fs.dt(fs.cy(), 1, 1), 2))
                = '500000/120000/380000/true,0/0/0/false', 'monthly series: January (closed) and February');
  perform fs.ok((select sum(net_cents) from public.fs_monthly(fs.id('A'), fs.dt(fs.cy(), 1, 1), 12)) = 230000, 'the monthly nets add up to the annual net income');
  perform fs.ok((select count(*) from public.fs_monthly(fs.id('A'), fs.dt(fs.cy(), 1, 1), 500)) = 60, 'series limited to 60 months');
  perform fs.ok(fs.err('other', format('select public.ledger_init(%L)', fs.id('B'))) = ''
                and fs.je('B', 'other', fs.dt(fs.cy(), 5, 1), 'Gasto sin saldo inicial', '[["6000",10000,0],["1010",0,10000]]') = '', 'company B: an expense paid with no opening balance');
  select * into q from public.fs_data_quality(fs.id('B'), fs.dt(fs.cy(), 1, 1), fs.dt(fs.cy(), 12, 31));
  perform fs.ok(q.negative_cash_accounts = 1 and not q.opening_balance_recorded, 'company B: negative cash and no opening balance → provisional');
  perform fs.ok((select count(*) from public.fs_balance_sheet(fs.id('C'), fs.dt(fs.cy(), 12, 31))) = 0 and (select count(*) from public.fs_cash_flow(fs.id('C'), fs.dt(fs.cy(), 1, 1), fs.dt(fs.cy(), 12, 31))) = 0,
                'company C without a ledger: empty statements, no error');
  perform fs.ok((select count(*) from public.fs_monthly(fs.id('C'), fs.dt(fs.cy(), 1, 1), 3)) = 3 and (select sum(net_cents) from public.fs_monthly(fs.id('C'), fs.dt(fs.cy(), 1, 1), 3)) = 0,
                'company C: monthly series of zeros');
end $$;

-- ------------------------------------------------------------- budgets: lines, approval, publication, versions
do $$ declare b1 uuid; b2 uuid; b3 uuid; ba uuid; n int; cy int := fs.cy(); begin
  perform fs.ok(fs.err('member', format('select public.budget_create(%L, %L, %s, %L)', fs.id('A'), 'Plan', cy, 'monthly')) like '%FORBIDDEN%', 'members do not create budgets');
  b1 := fs.val('admin', format('select public.budget_create(%L, %L, %s, %L, %L, null, %L)', fs.id('A'), 'Plan anual', cy, 'monthly', 'base', 'Primer presupuesto'))::uuid;
  insert into fs.ctx values ('b1', b1::text);
  perform fs.ok(b1 is not null, 'the admin creates a monthly budget (draft)');
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, %L, null, 1, 100)', b1, fs.acct('A', '1010'))) like '%BUDGET_LINE_INVALID%', 'only revenue / expense accounts');
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, %L, null, null, 100)', b1, fs.acct('A', '4000'))) like '%BUDGET_LINE_INVALID%', 'a monthly budget needs the month');
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, %L, null, 1, -5)', b1, fs.acct('A', '4000'))) like '%AMOUNT_INVALID%', 'no negative budgets');
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, %L, null, 1, 100)', b1, fs.acct('B', '4000'))) like '%BUDGET_LINE_INVALID%', 'isolation: no account of another company');
  perform fs.ok((select bool_and(fs.err('admin', format('select public.budget_set_line(%L, %L, null, %s, 40000)', b1, fs.acct('A', '4000'), m)) = ''
                              and fs.err('admin', format('select public.budget_set_line(%L, %L, null, %s, 10000)', b1, fs.acct('A', '6100'), m)) = '') from generate_series(1, 12) m),
                'revenue 400.00 and payroll 100.00 per month');
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, %L, null, 1, 40000)', b1, fs.acct('A', '4000'))) = ''
                and (select count(*) from public.budget_lines where budget_id = b1) = 24, 'setting a line again replaces it (no duplicates)');
  -- the whole line in one call (what the app uses): all twelve months or nothing
  perform fs.ok(fs.err('admin', format('select public.budget_set_lines(%L, %L, null, %L::bigint[], %L)', b1, fs.acct('A', '6200'),
                '{100,200,300,400,500,600,700,800,900,1000,1100,1200}', 'Plan de alquiler')) = '', 'budget_set_lines accepts a 12-month line');
  perform fs.ok((select sum(amount_cents) || '/' || count(*) || '/' || min(note) from public.budget_lines where budget_id = b1 and account_id = fs.acct('A', '6200')) = '7800/12/Plan de alquiler',
                'budget_set_lines saves the 12 months of a line in one call');
  perform fs.ok(fs.err('admin', format('select public.budget_set_lines(%L, %L, null, %L::bigint[])', b1, fs.acct('A', '6200'), '{1,1,1,1,1,1,1,1,1,1,1,-1}')) like '%AMOUNT_INVALID%'
                and (select sum(amount_cents) from public.budget_lines where budget_id = b1 and account_id = fs.acct('A', '6200')) = 7800,
                'an invalid month rolls back the whole line (atomic)');
  perform fs.ok(fs.err('admin', format('select public.budget_set_lines(%L, %L, null, %L::bigint[])', b1, fs.acct('A', '6200'), '{1,2,3}')) like '%BUDGET_LINE_INVALID%', 'a monthly line needs 12 amounts');
  perform fs.ok(fs.err('admin', format('select public.budget_set_lines(%L, %L, null, %L::bigint[])', b1, fs.acct('A', '6200'), '{NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL}')) = '', 'empty months accepted');
  perform fs.ok(not exists (select 1 from public.budget_lines where budget_id = b1 and account_id = fs.acct('A', '6200')), 'empty months delete the line');
  perform fs.ok(fs.err('member', format('select public.budget_set_lines(%L, %L, null, %L::bigint[])', b1, fs.acct('A', '6200'), '{1,1,1,1,1,1,1,1,1,1,1,1}')) like '%BUDGET_NOT_FOUND%', 'members cannot edit lines');
  perform fs.ok(fs.err('admin', format('select public.budget_approve(%L)', b1)) like '%BUDGET_NOT_FOUND%', 'admins do not approve (owner)');
  perform fs.ok(fs.err('owner', format('select public.budget_approve(%L, %L)', b1, 'Revisado')) = '', 'the owner approves');
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, %L, null, 1, 1)', b1, fs.acct('A', '4000'))) like '%BUDGET_LOCKED%', 'an approved budget is not edited');
  perform fs.ok(fs.merr(format('update public.budget_lines set amount_cents = 1 where budget_id = %L', b1)) like '%BUDGET_LOCKED%', 'not even by maintenance');
  perform fs.ok(fs.merr(format('update public.budgets set name = %L where id = %L', 'x', b1)) like '%BUDGET_LOCKED%', 'nor its header');
  perform fs.ok(fs.merr(format('delete from public.budgets where id = %L', b1)) like '%BUDGET_IMMUTABLE%', 'budgets are never deleted');
  perform fs.ok(fs.err('owner', format('select public.budget_publish(%L)', b1)) = '' and fs.err('owner', format('select public.budget_publish(%L)', b1)) = '', 'published (twice: idempotent)');
  b2 := fs.val('admin', format('select public.budget_new_version(%L, %L)', b1, 'Ajuste de nómina'))::uuid;
  perform fs.ok(b2 is not null and (select version || '/' || status from public.budgets where id = b2) = '2/draft' and (select count(*) from public.budget_lines where budget_id = b2) = 24,
                'version 2: a draft copy with all lines');
  perform fs.ok(fs.err('admin', format('select public.budget_new_version(%L)', b1)) like '%BUDGET_DRAFT_EXISTS%', 'one draft version at a time');
  perform fs.ok((select bool_and(fs.err('admin', format('select public.budget_set_line(%L, %L, null, %s, 6000)', b2, fs.acct('A', '6100'), m)) = '') from generate_series(1, 12) m),
                'v2: payroll lowered to 60.00 per month');
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, null, null, 1, 5000)', b2)) like '%BUDGET_LINE_INVALID%', 'a line is an account or a category');
  -- integration with payables (0024): a category line measured by approved bills
  perform fs.ok(fs.err('admin', format('select public.payables_init(%L)', fs.id('A'))) = '', 'payables initialised in A');
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, null, %L, 3, 20000, %L)', b2,
                (select id from public.expense_categories where company_id = fs.id('A') and name = 'Gastos generales'), 'Material de oficina')) = '', 'v2: category line "Gastos generales" in March 200.00');
  perform fs.ok(fs.err('owner', format('select public.budget_approve(%L)', b2)) = '' and fs.err('owner', format('select public.budget_publish(%L)', b2)) = '', 'v2 approved and published');
  perform fs.ok((select status from public.budgets where id = b1) = 'archived' and (select count(*) from public.budgets where company_id = fs.id('A') and status = 'published') = 1,
                'publishing v2 archived v1: one published budget per year and scenario');
  perform fs.ok((select amount_cents from public.budget_lines where budget_id = b1 and account_id = fs.acct('A', '6100') and month = 1) = 10000, 'v1 keeps its original figures');
  insert into fs.ctx values ('b2', b2::text);
  b3 := fs.val('admin', format('select public.budget_create(%L, %L, %s, %L, %L, %L)', fs.id('A'), 'Ventas depto', cy, 'annual', 'base', fs.id('dep')))::uuid;
  perform fs.ok(fs.err('admin', format('select public.budget_set_line(%L, %L, null, null, 100000)', b3, fs.acct('A', '6000'))) = '', 'an annual department budget');
  insert into fs.ctx values ('b3', b3::text);
  ba := fs.val('admin', format('select public.budget_create(%L, %L, %s, %L, %L)', fs.id('A'), 'Optimista', cy + 1, 'monthly', 'optimistic'))::uuid;
  n := fs.val('admin', format('select public.budget_fill_from_actuals(%L, %s, 10)', ba, cy))::int;
  perform fs.ok(n = 7, format('prefill from last year''s actuals: one line per account and month with activity (%s)', n));
  perform fs.ok((select amount_cents from public.budget_lines where budget_id = ba and account_id = fs.acct('A', '4000') and month = 1) = 517000, '+10%: January revenue 4,700.00 → 5,170.00');
  perform fs.ok(fs.err('admin', format('select public.budget_archive(%L, %L)', ba, '')) like '%REASON_REQUIRED%' and fs.err('admin', format('select public.budget_archive(%L, %L)', ba, 'Descartado')) = '',
                'archiving needs a reason');
  perform fs.ok(fs.err('admin', format('select public.budget_archive(%L, %L)', b2, 'Quitar')) like '%FORBIDDEN%', 'only an approver archives a published budget');
end $$;

-- ------------------------------------------------------------- budget vs actual
do $$ declare r record; cy int := fs.cy(); begin
  select * into r from public.budget_vs_actual(fs.id('b2'), fs.dt(cy, 12, 31)) where account_id = fs.acct('A', '4000');
  perform fs.ok(r.budget_total_cents = 480000 and r.budget_ytd_cents = 480000 and r.actual_cents = 470000 and r.variance_cents = -10000 and r.variance_pct = -2.1 and not r.favorable and r.alert = 'ok',
                'revenue: 4,700.00 vs 4,800.00 → −100.00 (−2.1 %), unfavourable, within tolerance');
  select * into r from public.budget_vs_actual(fs.id('b2'), fs.dt(cy, 12, 31)) where account_id = fs.acct('A', '6100');
  perform fs.ok(r.budget_total_cents = 72000 and r.actual_cents = 80000 and r.variance_cents = 8000 and not r.favorable and r.consumed_pct = 111.1 and r.alert = 'critical',
                'payroll: 800.00 vs 720.00 → over budget (expense: unfavourable), 111.1 % consumed, critical');
  select * into r from public.budget_vs_actual(fs.id('b1'), fs.dt(cy, 12, 31)) where account_id = fs.acct('A', '6100');
  perform fs.ok(r.favorable and r.variance_cents = -40000 and r.consumed_pct = 66.7 and r.alert = 'ok', 'v1 payroll: 800.00 vs 1,200.00 → under budget is favourable for an expense');
  select * into r from public.budget_vs_actual(fs.id('b2'), fs.dt(cy, 6, 30)) where account_id = fs.acct('A', '4000');
  perform fs.ok(r.budget_ytd_cents = 240000 and r.actual_cents = 500000 - 30000 and r.favorable and r.projection_cents > r.actual_cents,
                'at June 30: year-to-date budget 2,400.00, ahead of plan, run-rate projection above actual');
  select * into r from public.budget_vs_actual(fs.id('b2'), fs.dt(cy - 1, 12, 31)) where account_id = fs.acct('A', '4000');
  perform fs.ok(r.budget_ytd_cents = 0 and r.variance_pct is null and r.projection_cents is null and r.alert = 'ok', 'before the year starts: no division by zero (null percentages)');
  perform fs.ok(fs.err('admin', format('insert into public.vendors (company_id, name) values (%L, %L)', fs.id('A'), 'Papelería')) = '', 'a vendor');
  perform fs.ok(fs.err('admin', format('select public.bill_save_draft(%L, null, %L, %L, %L, null, %L, null, %L)', fs.id('A'), (select id from public.vendors where company_id = fs.id('A') and name = 'Papelería'),
                  'P-1', fs.dt(cy, 3, 10), 'Papel', jsonb_build_array(jsonb_build_object('category_id', (select id from public.expense_categories where company_id = fs.id('A') and name = 'Gastos generales'), 'amount_cents', '25000')))) = '',
                'a bill of 250.00 in "Gastos generales" (March)');
  perform fs.ok(fs.err('owner', format('select public.bill_submit(%L)', (select id from public.bills where vendor_invoice_number = 'P-1'))) = '', 'submitted');
  perform fs.ok(fs.err('owner', format('select public.bill_approve(%L)', (select id from public.bills where vendor_invoice_number = 'P-1'))) = '', 'approved (posted to the ledger)');
  select * into r from public.budget_vs_actual(fs.id('b2'), fs.dt(cy, 12, 31)) where kind = 'category';
  perform fs.ok(r.budget_total_cents = 20000 and r.actual_cents = 25000 and not r.favorable and r.in_total and r.alert = 'critical',
                'category line: 250.00 of approved bills vs 200.00 budget → over budget, counted in totals (no account line for 6000)');
  perform fs.ok(fs.sec('fs_income_statement', 'A', 'operating_expense', fs.dt(cy, 1, 1), fs.dt(cy, 12, 31)) = 105000 + 25000, 'the same bill appears once in the income statement (no duplicate)');
  select * into r from public.budget_vs_actual(fs.id('b3'), fs.dt(cy, 12, 31));
  perform fs.ok(not r.actual_available, 'a department budget is flagged: transactions carry no department yet');
  perform fs.ok(fs.val('other', format('select count(*) from public.budget_vs_actual(%L, current_date)', fs.id('b2'))) = '0'
                and fs.val('other', format('select count(*) from public.budgets where company_id = %L', fs.id('A'))) = '0', 'isolation: B sees no budget of A');
  perform fs.ok(fs.err('other', format('select public.budget_approve(%L)', fs.id('b3'))) like '%BUDGET_NOT_FOUND%', 'isolation: B cannot approve A''s budgets');
end $$;

-- ------------------------------------------------------------- assumptions and audit
do $$ begin
  perform fs.ok(fs.err('member', format('select public.fs_save_assumptions(%L, 5, 90, 15, 10, 6)', fs.id('A'))) like '%FORBIDDEN%', 'members do not change assumptions');
  perform fs.ok(fs.err('admin', format('select public.fs_save_assumptions(%L, 5, 150, 15, 10, 6)', fs.id('A'))) like '%check%', 'collection rate up to 100 %');
  perform fs.ok(fs.err('admin', format('select public.fs_save_assumptions(%L, 5, 85, 20, 10, 12)', fs.id('A'))) = '', 'the admin saves assumptions');
  perform fs.ok((select growth_pct || '/' || collection_pct || '/' || horizon_months from public.fs_assumptions where company_id = fs.id('A')) = '5.00/85.00/12', 'assumptions saved');
  perform fs.ok((select count(*) from public.budget_events where company_id = fs.id('A') and action in ('created', 'approved', 'published', 'version_created', 'archived', 'filled_from_actuals', 'assumptions_updated')) >= 10,
                'history: creation, approval, publication, versions, archive, prefill, assumptions');
  perform fs.ok(fs.merr(format('delete from public.budget_events where company_id = %L', fs.id('A'))) like '%LEDGER_IMMUTABLE%', 'the budget history is append-only');
  perform fs.ok(fs.val('owner', format('select unbalanced_entries = 0 and debit_cents = credit_cents from public.ledger_integrity(%L)', fs.id('A')))::boolean, 'statements and budgets changed no entry: the ledger still balances');
  perform fs.ok(fs.merr(format('delete from public.companies where id = %L', fs.id('A'))) = '', 'a whole company can be deleted');
  perform fs.ok((select count(*) from public.budgets where company_id = fs.id('A')) = 0, 'its budgets go with it (cascade)');
end $$;

do $$ begin
  if exists (select 1 from fs.failures) then
    raise exception 'STATEMENTS TESTS FAILED: %', (select string_agg(msg, ' | ') from fs.failures);
  end if;
  raise notice 'ALL STATEMENTS TESTS PASSED';
end $$;
