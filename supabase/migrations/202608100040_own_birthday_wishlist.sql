-- Your own birthday: a list of things you would like.
--
-- THE PRODUCT CHANGE. Until now the birthday person could see nothing at all of
-- their own birthday, which is right about the PRESENTS and wrong about the
-- WISHES. Somebody should be able to say "AirPods, aftershave, trainers, a
-- game" and have their family see it, without learning one thing about what the
-- family then did with it.
--
-- WHY THIS IS A NEW TABLE AND NOT A HOLE IN `gift_ideas`
--
--   The obvious implementation is a narrow exception in the gift-idea policies:
--   let the celebrant read the rows they authored. It was tried on paper and
--   rejected, for three reasons that are all the same reason.
--
--   1. THE CELEBRANT WOULD NEED A RECIPIENT ID. `gift_ideas` hangs off
--      `christmas_recipients`, so writing one means holding the id of the
--      celebrant's own row in their own birthday event -- the very handle every
--      other rule in this database spends its effort keeping away from them.
--      Once they have it, `save_gift_idea` and `list_gift_ideas` are two
--      SECURITY DEFINER routines that bypass row level security and are one
--      mistake away from handing over the family's secret ideas.
--
--   2. IT WOULD LEAK WHETHER PLANNING HAS STARTED. There is no recipient row
--      until somebody creates one, so a wishlist built on recipients works or
--      does not work depending on whether the family has begun -- which is
--      exactly what `birthdayCardState` and migration 031 go to some trouble
--      never to tell the celebrant.
--
--   3. IT PUTS THE CELEBRANT'S ROWS IN THE SAME TABLE AS THE SECRETS. Every
--      future query against `gift_ideas`, every future policy, every future
--      definer routine would have to remember that one reader is allowed some
--      of these rows and none of the others.
--
--   A separate table has none of those problems and one property none of the
--   alternatives has: THERE IS NOTHING TO LEAK. It records no recipient, no
--   event, no purchase, no price paid, no status and no link of any kind to the
--   planning. A celebrant reading every row of it learns only what they
--   themselves typed.
--
-- WHAT THE BIRTHDAY PERSON CAN DO
--   Add, read, change and remove entries on their OWN list, for their own next
--   birthday, in the Area they are that person in.
--
-- WHAT THEY STILL CANNOT DO, AND THIS MIGRATION DOES NOT CHANGE
--   Read `gift_ideas`, `purchases`, `purchase_allocations`,
--   `recipient_contributions`, `contributors`, `christmas_recipients`,
--   `settlements`, `payment_receipts` or their own birthday `events` row. Every
--   policy 031 and 036 wrote about their own birthday still stands, untouched.
--   An administrator who is the celebrant is restricted exactly as anybody else
--   is: nothing here consults a role.
--
-- IF JADE BUYS THE AIRPODS
--   Nothing happens to the wishlist row. Taylor still sees "AirPods" as their
--   own wish. There is no column that could say "purchased", no join that
--   reaches a purchase, and no trigger that removes or marks anything -- the
--   separation is structural, not a rule somebody has to keep applying.
--
-- IF JADE ADDS "SURPRISE WEEKEND AWAY" FOR TAYLOR
--   That is a gift idea and it goes in `gift_ideas`, where Taylor cannot see
--   it. Only the birthday person writes to this table; nobody can put something
--   on somebody else's wishlist, so a family member's private idea can never
--   arrive here by accident.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits no existing row. The only object it adds is
--     an empty table.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt,
--     and touches Christmas 2026 in no way at all.
--   * It weakens no policy. The only policy it replaces is `area_of_written_row`
--     gaining one line, and the only rows that line is about are this table's.
--
-- MIGRATIONS 001-039 ARE APPLIED AND ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regproc('public.is_area_contributor_member') is null then
    raise exception 'Migration 039 has not been applied.';
  end if;
  if to_regproc('public.current_person_in_area') is null
    or to_regproc('public.area_of_person') is null
    or to_regproc('public.current_member_in_area') is null then
    raise exception 'Migrations 034-036 have not been applied.';
  end if;
  if to_regproc('public.refuse_foreign_area_write') is null then
    raise exception 'Migration 037 has not been applied.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The list
--
-- ONE ROW IS ONE WISH, FOR ONE PERSON, FOR ONE YEAR.
--
-- `occurrence_year` rather than an event id, because the wishlist exists
-- whether or not anybody has started planning, and must look identical either
-- way. It is the year of the birthday the wish is for -- next year's list is a
-- new list, and last year's stays where it was.
--
-- The columns are `gift_ideas`' own, minus everything that is about planning:
-- no recipient, no suggester-other-than-you, no retailer, no photos, no status.
-- What is left is what somebody would write on a list.
-- ---------------------------------------------------------------------------

create table if not exists public.birthday_wishlist_ideas (
  id uuid primary key default gen_random_uuid(),

  -- Stamped by the trigger below from the PERSON, never accepted from a caller.
  area_id uuid not null references public.areas(id) on delete restrict,

  person_id uuid not null references public.people(id) on delete cascade,

  occurrence_year smallint not null
    check (occurrence_year between 2000 and 2200),

  title text not null
    check (length(trim(title)) between 1 and 200 and trim(title) !~ '[[:cntrl:]]'),

  estimated_price_pennies integer
    check (estimated_price_pennies is null
      or (estimated_price_pennies >= 0 and estimated_price_pennies <= 100000000)),

  url text
    check (
      url is null
      or (
        length(url) between 1 and 2048
        and url = trim(url)
        and url !~ '[[:space:][:cntrl:]]'
        and url ~* '^https?://[^/?#@]+([/?#][^[:space:]]*)?$'
      )
    ),

  notes text
    check (notes is null or (
      length(trim(notes)) between 1 and 4000
      and translate(notes, E'\n\r\t', '') !~ '[[:cntrl:]]'
    )),

  -- Stamped by the trigger below. It is always the celebrant's own membership
  -- in this Area; the column exists so that is a recorded fact rather than an
  -- assumption, and so an audit can see who typed it.
  created_by_app_member_id uuid not null references public.app_members(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.birthday_wishlist_ideas is
  'Things somebody has said they would like for their own birthday. Written only by the birthday person; readable by their family. It records no purchase, no price paid, no status and no link to the planning, so showing it to the celebrant reveals nothing about what the family has done.';

comment on column public.birthday_wishlist_ideas.occurrence_year is
  'The year of the birthday this wish is for. Not an event: the list exists whether or not anybody has started planning, and must look the same either way.';

-- The same wish typed twice is a double-tapped Save, not two wishes.
create unique index if not exists birthday_wishlist_one_wish_per_year_idx
  on public.birthday_wishlist_ideas (person_id, occurrence_year, lower(trim(title)));

create index if not exists birthday_wishlist_person_year_idx
  on public.birthday_wishlist_ideas (person_id, occurrence_year, created_at desc);

create index if not exists birthday_wishlist_area_idx
  on public.birthday_wishlist_ideas (area_id);

-- ---------------------------------------------------------------------------
-- 2. Whose list is this, and is the reader that person?
--
-- THE WHOLE AUTHORIZATION OF THIS FEATURE, IN ONE FUNCTION.
--
-- Both halves are resolved inside the SAME Area, and the Area is derived from
-- the PERSON the list belongs to -- never from a header, a cookie, an acting
-- Area or anything else that travels with the request.
--
--   the Area          = the Area that person is in
--   the reader's self = who the reader is IN THAT Area
--
-- So an account that is Taylor in Alpha and Sam in Bravo may write Taylor's
-- Alpha list and Sam's Bravo list, and neither membership reaches the other.
-- An identity match in one Area cannot produce a match in another, because the
-- comparison never crosses one.
-- ---------------------------------------------------------------------------

create or replace function public.is_own_wishlist_person(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.people p
    where p.id = p_person_id
      and p.area_id is not null
      -- Who the reader is IN THIS PERSON'S OWN AREA. Null when the reader has
      -- no membership there, which makes the comparison false rather than
      -- accidentally true.
      and p.id = public.current_person_in_area(p.area_id)
  );
$$;

revoke all on function public.is_own_wishlist_person(uuid) from public, anon;
grant execute on function public.is_own_wishlist_person(uuid) to authenticated;

comment on function public.is_own_wishlist_person(uuid) is
  'Is this person the reader, resolved inside that person''s own Area? The only question the wishlist policies ask, and the only thing that decides who may write one.';

-- ---------------------------------------------------------------------------
-- 3. The row is anchored to its person, not to what the browser sent
--
-- `area_id` and `created_by_app_member_id` are DERIVED, in a BEFORE trigger, so
-- there is nothing for a caller to get wrong and nothing to spoof. The row-level
-- security check below then runs on the finished row.
--
-- On update, the four things that decide who a row belongs to are put back:
-- whose list it is, which Area, which year, and who wrote it. Only the wish
-- itself can be edited, which is migration 007's rule for gift ideas said again
-- for the same reason.
-- ---------------------------------------------------------------------------

create or replace function public.anchor_wishlist_idea()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_area uuid;
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.person_id := old.person_id;
    new.area_id := old.area_id;
    new.occurrence_year := old.occurrence_year;
    new.created_by_app_member_id := old.created_by_app_member_id;
    new.created_at := old.created_at;
    new.updated_at := now();
    return new;
  end if;

  owning_area := public.area_of_person(new.person_id);
  if owning_area is null then
    raise exception 'That person could not be found' using errcode = 'P0002';
  end if;
  new.area_id := owning_area;

  -- The membership is the reader's own, IN THAT AREA. A login with two gets the
  -- right one; a login with none gets null and the not-null constraint refuses
  -- the row, which is the correct answer for somebody with no membership there.
  new.created_by_app_member_id := coalesce(
    new.created_by_app_member_id,
    public.current_member_in_area(owning_area)
  );

  -- Supplied by a browser rather than derived: check it, do not trust it.
  if not exists (
    select 1 from public.app_members m
    where m.id = new.created_by_app_member_id
      and m.area_id = owning_area
      and m.person_id = new.person_id
      and m.active = true
  ) then
    raise exception 'A wishlist entry must be written by the birthday person'
      using errcode = '42501';
  end if;

  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists birthday_wishlist_ideas_anchor on public.birthday_wishlist_ideas;
create trigger birthday_wishlist_ideas_anchor
before insert or update on public.birthday_wishlist_ideas
for each row execute function public.anchor_wishlist_idea();

-- ---------------------------------------------------------------------------
-- 4. Who may read it, and who may write it
--
-- READ: everybody in the Area, the birthday person included.
--   This is the one table on a birthday that the celebrant is allowed to see,
--   and there is no version of it that is a secret -- they wrote every row.
--   Their family needs it for the same reason they wrote it.
--
-- WRITE: the birthday person, and nobody else.
--   Not an administrator, not a contributor, not the family planning the
--   birthday. A wishlist somebody else can add to is not a wishlist, and more
--   to the point: if a family member could write here, they could put a private
--   planning idea somewhere the celebrant can read it.
-- ---------------------------------------------------------------------------

alter table public.birthday_wishlist_ideas enable row level security;

revoke all on table public.birthday_wishlist_ideas from anon;
grant select, insert, update, delete on table public.birthday_wishlist_ideas to authenticated;

drop policy if exists "members read wishlists in their area" on public.birthday_wishlist_ideas;
create policy "members read wishlists in their area"
  on public.birthday_wishlist_ideas for select
  using (
    public.is_active_app_member()
    and public.is_area_member(area_id)
  );

drop policy if exists "the birthday person writes their own wishlist" on public.birthday_wishlist_ideas;
create policy "the birthday person writes their own wishlist"
  on public.birthday_wishlist_ideas for insert
  with check (
    public.is_area_member(area_id)
    and public.is_own_wishlist_person(person_id)
    and public.is_own_app_member(created_by_app_member_id)
  );

drop policy if exists "the birthday person edits their own wishlist" on public.birthday_wishlist_ideas;
create policy "the birthday person edits their own wishlist"
  on public.birthday_wishlist_ideas for update
  using (
    public.is_area_member(area_id)
    and public.is_own_wishlist_person(person_id)
  )
  with check (
    public.is_area_member(area_id)
    and public.is_own_wishlist_person(person_id)
  );

drop policy if exists "the birthday person removes their own wishlist entries" on public.birthday_wishlist_ideas;
create policy "the birthday person removes their own wishlist entries"
  on public.birthday_wishlist_ideas for delete
  using (
    public.is_area_member(area_id)
    and public.is_own_wishlist_person(person_id)
  );

-- ---------------------------------------------------------------------------
-- 5. The write barrier learns about the new table
--
-- Row level security above is already total for this table -- there is no
-- SECURITY DEFINER routine that writes it, so nothing bypasses those policies
-- today. This is for the day somebody adds one. Migration 037's barrier is the
-- guard definer rights do not skip, and a tenant-owned table that is not in it
-- is a table that will be missed.
--
-- `area_of_written_row` is REPLACED, not edited: migration 037 is applied and
-- immutable. The body below is 037's, word for word, with one line added.
-- ---------------------------------------------------------------------------

create or replace function public.area_of_written_row(p_table_name text, p_row jsonb)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_table_name
    when 'people' then (p_row ->> 'area_id')::uuid
    when 'events' then (p_row ->> 'area_id')::uuid
    when 'app_members' then (p_row ->> 'area_id')::uuid
    when 'birthday_wishlist_ideas' then (p_row ->> 'area_id')::uuid
    when 'christmas_recipients' then public.area_of_event((p_row ->> 'christmas_event_id')::uuid)
    when 'contributors' then public.area_of_event((p_row ->> 'christmas_event_id')::uuid)
    when 'settlements' then public.area_of_event((p_row ->> 'christmas_event_id')::uuid)
    when 'payment_receipts' then public.area_of_event((p_row ->> 'christmas_event_id')::uuid)
    when 'purchases' then public.area_of_recipient((p_row ->> 'christmas_recipient_id')::uuid)
    when 'gift_ideas' then public.area_of_recipient((p_row ->> 'christmas_recipient_id')::uuid)
    when 'recipient_contributions' then public.area_of_recipient((p_row ->> 'christmas_recipient_id')::uuid)
    when 'purchase_allocations' then public.area_of_purchase((p_row ->> 'purchase_id')::uuid)
    when 'item_photos' then coalesce(
      public.area_of_purchase((p_row ->> 'purchase_id')::uuid),
      public.area_of_gift_idea((p_row ->> 'gift_idea_id')::uuid))
    else null
  end;
$$;

-- Named to sort AFTER `birthday_wishlist_ideas_anchor`, so the Area has been
-- derived by the time the barrier asks about it. Postgres fires before-row
-- triggers in name order, which is what migration 037 relies on too.
drop trigger if exists birthday_wishlist_ideas_refuse_foreign_area on public.birthday_wishlist_ideas;
create trigger birthday_wishlist_ideas_refuse_foreign_area
before insert or update or delete on public.birthday_wishlist_ideas
for each row execute function public.refuse_foreign_area_write();

-- ---------------------------------------------------------------------------
-- 6. NOT PUBLISHED TO REALTIME, DELIBERATELY
--
-- Migration 014 publishes the tables an open screen has to see change under it
-- -- recipients, purchases, allocations, the money. A wishlist is not one of
-- them: nothing in the application subscribes to it, so publishing it would add
-- write-ahead-log traffic for every wish and deliver it to nobody.
--
-- It is a line to add on the day a screen wants it, and adding it then is one
-- statement. Publishing a table on the chance somebody might subscribe later is
-- how a publication ends up carrying tables nobody can account for.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 7. End state
--
-- Two kinds of assertion. The first kind says the new thing exists and is shut
-- correctly. The second kind says NOTHING ELSE MOVED -- every policy that hides
-- a birthday from its celebrant is checked by name, because a wishlist that
-- arrived alongside a loosened purchase policy would be a far worse outcome
-- than no wishlist at all.
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  expected text;
  found_qual text;
begin
  if to_regclass('public.birthday_wishlist_ideas') is null then
    problems := problems || 'the wishlist table is missing'::text;
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'birthday_wishlist_ideas' and c.relrowsecurity
  ) then
    problems := problems || 'the wishlist table has no row level security'::text;
  end if;

  if has_table_privilege('anon', 'public.birthday_wishlist_ideas', 'select') then
    problems := problems || 'anon can read wishlists'::text;
  end if;
  if not has_table_privilege('authenticated', 'public.birthday_wishlist_ideas', 'insert') then
    problems := problems || 'a member cannot write their own wishlist'::text;
  end if;

  -- Four policies, and every one of them names an Area -- the sweep 036
  -- installed would otherwise start failing on the next migration that runs it.
  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'birthday_wishlist_ideas') <> 4 then
    problems := problems || 'the wishlist does not have exactly four policies'::text;
  end if;

  for found_qual in
    select coalesce(qual, '') || coalesce(with_check, '')
    from pg_policies
    where schemaname = 'public' and tablename = 'birthday_wishlist_ideas'
  loop
    if found_qual not like '%area%' then
      problems := problems || 'a wishlist policy does not mention an Area'::text;
    end if;
  end loop;

  -- WRITING IS THE BIRTHDAY PERSON'S ALONE. All three write policies must ask
  -- the one question, and none of them may ask about a role.
  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'birthday_wishlist_ideas'
        and cmd in ('INSERT', 'UPDATE', 'DELETE')
        and coalesce(qual, '') || coalesce(with_check, '') like '%is_own_wishlist_person%') <> 3 then
    problems := problems || 'a wishlist write policy does not check that the writer is the birthday person'::text;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'birthday_wishlist_ideas'
      and coalesce(qual, '') || coalesce(with_check, '') like '%is_app_admin%'
  ) then
    problems := problems || 'a wishlist policy consults an administrative role'::text;
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'birthday_wishlist_ideas_anchor' and not tgisinternal
  ) or not exists (
    select 1 from pg_trigger where tgname = 'birthday_wishlist_ideas_refuse_foreign_area' and not tgisinternal
  ) then
    problems := problems || 'the wishlist is missing a guard'::text;
  end if;

  -- THE TABLE CANNOT REACH THE PLANNING. Not a comment, an assertion: no
  -- foreign key from this table may name anything that knows about money.
  if exists (
    select 1
    from pg_constraint c
    join pg_class target on target.oid = c.confrelid
    where c.conrelid = 'public.birthday_wishlist_ideas'::regclass
      and c.contype = 'f'
      and target.relname not in ('areas', 'people', 'app_members')
  ) then
    problems := problems || 'the wishlist has a foreign key into the planning'::text;
  end if;

  -- ---------------------------------------------------------------------
  -- NOTHING ELSE MOVED.
  -- ---------------------------------------------------------------------
  foreach expected in array array[
    'is_own_birthday_event', 'is_own_birthday_recipient',
    'is_own_birthday_purchase', 'is_own_birthday_gift_idea'
  ] loop
    if to_regprocedure('public.' || expected || '(uuid)') is null then
      problems := problems || format('%s has gone missing', expected)::text;
    end if;
  end loop;

  -- Each of these policies still refuses the celebrant. Checked by reading the
  -- policy text back out of the catalogue, so a policy that had been replaced
  -- with a looser one would be caught here rather than in production.
  for expected, found_qual in
    select p.policyname, coalesce(p.qual, '')
    from pg_policies p
    where p.schemaname = 'public'
      and p.policyname in (
        'active members read events',
        'active members read recipients',
        'active members read contributors',
        'active members read gift ideas',
        'active members read purchases',
        'active members read purchase allocations',
        'active members read contributions',
        'active members read family settlements',
        'active members read family payment receipts'
      )
  loop
    if found_qual not like '%is_own_birthday%' then
      problems := problems || format('policy "%s" no longer hides the reader''s own birthday', expected)::text;
    end if;
  end loop;

  -- And the empty table really is empty: this migration creates no wish.
  if (select count(*) from public.birthday_wishlist_ideas) <> 0 then
    problems := problems || 'this migration created a wishlist entry'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 040 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'The birthday person can keep a wishlist. Everything about what the family did with it is exactly as hidden as it was.';
end;
$$;
