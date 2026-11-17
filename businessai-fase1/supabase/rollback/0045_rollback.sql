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
-- the foreign keys come back only if every recorder still exists (otherwise refuse: never delete records)
do $$ begin
  if exists (select 1 from public.payments p where p.created_by is not null and not exists (select 1 from auth.users u where u.id = p.created_by))
     or exists (select 1 from public.companies c where not exists (select 1 from auth.users u where u.id = c.created_by)) then
    raise exception 'BA0045 rollback: users were deleted after 0045; their records stay without the foreign key. Nothing was changed.';
  end if;
end $$;
alter table public.payments drop constraint if exists payments_created_by_fkey;
alter table public.payments add constraint payments_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.companies drop constraint if exists companies_created_by_fkey;
alter table public.companies add constraint companies_created_by_fkey foreign key (created_by) references auth.users(id) on delete restrict;
drop function if exists public.pos_integrations_active(text, text, bigint, uuid, text);
drop function if exists public.pos_integration_token_update(uuid, text, text, bigint, uuid, text);
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
