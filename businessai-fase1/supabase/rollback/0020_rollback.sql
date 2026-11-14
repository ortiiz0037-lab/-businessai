-- Rollback of 0020 (workforce). Attendance records are legal and payroll
-- evidence: this rollback REFUSES, changing nothing, while any employee,
-- punch, correction, leave request or shift exists. Export them first
-- (reports → CSV) and decide what to keep. With no workforce data it
-- removes every 0020 object and the workforce.manage permission.
-- Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.employees') is not null and (
       exists (select 1 from public.employees) or exists (select 1 from public.time_punches)
       or exists (select 1 from public.punch_corrections) or exists (select 1 from public.leave_requests)
       or exists (select 1 from public.work_shifts)) then
    raise exception 'BA0020 rollback: workforce data exists (employees / punches / requests / shifts); export it first. Nothing was changed.';
  end if;
end $$;
drop function if exists public.punch(uuid, text, text);
drop function if exists public.request_punch_correction(uuid, text, uuid, text, timestamptz, text);
drop function if exists public.decide_punch_correction(uuid, boolean, text);
drop function if exists public.cancel_punch_correction(uuid);
drop function if exists public.request_leave(uuid, text, date, date, integer, text);
drop function if exists public.decide_leave(uuid, boolean, text);
drop function if exists public.cancel_leave(uuid);
drop function if exists public.create_employee_access(uuid);
drop function if exists public.claim_employee_access(text);
drop function if exists public.revoke_employee_access(uuid);
drop function if exists public.employee_pay(uuid);
drop function if exists public.workforce_now(uuid);
drop table if exists public.workforce_settings;   -- its policy refers to employees
drop table if exists public.workforce_events;
drop table if exists public.work_shifts;
drop table if exists public.leave_requests;
drop table if exists public.punch_corrections;
drop table if exists public.time_punches;
drop table if exists public.employees;
drop table if exists public.department_supervisors;
drop table if exists public.departments;
drop function if exists public.wf_sequence_ok(uuid);
drop function if exists public.wf_last_kind(uuid);
drop function if exists public.wf_next_ok(text, text);
drop function if exists public.wf_employee_guard();
drop function if exists public.wf_shift_guard();
drop function if exists public.wf_log_row();
drop function if exists public.wf_feature(uuid, text);
drop function if exists public.wf_log(uuid, uuid, text, text, text, jsonb);
drop function if exists public.wf_is_self(uuid);
drop function if exists public.wf_supervises(uuid);
drop function if exists public.wf_manages(uuid);
delete from public.role_permissions where permission_key = 'workforce.manage';
delete from public.permissions where key = 'workforce.manage';
commit;
