-- =====================================================================
-- BusinessAI · Migration 0022 · Labor rules per employee / group,
-- jurisdiction templates, meal-period alerts
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0020 and 0021.
--
-- 1. JURISDICTIONS. public.labor_jurisdictions is a catalog of REFERENCE
--    templates (PR, US federal, US California, custom). Nothing is assumed:
--    a manager applies a template explicitly to the company defaults or to
--    a rule group, and every value stays editable. The templates are not
--    legal advice; the notes say so in both languages.
-- 2. RULE GROUPS. public.labor_rule_sets: named groups per company
--    (e.g. "Exentos", "Turno nocturno", "Convenio X") with their own
--    jurisdiction, overtime thresholds and multiplier, exemption from
--    overtime, and meal-period rules. employees.rule_set_id assigns an
--    employee to a group; without a group the company defaults apply
--    (workforce_settings, which now also carries jurisdiction and meal
--    rules). public.wf_rules(emp) resolves the rules of one employee.
-- 3. MEAL ALERTS. When meal rules are set (meal_break_after_minutes and
--    meal_break_min_minutes), continuous work without a qualifying break
--    raises 'approaching' (alert_before minutes earlier) and 'missed'
--    alerts, kept in public.meal_alerts (one per session and kind; append
--    only, except acknowledging: who and when). Alerts are evaluated after
--    every punch and by refresh_meal_alerts(company), which the live panel
--    calls while a supervisor or admin has it open. A scheduled job
--    (Supabase Cron) would evaluate them without anyone watching: it is not
--    configured (external service). Visible to the employee's supervisors,
--    the managers and the employee.
-- Rollback: supabase/rollback/0022_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.kiosk_punch(text, text, text, text)') is null then
    raise exception 'BA0022: migrations 0020 and 0021 must be applied first';
  end if;
end $$;

-- ------------------------------------------------------------ jurisdictions
create table if not exists public.labor_jurisdictions (
  code text primary key check (code ~ '^[A-Z]{2}(-[A-Z0-9]{1,8})?$|^CUSTOM$'),
  name_es text not null,
  name_en text not null,
  daily_overtime_after_minutes integer,
  weekly_overtime_after_minutes integer,
  overtime_multiplier numeric(4,2),
  meal_break_after_minutes integer,
  meal_break_min_minutes integer,
  note_es text not null,
  note_en text not null
);
alter table public.labor_jurisdictions enable row level security;
revoke all on public.labor_jurisdictions from public, anon, authenticated;
grant select on public.labor_jurisdictions to authenticated;
grant all on public.labor_jurisdictions to service_role;
drop policy if exists ba_labor_jurisdictions_select on public.labor_jurisdictions;
create policy ba_labor_jurisdictions_select on public.labor_jurisdictions for select to authenticated using (true);

insert into public.labor_jurisdictions (code, name_es, name_en, daily_overtime_after_minutes, weekly_overtime_after_minutes,
                                        overtime_multiplier, meal_break_after_minutes, meal_break_min_minutes, note_es, note_en) values
  ('PR', 'Puerto Rico (referencia general)', 'Puerto Rico (general reference)', 480, 2400, 1.5, 300, 60,
   'Referencia general: extras después de 8 h al día o 40 a la semana; periodo de comida antes de terminar la 5.ª hora. Hay excepciones (exentos, contratados antes de 2017, decretos, convenios, comidas de 30 minutos por acuerdo). No es asesoría legal.',
   'General reference: overtime after 8 h a day or 40 a week; meal period before the end of the 5th hour. Exceptions exist (exempt, hired before 2017, decrees, agreements, 30-minute meals by agreement). Not legal advice.'),
  ('US-FED', 'Estados Unidos — federal (referencia)', 'United States — federal (reference)', null, 2400, 1.5, null, null,
   'Referencia general federal: extras después de 40 h a la semana; sin regla federal general de comidas. Los estados pueden exigir más. No es asesoría legal.',
   'General federal reference: overtime after 40 h a week; no general federal meal rule. States may require more. Not legal advice.'),
  ('US-CA', 'California (referencia)', 'California (reference)', 480, 2400, 1.5, 300, 30,
   'Referencia general: extras después de 8 h al día o 40 a la semana (hay doble tiempo en algunos casos, no calculado aquí); comida de 30 minutos antes de la 5.ª hora. No es asesoría legal.',
   'General reference: overtime after 8 h a day or 40 a week (double time in some cases, not calculated here); 30-minute meal before the 5th hour. Not legal advice.'),
  ('CUSTOM', 'Personalizada', 'Custom', null, null, null, null, null,
   'Sin valores predeterminados: define tus propias reglas según tu jurisdicción y tus acuerdos.',
   'No default values: define your own rules for your jurisdiction and agreements.')
on conflict (code) do nothing;

-- ------------------------------------------------------------ company defaults
alter table public.workforce_settings add column if not exists jurisdiction text references public.labor_jurisdictions(code);
alter table public.workforce_settings add column if not exists meal_break_after_minutes integer
  check (meal_break_after_minutes is null or meal_break_after_minutes between 60 and 960);
alter table public.workforce_settings add column if not exists meal_break_min_minutes integer
  check (meal_break_min_minutes is null or meal_break_min_minutes between 10 and 180);
alter table public.workforce_settings add column if not exists meal_alert_before_minutes integer not null default 15
  check (meal_alert_before_minutes between 0 and 120);

-- ------------------------------------------------------------ rule groups
create table if not exists public.labor_rule_sets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  jurisdiction text references public.labor_jurisdictions(code),
  exempt boolean not null default false,
  daily_overtime_after_minutes integer check (daily_overtime_after_minutes is null or daily_overtime_after_minutes between 60 and 1440),
  weekly_overtime_after_minutes integer check (weekly_overtime_after_minutes is null or weekly_overtime_after_minutes between 60 and 10080),
  overtime_multiplier numeric(4,2) not null default 1.5 check (overtime_multiplier between 1 and 4),
  meal_break_after_minutes integer check (meal_break_after_minutes is null or meal_break_after_minutes between 60 and 960),
  meal_break_min_minutes integer check (meal_break_min_minutes is null or meal_break_min_minutes between 10 and 180),
  meal_alert_before_minutes integer not null default 15 check (meal_alert_before_minutes between 0 and 120),
  notes text check (notes is null or char_length(notes) <= 500),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);
-- Employees may belong to a group (added before the policies that use it).
alter table public.employees add column if not exists rule_set_id uuid references public.labor_rule_sets(id) on delete set null;
grant select (rule_set_id), insert (rule_set_id), update (rule_set_id) on public.employees to authenticated;
alter table public.labor_rule_sets enable row level security;
revoke all on public.labor_rule_sets from public, anon, authenticated;
grant select, insert, update on public.labor_rule_sets to authenticated;
grant all on public.labor_rule_sets to service_role;
drop policy if exists ba_rule_sets_select on public.labor_rule_sets;
create policy ba_rule_sets_select on public.labor_rule_sets for select to authenticated
  using (public.is_company_member(company_id)
         or exists (select 1 from public.employees e where e.rule_set_id = labor_rule_sets.id and e.user_id = (select auth.uid())));
drop policy if exists ba_rule_sets_insert on public.labor_rule_sets;
create policy ba_rule_sets_insert on public.labor_rule_sets for insert to authenticated with check (public.wf_manages(company_id));
drop policy if exists ba_rule_sets_update on public.labor_rule_sets;
create policy ba_rule_sets_update on public.labor_rule_sets for update to authenticated
  using (public.wf_manages(company_id)) with check (public.wf_manages(company_id));
drop trigger if exists ba_company_immutable on public.labor_rule_sets;
create trigger ba_company_immutable before update on public.labor_rule_sets for each row execute function public.forbid_company_change();
drop trigger if exists ba_wf_log_row on public.labor_rule_sets;
create trigger ba_wf_log_row after insert or update or delete on public.labor_rule_sets for each row execute function public.wf_log_row();


-- A group must belong to the employee's company.
create or replace function public.wf_rule_set_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.rule_set_id is not null and not exists (select 1 from public.labor_rule_sets r where r.id = new.rule_set_id and r.company_id = new.company_id) then
    raise exception 'RULE_SET_INVALID' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ba_wf_rule_set_guard on public.employees;
create trigger ba_wf_rule_set_guard before insert or update of rule_set_id on public.employees
  for each row execute function public.wf_rule_set_guard();

-- Rules of one employee: its group, else the company defaults.
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

-- Apply a reference template (explicit action; values stay editable).
create or replace function public.apply_jurisdiction_template(target uuid, code text, rule_set uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.labor_jurisdictions;
begin
  if not public.wf_manages(target) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into j from public.labor_jurisdictions where labor_jurisdictions.code = apply_jurisdiction_template.code;
  if not found then
    raise exception 'JURISDICTION_INVALID' using errcode = 'P0001';
  end if;
  if rule_set is null then
    insert into public.workforce_settings (company_id, jurisdiction, daily_overtime_after_minutes, weekly_overtime_after_minutes,
                                           overtime_multiplier, meal_break_after_minutes, meal_break_min_minutes, updated_by)
    values (target, j.code, j.daily_overtime_after_minutes, j.weekly_overtime_after_minutes, coalesce(j.overtime_multiplier, 1.5),
            j.meal_break_after_minutes, j.meal_break_min_minutes, (select auth.uid()))
    on conflict (company_id) do update set jurisdiction = excluded.jurisdiction,
      daily_overtime_after_minutes = excluded.daily_overtime_after_minutes, weekly_overtime_after_minutes = excluded.weekly_overtime_after_minutes,
      overtime_multiplier = excluded.overtime_multiplier, meal_break_after_minutes = excluded.meal_break_after_minutes,
      meal_break_min_minutes = excluded.meal_break_min_minutes, updated_by = excluded.updated_by, updated_at = now();
  else
    update public.labor_rule_sets set jurisdiction = j.code, daily_overtime_after_minutes = j.daily_overtime_after_minutes,
      weekly_overtime_after_minutes = j.weekly_overtime_after_minutes, overtime_multiplier = coalesce(j.overtime_multiplier, 1.5),
      meal_break_after_minutes = j.meal_break_after_minutes, meal_break_min_minutes = j.meal_break_min_minutes, updated_at = now()
     where id = rule_set and company_id = target;
    if not found then
      raise exception 'RULE_SET_INVALID' using errcode = 'P0001';
    end if;
  end if;
  perform public.wf_log(target, null, 'labor_jurisdictions', j.code, 'template_applied', jsonb_build_object('rule_set', rule_set));
end $$;

-- ------------------------------------------------------------ meal alerts
create table if not exists public.meal_alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  session_start timestamptz not null,
  kind text not null check (kind in ('approaching', 'missed')),
  due_at timestamptz not null,
  detected_at timestamptz not null default now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  note text check (note is null or char_length(note) <= 300),
  unique (employee_id, session_start, kind)
);
create index if not exists meal_alerts_company_idx on public.meal_alerts (company_id, detected_at desc);
alter table public.meal_alerts enable row level security;
revoke all on public.meal_alerts from public, anon, authenticated;
grant select on public.meal_alerts to authenticated;
grant all on public.meal_alerts to service_role;
drop policy if exists ba_meal_alerts_select on public.meal_alerts;
create policy ba_meal_alerts_select on public.meal_alerts for select to authenticated
  using (public.wf_supervises(employee_id) or public.wf_is_self(employee_id));

-- Append-only, except acknowledging once.
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
drop trigger if exists ba_wf_meal_alert_guard on public.meal_alerts;
create trigger ba_wf_meal_alert_guard before update or delete on public.meal_alerts
  for each row execute function public.wf_meal_alert_guard();

-- The current (or last) session of an employee and its longest stretch of
-- work without a qualifying meal break. Returns null when no meal rule.
create or replace function public.wf_meal_eval(emp uuid, at_time timestamptz)
returns table (session_start timestamptz, kind text, due_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  r record;
  p record;
  start_at timestamptz;
  seg_start timestamptz;
  brk timestamptz;
  open_session boolean := true;
  worst_due timestamptz;
  missed boolean := false;
begin
  select * into r from public.wf_rules(emp);
  if r.meal_break_after_minutes is null or r.meal_break_min_minutes is null then
    return;
  end if;
  select max(tp.at) into start_at from public.time_punches tp where tp.employee_id = emp and tp.kind = 'in' and tp.voided_at is null and tp.at <= at_time;
  if start_at is null then return; end if;
  seg_start := start_at;
  for p in select tp.kind, tp.at from public.time_punches tp
            where tp.employee_id = emp and tp.voided_at is null and tp.at > start_at and tp.at <= at_time order by tp.at loop
    if p.kind = 'break_start' then
      if p.at - seg_start >= make_interval(mins => r.meal_break_after_minutes) then
        missed := true; worst_due := coalesce(worst_due, seg_start + make_interval(mins => r.meal_break_after_minutes));
      end if;
      brk := p.at;
    elsif p.kind = 'break_end' and brk is not null then
      if p.at - brk >= make_interval(mins => r.meal_break_min_minutes) then
        seg_start := p.at;           -- a qualifying meal resets the count
      end if;
      brk := null;
    elsif p.kind = 'out' then
      if brk is null and p.at - seg_start >= make_interval(mins => r.meal_break_after_minutes) then
        missed := true; worst_due := coalesce(worst_due, seg_start + make_interval(mins => r.meal_break_after_minutes));
      end if;
      open_session := false;
    end if;
  end loop;
  session_start := start_at;
  if missed then
    kind := 'missed'; due_at := worst_due; return next; return;
  end if;
  if open_session and brk is null then
    if at_time - seg_start >= make_interval(mins => r.meal_break_after_minutes) then
      kind := 'missed'; due_at := seg_start + make_interval(mins => r.meal_break_after_minutes); return next;
    elsif at_time - seg_start >= make_interval(mins => greatest(r.meal_break_after_minutes - r.meal_alert_before_minutes, 0)) then
      kind := 'approaching'; due_at := seg_start + make_interval(mins => r.meal_break_after_minutes); return next;
    end if;
  end if;
end $$;

create or replace function public.wf_meal_record(emp uuid, at_time timestamptz)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m record;
  n integer := 0;
  e public.employees;
begin
  select * into e from public.employees where id = emp;
  for m in select * from public.wf_meal_eval(emp, at_time) loop
    insert into public.meal_alerts (company_id, employee_id, session_start, kind, due_at)
    values (e.company_id, emp, m.session_start, m.kind, m.due_at)
    on conflict (employee_id, session_start, kind) do nothing;
    if found then
      n := n + 1;
      perform public.wf_log(e.company_id, emp, 'meal_alerts', emp::text, 'meal_' || m.kind, jsonb_build_object('due_at', m.due_at));
    end if;
  end loop;
  return n;
end $$;

-- After every punch (self, supervisor, kiosk, correction).
create or replace function public.wf_meal_after_punch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.wf_meal_record(new.employee_id, greatest(new.at, clock_timestamp()));
  return null;
end $$;
drop trigger if exists ba_wf_meal_after_punch on public.time_punches;
create trigger ba_wf_meal_after_punch after insert on public.time_punches
  for each row execute function public.wf_meal_after_punch();

-- Live panel: evaluate every employee the caller supervises (open sessions).
create or replace function public.refresh_meal_alerts(target uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  e record;
  n integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  for e in select x.id from public.employees x where x.company_id = target and x.status = 'active' and public.wf_supervises(x.id) loop
    n := n + public.wf_meal_record(e.id, clock_timestamp());
  end loop;
  return n;
end $$;

create or replace function public.acknowledge_meal_alert(alert uuid, ack_note text default null)
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
  if a.acknowledged_at is null then
    update public.meal_alerts set acknowledged_by = (select auth.uid()), acknowledged_at = now(),
           note = nullif(left(btrim(coalesce(ack_note, '')), 300), '') where id = a.id;
    perform public.wf_log(a.company_id, a.employee_id, 'meal_alerts', a.id::text, 'acknowledged', '{}');
  end if;
end $$;

-- ------------------------------------------------------------ grants
do $$
declare f text;
begin
  foreach f in array array['wf_rule_set_guard()', 'wf_meal_eval(uuid, timestamptz)', 'wf_meal_record(uuid, timestamptz)',
                           'wf_meal_after_punch()', 'wf_meal_alert_guard()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['wf_rules(uuid)', 'apply_jurisdiction_template(uuid, text, uuid)', 'refresh_meal_alerts(uuid)',
                           'acknowledge_meal_alert(uuid, text)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

do $$ begin
  if (select count(*) from public.labor_jurisdictions) < 4 then
    raise exception 'BA0022 self-check failed: jurisdiction catalog';
  end if;
  if has_table_privilege('authenticated', 'public.meal_alerts', 'INSERT') or has_table_privilege('authenticated', 'public.meal_alerts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.labor_jurisdictions', 'INSERT') then
    raise exception 'BA0022 self-check failed: privileges';
  end if;
end $$;

commit;
