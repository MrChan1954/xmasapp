-- People become a directory: archivable, and creatable in one step.
--
-- WHAT PHASE 3 FOUND, AND WHY THIS FILE IS SMALL
--
--   The gift history a Person profile shows needs NO new storage. A purchase
--   already names exactly one `christmas_recipients` row, and that row already
--   names exactly one person and one event:
--
--     purchases -> christmas_recipients -> (person_id, christmas_event_id)
--
--   So "what have we bought Eden?" is a join over rows that have existed since
--   migration 001. A `person_gift_history` table would be a cache of data the
--   database can already answer, and a second thing to be wrong.
--
--   Two things genuinely are not derivable, and they are all this file adds.
--
--   1. WHETHER A PERSON IS STILL PART OF THE FAMILY'S PLANNING.
--      `people` has no archive state and no delete policy: a browser cannot
--      remove a person at all, which is the right protection -- deleting
--      somebody would orphan their purchases, allocations and payments -- but
--      it leaves no way to retire somebody either, so every picker offers
--      everybody forever.
--
--   2. A PERSON AND THEIR BIRTHDAY, CREATED TOGETHER.
--      Adding a person and recording their birthday are two writes today, so a
--      failure between them leaves a person the family has to go and finish
--      elsewhere.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes, renumbers or rewrites no existing row. The column it
--     adds is nullable, so every person that exists stays exactly as they are
--     and reads as active.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt,
--     and redefines none of the functions that write them.
--   * It adds NO delete path for people. Deleting a person is still impossible
--     from a browser, and deliberately so.
--   * It touches Christmas 2026 in no way whatsoever.
--
-- MIGRATIONS 001-031 ARE APPLIED AND ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.events') is null then
    raise exception 'Migration 025 has not been applied.';
  end if;
  if to_regproc('public.set_person_birthday') is null then
    raise exception 'Migration 026 has not been applied.';
  end if;
  if to_regproc('public.current_person_id') is null then
    raise exception 'Migration 031 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Archived, not deleted
--
-- NULLABLE, and null means active. Every person who already exists therefore
-- reads as active with no backfill, no UPDATE, and no chance of a mistake
-- during one.
--
-- A TIMESTAMP RATHER THAN A BOOLEAN because "when did we stop planning for
-- Grandma" is a question somebody will ask, and a boolean cannot answer it.
-- The same reasoning already applies to `purchases.deleted_at`.
--
-- ARCHIVING IS PRESENTATION, NOT DELETION. An archived person keeps every
-- purchase, every allocation, every payment and every birthday. They stop being
-- offered for NEW assignments and they stay in the history they are already
-- part of, exactly as an archived event does.
-- ---------------------------------------------------------------------------

alter table public.people
  add column if not exists archived_at timestamptz;

comment on column public.people.archived_at is
  'When this person stopped being offered for new assignments. Null means active. Archiving hides nobody from history: every purchase, allocation, payment and birthday is untouched.';

create index if not exists people_active_idx
  on public.people (id) where archived_at is null;

-- ---------------------------------------------------------------------------
-- 2. Archiving and restoring
--
-- Global Admin only, and deliberately SHALLOW -- it writes one timestamp and
-- nothing else. It does not end their event recipiencies, does not touch their
-- contributor rows, does not settle their balances and does not clear their
-- birthday. The same reasoning as `set_family_contributor` in migration 030:
-- eligibility for what comes NEXT is a different fact from what has already
-- happened, and a function that quietly did both would be impossible to undo.
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
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to archive a family member'
      using errcode = '42501';
  end if;
  if p_archived is null then
    raise exception 'Choose whether to archive or restore this person' using errcode = '23514';
  end if;

  update public.people
  set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
      updated_at = now()
  where id = p_person_id
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
  'Archive or restore a family member. Presentation only: it rewrites no purchase, allocation, payment, birthday or event relationship.';

-- ---------------------------------------------------------------------------
-- 3. A person, and their birthday, in one step
--
-- WHY A FUNCTION WHEN `people` ALREADY HAS AN INSERT POLICY
--
--   Two reasons, and neither is tidiness.
--
--   ATOMICITY. Recording a birthday is a second write today, so a failure
--   between them leaves a half-added person somebody has to go and finish on
--   another screen -- and the birthday is the field most likely to be skipped
--   and never come back to.
--
--   AND WHAT IT REFUSES TO SET. The insert policy lets an admin write any
--   column, including `is_family_contributor`. Being in the family and sharing
--   the cost of gifts are different facts (migration 030), and adding somebody
--   to the directory must not quietly decide the second one. This function
--   writes a name and a birthday; eligibility stays false and stays the Global
--   Admin's separate, deliberate decision.
--
-- THE BIRTHDAY VALIDATION IS NOT REPRODUCED HERE. It delegates to migration
-- 026's `set_person_birthday`, so the month range, the day-of-month range, the
-- 29 February rule and the year bounds are the SAME rules the Birthdays screen
-- enforces -- not a second copy that can drift. Both writes are in this
-- function's transaction, so an invalid birthday takes the person with it and
-- nothing half-made survives.
-- ---------------------------------------------------------------------------

create or replace function public.create_person(
  p_name text,
  p_month smallint default null,
  p_day smallint default null,
  p_year smallint default null
)
returns public.people
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_name text;
  saved_person public.people;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to add a family member'
      using errcode = '42501';
  end if;

  clean_name := nullif(trim(coalesce(p_name, '')), '');
  if clean_name is null or length(clean_name) > 100 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid name' using errcode = '23514';
  end if;

  -- A new person is a PERSON. Not a contributor, not a member, not an admin:
  -- those are separate decisions somebody makes on purpose, elsewhere.
  insert into public.people (name)
  values (clean_name)
  returning * into saved_person;

  if p_month is not null or p_day is not null or p_year is not null then
    -- Same validation as the Birthdays screen, because it is the same function.
    saved_person := public.set_person_birthday(saved_person.id, p_month, p_day, p_year);
  end if;

  return saved_person;
end;
$$;

revoke all on function public.create_person(text, smallint, smallint, smallint) from public, anon;
grant execute on function public.create_person(text, smallint, smallint, smallint) to authenticated;

comment on function public.create_person(text, smallint, smallint, smallint) is
  'Add a family member to the directory, with their birthday if it is known, in one transaction. Global Admin only. Creates a PERSON and nothing else: never a contributor, a member or an admin.';

-- ---------------------------------------------------------------------------
-- 4. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  archived integer;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'people' and column_name = 'archived_at'
  ) then
    problems := problems || 'people.archived_at is missing'::text;
  end if;

  -- Nobody was archived by this migration. The column is nullable and nothing
  -- backfills it, so every existing person must still read as active.
  select count(*) into archived from public.people where archived_at is not null;
  if archived > 0 then
    problems := problems || format('%s people were archived by this migration', archived)::text;
  end if;

  if (
    select count(*) from pg_proc
    where proname in ('set_person_archived', 'create_person')
      and pronamespace = 'public'::regnamespace
      and prosecdef
      and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as s where s like 'search_path=%')
  ) <> 2 then
    problems := problems || 'a new function is missing, not definer, or not search_path-pinned'::text;
  end if;

  if has_function_privilege('anon', 'public.create_person(text, smallint, smallint, smallint)', 'execute')
    or has_function_privilege('anon', 'public.set_person_archived(uuid, boolean)', 'execute') then
    problems := problems || 'a new function is executable by anon'::text;
  end if;

  -- STILL NO WAY TO DELETE A PERSON. That is the protection this migration is
  -- built on: archiving is offered precisely because deleting is not.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'people' and cmd = 'DELETE'
  ) then
    problems := problems || 'a delete policy appeared on people'::text;
  end if;

  -- Nothing that was already there has moved.
  if to_regproc('public.set_person_birthday') is null
    or to_regproc('public.is_own_birthday_event') is null
    or to_regproc('public.set_family_contributor') is null then
    problems := problems || 'an earlier migration''s object has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 032 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'People can be archived and created with a birthday in one step. No person, purchase, allocation, payment or birthday was changed.';
end;
$$;
