-- Double-entry general ledger (0023). TEST-ONLY, local throw-away database
-- with 0014a … 0023. Schema lg.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema lg;
create table lg.ctx (key text primary key, val text not null);
create function lg.id(k text) returns uuid language sql stable as $$ select val::uuid from lg.ctx where key = k $$;
create table lg.failures (msg text);
create function lg.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into lg.failures values (msg); end if;
end $$;
grant usage on schema lg to authenticated;
grant select on lg.ctx to authenticated;
grant execute on all functions in schema lg to authenticated;
create function lg.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', lg.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function lg.val(who text, q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', lg.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- Maintenance (no user) statement → error text or ''.
create function lg.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
create function lg.acct(co text, c text) returns uuid language sql stable as $$
  select id from public.ledger_accounts where company_id = lg.id(co) and code = c $$;
-- Balance (normal side) of an account by code, in cents.
create function lg.bal(co text, c text) returns bigint language sql stable as $$
  select balance_cents from public.ledger_trial_balance(lg.id(co)) where code = c $$;
create function lg.entries(co text, src text) returns bigint language sql stable as $$
  select count(*) from public.journal_entries where company_id = lg.id(co) and source = src $$;
create function lg.lines(e uuid) returns text language sql stable as $$
  select string_agg(a.code || ':' || l.debit_cents || '/' || l.credit_cents, ' ' order by l.line_no)
  from public.journal_lines l join public.ledger_accounts a on a.id = l.account_id where l.entry_id = e $$;

insert into lg.ctx values
  ('owner', 'c1000000-0000-4000-8000-000000000001'), ('admin', 'c1000000-0000-4000-8000-000000000002'),
  ('member', 'c1000000-0000-4000-8000-000000000003'), ('other', 'c1000000-0000-4000-8000-000000000004'),
  ('A', 'c2000000-0000-4000-8000-000000000001'), ('B', 'c2000000-0000-4000-8000-000000000002'),
  ('client', 'c3000000-0000-4000-8000-000000000001'), ('clientB', 'c3000000-0000-4000-8000-000000000002'),
  ('inv1', 'c4000000-0000-4000-8000-000000000001'), ('inv2', 'c4000000-0000-4000-8000-000000000002'),
  ('inv3', 'c4000000-0000-4000-8000-000000000003'), ('invB1', 'c4000000-0000-4000-8000-000000000011'),
  ('invB2', 'c4000000-0000-4000-8000-000000000012'), ('invB3', 'c4000000-0000-4000-8000-000000000013'),
  ('pay1', 'c5000000-0000-4000-8000-000000000001'), ('pay2', 'c5000000-0000-4000-8000-000000000002'),
  ('payB1', 'c5000000-0000-4000-8000-000000000011'), ('payB2', 'c5000000-0000-4000-8000-000000000012');
insert into auth.users (id, email) select val::uuid, key || '@lg.test' from lg.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (lg.id('A'), 'Libros A', lg.id('owner')), (lg.id('B'), 'Libros B', lg.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (lg.id('A'), 'cus_lg_a', 'sub_lg_a', 'premium', 'active'), (lg.id('B'), 'cus_lg_b', 'sub_lg_b', 'basic', 'active');
insert into public.memberships (company_id, user_id, role) values
  (lg.id('A'), lg.id('owner'), 'owner'), (lg.id('A'), lg.id('admin'), 'admin'), (lg.id('A'), lg.id('member'), 'member'),
  (lg.id('B'), lg.id('other'), 'owner');
insert into public.clients (id, company_id, name) values (lg.id('client'), lg.id('A'), 'Cliente Uno'), (lg.id('clientB'), lg.id('B'), 'Cliente B');

-- ------------------------------------------------------------- chart and roles
do $$ begin
  perform lg.ok(lg.err('member', format('select public.ledger_init(%L)', lg.id('A'))) like '%FORBIDDEN%', 'a member cannot initialise the ledger');
  perform lg.ok(lg.err('owner', format('select public.ledger_init(%L)', lg.id('A'))) = '', 'the owner initialises the ledger');
  perform lg.ok((select count(*) from public.ledger_accounts where company_id = lg.id('A')) = 16, 'default chart: 16 accounts');
  perform lg.ok((select count(distinct type) from public.ledger_accounts where company_id = lg.id('A')) = 5, 'assets, liabilities, equity, revenue and expenses');
  perform lg.ok((select count(*) from public.ledger_accounts where company_id = lg.id('A') and system_key is not null) = 7, 'seven system accounts');
  perform lg.ok(lg.err('owner', format('select public.ledger_init(%L)', lg.id('A'))) = '' and (select count(*) from public.ledger_accounts where company_id = lg.id('A')) = 16,
                'initialising again changes nothing');
  perform lg.ok(lg.val('member', format('select count(*) from public.ledger_accounts where company_id = %L', lg.id('A'))) = '0', 'members see no accounts');
  perform lg.ok(lg.val('admin', format('select count(*) from public.ledger_accounts where company_id = %L', lg.id('A'))) = '16', 'admins see the chart');
  perform lg.ok(lg.val('other', format('select count(*) from public.ledger_accounts where company_id = %L', lg.id('A'))) = '0', 'isolation: B sees no account of A');
  perform lg.ok(lg.err('member', format('insert into public.ledger_accounts (company_id, code, name, type) values (%L, %L, %L, %L)', lg.id('A'), '6900', 'X', 'expense')) like '%row-level security%',
                'members cannot create accounts');
  perform lg.ok(lg.err('owner', format('insert into public.ledger_accounts (company_id, code, name, type, system_key) values (%L, %L, %L, %L, %L)', lg.id('A'), '6901', 'X', 'expense', 'cash')) like '%permission denied%',
                'nobody makes a system account by hand');
  perform lg.ok(lg.err('admin', format('insert into public.ledger_accounts (company_id, code, name, name_en, type, description) values (%L, %L, %L, %L, %L, %L)',
                lg.id('A'), '6400', 'Publicidad', 'Advertising', 'expense', 'Anuncios')) = '', 'an admin creates a custom account');
  perform lg.ok(lg.err('admin', format('insert into public.ledger_accounts (company_id, code, name, type) values (%L, %L, %L, %L)', lg.id('A'), '6400', 'Dup', 'expense')) like '%duplicate%',
                'account codes are unique per company');
  perform lg.ok(lg.err('admin', format('insert into public.ledger_accounts (company_id, code, name, type) values (%L, %L, %L, %L)', lg.id('A'), '7000', 'X', 'cost')) like '%check%',
                'only the five account types');
  perform lg.ok(lg.err('other', format('insert into public.ledger_accounts (company_id, code, name, type) values (%L, %L, %L, %L)', lg.id('B'), '6000', 'X', 'expense')) like '%LEDGER_NOT_INITIALIZED%',
                'custom accounts only after the default chart exists');
end $$;

-- ------------------------------------------------------------ invoices
do $$ declare e uuid; begin
  perform lg.ok(lg.err('member', format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total) values (%L, %L, %L, %L, %L, %L, %L, 100.00, 7.00, 107.00)',
                lg.id('inv1'), lg.id('A'), lg.id('client'), lg.id('member'), 'invoice', 'x', 'draft')) = '', 'a member creates a draft invoice');
  perform lg.ok(lg.entries('A', 'invoice') = 0, 'a draft produces no entry');
  perform lg.ok(lg.err('member', format('update public.documents set subtotal = 100.00 where id = %L', lg.id('inv1'))) = '' and lg.entries('A', 'invoice') = 0, 'editing a draft produces no entry');
  perform lg.ok(lg.err('member', format('update public.documents set status = %L where id = %L', 'sent', lg.id('inv1'))) = '', 'the member issues it (draft → sent)');
  select id into e from public.journal_entries where company_id = lg.id('A') and source = 'invoice' and source_id = lg.id('inv1');
  perform lg.ok(e is not null and lg.entries('A', 'invoice') = 1, 'issuing posts one entry (even when the user has no accounting permission)');
  perform lg.ok(lg.lines(e) = '1200:10700/0 4000:0/10000 2100:0/700', 'Dr receivable 107.00 / Cr revenue 100.00 / Cr sales tax 7.00 (integer cents)');
  perform lg.ok((select j.entry_date = d.issue_date and j.reference = d.document_number and j.created_by = lg.id('member') and j.currency = 'USD' and j.total_cents = 10700
                 from public.journal_entries j, public.documents d where j.id = e and d.id = lg.id('inv1')), 'date = issue date, reference = number, user and currency recorded');
  perform lg.ok(lg.merr(format('select public.ledger_post_invoice(%L)', lg.id('inv1'))) = '' and lg.entries('A', 'invoice') = 1, 'posting the same invoice again: no second entry');
  perform lg.ok(lg.err('member', format('update public.documents set status = %L where id = %L', 'sent', lg.id('inv1'))) = '' and lg.entries('A', 'invoice') = 1, 'repeating the status: no second entry');
  perform lg.ok(lg.err('member', format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total) values (%L, %L, %L, %L, %L, %L, %L, 50.00, 0, 50.00)',
                lg.id('inv2'), lg.id('A'), lg.id('client'), lg.id('member'), 'invoice', 'x', 'sent')) = '', 'an invoice created already issued');
  perform lg.ok(lg.entries('A', 'invoice') = 2, 'it posts once');
  perform lg.ok(lg.lines((select id from public.journal_entries where source_id = lg.id('inv2'))) = '1200:5000/0 4000:0/5000', 'no tax line when the tax is zero');
  perform lg.ok(lg.err('member', format('insert into public.documents (company_id, created_by, document_type, document_number, status, total) values (%L, %L, %L, %L, %L, 0)',
                lg.id('A'), lg.id('member'), 'invoice', 'x', 'sent')) = '' and lg.entries('A', 'invoice') = 2, 'a zero invoice posts nothing');
  perform lg.ok(lg.err('member', format('insert into public.documents (company_id, created_by, document_type, document_number, status, total) values (%L, %L, %L, %L, %L, 80)',
                lg.id('A'), lg.id('member'), 'quote', 'x', 'sent')) = '' and (select count(*) from public.journal_entries where company_id = lg.id('A')) = 2, 'quotes post nothing');
end $$;

-- ------------------------------------------------------------ payments
do $$ declare e uuid; begin
  perform lg.ok(lg.err('member', format('insert into public.payments (id, company_id, document_id, amount, created_by, payment_method, idempotency_key) values (%L, %L, %L, 40.00, %L, %L, %L)',
                lg.id('pay1'), lg.id('A'), lg.id('inv1'), lg.id('member'), 'cash', 'pay-key-0001')) = '', 'a partial payment of 40.00');
  select id into e from public.journal_entries where source = 'payment' and source_id = lg.id('pay1');
  perform lg.ok(lg.lines(e) = '1000:4000/0 1200:0/4000', 'Dr cash 40.00 / Cr receivable 40.00');
  perform lg.ok(lg.bal('A', '1200') = 10700 - 4000 + 5000 and lg.bal('A', '1000') = 4000 and lg.bal('A', '4000') = 15000,
                'receivable 117.00, cash 40.00, revenue unchanged at 150.00 (not recognised twice)');
  perform lg.ok(lg.err('member', format('insert into public.payments (company_id, document_id, amount, created_by, idempotency_key) values (%L, %L, 40.00, %L, %L)',
                lg.id('A'), lg.id('inv1'), lg.id('member'), 'pay-key-0001')) like '%duplicate%' and lg.entries('A', 'payment') = 1,
                'the same payment submitted twice: refused, one entry');
  perform lg.ok(lg.err('member', format('insert into public.payments (company_id, document_id, amount, created_by) values (%L, %L, 67.01, %L)',
                lg.id('A'), lg.id('inv1'), lg.id('member'))) like '%PAYMENT_EXCEEDS_BALANCE%' and lg.entries('A', 'payment') = 1, 'overpayment refused, nothing posted');
  perform lg.ok(lg.err('member', format('insert into public.payments (id, company_id, document_id, amount, created_by) values (%L, %L, %L, 67.00, %L)',
                lg.id('pay2'), lg.id('A'), lg.id('inv1'), lg.id('member'))) = '', 'the rest (67.00) is paid');
  perform lg.ok((select status from public.documents where id = lg.id('inv1')) = 'paid', 'the invoice is paid');
  perform lg.ok(lg.entries('A', 'payment') = 2 and lg.entries('A', 'invoice') = 2, 'paying in full posts the payment only (no revenue again)');
  perform lg.ok(lg.bal('A', '1200') = 5000 and lg.bal('A', '1000') = 10700 and lg.bal('A', '4000') = 15000 and lg.bal('A', '2100') = 700,
                'receivable 50.00 (invoice 2), cash 107.00, revenue 150.00, tax 7.00');
  perform lg.ok(lg.err('member', format('insert into public.documents (company_id, client_id, created_by, document_type, document_number, status, total, metadata) values (%L, %L, %L, %L, %L, %L, 67.00, %L)',
                lg.id('A'), lg.id('client'), lg.id('member'), 'receipt', 'x', 'paid', jsonb_build_object('payment_id', lg.id('pay2')))) = ''
                and (select count(*) from public.journal_entries where company_id = lg.id('A')) = 4, 'a receipt posts nothing (proof of a posted payment)');
end $$;

-- ------------------------------------------------------------ voids
do $$ declare o uuid; v uuid; before text; begin
  select id into o from public.journal_entries where source = 'invoice' and source_id = lg.id('inv2');
  before := lg.lines(o);
  perform lg.ok(lg.err('member', format('update public.documents set status = %L, metadata = metadata || %L where id = %L', 'cancelled', '{"void":{"reason":"Error de precio"}}', lg.id('inv2'))) like '%DOCUMENT_VOID_FORBIDDEN%',
                'a member cannot void');
  perform lg.ok(lg.err('admin', format('update public.documents set status = %L, metadata = metadata || %L where id = %L', 'cancelled', '{"void":{"reason":"Error de precio"}}', lg.id('inv2'))) = '', 'an admin voids invoice 2');
  select id into v from public.journal_entries where source = 'invoice_void' and source_id = lg.id('inv2');
  perform lg.ok(v is not null and lg.lines(v) = '1200:0/5000 4000:5000/0', 'the void posts the mirror entry');
  perform lg.ok((select reverses_entry_id = o and reversal_reason = 'Error de precio' and created_by = lg.id('admin') from public.journal_entries where id = v),
                'it points to the original, with the void reason and the user');
  perform lg.ok(lg.lines(o) = before and (select count(*) from public.journal_entries where id = o) = 1, 'the original entry is kept as it was');
  perform lg.ok(lg.bal('A', '1200') = 0 and lg.bal('A', '4000') = 10000, 'receivable 0, revenue back to 100.00');
  perform lg.ok(lg.err('member', format('insert into public.documents (id, company_id, created_by, document_type, document_number, status, total) values (%L, %L, %L, %L, %L, %L, 30)',
                lg.id('inv3'), lg.id('A'), lg.id('member'), 'invoice', 'x', 'draft')) = '', 'a third invoice, draft');
  perform lg.ok(lg.err('admin', format('update public.documents set status = %L, metadata = metadata || %L where id = %L', 'cancelled', '{"void":{"reason":"No procede"}}', lg.id('inv3'))) = ''
                and lg.entries('A', 'invoice_void') = 1, 'voiding a draft posts nothing');
end $$;

-- ------------------------------------------------------------ manual entries
do $$ declare e uuid; e2 uuid; lns jsonb; begin
  lns := jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6400'), 'debit', 2550, 'memo', 'Anuncio'),
                           jsonb_build_object('account', lg.acct('A', '1000'), 'credit', 2550));
  perform lg.ok(lg.err('member', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), 'Anuncio', lns)) like '%FORBIDDEN%', 'members cannot post entries');
  e := lg.val('owner', format('select public.ledger_post_manual(%L, current_date, %L, %L, %L, %L)', lg.id('A'), 'Anuncio en radio', 'F-77', lns, 'manual-key-001'))::uuid;
  perform lg.ok(e is not null and lg.lines(e) = '6400:2550/0 1000:0/2550', 'the owner posts a balanced entry (25.50)');
  e2 := lg.val('owner', format('select public.ledger_post_manual(%L, current_date, %L, %L, %L, %L)', lg.id('A'), 'Anuncio en radio', 'F-77', lns, 'manual-key-001'))::uuid;
  perform lg.ok(e2 = e and lg.entries('A', 'manual') = 1, 'the same submission again returns the same entry');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), 'X',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6400'), 'debit', 1000), jsonb_build_object('account', lg.acct('A', '1000'), 'credit', 999)))) like '%ENTRY_UNBALANCED%',
                'unbalanced by one cent: refused');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), 'X',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6400'), 'debit', 1000)))) like '%ENTRY_LINES_INVALID%', 'a single line: refused');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), 'X',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6400'), 'debit', 10.5), jsonb_build_object('account', lg.acct('A', '1000'), 'credit', 10.5)))) like '%ENTRY_AMOUNT_INVALID%',
                'decimal amounts refused: integer cents only');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), 'X',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6400'), 'debit', -100), jsonb_build_object('account', lg.acct('A', '1000'), 'debit', 100)))) like '%ENTRY_AMOUNT_INVALID%',
                'negative amounts refused');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), 'X',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6400'), 'debit', 100, 'credit', 100), jsonb_build_object('account', lg.acct('A', '1000'), 'credit', 0)))) like '%ENTRY_LINE_INVALID%',
                'a line that is both debit and credit: refused');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), 'X',
                jsonb_build_array(jsonb_build_object('key', 'cash', 'debit', 100), jsonb_build_object('key', 'sales_revenue', 'credit', 100)))) like '%ACCOUNT_INVALID%',
                'users name accounts explicitly');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), '  ', lns)) like '%ENTRY_DESCRIPTION_REQUIRED%', 'a description is required');
  perform lg.ok(lg.entries('A', 'manual') = 1, 'nothing was posted by the refused attempts');
end $$;

-- ------------------------------------------- direct database writes (maintenance / API)
do $$ declare e uuid; msg text := ''; o uuid; begin
  perform lg.ok(lg.err('owner', format('insert into public.journal_entries (company_id, entry_date, description, source, total_cents) values (%L, current_date, %L, %L, 100)', lg.id('A'), 'X', 'manual')) like '%permission denied%',
                'the API cannot write entries directly');
  perform lg.ok(lg.err('owner', format('update public.journal_lines set debit_cents = 1 where company_id = %L', lg.id('A'))) like '%permission denied%', 'the API cannot edit lines');
  -- Maintenance with full privileges: an unbalanced entry fails at commit.
  begin
    insert into public.journal_entries (company_id, entry_date, description, source, total_cents) values (lg.id('A'), current_date, 'Directo', 'manual', 100) returning id into e;
    insert into public.journal_lines (company_id, entry_id, line_no, account_id, debit_cents) values (lg.id('A'), e, 1, lg.acct('A', '6000'), 100);
    insert into public.journal_lines (company_id, entry_id, line_no, account_id, credit_cents) values (lg.id('A'), e, 2, lg.acct('A', '1000'), 90);
    set constraints ba_ledger_entry_balanced immediate;
  exception when others then msg := sqlerrm; end;
  set constraints ba_ledger_entry_balanced deferred;
  perform lg.ok(msg like '%ENTRY_UNBALANCED%', 'maintenance: an unbalanced entry is refused (deferred check)');
  msg := '';
  begin
    insert into public.journal_entries (company_id, entry_date, description, source, total_cents) values (lg.id('A'), current_date, 'Sin líneas', 'manual', 100);
    set constraints ba_ledger_entry_balanced immediate;
  exception when others then msg := sqlerrm; end;
  set constraints ba_ledger_entry_balanced deferred;
  perform lg.ok(msg like '%ENTRY_UNBALANCED%', 'maintenance: an entry without lines is refused');
  select id into o from public.journal_entries where company_id = lg.id('A') and source = 'manual';
  perform lg.ok(lg.merr(format('update public.journal_lines set debit_cents = debit_cents + 1 where entry_id = %L', o)) like '%LEDGER_IMMUTABLE%', 'maintenance cannot edit a posted line');
  perform lg.ok(lg.merr(format('update public.journal_entries set description = %L where id = %L', 'cambiado', o)) like '%LEDGER_IMMUTABLE%', 'maintenance cannot edit a posted entry');
  perform lg.ok(lg.merr(format('delete from public.journal_entries where id = %L', o)) like '%LEDGER_IMMUTABLE%', 'maintenance cannot delete a posted entry');
  perform lg.ok(lg.merr('truncate public.journal_lines cascade') like '%LEDGER_IMMUTABLE%', 'nobody truncates the ledger');
  perform lg.ok(lg.merr(format('insert into public.journal_lines (company_id, entry_id, line_no, account_id, debit_cents) values (%L, %L, 9, %L, 5)', lg.id('A'), o, lg.acct('A', '6000'))) like '%LEDGER_IMMUTABLE%',
                'no line can be added to an entry posted earlier');
  perform lg.ok(lg.merr(format('insert into public.journal_entries (company_id, entry_date, description, source, total_cents, currency) values (%L, current_date, %L, %L, 100, %L)', lg.id('A'), 'X', 'manual', 'EUR')) like '%CURRENCY_NOT_SUPPORTED%',
                'only the base currency (USD) for now');
  perform lg.ok(lg.merr(format('insert into public.journal_lines (company_id, entry_id, line_no, account_id, debit_cents) values (%L, %L, 9, %L, 5)', lg.id('B'), o, lg.acct('A', '6000'))) <> '',
                'a line cannot belong to another company''s entry');
end $$;

-- ------------------------------------------------------------ reversals
do $$ declare o uuid; r uuid; inv uuid; before text; begin
  select id into o from public.journal_entries where company_id = lg.id('A') and source = 'manual';
  select id into inv from public.journal_entries where company_id = lg.id('A') and source = 'invoice' and source_id = lg.id('inv1');
  before := lg.lines(o);
  perform lg.ok(lg.err('member', format('select public.ledger_reverse_entry(%L, %L)', o, 'Error')) like '%ENTRY_NOT_FOUND%', 'members cannot reverse');
  perform lg.ok(lg.err('admin', format('select public.ledger_reverse_entry(%L, %L)', o, ' ')) like '%REVERSAL_REASON_REQUIRED%', 'a reason is required');
  perform lg.ok(lg.err('admin', format('select public.ledger_reverse_entry(%L, %L)', inv, 'Error')) like '%ENTRY_FROM_DOCUMENT%', 'entries from invoices are corrected by voiding the invoice');
  r := lg.val('admin', format('select public.ledger_reverse_entry(%L, %L)', o, 'Cuenta equivocada'))::uuid;
  perform lg.ok(r is not null and lg.lines(r) = '6400:0/2550 1000:2550/0', 'the admin reverses the manual entry (mirror lines)');
  perform lg.ok((select reverses_entry_id = o and reversal_reason = 'Cuenta equivocada' and source = 'reversal' from public.journal_entries where id = r), 'documented: original and reason');
  perform lg.ok(lg.lines(o) = before, 'the original entry is preserved');
  perform lg.ok(lg.err('owner', format('select public.ledger_reverse_entry(%L, %L)', o, 'Otra vez')) like '%ENTRY_ALREADY_REVERSED%', 'an entry is reversed once');
  perform lg.ok(lg.err('owner', format('select public.ledger_reverse_entry(%L, %L)', r, 'Deshacer')) like '%REVERSAL_OF_REVERSAL%', 'a reversal is not reversed');
  perform lg.ok(lg.bal('A', '6400') = 0, 'the expense nets to zero');
end $$;

-- ------------------------------------------------------------ accounts with movements
do $$ declare x uuid; begin
  perform lg.ok(lg.err('admin', format('delete from public.ledger_accounts where id = %L', lg.acct('A', '6400'))) like '%ACCOUNT_HAS_ENTRIES%', 'an account with movements cannot be deleted');
  perform lg.ok(lg.err('admin', format('update public.ledger_accounts set type = %L where id = %L', 'asset', lg.acct('A', '6400'))) like '%ACCOUNT_LOCKED%', 'its type is locked');
  perform lg.ok(lg.err('admin', format('update public.ledger_accounts set code = %L where id = %L', '6401', lg.acct('A', '6400'))) like '%ACCOUNT_LOCKED%', 'its code is locked');
  perform lg.ok(lg.err('admin', format('update public.ledger_accounts set name = %L, description = %L where id = %L', 'Mercadeo', 'Publicidad y mercadeo', lg.acct('A', '6400'))) = '', 'it can be renamed');
  perform lg.ok(lg.err('admin', format('update public.ledger_accounts set status = %L where id = %L', 'archived', lg.acct('A', '6400'))) = '', 'and archived');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('A'), 'X',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6400'), 'debit', 100), jsonb_build_object('account', lg.acct('A', '1000'), 'credit', 100)))) like '%ACCOUNT_ARCHIVED%',
                'archived accounts take no new entries');
  perform lg.ok(lg.err('admin', format('delete from public.ledger_accounts where id = %L', lg.acct('A', '1200'))) like '%ACCOUNT_SYSTEM%', 'system accounts cannot be deleted');
  perform lg.ok(lg.err('admin', format('update public.ledger_accounts set status = %L where id = %L', 'archived', lg.acct('A', '1000'))) like '%ACCOUNT_SYSTEM%', 'nor archived');
  perform lg.ok(lg.err('admin', format('update public.ledger_accounts set name = %L where id = %L', 'Caja', lg.acct('A', '1000'))) = '', 'but renamed');
  perform lg.ok(lg.err('admin', format('insert into public.ledger_accounts (company_id, code, name, type) values (%L, %L, %L, %L)', lg.id('A'), '6950', 'Temporal', 'expense')) = ''
                , 'a temporary custom account');
  perform lg.ok(lg.err('admin', format('delete from public.ledger_accounts where id = %L', lg.acct('A', '6950'))) = '', 'an unused custom account can be deleted');
  perform lg.ok(lg.merr(format('delete from public.ledger_accounts where id = %L', lg.acct('A', '6400'))) like '%ACCOUNT_HAS_ENTRIES%', 'not even maintenance deletes an account with movements');
  perform lg.ok(lg.err('other', format('update public.ledger_accounts set name = %L where id = %L', 'hack', lg.acct('A', '6000'))) = ''
                and (select name from public.ledger_accounts where id = lg.acct('A', '6000')) = 'Gastos generales', 'isolation: B cannot rename A''s accounts');
end $$;

-- ------------------------------------------------------------ periods
do $$ declare last_month date := (date_trunc('month', public.ba_today()) - interval '1 month')::date; begin
  perform lg.ok(lg.err('member', format('select public.ledger_close_period(%L, %L)', lg.id('A'), last_month)) like '%FORBIDDEN%', 'members cannot close periods');
  perform lg.ok(lg.err('admin', format('select public.ledger_close_period(%L, %L)', lg.id('A'), public.ba_today())) like '%PERIOD_NOT_ENDED%', 'the current month cannot be closed');
  perform lg.ok(lg.err('admin', format('select public.ledger_close_period(%L, %L)', lg.id('A'), last_month)) = '', 'the admin closes last month');
  perform lg.ok(lg.err('admin', format('select public.ledger_close_period(%L, %L)', lg.id('A'), last_month)) like '%PERIOD_ALREADY_CLOSED%', 'closing twice: refused');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, %L, %L, null, %L)', lg.id('A'), last_month + 3, 'Tardío',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6000'), 'debit', 100), jsonb_build_object('account', lg.acct('A', '1000'), 'credit', 100)))) like '%PERIOD_CLOSED%',
                'no entry dated in a closed month');
  perform lg.ok(lg.merr(format('select public.ledger_post(%L, %L, %L, null, %L, null, %L)', lg.id('A'), last_month + 3, 'X', 'manual',
                jsonb_build_array(jsonb_build_object('key', 'cash', 'debit', 100), jsonb_build_object('key', 'owner_equity', 'credit', 100)))) like '%PERIOD_CLOSED%',
                'not even maintenance posts into a closed month');
  perform lg.ok(lg.err('member', format('insert into public.documents (company_id, created_by, document_type, document_number, status, total, issue_date) values (%L, %L, %L, %L, %L, 20, %L)',
                lg.id('A'), lg.id('member'), 'invoice', 'x', 'sent', last_month + 5)) like '%PERIOD_CLOSED%', 'an invoice issued with a date in a closed month is refused');
  perform lg.ok(lg.err('admin', format('select public.ledger_reopen_period(%L, %L, %L)', lg.id('A'), last_month, 'Ajuste')) like '%FORBIDDEN%', 'only the owner reopens');
  perform lg.ok(lg.err('owner', format('select public.ledger_reopen_period(%L, %L, %L)', lg.id('A'), last_month, '')) like '%REOPEN_REASON_REQUIRED%', 'reopening needs a reason');
  perform lg.ok(lg.err('owner', format('select public.ledger_reopen_period(%L, %L, %L)', lg.id('A'), last_month, 'Factura de proveedor tardía')) = '', 'the owner reopens with a reason');
  perform lg.ok((select reopened_by = lg.id('owner') and reopen_reason = 'Factura de proveedor tardía' and status = 'open' from public.accounting_periods where company_id = lg.id('A') and period_month = last_month),
                'who, when and why are recorded');
  perform lg.ok(lg.err('owner', format('select public.ledger_post_manual(%L, %L, %L, null, %L)', lg.id('A'), last_month + 3, 'Tardío',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6000'), 'debit', 100), jsonb_build_object('account', lg.acct('A', '1000'), 'credit', 100)))) = '',
                'after reopening the entry is accepted');
  perform lg.ok(lg.err('owner', format('update public.accounting_periods set status = %L where company_id = %L', 'closed', lg.id('A'))) like '%permission denied%', 'periods change only through the functions');
  perform lg.ok(lg.merr(format('delete from public.accounting_periods where company_id = %L', lg.id('A'))) like '%LEDGER_IMMUTABLE%', 'period history is not deleted');
end $$;

-- ------------------------------------------------------------ reports and integrity
do $$ begin
  perform lg.ok(lg.val('admin', format('select sum(debit_cents) = sum(credit_cents) from public.ledger_trial_balance(%L)', lg.id('A')))::boolean, 'trial balance: total debits = total credits');
  perform lg.ok(lg.val('admin', format('select unbalanced_entries = 0 and debit_cents = credit_cents and receivable_cents = open_invoices_cents and unposted_invoices = 0 and unposted_payments = 0 from public.ledger_integrity(%L)', lg.id('A')))::boolean,
                'integrity: no unbalanced entry, receivable = open invoices, nothing unposted');
  perform lg.ok(lg.val('admin', format('select count(*) from public.ledger_account_activity(%L, current_date - 400, current_date + 1)', lg.acct('A', '1200')))::int = 1 + 5,
                'account ledger: opening line + 5 movements of receivables');
  perform lg.ok(lg.val('admin', format('select balance_cents from public.ledger_account_activity(%L, current_date - 400, current_date + 1) order by entry_number desc nulls last limit 1', lg.acct('A', '1200')))::bigint = 0,
                'running balance of receivables ends at 0');
  perform lg.ok(lg.val('member', format('select count(*) from public.ledger_trial_balance(%L)', lg.id('A'))) = '0', 'members read no balances');
  perform lg.ok(lg.val('other', format('select count(*) from public.ledger_integrity(%L)', lg.id('A'))) = '0', 'isolation: B reads no integrity of A');
  perform lg.ok(lg.val('other', format('select count(*) from public.journal_entries where company_id = %L', lg.id('A'))) = '0', 'isolation: B sees no entry of A');
  perform lg.ok(lg.err('other', format('select public.ledger_reverse_entry(%L, %L)', (select id from public.journal_entries where company_id = lg.id('A') and source = 'manual' limit 1), 'hack')) like '%ENTRY_NOT_FOUND%',
                'isolation: B cannot reverse A''s entries');
  perform lg.ok(lg.err('other', format('select public.ledger_post_manual(%L, current_date, %L, null, %L)', lg.id('B'), 'X',
                jsonb_build_array(jsonb_build_object('account', lg.acct('A', '6000'), 'debit', 100), jsonb_build_object('account', lg.acct('A', '1000'), 'credit', 100)))) like '%ACCOUNT_INVALID%',
                'isolation: B cannot post to A''s accounts');
  perform lg.ok((select min(entry_number) = 1 and max(entry_number) = count(*) and count(distinct entry_number) = count(*) from public.journal_entries where company_id = lg.id('A')),
                'entry numbers are consecutive without gaps (refused attempts left none)');
  perform lg.ok((select count(*) from public.ledger_events where company_id = lg.id('A') and action in ('posted', 'reversed', 'closed', 'reopened', 'initialized', 'created', 'archived', 'deleted')) >= 15,
                'history: postings, reversals, periods and account changes');
  perform lg.ok(lg.err('owner', format('insert into public.ledger_events (company_id, entity, action) values (%L, %L, %L)', lg.id('A'), 'x', 'x')) like '%permission denied%'
                and lg.merr(format('update public.ledger_events set action = %L where company_id = %L', 'x', lg.id('A'))) like '%LEDGER_IMMUTABLE%', 'the history cannot be written or edited');
end $$;

-- ------------------------------------------------------------ history from before the ledger (company B)
alter table public.documents disable trigger ba_ledger_document;
alter table public.payments disable trigger ba_ledger_payment;
select set_config('request.jwt.claims', json_build_object('sub', lg.id('other'), 'role', 'authenticated')::text, false);
set role authenticated;
insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date)
  values (lg.id('invB1'), lg.id('B'), lg.id('clientB'), lg.id('other'), 'invoice', 'x', 'sent', 200, 14, 214, public.ba_today() - 10),
         (lg.id('invB2'), lg.id('B'), lg.id('clientB'), lg.id('other'), 'invoice', 'x', 'sent', 90, 0, 90, public.ba_today() - 5),
         (lg.id('invB3'), lg.id('B'), lg.id('clientB'), lg.id('other'), 'invoice', 'x', 'sent', 30, 0, 30, public.ba_today() - 5);
insert into public.payments (id, company_id, document_id, amount, created_by, paid_at)
  values (lg.id('payB1'), lg.id('B'), lg.id('invB1'), 100, lg.id('other'), now() - interval '2 days');
update public.documents set status = 'cancelled', metadata = metadata || '{"void":{"reason":"Duplicada"}}' where id = lg.id('invB3');
reset role;
select set_config('request.jwt.claims', '', false);
alter table public.documents enable trigger ba_ledger_document;
alter table public.payments enable trigger ba_ledger_payment;
do $$ declare n int; begin
  perform lg.ok((select count(*) from public.journal_entries where company_id = lg.id('B')) = 0, 'company B has documents from before the ledger, none posted');
  perform lg.ok(lg.val('other', format('select unposted_invoices || ''/'' || unposted_payments from public.ledger_integrity(%L)', lg.id('B'))) = '2/1',
                'integrity shows what is not in the ledger yet');
  perform lg.ok(lg.err('other', format('insert into public.payments (id, company_id, document_id, amount, created_by) values (%L, %L, %L, 40, %L)', lg.id('payB2'), lg.id('B'), lg.id('invB2'), lg.id('other'))) = '', 'a payment on an invoice from before the ledger');
  perform lg.ok((select string_agg(source, ',' order by entry_number) from public.journal_entries where company_id = lg.id('B')) = 'invoice,payment',
                'posts the invoice first (its real issue), then the payment');
  n := lg.val('other', format('select public.ledger_import_history(%L)', lg.id('B')))::int;
  perform lg.ok(n = 4, format('import history: invoice 1, its payment, invoice 3 and its void (%s entries)', n));
  perform lg.ok(lg.val('other', format('select public.ledger_import_history(%L)', lg.id('B')))::int = 0, 'importing again posts nothing');
  perform lg.ok((select entry_date from public.journal_entries where source = 'invoice' and source_id = lg.id('invB1')) = public.ba_today() - 10
                and (select entry_date from public.journal_entries where source = 'payment' and source_id = lg.id('payB1')) = ((now() - interval '2 days') at time zone 'America/Puerto_Rico')::date,
                'imported entries keep the real dates');
  perform lg.ok(lg.val('other', format('select unbalanced_entries = 0 and receivable_cents = open_invoices_cents and receivable_cents = 11400 + 5000 and unposted_invoices = 0 and unposted_payments = 0 from public.ledger_integrity(%L)', lg.id('B')))::boolean,
                'after the import: receivable 164.00 = open invoices, nothing unposted');
  perform lg.ok(lg.bal('B', '4000') = 29000 and lg.bal('B', '2100') = 1400 and lg.bal('B', '1000') = 14000, 'B: revenue 290.00, tax 14.00, cash 140.00');
end $$;

-- ------------------------------------------------------------ company deletion
do $$ begin
  perform lg.ok(lg.merr(format('delete from public.companies where id = %L', lg.id('B'))) = '', 'deleting a whole company removes its ledger (cascade)');
  perform lg.ok((select count(*) from public.journal_entries where company_id = lg.id('B')) = 0 and (select count(*) from public.ledger_accounts where company_id = lg.id('B')) = 0, 'nothing of B is left');
  perform lg.ok((select count(*) from public.journal_entries where company_id = lg.id('A')) > 0, 'A is untouched');
end $$;

do $$ begin
  if exists (select 1 from lg.failures) then
    raise exception 'LEDGER TESTS FAILED: %', (select string_agg(msg, ' | ') from lg.failures);
  end if;
  raise notice 'ALL LEDGER TESTS PASSED';
end $$;
