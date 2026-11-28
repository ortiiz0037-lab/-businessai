-- =====================================================================
-- BusinessAI · Migration 0006 · Payments survive document deletion
-- =====================================================================
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Separate approval from 0005.
--
-- Problem (from the inspection): payments_document_id_fkey is
--   FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
-- so deleting a document silently deletes every payment recorded against
-- it. Referential actions run as the table owner, so this bypasses RLS and
-- the revoked DELETE privilege from 0005: the payment ledger can still be
-- erased by deleting the invoice.
--
-- Change: ON DELETE NO ACTION. A document that has payments can no longer
-- be deleted (error 23503; the app shows a specific message). Deleting a
-- whole company still works: companies → payments and companies →
-- documents both cascade in the same statement, and NO ACTION is checked
-- at the end of that statement (RESTRICT would not allow it).
--
-- No rows are changed. The constraint is re-created with the same columns;
-- existing rows already satisfy it.
--
-- Side effects to accept before applying:
--   * an invoice with payments can no longer be deleted (also through
--     delete_document_with_audit, which then fails and stores no audit
--     row). Mistaken invoices must be cancelled (status 'cancelled').
--   * the app's delete action shows "tiene pagos registrados".
--
-- Rollback: supabase/rollback/0006_rollback.sql
-- =====================================================================

begin;

-- Re-creating the FK validates it: it locks payments (and briefly
-- documents). Fail fast rather than queue application traffic.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  def text;
begin
  select pg_get_constraintdef(oid) into def
  from pg_constraint
  where conrelid = 'public.payments'::regclass and conname = 'payments_document_id_fkey';

  if def is null then
    raise exception 'BA0006: payments_document_id_fkey not found';
  end if;

  if def ilike '%ON DELETE CASCADE%' then
    alter table public.payments
      drop constraint payments_document_id_fkey,
      add constraint payments_document_id_fkey
        foreign key (document_id) references public.documents(id) on delete no action;
    raise notice 'BA0006: payments_document_id_fkey changed to ON DELETE NO ACTION';
  elsif def ilike '%documents(id)%' and def not ilike '%ON DELETE%' then
    raise notice 'BA0006: already ON DELETE NO ACTION; nothing to do';
  else
    raise exception 'BA0006: unexpected definition, review manually: %', def;
  end if;
end $$;

commit;
