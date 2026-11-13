-- CRM (0035). TEST-ONLY, local throw-away database with every migration up
-- to 0035. Schema at. Fictitious companies, people and amounts.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
create schema at;
create table at.ctx (key text primary key, val text not null);
create function at.id(k text) returns uuid language sql stable as $$ select val::uuid from at.ctx where key = k $$;
create table at.failures (msg text);
create function at.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'PASS: %', msg;
  else raise notice 'FAIL: %', msg; insert into at.failures values (msg); end if;
end $$;
create function at.err(who text, stmt text) returns text language plpgsql as $$
declare msg text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', at.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin execute stmt; exception when others then msg := sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return msg;
end $$;
create function at.val(who text, q text) returns text language plpgsql volatile as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', at.id(who), 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into r;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create function at.n(who text, q text) returns integer language sql as $$ select at.val(who, q)::integer $$;
create function at.put(k text, v text) returns void language sql as $$ insert into at.ctx values (k, v) on conflict (key) do update set val = excluded.val $$;
grant usage on schema at to authenticated;
grant select on at.ctx to authenticated;
grant execute on all functions in schema at to authenticated;

insert into at.ctx values
  ('owner', 'ca000000-0000-4000-8000-000000000001'), ('admin', 'ca000000-0000-4000-8000-000000000002'),
  ('member', 'ca000000-0000-4000-8000-000000000003'), ('member2', 'ca000000-0000-4000-8000-000000000004'),
  ('other', 'ca000000-0000-4000-8000-000000000005'), ('worker', 'ca000000-0000-4000-8000-000000000006'),
  ('A', 'cb000000-0000-4000-8000-000000000001'), ('B', 'cb000000-0000-4000-8000-000000000002'),
  ('c1', 'cc000000-0000-4000-8000-000000000001'), ('c2', 'cc000000-0000-4000-8000-000000000002'), ('cB', 'cc000000-0000-4000-8000-000000000003');
insert into auth.users (id, email) select val::uuid, key || '@crm.test' from at.ctx where key in ('owner', 'admin', 'member', 'member2', 'other', 'worker');
insert into public.companies (id, name, created_by) values (at.id('A'), 'CRM A', at.id('owner')), (at.id('B'), 'CRM B', at.id('other'));
insert into public.company_subscriptions (company_id, stripe_customer_id, stripe_subscription_id, plan, status) values
  (at.id('A'), 'cus_crm_a', 'sub_crm_a', 'pro', 'active'), (at.id('B'), 'cus_crm_b', 'sub_crm_b', 'pro', 'active');
insert into public.memberships (company_id, user_id, role) values
  (at.id('A'), at.id('owner'), 'owner'), (at.id('A'), at.id('admin'), 'admin'), (at.id('A'), at.id('member'), 'member'),
  (at.id('A'), at.id('member2'), 'member'), (at.id('B'), at.id('other'), 'owner');
-- an employee with an account but no membership (time clock only)
insert into public.employees (company_id, first_name, last_name, user_id) values (at.id('A'), 'Wendy', 'Worker', at.id('worker'));
insert into public.clients (id, company_id, name, business_name, email, phone) values
  (at.id('c1'), at.id('A'), 'Carmen Ruiz', 'Ruiz Consulting', 'Carmen@Ruiz.test', '(787) 555-0101'),
  (at.id('c2'), at.id('A'), 'Diego Soto', null, 'diego@soto.test', '787-555-0202'),
  (at.id('cB'), at.id('B'), 'Cliente de B', null, 'carmen@ruiz.test', '787-555-0101');
do $$ begin perform at.val('owner', format('select public.ledger_init(%L)::text', at.id('A'))); end $$;

-- ===================================================================== permissions and setup
do $$ declare e text; begin
  perform at.ok((select count(*) from public.role_permissions where permission_key like 'crm.%' or permission_key = 'branches.manage') = 12, 'permission matrix: 12 role rows for the 5 CRM permissions');
  perform at.ok(at.val('member', format('select public.has_permission(%L, ''crm.manage'')::text', at.id('A'))) = 'true'
            and at.val('member', format('select public.has_permission(%L, ''crm.view_all'')::text', at.id('A'))) = 'false'
            and at.val('member', format('select public.has_permission(%L, ''crm.configure'')::text', at.id('A'))) = 'false', 'members manage their CRM work but neither see all nor configure');
  perform at.ok(at.val('other', format('select public.has_permission(%L, ''crm.view'')::text', at.id('A'))) = 'false', 'the owner of another company has no CRM permission here');
  perform at.ok(at.err('worker', format('select public.crm_ensure_setup(%L)', at.id('A'))) like '%FORBIDDEN%', 'an employee without membership has no CRM access');
  e := at.err('member', format('select public.crm_ensure_setup(%L)', at.id('A'))) || at.err('member', format('select public.crm_ensure_setup(%L)', at.id('A')));
  perform at.ok(e = '' and (select count(*) from public.crm_pipeline_stages where company_id = at.id('A')) = 7, 'default pipeline: 7 stages, created once');
  perform at.ok((select string_agg(key || ':' || probability_bp, ',' order by position) from public.crm_pipeline_stages where company_id = at.id('A'))
            = 'new:1000,contacted:2000,qualified:4000,proposal:6000,negotiation:8000,won:10000,lost:0', 'stages and default probabilities in order');
  perform at.ok(at.err('member', format('insert into public.crm_tags (company_id, name) values (%L, ''x'')', at.id('A'))) like '%permission denied%'
            and at.err('owner', format('insert into public.crm_opportunities (company_id, client_id, name, probability_bp, stage_id) select %L, %L, ''x'', 0, id from public.crm_pipeline_stages limit 1', at.id('A'), at.id('c1'))) like '%permission denied%'
            and at.err('owner', 'delete from public.crm_events') like '%permission denied%', 'no direct writes to CRM tables, not even the owner (functions only)');
end $$;

-- ===================================================================== clients: CRM fields, validation, value history, duplicates
do $$ declare e text; begin
  e := at.err('member', format('update public.clients set kind = ''company'', legal_name = ''Ruiz Consulting LLC'', tax_id = ''66-1234567'', lifecycle = ''lead'', source = ''Referido'', owner_id = %L where id = %L', at.id('member'), at.id('c1')));
  perform at.ok(e = '' and (select kind || '|' || lifecycle || '|' || legal_name from public.clients where id = at.id('c1')) = 'company|lead|Ruiz Consulting LLC', 'a member sets type, legal name, tax id, stage, source and responsible');
  perform at.ok((select changes -> 'legal_name' ->> 'to' from public.crm_events where entity = 'client' and client_id = at.id('c1') and action = 'updated' order by id desc limit 1) = 'Ruiz Consulting LLC'
            and (select changes -> 'kind' ->> 'from' from public.crm_events where entity = 'client' and client_id = at.id('c1') order by id desc limit 1) = 'individual', 'history keeps old → new values of each changed field');
  perform at.ok(at.err('member', format('update public.clients set owner_id = %L where id = %L', at.id('other'), at.id('c2'))) like '%CRM_OWNER_INVALID%', 'the responsible must be a member of the same company');
  perform at.ok(at.err('member', format('update public.clients set lifecycle = ''vip'' where id = %L', at.id('c2'))) like '%clients_crm_check%', 'lifecycle values are checked by the database');
  perform at.ok(at.n('member', format('select count(*) from public.crm_find_duplicates(%L, null, ''  CARMEN@ruiz.test '', null, null)', at.id('A'))) = 1, 'duplicate by email (case and spaces ignored), only within the company');
  perform at.ok(at.val('member', format('select array_to_string(reasons, '','') from public.crm_find_duplicates(%L, ''carmen  ruiz'', null, ''787.555.0101'', ''661234567'')', at.id('A'))) = 'phone,tax_id,name', 'duplicate by phone digits, tax id without punctuation and name');
  perform at.ok(at.n('member', format('select count(*) from public.crm_find_duplicates(%L, ''Carmen Ruiz'', null, null, null, %L)', at.id('A'), at.id('c1'))) = 0, 'the client being edited is excluded');
  perform at.ok(at.n('other', format('select count(*) from public.crm_find_duplicates(%L, ''Carmen Ruiz'', ''carmen@ruiz.test'', null, null)', at.id('A'))) = 0, 'another company finds nothing of company A');
end $$;

-- ===================================================================== contacts and tags
do $$ declare k1 uuid; k2 uuid; t1 uuid; t2 uuid; tb uuid; begin
  k1 := at.val('member', format('select public.crm_save_contact(%L, null, %L, ''Laura'', ''Méndez'', ''Compras'', ''Laura@Ruiz.test'', ''787-555-0111'', true, null)', at.id('A'), at.id('c1')))::uuid;
  k2 := at.val('member', format('select public.crm_save_contact(%L, null, %L, ''Pedro'', null, null, null, null, true, ''Prefiere WhatsApp'')', at.id('A'), at.id('c1')))::uuid;
  perform at.put('k1', k1::text);
  perform at.ok((select is_primary from public.crm_contacts where id = k1) = false and (select is_primary from public.crm_contacts where id = k2) and (select email from public.crm_contacts where id = k1) = 'laura@ruiz.test',
    'contacts of a company client: one primary at a time; email stored in lower case');
  perform at.ok(at.err('member', format('select public.crm_save_contact(%L, null, %L, ''X'', null, null, ''bad-email'', null, false, null)', at.id('A'), at.id('c1'))) like '%crm_contacts_email_check%', 'contact email validated by the database');
  perform at.ok(at.err('other', format('select public.crm_save_contact(%L, null, %L, ''X'', null, null, null, null, false, null)', at.id('B'), at.id('c1'))) like '%CLIENT_NOT_FOUND%', 'a contact cannot point to a client of another company');
  perform at.ok(at.n('other', 'select count(*) from public.crm_contacts') = 0, 'another company reads no contacts');
  perform at.ok(at.err('member', format('select public.crm_save_tag(%L, null, ''VIP'', ''amber'')', at.id('A'))) like '%FORBIDDEN%', 'tags catalog: configure permission only');
  t1 := at.val('admin', format('select public.crm_save_tag(%L, null, ''VIP'', ''amber'')', at.id('A')))::uuid;
  t2 := at.val('admin', format('select public.crm_save_tag(%L, null, ''Gobierno'', ''blue'')', at.id('A')))::uuid;
  tb := at.val('other', format('select public.crm_save_tag(%L, null, ''Otra'', ''red'')', at.id('B')))::uuid;
  perform at.ok(at.err('admin', format('select public.crm_save_tag(%L, null, '' vip '', ''red'')', at.id('A'))) like '%CRM_TAG_EXISTS%', 'tag names are unique per company (case-insensitive)');
  perform at.ok(at.n('member', format('select public.crm_set_client_tags(%L, array[%L, %L]::uuid[])', at.id('c1'), t1, t2)) = 2, 'a member tags a client');
  perform at.ok(at.err('member', format('select public.crm_set_client_tags(%L, array[%L]::uuid[])', at.id('c1'), tb)) like '%CRM_TAG_NOT_FOUND%', 'a tag of another company is refused');
  perform at.ok(at.n('member', format('select public.crm_set_client_tags(%L, array[%L]::uuid[])', at.id('c1'), t1)) = 1
            and (select changes::text from public.crm_events where entity = 'client_tag' order by id desc limit 1) like '%Gobierno%', 'replacing tags is recorded (from → to)');
  perform at.put('tag_vip', t1::text);
end $$;

-- ===================================================================== opportunities, visibility, pipeline totals
do $$ declare o1 uuid; o1b uuid; o2 uuid; o3 uuid; v integer; begin
  o1 := at.val('member', format('select public.crm_save_opportunity(%L, null, %L, %L, ''Auditoría anual'', null, 100001, null, current_date + 30, null, ''Web'', null, null, null, %L)',
                                at.id('A'), at.id('c1'), at.id('k1'), 'aa000000-0000-4000-8000-000000000001'))::uuid;
  o1b := at.val('member', format('select public.crm_save_opportunity(%L, null, %L, %L, ''Auditoría anual'', null, 100001, null, current_date + 30, null, ''Web'', null, null, null, %L)',
                                at.id('A'), at.id('c1'), at.id('k1'), 'aa000000-0000-4000-8000-000000000001'))::uuid;
  perform at.ok(o1 = o1b and (select count(*) from public.crm_opportunities) = 1, 'idempotent creation: the same submission returns the same opportunity');
  perform at.ok((select owner_id from public.crm_opportunities where id = o1) = at.id('member') and (select probability_bp from public.crm_opportunities where id = o1) = 1000
            and (select lifecycle from public.clients where id = at.id('c1')) = 'prospect', 'defaults: responsible = creator, probability of the stage; the lead becomes a prospect');
  perform at.ok(at.err('member', format('select public.crm_save_opportunity(%L, null, %L, null, ''x'', null, -1, null, null, null, null, null, null, null, gen_random_uuid())', at.id('A'), at.id('c2'))) like '%CRM_AMOUNT_INVALID%', 'negative values refused');
  perform at.ok(at.err('member', format('select public.crm_save_opportunity(%L, null, %L, null, ''x'', null, 1, 12000, null, null, null, null, null, null, gen_random_uuid())', at.id('A'), at.id('c2'))) like '%CRM_PROBABILITY_INVALID%', 'probability limited to 0–100 %');
  perform at.ok(at.err('member', format('select public.crm_save_opportunity(%L, null, %L, null, ''x'', null, 1, null, null, null, null, null, null, null, gen_random_uuid())', at.id('A'), at.id('cB'))) like '%CLIENT_NOT_FOUND%', 'a client of another company cannot be used');
  perform at.ok(at.err('member', format('select public.crm_save_opportunity(%L, null, %L, null, ''x'', null, 1, null, null, %L, null, null, null, null, gen_random_uuid())', at.id('A'), at.id('c2'), at.id('other'))) like '%CRM_OWNER_INVALID%', 'the responsible of an opportunity must belong to the company');
  o2 := at.val('member2', format('select public.crm_save_opportunity(%L, null, %L, null, ''Licencias'', null, 5, null, null, null, null, null, null, null, gen_random_uuid())', at.id('A'), at.id('c2')))::uuid;
  o3 := at.val('admin', format('select public.crm_save_opportunity(%L, null, %L, null, ''Soporte'', null, 250000, 2500, null, %L, null, null, (select id from public.crm_pipeline_stages where company_id = %L and key = ''qualified''), null, gen_random_uuid())',
                                at.id('A'), at.id('c2'), at.id('admin'), at.id('A')))::uuid;
  perform at.put('o1', o1::text); perform at.put('o2', o2::text); perform at.put('o3', o3::text);
  perform at.ok(at.n('member', 'select count(*) from public.crm_opportunities') = 1 and at.n('member2', 'select count(*) from public.crm_opportunities') = 1
            and at.n('admin', 'select count(*) from public.crm_opportunities') = 3 and at.n('owner', 'select count(*) from public.crm_opportunities') = 3
            and at.n('other', 'select count(*) from public.crm_opportunities') = 0, 'visibility: members see their own; owner and admin all; another company none');
  -- weighted: (100001 × 1000 + 5 × 1000) / 10000 = 10000.6 → 10001 (new); 250000 × 2500 / 10000 = 62500 (qualified, manual 25 %)
  perform at.ok(at.val('owner', format('select string_agg(key || '':'' || opportunities || '':'' || amount_cents || '':'' || weighted_cents, '','' order by stage_position) from public.crm_pipeline_summary(%L) where opportunities > 0', at.id('A')))
            = 'new:2:100006:10001,qualified:1:250000:62500', 'pipeline totals from the real rows, weighted rounded once (owner)');
  perform at.ok(at.val('member', format('select string_agg(key || '':'' || opportunities || '':'' || amount_cents, '','') from public.crm_pipeline_summary(%L) where opportunities > 0', at.id('A'))) = 'new:1:100001',
    'the same totals for a member only count what it may see');
  perform at.ok(at.err('member2', format('select public.crm_move_opportunity(%L, (select id from public.crm_pipeline_stages where key = ''contacted'' and company_id = %L), 1)', o1, at.id('A'))) like '%CRM_OPPORTUNITY_NOT_FOUND%',
    'a member cannot move another member''s opportunity');
  -- moves
  perform at.ok(at.err('member', format('select public.crm_move_opportunity(%L, (select id from public.crm_pipeline_stages where key = ''contacted'' and company_id = %L), 7)', o1, at.id('A'))) like '%CRM_STALE%', 'stale version refused');
  v := at.n('member', format('select public.crm_move_opportunity(%L, (select id from public.crm_pipeline_stages where key = ''proposal'' and company_id = %L), 1)', o1, at.id('A')));
  perform at.ok(v = 2 and (select probability_bp from public.crm_opportunities where id = o1) = 6000, 'stage change applies the stage probability');
  perform at.ok(at.err('member', format('select public.crm_move_opportunity(%L, (select id from public.crm_pipeline_stages where key = ''lost'' and company_id = %L), 2, '' '')', o1, at.id('A'))) like '%CRM_LOST_REASON_REQUIRED%', 'losing requires a reason');
  v := at.n('member', format('select public.crm_move_opportunity(%L, (select id from public.crm_pipeline_stages where key = ''lost'' and company_id = %L), 2, ''Precio'')', o1, at.id('A')));
  perform at.ok((select status || '|' || lost_reason || '|' || probability_bp || '|' || (closed_at is not null) from public.crm_opportunities where id = o1) = 'lost|Precio|0|true', 'lost: reason, 0 %, closing time');
  perform at.ok(at.err('member', format('select public.crm_save_opportunity(%L, %L, %L, null, ''x'', null, 1, null, null, null, null, null, null, 3, null)', at.id('A'), o1, at.id('c1'))) like '%CRM_OPPORTUNITY_CLOSED%', 'a closed opportunity is not edited (reopen it first)');
  v := at.n('member', format('select public.crm_move_opportunity(%L, (select id from public.crm_pipeline_stages where key = ''negotiation'' and company_id = %L), 3)', o1, at.id('A')));
  perform at.ok((select status || '|' || coalesce(lost_reason, '-') || '|' || (closed_at is null) from public.crm_opportunities where id = o1) = 'open|-|true', 'reopened: open again, no reason, no closing time');
  v := at.n('member', format('select public.crm_move_opportunity(%L, (select id from public.crm_pipeline_stages where key = ''won'' and company_id = %L), 4)', o1, at.id('A')));
  perform at.ok((select status from public.crm_opportunities where id = o1) = 'won' and (select lifecycle from public.clients where id = at.id('c1')) = 'customer', 'won: the prospect becomes a customer');
  perform at.ok((select string_agg(action, ',' order by id) from public.crm_events where opportunity_id = o1 and entity = 'opportunity') = 'created,stage_changed,lost,reopened,won', 'opportunity history');
  perform at.ok(at.n('member2', format('select count(*) from public.crm_events where opportunity_id = %L', o1)) = 0 and at.n('member', format('select count(*) from public.crm_events where opportunity_id = %L', o1)) >= 5,
    'the history follows the opportunity visibility');
  -- update with version and manual probability
  perform at.put('o3b', at.val('admin', format('select public.crm_save_opportunity(%L, %L, %L, null, ''Soporte 24/7'', ''Contrato anual'', 300000, null, null, %L, null, null, null, 1, null)', at.id('A'), o3, at.id('c2'), at.id('admin'))));
  perform at.ok(at.id('o3b') = o3
            and (select amount_cents || '|' || probability_bp || '|' || probability_manual || '|' || version from public.crm_opportunities where id = o3) = '300000|4000|false|2', 'edit: clearing the manual probability returns to the stage one');
  -- stages
  perform at.ok(at.err('member', format('select public.crm_save_stage(%L, null, ''Demo'', ''Demo'', 5000, 45, true)', at.id('A'))) like '%FORBIDDEN%', 'members cannot change the pipeline');
  perform at.ok(at.err('owner', format('select public.crm_save_stage(%L, (select id from public.crm_pipeline_stages where key = ''won'' and company_id = %L), ''Ganado'', ''Won'', 9000, 90, true)', at.id('A'), at.id('A'))) like '%CRM_STAGE_FIXED%', 'won stays at 100 %');
  perform at.ok(at.err('owner', format('select public.crm_save_stage(%L, (select id from public.crm_pipeline_stages where key = ''qualified'' and company_id = %L), ''Calificado'', ''Qualified'', 4000, 30, false)', at.id('A'), at.id('A'))) like '%CRM_STAGE_IN_USE%', 'a stage with open opportunities cannot be deactivated');
  perform at.put('e', at.err('owner', format('select public.crm_save_stage(%L, null, ''Demostración'', ''Demo'', 5000, 45, true)', at.id('A'))) || '.');
  perform at.ok((select val from at.ctx where key = 'e') = '.'
            and (select count(*) from public.crm_pipeline_stages where company_id = at.id('A')) = 8, 'a custom stage is added');
end $$;

-- ===================================================================== activities
do $$ declare a1 uuid; a2 uuid; n1 uuid; v integer; begin
  perform at.ok(at.err('member', format('select public.crm_save_activity(%L, null, ''task'', ''Llamar'', null, null, %L, null, null, null, null, null, gen_random_uuid())', at.id('A'), at.id('c2'))) like '%CRM_DUE_REQUIRED%', 'a task needs a due date');
  perform at.ok(at.err('member', format('select public.crm_save_activity(%L, null, ''note'', ''x'', null, ''outbound'', %L, null, null, null, null, null, gen_random_uuid())', at.id('A'), at.id('c2'))) like '%CRM_ACTIVITY_INVALID%', 'direction only for calls and emails');
  a1 := at.val('member', format('select public.crm_save_activity(%L, null, ''task'', ''Enviar propuesta'', null, null, null, null, %L, now() - interval ''2 days'', null, null, %L)', at.id('A'), at.id('o1'), 'ab000000-0000-4000-8000-000000000001'))::uuid;
  perform at.ok(a1 = at.val('member', format('select public.crm_save_activity(%L, null, ''task'', ''Enviar propuesta'', null, null, null, null, %L, now() - interval ''2 days'', null, null, %L)', at.id('A'), at.id('o1'), 'ab000000-0000-4000-8000-000000000001'))::uuid
            and (select client_id from public.crm_activities where id = a1) = at.id('c1'), 'idempotent; the client comes from the opportunity');
  a2 := at.val('member', format('select public.crm_save_activity(%L, null, ''email'', ''Correo de seguimiento'', ''Resumen de la reunión'', ''outbound'', %L, %L, null, now() + interval ''1 day'', %L, null, gen_random_uuid())', at.id('A'), at.id('c1'), at.id('k1'), at.id('member2')))::uuid;
  n1 := at.val('member2', format('select public.crm_save_activity(%L, null, ''note'', ''Cliente pidió descuento'', null, null, %L, null, null, null, null, null, gen_random_uuid())', at.id('A'), at.id('c1')))::uuid;
  perform at.ok((select status || '|' || (completed_at is not null) from public.crm_activities where id = n1) = 'completed|true', 'a note is recorded as done');
  perform at.ok(at.n('member', format('select count(*) from public.crm_activities where company_id = %L and status = ''pending'' and due_at < now()', at.id('A'))) = 1, 'overdue follow-ups: pending and past due');
  -- visibility: member2 is assigned the email (sees it), sees the client-level note, not the task of member's opportunity
  perform at.ok(at.n('member2', format('select count(*) from public.crm_activities where id in (%L, %L)', a2, n1)) = 2 and at.n('member2', format('select count(*) from public.crm_activities where id = %L', a1)) = 0,
    'activities: assigned and client-level visible; another member''s opportunity task hidden');
  perform at.ok(at.n('other', 'select count(*) from public.crm_activities') = 0, 'another company sees no activity');
  perform at.ok(at.err('member', format('select public.crm_save_activity(%L, null, ''call'', ''x'', null, null, %L, null, null, null, %L, null, gen_random_uuid())', at.id('A'), at.id('c1'), at.id('worker'))) like '%CRM_OWNER_INVALID%', 'only members can be assigned');
  perform at.ok(at.err('member', format('select public.crm_set_activity_status(%L, ''completed'', ''Enviada'', 5)', a1)) like '%CRM_STALE%', 'stale completion refused');
  v := at.n('member', format('select public.crm_set_activity_status(%L, ''completed'', ''Enviada por correo'', 1)', a1));
  perform at.ok(v = 2 and (select status || '|' || outcome || '|' || (completed_by = at.id('member')) from public.crm_activities where id = a1) = 'completed|Enviada por correo|true', 'complete with outcome; who and when recorded');
  perform at.ok(at.err('member', format('select public.crm_set_activity_status(%L, ''pending'', null, 1)', n1)) like '%CRM_ACTIVITY_INVALID%', 'notes have no status changes');
  perform at.ok(at.n('member', format('select count(*) from public.crm_activities where company_id = %L and status = ''pending'' and due_at < now()', at.id('A'))) = 0, 'no overdue follow-up once completed');
end $$;

-- ===================================================================== documents: links, quote → invoice, finance
do $$ declare q uuid; qd uuid; inv uuid; inv2 uuid; ji integer; e text; dB uuid; begin
  q := at.val('owner', format($q$insert into public.documents (company_id, client_id, created_by, document_type, document_number, title, subtotal, tax, total, items, language)
        values (%L, %L, %L, 'quote', 'x', 'Auditoría', 1000.00, 115.00, 1115.00, '[{"description":"Auditoría","quantity":1,"price":1000}]', 'es') returning id::text$q$, at.id('A'), at.id('c1'), at.id('owner')))::uuid;
  qd := at.val('owner', format($q$insert into public.documents (company_id, client_id, created_by, document_type, document_number, title, total) values (%L, %L, %L, 'quote', 'x', 'Borrador', 10) returning id::text$q$, at.id('A'), at.id('c2'), at.id('owner')))::uuid;
  perform at.ok(at.err('owner', format('select public.crm_convert_quote(%L, null, current_date + 30, gen_random_uuid())', q)) like '%CRM_QUOTE_NOT_ACCEPTED%', 'a draft quote is not converted');
  perform at.err('owner', format('update public.documents set status = ''sent'' where id = %L', q));
  perform at.err('owner', format('update public.documents set status = ''accepted'' where id = %L', q));
  perform at.ok((select status from public.documents where id = q) = 'accepted', 'quote accepted through the existing lifecycle');
  ji := (select count(*) from public.journal_entries where company_id = at.id('A'));
  perform at.ok(at.err('member', format('select public.crm_link_document(%L, %L, true)', at.id('o1'), qd)) like '%CRM_DOCUMENT_OTHER_CLIENT%', 'a document of another client cannot be linked');
  perform at.ok(at.err('owner', format('select public.crm_convert_quote(%L, null, current_date - 1, gen_random_uuid())', q)) like '%CRM_DUE_DATE_INVALID%', 'the due date cannot be in the past');
  inv := at.val('member', format('select public.crm_convert_quote(%L, %L, current_date + 30, %L)', q, at.id('o1'), 'ac000000-0000-4000-8000-000000000001'))::uuid;
  perform at.ok((select document_type || '|' || status || '|' || total || '|' || tax || '|' || (client_id = at.id('c1')) || '|' || (items = (select items from public.documents where id = q)) || '|' || (document_number like 'FAC-%')
                 from public.documents where id = inv) = 'invoice|draft|1115.00|115.00|true|true|true', 'accepted quote → DRAFT invoice: same client, lines and totals; numbered by the database');
  perform at.ok((select count(*) from public.journal_entries where company_id = at.id('A')) = ji, 'conversion posts nothing to the ledger (only sending the invoice does)');
  perform at.ok(at.val('member', format('select public.crm_convert_quote(%L, %L, current_date + 30, %L)', q, at.id('o1'), 'ac000000-0000-4000-8000-000000000001'))::uuid = inv, 'the same request returns the same invoice');
  perform at.ok(at.err('owner', format('select public.crm_convert_quote(%L, null, current_date + 30, gen_random_uuid())', q)) like '%CRM_QUOTE_ALREADY_CONVERTED%', 'a second conversion is refused while the invoice lives');
  perform at.ok(at.n('member', format('select count(*) from public.crm_opportunity_documents where opportunity_id = %L', at.id('o1'))) = 2, 'quote and invoice linked to the opportunity');
  perform at.ok(at.err('other', format('select public.crm_convert_quote(%L, null, current_date + 30, gen_random_uuid())', q)) like '%DOCUMENT_NOT_FOUND%', 'another company cannot convert it');
  -- the existing flow sends the invoice: one ledger entry, receivables show it
  perform at.err('owner', format('update public.documents set status = ''sent'' where id = %L', inv));
  perform at.ok((select count(*) from public.journal_entries where company_id = at.id('A') and source = 'invoice' and source_id = inv) = 1, 'sending (existing flow) posts it once');
  perform at.ok(at.val('owner', format('select balance_cents::text from public.ar_invoice_balances(%L) where document_id = %L', at.id('A'), inv)) = '111500', 'receivables read the balance (no CRM copy)');
  perform at.ok(at.n('member', format('select count(*) from public.ar_invoice_balances(%L)', at.id('A'))) = 0, 'members without receivables.view see no balances');
  -- void → convertible again
  perform at.err('owner', format($q$update public.documents set status = 'cancelled', metadata = metadata || jsonb_build_object('void', jsonb_build_object('reason', 'Error de prueba', 'voided_at', now(), 'previous_status', 'sent')) where id = %L$q$, inv));
  if (select status from public.documents where id = inv) = 'cancelled' then
    inv2 := at.val('owner', format('select public.crm_convert_quote(%L, null, current_date + 30, gen_random_uuid())', q))::uuid;
    perform at.ok(inv2 is not null and inv2 <> inv, 'after voiding the invoice, the quote can be invoiced again');
  else
    perform at.ok(false, 'void the converted invoice through the existing flow');
  end if;
  -- archived client: history stays, no new document
  perform at.err('admin', format('update public.clients set archived_at = now() where id = %L', at.id('c2')));
  perform at.err('owner', format('update public.documents set status = ''sent'' where id = %L', qd));
  perform at.err('owner', format('update public.documents set status = ''accepted'' where id = %L', qd));
  perform at.ok(at.err('owner', format('select public.crm_convert_quote(%L, null, current_date + 30, gen_random_uuid())', qd)) like '%CLIENT_ARCHIVED%', 'an archived client receives no new invoice');
  perform at.ok(at.n('owner', format('select count(*) from public.documents where client_id = %L', at.id('c2'))) = 1
            and at.n('owner', format('select count(*) from public.crm_opportunities where client_id = %L', at.id('c2'))) = 2, 'an archived client keeps its documents and opportunities');
  perform at.ok(at.err('owner', format('delete from public.clients where id = %L', at.id('c1'))) <> '', 'a client with history is never deleted');
  perform at.err('admin', format('update public.clients set archived_at = null where id = %L', at.id('c2')));
end $$;

-- ===================================================================== branches (plan limit, scoping, sharing)
do $$ declare b1 uuid; b2 uuid; b3 uuid; c3 uuid; ob uuid; begin
  perform at.ok(at.err('member', format('select public.crm_save_branch(%L, null, ''Ponce'', ''PON'', null)', at.id('A'))) like '%FORBIDDEN%', 'members cannot create branches');
  b1 := at.val('admin', format('select public.crm_save_branch(%L, null, ''San Juan'', ''sju'', null)', at.id('A')))::uuid;
  b2 := at.val('admin', format('select public.crm_save_branch(%L, null, ''Ponce'', ''PON'', null)', at.id('A')))::uuid;
  b3 := at.val('admin', format('select public.crm_save_branch(%L, null, ''Mayagüez'', ''MAY'', null)', at.id('A')))::uuid;
  perform at.ok((select code from public.branches where id = b1) = 'SJU', 'branch codes in upper case');
  perform at.ok(at.err('admin', format('select public.crm_save_branch(%L, null, ''Caguas'', ''CAG'', null)', at.id('A'))) like '%PLAN_LIMIT_BRANCHES%', 'Pro plan: 3 active branches (existing plan limit)');
  perform at.ok(at.err('admin', format('select public.crm_save_branch(%L, null, ''Otra'', ''SJU'', null)', at.id('A'))) like '%BRANCH_CODE_EXISTS%', 'branch codes unique per company');
  perform at.err('admin', format('select public.crm_set_branch_archived(%L, true)', b3));
  perform at.ok(at.err('admin', format('select public.crm_set_branch_member(%L, %L, true)', b1, at.id('other'))) like '%CRM_OWNER_INVALID%', 'only members of the company join a branch');
  perform at.err('admin', format('select public.crm_set_branch_member(%L, %L, true)', b1, at.id('member')));
  c3 := gen_random_uuid(); perform at.put('c3', c3::text);
  perform at.ok(at.err('owner', format('insert into public.clients (id, company_id, name, branch_id) values (%L, %L, ''Cliente Ponce'', %L)', c3, at.id('A'), b2)) = '', 'a client assigned to a branch');
  ob := at.val('admin', format('select public.crm_save_opportunity(%L, null, %L, null, ''Ponce deal'', null, 1000, null, null, %L, null, %L, null, null, gen_random_uuid())', at.id('A'), c3, at.id('member'), b2))::uuid;
  perform at.ok(at.n('member', format('select count(*) from public.clients where id = %L', c3)) = 1 and at.n('member', format('select count(*) from public.crm_opportunities where id = %L', ob)) = 1,
    'without scoping (default) nothing changes');
  perform at.ok(at.err('member', format('select public.crm_save_settings(%L, true, false)', at.id('A'))) like '%FORBIDDEN%', 'members cannot change visibility');
  perform at.err('owner', format('select public.crm_save_settings(%L, true, false)', at.id('A')));
  perform at.ok(at.n('member', format('select count(*) from public.clients where id = %L', c3)) = 0 and at.n('member', format('select count(*) from public.crm_opportunities where id = %L', ob)) = 0,
    'scoping on, clients not shared: a San Juan member does not see the Ponce client or its opportunity');
  perform at.ok(at.n('member', format('select count(*) from public.clients where id = %L', at.id('c1'))) = 1, 'clients without a branch stay visible to everyone');
  perform at.ok(at.n('member2', format('select count(*) from public.clients where id = %L', c3)) = 1 and at.n('owner', format('select count(*) from public.clients where id = %L', c3)) = 1,
    'members without branches and the owner keep seeing everything');
  perform at.ok(at.err('member', format('insert into public.clients (company_id, name, branch_id) values (%L, ''Intento'', %L)', at.id('A'), b2)) like '%CRM_BRANCH_INVALID%', 'a scoped member cannot create clients in another branch');
  perform at.err('owner', format('select public.crm_share_client(%L, %L, true)', c3, b1));
  perform at.ok(at.n('member', format('select count(*) from public.clients where id = %L', c3)) = 1, 'shared with San Juan: the client becomes visible');
  perform at.ok(at.n('member', format('select count(*) from public.crm_opportunities where id = %L', ob)) = 0, 'its Ponce opportunity stays in Ponce');
  perform at.err('owner', format('select public.crm_save_settings(%L, true, true)', at.id('A')));
  perform at.err('owner', format('select public.crm_share_client(%L, %L, false)', c3, b1));
  perform at.ok(at.n('member', format('select count(*) from public.clients where id = %L', c3)) = 1, 'sharing across branches turned on: clients readable from every branch');
  perform at.err('owner', format('select public.crm_save_settings(%L, false, true)', at.id('A')));
end $$;

-- ===================================================================== assistant proposals
do $$ begin
  perform at.ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'assistant_actions_kind_check')) like '%crm_task%', 'assistant actions accept CRM notes and tasks (still confirmed by the user)');
  perform at.ok(at.err('member', 'select public.assistant_propose(gen_random_uuid(), ''crm_task'', ''x'', ''{}'')') like '%ASSISTANT_NOT_FOUND%', 'no proposal outside an open server turn');
end $$;

do $$ begin
  if exists (select 1 from at.failures) then
    raise exception 'CRM 0035 TESTS FAILED: %', (select string_agg(msg, ' | ') from at.failures);
  end if;
  raise notice 'ALL CRM 0035 TESTS PASSED';
end $$;
