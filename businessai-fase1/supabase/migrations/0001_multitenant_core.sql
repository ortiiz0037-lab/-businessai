-- Fase 1: núcleo multi-tenant. Sin datos de negocio todavía.
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);

alter table public.companies enable row level security;
alter table public.memberships enable row level security;

-- Defensa en profundidad: sin acceso anónimo y sin escrituras directas donde no aplican.
revoke all on public.companies, public.memberships from anon;
revoke insert, delete on public.companies from authenticated;
revoke insert, update, delete on public.memberships from authenticated;

-- Helpers security definer (evitan recursión de RLS sobre memberships).
create function public.is_company_member(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.company_id = target and m.user_id = (select auth.uid()));
$$;

create function public.has_company_role(target uuid, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.company_id = target and m.user_id = (select auth.uid())
                   and m.role = any (roles));
$$;

create policy companies_select on public.companies for select to authenticated
  using (public.is_company_member(id));
create policy companies_update on public.companies for update to authenticated
  using (public.has_company_role(id, array['owner','admin']))
  with check (public.has_company_role(id, array['owner','admin']));
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.is_company_member(company_id));

-- Única vía para crear una empresa: crea empresa + membership 'owner' de forma atómica.
create function public.create_company(company_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  new_id uuid;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  company_name := btrim(company_name);
  if company_name is null or char_length(company_name) not between 2 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  insert into public.companies (name, created_by) values (company_name, uid) returning id into new_id;
  insert into public.memberships (company_id, user_id, role) values (new_id, uid, 'owner');
  return new_id;
end $$;

revoke all on function public.is_company_member(uuid), public.has_company_role(uuid, text[]),
  public.create_company(text) from public, anon;
grant execute on function public.is_company_member(uuid), public.has_company_role(uuid, text[]),
  public.create_company(text) to authenticated;
