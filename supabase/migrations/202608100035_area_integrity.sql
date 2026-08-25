-- Cross-Area integrity: relationships that must be impossible, made impossible.
--
-- WHAT IS ALREADY SAFE, AND WHY THIS FILE IS SHORTER THAN IT LOOKS
--
--   Migration 025's `enforce_event_scope_integrity` already refuses to let a
--   recipient, contributor, purchase, allocation, contribution plan, settlement
--   or receipt straddle two EVENTS. An event belongs to exactly one Area, so
--   none of those can straddle two Areas either. That guard was written to stop
--   Christmas money leaking into a birthday and turns out to do most of this
--   job already.
--
--   What it does NOT cover is the other kind of link: the ones that reach a
--   PERSON rather than an event. Those are the only ways a row can name two
--   Areas at once, and there are exactly five of them:
--
--     events.celebrant_person_id           whose birthday this is
--     christmas_recipients.person_id       who an event is buying for
--     contributors.person_id               who shares the cost
--     app_members.person_id                who an account belongs to
--     purchases.gift_location_person_id    who is hiding the present
--
--   Each is closed below. Nothing else needs closing, and adding guards that
--   restate the event rule would be noise pretending to be safety.
--
-- PER-AREA UNIQUENESS
--   Three global rules become per-Area rules. Two Areas may each have their own
--   Christmas 2026; two Areas may each plan the same year's birthday for their
--   own person; and each Area gets its own administrator instead of the
--   application having one.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or rewrites no row. Every statement is an index, a
--     function or a trigger.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt.
--   * It touches Christmas 2026 only by replacing the index that protects it
--     with one that protects it per Area -- its own row is not read or written.
--
-- MIGRATIONS 001-034 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.areas') is null then
    raise exception 'Migration 034 has not been applied.';
  end if;
  if exists (select 1 from public.people where area_id is null)
    or exists (select 1 from public.events where area_id is null)
    or exists (select 1 from public.app_members where area_id is null) then
    raise exception 'Migration 034 left rows without an Area. Fix that before adding guards.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. A person named by a row must live in that row's Area
--
-- ONE TRIGGER, FIVE COLUMNS, because they are one rule: whatever you name, it
-- has to be from here.
--
-- It reads the Area from the ROW'S OWN PARENT, never from anything a caller
-- supplied -- an event's recipient is checked against that event's Area, and a
-- membership's person against that membership's Area.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_cross_area_person()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_area uuid;
  person_area uuid;
  target_person uuid;
begin
  if tg_table_name = 'events' then
    target_person := new.celebrant_person_id;
    owning_area := new.area_id;
  elsif tg_table_name = 'app_members' then
    target_person := new.person_id;
    owning_area := new.area_id;
  elsif tg_table_name = 'christmas_recipients' then
    target_person := new.person_id;
    select e.area_id into owning_area from public.events e where e.id = new.christmas_event_id;
  elsif tg_table_name = 'contributors' then
    target_person := new.person_id;
    select e.area_id into owning_area from public.events e where e.id = new.christmas_event_id;
  elsif tg_table_name = 'purchases' then
    target_person := new.gift_location_person_id;
    select e.area_id into owning_area
    from public.christmas_recipients r
    join public.events e on e.id = r.christmas_event_id
    where r.id = new.christmas_recipient_id;
  end if;

  -- Nothing named, or nothing to compare against yet: not this rule's business.
  -- A row whose Area is still null is one migration 034 has not reached, and
  -- 037 is where null stops being allowed at all.
  if target_person is null or owning_area is null then
    return new;
  end if;

  select p.area_id into person_area from public.people p where p.id = target_person;
  if person_area is null then
    return new;
  end if;

  if person_area <> owning_area then
    raise exception 'That person belongs to a different Area'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

do $$
declare
  target text;
begin
  foreach target in array array['events', 'app_members', 'christmas_recipients', 'contributors', 'purchases'] loop
    execute format('drop trigger if exists %I on public.%I', target || '_refuse_cross_area', target);
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.refuse_cross_area_person()',
      target || '_refuse_cross_area', target);
  end loop;
end;
$$;

comment on function public.refuse_cross_area_person() is
  'Refuses any row that names a person from another Area. The Area is read from the row''s own parent, never from anything a caller supplied.';

-- ---------------------------------------------------------------------------
-- 2. Rules that were global become rules about one Area
--
-- Every index below is REPLACED, not loosened: the same thing stays unique, it
-- just stays unique per Area instead of per application. Christmas 2026 still
-- cannot be created twice in this family. It can now be created once in a
-- family that has nothing to do with this one.
--
-- Each replacement is created BEFORE the old one is dropped where the new
-- constraint is the stricter of the two, so there is no instant at which
-- duplicates could be inserted.
-- ---------------------------------------------------------------------------

-- One Christmas per year, per Area.
create unique index if not exists events_one_christmas_per_area_year_idx
  on public.events (area_id, year)
  where event_type = 'christmas';
drop index if exists public.events_one_christmas_per_year_idx;

-- The same occasion entered twice remains the likeliest event-creation
-- mistake. Two Areas holding an "Easter" on the same day are two families, not
-- a mistake.
create unique index if not exists events_name_and_date_per_area_idx
  on public.events (area_id, lower(trim(name)), event_date);
drop index if exists public.events_name_and_date_unique_idx;

-- NOT REPLACED, DELIBERATELY: events_one_birthday_per_person_per_year_idx.
--   It is keyed on the celebrant, and a person belongs to exactly one Area, so
--   it is already a per-Area rule wearing global clothing. Adding area_id to it
--   would change no behaviour and would suggest a hole that is not there.

-- One administrator per AREA, replacing one administrator per application.
--
-- THIS IS THE CONSTRAINT MIGRATION 033 FLAGGED AND COULD NOT FIX. Its guard
-- refuses to let the last administrator leave; the old index refused to let a
-- second one exist; together the role could never be handed over. Per Area the
-- ceiling still stands at one, but the guard below now counts within an Area,
-- so removing Area B's administrator can no longer be excused by Area A having
-- one. Handing over is a Phase 5 application concern and arrives with the
-- create_area RPC in 037.
create unique index if not exists app_members_single_admin_per_area_idx
  on public.app_members (area_id)
  where role = 'admin';
drop index if exists public.app_members_single_admin_idx;

-- One login email per Area, replacing one login email per application.
--
-- This is what makes the Area switcher possible at all: the same human can hold
-- a membership in two families, each pointing at that family's own person row.
-- Within one Area an email is still unique, so nobody can be invited twice.
create unique index if not exists app_members_email_per_area_idx
  on public.app_members (area_id, lower(email))
  where email is not null;
drop index if exists public.app_members_email_case_insensitive_idx;

-- The same two rules again, this time as TABLE CONSTRAINTS rather than indexes.
--
-- Migration 004 declared `email ... unique` and `user_id ... unique` inline, so
-- alongside 006's case-insensitive index there are constraints saying the same
-- thing, and dropping only the index would have left the rule standing.
--
-- THE user_id ONE IS WHAT ACTUALLY BLOCKS THE AREA SWITCHER. Supabase gives a
-- human ONE auth user for ONE email address -- auth.users.email is unique, so
-- being in two families cannot mean having two logins. It has to mean one login
-- holding a membership in each, and that is exactly what UNIQUE (user_id)
-- forbids. It becomes unique per Area.
alter table public.app_members drop constraint if exists app_members_email_key;
alter table public.app_members drop constraint if exists app_members_user_id_key;

create unique index if not exists app_members_user_per_area_idx
  on public.app_members (area_id, user_id)
  where user_id is not null;

-- NOT REPLACED, DELIBERATELY: app_members_one_membership_per_person_idx.
--   One membership per PERSON row is already per-Area, because a person row
--   belongs to one Area and section 1 refuses to let a membership name a person
--   from another. Two memberships for one human are two person rows.

-- ---------------------------------------------------------------------------
-- 3. The last administrator of an AREA, not of the application
--
-- Migration 033's guard is redefined rather than replaced: same name, same
-- body, same refusal, with the count narrowed to the departing row's Area. The
-- triggers 033 attached keep working untouched.
--
-- WITHOUT THIS, DROPPING THE GLOBAL INDEX ABOVE WOULD OPEN A HOLE. A global
-- count is satisfied by any administrator anywhere, so once two Areas exist,
-- Area B could lose its last one while Area A still had hers.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_last_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_admin boolean;
  still_admin boolean;
  remaining integer;
begin
  was_admin := old.role = 'admin' and old.active;

  -- An update that leaves the row an active administrator OF THE SAME AREA is
  -- a name change, not a departure. Moving to another Area is a departure from
  -- this one, so the Area has to match for the change to be excused.
  still_admin := tg_op = 'UPDATE'
    and new.role = 'admin'
    and new.active
    and new.area_id is not distinct from old.area_id;

  if not was_admin or still_admin then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select count(*) into remaining
  from public.app_members
  where role = 'admin'
    and active
    and area_id is not distinct from old.area_id
    and id <> old.id;

  if remaining = 0 then
    raise exception 'This Area must keep at least one active administrator'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function public.refuse_last_admin_removal() is
  'Refuses the change that would leave an Area with no active administrator. Deactivation, demotion, deletion and moving to another Area alike.';

-- ---------------------------------------------------------------------------
-- 4. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  gone text;
  present text;
  trg text;
begin
  foreach gone in array array[
    'events_one_christmas_per_year_idx',
    'events_name_and_date_unique_idx',
    'app_members_single_admin_idx',
    'app_members_email_case_insensitive_idx',
    'app_members_email_key',
    'app_members_user_id_key'
  ] loop
    if to_regclass('public.' || gone) is not null then
      problems := problems || format('%s should have been replaced', gone)::text;
    end if;
  end loop;

  foreach present in array array[
    'events_one_christmas_per_area_year_idx',
    'events_name_and_date_per_area_idx',
    'app_members_single_admin_per_area_idx',
    'app_members_email_per_area_idx',
    'app_members_user_per_area_idx',
    'events_one_birthday_per_person_per_year_idx',
    'app_members_one_membership_per_person_idx'
  ] loop
    if to_regclass('public.' || present) is null then
      problems := problems || format('%s is missing', present)::text;
    end if;
  end loop;

  foreach trg in array array[
    'events_refuse_cross_area',
    'app_members_refuse_cross_area',
    'christmas_recipients_refuse_cross_area',
    'contributors_refuse_cross_area',
    'purchases_refuse_cross_area'
  ] loop
    if not exists (select 1 from pg_trigger where tgname = trg and not tgisinternal) then
      problems := problems || format('trigger %s is missing', trg)::text;
    end if;
  end loop;

  -- The guards migration 033 installed are still installed. Redefining a
  -- function must not have detached anything from it.
  foreach trg in array array['app_members_keep_an_admin', 'app_members_require_person_link'] loop
    if not exists (select 1 from pg_trigger where tgname = trg and not tgisinternal) then
      problems := problems || format('migration 033''s trigger %s has gone missing', trg)::text;
    end if;
  end loop;

  -- Nothing here creates, moves or deletes a row. If the counts have changed,
  -- something in this file did more than it claimed to.
  if exists (select 1 from public.events where area_id is null)
    or exists (select 1 from public.people where area_id is null) then
    problems := problems || 'a row lost its Area'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 035 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Cross-Area person links are refused and uniqueness is per Area. Row level security is still Area-blind: that is 036.';
end;
$$;
