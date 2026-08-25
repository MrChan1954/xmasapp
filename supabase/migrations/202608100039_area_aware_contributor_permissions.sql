-- Authorization that knows which Area it is answering about.
--
-- WHAT PHASE 5 LEFT BEHIND. Migrations 034-038 made every POLICY Area-aware and
-- put a barrier on every WRITE. What they did not do is revisit the handful of
-- authorization helpers that predate Areas and are still asked global
-- questions. Three of them matter, and all three are wrong in the same way:
-- they answer about the caller's memberships as a set, rather than about one
-- Area.
--
--   is_family_contributor_member()
--     "is this login a contributor?" -- true if ANY of their memberships links
--     to a contributor person in ANY Area. It is the authorization for
--     `set_person_birthday`, so a contributor in Alpha who is an ordinary
--     member of Bravo could edit BRAVO'S birthdays. That is not a lost
--     permission; it is a granted one, across a tenant boundary.
--
--   set_person_birthday()
--     Asks `is_app_admin()`, which after 038 answers about the Area the caller
--     SAID they were in -- while the person being edited may be in a different
--     one. The two halves of the check were never required to agree.
--
--   list_gift_ideas()
--     SECURITY DEFINER, so row level security does not apply to it, and it
--     asks only `is_active_app_member()`. Any active member of any Area could
--     read every gift idea for any recipient anywhere -- titles, prices, links,
--     notes and who suggested them. 036 scoped the TABLE and could not scope
--     this, because a definer routine is exactly what bypasses a policy.
--
-- THE SHAPE OF THE FIX, AND WHY IT IS NOT "SET THE ACTING AREA"
--   Every check below derives its Area FROM THE ROW IT IS ABOUT -- the person
--   being edited, the recipient being read -- and then asks whether the caller
--   is entitled IN THAT Area. None of them consults `acting_area()`.
--
--   That is deliberate. The acting Area is a request-scoped side effect set by
--   a PostgREST pre-request hook, and a privileged operation whose authorization
--   depends on a header having been honoured is a privileged operation that
--   fails open the day the hook stops running. Deriving the Area from the
--   subject cannot fail that way: there is no request in which the person being
--   edited belongs to a different Area than they belong to.
--
--   The hook remains, and remains useful -- fifty routines written before Areas
--   existed still ask `is_app_admin()` and still need an answer. It is simply no
--   longer what decides these three.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits no row of any kind. Every statement is a
--     function or a trigger.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt,
--     and touches Christmas 2026 in no way at all.
--   * It grants nobody anything they did not have. Every change here is a
--     refusal that was missing.
--   * It adds no wishlist. Own-birthday gift ideas are migration 040.
--
-- MIGRATIONS 001-038 ARE APPLIED AND ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regproc('public.claim_active_area') is null then
    raise exception 'Migration 038 has not been applied.';
  end if;
  if to_regproc('public.is_area_admin') is null or to_regproc('public.current_person_in_area') is null then
    raise exception 'Migration 034 has not been applied.';
  end if;
  if to_regproc('public.area_of_recipient') is null then
    raise exception 'Migration 036 has not been applied.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'people' and column_name = 'is_family_contributor'
  ) then
    raise exception 'Migration 030 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Is the caller a contributor OF ONE PARTICULAR AREA?
--
-- The Area-aware counterpart to migration 031's `is_family_contributor_member`,
-- in the same shape as 034's `is_area_member` and `is_area_admin`.
--
-- BOTH HALVES COME FROM THE SAME AREA. The membership is the caller's
-- membership IN THIS Area, and the person it is judged by is that membership's
-- own person -- not a person found by name, not a person from another Area, and
-- not whichever membership the planner reached first. A contributor in Alpha
-- gets false here for Bravo, which is the whole point of the file.
-- ---------------------------------------------------------------------------

create or replace function public.is_area_contributor_member(p_area_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_members m
    join public.people p on p.id = m.person_id
    where m.user_id = (select auth.uid())
      and m.active = true
      and m.area_id = p_area_id
      -- The person really is in the Area the membership claims. 035's guard
      -- makes this true for every row it has seen; asserting it here means a
      -- row that predates the guard cannot borrow a permission with it.
      and p.area_id = p_area_id
      and p.is_family_contributor
  );
$$;

revoke all on function public.is_area_contributor_member(uuid) from public, anon;
grant execute on function public.is_area_contributor_member(uuid) to authenticated;

comment on function public.is_area_contributor_member(uuid) is
  'Is the caller one of THIS Area''s contributors? Eligibility only, in one Area only. Being a contributor elsewhere is not an answer to this question.';

-- ---------------------------------------------------------------------------
-- 2. The global question, made safe rather than removed
--
-- `is_family_contributor_member()` keeps its name, its signature and its
-- meaning for anyone who belongs to one Area -- which is everyone today. What
-- changes is what it does with a login that belongs to two: it stops saying
-- "yes, somewhere" and starts refusing to answer, exactly as 036 did to
-- `is_app_admin()` and for the same reason.
--
-- It is redefined rather than dropped because it is granted to `authenticated`
-- and therefore reachable as an RPC. A function that has been callable cannot
-- be assumed to have no callers.
-- ---------------------------------------------------------------------------

create or replace function public.is_family_contributor_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    -- Said which Area they are acting in: answer about that one.
    when public.acting_area() is not null
      then public.is_area_contributor_member(public.acting_area())
    -- Said nothing: answer only when there is nothing to guess between.
    else exists (
      select 1
      from public.app_members m
      join public.people p on p.id = m.person_id
      where m.user_id = (select auth.uid())
        and m.active = true
        and p.is_family_contributor
        and (
          select count(*)
          from public.app_members m2
          where m2.user_id = (select auth.uid()) and m2.active = true
        ) = 1
    )
  end;
$$;

comment on function public.is_family_contributor_member() is
  'Is the caller a contributor of the Area they are acting in, or of the only Area they belong to? False for a login in two Areas that has not said which. Ask is_area_contributor_member about a particular one.';

-- ---------------------------------------------------------------------------
-- 3. A birthday date is maintained by THIS Area's admin or THIS Area's
--    contributors
--
-- The ONLY change is the authorization block. Every validation below it -- the
-- month range, the day-of-month range, the leap-day rule, the year bounds, the
-- clear-both-or-neither rule -- is migration 026's, carried through 031
-- unchanged, and reproduced here word for word because `create or replace
-- function` replaces a whole body and there is no way to amend one line of it.
--
-- Migrations 026 and 031 are applied and are NOT edited. This supersedes both.
--
-- WHY THE REFUSAL IS ONE MESSAGE FOR TWO CASES. A person id that names nobody
-- and a person id that names somebody in another Area get the same 42501. They
-- are different facts, and telling them apart would let anyone with a login
-- probe uuids to learn which ones are people in families they cannot see.
-- ---------------------------------------------------------------------------

create or replace function public.set_person_birthday(
  p_person_id uuid,
  p_month smallint,
  p_day smallint,
  p_year smallint
)
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

  if target_area is null
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

revoke all on function public.set_person_birthday(uuid, smallint, smallint, smallint)
  from public, anon;
grant execute on function public.set_person_birthday(uuid, smallint, smallint, smallint) to authenticated;

comment on function public.set_person_birthday(uuid, smallint, smallint, smallint) is
  'Record or clear a permanent birthday date. This Area''s administrator, or one of this Area''s contributors, resolved from the person being edited. Confers no other administrative right.';

-- ---------------------------------------------------------------------------
-- 4. Gift ideas are readable inside their own Area, by people who are not the
--    birthday person
--
-- `list_gift_ideas` exists because `app_members` is private and the browser
-- needs a suggester's NAME rather than a membership id. That is a good reason
-- for a definer routine and it is not being removed. What is being added is the
-- two checks the definer rights bypassed:
--
--   THE AREA. Derived from the recipient, and matched against the caller's
--   memberships. Nothing the caller passes decides it.
--
--   THE SURPRISE RULE. Row level security already refuses the celebrant these
--   rows; this routine ran beside that refusal rather than behind it.
--
-- THE CELEBRANT GETS NO ROWS, NOT AN ERROR. An error would confirm that a
-- recipient row for their birthday exists, which is itself something they are
-- not told anywhere else in the application.
--
-- Migration 040 narrows this again, to let the birthday person see the ideas
-- THEY submitted for themselves. Nothing here anticipates that: this is the
-- rule as it stands today, said in the one place it was not being said.
-- ---------------------------------------------------------------------------

create or replace function public.list_gift_ideas(
  p_christmas_recipient_id uuid
)
returns table (
  id uuid,
  christmas_recipient_id uuid,
  title text,
  estimated_price_pennies integer,
  retailer text,
  url text,
  notes text,
  suggested_by_name text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owning_area uuid;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required'
      using errcode = '42501';
  end if;

  owning_area := public.area_of_recipient(p_christmas_recipient_id);
  if owning_area is null or not public.is_area_member(owning_area) then
    raise exception 'Active app membership required'
      using errcode = '42501';
  end if;

  if public.is_own_birthday_recipient(p_christmas_recipient_id) then
    return;
  end if;

  return query
  select
    idea.id,
    idea.christmas_recipient_id,
    idea.title,
    idea.estimated_price_pennies,
    idea.retailer,
    idea.url,
    idea.notes,
    coalesce(person.name, 'Unknown member') as suggested_by_name,
    idea.created_at,
    idea.updated_at
  from public.gift_ideas as idea
  join public.app_members as member
    on member.id = idea.suggested_by_app_member_id
  left join public.people as person
    on person.id = member.person_id
  where idea.christmas_recipient_id = p_christmas_recipient_id
  order by idea.created_at desc;
end;
$$;

revoke all on function public.list_gift_ideas(uuid) from public, anon;
grant execute on function public.list_gift_ideas(uuid) to authenticated;

comment on function public.list_gift_ideas(uuid) is
  'Gift ideas for one recipient, with suggester names. Refuses a recipient outside the caller''s Areas, and returns nothing for the caller''s own birthday.';

-- ---------------------------------------------------------------------------
-- 5. An idea is credited to a member of its own Area
--
-- `gift_ideas.suggested_by_app_member_id` is the only authorship this database
-- records, and migration 035's cross-Area guard does not cover it: it closes
-- the five columns that name a PERSON, and this one names a MEMBERSHIP.
--
-- The gap is small today -- the insert policy already requires the membership
-- to be one of the caller's own -- but it stops the column meaning what it
-- appears to mean: a login with memberships in two Areas could stamp an idea in
-- Alpha with its Bravo membership. Migration 040 reads this column to decide
-- whether an idea is the birthday person's own, so it has to mean one thing.
--
-- INSERT ONLY, because migration 007's `protect_gift_idea_identity` already
-- makes the column immutable on update: adding an update branch would refuse
-- rows that trigger would silently have put back.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_cross_area_idea_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_area uuid;
  author_area uuid;
begin
  if new.suggested_by_app_member_id is null then
    return new;
  end if;

  owning_area := public.area_of_recipient(new.christmas_recipient_id);
  select m.area_id into author_area
  from public.app_members m
  where m.id = new.suggested_by_app_member_id;

  -- Nothing to compare against is not this rule's business, exactly as in 035.
  if owning_area is null or author_area is null then
    return new;
  end if;

  if owning_area <> author_area then
    raise exception 'That member belongs to a different Area'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists gift_ideas_refuse_cross_area_author on public.gift_ideas;
create trigger gift_ideas_refuse_cross_area_author
before insert on public.gift_ideas
for each row execute function public.refuse_cross_area_idea_author();

comment on function public.refuse_cross_area_idea_author() is
  'Refuses a gift idea credited to a membership from another Area. The Area is read from the idea''s own recipient, never from anything a caller supplied.';

-- ---------------------------------------------------------------------------
-- 6. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
begin
  -- The new helper exists, is definer, is pinned, and is not open to anon.
  if not exists (
    select 1 from pg_proc
    where proname = 'is_area_contributor_member' and pronamespace = 'public'::regnamespace
      and prosecdef
      and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as s where s like 'search_path=%')
  ) then
    problems := problems || 'is_area_contributor_member is missing, not definer, or not search_path-pinned'::text;
  end if;

  foreach fn in array array[
    'public.is_area_contributor_member(uuid)',
    'public.set_person_birthday(uuid, smallint, smallint, smallint)',
    'public.list_gift_ideas(uuid)'
  ] loop
    if to_regprocedure(fn) is null then
      problems := problems || format('%s is missing', fn)::text;
    elsif has_function_privilege('anon', fn, 'execute') then
      problems := problems || format('%s is callable by anon', fn)::text;
    elsif not has_function_privilege('authenticated', fn, 'execute') then
      problems := problems || format('%s is not callable by a member', fn)::text;
    end if;
  end loop;

  -- BIRTHDAY EDITING IS AREA-AWARE. Proved by the text, because proving it by
  -- behaviour needs two Areas and a login in both, and this block creates none.
  if not exists (
    select 1 from pg_proc
    where proname = 'set_person_birthday' and pronamespace = 'public'::regnamespace
      and prosrc like '%area_of_person%'
      and prosrc like '%is_area_admin%'
      and prosrc like '%is_area_contributor_member%'
  ) then
    problems := problems || 'set_person_birthday does not resolve the person''s own Area'::text;
  end if;

  -- AND DOES NOT DEPEND ON THE PRE-REQUEST HOOK. `acting_area` must not appear
  -- in it, directly or through `is_app_admin`.
  if exists (
    select 1 from pg_proc
    where proname = 'set_person_birthday' and pronamespace = 'public'::regnamespace
      and (prosrc like '%acting_area%' or prosrc like '%is_app_admin%')
  ) then
    problems := problems || 'set_person_birthday still depends on the acting Area'::text;
  end if;

  -- The global contributor question refuses to guess, like the three in 036.
  if not exists (
    select 1 from pg_proc
    where proname = 'is_family_contributor_member' and pronamespace = 'public'::regnamespace
      and prosrc like '%acting_area%' and prosrc like '%= 1%'
  ) then
    problems := problems || 'is_family_contributor_member can still answer for a login in two Areas'::text;
  end if;

  -- The definer reader is Area-scoped and keeps the surprise rule.
  if not exists (
    select 1 from pg_proc
    where proname = 'list_gift_ideas' and pronamespace = 'public'::regnamespace
      and prosrc like '%is_area_member%' and prosrc like '%is_own_birthday_recipient%'
  ) then
    problems := problems || 'list_gift_ideas is not Area-scoped, or has lost the birthday rule'::text;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'gift_ideas_refuse_cross_area_author' and not tgisinternal
      and tgrelid = 'public.gift_ideas'::regclass
  ) then
    problems := problems || 'gift ideas can still be credited to another Area''s membership'::text;
  end if;

  -- Nothing earlier may have been detached or removed. This file replaces
  -- function bodies, and a replaced function must not take its triggers or its
  -- neighbours with it.
  foreach fn in array array[
    'public.is_area_admin(uuid)', 'public.is_area_member(uuid)',
    'public.current_person_in_area(uuid)', 'public.acting_area()',
    'public.claim_active_area()', 'public.is_own_birthday_recipient(uuid)',
    'public.save_gift_idea(uuid, uuid, text, integer, text, text, text)'
  ] loop
    if to_regprocedure(fn) is null then
      problems := problems || format('%s has gone missing', fn)::text;
    end if;
  end loop;

  if not exists (select 1 from pg_trigger where tgname = 'protect_gift_idea_identity_before_update' and not tgisinternal)
    or not exists (select 1 from pg_trigger where tgname = 'gift_ideas_refuse_foreign_area' and not tgisinternal)
    or not exists (select 1 from pg_trigger where tgname = 'people_refuse_foreign_area' and not tgisinternal) then
    problems := problems || 'a trigger from an earlier migration has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 039 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Birthday editing and gift-idea reading are decided inside one Area, from the row being acted on rather than from the request.';
end;
$$;
