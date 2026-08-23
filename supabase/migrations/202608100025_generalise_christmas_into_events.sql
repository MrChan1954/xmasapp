-- The Event layer: one generic Event table, and Christmas 2026 unchanged inside it.
--
-- WHAT THIS FILE IS FOR
--   The app is about to stop meaning "Christmas 2026" and start meaning
--   "a family, with several events". This migration is the foundation of that
--   and nothing else: no screen changes, no new route, no dashboard.
--
-- THE ONE IDEA
--   `christmas_events` was ALREADY an event table. Every row that belongs to an
--   occasion already reaches it, either directly (`contributors`,
--   `christmas_recipients`, `settlements` and `payment_receipts` all carry
--   `christmas_event_id`) or through exactly one immutable foreign key
--   (`gift_ideas` and `purchases` -> `christmas_recipients`;
--   `purchase_allocations` -> `purchases`; `recipient_contributions` ->
--   `christmas_recipients`).
--
--   So this is a GENERALISATION, not a rebuild. The table is renamed to
--   `events` and gains the columns a birthday or an Easter needs. Its primary
--   keys do not change, which is the whole reason no financial row has to move:
--   every `christmas_event_id` in the database still points at the same row it
--   pointed at before, and that row is now Christmas 2026 the Event.
--
-- WHAT IS DELIBERATELY NOT DONE HERE
--   * `christmas_recipients` and `contributors` are NOT renamed. They are
--     already correct per-event join tables onto the global `people` list, and
--     renaming them would mean rewriting every proven RPC, policy and trigger
--     that reads them. Their names are cosmetic debt; their shape is right.
--   * `christmas_event_id` columns are NOT renamed, for the same reason.
--   * No function that touches money is redefined. `save_purchase`,
--     `save_purchase_with_location`, `record_settlement`, `review_payment`,
--     `admin_record_confirmed_payment`, `void_settlement` and
--     `save_christmas_recipient_with_contributions` are left exactly as
--     migrations 008-024 left them.
--   * Nothing gains a write policy. Creating an event is Checkpoint 4 and will
--     arrive as its own SECURITY DEFINER entry point.
--
-- WHAT IT DOES ADD
--   1. `events`, generalised in place, with a type, a date, a status, an
--      optional celebrant and an author.
--   2. `christmas_events` as a compatibility VIEW over the Christmas-type rows,
--      so every existing query and every existing function keeps working
--      unchanged and the production UI needs no edit at all.
--   3. Structural guards that make cross-event contamination impossible rather
--      than merely unlikely: the event link of a purchase, an allocation, a
--      contribution and a payment can never be moved, and can never point at
--      two different events at once.
--
-- SAFETY
--   Every financial figure in the database is measured before the first DDL
--   statement and measured again after the last one, and the migration aborts
--   if a single penny, row or balance differs. Owed is measured twice more --
--   once family-wide and once scoped to Christmas 2026 -- and both must agree,
--   which is what proves the Christmas balances survive the move to an Event
--   world intact.
--
--   Applying this file is transactional. A failed assertion rolls the whole
--   thing back, so the database is either fully on the Event model or exactly
--   where it started.

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
-- Refuse to run against a database that is not where this file expects it to
-- be, rather than half-applying and leaving something worse than either state.
do $$
declare
  missing text[] := array[]::text[];
  required_table text;
begin
  -- Checked FIRST, and on its own. After this migration has run,
  -- `christmas_events` still exists -- as the compatibility view -- so asking
  -- about that name cannot tell the two situations apart. `events` can.
  if pg_catalog.to_regclass('public.events') is not null then
    raise exception 'public.events already exists. This migration has already been applied.';
  end if;

  if pg_catalog.to_regclass('public.christmas_events') is null then
    raise exception 'public.christmas_events is missing. Apply migrations 001-024 before this file.';
  end if;

  if (
    select relkind
    from pg_catalog.pg_class
    where oid = 'public.christmas_events'::regclass
  ) <> 'r' then
    raise exception 'public.christmas_events is not an ordinary table, so it cannot be generalised safely.';
  end if;

  foreach required_table in array array[
    'people', 'christmas_recipients', 'contributors', 'recipient_contributions',
    'app_members', 'gift_ideas', 'purchases', 'purchase_allocations',
    'settlements', 'payment_receipts'
  ]
  loop
    if pg_catalog.to_regclass('public.' || required_table) is null then
      missing := missing || required_table;
    end if;
  end loop;

  if array_length(missing, 1) is not null then
    raise exception 'The Event layer needs the full application schema. Missing: %',
      array_to_string(missing, ', ');
  end if;

  -- Every existing event row must carry a real Christmas year, or the backfill
  -- below cannot give it a date.
  if exists (select 1 from public.christmas_events where year is null) then
    raise exception 'A christmas_events row has no year, so it cannot be dated as an event.';
  end if;

  -- The compatibility view in section 4 relies on `security_invoker`, which
  -- arrived in PostgreSQL 15. Without it the view would run as its owner and
  -- hand every row to anybody holding the SELECT grant, so an older server must
  -- stop here with an explanation rather than fail on a syntax error later.
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'The Event layer needs PostgreSQL 15 or newer for security_invoker views. This server reports %.',
      current_setting('server_version');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Pre-flight: the existing data must already be event-clean
-- ---------------------------------------------------------------------------
-- The guards installed in sections 6 and 7 refuse any row whose event links
-- disagree, and the Owed reconciliation in section 2 assumes every obligation
-- already belongs to the event being generalised. Both are checked here first,
-- so the migration fails with a precise explanation rather than an opaque
-- trigger error or a confusing balance mismatch.
do $$
declare
  problems text[] := array[]::text[];
  offender_count bigint;
begin
  select count(*) into offender_count
  from public.recipient_contributions as contribution
  join public.christmas_recipients as recipient on recipient.id = contribution.christmas_recipient_id
  join public.contributors as contributor on contributor.id = contribution.contributor_id
  where recipient.christmas_event_id <> contributor.christmas_event_id;
  if offender_count > 0 then
    problems := problems || (offender_count || ' recipient_contributions cross two events');
  end if;

  select count(*) into offender_count
  from public.purchases as purchase
  join public.christmas_recipients as recipient on recipient.id = purchase.christmas_recipient_id
  join public.contributors as payer on payer.id = purchase.checkout_payer_contributor_id
  where recipient.christmas_event_id <> payer.christmas_event_id;
  if offender_count > 0 then
    problems := problems || (offender_count || ' purchases were paid for by a contributor from another event');
  end if;

  select count(*) into offender_count
  from public.purchase_allocations as allocation
  join public.purchases as purchase on purchase.id = allocation.purchase_id
  join public.christmas_recipients as recipient on recipient.id = purchase.christmas_recipient_id
  join public.contributors as contributor on contributor.id = allocation.contributor_id
  where recipient.christmas_event_id <> contributor.christmas_event_id;
  if offender_count > 0 then
    problems := problems || (offender_count || ' purchase_allocations name a contributor from another event');
  end if;

  select count(*) into offender_count
  from public.settlements as settlement
  join public.contributors as payer on payer.id = settlement.payer_contributor_id
  join public.contributors as payee on payee.id = settlement.payee_contributor_id
  where settlement.christmas_event_id <> payer.christmas_event_id
     or settlement.christmas_event_id <> payee.christmas_event_id;
  if offender_count > 0 then
    problems := problems || (offender_count || ' settlements involve a contributor from another event');
  end if;

  select count(*) into offender_count
  from public.payment_receipts as receipt
  join public.settlements as settlement on settlement.id = receipt.settlement_id
  join public.contributors as payer on payer.id = receipt.payer_contributor_id
  join public.contributors as payee on payee.id = receipt.payee_contributor_id
  where receipt.christmas_event_id <> settlement.christmas_event_id
     or receipt.christmas_event_id <> payer.christmas_event_id
     or receipt.christmas_event_id <> payee.christmas_event_id;
  if offender_count > 0 then
    problems := problems || (offender_count || ' payment_receipts disagree with their payment about the event');
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Existing data is not event-clean, so the Event guards cannot be installed: %',
      array_to_string(problems, '; ');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Measure everything, before anything changes
-- ---------------------------------------------------------------------------
-- The Owed digest is the important one. It is the same arithmetic
-- `calculateNetOwedBalances` in src/lib/owed.ts performs -- purchase
-- responsibility netted per contributor pair, minus CONFIRMED payments only --
-- rendered as a stable string so two readings can be compared exactly.
--
-- Held in a TEMPORARY function so the identical expression produces both the
-- before and the after reading. A second copy of this query would be a second
-- chance to get it subtly wrong. It disappears with the session and leaves no
-- permanent object behind.
create or replace function pg_temp.event_owed_digest(p_event_id uuid)
returns text
language sql
stable
as $$
  select coalesce(
    string_agg(pair_key || '=' || net_pennies::text, ',' order by pair_key),
    'no outstanding balances'
  )
  from (
    select pair_key, sum(signed_pennies) as net_pennies
    from (
      -- A purchase responsibility: the allocated contributor owes whoever paid
      -- at the checkout. Self-allocations and zero rows are skipped, exactly as
      -- the application engine skips them.
      select
        least(allocation.contributor_id::text, purchase.checkout_payer_contributor_id::text)
          || '|' ||
        greatest(allocation.contributor_id::text, purchase.checkout_payer_contributor_id::text)
          as pair_key,
        case
          when allocation.contributor_id::text < purchase.checkout_payer_contributor_id::text
          then allocation.responsibility_pennies
          else -allocation.responsibility_pennies
        end as signed_pennies
      from public.purchase_allocations as allocation
      join public.purchases as purchase
        on purchase.id = allocation.purchase_id
      join public.christmas_recipients as recipient
        on recipient.id = purchase.christmas_recipient_id
      where purchase.deleted_at is null
        and allocation.responsibility_pennies > 0
        and allocation.contributor_id <> purchase.checkout_payer_contributor_id
        and (p_event_id is null or recipient.christmas_event_id = p_event_id)

      union all

      -- A payment, counted only for the part the receiver actually confirmed.
      select
        least(settlement.payer_contributor_id::text, settlement.payee_contributor_id::text)
          || '|' ||
        greatest(settlement.payer_contributor_id::text, settlement.payee_contributor_id::text),
        case
          when settlement.payer_contributor_id::text < settlement.payee_contributor_id::text
          then -settlement.confirmed_amount_pennies
          else settlement.confirmed_amount_pennies
        end
      from public.settlements as settlement
      where settlement.voided_at is null
        and settlement.confirmed_amount_pennies > 0
        and settlement.payer_contributor_id <> settlement.payee_contributor_id
        and (p_event_id is null or settlement.christmas_event_id = p_event_id)
    ) as movements
    group by pair_key
    having sum(signed_pennies) <> 0
  ) as balances;
$$;

drop table if exists pg_temp.event_generalisation_baseline;
create temporary table event_generalisation_baseline as
select
  (select id from public.christmas_events order by year desc limit 1) as christmas_event_id,
  (select count(*) from public.christmas_events) as event_count,
  (select count(*) from public.people) as people_count,
  (select count(*) from public.christmas_recipients) as recipient_count,
  (select count(*) from public.christmas_recipients where active) as active_recipient_count,
  (select coalesce(sum(budget_pennies), 0) from public.christmas_recipients) as budget_pennies,
  (select coalesce(sum(budget_pennies), 0) from public.christmas_recipients where active) as active_budget_pennies,
  (select count(*) from public.contributors) as contributor_count,
  (select count(*) from public.contributors where active) as active_contributor_count,
  (select count(*) from public.recipient_contributions) as contribution_count,
  (select coalesce(sum(planned_amount_pennies), 0) from public.recipient_contributions) as planned_pennies,
  (select count(*) from public.gift_ideas) as gift_idea_count,
  (select coalesce(sum(estimated_price_pennies), 0) from public.gift_ideas) as gift_idea_pennies,
  (select count(*) from public.purchases) as purchase_row_count,
  (select count(*) from public.purchases where deleted_at is null) as live_purchase_count,
  (select coalesce(sum(actual_price_pennies), 0) from public.purchases where deleted_at is null) as spend_pennies,
  (select count(*) from public.purchase_allocations) as allocation_count,
  (
    select coalesce(sum(allocation.responsibility_pennies), 0)
    from public.purchase_allocations as allocation
    join public.purchases as purchase on purchase.id = allocation.purchase_id
    where purchase.deleted_at is null
  ) as allocation_pennies,
  (select count(*) from public.settlements) as settlement_count,
  (select coalesce(sum(amount_pennies), 0) from public.settlements where voided_at is null) as claimed_pennies,
  (select coalesce(sum(confirmed_amount_pennies), 0) from public.settlements where voided_at is null) as confirmed_pennies,
  (select count(*) from public.payment_receipts) as receipt_count,
  (select coalesce(sum(amount_pennies), 0) from public.payment_receipts) as receipt_pennies,
  pg_temp.event_owed_digest(null::uuid) as owed_digest_family,
  pg_temp.event_owed_digest(
    (select id from public.christmas_events order by year desc limit 1)
  ) as owed_digest_christmas;

-- Christmas 2026 is currently the only event, so the two Owed readings must
-- already be identical. If they are not, some obligation is not attached to the
-- event being generalised and the premise of this file is wrong.
do $$
declare
  baseline record;
begin
  select * into baseline from pg_temp.event_generalisation_baseline;

  if baseline.christmas_event_id is null then
    raise exception 'No Christmas event exists to generalise.';
  end if;
  if baseline.owed_digest_family is distinct from baseline.owed_digest_christmas then
    raise exception 'Owed for the whole family (%) differs from Owed for event % (%). This database holds % event row(s), so some obligation belongs to an event other than the one being measured. Resolve that before generalising.',
      baseline.owed_digest_family,
      baseline.christmas_event_id,
      baseline.owed_digest_christmas,
      baseline.event_count;
  end if;

  raise notice 'Baseline: % recipients, % contributors, % live purchases, % pennies spent, % pennies confirmed. Owed: %',
    baseline.recipient_count, baseline.contributor_count, baseline.live_purchase_count,
    baseline.spend_pennies, baseline.confirmed_pennies, baseline.owed_digest_family;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Generalise christmas_events into events
-- ---------------------------------------------------------------------------
-- A rename, not a copy. Postgres carries the primary key, the foreign keys that
-- point AT this table, the indexes, the RLS policies and the grants across
-- automatically, and every row keeps its id. That is what makes the whole
-- financial history survive untouched: `settlements.christmas_event_id`,
-- `payment_receipts.christmas_event_id`, `contributors.christmas_event_id` and
-- `christmas_recipients.christmas_event_id` all still resolve, to the same row.
alter table public.christmas_events rename to events;

-- Constraint names are cosmetic, but a `christmas_events_pkey` on a table
-- called `events` is the kind of leftover that makes the next reader wonder
-- whether the rename really finished. Renamed by lookup so a database whose
-- constraint names drifted does not fail the whole migration over a label.
do $$
declare
  old_name text;
  new_name text;
begin
  foreach old_name in array array['christmas_events_pkey', 'christmas_events_name_safe_check']
  loop
    new_name := replace(old_name, 'christmas_events_', 'events_');
    if exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.events'::regclass and conname = old_name
    ) then
      execute format('alter table public.events rename constraint %I to %I', old_name, new_name);
    end if;
  end loop;
end;
$$;

-- `year` was `not null unique`, which is exactly the single-Christmas
-- assumption this file exists to remove: a birthday has no year of its own, and
-- two events can share one. Replaced below by a partial unique index that keeps
-- the guarantee where it is still true -- one Christmas per year.
do $$
declare
  year_constraint text;
  year_attnum smallint;
begin
  select attnum into year_attnum
  from pg_catalog.pg_attribute
  where attrelid = 'public.events'::regclass
    and attname = 'year'
    and not attisdropped;

  select conname into year_constraint
  from pg_catalog.pg_constraint
  where conrelid = 'public.events'::regclass
    and contype = 'u'
    and conkey = array[year_attnum];

  if year_constraint is not null then
    execute format('alter table public.events drop constraint %I', year_constraint);
  end if;
end;
$$;

alter table public.events
  add column if not exists event_type text,
  add column if not exists event_date date,
  add column if not exists description text,
  add column if not exists celebrant_person_id uuid,
  add column if not exists status text,
  add column if not exists created_by_app_member_id uuid,
  add column if not exists updated_at timestamptz;

-- The only data change this migration makes, and it changes nothing that was
-- already recorded: it fills in what a generic Event needs to know about the
-- Christmas rows that predate the concept. Christmas Day is the event date,
-- because that is what the year always meant.
update public.events
set
  event_type = coalesce(event_type, 'christmas'),
  event_date = coalesce(event_date, make_date(year, 12, 25)),
  status = coalesce(status, 'active'),
  updated_at = coalesce(updated_at, created_at);

alter table public.events
  alter column event_type set not null,
  alter column event_date set not null,
  alter column status set not null,
  alter column status set default 'active',
  alter column updated_at set not null,
  alter column updated_at set default now(),
  alter column year drop not null;

-- `event_type` deliberately has NO default. Every future event must say what
-- kind of thing it is; silently inheriting 'christmas' is exactly the bug this
-- whole migration exists to make impossible.
alter table public.events
  add constraint events_type_known_check
  check (event_type in ('christmas', 'birthday', 'easter', 'wedding', 'anniversary', 'other'));

alter table public.events
  add constraint events_status_known_check
  check (status in ('active', 'archived'));

-- A Christmas is identified by its year everywhere in the existing app, so a
-- Christmas without one would disappear from the compatibility view below.
alter table public.events
  add constraint events_christmas_has_year_check
  check (event_type <> 'christmas' or year is not null);

alter table public.events
  add constraint events_year_range_check
  check (year is null or year between 1900 and 2999);

alter table public.events
  add constraint events_description_safe_check
  check (
    description is null
    or (
      length(trim(description)) between 1 and 1000
      and translate(description, E'\n\r\t', '') !~ '[[:cntrl:]]'
    )
  );

-- A birthday is somebody's birthday. Requiring the celebrant here is what lets
-- event creation offer "whose birthday?" as a real relationship rather than a
-- word in the name, and what will let a future dashboard show the right face.
-- It constrains WHO the event is about, never who may receive or contribute.
alter table public.events
  add constraint events_birthday_names_its_celebrant_check
  check (event_type <> 'birthday' or celebrant_person_id is not null);

alter table public.events
  add constraint events_christmas_has_no_celebrant_check
  check (event_type <> 'christmas' or celebrant_person_id is null);

alter table public.events
  add constraint events_celebrant_person_fkey
  foreign key (celebrant_person_id) references public.people(id) on delete restrict;

alter table public.events
  add constraint events_created_by_app_member_fkey
  foreign key (created_by_app_member_id) references public.app_members(id) on delete restrict;

-- One Christmas per year survives as a rule; it just stops applying to
-- everything else. Two birthdays in 2027 are fine, and both carry a null year.
create unique index if not exists events_one_christmas_per_year_idx
  on public.events (year)
  where event_type = 'christmas';

-- The same occasion entered twice is the most likely event-creation mistake,
-- and the hardest to unpick afterwards because purchases start attaching to
-- whichever copy the person opened.
create unique index if not exists events_name_and_date_unique_idx
  on public.events (lower(trim(name)), event_date);

-- The dashboard's queries: upcoming and past events by date, filtered by
-- whether they have been archived.
create index if not exists events_status_date_idx
  on public.events (status, event_date desc);

create index if not exists events_type_date_idx
  on public.events (event_type, event_date desc);

create index if not exists events_celebrant_idx
  on public.events (celebrant_person_id)
  where celebrant_person_id is not null;

comment on table public.events is
  'One occasion the family plans and pays for together: a Christmas, a birthday, an Easter, a wedding. Recipients, contributors, gift ideas, purchases, allocations and payments all belong to exactly one of these.';
comment on column public.events.year is
  'Christmas only. Kept because the Christmas year is how every existing screen and function finds its event; null for every other event type.';
comment on column public.events.event_type is
  'Controls the icon, the label and the sensible setup defaults. It does NOT create a separate financial system: every type uses the same recipients, contributors, purchases, allocations and Owed engine.';
comment on column public.events.event_date is
  'The day the event is for. Christmas rows were dated from their year at migration time.';
comment on column public.events.celebrant_person_id is
  'Whose birthday or anniversary this is, as a reference to the one global person row. Never a duplicate person: the same Paige is the celebrant here and a recipient elsewhere.';
comment on column public.events.status is
  'active or archived. Past-ness is derived from event_date; archiving is a deliberate choice to keep an event out of the primary list.';

-- ---------------------------------------------------------------------------
-- 4. The compatibility view
-- ---------------------------------------------------------------------------
-- Every existing query in the application, and the two SECURITY DEFINER
-- recipient functions from migrations 011 and 012, read `christmas_events`.
-- This view is what lets all of them keep working with no edit at all, which is
-- the difference between a foundation and a rewrite.
--
-- It is deliberately restricted to `event_type = 'christmas'`:
--
--   * `.eq("year", 2026)` still finds exactly one row.
--   * the Family Access route's "latest Christmas" query
--     (`order by year desc limit 1`) cannot be hijacked by a birthday, whose
--     null year would sort FIRST under a descending order.
--   * `save_christmas_recipient_with_contributions` keeps refusing to attach a
--     recipient to a non-Christmas event until Checkpoint 3 generalises it on
--     purpose, rather than by accident.
--
-- `security_invoker` makes the caller's own RLS apply. Without it the view
-- would run as its owner and quietly hand every row to anybody with the SELECT
-- grant, which would be a real privilege escalation dressed up as a rename.
--
-- `check_option = cascaded` is belt and braces. A single-table view with a
-- WHERE clause is AUTO-UPDATABLE in PostgreSQL, so it is a potential write path
-- for any role holding INSERT or UPDATE on it. No browser role does -- the
-- grants below leave `authenticated` with SELECT alone -- but the server's
-- secret-key role keeps full access here as it does on every other table, and
-- without this a write through a Christmas-only view could create or move a row
-- that is not a Christmas at all. With it, anything written through this view
-- must still satisfy `event_type = 'christmas'`.
create view public.christmas_events
with (security_invoker = true, check_option = cascaded) as
select
  event.id,
  event.year,
  event.name,
  event.created_at
from public.events as event
where event.event_type = 'christmas';

comment on view public.christmas_events is
  'Compatibility layer for code written before events were generic. Shows only Christmas-type rows of public.events. Load-bearing: migrations 011 and 012 read it from inside SECURITY DEFINER functions. Do not drop it until every caller reads public.events directly.';

-- ---------------------------------------------------------------------------
-- 5. Row level security and grants
-- ---------------------------------------------------------------------------
-- The rename carried the existing policy and grants across. They are restated
-- here so the end state of this table is legible in one place, and so a hosted
-- database that drifted is corrected rather than assumed.
alter table public.events enable row level security;

drop policy if exists "active members read events" on public.events;
create policy "active members read events"
on public.events
for select
to authenticated
using (public.is_active_app_member());

-- No INSERT, UPDATE or DELETE policy, and no write grant. Events are read-only
-- to every browser session, admin included. Creating, editing and archiving
-- events arrives in Checkpoint 4 as an independently authorized SECURITY
-- DEFINER function, the same shape as every other write in this schema.
revoke all privileges on table public.events from public, anon, authenticated;
grant select on table public.events to authenticated;

revoke all privileges on public.christmas_events from public, anon, authenticated;
grant select on public.christmas_events to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The event link is immutable
-- ---------------------------------------------------------------------------
-- The design above accepts a single event_id on the parent instead of
-- duplicating one onto every financial row. That is only sound while the link
-- cannot move: if a purchase could be re-pointed at a recipient in another
-- event, its historical allocations would silently change which Owed balance
-- they belong to.
--
-- The application already refuses every one of these moves inside its RPCs.
-- This makes it a property of the database instead of a property of the code
-- that happens to be calling it.
create or replace function public.protect_event_scope_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'christmas_recipients' then
    if new.christmas_event_id is distinct from old.christmas_event_id then
      raise exception 'A recipient cannot be moved to another event' using errcode = '42501';
    end if;
    if new.person_id is distinct from old.person_id then
      raise exception 'A recipient cannot be reassigned to another person' using errcode = '42501';
    end if;

  elsif tg_table_name = 'contributors' then
    if new.christmas_event_id is distinct from old.christmas_event_id then
      raise exception 'A contributor cannot be moved to another event' using errcode = '42501';
    end if;
    if new.person_id is distinct from old.person_id then
      raise exception 'A contributor cannot be reassigned to another person' using errcode = '42501';
    end if;

  elsif tg_table_name = 'recipient_contributions' then
    if new.christmas_recipient_id is distinct from old.christmas_recipient_id
      or new.contributor_id is distinct from old.contributor_id then
      raise exception 'A contributor allocation cannot be moved to another recipient or contributor'
        using errcode = '42501';
    end if;

  elsif tg_table_name = 'purchases' then
    if new.christmas_recipient_id is distinct from old.christmas_recipient_id then
      raise exception 'A purchase cannot be moved to another recipient' using errcode = '42501';
    end if;

  elsif tg_table_name = 'purchase_allocations' then
    if new.purchase_id is distinct from old.purchase_id
      or new.contributor_id is distinct from old.contributor_id then
      raise exception 'A responsibility snapshot cannot be moved to another purchase or contributor'
        using errcode = '42501';
    end if;

  elsif tg_table_name = 'settlements' then
    if new.christmas_event_id is distinct from old.christmas_event_id then
      raise exception 'A payment cannot be moved to another event' using errcode = '42501';
    end if;
    if new.payer_contributor_id is distinct from old.payer_contributor_id
      or new.payee_contributor_id is distinct from old.payee_contributor_id then
      raise exception 'A payment cannot be moved between contributors' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.protect_event_scope_identity() from public, anon, authenticated;

drop trigger if exists protect_event_scope_identity on public.christmas_recipients;
create trigger protect_event_scope_identity
  before update on public.christmas_recipients
  for each row execute function public.protect_event_scope_identity();

drop trigger if exists protect_event_scope_identity on public.contributors;
create trigger protect_event_scope_identity
  before update on public.contributors
  for each row execute function public.protect_event_scope_identity();

drop trigger if exists protect_event_scope_identity on public.recipient_contributions;
create trigger protect_event_scope_identity
  before update on public.recipient_contributions
  for each row execute function public.protect_event_scope_identity();

drop trigger if exists protect_event_scope_identity on public.purchases;
create trigger protect_event_scope_identity
  before update on public.purchases
  for each row execute function public.protect_event_scope_identity();

drop trigger if exists protect_event_scope_identity on public.purchase_allocations;
create trigger protect_event_scope_identity
  before update on public.purchase_allocations
  for each row execute function public.protect_event_scope_identity();

drop trigger if exists protect_event_scope_identity on public.settlements;
create trigger protect_event_scope_identity
  before update on public.settlements
  for each row execute function public.protect_event_scope_identity();

-- `gift_ideas` already has this guarantee: `protect_gift_idea_identity` from
-- migration 007 restores the original recipient on every update.
-- `payment_receipts` already refuses every update and delete outright, from
-- migration 021. Neither is duplicated here.

-- ---------------------------------------------------------------------------
-- 7. Two events can never meet
-- ---------------------------------------------------------------------------
-- The other half of the guarantee. Immutability stops a row being MOVED between
-- events; this stops one being CREATED across two.
--
-- Constraint triggers, deferrable and initially deferred, matching the shape
-- migration 012 already uses for the recipient budget invariant: the canonical
-- RPCs replace whole allocation snapshots inside one transaction, so the check
-- belongs at commit rather than after each statement.
--
-- Each check returns without complaint when a parent row is absent. Foreign
-- keys already guarantee those references resolve at commit; this trigger's
-- only job is to compare the events they resolve to.
create or replace function public.enforce_event_scope_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_event uuid;
  contributor_event uuid;
  purchase_recipient uuid;
  payer_event uuid;
  payee_event uuid;
  settlement_event uuid;
begin
  if tg_table_name = 'recipient_contributions' then
    select christmas_event_id into recipient_event
    from public.christmas_recipients where id = new.christmas_recipient_id;
    select christmas_event_id into contributor_event
    from public.contributors where id = new.contributor_id;
    if recipient_event is null or contributor_event is null then
      return null;
    end if;
    if recipient_event <> contributor_event then
      raise exception 'A contributor allocation must stay inside one event'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'purchases' then
    select christmas_event_id into recipient_event
    from public.christmas_recipients where id = new.christmas_recipient_id;
    select christmas_event_id into contributor_event
    from public.contributors where id = new.checkout_payer_contributor_id;
    if recipient_event is null or contributor_event is null then
      return null;
    end if;
    if recipient_event <> contributor_event then
      raise exception 'The checkout payer must belong to the same event as the recipient'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'purchase_allocations' then
    select christmas_recipient_id into purchase_recipient
    from public.purchases where id = new.purchase_id;
    if purchase_recipient is null then
      return null;
    end if;
    select christmas_event_id into recipient_event
    from public.christmas_recipients where id = purchase_recipient;
    select christmas_event_id into contributor_event
    from public.contributors where id = new.contributor_id;
    if recipient_event is null or contributor_event is null then
      return null;
    end if;
    if recipient_event <> contributor_event then
      raise exception 'A purchase responsibility must name a contributor from the same event'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'settlements' then
    select christmas_event_id into payer_event
    from public.contributors where id = new.payer_contributor_id;
    select christmas_event_id into payee_event
    from public.contributors where id = new.payee_contributor_id;
    if payer_event is null or payee_event is null then
      return null;
    end if;
    if payer_event <> new.christmas_event_id or payee_event <> new.christmas_event_id then
      raise exception 'A payment must stay inside one event'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'payment_receipts' then
    select christmas_event_id into settlement_event
    from public.settlements where id = new.settlement_id;
    select christmas_event_id into payer_event
    from public.contributors where id = new.payer_contributor_id;
    select christmas_event_id into payee_event
    from public.contributors where id = new.payee_contributor_id;
    if settlement_event is null or payer_event is null or payee_event is null then
      return null;
    end if;
    if settlement_event <> new.christmas_event_id
      or payer_event <> new.christmas_event_id
      or payee_event <> new.christmas_event_id then
      raise exception 'A payment confirmation must stay inside one event'
        using errcode = '23514';
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.enforce_event_scope_integrity() from public, anon, authenticated;

drop trigger if exists enforce_event_scope_integrity on public.recipient_contributions;
create constraint trigger enforce_event_scope_integrity
after insert or update on public.recipient_contributions
deferrable initially deferred
for each row execute function public.enforce_event_scope_integrity();

drop trigger if exists enforce_event_scope_integrity on public.purchases;
create constraint trigger enforce_event_scope_integrity
after insert or update on public.purchases
deferrable initially deferred
for each row execute function public.enforce_event_scope_integrity();

drop trigger if exists enforce_event_scope_integrity on public.purchase_allocations;
create constraint trigger enforce_event_scope_integrity
after insert or update on public.purchase_allocations
deferrable initially deferred
for each row execute function public.enforce_event_scope_integrity();

drop trigger if exists enforce_event_scope_integrity on public.settlements;
create constraint trigger enforce_event_scope_integrity
after insert or update on public.settlements
deferrable initially deferred
for each row execute function public.enforce_event_scope_integrity();

drop trigger if exists enforce_event_scope_integrity on public.payment_receipts;
create constraint trigger enforce_event_scope_integrity
after insert on public.payment_receipts
deferrable initially deferred
for each row execute function public.enforce_event_scope_integrity();

-- ---------------------------------------------------------------------------
-- 8. Assert the end state
-- ---------------------------------------------------------------------------
-- The same discipline as migrations 023 and 024: this file must not be able to
-- finish quietly having done half its job.
do $$
declare
  problems text[] := array[]::text[];
  guarded_table text;
  christmas_row public.events%rowtype;
begin
  if pg_catalog.to_regclass('public.events') is null then
    problems := problems || 'public.events does not exist';
  elsif (select relkind from pg_catalog.pg_class where oid = 'public.events'::regclass) <> 'r' then
    problems := problems || 'public.events is not an ordinary table';
  elsif not (select relrowsecurity from pg_catalog.pg_class where oid = 'public.events'::regclass) then
    problems := problems || 'row level security is off on public.events';
  end if;

  if pg_catalog.to_regclass('public.christmas_events') is null then
    problems := problems || 'the christmas_events compatibility view is missing';
  elsif (select relkind from pg_catalog.pg_class where oid = 'public.christmas_events'::regclass) <> 'v' then
    problems := problems || 'christmas_events is not a view';
  elsif not exists (
    select 1
    from pg_catalog.pg_class as relation
    cross join lateral unnest(coalesce(relation.reloptions, array[]::text[])) as view_option(setting)
    where relation.oid = 'public.christmas_events'::regclass
      and lower(view_option.setting) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1')
  ) then
    problems := problems || 'the christmas_events view does not run as its invoker, so it would bypass RLS';
  end if;

  -- The view is auto-updatable, so its WHERE clause must also bind writes.
  if coalesce((
    select check_option
    from information_schema.views
    where table_schema = 'public' and table_name = 'christmas_events'
  ), 'NONE') = 'NONE' then
    problems := problems || 'the christmas_events view has no check option, so a write through it could escape event_type = christmas';
  end if;

  -- Every new column, or the Event model is only half there.
  if exists (
    select 1
    from unnest(array[
      'event_type', 'event_date', 'description', 'celebrant_person_id',
      'status', 'created_by_app_member_id', 'updated_at'
    ]) as expected(column_name)
    where not exists (
      select 1
      from pg_catalog.pg_attribute
      where attrelid = 'public.events'::regclass
        and attname = expected.column_name
        and not attisdropped
    )
  ) then
    problems := problems || 'public.events is missing one of its new columns';
  end if;

  -- Every new constraint.
  if exists (
    select 1
    from unnest(array[
      'events_type_known_check', 'events_status_known_check',
      'events_christmas_has_year_check', 'events_year_range_check',
      'events_description_safe_check', 'events_birthday_names_its_celebrant_check',
      'events_christmas_has_no_celebrant_check',
      'events_celebrant_person_fkey', 'events_created_by_app_member_fkey'
    ]) as expected(constraint_name)
    where not exists (
      select 1
      from pg_catalog.pg_constraint
      where conrelid = 'public.events'::regclass
        and conname = expected.constraint_name
    )
  ) then
    problems := problems || 'public.events is missing one of its new constraints';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.events'::regclass
      and contype = 'u'
  ) then
    problems := problems || 'the single-Christmas unique constraint on year still exists';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and indexname = 'events_one_christmas_per_year_idx'
  ) then
    problems := problems || 'one Christmas per year is no longer enforced';
  end if;

  -- Both guards, on every table they are meant to protect.
  foreach guarded_table in array array[
    'christmas_recipients', 'contributors', 'recipient_contributions',
    'purchases', 'purchase_allocations', 'settlements'
  ]
  loop
    if not exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = ('public.' || guarded_table)::regclass
        and tgname = 'protect_event_scope_identity'
    ) then
      problems := problems || (guarded_table || ' has no event immutability guard');
    end if;
  end loop;

  foreach guarded_table in array array[
    'recipient_contributions', 'purchases', 'purchase_allocations',
    'settlements', 'payment_receipts'
  ]
  loop
    if not exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = ('public.' || guarded_table)::regclass
        and tgname = 'enforce_event_scope_integrity'
    ) then
      problems := problems || (guarded_table || ' has no cross-event integrity guard');
    end if;
  end loop;

  -- Events stay read-only to the browser.
  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('events', 'christmas_events')
      and grantee in ('authenticated', 'anon', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    problems := problems || 'a browser role can write to events';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'events'
      and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    problems := problems || 'a direct write policy exists on events';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'events'
      and policyname = 'active members read events' and cmd = 'SELECT'
  ) then
    problems := problems || 'active members can no longer read events';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'events'
      and roles && array['anon', 'public']::name[]
  ) then
    problems := problems || 'an anonymous policy exists on events';
  end if;

  -- And Christmas 2026 is still there, still itself.
  select * into christmas_row
  from public.events
  where event_type = 'christmas'
  order by year desc
  limit 1;

  if not found then
    problems := problems || 'the Christmas event did not survive the generalisation';
  else
    if christmas_row.year is null then
      problems := problems || 'the Christmas event lost its year';
    end if;
    if christmas_row.event_date is null then
      problems := problems || 'the Christmas event has no date';
    end if;
    if christmas_row.status <> 'active' then
      problems := problems || 'the Christmas event is not active';
    end if;
    if not exists (select 1 from public.christmas_events where id = christmas_row.id) then
      problems := problems || 'the Christmas event is invisible through the compatibility view';
    end if;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'The Event layer did not install cleanly: %', array_to_string(problems, '; ');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Assert that no money moved
-- ---------------------------------------------------------------------------
-- The reading from section 2, taken again against the finished schema. Any
-- difference at all -- one penny, one row, one changed balance -- aborts the
-- migration and rolls everything back.
do $$
declare
  baseline record;
  differences text[] := array[]::text[];
  now_value bigint;
  now_digest text;
begin
  select * into baseline from pg_temp.event_generalisation_baseline;

  select count(*) into now_value from public.people;
  if now_value <> baseline.people_count then
    differences := differences || format('people %s -> %s', baseline.people_count, now_value);
  end if;

  select count(*) into now_value from public.christmas_recipients;
  if now_value <> baseline.recipient_count then
    differences := differences || format('recipients %s -> %s', baseline.recipient_count, now_value);
  end if;

  select count(*) into now_value from public.christmas_recipients where active;
  if now_value <> baseline.active_recipient_count then
    differences := differences || format('active recipients %s -> %s', baseline.active_recipient_count, now_value);
  end if;

  select coalesce(sum(budget_pennies), 0) into now_value from public.christmas_recipients;
  if now_value <> baseline.budget_pennies then
    differences := differences || format('total budget %s -> %s', baseline.budget_pennies, now_value);
  end if;

  select coalesce(sum(budget_pennies), 0) into now_value from public.christmas_recipients where active;
  if now_value <> baseline.active_budget_pennies then
    differences := differences || format('active budget %s -> %s', baseline.active_budget_pennies, now_value);
  end if;

  select count(*) into now_value from public.contributors;
  if now_value <> baseline.contributor_count then
    differences := differences || format('contributors %s -> %s', baseline.contributor_count, now_value);
  end if;

  select count(*) into now_value from public.contributors where active;
  if now_value <> baseline.active_contributor_count then
    differences := differences || format('active contributors %s -> %s', baseline.active_contributor_count, now_value);
  end if;

  select count(*) into now_value from public.recipient_contributions;
  if now_value <> baseline.contribution_count then
    differences := differences || format('contribution rows %s -> %s', baseline.contribution_count, now_value);
  end if;

  select coalesce(sum(planned_amount_pennies), 0) into now_value from public.recipient_contributions;
  if now_value <> baseline.planned_pennies then
    differences := differences || format('planned contributions %s -> %s', baseline.planned_pennies, now_value);
  end if;

  select count(*) into now_value from public.gift_ideas;
  if now_value <> baseline.gift_idea_count then
    differences := differences || format('gift ideas %s -> %s', baseline.gift_idea_count, now_value);
  end if;

  select coalesce(sum(estimated_price_pennies), 0) into now_value from public.gift_ideas;
  if now_value <> baseline.gift_idea_pennies then
    differences := differences || format('gift idea estimates %s -> %s', baseline.gift_idea_pennies, now_value);
  end if;

  select count(*) into now_value from public.purchases;
  if now_value <> baseline.purchase_row_count then
    differences := differences || format('purchase rows %s -> %s', baseline.purchase_row_count, now_value);
  end if;

  select count(*) into now_value from public.purchases where deleted_at is null;
  if now_value <> baseline.live_purchase_count then
    differences := differences || format('live purchases %s -> %s', baseline.live_purchase_count, now_value);
  end if;

  select coalesce(sum(actual_price_pennies), 0) into now_value
  from public.purchases where deleted_at is null;
  if now_value <> baseline.spend_pennies then
    differences := differences || format('total spend %s -> %s', baseline.spend_pennies, now_value);
  end if;

  select count(*) into now_value from public.purchase_allocations;
  if now_value <> baseline.allocation_count then
    differences := differences || format('allocation rows %s -> %s', baseline.allocation_count, now_value);
  end if;

  select coalesce(sum(allocation.responsibility_pennies), 0) into now_value
  from public.purchase_allocations as allocation
  join public.purchases as purchase on purchase.id = allocation.purchase_id
  where purchase.deleted_at is null;
  if now_value <> baseline.allocation_pennies then
    differences := differences || format('allocated responsibility %s -> %s', baseline.allocation_pennies, now_value);
  end if;

  select count(*) into now_value from public.settlements;
  if now_value <> baseline.settlement_count then
    differences := differences || format('payments %s -> %s', baseline.settlement_count, now_value);
  end if;

  select coalesce(sum(amount_pennies), 0) into now_value
  from public.settlements where voided_at is null;
  if now_value <> baseline.claimed_pennies then
    differences := differences || format('claimed payments %s -> %s', baseline.claimed_pennies, now_value);
  end if;

  select coalesce(sum(confirmed_amount_pennies), 0) into now_value
  from public.settlements where voided_at is null;
  if now_value <> baseline.confirmed_pennies then
    differences := differences || format('confirmed payments %s -> %s', baseline.confirmed_pennies, now_value);
  end if;

  select count(*) into now_value from public.payment_receipts;
  if now_value <> baseline.receipt_count then
    differences := differences || format('payment receipts %s -> %s', baseline.receipt_count, now_value);
  end if;

  select coalesce(sum(amount_pennies), 0) into now_value from public.payment_receipts;
  if now_value <> baseline.receipt_pennies then
    differences := differences || format('receipt amounts %s -> %s', baseline.receipt_pennies, now_value);
  end if;

  select count(*) into now_value from public.events;
  if now_value <> baseline.event_count then
    differences := differences || format('events %s -> %s', baseline.event_count, now_value);
  end if;

  -- The two that matter most. The family-wide balance must be unchanged, and
  -- the Christmas event's own balance must still be the whole of it.
  now_digest := pg_temp.event_owed_digest(null::uuid);
  if now_digest is distinct from baseline.owed_digest_family then
    differences := differences || format('Owed changed: %s -> %s', baseline.owed_digest_family, now_digest);
  end if;

  now_digest := pg_temp.event_owed_digest(baseline.christmas_event_id);
  if now_digest is distinct from baseline.owed_digest_christmas then
    differences := differences || format('Christmas Owed changed: %s -> %s', baseline.owed_digest_christmas, now_digest);
  end if;
  if now_digest is distinct from pg_temp.event_owed_digest(null::uuid) then
    differences := differences || 'Christmas Owed is no longer the whole of the family Owed';
  end if;

  if array_length(differences, 1) is not null then
    raise exception 'The Event layer changed financial data, which it must never do: %',
      array_to_string(differences, '; ');
  end if;

  raise notice 'Verified: every budget, plan, purchase, allocation, payment, receipt and Owed balance is unchanged. Christmas % is now Event %.',
    (select year from public.events where id = baseline.christmas_event_id),
    baseline.christmas_event_id;
end;
$$;

drop table if exists pg_temp.event_generalisation_baseline;
drop function if exists pg_temp.event_owed_digest(uuid);

-- PostgREST caches the schema. Without this the API keeps serving the old shape
-- until it happens to reload, and `christmas_events` would appear to have
-- vanished rather than become a view.
notify pgrst, 'reload schema';
