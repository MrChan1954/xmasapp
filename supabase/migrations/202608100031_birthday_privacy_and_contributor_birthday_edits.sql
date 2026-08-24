-- Birthday self-privacy, and who may maintain a permanent birthday date.
--
-- TWO CHANGES, ONE IDEA: a birthday belongs to the person it is about, and the
-- planning for it belongs to everybody else.
--
--   1. YOU CANNOT SEE YOUR OWN BIRTHDAY PLANNING.
--      Not the event, not the budget, not the contributors, not the ideas, not
--      the purchases, not the money. This beats Global Admin: the point of the
--      rule is the surprise, and an admin has a birthday like anybody else.
--
--      Until now every planning table was readable by `is_active_app_member()`,
--      so the celebrant could read all of it -- through the app, or by asking
--      PostgREST directly with the session they already hold. A screen that
--      merely declined to render it would have been decoration. This is
--      therefore enforced in ROW LEVEL SECURITY, where the browser cannot go
--      round it.
--
--   2. A FAMILY CONTRIBUTOR MAY MAINTAIN BIRTHDAY DATES.
--      Recording that somebody's birthday is the 6th of November is family
--      admin, not financial administration, and funnelling it through one
--      Global Admin makes the calendar go stale. Contributors -- the people who
--      already share the cost of gifts -- may now do it too.
--
--      This grants NOTHING ELSE. It widens exactly one function. A contributor
--      still cannot create events, move money, change budgets, manage
--      contributors or touch anybody's membership.
--
-- MIGRATIONS 001-030 ARE APPLIED AND ARE NOT EDITED.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes and rewrites no row of family data. Every statement
--     below is a policy, a function or a grant.
--   * It changes no budget, plan, purchase, allocation, settlement, receipt or
--     Owed value, and redefines none of the functions that write them.
--   * It touches Christmas 2026 in no way whatsoever: every guard it adds is
--     conditional on `event_type = 'birthday'`.

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
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'people' and column_name = 'is_family_contributor'
  ) then
    raise exception 'Migration 030 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Who is the caller, as a PERSON
--
-- `current_app_member_id()` already answers "which membership is this". This
-- answers "which family member is this", which is what a birthday is about: the
-- celebrant is a person, and the reader is a person, and the rule compares the
-- two.
--
-- SECURITY DEFINER because it reads `app_members`, which a member may only read
-- their own row of. Definer + a pinned empty search_path is the same shape as
-- `is_app_admin()` and `current_app_member_id()` from migration 006.
-- ---------------------------------------------------------------------------

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
  limit 1;
$$;

revoke all on function public.current_person_id() from public, anon;
grant execute on function public.current_person_id() to authenticated;

comment on function public.current_person_id() is
  'The family member behind the calling session, or null. Null for a signed-out visitor, an inactive membership, or a membership with no person linked.';

-- ---------------------------------------------------------------------------
-- 2. Is the caller one of the family's contributors?
--
-- Eligibility comes from `people.is_family_contributor`, which migration 030
-- backfilled from who already contributes and which the Global Admin maintains.
-- No name is mentioned here and none can be: this is a join, not a list.
-- ---------------------------------------------------------------------------

create or replace function public.is_family_contributor_member()
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
      and p.is_family_contributor
  );
$$;

revoke all on function public.is_family_contributor_member() from public, anon;
grant execute on function public.is_family_contributor_member() to authenticated;

comment on function public.is_family_contributor_member() is
  'Is the calling session one of the family''s contributors? Eligibility only -- it confers no administrative right beyond the ones that name it explicitly.';

-- ---------------------------------------------------------------------------
-- 3. Is this row part of the reader's OWN birthday?
--
-- Three functions rather than one, because the planning tables reach an event
-- by three different routes:
--
--   event        events.id
--   recipient    christmas_recipients.christmas_event_id -> events.id
--   purchase     purchases.christmas_recipient_id -> christmas_recipients -> events.id
--
-- Each is SECURITY DEFINER so the lookup itself is not filtered by the very
-- policy it is being used to evaluate -- otherwise `events`' own policy would
-- call a function that reads `events`, and the two would chase each other.
--
-- Every one of them is FALSE unless the event is a birthday. Christmas, Easter
-- and every other occasion are untouched by all of this.
-- ---------------------------------------------------------------------------

create or replace function public.is_own_birthday_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.events e
    where e.id = p_event_id
      and e.event_type = 'birthday'
      and e.celebrant_person_id is not null
      and e.celebrant_person_id = public.current_person_id()
  );
$$;

create or replace function public.is_own_birthday_recipient(p_christmas_recipient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.christmas_recipients r
    join public.events e on e.id = r.christmas_event_id
    where r.id = p_christmas_recipient_id
      and e.event_type = 'birthday'
      and e.celebrant_person_id is not null
      and e.celebrant_person_id = public.current_person_id()
  );
$$;

create or replace function public.is_own_birthday_gift_idea(p_gift_idea_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.gift_ideas g
    join public.christmas_recipients r on r.id = g.christmas_recipient_id
    join public.events e on e.id = r.christmas_event_id
    where g.id = p_gift_idea_id
      and e.event_type = 'birthday'
      and e.celebrant_person_id is not null
      and e.celebrant_person_id = public.current_person_id()
  );
$$;

create or replace function public.is_own_birthday_purchase(p_purchase_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.purchases pu
    join public.christmas_recipients r on r.id = pu.christmas_recipient_id
    join public.events e on e.id = r.christmas_event_id
    where pu.id = p_purchase_id
      and e.event_type = 'birthday'
      and e.celebrant_person_id is not null
      and e.celebrant_person_id = public.current_person_id()
  );
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.is_own_birthday_event(uuid)',
    'public.is_own_birthday_recipient(uuid)',
    'public.is_own_birthday_purchase(uuid)',
    'public.is_own_birthday_gift_idea(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

comment on function public.is_own_birthday_event(uuid) is
  'Is this event the reader''s own birthday? Always false for any event that is not a birthday.';

-- ---------------------------------------------------------------------------
-- 4. The reads themselves
--
-- Each policy keeps exactly the permission it had and subtracts one case. The
-- shape is deliberately identical everywhere -- `is_active_app_member() and not
-- <own birthday>` -- so a reader can check the whole set at a glance and see
-- that nothing else changed.
--
-- The tables NOT listed here, and why:
--   people, app_members            a birthday DATE is not a secret; the
--                                  planning is. Everybody keeps reading these.
--   notifications                  already scoped to the reader's own rows.
--                                  What a notification SAYS is decided when it
--                                  is built, which is the application's job.
--   birthday_reminders,            no policy at all: server-only tables, read
--   birthday_budget_summaries,     through SECURITY DEFINER sweeps. A browser
--   notification_events/outbox     cannot see them today and still cannot.
--   audit_log                      records that something happened, not what
--                                  was bought. Left as it is deliberately, and
--                                  called out in the report rather than changed
--                                  quietly.
-- ---------------------------------------------------------------------------

drop policy if exists "active members read events" on public.events;
create policy "active members read events"
on public.events
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_event(id));

drop policy if exists "active members read recipients" on public.christmas_recipients;
create policy "active members read recipients"
on public.christmas_recipients
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_event(christmas_event_id));

drop policy if exists "active members read contributors" on public.contributors;
create policy "active members read contributors"
on public.contributors
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_event(christmas_event_id));

drop policy if exists "active members read contributions" on public.recipient_contributions;
create policy "active members read contributions"
on public.recipient_contributions
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_recipient(christmas_recipient_id));

drop policy if exists "active members read gift ideas" on public.gift_ideas;
create policy "active members read gift ideas"
on public.gift_ideas
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_recipient(christmas_recipient_id));

drop policy if exists "active members read purchases" on public.purchases;
create policy "active members read purchases"
on public.purchases
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_recipient(christmas_recipient_id));

drop policy if exists "active members read purchase allocations" on public.purchase_allocations;
create policy "active members read purchase allocations"
on public.purchase_allocations
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_purchase(purchase_id));

drop policy if exists "active members read family settlements" on public.settlements;
create policy "active members read family settlements"
on public.settlements
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_event(christmas_event_id));

drop policy if exists "active members read family payment receipts" on public.payment_receipts;
create policy "active members read family payment receipts"
on public.payment_receipts
for select
to authenticated
using (public.is_active_app_member() and not public.is_own_birthday_event(christmas_event_id));

-- A photo of a present is the present. `item_photos` hangs off either a gift
-- idea or a purchase, so both routes are closed.
drop policy if exists "active members read item photos" on public.item_photos;
create policy "active members read item photos"
on public.item_photos
for select
to authenticated
-- Both predicates are SECURITY DEFINER on purpose. A plain subquery here would
-- be evaluated as the READER, so `gift_ideas`' own policy would already have
-- hidden the row -- `not exists` would be true and the photo would be shown.
using (
  public.is_active_app_member()
  and (purchase_id is null or not public.is_own_birthday_purchase(purchase_id))
  and (gift_idea_id is null or not public.is_own_birthday_gift_idea(gift_idea_id))
);

-- ---------------------------------------------------------------------------
-- 5. A birthday date may be maintained by a contributor
--
-- The ONLY change is the authorization line. Every validation below it -- the
-- month range, the day-of-month range, the leap-day rule, the year bounds, the
-- clear-both-or-neither rule -- is migration 026's, reproduced unchanged
-- because `create or replace function` replaces a whole body and there is no
-- way to amend one line of it.
--
-- Migration 026 is applied and is NOT edited. This supersedes it.
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
begin
  -- The one line that changed. A Global Admin may always do this; a family
  -- contributor may too. Nobody else, and this grants nothing else to either.
  if not (public.is_app_admin() or public.is_family_contributor_member()) then
    raise exception 'Only a Global Admin or a family contributor can change a birthday'
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
  from public, anon, authenticated;
grant execute on function public.set_person_birthday(uuid, smallint, smallint, smallint) to authenticated;

comment on function public.set_person_birthday(uuid, smallint, smallint, smallint) is
  'Record or clear a permanent birthday date. Global Admin or a family contributor. Confers no other administrative right.';

-- ---------------------------------------------------------------------------
-- 6. You cannot be financially entangled with your own birthday
--
-- WHY THIS IS PART OF A PRIVACY MIGRATION
--   Section 4 hides a birthday's settlements and allocations from its
--   celebrant. That is only safe while the celebrant cannot HAVE any: hiding
--   somebody's real debt would be a far worse bug than the one being fixed.
--
--   `start_birthday_planning` (migration 030) already refuses a celebrant
--   contributing to their own birthday at setup. `set_event_contributor`
--   (migration 026) does not, so an admin could add them afterwards through
--   Event Settings. That is the hole.
--
-- WHY A TRIGGER AND NOT A REDEFINED FUNCTION
--   A trigger closes every route at once -- both RPCs, and anything added
--   later -- instead of reproducing a hundred lines of somebody else's
--   validation to change one line of it, twice. It also cannot be bypassed by a
--   SECURITY DEFINER function, which is exactly the property wanted.
--
-- EXISTING ROWS ARE NOT TOUCHED. This fires on INSERT and UPDATE only. If the
-- family already has such a row, section 8 says so rather than deleting it.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_celebrant_as_own_contributor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active and exists (
    select 1 from public.events e
    where e.id = new.christmas_event_id
      and e.event_type = 'birthday'
      and e.celebrant_person_id = new.person_id
  ) then
    raise exception 'Somebody cannot contribute towards their own birthday'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists contributors_refuse_own_birthday on public.contributors;
create trigger contributors_refuse_own_birthday
before insert or update on public.contributors
for each row execute function public.refuse_celebrant_as_own_contributor();

-- And you cannot start it either. The resolver already shows the celebrant a
-- privacy screen instead of the setup form, but a hand-made request must meet
-- the same answer -- including from an admin, whose own birthday this rule
-- outranks.
create or replace function public.refuse_starting_own_birthday()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event_type = 'birthday'
    and new.celebrant_person_id is not null
    and new.celebrant_person_id = public.current_person_id()
  then
    raise exception 'You cannot set up the planning for your own birthday'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists events_refuse_own_birthday_setup on public.events;
create trigger events_refuse_own_birthday_setup
before insert on public.events
for each row execute function public.refuse_starting_own_birthday();

-- ---------------------------------------------------------------------------
-- 7. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  entangled integer;
  guarded text[] := array[
    'events', 'christmas_recipients', 'contributors', 'recipient_contributions',
    'gift_ideas', 'purchases', 'purchase_allocations', 'settlements',
    'payment_receipts', 'item_photos'
  ];
  guarded_table text;
begin
  -- Every planning table subtracts the reader's own birthday, and still
  -- requires an active membership. A policy that lost the second half would be
  -- a far bigger hole than the one this migration closes.
  foreach guarded_table in array guarded loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = guarded_table and cmd = 'SELECT'
        and qual like '%is_own_birthday%'
    ) then
      problems := problems || format('%s does not exclude the reader''s own birthday', guarded_table)::text;
    end if;
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = guarded_table and cmd = 'SELECT'
        and qual like '%is_active_app_member%'
    ) then
      problems := problems || format('%s stopped requiring an active membership', guarded_table)::text;
    end if;
  end loop;

  -- Every new function is definer, pinned, and closed to anon.
  if (
    select count(*) from pg_proc
    where proname in (
      'current_person_id', 'is_family_contributor_member', 'is_own_birthday_event',
      'is_own_birthday_recipient', 'is_own_birthday_purchase', 'is_own_birthday_gift_idea'
    )
      and pronamespace = 'public'::regnamespace
      and prosecdef
      and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as s where s like 'search_path=%')
  ) <> 6 then
    problems := problems || 'a new function is missing, not definer, or not search_path-pinned'::text;
  end if;

  if has_function_privilege('anon', 'public.current_person_id()', 'execute')
    or has_function_privilege('anon', 'public.is_own_birthday_event(uuid)', 'execute') then
    problems := problems || 'a new function is executable by anon'::text;
  end if;

  -- Birthday dates may now be maintained by a contributor, and by nobody else
  -- new. If this ever stops mentioning is_app_admin the rule has been widened
  -- past what was intended.
  if not exists (
    select 1 from pg_proc
    where proname = 'set_person_birthday' and pronamespace = 'public'::regnamespace
      and prosrc like '%is_family_contributor_member%' and prosrc like '%is_app_admin%'
  ) then
    problems := problems || 'set_person_birthday no longer admits exactly admins and contributors'::text;
  end if;

  -- Nothing that was already there has moved.
  if to_regproc('public.start_birthday_planning') is null
    or to_regproc('public.set_family_contributor') is null
    or to_regclass('public.birthday_budget_summaries') is null then
    problems := problems || 'a migration 030 object has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 031 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  -- Not a failure: a fact the operator needs. A celebrant who is ALREADY an
  -- active contributor on their own birthday keeps that row -- nothing here
  -- deletes family data -- but section 4 now hides it from them, which means
  -- hiding a real obligation. There should be none, because migration 030
  -- refuses to create one; if there is, it predates that and wants a human
  -- decision rather than a migration's.
  select count(*) into entangled
  from public.contributors c
  join public.events e on e.id = c.christmas_event_id
  where c.active and e.event_type = 'birthday' and e.celebrant_person_id = c.person_id;

  if entangled > 0 then
    raise warning 'ATTENTION: % contributor row(s) make somebody a contributor to their own birthday. They are unchanged, but that money is now hidden from them. Resolve before relying on this migration.', entangled;
  end if;

  raise notice 'Birthday self-privacy is enforced in row level security across % tables, and family contributors may maintain birthday dates. No budget, plan, purchase, payment or birthday was changed.', array_length(guarded, 1);
end;
$$;
