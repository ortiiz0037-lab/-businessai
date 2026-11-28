-- =====================================================================
-- BusinessAI · Migration 0041 · Advanced Document Studio (S5)
-- =====================================================================
-- STAGING-GATE: approval required (scripts/staging/draft-gate.sh: applied only when named in APPROVED_DRAFTS)
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Requires 0040.
--
--   * Typefaces: documents, templates and the corporate identity may use the
--     nine embedded families of public/studio/fonts (SIL Open Font License):
--     sans, serif (Liberation), lato, montserrat, plex-sans, plex-serif, lora,
--     playfair, mono. studio_valid_page and the studio_brand checks accept them.
--     (Inline formatting {c=…|…} and table options are content: the 0038
--     validator already accepts them — no markup, no links.)
--   * Assistant: proposal 'studio_edit' — an edit of an existing Studio DRAFT,
--     applied only after the user confirms, with the version it was proposed on
--     (a newer version refuses it). Needs studio.edit. Never issues, sends or
--     touches Finance.
-- Rollback: supabase/rollback/0041_rollback.sql
-- =====================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_actions_kind_check' and pg_get_constraintdef(oid) like '%studio_payment_voucher%') then
    raise exception 'BA0041: migration 0040 must be applied first';
  end if;
end $$;

-- ------------------------------------------------------------- typefaces
create or replace function public.studio_valid_page(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'object'
    and coalesce(p ->> 'size', 'letter') in ('letter', 'a4', 'legal')
    and coalesce(p ->> 'orientation', 'portrait') in ('portrait', 'landscape')
    and coalesce(p ->> 'font', 'sans') in ('sans', 'serif', 'lato', 'montserrat', 'plex-sans', 'plex-serif', 'lora', 'playfair', 'mono')
    and coalesce((p ->> 'fontSize')::numeric, 10.5) between 8 and 16
    and coalesce((p ->> 'lineHeight')::numeric, 1.35) between 1 and 2.2
    and coalesce((p ->> 'marginTop')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginRight')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginBottom')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginLeft')::numeric, 20) between 8 and 50
    and coalesce(p ->> 'accent', '#000000') ~ '^#[0-9A-Fa-f]{6}$'
    and octet_length(p::text) < 4000
$$;

alter table public.studio_brand drop constraint if exists studio_brand_heading_font_check;
alter table public.studio_brand add constraint studio_brand_heading_font_check check (heading_font in ('sans', 'serif', 'lato', 'montserrat', 'plex-sans', 'plex-serif', 'lora', 'playfair', 'mono'));
alter table public.studio_brand drop constraint if exists studio_brand_body_font_check;
alter table public.studio_brand add constraint studio_brand_body_font_check check (body_font in ('sans', 'serif', 'lato', 'montserrat', 'plex-sans', 'plex-serif', 'lora', 'playfair', 'mono'));

-- ------------------------------------------------------------- assistant: edits of drafts
alter table public.assistant_actions drop constraint if exists assistant_actions_kind_check;
alter table public.assistant_actions add constraint assistant_actions_kind_check
  check (kind in ('studio_draft', 'crm_note', 'crm_task', 'studio_collection_letter', 'studio_payment_voucher', 'studio_edit'));

create or replace function public.assistant_propose(turn uuid, act_kind text, act_summary text, act_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare t public.assistant_turns; me uuid := (select auth.uid()); lvl text; nid uuid;
begin
  select * into t from public.assistant_turns x where x.id = turn;
  if t.id is null or t.user_id is distinct from me or t.status <> 'open' or t.expires_at < now() or not public.has_permission(t.company_id, 'assistant.use') then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  lvl := case act_kind when 'studio_draft' then 'draft' when 'crm_note' then 'draft' when 'crm_task' then 'draft'
                       when 'studio_collection_letter' then 'draft' when 'studio_payment_voucher' then 'draft'
                       when 'studio_edit' then 'draft' end;
  if lvl is null then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  if act_kind = 'studio_draft' and not public.has_permission(t.company_id, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if act_kind in ('crm_note', 'crm_task') and not public.has_permission(t.company_id, 'crm.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  -- 0040: Studio drafts about Finance records need Studio AND the module that owns the record (same rules as the screens)
  if act_kind = 'studio_collection_letter' and not (public.has_permission(t.company_id, 'studio.edit') and public.has_permission(t.company_id, 'documents.view')) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  -- 0041: an edit of an existing Studio DRAFT (applied only after the user confirms, with the version it was proposed on)
  if act_kind = 'studio_edit' and not public.has_permission(t.company_id, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if act_kind = 'studio_payment_voucher' and not (public.has_permission(t.company_id, 'studio.edit') and public.has_permission(t.company_id, 'payables.view')) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if act_summary is null or char_length(btrim(act_summary)) not between 1 and 400 then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'summary'; end if;
  if (select count(*) from public.assistant_actions a where a.conversation_id = t.conversation_id and a.status = 'proposed' and a.expires_at > now()) >= 5 then
    raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'too_many_pending';
  end if;
  insert into public.assistant_actions (company_id, conversation_id, user_id, kind, level, summary, payload, turn_id)
  values (t.company_id, t.conversation_id, me, act_kind, lvl, left(btrim(act_summary), 400), act_payload, t.id)
  returning id into nid;
  insert into public.assistant_events (company_id, user_id, conversation_id, action_id, event, detail)
  values (t.company_id, me, t.conversation_id, nid, 'action_proposed', jsonb_build_object('kind', act_kind, 'level', lvl));
  return nid;
end $$;

-- ------------------------------------------------------------- self-check
do $$ begin
  if not public.studio_valid_page('{"font": "lora"}'::jsonb) or public.studio_valid_page('{"font": "comic"}'::jsonb) then
    raise exception 'BA0041 self-check failed: typefaces';
  end if;
  if not has_function_privilege('authenticated', 'public.assistant_propose(uuid, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.assistant_propose(uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'BA0041 self-check failed: assistant_propose grants changed';
  end if;
end $$;

commit;
