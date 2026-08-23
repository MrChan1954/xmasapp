-- The monthly birthday budgeting reminder.
--
-- TWO DIFFERENT WARNINGS, DELIBERATELY NOT MIXED
--
--   1. THE BIRTHDAY IS COMING.  One week before, one day before. Driven by the
--      PERMANENT date on `people`, so it works for anybody whose birthday is
--      recorded, whether or not the family has planned anything. That is
--      migration 027, and nothing here changes it.
--
--   2. YOU HAVE MONEY PUT ASIDE FOR IT.  The 1st of the month. Driven by the
--      CONTRIBUTION PLAN inside that year's birthday occurrence, because that
--      is the only place a per-person amount exists.
--
--   A permanent date is enough to say "Paige's birthday is next week". It is
--   not enough to say "you have thirty pounds towards it" -- that number lives
--   in `recipient_contributions`, and if there is no occurrence and no plan
--   then there is no number and this file invents nothing.
--
-- WHERE THE AMOUNT COMES FROM
--   `recipient_contributions.planned_amount_pennies`, exactly as the Owed
--   engine and the People screen read it. Nothing here divides a budget,
--   assumes an equal split, or names a family member. Integer pennies
--   throughout, summed in the database.
--
-- WHO IS TOLD
--   Every contributor with a POSITIVE planned amount towards a birthday falling
--   in that calendar month -- except the person whose birthday it is. Nobody is
--   reminded to club together for their own present, and nobody is told about
--   money they are not responsible for.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates no event, no occurrence, no birthday and no plan.
--   * It changes no budget, purchase, allocation, settlement, receipt or Owed
--     value, and redefines none of the functions that write them.
--   * It touches Christmas 2026 in no way whatsoever.
--
-- MIGRATIONS 025-028 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.birthday_reminders') is null then
    raise exception 'Migration 026 has not been applied: public.birthday_reminders does not exist.';
  end if;
  if to_regclass('public.recipient_contributions') is null then
    raise exception 'public.recipient_contributions is missing.';
  end if;
  if to_regclass('public.notification_outbox') is null then
    raise exception 'Migration 023 has not been applied: public.notification_outbox does not exist.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. What was sent, and to whom
--
-- The durable claim. One row per contributor per calendar month, which IS the
-- dedupe identity: a retried sweep, two sweeps at once, or a scheduler that
-- fires twice on the 1st all converge on one row and therefore one send.
--
-- It also records the amount the person was told, so "what did the app say to
-- me on the 1st of November" has an answer that does not depend on the plan
-- staying unchanged afterwards.
--
-- Server-only, like `birthday_reminders`: RLS on, no policy, no grant. A member
-- has no reason to read the table and no way to forge a row.
-- ---------------------------------------------------------------------------

create table if not exists public.birthday_budget_summaries (
  id uuid primary key default gen_random_uuid(),
  contributor_person_id uuid not null references public.people(id) on delete cascade,
  /** The calendar month the money is for, in the family's own timezone. */
  budget_month text not null
    check (budget_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  /** What the person was told, in integer pennies. Never zero: a nothing is not worth a notification. */
  total_pennies integer not null check (total_pennies > 0),
  birthday_count smallint not null check (birthday_count > 0),
  /**
   * The birthdays this covered, as claimed:
   *   [{ "celebrant_name": "...", "event_date": "2026-11-06", "planned_amount_pennies": 3000 }]
   *
   * Stored rather than re-derived, for two reasons. The notification dispatcher
   * reads its subjects with a plain table read -- its client is deliberately
   * `{ from }` and nothing else, so the whole pipeline cannot call a function or
   * write anything -- and the message should say what was true when the month
   * opened, not what the plan happens to be when the outbox drains.
   */
  lines jsonb not null
    check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) > 0),
  queued_at timestamptz not null default now(),
  unique (contributor_person_id, budget_month)
);

comment on table public.birthday_budget_summaries is
  'One monthly birthday-budget reminder per contributor per month. The unique key IS the dedupe identity, so a retried sweep sends nothing twice.';

alter table public.birthday_budget_summaries enable row level security;
revoke all privileges on table public.birthday_budget_summaries from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. What is due on the 1st
--
-- One row per (contributor, birthday) so the caller can write a summary that
-- names each birthday and its amount. Aggregation into a per-person total
-- happens in the app, from these rows, so the wording and the arithmetic are
-- reading the same numbers.
--
-- ONLY ON THE 1st. The day check is here rather than in the caller, so a sweep
-- run on any other day produces nothing at all and cannot be made to.
-- ---------------------------------------------------------------------------

create or replace function public.due_birthday_budget_summaries(p_today date)
returns table (
  contributor_person_id uuid,
  contributor_name text,
  celebrant_person_id uuid,
  celebrant_name text,
  event_id uuid,
  event_date date,
  planned_amount_pennies integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    contributor_person.id as contributor_person_id,
    contributor_person.name as contributor_name,
    celebrant.id as celebrant_person_id,
    celebrant.name as celebrant_name,
    event.id as event_id,
    event.event_date,
    sum(contribution.planned_amount_pennies)::integer as planned_amount_pennies
  from public.events as event
  join public.people as celebrant
    on celebrant.id = event.celebrant_person_id
  join public.christmas_recipients as recipient
    on recipient.christmas_event_id = event.id
   and recipient.active = true
  join public.recipient_contributions as contribution
    on contribution.christmas_recipient_id = recipient.id
  join public.contributors as contributor
    on contributor.id = contribution.contributor_id
   and contributor.active = true
  join public.people as contributor_person
    on contributor_person.id = contributor.person_id
  where
    -- The 1st, and only the 1st.
    extract(day from p_today) = 1
    and event.event_type = 'birthday'
    and event.status = 'active'
    -- The birthday falls in THIS calendar month. December's sweep does not
    -- reach into January; January's own sweep does that on the 1st.
    and date_trunc('month', event.event_date) = date_trunc('month', p_today)
    -- Nobody clubs together for their own present.
    and contributor_person.id <> event.celebrant_person_id
    -- And nobody is claimed against this month twice.
    and not exists (
      select 1
      from public.birthday_budget_summaries as sent
      where sent.contributor_person_id = contributor_person.id
        and sent.budget_month = to_char(p_today, 'YYYY-MM')
    )
  group by
    contributor_person.id, contributor_person.name,
    celebrant.id, celebrant.name,
    event.id, event.event_date
  -- A plan of zero is not a reminder. This is applied AFTER the sum, so a
  -- contributor split across two recipients of one birthday is judged on what
  -- they actually owe towards it.
  having sum(contribution.planned_amount_pennies) > 0
  order by event.event_date, celebrant.name;
$$;

revoke all on function public.due_birthday_budget_summaries(date) from public, anon, authenticated;

comment on function public.due_birthday_budget_summaries(date) is
  'Contributors with money planned towards a birthday in the given month, on the 1st of that month only. Server-only; revoked from every browser role.';

-- ---------------------------------------------------------------------------
-- 3. Claim one contributor's month
--
-- Returns the row only for the caller that won the insert, so a repeat run --
-- or two runs at once -- sends exactly once.
-- ---------------------------------------------------------------------------

create or replace function public.claim_birthday_budget_summary(
  p_contributor_person_id uuid,
  p_budget_month text,
  p_total_pennies integer,
  p_birthday_count smallint,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  if p_budget_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Budget month must look like YYYY-MM' using errcode = '22023';
  end if;
  if p_total_pennies is null or p_total_pennies <= 0 then
    raise exception 'A budget reminder needs a positive amount' using errcode = '23514';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A budget reminder needs the birthdays it covers' using errcode = '23514';
  end if;
  -- The total must be the sum of the lines. A summary whose figure disagrees
  -- with its own list is worse than no summary.
  if p_total_pennies <> (
    select coalesce(sum((line ->> 'planned_amount_pennies')::integer), 0)
    from jsonb_array_elements(p_lines) as line
  ) then
    raise exception 'The total does not match the birthdays it lists' using errcode = '23514';
  end if;

  insert into public.birthday_budget_summaries (
    contributor_person_id, budget_month, total_pennies, birthday_count, lines
  )
  values (p_contributor_person_id, p_budget_month, p_total_pennies, p_birthday_count, p_lines)
  on conflict (contributor_person_id, budget_month) do nothing
  returning id into claimed_id;

  -- Null for the caller that lost the race. Nothing to send.
  return claimed_id;
end;
$$;

revoke all on function public.claim_birthday_budget_summary(uuid, text, integer, smallint, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. A new notification kind
--
-- It reuses the "birthdays" preference category: somebody who has turned
-- birthday notifications off does not want this one either.
-- ---------------------------------------------------------------------------

do $$
declare
  existing_constraint record;
  kinds constant text :=
    $list$'purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review', 'birthday_reminder', 'birthday_budget_month'$list$;
begin
  for existing_constraint in
    select conname, conrelid::regclass::text as table_name
    from pg_catalog.pg_constraint
    where conrelid in (
        'public.notification_outbox'::regclass,
        'public.notification_events'::regclass
      )
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%birthday_reminder%'
  loop
    execute format('alter table %s drop constraint %I', existing_constraint.table_name, existing_constraint.conname);
  end loop;

  execute format(
    'alter table public.notification_outbox add constraint notification_outbox_kind_check check (kind in (%s))',
    kinds
  );
  execute format(
    'alter table public.notification_events add constraint notification_events_kind_check check (kind in (%s))',
    kinds
  );

  for existing_constraint in
    select conname, conrelid::regclass::text as table_name
    from pg_catalog.pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%event_kind%'
  loop
    execute format('alter table %s drop constraint %I', existing_constraint.table_name, existing_constraint.conname);
  end loop;

  execute format(
    'alter table public.notifications add constraint notifications_event_kind_check check (event_kind is null or event_kind in (%s))',
    kinds
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
begin
  if to_regclass('public.birthday_budget_summaries') is null then
    problems := problems || ('birthday_budget_summaries is missing')::text;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'birthday_budget_summaries'
  ) then
    problems := problems || ('birthday_budget_summaries has a policy, so it is readable')::text;
  end if;

  if has_table_privilege('authenticated', 'public.birthday_budget_summaries', 'select') then
    problems := problems || ('birthday_budget_summaries is granted to authenticated')::text;
  end if;

  -- Every function is definer, pinned, and server-only.
  if not exists (
    select 1 from pg_proc
    where proname in ('due_birthday_budget_summaries', 'claim_birthday_budget_summary')
      and pronamespace = 'public'::regnamespace
      and prosecdef
      and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as setting
                  where setting like 'search_path=%')
    having count(*) = 2
  ) then
    problems := problems || ('a budget function is missing, not definer, or not search_path-pinned')::text;
  end if;

  if has_function_privilege('authenticated', 'public.due_birthday_budget_summaries(date)', 'execute')
    or has_function_privilege('authenticated', 'public.claim_birthday_budget_summary(uuid, text, integer, smallint, jsonb)', 'execute') then
    problems := problems || ('a budget function is executable by a browser session')::text;
  end if;

  -- The new kind is accepted, and the old ones still are.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notification_outbox'::regclass
      and conname = 'notification_outbox_kind_check'
      and pg_get_constraintdef(oid) like '%birthday_budget_month%'
      and pg_get_constraintdef(oid) like '%birthday_reminder%'
      and pg_get_constraintdef(oid) like '%purchase%'
  ) then
    problems := problems || ('the outbox does not accept birthday_budget_month alongside the existing kinds')::text;
  end if;

  -- The week and day reminders are untouched.
  if exists (
    select 1 from pg_proc
    where proname = 'due_birthday_reminders'
      and pronamespace = 'public'::regnamespace
      and prosrc like '%one_month%'
  ) then
    problems := problems || ('due_birthday_reminders changed')::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 029 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'The monthly birthday budget reminder is installed. No event, birthday, plan or financial row was created or changed.';
end;
$$;
