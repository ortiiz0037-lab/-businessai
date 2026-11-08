-- Billing (0010) test suite. Runs after 10_rls_business.test.sql (users A, B,
-- C and companies coA/coB exist; their trial rows were created by 0010's
-- trigger only if 0010 was applied BEFORE the companies were created — here
-- they were created after, see run.sh).
-- Simulated Stripe states are written as superuser, exactly as the webhook
-- (service_role) would write them.
\set ON_ERROR_STOP 1

-- --------------------------------------------------------- registration
do $$ declare s record; begin
  select * into s from public.company_subscriptions where company_id = t.id('coA');
  perform t.ok(s.status = 'trialing' and s.plan = 'pro' and s.stripe_subscription_id is null,
               'new company gets an app trial row (trialing, plan pro, no Stripe)');
  perform t.ok(s.app_trial_ends_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 minute',
               'trial lasts 7 days (billing_config.trial_days)');
end $$;

do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'trialing' and st.can_write, 'trial: state trialing, can create');
  perform t.ok(st.max_clients = 500 and st.max_documents_per_month = 300, 'trial uses the Pro limits');
  perform t.ok(st.trial_ends_at is not null, 'trial end date exposed to the app');
  insert into public.clients (company_id, name) values (t.id('coA'), 'Cliente en prueba');
  perform t.ok(true, 'trial: owner creates a client');
end $$;

-- ---------------------------------------------------------- isolation
do $$ declare n int; begin
  perform t.as_user('userB'); set local role authenticated;
  select count(*) into n from public.company_billing_state(t.id('coA'));
  perform t.ok(n = 0, 'B cannot read A''s billing state');
  select count(*) into n from public.company_subscriptions where company_id = t.id('coA');
  perform t.ok(n = 0, 'B cannot read A''s subscription row');
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
  perform t.as_user('userA'); set local role authenticated;
  begin
    update public.company_subscriptions set status = 'active', stripe_subscription_id = 'sub_fake'
     where company_id = t.id('coA');
    perform t.ok(false, 'owner cannot activate its own subscription');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot activate its own subscription'); end;
  begin
    update public.company_subscriptions set app_trial_ends_at = now() + interval '1 year'
     where company_id = t.id('coA');
    perform t.ok(false, 'owner cannot extend its own trial');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot extend its own trial'); end;
  begin
    insert into public.company_subscriptions (company_id, plan, status) values (t.id('coA'), 'premium', 'active');
    perform t.ok(false, 'owner cannot insert a subscription');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot insert a subscription'); end;
  begin
    update public.billing_plans set max_clients = null where plan = 'basic';
    perform t.ok(false, 'owner cannot change plan limits');
  exception when insufficient_privilege then perform t.ok(true, 'owner cannot change plan limits'); end;
end $$;

-- ------------------------------------------------------- trial expiry
update public.company_subscriptions set app_trial_ends_at = now() - interval '1 minute'
 where company_id = t.id('coA');
do $$ declare st record; n int; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'trial_expired' and not st.can_write, 'expired trial: state trial_expired, read-only');
  begin
    insert into public.clients (company_id, name) values (t.id('coA'), 'x');
    perform t.ok(false, 'expired trial: cannot create clients');
  exception when raise_exception then
    perform t.ok(sqlerrm = 'BILLING_INACTIVE', 'expired trial: cannot create clients (BILLING_INACTIVE)'); end;
  begin
    insert into public.documents (company_id, document_type, document_number) values (t.id('coA'), 'invoice', 'EXP-1');
    perform t.ok(false, 'expired trial: cannot create documents');
  exception when raise_exception then perform t.ok(true, 'expired trial: cannot create documents'); end;
  select count(*) into n from public.documents where company_id = t.id('coA');
  perform t.ok(n > 0, 'expired trial: existing documents still readable');
  update public.documents set status = 'sent' where company_id = t.id('coA') and document_type = 'invoice';
  get diagnostics n = row_count;
  perform t.ok(n > 0, 'expired trial: existing invoices can still be updated');
  insert into public.payments (company_id, document_id, amount, payment_method, created_by)
    select t.id('coA'), d.id, 1, 'manual', t.id('userA') from public.documents d
     where d.company_id = t.id('coA') and d.document_type = 'invoice' limit 1;
  perform t.ok(true, 'expired trial: payments can still be recorded (collect existing invoices)');
end $$;

-- ------------------------------------------------- Stripe: active (basic)
update public.company_subscriptions
   set stripe_customer_id = 'cus_test_A', stripe_subscription_id = 'sub_test_A1', stripe_price_id = 'price_basic',
       plan = 'basic', status = 'active',
       current_period_start = now(), current_period_end = now() + interval '1 month'
 where company_id = t.id('coA');
update public.billing_plans set max_clients = 3, max_documents_per_month = 4 where plan = 'basic';
do $$ declare st record; used bigint; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'active' and st.can_write and st.plan = 'basic', 'paid: state active, plan basic');
  perform t.ok(st.current_period_end > now(), 'paid: period end exposed');
  used := st.clients_used;
  -- fill up to the (test) limit of 3 clients
  for i in 1 .. greatest(0, 3 - used) loop
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
-- upgrade to premium (unlimited) through Stripe
update public.company_subscriptions set plan = 'premium', stripe_price_id = 'price_premium'
 where company_id = t.id('coA');
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  insert into public.clients (company_id, name) values (t.id('coA'), 'tras mejorar plan');
  perform t.ok(true, 'upgrade to premium lifts the limit immediately');
end $$;

-- --------------------------------------------- failed payment → past_due
update public.company_subscriptions
   set status = 'past_due', last_payment_failed_at = now(), last_payment_error = 'card_declined'
 where company_id = t.id('coA');
do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'past_due' and st.can_write and st.last_payment_failed_at is not null,
               'failed payment: past_due keeps access while Stripe retries, failure exposed');
end $$;

-- ------------------------------------------- cancel at period end, then end
update public.company_subscriptions
   set status = 'active', last_payment_failed_at = null, last_payment_error = null,
       cancel_at_period_end = true, cancel_at = current_period_end
 where company_id = t.id('coA');
do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'active' and st.can_write and st.cancel_at_period_end,
               'cancellation scheduled: still active until the period ends');
end $$;
update public.company_subscriptions set status = 'canceled', canceled_at = now(), ended_at = now()
 where company_id = t.id('coA');
do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'canceled' and not st.can_write, 'subscription ended: canceled, read-only');
  begin
    insert into public.clients (company_id, name) values (t.id('coA'), 'x');
    perform t.ok(false, 'canceled: cannot create');
  exception when raise_exception then perform t.ok(true, 'canceled: cannot create'); end;
end $$;
update public.company_subscriptions set status = 'unpaid' where company_id = t.id('coA');
do $$ declare st record; begin
  perform t.as_user('userA'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'unpaid' and not st.can_write, 'retries exhausted: unpaid, read-only');
end $$;

-- ------------------------------ incomplete checkout during the app trial
update public.company_subscriptions
   set status = 'incomplete', stripe_subscription_id = 'sub_test_B1', stripe_customer_id = 'cus_test_B'
 where company_id = t.id('coB');
do $$ declare st record; begin
  perform t.as_user('userB'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coB'));
  perform t.ok(st.state = 'trialing' and st.can_write,
               'incomplete checkout while the app trial runs: still trialing');
end $$;
update public.company_subscriptions set app_trial_ends_at = now() - interval '1 second'
 where company_id = t.id('coB');
do $$ declare st record; begin
  perform t.as_user('userB'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coB'));
  perform t.ok(st.state = 'incomplete' and not st.can_write, 'incomplete after the trial: read-only');
end $$;

-- ----------------------------------------- company without a billing row
delete from public.company_subscriptions where company_id = t.id('coB');
do $$ declare st record; begin
  perform t.as_user('userB'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coB'));
  perform t.ok(st.state = 'none' and not st.can_write, 'no billing row (pre-existing company): none, read-only');
end $$;

-- --------------------------------------------- server-side is not limited
insert into public.clients (company_id, name) values (t.id('coB'), 'creado por service role');
do $$ begin perform t.ok(true, 'service context (no user) is not limited by the trigger'); end $$;

-- ------------------------------------------------------- member role
update public.company_subscriptions set status = 'active' where company_id = t.id('coA');
do $$ declare st record; begin
  perform t.as_user('userC'); set local role authenticated;
  select * into st from public.company_billing_state(t.id('coA'));
  perform t.ok(st.state = 'active', 'members can read their company''s billing state');
end $$;

-- restore the catalog limits changed for the test
update public.billing_plans set max_clients = 50, max_documents_per_month = 40 where plan = 'basic';
do $$ begin raise notice 'ALL BILLING TESTS PASSED'; end $$;
