-- Rollback of 0021 (kiosk PIN mode, append-only evidence). Refuses,
-- changing nothing, while any punch was made at a kiosk (the source and
-- kiosk_id are evidence). Kiosks and PINs are configuration: they are
-- dropped (employees punch with their own login or a supervisor again).
-- Restores 0020's cancel_punch_correction. Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.time_clock_kiosks') is not null and exists (select 1 from public.time_punches where source = 'kiosk') then
    raise exception 'BA0021 rollback: punches made at kiosks exist; nothing was changed.';
  end if;
end $$;
do $$
declare t text;
begin
  foreach t in array array['workforce_events', 'time_punches', 'punch_corrections', 'leave_requests']
  loop
    execute format('drop trigger if exists ba_wf_append_only on public.%I', t);
  end loop;
end $$;
drop function if exists public.wf_append_only();
drop function if exists public.wf_company_gone(uuid);
drop function if exists public.kiosk_punch(text, text, text, text);
drop function if exists public.kiosk_info(text);
drop function if exists public.revoke_kiosk(uuid);
drop function if exists public.create_kiosk(uuid, text);
drop function if exists public.employee_pin_status(uuid);
drop function if exists public.clear_employee_pin(uuid);
drop function if exists public.set_employee_pin(uuid, text);
drop function if exists public.wf_pin_trivial(text);
drop function if exists public.wf_pin_hash(text, text);
alter table public.time_punches drop constraint if exists time_punches_source_check;
alter table public.time_punches add constraint time_punches_source_check check (source in ('self', 'supervisor', 'correction'));
alter table public.time_punches drop column if exists kiosk_id;
drop table if exists public.employee_pins;
drop table if exists public.time_clock_kiosks;
-- 0020 version
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
revoke all on function public.cancel_punch_correction(uuid) from public, anon;
grant execute on function public.cancel_punch_correction(uuid) to authenticated, service_role;
commit;
