-- Accounts receivable and collections (0025). TEST-ONLY, local throw-away
-- database with 0014a, 0015, 0023, 0024, 0025. Schema ar.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema ar;
create table ar.ctx (key text primary key, val text not null);
create function ar.id(k text) returns uuid language sql stable as $$ select val::uuid from ar.ctx where key = k $$;
create table ar.failures (msg text);
create function ar.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into ar.failures values (msg); end if;
end $$;
grant usage on schema ar to authenticated;
grant select on ar.ctx to authenticated;
grant execute on all functions in schema ar to authenticated;
create function ar.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', ar.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function ar.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', ar.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function ar.merr(stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  begin execute stmt; exception when others then msg := sqlerrm; end;
  return msg;
end $$;
-- Balance row of an invoice as the admin sees it (status/balance/bucket).
create function ar.row(inv text, as_of date default null) returns text language plpgsql volatile as $$
begin
  return ar.val('admin', format('select ar_status || ''/'' || balance_cents || ''/'' || coalesce(bucket, ''-'') from public.ar_invoice_balances(%L, %L) where document_id = %L',
    ar.id('A'), as_of, ar.id(inv)));
end $$;
create function ar.status(inv text) returns text language sql volatile as $$ select status from public.documents where id = ar.id(inv) $$;
create function ar.acct(co text, c text) returns bigint language sql volatile as $$
  select balance_cents from public.ledger_trial_balance(ar.id(co)) where code = c $$;
-- An issued invoice (the member issues it; dates relative to today).
create function ar.inv(co text, who text, inv text, client text, total numeric, issued int, due int) returns text language sql as $$
  select ar.err(who, format('insert into public.documents (id, company_id, client_id, created_by, document_type, document_number, status, subtotal, tax, total, issue_date, due_date)
    values (%L, %L, %L, %L, %L, %L, %L, %s, 0, %s, %L, %L)', ar.id(inv), ar.id(co), ar.id(client), ar.id(who), 'invoice', 'x', 'sent', total, total,
    public.ba_today() + issued, public.ba_today() + due)) $$;
create function ar.pay(co text, who text, inv text, amount numeric, pid text default null) returns text language sql as $$
  select ar.err(who, format('insert into public.payments (id, company_id, document_id, amount, created_by) values (%L, %L, %L, %s, %L)',
    coalesce(ar.id(pid), gen_random_uuid()), ar.id(co), ar.id(inv), amount, ar.id(who))) $$;

insert into ar.ctx values
  ('owner', 'f1000000-0000-4000-8000-0000000000a1'), ('admin', 'f1000000-0000-4000-8000-0000000000a2'),
  ('member', 'f1000000-0000-4000-8000-0000000000a3'), ('other', 'f1000000-0000-4000-8000-0000000000a4'),
  ('A', 'f2000000-0000-4000-8000-0000000000a1'), ('B', 'f2000000-0000-4000-8000-0000000000a2'),
  ('c1', 'f3000000-0000-4000-8000-0000000000a1'), ('c2', 'f3000000-0000-4000-8000-0000000000a2'), ('cB', 'f3000000-0000-4000-8000-0000000000a3'),
  ('i1', 'f4000000-0000-4000-8000-0000000000a1'), ('i2', 'f4000000-0000-4000-8000-0000000000a2'), ('i3', 'f4000000-0000-4000-8000-0000000000a3'),
  ('i4', 'f4000000-0000-4000-8000-0000000000a4'), ('i5', 'f4000000-0000-4000-8000-0000000000a5'), ('i6', 'f4000000-0000-4000-8000-0000000000a6'),
  ('i7', 'f4000000-0000-4000-8000-0000000000a7'), ('i8', 'f4000000-0000-4000-8000-0000000000a8'), ('i9', 'f4000000-0000-4000-8000-0000000000a9'),
  ('iB', 'f4000000-0000-4000-8000-0000000000b1'),
  ('p2', 'f5000000-0000-4000-8000-0000000000a2'), ('p5', 'f5000000-0000-4000-8000-0000000000a5'), ('p7', 'f5000000-0000-4000-8000-0000000000a7'),
  ('pB', 'f5000000-0000-4000-8000-0000000000b1');
insert into auth.users (id, email) select val::uuid, key || '@ar.test' from ar.ctx where key in ('owner', 'admin', 'member', 'other');
insert into public.companies (id, name, created_by) values (ar.id('A'), 'Cobros A', ar.id('owner')), (ar.id('B'), 'Cobros B', ar.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (ar.id('A'), 'cus_ar_a', 'sub_ar_a', 'basic', 'active'), (ar.id('B'), 'cus_ar_b', 'sub_ar_b', 'premium', 'active');
insert into public.memberships (company_id, user_id, role) values
  (ar.id('A'), ar.id('owner'), 'owner'), (ar.id('A'), ar.id('admin'), 'admin'), (ar.id('A'), ar.id('member'), 'member'), (ar.id('B'), ar.id('other'), 'owner');
insert into public.clients (id, company_id, name, email) values
  (ar.id('c1'), ar.id('A'), 'Cliente Uno', 'uno@cliente.test'), (ar.id('c2'), ar.id('A'), 'Cliente Dos', null), (ar.id('cB'), ar.id('B'), 'Cliente B', 'b@cliente.test');

-- ------------------------------------------------------------- invoices, statuses, aging
do $$ begin
  perform ar.ok(ar.inv('A', 'member', 'i1', 'c1', 100, -100, -95) = '' and ar.inv('A', 'member', 'i2', 'c1', 200, -70, -65) = ''
                and ar.inv('A', 'member', 'i3', 'c1', 300, -40, -35) = '' and ar.inv('A', 'member', 'i4', 'c2', 400, -10, 20) = ''
                and ar.inv('A', 'member', 'i5', 'c2', 50, -20, -5) = '' and ar.inv('A', 'member', 'i6', 'c2', 80, -3, 10) = '', 'six invoices issued by a member');
  perform ar.ok(ar.pay('A', 'member', 'i2', 50, 'p2') = '' and ar.pay('A', 'member', 'i5', 50, 'p5') = '' and ar.pay('A', 'member', 'i6', 30) = '',
                'payments: 50 on i2 (partial), 50 on i5 (full), 30 on i6 (partial)');
  perform ar.ok(ar.val('member', format('select count(*) from public.ar_invoice_balances(%L)', ar.id('A'))) = '0', 'members see no receivables');
  perform ar.ok(ar.val('admin', format('select count(*) from public.ar_invoice_balances(%L)', ar.id('A'))) = '6', 'admins see the six invoices');
  perform ar.ok(ar.row('i1') = 'overdue/10000/90_plus', 'i1: 95 days past due → 90+');
  perform ar.ok(ar.row('i2') = 'overdue/15000/61_90', 'i2: partially paid and 65 days past due → overdue, 61–90, balance 150.00');
  perform ar.ok(ar.row('i3') = 'overdue/30000/31_60', 'i3: 35 days → 31–60');
  perform ar.ok(ar.row('i4') = 'issued/40000/0_30', 'i4: not yet due → issued, 0–30');
  perform ar.ok(ar.row('i5') = 'paid/0/-', 'i5: paid, no bucket');
  perform ar.ok(ar.row('i6') = 'partially_paid/5000/0_30', 'i6: partially paid, not due');
  perform ar.ok(ar.val('admin', format('select b0_30 || ''/'' || b31_60 || ''/'' || b61_90 || ''/'' || b90_plus || ''/'' || total_cents || ''/'' || overdue_cents from public.ar_aging(%L) where client_id = %L', ar.id('A'), ar.id('c1')))
                = '0/30000/15000/10000/55000/55000', 'aging of client 1: 31–60 300.00, 61–90 150.00, 90+ 100.00, all overdue');
  perform ar.ok(ar.val('admin', format('select b0_30 || ''/'' || total_cents || ''/'' || overdue_cents || ''/'' || not_due_cents from public.ar_aging(%L) where client_id = %L', ar.id('A'), ar.id('c2')))
                = '45000/45000/0/45000', 'aging of client 2: 450.00 in 0–30, nothing overdue');
  perform ar.ok(ar.row('i1', public.ba_today() - 30) = 'overdue/10000/61_90' and ar.row('i2', public.ba_today() - 30) = 'overdue/20000/31_60',
                'as of 30 days ago: older buckets, and today''s payment not counted yet');
  perform ar.ok(ar.val('admin', format('select count(*) from public.ar_invoice_balances(%L, %L) where document_id = %L', ar.id('A'), public.ba_today() - 30, ar.id('i4'))) = '0',
                'as of 30 days ago: an invoice issued later is not there');
  perform ar.ok(ar.val('owner', format('select receivable_cents = open_invoices_cents and receivable_cents = 100000 from public.ledger_integrity(%L)', ar.id('A')))::boolean,
                'ledger: accounts receivable 1,000.00 = open balance of the invoices');
  perform ar.ok((select sum(balance_cents) from public.ar_invoice_balances(ar.id('A'))) = ar.acct('A', '1200'), 'the aging total equals the receivable account (no parallel book)');
  perform ar.ok(ar.acct('A', '4000') = 113000 and ar.acct('A', '1000') = 13000, 'revenue 1,130.00 recognised once at issue; cash 130.00 from payments');
end $$;

-- ------------------------------------------------------------- payment voids
do $$ declare rev bigint := ar.acct('A', '4000'); begin
  perform ar.ok(ar.err('member', format('select public.payment_void(%L, %L)', ar.id('p5'), 'Cheque devuelto')) like '%PAYMENT_NOT_FOUND%', 'members cannot void payments');
  perform ar.ok(ar.err('admin', format('select public.payment_void(%L, %L)', ar.id('p5'), '')) like '%REASON_REQUIRED%', 'a reason is required');
  perform ar.ok(ar.err('admin', format('select public.payment_void(%L, %L)', ar.id('p5'), 'Cheque devuelto')) = '', 'the admin voids the payment of i5 (bounced check)');
  perform ar.ok((select voided_by = ar.id('admin') and void_reason = 'Cheque devuelto' and amount = 50 from public.payments where id = ar.id('p5')), 'the payment row is kept, marked voided');
  perform ar.ok(ar.status('i5') = 'overdue' and ar.row('i5') = 'overdue/5000/0_30', 'the invoice goes back from paid to overdue with its balance');
  perform ar.ok((select string_agg(a.code || ':' || l.debit_cents || '/' || l.credit_cents, ' ' order by l.line_no) from public.journal_entries e join public.journal_lines l on l.entry_id = e.id
                 join public.ledger_accounts a on a.id = l.account_id where e.source = 'payment_void' and e.source_id = ar.id('p5')) = '1000:0/5000 1200:5000/0',
                'reversal entry: Dr receivable / Cr cash');
  perform ar.ok((select reverses_entry_id is not null from public.journal_entries where source = 'payment_void' and source_id = ar.id('p5'))
                and exists (select 1 from public.journal_entries where source = 'payment' and source_id = ar.id('p5')), 'it points to the original payment entry, which is kept');
  perform ar.ok(ar.acct('A', '4000') = rev, 'revenue unchanged by the void');
  perform ar.ok(ar.err('admin', format('select public.payment_void(%L, %L)', ar.id('p5'), 'Otra vez')) like '%PAYMENT_ALREADY_VOIDED%', 'a payment is voided once');
  perform ar.ok(ar.merr(format('update public.payments set amount = 1 where id = %L', ar.id('p2'))) like '%PAYMENT_IMMUTABLE%', 'payments are not edited (maintenance)');
  perform ar.ok(ar.merr(format('delete from public.payments where id = %L', ar.id('p5'))) like '%PAYMENT_IMMUTABLE%', 'nor deleted, voided or not');
  perform ar.ok(ar.merr(format('update public.payments set voided_at = null, void_reason = null where id = %L', ar.id('p5'))) like '%PAYMENT_IMMUTABLE%', 'a void is not undone');
  perform ar.ok(ar.err('member', format('insert into public.documents (company_id, client_id, created_by, document_type, document_number, status, total, metadata) values (%L, %L, %L, %L, %L, %L, 50, %L)',
                ar.id('A'), ar.id('c2'), ar.id('member'), 'receipt', 'x', 'paid', jsonb_build_object('payment_id', ar.id('p5')))) like '%RECEIPT_PAYMENT_REQUIRED%', 'no receipt for a voided payment');
  perform ar.ok(ar.pay('A', 'member', 'i5', 50.01) like '%PAYMENT_EXCEEDS_BALANCE%', 'the balance after the void is exact (50.00)');
  perform ar.ok(ar.pay('A', 'member', 'i5', 50) = '' and ar.status('i5') = 'paid', 'paid again with a new payment');
  perform ar.ok(ar.err('admin', format('update public.documents set status = %L where id = %L', 'sent', ar.id('i5'))) like '%DOCUMENT_TRANSITION%', 'a paid invoice cannot be set back by hand while payments cover it');
  perform ar.ok(ar.err('admin', format('update public.documents set status = %L, metadata = metadata || %L where id = %L', 'cancelled', '{"void":{"reason":"Error"}}', ar.id('i5'))) like '%DOCUMENT_HAS_PAYMENTS%',
                'an invoice with active payments is not voided');
  perform ar.ok(ar.inv('A', 'member', 'i7', 'c2', 25, -2, 5) = '' and ar.pay('A', 'member', 'i7', 25, 'p7') = ''
                and ar.err('admin', format('select public.payment_void(%L, %L)', ar.id('p7'), 'Pago aplicado a la factura equivocada')) = '', 'i7: paid, then the payment voided');
  perform ar.ok(ar.err('admin', format('update public.documents set status = %L, metadata = metadata || %L where id = %L', 'cancelled', '{"void":{"reason":"Factura duplicada"}}', ar.id('i7'))) = '',
                'with only voided payments the invoice can be voided');
  perform ar.ok(ar.val('owner', format('select receivable_cents = open_invoices_cents and unbalanced_entries = 0 from public.ledger_integrity(%L)', ar.id('A')))::boolean
                and (select sum(balance_cents) from public.ar_invoice_balances(ar.id('A'))) = ar.acct('A', '1200'), 'after voids: receivable = open balances, ledger balanced');
end $$;

-- ------------------------------------------------------------- collections: statuses, notes, promises
do $$ declare pid uuid; begin
  perform ar.ok(ar.err('member', format('select public.ar_set_status(%L, %L)', ar.id('i1'), 'contacted')) like '%INVOICE_NOT_FOUND%', 'members do not manage collections');
  perform ar.ok(ar.err('admin', format('select public.ar_set_status(%L, %L)', ar.id('i1'), 'paid')) like '%STATUS_INVALID%', 'only collection statuses');
  perform ar.ok(ar.err('admin', format('select public.ar_set_status(%L, %L)', ar.id('i1'), 'contacted')) = '' and ar.val('admin', format('select collection_status from public.ar_invoice_balances(%L) where document_id = %L', ar.id('A'), ar.id('i1'))) = 'contacted',
                'the admin marks i1 as contacted');
  perform ar.ok(ar.err('admin', format('select public.ar_add_note(%L, null, %L, %L)', ar.id('A'), ar.id('i1'), 'Llamé; promete revisar')) = '', 'an internal note on the invoice (client taken from it)');
  perform ar.ok(ar.err('admin', format('select public.ar_add_note(%L, %L, null, %L)', ar.id('A'), ar.id('c1'), 'Cliente prefiere correo')) = '', 'a note on the client');
  perform ar.ok((select count(*) from public.collection_notes where client_id = ar.id('c1')) = 2, 'both in the client history');
  perform ar.ok(ar.err('admin', format('select public.ar_add_note(%L, %L, %L, %L)', ar.id('A'), ar.id('c2'), ar.id('i1'), 'x')) like '%CLIENT_INVALID%', 'a note cannot mix a client and another client''s invoice');
  perform ar.ok(ar.err('other', format('select public.ar_add_note(%L, %L, null, %L)', ar.id('B'), ar.id('c1'), 'x')) like '%CLIENT_INVALID%', 'isolation: B cannot write on A''s client');
  perform ar.ok(ar.merr(format('update public.collection_notes set body = %L where client_id = %L', 'cambiado', ar.id('c1'))) like '%LEDGER_IMMUTABLE%', 'notes are append-only');
  -- promises
  perform ar.ok(ar.err('admin', format('select public.ar_add_promise(%L, %L, 30001)', ar.id('i3'), public.ba_today() + 5)) like '%AMOUNT_INVALID%', 'a promise cannot exceed the balance');
  perform ar.ok(ar.err('admin', format('select public.ar_add_promise(%L, %L, 10000)', ar.id('i3'), public.ba_today() - 1)) like '%DATE_INVALID%', 'nor be dated in the past');
  perform ar.ok(ar.err('member', format('select public.ar_refresh(%L)', ar.id('A'))) like '%FORBIDDEN%', 'members do not run collection refreshes');
  perform ar.ok(ar.err('admin', format('select public.ar_add_promise(%L, %L, 10000)', ar.id('i5'), public.ba_today() + 1)) like '%INVOICE_NOT_OPEN%', 'nor be on a paid invoice');
  pid := ar.val('admin', format('select public.ar_add_promise(%L, %L, 10000, %L)', ar.id('i3'), public.ba_today() + 5, 'Paga el viernes'))::uuid;
  perform ar.ok(pid is not null and (select status from public.payment_promises where id = pid) = 'pending'
                and (select status from public.invoice_collections where document_id = ar.id('i3')) = 'promised', 'promise of 100.00 in 5 days: pending, invoice marked promised');
  perform ar.ok(ar.pay('A', 'member', 'i3', 60) = '' and (select status from public.payment_promises where id = pid) = 'pending', 'a 60.00 payment: not enough, still pending');
  perform ar.ok(ar.pay('A', 'member', 'i3', 40) = '', 'another 40.00 paid');
  perform ar.ok((select status from public.payment_promises where id = pid) = 'kept', 'the promise is kept automatically');
  insert into public.payment_promises (company_id, document_id, client_id, promised_date, amount_cents) values (ar.id('A'), ar.id('i2'), ar.id('c1'), public.ba_today() - 2, 15000);
  perform public.ar_refresh(ar.id('A'));
  perform ar.ok((select status from public.payment_promises where document_id = ar.id('i2')) = 'broken', 'a promise past its date without payment: broken');
  pid := ar.val('admin', format('select public.ar_add_promise(%L, %L, 5000)', ar.id('i4'), public.ba_today() + 3))::uuid;
  perform ar.ok(ar.err('admin', format('select public.ar_cancel_promise(%L, %L)', pid, '')) like '%REASON_REQUIRED%'
                and ar.err('admin', format('select public.ar_cancel_promise(%L, %L)', pid, 'El cliente cambió de plan')) = '', 'a promise is cancelled with a reason');
  perform ar.ok(ar.err('admin', format('select public.ar_cancel_promise(%L, %L)', pid, 'Otra vez')) like '%PROMISE_RESOLVED%', 'a resolved promise does not change');
  perform ar.ok(ar.merr(format('update public.payment_promises set amount_cents = 1 where id = %L', pid)) like '%AR_RECORD_IMMUTABLE%', 'nor is it edited (maintenance)');
  perform ar.ok(ar.err('other', format('select public.ar_add_promise(%L, %L, 100)', ar.id('i4'), public.ba_today() + 3)) like '%INVOICE_NOT_FOUND%', 'isolation: B cannot add promises to A''s invoices');
end $$;

-- ------------------------------------------------------------- reminders (outbox)
do $$ declare n int; r uuid; begin
  perform ar.ok(ar.err('admin', format('select public.ar_save_settings(%L, true, %L, %L, %L, %L, null, null)', ar.id('A'), '{400}', 'es', 'Cobros A', 'cobros@a.test')) like '%check%',
                'reminder days are limited (-60 … 365)');
  perform ar.ok(ar.err('admin', format('select public.ar_save_settings(%L, true, %L, %L, %L, %L, null, null)', ar.id('A'), '{7,0}', 'es', 'Cobros A', 'cobros@a.test')) = '',
                'reminders on the due day and 7 days after');
  perform ar.ok(ar.inv('A', 'member', 'i8', 'c1', 70, -20, -7) = '' and ar.inv('A', 'member', 'i9', 'c2', 90, -5, 0) = '', 'i8 due 7 days ago (client with email), i9 due today (no email)');
  perform ar.ok(ar.err('member', format('select public.ar_refresh(%L)', ar.id('A'))) like '%FORBIDDEN%', 'members do not run the reminders');
  n := ar.val('admin', format('select reminders_queued from public.ar_refresh(%L)', ar.id('A')))::int;
  perform ar.ok(n = 2, format('two reminders queued (i8 day +7, i9 day 0), older ones not flooded (%s)', n));
  perform ar.ok((select status || '/' || to_email from public.collection_reminders where document_id = ar.id('i8')) = 'pending/uno@cliente.test', 'i8: pending to the client''s email');
  perform ar.ok((select status from public.collection_reminders where document_id = ar.id('i9')) = 'no_email', 'i9: client without email → not sendable, visible');
  perform ar.ok(ar.val('admin', format('select reminders_queued from public.ar_refresh(%L)', ar.id('A')))::int = 0, 'refreshing again queues nothing (one per invoice and day)');
  perform ar.ok(ar.err('admin', format('select public.ar_mark_reminder(%L, %L)', (select id from public.collection_reminders where document_id = ar.id('i9')), 'sent')) like '%REMINDER_CLOSED%',
                'a reminder without email cannot be marked sent by email');
  perform ar.ok(ar.err('admin', format('select public.ar_mark_reminder(%L, %L)', (select id from public.collection_reminders where document_id = ar.id('i9')), 'sent_manual')) = '',
                'it can be recorded as contacted by other means');
  perform ar.ok(ar.pay('A', 'member', 'i8', 70) = '', 'i8 paid');
  perform ar.ok((select status || '/' || last_error from public.collection_reminders where document_id = ar.id('i8')) = 'cancelled/paid', 'paying i8 cancelled its pending reminder');
  perform ar.ok(ar.err('admin', format('select public.ar_mark_reminder(%L, %L)', (select id from public.collection_reminders where document_id = ar.id('i8')), 'sent')) like '%REMINDER_CLOSED%',
                'a cancelled reminder is not sent');
  perform ar.ok(ar.merr(format('delete from public.collection_reminders where document_id = %L', ar.id('i8'))) like '%AR_RECORD_IMMUTABLE%', 'reminders are history (not deleted)');
  perform ar.ok(ar.err('admin', format('select public.ar_set_status(%L, %L)', ar.id('i9'), 'disputed')) = '', 'i9 disputed');
end $$;

-- ------------------------------------------------------------- period report and isolation
do $$ declare bad int; begin
  select count(*) into bad from public.ar_client_report(ar.id('A'), public.ba_today() - 30, public.ba_today()) r
   where r.opening_cents + r.invoiced_cents - r.collected_cents + r.payments_voided_cents - r.invoices_voided_cents <> r.closing_cents;
  perform ar.ok(bad = 0, 'period report: opening + invoiced − collected + voided payments − voided invoices = closing, for every client');
  perform ar.ok((select sum(closing_cents) from public.ar_client_report(ar.id('A'), public.ba_today() - 30, public.ba_today())) = ar.acct('A', '1200'),
                'closing balances add up to the receivable account');
  perform ar.ok((select count(*) from public.ar_client_report(ar.id('A'), public.ba_today() - 30, public.ba_today())) = 2, 'one row per client');
  perform ar.ok(ar.val('member', format('select count(*) from public.ar_client_report(%L, current_date - 30, current_date)', ar.id('A'))) = '0', 'members read no report');
  perform ar.ok(ar.val('other', format('select count(*) from public.ar_aging(%L)', ar.id('A'))) = '0', 'isolation: B reads no aging of A');
  perform ar.ok(ar.val('other', format('select count(*) from public.collection_notes where company_id = %L', ar.id('A'))) = '0'
                and ar.val('other', format('select count(*) from public.payment_promises where company_id = %L', ar.id('A'))) = '0', 'isolation: B sees no notes or promises of A');
  perform ar.ok(ar.err('other', format('select public.payment_void(%L, %L)', ar.id('p2'), 'hack')) like '%PAYMENT_NOT_FOUND%', 'isolation: B cannot void A''s payments');
  perform ar.ok(ar.err('other', format('select public.ar_set_status(%L, %L)', ar.id('i1'), 'on_hold')) like '%INVOICE_NOT_FOUND%', 'isolation: B cannot change A''s collection status');
  perform ar.ok((select count(*) from public.receivables_events where company_id = ar.id('A') and action in ('payment_voided', 'status', 'note', 'promise', 'promise_kept', 'promise_broken', 'promise_cancelled', 'reminder_queued', 'reminder_sent_manual')) >= 12,
                'history: voids, statuses, notes, promises, reminders');
  perform ar.ok(ar.merr(format('delete from public.receivables_events where company_id = %L', ar.id('A'))) like '%LEDGER_IMMUTABLE%', 'the history is append-only');
end $$;

-- ------------------------------------------------------------- company deletion
do $$ begin
  perform ar.ok(ar.inv('B', 'other', 'iB', 'cB', 120, -40, -10) = '' and ar.pay('B', 'other', 'iB', 20, 'pB') = ''
                and ar.err('other', format('select public.payment_void(%L, %L)', ar.id('pB'), 'Devuelto')) = ''
                and ar.err('other', format('select public.ar_add_promise(%L, %L, 1000)', ar.id('iB'), public.ba_today() + 2)) = '', 'B: invoice, payment, void, promise');
  perform ar.ok(ar.merr(format('delete from public.companies where id = %L', ar.id('B'))) = '', 'deleting a whole company removes its receivables data (cascade)');
  perform ar.ok((select count(*) from public.payments where company_id = ar.id('B')) + (select count(*) from public.payment_promises where company_id = ar.id('B')) = 0, 'nothing of B is left');
end $$;

do $$ begin
  if exists (select 1 from ar.failures) then
    raise exception 'RECEIVABLES TESTS FAILED: %', (select string_agg(msg, ' | ') from ar.failures);
  end if;
  raise notice 'ALL RECEIVABLES TESTS PASSED';
end $$;
