-- Rollback of 0032 (bank summary for the assistant). Read-only function: no data to keep.
begin;
set local lock_timeout = '5s';
drop function if exists public.assistant_bank_summary(uuid, date);
commit;
