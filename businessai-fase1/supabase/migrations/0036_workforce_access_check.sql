-- =====================================================================
-- BusinessAI · Migration 0036 · Employee access link: check before use
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0020.
--
-- Bug fixed: the page /clock/link offered «Vincular y ponchar» for ANY
-- 64-hex token and only learned at the click that the link was no longer
-- valid («El enlace de acceso no es válido»). Reproduced locally in two ways:
--   * the manager pressed «Crear enlace de acceso» again: the new link
--     replaces the hash of the one the employee already has;
--   * the employee already used the link (back button, second tap, opened
--     again): the hash was cleared, so the same account got ACCESS_INVALID
--     although it IS linked.
-- This adds:
--   * employee_access_check(raw_token): READ-ONLY check for the signed-in
--     user, before anything is consumed: ok / linked (already yours) / used /
--     invalid / expired / email_mismatch (masked expected email) /
--     already_linked. Changes nothing.
--   * employee_access_uses: hash of each consumed link (never the link),
--     so a used link is told apart from an unknown one. No API access.
--   * claim_employee_access: same checks and order as 0020; a link already
--     used BY THE SAME account for the same employee returns that employee
--     (no change, nothing logged); used by anyone else → ACCESS_USED.
--   * create/revoke_employee_access: unchanged behaviour; a new link or a
--     revocation forgets earlier used hashes of that employee.
-- Nothing else changes: still one link per employee, 7 days, only the
-- SHA-256 stored, only the account with the employee's email can claim it.
begin;
set local lock_timeout = '5s';

create table if not exists public.employee_access_uses (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  employee_id uuid not null references public.employees(id) on delete cascade,
  user_id uuid not null,
  used_at timestamptz not null default now()
);
create index if not exists employee_access_uses_employee_idx on public.employee_access_uses (employee_id);
alter table public.employee_access_uses enable row level security;
revoke all on table public.employee_access_uses from public, anon, authenticated;

-- ------------------------------------------------------------ read-only check
create or replace function public.employee_access_check(raw_token text)
returns table (state text, employee_name text, company_name text, expected_email text)
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  h text;
  e public.employees;
  used public.employee_access_uses;
  mail text;
  company text;
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if raw_token is null or raw_token !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::text, null::text, null::text; return;
  end if;
  h := encode(sha256(convert_to(raw_token, 'UTF8')), 'hex');
  select * into e from public.employees where access_token_hash = h;
  if not found then
    select * into used from public.employee_access_uses u where u.token_hash = h;
    if found then
      select * into e from public.employees where id = used.employee_id;
      if used.user_id = uid and e.user_id = uid then
        select c.name into company from public.companies c where c.id = e.company_id;
        return query select 'linked'::text, e.first_name || ' ' || e.last_name, company, null::text; return;
      end if;
      return query select 'used'::text, null::text, null::text, null::text; return;
    end if;
    return query select 'invalid'::text, null::text, null::text, null::text; return;
  end if;
  select c.name into company from public.companies c where c.id = e.company_id;
  if e.access_expires_at <= now() or e.status <> 'active' then
    return query select 'expired'::text, e.first_name || ' ' || e.last_name, company, null::text; return;
  end if;
  select lower(btrim(u.email)) into mail from auth.users u where u.id = uid;
  if mail is distinct from e.email then
    -- masked: enough for the employee to recognise it, not the full address
    return query select 'email_mismatch'::text, e.first_name || ' ' || e.last_name, company,
      left(e.email, 1) || '•••@' || split_part(e.email, '@', 2); return;
  end if;
  if exists (select 1 from public.employees x where x.company_id = e.company_id and x.user_id = uid and x.id <> e.id) then
    return query select 'already_linked'::text, e.first_name || ' ' || e.last_name, company, null::text; return;
  end if;
  return query select 'ok'::text, e.first_name || ' ' || e.last_name, company, null::text;
end $$;

-- ------------------------------------------------------------ claim (0020 + used links)
create or replace function public.claim_employee_access(raw_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  e public.employees;
  uid uuid := (select auth.uid());
  mail text;
  h text;
  used public.employee_access_uses;
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if raw_token is null or raw_token !~ '^[0-9a-f]{64}$' then
    raise exception 'ACCESS_INVALID' using errcode = 'P0001';
  end if;
  h := encode(sha256(convert_to(raw_token, 'UTF8')), 'hex');
  select * into e from public.employees where access_token_hash = h for update;
  if not found then
    select * into used from public.employee_access_uses u where u.token_hash = h;
    if found then
      -- the same account pressing again (back button, second tap): already done, nothing changes
      if used.user_id = uid and exists (select 1 from public.employees x where x.id = used.employee_id and x.user_id = uid) then
        return used.employee_id;
      end if;
      raise exception 'ACCESS_USED' using errcode = 'P0001';
    end if;
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
  insert into public.employee_access_uses (token_hash, employee_id, user_id) values (h, e.id, uid)
    on conflict (token_hash) do nothing;
  perform public.wf_log(e.company_id, e.id, 'employees', e.id::text, 'access_linked', '{}');
  return e.id;
end $$;

-- ------------------------------------------------------------ create / revoke (0020 + forget used links)
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
  delete from public.employee_access_uses where employee_id = emp;
  perform public.wf_log(e.company_id, emp, 'employees', emp::text, 'access_link_created', '{}');
  return raw;
end $$;

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
  delete from public.employee_access_uses where employee_id = emp;
  perform public.wf_log(e.company_id, emp, 'employees', emp::text, 'access_revoked', '{}');
end $$;

do $$
declare f text;
begin
  foreach f in array array['employee_access_check(text)', 'claim_employee_access(text)', 'create_employee_access(uuid)', 'revoke_employee_access(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ------------------------------------------------------------ self-check
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.employee_access_uses'::regclass)
     or has_table_privilege('authenticated', 'public.employee_access_uses', 'SELECT')
     or has_table_privilege('anon', 'public.employee_access_uses', 'SELECT') then
    raise exception 'BA0036 self-check failed: used-link hashes exposed';
  end if;
  if has_function_privilege('anon', 'public.employee_access_check(text)', 'EXECUTE')
     or (select provolatile from pg_proc where oid = 'public.employee_access_check(text)'::regprocedure) <> 's' then
    raise exception 'BA0036 self-check failed: the check must be read-only and need a session';
  end if;
end $$;

commit;
