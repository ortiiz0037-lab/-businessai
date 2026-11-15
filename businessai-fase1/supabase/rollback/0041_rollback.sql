-- Rollback of 0041 (advanced Document Studio). Refuses, changing nothing,
-- while a document, template, version or the corporate identity uses one of
-- the new typefaces, or an assistant draft-edit proposal exists. Restores the
-- 0028 page validator and brand checks and the 0040 assistant_propose.
-- Inline formatting spans in content are plain text to the older app.
-- Emergency use only.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.studio_documents where coalesce(page ->> 'font', 'sans') not in ('sans', 'serif'))
     or exists (select 1 from public.studio_templates where coalesce(page ->> 'font', 'sans') not in ('sans', 'serif'))
     or exists (select 1 from public.studio_versions where coalesce(page ->> 'font', 'sans') not in ('sans', 'serif'))
     or exists (select 1 from public.studio_brand where heading_font not in ('sans', 'serif') or body_font not in ('sans', 'serif') or coalesce(page ->> 'font', 'sans') not in ('sans', 'serif'))
     or exists (select 1 from public.assistant_actions where kind = 'studio_edit') then
    raise exception 'BA0041 rollback: the new typefaces or assistant draft-edit proposals are in use; nothing was changed.';
  end if;
end $$;
alter table public.assistant_actions drop constraint if exists assistant_actions_kind_check;
alter table public.assistant_actions add constraint assistant_actions_kind_check check (kind in ('studio_draft', 'crm_note', 'crm_task', 'studio_collection_letter', 'studio_payment_voucher'));
create or replace function public.assistant_propose(turn uuid, act_kind text, act_summary text, act_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare t public.assistant_turns; me uuid := (select auth.uid()); lvl text; nid uuid;
begin
  select * into t from public.assistant_turns x where x.id = turn;
  if t.id is null or t.user_id is distinct from me or t.status <> 'open' or t.expires_at < now() or not public.has_permission(t.company_id, 'assistant.use') then
    raise exception 'ASSISTANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  lvl := case act_kind when 'studio_draft' then 'draft' when 'crm_note' then 'draft' when 'crm_task' then 'draft'
                       when 'studio_collection_letter' then 'draft' when 'studio_payment_voucher' then 'draft' end;
  if lvl is null then raise exception 'ASSISTANT_INVALID' using errcode = 'P0001', hint = 'kind'; end if;
  if act_kind = 'studio_draft' and not public.has_permission(t.company_id, 'studio.edit') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if act_kind in ('crm_note', 'crm_task') and not public.has_permission(t.company_id, 'crm.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  -- 0040: Studio drafts about Finance records need Studio AND the module that owns the record (same rules as the screens)
  if act_kind = 'studio_collection_letter' and not (public.has_permission(t.company_id, 'studio.edit') and public.has_permission(t.company_id, 'documents.view')) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
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
alter table public.studio_brand drop constraint if exists studio_brand_heading_font_check;
alter table public.studio_brand add constraint studio_brand_heading_font_check check (heading_font in ('sans', 'serif'));
alter table public.studio_brand drop constraint if exists studio_brand_body_font_check;
alter table public.studio_brand add constraint studio_brand_body_font_check check (body_font in ('sans', 'serif'));
create or replace function public.studio_valid_page(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'object'
    and coalesce(p ->> 'size', 'letter') in ('letter', 'a4', 'legal')
    and coalesce(p ->> 'orientation', 'portrait') in ('portrait', 'landscape')
    and coalesce(p ->> 'font', 'sans') in ('sans', 'serif')
    and coalesce((p ->> 'fontSize')::numeric, 10.5) between 8 and 16
    and coalesce((p ->> 'lineHeight')::numeric, 1.35) between 1 and 2.2
    and coalesce((p ->> 'marginTop')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginRight')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginBottom')::numeric, 20) between 8 and 50
    and coalesce((p ->> 'marginLeft')::numeric, 20) between 8 and 50
    and coalesce(p ->> 'accent', '#000000') ~ '^#[0-9A-Fa-f]{6}$'
    and octet_length(p::text) < 4000
$$;
commit;
