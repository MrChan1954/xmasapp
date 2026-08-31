-- =============================================================================
-- MIGRATION 052 -- READ-ONLY PRODUCTION CHECKS, AFTER APPLYING
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and reports, line by
--   line, whether migration 052 is really in place: the table created and shut
--   to the browser, ten routines added, nine redefined, two policies changed,
--   the backfill correct, and NOBODY yet administering Gift Planner.
--
--   IT ONLY READS. There is no insert, update, delete or DDL anywhere in this
--   file. Running it twice changes nothing. Running it before the bootstrap and
--   again after is the intended use.
--
-- HOW TO RUN IT
--   Open the Supabase SQL Editor, paste this WHOLE file in, and press Run.
--   You get one table back. Read the first column.
--
--   RUN IT AFTER 052, NOT BEFORE. Sections 5 and 7 read rows OUT of
--   `app_accounts`, so on a database that has not had 052 this file does not
--   report a failure -- it stops with
--
--       ERROR: relation "public.app_accounts" does not exist
--
--   which is itself an unambiguous answer, and a far clearer one than a table
--   of FAILs would be. There is no way to read a table's rows conditionally in
--   a single statement, and being one statement is what makes the Supabase SQL
--   Editor show the whole report rather than only its last query.
--
-- HOW TO READ THE RESULT
--   PASS     this check is fine.
--   FAIL     something is wrong. Send the whole table back before doing
--            anything else; `docs/Q19-052-ROLLBACK.sql` exists for this.
--   REVIEW   a person has to look. Not automatically wrong.
--   INFO     a fact for the record.
--
--   FAIL rows sort to the TOP, then REVIEW.
--
-- THE THREE THAT MATTER MOST
--
--   `app_accounts is closed to both browser roles` -- if this fails, the global
--   approval table is readable or writable from a browser and the whole design
--   is undone. It sweeps every privilege, not just SELECT.
--
--   `no account was approved without a confirmed email` -- the backfill rule.
--   A failure here means somebody was let in on an address they never proved
--   they own, which is the exact takeover 052 exists to prevent.
--
--   `zero global administrators (BEFORE the bootstrap)` -- expected to PASS
--   immediately after 052 and to become REVIEW once the first administrator is
--   appointed. Both are correct at the right moment; the detail says which.
-- =============================================================================

with
-- What each browser role actually holds on app_accounts, from the catalogue.
account_acl as (
  select a.grantee::regrole::text as role_name, a.privilege_type
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  where c.oid = to_regclass('public.app_accounts')
    and a.grantee::regrole::text in ('anon', 'authenticated')
),

-- The ten routines 052 adds, as one list to sweep rather than ten checks.
added(signature) as (values
  ('public.is_globally_approved()'),
  ('public.is_global_admin()'),
  ('public.my_account_status()'),
  ('public.list_accounts(text)'),
  ('public.set_account_status(uuid, text, text)'),
  ('public.grant_global_admin(uuid)'),
  ('public.revoke_global_admin(uuid)'),
  ('public.grant_area_access(uuid, text)'),
  ('public.revoke_area_access(uuid, boolean)'),
  ('public.list_area_access()')
),

checks as (

-- ---------------------------------------------------------------------------
-- 1. THE TABLE
-- ---------------------------------------------------------------------------

  select 101 as ord,
    case when to_regclass('public.app_accounts') is not null then 'PASS' else 'FAIL' end as status,
    'app_accounts exists' as check_name,
    coalesce(to_regclass('public.app_accounts')::text, 'MISSING') as detail

  union all
  select 102,
    case when coalesce((select c.relrowsecurity from pg_class c
                        where c.oid = to_regclass('public.app_accounts')), false)
         then 'PASS' else 'FAIL' end,
    'app_accounts has row level security enabled',
    coalesce((select c.relrowsecurity::text from pg_class c
              where c.oid = to_regclass('public.app_accounts')), 'no table')

  union all
  select 103,
    case when (select count(*) from pg_policy where polrelid = to_regclass('public.app_accounts')) = 0
         then 'PASS' else 'FAIL' end,
    'app_accounts has ZERO policies, so nothing admits a browser',
    (select count(*)::text from pg_policy where polrelid = to_regclass('public.app_accounts'))

  union all
  select 104,
    case when not exists (select 1 from account_acl) then 'PASS' else 'FAIL' end,
    'app_accounts is closed to both browser roles (no privilege of any kind)',
    coalesce((select string_agg(role_name || '=' || privilege_type, ', ' order by role_name, privilege_type)
              from account_acl), 'nothing granted -- correct')

  union all
  select 105,
    case when (select count(*) from pg_constraint
               where conrelid = to_regclass('public.app_accounts')
                 and conname in ('app_accounts_status_known', 'app_accounts_admin_must_be_approved')) = 2
         then 'PASS' else 'FAIL' end,
    'both CHECK constraints are present',
    coalesce((select string_agg(conname, ', ' order by conname) from pg_constraint
              where conrelid = to_regclass('public.app_accounts') and contype = 'c'), 'none')

  union all
  select 106,
    case when exists (select 1 from pg_indexes
                      where schemaname = 'public' and tablename = 'app_accounts'
                        and indexname = 'app_accounts_undecided_idx')
         then 'PASS' else 'FAIL' end,
    'the partial index on the undecided queue exists',
    coalesce((select string_agg(indexname, ', ' order by indexname) from pg_indexes
              where schemaname = 'public' and tablename = 'app_accounts'), 'none')

-- ---------------------------------------------------------------------------
-- 2. THE TEN NEW ROUTINES
-- ---------------------------------------------------------------------------

  union all
  select 201,
    case when (select count(*) from added where to_regprocedure(signature) is not null) = 10
         then 'PASS' else 'FAIL' end,
    'all ten new routines exist',
    (select coalesce(string_agg(signature, ', ' order by signature), '(none missing)')
     from added where to_regprocedure(signature) is null) || ' missing'

  union all
  select 202,
    case when not exists (
           select 1 from added
           where to_regprocedure(signature) is null
              or not (select p.prosecdef from pg_proc p where p.oid = signature::regprocedure))
         then 'PASS' else 'FAIL' end,
    'every new routine is SECURITY DEFINER',
    (select coalesce(string_agg(signature, ', ' order by signature), '(all definer)')
     from added
     where to_regprocedure(signature) is not null
       and not (select p.prosecdef from pg_proc p where p.oid = signature::regprocedure))

  union all
  select 203,
    case when not exists (
           select 1 from added
           where to_regprocedure(signature) is null
              or not exists (select 1 from pg_proc p, unnest(p.proconfig) as cfg
                             where p.oid = signature::regprocedure
                               and cfg in ('search_path=', 'search_path=""')))
         then 'PASS' else 'FAIL' end,
    'every new routine pins search_path to the empty string',
    (select coalesce(string_agg(signature, ', ' order by signature), '(all pinned)')
     from added
     where to_regprocedure(signature) is not null
       and not exists (select 1 from pg_proc p, unnest(p.proconfig) as cfg
                       where p.oid = signature::regprocedure
                         and cfg in ('search_path=', 'search_path=""')))

  union all
  select 204,
    case when not exists (
           select 1 from added
           where to_regprocedure(signature) is null
              or not has_function_privilege('authenticated', signature, 'execute'))
         then 'PASS' else 'FAIL' end,
    'authenticated can execute every new routine',
    (select coalesce(string_agg(signature, ', ' order by signature), '(all callable)')
     from added
     where to_regprocedure(signature) is not null
       and not has_function_privilege('authenticated', signature, 'execute'))

  union all
  select 205,
    case when not exists (
           select 1 from added
           where to_regprocedure(signature) is not null
             and has_function_privilege('anon', signature, 'execute'))
         then 'PASS' else 'FAIL' end,
    'ANON CAN EXECUTE NONE OF THEM',
    (select coalesce(string_agg(signature, ', ' order by signature), '(none reachable by anon)')
     from added
     where to_regprocedure(signature) is not null
       and has_function_privilege('anon', signature, 'execute'))

-- ---------------------------------------------------------------------------
-- 3. THE NINE REDEFINITIONS
-- ---------------------------------------------------------------------------

  union all
  select 301,
    case when (select count(*) from (values
                 ('public.is_active_app_member()'),
                 ('public.is_area_member(uuid)'),
                 ('public.is_area_admin(uuid)'),
                 ('public.is_own_app_member(uuid)'),
                 ('public.is_app_admin()'),
                 ('public.is_area_contributor_member(uuid)')) as t(sig)
               where to_regprocedure(sig) is not null
                 and position('is_globally_approved' in pg_get_functiondef(sig::regprocedure)) > 0) = 6
         then 'PASS' else 'FAIL' end,
    'all six membership predicates carry the approval gate',
    (select coalesce(string_agg(sig, ', ' order by sig), '(all gated)') from (values
       ('public.is_active_app_member()'),
       ('public.is_area_member(uuid)'),
       ('public.is_area_admin(uuid)'),
       ('public.is_own_app_member(uuid)'),
       ('public.is_app_admin()'),
       ('public.is_area_contributor_member(uuid)')) as t(sig)
     where to_regprocedure(sig) is null
        or position('is_globally_approved' in pg_get_functiondef(sig::regprocedure)) = 0)

  union all
  select 302,
    case when position('is_globally_approved' in
                       pg_get_functiondef('public.create_area(text, text)'::regprocedure)) > 0
         then 'PASS' else 'FAIL' end,
    'create_area refuses an unapproved account',
    case when position('is_globally_approved' in
                       pg_get_functiondef('public.create_area(text, text)'::regprocedure)) > 0
         then 'the approval gate is in its body'
         else 'THE GATE IS MISSING -- any signed-in account can create a family' end

  union all
  select 303,
    case when position('email_confirmed_at' in
                       pg_get_functiondef('public.claim_app_member()'::regprocedure)) > 0
         then 'PASS' else 'FAIL' end,
    'claim_app_member requires a confirmed email',
    case when position('email_confirmed_at' in
                       pg_get_functiondef('public.claim_app_member()'::regprocedure)) > 0
         then 'the confirmed-email condition is in its body'
         else 'THE CONDITION IS MISSING -- an unconfirmed address can claim a family seat' end

  union all
  select 304,
    case when position('app_accounts' in
                       pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) > 0
         then 'PASS' else 'FAIL' end,
    'stamp_audit_area returns early for a global decision',
    case when position('app_accounts' in
                       pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) > 0
         then 'the early return is in its body'
         else 'MISSING -- a global decision would be stamped with the decider''s family' end

  union all
  -- AND 049'S LOGIC SURVIVED THE REDEFINITION. A `create or replace` that
  -- dropped the acting-Area step while adding the early return would pass 304
  -- and silently undo an earlier migration.
  select 305,
    case when position('public.acting_area()' in
                       pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) > 0
          and position('public.area_of_record(' in
                       pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) > 0
         then 'PASS' else 'FAIL' end,
    'and it still carries migration 049''s acting-Area logic and 037''s record lookup',
    case when position('public.acting_area()' in
                       pg_get_functiondef('public.stamp_audit_area()'::regprocedure)) > 0
         then 'both steps present'
         else 'MIGRATION 049 HAS BEEN UNDONE by 052''s redefinition' end

  union all
  select 306,
    case when (select count(*) from (values
                 ('public.is_active_app_member()'),
                 ('public.is_area_member(uuid)'),
                 ('public.is_area_admin(uuid)'),
                 ('public.is_own_app_member(uuid)'),
                 ('public.is_app_admin()'),
                 ('public.is_area_contributor_member(uuid)'),
                 ('public.create_area(text, text)'),
                 ('public.claim_app_member()'),
                 ('public.stamp_audit_area()')) as t(sig)
               where (select p.prosecdef from pg_proc p where p.oid = sig::regprocedure)
                 and exists (select 1 from pg_proc p, unnest(p.proconfig) as cfg
                             where p.oid = sig::regprocedure
                               and cfg in ('search_path=', 'search_path=""'))) = 9
         then 'PASS' else 'FAIL' end,
    'all nine redefined routines are still pinned SECURITY DEFINERs',
    'checked: definer flag and search_path on each'

-- ---------------------------------------------------------------------------
-- 4. THE POLICIES
-- ---------------------------------------------------------------------------

  union all
  select 401,
    case when exists (
           select 1 from pg_policy
           where polrelid = 'public.app_members'::regclass
             and polname = 'active members may read own membership'
             and position('is_globally_approved' in pg_get_expr(polqual, polrelid)) > 0)
         then 'PASS' else 'FAIL' end,
    'the app_members own-row policy requires global approval',
    coalesce((select pg_get_expr(polqual, polrelid) from pg_policy
              where polrelid = 'public.app_members'::regclass
                and polname = 'active members may read own membership'), 'THE POLICY IS MISSING')

  union all
  select 402,
    case when exists (
           select 1 from pg_policy
           where polrelid = 'public.audit_log'::regclass
             and polname = 'global admins read global account decisions')
         then 'PASS' else 'FAIL' end,
    'the global audit policy exists',
    coalesce((select pg_get_expr(polqual, polrelid) from pg_policy
              where polrelid = 'public.audit_log'::regclass
                and polname = 'global admins read global account decisions'), 'MISSING')

  union all
  -- ALL FIVE RESTRICTIONS, INDIVIDUALLY. This policy is PERMISSIVE, so it is
  -- OR'd with the family one -- every restriction has to hold on its own or it
  -- becomes a door onto rows it was never meant to reach.
  select 403,
    case when (select count(*) from (values
                 ('area_id IS NULL'),
                 ('table_name = ''app_accounts'''),
                 ('celebrant_person_id IS NULL'),
                 ('birthday_privacy_unknown = false'),
                 ('is_global_admin()')) as t(needle)
               where position(t.needle in coalesce((select pg_get_expr(polqual, polrelid) from pg_policy
                 where polrelid = 'public.audit_log'::regclass
                   and polname = 'global admins read global account decisions'), '')) > 0) = 5
         then 'PASS' else 'FAIL' end,
    'and it carries all five of its restrictions',
    (select coalesce(string_agg(t.needle, ' | ' order by t.needle), '(all five present)')
     from (values ('area_id IS NULL'), ('table_name = ''app_accounts'''),
                  ('celebrant_person_id IS NULL'), ('birthday_privacy_unknown = false'),
                  ('is_global_admin()')) as t(needle)
     where position(t.needle in coalesce((select pg_get_expr(polqual, polrelid) from pg_policy
       where polrelid = 'public.audit_log'::regclass
         and polname = 'global admins read global account decisions'), '')) = 0) || ' missing'

  union all
  select 404,
    case when exists (
           select 1 from pg_policy
           where polrelid = 'public.audit_log'::regclass
             and polname = 'members read the audit log'
             and position('birthday_privacy_unknown' in pg_get_expr(polqual, polrelid)) > 0
             and position('celebrant_person_id' in pg_get_expr(polqual, polrelid)) > 0)
         then 'PASS' else 'FAIL' end,
    'migration 050''s audit policy is untouched',
    coalesce((select pg_get_expr(polqual, polrelid) from pg_policy
              where polrelid = 'public.audit_log'::regclass
                and polname = 'members read the audit log'), 'MISSING -- 050 HAS BEEN UNDONE')

  union all
  select 405,
    case when (select count(*) from pg_policy where polrelid = 'public.audit_log'::regclass) = 2
         then 'PASS' else 'REVIEW' end,
    'audit_log has exactly two policies (050''s and 052''s)',
    (select coalesce(string_agg(polname, ', ' order by polname), 'none')
     from pg_policy where polrelid = 'public.audit_log'::regclass)

  union all
  select 406,
    case when (select count(*) from pg_constraint
               where conrelid = 'public.audit_log'::regclass
                 and conname = 'audit_log_action_check'
                 and position('decided' in pg_get_constraintdef(oid)) > 0
                 and position('handover' in pg_get_constraintdef(oid)) > 0
                 and position('added' in pg_get_constraintdef(oid)) > 0) = 1
         then 'PASS' else 'FAIL' end,
    'the audit action vocabulary was WIDENED, not replaced',
    coalesce((select pg_get_constraintdef(oid) from pg_constraint
              where conrelid = 'public.audit_log'::regclass
                and conname = 'audit_log_action_check'), 'MISSING')

-- ---------------------------------------------------------------------------
-- 5. THE BACKFILL
-- ---------------------------------------------------------------------------

  union all
  select 501,
    case when (select count(*) from public.app_accounts a
               join auth.users u on u.id = a.user_id
               where a.status = 'approved' and u.email_confirmed_at is null) = 0
         then 'PASS' else 'FAIL' end,
    'NO ACCOUNT WAS APPROVED WITHOUT A CONFIRMED EMAIL',
    (select count(*)::text from public.app_accounts a
     join auth.users u on u.id = a.user_id
     where a.status = 'approved' and u.email_confirmed_at is null)
    || ' approved account(s) have an unconfirmed address'

  union all
  -- Category A, recomputed from scratch and compared with what is on disk. A
  -- mismatch AFTER a human has reviewed the queue is expected and reads REVIEW;
  -- immediately after 052 it must be zero.
  select 502,
    case when (select count(*) from public.app_accounts where status = 'approved')
            = (select count(distinct u.id) from auth.users u
               where u.email_confirmed_at is not null
                 and exists (select 1 from public.app_members m
                             where m.user_id = u.id and m.active = true))
         then 'PASS' else 'REVIEW' end,
    'the approved set equals the confirmed-and-claimed set (true immediately after 052)',
    format('%s approved, %s meet the backfill rule -- a difference is expected once a person has decided anything',
      (select count(*) from public.app_accounts where status = 'approved'),
      (select count(distinct u.id) from auth.users u
       where u.email_confirmed_at is not null
         and exists (select 1 from public.app_members m
                     where m.user_id = u.id and m.active = true)))

  union all
  select 503,
    case when (select count(*) from public.app_accounts where status not in
                 ('pending', 'approved', 'rejected', 'suspended')) = 0
         then 'PASS' else 'FAIL' end,
    'every status is one of the four the CHECK allows',
    (select coalesce(string_agg(distinct status, ', ' order by status), 'none') from public.app_accounts)

  union all
  -- ZERO IMMEDIATELY AFTER 052, and one (or more) once the bootstrap has been
  -- run. Both are right at the right moment, which is why this is a REVIEW and
  -- not a FAIL -- the detail says which state you are looking at.
  select 504,
    case when (select count(*) from public.app_accounts where is_global_admin) = 0
         then 'PASS' else 'REVIEW' end,
    'zero global administrators (BEFORE the bootstrap)',
    case when (select count(*) from public.app_accounts where is_global_admin) = 0
         then 'none yet -- correct immediately after 052, and the bootstrap is still to run'
         else (select count(*)::text from public.app_accounts where is_global_admin)
              || ' appointed -- correct AFTER the bootstrap, wrong before it' end

  union all
  select 505,
    case when (select count(*) from public.app_accounts
               where is_global_admin and status <> 'approved') = 0
         then 'PASS' else 'FAIL' end,
    'no global administrator is unapproved',
    (select count(*)::text from public.app_accounts where is_global_admin and status <> 'approved')

  union all
  select 506,
    case when (select count(*) from public.app_accounts a
               where not exists (select 1 from auth.users u where u.id = a.user_id)) = 0
         then 'PASS' else 'FAIL' end,
    'every app_accounts row names a real auth user',
    (select count(*)::text from public.app_accounts)
    || ' rows, all referencing auth.users'

-- ---------------------------------------------------------------------------
-- 6. NOTHING ELSE MOVED -- 051's invariants, re-checked
-- ---------------------------------------------------------------------------

  union all
  select 601,
    case when (select count(*) from (values
                 ('public.is_family_contributor_member()'),
                 ('public.save_christmas_recipient(uuid, uuid, text, integer)'),
                 ('public.save_recipient_contributions(uuid, jsonb)')) as t(sig)
               where to_regprocedure(t.sig) is not null) = 0
         then 'PASS' else 'FAIL' end,
    '051''s three dropped routines are still gone',
    (select coalesce(string_agg(t.sig, ', ' order by t.sig), '(all still absent)') from (values
       ('public.is_family_contributor_member()'),
       ('public.save_christmas_recipient(uuid, uuid, text, integer)'),
       ('public.save_recipient_contributions(uuid, jsonb)')) as t(sig)
     where to_regprocedure(t.sig) is not null)

  union all
  select 602,
    case when (select coalesce(string_agg(a.privilege_type, ',' order by a.privilege_type), '')
               from pg_class c cross join lateral aclexplode(c.relacl) a
               where c.oid = 'public.areas'::regclass and a.grantee = 'authenticated'::regrole)
              = 'SELECT'
         then 'PASS' else 'FAIL' end,
    '051''s narrowing of `areas` still holds (authenticated = {SELECT})',
    coalesce((select string_agg(a.privilege_type, ',' order by a.privilege_type)
              from pg_class c cross join lateral aclexplode(c.relacl) a
              where c.oid = 'public.areas'::regclass and a.grantee = 'authenticated'::regrole), 'nothing')

  union all
  select 603,
    case when (select coalesce(string_agg(a.privilege_type, ',' order by a.privilege_type), '')
               from pg_class c cross join lateral aclexplode(c.relacl) a
               where c.oid = 'public.birthday_wishlist_ideas'::regclass
                 and a.grantee = 'authenticated'::regrole)
              = 'DELETE,INSERT,SELECT,UPDATE'
         then 'PASS' else 'FAIL' end,
    '051''s narrowing of `birthday_wishlist_ideas` still holds',
    coalesce((select string_agg(a.privilege_type, ',' order by a.privilege_type)
              from pg_class c cross join lateral aclexplode(c.relacl) a
              where c.oid = 'public.birthday_wishlist_ideas'::regclass
                and a.grantee = 'authenticated'::regrole), 'nothing')

  union all
  -- 048's three internal helpers were not handed back by anything above.
  select 604,
    case when (select count(*) from (values
                 ('public.area_of_record(text, uuid)'),
                 ('public.area_of_written_row(text, jsonb)'),
                 ('public.audit_actor_name()')) as t(sig)
               where has_function_privilege('anon', t.sig, 'execute')
                  or has_function_privilege('authenticated', t.sig, 'execute')) = 0
         then 'PASS' else 'FAIL' end,
    '048''s three internal helpers are still closed to both browser roles',
    (select coalesce(string_agg(t.sig, ', ' order by t.sig), '(all still closed)') from (values
       ('public.area_of_record(text, uuid)'),
       ('public.area_of_written_row(text, jsonb)'),
       ('public.audit_actor_name()')) as t(sig)
     where has_function_privilege('anon', t.sig, 'execute')
        or has_function_privilege('authenticated', t.sig, 'execute'))

  union all
  select 605,
    case when not exists (
           select 1 from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity)
         then 'PASS' else 'FAIL' end,
    'every table in public still has row level security on',
    coalesce((select string_agg(c.relname, ', ' order by c.relname)
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
             'none unguarded -- correct')

-- ---------------------------------------------------------------------------
-- 7. THE PROTECTED FAMILY, UNCHANGED
-- ---------------------------------------------------------------------------

  union all
  select 701,
    case when (select count(*) from public.areas) > 0
          and (select count(*) from public.people) > 0
          and (select count(*) from public.app_members) > 0
         then 'PASS' else 'FAIL' end,
    '052 destroyed nothing -- the family is still there',
    format('%s areas, %s people, %s memberships, %s events',
      (select count(*) from public.areas), (select count(*) from public.people),
      (select count(*) from public.app_members), (select count(*) from public.events))

  union all
  -- CROSS-AREA INTEGRITY, which must be zero and has been through every phase.
  select 702,
    case when (select count(*) from public.app_members m
               join public.people p on p.id = m.person_id
               where m.area_id <> p.area_id) = 0
         then 'PASS' else 'FAIL' end,
    'no membership points at a person in another family',
    (select count(*)::text from public.app_members m
     join public.people p on p.id = m.person_id where m.area_id <> p.area_id)

  union all
  select 703, 'INFO',
    'accounts by status',
    coalesce((select string_agg(status || '=' || n::text, ', ' order by status)
              from (select status, count(*) as n from public.app_accounts group by status) s), 'no rows')

  union all
  select 704, 'INFO',
    'auth users with no app_accounts row (undecided, and therefore refused)',
    (select count(*)::text from auth.users u
     where not exists (select 1 from public.app_accounts a where a.user_id = u.id))

  union all
  select 705, 'INFO',
    'global account audit entries so far',
    (select count(*)::text from public.audit_log where table_name = 'app_accounts')

  union all
  select 706,
    case when (select count(*) from public.audit_log
               where table_name = 'app_accounts' and area_id is not null) = 0
         then 'PASS' else 'FAIL' end,
    'NOT ONE global audit entry carries a family Area',
    (select count(*)::text from public.audit_log
     where table_name = 'app_accounts' and area_id is not null)
    || ' global entries are stamped with a family'
),

summary as (
  select
    count(*) filter (where status = 'PASS')   as passed,
    count(*) filter (where status = 'FAIL')   as failed,
    count(*) filter (where status = 'REVIEW') as to_review,
    count(*) filter (where status = 'INFO')   as facts
  from checks
)

select status, check_name, detail from (
  select 0 as ord,
    case when failed > 0 then 'FAIL' when to_review > 0 then 'REVIEW' else 'PASS' end as status,
    case when failed > 0 then 'MIGRATION 052 HAS A PROBLEM -- read the FAIL rows below'
         when to_review > 0 then 'Migration 052 applied; some rows need a person to look'
         else 'Migration 052 is fully in place' end as check_name,
    format('%s passed, %s failed, %s to review, %s facts recorded', passed, failed, to_review, facts) as detail
  from summary
  union all
  select ord, status, check_name, detail from checks
) as everything
order by
  -- The summary is always the first row, whatever verdict it carries; after it,
  -- FAIL sorts to the top, then REVIEW.
  (ord <> 0),
  case status when 'FAIL' then 0 when 'REVIEW' then 1 when 'PASS' then 2 else 3 end,
  ord;
