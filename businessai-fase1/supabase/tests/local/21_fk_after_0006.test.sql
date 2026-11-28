-- Runs after 10_rls_business.test.sql on a database with 0005 AND 0006.
\set ON_ERROR_STOP 1
do $$ begin
  perform t.ok((select confdeltype from pg_constraint where conname = 'payments_document_id_fkey') = 'a',
               '0006: payments_document_id_fkey is ON DELETE NO ACTION');
end $$;
do $$ begin
  perform t.as_user('userA'); set local role authenticated;
  begin
    delete from public.documents where id = t.id('docA');
    perform t.ok(false, '0006: an invoice with payments cannot be deleted');
  exception when foreign_key_violation then perform t.ok(true, '0006: an invoice with payments cannot be deleted (23503)'); end;
end $$;
do $$ declare n int; begin
  perform t.ok(exists (select 1 from public.payments where id = t.id('payA')), '0006: the payment survives');
  perform t.as_user('userA'); set local role authenticated;
  delete from public.documents where id = t.id('docA2'); get diagnostics n = row_count;
  perform t.ok(n = 1, '0006: a document without payments can still be deleted');
end $$;
-- Deleting a whole company (service level) still cascades through both paths.
do $$ begin
  delete from public.companies where id = t.id('coB');
  perform t.ok(not exists (select 1 from public.payments where company_id = t.id('coB'))
           and not exists (select 1 from public.documents where company_id = t.id('coB')),
               '0006: deleting a company still removes its documents and payments');
end $$;
-- document_deletion_audit references companies ON DELETE RESTRICT (inspected):
-- a company with audit rows cannot be deleted. Reported as a risk, unchanged.
do $$ begin
  begin
    delete from public.companies where id = t.id('coA');
    perform t.ok(false, 'audit FK RESTRICT blocks deleting a company with audit rows');
  exception when foreign_key_violation then
    perform t.ok(true, 'audit FK RESTRICT blocks deleting a company with audit rows (existing behaviour)'); end;
end $$;
do $$ begin raise notice 'ALL FK TESTS PASSED'; end $$;
