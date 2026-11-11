-- Billing hardening (0016) test suite. TEST-ONLY, local throw-away database
-- with 0001–0011 (+ 0014a / 0015 optional) + 0016. Standalone fixture (schema h).
-- One free trial per person (claims, abandoned checkouts, concurrency is
-- covered by the primary key) and receipts outside the document quota.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema h;
create table h.failures (msg text);
create function h.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into h.failures values (msg); end if;
end $$;
grant usage on schema h to authenticated;
grant insert on h.failures to authenticated;
grant execute on function h.ok(boolean, text) to authenticated;

insert into auth.users (id) values
  ('8a000000-0000-4000-8000-000000000001'), ('8a000000-0000-4000-8000-000000000002'), ('8a000000-0000-4000-8000-000000000003');
insert into public.companies (id, name, created_by) values
  ('8c000000-0000-4000-8000-00000000000a', 'Prueba A', '8a000000-0000-4000-8000-000000000001'),
  ('8c000000-0000-4000-8000-00000000000b', 'Prueba B', '8a000000-0000-4000-8000-000000000001'),
  ('8c000000-0000-4000-8000-00000000000c', 'Prueba C', '8a000000-0000-4000-8000-000000000002'),
  ('8c000000-0000-4000-8000-00000000000d', 'Prueba D', '8a000000-0000-4000-8000-000000000002'),
  ('8c000000-0000-4000-8000-00000000000e', 'Prueba E', '8a000000-0000-4000-8000-000000000003');
insert into public.memberships (company_id, user_id, role) values
  ('8c000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-000000000001', 'owner'),
  ('8c000000-0000-4000-8000-00000000000b', '8a000000-0000-4000-8000-000000000001', 'owner'),
  ('8c000000-0000-4000-8000-00000000000c', '8a000000-0000-4000-8000-000000000002', 'owner'),
  ('8c000000-0000-4000-8000-00000000000d', '8a000000-0000-4000-8000-000000000002', 'owner'),
  ('8c000000-0000-4000-8000-00000000000e', '8a000000-0000-4000-8000-000000000003', 'owner');

-- ------------------------------------------------------ one trial per person
do $$
declare u1 uuid := '8a000000-0000-4000-8000-000000000001'; u2 uuid := '8a000000-0000-4000-8000-000000000002';
        a uuid := '8c000000-0000-4000-8000-00000000000a'; b uuid := '8c000000-0000-4000-8000-00000000000b';
        c uuid := '8c000000-0000-4000-8000-00000000000c'; d uuid := '8c000000-0000-4000-8000-00000000000d';
begin
  perform h.ok(public.user_trial_available(a, u1), 'a new user can start a trial in company A');
  perform h.ok(public.claim_trial(a, u1), 'the trial is claimed for company A');
  perform h.ok(public.claim_trial(a, u1), 'claiming again for the same company (new Checkout) is fine');
  perform h.ok(not public.user_trial_available(b, u1) and not public.claim_trial(b, u1),
               'C3: the same person gets no second trial in company B while A''s checkout is open');
  -- Company A's checkout completes: Stripe writes the trial.
  insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status, trial_start, trial_end)
  values (a, 'cus_h_a', 'sub_h_a', 'pro', 'trialing', now(), now() + interval '7 days');
  update public.trial_claims set claimed_at = now() - interval '30 days' where user_id = u1;
  perform h.ok(not public.claim_trial(b, u1), 'C3: after A used the trial, company B never gets one (even much later)');
  -- Abandoned checkout: claim for C never became a subscription.
  perform h.ok(public.claim_trial(c, u2), 'user 2 claims a trial for company C');
  perform h.ok(not public.claim_trial(d, u2), 'a second company within 25 hours gets none');
  update public.trial_claims set claimed_at = now() - interval '26 hours' where user_id = u2;
  perform h.ok(public.user_trial_available(d, u2) and public.claim_trial(d, u2),
               'an abandoned checkout (no subscription after 25 hours) does not burn the trial');
  perform h.ok((select company_id from public.trial_claims where user_id = u2) = d, 'the claim moved to company D');
  -- Trials consumed before 0016 (no claim row) still count.
  delete from public.trial_claims where user_id = u1;
  perform h.ok(not public.user_trial_available(b, u1) and not public.claim_trial(b, u1),
               'a trial consumed before this migration (trial_consumed_at) also counts');
  -- Deleting the company does not free the claim.
  update public.trial_claims set claimed_at = now() where user_id = u2;
  delete from public.companies where id = d;
  perform h.ok(exists (select 1 from public.trial_claims where user_id = u2 and company_id is null)
               and not public.claim_trial(c, u2), 'deleting the company keeps the claim: no new trial');
end $$;

-- API roles cannot claim, read or write.
do $$ begin
  perform h.ok(not has_function_privilege('authenticated', 'public.claim_trial(uuid, uuid)', 'EXECUTE')
               and not has_function_privilege('anon', 'public.claim_trial(uuid, uuid)', 'EXECUTE')
               and not has_table_privilege('authenticated', 'public.trial_claims', 'SELECT')
               and not has_table_privilege('authenticated', 'public.trial_claims', 'INSERT'),
               'only service_role can claim trials or read claims');
end $$;

-- --------------------------------------------- receipts outside the quota
update public.billing_plans set max_documents_per_month = 2 where plan = 'basic';
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status,
                                          current_period_start, current_period_end)
values ('8c000000-0000-4000-8000-00000000000e', 'cus_h_e', 'sub_h_e', 'basic', 'active', now() - interval '1 day', now() + interval '29 days');
do $$
declare e uuid := '8c000000-0000-4000-8000-00000000000e'; u3 uuid := '8a000000-0000-4000-8000-000000000003';
        st record; msg text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.clients (company_id, name) values (e, 'Cliente H');   -- the shared trigger also runs on clients
  insert into public.documents (company_id, document_type, document_number, status, total, created_by) values (e, 'invoice', 'H-1', 'sent', 10, u3);
  insert into public.documents (company_id, document_type, document_number, status, total, created_by) values (e, 'quote', 'H-2', 'draft', 10, u3);
  begin
    insert into public.documents (company_id, document_type, document_number, status, total, created_by) values (e, 'invoice', 'H-3', 'draft', 10, u3);
    msg := 'inserted';
  exception when others then msg := sqlerrm; end;
  reset role;
  perform h.ok(msg = 'PLAN_LIMIT_DOCUMENTS', 'the plan limit (2) still blocks a third invoice');
  -- A receipt of a payment (0015 rules apply when 0015 is present).
  insert into public.payments (id, company_id, document_id, amount)
  select '8e000000-0000-4000-8000-000000000001', e, id, 10 from public.documents where company_id = e and document_type = 'invoice';
  set local role authenticated;
  begin
    insert into public.documents (company_id, document_type, document_number, status, total, metadata, created_by)
    values (e, 'receipt', 'H-R1', 'paid', 10, '{"payment_id":"8e000000-0000-4000-8000-000000000001"}', u3);
    msg := '';
  exception when others then msg := sqlerrm; end;
  select * into st from public.company_billing_state(e);
  reset role;
  perform h.ok(msg = '', 'I8: a receipt can still be created at the document limit ' || msg);
  perform h.ok(st.documents_this_month = 2, 'I8: receipts are not counted in documents_this_month (2)');
  perform set_config('request.jwt.claims', '', true);
end $$;
-- Receipts still need an active subscription.
update public.company_subscriptions set status = 'canceled' where company_id = '8c000000-0000-4000-8000-00000000000e';
do $$ declare msg text; begin
  perform set_config('request.jwt.claims', json_build_object('sub', '8a000000-0000-4000-8000-000000000003', 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.documents (company_id, document_type, document_number, status, total, metadata, created_by)
    values ('8c000000-0000-4000-8000-00000000000e', 'receipt', 'H-R2', 'paid', 10, '{"payment_id":"8e000000-0000-4000-8000-000000000001"}',
            '8a000000-0000-4000-8000-000000000003');
    msg := 'inserted';
  exception when others then msg := sqlerrm; end;
  reset role;
  perform h.ok(msg = 'BILLING_INACTIVE', 'receipts still require an active subscription or trial ' || msg);
end $$;

do $$ begin
  if exists (select 1 from h.failures) then
    raise exception 'BILLING HARDENING TESTS FAILED: %', (select string_agg(msg, '; ') from h.failures);
  end if;
  raise notice 'ALL BILLING HARDENING TESTS PASSED';
end $$;
