-- OBJECTS THAT EXIST IN PRODUCTION AND IN NO MIGRATION IN THIS REPOSITORY.
--
-- `public.rls_auto_enable` is not created by migrations 001-040, appears in no
-- commit in this repository's history, and is not created by either GitHub
-- workflow. It was found during the Phase 5 pre-deployment audit.
--
-- WHAT IT IS, ON PRIMARY EVIDENCE. The text below is copied verbatim out of the
-- production schema dump taken by `.github/workflows/database-backup.yml` on
-- 2026-08-25 (run 32807452809), which is a `pg_dump` of the live database.
--
-- WHAT IT DOES. On CREATE TABLE in schema `public`, it enables row level
-- security on the new table. That is the whole of it: it never disables row
-- level security, never grants, never drops, never reads or writes a row, and
-- it swallows its own failures into the log.
--
-- WHY IT IS CALLABLE BY anon. Supabase's project default is
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON
-- FUNCTIONS TO anon, authenticated, service_role`, which is in the same dump and
-- applies to all 84 functions there. The grant is the platform's blanket
-- default, not a deliberate exposure -- and it buys nothing, because a function
-- returning `event_trigger` cannot be invoked directly at all. The test suite
-- proves that rather than asserting it.
--
-- THIS FILE IS A TEST FIXTURE. Nothing applies it to production. It exists so
-- the rehearsal can run migrations 039 and 040 with this function live and an
-- event trigger attached, and show that neither migration is affected.

CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;



-- The attachment. NO `CREATE EVENT TRIGGER` appears in the production dump --
-- but `supabase db dump` runs as `postgres`, which on Supabase is not a full
-- superuser, and pg_dump omits event triggers such a role cannot dump. Absence
-- from the dump is therefore suggestive and not conclusive, so the rehearsal
-- assumes the WORSE case and attaches it.
create event trigger rls_auto_enable_on_ddl
  on ddl_command_end
  execute function public.rls_auto_enable();
