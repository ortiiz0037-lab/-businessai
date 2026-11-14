-- Rollback of 0031 (Intelligence Center insights). Read-only function: no data to keep.
begin;
set local lock_timeout = '5s';
drop function if exists public.assistant_insights(uuid, date, date);
commit;
