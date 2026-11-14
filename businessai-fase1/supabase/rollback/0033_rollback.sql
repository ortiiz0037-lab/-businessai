-- Rollback of 0033 (Workforce / HR completion).
-- Refuses, changing nothing, while anything 0033 introduced holds data: HR
-- documents, private contacts, patterns, shift change requests, rule
-- exceptions / proposals / versions, suspended or archived employees, direct
-- supervisors, non-default type or classification, the new leave types,
-- handled-alert actions or files in HR-documents. Emergency use only.
-- Restores the 0020 / 0022 functions that 0033 replaced, verbatim.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.employee_documents') is not null and (
       exists (select 1 from public.employee_documents) or exists (select 1 from public.employee_contacts)
    or exists (select 1 from public.shift_patterns) or exists (select 1 from public.shift_change_requests)
    or exists (select 1 from public.employee_rule_overrides) or exists (select 1 from public.labor_rule_changes)
    or exists (select 1 from public.labor_rule_versions)) then
    raise exception 'BA0033 rollback: HR data exists (documents, contacts, patterns, shift changes or rule history); nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'archived_at')
     and exists (select 1 from public.employees where status = 'suspended' or archived_at is not null or supervisor_user_id is not null
                   or employment_type <> 'full_time' or classification <> 'non_exempt' or status_reason is not null) then
    raise exception 'BA0033 rollback: employees use 0033 fields (suspended, archived, supervisor, type or classification); nothing was changed.';
  end if;
  if exists (select 1 from public.leave_requests where leave_type in ('bereavement', 'jury_duty', 'parental', 'military')) then
    raise exception 'BA0033 rollback: leave requests of the new types exist; nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'meal_alerts' and column_name = 'action_taken')
     and exists (select 1 from public.meal_alerts where action_taken is not null) then
    raise exception 'BA0033 rollback: handled alerts record an action; nothing was changed.';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'HR-documents') then
    raise exception 'BA0033 rollback: files exist in HR-documents; nothing was changed.';
  end if;
end $$;

drop policy if exists ba_hr_documents_select on storage.objects;
drop policy if exists ba_hr_documents_insert on storage.objects;
drop policy if exists ba_hr_documents_delete on storage.objects;
delete from storage.buckets where id = 'HR-documents';

drop policy if exists ba_employees_select on public.employees;
create policy ba_employees_select on public.employees for select to authenticated
  using (public.wf_supervises(id) or user_id = (select auth.uid()));
drop trigger if exists ba_wf_employee_hr_guard on public.employees;
drop trigger if exists ba_wf_rule_versioning on public.workforce_settings;
drop trigger if exists ba_wf_rule_versioning on public.labor_rule_sets;

drop function if exists public.wf_schedule_conflicts(uuid, date, date);
drop function if exists public.wf_missing_punches(uuid, date, date);
drop function if exists public.wf_meal_sweep();
drop function if exists public.resolve_meal_alert(uuid, text, text);
drop function if exists public.discard_rule_change(uuid);
drop function if exists public.apply_rule_change(uuid);
drop function if exists public.propose_jurisdiction_template(uuid, text, uuid);
drop function if exists public.propose_rule_change(uuid, text, uuid, jsonb, text);
drop function if exists public.cancel_shift_change(uuid);
drop function if exists public.decide_shift_change(uuid, boolean, text);
drop function if exists public.request_shift_change(uuid, text, timestamptz, timestamptz, integer, text);
drop function if exists public.generate_pattern_shifts(uuid, date, date);
drop function if exists public.set_employee_document(uuid, boolean, boolean);
drop function if exists public.archive_employee(uuid, boolean);
drop function if exists public.set_employee_status(uuid, text, text);

-- the 0020 / 0022 versions (verbatim)
create or replace function public.wf_supervises(emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.employees e
    where e.id = emp
      and (public.has_permission(e.company_id, 'workforce.manage')
           or (e.department_id is not null and public.is_company_member(e.company_id) and exists (
                 select 1 from public.department_supervisors s
                 where s.department_id = e.department_id and s.user_id = (select auth.uid())))))
$$;

create or replace function public.wf_shift_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'DELETE' then
    if exists (select 1 from public.work_shifts s where s.employee_id = new.employee_id and s.id <> new.id
                 and s.starts_at < new.ends_at and new.starts_at < s.ends_at) then
      raise exception 'SHIFT_OVERLAP' using errcode = 'P0001';
    end if;
    if tg_op = 'INSERT' then new.created_by := (select auth.uid()); end if;
  end if;
  return coalesce(new, old);
end $$;

create or replace function public.wf_log_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  changed text[];
begin
  -- The whole company is being deleted (cascade): nothing to record.
  if tg_op = 'DELETE' and not exists (select 1 from public.companies c where c.id = (r ->> 'company_id')::uuid) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}') into changed
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value and n.key not in ('updated_at', 'access_token_hash', 'access_expires_at');
    if cardinality(changed) = 0 then return null; end if;
  end if;
  insert into public.workforce_events (company_id, employee_id, entity, entity_id, action, details, actor)
  values ((r ->> 'company_id')::uuid,
          case tg_table_name when 'employees' then (r ->> 'id')::uuid when 'work_shifts' then (r ->> 'employee_id')::uuid end,
          tg_table_name, coalesce(r ->> 'id', r ->> 'company_id'), lower(tg_op),
          case when tg_op = 'UPDATE' then jsonb_build_object('fields', changed)
               when tg_table_name = 'work_shifts' then jsonb_build_object('starts_at', r -> 'starts_at', 'ends_at', r -> 'ends_at')
               else '{}'::jsonb end,
          (select auth.uid()));
  return null;
end $$;

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
  if kind not in ('vacation', 'sick', 'personal', 'unpaid', 'day_off', 'other') then
    raise exception 'LEAVE_TYPE_INVALID' using errcode = 'P0001';
  end if;
  if from_day is null or to_day is null or to_day < from_day or to_day - from_day > 366
     or from_day < (now() at time zone 'America/Puerto_Rico')::date - 62 then
    raise exception 'LEAVE_DATES_INVALID' using errcode = 'P0001';
  end if;
  if minutes is not null and (minutes not between 15 and 1440 or from_day <> to_day) then
    raise exception 'LEAVE_DATES_INVALID' using errcode = 'P0001';
  end if;
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

create or replace function public.wf_rules(emp uuid)
returns table (source text, rule_set_id uuid, jurisdiction text, exempt boolean, daily_overtime_after_minutes integer,
               weekly_overtime_after_minutes integer, overtime_multiplier numeric, meal_break_after_minutes integer,
               meal_break_min_minutes integer, meal_alert_before_minutes integer)
language sql stable security definer set search_path = '' as $$
  select case when r.id is not null then 'group' else 'company' end, r.id,
         coalesce(r.jurisdiction, w.jurisdiction), coalesce(r.exempt, false),
         case when r.id is not null then r.daily_overtime_after_minutes else coalesce(w.daily_overtime_after_minutes, 480) end,
         case when r.id is not null then r.weekly_overtime_after_minutes else coalesce(w.weekly_overtime_after_minutes, 2400) end,
         coalesce(r.overtime_multiplier, w.overtime_multiplier, 1.5),
         case when r.id is not null then r.meal_break_after_minutes else w.meal_break_after_minutes end,
         case when r.id is not null then r.meal_break_min_minutes else w.meal_break_min_minutes end,
         coalesce(r.meal_alert_before_minutes, w.meal_alert_before_minutes, 15)
  from public.employees e
  left join public.labor_rule_sets r on r.id = e.rule_set_id and r.archived_at is null
  left join public.workforce_settings w on w.company_id = e.company_id
  where e.id = emp and (public.wf_supervises(emp) or public.wf_is_self(emp) or (select auth.uid()) is null)
$$;

create or replace function public.wf_meal_alert_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.wf_company_gone(old.company_id) then return old; end if;
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = 'meal_alerts';
  end if;
  if old.acknowledged_at is not null or new.acknowledged_at is null
     or (to_jsonb(new) - array['acknowledged_by', 'acknowledged_at', 'note']) <> (to_jsonb(old) - array['acknowledged_by', 'acknowledged_at', 'note']) then
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = 'meal_alerts';
  end if;
  return new;
end $$;

drop table if exists public.labor_rule_changes;
drop table if exists public.labor_rule_versions;
drop table if exists public.employee_rule_overrides;
drop table if exists public.shift_change_requests;
alter table public.work_shifts drop column if exists pattern_id;
alter table public.work_shifts drop column if exists updated_at;
alter table public.work_shifts drop column if exists updated_by;
drop table if exists public.shift_patterns;
drop table if exists public.employee_documents;
drop table if exists public.employee_contacts;

drop function if exists public.wf_rule_versioning();
drop function if exists public.wf_rule_version_of(text, uuid);
drop function if exists public.wf_rule_snapshot(text, jsonb);
drop function if exists public.wf_rule_values_problem(text, jsonb);
drop function if exists public.wf_rules_history_guard();
drop function if exists public.wf_request_guard();
drop function if exists public.wf_pattern_guard();
drop function if exists public.wf_timezone(uuid);
drop function if exists public.wf_document_guard();
drop function if exists public.hr_object_employee(text);
drop function if exists public.wf_contact_stamp();
drop function if exists public.wf_employee_hr_guard();

alter table public.meal_alerts drop column if exists action_taken;
alter table public.leave_requests drop constraint if exists leave_requests_leave_type_check;
alter table public.leave_requests add constraint leave_requests_leave_type_check
  check (leave_type in ('vacation', 'sick', 'personal', 'unpaid', 'day_off', 'other'));
alter table public.labor_jurisdictions drop column if exists verified_on;
alter table public.labor_jurisdictions drop column if exists verification_status;
alter table public.workforce_settings drop column if exists overnight_attribution;
alter table public.employees drop constraint if exists employees_archive_check;
alter table public.employees drop column if exists archived_by;
alter table public.employees drop column if exists archived_at;
alter table public.employees drop column if exists status_reason;
alter table public.employees drop column if exists supervisor_user_id;
alter table public.employees drop column if exists classification;
alter table public.employees drop column if exists employment_type;
alter table public.employees drop constraint if exists employees_status_check;
alter table public.employees add constraint employees_status_check check (status in ('active', 'inactive', 'terminated'));
commit;
