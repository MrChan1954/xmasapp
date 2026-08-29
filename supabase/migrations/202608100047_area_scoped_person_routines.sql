-- The four person routines that authorised in one family and wrote in another.
--
-- THE SHAPE, WHICH IS 045'S EXACTLY
--
--   Migration 044 hardened `set_family_contributor`, `set_person_name` and
--   `set_person_archived` by deriving the Area FROM THE PERSON and asking
--   `is_area_admin(target_area)`. That is the right question about permission
--   and the wrong question about place:
--
--       "Am I an administrator of this person's family?"   -> of Alpha, yes.
--       "...and is Alpha the family I am STANDING IN?"     -> never asked.
--
--   Migration 045 closed exactly this gap for sixteen routines with
--   `require_acting_area()`. It did not revisit these, because 044 had already
--   made them Area-aware -- and Area-aware is not the same as acting-Area-aware.
--   `set_person_birthday` (026, refined by 039) has the same shape for the same
--   reason.
--
-- MEASURED, NOT ASSUMED
--
--   Against a real PostgreSQL carrying 001-046, the fixture account that
--   administers Alpha and merely belongs to Bravo was pointed at an ALPHA
--   person while ACTING IN BRAVO. All four succeeded:
--
--       set_family_contributor   *** ALLOWED ***
--       set_person_name          *** ALLOWED ***
--       set_person_archived      *** ALLOWED ***
--       set_person_birthday      *** ALLOWED ***   (smallint signature)
--
--   The Alpha person came back renamed, made a contributor, archived, and with
--   a new birthday month -- every one of them written from a family the caller
--   was not in. Not privilege escalation: that account really does administer
--   Alpha. A violation of the rule that the selected Area is authoritative,
--   which is what the whole application is built on.
--
-- WHAT WAS CHECKED AND DELIBERATELY LEFT ALONE
--
--   Every SECURITY DEFINER routine that writes was classified. Of the
--   seventeen without `require_acting_area`, four are the ones above. The rest
--   are safe as they stand, and adding the guard would be wrong:
--
--     start_birthday_planning   already refuses a cross-Area celebrant in its
--                               own words. Probed; refused.
--     create_area / create_person / create_event
--                               creators. There is no existing object to
--                               target, and `is_app_admin()` has answered about
--                               the ACTING Area since 038. Probed; refused.
--     claim_app_member          takes no arguments and matches only the
--                               caller's own email on an unclaimed row. Adding
--                               the guard would BREAK claiming an invitation to
--                               a family you are not yet standing in.
--     record_audit_event, record_birthday_audit_event,
--     enqueue_notification_event, claim_birthday_reminder,
--     claim_birthday_budget_summary
--                               triggers and background jobs; not executable by
--                               `authenticated`.
--     save_purchase, save_christmas_recipient, save_recipient_contributions
--                               inner routines, not executable by
--                               `authenticated`, reached only through wrappers
--                               that 045 already guards.
--
-- WHAT THIS MIGRATION CHANGES
--
--   One condition per routine. The bodies below are the live definitions, taken
--   from `pg_get_functiondef` on a database carrying 001-046 and reproduced
--   verbatim -- same signatures, same role checks, same validation, same error
--   codes and wording, same return shapes, same `security definer` and pinned
--   `search_path`. The only addition is `is_acting_area(target_area)`, and the
--   Area is derived from the person, never from anything the caller passed.
--
--   Once that holds, every `is_area_admin(target_area)` beside it is ALREADY a
--   question about the acting Area, because the two are now the same Area.
--
-- WHY NOT `require_acting_area()`, WHICH IS WHAT 045 USED
--
--   Because it speaks. It raises "That belongs to another family. Switch to
--   that family first." -- exactly right when the thing you named is a family's
--   event, and wrong here, because these routines take a PERSON id and have
--   always been careful to give ONE refusal for "no such person" and for "not
--   your family". A separate sentence for the second case turns any uuid into a
--   question you can ask about other families: is there somebody here?
--
--   The first draft of this migration did use `require_acting_area()` above the
--   role check, and `tenancy-runtime`'s existing test -- "a person id that names
--   nobody is refused exactly like one from another family" -- failed on the
--   spot. So the check is folded into the condition that was already there,
--   using the boolean form 046 added for the same reason: a policy, and now
--   this, needs a predicate rather than an exception. All four failure modes --
--   no such person, another family, not standing there, not entitled -- come
--   back as the one sentence the routine has always given.
--
-- APPEND-ONLY. Nothing in 001-046 is edited. No grants change: these four are
-- already `execute` to `authenticated` and stay that way.

-- ---------------------------------------------------------------------------
-- set_family_contributor  ->  public.area_of_person(p_person_id)
-- ---------------------------------------------------------------------------

create or replace function public.set_family_contributor(p_person_id uuid, p_eligible boolean)
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

  -- MIGRATION 047: and that Area must be the one the caller is STANDING IN.
  -- Folded into the same condition rather than raised above it, so the refusal
  -- stays a single sentence -- see the header.
  if target_area is null
     or not public.is_acting_area(target_area)
     or not public.is_area_admin(target_area) then
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

-- ---------------------------------------------------------------------------
-- set_person_name  ->  public.area_of_person(p_person_id)
-- ---------------------------------------------------------------------------

create or replace function public.set_person_name(p_person_id uuid, p_name text)
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

  -- MIGRATION 047: and standing in it. Same condition, same one sentence out.
  if target_area is null
     or not public.is_acting_area(target_area)
     or not public.is_area_admin(target_area) then
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

-- ---------------------------------------------------------------------------
-- set_person_archived  ->  public.area_of_person(p_person_id)
-- ---------------------------------------------------------------------------

create or replace function public.set_person_archived(p_person_id uuid, p_archived boolean)
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

  -- MIGRATION 047: and standing in it. Same condition, same one sentence out.
  if target_area is null
     or not public.is_acting_area(target_area)
     or not public.is_area_admin(target_area) then
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

-- ---------------------------------------------------------------------------
-- set_person_birthday  ->  public.area_of_person(p_person_id)
--
-- The one with two write paths -- clearing a birthday and setting one -- and
-- the one whose authorisation is wider: a contributor MEMBER may edit a
-- birthday, not only an administrator. Both facts are preserved exactly; the
-- guard sits above them, so neither role can now reach across families.
-- ---------------------------------------------------------------------------

create or replace function public.set_person_birthday(p_person_id uuid, p_month smallint, p_day smallint, p_year smallint)
returns public.people
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_person public.people;
  max_day integer;
  target_area uuid;
begin
  -- THE AREA COMES FROM THE PERSON BEING EDITED, never from the request. There
  -- is no header, cookie or acting-Area note in this decision: whoever this
  -- person is, they are in exactly one Area, and the caller is either entitled
  -- there or is not.
  target_area := public.area_of_person(p_person_id);

  -- MIGRATION 047: entitled there, AND standing there. The comment above was
  -- true about permission and silent about place, which is the whole defect.
  -- Folded into the condition, so an id that names nobody and an id that names
  -- somebody else's family still come back as the same sentence.
  if target_area is null
    or not public.is_acting_area(target_area)
    or not (
      public.is_area_admin(target_area)
      or public.is_area_contributor_member(target_area)
    ) then
    raise exception 'Only this Area''s administrator or one of its contributors can change a birthday'
      using errcode = '42501';
  end if;

  -- Clearing a birthday means clearing all of it.
  if p_month is null or p_day is null then
    if p_month is not null or p_day is not null then
      raise exception 'Enter both a month and a day, or neither' using errcode = '23514';
    end if;
    update public.people
    set birthday_month = null, birthday_day = null, birthday_year = null, updated_at = now()
    where id = p_person_id
    returning * into saved_person;
    if not found then
      raise exception 'That family member could not be found' using errcode = 'P0002';
    end if;
    return saved_person;
  end if;

  if p_month not between 1 and 12 then
    raise exception 'Choose a month between January and December' using errcode = '23514';
  end if;

  -- 29 February is a real birthday. The year is not consulted here: which day a
  -- non-leap year observes it on is decided by `birthday_occurrence_date`.
  max_day := case p_month
    when 2 then 29
    when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30
    else 31
  end;
  if p_day < 1 or p_day > max_day then
    raise exception 'That day does not exist in that month' using errcode = '23514';
  end if;

  if p_year is not null and p_year not between 1900 and 2200 then
    raise exception 'Enter a realistic year of birth, or leave it blank' using errcode = '23514';
  end if;

  update public.people
  set birthday_month = p_month, birthday_day = p_day, birthday_year = p_year, updated_at = now()
  where id = p_person_id
  returning * into saved_person;

  if not found then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  return saved_person;
end;
$$;

comment on function public.set_family_contributor(uuid, boolean) is
  'Set whether a person may be asked to share the cost of a gift. The Area comes from the person, must be the Area the caller is standing in (047), and the caller must administer it.';
comment on function public.set_person_name(uuid, text) is
  'Rename a person. The Area comes from the person, must be the Area the caller is standing in (047), and the caller must administer it.';
comment on function public.set_person_archived(uuid, boolean) is
  'Archive or restore a person. The Area comes from the person, must be the Area the caller is standing in (047), and the caller must administer it.';
comment on function public.set_person_birthday(uuid, smallint, smallint, smallint) is
  'Set or clear a person''s birthday. The Area comes from the person, must be the Area the caller is standing in (047), and the caller must administer it or be one of its contributors.';
