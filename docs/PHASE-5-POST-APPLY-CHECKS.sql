-- =============================================================================
-- PHASE 5 -- READ-ONLY PRODUCTION CHECKS, AFTER MIGRATIONS 034-040
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and row counts and tells
--   you, line by line, whether migrations 034 to 040 are really in place and
--   whether the family's data is in the shape the application is about to
--   assume.
--
-- HOW TO RUN IT
--   Open the Supabase SQL Editor, paste this WHOLE file in, and press Run.
--   You will get one table back. Read the first column.
--
-- HOW TO READ THE RESULT
--   PASS     this check is fine. Nothing to do.
--   FAIL     something is wrong. Do not deploy. Send the whole table back.
--   INFO     a fact for the record, not a pass or a fail -- row counts, ids,
--            names. Worth reading, nothing to act on.
--   REVIEW   something a person has to look at and judge.
--
--   FAIL rows are sorted to the TOP, so if the first row says PASS and the
--   summary says 0 failed, everything passed.
--
-- EVERY STATEMENT HERE IS A SELECT
--   Nothing is created, altered, dropped, inserted, updated or deleted. No
--   function is called that changes anything. It reads no budget, no price, no
--   allocation, no settlement, no receipt, no gift title and no note -- only
--   counts, ids and the names of database objects.
--
-- WHY THIS FILE NO LONGER ASKS THE MIGRATION HISTORY TABLE
--   It used to start by reading `supabase_migrations.schema_migrations`, and
--   that failed with "relation does not exist". That table is created and
--   maintained by the Supabase CLI (`supabase db push` / `supabase migration
--   up`). THIS PROJECT HAS NEVER USED IT: there is no `supabase/config.toml`,
--   the CLI appears only in the backup workflow as `supabase db dump`, and every
--   migration has been applied by pasting it into the SQL Editor by hand. So the
--   table was never created -- and asking for it proved the wrong thing anyway.
--   It records which FILES a tool ran. What matters is which OBJECTS exist.
--
--   Sections 034 to 040 below check for the actual functions, tables, policies,
--   triggers, indexes and grants each migration was supposed to leave behind.
--
-- WHY IT IS ONE STATEMENT INSTEAD OF TWENTY-NINE
--   The Supabase SQL Editor shows the result of the LAST statement it runs. The
--   previous version of this file was twenty-nine separate queries, so
--   twenty-eight of them would have been invisible even if the first had not
--   errored. This is one query returning one table.
--
-- IF THE WHOLE QUERY ERRORS INSTEAD OF RETURNING A TABLE
--   Send the error text back. Two errors have a specific meaning:
--     * 'column "area_id" does not exist'  -> migration 034 did not land.
--     * 'relation "public.birthday_wishlist_ideas" does not exist'
--                                          -> migration 040 did not land.
--   Anything else is unexpected and worth reporting verbatim.
--
-- =============================================================================

with checks as (

-- ===========================================================================
-- 034  AREAS AND MEMBERSHIPS -- the tenant boundary itself
-- ===========================================================================

select 1001 as sort,
       '034 areas and memberships'::text as section,
       'the areas table exists'::text as check_name,
       (case when to_regclass('public.areas') is not null then 'PASS' else 'FAIL' end)::text as verdict,
       coalesce(to_regclass('public.areas')::text, '(missing)')::text as detail

union all
select 1010 + c.n, '034 areas and memberships',
       'column ' || c.tbl || '.area_id exists',
       case when exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = c.tbl and column_name = 'area_id'
       ) then 'PASS' else 'FAIL' end,
       coalesce((select data_type from information_schema.columns
                 where table_schema = 'public' and table_name = c.tbl and column_name = 'area_id'), '(missing)')
from (values ('people', 1), ('events', 2), ('app_members', 3), ('audit_log', 4)) as c(tbl, n)

union all
select 1020 + f.n, '034 areas and memberships',
       'function public.' || f.name || ' exists',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = f.name
       ) then 'PASS' else 'FAIL' end,
       coalesce((select 'takes: ' || coalesce(nullif(pg_get_function_identity_arguments(p.oid), ''), 'no arguments')
                 from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname = f.name limit 1), '(missing)')
from (values ('is_area_member', 1), ('is_area_admin', 2), ('current_person_in_area', 3)) as f(name, n)

union all
select 1030 + i.n, '034 areas and memberships',
       'index ' || i.name || ' exists',
       case when to_regclass('public.' || i.name) is not null then 'PASS' else 'FAIL' end,
       coalesce(to_regclass('public.' || i.name)::text, '(missing)')
from (values ('areas_events_identity_idx', 1), ('areas_people_identity_idx', 2)) as i(name, n)

-- ===========================================================================
-- 035  AREA INTEGRITY -- relationships that must be impossible
-- ===========================================================================

union all
select 2001, '035 area integrity',
       'function public.refuse_cross_area_person exists',
       case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                         and proname = 'refuse_cross_area_person') then 'PASS' else 'FAIL' end,
       'the one guard that refuses a person from another Area'

union all
select 2010 + t.n, '035 area integrity',
       'trigger ' || t.name || ' is attached',
       case when exists (select 1 from pg_trigger where tgname = t.name and not tgisinternal)
            then 'PASS' else 'FAIL' end,
       coalesce((select c.relname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
                 where tg.tgname = t.name and not tg.tgisinternal limit 1), '(not attached)')
from (values
  ('events_refuse_cross_area', 1),
  ('app_members_refuse_cross_area', 2),
  ('christmas_recipients_refuse_cross_area', 3),
  ('contributors_refuse_cross_area', 4),
  ('purchases_refuse_cross_area', 5)
) as t(name, n)

union all
select 2020 + i.n, '035 area integrity',
       'per-Area rule ' || i.name || ' exists',
       case when to_regclass('public.' || i.name) is not null then 'PASS' else 'FAIL' end,
       'uniqueness is now per family, not per application'
from (values
  ('events_one_christmas_per_area_year_idx', 1),
  ('events_name_and_date_per_area_idx', 2),
  ('app_members_single_admin_per_area_idx', 3),
  ('app_members_email_per_area_idx', 4),
  ('app_members_user_per_area_idx', 5),
  ('events_one_birthday_per_person_per_year_idx', 6),
  ('app_members_one_membership_per_person_idx', 7)
) as i(name, n)

union all
select 2040 + i.n, '035 area integrity',
       'superseded rule ' || i.name || ' is GONE',
       case when to_regclass('public.' || i.name) is null then 'PASS' else 'FAIL' end,
       'a global rule still standing would block a second family'
from (values
  ('events_one_christmas_per_year_idx', 1),
  ('events_name_and_date_unique_idx', 2),
  ('app_members_single_admin_idx', 3),
  ('app_members_email_case_insensitive_idx', 4)
) as i(name, n)

union all
select 2050 + c.n, '035 area integrity',
       'superseded constraint ' || c.name || ' is GONE',
       case when not exists (
         select 1 from pg_constraint
         where conrelid = 'public.app_members'::regclass and conname = c.name
       ) then 'PASS' else 'FAIL' end,
       'UNIQUE (user_id) is what used to make one login mean one family'
from (values ('app_members_email_key', 1), ('app_members_user_id_key', 2)) as c(name, n)

union all
select 2060, '035 area integrity',
       'the last-administrator guard counts within one Area',
       case when exists (
         select 1 from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'refuse_last_admin_removal' and position('area_id' in prosrc) > 0
       ) then 'PASS' else 'FAIL' end,
       'without this, Area B could lose its admin because Area A has one'

union all
select 2070 + t.n, '035 area integrity',
       'migration 033 trigger ' || t.name || ' survived',
       case when exists (select 1 from pg_trigger where tgname = t.name and not tgisinternal)
            then 'PASS' else 'FAIL' end,
       'redefining a function must not detach its triggers'
from (values ('app_members_keep_an_admin', 1), ('app_members_require_person_link', 2)) as t(name, n)

-- ===========================================================================
-- 036  AREA-SCOPED VISIBILITY -- row level security learns the Area
-- ===========================================================================

union all
select 3010 + f.n, '036 area-scoped visibility',
       'function public.' || f.name || ' exists',
       case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                         and proname = f.name) then 'PASS' else 'FAIL' end,
       'a lookup a policy uses to find a row''s Area'
from (values
  ('area_of_event', 1), ('area_of_recipient', 2), ('area_of_purchase', 3),
  ('area_of_gift_idea', 4), ('area_of_person', 5), ('area_of_member', 6),
  ('is_own_app_member', 7), ('current_member_in_area', 8)
) as f(name, n)

union all
select 3030, '036 area-scoped visibility',
       'the areas table has its read policy',
       case when exists (
         select 1 from pg_policies where schemaname = 'public' and tablename = 'areas'
           and policyname = 'members read their own areas'
       ) then 'PASS' else 'FAIL' end,
       (select count(*)::text || ' policies on public.areas'
        from pg_policies where schemaname = 'public' and tablename = 'areas')

union all
select 3040 + f.n, '036 area-scoped visibility',
       f.name || ' refuses to guess for a login in two Areas',
       case when exists (
         select 1 from pg_proc where pronamespace = 'public'::regnamespace
           and proname = f.name and position('= 1' in prosrc) > 0
       ) then 'PASS' else 'FAIL' end,
       'losing this lets a two-Area login be answered about the wrong family'
from (values ('current_app_member_id', 1), ('current_person_id', 2), ('is_app_admin', 3)) as f(name, n)

union all
select 3050 + f.n, '036 area-scoped visibility',
       f.name || ' resolves the reader inside the event''s own Area',
       case when exists (
         select 1 from pg_proc where pronamespace = 'public'::regnamespace
           and proname = f.name and position('current_person_in_area' in prosrc) > 0
       ) then 'PASS' else 'FAIL' end,
       'comparing across Areas would hide the wrong birthday, or reveal the right one'
from (values
  ('is_own_birthday_event', 1), ('is_own_birthday_recipient', 2),
  ('is_own_birthday_purchase', 3), ('is_own_birthday_gift_idea', 4)
) as f(name, n)

-- ===========================================================================
-- 037  AREA WRITE BARRIER -- what row level security cannot do
-- ===========================================================================

union all
select 4010 + f.n, '037 area write barrier',
       'function public.' || f.name || ' exists',
       case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                         and proname = f.name) then 'PASS' else 'FAIL' end,
       'definer routines bypass policies; a trigger is not bypassed'
from (values
  ('refuse_foreign_area_write', 1), ('area_of_written_row', 2), ('area_of_record', 3),
  ('stamp_audit_area', 4), ('default_area_for_new_row', 5), ('create_area', 6),
  ('set_area_name', 7), ('set_area_archived', 8)
) as f(name, n)

union all
select 4030 + t.n, '037 area write barrier',
       'write barrier on ' || t.tbl,
       case when exists (
         select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
         where tg.tgname = t.tbl || '_refuse_foreign_area' and not tg.tgisinternal
           and c.relname = t.tbl
       ) then 'PASS' else 'FAIL' end,
       'refuses a write into a family the caller does not belong to'
from (values
  ('people', 1), ('events', 2), ('app_members', 3), ('christmas_recipients', 4),
  ('contributors', 5), ('purchases', 6), ('purchase_allocations', 7), ('gift_ideas', 8),
  ('recipient_contributions', 9), ('settlements', 10), ('payment_receipts', 11),
  ('item_photos', 12), ('birthday_wishlist_ideas', 13)
) as t(tbl, n)

union all
select 4050 + t.n, '037 area write barrier',
       'missing-Area default on ' || t.tbl,
       case when exists (
         select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
         where tg.tgname = t.tbl || '_area_default' and not tg.tgisinternal and c.relname = t.tbl
       ) then 'PASS' else 'FAIL' end,
       'fills the Area for the routines written before Areas existed'
from (values ('people', 1), ('events', 2), ('app_members', 3)) as t(tbl, n)

union all
select 4060, '037 area write barrier',
       'audit entries learn their Area on the way in',
       case when exists (select 1 from pg_trigger where tgname = 'audit_log_stamp_area' and not tgisinternal)
            then 'PASS' else 'FAIL' end,
       'five migrations insert into audit_log; one trigger catches them all'

union all
select 4070 + t.n, '037 area write barrier',
       t.tbl || '.area_id is NOT NULL',
       case when exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = t.tbl
           and column_name = 'area_id' and is_nullable = 'NO'
       ) then 'PASS' else 'FAIL' end,
       'this is what makes every guard total rather than best-effort'
from (values ('people', 1), ('events', 2), ('app_members', 3)) as t(tbl, n)

-- ===========================================================================
-- 038  ACTING AREA -- which of my families am I speaking as?
-- ===========================================================================

union all
select 5010 + f.n, '038 acting area',
       'function public.' || f.name || ' exists',
       case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                         and proname = f.name) then 'PASS' else 'FAIL' end,
       'the x-area-id header becomes an acting Area through these'
from (values ('acting_area', 1), ('act_in_area', 2), ('claim_active_area', 3)) as f(name, n)

union all
select 5020 + f.n, '038 acting area',
       f.name || ' reads the acting Area',
       case when exists (
         select 1 from pg_proc where pronamespace = 'public'::regnamespace
           and proname = f.name and position('acting_area' in prosrc) > 0
       ) then 'PASS' else 'FAIL' end,
       'without this a login in two families loses every admin routine'
from (values
  ('current_app_member_id', 1), ('current_person_id', 2),
  ('is_app_admin', 3), ('default_area_for_new_row', 4)
) as f(name, n)

-- ===========================================================================
-- 039  AREA-AWARE CONTRIBUTOR PERMISSIONS   ** newly applied **
--
--      The migration that stopped a contributor in one family being treated as
--      a contributor in another, and stopped a SECURITY DEFINER routine reading
--      gift ideas across families.
-- ===========================================================================

union all
select 6001, '039 area-aware permissions',
       'function public.is_area_contributor_member exists',
       case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                         and proname = 'is_area_contributor_member') then 'PASS' else 'FAIL' end,
       'contributor eligibility, asked about ONE family'

union all
select 6002, '039 area-aware permissions',
       'is_area_contributor_member is SECURITY DEFINER and search_path-pinned',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'is_area_contributor_member'
           and p.prosecdef
           and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) s where s like 'search_path=%')
       ) then 'PASS' else 'FAIL' end,
       'it reads app_members, which a member may only read their own row of'

union all
select 6010 + a.n, '039 area-aware permissions',
       'set_person_birthday ' || a.label,
       case when exists (
         select 1 from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'set_person_birthday'
           and (case when a.must_contain then position(a.needle in prosrc) > 0
                     else position(a.needle in prosrc) = 0 end)
       ) then 'PASS' else 'FAIL' end,
       a.why
from (values
  ('derives the Area from the person being edited',     'area_of_person',              true,  'the Area comes from the row, never from the request',    1),
  ('asks is_area_admin about that Area',                'is_area_admin',               true,  'this family''s administrator, not any administrator',     2),
  ('asks is_area_contributor_member about that Area',   'is_area_contributor_member',  true,  'this family''s contributor, not any contributor',         3),
  ('no longer asks the global admin question',          'is_app_admin',                false, 'that question answers about whichever Area was claimed',  4),
  ('does not depend on the pre-request hook',           'acting_area',                 false, 'authorization must not rest on a header being honoured',  5)
) as a(label, needle, must_contain, why, n)

union all
select 6020 + a.n, '039 area-aware permissions',
       'list_gift_ideas ' || a.label,
       case when exists (
         select 1 from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'list_gift_ideas' and position(a.needle in prosrc) > 0
       ) then 'PASS' else 'FAIL' end,
       a.why
from (values
  ('checks the caller belongs to the recipient''s Area', 'is_area_member',
   'it is SECURITY DEFINER, so no policy narrows it', 1),
  ('still keeps the birthday surprise', 'is_own_birthday_recipient',
   'the celebrant must get nothing back from it', 2)
) as a(label, needle, why, n)

union all
select 6030, '039 area-aware permissions',
       'function public.refuse_cross_area_idea_author exists',
       case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                         and proname = 'refuse_cross_area_idea_author') then 'PASS' else 'FAIL' end,
       'a gift idea may not be credited to another family''s membership'

union all
select 6031, '039 area-aware permissions',
       'trigger gift_ideas_refuse_cross_area_author is attached to gift_ideas',
       case when exists (
         select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
         where tg.tgname = 'gift_ideas_refuse_cross_area_author'
           and not tg.tgisinternal and c.relname = 'gift_ideas'
       ) then 'PASS' else 'FAIL' end,
       'insert only: migration 007 already makes the column immutable on update'

union all
select 6040 + a.n, '039 area-aware permissions',
       'is_family_contributor_member ' || a.label,
       case when exists (
         select 1 from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'is_family_contributor_member' and position(a.needle in prosrc) > 0
       ) then 'PASS' else 'FAIL' end,
       a.why
from (values
  ('honours a stated Area',      'acting_area', 'answers about the family the caller said they are in',   1),
  ('otherwise refuses to guess', '= 1',         'and answers only when there is nothing to guess between', 2)
) as a(label, needle, why, n)

-- ===========================================================================
-- 040  OWN-BIRTHDAY WISHLIST   ** newly applied **
--
--      One new table, four policies, two triggers. The birthday person writes
--      it; their family reads it; it records nothing at all about what the
--      family then did with it.
-- ===========================================================================

union all
select 7001, '040 birthday wishlist',
       'the birthday_wishlist_ideas table exists',
       case when to_regclass('public.birthday_wishlist_ideas') is not null then 'PASS' else 'FAIL' end,
       coalesce(to_regclass('public.birthday_wishlist_ideas')::text, '(missing)')

union all
select 7002, '040 birthday wishlist',
       'row level security is ON for the wishlist',
       case when coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname = 'birthday_wishlist_ideas'), false)
            then 'PASS' else 'FAIL' end,
       'without it the table would be readable by every signed-in account'

union all
select 7003, '040 birthday wishlist',
       'the wishlist has exactly four policies',
       case when (select count(*) from pg_policies
                  where schemaname = 'public' and tablename = 'birthday_wishlist_ideas') = 4
            then 'PASS' else 'FAIL' end,
       (select count(*)::text || ' found (4 expected)'
        from pg_policies where schemaname = 'public' and tablename = 'birthday_wishlist_ideas')

union all
select 7010 + p.n, '040 birthday wishlist',
       'policy "' || p.name || '" exists',
       case when exists (
         select 1 from pg_policies where schemaname = 'public'
           and tablename = 'birthday_wishlist_ideas' and policyname = p.name
       ) then 'PASS' else 'FAIL' end,
       coalesce((select cmd from pg_policies where schemaname = 'public'
                 and tablename = 'birthday_wishlist_ideas' and policyname = p.name), '(missing)')
from (values
  ('members read wishlists in their area', 1),
  ('the birthday person writes their own wishlist', 2),
  ('the birthday person edits their own wishlist', 3),
  ('the birthday person removes their own wishlist entries', 4)
) as p(name, n)

union all
select 7020, '040 birthday wishlist',
       'all three WRITE policies check that the writer is the birthday person',
       case when (
         select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'birthday_wishlist_ideas'
           and cmd in ('INSERT', 'UPDATE', 'DELETE')
           and position('is_own_wishlist_person' in coalesce(qual, '') || coalesce(with_check, '')) > 0
       ) = 3 then 'PASS' else 'FAIL' end,
       'nobody may add to, edit or remove somebody else''s list'

union all
select 7021, '040 birthday wishlist',
       'the READ policy does not, so the family can see the list',
       case when exists (
         select 1 from pg_policies where schemaname = 'public'
           and tablename = 'birthday_wishlist_ideas' and cmd = 'SELECT'
           and position('is_own_wishlist_person' in coalesce(qual, '')) = 0
       ) then 'PASS' else 'FAIL' end,
       'a wish is only useful if the people buying can read it'

union all
select 7022, '040 birthday wishlist',
       'no wishlist policy consults an administrative role',
       case when not exists (
         select 1 from pg_policies where schemaname = 'public'
           and tablename = 'birthday_wishlist_ideas'
           and position('is_app_admin' in coalesce(qual, '') || coalesce(with_check, '')) > 0
       ) then 'PASS' else 'FAIL' end,
       'an admin who is the celebrant must be restricted like anybody else'

union all
select 7030 + t.n, '040 birthday wishlist',
       'trigger ' || t.name || ' is attached',
       case when exists (
         select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
         where tg.tgname = t.name and not tg.tgisinternal and c.relname = 'birthday_wishlist_ideas'
       ) then 'PASS' else 'FAIL' end,
       t.why
from (values
  ('birthday_wishlist_ideas_anchor', 'derives the Area and the author from the person', 1),
  ('birthday_wishlist_ideas_refuse_foreign_area', 'the same write barrier every other table has', 2)
) as t(name, why, n)

union all
select 7040 + f.n, '040 birthday wishlist',
       'function public.' || f.name || ' exists',
       case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                         and proname = f.name) then 'PASS' else 'FAIL' end,
       'the whole authorization of the feature is these two'
from (values ('is_own_wishlist_person', 1), ('anchor_wishlist_idea', 2)) as f(name, n)

union all
select 7050, '040 birthday wishlist',
       'the write barrier knows how to find the wishlist''s Area',
       case when exists (
         select 1 from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'area_of_written_row'
           and position('birthday_wishlist_ideas' in prosrc) > 0
       ) then 'PASS' else 'FAIL' end,
       'migration 040 replaced 037''s dispatch to add one line'

union all
select 7060, '040 birthday wishlist',
       'the wishlist has NO foreign key into the planning',
       case when not exists (
         select 1 from pg_constraint c join pg_class target on target.oid = c.confrelid
         where c.conrelid = 'public.birthday_wishlist_ideas'::regclass and c.contype = 'f'
           and target.relname not in ('areas', 'people', 'app_members')
       ) then 'PASS' else 'FAIL' end,
       'points only at: ' ||
       coalesce((select string_agg(distinct target.relname, ', ')
                 from pg_constraint c join pg_class target on target.oid = c.confrelid
                 where c.conrelid = 'public.birthday_wishlist_ideas'::regclass and c.contype = 'f'),
                '(nothing)')

union all
select 7070, '040 birthday wishlist',
       'a signed-out visitor cannot read the wishlist',
       case when coalesce((select has_table_privilege('anon', c.oid, 'select')
                           from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname = 'birthday_wishlist_ideas'), false)
            then 'FAIL' else 'PASS' end,
       'anon must have no grant on this table at all'

union all
select 7080 + g.n, '040 birthday wishlist',
       'a signed-in member may ' || g.right_name || ' the wishlist',
       case when coalesce((select has_table_privilege('authenticated', c.oid, g.right_name)
                           from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname = 'birthday_wishlist_ideas'), false)
            then 'PASS' else 'FAIL' end,
       'row level security then decides WHICH rows'
from (values ('select', 1), ('insert', 2), ('update', 3), ('delete', 4)) as g(right_name, n)

-- ===========================================================================
-- THE AREA ITSELF -- expect exactly one, today
-- ===========================================================================

union all
select 8001, 'the family',
       'exactly one Area exists',
       case when (select count(*) from public.areas) = 1 then 'PASS'
            when (select count(*) from public.areas) = 0 then 'FAIL'
            else 'REVIEW' end,
       (select count(*)::text from public.areas) ||
       ' Area(s). One is expected today. More than one is not wrong, but it ' ||
       'changes what several checks below mean.'

union all
select 8005 + (row_number() over (order by a.created_at))::int,
       'the family',
       'Area: ' || a.name,
       'INFO',
       'id ' || a.id::text ||
       case when a.archived_at is not null then ' (archived)' else ' (active)' end ||
       ', created ' || a.created_at::date::text
from public.areas a

-- ===========================================================================
-- EVERY TENANT-OWNED ROW NAMES AN AREA -- zero orphans is a PASS
-- ===========================================================================

union all
select 8100 + t.n, 'orphan rows',
       'rows in ' || t.label || ' with no Area',
       case when t.orphans = 0 then 'PASS' else 'FAIL' end,
       t.orphans::text || ' found (0 expected)'
from (
  select 'people'       as label, (select count(*) from public.people      where area_id is null) as orphans, 1 as n
  union all select 'events',      (select count(*) from public.events      where area_id is null), 2
  union all select 'app_members', (select count(*) from public.app_members where area_id is null), 3
  union all select 'audit_log',   (select count(*) from public.audit_log   where area_id is null), 4
) as t

union all
select 8110 + (row_number() over (order by t.area_id))::int,
       'orphan rows',
       'family ' || t.area_id::text || ' holds',
       'INFO',
       t.people::text || ' people, ' || t.events::text || ' events, ' ||
       t.memberships::text || ' memberships'
from (
  select a.area_id,
         (select count(*) from public.people      p where p.area_id = a.area_id) as people,
         (select count(*) from public.events      e where e.area_id = a.area_id) as events,
         (select count(*) from public.app_members m where m.area_id = a.area_id) as memberships
  from (
    select area_id from public.people
    union select area_id from public.events
    union select area_id from public.app_members
  ) a
) t

-- ===========================================================================
-- NOTHING REACHES ACROSS AN AREA -- checked as DATA, not as a trigger
--
--   A guard that is installed but was installed after a bad row existed would
--   still leave the bad row there. These look at the rows themselves.
--   Zero is a PASS on every line.
-- ===========================================================================

union all
select 8200 + t.n, 'cross-Area links',
       t.label,
       case when t.bad = 0 then 'PASS' else 'FAIL' end,
       t.bad::text || ' found (0 expected)'
from (
  select 'a birthday celebrant from another family' as label, 1 as n,
         (select count(*) from public.events e join public.people p on p.id = e.celebrant_person_id
          where p.area_id is distinct from e.area_id) as bad
  union all
  select 'a membership whose person is in another family', 2,
         (select count(*) from public.app_members m join public.people p on p.id = m.person_id
          where p.area_id is distinct from m.area_id)
  union all
  select 'a gift recipient from another family', 3,
         (select count(*) from public.christmas_recipients r
          join public.events e on e.id = r.christmas_event_id
          join public.people p on p.id = r.person_id
          where p.area_id is distinct from e.area_id)
  union all
  select 'a contributor from another family', 4,
         (select count(*) from public.contributors c
          join public.events e on e.id = c.christmas_event_id
          join public.people p on p.id = c.person_id
          where p.area_id is distinct from e.area_id)
  union all
  select 'a gift hidden at somebody in another family', 5,
         (select count(*) from public.purchases pu
          join public.christmas_recipients r on r.id = pu.christmas_recipient_id
          join public.events e on e.id = r.christmas_event_id
          join public.people p on p.id = pu.gift_location_person_id
          where p.area_id is distinct from e.area_id)
  union all
  select 'a gift idea credited to another family''s membership', 6,
         (select count(*) from public.gift_ideas g
          join public.christmas_recipients r on r.id = g.christmas_recipient_id
          join public.events e on e.id = r.christmas_event_id
          join public.app_members m on m.id = g.suggested_by_app_member_id
          where m.area_id is distinct from e.area_id)
) as t

-- ===========================================================================
-- AND NEITHER DOES THE MONEY -- zero is a PASS on every line
-- ===========================================================================

union all
select 8300 + t.n, 'money integrity',
       t.label,
       case when t.bad = 0 then 'PASS' else 'FAIL' end,
       t.bad::text || ' found (0 expected)'
from (
  select 'an allocation whose contributor belongs to a different event' as label, 1 as n,
         (select count(*) from public.purchase_allocations pa
          join public.purchases pu on pu.id = pa.purchase_id
          join public.christmas_recipients r on r.id = pu.christmas_recipient_id
          join public.events e on e.id = r.christmas_event_id
          join public.contributors c on c.id = pa.contributor_id
          where c.christmas_event_id is distinct from e.id) as bad
  union all
  select 'a contribution plan spanning two events', 2,
         (select count(*) from public.recipient_contributions rc
          join public.christmas_recipients r on r.id = rc.christmas_recipient_id
          join public.contributors c on c.id = rc.contributor_id
          where c.christmas_event_id is distinct from r.christmas_event_id)
  union all
  select 'a wishlist row whose Area disagrees with its person', 3,
         (select count(*) from public.birthday_wishlist_ideas w
          join public.people p on p.id = w.person_id
          where p.area_id is distinct from w.area_id)
  union all
  select 'a wishlist row credited to another family''s membership', 4,
         (select count(*) from public.birthday_wishlist_ideas w
          join public.app_members m on m.id = w.created_by_app_member_id
          where m.area_id is distinct from w.area_id)
) as t

-- ===========================================================================
-- WHO ADMINISTERS EACH FAMILY -- expect exactly one each
-- ===========================================================================

union all
select 8400, 'administrators',
       'every family has exactly one active administrator',
       case when not exists (
         select 1 from public.app_members
         where role = 'admin' and active
         group by area_id having count(*) <> 1
       ) and not exists (
         select 1 from public.areas a
         where not exists (select 1 from public.app_members m
                           where m.area_id = a.id and m.role = 'admin' and m.active)
       ) then 'PASS' else 'FAIL' end,
       (select count(*)::text from public.app_members where role = 'admin' and active) ||
       ' active administrator(s) across ' ||
       (select count(*)::text from public.areas) || ' Area(s)'

union all
select 8410, 'administrators',
       'memberships not linked to a person',
       case when (select count(*) from public.app_members where person_id is null) = 0
            then 'PASS' else 'REVIEW' end,
       (select count(*)::text from public.app_members where person_id is null) ||
       ' found. Not a blocker -- migration 033 grandfathers these -- but worth knowing.'

-- ===========================================================================
-- ROW LEVEL SECURITY IS ON, AND EVERY POLICY KNOWS ITS AREA
-- ===========================================================================

union all
select 9000, 'security posture',
       'row level security is enabled on every public table',
       case when not exists (
         select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
       ) then 'PASS' else 'FAIL' end,
       coalesce((select string_agg(c.relname, ', ')
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
                'no table is left open')

union all
select 9010, 'security posture',
       'every policy names an Area, or is scoped to the caller''s own row',
       case when not exists (
         select 1 from pg_policies
         where schemaname = 'public'
           and position('area' in coalesce(qual, '') || coalesce(with_check, '')) = 0
           and position('is_own_app_member' in coalesce(qual, '') || coalesce(with_check, '')) = 0
           and policyname <> 'active members may read own membership'
       ) then 'PASS' else 'FAIL' end,
       (select count(*)::text from pg_policies where schemaname = 'public') || ' policies checked'

union all
select 9020 + (row_number() over (order by pol.tablename, pol.policyname))::int,
       'security posture',
       'policy ' || pol.tablename || ' :: ' || pol.policyname || ' names no Area',
       'FAIL',
       'this policy needs reviewing before a second family exists'
from pg_policies pol
where pol.schemaname = 'public'
  and position('area' in coalesce(pol.qual, '') || coalesce(pol.with_check, '')) = 0
  and position('is_own_app_member' in coalesce(pol.qual, '') || coalesce(pol.with_check, '')) = 0
  and pol.policyname <> 'active members may read own membership'

-- ===========================================================================
-- WHAT IS EXPOSED, AND TO WHOM
-- ===========================================================================

union all
select 9100 + f.n, 'function grants',
       'a signed-out visitor cannot run ' || f.name,
       case when coalesce((select bool_or(has_function_privilege('anon', p.oid, 'execute'))
                           from pg_proc p
                           where p.pronamespace = 'public'::regnamespace and p.proname = f.name), false)
            then 'FAIL' else 'PASS' end,
       'anon must reach none of the Area machinery'
from (values
  ('is_area_member', 1), ('is_area_admin', 2), ('current_person_in_area', 3),
  ('current_member_in_area', 4), ('act_in_area', 5), ('create_area', 6),
  ('set_area_name', 7), ('set_area_archived', 8), ('is_area_contributor_member', 9),
  ('set_person_birthday', 10), ('list_gift_ideas', 11), ('save_gift_idea', 12),
  ('is_own_wishlist_person', 13)
) as f(name, n)

union all
select 9130 + f.n, 'function grants',
       'a signed-in member CAN run ' || f.name,
       case when coalesce((select bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
                           from pg_proc p
                           where p.pronamespace = 'public'::regnamespace and p.proname = f.name), false)
            then 'PASS' else 'FAIL' end,
       'the application would stop working without this'
from (values
  ('is_area_member', 1), ('is_area_admin', 2), ('current_person_in_area', 3),
  ('act_in_area', 4), ('create_area', 5), ('is_area_contributor_member', 6),
  ('set_person_birthday', 7), ('list_gift_ideas', 8)
) as f(name, n)

union all
select 9160, 'function grants',
       'the areas table is readable by members and not by anon',
       case when coalesce((select has_table_privilege('authenticated', c.oid, 'select')
                           from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname = 'areas'), false)
            and not coalesce((select has_table_privilege('anon', c.oid, 'select')
                              from pg_class c join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname = 'public' and c.relname = 'areas'), false)
            then 'PASS' else 'FAIL' end,
       'a policy narrows a grant; it cannot stand in for one'

union all
select 9165, 'function grants',
       'the areas table has NO write policy, so no browser can write it',
       case when not exists (
         select 1 from pg_policies
         where schemaname = 'public' and tablename = 'areas' and cmd <> 'SELECT'
       ) then 'PASS' else 'FAIL' end,
       'THIS is the lock. With row level security on and no write policy, an ' ||
       'insert is refused outright and an update matches no row. An Area is ' ||
       'created by create_area, which runs with the owner''s rights.'

union all
select 9166, 'function grants',
       'left-over table grant on areas (tidiness, not exposure)',
       'INFO',
       case when coalesce((select bool_or(has_table_privilege(r.rolname, c.oid, 'insert'))
                           from pg_class c
                           join pg_namespace n2 on n2.oid = c.relnamespace
                           cross join (values ('authenticated')) as r(rolname)
                           where n2.nspname = 'public' and c.relname = 'areas'), false)
            then 'authenticated still holds an INSERT grant on areas. Expected: ' ||
                 'Supabase grants ALL on every new public table by default, and ' ||
                 'migration 034 revoked that from anon but only ADDED select for ' ||
                 'authenticated. Row level security refuses the write regardless ' ||
                 '(proved by scripts/tenancy-runtime.test.mjs), so this is worth ' ||
                 'tidying one day and is not a way in.'
            else 'no left-over write grant on areas.' end

-- ===========================================================================
-- THE POSTGREST PRE-REQUEST HOOK -- the static half
--
--   The RUNTIME half was already proved separately, with a real signed-in
--   member: 8/8 checks. This only asks whether the setting is still stored.
-- ===========================================================================

union all
select 9200, 'pre-request hook',
       'pgrst.db_pre_request is configured on the authenticator role',
       case when exists (
         select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
         where r.rolname = 'authenticator'
           and array_to_string(s.setconfig, ' ') like '%pgrst.db_pre_request=public.claim_active_area%'
       ) then 'PASS' else 'FAIL' end,
       coalesce((select array_to_string(s.setconfig, ' | ')
                 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                 where r.rolname = 'authenticator'), '(no settings stored on authenticator)')

union all
select 9210, 'pre-request hook',
       'the authenticator role may execute claim_active_area',
       case when coalesce((select bool_or(has_function_privilege('authenticator', p.oid, 'execute'))
                           from pg_proc p
                           where p.pronamespace = 'public'::regnamespace
                             and p.proname = 'claim_active_area'), false)
            then 'PASS' else 'FAIL' end,
       'PostgREST connects as authenticator and calls this before every request'

union all
select 9220, 'pre-request hook',
       'this SQL Editor session shows no pre-request setting',
       'INFO',
       'Expected, and not a problem: you are connected as postgres, not as ' ||
       'authenticator. The row above is the one that matters. Session value: ' ||
       coalesce(current_setting('pgrst.db_pre_request', true), '(none)')

-- ===========================================================================
-- public.rls_auto_enable -- the object no migration in this repository creates
--
--   Already identified from the production schema dump: an event trigger
--   function that enables row level security on newly created public tables.
--   These rows confirm it is still exactly that, and show whether it is
--   attached to anything.
-- ===========================================================================

union all
select 9300, 'rls_auto_enable',
       'what it is',
       'INFO',
       coalesce((select 'returns ' || pg_get_function_result(p.oid) ||
                        ', owner ' || pg_get_userbyid(p.proowner) ||
                        case when p.prosecdef then ', SECURITY DEFINER' else ', invoker rights' end
                 from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable'),
                '(not present -- nothing to explain)')

union all
select 9310, 'rls_auto_enable',
       'it cannot be called directly by anybody',
       case when not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                             and proname = 'rls_auto_enable') then 'PASS'
            when exists (select 1 from pg_proc p
                         where p.pronamespace = 'public'::regnamespace
                           and p.proname = 'rls_auto_enable'
                           and pg_get_function_result(p.oid) = 'event_trigger') then 'PASS'
            else 'REVIEW' end,
       'a function returning event_trigger can only be run by the DDL machinery, ' ||
       'so the grant Supabase gives every public function by default buys nothing'

union all
select 9320, 'rls_auto_enable',
       'all it can do is turn row level security ON',
       case when not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                             and proname = 'rls_auto_enable') then 'PASS'
            when exists (
              select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable'
                and position('enable row level security' in lower(p.prosrc)) > 0
                and position('disable row level security' in lower(p.prosrc)) = 0
                and position('delete from' in lower(p.prosrc)) = 0
                and position('insert into' in lower(p.prosrc)) = 0
                and position('drop ' in lower(p.prosrc)) = 0
            ) then 'PASS' else 'REVIEW' end,
       'if this ever says REVIEW, send the function body back'

union all
select 9330 + (row_number() over (order by e.evtname))::int,
       'rls_auto_enable',
       'event trigger ' || e.evtname || ' runs ' || p.proname,
       'INFO',
       'fires on ' || e.evtevent || ', state ' || e.evtenabled::text
from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid

union all
select 9340, 'rls_auto_enable',
       'event triggers visible in this database',
       'INFO',
       (select count(*)::text from pg_event_trigger) ||
       ' found. Zero here is expected but not conclusive -- the backup tool runs ' ||
       'as a role that cannot see every event trigger.'

-- ===========================================================================
-- CHRISTMAS -- identity and shape only. No amount is read anywhere in this file.
-- ===========================================================================

union all
select 9400 + (row_number() over (order by e.year desc))::int,
       'Christmas',
       e.name,
       'INFO',
       'id ' || e.id::text || ', ' || e.event_date::text || ', status ' || e.status ||
       ', family ' || coalesce(e.area_id::text, '(none)')
from public.events e
where e.event_type = 'christmas'

union all
select 9450 + t.n, 'Christmas',
       'Christmas 2026 ' || t.label,
       'INFO',
       t.amount::text
from (
  select 'recipients' as label, 1 as n,
         (select count(*) from public.christmas_recipients r
          join public.events e on e.id = r.christmas_event_id
          where e.event_type = 'christmas' and e.year = 2026) as amount
  union all
  select 'contributors', 2,
         (select count(*) from public.contributors c
          join public.events e on e.id = c.christmas_event_id
          where e.event_type = 'christmas' and e.year = 2026)
  union all
  select 'purchases', 3,
         (select count(*) from public.purchases pu
          join public.christmas_recipients r on r.id = pu.christmas_recipient_id
          join public.events e on e.id = r.christmas_event_id
          where e.event_type = 'christmas' and e.year = 2026)
  union all
  select 'allocations', 4,
         (select count(*) from public.purchase_allocations pa
          join public.purchases pu on pu.id = pa.purchase_id
          join public.christmas_recipients r on r.id = pu.christmas_recipient_id
          join public.events e on e.id = r.christmas_event_id
          where e.event_type = 'christmas' and e.year = 2026)
  union all
  select 'settlements', 5,
         (select count(*) from public.settlements s
          join public.events e on e.id = s.christmas_event_id
          where e.event_type = 'christmas' and e.year = 2026)
) as t

-- ===========================================================================
-- WHOLE-DATABASE FINGERPRINT -- row counts only. Keep this output.
--
--   Compare it against the same figures taken before 039 and 040 were applied.
--   Every number should be identical, except birthday_wishlist_ideas, which is
--   new and should be 0 until somebody writes their first wish.
-- ===========================================================================

union all
select 9500 + t.n, 'fingerprint (row counts)', t.label, 'INFO', t.amount::text
from (
  select 'areas' as label, 1 as n, (select count(*) from public.areas) as amount
  union all select 'people',                  2, (select count(*) from public.people)
  union all select 'events',                  3, (select count(*) from public.events)
  union all select 'app_members',             4, (select count(*) from public.app_members)
  union all select 'christmas_recipients',    5, (select count(*) from public.christmas_recipients)
  union all select 'contributors',            6, (select count(*) from public.contributors)
  union all select 'recipient_contributions', 7, (select count(*) from public.recipient_contributions)
  union all select 'purchases',               8, (select count(*) from public.purchases)
  union all select 'purchase_allocations',    9, (select count(*) from public.purchase_allocations)
  union all select 'gift_ideas',             10, (select count(*) from public.gift_ideas)
  union all select 'settlements',            11, (select count(*) from public.settlements)
  union all select 'payment_receipts',       12, (select count(*) from public.payment_receipts)
  union all select 'item_photos',            13, (select count(*) from public.item_photos)
  union all select 'notifications',          14, (select count(*) from public.notifications)
  union all select 'audit_log',              15, (select count(*) from public.audit_log)
  union all select 'birthday_wishlist_ideas (new in 040, expect 0)', 16,
                                                 (select count(*) from public.birthday_wishlist_ideas)
) as t

-- ===========================================================================
-- FOR THE DAY THERE IS A SECOND FAMILY
--
--   These pass trivially while one Area exists. They are the ones to look at
--   again the moment a second one is created. Zero is a PASS on every line.
-- ===========================================================================

union all
select 9600 + t.n, 'second-family readiness', t.label,
       case when t.bad = 0 then 'PASS' else 'FAIL' end,
       t.bad::text || ' found (0 expected)'
from (
  select 'a family with more or fewer than one active administrator' as label, 1 as n,
         (select count(*) from (
            select area_id from public.app_members
            where role = 'admin' and active group by area_id having count(*) <> 1
          ) x) as bad
  union all
  select 'a person with two memberships pointing at them', 2,
         (select count(*) from (
            select person_id from public.app_members
            where person_id is not null group by person_id having count(*) > 1
          ) x)
  union all
  select 'the same email used twice inside one family', 3,
         (select count(*) from (
            select area_id, lower(email) as e from public.app_members
            where email is not null group by area_id, lower(email) having count(*) > 1
          ) x)
  union all
  select 'the same login holding two memberships in one family', 4,
         (select count(*) from (
            select area_id, user_id from public.app_members
            where user_id is not null group by area_id, user_id having count(*) > 1
          ) x)
) as t

)

-- ===========================================================================
-- THE RESULT
--
--   One table. Read the `verdict` column. FAIL rows are sorted to the top and
--   the SUMMARY row sits above everything.
-- ===========================================================================

select result.verdict, result.section, result.check_name, result.detail
from (
  select -1 as sort,
         'SUMMARY'::text as section,
         (case when (select count(*) from checks where verdict = 'FAIL') = 0
               then 'Everything checked is in order'
               else 'SOMETHING FAILED -- the FAIL rows are directly below this one'
          end)::text as check_name,
         (case when (select count(*) from checks where verdict = 'FAIL') = 0
               then 'PASS' else 'FAIL' end)::text as verdict,
         ((select count(*) from checks where verdict = 'PASS')::text   || ' passed, ' ||
          (select count(*) from checks where verdict = 'FAIL')::text   || ' failed, ' ||
          (select count(*) from checks where verdict = 'REVIEW')::text || ' to review, ' ||
          (select count(*) from checks where verdict = 'INFO')::text   || ' facts recorded')::text as detail
  union all
  select sort, section, check_name, verdict, detail from checks
) result
order by
  case result.verdict when 'FAIL' then 0 when 'REVIEW' then 1 else 2 end,
  result.sort;
