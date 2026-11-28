-- =====================================================================
-- BusinessAI · Migration 0038 · Document Studio: collections and payments
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0037 (and through it 0024, 0025, 0028, 0035).
--
-- Studio documents ABOUT existing finance records, never instead of them
-- (no amount is typed in Studio; nothing is posted; no payment is created):
--   * new kinds: collection_letter (about an issued invoice: balance, days
--     past due, last pending promise, ageing of the client; own number CC-…)
--     and payment_voucher (about a recorded, not voided vendor payment:
--     amount, date, method, reference, the bill and its lines; CP-…).
--   * studio_documents.bill_id / bill_payment_id (same company by FK): a
--     purchase order or a voucher points at the expense; the voucher's
--     payment must belong to that bill. Set only through
--     studio_set_finance_link on drafts, with payables.view.
--   * studio_data adds bill (with its lines), bill_payment, collection and
--     aging (statements and collection letters); the snapshot at issue keeps them.
--   * studio_finance_links(bill / document): the Studio documents linked to an
--     expense or an invoice, for traceability on those pages (RLS of Studio).
-- Visibility of Studio documents does not change; reading the expense data
-- additionally needs payables.view.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regprocedure('public.studio_set_branch(uuid,uuid)') is null or to_regclass('public.bills') is null or to_regprocedure('public.ar_invoice_balances(uuid,date)') is null then
    raise exception 'BA0038 requires 0037 (Studio branches), 0024 (payables) and 0025 (receivables)';
  end if;
end $$;

alter table public.studio_documents drop constraint if exists studio_documents_kind_check;
alter table public.studio_documents add constraint studio_documents_kind_check check (kind in ('letter', 'quote', 'invoice', 'receipt', 'work_order', 'purchase_order', 'contract', 'report', 'account_statement', 'certificate', 'collection_letter', 'payment_voucher'));
alter table public.studio_templates drop constraint if exists studio_templates_kind_check;
alter table public.studio_templates add constraint studio_templates_kind_check check (kind in ('letter', 'quote', 'invoice', 'receipt', 'work_order', 'purchase_order', 'contract', 'report', 'account_statement', 'certificate', 'collection_letter', 'payment_voucher'));

alter table public.studio_documents add column if not exists bill_id uuid;
alter table public.studio_documents add column if not exists bill_payment_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'studio_documents_bill_fk') then
    alter table public.studio_documents add constraint studio_documents_bill_fk foreign key (company_id, bill_id) references public.bills (company_id, id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'studio_documents_bill_payment_fk') then
    alter table public.studio_documents add constraint studio_documents_bill_payment_fk foreign key (company_id, bill_payment_id) references public.bill_payments (company_id, id) on delete restrict;
  end if;
end $$;
create index if not exists studio_documents_bill_idx on public.studio_documents (bill_id) where bill_id is not null;

create or replace function public.studio_check_refs()
returns trigger language plpgsql set search_path = '' as $$
declare dt text;
begin
  if new.client_id is not null and not exists (select 1 from public.clients c where c.id = new.client_id and c.company_id = new.company_id) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'client';
  end if;
  if new.employee_id is not null and not exists (select 1 from public.employees e where e.id = new.employee_id and e.company_id = new.company_id) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'employee';
  end if;
  if new.vendor_id is not null and not exists (select 1 from public.vendors v where v.id = new.vendor_id and v.company_id = new.company_id) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'vendor';
  end if;
  if new.source_document_id is not null then
    select d.document_type into dt from public.documents d where d.id = new.source_document_id and d.company_id = new.company_id;
    if dt is null then raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'document'; end if;
    if (new.kind = 'invoice' and dt <> 'invoice') or (new.kind = 'quote' and dt <> 'quote') or (new.kind = 'receipt' and dt not in ('receipt', 'invoice'))
       or (new.kind = 'collection_letter' and dt <> 'invoice') or new.kind = 'payment_voucher'
       or (new.kind = 'work_order' and dt not in ('work_order', 'quote', 'invoice')) or new.kind in ('purchase_order', 'certificate') then
      raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'document_type';
    end if;
  end if;
  -- 0038: expense links (same company by FK): a bill for purchase orders and vouchers; a payment only on a voucher, of that bill
  if new.bill_id is not null and new.kind not in ('purchase_order', 'payment_voucher') then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'bill';
  end if;
  if new.bill_payment_id is not null and (new.kind <> 'payment_voucher'
     or not exists (select 1 from public.bill_payments p where p.id = new.bill_payment_id and p.bill_id = new.bill_id)) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'bill_payment';
  end if;
  return new;
end $$;
drop trigger if exists ba_studio_refs on public.studio_documents;
create trigger ba_studio_refs before insert or update of client_id, employee_id, vendor_id, source_document_id, kind, bill_id, bill_payment_id on public.studio_documents
  for each row execute function public.studio_check_refs();

-- ---------------------------------------------------------------- content: the two new blocks (the expense, the ageing)
-- Same validator as 0028 plus 'bill' and 'aging'; a superset, so existing rows stay valid.
create or replace function public.studio_valid_content(c jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare b jsonb; t text;
begin
  if c is null or jsonb_typeof(c) <> 'object' or (c ->> 'v') is distinct from '1' or jsonb_typeof(c -> 'blocks') <> 'array' then return false; end if;
  if octet_length(c::text) > 400000 or jsonb_array_length(c -> 'blocks') > 500 then return false; end if;
  for b in select value from jsonb_array_elements(c -> 'blocks') loop
    if jsonb_typeof(b) <> 'object' then return false; end if;
    t := b ->> 'type';
    if t is null or t not in ('heading', 'paragraph', 'table', 'image', 'signature', 'stamp', 'spacer', 'divider', 'pagebreak', 'items', 'totals', 'payments', 'statement', 'fields', 'bill', 'aging') then
      return false;
    end if;
    if octet_length(coalesce(b ->> 'text', '')) > 20000 then return false; end if;
    if t = 'table' and (jsonb_typeof(b -> 'rows') <> 'array' or jsonb_array_length(b -> 'rows') > 200) then return false; end if;
    if t = 'image' and coalesce(b ->> 'asset', '') !~* '^(logo|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then return false; end if;
    -- no markup or links smuggled into text
    if b::text ~* '<\s*/?\s*(script|iframe|object|embed|img|svg|style|link|a|form|input|meta|base)\y|javascript:|vbscript:|data:text/html|\son[a-z]+\s*=' then return false; end if;
  end loop;
  return true;
end $$;

-- ---------------------------------------------------------------- link a draft to an expense (and, for a voucher, one of its payments)
create or replace function public.studio_set_finance_link(doc uuid, bill uuid, payment uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  d public.studio_documents := public.studio_doc_for(doc, 'studio.edit');
  b public.bills;
  v integer;
begin
  if d.status <> 'draft' then raise exception 'STUDIO_LOCKED' using errcode = 'P0001', hint = d.status; end if;
  if d.kind not in ('purchase_order', 'payment_voucher') then raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  if bill is not null then
    if not public.has_permission(d.company_id, 'payables.view') then raise exception 'FORBIDDEN' using errcode = 'P0001', hint = 'reference'; end if;
    select * into b from public.bills x where x.id = bill and x.company_id = d.company_id;
    if b.id is null then raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'bill'; end if;
    if d.kind = 'payment_voucher' and b.status in ('draft', 'pending_approval', 'voided') then raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'bill_status'; end if;
  elsif payment is not null then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'bill_payment';
  end if;
  if payment is not null and exists (select 1 from public.bill_payments p where p.id = payment and p.voided_at is not null) then
    raise exception 'STUDIO_REF_INVALID' using errcode = 'P0001', hint = 'bill_payment_voided';
  end if;
  update public.studio_documents set bill_id = bill, bill_payment_id = payment, vendor_id = coalesce(b.vendor_id, vendor_id),
         version = version + 1, updated_by = (select auth.uid()), updated_at = now()
   where id = d.id returning version into v;
  perform public.studio_log(d.company_id, d.id, 'document', d.id::text, 'finance_linked', jsonb_build_object('bill', bill, 'payment', payment));
  return v;
end $$;

-- ---------------------------------------------------------------- traceability: Studio documents of an expense / an invoice
create or replace function public.studio_finance_links(target uuid, bill uuid, document uuid)
returns table (id uuid, kind text, title text, status text, number text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.kind, s.title, s.status, s.number, s.updated_at from public.studio_documents s
  where s.company_id = target and public.has_permission(target, 'studio.view')
    and ((bill is not null and s.bill_id = bill and public.has_permission(target, 'payables.view'))
         or (document is not null and s.source_document_id = document and public.has_permission(target, 'documents.view')))
  order by s.updated_at desc limit 50
$$;

-- ---------------------------------------------------------------- history: the issued PDF attached to the expense
create or replace function public.studio_record(doc uuid, act text, info jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.studio_documents;
begin
  select * into d from public.studio_documents where id = doc;
  if d.id is null or ((select auth.uid()) is not null and not public.has_permission(d.company_id, 'studio.view')) then raise exception 'STUDIO_NOT_FOUND' using errcode = 'P0001'; end if;
  -- 0038: attached_to_bill
  if act not in ('exported_pdf', 'printed', 'email_prepared', 'attached_to_bill') then raise exception 'STUDIO_ACTION_INVALID' using errcode = 'P0001'; end if;
  if act = 'email_prepared' and d.status <> 'final' then raise exception 'STUDIO_TRANSITION' using errcode = 'P0001', hint = 'email needs an issued document'; end if;
  if act = 'attached_to_bill' and (d.status <> 'final' or d.bill_id is null) then raise exception 'STUDIO_TRANSITION' using errcode = 'P0001', hint = 'attach needs an issued document linked to an expense'; end if;
  perform public.studio_log(d.company_id, d.id, 'document', d.id::text, act, coalesce(info, '{}'::jsonb) - 'body');
end $$;

-- ---------------------------------------------------------------- 0037 functions + finance data and rules
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
  -- 0038: the linked expense (amounts read from Payables, never typed in Studio)
  if d.bill_id is not null then
    if (select auth.uid()) is not null and not public.has_permission(d.company_id, 'payables.view') then
      raise exception 'FORBIDDEN' using errcode = 'P0001', hint = 'reference';
    end if;
    r := r || jsonb_build_object('bill', (select jsonb_build_object('id', b.id, 'vendor_invoice_number', b.vendor_invoice_number, 'description', b.description,
      'bill_date', b.bill_date, 'due_date', b.due_date, 'status', b.status, 'total_cents', b.total_cents, 'paid_cents', b.paid_cents,
      'balance_cents', b.total_cents - b.paid_cents,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('category', c.name, 'category_en', c.name_en, 'description', l.description, 'amount_cents', l.amount_cents) order by l.line_no)
                         from public.bill_lines l left join public.expense_categories c on c.id = l.category_id where l.bill_id = b.id), '[]'::jsonb))
      from public.bills b where b.id = d.bill_id));
    if d.vendor_id is null then
      r := r || jsonb_build_object('vendor', (select jsonb_build_object('name', v.name, 'tax_id', v.tax_id, 'email', v.email, 'phone', v.phone, 'address', v.address)
        from public.vendors v join public.bills b on b.vendor_id = v.id where b.id = d.bill_id));
    end if;
  end if;
  if d.bill_payment_id is not null then
    r := r || jsonb_build_object('bill_payment', (select jsonb_build_object('paid_on', p.paid_on, 'amount_cents', p.amount_cents, 'method', p.method, 'reference', p.reference,
      'voided', p.voided_at is not null) from public.bill_payments p where p.id = d.bill_payment_id));
  end if;
  -- 0038: collection letter: the invoice's balance, days past due, status and the last pending promise
  if d.kind = 'collection_letter' and d.source_document_id is not null then
    r := r || jsonb_build_object('collection', (select jsonb_build_object('balance_cents', b.balance_cents, 'days_past_due', greatest(b.days_past_due, 0), 'due_date', b.due_date,
      'status', b.collection_status, 'number', b.document_number,
      'promise_date', (select pr.promised_date from public.payment_promises pr where pr.document_id = b.document_id and pr.status = 'pending' order by pr.created_at desc limit 1),
      'promise_cents', (select pr.amount_cents from public.payment_promises pr where pr.document_id = b.document_id and pr.status = 'pending' order by pr.created_at desc limit 1))
      from public.ar_invoice_balances(d.company_id, null) b where b.document_id = d.source_document_id));
  end if;
  -- 0038: ageing of the client (statements and collection letters)
  if d.kind in ('account_statement', 'collection_letter') and coalesce(d.client_id, (select x.client_id from public.documents x where x.id = d.source_document_id)) is not null then
    r := r || jsonb_build_object('aging', (select jsonb_build_object(
      'current_cents', coalesce(sum(b.balance_cents) filter (where b.days_past_due <= 0), 0), 'd1_30_cents', coalesce(sum(b.balance_cents) filter (where b.days_past_due between 1 and 30), 0),
      'd31_60_cents', coalesce(sum(b.balance_cents) filter (where b.bucket = '31_60'), 0), 'd61_90_cents', coalesce(sum(b.balance_cents) filter (where b.bucket = '61_90'), 0),
      'd90_plus_cents', coalesce(sum(b.balance_cents) filter (where b.bucket = '90_plus'), 0), 'total_cents', coalesce(sum(b.balance_cents), 0))
      from public.ar_invoice_balances(d.company_id, null) b
      where b.client_id = coalesce(d.client_id, (select x.client_id from public.documents x where x.id = d.source_document_id)) and b.balance_cents > 0));
  end if;
  if d.branch_id is not null then                                         -- 0037: the issuing branch (frozen in the snapshot)
    r := r || jsonb_build_object('branch', (select jsonb_build_object('name', b.name, 'code', b.code, 'address', b.address)
      from public.branches b where b.id = d.branch_id));
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
  bcode text;
begin
  if d.status <> 'draft' then raise exception 'STUDIO_TRANSITION' using errcode = 'P0001', hint = d.status || '->final'; end if;
  if expected_version is distinct from d.version then raise exception 'STUDIO_CONFLICT' using errcode = 'P0001', hint = d.version::text; end if;
  if jsonb_typeof(coalesce(items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(items, '[]'::jsonb)) > 30 then raise exception 'STUDIO_ITEMS_INVALID' using errcode = 'P0001'; end if;
  if d.kind in ('invoice', 'quote', 'receipt') and d.source_document_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001'; end if;
  if d.kind = 'account_statement' and d.client_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001', hint = 'client'; end if;
  if d.kind = 'certificate' and d.employee_id is null and d.client_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001', hint = 'recipient'; end if;
  -- 0038: a collection letter is about an issued invoice; a voucher about a payment that was not voided
  if d.kind = 'collection_letter' and d.source_document_id is null then raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001', hint = 'document'; end if;
  if d.kind = 'payment_voucher' and (d.bill_payment_id is null
     or exists (select 1 from public.bill_payments p where p.id = d.bill_payment_id and p.voided_at is not null)) then
    raise exception 'STUDIO_SOURCE_REQUIRED' using errcode = 'P0001', hint = 'payment';
  end if;
  data := public.studio_data(d.id);
  if d.source_document_id is not null then
    select * into src from public.documents x where x.id = d.source_document_id;
    if src.status = 'draft' and d.kind in ('invoice', 'receipt', 'collection_letter') then raise exception 'STUDIO_SOURCE_DRAFT' using errcode = 'P0001'; end if;
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
  end if;
  if d.source_document_id is null or d.kind = 'collection_letter' then  -- 0038: a collection letter has its own number
    insert into public.studio_counters as c (company_id, kind, year, last_number) values (d.company_id, d.kind, y, 1)
    on conflict (company_id, kind, year) do update set last_number = c.last_number + 1
    returning last_number into n;
    select b.number_formats ->> d.kind into pattern from public.studio_brand b where b.company_id = d.company_id;
    pattern := coalesce(nullif(pattern, ''), upper(case d.kind when 'letter' then 'CAR' when 'work_order' then 'OT' when 'purchase_order' then 'OC' when 'contract' then 'CON'
                 when 'report' then 'INF' when 'account_statement' then 'EC' when 'certificate' then 'CER' when 'collection_letter' then 'CC' when 'payment_voucher' then 'CP' else left(d.kind, 3) end) || '-{YYYY}-{####}');
    num := replace(replace(replace(pattern, '{YYYY}', y::text), '{YY}', right(y::text, 2)), '{####}', lpad(n::text, 4, '0'));
    -- 0037: {SUC} = the branch code (empty without a branch; the separators around it collapse)
    select b.code into bcode from public.branches b where b.id = d.branch_id;
    num := btrim(regexp_replace(replace(num, '{SUC}', coalesce(bcode, '')), '([-/. ])[-/. ]+', '\1', 'g'), '-/. ');
    if num !~ '\d' then num := num || '-' || lpad(n::text, 4, '0'); end if;
  end if;
  update public.studio_documents set status = 'final', number = left(num, 60), finalized_by = (select auth.uid()), finalized_at = now(),
         snapshot = jsonb_build_object('data', data, 'items', coalesce(items, '[]'::jsonb), 'issued_on', public.ba_today(), 'version', d.version)
   where id = d.id;
  perform public.studio_log(d.company_id, d.id, 'document', d.id::text, 'finalized', jsonb_build_object('number', num, 'version', d.version));
  return num;
end $$;

do $$
declare f text;
begin
  foreach f in array array['studio_set_finance_link(uuid, uuid, uuid)', 'studio_finance_links(uuid, uuid, uuid)', 'studio_data(uuid)', 'studio_finalize(uuid, integer, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function public.studio_check_refs() from public, anon, authenticated;

-- ---------------------------------------------------------------- self-check
do $$ begin
  if has_table_privilege('authenticated', 'public.studio_documents', 'UPDATE') or has_table_privilege('authenticated', 'public.studio_documents', 'INSERT') then
    raise exception 'BA0038 self-check failed: studio documents writable directly';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
        and p.proname in ('studio_set_finance_link', 'studio_finance_links') and p.prosecdef and not (p.proconfig @> array['search_path=""'])) > 0 then
    raise exception 'BA0038 self-check failed: definer without search_path';
  end if;
end $$;

commit;
