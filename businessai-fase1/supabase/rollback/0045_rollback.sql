-- Rollback of 0045 (snapshot of client and issuer when a document is issued). The snapshots
-- already written stay in documents.metadata.issued: they are history of issued documents.
-- Refuses while an account deletion request is pending (a user is waiting for it).
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.account_deletion_requests') is not null and exists (select 1 from public.account_deletion_requests where status = 'pending') then
    raise exception 'BA0045 rollback: account deletion requests are pending; nothing was changed.';
  end if;
end $$;
drop function if exists public.account_deletion_cancel();
drop function if exists public.account_deletion_request(text);
drop table if exists public.account_deletion_requests;
drop trigger if exists ba_snapshot_document_issue on public.documents;
drop function if exists public.document_issue_snapshot();
drop function if exists ba_private.doc_pick(jsonb, text[]);
do $$ begin
  if to_regclass('public.document_deletion_audit') is not null then
    grant insert, update, delete on public.document_deletion_audit to anon;
    grant update, delete on public.document_deletion_audit to authenticated;
  end if;
end $$;
commit;
