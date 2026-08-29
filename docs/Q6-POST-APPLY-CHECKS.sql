-- =============================================================================
-- Q6 -- READ-ONLY PRODUCTION CHECKS, AFTER MIGRATION 047
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and tells you, line by
--   line, whether migration 047 is really in place: the four routines, their
--   signatures, their SECURITY DEFINER hardening, their pinned search_path,
--   their grants, and the acting-Area guard inside each body.
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
--   REVIEW   something a person has to look at and judge.
--
--   FAIL rows are sorted to the TOP, and a SUMMARY row sits above everything.
--
-- WHAT MIGRATION 047 IS FOR
--   Migration 044 hardened `set_family_contributor`, `set_person_name` and
--   `set_person_archived` by deriving the Area FROM THE PERSON and asking
--   `is_area_admin(target_area)`. That is the right question about permission
--   and the wrong question about place:
--
--       "Am I an administrator of this person's family?"   -> of Alpha, yes.
--       "...and is Alpha the family I am STANDING IN?"     -> never asked.
--
--   Migration 045 closed exactly this gap for sixteen routines. It did not
--   revisit these, because 044 had already made them Area-aware -- and
--   Area-aware is not the same as acting-Area-aware. `set_person_birthday`
--   (026, refined by 039) had the same shape for the same reason.
--
--   MEASURED, NOT ASSUMED. Against a real PostgreSQL carrying 001-046, the
--   fixture account that ADMINISTERS Alpha and also ADMINISTERS Charlie was
--   pointed at an ALPHA person while ACTING IN CHARLIE. All four succeeded:
--   the Alpha person came back renamed, made a contributor, archived, and with
--   a new birthday month -- every one of them written from a family the caller
--   was not standing in.
--
--   Charlie is the case that matters. In a family where the caller is only an
--   ordinary member, the ADMIN check could be what refuses; in Charlie the
--   caller is a genuine administrator, so only the acting-Area question can.
--
--   Not privilege escalation: that account really does administer Alpha. A
--   violation of the rule that the selected Area is authoritative, which is
--   what the whole application is built on.
--
-- WHY THE GUARD IS `is_acting_area` AND NOT `require_acting_area`
--   Because `require_acting_area` SPEAKS. It raises "That belongs to another
--   family. Switch to that family first." -- right when the thing you named is
--   a family's event, and wrong here, because these four take a PERSON id and
--   have always given ONE refusal for "no such person" and for "not your
--   family". A separate sentence for the second case turns any uuid into a
--   question you can ask about other families: is there somebody here?
--
--   So 047 folds the check into the condition that was already there, using
--   the boolean form migration 046 added for the same reason. All four failure
--   modes -- no such person, another family, not standing there, not entitled
--   -- come back as the one sentence the routine has always given.
--
-- WHEN TO RUN IT
--   Immediately after pasting 047 into the SQL Editor, and BEFORE deploying.
-- =============================================================================

with checks as (

-- ---------------------------------------------------------------------------
-- 1. The four routines exist, with the signatures they have always had
-- ---------------------------------------------------------------------------

select 4701 as sort,
       '047 person routines'::text as section,
       'all four routines exist with their original signatures'::text as check_name,
       (case when to_regprocedure('public.set_family_contributor(uuid,boolean)') is not null
              and to_regprocedure('public.set_person_name(uuid,text)') is not null
              and to_regprocedure('public.set_person_archived(uuid,boolean)') is not null
              and to_regprocedure('public.set_person_birthday(uuid,smallint,smallint,smallint)') is not null
             then 'PASS' else 'FAIL' end)::text as verdict,
       (coalesce(to_regprocedure('public.set_family_contributor(uuid,boolean)')::text, 'MISSING') || ' | ' ||
        coalesce(to_regprocedure('public.set_person_name(uuid,text)')::text, 'MISSING') || ' | ' ||
        coalesce(to_regprocedure('public.set_person_archived(uuid,boolean)')::text, 'MISSING') || ' | ' ||
        coalesce(to_regprocedure('public.set_person_birthday(uuid,smallint,smallint,smallint)')::text, 'MISSING'))::text as detail

union all

-- A duplicate overload would be worse than a missing routine: PostgREST would
-- pick one and the other would sit there unguarded.
select 4702, '047 person routines',
       'no extra overloads of the four names',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')) = 4
             then 'PASS' else 'FAIL' end),
       (select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ' | ' order by p.proname)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('set_family_contributor','set_person_name','set_person_archived','set_person_birthday'))

union all

-- ---------------------------------------------------------------------------
-- 2. The guard itself, in each of the four bodies
-- ---------------------------------------------------------------------------

select 4710, '047 person routines',
       'every one of the four asks is_acting_area(target_area)',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')
                     and pg_get_functiondef(p.oid) like '%is_acting_area(target_area)%') = 4
             then 'PASS' else 'FAIL' end),
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), '(none)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('set_family_contributor','set_person_name',
                            'set_person_archived','set_person_birthday')
          and pg_get_functiondef(p.oid) not like '%is_acting_area(target_area)%')
       || ' <- any name here is MISSING the guard'

union all

-- The Area must come from the PERSON. A guard that checked an Area the caller
-- passed in would be theatre: the attacker would simply pass the right one.
select 4711, '047 person routines',
       'the Area is derived from the person, never from the request',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')
                     and pg_get_functiondef(p.oid) like '%area_of_person(p_person_id)%') = 4
             then 'PASS' else 'FAIL' end),
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('set_family_contributor','set_person_name',
                            'set_person_archived','set_person_birthday')
          and pg_get_functiondef(p.oid) like '%area_of_person(p_person_id)%')
       || ' of 4 derive the Area with area_of_person(p_person_id)'

union all

-- The RAISING form would give "another family" its own sentence and undo the
-- conflated refusal these four have always given. See the header.
select 4712, '047 person routines',
       'none of the four uses the raising form, which would leak existence',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')
                     and pg_get_functiondef(p.oid) like '%require_acting_area%') = 0
             then 'PASS' else 'REVIEW' end),
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), '(none -- correct)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('set_family_contributor','set_person_name',
                            'set_person_archived','set_person_birthday')
          and pg_get_functiondef(p.oid) like '%require_acting_area%')

union all

-- The role checks 044 and 039 put there must still be there. 047 adds a
-- question about PLACE; it must not have replaced the question about PERMISSION.
select 4713, '047 person routines',
       'the existing role checks survive alongside the new one',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')
                     and pg_get_functiondef(p.oid) like '%is_area_admin(target_area)%') = 4
              and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'set_person_birthday'
                     and pg_get_functiondef(p.oid) like '%is_area_contributor_member(target_area)%') = 1
             then 'PASS' else 'FAIL' end),
       'all four keep is_area_admin; set_person_birthday keeps is_area_contributor_member'

union all

-- ---------------------------------------------------------------------------
-- 3. SECURITY DEFINER, the pinned search_path, and the grants
-- ---------------------------------------------------------------------------

select 4720, '047 person routines',
       'all four are still SECURITY DEFINER',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')
                     and p.prosecdef) = 4
             then 'PASS' else 'FAIL' end),
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('set_family_contributor','set_person_name',
                            'set_person_archived','set_person_birthday')
          and p.prosecdef) || ' of 4 are security definer'

union all

-- An unpinned search_path on a definer routine is the classic way to be made
-- to call somebody else's function. 047 must not have dropped it.
select 4721, '047 person routines',
       'all four still pin search_path to the empty string',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')
                     and 'search_path=""' = any(p.proconfig)) = 4
             then 'PASS' else 'FAIL' end),
       (select coalesce(string_agg(p.proname || ' -> ' || coalesce(p.proconfig::text, 'NOT PINNED'), ' | ' order by p.proname), '(none found)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('set_family_contributor','set_person_name',
                            'set_person_archived','set_person_birthday')
          and (p.proconfig is null or not ('search_path=""' = any(p.proconfig))))

union all

select 4722, '047 person routines',
       'execute is still granted to authenticated on all four',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')
                     and has_function_privilege('authenticated', p.oid, 'execute')) = 4
             then 'PASS' else 'FAIL' end),
       'the application calls all four as the signed-in user; revoking would break person administration'

union all

-- 047 changes no grants. A logged-out caller must not have gained one.
select 4723, '047 person routines',
       'anon can execute none of the four',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('set_family_contributor','set_person_name',
                                       'set_person_archived','set_person_birthday')
                     and has_function_privilege('anon', p.oid, 'execute')) = 0
             then 'PASS' else 'FAIL' end),
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), '(none -- correct)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('set_family_contributor','set_person_name',
                            'set_person_archived','set_person_birthday')
          and has_function_privilege('anon', p.oid, 'execute'))

union all

-- ---------------------------------------------------------------------------
-- 4. Migrations 001-046 are unchanged
--
-- Nothing inside the database records which migration files exist on disk, so
-- this cannot literally diff them. What it CAN do is confirm that the objects
-- 044, 045 and 046 created are still present and still carry their guards --
-- which is what "unchanged" has to mean from in here.
-- ---------------------------------------------------------------------------

select 4730, '001-046 unchanged',
       'the helpers 047 depends on all still exist',
       (case when to_regprocedure('public.area_of_person(uuid)') is not null
              and to_regprocedure('public.is_acting_area(uuid)') is not null
              and to_regprocedure('public.is_area_admin(uuid)') is not null
              and to_regprocedure('public.is_area_contributor_member(uuid)') is not null
              and to_regprocedure('public.require_acting_area(uuid)') is not null
             then 'PASS' else 'FAIL' end),
       (coalesce(to_regprocedure('public.area_of_person(uuid)')::text, 'area_of_person MISSING') || ' | ' ||
        coalesce(to_regprocedure('public.is_acting_area(uuid)')::text, 'is_acting_area MISSING') || ' | ' ||
        coalesce(to_regprocedure('public.is_area_admin(uuid)')::text, 'is_area_admin MISSING') || ' | ' ||
        coalesce(to_regprocedure('public.is_area_contributor_member(uuid)')::text, 'is_area_contributor_member MISSING') || ' | ' ||
        coalesce(to_regprocedure('public.require_acting_area(uuid)')::text, 'require_acting_area MISSING'))

union all

-- 045 hardened sixteen routines and 046 added its own. 047 adds none, so this
-- count must be exactly what it was before 047 was pasted in.
select 4731, '001-046 unchanged',
       '045''s cohort still carries require_acting_area',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prosrc like '%require_acting_area%') = 21
             then 'PASS' else 'REVIEW' end),
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc like '%require_acting_area%')
       || ' routines mention require_acting_area (21 expected on 001-047)'

union all

select 4732, '001-046 unchanged',
       '046''s gift idea removal is still in place',
       (case when to_regprocedure('public.remove_gift_idea(uuid)') is not null
             then 'PASS' else 'FAIL' end),
       coalesce(to_regprocedure('public.remove_gift_idea(uuid)')::text, 'MISSING')

union all

-- ---------------------------------------------------------------------------
-- 5. No policy or grant drift
-- ---------------------------------------------------------------------------

-- 047 writes no policies. `people` must still carry exactly the three it had.
select 4740, 'no drift',
       'the policies on people are unchanged',
       (case when (select count(*) from pg_policies
                   where schemaname = 'public' and tablename = 'people') = 3
             then 'PASS' else 'REVIEW' end),
       (select coalesce(string_agg(cmd || ' ' || policyname, ' | ' order by policyname), '(none)')
        from pg_policies where schemaname = 'public' and tablename = 'people')

union all

select 4741, 'no drift',
       'row level security is still enabled on people',
       (case when (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = 'people')
             then 'PASS' else 'FAIL' end),
       'people.relrowsecurity'

union all

-- THE DRIFT CHECK THAT EARNS ITS PLACE. Every SECURITY DEFINER routine that
-- writes, is callable by a signed-in user, and asks no acting-Area question.
-- After 047 there should be exactly five, and each is deliberately unguarded:
--
--   start_birthday_planning  refuses a cross-Area celebrant in its own words
--   create_area / create_person / create_event
--                            creators. There is no existing object to target,
--                            `is_app_admin()` has answered about the ACTING
--                            Area since 038, and 035's refuse_cross_area_person
--                            trigger refuses a created row that names another
--                            family's people
--   claim_app_member         takes no argument and matches only the caller's
--                            own email on an unclaimed row. Guarding it would
--                            BREAK claiming an invitation to a family you are
--                            not yet standing in
--
-- A SIXTH NAME APPEARING HERE IS THE WHOLE POINT OF THIS CHECK.
select 4742, 'no drift',
       'no unguarded definer writer beyond the five known-safe ones',
       (case when (select coalesce(string_agg(p.proname, ',' order by p.proname), '')
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prosecdef
                     and pg_get_function_result(p.oid) <> 'trigger'
                     and has_function_privilege('authenticated', p.oid, 'execute')
                     and p.prosrc ~* '(insert into|update (only )?public\.|delete from)'
                     and p.prosrc !~* '(require_acting_area|is_acting_area)')
                  = 'claim_app_member,create_area,create_event,create_person,start_birthday_planning'
             then 'PASS' else 'REVIEW' end),
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), '(none)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and pg_get_function_result(p.oid) <> 'trigger'
          and has_function_privilege('authenticated', p.oid, 'execute')
          and p.prosrc ~* '(insert into|update (only )?public\.|delete from)'
          and p.prosrc !~* '(require_acting_area|is_acting_area)')

union all

-- The inner routines 045's wrappers call must stay unreachable directly.
select 4743, 'no drift',
       'the inner save_* routines are still not executable by authenticated',
       (case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('save_purchase','save_christmas_recipient','save_recipient_contributions')
                     and has_function_privilege('authenticated', p.oid, 'execute')) = 0
             then 'PASS' else 'FAIL' end),
       (select coalesce(string_agg(p.proname, ', ' order by p.proname), '(none reachable -- correct)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('save_purchase','save_christmas_recipient','save_recipient_contributions')
          and has_function_privilege('authenticated', p.oid, 'execute'))

union all

-- ---------------------------------------------------------------------------
-- 6. Facts for the record
-- ---------------------------------------------------------------------------

select 4750, 'for the record', 'Areas in the database', 'INFO',
       (select count(*)::text from public.areas)

union all

select 4751, 'for the record', 'people in the database', 'INFO',
       (select count(*)::text from public.people)

union all

select 4752, 'for the record', 'accounts belonging to more than one Area', 'INFO',
       (select count(*)::text from (
          select user_id from public.app_members
          where active and user_id is not null
          group by user_id having count(distinct area_id) > 1) m)
       || ' (these are the logins this defect applied to)'

)
select result.verdict, result.section, result.check_name, result.detail
from (
  select 0 as sort, 'SUMMARY'::text as section,
         (case when (select count(*) from checks where verdict = 'FAIL') = 0
               then 'Everything checked is in order'
               else 'SOMETHING FAILED -- the FAIL rows are directly below this one'
          end)::text as check_name,
         (case when (select count(*) from checks where verdict = 'FAIL') = 0
               then 'PASS' else 'FAIL' end)::text as verdict,
         ((select count(*) from checks where verdict = 'PASS')::text || ' passed, ' ||
          (select count(*) from checks where verdict = 'FAIL')::text || ' failed, ' ||
          (select count(*) from checks where verdict = 'REVIEW')::text || ' to review, ' ||
          (select count(*) from checks where verdict = 'INFO')::text || ' facts recorded')::text as detail
  union all
  select sort, section, check_name, verdict, detail from checks
) result
order by
  case result.verdict when 'FAIL' then 0 when 'REVIEW' then 1 else 2 end,
  result.sort;
