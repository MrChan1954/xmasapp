-- Two-stage birthday reminders, and a way to remove an event that never held
-- anything.
--
-- WHY THIS IS A NEW MIGRATION RATHER THAN AN EDIT TO 026
--   026 introduced the three-stage reminder and the `create_event` entry point
--   the family has already used. Whatever the repository believes about what
--   has been applied, an event created through that function exists, which
--   means 026 is live. Editing it would put the database and the repository
--   into silent disagreement about what has run. So: a new migration, the next
--   number, adding and replacing rather than rewriting.
--
--   This file is also correct if 026 has NOT been applied: applying 026 and
--   then 027 leaves exactly the state 027 asserts at the end.
--
-- WHAT CHANGES
--   1. The one-month birthday reminder is retired. The dashboard now shows
--      upcoming birthdays directly from the permanent date, which is a better
--      long-range warning than a push notification a month out — it is there
--      whenever the family looks, and it costs nobody an interruption.
--
--      Only ONE WEEK BEFORE and ONE DAY BEFORE remain.
--
--   2. `delete_event_if_empty` — a physical delete, allowed ONLY for an event
--      that has never held anything worth keeping. An accidental test
--      occurrence should not become permanent family history; a real one must
--      never be deletable at all.
--
-- WHAT DOES NOT CHANGE
--   * No budget, plan, purchase, allocation, settlement, receipt or Owed value.
--     None of the functions that write them are redefined.
--   * No birthday is created, changed or cleared.
--   * No existing reminder row is rewritten or deleted. A one-month reminder
--     that has already been sent stays exactly as it is: it is history, and
--     history is not edited to make a new rule look tidy.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.birthday_reminders') is null then
    raise exception
      'Migration 026 has not been applied: public.birthday_reminders does not exist. Apply 026 first.';
  end if;
  if to_regclass('public.events') is null then
    raise exception
      'Migration 025 has not been applied: public.events does not exist.';
  end if;
  if to_regproc('public.due_birthday_reminders') is null then
    raise exception
      'Migration 026 has not been applied: public.due_birthday_reminders does not exist.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Retire the one-month stage
--
-- The stage list is enforced by a CHECK constraint written inline in 026, so
-- its name was chosen by PostgreSQL. It is found by what it says rather than by
-- a name this file guesses at.
--
-- HISTORY IS NOT REWRITTEN. If a one-month reminder was ever sent, its row
-- stays. The new constraint is then added NOT VALID, which refuses every new
-- one-month row while leaving the old ones untouched and readable. Where no
-- such row exists — the normal case — the constraint is added and validated
-- immediately, so the database refuses the value outright.
-- ---------------------------------------------------------------------------

do $$
declare
  legacy_rows bigint;
  constraint_name text;
begin
  select count(*) into legacy_rows
  from public.birthday_reminders
  where stage = 'one_month';

  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.birthday_reminders'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%one_month%'
  limit 1;

  if constraint_name is not null then
    execute format(
      'alter table public.birthday_reminders drop constraint %I',
      constraint_name
    );
  end if;

  -- Already replaced by an earlier run of this migration.
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.birthday_reminders'::regclass
      and conname = 'birthday_reminders_stage_is_week_or_day_check'
  ) then
    raise notice 'Reminder stages were already reduced to one_week and one_day.';
    return;
  end if;

  if legacy_rows = 0 then
    alter table public.birthday_reminders
      add constraint birthday_reminders_stage_is_week_or_day_check
      check (stage in ('one_week', 'one_day'));
    raise notice 'Reminder stages reduced to one_week and one_day. No one_month row existed.';
  else
    -- NOT VALID: enforced for every INSERT and UPDATE from now on, and never
    -- applied retrospectively to the % rows already written.
    alter table public.birthday_reminders
      add constraint birthday_reminders_stage_is_week_or_day_check
      check (stage in ('one_week', 'one_day')) not valid;
    raise notice
      'Reminder stages reduced to one_week and one_day. % historical one_month row(s) were left untouched.',
      legacy_rows;
  end if;
end;
$$;

comment on constraint birthday_reminders_stage_is_week_or_day_check on public.birthday_reminders is
  'Two stages only: one week before and one day before. The one-month reminder was retired in migration 027 because the dashboard shows upcoming birthdays from the permanent date, which is a better long-range warning than an interruption.';

-- The due list, with the one-month arm removed.
--
-- Everything else about it is unchanged: it is still driven by the date it is
-- given rather than a hidden clock, it still considers this year's occurrence
-- and next year's so a January birthday is found from the previous December,
-- and it still excludes anything already claimed.
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
      ('one_week'::text, interval '7 days'),
      ('one_day', interval '1 day')
    ) as s(stage, lead_time)
  ),
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

comment on function public.due_birthday_reminders(date) is
  'Birthday reminders due on the given day: one week before and one day before, and nothing else. Server-only; revoked from every browser role.';

-- The claim function keeps its own opinion about which stages exist, so a
-- caller cannot claim a stage the sweep would never produce.
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
  claimed_id uuid;
begin
  if p_stage not in ('one_week', 'one_day') then
    raise exception 'Unknown reminder stage: %', p_stage using errcode = '22023';
  end if;

  insert into public.birthday_reminders (person_id, occurrence_year, stage, occurrence_date)
  values (p_person_id, p_occurrence_year, p_stage, p_occurrence_date)
  on conflict (person_id, occurrence_year, stage) do nothing
  returning id into claimed_id;

  -- True only for the caller that won the insert. A repeat run, or two runs at
  -- once, claims nothing and therefore sends nothing.
  return claimed_id is not null;
end;
$$;

revoke all on function public.claim_birthday_reminder(uuid, smallint, text, date)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Deleting an event that never held anything
--
-- THE RULE, STATED ONCE
--   An event may be physically deleted ONLY while it has no purchases, no
--   purchase allocations, no payments, no payment receipts (which is where a
--   confirmation or a rejection is recorded) and no gift ideas. The moment any
--   of those exists, the event is history and the only way to take it off the
--   list is to ARCHIVE it.
--
-- WHY A FUNCTION AND NOT A DELETE POLICY
--   `events` has no delete grant for any browser role and will not get one. The
--   check has to run in the same statement as the delete, or a row could be
--   written between the check and the delete. A SECURITY DEFINER function that
--   checks and deletes together is that statement.
--
-- WHAT THE DELETE TAKES WITH IT
--   Only setup rows, and only by the cascades that already existed:
--     events -> christmas_recipients -> recipient_contributions
--     events -> contributors        -> recipient_contributions
--   `purchases` and `settlements` reference their parents with ON DELETE
--   RESTRICT, so even if the checks below were wrong, the database would refuse
--   the delete rather than lose money. `gift_ideas` cascades from recipients,
--   which is exactly why it is checked explicitly here.
--
-- WHAT IT DOES NOT TAKE
--   The audit log. `audit_log.record_id` is a plain uuid with no foreign key,
--   so the record that this event existed and was removed survives the event.
-- ---------------------------------------------------------------------------

create or replace function public.delete_event_if_empty(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_event public.events;
  blocker text;
  blocking_count bigint;
begin
  if not public.is_app_admin() then
    raise exception 'Only the Global Admin can delete an event' using errcode = '42501';
  end if;

  select * into target_event from public.events where id = p_event_id;
  if not found then
    raise exception 'That event could not be found' using errcode = 'P0002';
  end if;

  -- Each category is counted rather than merely tested, so the refusal can say
  -- what is actually there. The order is the order a reader would care about:
  -- money first.
  select 'purchases', count(*) into blocker, blocking_count
  from public.purchases as purchase
  join public.christmas_recipients as recipient on recipient.id = purchase.christmas_recipient_id
  where recipient.christmas_event_id = p_event_id;
  if blocking_count = 0 then
    select 'purchase allocations', count(*) into blocker, blocking_count
    from public.purchase_allocations as allocation
    join public.purchases as purchase on purchase.id = allocation.purchase_id
    join public.christmas_recipients as recipient on recipient.id = purchase.christmas_recipient_id
    where recipient.christmas_event_id = p_event_id;
  end if;
  if blocking_count = 0 then
    select 'payments', count(*) into blocker, blocking_count
    from public.settlements
    where christmas_event_id = p_event_id;
  end if;
  if blocking_count = 0 then
    -- Confirmations and rejections are both rows in `payment_receipts`, which
    -- carries its own event id: there is no separate confirmations table.
    select 'payment confirmations or rejections', count(*) into blocker, blocking_count
    from public.payment_receipts
    where christmas_event_id = p_event_id;
  end if;
  if blocking_count = 0 then
    select 'gift ideas', count(*) into blocker, blocking_count
    from public.gift_ideas as idea
    join public.christmas_recipients as recipient on recipient.id = idea.christmas_recipient_id
    where recipient.christmas_event_id = p_event_id;
  end if;

  if blocking_count > 0 then
    raise exception
      'This event has % % and cannot be deleted. Archive it instead — archiving keeps every record.',
      blocking_count, blocker
      using errcode = '23503';
  end if;

  -- Recorded BEFORE the delete, so the log survives whatever the delete does.
  insert into public.audit_log (
    table_name, record_id, action, actor_user_id, actor_name,
    summary, subject, context, amount_pennies, details
  )
  values (
    'events',
    target_event.id,
    'removed',
    (select auth.uid()),
    public.audit_actor_name(),
    'events removed',
    target_event.name,
    'event',
    null,
    jsonb_build_object(
      'event_type', target_event.event_type,
      'event_date', target_event.event_date,
      'reason', 'empty occurrence deleted by Global Admin'
    )
  );

  -- Cascades take the recipients, contributors and their zero-value plan rows.
  delete from public.events where id = p_event_id;
  return true;
end;
$$;

revoke all on function public.delete_event_if_empty(uuid) from public, anon;
grant execute on function public.delete_event_if_empty(uuid) to authenticated;

comment on function public.delete_event_if_empty(uuid) is
  'Physically delete an event that has never held a purchase, allocation, payment, receipt, confirmation or gift idea. Global Admin only, checked here. Anything with activity must be archived instead.';

-- ---------------------------------------------------------------------------
-- 3. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  stage_definition text;
  legacy_rows bigint;
begin
  -- The stage constraint says what it should say.
  select pg_get_constraintdef(oid) into stage_definition
  from pg_constraint
  where conrelid = 'public.birthday_reminders'::regclass
    and conname = 'birthday_reminders_stage_is_week_or_day_check';

  if stage_definition is null then
    problems := problems || ('the two-stage reminder constraint is missing')::text;
  elsif stage_definition ilike '%one_month%' then
    problems := problems || ('the reminder constraint still allows one_month')::text;
  end if;

  -- The sweep cannot produce a one-month reminder.
  if exists (
    select 1 from pg_proc
    where proname = 'due_birthday_reminders'
      and pronamespace = 'public'::regnamespace
      and prosrc ilike '%one_month%'
  ) then
    problems := problems || ('due_birthday_reminders still lists the one_month stage')::text;
  end if;

  -- A new one-month reminder is refused.
  begin
    insert into public.birthday_reminders (person_id, occurrence_year, stage, occurrence_date)
    select id, 1901::smallint, 'one_month', date '1901-01-01'
    from public.people
    limit 1;
    problems := problems || ('a one_month reminder was accepted')::text;
    raise exception 'rollback the probe';
  exception
    when check_violation then null;      -- expected
    when raise_exception then
      if sqlerrm <> 'rollback the probe' then raise; end if;
    when no_data_found then null;        -- no people at all: nothing to probe with
  end;

  -- History was not touched.
  select count(*) into legacy_rows from public.birthday_reminders where stage = 'one_month';
  if legacy_rows > 0 then
    raise notice '% historical one_month reminder(s) are preserved unchanged.', legacy_rows;
  end if;

  -- The delete function exists, is pinned, and is not granted to anon.
  if not exists (
    select 1 from pg_proc
    where proname = 'delete_event_if_empty'
      and pronamespace = 'public'::regnamespace
      and prosecdef
      and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as setting
                  where setting like 'search_path=%')
  ) then
    problems := problems || ('delete_event_if_empty is missing, not definer, or not search_path-pinned')::text;
  end if;

  if has_function_privilege('anon', 'public.delete_event_if_empty(uuid)', 'execute') then
    problems := problems || ('delete_event_if_empty is executable by anon')::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 027 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Birthday reminders are now one week and one day only, and an empty event can be deleted. No birthday, event or financial row was created or changed.';
end;
$$;
