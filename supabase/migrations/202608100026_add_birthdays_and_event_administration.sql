-- Birthdays, birthday reminders, and the entry points that create and manage
-- an event from inside the app.
--
-- WHAT THIS FILE IS FOR
--   Checkpoint 4 is the first time the family can create an event without a
--   developer. It is also where a person's birthday becomes permanent family
--   data rather than something re-entered every December.
--
-- THE PRODUCT DISTINCTION THIS SCHEMA ENCODES
--   A BIRTHDAY is a recurring calendar date belonging to a PERSON. It has no
--   money, no recipients and no year of its own. Paige's birthday is the 6th of
--   November, permanently.
--
--   A BIRTHDAY EVENT is one year's gift planning for that birthday. It is an
--   ordinary row in `events`, with recipients, contributors, purchases,
--   allocations, payments and Owed, exactly like Christmas.
--
--   The two are deliberately NOT one record. Storing them together would mean
--   either losing the permanent date when an event is archived, or rewriting
--   history when somebody corrects a birthday. Annual occurrences are DERIVED
--   from the permanent date; nothing resets on the 1st of January.
--
-- WHY BIRTHDAYS LIVE ON `people` AND NOT IN A TABLE OF THEIR OWN
--   A birthday is an attribute of a person, exactly like their name: one value,
--   1:1, with no lifecycle of its own. A separate table would add a join to
--   every calendar read and every reminder sweep, a second RLS surface, and a
--   second set of grants, in exchange for nothing — there is no history to keep
--   and no cardinality to grow into. `people` is already read-only to browsers
--   and writable only through SECURITY DEFINER functions, so the birthday
--   inherits exactly the authorization the rest of the person already has.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It changes no budget, plan, purchase, allocation, settlement, receipt or
--     Owed value, and redefines none of the functions that write them.
--   * It creates no event and no birthday. Every value is entered through the
--     app by an authorized person.
--   * It deletes nothing, and adds no job that deletes anything.

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
  required text;
begin
  if pg_catalog.to_regclass('public.events') is null then
    raise exception 'public.events is missing. Apply migration 025 before this file.';
  end if;
  if pg_catalog.to_regclass('public.birthday_reminders') is not null then
    raise exception 'public.birthday_reminders already exists. This migration has already been applied.';
  end if;

  foreach required in array array[
    'people', 'app_members', 'christmas_recipients', 'contributors',
    'recipient_contributions', 'audit_log', 'notification_outbox',
    'notification_events', 'notifications', 'notification_preferences'
  ]
  loop
    if pg_catalog.to_regclass('public.' || required) is null then
      missing := missing || required;
    end if;
  end loop;
  if array_length(missing, 1) is not null then
    raise exception 'Checkpoint 4 needs the full application schema. Missing: %',
      array_to_string(missing, ', ');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The permanent birthday
-- ---------------------------------------------------------------------------
-- Month and day are what the family always knows. The YEAR is optional on
-- purpose: the recurring date is what drives the calendar and the reminders,
-- and a family that does not want somebody's age recorded must still be able to
-- save when to buy them a present.
alter table public.people
  add column if not exists birthday_month smallint,
  add column if not exists birthday_day smallint,
  add column if not exists birthday_year smallint;

comment on column public.people.birthday_month is
  'Permanent recurring birthday month, 1-12. Null means no birthday recorded.';
comment on column public.people.birthday_day is
  'Permanent recurring birthday day. Validated against the month, with 29 February allowed.';
comment on column public.people.birthday_year is
  'Optional year of birth. Never required: the recurring date is what the calendar and reminders need.';

-- Month and day travel together or not at all: half a birthday is not a date.
alter table public.people
  add constraint people_birthday_complete_check
  check (
    (birthday_month is null and birthday_day is null)
    or (birthday_month is not null and birthday_day is not null)
  );

-- A real calendar date, checked structurally rather than in TypeScript.
-- February accepts 29 because the birthday itself is real; what a non-leap
-- year does with it is a presentation decision, made once in
-- `birthday_occurrence_date` below.
alter table public.people
  add constraint people_birthday_is_a_real_date_check
  check (
    birthday_month is null
    or (
      birthday_month between 1 and 12
      and birthday_day between 1
        and case birthday_month
          when 2 then 29
          when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30
          else 31
        end
    )
  );

alter table public.people
  add constraint people_birthday_year_sane_check
  check (birthday_year is null or birthday_year between 1900 and 2200);

-- The reminder sweep asks "whose birthday falls on these few dates?", so the
-- month and day are the index, and people without one are left out of it.
create index if not exists people_birthday_idx
  on public.people (birthday_month, birthday_day)
  where birthday_month is not null;

-- ---------------------------------------------------------------------------
-- 2. One occurrence of a birthday, as a real date
-- ---------------------------------------------------------------------------
-- THE LEAP-DAY POLICY, DECIDED ONCE AND WRITTEN DOWN.
--
--   A 29 February birthday is observed on 28 FEBRUARY in a non-leap year.
--
-- The alternative — 1 March — was rejected because it moves the birthday into
-- the following month, which reads wrong on a calendar sorted by month and
-- would put the reminder after some people had already celebrated. 28 February
-- keeps the occurrence inside February and never lands after the real date.
--
-- Immutable, so it can be used in an index and in a generated comparison.
create or replace function public.birthday_occurrence_date(
  p_month smallint,
  p_day smallint,
  p_year integer
)
returns date
language sql
immutable
strict
set search_path = ''
as $$
  select make_date(
    p_year,
    p_month::integer,
    least(
      p_day::integer,
      -- Days in that month of that year: step into the next month and back one.
      extract(day from (
        make_date(p_year, p_month::integer, 1) + interval '1 month' - interval '1 day'
      ))::integer
    )
  );
$$;

revoke all on function public.birthday_occurrence_date(smallint, smallint, integer)
  from public, anon, authenticated;
grant execute on function public.birthday_occurrence_date(smallint, smallint, integer) to authenticated;

comment on function public.birthday_occurrence_date(smallint, smallint, integer) is
  'The date a recurring birthday falls on in a given year. 29 February is observed on 28 February in a non-leap year.';

-- ---------------------------------------------------------------------------
-- 3. Auditing a birthday change
-- ---------------------------------------------------------------------------
-- `people` is audited for INSERT and DELETE only (migration 015), so a birthday
-- edit — an UPDATE — would otherwise leave no trace. Birthdays are personal
-- data the whole family can see, so a change to one is exactly the kind of
-- thing the activity log exists to answer for.
--
-- The DATE ITSELF is not written into the log: it is already visible on the
-- Birthdays page to every active member, and an audit row is not the place to
-- duplicate personal data. The log records that it changed, and who by.
create or replace function public.record_birthday_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  had_birthday boolean := old.birthday_month is not null;
  has_birthday boolean := new.birthday_month is not null;
  resolved_action text;
begin
  if old.birthday_month is not distinct from new.birthday_month
    and old.birthday_day is not distinct from new.birthday_day
    and old.birthday_year is not distinct from new.birthday_year
  then
    return null;
  end if;

  resolved_action := case
    when not had_birthday and has_birthday then 'added'
    when had_birthday and not has_birthday then 'removed'
    else 'restored'
  end;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details
  )
  values (
    'people_birthday',
    new.id,
    resolved_action,
    (select auth.uid()),
    public.audit_actor_name(),
    format('people_birthday %s', resolved_action),
    new.name,
    'birthday',
    null,
    '{}'::jsonb
  );
  return null;
end;
$$;

revoke all on function public.record_birthday_audit_event() from public, anon, authenticated;

drop trigger if exists audit_people_birthday on public.people;
create trigger audit_people_birthday
  after update of birthday_month, birthday_day, birthday_year on public.people
  for each row execute function public.record_birthday_audit_event();

-- The audit log's action list predates this file and knows nothing of an edit
-- that is neither an add nor a removal; 'restored' is reused for a correction
-- so no constraint has to change and no historical row is reinterpreted.

-- ---------------------------------------------------------------------------
-- 4. Saving a birthday
-- ---------------------------------------------------------------------------
-- Global Admin only, and enforced HERE rather than in the browser: a birthday
-- is somebody else's personal data, and the existing product rule is that one
-- person administers structural family information.
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
  -- Computed before the checks below rather than inline: a bare CASE inside an
  -- IF condition is not valid plpgsql, because the parser ends the condition at
  -- the CASE's own THEN.
  max_day integer;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to change a birthday'
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
  -- The CHECK constraint would catch this too; raising here means the person
  -- filling in the form is told which field is wrong. February allows 29: the
  -- birthday is real, and `birthday_occurrence_date` decides what a non-leap
  -- year does with it.
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
  from public, anon, authenticated;
grant execute on function public.set_person_birthday(uuid, smallint, smallint, smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Creating an event
-- ---------------------------------------------------------------------------
-- Migration 025 deliberately left `events` with no write policy and no write
-- grant for any browser session. That stays true: this is the only way in, it
-- checks the caller itself, and it is atomic — an event, its celebrant
-- recipient and its contributors are one transaction or none of them.
create or replace function public.create_event(
  p_name text,
  p_event_type text,
  p_event_date date,
  p_description text,
  p_celebrant_person_id uuid,
  /** People to seed as recipients, each starting at a zero budget. */
  p_recipient_person_ids uuid[],
  /** People to seed as contributors. */
  p_contributor_person_ids uuid[]
)
returns public.events
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_member_id uuid;
  saved_event public.events;
  -- Deliberately NOT called `person_id`: a plpgsql variable of that name would
  -- shadow the column of the same name in the INSERTs below, and PostgreSQL
  -- refuses the reference as ambiguous.
  target_person_id uuid;
  new_recipient_id uuid;
  clean_name text;
  clean_description text;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to create an event' using errcode = '42501';
  end if;
  current_member_id := public.current_app_member_id();
  if current_member_id is null then
    raise exception 'An active membership is required' using errcode = '42501';
  end if;

  clean_name := nullif(trim(coalesce(p_name, '')), '');
  if clean_name is null or length(clean_name) > 100 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid event name' using errcode = '23514';
  end if;
  if p_event_type not in ('christmas', 'birthday', 'easter', 'wedding', 'anniversary', 'other') then
    raise exception 'Choose a valid event type' using errcode = '23514';
  end if;
  if p_event_date is null then
    raise exception 'Choose the date this event is for' using errcode = '23514';
  end if;

  clean_description := nullif(trim(coalesce(p_description, '')), '');
  if clean_description is not null and length(clean_description) > 1000 then
    raise exception 'Keep the description under 1000 characters' using errcode = '23514';
  end if;

  if p_event_type = 'birthday' and p_celebrant_person_id is null then
    raise exception 'Choose whose birthday this is' using errcode = '23514';
  end if;
  if p_event_type = 'christmas' and p_celebrant_person_id is not null then
    raise exception 'A Christmas is not about one person' using errcode = '23514';
  end if;
  if p_celebrant_person_id is not null and not exists (
    select 1 from public.people where id = p_celebrant_person_id
  ) then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  insert into public.events (
    name, event_type, event_date, description, celebrant_person_id,
    year, status, created_by_app_member_id
  ) values (
    clean_name,
    p_event_type,
    p_event_date,
    clean_description,
    p_celebrant_person_id,
    -- Only Christmas carries a year, and it is the year of its own date, so
    -- the compatibility view from migration 025 keeps working unchanged.
    case when p_event_type = 'christmas' then extract(year from p_event_date)::integer else null end,
    'active',
    current_member_id
  )
  returning * into saved_event;

  -- Contributors first: a recipient's allocation plan has to name every active
  -- contributor, so they must exist before the first recipient does.
  foreach target_person_id in array coalesce(p_contributor_person_ids, array[]::uuid[])
  loop
    if not exists (select 1 from public.people where id = target_person_id) then
      raise exception 'A chosen contributor is not a family member' using errcode = 'P0002';
    end if;
    insert into public.contributors (christmas_event_id, person_id, active)
    values (saved_event.id, target_person_id, true)
    on conflict (christmas_event_id, person_id) do nothing;
  end loop;

  foreach target_person_id in array coalesce(p_recipient_person_ids, array[]::uuid[])
  loop
    if not exists (select 1 from public.people where id = target_person_id) then
      raise exception 'A chosen recipient is not a family member' using errcode = 'P0002';
    end if;
    insert into public.christmas_recipients (christmas_event_id, person_id, budget_pennies, active)
    values (saved_event.id, target_person_id, 0, true)
    on conflict (christmas_event_id, person_id) do nothing
    returning id into new_recipient_id;

    -- A zero budget with a zero plan for every contributor satisfies the
    -- recipient budget invariant from migration 012 immediately, so the event
    -- is valid the moment it is created rather than only once somebody sets a
    -- budget.
    if new_recipient_id is not null then
      insert into public.recipient_contributions (
        christmas_recipient_id, contributor_id, planned_amount_pennies
      )
      select new_recipient_id, contributor.id, 0
      from public.contributors as contributor
      where contributor.christmas_event_id = saved_event.id
        and contributor.active = true;
    end if;
  end loop;

  return saved_event;
end;
$$;

revoke all on function public.create_event(text, text, date, text, uuid, uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.create_event(text, text, date, text, uuid, uuid[], uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Editing and archiving an event
-- ---------------------------------------------------------------------------
-- The event's TYPE and its CELEBRANT are deliberately not editable. Both are
-- identity: changing them would silently reinterpret every purchase, plan and
-- balance already recorded against the event.
--
-- Changing a Birthday Event's date changes THAT YEAR'S occasion only. The
-- person's permanent birthday is a separate field, edited separately, and
-- correcting one never rewrites the other.
create or replace function public.update_event(
  p_event_id uuid,
  p_name text,
  p_event_date date,
  p_description text
)
returns public.events
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.events;
  saved_event public.events;
  clean_name text;
  clean_description text;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to change an event' using errcode = '42501';
  end if;

  select * into existing from public.events where id = p_event_id for update;
  if not found then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;

  clean_name := nullif(trim(coalesce(p_name, '')), '');
  if clean_name is null or length(clean_name) > 100 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid event name' using errcode = '23514';
  end if;
  if p_event_date is null then
    raise exception 'Choose the date this event is for' using errcode = '23514';
  end if;
  clean_description := nullif(trim(coalesce(p_description, '')), '');
  if clean_description is not null and length(clean_description) > 1000 then
    raise exception 'Keep the description under 1000 characters' using errcode = '23514';
  end if;

  update public.events
  set
    name = clean_name,
    event_date = p_event_date,
    description = clean_description,
    -- A Christmas stays identified by the year of its own date, so moving it
    -- keeps the compatibility view and the one-per-year rule honest.
    year = case when existing.event_type = 'christmas' then extract(year from p_event_date)::integer else year end,
    updated_at = now()
  where id = p_event_id
  returning * into saved_event;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, details
  ) values (
    'events', p_event_id, 'restored', (select auth.uid()), public.audit_actor_name(),
    'events updated', saved_event.name, 'updated', '{}'::jsonb
  );

  return saved_event;
end;
$$;

revoke all on function public.update_event(uuid, text, date, text) from public, anon, authenticated;
grant execute on function public.update_event(uuid, text, date, text) to authenticated;

-- Archiving hides an event from the primary list. It deletes NOTHING: every
-- purchase, allocation, payment, receipt and audit row is untouched, and the
-- event can be reopened.
create or replace function public.set_event_status(
  p_event_id uuid,
  p_status text
)
returns public.events
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_event public.events;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to archive an event' using errcode = '42501';
  end if;
  if p_status not in ('active', 'archived') then
    raise exception 'Choose whether the event is active or archived' using errcode = '23514';
  end if;

  update public.events
  set status = p_status, updated_at = now()
  where id = p_event_id
  returning * into saved_event;

  if not found then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;

  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, details
  ) values (
    'events', p_event_id,
    case when p_status = 'archived' then 'removed' else 'restored' end,
    (select auth.uid()), public.audit_actor_name(),
    format('events %s', case when p_status = 'archived' then 'archived' else 'reopened' end),
    saved_event.name, p_status, '{}'::jsonb
  );

  return saved_event;
end;
$$;

revoke all on function public.set_event_status(uuid, text) from public, anon, authenticated;
grant execute on function public.set_event_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Event contributors, named explicitly
-- ---------------------------------------------------------------------------
-- This is what retires the last "current Christmas" assumption: contributor
-- membership is edited against an EVENT the caller names, not against whichever
-- Christmas happens to be latest.
--
-- Retiring a contributor is a soft change, exactly as it always was: their
-- historical purchase allocations are snapshots and are never touched.
create or replace function public.set_event_contributor(
  p_event_id uuid,
  p_person_id uuid,
  p_active boolean
)
returns public.contributors
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_contributor public.contributors;
  planned_total bigint;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to change contributors' using errcode = '42501';
  end if;
  if not exists (select 1 from public.events where id = p_event_id) then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.people where id = p_person_id) then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  if not p_active then
    -- The same rule Family Access has always applied: somebody carrying part of
    -- a plan cannot simply vanish from it.
    select coalesce(sum(contribution.planned_amount_pennies), 0)
    into planned_total
    from public.recipient_contributions as contribution
    join public.contributors as contributor on contributor.id = contribution.contributor_id
    where contributor.christmas_event_id = p_event_id
      and contributor.person_id = p_person_id;

    if planned_total > 0 then
      raise exception 'Reassign this person''s planned amounts before removing them from the event'
        using errcode = '23514';
    end if;
  end if;

  insert into public.contributors (christmas_event_id, person_id, active)
  values (p_event_id, p_person_id, p_active)
  on conflict (christmas_event_id, person_id)
  do update set active = excluded.active
  returning * into saved_contributor;

  -- A newly active contributor must appear in every active recipient's plan, at
  -- zero, or the budget invariant from migration 012 would reject the next
  -- edit to any of them.
  if p_active then
    insert into public.recipient_contributions (
      christmas_recipient_id, contributor_id, planned_amount_pennies
    )
    select recipient.id, saved_contributor.id, 0
    from public.christmas_recipients as recipient
    where recipient.christmas_event_id = p_event_id
      and recipient.active = true
    on conflict (christmas_recipient_id, contributor_id) do nothing;
  end if;

  return saved_contributor;
end;
$$;

revoke all on function public.set_event_contributor(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_event_contributor(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Adding an existing family member as a recipient
-- ---------------------------------------------------------------------------
-- PEOPLE ARE GLOBAL. The existing recipient RPC creates a NEW person, which is
-- right for "add somebody the family has never bought for". This is the other
-- half: the same Paige who contributes to Christmas becomes the recipient of
-- her own birthday, with no second Paige anywhere.
create or replace function public.add_event_recipient(
  p_event_id uuid,
  p_person_id uuid
)
returns public.christmas_recipients
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_recipient public.christmas_recipients;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to add a recipient' using errcode = '42501';
  end if;
  if not exists (select 1 from public.events where id = p_event_id) then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.people where id = p_person_id) then
    raise exception 'That family member could not be found' using errcode = 'P0002';
  end if;

  insert into public.christmas_recipients (christmas_event_id, person_id, budget_pennies, active)
  values (p_event_id, p_person_id, 0, true)
  on conflict (christmas_event_id, person_id)
  do update set active = true
  returning * into saved_recipient;

  insert into public.recipient_contributions (
    christmas_recipient_id, contributor_id, planned_amount_pennies
  )
  select saved_recipient.id, contributor.id, 0
  from public.contributors as contributor
  where contributor.christmas_event_id = p_event_id
    and contributor.active = true
  on conflict (christmas_recipient_id, contributor_id) do nothing;

  return saved_recipient;
end;
$$;

revoke all on function public.add_event_recipient(uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_event_recipient(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. One Birthday Event per person per year
-- ---------------------------------------------------------------------------
-- Names are not identity: two events both called "Paige's Birthday 2027" are a
-- mistake, and so are two with different names for the same occasion. The
-- celebrant and the year of the occasion are what must be unique.
--
-- Archived events are excluded so a mistake can be archived and redone.
create unique index if not exists events_one_birthday_per_person_per_year_idx
  on public.events (celebrant_person_id, (extract(year from event_date)))
  where event_type = 'birthday' and status = 'active';

-- ---------------------------------------------------------------------------
-- 10. Birthday reminders
-- ---------------------------------------------------------------------------
-- ONE ROW PER (PERSON, OCCURRENCE YEAR, STAGE).
--
-- This is the whole of the "resets every year" requirement, and it is why no
-- job ever deletes anything. A boolean on `people` would have to be cleared
-- each January by something that runs — and if it did not run, or ran twice,
-- the family would either be silently un-remindable or reminded twice. An
-- occurrence-keyed row cannot have that problem: 2027 simply has no rows yet.
--
-- The unique constraint is the idempotence, not an application flag. Two
-- scheduler runs on the same day race to insert the same key; one wins, the
-- other conflicts and does nothing.
create table public.birthday_reminders (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  /** The calendar year of the birthday occurrence, not of the send. */
  occurrence_year smallint not null check (occurrence_year between 1900 and 2200),
  stage text not null check (stage in ('one_month', 'one_week', 'one_day')),
  /** The date the occurrence falls on, kept so history is readable later. */
  occurrence_date date not null,
  queued_at timestamptz not null default now(),
  unique (person_id, occurrence_year, stage)
);

create index birthday_reminders_occurrence_idx
  on public.birthday_reminders (occurrence_year, stage);

alter table public.birthday_reminders enable row level security;

-- No grants and no policies: the scheduler's secret-key client is the only
-- thing that touches this, exactly like `notification_events` and
-- `notification_outbox`. Nobody can fabricate a delivery record, and nobody can
-- erase one to make a reminder send twice.
revoke all privileges on table public.birthday_reminders from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. Which reminders are due
-- ---------------------------------------------------------------------------
-- Pure reading. The caller supplies TODAY as a real calendar date — the app
-- computes it in Europe/London — because a birthday is a calendar date and
-- deriving it from a UTC instant is exactly how a reminder lands on the wrong
-- day at 00:30 in summer.
--
-- "One month before" is CALENDAR arithmetic: the 6th of November is one month
-- after the 6th of October, whatever the month lengths. Where the target month
-- is short, Postgres clamps — one month before the 31st of March is the 28th of
-- February — which is the same clamping rule the occurrence date itself uses.
create or replace function public.due_birthday_reminders(p_today date)
returns table (
  person_id uuid,
  person_name text,
  occurrence_year smallint,
  occurrence_date date,
  stage text
)
language sql
stable
security definer
set search_path = ''
as $$
  with stages as (
    select * from (values
      ('one_month'::text, interval '1 month'),
      ('one_week', interval '7 days'),
      ('one_day', interval '1 day')
    ) as s(stage, lead_time)
  ),
  -- This year's occurrence and next year's, so a reminder due in late December
  -- for a January birthday is found without any special case.
  occurrences as (
    select
      person.id as person_id,
      person.name as person_name,
      candidate.occurrence_year::smallint as occurrence_year,
      public.birthday_occurrence_date(
        person.birthday_month, person.birthday_day, candidate.occurrence_year
      ) as occurrence_date
    from public.people as person
    cross join lateral (
      values
        (extract(year from p_today)::integer),
        (extract(year from p_today)::integer + 1)
    ) as candidate(occurrence_year)
    where person.birthday_month is not null
  )
  select
    occurrences.person_id,
    occurrences.person_name,
    occurrences.occurrence_year,
    occurrences.occurrence_date,
    stages.stage
  from occurrences
  cross join stages
  where
    -- Due exactly when today is the lead time before the occurrence. A run that
    -- misses a day does not silently send a stale reminder; the next stage
    -- still fires.
    (occurrences.occurrence_date - stages.lead_time)::date = p_today
    and not exists (
      select 1
      from public.birthday_reminders as sent
      where sent.person_id = occurrences.person_id
        and sent.occurrence_year = occurrences.occurrence_year
        and sent.stage = stages.stage
    );
$$;

revoke all on function public.due_birthday_reminders(date) from public, anon, authenticated;

-- Claim one reminder. Returns true only for the caller that won the insert, so
-- a repeated run — or two runs at once — sends exactly once.
create or replace function public.claim_birthday_reminder(
  p_person_id uuid,
  p_occurrence_year smallint,
  p_stage text,
  p_occurrence_date date
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_id uuid;
begin
  if p_stage not in ('one_month', 'one_week', 'one_day') then
    raise exception 'Unknown reminder stage' using errcode = '23514';
  end if;

  insert into public.birthday_reminders (person_id, occurrence_year, stage, occurrence_date)
  values (p_person_id, p_occurrence_year, p_stage, p_occurrence_date)
  on conflict (person_id, occurrence_year, stage) do nothing
  returning id into inserted_id;

  return inserted_id is not null;
end;
$$;

revoke all on function public.claim_birthday_reminder(uuid, smallint, text, date)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 12. Birthday reminders as a notification kind
-- ---------------------------------------------------------------------------
-- The EXISTING notification system carries these. No second outbox, no second
-- transport, no second Notification Centre. The three CHECK constraints that
-- enumerate kinds and categories are widened, and one preference column is
-- added so a member can turn birthday reminders off like anything else.
do $$
declare
  existing_constraint record;
begin
  for existing_constraint in
    select conname from pg_catalog.pg_constraint
    where conrelid = 'public.notification_outbox'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%payment_review%'
  loop
    execute format('alter table public.notification_outbox drop constraint %I', existing_constraint.conname);
  end loop;
  alter table public.notification_outbox
    add constraint notification_outbox_kind_check
    check (kind in ('purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review', 'birthday_reminder'));

  for existing_constraint in
    select conname from pg_catalog.pg_constraint
    where conrelid = 'public.notification_events'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%gift_status%'
  loop
    execute format('alter table public.notification_events drop constraint %I', existing_constraint.conname);
  end loop;
  alter table public.notification_events
    add constraint notification_events_kind_check
    check (kind in ('purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review', 'birthday_reminder'));

  for existing_constraint in
    select conname from pg_catalog.pg_constraint
    where conrelid = 'public.notifications'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%event_kind%'
  loop
    execute format('alter table public.notifications drop constraint %I', existing_constraint.conname);
  end loop;
  alter table public.notifications
    add constraint notifications_event_kind_check
    check (event_kind is null or event_kind in (
      'purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review', 'birthday_reminder'
    ));

  for existing_constraint in
    select conname from pg_catalog.pg_constraint
    where conrelid = 'public.notifications'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%money_owed_to_me%'
  loop
    execute format('alter table public.notifications drop constraint %I', existing_constraint.conname);
  end loop;
  alter table public.notifications
    add constraint notifications_category_check
    check (category in (
      'purchases', 'money_i_owe', 'money_owed_to_me', 'gift_ideas', 'gift_status', 'birthdays'
    ));
end;
$$;

-- Defaults to true, like every other switch: a member who has never opened the
-- Notifications screen still gets reminded about a birthday.
alter table public.notification_preferences
  add column if not exists birthdays boolean not null default true;

-- ---------------------------------------------------------------------------
-- 13. Assert the end state
-- ---------------------------------------------------------------------------
do $$
declare
  problems text[] := array[]::text[];
  required_function text;
begin
  foreach required_function in array array[
    'birthday_occurrence_date', 'set_person_birthday', 'create_event', 'update_event',
    'set_event_status', 'set_event_contributor', 'add_event_recipient',
    'due_birthday_reminders', 'claim_birthday_reminder', 'record_birthday_audit_event'
  ]
  loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = required_function
    ) then
      problems := problems || (required_function || ' is missing');
    end if;
  end loop;

  -- Every new entry point is a definer function with a pinned search path.
  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'set_person_birthday', 'create_event', 'update_event', 'set_event_status',
        'set_event_contributor', 'add_event_recipient', 'due_birthday_reminders',
        'claim_birthday_reminder', 'record_birthday_audit_event'
      )
      -- Postgres stores `set search_path = ''` as the setting `search_path=""`,
      -- so the prefix is what to look for rather than an exact string.
      and (
        not p.prosecdef
        or p.proconfig is null
        or not exists (
          select 1 from unnest(p.proconfig) as setting(value)
          where setting.value like 'search_path=%'
        )
      )
  ) then
    problems := problems || ('a new function is not a definer with a pinned search_path')::text;
  end if;

  -- Events remain write-protected: the RPCs are the only way in.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('events', 'birthday_reminders')
      and grantee in ('authenticated', 'anon', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    problems := problems || ('a browser role can write to events or birthday_reminders')::text;
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'birthday_reminders'
  ) then
    problems := problems || ('birthday_reminders has a policy; it should be server-only')::text;
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'public.birthday_reminders'::regclass) then
    problems := problems || ('row level security is off on birthday_reminders')::text;
  end if;

  -- The scheduler's two functions are never callable by a browser session.
  if exists (
    select 1
    from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('due_birthday_reminders', 'claim_birthday_reminder')
      and grantee in ('authenticated', 'anon', 'public')
  ) then
    problems := problems || ('a browser role can run the reminder scheduler')::text;
  end if;

  -- Birthday validity is structural.
  foreach required_function in array array[
    'people_birthday_complete_check', 'people_birthday_is_a_real_date_check',
    'people_birthday_year_sane_check'
  ]
  loop
    if not exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.people'::regclass and conname = required_function
    ) then
      problems := problems || (required_function || ' is missing');
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and indexname = 'events_one_birthday_per_person_per_year_idx'
  ) then
    problems := problems || ('one birthday event per person per year is not enforced')::text;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.notification_preferences'::regclass
      and attname = 'birthdays' and not attisdropped
  ) then
    problems := problems || ('the birthdays notification preference is missing')::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Checkpoint 4 did not install cleanly: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Birthdays, event administration and birthday reminders are installed. No event, birthday or financial row was created or changed.';
end;
$$;

notify pgrst, 'reload schema';
