-- Rollback of 0037 (Document Studio branches). Refuses, changing nothing, while
-- a Studio document has a branch (issued ones keep it in their snapshot; the
-- column would be lost). Restores the 0028 versions of studio_data and
-- studio_finalize verbatim. Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_documents' and column_name = 'branch_id')
     and exists (select 1 from public.studio_documents where branch_id is not null) then
    raise exception 'BA0037 rollback: Studio documents have a branch; nothing was changed.';
  end if;
end $$;
drop function if exists public.studio_set_branch(uuid, uuid);
create or replace function public.studio_data(doc uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  d public.studio_documents;
  r jsonb := '{}'::jsonb;
begin
  select * into d from public.studio_documents where id = doc;
  if d.id is null or ((select auth.uid()) is not null and not public.has_permission(d.company_id, 'studio.view')) then
    raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform public.studio_check_ref_access(d.company_id, d.client_id, d.source_document_id, d.employee_id, d.vendor_id);
  r := jsonb_build_object('company', (
    select jsonb_build_object('name', c.name, 'legal_name', p.legal_name, 'display_name', p.display_name, 'phone', p.phone, 'email', p.email,
                              'address', p.address, 'city', p.city, 'state', p.state, 'postal_code', p.postal_code, 'payment_info', p.payment_info)
    from public.companies c left join public.company_profiles p on p.company_id = c.id where c.id = d.company_id));
  if d.client_id is not null then
    r := r || jsonb_build_object('client', (select jsonb_build_object('name', c.name, 'business_name', c.business_name, 'email', c.email, 'phone', c.phone,
      'address', c.address, 'city', c.city, 'state', c.state, 'postal_code', c.postal_code) from public.clients c where c.id = d.client_id));
  end if;
  if d.source_document_id is not null then
    r := r || jsonb_build_object('document', (select jsonb_build_object('id', x.id, 'type', x.document_type, 'number', x.document_number, 'status', x.status, 'title', x.title,
      'issue_date', x.issue_date, 'due_date', x.due_date, 'subtotal', x.subtotal, 'tax', x.tax, 'total', x.total, 'payment_info', x.payment_info, 'language', x.language,
      'discount', coalesce((x.metadata ->> 'discount')::numeric, 0), 'tax_rate', (x.metadata ->> 'tax_rate')::numeric, 'client_id', x.client_id)
      from public.documents x where x.id = d.source_document_id),
      'payments', coalesce((select jsonb_agg(jsonb_build_object('date', (coalesce(y.paid_at, y.created_at) at time zone 'America/Puerto_Rico')::date, 'amount', y.amount,
                              'method', y.payment_method, 'reference', y.reference) order by coalesce(y.paid_at, y.created_at))
                            from public.payments y where y.document_id = d.source_document_id and y.voided_at is null), '[]'::jsonb));
    if d.client_id is null then
      r := r || jsonb_build_object('client', (select jsonb_build_object('name', c.name, 'business_name', c.business_name, 'email', c.email, 'phone', c.phone,
        'address', c.address, 'city', c.city, 'state', c.state, 'postal_code', c.postal_code)
        from public.clients c join public.documents x on x.client_id = c.id where x.id = d.source_document_id));
    end if;
  end if;
  if d.kind = 'account_statement' and d.client_id is not null then
    r := r || jsonb_build_object('statement', coalesce((select jsonb_agg(jsonb_build_object('number', b.document_number, 'issue_date', b.issue_date, 'due_date', b.due_date,
      'total_cents', b.total_cents, 'paid_cents', b.paid_cents, 'balance_cents', b.balance_cents, 'days_past_due', b.days_past_due) order by b.issue_date)
      from public.ar_invoice_balances(d.company_id, null) b where b.client_id = d.client_id and b.balance_cents > 0), '[]'::jsonb));
  end if;
  if d.employee_id is not null then
    r := r || jsonb_build_object('employee', (select jsonb_build_object('first_name', e.first_name, 'last_name', e.last_name, 'full_name', btrim(e.first_name || ' ' || coalesce(e.last_name, '')),
      'employee_number', e.employee_number, 'position', e.position, 'hire_date', e.hire_date, 'termination_date', e.termination_date, 'status', e.status,
      'department', (select dp.name from public.departments dp where dp.id = e.department_id)) from public.employees e where e.id = d.employee_id));
  end if;
  if d.vendor_id is not null then
    r := r || jsonb_build_object('vendor', (select jsonb_build_object('name', v.name, 'tax_id', v.tax_id, 'email', v.email, 'phone', v.phone, 'address', v.address)
      from public.vendors v where v.id = d.vendor_id));
  end if;
  return r;
end $$;

create or replace function public.studio_finalize(doc uuid, expected_version integer, items jsonb default '[]'::jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  d public.studio_documents := public.studio_doc_for(doc, 'studio.issue');
  src public.documents;
  data jsonb;
  num text;
  y integer := extract(year from public.ba_today())::int;
  n integer;
  pattern text;
  item_sum numeric;
begin
  if d.status <> 'draft' then raise exception 'STUDIO_TRANSITION' using errcode = 'P0001', hint = d.status || '->final'; end if;
  if expected_version is distinct from d.version then raise exception 'STUDIO_CONFLICT' using errcode = 'P0001', hint = d.version::text; end if;
  if jsonb_typeof(coalesce(items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(items, '[]'::jsonb)) > 30 then raise exception 'STUDIO_ITEMS_INVALID' using errcode = 'P0001'; end if;
  if d.kind in ('invoice', 'quote', 'receipt') and d.source_document_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001'; end if;
  if d.kind = 'account_statement' and d.client_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001', hint = 'client'; end if;
  if d.kind = 'certificate' and d.employee_id is null and d.client_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001', hint = 'recipient'; end if;
  data := public.studio_data(d.id);
  if d.source_document_id is not null then
    select * into src from public.documents x where x.id = d.source_document_id;
    if src.status = 'draft' and d.kind in ('invoice', 'receipt') then raise exception 'STUDIO_SOURCE_DRAFT' using errcode = 'P0001'; end if;
    if jsonb_array_length(coalesce(items, '[]'::jsonb)) > 0 then
      if jsonb_typeof(src.items) = 'array' and jsonb_array_length(src.items) > 0 then
        if items <> src.items then raise exception 'STUDIO_ITEMS_INVALID' using errcode = 'P0001', hint = 'differ'; end if;
      else
        select coalesce(sum((x ->> 'amount')::numeric), 0) into item_sum from jsonb_array_elements(items) x;
        if item_sum <> src.subtotal then raise exception 'STUDIO_ITEMS_INVALID' using errcode = 'P0001', hint = 'subtotal'; end if;
      end if;
    elsif jsonb_typeof(src.items) = 'array' and jsonb_array_length(src.items) > 0 then
      items := src.items;
    end if;
    num := src.document_number;                                        -- the business document's own number
  else
    insert into public.studio_counters as c (company_id, kind, year, last_number) values (d.company_id, d.kind, y, 1)
    on conflict (company_id, kind, year) do update set last_number = c.last_number + 1
    returning last_number into n;
    select b.number_formats ->> d.kind into pattern from public.studio_brand b where b.company_id = d.company_id;
    pattern := coalesce(nullif(pattern, ''), upper(case d.kind when 'letter' then 'CAR' when 'work_order' then 'OT' when 'purchase_order' then 'OC' when 'contract' then 'CON'
                 when 'report' then 'INF' when 'account_statement' then 'EC' when 'certificate' then 'CER' else left(d.kind, 3) end) || '-{YYYY}-{####}');
    num := replace(replace(replace(pattern, '{YYYY}', y::text), '{YY}', right(y::text, 2)), '{####}', lpad(n::text, 4, '0'));
    if num !~ '\d' then num := num || '-' || lpad(n::text, 4, '0'); end if;
  end if;
  update public.studio_documents set status = 'final', number = left(num, 60), finalized_by = (select auth.uid()), finalized_at = now(),
         snapshot = jsonb_build_object('data', data, 'items', coalesce(items, '[]'::jsonb), 'issued_on', public.ba_today(), 'version', d.version)
   where id = d.id;
  perform public.studio_log(d.company_id, d.id, 'document', d.id::text, 'finalized', jsonb_build_object('number', num, 'version', d.version));
  return num;
end $$;

alter table public.studio_documents drop constraint if exists studio_documents_branch_fk;
drop index if exists public.studio_documents_branch_idx;
alter table public.studio_documents drop column if exists branch_id;
do $$
declare f text;
begin
  foreach f in array array['studio_data(uuid)', 'studio_finalize(uuid, integer, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
commit;
