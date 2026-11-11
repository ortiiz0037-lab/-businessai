-- Billing (0010) test suite: 7-day trial WITH a card (Stripe trial).
-- Runs after 10_rls_business.test.sql (users A, B, C; companies coA/coB).
-- Stripe states are written as superuser, exactly as the webhook
-- (service_role) stores them.
\set ON_ERROR_STOP 1

-- ----------------------------------------- sign-up: no access before Checkout
do $$ declare cid uuid; begin
  perform t.as_user('userB'); set local role authenticated;
  cid := public.create_company('Empresa Nueva B2'); reset role;
  insert into t.ctx values ('coN', cid);
end $$;
do $$ declare st record; n int; begin
  select count(*) into n from public.company_subscriptions where company_id = t.id('coN');
  perform t.ok(n = 0, 'registration alone creates no trial (card required)');
  perform t.as_user('userB'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coN'));
  perform t.ok(st.state = 'none' and not st.can_write, 'before Checkout: state none, read-only');
  perform t.ok(st.trial_eligible and st.trial_days = 7, 'before Checkout: eligible for a 7-day trial');
  begin
    insert into public.clients (company_id, name) values (t.id('coN'), 'x');
    perform t.ok(false, 'before Checkout: cannot create clients');
  exception when raise_exception then
    perform t.ok(sqlerrm = 'BILLING_INACTIVE', 'before Checkout: cannot create clients (BILLING_INACTIVE)'); end;
end $$;

-- Checkout started (customer created) but not completed / card declined
insert into public.company_subscriptions (company_id, stripe_customer_id, plan, status)
values (t.id('coN'), 'cus_test_N', 'pro', 'incomplete');
do $$ declare st record; begin
  perform t.as_user('userB'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coN'));
  perform t.ok(st.state = 'none' and not st.can_write and st.trial_eligible,
               'checkout abandoned or card declined: still none, trial not consumed');
end $$;

-- ------------------------------------- Checkout completed → Stripe trial
update public.company_subscriptions
   set stripe_subscription_id = 'sub_test_N1', stripe_price_id = 'price_pro', plan = 'pro', status = 'trialing',
       trial_start = now(), trial_end = now() + interval '7 days',
       current_period_start = now(), current_period_end = now() + interval '7 days'
 where company_id = t.id('coN');
do $$ declare st record; begin
  perform t.ok((select trial_consumed_at is not null from public.company_subscriptions where company_id = t.id('coN')),
               'storing a subscription with a trial marks the trial as consumed');
  perform t.as_user('userB'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coN'));
  perform t.ok(st.state = 'trialing' and st.can_write and st.plan = 'pro', 'trial: trialing, can create, plan chosen at Checkout');
  perform t.ok(st.trial_ends_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 minute',
               'trial: first charge date = trial end (7 days)');
  perform t.ok(not st.trial_eligible, 'trial: no second trial');
  perform t.ok(st.max_clients = 500, 'trial uses the limits of the chosen plan');
  insert into public.clients (company_id, name) values (t.id('coN'), 'Cliente en prueba');
  perform t.ok(true, 'trial: owner creates a client');
end $$;

-- ------------------------------------------------ cancel during the trial
update public.company_subscriptions set cancel_at_period_end = true, cancel_at = trial_end
 where company_id = t.id('coN');
do $$ declare st record; begin
  perform t.as_user('userB'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coN'));
  perform t.ok(st.state = 'trialing' and st.can_write and st.cancel_at_period_end,
               'cancelled during trial: access until the trial ends');
end $$;
update public.company_subscriptions set status = 'canceled', ended_at = now() where company_id = t.id('coN');
do $$ declare st record; begin
  perform t.as_user('userB'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coN'));
  perform t.ok(st.state = 'canceled' and not st.can_write, 'trial ended after cancelling: canceled, read-only');
  perform t.ok(not st.trial_eligible, 'after cancelling the trial: no new trial');
end $$;

-- A new subscription (no trial) cannot reset the consumed trial.
update public.company_subscriptions
   set stripe_subscription_id = 'sub_test_N2', status = 'active', trial_start = null, trial_end = null,
       cancel_at_period_end = false, cancel_at = null, ended_at = null, trial_consumed_at = null
 where company_id = t.id('coN');
do $$ begin
  perform t.ok((select trial_consumed_at is not null from public.company_subscriptions where company_id = t.id('coN')),
               'trial_consumed_at can never be cleared (one trial per company)');
end $$;

-- ---------------------------------------------------------- isolation
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  select count(*) into n from public.company_billing_state(t.id('coN'));
  perform t.ok(n = 0, 'A cannot read another company''s billing state');
  select count(*) into n from public.company_subscriptions where company_id = t.id('coN');
  perform t.ok(n = 0, 'A cannot read another company''s subscription row');
end $$;
do $$ begin
  set local role anon;
  begin
    perform public.company_billing_state(t.id('coA'));
    perform t.ok(false, 'anon cannot call company_billing_state');
  exception when insufficient_privilege then perform t.ok(true, 'anon cannot call company_billing_state'); end;
  perform t.ok((select count(*) from public.billing_plans) = 3, 'anon can read the plan catalog (pricing)');
end $$;
do $$ begin
  perform t.as_user('userB'); set local role authenticated;
  begin
    update public.company_subscriptions set status = 'active' where company_id = t.id('coN');
    perform t.ok(false, 'owner cannot activate its own subscription');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot activate its own subscription'); end;
  begin
    update public.company_subscriptions set trial_consumed_at = null where company_id = t.id('coN');
    perform t.ok(false, 'owner cannot reset its trial');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot reset its trial'); end;
  begin
    insert into public.company_subscriptions (company_id, plan, status) values (t.id('coN'), 'premium', 'active');
    perform t.ok(false, 'owner cannot insert a subscription');
  exception when insufficient_privilege or unique_violation then perform t.ok(true, 'owner cannot insert a subscription'); end;
  begin
    update public.billing_plans set max_clients = null where plan = 'basic';
    perform t.ok(false, 'owner cannot change plan limits');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot change plan limits'); end;
end $$;

-- ------------------------------------------- paid plan limits (company A)
update public.company_subscriptions
   set stripe_price_id = 'price_basic', plan = 'basic', status = 'active',
       current_period_start = now(), current_period_end = now() + interval '1 month'
 where company_id = t.id('coA');
update public.billing_plans set max_clients = 3, max_documents_per_month = 4 where plan = 'basic';
do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'active' and st.can_write and st.plan = 'basic', 'paid: active, plan basic');
  perform t.ok(st.current_period_end > now(), 'paid: period end exposed');
  for i in 1 .. greatest(0, 3 - st.clients_used) loop
    insert into public.clients (company_id, name) values (t.id('coA'), 'Cliente ' || i);
  end loop;
  begin
    insert into public.clients (company_id, name) values (t.id('coA'), 'uno de más');
    perform t.ok(false, 'basic: client limit enforced');
  exception when raise_exception then
    perform t.ok(sqlerrm = 'PLAN_LIMIT_CLIENTS', 'basic: client limit enforced (PLAN_LIMIT_CLIENTS)'); end;
end $$;
do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  for i in 1 .. greatest(0, 4 - st.documents_this_month) loop
    insert into public.documents (company_id, document_type, document_number) values (t.id('coA'), 'quote', 'LIM-' || i);
  end loop;
  begin
    insert into public.documents (company_id, document_type, document_number) values (t.id('coA'), 'quote', 'LIM-X');
    perform t.ok(false, 'basic: monthly document limit enforced');
  exception when raise_exception then
    perform t.ok(sqlerrm = 'PLAN_LIMIT_DOCUMENTS', 'basic: monthly document limit enforced (PLAN_LIMIT_DOCUMENTS)'); end;
end $$;
update public.company_subscriptions set plan = 'premium', stripe_price_id = 'price_premium' where company_id = t.id('coA');
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  insert into public.clients (company_id, name) values (t.id('coA'), 'tras mejorar plan');
  perform t.ok(true, 'upgrade to premium lifts the limit immediately');
end $$;

-- ----------------------- first charge after the trial fails → past_due
update public.company_subscriptions
   set status = 'past_due', last_payment_failed_at = now(), last_payment_error = 'Your card was declined.'
 where company_id = t.id('coA');
do $$ declare st record; n int; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'past_due' and st.can_write and st.last_payment_failed_at is not null,
               'failed charge: past_due keeps access while Stripe retries, failure exposed');
end $$;
update public.company_subscriptions set status = 'unpaid' where company_id = t.id('coA');
do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'unpaid' and not st.can_write, 'retries exhausted: unpaid, read-only');
  begin
    insert into public.clients (company_id, name) values (t.id('coA'), 'x');
    perform t.ok(false, 'unpaid: cannot create');
  exception when raise_exception then perform t.ok(true, 'unpaid: cannot create'); end;
end $$;
-- Leave an open balance on coA's invoice (the RLS suite paid it in full):
-- with 0015 a payment can never exceed the balance.
update public.documents set total = total + 100 where company_id = t.id('coA') and document_type = 'invoice';
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  select count(*) into n from public.documents where company_id = t.id('coA');
  perform t.ok(n > 0, 'read-only: existing documents still readable');
  update public.documents set status = 'sent' where company_id = t.id('coA') and document_type = 'invoice';
  get diagnostics n = row_count;
  perform t.ok(n > 0, 'read-only: existing invoices can still be updated');
  insert into public.payments (company_id, document_id, amount, payment_method, created_by)
    select t.id('coA'), d.id, 1, 'manual', t.id('userA') from public.documents d
     where d.company_id = t.id('coA') and d.document_type = 'invoice' limit 1;
  perform t.ok(true, 'read-only: customer payments can still be recorded');
end $$;
update public.company_subscriptions set status = 'active', last_payment_failed_at = null, last_payment_error = null
 where company_id = t.id('coA');
do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'active' and st.can_write, 'card updated and charged: active again');
end $$;

-- --------------------------------------------- server-side is not limited
delete from public.company_subscriptions where company_id = t.id('coB');
insert into public.clients (company_id, name) values (t.id('coB'), 'creado por service role');
do $$ begin perform t.ok(true, 'service context (no user) is not limited by the trigger'); end $$;
do $$ declare st record; begin
  perform t.as_user('userC'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'active', 'members can read their company''s billing state');
end $$;

update public.billing_plans set max_clients = 50, max_documents_per_month = 40 where plan = 'basic';
do $$ begin raise notice 'ALL BILLING TESTS PASSED'; end $$;
