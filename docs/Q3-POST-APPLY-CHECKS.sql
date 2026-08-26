-- =============================================================================
-- Q3 -- READ-ONLY PRODUCTION CHECKS, AFTER MIGRATIONS 044 AND 045
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and row counts and tells
--   you, line by line, whether migration 044 is really in place and whether
--   person administration is now asking about the right family.
--
-- HOW TO RUN IT
--   Open the Supabase SQL Editor, paste this WHOLE file in, and press Run.
--   You will get one table back. Read the first column.
--
-- HOW TO READ THE RESULT
--   PASS     this check is fine. Nothing to do.
--   FAIL     something is wrong. Do not deploy. Send the whole table back.
--   INFO     a fact for the record, not a pass or a fail -- counts and names.
--   REVIEW   something a person has to look at and judge.
--
--   FAIL rows are sorted to the TOP, and a SUMMARY row sits above everything.
--
-- WHAT MIGRATION 044 IS FOR
--   `set_family_contributor` (030) and `set_person_archived` (032) were written
--   when there was one family. Each asked `is_app_admin()` -- which since
--   migration 038 answers about the Area the caller SAID they are acting in --
--   and then wrote `where id = p_person_id`, naming no Area at all. The
--   question and the row came apart.
--
--   037's write barrier does not close it: that refuses a writer who is not a
--   MEMBER of the row's Area, which is no help against somebody who belongs to
--   both. An administrator of one family who is an ordinary member of another
--   could change a person in the second from inside the first. Proven against a
--   real PostgreSQL before 044 was written.
--
--   044 gives both routines the shape migration 039 already gave
--   `set_person_birthday`: resolve the Area FROM THE PERSON, then require
--   administration OF THAT AREA. It also adds `set_person_name`, so a
--   misspelled name can be corrected at all.
--
-- EVERY STATEMENT HERE IS A SELECT
--   Nothing is created, altered, dropped, inserted, updated or deleted. No
--   function is called that changes anything. It reads no budget, no price, no
--   allocation, no settlement, no receipt, no gift title and no note -- only
--   counts, ids and the names of database objects.
--
-- RUN THIS ONLY AFTER 044 AND 045 HAVE BEEN APPLIED
--   Before then every row below will say FAIL, correctly, because none of what
--   it checks exists yet.
-- =============================================================================

with checks as (

-- ---------------------------------------------------------------------------
-- 1. The three routines exist, and are shaped the way 044 says
-- ---------------------------------------------------------------------------

select 4401 as sort,
       '044 person administration'::text as section,
       'all three person routines exist'::text as check_name,
       (case when to_regprocedure('public.set_family_contributor(uuid, boolean)') is not null
              and to_regprocedure('public.set_person_archived(uuid, boolean)') is not null
              and to_regprocedure('public.set_person_name(uuid, text)') is not null
             then 'PASS' else 'FAIL' end)::text as verdict,
       (coalesce(to_regprocedure('public.set_family_contributor(uuid, boolean)')::text, 'MISSING') || ', ' ||
        coalesce(to_regprocedure('public.set_person_archived(uuid, boolean)')::text, 'MISSING') || ', ' ||
        coalesce(to_regprocedure('public.set_person_name(uuid, text)')::text, 'MISSING'))::text as detail

union all
select 4402, '044 person administration',
       'each one resolves the Area of the person it is changing',
       (case when (select count(*) from pg_proc
                   where pronamespace = 'public'::regnamespace
                     and proname in ('set_family_contributor', 'set_person_archived', 'set_person_name')
                     and prosrc like '%area_of_person%'
                     and prosrc like '%is_area_admin%') = 3
             then 'PASS' else 'FAIL' end),
       ((select coalesce(string_agg(proname, ', ' order by proname), '(none)') from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('set_family_contributor', 'set_person_archived', 'set_person_name')
           and prosrc like '%area_of_person%' and prosrc like '%is_area_admin%')
        || ' resolve and check the target Area')

union all
select 4403, '044 person administration',
       'and none of them still asks the acting-Area question',
       (case when (select count(*) from pg_proc
                   where pronamespace = 'public'::regnamespace
                     and proname in ('set_family_contributor', 'set_person_archived', 'set_person_name')
                     and prosrc like '%is_app_admin()%') = 0
             then 'PASS' else 'FAIL' end),
       ((select coalesce(string_agg(proname, ', ' order by proname), '(none -- correct)') from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('set_family_contributor', 'set_person_archived', 'set_person_name')
           and prosrc like '%is_app_admin()%')
        || ' still call is_app_admin(), which answers about the wrong Area')

union all
select 4404, '044 person administration',
       'each write is also narrowed to the resolved Area',
       (case when (select count(*) from pg_proc
                   where pronamespace = 'public'::regnamespace
                     and proname in ('set_family_contributor', 'set_person_archived', 'set_person_name')
                     and prosrc like '%area_id = target_area%') = 3
             then 'PASS' else 'FAIL' end),
       'belt as well as braces: the UPDATE says which Area it means'

-- ---------------------------------------------------------------------------
-- 2. Grants: authenticated may, anon may not
-- ---------------------------------------------------------------------------

union all
select 4410, '044 grants',
       'authenticated may run all three',
       (case when has_function_privilege('authenticated', 'public.set_family_contributor(uuid, boolean)', 'execute')
              and has_function_privilege('authenticated', 'public.set_person_archived(uuid, boolean)', 'execute')
              and has_function_privilege('authenticated', 'public.set_person_name(uuid, text)', 'execute')
             then 'PASS' else 'FAIL' end),
       'the app signs in as authenticated'

union all
select 4411, '044 grants',
       'anon may run none of them',
       (case when not has_function_privilege('anon', 'public.set_family_contributor(uuid, boolean)', 'execute')
              and not has_function_privilege('anon', 'public.set_person_archived(uuid, boolean)', 'execute')
              and not has_function_privilege('anon', 'public.set_person_name(uuid, text)', 'execute')
             then 'PASS' else 'FAIL' end),
       'a signed-out caller must not administer anybody'

union all
select 4412, '044 grants',
       'all three are SECURITY DEFINER with a pinned search_path',
       (case when (select count(*) from pg_proc
                   where pronamespace = 'public'::regnamespace
                     and proname in ('set_family_contributor', 'set_person_archived', 'set_person_name')
                     and prosecdef
                     and proconfig::text like '%search_path=%') = 3
             then 'PASS' else 'FAIL' end),
       'an unpinned search_path in a definer function is a privilege escalation'

-- ---------------------------------------------------------------------------
-- 3. Nothing 044 promised not to touch has moved
-- ---------------------------------------------------------------------------

union all
select 4420, '044 did not disturb the guards',
       'the write barrier and the cross-Area person guard are still there',
       (case when to_regproc('public.refuse_foreign_area_write') is not null
              and to_regproc('public.refuse_cross_area_person') is not null
              and to_regproc('public.area_of_person') is not null
             then 'PASS' else 'FAIL' end),
       '037 and 035 are load-bearing underneath 044'

union all
select 4421, '044 did not disturb the guards',
       'set_person_birthday still asks about the Area too',
       (case when (select count(*) from pg_proc
                   where pronamespace = 'public'::regnamespace
                     and proname = 'set_person_birthday'
                     and prosrc like '%area_of_person%') = 1
             then 'PASS' else 'FAIL' end),
       'migration 039 got there first; 044 must not have undone it'

union all
select 4422, '044 did not disturb the guards',
       'every person still belongs to exactly one Area',
       (case when (select count(*) from public.people where area_id is null) = 0
             then 'PASS' else 'FAIL' end),
       ((select count(*) from public.people where area_id is null)::text || ' people with no Area')

union all
select 4423, '044 did not disturb the guards',
       'no membership names a person from another Area',
       (case when (select count(*) from public.app_members m
                   join public.people p on p.id = m.person_id
                   where p.area_id <> m.area_id) = 0
             then 'PASS' else 'FAIL' end),
       ((select count(*) from public.app_members m
         join public.people p on p.id = m.person_id
         where p.area_id <> m.area_id)::text || ' memberships pointing at a foreign person')

union all
select 4424, '044 did not disturb the guards',
       'every Area still has exactly one active administrator',
       (case when (select count(*) from (
                     select a.id from public.areas a
                     left join public.app_members m
                       on m.area_id = a.id and m.active and m.role = 'admin'
                     group by a.id having count(m.id) <> 1) bad) = 0
             then 'PASS' else 'FAIL' end),
       ((select count(*) from (
           select a.id from public.areas a
           left join public.app_members m
             on m.area_id = a.id and m.active and m.role = 'admin'
           group by a.id having count(m.id) <> 1) bad)::text
        || ' Areas without exactly one active admin')

-- ---------------------------------------------------------------------------
-- 4. Facts for the record. Counts only -- no names, no money.
-- ---------------------------------------------------------------------------

union all
select 4430, 'facts', 'families, people and memberships', 'INFO',
       ((select count(*) from public.areas)::text || ' families, ' ||
        (select count(*) from public.people)::text || ' people, ' ||
        (select count(*) from public.app_members)::text || ' memberships (' ||
        (select count(*) from public.app_members where active)::text || ' active)')

union all
select 4431, 'facts', 'people who are contributors, and people who can sign in', 'INFO',
       ((select count(*) from public.people where is_family_contributor)::text ||
        ' contributors, ' ||
        (select count(*) from public.app_members where active and user_id is not null)::text ||
        ' active logins -- these are different facts about different sets of people')

union all
select 4432, 'facts', 'archived people keep their history', 'INFO',
       ((select count(*) from public.people where archived_at is not null)::text ||
        ' archived, of which ' ||
        (select count(*) from public.people p
         where p.archived_at is not null
           and exists (select 1 from public.christmas_recipients r where r.person_id = p.id))::text ||
        ' still have event history -- which is why archiving is not deletion')

union all
select 4433, 'facts', 'logins that belong to more than one family', 'INFO',
       ((select count(*) from (
           select user_id from public.app_members
           where user_id is not null and active
           group by user_id having count(distinct area_id) > 1) multi)::text ||
        ' accounts hold memberships in several families')

-- ---------------------------------------------------------------------------
-- 5. MIGRATION 045 -- one family at a time, for every targeted mutation
--
-- 044 fixed the two People routines that were proven Area-blind. 045 is the
-- rest: sixteen event, recipient, gift, purchase and payment routines that
-- authorised against the Area the caller was STANDING IN and then wrote to a
-- row identified only by its id, plus the four Area-level routines that could
-- be aimed at a family the caller was not looking at.
--
-- The fix is one line each -- `require_acting_area(<the row's own Area>)` --
-- so that every `is_app_admin()` beneath it is already a question about the
-- right family.
-- ---------------------------------------------------------------------------

union all
select 4501, '045 mutation hardening',
       'the guard and the settlement helper exist',
       (case when to_regprocedure('public.require_acting_area(uuid)') is not null
              and to_regprocedure('public.area_of_settlement(uuid)') is not null
             then 'PASS' else 'FAIL' end),
       (coalesce(to_regprocedure('public.require_acting_area(uuid)')::text, 'MISSING') || ', ' ||
        coalesce(to_regprocedure('public.area_of_settlement(uuid)')::text, 'MISSING'))

union all
select 4502, '045 mutation hardening',
       'EVERY targeted mutation calls the guard',
       (case when (select count(*) from unnest(array[
                     'set_event_status','update_event','delete_event_if_empty','add_event_recipient',
                     'set_event_contributor','set_christmas_recipient_active',
                     'save_christmas_recipient_with_contributions','save_gift_idea',
                     'save_purchase_with_location','set_purchase_status','void_purchase',
                     'record_settlement','admin_record_confirmed_payment','review_payment',
                     'void_settlement','set_area_name','set_area_archived','leave_area',
                     'transfer_area_admin']) as wanted(name)
                   where not exists (
                     select 1 from pg_proc p
                     where p.pronamespace = 'public'::regnamespace
                       and p.proname = wanted.name
                       and p.prosrc like '%require_acting_area%')) = 0
             then 'PASS' else 'FAIL' end),
       ((select coalesce(string_agg(wanted.name, ', ' order by wanted.name), '(none -- correct)')
         from unnest(array[
           'set_event_status','update_event','delete_event_if_empty','add_event_recipient',
           'set_event_contributor','set_christmas_recipient_active',
           'save_christmas_recipient_with_contributions','save_gift_idea',
           'save_purchase_with_location','set_purchase_status','void_purchase',
           'record_settlement','admin_record_confirmed_payment','review_payment',
           'void_settlement','set_area_name','set_area_archived','leave_area',
           'transfer_area_admin']) as wanted(name)
         where not exists (
           select 1 from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname = wanted.name
             and p.prosrc like '%require_acting_area%'))
        || ' are unguarded')

union all
select 4503, '045 mutation hardening',
       'NO OTHER authenticated mutation is Area-blind',
       (case when (select count(*) from pg_proc p
                   where p.pronamespace = 'public'::regnamespace
                     and has_function_privilege('authenticated', p.oid, 'execute')
                     and p.prorettype::regtype::text <> 'trigger'
                     and pg_get_functiondef(p.oid) ~* '(insert into public\.|update public\.|delete from public\.)'
                     and pg_get_functiondef(p.oid) !~ 'require_acting_area'
                     and pg_get_functiondef(p.oid) !~ 'area_of_(person|event|recipient|purchase|gift_idea|member|settlement)'
                     and p.proname not in (
                       'create_area', 'create_person', 'create_event', 'claim_app_member')) = 0
             then 'PASS' else 'REVIEW' end),
       ((select coalesce(string_agg(p.proname, ', ' order by p.proname), '(none -- correct)')
         from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and has_function_privilege('authenticated', p.oid, 'execute')
           and p.prorettype::regtype::text <> 'trigger'
           and pg_get_functiondef(p.oid) ~* '(insert into public\.|update public\.|delete from public\.)'
           and pg_get_functiondef(p.oid) !~ 'require_acting_area'
           and pg_get_functiondef(p.oid) !~ 'area_of_(person|event|recipient|purchase|gift_idea|member|settlement)'
           and p.proname not in ('create_area', 'create_person', 'create_event', 'claim_app_member'))
        || ' write without deriving a target Area (the four insert-only routines are exempt)')

union all
select 4504, '045 grants',
       'anon can call none of the guarded routines, authenticated can call them all',
       (case when (select count(*) from pg_proc p
                   where p.pronamespace = 'public'::regnamespace
                     and p.proname = any(array[
                       'set_event_status','update_event','delete_event_if_empty','add_event_recipient',
                       'set_event_contributor','set_christmas_recipient_active',
                       'save_christmas_recipient_with_contributions','save_gift_idea',
                       'save_purchase_with_location','set_purchase_status','void_purchase',
                       'record_settlement','admin_record_confirmed_payment','review_payment',
                       'void_settlement','set_area_name','set_area_archived','leave_area',
                       'transfer_area_admin','require_acting_area','area_of_settlement'])
                     and (has_function_privilege('anon', p.oid, 'execute')
                          or not has_function_privilege('authenticated', p.oid, 'execute'))) = 0
             then 'PASS' else 'FAIL' end),
       'a guard anon can call, or one the app cannot, is not a guard'

union all
select 4505, '045 grants',
       'every guarded routine is a definer with a pinned search_path',
       (case when (select count(*) from pg_proc p
                   where p.pronamespace = 'public'::regnamespace
                     and p.proname = any(array[
                       'set_event_status','update_event','delete_event_if_empty','add_event_recipient',
                       'set_event_contributor','set_christmas_recipient_active',
                       'save_christmas_recipient_with_contributions','save_gift_idea',
                       'save_purchase_with_location','set_purchase_status','void_purchase',
                       'record_settlement','admin_record_confirmed_payment','review_payment',
                       'void_settlement','set_area_name','set_area_archived','leave_area',
                       'transfer_area_admin','require_acting_area','area_of_settlement'])
                     and (not p.prosecdef
                          or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%')) = 0
             then 'PASS' else 'FAIL' end),
       'an unpinned search_path in a definer function is a privilege escalation'

union all
select 4506, '045 structural integrity',
       'no row anywhere has a parent in another family',
       (case when (
         (select count(*) from public.christmas_recipients r
            join public.events e on e.id = r.christmas_event_id
            join public.people p on p.id = r.person_id where p.area_id <> e.area_id)
       + (select count(*) from public.contributors c
            join public.events e on e.id = c.christmas_event_id
            join public.people p on p.id = c.person_id where p.area_id <> e.area_id)
       + (select count(*) from public.app_members m
            join public.people p on p.id = m.person_id where p.area_id <> m.area_id)
       + (select count(*) from public.settlements s
            join public.contributors c on c.id = s.payer_contributor_id
            where c.christmas_event_id <> s.christmas_event_id)) = 0
             then 'PASS' else 'FAIL' end),
       'recipients, contributors, memberships and settlements all checked against their parents'

union all
select 4507, '045 did not disturb the guards',
       'the 037 write barrier and the 044 person routines are still in place',
       (case when to_regproc('public.refuse_foreign_area_write') is not null
              and to_regprocedure('public.set_person_name(uuid, text)') is not null
              and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
                     and proname in ('set_family_contributor','set_person_archived','set_person_name')
                     and prosrc like '%area_of_person%') = 3
             then 'PASS' else 'FAIL' end),
       '045 sits on top of 044, and replaces none of it'

)

-- ===========================================================================
-- THE ANSWER
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
