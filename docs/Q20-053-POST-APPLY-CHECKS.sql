-- =============================================================================
-- MIGRATION 053 -- READ-ONLY PRODUCTION CHECKS, AFTER APPLYING
-- =============================================================================
--
-- WHAT THIS IS
--   One SELECT. It reads the database's own catalogues and reports, line by
--   line, whether migration 053 is really in place: one column, one constraint,
--   one partial index, four routines added, four redefined, no policy changed,
--   no backfill performed, and -- the one that matters most -- the silent
--   auto-join actually gone.
--
--   IT ONLY READS. There is no insert, update, delete or DDL anywhere in this
--   file. Running it twice changes nothing.
--
-- HOW TO RUN IT
--   Open the Supabase SQL Editor, paste this WHOLE file in, and press Run.
--   You get one table back. Read the first column.
--
--   RUN IT AFTER 053, NOT BEFORE. Several checks read `app_members.declined_at`
--   directly, so on a database that has not had 053 this file does not report a
--   failure -- it stops with
--
--       ERROR: column "declined_at" does not exist
--
--   which is itself an unambiguous answer.
--
-- HOW TO READ THE RESULT
--   PASS     this check is fine.
--   FAIL     something is wrong. Send the whole table back before doing
--            anything else; `docs/Q20-053-ROLLBACK.sql` exists for this.
--   REVIEW   a person has to look. Not automatically wrong.
--   INFO     a fact for the record.
--
--   FAIL rows sort to the TOP, then REVIEW.
--
-- THE FOUR THAT MATTER MOST
--
--   `claim_app_member no longer contains an UPDATE` -- if this fails, signing
--   in still joins people to families without asking, and the migration has
--   achieved nothing.
--
--   `no invitee routine takes an email address or a user id` -- if this fails,
--   there is a routine that can be pointed at somebody else, and the whole
--   authorization model of 053 rests on there not being one.
--
--   `every new routine is SECURITY DEFINER with a pinned search_path` -- a
--   definer routine with a mutable search_path is the classic escalation shape.
--
--   `no unclaimed non-QA invitation is left stranded` -- REVIEW, not PASS/FAIL.
--   From the instant 053 applies, an outstanding invitation stops being
--   auto-claimable and starts requiring Accept. The count is reported so a
--   person can decide who needs telling. NO EMAIL ADDRESS IS SELECTED anywhere
--   in this file.
-- =============================================================================

with
-- What each browser role holds on the four new routines, from the catalogue.
routine_acl as (
  select p.proname,
         a.grantee::regrole::text as role_name,
         a.privilege_type
  from pg_proc p
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('list_my_family_invitations', 'accept_family_invitation',
                      'decline_family_invitation', 'record_invitation_delivery')
),
new_routines as (
  select p.proname, p.oid, p.prosecdef, p.proconfig,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_functiondef(p.oid) as body
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('list_my_family_invitations', 'accept_family_invitation',
                      'decline_family_invitation', 'record_invitation_delivery')
),
redefined as (
  select p.proname, pg_get_functiondef(p.oid) as body,
         pg_get_function_result(p.oid) as result
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('refuse_foreign_area_write', 'grant_area_access',
                      'list_area_access', 'claim_app_member')
)

select * from (

  -- 1. THE SCHEMA -------------------------------------------------------------

  select
    case when exists (
      select 1 from pg_attribute
      where attrelid = 'public.app_members'::regclass
        and attname = 'declined_at' and not attisdropped
    ) then 'PASS' else 'FAIL' end as result,
    'app_members.declined_at exists' as check_name,
    '' as detail

  union all
  select
    case when exists (
      select 1 from pg_constraint
      where conrelid = 'public.app_members'::regclass
        and conname = 'app_members_declined_is_unclaimed'
    ) then 'PASS' else 'FAIL' end,
    'the declined-is-unclaimed CHECK exists',
    coalesce((select pg_get_constraintdef(oid) from pg_constraint
              where conrelid = 'public.app_members'::regclass
                and conname = 'app_members_declined_is_unclaimed'), 'missing')

  union all
  select
    case when exists (
      select 1 from pg_indexes where schemaname = 'public'
        and indexname = 'app_members_open_invitation_idx'
    ) then 'PASS' else 'FAIL' end,
    'the partial open-invitation index exists',
    ''

  union all
  select
    case when (select count(*) from public.app_members
               where declined_at is not null
                 and (user_id is not null or active = true)) = 0
    then 'PASS' else 'FAIL' end,
    'no row is declined AND claimed or active',
    'the CHECK, verified against the rows rather than the catalogue'

  -- 2. THE FOUR NEW ROUTINES --------------------------------------------------

  union all
  select
    case when (select count(*) from new_routines) = 4 then 'PASS' else 'FAIL' end,
    'all four new routines exist',
    (select coalesce(string_agg(proname, ', ' order by proname), 'none') from new_routines)

  union all
  select
    case when not exists (
      select 1 from new_routines
      where not prosecdef
         or not ('search_path=""' = any(coalesce(proconfig, array[]::text[])))
    ) then 'PASS' else 'FAIL' end,
    'every new routine is SECURITY DEFINER with a pinned search_path',
    coalesce((select string_agg(proname || ' -> ' || coalesce(array_to_string(proconfig, ','), 'UNPINNED'), '; ')
              from new_routines where not prosecdef
                 or not ('search_path=""' = any(coalesce(proconfig, array[]::text[])))), 'all four correct')

  union all
  select
    case when not exists (
      select 1 from routine_acl where role_name in ('anon', 'PUBLIC')
    ) then 'PASS' else 'FAIL' end,
    'anon holds no privilege on any new routine',
    coalesce((select string_agg(proname || ':' || role_name || ':' || privilege_type, '; ')
              from routine_acl where role_name in ('anon', 'PUBLIC')), 'none, as designed')

  union all
  select
    case when (select count(*) from routine_acl
               where role_name = 'authenticated' and privilege_type = 'EXECUTE') = 4
    then 'PASS' else 'FAIL' end,
    'authenticated may execute all four',
    ''

  union all
  select
    case when not exists (
      select 1 from routine_acl where role_name = 'service_role'
    ) then 'PASS' else 'REVIEW' end,
    'no new routine was granted to service_role',
    'the delivery audit is written with the administrator''s own session'

  union all
  select
    case when not exists (
      select 1 from new_routines
      where proname <> 'record_invitation_delivery'
        and args not in ('', 'p_invitation_id uuid')
    ) then 'PASS' else 'FAIL' end,
    'no invitee routine takes an email address or a user id',
    (select coalesce(string_agg(proname || '(' || args || ')', '; ' order by proname), '')
     from new_routines)

  union all
  select
    case when (select count(*) from new_routines
               where proname in ('accept_family_invitation', 'decline_family_invitation')
                 and body like '%email_confirmed_at is not null%') = 2
    then 'PASS' else 'FAIL' end,
    'accept and decline both require a CONFIRMED auth email',
    ''

  union all
  select
    case when (select count(*) from new_routines
               where proname = 'accept_family_invitation'
                 and body like '%rejected%' and body like '%suspended%') = 1
    then 'PASS' else 'FAIL' end,
    'accept refuses rejected and suspended accounts',
    ''

  union all
  select
    case when (select count(*) from new_routines
               where proname = 'record_invitation_delivery'
                 and body like '%''ready''%' and body like '%''undelivered''%'
                 and body like '%require_acting_area%' and body like '%is_area_admin%') = 1
    then 'PASS' else 'FAIL' end,
    'the delivery routine has a closed vocabulary and admin-only authorization',
    ''

  -- 3. THE FOUR REDEFINITIONS -------------------------------------------------

  union all
  select
    case when not exists (
      select 1 from redefined where proname = 'claim_app_member'
        and lower(body) like '%update %'
    ) then 'PASS' else 'FAIL' end,
    'claim_app_member no longer contains an UPDATE',
    'THE ONE THAT MATTERS MOST -- signing in must join nobody'

  union all
  select
    case when (select count(*) from redefined
               where proname = 'refuse_foreign_area_write' and body like '%declined_at%') = 1
    then 'PASS' else 'FAIL' end,
    'the write barrier carries the decline exemption',
    ''

  union all
  select
    case when (select count(*) from redefined
               where proname = 'grant_area_access' and body like '%declined_at = null%') = 1
    then 'PASS' else 'FAIL' end,
    'grant_area_access clears declined_at on a reissue',
    ''

  union all
  select
    case when (select count(*) from redefined
               where proname = 'list_area_access' and result like '%declined_at%') = 1
    then 'PASS' else 'FAIL' end,
    'list_area_access returns declined_at',
    ''

  union all
  select
    case when (select count(*) from redefined
               where proname = 'list_area_access'
                 and body like '%when m.user_id is null then null%') = 1
    then 'PASS' else 'FAIL' end,
    'list_area_access still hides account status for an unclaimed seat',
    'the enumeration guarantee 052 shipped, unweakened by the new column'

  union all
  select
    case when (select count(*) from pg_proc
               where pronamespace = 'public'::regnamespace and proname = 'list_area_access') = 1
    then 'PASS' else 'FAIL' end,
    'list_area_access exists exactly once (the drop-and-recreate left no twin)',
    ''

  -- 4. WHAT MUST NOT HAVE CHANGED ---------------------------------------------

  union all
  select
    case when (select count(*) from pg_policies
               where schemaname = 'public' and tablename = 'app_members') = 2
    then 'PASS' else 'FAIL' end,
    'app_members still has exactly its two policies',
    (select coalesce(string_agg(policyname, '; ' order by policyname), 'none')
     from pg_policies where schemaname = 'public' and tablename = 'app_members')

  union all
  select
    case when exists (
      select 1 from pg_constraint
      where conrelid = 'public.audit_log'::regclass and conname = 'audit_log_action_check'
        and pg_get_constraintdef(oid) not like '%invitation%'
    ) then 'PASS' else 'FAIL' end,
    'audit_log_action_check was NOT widened by 053',
    ''

  union all
  select
    case when not exists (
      select 1 from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.prosecdef
        and not ('search_path=""' = any(coalesce(p.proconfig, array[]::text[])))
    ) then 'PASS' else 'FAIL' end,
    'NO SECURITY DEFINER routine anywhere has a mutable search_path',
    coalesce((select string_agg(proname, '; ') from pg_proc
              where pronamespace = 'public'::regnamespace and prosecdef
                and not ('search_path=""' = any(coalesce(proconfig, array[]::text[])))), 'none')

  union all
  select
    case when (select count(*) from public.app_members m
               join public.people p on p.id = m.person_id
               where p.area_id <> m.area_id) = 0
    then 'PASS' else 'FAIL' end,
    'cross-Area integrity is zero',
    'no seat names a person belonging to another family'

  -- 5. THE POPULATION, COUNTED, WITH NO ADDRESS READ --------------------------

  union all
  select 'INFO',
    'open invitations awaiting an answer',
    (select count(*)::text from public.app_members
     where user_id is null and active = true and declined_at is null)

  union all
  select
    case when (select count(*) from public.app_members
               where user_id is null and active = true and declined_at is null) = 0
    then 'PASS' else 'REVIEW' end,
    'no unclaimed non-QA invitation is left stranded',
    'from now on these require Accept. If any belongs to a real family, tell that '
    'person to accept it -- do NOT backfill. No address is selected by this file.'

  union all
  select 'INFO',
    'declined invitations',
    (select count(*)::text from public.app_members where declined_at is not null)

  union all
  select 'INFO',
    'invitation audit rows written since 053',
    (select count(*)::text from public.audit_log
     where table_name = 'app_members'
       and (summary like 'Joined %' or summary like 'Declined the invitation to %'
            or summary = 'Invitation delivery recorded'))

  union all
  select
    case when not exists (
      select 1 from public.audit_log
      where summary = 'Invitation delivery recorded'
        and (area_id is null or details::text like '%@%' or details::text like '%http%')
    ) then 'PASS' else 'FAIL' end,
    'every delivery audit row is Area-attributed and carries no address or link',
    ''

) checks
order by case result when 'FAIL' then 0 when 'REVIEW' then 1 when 'INFO' then 3 else 2 end,
         check_name;
