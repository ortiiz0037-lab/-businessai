-- TEST-ONLY. Reproduces, in a local throw-away database, a protection that
-- hosted Supabase installs and the local shim (00_supabase_shim.sql) does not:
-- copied verbatim from supabase/storage, migrations/tenant/0055-prevent-direct-deletes.sql.
--
-- A direct DELETE on storage.objects / storage.buckets raises 42501 "Direct
-- deletion from storage tables is not allowed" unless storage.allow_delete_query
-- is 'true'. The Storage API sets it for every request, in the same transaction
-- as the caller's role and JWT claims (src/internal/database/postgres/scope.ts):
-- for a request of the Storage API this trigger never decides, RLS does.
--
-- Applied on top of the shim only by the scenarios that must behave like the
-- hosted database (supabase/tests/local/run.sh); never by a migration.
CREATE OR REPLACE FUNCTION storage.protect_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Check if storage.allow_delete_query is set to 'true'
    IF COALESCE(current_setting('storage.allow_delete_query', true), 'false') != 'true' THEN
        RAISE EXCEPTION 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
            USING HINT = 'This prevents accidental data loss from orphaned objects.',
                  ERRCODE = '42501';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS protect_buckets_delete ON storage.buckets;
CREATE TRIGGER protect_buckets_delete
    BEFORE DELETE ON storage.buckets
    FOR EACH STATEMENT
    EXECUTE FUNCTION storage.protect_delete();

DROP TRIGGER IF EXISTS protect_objects_delete ON storage.objects;
CREATE TRIGGER protect_objects_delete
    BEFORE DELETE ON storage.objects
    FOR EACH STATEMENT
    EXECUTE FUNCTION storage.protect_delete();
