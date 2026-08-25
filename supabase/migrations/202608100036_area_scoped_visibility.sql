-- Row level security learns which Area a row belongs to.
--
-- UP TO NOW EVERY POLICY IN THIS DATABASE HAS ASKED ONE QUESTION: "is the
-- reader an active member of the family?" There was one family, so that was the
-- whole of the truth. With Areas it is half of it. The question becomes "is the
-- reader an active member of THIS ROW'S Area", and this migration asks it of
-- every table a family can see.
--
-- HOW EACH TABLE FINDS ITS AREA
--   people, events, app_members and audit_log carry area_id themselves.
--   Everything else reaches it through a parent, and migration 025's
--   `enforce_event_scope_integrity` guarantees there is only ever one parent to
--   reach it through -- a recipient, contributor, purchase, allocation,
--   contribution, settlement or receipt cannot straddle two events, so it
--   cannot straddle two Areas either.
--
-- WHY THE LOOKUPS ARE FUNCTIONS AND NOT SUBQUERIES
--   A plain subquery inside a policy is evaluated AS THE READER, so it sees only
--   what that reader is already allowed to see. Used for an Area check that
--   inverts the answer: the parent row would be invisible, the lookup would
--   return null, and the check would quietly pass. Every lookup below is
--   SECURITY DEFINER with a pinned search_path for that reason.
--
-- WHAT HAPPENS TO SOMEONE IN TWO AREAS
--   `current_app_member_id()`, `current_person_id()` and `is_app_admin()` were
--   written when one login meant one membership. They are redefined below to
--   REFUSE TO ANSWER rather than guess when a login holds more than one, which
--   makes every one of their 100-odd existing callers safe by default instead of
--   silently picking an Area. Anything that needs an answer for a two-Area login
--   asks the Area-aware version by name.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits no row of family data, and reads none of it.
--   * It does not stop a SECURITY DEFINER routine from writing across Areas --
--     definer rights bypass row level security by design. That is 037's job and
--     is done with a trigger, which definer rights do not bypass.
--   * It touches Christmas 2026 only in the sense that its rows are now visible
--     to the Area they already belong to, which is the one they always had.
--
-- MIGRATIONS 001-035 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regproc('public.is_area_member') is null then
    raise exception 'Migration 034 has not been applied.';
  end if;
  if to_regclass('public.app_members_single_admin_per_area_idx') is null then
    raise exception 'Migration 035 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Which Area a row belongs to
--
-- One function per SHAPE of row, not one per table, because several tables hang
-- off the same parent. Each is `stable`, so a policy calling it once per row
-- costs a cached lookup rather than a fresh plan.
-- ---------------------------------------------------------------------------

create or replace function public.area_of_event(p_event_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.area_id from public.events e where e.id = p_event_id;
$$;

create or replace function public.area_of_recipient(p_recipient_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.area_id
  from public.christmas_recipients r
  join public.events e on e.id = r.christmas_event_id
  where r.id = p_recipient_id;
$$;

create or replace function public.area_of_purchase(p_purchase_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.area_id
  from public.purchases pu
  join public.christmas_recipients r on r.id = pu.christmas_recipient_id
  join public.events e on e.id = r.christmas_event_id
  where pu.id = p_purchase_id;
$$;

create or replace function public.area_of_gift_idea(p_gift_idea_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.area_id
  from public.gift_ideas g
  join public.christmas_recipients r on r.id = g.christmas_recipient_id
  join public.events e on e.id = r.christmas_event_id
  where g.id = p_gift_idea_id;
$$;

create or replace function public.area_of_person(p_person_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.area_id from public.people p where p.id = p_person_id;
$$;

create or replace function public.area_of_member(p_app_member_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.area_id from public.app_members m where m.id = p_app_member_id;
$$;

/*
 * WHOSE MEMBERSHIP ROW THIS IS.
 *
 * The notification, preference and device tables are scoped to "your own row",
 * which used to be written as `app_member_id = current_app_member_id()`. That
 * comparison stops working for a login with two memberships, and the safe
 * reading of it -- return nothing -- would hide that person's own
 * notifications from them in both Areas.
 *
 * Asking whether the ROW belongs to the caller has no such ambiguity, and is
 * the question those policies were always really asking.
 */
create or replace function public.is_own_app_member(p_app_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_members m
    where m.id = p_app_member_id
      and m.user_id = (select auth.uid())
      and m.active = true
  );
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.area_of_event(uuid)', 'public.area_of_recipient(uuid)',
    'public.area_of_purchase(uuid)', 'public.area_of_gift_idea(uuid)',
    'public.area_of_person(uuid)', 'public.area_of_member(uuid)',
    'public.is_own_app_member(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. audit_log learns its Area
--
-- The audit log is the fourth root: it records what happened, not what it
-- happened to, so no parent can tell it which Area it belongs to. It also has
-- no membership column to read one from -- it identifies its actor by
-- `actor_user_id`, and one login may hold a membership in two Areas, so that
-- would be a guess rather than a lookup.
--
-- SO THE BACKFILL ONLY RUNS WHILE THE ANSWER IS CERTAIN: when exactly one Area
-- exists, every entry ever written came from it. If a second Area already
-- exists by the time this runs, older entries keep a null Area and stay
-- invisible to everyone rather than being attributed to a family at random.
-- ---------------------------------------------------------------------------

alter table public.audit_log add column if not exists area_id uuid references public.areas(id) on delete restrict;
create index if not exists audit_log_area_idx on public.audit_log (area_id);

do $$
declare
  only_area uuid;
begin
  if (select count(*) from public.areas) = 1 then
    select id into only_area from public.areas;
    update public.audit_log set area_id = only_area where area_id is null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The old questions, asked safely
--
-- Each of these keeps its name, its signature and its meaning for anyone who
-- belongs to one Area -- which is everyone, today. What changes is what happens
-- to a login that belongs to two: instead of `limit 1` picking whichever row
-- the planner reached first, they return null or false.
--
-- THIS IS THE POINT. There are more than a hundred callers of these three
-- functions across thirty migrations, most of them inside SECURITY DEFINER
-- routines that row level security does not constrain. Rewriting all of them is
-- not a change anyone could review. Making the functions refuse to guess turns
-- every one of those callers into a safe one at a stroke: a two-Area login gets
-- "no" from the legacy path and has to go through an Area-aware one.
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
      select count(*)
      from public.app_members m2
      where m2.user_id = (select auth.uid()) and m2.active = true
    ) = 1;
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
      select count(*)
      from public.app_members m2
      where m2.user_id = (select auth.uid()) and m2.active = true
    ) = 1;
$$;

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
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
  );
$$;

comment on function public.current_app_member_id() is
  'The caller''s membership, when they have exactly one. Null when a login belongs to more than one Area: ask current_member_in_area instead of guessing.';
comment on function public.current_person_id() is
  'Which person the caller is, when they belong to exactly one Area. Null otherwise: ask current_person_in_area.';
comment on function public.is_app_admin() is
  'Whether the caller administers the one Area they belong to. False for a login in two Areas, which must ask is_area_admin about a particular one.';

/*
 * `is_active_app_member()` KEEPS ITS OLD MEANING, deliberately. It asks whether
 * the caller is an active member of anything at all, and that is still exactly
 * the right question -- it is a check on the READER, not on a row. Every policy
 * that uses it gains a check on the row's Area alongside, below, and narrowing
 * this one as well would only stop a two-Area login from using the application.
 */

/*
 * WHICH MEMBERSHIP THE CALLER HOLDS IN ONE PARTICULAR AREA -- the unambiguous
 * counterpart to current_app_member_id(), completing the pair that 034 started
 * with current_person_in_area().
 */
create or replace function public.current_member_in_area(p_area_id uuid)
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
    and m.area_id = p_area_id
  limit 1;
$$;

revoke all on function public.current_member_in_area(uuid) from public, anon;
grant execute on function public.current_member_in_area(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Birthday privacy, resolved inside the right Area
--
-- These four predicates compare an event's celebrant against "the person the
-- caller is". Both halves of that comparison have to come from the SAME Area or
-- the answer is meaningless: the caller's person in Area A tested against a
-- celebrant in Area B would hide a stranger's birthday and, far worse, could
-- reveal the caller's own.
--
-- Each is redefined to resolve the caller's person WITHIN THE EVENT'S OWN Area.
-- No policy changes, because the predicate names and signatures do not.
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
      and e.celebrant_person_id = public.current_person_in_area(e.area_id)
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
      and e.celebrant_person_id = public.current_person_in_area(e.area_id)
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
      and e.celebrant_person_id = public.current_person_in_area(e.area_id)
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
      and e.celebrant_person_id = public.current_person_in_area(e.area_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. An Area is visible to the people in it
--
-- Migration 034 turned row level security on for `areas` and wrote no policy,
-- which made every Area invisible to everybody. That was deliberate: an
-- unfinished tenant table should show nothing rather than everything. This is
-- the policy it was waiting for, and it is the whole of the switcher's data --
-- a member sees the Areas they belong to and no others, so there is no query
-- anywhere in the application that can list somebody else's family.
--
-- NO WRITE POLICY. Creating an Area goes through the RPC in 037, which has to
-- make an administrator in the same breath; renaming or archiving one is an
-- administrator action added there too. Nothing may insert into this table by
-- hand.
-- ---------------------------------------------------------------------------

drop policy if exists "members read their own areas" on public.areas;
create policy "members read their own areas"
  on public.areas for select
  using (public.is_area_member(id));

-- ---------------------------------------------------------------------------
-- 6. Every policy gains the row's Area
--
-- Each policy below is REPLACED BY THE SAME POLICY WITH ONE MORE CONJUNCT. The
-- old text is kept word for word so a reviewer can see that nothing was
-- loosened while the Area check was added -- birthday privacy, the admin-only
-- writes and the own-row scoping all read exactly as they did.
--
-- Policy names are unchanged too, so anything that greps for them still finds
-- them.
-- ---------------------------------------------------------------------------

-- people ---------------------------------------------------------------------

drop policy if exists "active members read people" on public.people;
create policy "active members read people"
  on public.people for select
  using (public.is_active_app_member() and public.is_area_member(area_id));

drop policy if exists "admins create people" on public.people;
create policy "admins create people"
  on public.people for insert
  with check (public.is_area_admin(area_id));

drop policy if exists "admins update people" on public.people;
create policy "admins update people"
  on public.people for update
  using (public.is_area_admin(area_id))
  with check (public.is_area_admin(area_id));

-- events ---------------------------------------------------------------------

drop policy if exists "active members read events" on public.events;
create policy "active members read events"
  on public.events for select
  using (
    public.is_active_app_member()
    and public.is_area_member(area_id)
    and not public.is_own_birthday_event(id)
  );

-- app_members ----------------------------------------------------------------
--
-- Reading your OWN membership stays Area-blind on purpose: it is how a login
-- discovers which Areas it belongs to, and the switcher has nothing to offer
-- until that query has run.

drop policy if exists "active members may read own membership" on public.app_members;
create policy "active members may read own membership"
  on public.app_members for select
  using (user_id = (select auth.uid()) and active = true);

drop policy if exists "admins read all memberships" on public.app_members;
create policy "admins read all memberships"
  on public.app_members for select
  using (public.is_area_admin(area_id));

-- christmas_recipients -------------------------------------------------------

drop policy if exists "active members read recipients" on public.christmas_recipients;
create policy "active members read recipients"
  on public.christmas_recipients for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_event(christmas_event_id))
    and not public.is_own_birthday_event(christmas_event_id)
  );

drop policy if exists "admins create recipients" on public.christmas_recipients;
create policy "admins create recipients"
  on public.christmas_recipients for insert
  with check (public.is_area_admin(public.area_of_event(christmas_event_id)));

drop policy if exists "admins update recipients" on public.christmas_recipients;
create policy "admins update recipients"
  on public.christmas_recipients for update
  using (public.is_area_admin(public.area_of_event(christmas_event_id)))
  with check (public.is_area_admin(public.area_of_event(christmas_event_id)));

-- contributors ---------------------------------------------------------------

drop policy if exists "active members read contributors" on public.contributors;
create policy "active members read contributors"
  on public.contributors for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_event(christmas_event_id))
    and not public.is_own_birthday_event(christmas_event_id)
  );

-- gift_ideas -----------------------------------------------------------------

drop policy if exists "active members read gift ideas" on public.gift_ideas;
create policy "active members read gift ideas"
  on public.gift_ideas for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
    and not public.is_own_birthday_recipient(christmas_recipient_id)
  );

drop policy if exists "active members add gift ideas" on public.gift_ideas;
create policy "active members add gift ideas"
  on public.gift_ideas for insert
  with check (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
    and public.is_own_app_member(suggested_by_app_member_id)
  );

drop policy if exists "active members edit gift ideas" on public.gift_ideas;
create policy "active members edit gift ideas"
  on public.gift_ideas for update
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
  )
  with check (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
  );

drop policy if exists "active members remove gift ideas" on public.gift_ideas;
create policy "active members remove gift ideas"
  on public.gift_ideas for delete
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
  );

-- item_photos ----------------------------------------------------------------
--
-- A photo hangs off a purchase OR a gift idea, so its Area comes from whichever
-- one it names. The `is null or` shape is migration 031's and is kept: a photo
-- with neither parent belongs to nothing and is readable by nobody, which is
-- what the trailing coalesce says.

drop policy if exists "active members read item photos" on public.item_photos;
create policy "active members read item photos"
  on public.item_photos for select
  using (
    public.is_active_app_member()
    and public.is_area_member(coalesce(
      public.area_of_purchase(purchase_id),
      public.area_of_gift_idea(gift_idea_id)
    ))
    and (purchase_id is null or not public.is_own_birthday_purchase(purchase_id))
    and (gift_idea_id is null or not public.is_own_birthday_gift_idea(gift_idea_id))
  );

drop policy if exists "active members add item photos" on public.item_photos;
create policy "active members add item photos"
  on public.item_photos for insert
  with check (
    public.is_active_app_member()
    and public.is_area_member(coalesce(
      public.area_of_purchase(purchase_id),
      public.area_of_gift_idea(gift_idea_id)
    ))
  );

drop policy if exists "active members remove item photos" on public.item_photos;
create policy "active members remove item photos"
  on public.item_photos for delete
  using (
    public.is_active_app_member()
    and public.is_area_member(coalesce(
      public.area_of_purchase(purchase_id),
      public.area_of_gift_idea(gift_idea_id)
    ))
  );

-- purchases and their allocations --------------------------------------------

drop policy if exists "active members read purchases" on public.purchases;
create policy "active members read purchases"
  on public.purchases for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
    and not public.is_own_birthday_recipient(christmas_recipient_id)
  );

drop policy if exists "active members read purchase allocations" on public.purchase_allocations;
create policy "active members read purchase allocations"
  on public.purchase_allocations for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_purchase(purchase_id))
    and not public.is_own_birthday_purchase(purchase_id)
  );

-- recipient_contributions ----------------------------------------------------

drop policy if exists "active members read contributions" on public.recipient_contributions;
create policy "active members read contributions"
  on public.recipient_contributions for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
    and not public.is_own_birthday_recipient(christmas_recipient_id)
  );

drop policy if exists "active members add contributions" on public.recipient_contributions;
create policy "active members add contributions"
  on public.recipient_contributions for insert
  with check (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
  );

drop policy if exists "active members update contributions" on public.recipient_contributions;
create policy "active members update contributions"
  on public.recipient_contributions for update
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
  )
  with check (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_recipient(christmas_recipient_id))
  );

-- settlements and payment receipts -------------------------------------------

drop policy if exists "active members read family settlements" on public.settlements;
create policy "active members read family settlements"
  on public.settlements for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_event(christmas_event_id))
    and not public.is_own_birthday_event(christmas_event_id)
  );

drop policy if exists "active members read family payment receipts" on public.payment_receipts;
create policy "active members read family payment receipts"
  on public.payment_receipts for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_event(christmas_event_id))
    and not public.is_own_birthday_event(christmas_event_id)
  );

-- audit_log ------------------------------------------------------------------

drop policy if exists "members read the audit log" on public.audit_log;
create policy "members read the audit log"
  on public.audit_log for select
  using (public.is_active_app_member() and public.is_area_member(area_id));

-- Your own notifications, preferences and devices ----------------------------
--
-- These four were `app_member_id = current_app_member_id()`, which compares one
-- membership against one membership and has no answer for a login holding two.
-- Asking whether the ROW is yours is the same question without the ambiguity,
-- and it keeps a two-Area login seeing their notifications from both.

drop policy if exists "members read their own notifications" on public.notifications;
create policy "members read their own notifications"
  on public.notifications for select
  using (public.is_own_app_member(app_member_id));

drop policy if exists "members update their own notifications" on public.notifications;
create policy "members update their own notifications"
  on public.notifications for update
  using (public.is_own_app_member(app_member_id))
  with check (public.is_own_app_member(app_member_id));

drop policy if exists "members read their own notification preferences" on public.notification_preferences;
create policy "members read their own notification preferences"
  on public.notification_preferences for select
  using (public.is_own_app_member(app_member_id));

drop policy if exists "members create their own notification preferences" on public.notification_preferences;
create policy "members create their own notification preferences"
  on public.notification_preferences for insert
  with check (public.is_own_app_member(app_member_id));

drop policy if exists "members update their own notification preferences" on public.notification_preferences;
create policy "members update their own notification preferences"
  on public.notification_preferences for update
  using (public.is_own_app_member(app_member_id))
  with check (public.is_own_app_member(app_member_id));

drop policy if exists "members read their own devices" on public.push_subscriptions;
create policy "members read their own devices"
  on public.push_subscriptions for select
  using (public.is_own_app_member(app_member_id));

drop policy if exists "members remove their own devices" on public.push_subscriptions;
create policy "members remove their own devices"
  on public.push_subscriptions for delete
  using (public.is_own_app_member(app_member_id));

-- ---------------------------------------------------------------------------
-- 7. End state
--
-- The assertion that matters is the LAST one: every policy on every table a
-- family can see must now mention an Area. It is written as a sweep over
-- pg_policies rather than a list, so a table added later cannot be forgotten --
-- it will simply start failing this block until somebody scopes it.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  fn text;
  offender record;
  scoped integer;
begin
  foreach fn in array array[
    'area_of_event', 'area_of_recipient', 'area_of_purchase', 'area_of_gift_idea',
    'area_of_person', 'area_of_member', 'is_own_app_member', 'current_member_in_area'
  ] loop
    if not exists (
      select 1 from pg_proc
      where proname = fn and pronamespace = 'public'::regnamespace and prosecdef
        and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as s where s like 'search_path=%')
    ) then
      problems := problems || format('%s is missing, not definer, or not search_path-pinned', fn)::text;
    end if;
    if has_function_privilege('anon', 'public.' || fn || '(uuid)', 'execute') then
      problems := problems || format('%s is executable by anon', fn)::text;
    end if;
  end loop;

  if to_regclass('public.audit_log') is not null
    and not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'audit_log' and column_name = 'area_id'
    ) then
    problems := problems || 'audit_log has no area_id'::text;
  end if;

  -- The three legacy questions refuse to guess. Proved by their TEXT, because
  -- proving it by behaviour needs two memberships for one login and this block
  -- may not create any.
  for offender in
    select proname from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('current_app_member_id', 'current_person_id', 'is_app_admin')
      and prosrc not like '%= 1%'
  loop
    problems := problems || format('%s can still pick one Area at random', offender.proname)::text;
  end loop;

  -- Birthday privacy resolves the reader inside the event's own Area.
  for offender in
    select proname from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('is_own_birthday_event', 'is_own_birthday_recipient',
                      'is_own_birthday_purchase', 'is_own_birthday_gift_idea')
      and prosrc not like '%current_person_in_area%'
  loop
    problems := problems || format('%s still compares across Areas', offender.proname)::text;
  end loop;

  -- THE SWEEP. Every policy on a family-visible table names an Area somewhere,
  -- by column or through one of the lookups. The two exceptions are listed by
  -- name and by reason, not by table, so adding a table cannot smuggle one in.
  for offender in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      -- A policy is scoped if it names an Area, or if it is scoped to the
      -- CALLER'S OWN ROW instead -- your notifications, your preferences, your
      -- devices and your list of memberships are yours in every Area at once,
      -- and narrowing them to one would hide your own things from you.
      and coalesce(qual, '') || coalesce(with_check, '') not like '%area%'
      and coalesce(qual, '') || coalesce(with_check, '') not like '%is_own_app_member%'
      and policyname <> 'active members may read own membership'
  loop
    problems := problems || format('%s.%s does not mention an Area', offender.tablename, offender.policyname)::text;
  end loop;

  -- A policy narrows a grant; it cannot stand in for one. Without this the
  -- switcher fails with permission denied and the policy above never runs.
  if not has_table_privilege('authenticated', 'public.areas', 'select') then
    problems := problems || 'authenticated cannot select from areas'::text;
  end if;
  if has_table_privilege('anon', 'public.areas', 'select') then
    problems := problems || 'anon can select from areas'::text;
  end if;

  select count(*) into scoped from pg_policies where schemaname = 'public';
  if scoped < 32 then
    problems := problems || format('only %s policies exist; 036 should not have removed any', scoped)::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 036 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'No Area can read another. Writing across one is still possible through a SECURITY DEFINER routine: that is 037.';
end;
$$;
