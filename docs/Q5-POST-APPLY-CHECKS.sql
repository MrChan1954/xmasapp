-- =============================================================================
-- Q5 -- READ-ONLY PRODUCTION CHECKS, AFTER MIGRATION 046
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and tells you, line by
--   line, whether migration 046 is really in place: the routine, its grants,
--   the two rewritten policies, and the grant it takes back.
--
--   IT ONLY READS. There is no insert, update, delete or DDL anywhere in this
--   file. Running it twice changes nothing.
--
-- HOW TO RUN IT
--   Open the Supabase SQL Editor, paste this WHOLE file in, and press Run.
--   You will get one table back. Read the first column.
--
-- HOW TO READ THE RESULT
--   PASS     this check is fine. Nothing to do.
--   FAIL     something is wrong. Do not deploy. Send the whole table back.
--   INFO     a fact for the record, not a pass or a fail.
--
--   FAIL rows are sorted to the TOP, and a SUMMARY row sits above everything.
--
-- WHAT MIGRATION 046 IS FOR
--   Migration 045 put `require_acting_area()` at the top of sixteen routines,
--   so that authorising in one family could no longer write to another. It
--   could not cover removing a gift idea, because that was not a routine: the
--   application deleted the row straight from the browser, so its only
--   boundary was this table's DELETE policy -- and that policy asked whether
--   the reader is a MEMBER of the idea's family. A login that belongs to two
--   families answers yes in both.
--
--   Measured against a real PostgreSQL carrying 001-045: the account belonging
--   to two families, ACTING IN ONE, ran the application's own delete against
--   the OTHER family's gift idea. It returned the row. The idea was gone.
--
--   The same delete cost history. `purchases.originating_gift_idea_id` is
--   `on delete set null`, so removing an idea somebody had already bought left
--   the purchase standing with its provenance quietly emptied -- while the
--   confirmation on screen promised that purchases would not change.
--
--   046 adds `remove_gift_idea`, which refuses both cases in words a person can
--   read; rewrites the UPDATE and DELETE policies to ask which family the
--   caller is STANDING IN, not merely which they belong to; excludes the
--   celebrant's own birthday from both; and takes back the `delete` grant that
--   made the raw path reachable at all -- the same thing migration 011 did to
--   `insert` and `update` on this table, for the same reason.
--
-- WHEN TO RUN IT
--   Immediately after pasting 046 into the SQL Editor, and BEFORE deploying.
--   The application calls `remove_gift_idea`, so the routine has to exist
--   first.
-- =============================================================================

with checks as (

-- ---------------------------------------------------------------------------
-- 1. The routine, and the predicate it shares with the policies
-- ---------------------------------------------------------------------------

select 4601 as sort,
       '046 gift idea removal'::text as section,
       'remove_gift_idea and is_acting_area both exist'::text as check_name,
       (case when to_regprocedure('public.remove_gift_idea(uuid)') is not null
              and to_regprocedure('public.is_acting_area(uuid)') is not null
             then 'PASS' else 'FAIL' end)::text as verdict,
       (coalesce(to_regprocedure('public.remove_gift_idea(uuid)')::text, 'MISSING') || ', ' ||
        coalesce(to_regprocedure('public.is_acting_area(uuid)')::text, 'MISSING'))::text as detail

union all

select 4602, '046 gift idea removal',
       'both are SECURITY DEFINER with a pinned search_path',
       (case when count(*) = 2 then 'PASS' else 'FAIL' end)::text,
       ('definer+pinned: ' || count(*)::text || ' of 2')::text
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('remove_gift_idea', 'is_acting_area')
  and p.prosecdef
  and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path=%'

union all

select 4603, '046 gift idea removal',
       'neither routine is callable by anon',
       (case when not exists (
               select 1 from pg_proc p
               join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public'
                 and p.proname in ('remove_gift_idea', 'is_acting_area')
                 and has_function_privilege('anon', p.oid, 'execute'))
             then 'PASS' else 'FAIL' end)::text,
       'anon must hold no execute on either'::text

union all

select 4604, '046 gift idea removal',
       'authenticated may call remove_gift_idea',
       (case when to_regprocedure('public.remove_gift_idea(uuid)') is not null
              and has_function_privilege('authenticated',
                    to_regprocedure('public.remove_gift_idea(uuid)'), 'execute')
             then 'PASS' else 'FAIL' end)::text,
       'the application calls this one'::text

union all

-- ---------------------------------------------------------------------------
-- 2. The grant that made the bypass reachable is gone
-- ---------------------------------------------------------------------------

select 4610, '046 gift idea removal',
       'authenticated can no longer DELETE gift_ideas directly',
       (case when not has_table_privilege('authenticated', 'public.gift_ideas', 'delete')
             then 'PASS' else 'FAIL' end)::text,
       'removal must go through remove_gift_idea'::text

union all

select 4611, '046 gift idea removal',
       'but can still read them',
       (case when has_table_privilege('authenticated', 'public.gift_ideas', 'select')
             then 'PASS' else 'FAIL' end)::text,
       'reading is what the list is for'::text

union all

select 4612, '046 gift idea removal',
       'insert and update were already withdrawn, by 011',
       (case when not has_table_privilege('authenticated', 'public.gift_ideas', 'insert')
              and not has_table_privilege('authenticated', 'public.gift_ideas', 'update')
             then 'PASS' else 'FAIL' end)::text,
       'save_gift_idea owns those, and now remove_gift_idea owns delete'::text

union all

-- ---------------------------------------------------------------------------
-- 3. The policies ask which family the caller is standing in
-- ---------------------------------------------------------------------------

select 4620, '046 gift idea removal',
       'the DELETE policy carries the acting Area, the celebrant rule and the purchase guard',
       (case when (select count(*) from pg_policies
                   where schemaname = 'public' and tablename = 'gift_ideas'
                     and cmd = 'DELETE'
                     and qual like '%is_acting_area%'
                     and qual like '%is_own_birthday_recipient%'
                     and qual like '%originating_gift_idea_id%') = 1
             then 'PASS' else 'FAIL' end)::text,
       coalesce((select left(qual, 240) from pg_policies
                 where schemaname = 'public' and tablename = 'gift_ideas' and cmd = 'DELETE'), 'NO DELETE POLICY')::text

union all

select 4621, '046 gift idea removal',
       'the UPDATE policy carries it in BOTH using and with check',
       (case when (select count(*) from pg_policies
                   where schemaname = 'public' and tablename = 'gift_ideas'
                     and cmd = 'UPDATE'
                     and qual like '%is_acting_area%'
                     and with_check like '%is_acting_area%'
                     and qual like '%is_own_birthday_recipient%'
                     and with_check like '%is_own_birthday_recipient%') = 1
             then 'PASS' else 'FAIL' end)::text,
       ('using: ' || coalesce((select left(qual, 110) from pg_policies
                               where schemaname = 'public' and tablename = 'gift_ideas' and cmd = 'UPDATE'), 'NONE')
        || ' | check: ' || coalesce((select left(with_check, 110) from pg_policies
                               where schemaname = 'public' and tablename = 'gift_ideas' and cmd = 'UPDATE'), 'NONE'))::text

union all

select 4622, '046 gift idea removal',
       'row level security is still enabled on gift_ideas',
       (case when (select relrowsecurity from pg_class where oid = 'public.gift_ideas'::regclass)
             then 'PASS' else 'FAIL' end)::text,
       'policies mean nothing without it'::text

union all

-- ---------------------------------------------------------------------------
-- 4. Nothing else moved
-- ---------------------------------------------------------------------------

select 4630, '046 gift idea removal',
       'the read policy still hides the celebrant''s own birthday',
       (case when (select count(*) from pg_policies
                   where schemaname = 'public' and tablename = 'gift_ideas'
                     and cmd = 'SELECT' and qual like '%is_own_birthday_recipient%') = 1
             then 'PASS' else 'FAIL' end)::text,
       '046 must not have disturbed 036''s read rule'::text

union all

select 4631, '046 gift idea removal',
       'no gift idea lost its purchase link',
       (case when (select count(*) from public.purchases
                   where deleted_at is null and originating_gift_idea_id is not null
                     and not exists (select 1 from public.gift_ideas g
                                     where g.id = purchases.originating_gift_idea_id)) = 0
             then 'PASS' else 'FAIL' end)::text,
       ('live purchases naming an idea: ' ||
        (select count(*)::text from public.purchases
         where deleted_at is null and originating_gift_idea_id is not null))::text

union all

select 4640, '046 gift idea removal', 'gift ideas in the database', 'INFO',
       (select count(*)::text from public.gift_ideas)

union all

select 4641, '046 gift idea removal', 'live purchases in the database', 'INFO',
       (select count(*)::text from public.purchases where deleted_at is null)

)
select * from (
  select 0 as sort, 'SUMMARY'::text as section,
         (case when (select count(*) from checks where verdict = 'FAIL') = 0
               then 'Everything checked is in order'
               else 'SOMETHING FAILED -- the FAIL rows are directly below this one'
          end)::text as check_name,
         (case when (select count(*) from checks where verdict = 'FAIL') = 0
               then 'PASS' else 'FAIL' end)::text as verdict,
         ((select count(*) from checks where verdict = 'PASS')::text || ' passed, ' ||
          (select count(*) from checks where verdict = 'FAIL')::text || ' failed, ' ||
          (select count(*) from checks where verdict = 'INFO')::text || ' facts recorded')::text as detail
  union all
  select sort, section, check_name, verdict, detail from checks
) result
order by
  case result.verdict when 'FAIL' then 0 when 'REVIEW' then 1 else 2 end,
  result.sort;
