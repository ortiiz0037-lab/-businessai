-- Rollback of 0022 (rules per employee / group, jurisdictions, meal alerts).
-- Refuses, changing nothing, while meal alerts exist (they are attendance
-- evidence) or any employee is assigned to a rule group (its overtime would
-- silently change to the company defaults). Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.meal_alerts') is not null and exists (select 1 from public.meal_alerts) then
    raise exception 'BA0022 rollback: meal alerts exist; nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'rule_set_id')
     and exists (select 1 from public.employees where rule_set_id is not null) then
    raise exception 'BA0022 rollback: employees are assigned to rule groups; nothing was changed.';
  end if;
end $$;
drop trigger if exists ba_wf_meal_after_punch on public.time_punches;
drop function if exists public.acknowledge_meal_alert(uuid, text);
drop function if exists public.refresh_meal_alerts(uuid);
drop function if exists public.wf_meal_after_punch();
drop function if exists public.wf_meal_record(uuid, timestamptz);
drop function if exists public.wf_meal_eval(uuid, timestamptz);
drop table if exists public.meal_alerts;
drop function if exists public.wf_meal_alert_guard();
drop function if exists public.apply_jurisdiction_template(uuid, text, uuid);
drop function if exists public.wf_rules(uuid);
drop trigger if exists ba_wf_rule_set_guard on public.employees;
drop function if exists public.wf_rule_set_guard();
alter table public.employees drop constraint if exists employees_rule_set_id_fkey;
drop table if exists public.labor_rule_sets;
alter table public.employees drop column if exists rule_set_id;
alter table public.workforce_settings drop column if exists meal_alert_before_minutes;
alter table public.workforce_settings drop column if exists meal_break_min_minutes;
alter table public.workforce_settings drop column if exists meal_break_after_minutes;
alter table public.workforce_settings drop column if exists jurisdiction;
drop table if exists public.labor_jurisdictions;
commit;
