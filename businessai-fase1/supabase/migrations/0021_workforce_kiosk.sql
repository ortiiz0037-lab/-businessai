-- =====================================================================
-- BusinessAI · Migration 0021 · Shared-tablet PIN mode and append-only
-- attendance evidence
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0020.
--
-- 1. KIOSKS (shared tablets). A manager registers a tablet and gets a
--    256-bit setup token ONCE (only its SHA-256 is stored); the tablet keeps
--    it in an httpOnly cookie. Nobody signs in on the tablet: it carries no
--    user account, so a stolen tablet exposes no account and no data.
--    Revoking the kiosk stops it immediately.
-- 2. PINs. An employee punches at a kiosk with employee number + a 6-digit
--    PIN (owner decision: exactly 6 digits, mandatory) (set by the employee at /clock or by a manager). The PIN is stored
--    as a salted, iterated SHA-256 (5,000 rounds) in a table no API role can
--    read. Trivial PINs (all equal digits, ascending / descending runs) are
--    refused.
-- 3. BRUTE FORCE. 5 failed attempts lock that employee's PIN for 15 minutes;
--    20 failures in 10 minutes lock the kiosk for 10 minutes. The kiosk
--    function RETURNS a status instead of raising, so failure counters are
--    really stored. The answer is the same for "unknown number", "wrong PIN"
--    and "locked": a kiosk cannot be used to discover employee numbers.
-- 4. PRIVACY. kiosk_punch returns only the employee's first name, the punch
--    and its time. A kiosk can list nothing and read nothing else.
-- 5. EVIDENCE (append-only, also for service_role / SQL):
--    * workforce_events: never updated; deleted only with its company.
--    * time_punches: never deleted (except with the company); a punch is
--      only voided once (voided_at, voided_by, void_reason) and then frozen.
--    * punch_corrections / leave_requests: a decided request never changes
--      (approved leave may only become cancelled, with who cancelled it).
--    * cancel_punch_correction now records who cancelled (decided_by).
-- Rollback: supabase/rollback/0021_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.punch(uuid, text, text)') is null then
    raise exception 'BA0021: migration 0020 (workforce) must be applied first';
  end if;
end $$;

-- ------------------------------------------------------------ kiosks
create table if not exists public.time_clock_kiosks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  last_used_at timestamptz,
  failed_count integer not null default 0,
  failed_window_start timestamptz
);
create index if not exists time_clock_kiosks_company_idx on public.time_clock_kiosks (company_id);
alter table public.time_clock_kiosks enable row level security;
revoke all on public.time_clock_kiosks from public, anon, authenticated;
grant select (id, company_id, name, created_at, revoked_at, last_used_at) on public.time_clock_kiosks to authenticated;
grant all on public.time_clock_kiosks to service_role;
drop policy if exists ba_kiosks_select on public.time_clock_kiosks;
create policy ba_kiosks_select on public.time_clock_kiosks for select to authenticated using (public.wf_manages(company_id));

create table if not exists public.employee_pins (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  salt text not null,
  pin_hash text not null,
  set_by uuid,
  set_at timestamptz not null default now(),
  failed_attempts integer not null default 0,
  locked_until timestamptz
);
alter table public.employee_pins enable row level security;
revoke all on public.employee_pins from public, anon, authenticated;
grant all on public.employee_pins to service_role;

alter table public.time_punches add column if not exists kiosk_id uuid references public.time_clock_kiosks(id) on delete restrict;
alter table public.time_punches drop constraint if exists time_punches_source_check;
alter table public.time_punches add constraint time_punches_source_check
  check (source in ('self', 'supervisor', 'correction', 'kiosk'));

-- ------------------------------------------------------------ PIN hashing
create or replace function public.wf_pin_hash(salt text, pin text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  h bytea := sha256(convert_to(salt || ':' || pin, 'UTF8'));
  i integer;
begin
  for i in 1 .. 5000 loop
    h := sha256(h || convert_to(salt, 'UTF8'));
  end loop;
  return encode(h, 'hex');
end $$;

create or replace function public.wf_pin_trivial(pin text)
returns boolean language sql immutable set search_path = '' as $$
  select pin ~ '^(.)\1*$' or position(pin in '01234567890123') > 0 or position(pin in '98765432109876') > 0
$$;

create or replace function public.set_employee_pin(emp uuid, pin text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  s text;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into e from public.employees where id = emp;
  if not found or not (public.wf_manages(e.company_id) or public.wf_is_self(emp)) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if e.status <> 'active' then
    raise exception 'EMPLOYEE_INACTIVE' using errcode = 'P0001';
  end if;
  if pin is null or pin !~ '^[0-9]{6}$' then
    raise exception 'PIN_INVALID' using errcode = 'P0001';
  end if;
  if public.wf_pin_trivial(pin) then
    raise exception 'PIN_TOO_SIMPLE' using errcode = 'P0001';
  end if;
  s := encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
  insert into public.employee_pins (employee_id, company_id, salt, pin_hash, set_by)
  values (emp, e.company_id, s, public.wf_pin_hash(s, pin), (select auth.uid()))
  on conflict (employee_id) do update set salt = excluded.salt, pin_hash = excluded.pin_hash, set_by = excluded.set_by,
    set_at = now(), failed_attempts = 0, locked_until = null;
  perform public.wf_log(e.company_id, emp, 'employee_pins', emp::text, 'pin_set',
                        jsonb_build_object('by_self', public.wf_is_self(emp)));
end $$;

create or replace function public.clear_employee_pin(emp uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.employees;
begin
  select * into e from public.employees where id = emp;
  if not found or not public.wf_manages(e.company_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;
  delete from public.employee_pins where employee_id = emp;
  perform public.wf_log(e.company_id, emp, 'employee_pins', emp::text, 'pin_cleared', '{}');
end $$;

-- Whether a PIN is set / locked (no hash, no salt) — managers, supervisors, self.
create or replace function public.employee_pin_status(emp uuid)
returns table (pin_set boolean, set_at timestamptz, locked_until timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.employee_id is not null, p.set_at, case when p.locked_until > now() then p.locked_until end
  from (select emp as id) x left join public.employee_pins p on p.employee_id = x.id
  where public.wf_supervises(emp) or public.wf_is_self(emp)
$$;

-- ------------------------------------------------------------ kiosk admin
create or replace function public.create_kiosk(target uuid, kiosk_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw text;
  kid uuid;
begin
  if not public.wf_manages(target) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(kiosk_name, ''))) not between 1 and 60 then
    raise exception 'KIOSK_NAME_INVALID' using errcode = 'P0001';
  end if;
  if (select count(*) from public.time_clock_kiosks where company_id = target and revoked_at is null) >= 20 then
    raise exception 'KIOSK_LIMIT' using errcode = 'P0001', hint = '20';
  end if;
  raw := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
  insert into public.time_clock_kiosks (company_id, name, token_hash, created_by)
  values (target, btrim(kiosk_name), encode(sha256(convert_to(raw, 'UTF8')), 'hex'), (select auth.uid()))
  returning id into kid;
  perform public.wf_log(target, null, 'time_clock_kiosks', kid::text, 'created', jsonb_build_object('name', btrim(kiosk_name)));
  return raw;
end $$;

create or replace function public.revoke_kiosk(kiosk uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare k public.time_clock_kiosks;
begin
  select * into k from public.time_clock_kiosks where id = kiosk for update;
  if not found or not public.wf_manages(k.company_id) then
    raise exception 'KIOSK_NOT_FOUND' using errcode = 'P0001';
  end if;
  if k.revoked_at is null then
    update public.time_clock_kiosks set revoked_at = now(), revoked_by = (select auth.uid()) where id = k.id;
    perform public.wf_log(k.company_id, null, 'time_clock_kiosks', k.id::text, 'revoked', jsonb_build_object('name', k.name));
  end if;
end $$;

-- What the tablet may show about itself: company and kiosk names, and the
-- company time zone (to display the punch time).
drop function if exists public.kiosk_info(text);
create function public.kiosk_info(raw_token text)
returns table (company_name text, kiosk_name text, timezone text)
language sql stable security definer set search_path = '' as $$
  select c.name, k.name, coalesce((select w.timezone from public.workforce_settings w where w.company_id = k.company_id), 'America/Puerto_Rico')
  from public.time_clock_kiosks k join public.companies c on c.id = k.company_id
  where raw_token ~ '^[0-9a-f]{64}$' and k.token_hash = encode(sha256(convert_to(raw_token, 'UTF8')), 'hex') and k.revoked_at is null
$$;

-- ------------------------------------------------------------ kiosk punch
-- Status: ok | invalid (unknown number, wrong PIN or locked: one answer) |
-- kiosk_invalid | kiosk_locked | sequence | unavailable
create or replace function public.kiosk_punch(raw_token text, emp_number text, emp_pin text, punch_kind text)
returns table (status text, first_name text, kind text, punched_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  k public.time_clock_kiosks;
  e public.employees;
  p public.employee_pins;
  f record;
  t timestamptz;
  pid uuid;
begin
  if raw_token is null or raw_token !~ '^[0-9a-f]{64}$' then
    status := 'kiosk_invalid'; return next; return;
  end if;
  select * into k from public.time_clock_kiosks
   where token_hash = encode(sha256(convert_to(raw_token, 'UTF8')), 'hex') and revoked_at is null for update;
  if not found then
    status := 'kiosk_invalid'; return next; return;
  end if;
  if k.failed_window_start is not null and k.failed_window_start > now() - interval '10 minutes' and k.failed_count >= 20 then
    status := 'kiosk_locked'; return next; return;
  end if;
  if punch_kind not in ('in', 'out', 'break_start', 'break_end') then
    status := 'sequence'; return next; return;
  end if;

  select x.* into e from public.employees x
   where x.company_id = k.company_id and x.employee_number = btrim(coalesce(emp_number, '')) and x.status = 'active';
  if found then
    select * into p from public.employee_pins where employee_id = e.id for update;
  end if;
  if e.id is null or p.employee_id is null or (p.locked_until is not null and p.locked_until > now())
     or emp_pin is null or emp_pin !~ '^[0-9]{6}$' or public.wf_pin_hash(p.salt, emp_pin) <> p.pin_hash then
    -- Count the failure (stored: this function returns, it does not raise).
    update public.time_clock_kiosks
       set failed_count = case when failed_window_start is null or failed_window_start <= now() - interval '10 minutes' then 1 else failed_count + 1 end,
           failed_window_start = case when failed_window_start is null or failed_window_start <= now() - interval '10 minutes' then now() else failed_window_start end
     where id = k.id;
    if p.employee_id is not null and not (p.locked_until is not null and p.locked_until > now()) then
      update public.employee_pins
         set failed_attempts = failed_attempts + 1,
             locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
       where employee_id = p.employee_id;
      if p.failed_attempts + 1 >= 5 then
        perform public.wf_log(k.company_id, e.id, 'employee_pins', e.id::text, 'pin_locked', jsonb_build_object('kiosk_id', k.id));
      end if;
    end if;
    status := 'invalid'; return next; return;
  end if;

  update public.employee_pins set failed_attempts = 0, locked_until = null where employee_id = e.id;
  select * into f from public.wf_feature(e.company_id, 'time_clock');
  if not f.available then
    status := 'unavailable'; return next; return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ba_punch:' || e.id::text, 0));
  t := clock_timestamp();
  if not public.wf_next_ok(public.wf_last_kind(e.id), punch_kind)
     or exists (select 1 from public.time_punches where employee_id = e.id and voided_at is null and at >= t) then
    status := 'sequence'; first_name := e.first_name; return next; return;
  end if;
  insert into public.time_punches (company_id, employee_id, kind, at, source, recorded_by, kiosk_id)
  values (e.company_id, e.id, punch_kind, t, 'kiosk', null, k.id) returning id into pid;
  update public.time_clock_kiosks set last_used_at = now() where id = k.id;
  perform public.wf_log(e.company_id, e.id, 'time_punches', pid::text, 'punch',
                        jsonb_build_object('kind', punch_kind, 'source', 'kiosk', 'kiosk_id', k.id, 'kiosk', k.name));
  status := 'ok'; first_name := e.first_name; kind := punch_kind; punched_at := t;
  return next;
end $$;

-- ------------------------------------------------------------ evidence
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
  update public.punch_corrections set status = 'cancelled', decided_at = now(), decided_by = (select auth.uid()) where id = c.id;
  perform public.wf_log(c.company_id, c.employee_id, 'punch_corrections', c.id::text, 'cancelled', '{}');
end $$;

-- A row deleted together with its company (cascade) is the only deletion allowed.
create or replace function public.wf_company_gone(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.companies where id = target)
$$;

create or replace function public.wf_append_only()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.wf_company_gone(old.company_id) then
      return old;
    end if;
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  end if;
  if tg_table_name = 'workforce_events' then
    raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
  elsif tg_table_name = 'time_punches' then
    -- Only voiding, once: everything else stays as recorded.
    if old.voided_at is not null
       or (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason']) <> (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason'])
       or new.voided_at is null then
      raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
  elsif tg_table_name in ('punch_corrections', 'leave_requests') then
    if old.status = 'pending' then
      if (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_note'])
         <> (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_note']) then
        raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
      end if;
    elsif not (tg_table_name = 'leave_requests' and old.status = 'approved' and new.status = 'cancelled'
               and (to_jsonb(new) - array['status', 'decided_by', 'decided_at']) = (to_jsonb(old) - array['status', 'decided_by', 'decided_at'])) then
      raise exception 'HISTORY_IMMUTABLE' using errcode = 'P0001', hint = tg_table_name;
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['workforce_events', 'time_punches', 'punch_corrections', 'leave_requests']
  loop
    execute format('drop trigger if exists ba_wf_append_only on public.%I', t);
    execute format('create trigger ba_wf_append_only before update or delete on public.%I for each row execute function public.wf_append_only()', t);
  end loop;
end $$;

-- ------------------------------------------------------------ grants
do $$
declare f text;
begin
  foreach f in array array['wf_pin_hash(text, text)', 'wf_pin_trivial(text)', 'wf_company_gone(uuid)', 'wf_append_only()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['set_employee_pin(uuid, text)', 'clear_employee_pin(uuid)', 'employee_pin_status(uuid)',
                           'create_kiosk(uuid, text)', 'revoke_kiosk(uuid)', 'cancel_punch_correction(uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  -- The tablet is not signed in: only these two are callable without a user.
  foreach f in array array['kiosk_info(text)', 'kiosk_punch(text, text, text, text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end $$;

do $$
begin
  if has_table_privilege('authenticated', 'public.employee_pins', 'SELECT') or has_table_privilege('anon', 'public.employee_pins', 'SELECT')
     or has_column_privilege('authenticated', 'public.time_clock_kiosks', 'token_hash', 'SELECT')
     or has_table_privilege('anon', 'public.time_clock_kiosks', 'SELECT')
     or has_table_privilege('anon', 'public.time_punches', 'SELECT') then
    raise exception 'BA0021 self-check failed: PINs or kiosk tokens readable';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgname = 'ba_wf_append_only'
        and tgrelid in ('public.workforce_events'::regclass, 'public.time_punches'::regclass,
                        'public.punch_corrections'::regclass, 'public.leave_requests'::regclass)) <> 4 then
    raise exception 'BA0021 self-check failed: append-only triggers';
  end if;
end $$;

commit;
