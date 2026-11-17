-- =====================================================================
-- BusinessAI · Migration 0045 · Platform stabilization (S9)
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0015 (documents lifecycle) and 0035 (CRM client fields).
--
-- Finding S9-1: an issued invoice / quote / receipt kept its lines and amounts, but the bill-to
-- client and the issuer (company profile) were read LIVE when the document was shown: renaming a
-- client or moving the company changed past invoices. The database now records, once, when a
-- document leaves draft (or is created already issued), a snapshot of the client and the company
-- profile in documents.metadata.issued. It is written by this trigger (never by the browser), and
-- 0015's protect_issued_documents keeps it unchangeable afterwards (metadata of an issued document
-- is frozen). Documents issued before 0045 have no snapshot: the app falls back to live data and
-- says so. Nothing existing is rewritten.
-- Finding S9-2: public.document_deletion_audit (inherited from the original schema) still granted
-- INSERT / UPDATE / DELETE to anon and UPDATE / DELETE to authenticated. RLS already refused them
-- (no policy), but an audit trail must be append-only by privilege too: those grants are revoked
-- (signed-in users keep INSERT, under the existing policy, and SELECT).
-- Finding S9-3: there was no way to start deleting one's account from inside the app (required by
-- the App Store and Google Play for apps with sign-up). public.account_deletion_requests records the
-- request of the signed-in user (once, cancellable while pending). Deleting the auth user needs the
-- service role and is completed by an operator (docs/MOBILE.md §store requirements): the user's
-- memberships end; the companies' financial records are NOT deleted (legal retention); a company
-- whose only owner asks for deletion must first be transferred or closed (stated to the user).
-- Rollback: supabase/rollback/0045_rollback.sql (snapshots already written stay: they are history).
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.protect_issued_documents()') is null or to_regclass('public.company_profiles') is null then
    raise exception 'BA0045: migrations 0003 and 0015 must be applied first';
  end if;
end $$;

-- the keys kept (whatever exists in this database: columns added later are simply absent)
create or replace function ba_private.doc_pick(j jsonb, keys text[])
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(coalesce(j, '{}'::jsonb)) e
  where e.key = any (keys) and e.value <> 'null'::jsonb
$$;

create or replace function public.document_issue_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is null or new.status = 'draft' or coalesce(new.metadata, '{}'::jsonb) ? 'issued' then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;   -- only when it is issued
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('issued', jsonb_build_object(
    'at', now(),
    'client', case when new.client_id is null then null else
      ba_private.doc_pick((select to_jsonb(c) from public.clients c where c.id = new.client_id and c.company_id = new.company_id),
        array['name', 'business_name', 'legal_name', 'tax_id', 'email', 'phone', 'address', 'city', 'state', 'postal_code']) end,
    'company', ba_private.doc_pick((select to_jsonb(p) from public.company_profiles p where p.company_id = new.company_id),
        array['legal_name', 'display_name', 'phone', 'email', 'address', 'city', 'state', 'postal_code'])));
  return new;
end $$;
revoke all on function public.document_issue_snapshot() from public, anon, authenticated;
revoke all on function ba_private.doc_pick(jsonb, text[]) from public, anon, authenticated;

-- BEFORE triggers run by name: after ba_check_* / ba_enforce_* / ba_protect_issued_documents
drop trigger if exists ba_snapshot_document_issue on public.documents;
create trigger ba_snapshot_document_issue before insert or update of status on public.documents
  for each row execute function public.document_issue_snapshot();

-- ===================================================================== POS: token renewal and polling (needs 0044)
do $$ begin
  if to_regprocedure('ba_private.pos_verify(text, text, text, bigint, uuid)') is not null then
    execute $f$
    create or replace function public.pos_integration_token_update(integration uuid, payload text, key text, ts bigint, nonce uuid, mac text)
    returns void language plpgsql security definer set search_path = '' as $b$
    declare p jsonb; i public.pos_integrations;
    begin
      perform ba_private.pos_verify(key, concat_ws('|', 'pos_token', 'v1', key, integration::text, ts::text, nonce::text, ba_private.sha_hex(payload)), mac, ts, nonce);
      select * into i from public.pos_integrations where id = integration for update;
      if i.id is null or i.status = 'disconnected' then raise exception 'POS_NOT_FOUND' using errcode = 'P0001'; end if;
      p := payload::jsonb;
      if coalesce(p ->> 'token_ciphertext', '') = '' or coalesce(p ->> 'key_version', '') !~ '^[A-Za-z0-9_-]{1,32}$' then raise exception 'POS_INTEGRATION_INVALID' using errcode = 'P0001'; end if;
      insert into ba_private.pos_integration_secrets (integration_id, token_ciphertext, key_version, expires_at)
      values (i.id, p ->> 'token_ciphertext', p ->> 'key_version', nullif(p ->> 'expires_at', '')::timestamptz)
      on conflict (integration_id) do update set token_ciphertext = excluded.token_ciphertext, key_version = excluded.key_version, expires_at = excluded.expires_at, updated_at = now();
      update public.pos_integrations set status = case when status in ('error', 'login_required') then 'active' else status end, error_code = null where id = i.id;
      perform ba_private.pos_log(i.company_id, 'pos_integrations', i.id::text, 'token_renewed', '{}');
    end $b$;
    create or replace function public.pos_integrations_active(provider text, key text, ts bigint, nonce uuid, mac text)
    returns jsonb language plpgsql security definer set search_path = '' as $b$
    #variable_conflict use_variable
    begin
      perform ba_private.pos_verify(key, concat_ws('|', 'pos_active', 'v1', key, provider, ts::text, nonce::text), mac, ts, nonce);
      return coalesce((select jsonb_agg(jsonb_build_object('integration_id', i.id, 'cursor', i.sync_cursor, 'last_success_at', i.last_success_at,
               'locations', (select coalesce(jsonb_agg(m.external_location_id), '[]'::jsonb) from public.pos_location_maps m where m.integration_id = i.id)))
             from public.pos_integrations i where i.provider = provider and i.status in ('active', 'error')), '[]'::jsonb);
    end $b$;
    revoke all on function public.pos_integration_token_update(uuid, text, text, bigint, uuid, text), public.pos_integrations_active(text, text, bigint, uuid, text) from public;
    grant execute on function public.pos_integration_token_update(uuid, text, text, bigint, uuid, text), public.pos_integrations_active(text, text, bigint, uuid, text) to anon, authenticated, service_role;
    $f$;
  end if;
end $$;

-- ===================================================================== user deletion keeps financial records
alter table public.payments drop constraint if exists payments_created_by_fkey;
alter table public.companies drop constraint if exists companies_created_by_fkey;

-- ===================================================================== account deletion requests
create table if not exists public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'cancelled', 'completed')),
  reason text check (reason is null or char_length(reason) <= 500),
  sole_owner_of integer not null default 0 check (sole_owner_of >= 0),
  requested_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public, anon, authenticated;
grant select on public.account_deletion_requests to authenticated;
grant all on public.account_deletion_requests to service_role;
drop policy if exists ba_account_deletion_requests_select on public.account_deletion_requests;
create policy ba_account_deletion_requests_select on public.account_deletion_requests for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.account_deletion_request(p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid()); sole integer;
begin
  if me is null then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  -- companies where this user is the only active owner: they must be transferred or closed first
  select count(*) into sole from public.memberships m where m.user_id = me and m.role = 'owner' and m.status = 'active'
    and not exists (select 1 from public.memberships o where o.company_id = m.company_id and o.role = 'owner' and o.status = 'active' and o.user_id <> me);
  insert into public.account_deletion_requests (user_id, status, reason, sole_owner_of) values (me, 'pending', nullif(left(btrim(coalesce(p_reason, '')), 500), ''), sole)
  on conflict (user_id) do update set status = 'pending', reason = excluded.reason, sole_owner_of = excluded.sole_owner_of, requested_at = now(), processed_at = null
    where public.account_deletion_requests.status <> 'completed';
  return jsonb_build_object('status', 'pending', 'sole_owner_of', sole);
end $$;
create or replace function public.account_deletion_cancel()
returns void language sql security definer set search_path = '' as $$
  update public.account_deletion_requests set status = 'cancelled', processed_at = now() where user_id = (select auth.uid()) and status = 'pending'
$$;
revoke all on function public.account_deletion_request(text), public.account_deletion_cancel() from public, anon;
grant execute on function public.account_deletion_request(text), public.account_deletion_cancel() to authenticated, service_role;

do $$ begin
  if to_regclass('public.document_deletion_audit') is not null then
    revoke insert, update, delete, truncate on public.document_deletion_audit from anon;
    revoke update, delete, truncate on public.document_deletion_audit from authenticated;
  end if;
end $$;

do $$ begin
  if to_regclass('public.document_deletion_audit') is not null and (has_table_privilege('anon', 'public.document_deletion_audit', 'INSERT')
     or has_table_privilege('authenticated', 'public.document_deletion_audit', 'DELETE')) then
    raise exception 'BA0045 self-check failed: deletion audit still writable';
  end if;
  if exists (select 1 from pg_constraint where conname in ('payments_created_by_fkey', 'companies_created_by_fkey')) then
    raise exception 'BA0045 self-check failed: user deletion still blocked by a foreign key';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'ba_snapshot_document_issue') then
    raise exception 'BA0045 self-check failed: snapshot trigger missing';
  end if;
end $$;

commit;
