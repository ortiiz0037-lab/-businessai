-- =====================================================================
-- BusinessAI · Migration 0033 · Workforce / HR completion
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0020, 0021 and 0022.
--
-- Builds on the existing module (0020 employees, clock, corrections, leave,
-- shifts, history; 0021 kiosk PIN; 0022 rule groups, jurisdictions, meal
-- alerts). Nothing is duplicated: punches stay the only source of hours and
-- employees the only source of people.
--
--  1. Employees: suspended status, archive (only inactive / terminated; the
--     history stays), employment type, classification (exempt / non-exempt),
--     direct supervisor (an active member: sees and approves only that team),
--     status reason, and a change log with old → new values for the
--     non-sensitive fields. Private contact data (address, emergency contact)
--     in its own table: the company's managers and the employee only.
--  2. Private labour documents: metadata + private bucket HR-documents
--     (<company>/<employee>/<file>). Managers only; the employee sees a
--     document only when it is shared with them. Never deleted: archived.
--  3. Schedules: recurring patterns that generate concrete shifts
--     (idempotent, skip conflicts and approved leave), change / drop requests
--     with approval (never self-approved), a per-employee lock that makes the
--     no-overlap rule safe under concurrency, conflicts report.
--  4. Overnight attribution: 'start_day' (default) or 'split_midnight'.
--  5. Rules: per-employee exceptions, an append-only version history of
--     every rule change (company, group, employee), and explicit
--     propose → apply of changes (stale proposals are refused). Template
--     values are REFERENCES whose current validity BusinessAI has not verified.
--  6. Meal / break alerts: the action taken when handling one; a sweep
--     function for a scheduler (pg_cron) — NOT scheduled by this migration.
--  7. Leave: bereavement, jury duty, parental and military types.
--  8. Missing punches: forgotten clock-outs and shifts without a clock-in.
--
-- Rollback: supabase/rollback/0033_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$ begin
  if to_regclass('public.meal_alerts') is null or to_regclass('public.time_clock_kiosks') is null
     or to_regprocedure('public.storage_company_id(text)') is null then
    raise exception 'BA0033: migrations 0007, 0020, 0021 and 0022 must be applied first';
  end if;
end $$;

-- ===================================================================== 1. employees
alter table public.employees drop constraint if exists employees_status_check;
alter table public.employees add constraint employees_status_check check (status in ('active', 'suspended', 'inactive', 'terminated'));
alter table public.employees add column if not exists employment_type text not null default 'full_time'
  check (employment_type in ('full_time', 'part_time', 'temporary', 'seasonal', 'contractor', 'intern'));
alter table public.employees add column if not exists classification text not null default 'non_exempt'
  check (classification in ('non_exempt', 'exempt'));
alter table public.employees add column if not exists supervisor_user_id uuid references auth.users(id) on delete set null;
alter table public.employees add column if not exists status_reason text check (status_reason is null or char_length(status_reason) <= 300);
alter table public.employees add column if not exists archived_at timestamptz;
alter table public.employees add column if not exists archived_by uuid;
alter table public.employees drop constraint if exists employees_archive_check;
alter table public.employees add constraint employees_archive_check check (archived_at is null or status in ('inactive', 'terminated'));
create index if not exists employees_supervisor_idx on public.employees (supervisor_user_id) where supervisor_user_id is not null;

grant select (employment_type, classification, supervisor_user_id, status_reason, archived_at) on public.employees to authenticated;
grant insert (employment_type, classification, supervisor_user_id, status_reason) on public.employees to authenticated;
grant update (employment_type, classification, supervisor_user_id, status_reason) on public.employees to authenticated;

-- Manager of the company, supervisor of the employee's department, or the
-- employee's DIRECT supervisor (an active member of the company).
create or replace function public.wf_supervises(emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.employees e
    where e.id = emp
      and (public.has_permission(e.company_id, 'workforce.manage')
           or (public.is_company_member(e.company_id) and (
                 (e.department_id is not null and exists (
                    select 1 from public.department_supervisors s
                    where s.department_id = e.department_id and s.user_id = (select auth.uid())))
                 or (e.supervisor_user_id is not null and e.supervisor_user_id = (select auth.uid()))))))
$$;

-- Read policy: the manager test on the row's own company first. Found by the
-- Workforce browser test: with only wf_supervises(id), a manager's INSERT ...
-- RETURNING (creating an employee from the app) was refused, because the new
-- row is not yet visible to the lookup by id. Same people see the same rows.
drop policy if exists ba_employees_select on public.employees;
create policy ba_employees_select on public.employees for select to authenticated
  using (public.wf_manages(company_id) or public.wf_supervises(id) or user_id = (select auth.uid()));

-- The direct supervisor must be an active member and not the employee itself.
create or replace function public.wf_employee_hr_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.supervisor_user_id is not null and (tg_op = 'INSERT' or new.supervisor_user_id is distinct from old.supervisor_user_id) then
    if new.supervisor_user_id = new.user_id
       or not exists (select 1 from public.memberships m where m.company_id = new.company_id and m.user_id = new.supervisor_user_id and m.status = 'active') then
      raise exception 'SUPERVISOR_INVALID' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.user_id is not null and new.user_id = new.supervisor_user_id then
    raise exception 'SUPERVISOR_INVALID' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.archived_at is not null and new.archived_at is not null and new.status <> old.status then
    raise exception 'EMPLOYEE_ARCHIVED' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_wf_employee_hr_guard on public.employees;
create trigger ba_wf_employee_hr_guard before insert or update on public.employees
  for each row execute function public.wf_employee_hr_guard();

-- Status changes with a reason (suspend, reactivate, deactivate, terminate).
create or replace function public.set_employee_status(emp uuid, new_status text, reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.employees;
begin
  select * into e from public.employees where id = emp for update;
  if not found or not public.wf_manages(e.company_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if new_status not in ('active', 'suspended', 'inactive', 'terminated') then
    raise exception 'EMPLOYEE_STATUS_INVALID' using errcode = 'P0001';
  end if;
  if e.archived_at is not null then
    raise exception 'EMPLOYEE_ARCHIVED' using errcode = 'P0001';
  end if;
  if new_status in ('suspended', 'terminated') and char_length(btrim(coalesce(reason, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  if e.status = new_status then return; end if;
  -- the plan limit is checked by wf_employee_guard when the employee becomes active again
  update public.employees set status = new_status, status_reason = nullif(left(btrim(coalesce(reason, '')), 300), '') where id = emp;
end $$;

-- Archive (hide from day-to-day lists) only an inactive or terminated
-- employee; everything recorded stays. Unarchive brings it back as is.
create or replace function public.archive_employee(emp uuid, archive boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.employees;
begin
  select * into e from public.employees where id = emp for update;
  if not found or not public.wf_manages(e.company_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if archive then
    if e.status not in ('inactive', 'terminated') then
      raise exception 'EMPLOYEE_ACTIVE' using errcode = 'P0001';
    end if;
    if e.archived_at is null then
      update public.employees set archived_at = now(), archived_by = (select auth.uid()) where id = emp;
    end if;
  elsif e.archived_at is not null then
    update public.employees set archived_at = null, archived_by = null where id = emp;
  end if;
end $$;

-- Private contact data: the company's managers and the employee only (not supervisors).
create table if not exists public.employee_contacts (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  address text check (address is null or char_length(address) <= 300),
  emergency_contact_name text check (emergency_contact_name is null or char_length(emergency_contact_name) <= 120),
  emergency_contact_phone text check (emergency_contact_phone is null or char_length(emergency_contact_phone) <= 40),
  emergency_contact_relation text check (emergency_contact_relation is null or char_length(emergency_contact_relation) <= 60),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.employee_contacts enable row level security;
revoke all on public.employee_contacts from public, anon, authenticated;
grant all on public.employee_contacts to service_role;
grant select on public.employee_contacts to authenticated;
grant insert (employee_id, company_id, address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation) on public.employee_contacts to authenticated;
grant update (address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation) on public.employee_contacts to authenticated;
drop policy if exists ba_emp_contacts_select on public.employee_contacts;
create policy ba_emp_contacts_select on public.employee_contacts for select to authenticated
  using (public.wf_manages(company_id) or public.wf_is_self(employee_id));
drop policy if exists ba_emp_contacts_insert on public.employee_contacts;
create policy ba_emp_contacts_insert on public.employee_contacts for insert to authenticated
  with check ((public.wf_manages(company_id) or public.wf_is_self(employee_id))
              and exists (select 1 from public.employees e where e.id = employee_id and e.company_id = employee_contacts.company_id));
drop policy if exists ba_emp_contacts_update on public.employee_contacts;
create policy ba_emp_contacts_update on public.employee_contacts for update to authenticated
  using (public.wf_manages(company_id) or public.wf_is_self(employee_id))
  with check (public.wf_manages(company_id) or public.wf_is_self(employee_id));
drop trigger if exists ba_company_immutable on public.employee_contacts;
create trigger ba_company_immutable before update on public.employee_contacts for each row execute function public.forbid_company_change();

create or replace function public.wf_contact_stamp()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_by := (select auth.uid());
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ba_wf_contact_stamp on public.employee_contacts;
create trigger ba_wf_contact_stamp before insert or update on public.employee_contacts for each row execute function public.wf_contact_stamp();

-- ===================================================================== 2. private labour documents
create table if not exists public.employee_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  category text not null check (category in ('contract', 'policy', 'evaluation', 'certification', 'training', 'other')),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  storage_path text not null unique check (char_length(storage_path) <= 400),
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  visible_to_employee boolean not null default false,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid
);
create index if not exists employee_documents_emp_idx on public.employee_documents (employee_id, created_at desc);
alter table public.employee_documents enable row level security;
revoke all on public.employee_documents from public, anon, authenticated;
grant all on public.employee_documents to service_role;
grant select on public.employee_documents to authenticated;
grant insert (company_id, employee_id, category, title, storage_path, file_name, content_type, size_bytes, visible_to_employee)
  on public.employee_documents to authenticated;
drop policy if exists ba_emp_docs_select on public.employee_documents;
create policy ba_emp_docs_select on public.employee_documents for select to authenticated
  using (public.wf_manages(company_id) or (visible_to_employee and archived_at is null and public.wf_is_self(employee_id)));
drop policy if exists ba_emp_docs_insert on public.employee_documents;
create policy ba_emp_docs_insert on public.employee_documents for insert to authenticated
  with check (public.wf_manages(company_id)
              and exists (select 1 from public.employees e where e.id = employee_id and e.company_id = employee_documents.company_id));

-- <company>/<employee>/<file>: the employee must belong to that company.
create or replace function public.hr_object_employee(object_name text)
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id from public.employees e
  where array_length(string_to_array(object_name, '/'), 1) = 3
    and (string_to_array(object_name, '/'))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and e.id = ((string_to_array(object_name, '/'))[2])::uuid
    and e.company_id = public.storage_company_id(object_name)
$$;

-- Evidence: never deleted (only with the whole company); archived instead.
create or replace function public.wf_document_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.wf_company_gone(old.company_id) then return old; end if;
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = 'employee_documents';
  end if;
  if tg_op = 'INSERT' then
    if public.hr_object_employee(new.storage_path) is distinct from new.employee_id
       or public.storage_company_id(new.storage_path) is distinct from new.company_id then
      raise exception 'DOCUMENT_PATH_INVALID' using errcode = 'P0001';
    end if;
    if (select auth.uid()) is not null and not exists (
         select 1 from storage.objects o where o.bucket_id = 'HR-documents' and o.name = new.storage_path) then
      raise exception 'DOCUMENT_FILE_MISSING' using errcode = 'P0001';
    end if;
    new.uploaded_by := (select auth.uid());
    new.created_at := now();
    new.archived_at := null;
    new.archived_by := null;
    perform public.wf_log(new.company_id, new.employee_id, 'employee_documents', new.id::text, 'document_added',
                          jsonb_build_object('category', new.category, 'title', new.title, 'shared', new.visible_to_employee));
    return new;
  end if;
  -- UPDATE (only through set_employee_document): sharing and archiving
  if (to_jsonb(new) - array['visible_to_employee', 'archived_at', 'archived_by']) <> (to_jsonb(old) - array['visible_to_employee', 'archived_at', 'archived_by'])
     or (old.archived_at is not null and new.archived_at is distinct from old.archived_at) then
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = 'employee_documents';
  end if;
  return new;
end $$;
drop trigger if exists ba_wf_document_guard on public.employee_documents;
create trigger ba_wf_document_guard before insert or update or delete on public.employee_documents
  for each row execute function public.wf_document_guard();

create or replace function public.set_employee_document(doc uuid, shared boolean, archive boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.employee_documents;
begin
  select * into d from public.employee_documents where id = doc for update;
  if not found or not public.wf_manages(d.company_id) then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if d.archived_at is not null then
    raise exception 'DOCUMENT_ARCHIVED' using errcode = 'P0001';
  end if;
  update public.employee_documents set visible_to_employee = coalesce(shared, d.visible_to_employee),
         archived_at = case when archive then now() end, archived_by = case when archive then (select auth.uid()) end
   where id = doc;
  perform public.wf_log(d.company_id, d.employee_id, 'employee_documents', d.id::text, case when archive then 'document_archived' else 'document_updated' end,
                        jsonb_build_object('shared', coalesce(shared, d.visible_to_employee)));
end $$;

do $$
declare b record;
begin
  select * into b from storage.buckets where id = 'HR-documents';
  if not found then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('HR-documents', 'HR-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  elsif b.public then
    raise exception 'BA0033: bucket HR-documents exists but is PUBLIC; make it private first';
  else
    update storage.buckets set file_size_limit = 10485760, allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
     where id = 'HR-documents';
  end if;
end $$;

drop policy if exists ba_hr_documents_select on storage.objects;
drop policy if exists ba_hr_documents_insert on storage.objects;
drop policy if exists ba_hr_documents_delete on storage.objects;
create policy ba_hr_documents_select on storage.objects for select to authenticated
  using (bucket_id = 'HR-documents' and (
           public.wf_manages(public.storage_company_id(name))
           or exists (select 1 from public.employee_documents d where d.storage_path = name and d.visible_to_employee
                        and d.archived_at is null and public.wf_is_self(d.employee_id))));
create policy ba_hr_documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'HR-documents' and public.wf_manages(public.storage_company_id(name)) and public.hr_object_employee(name) is not null);
-- only a file whose registration failed (never a registered document)
create policy ba_hr_documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'HR-documents' and public.wf_manages(public.storage_company_id(name))
         and not exists (select 1 from public.employee_documents d where d.storage_path = name));

-- ===================================================================== 3. schedules
create table if not exists public.shift_patterns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  name text check (name is null or char_length(name) <= 80),
  weekdays smallint[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  start_time time not null,
  end_time time not null,
  break_minutes smallint not null default 0 check (break_minutes between 0 and 480),
  starts_on date not null,
  ends_on date,
  status text not null default 'active' check (status in ('active', 'ended')),
  notes text check (notes is null or char_length(notes) <= 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_time <> end_time),
  check (ends_on is null or ends_on >= starts_on)
);
create index if not exists shift_patterns_emp_idx on public.shift_patterns (employee_id, status);
alter table public.shift_patterns enable row level security;
revoke all on public.shift_patterns from public, anon, authenticated;
grant all on public.shift_patterns to service_role;
grant select on public.shift_patterns to authenticated;
grant insert (company_id, employee_id, name, weekdays, start_time, end_time, break_minutes, starts_on, ends_on, notes) on public.shift_patterns to authenticated;
grant update (name, weekdays, start_time, end_time, break_minutes, starts_on, ends_on, status, notes) on public.shift_patterns to authenticated;
drop policy if exists ba_patterns_select on public.shift_patterns;
create policy ba_patterns_select on public.shift_patterns for select to authenticated
  using (public.wf_supervises(employee_id) or public.wf_is_self(employee_id));
drop policy if exists ba_patterns_insert on public.shift_patterns;
create policy ba_patterns_insert on public.shift_patterns for insert to authenticated
  with check (public.wf_supervises(employee_id)
              and exists (select 1 from public.employees e where e.id = employee_id and e.company_id = shift_patterns.company_id));
drop policy if exists ba_patterns_update on public.shift_patterns;
create policy ba_patterns_update on public.shift_patterns for update to authenticated
  using (public.wf_supervises(employee_id)) with check (public.wf_supervises(employee_id));
drop trigger if exists ba_company_immutable on public.shift_patterns;
create trigger ba_company_immutable before update on public.shift_patterns for each row execute function public.forbid_company_change();

create or replace function public.wf_pattern_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.employee_id <> old.employee_id then
    raise exception 'PATTERN_EMPLOYEE_LOCKED' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.status = 'ended' then
    raise exception 'PATTERN_ENDED' using errcode = 'P0001';
  end if;
  -- the break must fit in the shift (an end at or before the start is the next day)
  if new.break_minutes * interval '1 minute' >= ((new.end_time - new.start_time) + case when new.end_time <= new.start_time then interval '24 hours' else interval '0' end) then
    raise exception 'PATTERN_INVALID' using errcode = 'P0001';
  end if;
  new.weekdays := (select array_agg(distinct d order by d) from unnest(new.weekdays) d);
  if tg_op = 'INSERT' then new.created_by := (select auth.uid()); new.created_at := now(); end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ba_wf_pattern_guard on public.shift_patterns;
create trigger ba_wf_pattern_guard before insert or update on public.shift_patterns for each row execute function public.wf_pattern_guard();

alter table public.work_shifts add column if not exists pattern_id uuid references public.shift_patterns(id) on delete set null;
alter table public.work_shifts add column if not exists updated_at timestamptz;
alter table public.work_shifts add column if not exists updated_by uuid;
create unique index if not exists work_shifts_pattern_uidx on public.work_shifts (pattern_id, starts_at) where pattern_id is not null;

-- Shifts: no overlap per employee — now under a per-employee lock, so two
-- concurrent writes cannot both pass the check; a pattern of the same employee; who changed.
create or replace function public.wf_shift_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'DELETE' then
    perform pg_advisory_xact_lock(hashtextextended('ba_shift:' || new.employee_id::text, 0));
    if exists (select 1 from public.work_shifts s where s.employee_id = new.employee_id and s.id <> new.id
                 and s.starts_at < new.ends_at and new.starts_at < s.ends_at) then
      raise exception 'SHIFT_OVERLAP' using errcode = 'P0001';
    end if;
    if new.pattern_id is not null and (tg_op = 'INSERT' or new.pattern_id is distinct from old.pattern_id)
       and not exists (select 1 from public.shift_patterns p where p.id = new.pattern_id and p.employee_id = new.employee_id) then
      raise exception 'PATTERN_INVALID' using errcode = 'P0001';
    end if;
    if tg_op = 'INSERT' then new.created_by := (select auth.uid());
    else new.updated_at := now(); new.updated_by := (select auth.uid()); end if;
  end if;
  return coalesce(new, old);
end $$;

-- Company time zone (default Puerto Rico).
create or replace function public.wf_timezone(target uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select w.timezone from public.workforce_settings w where w.company_id = target), 'America/Puerto_Rico')
$$;

-- Concrete shifts from a pattern for [from_day, to_day] (at most 93 days).
-- Idempotent; days with another shift or an approved full-day leave are skipped and counted.
create or replace function public.generate_pattern_shifts(pattern uuid, from_day date, to_day date)
returns table (created integer, skipped_conflict integer, skipped_leave integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  p public.shift_patterns;
  e public.employees;
  tz text;
  d date;
  s timestamptz;
  f timestamptz;
  n_created integer := 0; n_conflict integer := 0; n_leave integer := 0;
  new_id uuid;
begin
  select * into p from public.shift_patterns where id = pattern for update;
  if not found or not public.wf_supervises(p.employee_id) then
    raise exception 'PATTERN_NOT_FOUND' using errcode = 'P0001';
  end if;
  if p.status <> 'active' then
    raise exception 'PATTERN_ENDED' using errcode = 'P0001';
  end if;
  select * into e from public.employees where id = p.employee_id;
  if e.status <> 'active' then
    raise exception 'EMPLOYEE_INACTIVE' using errcode = 'P0001';
  end if;
  if from_day is null or to_day is null or to_day < from_day or to_day - from_day > 92 then
    raise exception 'RANGE_INVALID' using errcode = 'P0001';
  end if;
  tz := public.wf_timezone(p.company_id);
  perform pg_advisory_xact_lock(hashtextextended('ba_shift:' || p.employee_id::text, 0));
  for d in select g::date from generate_series(greatest(from_day, p.starts_on), least(to_day, coalesce(p.ends_on, to_day)), interval '1 day') g loop
    continue when not (extract(dow from d)::smallint = any (p.weekdays));
    s := (d + p.start_time) at time zone tz;
    f := ((d + case when p.end_time <= p.start_time then 1 else 0 end) + p.end_time) at time zone tz;
    if exists (select 1 from public.work_shifts w where w.pattern_id = p.id and w.starts_at = s) then
      continue;   -- already generated
    end if;
    if exists (select 1 from public.leave_requests l where l.employee_id = p.employee_id and l.status = 'approved'
                 and l.partial_minutes is null and l.starts_on <= d and d <= l.ends_on) then
      n_leave := n_leave + 1; continue;
    end if;
    if exists (select 1 from public.work_shifts w where w.employee_id = p.employee_id and w.starts_at < f and s < w.ends_at) then
      n_conflict := n_conflict + 1; continue;
    end if;
    insert into public.work_shifts (company_id, employee_id, starts_at, ends_at, break_minutes, notes, pattern_id)
    values (p.company_id, p.employee_id, s, f, p.break_minutes, p.name, p.id)
    on conflict do nothing
    returning id into new_id;
    if new_id is not null then n_created := n_created + 1; new_id := null; end if;
  end loop;
  perform public.wf_log(p.company_id, p.employee_id, 'shift_patterns', p.id::text, 'generated',
                        jsonb_build_object('from', from_day, 'to', to_day, 'created', n_created, 'skipped_conflict', n_conflict, 'skipped_leave', n_leave));
  created := n_created; skipped_conflict := n_conflict; skipped_leave := n_leave;
  return next;
end $$;

-- Change or drop requests for a shift, approved by a supervisor (never by the employee).
create table if not exists public.shift_change_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  shift_id uuid references public.work_shifts(id) on delete set null,
  kind text not null check (kind in ('change', 'drop')),
  old_starts_at timestamptz not null,
  old_ends_at timestamptz not null,
  new_starts_at timestamptz,
  new_ends_at timestamptz,
  new_break_minutes smallint check (new_break_minutes is null or new_break_minutes between 0 and 480),
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 300),
  check ((kind = 'drop' and new_starts_at is null and new_ends_at is null)
      or (kind = 'change' and new_starts_at is not null and new_ends_at is not null and new_ends_at > new_starts_at
          and new_ends_at - new_starts_at <= interval '24 hours'))
);
create unique index if not exists shift_change_pending_uidx on public.shift_change_requests (shift_id) where status = 'pending';
create index if not exists shift_change_company_idx on public.shift_change_requests (company_id, status, requested_at desc);
alter table public.shift_change_requests enable row level security;
revoke all on public.shift_change_requests from public, anon, authenticated;
grant all on public.shift_change_requests to service_role;
grant select on public.shift_change_requests to authenticated;
drop policy if exists ba_shift_changes_select on public.shift_change_requests;
create policy ba_shift_changes_select on public.shift_change_requests for select to authenticated
  using (public.wf_supervises(employee_id) or public.wf_is_self(employee_id));

create or replace function public.wf_request_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.wf_company_gone(old.company_id) then return old; end if;
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  -- the shift link may be cleared when the shift is dropped; a decision is final
  if old.status <> 'pending'
     or (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_note', 'shift_id'])
        <> (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_note', 'shift_id']) then
    if not (old.status <> 'pending' and to_jsonb(new) - 'shift_id' = to_jsonb(old) - 'shift_id' and new.shift_id is null) then
      raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ba_wf_request_guard on public.shift_change_requests;
create trigger ba_wf_request_guard before update or delete on public.shift_change_requests for each row execute function public.wf_request_guard();

create or replace function public.request_shift_change(shift uuid, change_kind text, new_start timestamptz, new_end timestamptz,
                                                       new_break integer, why text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  s public.work_shifts;
  rid uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into s from public.work_shifts where id = shift;
  if not found or not (public.wf_is_self(s.employee_id) or public.wf_supervises(s.employee_id)) then
    raise exception 'SHIFT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if change_kind not in ('change', 'drop') then
    raise exception 'SHIFT_CHANGE_INVALID' using errcode = 'P0001';
  end if;
  if s.starts_at <= now() then
    raise exception 'SHIFT_STARTED' using errcode = 'P0001';
  end if;
  if change_kind = 'change' and (new_start is null or new_end is null or new_end <= new_start or new_end - new_start > interval '24 hours'
                                 or new_start <= now() or (new_break is not null and new_break not between 0 and 480)) then
    raise exception 'SHIFT_CHANGE_INVALID' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(why, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  begin
    insert into public.shift_change_requests (company_id, employee_id, shift_id, kind, old_starts_at, old_ends_at, new_starts_at, new_ends_at,
                                              new_break_minutes, reason, requested_by)
    values (s.company_id, s.employee_id, s.id, change_kind, s.starts_at, s.ends_at,
            case when change_kind = 'change' then new_start end, case when change_kind = 'change' then new_end end,
            case when change_kind = 'change' then coalesce(new_break, s.break_minutes) end, left(btrim(why), 300), (select auth.uid()))
    returning id into rid;
  exception when unique_violation then
    raise exception 'SHIFT_CHANGE_PENDING' using errcode = 'P0001';
  end;
  perform public.wf_log(s.company_id, s.employee_id, 'shift_change_requests', rid::text, 'requested', jsonb_build_object('kind', change_kind));
  return rid;
end $$;

create or replace function public.decide_shift_change(request uuid, approve boolean, note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.shift_change_requests;
  s public.work_shifts;
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into r from public.shift_change_requests where id = request for update;
  if not found or not public.wf_supervises(r.employee_id) then
    raise exception 'SHIFT_CHANGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if public.wf_is_self(r.employee_id) then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then
    raise exception 'SHIFT_CHANGE_NOT_PENDING' using errcode = 'P0001';
  end if;
  if approve then
    select * into s from public.work_shifts where id = r.shift_id for update;
    if not found then
      raise exception 'SHIFT_NOT_FOUND' using errcode = 'P0001';
    end if;
    if s.starts_at <> r.old_starts_at or s.ends_at <> r.old_ends_at then
      raise exception 'SHIFT_CHANGED' using errcode = 'P0001';   -- the shift changed after the request: decide again
    end if;
    if r.kind = 'change' then
      update public.work_shifts set starts_at = r.new_starts_at, ends_at = r.new_ends_at, break_minutes = r.new_break_minutes where id = s.id;
    else
      delete from public.work_shifts where id = s.id;
    end if;
  end if;
  update public.shift_change_requests set status = case when approve then 'approved' else 'rejected' end, decided_by = uid, decided_at = now(),
         decision_note = nullif(left(btrim(coalesce(note, '')), 300), '')
   where id = r.id;
  perform public.wf_log(r.company_id, r.employee_id, 'shift_change_requests', r.id::text, case when approve then 'approved' else 'rejected' end,
                        jsonb_build_object('kind', r.kind));
end $$;

create or replace function public.cancel_shift_change(request uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.shift_change_requests;
begin
  select * into r from public.shift_change_requests where id = request for update;
  if not found or not (r.requested_by = (select auth.uid()) or public.wf_supervises(r.employee_id)) then
    raise exception 'SHIFT_CHANGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then
    raise exception 'SHIFT_CHANGE_NOT_PENDING' using errcode = 'P0001';
  end if;
  update public.shift_change_requests set status = 'cancelled', decided_by = (select auth.uid()), decided_at = now() where id = r.id;
  perform public.wf_log(r.company_id, r.employee_id, 'shift_change_requests', r.id::text, 'cancelled', '{}');
end $$;

-- ===================================================================== 4. overnight attribution
alter table public.workforce_settings add column if not exists overnight_attribution text not null default 'start_day'
  check (overnight_attribution in ('start_day', 'split_midnight'));

-- ===================================================================== 5. rules: exceptions, versions, explicit changes
alter table public.labor_jurisdictions add column if not exists verification_status text not null default 'unverified'
  check (verification_status in ('unverified', 'verified'));
alter table public.labor_jurisdictions add column if not exists verified_on date;
update public.labor_jurisdictions set verification_status = 'unverified', verified_on = null where verified_on is null;

create table if not exists public.employee_rule_overrides (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(overrides) = 'object'),
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.employee_rule_overrides enable row level security;
revoke all on public.employee_rule_overrides from public, anon, authenticated;
grant all on public.employee_rule_overrides to service_role;
grant select on public.employee_rule_overrides to authenticated;
drop policy if exists ba_rule_overrides_select on public.employee_rule_overrides;
create policy ba_rule_overrides_select on public.employee_rule_overrides for select to authenticated
  using (public.wf_supervises(employee_id) or public.wf_is_self(employee_id));

create table if not exists public.labor_rule_versions (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  scope text not null check (scope in ('company', 'rule_set', 'employee')),
  scope_id uuid not null,
  version integer not null check (version >= 1),
  rule_values jsonb not null,
  change_id uuid,
  actor uuid,
  created_at timestamptz not null default now(),
  unique (scope, scope_id, version)
);
create index if not exists labor_rule_versions_company_idx on public.labor_rule_versions (company_id, created_at desc);
alter table public.labor_rule_versions enable row level security;
revoke all on public.labor_rule_versions from public, anon, authenticated;
grant all on public.labor_rule_versions to service_role;
grant select on public.labor_rule_versions to authenticated;
drop policy if exists ba_rule_versions_select on public.labor_rule_versions;
create policy ba_rule_versions_select on public.labor_rule_versions for select to authenticated
  using (public.wf_manages(company_id) or (scope = 'employee' and public.wf_supervises(scope_id)));

create table if not exists public.labor_rule_changes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  scope text not null check (scope in ('company', 'rule_set', 'employee')),
  scope_id uuid not null,
  changes jsonb not null check (jsonb_typeof(changes) = 'object'),
  note text check (note is null or char_length(note) <= 300),
  base_version integer not null,
  status text not null default 'pending' check (status in ('pending', 'applied', 'discarded')),
  proposed_by uuid,
  proposed_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  applied_version integer
);
create index if not exists labor_rule_changes_company_idx on public.labor_rule_changes (company_id, status, proposed_at desc);
alter table public.labor_rule_changes enable row level security;
revoke all on public.labor_rule_changes from public, anon, authenticated;
grant all on public.labor_rule_changes to service_role;
grant select on public.labor_rule_changes to authenticated;
drop policy if exists ba_rule_changes_select on public.labor_rule_changes;
create policy ba_rule_changes_select on public.labor_rule_changes for select to authenticated using (public.wf_manages(company_id));

-- History tables are append-only (a version) or final once decided (a change).
create or replace function public.wf_rules_history_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.wf_company_gone(old.company_id) then return old; end if;
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  if tg_table_name = 'labor_rule_versions' then
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  if to_jsonb(old) ->> 'status' <> 'pending'
     or (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'applied_version'])
        <> (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'applied_version']) then
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  return new;
end $$;
drop trigger if exists ba_wf_rules_history_guard on public.labor_rule_versions;
create trigger ba_wf_rules_history_guard before update or delete on public.labor_rule_versions for each row execute function public.wf_rules_history_guard();
drop trigger if exists ba_wf_rules_history_guard on public.labor_rule_changes;
create trigger ba_wf_rules_history_guard before update or delete on public.labor_rule_changes for each row execute function public.wf_rules_history_guard();

-- Allowed keys per scope; null when valid, else the first problem.
create or replace function public.wf_rule_values_problem(scope text, v jsonb)
returns text language plpgsql stable set search_path = '' as $$
declare
  k text;
  val jsonb;
  allowed text[] := case scope
    when 'company' then array['jurisdiction', 'timezone', 'week_starts_on', 'daily_overtime_after_minutes', 'weekly_overtime_after_minutes',
                              'overtime_multiplier', 'grace_minutes', 'meal_break_after_minutes', 'meal_break_min_minutes',
                              'meal_alert_before_minutes', 'overnight_attribution']
    when 'rule_set' then array['jurisdiction', 'exempt', 'daily_overtime_after_minutes', 'weekly_overtime_after_minutes', 'overtime_multiplier',
                               'meal_break_after_minutes', 'meal_break_min_minutes', 'meal_alert_before_minutes']
    when 'employee' then array['exempt', 'daily_overtime_after_minutes', 'weekly_overtime_after_minutes', 'overtime_multiplier',
                               'meal_break_after_minutes', 'meal_break_min_minutes', 'meal_alert_before_minutes']
  end;
  num numeric;
begin
  if allowed is null or v is null or jsonb_typeof(v) <> 'object' then return 'invalid'; end if;
  for k, val in select * from jsonb_each(v) loop
    if not k = any (allowed) then return 'key:' || k; end if;
    if jsonb_typeof(val) = 'null' then
      if k in ('timezone', 'week_starts_on', 'overtime_multiplier', 'grace_minutes', 'meal_alert_before_minutes', 'overnight_attribution')
         or (k = 'exempt' and scope = 'rule_set') then
        return 'null:' || k;
      end if;
      continue;
    end if;
    if k = 'exempt' then
      if jsonb_typeof(val) <> 'boolean' then return 'type:' || k; end if;
      continue;
    end if;
    if k in ('jurisdiction', 'timezone', 'overnight_attribution') then
      if jsonb_typeof(val) <> 'string' then return 'type:' || k; end if;
      if k = 'jurisdiction' and not exists (select 1 from public.labor_jurisdictions j where j.code = val #>> '{}') then return 'value:' || k; end if;
      if k = 'timezone' and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = val #>> '{}') then return 'value:' || k; end if;
      if k = 'overnight_attribution' and (val #>> '{}') not in ('start_day', 'split_midnight') then return 'value:' || k; end if;
      continue;
    end if;
    if jsonb_typeof(val) <> 'number' then return 'type:' || k; end if;
    num := (val #>> '{}')::numeric;
    if k <> 'overtime_multiplier' and num <> trunc(num) then return 'value:' || k; end if;
    if (k = 'daily_overtime_after_minutes' and num not between 60 and 1440)
       or (k = 'weekly_overtime_after_minutes' and num not between 60 and 10080)
       or (k = 'overtime_multiplier' and num not between 1 and 4)
       or (k = 'grace_minutes' and num not between 0 and 120)
       or (k = 'meal_break_after_minutes' and num not between 60 and 960)
       or (k = 'meal_break_min_minutes' and num not between 10 and 180)
       or (k = 'meal_alert_before_minutes' and num not between 0 and 120)
       or (k = 'week_starts_on' and num not between 0 and 6) then
      return 'value:' || k;
    end if;
  end loop;
  return null;
end $$;

-- The rule values of a scope (what a version stores).
create or replace function public.wf_rule_snapshot(tbl text, r jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case tbl
    when 'workforce_settings' then jsonb_build_object('jurisdiction', r -> 'jurisdiction', 'timezone', r -> 'timezone', 'week_starts_on', r -> 'week_starts_on',
      'daily_overtime_after_minutes', r -> 'daily_overtime_after_minutes', 'weekly_overtime_after_minutes', r -> 'weekly_overtime_after_minutes',
      'overtime_multiplier', r -> 'overtime_multiplier', 'grace_minutes', r -> 'grace_minutes', 'meal_break_after_minutes', r -> 'meal_break_after_minutes',
      'meal_break_min_minutes', r -> 'meal_break_min_minutes', 'meal_alert_before_minutes', r -> 'meal_alert_before_minutes',
      'overnight_attribution', r -> 'overnight_attribution')
    when 'labor_rule_sets' then jsonb_build_object('name', r -> 'name', 'jurisdiction', r -> 'jurisdiction', 'exempt', r -> 'exempt',
      'daily_overtime_after_minutes', r -> 'daily_overtime_after_minutes', 'weekly_overtime_after_minutes', r -> 'weekly_overtime_after_minutes',
      'overtime_multiplier', r -> 'overtime_multiplier', 'meal_break_after_minutes', r -> 'meal_break_after_minutes',
      'meal_break_min_minutes', r -> 'meal_break_min_minutes', 'meal_alert_before_minutes', r -> 'meal_alert_before_minutes', 'archived', (r ->> 'archived_at') is not null)
    else jsonb_build_object('overrides', r -> 'overrides', 'reason', r -> 'reason')
  end
$$;

create or replace function public.wf_rule_version_of(sc text, sid uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(max(v.version), 0) from public.labor_rule_versions v where v.scope = sc and v.scope_id = sid
$$;

-- Every change to the rules (any path: UI, API, template, apply) becomes a version.
create or replace function public.wf_rule_versioning()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  sc text := case tg_table_name when 'workforce_settings' then 'company' when 'labor_rule_sets' then 'rule_set' else 'employee' end;
  sid uuid := case tg_table_name when 'workforce_settings' then new.company_id when 'labor_rule_sets' then (to_jsonb(new) ->> 'id')::uuid
                                 else (to_jsonb(new) ->> 'employee_id')::uuid end;
  snap jsonb := public.wf_rule_snapshot(tg_table_name, to_jsonb(new));
  chg text := nullif(current_setting('ba.rule_change', true), '');
begin
  if tg_op = 'UPDATE' and snap = public.wf_rule_snapshot(tg_table_name, to_jsonb(old)) then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_rules:' || sid::text, 0));
  insert into public.labor_rule_versions (company_id, scope, scope_id, version, rule_values, change_id, actor)
  values (new.company_id, sc, sid, public.wf_rule_version_of(sc, sid) + 1, snap, chg::uuid, (select auth.uid()));
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['workforce_settings', 'labor_rule_sets', 'employee_rule_overrides'] loop
    execute format('drop trigger if exists ba_wf_rule_versioning on public.%I', t);
    execute format('create trigger ba_wf_rule_versioning after insert or update on public.%I for each row execute function public.wf_rule_versioning()', t);
  end loop;
end $$;

-- Propose a change (nothing changes until it is applied).
create or replace function public.propose_rule_change(target uuid, change_scope text, target_id uuid, change_values jsonb, change_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  problem text;
  cid uuid;
begin
  if not public.wf_manages(target) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if change_scope = 'company' and target_id is distinct from target
     or change_scope = 'rule_set' and not exists (select 1 from public.labor_rule_sets r where r.id = target_id and r.company_id = target and r.archived_at is null)
     or change_scope = 'employee' and not exists (select 1 from public.employees e where e.id = target_id and e.company_id = target)
     or change_scope not in ('company', 'rule_set', 'employee') then
    raise exception 'RULE_SCOPE_INVALID' using errcode = 'P0001';
  end if;
  problem := public.wf_rule_values_problem(change_scope, change_values);
  if problem is not null then
    raise exception 'RULE_VALUES_INVALID' using errcode = 'P0001', hint = problem;
  end if;
  if change_scope = 'employee' and char_length(btrim(coalesce(change_note, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  insert into public.labor_rule_changes (company_id, scope, scope_id, changes, note, base_version, proposed_by)
  values (target, change_scope, target_id, change_values, nullif(left(btrim(coalesce(change_note, '')), 300), ''),
          public.wf_rule_version_of(change_scope, target_id), (select auth.uid()))
  returning id into cid;
  perform public.wf_log(target, case when change_scope = 'employee' then target_id end, 'labor_rule_changes', cid::text, 'proposed',
                        jsonb_build_object('scope', change_scope, 'keys', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(change_values) k)));
  return cid;
end $$;

-- A reference template as a proposal (its values are shown before applying).
create or replace function public.propose_jurisdiction_template(target uuid, code text, rule_set uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare j public.labor_jurisdictions;
begin
  select * into j from public.labor_jurisdictions where labor_jurisdictions.code = propose_jurisdiction_template.code;
  if not found then
    raise exception 'JURISDICTION_INVALID' using errcode = 'P0001';
  end if;
  return public.propose_rule_change(target, case when rule_set is null then 'company' else 'rule_set' end, coalesce(rule_set, target),
    jsonb_build_object('jurisdiction', j.code, 'daily_overtime_after_minutes', j.daily_overtime_after_minutes,
                       'weekly_overtime_after_minutes', j.weekly_overtime_after_minutes, 'overtime_multiplier', coalesce(j.overtime_multiplier, 1.5),
                       'meal_break_after_minutes', j.meal_break_after_minutes, 'meal_break_min_minutes', j.meal_break_min_minutes),
    'template ' || j.code);
end $$;

-- Apply a pending change explicitly. Refused when the rules changed after it was proposed.
create or replace function public.apply_rule_change(change uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c public.labor_rule_changes;
  v jsonb;
  nv integer;
begin
  select * into c from public.labor_rule_changes where id = change for update;
  if not found or not public.wf_manages(c.company_id) then
    raise exception 'RULE_CHANGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if c.status <> 'pending' then
    raise exception 'RULE_CHANGE_NOT_PENDING' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_rules:' || c.scope_id::text, 0));
  if public.wf_rule_version_of(c.scope, c.scope_id) <> c.base_version then
    raise exception 'RULES_CHANGED_SINCE' using errcode = 'P0001';
  end if;
  v := c.changes;
  perform set_config('ba.rule_change', c.id::text, true);
  if c.scope = 'company' then
    -- one statement (one version): the first change creates the row with the table defaults for the rest
    insert into public.workforce_settings as w (company_id, jurisdiction, timezone, week_starts_on, daily_overtime_after_minutes, weekly_overtime_after_minutes,
                                                overtime_multiplier, grace_minutes, meal_break_after_minutes, meal_break_min_minutes, meal_alert_before_minutes,
                                                overnight_attribution, updated_by, updated_at)
    values (c.company_id, v ->> 'jurisdiction', coalesce(v ->> 'timezone', 'America/Puerto_Rico'), coalesce((v ->> 'week_starts_on')::smallint, 1),
            case when v ? 'daily_overtime_after_minutes' then (v ->> 'daily_overtime_after_minutes')::integer else 480 end,
            case when v ? 'weekly_overtime_after_minutes' then (v ->> 'weekly_overtime_after_minutes')::integer else 2400 end,
            coalesce((v ->> 'overtime_multiplier')::numeric, 1.5), coalesce((v ->> 'grace_minutes')::smallint, 5),
            (v ->> 'meal_break_after_minutes')::integer, (v ->> 'meal_break_min_minutes')::integer, coalesce((v ->> 'meal_alert_before_minutes')::integer, 15),
            coalesce(v ->> 'overnight_attribution', 'start_day'), (select auth.uid()), now())
    on conflict (company_id) do update set
      jurisdiction = case when v ? 'jurisdiction' then v ->> 'jurisdiction' else w.jurisdiction end,
      timezone = case when v ? 'timezone' then v ->> 'timezone' else w.timezone end,
      week_starts_on = case when v ? 'week_starts_on' then (v ->> 'week_starts_on')::smallint else w.week_starts_on end,
      daily_overtime_after_minutes = case when v ? 'daily_overtime_after_minutes' then (v ->> 'daily_overtime_after_minutes')::integer else w.daily_overtime_after_minutes end,
      weekly_overtime_after_minutes = case when v ? 'weekly_overtime_after_minutes' then (v ->> 'weekly_overtime_after_minutes')::integer else w.weekly_overtime_after_minutes end,
      overtime_multiplier = case when v ? 'overtime_multiplier' then (v ->> 'overtime_multiplier')::numeric else w.overtime_multiplier end,
      grace_minutes = case when v ? 'grace_minutes' then (v ->> 'grace_minutes')::smallint else w.grace_minutes end,
      meal_break_after_minutes = case when v ? 'meal_break_after_minutes' then (v ->> 'meal_break_after_minutes')::integer else w.meal_break_after_minutes end,
      meal_break_min_minutes = case when v ? 'meal_break_min_minutes' then (v ->> 'meal_break_min_minutes')::integer else w.meal_break_min_minutes end,
      meal_alert_before_minutes = case when v ? 'meal_alert_before_minutes' then (v ->> 'meal_alert_before_minutes')::integer else w.meal_alert_before_minutes end,
      overnight_attribution = case when v ? 'overnight_attribution' then v ->> 'overnight_attribution' else w.overnight_attribution end,
      updated_by = (select auth.uid()), updated_at = now();
  elsif c.scope = 'rule_set' then
    update public.labor_rule_sets r set
      jurisdiction = case when v ? 'jurisdiction' then v ->> 'jurisdiction' else r.jurisdiction end,
      exempt = case when v ? 'exempt' then (v ->> 'exempt')::boolean else r.exempt end,
      daily_overtime_after_minutes = case when v ? 'daily_overtime_after_minutes' then (v ->> 'daily_overtime_after_minutes')::integer else r.daily_overtime_after_minutes end,
      weekly_overtime_after_minutes = case when v ? 'weekly_overtime_after_minutes' then (v ->> 'weekly_overtime_after_minutes')::integer else r.weekly_overtime_after_minutes end,
      overtime_multiplier = case when v ? 'overtime_multiplier' then (v ->> 'overtime_multiplier')::numeric else r.overtime_multiplier end,
      meal_break_after_minutes = case when v ? 'meal_break_after_minutes' then (v ->> 'meal_break_after_minutes')::integer else r.meal_break_after_minutes end,
      meal_break_min_minutes = case when v ? 'meal_break_min_minutes' then (v ->> 'meal_break_min_minutes')::integer else r.meal_break_min_minutes end,
      meal_alert_before_minutes = case when v ? 'meal_alert_before_minutes' then (v ->> 'meal_alert_before_minutes')::integer else r.meal_alert_before_minutes end,
      updated_at = now()
     where r.id = c.scope_id and r.company_id = c.company_id and r.archived_at is null;
    if not found then
      raise exception 'RULE_SCOPE_INVALID' using errcode = 'P0001';
    end if;
  else
    -- employee exceptions: the proposal is the complete set of exceptions ({} removes them all)
    insert into public.employee_rule_overrides (employee_id, company_id, overrides, reason, updated_by, updated_at)
    values (c.scope_id, c.company_id, v, coalesce(c.note, 'n/a'), (select auth.uid()), now())
    on conflict (employee_id) do update set overrides = excluded.overrides, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform set_config('ba.rule_change', '', true);
  nv := public.wf_rule_version_of(c.scope, c.scope_id);
  update public.labor_rule_changes set status = 'applied', decided_by = (select auth.uid()), decided_at = now(), applied_version = nv where id = c.id;
  perform public.wf_log(c.company_id, case when c.scope = 'employee' then c.scope_id end, 'labor_rule_changes', c.id::text, 'applied',
                        jsonb_build_object('scope', c.scope, 'version', nv));
  return nv;
end $$;

create or replace function public.discard_rule_change(change uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.labor_rule_changes;
begin
  select * into c from public.labor_rule_changes where id = change for update;
  if not found or not public.wf_manages(c.company_id) then
    raise exception 'RULE_CHANGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if c.status <> 'pending' then
    raise exception 'RULE_CHANGE_NOT_PENDING' using errcode = 'P0001';
  end if;
  update public.labor_rule_changes set status = 'discarded', decided_by = (select auth.uid()), decided_at = now() where id = c.id;
  perform public.wf_log(c.company_id, case when c.scope = 'employee' then c.scope_id end, 'labor_rule_changes', c.id::text, 'discarded', '{}');
end $$;

-- Rules of one employee: exceptions of the employee, then its classification
-- (exempt), then its group, else the company defaults.
create or replace function public.wf_rules(emp uuid)
returns table (source text, rule_set_id uuid, jurisdiction text, exempt boolean, daily_overtime_after_minutes integer,
               weekly_overtime_after_minutes integer, overtime_multiplier numeric, meal_break_after_minutes integer,
               meal_break_min_minutes integer, meal_alert_before_minutes integer)
language sql stable security definer set search_path = '' as $$
  with base as (
    select e.id, e.classification, r.id as rid,
           coalesce(r.jurisdiction, w.jurisdiction) as jur, coalesce(r.exempt, false) as ex,
           case when r.id is not null then r.daily_overtime_after_minutes else coalesce(w.daily_overtime_after_minutes, 480) end as daily,
           case when r.id is not null then r.weekly_overtime_after_minutes else coalesce(w.weekly_overtime_after_minutes, 2400) end as weekly,
           coalesce(r.overtime_multiplier, w.overtime_multiplier, 1.5) as mult,
           case when r.id is not null then r.meal_break_after_minutes else w.meal_break_after_minutes end as meal_after,
           case when r.id is not null then r.meal_break_min_minutes else w.meal_break_min_minutes end as meal_min,
           coalesce(r.meal_alert_before_minutes, w.meal_alert_before_minutes, 15) as meal_alert,
           coalesce(o.overrides, '{}'::jsonb) as o
    from public.employees e
    left join public.labor_rule_sets r on r.id = e.rule_set_id and r.archived_at is null
    left join public.workforce_settings w on w.company_id = e.company_id
    left join public.employee_rule_overrides o on o.employee_id = e.id
    where e.id = emp and (public.wf_supervises(emp) or public.wf_is_self(emp) or (select auth.uid()) is null)
  )
  select case when b.o <> '{}'::jsonb then 'employee' when b.rid is not null then 'group' else 'company' end, b.rid, b.jur,
         case when b.o ? 'exempt' and jsonb_typeof(b.o -> 'exempt') = 'boolean' then (b.o ->> 'exempt')::boolean
              when b.classification = 'exempt' then true else b.ex end,
         case when b.o ? 'daily_overtime_after_minutes' then (b.o ->> 'daily_overtime_after_minutes')::integer else b.daily end,
         case when b.o ? 'weekly_overtime_after_minutes' then (b.o ->> 'weekly_overtime_after_minutes')::integer else b.weekly end,
         case when b.o ? 'overtime_multiplier' and jsonb_typeof(b.o -> 'overtime_multiplier') = 'number' then (b.o ->> 'overtime_multiplier')::numeric else b.mult end,
         case when b.o ? 'meal_break_after_minutes' then (b.o ->> 'meal_break_after_minutes')::integer else b.meal_after end,
         case when b.o ? 'meal_break_min_minutes' then (b.o ->> 'meal_break_min_minutes')::integer else b.meal_min end,
         case when b.o ? 'meal_alert_before_minutes' and jsonb_typeof(b.o -> 'meal_alert_before_minutes') = 'number' then (b.o ->> 'meal_alert_before_minutes')::integer else b.meal_alert end
  from base b
$$;

-- ===================================================================== 6. meal / break alerts
alter table public.meal_alerts add column if not exists action_taken text
  check (action_taken is null or action_taken in ('break_taken_late', 'schedule_adjusted', 'employee_reminded', 'no_action_needed', 'other'));

-- Append-only, except handling (acknowledgement, note, action) once.
create or replace function public.wf_meal_alert_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.wf_company_gone(old.company_id) then return old; end if;
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = 'meal_alerts';
  end if;
  if old.acknowledged_at is not null or new.acknowledged_at is null
     or (to_jsonb(new) - array['acknowledged_by', 'acknowledged_at', 'note', 'action_taken'])
        <> (to_jsonb(old) - array['acknowledged_by', 'acknowledged_at', 'note', 'action_taken']) then
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = 'meal_alerts';
  end if;
  return new;
end $$;

create or replace function public.resolve_meal_alert(alert uuid, action text, resolve_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.meal_alerts;
begin
  select * into a from public.meal_alerts where id = alert for update;
  if not found or not public.wf_supervises(a.employee_id) then
    raise exception 'MEAL_ALERT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if public.wf_is_self(a.employee_id) then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0001';
  end if;
  if action not in ('break_taken_late', 'schedule_adjusted', 'employee_reminded', 'no_action_needed', 'other') then
    raise exception 'ALERT_ACTION_INVALID' using errcode = 'P0001';
  end if;
  if action = 'other' and char_length(btrim(coalesce(resolve_note, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  if a.acknowledged_at is not null then
    raise exception 'MEAL_ALERT_HANDLED' using errcode = 'P0001';
  end if;
  update public.meal_alerts set acknowledged_by = (select auth.uid()), acknowledged_at = now(), action_taken = action,
         note = nullif(left(btrim(coalesce(resolve_note, '')), 300), '') where id = a.id;
  perform public.wf_log(a.company_id, a.employee_id, 'meal_alerts', a.id::text, 'resolved', jsonb_build_object('action', action));
end $$;

-- For a scheduler (pg_cron, as the database owner): evaluates every employee
-- with an open session in every company with the time clock. Not callable
-- from the API. NOT scheduled by this migration (see docs/WORKFORCE.md).
create or replace function public.wf_meal_sweep()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  e record;
  n integer := 0;
begin
  for e in
    select x.id from public.employees x
    where x.status = 'active'
      and (select f.available from public.wf_feature(x.company_id, 'time_clock') f)
      and public.wf_last_kind(x.id) in ('in', 'break_start', 'break_end')
  loop
    n := n + public.wf_meal_record(e.id, clock_timestamp());
  end loop;
  return n;
end $$;

-- ===================================================================== 7. leave types
alter table public.leave_requests drop constraint if exists leave_requests_leave_type_check;
alter table public.leave_requests add constraint leave_requests_leave_type_check
  check (leave_type in ('vacation', 'sick', 'personal', 'unpaid', 'day_off', 'other', 'bereavement', 'jury_duty', 'parental', 'military'));

create or replace function public.request_leave(emp uuid, kind text, from_day date, to_day date, minutes integer, why text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  lid uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not (public.wf_is_self(emp) or public.wf_supervises(emp)) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  select * into e from public.employees where id = emp;
  if kind not in ('vacation', 'sick', 'personal', 'unpaid', 'day_off', 'other', 'bereavement', 'jury_duty', 'parental', 'military') then
    raise exception 'LEAVE_TYPE_INVALID' using errcode = 'P0001';
  end if;
  if from_day is null or to_day is null or to_day < from_day or to_day - from_day > 366
     or from_day < (now() at time zone 'America/Puerto_Rico')::date - 62 then
    raise exception 'LEAVE_DATES_INVALID' using errcode = 'P0001';
  end if;
  if minutes is not null and (minutes not between 15 and 1440 or from_day <> to_day) then
    raise exception 'LEAVE_DATES_INVALID' using errcode = 'P0001';
  end if;
  -- one request at a time for a period (serialised per employee)
  perform pg_advisory_xact_lock(hashtextextended('ba_leave:' || emp::text, 0));
  if exists (select 1 from public.leave_requests l where l.employee_id = emp and l.status in ('pending', 'approved')
               and l.starts_on <= to_day and from_day <= l.ends_on) then
    raise exception 'LEAVE_OVERLAP' using errcode = 'P0001';
  end if;
  insert into public.leave_requests (company_id, employee_id, leave_type, starts_on, ends_on, partial_minutes, reason, requested_by)
  values (e.company_id, emp, kind, from_day, to_day, minutes, nullif(left(btrim(coalesce(why, '')), 300), ''), (select auth.uid()))
  returning id into lid;
  perform public.wf_log(e.company_id, emp, 'leave_requests', lid::text, 'requested', jsonb_build_object('type', kind, 'from', from_day, 'to', to_day));
  return lid;
end $$;

-- ===================================================================== 8. missing punches and schedule conflicts
-- Forgotten clock-outs (a session still open from an earlier day) and
-- shifts that started (plus the grace period) without a clock-in.
create or replace function public.wf_missing_punches(target uuid, from_day date, to_day date)
returns table (employee_id uuid, kind text, day date, ref_at timestamptz, shift_id uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  tz text := public.wf_timezone(target);
  grace integer := coalesce((select w.grace_minutes from public.workforce_settings w where w.company_id = target), 5);
begin
  if from_day is null or to_day is null or to_day < from_day or to_day - from_day > 62 then
    raise exception 'RANGE_INVALID' using errcode = 'P0001';
  end if;
  return query
    select e.id, 'no_clock_out'::text, (lp.at at time zone tz)::date, lp.at, null::uuid
      from public.employees e
      join lateral (select p.kind, p.at from public.time_punches p where p.employee_id = e.id and p.voided_at is null
                     order by p.at desc, p.created_at desc, p.id desc limit 1) lastp on true
      join lateral (select p.at from public.time_punches p where p.employee_id = e.id and p.voided_at is null and p.kind = 'in'
                     order by p.at desc limit 1) lp on true
     where e.company_id = target and public.wf_supervises(e.id) and lastp.kind <> 'out'
       and (lp.at at time zone tz)::date < (now() at time zone tz)::date
       and (lp.at at time zone tz)::date between from_day and to_day
    union all
    select s.employee_id, 'no_clock_in'::text, (s.starts_at at time zone tz)::date, s.starts_at, s.id
      from public.work_shifts s
      join public.employees e on e.id = s.employee_id
     where s.company_id = target and public.wf_supervises(s.employee_id) and e.status = 'active'
       and s.starts_at + make_interval(mins => grace) < now()
       and (s.starts_at at time zone tz)::date between from_day and to_day
       and not exists (select 1 from public.time_punches p where p.employee_id = s.employee_id and p.voided_at is null and p.kind = 'in'
                         and p.at between s.starts_at - interval '2 hours' and s.ends_at)
       and not exists (select 1 from public.leave_requests l where l.employee_id = s.employee_id and l.status = 'approved'
                         and l.starts_on <= (s.starts_at at time zone tz)::date and (s.starts_at at time zone tz)::date <= l.ends_on)
     order by 3, 1;
end $$;

-- Shifts on approved leave, of employees who are not active, and weeks whose
-- scheduled time exceeds the employee's weekly overtime threshold.
create or replace function public.wf_schedule_conflicts(target uuid, from_day date, to_day date)
returns table (kind text, employee_id uuid, shift_id uuid, starts_at timestamptz, detail text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  tz text := public.wf_timezone(target);
  wk smallint := coalesce((select w.week_starts_on from public.workforce_settings w where w.company_id = target), 1);
begin
  if from_day is null or to_day is null or to_day < from_day or to_day - from_day > 92 then
    raise exception 'RANGE_INVALID' using errcode = 'P0001';
  end if;
  return query
    select 'leave'::text, s.employee_id, s.id, s.starts_at, l.leave_type
      from public.work_shifts s
      join public.leave_requests l on l.employee_id = s.employee_id and l.status = 'approved'
                                  and l.starts_on <= (s.starts_at at time zone tz)::date and (s.starts_at at time zone tz)::date <= l.ends_on
     where s.company_id = target and public.wf_supervises(s.employee_id) and (s.starts_at at time zone tz)::date between from_day and to_day
    union all
    select 'employee_not_active'::text, s.employee_id, s.id, s.starts_at, e.status
      from public.work_shifts s join public.employees e on e.id = s.employee_id
     where s.company_id = target and public.wf_supervises(s.employee_id) and e.status <> 'active' and s.starts_at > now()
       and (s.starts_at at time zone tz)::date between from_day and to_day
    union all
    select 'weekly_hours'::text, x.employee_id, null::uuid, x.week_start::timestamptz, x.minutes::text
      from (
        select s.employee_id,
               ((s.starts_at at time zone tz)::date - ((extract(dow from (s.starts_at at time zone tz)::date)::int - wk + 7) % 7)) as week_start,
               sum(extract(epoch from (s.ends_at - s.starts_at)) / 60 - s.break_minutes)::integer as minutes
          from public.work_shifts s
         where s.company_id = target and public.wf_supervises(s.employee_id) and (s.starts_at at time zone tz)::date between from_day and to_day
         group by 1, 2) x
      join lateral (select r.weekly_overtime_after_minutes, r.exempt from public.wf_rules(x.employee_id) r) rr on true
     where rr.weekly_overtime_after_minutes is not null and not rr.exempt and x.minutes > rr.weekly_overtime_after_minutes
     order by 4, 2;
end $$;

-- ===================================================================== history with values
-- History for direct writes. Employees: old → new for the non-sensitive
-- fields (never pay, notes, contact or access data).
create or replace function public.wf_log_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  changed text[];
  vals jsonb := '{}'::jsonb;
  k text;
begin
  -- The whole company is being deleted (cascade): nothing to record.
  if tg_op = 'DELETE' and not exists (select 1 from public.companies c where c.id = (r ->> 'company_id')::uuid) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}') into changed
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value and n.key not in ('updated_at', 'updated_by', 'access_token_hash', 'access_expires_at');
    if cardinality(changed) = 0 then return null; end if;
    if tg_table_name in ('employees', 'shift_patterns', 'work_shifts') then
      foreach k in array changed loop
        if k in ('status', 'status_reason', 'position', 'department_id', 'supervisor_user_id', 'employment_type', 'classification', 'hire_date',
                 'termination_date', 'rule_set_id', 'pay_type', 'archived_at', 'employee_number', 'first_name', 'last_name',
                 'starts_at', 'ends_at', 'break_minutes', 'weekdays', 'start_time', 'end_time', 'starts_on', 'ends_on') then
          vals := vals || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(old) -> k, 'to', to_jsonb(new) -> k));
        end if;
      end loop;
    end if;
  end if;
  insert into public.workforce_events (company_id, employee_id, entity, entity_id, action, details, actor)
  values ((r ->> 'company_id')::uuid,
          case tg_table_name when 'employees' then (r ->> 'id')::uuid when 'work_shifts' then (r ->> 'employee_id')::uuid
                             when 'shift_patterns' then (r ->> 'employee_id')::uuid when 'employee_contacts' then (r ->> 'employee_id')::uuid end,
          tg_table_name, coalesce(r ->> 'id', r ->> 'employee_id', r ->> 'company_id'), lower(tg_op),
          case when tg_op = 'UPDATE' then jsonb_build_object('fields', changed) || case when vals <> '{}'::jsonb then jsonb_build_object('changes', vals) else '{}'::jsonb end
               when tg_table_name = 'work_shifts' then jsonb_build_object('starts_at', r -> 'starts_at', 'ends_at', r -> 'ends_at')
               else '{}'::jsonb end,
          (select auth.uid()));
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['shift_patterns', 'employee_contacts'] loop
    execute format('drop trigger if exists ba_wf_log_row on public.%I', t);
    execute format('create trigger ba_wf_log_row after insert or update or delete on public.%I for each row execute function public.wf_log_row()', t);
  end loop;
end $$;

-- ===================================================================== grants
do $$
declare f text;
begin
  foreach f in array array['wf_employee_hr_guard()', 'wf_contact_stamp()', 'wf_document_guard()', 'wf_pattern_guard()', 'wf_request_guard()',
                           'wf_rules_history_guard()', 'wf_rule_versioning()', 'wf_rule_snapshot(text, jsonb)', 'wf_rule_values_problem(text, jsonb)',
                           'wf_meal_sweep()', 'wf_timezone(uuid)', 'wf_rule_version_of(text, uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['set_employee_status(uuid, text, text)', 'archive_employee(uuid, boolean)', 'set_employee_document(uuid, boolean, boolean)',
                           'hr_object_employee(text)', 'generate_pattern_shifts(uuid, date, date)',
                           'request_shift_change(uuid, text, timestamptz, timestamptz, integer, text)', 'decide_shift_change(uuid, boolean, text)',
                           'cancel_shift_change(uuid)', 'propose_rule_change(uuid, text, uuid, jsonb, text)', 'propose_jurisdiction_template(uuid, text, uuid)',
                           'apply_rule_change(uuid)', 'discard_rule_change(uuid)', 'resolve_meal_alert(uuid, text, text)',
                           'wf_missing_punches(uuid, date, date)', 'wf_schedule_conflicts(uuid, date, date)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
grant execute on function public.wf_meal_sweep() to service_role;

-- ===================================================================== self-check
do $$
begin
  if has_table_privilege('authenticated', 'public.employee_documents', 'UPDATE') or has_table_privilege('authenticated', 'public.employee_documents', 'DELETE')
     or has_table_privilege('authenticated', 'public.labor_rule_versions', 'INSERT') or has_table_privilege('authenticated', 'public.labor_rule_changes', 'INSERT')
     or has_table_privilege('authenticated', 'public.employee_rule_overrides', 'INSERT') or has_table_privilege('authenticated', 'public.shift_change_requests', 'INSERT')
     or has_column_privilege('authenticated', 'public.employees', 'archived_at', 'UPDATE')
     or has_column_privilege('authenticated', 'public.employees', 'hourly_rate', 'SELECT')
     or has_function_privilege('authenticated', 'public.wf_meal_sweep()', 'EXECUTE')
     or has_table_privilege('anon', 'public.employee_documents', 'SELECT') or has_table_privilege('anon', 'public.employee_contacts', 'SELECT') then
    raise exception 'BA0033 self-check failed: privileges';
  end if;
  if (select public from storage.buckets where id = 'HR-documents') is distinct from false then
    raise exception 'BA0033 self-check failed: HR-documents must be private';
  end if;
end $$;

commit;
