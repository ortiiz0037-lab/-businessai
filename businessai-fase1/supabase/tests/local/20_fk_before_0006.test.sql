-- Runs after 10_rls_business.test.sql on a database with 0005 but WITHOUT
-- 0006. Demonstrates the inspected ON DELETE CASCADE hole: deleting an
-- invoice erases its payment even though payments are append-only.
\set ON_ERROR_STOP 1
do $$ declare n int; begin
  perform t.as_user('userA'); set local role authenticated;
  delete from public.documents where id = t.id('docA'); get diagnostics n = row_count;
  perform t.ok(n = 1, 'without 0006: owner deletes an invoice that has a payment');
end $$;
do $$ begin
  perform t.ok(not exists (select 1 from public.payments where id = t.id('payA')),
               'without 0006: the payment was erased by the cascade (hole confirmed)');
end $$;
