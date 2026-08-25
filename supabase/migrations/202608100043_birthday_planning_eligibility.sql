-- The administrator's own birthday, which nobody could plan.
--
-- THE DEAD END, EXACTLY
--   `start_birthday_planning` required `is_app_admin()`. Migration 031 refuses
--   anybody setting up their OWN birthday -- correctly: the surprise rule
--   outranks every permission, administrator included. Migration 035 allows one
--   administrator per Area.
--
--   Put those three together and the administrator's birthday has no possible
--   caller. They are refused because it is theirs; everybody else is refused
--   because they are not the administrator. It is not a permissions puzzle, it
--   is a birthday that cannot be organised.
--
-- THE FIX, AND WHAT IT IS NOT
--   Birthday planning follows CONTRIBUTOR truth as well as administration --
--   which is what migration 031 already decided for birthday DATES, saying that
--   keeping the calendar current is family admin rather than financial
--   administration. Paying for somebody's birthday is exactly what a contributor
--   does, so this is that decision applied to the same subject, not a new idea.
--
--   IT WEAKENS NO PRIVACY. The celebrant is still refused, by the same trigger
--   as before -- see section 2, which makes that trigger STRONGER. An
--   administrator still cannot see, plan or start their own birthday. What
--   changes is that somebody else now can.
--
--   IT WIDENS NOTHING ELSE. `start_birthday_planning` is the only routine that
--   is birthday-only; the shared ones are untouched, so Christmas is exactly as
--   administered as it was. Editing a recipient's budget afterwards already
--   needed no administrator -- migration 012 asks `is_app_admin()` only when
--   CREATING one -- so this single routine is the whole of the dead end.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits no row of any kind.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt,
--     and touches Christmas 2026 in no way at all.
--   * It gives the celebrant nothing. Section 2 takes something away from them.
--
-- MIGRATIONS 001-042 ARE APPLIED AND ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.leave_area(uuid)') is null then
    raise exception 'Migration 042 has not been applied.';
  end if;
  if to_regproc('public.is_area_contributor_member') is null then
    raise exception 'Migration 039 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Who may start a birthday
--
-- Migration 030's routine, extracted byte for byte, with its authorization
-- block replaced and one variable added. Every validation -- the name, the
-- date, the budget, the contribution total, the eligibility of each
-- contributor, the refusal to let somebody contribute to their own birthday --
-- is 030's and is unchanged.
--
-- Migration 030 is applied and is NOT edited. This supersedes it.
-- ---------------------------------------------------------------------------

create or replace function public.start_birthday_planning(
  p_celebrant_person_id uuid,
  p_name text,
  p_event_date date,
  p_budget_pennies integer,
  p_contributions jsonb
)
returns public.events
language plpgsql
security definer
set search_path = ''
as $$
declare
  celebrant_area uuid;
  current_member_id uuid;
  saved_event public.events;
  new_recipient_id uuid;
  clean_name text;
  planned_total integer;
  contribution jsonb;
  contributor_person_id uuid;
  contributor_pennies integer;
  new_contributor_id uuid;
begin
  -- THE ONE CHANGED BLOCK. Everything below it is migration 030's, extracted
  -- from that file byte for byte rather than retyped.
  --
  -- WHO MAY PLAN A BIRTHDAY: this family's administrator, or one of this
  -- family's contributors -- the same pair migration 031 chose for birthday
  -- DATES and migration 039 made Area-aware for them.
  --
  -- THE AREA COMES FROM THE CELEBRANT, never from the request. That closes the
  -- dead end (an Area's one administrator could not plan their own birthday, and
  -- nobody else was allowed to) without consulting a header, so the answer
  -- cannot change because a pre-request hook did or did not run.
  celebrant_area := public.area_of_person(p_celebrant_person_id);
  if celebrant_area is null
    or not (
      public.is_area_admin(celebrant_area)
      or public.is_area_contributor_member(celebrant_area)
    ) then
    -- One refusal for "no such person", "somebody else's family" and "not
    -- entitled here", so nobody can probe for people they cannot see.
    raise exception 'Only this family''s admin or one of its contributors can start birthday planning'
      using errcode = '42501';
  end if;

  current_member_id := public.current_member_in_area(celebrant_area);
  if current_member_id is null then
    raise exception 'An active membership is required' using errcode = '42501';
  end if;

  clean_name := nullif(trim(coalesce(p_name, '')), '');
  if clean_name is null or length(clean_name) > 100 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid name for this birthday' using errcode = '23514';
  end if;
  if p_event_date is null then
    raise exception 'Choose the date this birthday falls on' using errcode = '23514';
  end if;
  if p_budget_pennies is null or p_budget_pennies < 0 then
    raise exception 'Enter a budget of zero or more' using errcode = '23514';
  end if;
  if not exists (select 1 from public.people where id = p_celebrant_person_id) then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  -- The plan must add up to the budget, to the penny.
  select coalesce(sum((entry ->> 'pennies')::integer), 0)
  into planned_total
  from jsonb_array_elements(coalesce(p_contributions, '[]'::jsonb)) as entry;

  if planned_total <> p_budget_pennies then
    raise exception 'The contributions add up to % but the budget is %',
      planned_total, p_budget_pennies using errcode = '23514';
  end if;

  insert into public.events (
    name, event_type, event_date, description, celebrant_person_id,
    year, status, created_by_app_member_id
  ) values (
    clean_name, 'birthday', p_event_date, null, p_celebrant_person_id,
    null, 'active', current_member_id
  )
  returning * into saved_event;

  -- Contributors first: a recipient's plan has to name every active
  -- contributor, so they must exist before the recipient does.
  for contribution in
    select entry from jsonb_array_elements(coalesce(p_contributions, '[]'::jsonb)) as entry
  loop
    contributor_person_id := (contribution ->> 'person_id')::uuid;
    contributor_pennies := (contribution ->> 'pennies')::integer;

    if contributor_pennies is null or contributor_pennies < 0 then
      raise exception 'Every contribution must be zero or more' using errcode = '23514';
    end if;
    if contributor_person_id = p_celebrant_person_id then
      raise exception 'Somebody cannot contribute towards their own birthday' using errcode = '23514';
    end if;
    if not exists (select 1 from public.people where id = contributor_person_id) then
      raise exception 'A chosen contributor is not a family member' using errcode = 'P0002';
    end if;
    -- Eligibility is checked HERE, not only in the browser: a hand-made request
    -- cannot assign money to somebody the family has not made a contributor.
    if not exists (
      select 1 from public.people
      where id = contributor_person_id and is_family_contributor
    ) then
      raise exception 'That person is not one of the family''s contributors' using errcode = '42501';
    end if;

    insert into public.contributors (christmas_event_id, person_id, active)
    values (saved_event.id, contributor_person_id, true)
    on conflict (christmas_event_id, person_id) do nothing;
  end loop;

  -- The celebrant is the recipient. A birthday has exactly one.
  insert into public.christmas_recipients (christmas_event_id, person_id, budget_pennies, active)
  values (saved_event.id, p_celebrant_person_id, p_budget_pennies, true)
  returning id into new_recipient_id;

  -- Every active contributor gets a row, at their planned amount or at zero.
  -- Migration 012's invariant requires the full set, and the sum to equal the
  -- budget -- which the check above already guaranteed.
  insert into public.recipient_contributions (
    christmas_recipient_id, contributor_id, planned_amount_pennies
  )
  select
    new_recipient_id,
    contributor.id,
    coalesce((
      select (entry ->> 'pennies')::integer
      from jsonb_array_elements(coalesce(p_contributions, '[]'::jsonb)) as entry
      where (entry ->> 'person_id')::uuid = contributor.person_id
    ), 0)
  from public.contributors as contributor
  where contributor.christmas_event_id = saved_event.id
    and contributor.active = true;

  return saved_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. And the celebrant is refused harder than before
--
-- MIGRATION 031'S GUARD WAS AREA-BLIND, and section 1 would have made that
-- matter. It compares the celebrant against `current_person_id()`, which after
-- migration 038 answers about the Area the caller CLAIMED -- and returns null
-- for a login in two families that claimed nothing. Nobody could reach it that
-- way before, because `is_app_admin()` also returned false for such a login and
-- the authorization refused them first. Section 1 removes that accident: the
-- new check does not need a claimed Area, so the guard must not need one
-- either, or a two-family administrator could start their own birthday simply
-- by sending no header.
--
-- Resolving the reader inside the EVENT'S OWN Area is the same correction
-- migration 036 made to the four `is_own_birthday_*` predicates, for the same
-- reason. It is strictly stronger: it holds with a header, without one, and for
-- any number of memberships.
--
-- The trigger migration 031 attached is untouched and keeps firing; only what
-- it asks has changed.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_starting_own_birthday()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event_type = 'birthday'
    and new.celebrant_person_id is not null
    and new.celebrant_person_id = public.current_person_in_area(new.area_id)
  then
    raise exception 'You cannot set up the planning for your own birthday'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.refuse_starting_own_birthday() is
  'Refuses anybody starting the planning for their own birthday, resolved inside the event''s own Area so a login in two families cannot slip past by claiming neither.';

-- ---------------------------------------------------------------------------
-- 3. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
begin
  -- The dead end is closed: a contributor can start it.
  if not exists (
    select 1 from pg_proc
    where proname = 'start_birthday_planning' and pronamespace = 'public'::regnamespace
      and prosrc like '%is_area_contributor_member%'
      and prosrc like '%is_area_admin%'
      and prosrc like '%area_of_person%'
  ) then
    problems := problems || 'start_birthday_planning does not accept this Area''s contributors'::text;
  end if;

  -- And it does not depend on a claimed Area.
  if exists (
    select 1 from pg_proc
    where proname = 'start_birthday_planning' and pronamespace = 'public'::regnamespace
      and (prosrc like '%is_app_admin%' or prosrc like '%acting_area%'
           or prosrc like '%current_app_member_id%')
  ) then
    problems := problems || 'start_birthday_planning still resolves the caller from the request'::text;
  end if;

  -- Every validation migration 030 wrote is still there.
  if not exists (
    select 1 from pg_proc
    where proname = 'start_birthday_planning' and pronamespace = 'public'::regnamespace
      and prosrc like '%Somebody cannot contribute towards their own birthday%'
      and prosrc like '%is_family_contributor%'
      and prosrc like '%The contributions add up to%'
  ) then
    problems := problems || 'a validation from migration 030 has been lost'::text;
  end if;

  -- THE CELEBRANT IS STILL REFUSED, and now inside their own Area.
  if not exists (
    select 1 from pg_proc
    where proname = 'refuse_starting_own_birthday' and pronamespace = 'public'::regnamespace
      and prosrc like '%current_person_in_area(new.area_id)%'
  ) then
    problems := problems || 'the own-birthday guard does not resolve the reader inside the event''s Area'::text;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'events_refuse_own_birthday_setup' and not tgisinternal
      and tgrelid = 'public.events'::regclass
  ) then
    problems := problems || 'the own-birthday guard is no longer attached to events'::text;
  end if;

  -- And nothing about what the celebrant may READ has moved.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and policyname = 'active members read events'
      and qual not like '%is_own_birthday_event%'
  ) then
    problems := problems || 'the events policy no longer hides the reader''s own birthday'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 043 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'The administrator''s birthday can be planned -- by somebody else, and still never by them.';
end;
$$;
