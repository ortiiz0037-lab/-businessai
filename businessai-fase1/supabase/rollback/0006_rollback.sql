-- Rollback of 0006: restores the inspected ON DELETE CASCADE on
-- payments_document_id_fkey (deleting a document deletes its payments
-- again). Emergency use only.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.payments
  drop constraint payments_document_id_fkey,
  add constraint payments_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete cascade;
commit;
