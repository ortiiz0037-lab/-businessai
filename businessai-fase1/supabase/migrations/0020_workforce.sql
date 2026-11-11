-- =====================================================================
-- BusinessAI · Migration 0020 · Workforce: employees, time clock,
-- schedules, leave, punch corrections, history
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0014a, 0015 (company
-- immutability) and 0017 (plan features).
--
-- WHO
--  * Managers: members with workforce.manage (owner, admin) — everything.
--  * Supervisors: members assigned to a department (department_supervisors)
--    — employees of that department: attendance, schedules, approvals.
--  * Employees: NOT company members (they use no user seat). An employee
--    record may be linked to a login (employees.user_id) through a one-time
--    access link; that login sees and acts only on its own record.
-- PLANS (0017): active employees limited per plan (Basic 3, Pro 25,
--    Premium 100); punching requires the time_clock feature.
-- TIME CLOCK: punches are written only by functions, never directly.
--  * A self punch is stamped with the server time (now()): the device
--    cannot choose the time.
--  * Sequence in → break_start → break_end → … → out, checked under a
--    per-employee lock: duplicate or out-of-order punches are refused,
--    including two simultaneous taps.
--  * Past punches only through corrections (add / void / change), which
--    record who requested, who decided and when. An employee never approves
--    their own correction or leave; a supervisor may apply a correction they
--    requested for SOMEONE ELSE (recorded as such), never for themselves.
-- HISTORY: workforce_events records every change (employees, punches,
--    corrections, leave, shifts, settings) with the actor.
-- Times are timestamptz; the company time zone (workforce_settings) decides
-- the local day in reports.
-- Rollback: supabase/rollback/0020_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.has_permission(uuid, text)') is null then
    raise exception 'BA0020: migration 0014a must be applied first';
  end if;
  if to_regprocedure('public.company_feature(uuid, text)') is null then
    raise exception 'BA0020: migration 0017 (plan features) must be applied first';
  end if;
  if to_regprocedure('public.forbid_company_change()') is null then
    raise exception 'BA0020: migration 0015 must be applied first';
  end if;
end $$;

insert into public.permissions (key, module, description_es, description_en) values
  ('workforce.manage', 'workforce', 'Gestionar empleados, horarios, asistencia y aprobaciones', 'Manage employees, schedules, attendance and approvals')
on conflict (key) do nothing;
insert into public.role_permissions (role, permission_key) values ('owner', 'workforce.manage'), ('admin', 'workforce.manage')
on conflict do nothing;

-- ------------------------------------------------------------ tables
create table if not exists public.workforce_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  timezone text not null default 'America/Puerto_Rico',
  week_starts_on smallint not null default 1 check (week_starts_on between 0 and 6),   -- 0 Sunday, 1 Monday
  daily_overtime_after_minutes integer default 480 check (daily_overtime_after_minutes is null or daily_overtime_after_minutes between 60 and 1440),
  weekly_overtime_after_minutes integer default 2400 check (weekly_overtime_after_minutes is null or weekly_overtime_after_minutes between 60 and 10080),
  overtime_multiplier numeric(4,2) not null default 1.5 check (overtime_multiplier between 1 and 4),
  grace_minutes smallint not null default 5 check (grace_minutes between 0 and 120),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create table if not exists public.department_supervisors (
  company_id uuid not null references public.companies(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (department_id, user_id)
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  employee_number text check (employee_number is null or char_length(employee_number) between 1 and 30),
  first_name text not null check (char_length(btrim(first_name)) between 1 and 80),
  last_name text not null check (char_length(btrim(last_name)) between 1 and 80),
  email text check (email is null or (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  phone text check (phone is null or char_length(phone) <= 40),
  department_id uuid references public.departments(id) on delete set null,
  position text check (position is null or char_length(position) <= 80),
  hire_date date,
  termination_date date,
  status text not null default 'active' check (status in ('active', 'inactive', 'terminated')),
  pay_type text not null default 'hourly' check (pay_type in ('hourly', 'salary')),
  hourly_rate numeric(10,2) check (hourly_rate is null or hourly_rate >= 0),
  notes text check (notes is null or char_length(notes) <= 2000),
  access_token_hash text unique check (access_token_hash is null or access_token_hash ~ '^[0-9a-f]{64}$'),
  access_expires_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (termination_date is null or hire_date is null or termination_date >= hire_date)
);
create unique index if not exists employees_number_uidx on public.employees (company_id, employee_number) where employee_number is not null;
create unique index if not exists employees_user_uidx on public.employees (company_id, user_id) where user_id is not null;
create index if not exists employees_company_idx on public.employees (company_id, status);

create table if not exists public.time_punches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  kind text not null check (kind in ('in', 'out', 'break_start', 'break_end')),
  at timestamptz not null,
  source text not null check (source in ('self', 'supervisor', 'correction')),
  recorded_by uuid,
  note text check (note is null or char_length(note) <= 300),
  correction_id uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_at timestamptz not null default now()
);
create index if not exists time_punches_employee_idx on public.time_punches (employee_id, at);
create index if not exists time_punches_company_idx on public.time_punches (company_id, at);

create table if not exists public.punch_corrections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  action text not null check (action in ('add', 'void', 'change')),
  punch_id uuid references public.time_punches(id) on delete restrict,
  kind text check (kind is null or kind in ('in', 'out', 'break_start', 'break_end')),
  at timestamptz,
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 300),
  check ((action = 'add' and punch_id is null and kind is not null and at is not null)
      or (action = 'void' and punch_id is not null)
      or (action = 'change' and punch_id is not null and kind is not null and at is not null))
);
create index if not exists punch_corrections_company_idx on public.punch_corrections (company_id, status, requested_at desc);

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  leave_type text not null check (leave_type in ('vacation', 'sick', 'personal', 'unpaid', 'day_off', 'other')),
  starts_on date not null,
  ends_on date not null,
  partial_minutes integer check (partial_minutes is null or partial_minutes between 15 and 1440),
  reason text check (reason is null or char_length(reason) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 300),
  check (ends_on >= starts_on and ends_on - starts_on <= 366),
  check (partial_minutes is null or starts_on = ends_on)
);
create index if not exists leave_requests_company_idx on public.leave_requests (company_id, status, starts_on);

create table if not exists public.work_shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  break_minutes smallint not null default 0 check (break_minutes between 0 and 480),
  notes text check (notes is null or char_length(notes) <= 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours')
);
create index if not exists work_shifts_employee_idx on public.work_shifts (employee_id, starts_at);
create index if not exists work_shifts_company_idx on public.work_shifts (company_id, starts_at);

create table if not exists public.workforce_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid,
  entity text not null,
  entity_id text,
  action text not null,
  details jsonb not null default '{}',
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists workforce_events_company_idx on public.workforce_events (company_id, created_at desc);
create index if not exists workforce_events_employee_idx on public.workforce_events (employee_id, created_at desc);

-- ------------------------------------------------------------ access helpers
create or replace function public.wf_manages(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_permission(target, 'workforce.manage')
$$;

-- Manager of the company, or supervisor of the employee's department (an
-- active member of the company).
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

-- The signed-in user is this (non-terminated) employee.
create or replace function public.wf_is_self(emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.employees e where e.id = emp and e.user_id = (select auth.uid())
                 and (select auth.uid()) is not null and e.status <> 'terminated')
$$;

create or replace function public.wf_log(target uuid, emp uuid, ent text, ent_id text, act text, info jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.workforce_events (company_id, employee_id, entity, entity_id, action, details, actor)
  values (target, emp, ent, ent_id, act, coalesce(info, '{}'), (select auth.uid()))
$$;

-- A plan feature, answered by the server (employees are not members, so
-- company_feature() would answer nothing for them).
create or replace function public.wf_feature(target uuid, feature text)
returns table (available boolean, max_allowed integer, used integer)
language plpgsql security definer set search_path = '' as $$
declare
  saved_claims text := current_setting('request.jwt.claims', true);
  saved_sub text := current_setting('request.jwt.claim.sub', true);
  r record;
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select * into r from public.company_feature(target, feature);
  perform set_config('request.jwt.claims', coalesce(saved_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(saved_sub, ''), true);
  available := coalesce(r.available, false); max_allowed := r.max_allowed; used := coalesce(r.used, 0);
  return next;
end $$;

-- ------------------------------------------------------------ RLS
alter table public.workforce_settings enable row level security;
alter table public.departments enable row level security;
alter table public.department_supervisors enable row level security;
alter table public.employees enable row level security;
alter table public.time_punches enable row level security;
alter table public.punch_corrections enable row level security;
alter table public.leave_requests enable row level security;
alter table public.work_shifts enable row level security;
alter table public.workforce_events enable row level security;

revoke all on public.workforce_settings, public.departments, public.department_supervisors, public.employees,
  public.time_punches, public.punch_corrections, public.leave_requests, public.work_shifts, public.workforce_events
  from public, anon, authenticated;
grant all on public.workforce_settings, public.departments, public.department_supervisors, public.employees,
  public.time_punches, public.punch_corrections, public.leave_requests, public.work_shifts, public.workforce_events
  to service_role;

grant select, insert, update on public.workforce_settings to authenticated;
grant select, insert, update on public.departments to authenticated;
grant select, insert, delete on public.department_supervisors to authenticated;
-- Pay rate and the access token are not readable through the API.
grant select (id, company_id, user_id, employee_number, first_name, last_name, email, phone, department_id, position,
              hire_date, termination_date, status, pay_type, notes, access_expires_at, created_at, updated_at)
  on public.employees to authenticated;
grant insert (company_id, employee_number, first_name, last_name, email, phone, department_id, position, hire_date,
              termination_date, status, pay_type, hourly_rate, notes)
  on public.employees to authenticated;
grant update (employee_number, first_name, last_name, email, phone, department_id, position, hire_date,
              termination_date, status, pay_type, hourly_rate, notes, updated_at)
  on public.employees to authenticated;
grant select on public.time_punches, public.punch_corrections, public.leave_requests, public.workforce_events to authenticated;
grant select, insert, update, delete on public.work_shifts to authenticated;

drop policy if exists ba_wf_settings_select on public.workforce_settings;
create policy ba_wf_settings_select on public.workforce_settings for select to authenticated
  using (public.is_company_member(company_id)
         or exists (select 1 from public.employees e where e.company_id = workforce_settings.company_id and e.user_id = (select auth.uid())));
drop policy if exists ba_wf_settings_write on public.workforce_settings;
create policy ba_wf_settings_write on public.workforce_settings for insert to authenticated with check (public.wf_manages(company_id));
drop policy if exists ba_wf_settings_update on public.workforce_settings;
create policy ba_wf_settings_update on public.workforce_settings for update to authenticated
  using (public.wf_manages(company_id)) with check (public.wf_manages(company_id));

drop policy if exists ba_departments_select on public.departments;
create policy ba_departments_select on public.departments for select to authenticated using (public.is_company_member(company_id));
drop policy if exists ba_departments_insert on public.departments;
create policy ba_departments_insert on public.departments for insert to authenticated with check (public.wf_manages(company_id));
drop policy if exists ba_departments_update on public.departments;
create policy ba_departments_update on public.departments for update to authenticated
  using (public.wf_manages(company_id)) with check (public.wf_manages(company_id));

drop policy if exists ba_dept_sup_select on public.department_supervisors;
create policy ba_dept_sup_select on public.department_supervisors for select to authenticated using (public.is_company_member(company_id));
drop policy if exists ba_dept_sup_insert on public.department_supervisors;
create policy ba_dept_sup_insert on public.department_supervisors for insert to authenticated
  with check (public.wf_manages(company_id)
              and exists (select 1 from public.departments d where d.id = department_id and d.company_id = department_supervisors.company_id)
              and exists (select 1 from public.memberships m where m.company_id = department_supervisors.company_id
                            and m.user_id = department_supervisors.user_id and m.status = 'active'));
drop policy if exists ba_dept_sup_delete on public.department_supervisors;
create policy ba_dept_sup_delete on public.department_supervisors for delete to authenticated using (public.wf_manages(company_id));

drop policy if exists ba_employees_select on public.employees;
create policy ba_employees_select on public.employees for select to authenticated
  using (public.wf_supervises(id) or user_id = (select auth.uid()));
drop policy if exists ba_employees_insert on public.employees;
create policy ba_employees_insert on public.employees for insert to authenticated
  with check (public.wf_manages(company_id)
              and (department_id is null or exists (select 1 from public.departments d where d.id = department_id and d.company_id = employees.company_id)));
drop policy if exists ba_employees_update on public.employees;
create policy ba_employees_update on public.employees for update to authenticated
  using (public.wf_manages(company_id))
  with check (public.wf_manages(company_id)
              and (department_id is null or exists (select 1 from public.departments d where d.id = department_id and d.company_id = employees.company_id)));

drop policy if exists ba_punches_select on public.time_punches;
create policy ba_punches_select on public.time_punches for select to authenticated
  using (public.wf_supervises(employee_id) or public.wf_is_self(employee_id));
drop policy if exists ba_corrections_select on public.punch_corrections;
create policy ba_corrections_select on public.punch_corrections for select to authenticated
  using (public.wf_supervises(employee_id) or public.wf_is_self(employee_id));
drop policy if exists ba_leave_select on public.leave_requests;
create policy ba_leave_select on public.leave_requests for select to authenticated
  using (public.wf_supervises(employee_id) or public.wf_is_self(employee_id));
drop policy if exists ba_wf_events_select on public.workforce_events;
create policy ba_wf_events_select on public.workforce_events for select to authenticated
  using (public.wf_manages(company_id) or (employee_id is not null and public.wf_supervises(employee_id)));

drop policy if exists ba_shifts_select on public.work_shifts;
create policy ba_shifts_select on public.work_shifts for select to authenticated
  using (public.wf_supervises(employee_id) or public.wf_is_self(employee_id));
drop policy if exists ba_shifts_insert on public.work_shifts;
create policy ba_shifts_insert on public.work_shifts for insert to authenticated
  with check (public.wf_supervises(employee_id)
              and exists (select 1 from public.employees e where e.id = employee_id and e.company_id = work_shifts.company_id));
drop policy if exists ba_shifts_update on public.work_shifts;
create policy ba_shifts_update on public.work_shifts for update to authenticated
  using (public.wf_supervises(employee_id)) with check (public.wf_supervises(employee_id));
drop policy if exists ba_shifts_delete on public.work_shifts;
create policy ba_shifts_delete on public.work_shifts for delete to authenticated using (public.wf_supervises(employee_id));

-- ------------------------------------------------------------ triggers
do $$
declare t text;
begin
  foreach t in array array['workforce_settings', 'departments', 'department_supervisors', 'employees', 'time_punches',
                           'punch_corrections', 'leave_requests', 'work_shifts']
  loop
    execute format('drop trigger if exists ba_company_immutable on public.%I', t);
    execute format('create trigger ba_company_immutable before update on public.%I for each row execute function public.forbid_company_change()', t);
  end loop;
end $$;

-- Employees: plan limit on creation and reactivation; who created; the
-- login link (user_id) changes only through claim/revoke_employee_access.
create or replace function public.wf_employee_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id and (select auth.uid()) is not null
     and coalesce(current_setting('ba.wf_link', true), '') <> 'on' then
    raise exception 'EMPLOYEE_LINK_LOCKED' using errcode = 'P0001';
  end if;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') then
    perform pg_advisory_xact_lock(hashtextextended('ba_feature:' || new.company_id::text || ':employees', 0));
    select * into r from public.wf_feature(new.company_id, 'employees');
    if not r.available then
      raise exception 'PLAN_FEATURE_UNAVAILABLE' using errcode = 'P0001', hint = 'employees';
    end if;
    if r.max_allowed is not null and r.used >= r.max_allowed then
      raise exception 'PLAN_LIMIT_EMPLOYEES' using errcode = 'P0001', hint = r.max_allowed::text;
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    if (select auth.uid()) is not null then
      new.user_id := null;
      new.access_token_hash := null;
      new.access_expires_at := null;
    end if;
  else
    new.updated_at := now();
  end if;
  if new.status = 'terminated' and new.termination_date is null then
    new.termination_date := (now() at time zone 'America/Puerto_Rico')::date;
  end if;
  return new;
end $$;
drop trigger if exists ba_wf_employee_guard on public.employees;
create trigger ba_wf_employee_guard before insert or update on public.employees
  for each row execute function public.wf_employee_guard();

-- Shifts: no overlap per employee; who created.
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
drop trigger if exists ba_wf_shift_guard on public.work_shifts;
create trigger ba_wf_shift_guard before insert or update on public.work_shifts
  for each row execute function public.wf_shift_guard();

-- History for direct writes (employees, shifts, settings, departments).
create or replace function public.wf_log_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  changed text[];
begin
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
do $$
declare t text;
begin
  foreach t in array array['employees', 'work_shifts', 'workforce_settings', 'departments']
  loop
    execute format('drop trigger if exists ba_wf_log_row on public.%I', t);
    execute format('create trigger ba_wf_log_row after insert or update or delete on public.%I for each row execute function public.wf_log_row()', t);
  end loop;
end $$;

-- ------------------------------------------------------------ time clock
-- The valid order of punches: in → (break_start → break_end)* → out.
create or replace function public.wf_next_ok(prev text, kind text)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when prev is null or prev = 'out' then kind = 'in'
    when prev in ('in', 'break_end') then kind in ('break_start', 'out')
    when prev = 'break_start' then kind = 'break_end'
    else false end
$$;

-- The whole history of an employee is a valid sequence with strictly
-- increasing times (checked after every change).
create or replace function public.wf_sequence_ok(emp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with p as (
    select kind, at, lag(kind) over w as prev, lag(at) over w as prev_at
    from public.time_punches where employee_id = emp and voided_at is null
    window w as (order by at, created_at, id)
  )
  select not exists (select 1 from p where not public.wf_next_ok(prev, kind) or (prev_at is not null and at <= prev_at))
$$;

-- Last valid punch of an employee.
create or replace function public.wf_last_kind(emp uuid)
returns text language sql stable security definer set search_path = '' as $$
  select kind from public.time_punches where employee_id = emp and voided_at is null order by at desc, created_at desc, id desc limit 1
$$;

-- Self punch (the employee's own login) or a supervisor punching for the
-- employee right now (kiosk / forgotten phone). Time = server time.
create or replace function public.punch(emp uuid, punch_kind text, punch_note text default null)
returns table (punch_id uuid, punched_at timestamptz, state text)
language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  src text;
  pid uuid;
  t timestamptz := clock_timestamp();   -- server time of THIS punch (strictly increasing)
  f record;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if public.wf_is_self(emp) then
    src := 'self';
  elsif public.wf_supervises(emp) then
    src := 'supervisor';
  else
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if punch_kind not in ('in', 'out', 'break_start', 'break_end') then
    raise exception 'PUNCH_KIND_INVALID' using errcode = 'P0001';
  end if;
  -- One punch at a time per employee: simultaneous taps are serialised.
  perform pg_advisory_xact_lock(hashtextextended('ba_punch:' || emp::text, 0));
  select * into e from public.employees where id = emp;
  if e.status <> 'active' then
    raise exception 'EMPLOYEE_INACTIVE' using errcode = 'P0001';
  end if;
  select * into f from public.wf_feature(e.company_id, 'time_clock');
  if not f.available then
    raise exception 'TIME_CLOCK_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if not public.wf_next_ok(public.wf_last_kind(emp), punch_kind) then
    raise exception 'PUNCH_SEQUENCE' using errcode = 'P0001', hint = coalesce(public.wf_last_kind(emp), 'none');
  end if;
  if exists (select 1 from public.time_punches where employee_id = emp and voided_at is null and at >= t) then
    raise exception 'PUNCH_SEQUENCE' using errcode = 'P0001', hint = 'future punch exists';
  end if;
  insert into public.time_punches (company_id, employee_id, kind, at, source, recorded_by, note)
  values (e.company_id, emp, punch_kind, t, src, (select auth.uid()), nullif(btrim(coalesce(punch_note, '')), ''))
  returning id into pid;
  perform public.wf_log(e.company_id, emp, 'time_punches', pid::text, 'punch', jsonb_build_object('kind', punch_kind, 'source', src));
  punch_id := pid; punched_at := t; state := punch_kind;
  return next;
end $$;

-- ------------------------------------------------------------ corrections
create or replace function public.request_punch_correction(emp uuid, corr_action text, target_punch uuid, corr_kind text,
                                                           corr_at timestamptz, corr_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  p public.time_punches;
  cid uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not (public.wf_is_self(emp) or public.wf_supervises(emp)) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  select * into e from public.employees where id = emp;
  if corr_action not in ('add', 'void', 'change') then
    raise exception 'CORRECTION_INVALID' using errcode = 'P0001';
  end if;
  if corr_action in ('void', 'change') then
    select * into p from public.time_punches where id = target_punch and employee_id = emp and voided_at is null;
    if not found then
      raise exception 'PUNCH_NOT_FOUND' using errcode = 'P0001';
    end if;
  end if;
  if corr_action in ('add', 'change') then
    if corr_kind not in ('in', 'out', 'break_start', 'break_end') or corr_at is null then
      raise exception 'CORRECTION_INVALID' using errcode = 'P0001';
    end if;
    if corr_at > clock_timestamp() or corr_at < now() - interval '62 days'
       or (e.hire_date is not null and corr_at < e.hire_date::timestamp at time zone 'America/Puerto_Rico' - interval '1 day') then
      raise exception 'CORRECTION_TIME_INVALID' using errcode = 'P0001';
    end if;
  end if;
  if char_length(btrim(coalesce(corr_reason, ''))) not between 3 and 300 then
    raise exception 'CORRECTION_REASON_REQUIRED' using errcode = 'P0001';
  end if;
  if (select count(*) from public.punch_corrections where employee_id = emp and status = 'pending') >= 20 then
    raise exception 'CORRECTION_LIMIT' using errcode = 'P0001';
  end if;
  insert into public.punch_corrections (company_id, employee_id, action, punch_id, kind, at, reason, requested_by)
  values (e.company_id, emp, corr_action, case when corr_action = 'add' then null else target_punch end,
          case when corr_action = 'void' then null else corr_kind end,
          case when corr_action = 'void' then null else corr_at end, btrim(corr_reason), (select auth.uid()))
  returning id into cid;
  perform public.wf_log(e.company_id, emp, 'punch_corrections', cid::text, 'requested', jsonb_build_object('action', corr_action));
  return cid;
end $$;

-- Approve (apply) or reject. Never the employee concerned; never the
-- requester unless the requester is a supervisor correcting SOMEONE ELSE.
create or replace function public.decide_punch_correction(correction uuid, approve boolean, note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.punch_corrections;
  uid uuid := (select auth.uid());
  pid uuid;
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into c from public.punch_corrections where id = correction for update;
  if not found or not public.wf_supervises(c.employee_id) then
    raise exception 'CORRECTION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if public.wf_is_self(c.employee_id) then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0001';
  end if;
  if c.status <> 'pending' then
    raise exception 'CORRECTION_NOT_PENDING' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_punch:' || c.employee_id::text, 0));
  if approve then
    if c.action in ('void', 'change') then
      update public.time_punches set voided_at = now(), voided_by = uid, void_reason = c.reason
       where id = c.punch_id and voided_at is null;
      if not found then
        raise exception 'PUNCH_NOT_FOUND' using errcode = 'P0001';
      end if;
    end if;
    if c.action in ('add', 'change') then
      insert into public.time_punches (company_id, employee_id, kind, at, source, recorded_by, note, correction_id)
      values (c.company_id, c.employee_id, c.kind, c.at, 'correction', uid, left(c.reason, 300), c.id)
      returning id into pid;
    end if;
    if not public.wf_sequence_ok(c.employee_id) then
      raise exception 'CORRECTION_INVALID_SEQUENCE' using errcode = 'P0001',
        detail = 'The punches would not form a valid in / break / out sequence.';
    end if;
  end if;
  update public.punch_corrections
     set status = case when approve then 'approved' else 'rejected' end, decided_by = uid, decided_at = now(),
         decision_note = nullif(left(btrim(coalesce(note, '')), 300), '')
   where id = c.id;
  perform public.wf_log(c.company_id, c.employee_id, 'punch_corrections', c.id::text,
                        case when approve then 'approved' else 'rejected' end,
                        jsonb_build_object('action', c.action, 'self_requested', c.requested_by = uid));
end $$;

create or replace function public.cancel_punch_correction(correction uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.punch_corrections;
begin
  select * into c from public.punch_corrections where id = correction for update;
  if not found or c.requested_by is distinct from (select auth.uid()) then
    raise exception 'CORRECTION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if c.status <> 'pending' then
    raise exception 'CORRECTION_NOT_PENDING' using errcode = 'P0001';
  end if;
  update public.punch_corrections set status = 'cancelled', decided_at = now() where id = c.id;
  perform public.wf_log(c.company_id, c.employee_id, 'punch_corrections', c.id::text, 'cancelled', '{}');
end $$;

-- ------------------------------------------------------------ leave
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

create or replace function public.decide_leave(request uuid, approve boolean, note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  l public.leave_requests;
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into l from public.leave_requests where id = request for update;
  if not found or not public.wf_supervises(l.employee_id) then
    raise exception 'LEAVE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if public.wf_is_self(l.employee_id) then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = 'P0001';
  end if;
  if l.status <> 'pending' then
    raise exception 'LEAVE_NOT_PENDING' using errcode = 'P0001';
  end if;
  update public.leave_requests set status = case when approve then 'approved' else 'rejected' end,
         decided_by = uid, decided_at = now(), decision_note = nullif(left(btrim(coalesce(note, '')), 300), '')
   where id = l.id;
  perform public.wf_log(l.company_id, l.employee_id, 'leave_requests', l.id::text, case when approve then 'approved' else 'rejected' end, '{}');
end $$;

create or replace function public.cancel_leave(request uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare l public.leave_requests;
begin
  select * into l from public.leave_requests where id = request for update;
  if not found or not (l.requested_by = (select auth.uid()) or public.wf_supervises(l.employee_id)) then
    raise exception 'LEAVE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if l.status not in ('pending', 'approved') then
    raise exception 'LEAVE_NOT_PENDING' using errcode = 'P0001';
  end if;
  -- An employee cannot cancel an APPROVED leave alone (a supervisor does).
  if l.status = 'approved' and not public.wf_supervises(l.employee_id) then
    raise exception 'LEAVE_NOT_PENDING' using errcode = 'P0001';
  end if;
  update public.leave_requests set status = 'cancelled', decided_at = now(), decided_by = (select auth.uid()) where id = l.id;
  perform public.wf_log(l.company_id, l.employee_id, 'leave_requests', l.id::text, 'cancelled', '{}');
end $$;

-- ------------------------------------------------------------ employee login link
-- A manager creates a one-time link (7 days) for the employee's email; the
-- login with that same email claims it. Only the SHA-256 is stored.
create or replace function public.create_employee_access(emp uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  raw text;
begin
  select * into e from public.employees where id = emp for update;
  if not found or not public.wf_manages(e.company_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if e.email is null then
    raise exception 'EMPLOYEE_EMAIL_REQUIRED' using errcode = 'P0001';
  end if;
  if e.status <> 'active' then
    raise exception 'EMPLOYEE_INACTIVE' using errcode = 'P0001';
  end if;
  raw := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
  update public.employees set access_token_hash = encode(sha256(convert_to(raw, 'UTF8')), 'hex'),
         access_expires_at = now() + interval '7 days' where id = emp;
  perform public.wf_log(e.company_id, emp, 'employees', emp::text, 'access_link_created', '{}');
  return raw;
end $$;

create or replace function public.claim_employee_access(raw_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  uid uuid := (select auth.uid());
  mail text;
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if raw_token is null or raw_token !~ '^[0-9a-f]{64}$' then
    raise exception 'ACCESS_INVALID' using errcode = 'P0001';
  end if;
  select * into e from public.employees where access_token_hash = encode(sha256(convert_to(raw_token, 'UTF8')), 'hex') for update;
  if not found then
    raise exception 'ACCESS_INVALID' using errcode = 'P0001';
  end if;
  if e.access_expires_at <= now() or e.status <> 'active' then
    raise exception 'ACCESS_EXPIRED' using errcode = 'P0001';
  end if;
  select lower(btrim(u.email)) into mail from auth.users u where u.id = uid;
  if mail is distinct from e.email then
    raise exception 'ACCESS_EMAIL_MISMATCH' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.employees x where x.company_id = e.company_id and x.user_id = uid and x.id <> e.id) then
    raise exception 'ACCESS_ALREADY_LINKED' using errcode = 'P0001';
  end if;
  perform set_config('ba.wf_link', 'on', true);
  update public.employees set user_id = uid, access_token_hash = null, access_expires_at = null where id = e.id;
  perform set_config('ba.wf_link', '', true);
  perform public.wf_log(e.company_id, e.id, 'employees', e.id::text, 'access_linked', '{}');
  return e.id;
end $$;

-- Unlink a login (manager), e.g. a lost phone or a changed email.
create or replace function public.revoke_employee_access(emp uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.employees;
begin
  select * into e from public.employees where id = emp for update;
  if not found or not public.wf_manages(e.company_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform set_config('ba.wf_link', 'on', true);
  update public.employees set user_id = null, access_token_hash = null, access_expires_at = null where id = emp;
  perform set_config('ba.wf_link', '', true);
  perform public.wf_log(e.company_id, emp, 'employees', emp::text, 'access_revoked', '{}');
end $$;


-- Pay rate for managers only (the column is not granted to the API).
create or replace function public.employee_pay(emp uuid)
returns table (pay_type text, hourly_rate numeric)
language sql stable security definer set search_path = '' as $$
  select e.pay_type, e.hourly_rate from public.employees e where e.id = emp and public.wf_manages(e.company_id)
$$;

-- Who is clocked in / on break right now (live panel).
create or replace function public.workforce_now(target uuid)
returns table (employee_id uuid, state text, since timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.id, coalesce(lp.kind, 'out'), lp.at
  from public.employees e
  left join lateral (select p.kind, p.at from public.time_punches p
                     where p.employee_id = e.id and p.voided_at is null order by p.at desc, p.created_at desc, p.id desc limit 1) lp on true
  where e.company_id = target and e.status = 'active' and public.wf_supervises(e.id)
$$;


-- ------------------------------------------------------------ grants
do $$
declare f text;
begin
  foreach f in array array['wf_manages(uuid)', 'wf_supervises(uuid)', 'wf_is_self(uuid)', 'wf_log(uuid, uuid, text, text, text, jsonb)',
    'wf_feature(uuid, text)', 'wf_next_ok(text, text)', 'wf_sequence_ok(uuid)', 'wf_last_kind(uuid)',
    'wf_employee_guard()', 'wf_shift_guard()', 'wf_log_row()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['punch(uuid, text, text)', 'request_punch_correction(uuid, text, uuid, text, timestamptz, text)',
    'decide_punch_correction(uuid, boolean, text)', 'cancel_punch_correction(uuid)',
    'request_leave(uuid, text, date, date, integer, text)', 'decide_leave(uuid, boolean, text)', 'cancel_leave(uuid)',
    'create_employee_access(uuid)', 'claim_employee_access(text)', 'revoke_employee_access(uuid)',
    'employee_pay(uuid)', 'workforce_now(uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
-- RLS policies call these as the signed-in user.
grant execute on function public.wf_manages(uuid), public.wf_supervises(uuid), public.wf_is_self(uuid) to authenticated;

-- ------------------------------------------------------------ self-check
do $$
begin
  if has_table_privilege('authenticated', 'public.time_punches', 'INSERT')
     or has_table_privilege('authenticated', 'public.time_punches', 'UPDATE')
     or has_table_privilege('authenticated', 'public.time_punches', 'DELETE')
     or has_table_privilege('authenticated', 'public.punch_corrections', 'INSERT')
     or has_table_privilege('authenticated', 'public.punch_corrections', 'UPDATE')
     or has_table_privilege('authenticated', 'public.leave_requests', 'UPDATE')
     or has_table_privilege('authenticated', 'public.workforce_events', 'INSERT')
     or has_column_privilege('authenticated', 'public.employees', 'hourly_rate', 'SELECT')
     or has_column_privilege('authenticated', 'public.employees', 'access_token_hash', 'SELECT')
     or has_column_privilege('authenticated', 'public.employees', 'user_id', 'UPDATE')
     or has_table_privilege('anon', 'public.employees', 'SELECT') then
    raise exception 'BA0020 self-check failed: direct writes or sensitive columns exposed';
  end if;
  if exists (select 1 from public.role_permissions where role = 'member' and permission_key = 'workforce.manage') then
    raise exception 'BA0020 self-check failed: members cannot manage the workforce';
  end if;
end $$;

commit;
