#!/usr/bin/env bash
# Concurrency for Document Studio (0028). Sourced by run.sh (psqlq / RUNAS /
# WORK / PORT defined); never touches Supabase.
SR_CO=f8000000-0000-4000-8000-000000000001
SR_OWNER=f9000000-0000-4000-8000-000000000001
sr_as() { # $1 db, $2 expression → its value, evaluated as the owner
  psqlq -d "$1" -tAc "select $2 from (select set_config('request.jwt.claims', '{\"sub\":\"$SR_OWNER\",\"role\":\"authenticated\"}', false)) s"
}
sr_setup() { # $1 db: a company with two letter drafts → ids in $WORK/sr_d1.id, sr_d2.id
  psqlq -d "$1" -c "
    insert into auth.users (id, email) values ('$SR_OWNER', 'owner@srace.test') on conflict do nothing;
    delete from public.companies where id = '$SR_CO';
    insert into public.companies (id, name, created_by) values ('$SR_CO', 'Carrera Estudio', '$SR_OWNER');
    insert into public.memberships (company_id, user_id, role) values ('$SR_CO', '$SR_OWNER', 'owner');" >/dev/null
  local c='{"v":1,"blocks":[{"type":"paragraph","text":"Hola"}]}'
  sr_as "$1" "(public.studio_save_document('$SR_CO', null, 'letter', 'Uno', null, '$c', '{}')).id" > "$WORK/sr_d1.id"
  sr_as "$1" "(public.studio_save_document('$SR_CO', null, 'letter', 'Dos', null, '$c', '{}')).id" > "$WORK/sr_d2.id"
}
sr_session() { # $1 db, $2 sql, $3 delay, $4 hold
  "${RUNAS[@]}" psql -X -q -h "$WORK" -p "$PORT" -U postgres -d "$1" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$SR_OWNER","role":"authenticated"}', true) \\g /dev/null
set local role authenticated;
select pg_sleep($3) \\g /dev/null
$2;
select pg_sleep($4) \\g /dev/null
commit;
\\echo SESSION_OK
SQL
}
sr_pair() {
  sr_session "$1" "$2" 0 1.5 >"$WORK/sr1.out" & local p1=$!
  sr_session "$1" "$3" 0.4 0 >"$WORK/sr2.out" & local p2=$!
  wait $p1 || true; wait $p2 || true
  echo "$(cat "$WORK/sr1.out" "$WORK/sr2.out" | grep -c SESSION_OK)|$(cat "$WORK/sr1.out" "$WORK/sr2.out" | grep -oE 'STUDIO_CONFLICT|STUDIO_LOCKED|STUDIO_TRANSITION|studio_documents_number_uidx' | sort | tr '\n' ',')"
}
sr_race_numbers() { # two different letters issued at once → two consecutive numbers, no duplicate
  sr_setup "$1"; local d1 d2; d1=$(cat "$WORK/sr_d1.id"); d2=$(cat "$WORK/sr_d2.id")
  echo "$(sr_pair "$1" "select public.studio_finalize('$d1', 1)" "select public.studio_finalize('$d2', 1)")|$(psqlq -d "$1" -tAc "select count(distinct number) || '/' || string_agg(right(number, 4), ',' order by number) from public.studio_documents where company_id = '$SR_CO'")"
}
sr_race_save() { # two people save the same draft from version 1 → one saves, the other gets a conflict
  sr_setup "$1"; local d1; d1=$(cat "$WORK/sr_d1.id")
  local c1='{"v":1,"blocks":[{"type":"paragraph","text":"A"}]}' c2='{"v":1,"blocks":[{"type":"paragraph","text":"B"}]}'
  echo "$(sr_pair "$1" "select public.studio_save_document('$SR_CO', '$d1', 'letter', 'Uno', null, '$c1', '{}', expected_version => 1)" "select public.studio_save_document('$SR_CO', '$d1', 'letter', 'Uno', null, '$c2', '{}', expected_version => 1)")|$(psqlq -d "$1" -tAc "select version || '/' || (content -> 'blocks' -> 0 ->> 'text') || '/' || (select count(*) from public.studio_versions where document_id = '$d1') from public.studio_documents where id = '$d1'")"
}
sr_race_save_issue() { # saving while the draft is issued → the save is refused; the issued copy is the version that was issued
  sr_setup "$1"; local d1; d1=$(cat "$WORK/sr_d1.id")
  local c='{"v":1,"blocks":[{"type":"paragraph","text":"tarde"}]}'
  echo "$(sr_pair "$1" "select public.studio_finalize('$d1', 1)" "select public.studio_save_document('$SR_CO', '$d1', 'letter', 'Uno', null, '$c', '{}', expected_version => 1)")|$(psqlq -d "$1" -tAc "select status || '/' || (content -> 'blocks' -> 0 ->> 'text') from public.studio_documents where id = '$d1'")"
}
