-- Areas: the tenant boundary. Groundwork, and the existing family becomes one.
--
-- WHAT AN AREA IS
--   A complete, private gift-planning space: its own people, its own events,
--   its own money, its own members. Belonging to one grants nothing anywhere
--   else. One login may belong to several.
--
-- THE SHAPE THIS TAKES, AND WHY IT IS SMALLER THAN IT LOOKS
--
--   Only FOUR things are owned by an Area directly. Everything else already
--   hangs off one of them and cannot escape:
--
--     people        the directory. A root: it has no foreign keys at all.
--     events        every occasion. A root.
--     app_members   who may sign in, and as what.
--     audit_log     kept for later in this chain; it names no parent either.
--
--   Every other tenant-owned table reaches an Area through a parent that
--   already constrains it. `christmas_recipients`, `contributors`,
--   `settlements` and `payment_receipts` name an event; `purchases`,
--   `gift_ideas` and `recipient_contributions` name a recipient;
--   `purchase_allocations` names a purchase. And migration 025's
--   `enforce_event_scope_integrity` ALREADY refuses to let any of them straddle
--   two events -- so once an event belongs to one Area, none of its children
--   can belong to another. That guard was written for a different reason and
--   turns out to do most of this job already.
--
--   Copying `area_id` onto all fifteen would add fifteen columns that can drift
--   from the parents they duplicate. Deriving it costs a join in a policy and
--   cannot be wrong.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes, renumbers or rewrites no family row. Every column it
--     adds is nullable and is filled by naming the one Area that already
--     implicitly existed.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt,
--     and redefines none of the functions that write them.
--   * It enforces nothing yet. Row level security, the cross-Area guards and
--     NOT NULL arrive in 035-037, so this migration is safe to apply while the
--     current code is still running.
--   * It touches Christmas 2026 in no way beyond naming its Area.
--
-- MIGRATIONS 001-033 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.events') is null then
    raise exception 'Migration 025 has not been applied.';
  end if;
  if to_regproc('public.current_person_id') is null then
    raise exception 'Migration 031 has not been applied.';
  end if;
  if to_regproc('public.refuse_last_admin_removal') is null then
    raise exception 'Migration 033 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The Area
--
-- Deliberately almost empty. A name and a lifecycle is all tenancy needs;
-- branding, preferences and per-Area settings are product decisions that can be
-- added later without touching a boundary that everything else depends on.
-- ---------------------------------------------------------------------------

create table if not exists public.areas (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint areas_name_safe_check check (
    length(trim(name)) between 1 and 100 and trim(name) !~ '[[:cntrl:]]'
  )
);

comment on table public.areas is
  'One private gift-planning space. People, events, money and members all belong to exactly one, and membership of one grants nothing in any other.';

alter table public.areas enable row level security;

-- The grant and the policy are two different locks and both have to be open.
-- Row level security decides WHICH rows; this decides whether the table can be
-- read at all. 036 writes the policy; without this line it would have nothing
-- to narrow, and a member would get "permission denied for table areas" from
-- the switcher.
--
-- Read only, and nothing for anon. An Area is created by the RPC in 037, never
-- by an insert from a browser.
grant select on table public.areas to authenticated;
revoke all on table public.areas from anon;

-- Still no policy: 036 gives members a read of their own Areas. Until then the
-- table is readable by nobody from a browser, which is the safe default.

-- ---------------------------------------------------------------------------
-- 2. The four roots learn which Area they belong to
--
-- NULLABLE ON PURPOSE. Section 3 fills them in the same transaction, but a
-- nullable column means the ALTER itself rewrites nothing and cannot fail
-- half-way through a table of production history.
-- ---------------------------------------------------------------------------

alter table public.people add column if not exists area_id uuid references public.areas(id);
alter table public.events add column if not exists area_id uuid references public.areas(id);
alter table public.app_members add column if not exists area_id uuid references public.areas(id);

comment on column public.people.area_id is
  'The Area this person belongs to. The same real-world person in two Areas is two rows: their histories are separate, and nothing links them.';
comment on column public.app_members.area_id is
  'The Area this membership is for. One login may hold several, with a different person, role and active state in each.';

-- The composite keys the later cross-Area guards refer back to. A plain unique
-- on (id, area_id) is redundant with the primary key and free -- it exists so a
-- child can name BOTH and have the database prove they agree.
create unique index if not exists areas_events_identity_idx on public.events (id, area_id);
create unique index if not exists areas_people_identity_idx on public.people (id, area_id);

create index if not exists people_area_idx on public.people (area_id);
create index if not exists events_area_idx on public.events (area_id);
create index if not exists app_members_area_idx on public.app_members (area_id);

-- ---------------------------------------------------------------------------
-- 3. The family that already exists becomes the first Area
--
-- ONE AREA, CREATED ONCE, AND ONLY IF THERE IS SOMETHING TO PUT IN IT. A
-- database with no people and no events is a fresh install, not a family
-- waiting to be adopted -- it gets nothing, and its first Area is created by
-- whoever signs up.
--
-- THE NAME IS NOT DERIVED FROM ANYBODY. It is a constant, and deliberately a
-- neutral one: guessing a family's name from a person's name is exactly the
-- kind of inference this project has refused everywhere else. The Area is
-- renamed in Area Settings by somebody who knows what it should be called.
--
-- IDEMPOTENT. Re-running finds the Area it made last time -- by the rows that
-- point at it, never by its name -- and fills in anything still null.
-- ---------------------------------------------------------------------------

do $$
declare
  existing_area uuid;
  people_count integer;
  event_count integer;
  member_count integer;
begin
  select count(*) into people_count from public.people;
  select count(*) into event_count from public.events;
  select count(*) into member_count from public.app_members;

  if people_count = 0 and event_count = 0 and member_count = 0 then
    raise notice 'No existing family data: no initial Area created. The first Area will be created by its owner.';
    return;
  end if;

  -- An Area any existing row already points at, so a second run adopts the
  -- first run's Area instead of making another.
  select coalesce(
    (select area_id from public.people where area_id is not null limit 1),
    (select area_id from public.events where area_id is not null limit 1),
    (select area_id from public.app_members where area_id is not null limit 1)
  ) into existing_area;

  if existing_area is null then
    insert into public.areas (name) values ('Our family')
    returning id into existing_area;
    raise notice 'Created the initial Area for % people, % events and % memberships.',
      people_count, event_count, member_count;
  end if;

  -- Backfill. `where area_id is null` makes each statement a no-op on a second
  -- run, and touches no row that is already placed.
  update public.people set area_id = existing_area where area_id is null;
  update public.events set area_id = existing_area where area_id is null;
  update public.app_members set area_id = existing_area where area_id is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Which Areas the caller belongs to
--
-- The one question every later policy asks. SECURITY DEFINER because it reads
-- `app_members`, which a member may only read their own row of -- the same
-- shape as `is_app_admin()` and `current_person_id()` before it.
--
-- MEMBERSHIP IS NOT A ROLE. This says only "you are in this Area, and active".
-- What you may DO there is a separate question, answered per Area in 036.
-- ---------------------------------------------------------------------------

create or replace function public.is_area_member(p_area_id uuid)
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
      and m.area_id = p_area_id
  );
$$;

create or replace function public.is_area_admin(p_area_id uuid)
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
      and m.area_id = p_area_id
      and m.role = 'admin'
  );
$$;

/*
 * WHICH PERSON THE CALLER IS, IN ONE PARTICULAR AREA.
 *
 * `current_person_id()` from migration 031 answers this for a single-family
 * world and becomes ambiguous the moment one login holds two memberships: the
 * same account may be a different person in each. It is left in place and
 * unchanged -- 036 redefines it in terms of this, so every existing caller
 * keeps working -- and everything that knows which Area it is talking about
 * should ask this instead.
 *
 * BIRTHDAY PRIVACY DEPENDS ON GETTING THIS RIGHT. Comparing a celebrant in one
 * Area against the reader's person in another would either hide the wrong
 * birthday or reveal the right one.
 */
create or replace function public.current_person_in_area(p_area_id uuid)
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
    and m.area_id = p_area_id
  limit 1;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.is_area_member(uuid)',
    'public.is_area_admin(uuid)',
    'public.current_person_in_area(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  orphans integer;
  areas_made integer;
  fn text;
begin
  if to_regclass('public.areas') is null then
    problems := problems || 'the areas table is missing'::text;
  end if;

  foreach fn in array array['is_area_member', 'is_area_admin', 'current_person_in_area'] loop
    if not exists (
      select 1 from pg_proc
      where proname = fn and pronamespace = 'public'::regnamespace and prosecdef
        and exists (select 1 from unnest(coalesce(proconfig, array[]::text[])) as s where s like 'search_path=%')
    ) then
      problems := problems || format('%s is missing, not definer, or not search_path-pinned', fn)::text;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.is_area_member(uuid)', 'execute')
    or has_function_privilege('anon', 'public.current_person_in_area(uuid)', 'execute') then
    problems := problems || 'a new function is executable by anon'::text;
  end if;

  -- EXACTLY ONE AREA, or none on a fresh install. Two would mean the backfill
  -- split a family that has always been one.
  select count(*) into areas_made from public.areas;
  if areas_made > 1 then
    problems := problems || format('%s Areas exist; the backfill must create exactly one', areas_made)::text;
  end if;

  -- Nothing was left behind. Every person, event and membership names an Area.
  select
    (select count(*) from public.people where area_id is null)
    + (select count(*) from public.events where area_id is null)
    + (select count(*) from public.app_members where area_id is null)
  into orphans;
  if orphans > 0 then
    problems := problems || format('%s rows still have no Area', orphans)::text;
  end if;

  -- And nothing that was already there has moved.
  if to_regproc('public.current_person_id') is null
    or to_regproc('public.is_app_admin') is null
    or to_regproc('public.enforce_event_scope_integrity') is null then
    problems := problems || 'an earlier migration''s object has gone missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 034 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Areas exist and the existing family is one of them. Nothing is enforced yet: row level security, the cross-Area guards and NOT NULL arrive in 035-037.';
end;
$$;
