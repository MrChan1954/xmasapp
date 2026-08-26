-- Two person routines that never learned about Areas, and one that never existed.
--
-- THE HOLE, EXACTLY, AND IT IS NOT THEORETICAL
--
--   `set_family_contributor` (030) and `set_person_archived` (032) were written
--   when there was one family. Each asks `is_app_admin()` and then writes:
--
--       update public.people ... where id = p_person_id
--
--   Migration 038 taught `is_app_admin()` to answer about the Area the caller
--   SAID they are acting in. It could not teach these two which Area they are
--   WRITING to, because they never ask. So the question being answered and the
--   row being changed came apart:
--
--       "Am I an administrator?"      -> of Alpha, yes.
--       "...of the family I am about  -> never asked.
--        to change?"
--
--   Migration 037's write barrier is not a second line of defence here. It
--   refuses a writer who is not a MEMBER of the row's Area -- which is exactly
--   right for a stranger, and no help at all against somebody who belongs to
--   both. An administrator of Alpha who is an ordinary member of Bravo passes
--   the barrier, passes `is_app_admin()` while acting in Alpha, and edits
--   Bravo.
--
--   PROVEN, not inferred. Against a real PostgreSQL with 001-043 applied, the
--   fixture account that administers Alpha and merely belongs to Bravo flipped
--   a Bravo person's contributor flag and archived a Bravo person, from Alpha.
--   `set_person_birthday` refused the same reach, because migration 039 had
--   already given it the fix this file gives the other two.
--
-- THE FIX IS 039'S, APPLIED TO ITS TWO SIBLINGS
--
--   Resolve the Area FROM THE PERSON BEING CHANGED, then ask whether the caller
--   administers THAT Area. The target decides the question; the request never
--   does. There is no header, cookie or acting-Area note in the decision.
--
-- AND A NAME CAN FINALLY BE CORRECTED
--
--   `set_person_name` is new. Migration 011 revoked update on `people` from
--   `authenticated` and no routine ever replaced it for the name column, so a
--   misspelled person was misspelled for good -- correctable only by an
--   administrator with database access. It is written Area-aware from its first
--   line, with the same validation `create_person` already applies, so the two
--   ways a name can enter the database cannot disagree.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits NO row of any kind. Three function bodies.
--   * It changes no policy, no grant, no trigger, no constraint and no column.
--   * It does not widen anything: every routine here refuses strictly more than
--     it did before. An administrator acting in their own family sees no
--     change whatsoever.
--   * It touches Christmas 2026, its recipients, purchases, allocations,
--     settlements and receipts in no way at all.
--
-- WHAT IT DELIBERATELY LEAVES ALONE
--   The same "asks about the acting Area, writes by bare id" shape exists in
--   twelve further routines that belong to events, recipients, purchases and
--   settlements. They are NOT touched here: this migration is the People half,
--   and rewriting payment and event routines in the same breath would put
--   money-handling code in a change nobody asked to review. They are recorded
--   in the Q3 report so the decision is made deliberately rather than by
--   omission.
--
-- MIGRATIONS 001-043 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regproc('public.area_of_person') is null then
    raise exception 'Migration 035 has not been applied: area_of_person is missing.';
  end if;
  if to_regproc('public.is_area_admin') is null then
    raise exception 'Migration 034 has not been applied: is_area_admin is missing.';
  end if;
  if to_regprocedure('public.set_family_contributor(uuid, boolean)') is null then
    raise exception 'Migration 030 has not been applied.';
  end if;
  if to_regprocedure('public.set_person_archived(uuid, boolean)') is null then
    raise exception 'Migration 032 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Who may contribute -- asked of the right family
--
-- UNCHANGED IN EVERY OTHER RESPECT. It still writes one boolean. It still
-- rewrites no plan, no allocation and no payment: eligibility for what comes
-- NEXT is a different fact from what has already happened, which is what
-- migration 030 decided and this file does not revisit.
-- ---------------------------------------------------------------------------

create or replace function public.set_family_contributor(
  p_person_id uuid,
  p_eligible boolean
)
returns public.people
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_person public.people;
  target_area uuid;
begin
  -- THE AREA COMES FROM THE PERSON, never from the request.
  target_area := public.area_of_person(p_person_id);

  if target_area is null or not public.is_area_admin(target_area) then
    -- One refusal for "no such person" and for "not your family", so the
    -- message cannot be used to discover who exists elsewhere.
    raise exception 'Only this family''s administrator can change who contributes'
      using errcode = '42501';
  end if;

  if p_eligible is null then
    raise exception 'Choose whether this person may contribute' using errcode = '23514';
  end if;

  update public.people
  set is_family_contributor = p_eligible, updated_at = now()
  where id = p_person_id
    -- Belt as well as braces: the Area was just checked, and the write says so.
    and area_id = target_area
  returning * into saved_person;

  if not found then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  return saved_person;
end;
$$;

revoke all on function public.set_family_contributor(uuid, boolean) from public, anon;
grant execute on function public.set_family_contributor(uuid, boolean) to authenticated;

comment on function public.set_family_contributor(uuid, boolean) is
  'Add or remove a person from THEIR OWN Area''s contributor pool. Eligibility for future assignments only: it rewrites no plan, allocation or payment, and grants no account access.';

-- ---------------------------------------------------------------------------
-- 2. Archiving somebody -- in the family they are actually in
--
-- Still deliberately SHALLOW: one timestamp. It does not end their event
-- recipiencies, touch their contributor rows, settle their balances or clear
-- their birthday. Archiving is about what they are offered for NEXT time.
-- ---------------------------------------------------------------------------

create or replace function public.set_person_archived(
  p_person_id uuid,
  p_archived boolean
)
returns public.people
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_person public.people;
  target_area uuid;
begin
  target_area := public.area_of_person(p_person_id);

  if target_area is null or not public.is_area_admin(target_area) then
    raise exception 'Only this family''s administrator can archive one of its people'
      using errcode = '42501';
  end if;

  if p_archived is null then
    raise exception 'Choose whether to archive or restore this person' using errcode = '23514';
  end if;

  update public.people
  set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
      updated_at = now()
  where id = p_person_id
    and area_id = target_area
  returning * into saved_person;

  if not found then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  return saved_person;
end;
$$;

revoke all on function public.set_person_archived(uuid, boolean) from public, anon;
grant execute on function public.set_person_archived(uuid, boolean) to authenticated;

comment on function public.set_person_archived(uuid, boolean) is
  'Archive or restore a person in THEIR OWN Area. Presentation only: it rewrites no purchase, allocation, payment, birthday or event relationship, and the person keeps their id and their whole history.';

-- ---------------------------------------------------------------------------
-- 3. Correcting a name
--
-- WHY THIS NEEDS A FUNCTION AT ALL. Migration 011 revoked update on `people`
-- from `authenticated`, so there is no browser-side write to attach a rename
-- to, and nothing has replaced it since. A person entered as "Jaden" when they
-- are "Jade" stayed that way in every screen, every event and every history.
--
-- A NAME IS NOT A MOVE. It changes one column. It cannot change the Area, the
-- birthday, contributor eligibility, archived state or any membership, and
-- there is no argument here through which it could.
-- ---------------------------------------------------------------------------

create or replace function public.set_person_name(
  p_person_id uuid,
  p_name text
)
returns public.people
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_person public.people;
  target_area uuid;
  clean_name text;
begin
  target_area := public.area_of_person(p_person_id);

  if target_area is null or not public.is_area_admin(target_area) then
    raise exception 'Only this family''s administrator can rename one of its people'
      using errcode = '42501';
  end if;

  -- The same rule `create_person` applies, so a name cannot be valid on the way
  -- in and invalid on the way past, and `people_name_safe_check` is never the
  -- thing a person meets first.
  clean_name := nullif(trim(coalesce(p_name, '')), '');
  if clean_name is null or length(clean_name) > 100 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid name' using errcode = '23514';
  end if;

  update public.people
  set name = clean_name, updated_at = now()
  where id = p_person_id
    and area_id = target_area
  returning * into saved_person;

  if not found then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  return saved_person;
end;
$$;

revoke all on function public.set_person_name(uuid, text) from public, anon;
grant execute on function public.set_person_name(uuid, text) to authenticated;

comment on function public.set_person_name(uuid, text) is
  'Correct the name of a person in THEIR OWN Area. Changes one column: never the Area, the birthday, contributor eligibility, archived state or any membership.';

-- ---------------------------------------------------------------------------
-- 4. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
  offender record;
begin
  foreach fn in array array[
    'public.set_family_contributor(uuid, boolean)',
    'public.set_person_archived(uuid, boolean)',
    'public.set_person_name(uuid, text)'
  ] loop
    if to_regprocedure(fn) is null then
      problems := problems || format('%s is missing', fn)::text;
    end if;
  end loop;

  -- Each one must now resolve the Area from its target and check it. Asserted
  -- by text because proving it by behaviour needs a login that administers one
  -- Area and merely belongs to another, and this block creates none.
  for offender in
    select proname from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('set_family_contributor', 'set_person_archived', 'set_person_name')
      and (prosrc not like '%area_of_person%' or prosrc not like '%is_area_admin%')
  loop
    problems := problems || format('%s does not resolve and check its target Area', offender.proname)::text;
  end loop;

  -- And none of them may still be asking the acting-Area question instead.
  for offender in
    select proname from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('set_family_contributor', 'set_person_archived', 'set_person_name')
      and prosrc like '%is_app_admin()%'
  loop
    problems := problems || format('%s still asks is_app_admin(), which answers about the wrong Area', offender.proname)::text;
  end loop;

  if not has_function_privilege('authenticated', 'public.set_person_name(uuid, text)', 'execute') then
    problems := problems || 'authenticated cannot rename a person'::text;
  end if;
  if has_function_privilege('anon', 'public.set_person_name(uuid, text)', 'execute') then
    problems := problems || 'anon can rename a person'::text;
  end if;

  -- Nothing here may have disturbed a guard from 035 or 037.
  if to_regproc('public.refuse_foreign_area_write') is null
    or to_regproc('public.refuse_cross_area_person') is null then
    problems := problems || 'a guard from 035 or 037 has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 044 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Person administration now asks about the family the person is actually in.';
end;
$$;
