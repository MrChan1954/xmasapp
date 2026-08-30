-- Three routines nothing calls, and two tables a member could empty.
--
-- ===========================================================================
-- PART ONE -- THE THREE ROUTINES
-- ===========================================================================
--
-- WHAT THEY ARE
--
--   is_family_contributor_member()
--     Migration 031's question "is this login a family contributor". Migration
--     039 replaced it with `is_area_contributor_member(area_id)` and kept the
--     old name alive as a delegating wrapper so nothing broke mid-flight.
--     Nothing has called it since.
--
--   save_christmas_recipient(uuid, uuid, text, integer)
--   save_recipient_contributions(uuid, jsonb)
--     Migration 011/012's two-step way to save a recipient and then its
--     contributions. Superseded by
--     `save_christmas_recipient_with_contributions`, which does both in one
--     transaction so a budget and its allocations can never disagree. Migration
--     012 revoked both from `authenticated` and nothing ever granted them back,
--     so no browser session has been able to call either since.
--
-- WHY THEY GO NOW, AND HOW THAT WAS PROVED
--
--   Q15 checked each of the three against eight kinds of dependency and found
--   none of any kind:
--
--     other SQL function bodies    none
--     row level security policies  none
--     trigger attachments          none
--     constraints, indexes, views  none
--     src/ application code        none
--     API routes, service-role     none
--     .github background jobs      none
--     the PostgREST pre-request hook   none (it is claim_active_area)
--
--   Callers were read from `pg_proc.prosrc` of the FINAL definition of every
--   routine in the schema, not from migration text -- a routine that migration
--   012 called and migration 045 stopped calling has to count as uncalled, and
--   only the end state can say so.
--
--   Then the database was asked directly. Against a rehearsal carrying
--   001-050, `drop function ... restrict` succeeded for all three. RESTRICT is
--   the point: PostgreSQL refuses it if any catalogue object depends on the
--   function, so a clean drop is the database's own testimony rather than a
--   grep's. Afterwards the policy, trigger and index counts were unchanged at
--   37 / 61 / 77, and no remaining routine body named any of the three.
--
-- WHAT IS DELIBERATELY NOT DROPPED
--
--   `save_purchase(...)` looks like their sibling and is not. Migration 047's
--   notes group all three together as "inner routines reached only through
--   wrappers", and that is true of `save_purchase` alone --
--   `save_purchase_with_location` really does call it. It stays.
--
-- ===========================================================================
-- PART TWO -- THE TWO TABLES
-- ===========================================================================
--
-- WHAT WAS WRONG
--
--   Supabase's project default is
--
--       ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--         GRANT ALL ON TABLES TO anon, authenticated, service_role
--
--   so every table created in `public` arrives with ALL granted to the browser
--   roles unless a migration takes it away. Twenty of the twenty-two tables
--   revoke first and grant back narrowly. Two never revoked from
--   `authenticated`:
--
--     034: grant select on table public.areas to authenticated;
--     040: revoke all on table public.birthday_wishlist_ideas from anon;
--          grant select, insert, update, delete on table
--            public.birthday_wishlist_ideas to authenticated;
--
--   Both added the grant they meant on top of a blanket grant they never took
--   off. Migration 040 revoked `anon` and stopped there.
--
-- MEASURED AGAINST PRODUCTION, NOT INFERRED
--
--   From the schema dump taken by .github/workflows/database-backup.yml on
--   2026-08-30 at 18:40:06Z (run 33328658398), which is a pg_dump of the live
--   database:
--
--       GRANT ALL ON TABLE "public"."areas" TO "authenticated";
--       GRANT ALL ON TABLE "public"."birthday_wishlist_ideas" TO "authenticated";
--
--   Those are the ONLY two `GRANT ALL ... TO authenticated` lines in the whole
--   production schema. Every other table reads `GRANT SELECT`, or SELECT plus
--   the specific verbs it needs. Neither table grants anything to `anon`.
--
-- WHY IT MATTERS: ROW LEVEL SECURITY DOES NOT CONSTRAIN TRUNCATE
--
--   Row policies are consulted for SELECT, INSERT, UPDATE and DELETE. They are
--   never consulted for TRUNCATE, which is a table-level privilege only. So the
--   blanket grant is not neutralised by RLS the way the rest of it is.
--
--   Measured in a rehearsal, as an ordinary `authenticated` member acting in
--   their own Area, with one wishlist row seeded in each of three Areas:
--
--       select    allowed, narrowed by RLS
--       insert    refused by RLS
--       update    allowed, 0 rows -- no policy matches
--       delete    allowed, 0 rows -- no policy matches
--       truncate  SUCCEEDED -- all three Areas' rows destroyed, including the
--                 Area the member was not acting in
--
--   The same member was refused `permission denied` truncating `people`,
--   `events` and `audit_log`, which were revoked properly. On `areas` the
--   truncate was refused too -- but only with "cannot truncate a table
--   referenced in a foreign key constraint", which is an accident of the schema
--   and not a permission check. Restructure those foreign keys and it works.
--
-- HOW BAD, HONESTLY
--
--   Not reachable today. PostgREST maps only GET/POST/PATCH/DELETE onto
--   SELECT/INSERT/UPDATE/DELETE plus RPC; it has no TRUNCATE verb, no
--   SECURITY INVOKER routine here issues one, and a browser holds a JWT rather
--   than database credentials. So this is a latent capability, not a live
--   breach, and nothing in the family's data has been at risk.
--
--   It is fixed here because the protection is currently the client protocol's
--   verb set rather than the grant, and "the database must refuse on its own"
--   is the rule this whole application rests on. A capability that survives
--   only because nobody has spoken the right sentence is not a refusal.
--
-- WHY `REVOKE ALL` AND NOT `REVOKE TRUNCATE`
--
--   The residue is four privileges, not one: TRUNCATE, REFERENCES, TRIGGER and
--   -- on PostgreSQL 17 and later -- MAINTAIN. None is used by any code path
--   here, and none is meaningful to a PostgREST client.
--
--   Naming them individually would also pin this file to a server version:
--   MAINTAIN does not exist before PostgreSQL 17, so `revoke maintain` fails
--   outright on an older server and `revoke truncate, references, trigger`
--   silently leaves MAINTAIN behind on a newer one. `revoke all` is correct on
--   every version, and it states the intended privileges positively afterwards
--   instead of trying to enumerate what to take away.
--
-- WHAT THE MINIMUM SET IS, AND HOW IT WAS DERIVED
--
--   Not from the policies alone -- from what the application actually issues,
--   cross-checked against the policies and against the grants 034 and 040
--   intended. Every `.from("areas")` and `.from("birthday_wishlist_ideas")` in
--   `src/` was read:
--
--     areas                    6 call sites, every one `.select(`
--                              -- api/areas/route.ts, api/areas/membership/route.ts,
--                                 components/use-areas.ts, supabase/area-choice-client.ts,
--                                 supabase/areas-server.ts, supabase/people-server.ts
--                              Writes go through create_area, set_area_name,
--                              set_area_archived, leave_area and
--                              transfer_area_admin, which are SECURITY DEFINER
--                              and run with the owner's rights, so they consult
--                              no caller grant.
--                              => SELECT
--
--     birthday_wishlist_ideas  6 call sites: select x3, insert, update, delete
--                              -- birthdays/[personId]/wishlist-editor.tsx writes
--                                 directly from the browser
--                              => SELECT, INSERT, UPDATE, DELETE
--
--   Both answers agree exactly with the policies each table carries (`areas`
--   has one SELECT policy; the wishlist has all four) and with what migrations
--   034 and 040 wrote. Nothing is being narrowed below what the app uses, and
--   nothing it uses is being taken away.
--
-- WHAT IS DELIBERATELY LEFT ALONE
--
--   `service_role` keeps everything on both tables. It bypasses row level
--   security and the write barrier regardless, so removing anything would buy
--   nothing and would surprise server-side code later.
--
--   `anon` is named in the revoke for symmetry with migration 048 and because
--   saying it costs nothing. It holds nothing on either table today -- checked
--   in the production dump above -- so that half is a no-op.
--
--   No policy, trigger, index, column or row is touched by this file. Not
--   `app_members.contributor_id`, not `events.year`, not the
--   `christmas_events` view -- Q15 classified all three as required or as
--   legacy-but-live, and none is in scope here.
--
-- ROLLBACK
--
--   docs/Q15-051-ROLLBACK.sql, rehearsed against a database carrying 001-051.
--   It recreates the three routines from the production definitions and
--   restores `grant all` on both tables. Everything this file does is a
--   catalogue change, so rollback loses no data.
--
-- NO DATA IS READ OR WRITTEN BY THIS FILE.
--   No insert, no update, no delete, no truncate, no DDL on any table's shape.

-- ---------------------------------------------------------------------------
-- 1. Drop the three superseded routines
--
-- RESTRICT is PostgreSQL's default and is written out anyway: it is the whole
-- safety argument. If anything at all has come to depend on one of these since
-- the audit, this file stops here rather than taking the dependency with it.
-- ---------------------------------------------------------------------------

drop function if exists public.is_family_contributor_member() restrict;

drop function if exists public.save_christmas_recipient(uuid, uuid, text, integer) restrict;

drop function if exists public.save_recipient_contributions(uuid, jsonb) restrict;

-- ---------------------------------------------------------------------------
-- 2. Narrow the two tables to the privileges the application actually uses
--
-- Revoke everything, then state the intended set. Idempotent: running this file
-- twice reaches the same place.
-- ---------------------------------------------------------------------------

revoke all on table public.areas from public, anon, authenticated;
grant select on table public.areas to authenticated;

revoke all on table public.birthday_wishlist_ideas from public, anon, authenticated;
grant select, insert, update, delete on table public.birthday_wishlist_ideas to authenticated;

comment on table public.areas is
  'One family. Readable by its members; every write goes through a SECURITY DEFINER routine, so authenticated holds SELECT and nothing else (051).';
comment on table public.birthday_wishlist_ideas is
  'What the birthday person asked for, written by them from the browser. authenticated holds exactly SELECT, INSERT, UPDATE, DELETE -- never TRUNCATE, which row level security cannot constrain (051).';

-- ---------------------------------------------------------------------------
-- 3. End state
--
-- Says out loud what is now true, and refuses to finish if it is not.
--
-- The privilege checks read `aclexplode(relacl)` rather than calling
-- `has_table_privilege(..., 'MAINTAIN')`, because that privilege name does not
-- exist before PostgreSQL 17 and naming it would make this block fail on an
-- older server for a reason that has nothing to do with what it is testing.
-- Comparing the granted SET is also a stronger assertion: it catches a
-- privilege nobody thought to ask about.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  gone text;
  kept text;
  granted text[];
begin
  -- 3a. The three are gone.
  foreach gone in array array[
    'public.is_family_contributor_member()',
    'public.save_christmas_recipient(uuid, uuid, text, integer)',
    'public.save_recipient_contributions(uuid, jsonb)'
  ] loop
    if to_regprocedure(gone) is not null then
      problems := problems || format('%s is still present', gone)::text;
    end if;
  end loop;

  -- 3b. What replaced them is still here, and so is the sibling that is NOT
  --     redundant. Dropping save_purchase would break every purchase.
  foreach kept in array array[
    'public.is_area_contributor_member(uuid)',
    'public.save_christmas_recipient_with_contributions(uuid, uuid, text, integer, jsonb)',
    'public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb)',
    'public.save_purchase_with_location(uuid, uuid, text, integer, uuid, uuid, date, text, text, text, text, uuid, jsonb)',
    'public.set_person_birthday(uuid, smallint, smallint, smallint)'
  ] loop
    if to_regprocedure(kept) is null then
      problems := problems || format('%s went missing', kept)::text;
    end if;
  end loop;

  -- 3c. `areas`: authenticated holds exactly SELECT.
  select array_agg(privilege_type order by privilege_type)
    into granted
  from pg_class c, aclexplode(c.relacl) a
  where c.oid = 'public.areas'::regclass and a.grantee = 'authenticated'::regrole;

  if coalesce(granted, array[]::text[]) <> array['SELECT'] then
    problems := problems || format(
      'authenticated holds %s on public.areas, expected {SELECT}',
      coalesce(array_to_string(granted, ','), '(nothing)'))::text;
  end if;

  -- 3d. `birthday_wishlist_ideas`: exactly the four DML privileges.
  select array_agg(privilege_type order by privilege_type)
    into granted
  from pg_class c, aclexplode(c.relacl) a
  where c.oid = 'public.birthday_wishlist_ideas'::regclass and a.grantee = 'authenticated'::regrole;

  if coalesce(granted, array[]::text[]) <> array['DELETE', 'INSERT', 'SELECT', 'UPDATE'] then
    problems := problems || format(
      'authenticated holds %s on public.birthday_wishlist_ideas, expected {DELETE,INSERT,SELECT,UPDATE}',
      coalesce(array_to_string(granted, ','), '(nothing)'))::text;
  end if;

  -- 3e. TRUNCATE is refused on both, which is the point of the whole exercise.
  if has_table_privilege('authenticated', 'public.areas', 'TRUNCATE') then
    problems := problems || 'authenticated can still truncate public.areas'::text;
  end if;
  if has_table_privilege('authenticated', 'public.birthday_wishlist_ideas', 'TRUNCATE') then
    problems := problems || 'authenticated can still truncate public.birthday_wishlist_ideas'::text;
  end if;

  -- 3f. anon gained nothing, and service_role lost nothing.
  if exists (
    select 1 from pg_class c, aclexplode(c.relacl) a
    where c.oid in ('public.areas'::regclass, 'public.birthday_wishlist_ideas'::regclass)
      and a.grantee = 'anon'::regrole
  ) then
    problems := problems || 'anon now holds a privilege on one of the two tables'::text;
  end if;

  if not has_table_privilege('service_role', 'public.areas', 'SELECT')
     or not has_table_privilege('service_role', 'public.areas', 'INSERT')
     or not has_table_privilege('service_role', 'public.birthday_wishlist_ideas', 'SELECT')
     or not has_table_privilege('service_role', 'public.birthday_wishlist_ideas', 'INSERT') then
    problems := problems || 'service_role lost a privilege it needs'::text;
  end if;

  -- 3g. Row level security is still on, and no policy was disturbed.
  if not (select relrowsecurity from pg_class where oid = 'public.areas'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.birthday_wishlist_ideas'::regclass) then
    problems := problems || 'row level security was switched off somewhere'::text;
  end if;

  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'areas') <> 1 then
    problems := problems || 'public.areas no longer has exactly its one SELECT policy'::text;
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'birthday_wishlist_ideas') <> 4 then
    problems := problems || 'public.birthday_wishlist_ideas no longer has exactly its four policies'::text;
  end if;

  -- 3h. And the schema at large is where 050 left it.
  if (select count(*) from pg_policies where schemaname = 'public') <> 37 then
    problems := problems || format('expected 37 policies in public, found %s',
      (select count(*) from pg_policies where schemaname = 'public'))::text;
  end if;
  if (select count(*) from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal) <> 61 then
    problems := problems || 'the trigger count moved'::text;
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public') <> 77 then
    problems := problems || 'the index count moved'::text;
  end if;

  if array_length(problems, 1) is null then
    raise notice 'Migration 051: three superseded routines dropped; authenticated narrowed to SELECT on areas and to SELECT/INSERT/UPDATE/DELETE on birthday_wishlist_ideas; TRUNCATE refused on both; policies, triggers and indexes unchanged.';
  else
    raise exception 'Migration 051 did not reach its end state: %', array_to_string(problems, '; ');
  end if;
end;
$$;
