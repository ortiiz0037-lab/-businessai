-- Usage limits (0011) test suite. Runs after 10_rls_business.test.sql on a
-- database with 0010 + 0011. Uses its own company (coU) so the counts are
-- exact. Plan changes are written as superuser, as the Stripe webhook
-- (service_role) stores them.
\set ON_ERROR_STOP 1

insert into auth.users (id, email) values ('d0000000-0000-4000-8000-000000000004', 'usage@example.test');
insert into t.ctx values ('userD', 'd0000000-0000-4000-8000-000000000004');
do $$ declare cid uuid; begin
  perform t.as_user('userD'); set local role authenticated;
  cid := public.create_company('Empresa Límites'); reset role;
  insert into t.ctx values ('coU', cid);
end $$;
-- Stripe webhook: active subscription on Basic.
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status)
values (t.id('coU'), 'cus_usage', 'sub_usage', 'basic', 'active');
update public.billing_plans set max_clients = 10, max_documents_per_month = 10, max_members = 2 where plan = 'basic';

create function t.level(metric text) returns text language sql as $$
  select level from public.company_usage(t.id('coU')) u where u.metric = $1
$$;
create function t.used(metric text) returns bigint language sql as $$
  select used from public.company_usage(t.id('coU')) u where u.metric = $1
$$;
grant execute on function t.level(text), t.used(text) to authenticated;

create function t.add_clients(n int) returns void language plpgsql as $$
begin
  for i in 1 .. n loop
    insert into public.clients (company_id, name) values (t.id('coU'), 'Cliente ' || clock_timestamp());
  end loop;
end $$;
create function t.add_docs(n int) returns void language plpgsql as $$
begin
  for i in 1 .. n loop
    insert into public.documents (company_id, document_type, document_number)
    values (t.id('coU'), 'quote', 'U-' || gen_random_uuid());
  end loop;
end $$;
grant execute on function t.add_clients(int), t.add_docs(int) to authenticated;

-- ---------------------------------------------------- shape and isolation
do $$ declare n int; begin
  perform t.as_user('userD'); set local role authenticated;
  perform t.ok((select array_agg(metric order by metric) from public.company_usage(t.id('coU')))
               = array['clients', 'documents', 'members'], 'usage: one row per metric (clients, documents, members)');
  perform t.ok(t.level('clients') = 'ok' and t.used('members') = 1, 'usage: starts at ok; the owner counts as 1 member');
end $$;
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  select count(*) into n from public.company_usage(t.id('coU'));
  perform t.ok(n = 0, 'another company cannot read this usage');
  begin
    perform public.company_usage_window(t.id('coU'));
    perform t.ok(false, 'authenticated cannot call the internal window helper');
  exception when insufficient_privilege then perform t.ok(true, 'authenticated cannot call the internal window helper'); end;
end $$;
do $$ begin
  set local role anon;
  begin
    perform public.company_usage(t.id('coU'));
    perform t.ok(false, 'anon cannot read usage');
  exception when insufficient_privilege then perform t.ok(true, 'anon cannot read usage'); end;
end $$;

-- ------------------------------------------- clients: 80 / 90 / 100 % (limit 10)
do $$ begin
  perform t.as_user('userD'); set local role authenticated;
  perform t.add_clients(7);
  perform t.ok(t.level('clients') = 'ok', 'clients 7/10 (70 %): ok');
  perform t.add_clients(1);
  perform t.ok(t.level('clients') = 'warning', 'clients 8/10 (80 %): first warning');
  perform t.add_clients(1);
  perform t.ok(t.level('clients') = 'upgrade', 'clients 9/10 (90 %): second warning, offer upgrade');
  perform t.add_clients(1);
  perform t.ok(t.level('clients') = 'blocked', 'clients 10/10 (100 %): blocked');
  begin
    perform t.add_clients(1);
    perform t.ok(false, 'clients at 100 %: new client refused');
  exception when raise_exception then
    perform t.ok(sqlerrm = 'PLAN_LIMIT_CLIENTS', 'clients at 100 %: new client refused (PLAN_LIMIT_CLIENTS)'); end;
end $$;
do $$ declare n int; begin
  perform t.ok((select count(*) from public.clients where company_id = t.id('coU')) = 10,
               'at the limit nothing was deleted or added (10 clients)');
  perform t.as_user('userD'); set local role authenticated;
  update public.clients set notes = 'editado al límite' where company_id = t.id('coU'); get diagnostics n = row_count;
  perform t.ok(n = 10, 'at the limit existing clients can still be edited');
end $$;

-- ---------------------------------------- documents: 80 / 90 / 100 % (limit 10)
do $$ begin
  perform t.as_user('userD'); set local role authenticated;
  perform t.add_docs(8);
  perform t.ok(t.level('documents') = 'warning', 'documents 8/10: first warning');
  perform t.add_docs(1);
  perform t.ok(t.level('documents') = 'upgrade', 'documents 9/10: second warning, offer upgrade');
  perform t.add_docs(1);
  perform t.ok(t.level('documents') = 'blocked', 'documents 10/10: blocked');
  begin
    perform t.add_docs(1);
    perform t.ok(false, 'documents at 100 %: new document refused');
  exception when raise_exception then
    perform t.ok(sqlerrm = 'PLAN_LIMIT_DOCUMENTS', 'documents at 100 %: new document refused (PLAN_LIMIT_DOCUMENTS)'); end;
  update public.documents set status = 'sent' where company_id = t.id('coU');
  perform t.ok(true, 'documents at the limit can still change status');
end $$;

-- ------------------------------------------- monthly reset: calendar month
do $$ declare w record; begin
  select * into w from public.company_usage_window(t.id('coU'));
  perform t.ok(w.source = 'calendar_month', 'no Stripe period stored: counts by calendar month (Puerto Rico)');
  perform t.ok(w.resets_at = w.starts_at + interval '1 month', 'calendar window resets on the 1st of next month');
end $$;
-- Last month's documents do not count (simulated by moving test rows back in time).
update public.documents set created_at = date_trunc('month', now()) - interval '3 days'
 where id in (select id from public.documents where company_id = t.id('coU') order by created_at limit 4);
do $$ begin
  perform t.as_user('userD'); set local role authenticated;
  perform t.ok(t.used('documents') = 6, 'documents from last month are not counted (10 → 6)');
  perform t.add_docs(1);
  perform t.ok(true, 'after the reset new documents can be created again');
end $$;

-- ----------------------------------- monthly reset: Stripe billing period
update public.company_subscriptions
   set current_period_start = now() - interval '2 days', current_period_end = now() + interval '28 days'
 where company_id = t.id('coU');
update public.documents set created_at = now() - interval '5 days'
 where company_id = t.id('coU') and created_at >= date_trunc('month', now()) - interval '1 day';
do $$ declare w record; begin
  select * into w from public.company_usage_window(t.id('coU'));
  perform t.ok(w.source = 'billing_period' and w.resets_at > now() + interval '27 days',
               'with a Stripe period: counts in the billing period and resets at renewal');
  perform t.as_user('userD'); set local role authenticated;
  perform t.ok(t.used('documents') = 0, 'documents before the current period start do not count');
end $$;
-- Renewal (webhook stores the new period): the old period's documents stop counting.
do $$ begin
  perform t.as_user('userD'); set local role authenticated;
  perform t.add_docs(3);
  perform t.ok(t.used('documents') = 3, 'documents of the current period count');
end $$;
update public.company_subscriptions
   set current_period_start = now() + interval '1 second' - interval '1 second', current_period_end = now() + interval '30 days'
 where company_id = t.id('coU');
update public.documents set created_at = now() - interval '1 hour' where company_id = t.id('coU') and created_at > now() - interval '1 minute';
do $$ begin
  perform t.as_user('userD'); set local role authenticated;
  perform t.ok(t.used('documents') = 0, 'renewal resets the monthly document counter');
end $$;
do $$ begin
  perform t.ok((select count(*) from public.documents where company_id = t.id('coU')) = 14,
               'resets never delete documents (all 14 still exist)');
end $$;

-- --------------------------------------------------- members (limit 2)
-- No invitation flow exists yet; a future invite (on behalf of the signed-in
-- owner) is simulated with the owner's claims set.
do $$ begin
  perform t.as_user('userD');
  insert into auth.users (id, email) values ('e0000000-0000-4000-8000-000000000005', 'm1@example.test'),
                                            ('f0000000-0000-4000-8000-000000000006', 'm2@example.test');
  insert into public.memberships (company_id, user_id, role) values (t.id('coU'), 'e0000000-0000-4000-8000-000000000005', 'member');
  perform t.ok(true, 'members 2/2: second member allowed');
  begin
    insert into public.memberships (company_id, user_id, role) values (t.id('coU'), 'f0000000-0000-4000-8000-000000000006', 'member');
    perform t.ok(false, 'members at 100 %: third member refused');
  exception when raise_exception then
    perform t.ok(sqlerrm = 'PLAN_LIMIT_MEMBERS', 'members at 100 %: third member refused (PLAN_LIMIT_MEMBERS)'); end;
end $$;
do $$ declare cid uuid; begin
  perform t.as_user('userA'); set local role authenticated;
  cid := public.create_company('Empresa nueva sin plan');
  perform t.ok(exists (select 1 from public.memberships where company_id = cid and role = 'owner'),
               'creating a new company (first member = owner) is never blocked by the member limit');
end $$;

-- -------------------------------- Stripe plan changes update permissions
update public.company_subscriptions set plan = 'premium', stripe_price_id = 'price_premium' where company_id = t.id('coU');
do $$ begin
  perform t.as_user('userD'); set local role authenticated;
  perform t.ok(t.level('clients') = 'unlimited', 'upgrade to Premium (Stripe event): clients unlimited');
  perform t.add_clients(2);
  perform t.ok(true, 'upgrade: new clients allowed immediately');
end $$;
update public.company_subscriptions set plan = 'basic', stripe_price_id = 'price_basic' where company_id = t.id('coU');
do $$ declare n int; begin
  perform t.ok((select count(*) from public.clients where company_id = t.id('coU')) = 12,
               'downgrade to Basic with 12/10 clients: no client deleted');
  perform t.as_user('userD'); set local role authenticated;
  perform t.ok(t.level('clients') = 'blocked'
               and (select percent from public.company_usage(t.id('coU')) where metric = 'clients') = 100,
               'downgrade: above the limit → blocked, percent capped at 100');
  begin
    perform t.add_clients(1);
    perform t.ok(false, 'downgrade above the limit: new clients refused');
  exception when raise_exception then perform t.ok(true, 'downgrade above the limit: new clients refused'); end;
  update public.clients set notes = 'sigue editable' where company_id = t.id('coU'); get diagnostics n = row_count;
  perform t.ok(n = 12, 'downgrade: existing clients still readable and editable');
end $$;

-- ------------------------------------------------ configurable thresholds
update public.billing_plans set max_clients = 20 where plan = 'basic';
update public.billing_config set usage_warning_percent = 50, usage_upgrade_percent = 60;
do $$ begin
  perform t.as_user('userD'); set local role authenticated;
  perform t.ok(t.level('clients') = 'upgrade', 'thresholds are configurable (12/20 = 60 % ≥ 60 → upgrade)');
end $$;
do $$ begin
  begin
    update public.billing_config set usage_warning_percent = 95, usage_upgrade_percent = 90;
    perform t.ok(false, 'warning threshold must be below the upgrade threshold');
  exception when check_violation then perform t.ok(true, 'warning threshold must be below the upgrade threshold'); end;
end $$;

-- restore the catalog and thresholds changed for the test
update public.billing_config set usage_warning_percent = 80, usage_upgrade_percent = 90;
update public.billing_plans set max_clients = 50, max_documents_per_month = 40, max_members = 1 where plan = 'basic';
do $$ begin raise notice 'ALL USAGE TESTS PASSED'; end $$;
