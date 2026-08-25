-- =============================================================================
-- Q2 -- READ-ONLY PRODUCTION CHECKS, AFTER MIGRATIONS 041-043
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and row counts and tells
--   you, line by line, whether migrations 041, 042 and 043 are really in place
--   and whether every family is in a state the application can run against.
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
--   FAIL rows are sorted to the TOP, so if the first row says PASS and the
--   summary says 0 failed, everything passed.
--
-- EVERY STATEMENT HERE IS A SELECT
--   Nothing is created, altered, dropped, inserted, updated or deleted. No
--   function is called that changes anything. It reads no budget, no price, no
--   allocation, no settlement, no receipt, no gift title and no note -- only
--   counts, ids and the names of database objects.
--
-- RUN THIS ONLY AFTER 041, 042 AND 043 HAVE BEEN APPLIED
--   Before then every 041-043 row will say FAIL, correctly, because none of
--   those objects exists yet.
--
-- ONE ROW OF THE PHASE 5 FILE IS DELIBERATELY SUPERSEDED BY THIS ONE
--   `docs/PHASE-5-POST-APPLY-CHECKS.sql` checks that the index
--   `app_members_single_admin_per_area_idx` EXISTS. Migration 041 drops it on
--   purpose and replaces it with a deferrable constraint trigger, because a
--   unique index cannot be deferred and therefore made handing a family over
--   impossible in either order. So AFTER 041 that one Phase 5 row will say FAIL
--   and it is not a fault. This file checks the replacement, and checks the old
--   index is gone, which is the correct expectation from 041 onwards. Every
--   other row of the Phase 5 file still applies unchanged.
--
-- IF THE WHOLE QUERY ERRORS INSTEAD OF RETURNING A TABLE
--   Send the error text back verbatim.
--
-- =============================================================================

with checks as (

-- ===========================================================================
-- 041  HANDING A FAMILY OVER -- so an administrator is never the last one
-- ===========================================================================

select 4101 as sort,
       '041 admin handover'::text as section,
       'function public.refuse_area_without_one_admin exists'::text as check_name,
       (case when exists (select 1 from pg_proc
                          where pronamespace = 'public'::regnamespace
                            and proname = 'refuse_area_without_one_admin')
             then 'PASS' else 'FAIL' end)::text as verdict,
       'the rule that a family has exactly one administrator'::text as detail

union all
select 4102, '041 admin handover',
       'trigger app_members_exactly_one_admin is attached to app_members',
       case when exists (
         select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
         where tg.tgname = 'app_members_exactly_one_admin'
           and not tg.tgisinternal and c.relname = 'app_members'
       ) then 'PASS' else 'FAIL' end,
       coalesce((select c.relname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
                 where tg.tgname = 'app_members_exactly_one_admin' and not tg.tgisinternal
                 limit 1), '(not attached)')

union all
select 4103, '041 admin handover',
       'and it is DEFERRABLE INITIALLY DEFERRED, which is the whole point',
       case when exists (
         select 1 from pg_trigger
         where tgname = 'app_members_exactly_one_admin'
           and not tgisinternal and tgdeferrable and tginitdeferred
       ) then 'PASS' else 'FAIL' end,
       -- An immediate rule refuses the promotion (two admins for an instant)
       -- and refuses the demotion (none for an instant). Deferring it to commit
       -- is the only shape in which a handover can happen at all.
       coalesce((select case when tgdeferrable and tginitdeferred
                             then 'deferrable, initially deferred'
                             else 'IMMEDIATE -- a handover cannot succeed' end
                 from pg_trigger where tgname = 'app_members_exactly_one_admin'
                   and not tgisinternal limit 1), '(not attached)')

union all
select 4104, '041 admin handover',
       'the superseded index app_members_single_admin_per_area_idx is GONE',
       case when to_regclass('public.app_members_single_admin_per_area_idx') is null
            then 'PASS' else 'FAIL' end,
       -- See the note at the top of this file: this REPLACES the Phase 5 row
       -- that asked for the same index to exist.
       coalesce(to_regclass('public.app_members_single_admin_per_area_idx')::text,
                'gone, as 041 intends')

union all
select 4105, '041 admin handover',
       'function public.transfer_area_admin(uuid, uuid) exists',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'transfer_area_admin'
           and pg_get_function_identity_arguments(p.oid) = 'p_area_id uuid, p_new_admin_member_id uuid'
       ) then 'PASS' else 'FAIL' end,
       coalesce((select 'takes: ' || pg_get_function_identity_arguments(p.oid)
                 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname = 'transfer_area_admin' limit 1), '(missing)')

union all
select 4106, '041 admin handover',
       'transfer_area_admin runs with definer rights and a pinned search_path',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'transfer_area_admin'
           and p.prosecdef
           and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%'
       ) then 'PASS' else 'FAIL' end,
       coalesce((select case when p.prosecdef then 'security definer, ' else 'INVOKER RIGHTS, ' end
                        || coalesce(array_to_string(p.proconfig, ','), 'NO search_path set')
                 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname = 'transfer_area_admin' limit 1), '(missing)')

union all
select 4107, '041 admin handover',
       'only signed-in callers may run transfer_area_admin',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'transfer_area_admin'
           and has_function_privilege('authenticated', p.oid, 'execute')
           and not has_function_privilege('anon', p.oid, 'execute')
       ) then 'PASS' else 'FAIL' end,
       coalesce((select case when has_function_privilege('authenticated', p.oid, 'execute')
                             then 'authenticated: yes' else 'authenticated: NO' end
                        || ', ' ||
                        case when has_function_privilege('anon', p.oid, 'execute')
                             then 'anon: YES -- WRONG' else 'anon: no' end
                 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname = 'transfer_area_admin' limit 1), '(missing)')

union all
select 4108, '041 admin handover',
       'the audit log accepts a handover being recorded',
       case when exists (
         select 1 from pg_constraint
         where conrelid = 'public.audit_log'::regclass
           and conname = 'audit_log_action_check'
           and pg_get_constraintdef(oid) like '%handover%'
       ) then 'PASS' else 'FAIL' end,
       -- Without this the handover succeeds and then fails on its own audit
       -- row, taking the whole transaction with it.
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                 where conrelid = 'public.audit_log'::regclass
                   and conname = 'audit_log_action_check' limit 1), '(no such constraint)')

-- --------------------------------------------------------------------------
-- 041  and the state of every real family, measured against that rule
-- --------------------------------------------------------------------------

union all
select 4120, '041 admin handover',
       'EVERY family with members has exactly one active administrator',
       case when (select count(*) from (
              select m.area_id from public.app_members m
              group by m.area_id
              having count(*) filter (where m.role = 'admin' and m.active) <> 1
            ) x) = 0 then 'PASS' else 'FAIL' end,
       (select count(*)::text || ' families are not in that state'
        from (select m.area_id from public.app_members m group by m.area_id
              having count(*) filter (where m.role = 'admin' and m.active) <> 1) x)

union all
select 4121, '041 admin handover',
       'families, and how many active members each has',
       'INFO',
       (select coalesce(string_agg(x.line, '; ' order by x.line), '(no families)')
        from (select a.id::text || ': '
                     || count(*) filter (where m.active)::text || ' active, '
                     || count(*) filter (where m.role = 'admin' and m.active)::text || ' admin' as line
              from public.areas a
              left join public.app_members m on m.area_id = a.id
              group by a.id) x)

union all
select 4122, '041 admin handover',
       'handovers recorded so far',
       'INFO',
       (select count(*)::text || ' handover entries in the audit log'
        from public.audit_log where action = 'handover')

-- ===========================================================================
-- 042  LEAVING, AND JOINING A SECOND FAMILY
-- ===========================================================================

union all
select 4201, '042 membership lifecycle',
       'function public.leave_area(uuid) exists',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'leave_area'
           and pg_get_function_identity_arguments(p.oid) = 'p_area_id uuid'
       ) then 'PASS' else 'FAIL' end,
       coalesce((select 'takes: ' || pg_get_function_identity_arguments(p.oid)
                 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname = 'leave_area' limit 1), '(missing)')

union all
select 4202, '042 membership lifecycle',
       'only signed-in callers may run leave_area',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'leave_area'
           and has_function_privilege('authenticated', p.oid, 'execute')
           and not has_function_privilege('anon', p.oid, 'execute')
       ) then 'PASS' else 'FAIL' end,
       coalesce((select case when has_function_privilege('anon', p.oid, 'execute')
                             then 'anon: YES -- WRONG' else 'anon: no' end
                 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname = 'leave_area' limit 1), '(missing)')

union all
select 4203, '042 membership lifecycle',
       'function public.claim_app_member exists and is callable by a signed-in caller',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'claim_app_member'
           and has_function_privilege('authenticated', p.oid, 'execute')
       ) then 'PASS' else 'FAIL' end,
       'the routine that turns an invitation into a membership'

union all
select 4204, '042 membership lifecycle',
       'the write barrier function is still in place',
       case when exists (select 1 from pg_proc
                         where pronamespace = 'public'::regnamespace
                           and proname = 'refuse_foreign_area_write')
            then 'PASS' else 'FAIL' end,
       -- 042 REDEFINES this function rather than replacing the barrier. Its
       -- triggers are 037's and must all still be attached, below.
       'redefined by 042, with one narrow exemption for claiming an invitation'

union all
select 4210 + t.n, '042 membership lifecycle',
       'barrier trigger ' || t.name || '_refuse_foreign_area is still attached',
       case when exists (
         select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
         where tg.tgname = t.name || '_refuse_foreign_area'
           and not tg.tgisinternal and c.relname = t.name
       ) then 'PASS' else 'FAIL' end,
       'redefining the function must not have detached anything'
from (values
  ('people', 1), ('events', 2), ('app_members', 3), ('christmas_recipients', 4),
  ('contributors', 5), ('purchases', 6), ('purchase_allocations', 7),
  ('gift_ideas', 8), ('recipient_contributions', 9), ('settlements', 10),
  ('payment_receipts', 11), ('item_photos', 12)
) as t(name, n)

-- --------------------------------------------------------------------------
-- 042  and the state of the memberships themselves
-- --------------------------------------------------------------------------

union all
select 4230, '042 membership lifecycle',
       'NO login holds two memberships in one family',
       case when (select count(*) from (
              select area_id, user_id from public.app_members
              where user_id is not null group by area_id, user_id having count(*) > 1
            ) x) = 0 then 'PASS' else 'FAIL' end,
       (select count(*)::text || ' logins are doubled up in a family'
        from (select area_id, user_id from public.app_members
              where user_id is not null group by area_id, user_id having count(*) > 1) x)

union all
select 4231, '042 membership lifecycle',
       'NO membership points at a person in another family',
       case when (select count(*) from public.app_members m
                  join public.people p on p.id = m.person_id
                  where p.area_id is distinct from m.area_id) = 0
            then 'PASS' else 'FAIL' end,
       (select count(*)::text || ' crossed memberships'
        from public.app_members m join public.people p on p.id = m.person_id
        where p.area_id is distinct from m.area_id)

union all
select 4232, '042 membership lifecycle',
       'invitations waiting to be claimed',
       'INFO',
       (select count(*)::text || ' memberships have an email and no login yet'
        from public.app_members where user_id is null and email is not null)

union all
select 4233, '042 membership lifecycle',
       'logins that belong to more than one family',
       'INFO',
       (select count(*)::text || ' logins are in two or more families'
        from (select user_id from public.app_members
              where user_id is not null and active
              group by user_id having count(distinct area_id) > 1) x)

-- ===========================================================================
-- 043  WHOSE BIRTHDAY MAY BE PLANNED, AND BY WHOM
-- ===========================================================================

union all
select 4301, '043 birthday planning eligibility',
       'function public.start_birthday_planning exists with the expected arguments',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'start_birthday_planning'
           and pg_get_function_identity_arguments(p.oid)
               = 'p_celebrant_person_id uuid, p_name text, p_event_date date, '
                 || 'p_budget_pennies integer, p_contributions jsonb'
       ) then 'PASS' else 'FAIL' end,
       coalesce((select 'takes: ' || pg_get_function_identity_arguments(p.oid)
                 from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname = 'start_birthday_planning' limit 1), '(missing)')

union all
select 4302, '043 birthday planning eligibility',
       'it asks is_area_contributor_member, so a contributor can start one too',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'start_birthday_planning'
           and pg_get_functiondef(p.oid) like '%is_area_contributor_member%'
       ) then 'PASS' else 'FAIL' end,
       -- This is what unsticks the administrator's own birthday: they are
       -- refused because it is theirs, and before 043 everybody else was
       -- refused for not being the administrator.
       'without this, one person in each family can never have a birthday planned'

union all
select 4303, '043 birthday planning eligibility',
       'AND the celebrant is still refused their own -- privacy beats being admin',
       case when exists (
         select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'refuse_starting_own_birthday'
           and pg_get_functiondef(p.oid) like '%current_person_in_area%'
       ) then 'PASS' else 'FAIL' end,
       'the guard resolves the caller INSIDE the event''s own family'

union all
select 4304, '043 birthday planning eligibility',
       'trigger events_refuse_own_birthday is attached',
       case when exists (
         select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
         where not tg.tgisinternal and c.relname = 'events'
           and pg_get_triggerdef(tg.oid) like '%refuse_starting_own_birthday%'
       ) then 'PASS' else 'FAIL' end,
       coalesce((select tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
                 where not tg.tgisinternal and c.relname = 'events'
                   and pg_get_triggerdef(tg.oid) like '%refuse_starting_own_birthday%'
                 limit 1), '(not attached)')

union all
select 4310, '043 birthday planning eligibility',
       'NO birthday names a celebrant from another family',
       case when (select count(*) from public.events e
                  join public.people p on p.id = e.celebrant_person_id
                  where p.area_id is distinct from e.area_id) = 0
            then 'PASS' else 'FAIL' end,
       (select count(*)::text || ' events whose celebrant is in a different family'
        from public.events e join public.people p on p.id = e.celebrant_person_id
        where p.area_id is distinct from e.area_id)

union all
select 4311, '043 birthday planning eligibility',
       'people who can start a birthday in their family',
       'INFO',
       (select coalesce(string_agg(x.line, '; ' order by x.line), '(none)')
        from (select m.area_id::text || ': '
                     || (count(*) filter (where m.role = 'admin' and m.active)
                         + count(*) filter (where m.active and m.contributor_id is not null
                                              and m.role <> 'admin'))::text || ' eligible' as line
              from public.app_members m group by m.area_id) x)

-- ===========================================================================
-- CROSS-CUTTING -- nothing new is reachable by a stranger
-- ===========================================================================

union all
select 4401, 'cross-cutting',
       'every routine 041-043 added runs with a pinned search_path',
       case when (select count(*) from pg_proc p
                  where p.pronamespace = 'public'::regnamespace
                    and p.proname in ('transfer_area_admin', 'leave_area',
                                      'refuse_area_without_one_admin',
                                      'refuse_foreign_area_write', 'claim_app_member',
                                      'start_birthday_planning', 'refuse_starting_own_birthday')
                    and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%'
                 ) = 0 then 'PASS' else 'FAIL' end,
       (select coalesce(string_agg(p.proname, ', '), 'all pinned')
        from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('transfer_area_admin', 'leave_area',
                            'refuse_area_without_one_admin', 'refuse_foreign_area_write',
                            'claim_app_member', 'start_birthday_planning',
                            'refuse_starting_own_birthday')
          and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%')

union all
select 4402, 'cross-cutting',
       'NONE of them is callable by a signed-out visitor',
       case when (select count(*) from pg_proc p
                  where p.pronamespace = 'public'::regnamespace
                    and p.proname in ('transfer_area_admin', 'leave_area', 'claim_app_member',
                                      'start_birthday_planning')
                    and has_function_privilege('anon', p.oid, 'execute')
                 ) = 0 then 'PASS' else 'FAIL' end,
       (select coalesce(string_agg(p.proname, ', '), 'none reachable by anon')
        from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('transfer_area_admin', 'leave_area', 'claim_app_member',
                            'start_birthday_planning')
          and has_function_privilege('anon', p.oid, 'execute'))

union all
select 4403, 'cross-cutting',
       'the pre-request hook is still what turns a header into a family',
       case when exists (
         select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
         where r.rolname = 'authenticator'
           and array_to_string(s.setconfig, ' ') like '%pgrst.db_pre_request=%'
       ) then 'PASS' else 'REVIEW' end,
       coalesce((select (regexp_match(array_to_string(s.setconfig, ' '),
                                      'pgrst[.]db_pre_request=([a-z_.]+)'))[1]
                 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                 where r.rolname = 'authenticator' limit 1),
                'not set on this role -- check the API settings instead')

union all
select 4404, 'cross-cutting',
       'row level security is on for every table that carries an Area',
       case when (select count(*) from pg_class c
                  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                    and c.relname in ('areas', 'people', 'events', 'app_members', 'audit_log')
                    and not c.relrowsecurity) = 0
            then 'PASS' else 'FAIL' end,
       (select coalesce(string_agg(c.relname, ', '), 'all five are protected')
        from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and c.relname in ('areas', 'people', 'events', 'app_members', 'audit_log')
          and not c.relrowsecurity)

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
