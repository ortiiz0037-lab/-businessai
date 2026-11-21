-- Rollback of 0036 (employee access link check). Restores the 0020 versions of
-- claim/create/revoke_employee_access and drops the read-only check and the
-- table of used-link hashes (only hashes; no business data). Links already
-- used stay used; an unused pending link keeps working. Emergency use only.
begin;
set local lock_timeout = '5s';
drop function if exists public.employee_access_check(text);
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
drop table if exists public.employee_access_uses;
do $$
declare f text;
begin
  foreach f in array array['claim_employee_access(text)', 'create_employee_access(uuid)', 'revoke_employee_access(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
commit;
