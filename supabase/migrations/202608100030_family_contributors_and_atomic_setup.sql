-- Family-level contributor eligibility, atomic birthday setup, and a duplicate
-- guard for recurring occasions.
--
-- THREE THINGS THAT GENUINELY NEED THE DATABASE
--
--   1. WHO MAY CONTRIBUTE AT ALL.
--      Being in the family and being someone who chips in for gifts are
--      different facts. Nineteen people are in this family; four of them share
--      the cost. Until now every contributor selector offered all nineteen,
--      because the app had nowhere to record the difference.
--
--   2. STARTING A BIRTHDAY IN ONE TRANSACTION.
--      An occurrence, its recipient, its budget and its contribution plan have
--      to arrive together or not at all. Four separate calls can leave an event
--      with no plan -- and the monthly budget reminder reads the plan, so a
--      half-created birthday is a birthday nobody is reminded to save for.
--
--   3. (NOT NEEDED.) A duplicate-Christmas guard was planned here and then
--      removed: migration 025 already enforces one Christmas per year, and the
--      runtime preflight proved it by refusing a second Christmas 2026. See the
--      note where that section used to be.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It names nobody. The contributor backfill is derived from who is already
--     an active contributor on an existing event, which is data.
--   * It changes no budget, plan, purchase, allocation, settlement, receipt or
--     Owed value that already exists, and redefines none of the functions that
--     write them.
--   * It rewrites no birthday, no reminder and no existing occurrence.
--   * It touches Christmas 2026 in no way whatsoever.
--
-- MIGRATIONS 025-029 ARE LIVE AND ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.events') is null then
    raise exception 'Migration 025 has not been applied.';
  end if;
  if to_regproc('public.create_event') is null then
    raise exception 'Migration 026 has not been applied.';
  end if;
  if to_regclass('public.birthday_budget_summaries') is null then
    raise exception 'Migration 029 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Family contributor eligibility
--
-- A column on `people`, not a table of its own. It is one boolean fact per
-- person, 1:1, with no lifecycle -- the same reasoning that put birthdays here.
-- `people` is already read-only to browsers and writable only through SECURITY
-- DEFINER functions, so eligibility inherits exactly the authorization the rest
-- of the person already has, and no selector gains a join.
--
-- DEFAULT FALSE. A new family member is a family member: a recipient, a
-- birthday person, somebody with an account. They become a contributor when the
-- Global Admin says so, and not before.
-- ---------------------------------------------------------------------------

alter table public.people
  add column if not exists is_family_contributor boolean not null default false;

comment on column public.people.is_family_contributor is
  'May this person be offered when choosing who shares the cost of a gift? Eligibility only: it never changes an amount already planned or paid.';

create index if not exists people_family_contributors_idx
  on public.people (id) where is_family_contributor;

-- ---------------------------------------------------------------------------
-- 2. Backfill, from data and from nothing else
--
-- Anybody who is ALREADY an active contributor on an existing event is
-- evidently somebody this family expects to chip in. That is a fact the
-- database already holds; it needs no list of names and no guess.
--
-- Everybody else stays false. This is deliberately not "everyone in the
-- family": the whole point of the column is that those are different sets.
--
-- If a family has no events yet -- a new household -- this sets nobody, and the
-- Global Admin chooses in the app. That is the correct outcome, not a failure.
-- ---------------------------------------------------------------------------

do $$
declare
  eligible integer;
  total integer;
begin
  update public.people
  set is_family_contributor = true
  where id in (select distinct person_id from public.contributors where active)
    and is_family_contributor = false;

  select count(*) filter (where is_family_contributor), count(*)
  into eligible, total
  from public.people;

  raise notice 'Family contributors: % of % family members, derived from existing active event contributors.', eligible, total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Managing the pool
--
-- Global Admin only, checked here. Removing eligibility is deliberately
-- SHALLOW: it stops the person being offered for NEW assignments and touches
-- nothing that already exists. An allocation snapshot is immutable, a payment
-- is history, and a plan somebody is already carrying stays theirs until the
-- Global Admin edits that event on purpose.
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
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to change who contributes'
      using errcode = '42501';
  end if;
  if p_eligible is null then
    raise exception 'Choose whether this person may contribute' using errcode = '23514';
  end if;

  update public.people
  set is_family_contributor = p_eligible, updated_at = now()
  where id = p_person_id
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
  'Add or remove a family member from the contributor pool. Eligibility for FUTURE assignments only: it rewrites no plan, allocation or payment.';

-- ---------------------------------------------------------------------------
-- 4. One Christmas per year is ALREADY enforced -- nothing to add
--
-- Migration 025 created `events_one_christmas_per_year_idx`:
--
--     unique (year) where event_type = 'christmas'
--
-- so a second Christmas 2026 is refused by the database today, and this file
-- adds no second guard. The runtime preflight confirms it rather than assuming
-- it.
--
-- ONE BEHAVIOURAL NOTE WORTH KNOWING. That index has no `status` predicate, so
-- it covers archived rows too: archiving Christmas 2027 does NOT free 2027 for a
-- new one. Birthdays behave differently -- `events_one_birthday_per_person_per_year_idx`
-- is scoped to active rows, so archiving a mistaken birthday does free that
-- person's year.
--
-- That difference is defensible: a birthday occurrence is often created by
-- mistake and replaced, whereas a second Christmas for a year the family has
-- already archived is far more likely to be an error than an intention. It is
-- called out here because it is the kind of asymmetry that looks like a bug
-- when somebody meets it, and changing it is a product decision that does not
-- belong in a migration about contributors.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. Starting a birthday, atomically
--
-- The occurrence, its recipient, that recipient's budget, the contributors and
-- the contribution plan, in ONE transaction. Either the family has a birthday
-- to plan or nothing happened -- there is no state where the event exists and
-- the plan does not.
--
-- That matters beyond tidiness: the monthly budget reminder reads
-- `recipient_contributions`, so a half-created birthday is one nobody is ever
-- reminded to save for.
--
-- The plan arrives as [{ "person_id": uuid, "pennies": integer }] and must total
-- the budget exactly. Migration 012's invariant says the same thing at commit;
-- checking here as well means the caller is told which number is wrong rather
-- than being handed a constraint violation.
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
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to start birthday planning'
      using errcode = '42501';
  end if;
  current_member_id := public.current_app_member_id();
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

revoke all on function public.start_birthday_planning(uuid, text, date, integer, jsonb) from public, anon;
grant execute on function public.start_birthday_planning(uuid, text, date, integer, jsonb) to authenticated;

comment on function public.start_birthday_planning(uuid, text, date, integer, jsonb) is
  'Create one year of a person''s birthday planning in a single transaction: the occurrence, the celebrant as its recipient, the budget, the contributors and a plan that totals the budget exactly. Global Admin only.';

-- ---------------------------------------------------------------------------
-- 6. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'people' and column_name = 'is_family_contributor'
  ) then
    problems := problems || ('people.is_family_contributor is missing')::text;
  end if;

  -- Nobody was made eligible who is not already an active event contributor.
  if exists (
    select 1 from public.people
    where is_family_contributor
      and id not in (select distinct person_id from public.contributors where active)
  ) then
    problems := problems || ('the backfill made somebody eligible who is not an existing contributor')::text;
  end if;

  -- Both functions are definer, pinned, and closed to anon.
  if not exists (
    select 1 from pg_proc
    where proname in ('set_family_contributor', 'start_birthday_planning')
      and pronamespace = 'public'::regnamespace
      and prosecdef
      and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as setting
                  where setting like 'search_path=%')
    having count(*) = 2
  ) then
    problems := problems || ('a new function is missing, not definer, or not search_path-pinned')::text;
  end if;

  if has_function_privilege('anon', 'public.set_family_contributor(uuid, boolean)', 'execute')
    or has_function_privilege('anon', 'public.start_birthday_planning(uuid, text, date, integer, jsonb)', 'execute') then
    problems := problems || ('a new function is executable by anon')::text;
  end if;

  -- 025's guard is still there. This file did not add one and must not have
  -- removed one either.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'events_one_christmas_per_year_idx'
  ) then
    problems := problems || ('migration 025''s one-Christmas-per-year guard has gone missing')::text;
  end if;

  -- Nothing that was already there has moved.
  if exists (
    select 1 from pg_proc
    where proname = 'due_birthday_budget_summaries'
      and pronamespace = 'public'::regnamespace
      and prosrc not like '%extract(day from p_today) = 1%'
  ) then
    problems := problems || ('the monthly reminder sweep changed')::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 030 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Family contributors, atomic birthday setup and the one-Christmas-per-year guard are installed. No budget, plan, purchase, payment or birthday was changed.';
end;
$$;
