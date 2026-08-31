-- =============================================================================
-- MIGRATION 052 -- THE AUTH CENSUS, TO BE READ BEFORE APPLYING ANYTHING
-- =============================================================================
--
-- WHAT THIS ANSWERS
--
--   Migration 052's backfill approves exactly one population automatically:
--   accounts that already hold an ACTIVE, CLAIMED membership AND have a
--   CONFIRMED email address. Everybody else is left undecided, to be reviewed
--   by a person.
--
--   This file tells you, before you apply anything, who is in each group. Run
--   it, read it, and decide. Applying 052 without having read this is applying
--   an access-control change to a population you have not looked at.
--
--   IT ONLY READS. One statement -- a WITH clause and a SELECT. There is no
--   insert, update, delete or DDL anywhere in it, and it creates nothing.
--   Running it twice changes nothing.
--
-- HOW TO RUN IT
--   Supabase SQL Editor, paste the WHOLE file, press Run. One table comes back.
--
-- HOW TO READ IT
--
--   The first rows are the HEADLINE COUNTS. Then the individual accounts,
--   grouped:
--
--     A -- AUTOMATIC        active claimed membership + confirmed email.
--                           052 approves these. Nothing to decide.
--
--     B -- STOP AND REVIEW  active claimed membership, email NEVER CONFIRMED.
--                           These are the ones that matter. An unconfirmed
--                           address is an address nobody has proved they own,
--                           so the membership may belong to somebody who typed
--                           it into a sign-up form. 052 deliberately does NOT
--                           approve them.
--
--                           IF THIS COUNT IS NOT ZERO, DO NOT APPLY 052 UNTIL
--                           YOU HAVE DECIDED WHAT EACH ONE IS. Each will lose
--                           access at the moment 052 applies.
--
--     C -- MANUAL REVIEW    no active claimed membership at all. Either they
--                           never had one, or theirs was switched off. They
--                           lose nothing (they already had nothing), but they
--                           will need approving by hand if they should be let
--                           back in.
--
--     I -- INVITATIONS      seats waiting to be claimed. Unaffected by 052,
--                           listed because after it applies, whoever claims one
--                           still has to be approved separately.
--
--   The three account categories are mutually exclusive and cover every row in
--   `auth.users`. The headline counts assert that themselves.
--
-- WHAT IT DELIBERATELY DOES NOT SHOW
--
--   No gift, no amount, no budget, no birthday, no purchase, no person's name.
--   The Area name appears only against an unclaimed invitation, because an
--   invitation is meaningless without knowing which family it is for.
--
--   Email addresses ARE shown, because the whole decision is "should this
--   address be allowed in", and it cannot be made without them.
--
-- THE BOOTSTRAP
--
--   Migration 052 finishes with ZERO Gift Planner administrators, by design.
--   Pick the first one from category A below and follow the operator statement
--   in `docs/Q19-PUBLIC-SIGNUP-APPROVAL.md`. Do not choose from B or C.
-- =============================================================================

with

-- How many ACTIVE, CLAIMED memberships each login holds. This is the whole
-- basis of the categorisation, computed once.
claimed as (
  select
    u.id,
    u.email,
    u.created_at,
    u.last_sign_in_at,
    u.email_confirmed_at,
    (select count(*) from public.app_members m
     where m.user_id = u.id and m.active = true) as active_memberships,
    (select count(*) from public.app_members m
     where m.user_id = u.id) as memberships_of_any_kind
  from auth.users u
),

categorised as (
  select
    c.*,
    case
      when c.active_memberships > 0 and c.email_confirmed_at is not null then 'A'
      when c.active_memberships > 0                                     then 'B'
      else                                                                   'C'
    end as category
  from claimed c
),

invitations as (
  select a.name as area_name, m.email, m.active, m.role, m.created_at
  from public.app_members m
  join public.areas a on a.id = m.area_id
  where m.user_id is null
),

report as (

-- ---------------------------------------------------------------------------
-- HEADLINE
-- ---------------------------------------------------------------------------

  select 100 as ord, 'HEADLINE' as section, 'total accounts in auth.users' as item,
    (select count(*)::text from categorised) as detail

  union all
  select 101, 'HEADLINE', 'A -- automatic approval (active claimed + confirmed)',
    (select count(*)::text from categorised where category = 'A')

  union all
  select 102, 'HEADLINE', 'B -- STOP AND REVIEW (active claimed + UNCONFIRMED email)',
    (select count(*)::text from categorised where category = 'B')
    || case when (select count(*) from categorised where category = 'B') > 0
            then '  <-- DO NOT APPLY 052 UNTIL THESE ARE DECIDED' else '  (nothing to decide)' end

  union all
  select 103, 'HEADLINE', 'C -- manual review (no active claimed membership)',
    (select count(*)::text from categorised where category = 'C')

  union all
  select 104, 'HEADLINE', 'unclaimed invitations waiting to be claimed',
    (select count(*)::text from invitations)

  union all
  -- The categories partition auth.users. Asserted rather than described, so a
  -- reader does not have to add the three numbers up themselves.
  select 105, 'HEADLINE', 'the three categories cover every account exactly once',
    case when (select count(*) from categorised)
            = (select count(*) from categorised where category = 'A')
            + (select count(*) from categorised where category = 'B')
            + (select count(*) from categorised where category = 'C')
         then 'yes -- A + B + C = total' else 'NO -- the categorisation is broken, do not rely on it' end

  union all
  select 106, 'HEADLINE', 'accounts 052 will approve automatically',
    (select count(*)::text from categorised where category = 'A')
    || ' of ' || (select count(*)::text from categorised)

-- ---------------------------------------------------------------------------
-- A -- the automatic approval set
-- ---------------------------------------------------------------------------

  union all
  select 200, 'A -- AUTOMATIC', 'these are approved by 052 with no decision needed', ''

  union all
  select 201, 'A -- AUTOMATIC',
    c.id::text || '  ' || coalesce(c.email, '(no address)'),
    format('signed up %s | last signed in %s | confirmed %s | %s active membership(s)',
      to_char(c.created_at, 'YYYY-MM-DD'),
      coalesce(to_char(c.last_sign_in_at, 'YYYY-MM-DD'), 'never'),
      to_char(c.email_confirmed_at, 'YYYY-MM-DD'),
      c.active_memberships)
  from categorised c
  where c.category = 'A'

-- ---------------------------------------------------------------------------
-- B -- the one that blocks
-- ---------------------------------------------------------------------------

  union all
  select 300, 'B -- STOP AND REVIEW',
    case when (select count(*) from categorised where category = 'B') = 0
         then 'none -- nothing blocks the apply'
         else 'THESE HOLD A FAMILY MEMBERSHIP ON AN ADDRESS NOBODY HAS CONFIRMED' end, ''

  union all
  select 301, 'B -- STOP AND REVIEW',
    c.id::text || '  ' || coalesce(c.email, '(no address)'),
    format('signed up %s | last signed in %s | NEVER CONFIRMED | %s active membership(s) -- '
           || 'this account LOSES ACCESS when 052 applies',
      to_char(c.created_at, 'YYYY-MM-DD'),
      coalesce(to_char(c.last_sign_in_at, 'YYYY-MM-DD'), 'never'),
      c.active_memberships)
  from categorised c
  where c.category = 'B'

-- ---------------------------------------------------------------------------
-- C -- review by hand, but nothing is lost
-- ---------------------------------------------------------------------------

  union all
  select 400, 'C -- MANUAL REVIEW', 'no active claimed membership; they already had no access', ''

  union all
  select 401, 'C -- MANUAL REVIEW',
    c.id::text || '  ' || coalesce(c.email, '(no address)'),
    format('signed up %s | last signed in %s | email %s | reason: %s',
      to_char(c.created_at, 'YYYY-MM-DD'),
      coalesce(to_char(c.last_sign_in_at, 'YYYY-MM-DD'), 'never'),
      case when c.email_confirmed_at is not null then 'confirmed' else 'NOT confirmed' end,
      case when c.memberships_of_any_kind = 0 then 'no membership at all'
           else 'inactive membership only' end)
  from categorised c
  where c.category = 'C'

-- ---------------------------------------------------------------------------
-- I -- seats nobody has sat in
-- ---------------------------------------------------------------------------

  union all
  select 500, 'I -- INVITATIONS', 'seats waiting for a claim; 052 does not change these', ''

  union all
  select 501, 'I -- INVITATIONS',
    i.area_name || '  ->  ' || coalesce(i.email, '(no address)'),
    format('%s | issued %s | whoever claims this still needs approving separately',
      case when i.active then 'active' else 'INACTIVE -- not claimable' end,
      to_char(i.created_at, 'YYYY-MM-DD'))
  from invitations i
)

select section, item, detail
from report
order by ord,
  -- Within a group, oldest account first, so the list reads as a history.
  item;
