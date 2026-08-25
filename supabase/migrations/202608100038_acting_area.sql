-- Which of my Areas am I speaking as?
--
-- THE PROBLEM 036 AND 037 LEAVE BEHIND. Every privileged routine in this
-- database asks `is_app_admin()`, and 036 made that refuse to answer for a login
-- that belongs to two Areas -- safely, because the alternative was picking one
-- at random. But it means the very person the Area switcher exists for, someone
-- who administers one family and belongs to another, can no longer add a person,
-- create an event or record a purchase in either.
--
-- Migration 011 revoked insert and update on `people` from `authenticated`, and
-- the same is true of most tables here: there is no browser-side write to attach
-- an Area to. The Area has to be settled inside the routine, which means it has
-- to arrive with the request.
--
-- SO ONE THING IS ADDED: a TRANSACTION-LOCAL note of which Area the caller is
-- acting in. Set it, and the three questions from 036 answer about that Area
-- instead of refusing. All fifty-odd existing routines then work unchanged,
-- because they never asked the questions directly -- they asked `is_app_admin()`,
-- and `is_app_admin()` now knows which family is meant.
--
-- WHY THIS GRANTS NOTHING
--   * `act_in_area` refuses an Area the caller is not an active member of, so
--     the note can only ever name a family they are really in.
--   * Every use of it still runs the real check -- `is_area_admin(acting)` reads
--     the membership table, exactly as `is_app_admin()` always did. Claiming to
--     act in an Area you do not administer gets you a member's rights there, not
--     an administrator's.
--   * It is set with `is_local = true`, so it dies with the transaction and
--     cannot survive on a pooled connection into somebody else's request.
--   * A caller who sets nothing behaves precisely as they did before this file.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits no row of any kind.
--   * It widens no policy and removes no guard. The write barrier in 037 still
--     runs on every write, and refuses anything outside the caller's Areas
--     whatever this note says.
--
-- MIGRATIONS 001-037 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regproc('public.refuse_foreign_area_write') is null then
    raise exception 'Migration 037 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The note, and the only way to write it
-- ---------------------------------------------------------------------------

create or replace function public.acting_area()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.acting_area', true), '')::uuid;
$$;

comment on function public.acting_area() is
  'Which Area the caller said they are acting in for this transaction, or null. A statement of intent, never of authority: every caller of it re-checks the membership table.';

create or replace function public.act_in_area(p_area_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_area_id is null then
    perform set_config('app.acting_area', '', true);
    return;
  end if;

  -- Membership, not administration. Saying which of your families you are in
  -- is not a claim to run it, and `is_area_admin` below still decides that.
  if not public.is_area_member(p_area_id) then
    raise exception 'You are not a member of that Area' using errcode = '42501';
  end if;

  perform set_config('app.acting_area', p_area_id::text, true);
end;
$$;

revoke all on function public.act_in_area(uuid) from public, anon;
grant execute on function public.act_in_area(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The three questions learn to read it
--
-- Same names, same signatures, same answers for everyone who belongs to one
-- Area. The only change is that a login in two now has a way to be specific,
-- and still refuses when it has not been.
-- ---------------------------------------------------------------------------

create or replace function public.current_app_member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.app_members m
  where m.user_id = (select auth.uid())
    and m.active = true
    and (
      case
        when public.acting_area() is not null then m.area_id = public.acting_area()
        else (
          select count(*)
          from public.app_members m2
          where m2.user_id = (select auth.uid()) and m2.active = true
        ) = 1
      end
    );
$$;

create or replace function public.current_person_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.person_id
  from public.app_members m
  where m.user_id = (select auth.uid())
    and m.active = true
    and (
      case
        when public.acting_area() is not null then m.area_id = public.acting_area()
        else (
          select count(*)
          from public.app_members m2
          where m2.user_id = (select auth.uid()) and m2.active = true
        ) = 1
      end
    );
$$;

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.acting_area() is not null then public.is_area_admin(public.acting_area())
    else exists (
      select 1
      from public.app_members m
      where m.user_id = (select auth.uid())
        and m.active = true
        and m.role = 'admin'
        and (
          select count(*)
          from public.app_members m2
          where m2.user_id = (select auth.uid()) and m2.active = true
        ) = 1
    )
  end;
$$;

comment on function public.is_app_admin() is
  'Whether the caller administers the Area they are acting in -- the one they said, or the only one they belong to. False for a login in two Areas that has not said which.';

-- ---------------------------------------------------------------------------
-- 3. And so does the row that arrives without one
-- ---------------------------------------------------------------------------

create or replace function public.default_area_for_new_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidates uuid[];
begin
  if new.area_id is not null then
    return new;
  end if;

  if (select auth.uid()) is null then
    raise exception 'A new % must name the Area it belongs to', tg_table_name
      using errcode = '23502';
  end if;

  -- Said which: use it. act_in_area has already checked the membership, and
  -- 037's barrier checks it again on the way out.
  if public.acting_area() is not null then
    new.area_id := public.acting_area();
    return new;
  end if;

  select array_agg(distinct m.area_id) into candidates
  from public.app_members m
  where m.user_id = (select auth.uid()) and m.active = true;

  if candidates is null or array_length(candidates, 1) = 0 then
    raise exception 'You do not belong to an Area yet'
      using errcode = '42501';
  end if;

  if array_length(candidates, 1) > 1 then
    raise exception 'You belong to more than one Area. Say which this % is for.', tg_table_name
      using errcode = '23502';
  end if;

  new.area_id := candidates[1];
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. How the note gets set on a real request
--
-- PostgREST runs each request in one transaction and gives the client no way to
-- run two statements inside it, so the application cannot call `act_in_area`
-- and then its RPC. What it can do is send a header, and ask PostgREST to run
-- one function before every request -- which is what `db_pre_request` is for,
-- and which runs INSIDE that same transaction, exactly where the note needs to
-- be written.
--
-- The client sends `x-area-id: <the Area the user is looking at>` and this
-- turns it into an acting Area.
--
-- A HEADER IS A REQUEST, NOT A PERMISSION. It is checked against the membership
-- table like anything else, and a header naming an Area the caller is not in is
-- IGNORED rather than refused -- a stale one left over from leaving a family
-- would otherwise break every request that login made. Ignoring it falls back to
-- the single-Area answer, which is either correct or a refusal. It is never a
-- silent switch to the wrong family.
-- ---------------------------------------------------------------------------

create or replace function public.claim_active_area()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  asked text;
  wanted uuid;
begin
  asked := nullif(current_setting('request.headers', true), '')::json ->> 'x-area-id';
  if asked is null or asked = '' then
    return;
  end if;

  begin
    wanted := asked::uuid;
  exception when others then
    return;   -- not an Area id at all; nothing to act in
  end;

  if public.is_area_member(wanted) then
    perform set_config('app.acting_area', wanted::text, true);
  end if;
end;
$$;

comment on function public.claim_active_area() is
  'PostgREST pre-request hook: turns the x-area-id header into an acting Area, if the caller is really a member of it.';

do $$
begin
  -- Only where PostgREST exists. Locally, and inside the disposable database
  -- these migrations are rehearsed in, there is no authenticator role and
  -- nothing to configure.
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant execute on function public.claim_active_area() to authenticator';
    execute 'alter role authenticator set pgrst.db_pre_request = ''public.claim_active_area''';
    notify pgrst, 'reload config';
    raise notice 'PostgREST will call claim_active_area before each request.';
  else
    raise notice 'No authenticator role here, so no pre-request hook was configured. On Supabase this migration sets it.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
  offender record;
begin
  foreach fn in array array[
    'public.acting_area()', 'public.act_in_area(uuid)', 'public.claim_active_area()'
  ] loop
    if to_regprocedure(fn) is null then
      problems := problems || format('%s is missing', fn)::text;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.act_in_area(uuid)', 'execute') then
    problems := problems || 'anon can set an acting Area'::text;
  end if;

  -- The three questions read the note. Checked by text, because proving it by
  -- behaviour needs a login in two Areas and this block may create none.
  for offender in
    select proname from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('current_app_member_id', 'current_person_id', 'is_app_admin', 'default_area_for_new_row')
      and prosrc not like '%acting_area%'
  loop
    problems := problems || format('%s ignores the acting Area', offender.proname)::text;
  end loop;

  -- And still refuse to guess when nothing was said. Losing this would undo 036.
  for offender in
    select proname from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('current_app_member_id', 'current_person_id', 'is_app_admin')
      and prosrc not like '%= 1%'
  loop
    problems := problems || format('%s can once again pick an Area at random', offender.proname)::text;
  end loop;

  -- Nothing here may have touched a guard.
  if to_regproc('public.refuse_foreign_area_write') is null
    or not exists (select 1 from pg_trigger where tgname = 'people_refuse_foreign_area' and not tgisinternal)
    or not exists (select 1 from pg_trigger where tgname = 'people_area_default' and not tgisinternal) then
    problems := problems || 'a guard from 037 has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 038 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'A login in two Areas can now say which one it means, and is still refused when it does not.';
end;
$$;
