-- =====================================================================
-- BusinessAI · Read-only (OPTIONAL): cross-company relationship check
-- =====================================================================
-- ONE single SELECT. Returns only COUNTS (no rows, no ids, no names) of
-- existing records whose relationships mix companies — something the
-- current policies allow and 0005 prevents from now on, but does not fix
-- retroactively. All zeros = nothing to clean up.
--
-- Run in: Supabase Dashboard → SQL Editor → paste → Run.
-- =====================================================================

select
  (select count(*) from public.documents d
     join public.clients c on c.id = d.client_id
    where c.company_id <> d.company_id)               as documents_with_client_of_other_company,
  (select count(*) from public.payments p
     join public.documents d on d.id = p.document_id
    where d.company_id <> p.company_id)               as payments_with_document_of_other_company,
  (select count(*) from public.payments p
    where p.created_by is null)                       as payments_without_created_by,
  (select count(*) from public.payments p
    where p.created_by is not null
      and not exists (select 1 from public.memberships m
                      where m.user_id = p.created_by
                        and m.company_id = p.company_id)) as payments_by_non_member,
  (select count(*) from public.documents d
    where d.document_type = 'invoice' and d.status = 'paid'
      and not exists (select 1 from public.payments p
                      where p.document_id = d.id))    as paid_invoices_without_payment,
  (select count(*) from public.documents d
    where exists (select 1 from public.payments p
                  where p.document_id = d.id))        as documents_with_payments;
