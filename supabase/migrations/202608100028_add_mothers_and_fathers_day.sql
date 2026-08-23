-- Mother's Day and Father's Day as first-class occasions.
--
-- WHY A MIGRATION IS NEEDED AT ALL
--   `events.event_type` is a CHECK constraint enumerating the occasions this
--   family plans, and `create_event` keeps a second copy of that list inside
--   itself. Migration 025 wrote the first and 026 the second; neither includes
--   these two, so the database would refuse them however the form was filled in.
--
--   Both gates are widened here. The runtime preflight is what proved the second
--   one existed: the constraint accepted the new types and the RPC still
--   answered "Choose a valid event type".
--
-- WHY NOT JUST USE 'other' WITH THE NAME "Mother's Day"
--   Because they recur. Every year the family plans them again, and every year
--   they want the right date suggested, the right icon on the card and the right
--   grouping on the dashboard. A type carries all of that; a name carries none
--   of it, and cannot be queried or reasoned about without string matching that
--   breaks the first time somebody omits the apostrophe.
--
-- UK DATES, NOT AMERICAN ONES
--   Mother's Day here is MOTHERING SUNDAY: the fourth Sunday of Lent, three
--   weeks before Easter. Father's Day is the third Sunday in June. The dates are
--   computed by the app and offered on the form; nothing is stored here.
--
-- WHAT THIS DOES NOT DO
--   * It creates no event, and names no recipient. Who a Mother's Day is for is
--     data the Global Admin chooses, not a rule in the schema.
--   * It changes no budget, plan, purchase, allocation, settlement, receipt or
--     Owed value.
--   * It contains no statement that can delete an event.
--   * It touches Christmas 2026 in no way whatsoever.
--
-- MIGRATIONS 025, 026 AND 027 ARE LIVE AND ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.events') is null then
    raise exception 'Migration 025 has not been applied: public.events does not exist.';
  end if;
  if to_regproc('public.create_event') is null then
    raise exception 'Migration 026 has not been applied: public.create_event does not exist.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Widen the occasion list on the table
--
-- The constraint was written inline by migration 025, so PostgreSQL chose its
-- name. It is found by what it says rather than by a name this file guesses at,
-- and the replacement is validated immediately: every existing row already holds
-- one of the original six values, so there is nothing to fail.
-- ---------------------------------------------------------------------------

do $$
declare
  constraint_name text;
  unknown_types text;
begin
  -- Nothing here may run against rows this list would reject.
  select string_agg(distinct event_type, ', ') into unknown_types
  from public.events
  where event_type not in (
    'christmas', 'birthday', 'mothers_day', 'fathers_day',
    'easter', 'wedding', 'anniversary', 'other'
  );
  if unknown_types is not null then
    raise exception 'Existing events use unrecognised types: %. Widen this list before continuing.', unknown_types;
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass
      and conname = 'events_event_type_includes_mothers_and_fathers_day_check'
  ) then
    raise notice 'Mother''s Day and Father''s Day are already accepted event types.';
    return;
  end if;

  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.events'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%event_type%'
    and pg_get_constraintdef(oid) like '%anniversary%'
  limit 1;

  if constraint_name is not null then
    execute format('alter table public.events drop constraint %I', constraint_name);
  end if;

  alter table public.events
    add constraint events_event_type_includes_mothers_and_fathers_day_check
    check (event_type in (
      'christmas', 'birthday', 'mothers_day', 'fathers_day',
      'easter', 'wedding', 'anniversary', 'other'
    ));

  raise notice 'Mother''s Day and Father''s Day are now accepted event types.';
end;
$$;

comment on constraint events_event_type_includes_mothers_and_fathers_day_check on public.events is
  'The occasions this family plans. Mother''s Day is Mothering Sunday in the UK, and Father''s Day is the third Sunday in June; both recur, which is why each is a type rather than a name.';

-- ---------------------------------------------------------------------------
-- 2. Neither new occasion is about one named person
--
-- The same rule Christmas has had since 025. Who the gifts are FOR is recorded
-- as recipients, chosen by the Global Admin, so the app can never assume Mum or
-- Dad -- there is nowhere to put the assumption.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass
      and conname = 'events_celebrant_only_for_person_events_check'
  ) then
    raise notice 'The celebrant rule for the new types is already in place.';
    return;
  end if;

  alter table public.events
    add constraint events_celebrant_only_for_person_events_check
    check (event_type not in ('mothers_day', 'fathers_day') or celebrant_person_id is null);
end;
$$;

comment on constraint events_celebrant_only_for_person_events_check on public.events is
  'Mother''s Day and Father''s Day are not about one named person: who they are for is chosen as recipients.';

-- ---------------------------------------------------------------------------
-- 3. `create_event` keeps its own list, so it has to be widened too
--
-- The body below is COPIED FROM MIGRATION 026 and differs in exactly two places,
-- both marked. Nothing else changes: the same Global Admin check, the same
-- membership check, the same name, date and description validation, the same
-- zero-budget seeding that satisfies migration 012's invariant, the same return
-- value.
-- ---------------------------------------------------------------------------

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
  -- CHANGED IN 028: 'mothers_day' and 'fathers_day' added. Everything else in
  -- this function is byte-for-byte what migration 026 installed.
  if p_event_type not in (
    'christmas', 'birthday', 'mothers_day', 'fathers_day',
    'easter', 'wedding', 'anniversary', 'other'
  ) then
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
  -- ADDED IN 028. Who a Mother's Day or Father's Day is for is recorded as
  -- recipients, chosen by the Global Admin. The app must never assume Mum or
  -- Dad, so there is nowhere to put that assumption.
  if p_event_type in ('mothers_day', 'fathers_day') and p_celebrant_person_id is not null then
    raise exception 'Choose who this event is buying for as a recipient, not a celebrant'
      using errcode = '23514';
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

revoke all on function public.create_event(text, text, date, text, uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.create_event(text, text, date, text, uuid, uuid[], uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  definition text;
begin
  select pg_get_constraintdef(oid) into definition
  from pg_constraint
  where conrelid = 'public.events'::regclass
    and conname = 'events_event_type_includes_mothers_and_fathers_day_check';

  if definition is null then
    problems := problems || ('the widened event_type constraint is missing')::text;
  else
    if definition not like '%mothers_day%' then
      problems := problems || ('mothers_day is not an accepted event type')::text;
    end if;
    if definition not like '%fathers_day%' then
      problems := problems || ('fathers_day is not an accepted event type')::text;
    end if;
    -- Everything that was allowed before is still allowed.
    if definition not like '%christmas%' or definition not like '%birthday%'
      or definition not like '%easter%' or definition not like '%wedding%'
      or definition not like '%anniversary%' or definition not like '%other%' then
      problems := problems || ('the widened constraint dropped an occasion that was previously allowed')::text;
    end if;
  end if;

  -- create_event knows the new types too.
  if not exists (
    select 1 from pg_proc
    where proname = 'create_event'
      and pronamespace = 'public'::regnamespace
      and prosrc like '%mothers_day%'
      and prosrc like '%fathers_day%'
  ) then
    problems := problems || ('create_event still refuses the new occasions')::text;
  end if;

  -- And it is still the guarded function it was.
  if not exists (
    select 1 from pg_proc
    where proname = 'create_event'
      and pronamespace = 'public'::regnamespace
      and prosecdef
      and prosrc like '%is_app_admin()%'
      and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as setting
                  where setting like 'search_path=%')
  ) then
    problems := problems || ('create_event lost its Global Admin check, its definer rights or its search_path')::text;
  end if;

  if has_function_privilege('anon', 'public.create_event(text, text, date, text, uuid, uuid[], uuid[])', 'execute') then
    problems := problems || ('create_event is executable by anon')::text;
  end if;

  -- An unknown type is still refused. The insert is EXPECTED to raise; if it
  -- does not, raising here aborts the migration and rolls the probe back, so
  -- this file never needs a statement that can remove an event.
  begin
    insert into public.events (name, event_type, event_date)
    values ('probe', 'halloween', date '2099-10-31');
    raise exception 'MIGRATION 028 PROBE: an unrecognised event type was accepted';
  exception
    when check_violation then null; -- expected
  end;

  -- A Mother's Day with a celebrant is refused, the same way.
  begin
    insert into public.events (name, event_type, event_date, celebrant_person_id)
    select 'probe', 'mothers_day', date '2099-03-01', id from public.people limit 1;
    if found then
      raise exception 'MIGRATION 028 PROBE: a Mother''s Day was accepted with a celebrant';
    end if;
  exception
    when check_violation then null; -- expected
  end;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 028 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Mother''s Day and Father''s Day are available. No event, birthday or financial row was created or changed.';
end;
$$;
