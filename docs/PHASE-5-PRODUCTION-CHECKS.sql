-- SUPERSEDED -- DO NOT RUN THIS FILE.
--
-- This was the check list for BEFORE migrations 034-038 were applied. They are
-- applied, and so are 039 and 040, so every expectation below is now wrong.
--
-- Block 1 also fails outright with
--   ERROR: relation "supabase_migrations.schema_migrations" does not exist
-- because that table belongs to the Supabase CLI (supabase db push), which this
-- project has never used: migrations are applied by hand in the SQL Editor.
--
-- WHAT TO RUN INSTEAD:  docs/PHASE-5-POST-APPLY-CHECKS.sql
-- It is one statement, it proves the same things from the objects themselves,
-- and it is checked by scripts/production-checks.test.mjs.

-- PHASE 5 -- READ-ONLY PRODUCTION CHECKS
--
-- Run these in the Supabase SQL editor BEFORE applying migrations 034-038.
-- Every statement is a SELECT. Nothing here creates, updates or deletes a row,
-- and nothing reads a budget, a purchase, an allocation or a settlement amount.
--
-- WHY THEY MATTER. Each migration refuses to run if the database is not in the
-- state it expects, so a wrong answer below means a migration will stop rather
-- than do damage -- but knowing beforehand is better than finding out.

-- 1. WHICH MIGRATIONS ARE ACTUALLY APPLIED.
--    Phase 5 assumes 033 is the newest. If 032 or 033 are missing, stop.
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 12;

-- 2. THE OBJECTS 034-038 EXPECT TO FIND. All five must be true.
select
  to_regclass('public.areas') is null                              as areas_not_yet_created,
  to_regproc('public.enforce_event_scope_integrity') is not null   as migration_025_present,
  to_regproc('public.current_person_id') is not null               as migration_031_present,
  to_regproc('public.set_person_archived') is not null             as migration_032_present,
  to_regproc('public.refuse_last_admin_removal') is not null       as migration_033_present;

-- 3. HOW MANY ROWS THE BACKFILL WILL TOUCH.
--    Every one of these gets the same single Area. Nothing else changes.
select
  (select count(*) from public.people)      as people,
  (select count(*) from public.events)      as events,
  (select count(*) from public.app_members) as memberships,
  (select count(*) from public.audit_log)   as audit_entries;

-- 4. THE UNIQUENESS RULES THAT BECOME PER-AREA.
--    Each of these indexes is replaced by an identical rule scoped to one Area.
--    If any is already missing, migration 035 will say so rather than proceed.
select indexname
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'events_one_christmas_per_year_idx',
    'events_name_and_date_unique_idx',
    'app_members_single_admin_idx',
    'app_members_email_case_insensitive_idx'
  )
order by indexname;

-- 5. THE TWO TABLE CONSTRAINTS THAT BECOME PER-AREA.
--    UNIQUE (user_id) is what currently makes one login mean one family.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.app_members'::regclass
  and conname in ('app_members_email_key', 'app_members_user_id_key');

-- 6. WHO ADMINISTERS THE FAMILY TODAY.
--    Exactly one row is expected. After 035 this becomes one per Area, and the
--    same person keeps the role.
select count(*) as active_admins
from public.app_members
where role = 'admin' and active;

-- 7. ANY MEMBERSHIP THAT NAMES NO PERSON.
--    Not a blocker -- 033 grandfathers these -- but they cannot be resolved to
--    an Area by anything except the backfill, so it is worth knowing.
select count(*) as memberships_without_a_person
from public.app_members
where person_id is null;

-- 8. CHRISTMAS 2026, UNCHANGED AND UNREAD.
--    Its identity only. No amounts are selected anywhere in this file.
select id, name, event_type, year, event_date, status
from public.events
where event_type = 'christmas' and year = 2026;
