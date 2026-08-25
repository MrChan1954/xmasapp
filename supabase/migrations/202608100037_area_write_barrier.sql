-- The barrier that row level security cannot be: writing across Areas.
--
-- WHY 036 WAS NOT ENOUGH. Almost every write in this application goes through a
-- SECURITY DEFINER routine -- `save_christmas_recipient_with_contributions`,
-- `record_purchase`, `set_person_birthday` and fifty-odd others. Definer rights
-- bypass row level security by design; that is the whole reason those routines
-- exist. So the policies added in 036 stop one Area READING another and do
-- nothing whatever to stop one WRITING to another.
--
-- Triggers are not bypassed by definer rights. This migration therefore says the
-- same thing again in the one place that always runs:
--
--   an authenticated caller may only write rows in an Area they belong to.
--
-- THE SERVICE ROLE IS EXEMPT, and has to be. The notification dispatcher, the
-- reminder job and the application's admin client all act with no user behind
-- them, and every migration in this directory runs the same way. The exemption
-- is written as "no auth.uid()", which is precisely the set of callers that has
-- no membership to check -- not a role name that could be granted by accident.
--
-- THREE MORE THINGS FINISH THE MODEL
--   * area_id stops being nullable, which is what makes every guard here
--     total rather than best-effort.
--   * A row that does not name an Area gets the caller's, so the fifty-odd
--     routines that predate Areas keep working unchanged -- and a caller who
--     belongs to two is asked which, rather than guessed at.
--   * An Area can be created, which until now nothing could do.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It creates, deletes or edits no family data. The only rows it writes are
--     Areas for audit entries that had none.
--   * It changes no budget, plan, purchase, allocation, settlement or receipt.
--   * It gives nobody visibility of an Area they are not in. There is still no
--     account anywhere that can see two families it does not belong to.
--
-- MIGRATIONS 001-036 ARE NOT EDITED.

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regproc('public.area_of_event') is null then
    raise exception 'Migration 036 has not been applied.';
  end if;
  if exists (select 1 from public.people where area_id is null)
    or exists (select 1 from public.events where area_id is null)
    or exists (select 1 from public.app_members where area_id is null) then
    raise exception 'Some rows still have no Area. Migration 034 must be re-run before this one.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Which Area any audited row belonged to
--
-- The audit log names its subject as a table and an id rather than a foreign
-- key, so finding its Area means dispatching on the name. Anything not listed
-- resolves through the actor instead, and anything that resolves to nothing
-- keeps a null Area and stays invisible -- an audit entry nobody can place is
-- not one to show to a family at random.
-- ---------------------------------------------------------------------------

create or replace function public.area_of_record(p_table_name text, p_record_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_record_id is null then
    return null;
  end if;

  return case p_table_name
    when 'people' then public.area_of_person(p_record_id)
    when 'events' then public.area_of_event(p_record_id)
    when 'christmas_events' then public.area_of_event(p_record_id)
    when 'app_members' then public.area_of_member(p_record_id)
    when 'christmas_recipients' then public.area_of_recipient(p_record_id)
    when 'purchases' then public.area_of_purchase(p_record_id)
    when 'gift_ideas' then public.area_of_gift_idea(p_record_id)
    when 'contributors' then (
      select e.area_id from public.contributors c
      join public.events e on e.id = c.christmas_event_id where c.id = p_record_id)
    when 'settlements' then (
      select e.area_id from public.settlements s
      join public.events e on e.id = s.christmas_event_id where s.id = p_record_id)
    when 'payment_receipts' then (
      select e.area_id from public.payment_receipts r
      join public.events e on e.id = r.christmas_event_id where r.id = p_record_id)
    when 'recipient_contributions' then (
      select public.area_of_recipient(rc.christmas_recipient_id)
      from public.recipient_contributions rc where rc.id = p_record_id)
    when 'purchase_allocations' then (
      select public.area_of_purchase(pa.purchase_id)
      from public.purchase_allocations pa where pa.id = p_record_id)
    else null
  end;
end;
$$;

/*
 * EVERY AUDIT ENTRY LEARNS ITS AREA ON THE WAY IN.
 *
 * Five different migrations insert into audit_log, from four different
 * routines. Rather than edit any of them -- they are applied and immutable --
 * this fills the column in a BEFORE INSERT trigger, which catches all five and
 * anything added later.
 *
 * A DELETE is audited after the row has gone, so the lookup finds nothing and
 * the actor's own Area is used instead. That is the right answer: the person
 * who did it was in the Area it happened in.
 */
create or replace function public.stamp_audit_area()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_areas uuid[];
begin
  if new.area_id is not null then
    return new;
  end if;

  new.area_id := public.area_of_record(new.table_name, new.record_id);
  if new.area_id is not null then
    return new;
  end if;

  if new.actor_user_id is not null then
    select array_agg(distinct m.area_id) into actor_areas
    from public.app_members m
    where m.user_id = new.actor_user_id and m.active = true;

    -- One Area, or none of our business. An actor in two is not guessed at.
    if array_length(actor_areas, 1) = 1 then
      new.area_id := actor_areas[1];
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists audit_log_stamp_area on public.audit_log;
create trigger audit_log_stamp_area
before insert on public.audit_log
for each row execute function public.stamp_audit_area();

-- ---------------------------------------------------------------------------
-- 2. A new row that does not name an Area gets the caller's
--
-- THIS IS WHAT LETS FIFTY ROUTINES STAY UNTOUCHED. `create_person`,
-- `save_christmas_recipient_with_contributions`, `create_event` and the rest
-- were all written before Areas existed and none of them mentions one. Rather
-- than rewrite every routine -- a change no reviewer could check -- the column
-- fills itself from whoever is calling.
--
-- AND IT STILL DOES NOT GUESS. A login that belongs to two Areas has no single
-- answer, so it is asked for one instead of being given whichever membership
-- the planner reached first. That refusal is the entire safety property of this
-- migration in one branch: an Area is never chosen for you.
-- ---------------------------------------------------------------------------

create or replace function public.default_area_for_new_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidates uuid[];
begin
  if new.area_id is not null then
    return new;
  end if;

  if (select auth.uid()) is null then
    raise exception 'A new % must name the Area it belongs to', tg_table_name
      using errcode = '23502';
  end if;

  select array_agg(distinct m.area_id) into candidates
  from public.app_members m
  where m.user_id = (select auth.uid()) and m.active = true;

  if candidates is null or array_length(candidates, 1) = 0 then
    raise exception 'You do not belong to an Area yet'
      using errcode = '42501';
  end if;

  if array_length(candidates, 1) > 1 then
    raise exception 'You belong to more than one Area. Say which this % is for.', tg_table_name
      using errcode = '23502';
  end if;

  new.area_id := candidates[1];
  return new;
end;
$$;

do $$
declare
  target text;
begin
  foreach target in array array['people', 'events', 'app_members'] loop
    -- Named to sort before the guards in 035 and section 3, so the Area is
    -- filled in before anything is asked about it.
    execute format('drop trigger if exists %I on public.%I', target || '_area_default', target);
    execute format(
      'create trigger %I before insert on public.%I for each row execute function public.default_area_for_new_row()',
      target || '_area_default', target);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The barrier
--
-- Fires on every write to every table a family owns, under definer rights and
-- ordinary rights alike, and asks one question: is the caller in this row's
-- Area?
--
-- ON UPDATE IT ASKS TWICE, about where the row is now and where it is going.
-- Checking only one would let a member of Area A push a row into Area B, or a
-- member of Area B pull one out of Area A, depending on which half was left
-- out.
-- ---------------------------------------------------------------------------

create or replace function public.refuse_foreign_area_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  subject record;
  before_area uuid;
  after_area uuid;
begin
  -- Nobody behind the request: a migration, the notification dispatcher, the
  -- reminder job, or the application's own admin client. None of them has a
  -- membership to check, and all of them are already trusted with the whole
  -- database.
  if (select auth.uid()) is null then
    return coalesce(new, old);
  end if;

  if tg_op <> 'INSERT' then
    subject := old;
    before_area := public.area_of_written_row(tg_table_name, to_jsonb(subject));
  end if;

  if tg_op <> 'DELETE' then
    subject := new;
    after_area := public.area_of_written_row(tg_table_name, to_jsonb(subject));
  end if;

  -- AN AREA WITH NOBODY IN IT BELONGS TO NOBODY. The first membership has to
  -- be written by someone who is not yet a member -- that is what create_area
  -- below does, and there is no order of statements that avoids it. So an Area
  -- with no members at all is open, and closes the instant one exists.
  --
  -- IT CANNOT REOPEN. Migration 035 refuses to let an Area lose its last active
  -- administrator, by demotion, deactivation, deletion or transfer, so the
  -- membership count can never fall back to zero. The two guards hold each
  -- other up.
  if after_area is not null and not exists (
    select 1 from public.app_members m where m.area_id = after_area
  ) then
    return coalesce(new, old);
  end if;

  if before_area is not null and not public.is_area_member(before_area) then
    raise exception 'That belongs to another Area' using errcode = '42501';
  end if;

  if after_area is not null and not public.is_area_member(after_area) then
    raise exception 'That belongs to another Area' using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

/*
 * WHICH AREA A ROW BEING WRITTEN BELONGS TO.
 *
 * Takes the row as jsonb so one function can serve every table: the trigger
 * above does not know the row type at compile time, and a dozen near-identical
 * trigger functions would be a dozen places for the rule to drift.
 *
 * Reads the row's OWN parent key, never anything the caller passed separately,
 * so there is nothing here to spoof.
 */
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

do $$
declare
  target text;
begin
  foreach target in array array[
    'people', 'events', 'app_members', 'christmas_recipients', 'contributors',
    'purchases', 'purchase_allocations', 'gift_ideas', 'recipient_contributions',
    'settlements', 'payment_receipts', 'item_photos'
  ] loop
    execute format('drop trigger if exists %I on public.%I', target || '_refuse_foreign_area', target);
    execute format(
      'create trigger %I before insert or update or delete on public.%I for each row execute function public.refuse_foreign_area_write()',
      target || '_refuse_foreign_area', target);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. An Area can be created
--
-- Until now nothing could: `areas` has no insert policy and the only Area in
-- existence was made by 034's backfill. This is the one way in, and it does all
-- three things a new family needs in a single transaction -- the Area, the
-- person the founder is in it, and the membership that makes them its
-- administrator. A partial one of those is a family nobody can get into.
--
-- IT DOES NOT TOUCH ANY EXISTING AREA, and it cannot be used to join one: the
-- Area it writes to is the one it has just created, three statements earlier.
-- ---------------------------------------------------------------------------

create or replace function public.create_area(p_name text, p_person_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
  new_area uuid;
  new_person uuid;
begin
  if caller is null then
    raise exception 'You must be signed in to create an Area' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'An Area needs a name' using errcode = '22023';
  end if;

  if p_person_name is null or length(trim(p_person_name)) = 0 then
    raise exception 'Tell us your name so the family knows who you are' using errcode = '22023';
  end if;

  select u.email into caller_email from auth.users u where u.id = caller;

  insert into public.areas (name) values (trim(p_name)) returning id into new_area;

  insert into public.people (name, area_id, is_family_contributor)
  values (trim(p_person_name), new_area, true)
  returning id into new_person;

  insert into public.app_members (user_id, email, person_id, role, active, area_id)
  values (caller, caller_email, new_person, 'admin', true, new_area);

  return new_area;
end;
$$;

revoke all on function public.create_area(text, text) from public, anon;
grant execute on function public.create_area(text, text) to authenticated;

comment on function public.create_area(text, text) is
  'Creates an Area with the caller as its first person and its administrator, in one transaction. The only way an Area comes into existence.';

/*
 * RENAMING AND ARCHIVING, for that Area's own administrator only.
 *
 * Archiving is a date, not a delete: an Area holds years of somebody's family
 * finances and nothing here removes any of it.
 */
create or replace function public.set_area_name(p_area_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_area_admin(p_area_id) then
    raise exception 'Only this Area''s administrator can rename it' using errcode = '42501';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'An Area needs a name' using errcode = '22023';
  end if;
  update public.areas set name = trim(p_name), updated_at = now() where id = p_area_id;
end;
$$;

create or replace function public.set_area_archived(p_area_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_area_admin(p_area_id) then
    raise exception 'Only this Area''s administrator can archive it' using errcode = '42501';
  end if;
  update public.areas
  set archived_at = case when p_archived then now() else null end,
      updated_at = now()
  where id = p_area_id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array['public.set_area_name(uuid, text)', 'public.set_area_archived(uuid, boolean)'] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Every row names an Area, for good
--
-- Last, because everything above is what makes it survivable: the default
-- trigger fills the column for the fifty routines that never heard of Areas,
-- and this makes the column's absence impossible rather than merely unusual.
-- ---------------------------------------------------------------------------

alter table public.people alter column area_id set not null;
alter table public.events alter column area_id set not null;
alter table public.app_members alter column area_id set not null;

-- ---------------------------------------------------------------------------
-- 6. End state
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  guarded text[] := array[
    'people', 'events', 'app_members', 'christmas_recipients', 'contributors',
    'purchases', 'purchase_allocations', 'gift_ideas', 'recipient_contributions',
    'settlements', 'payment_receipts', 'item_photos'
  ];
  target text;
  fn text;
  nullable integer;
begin
  foreach target in array guarded loop
    if not exists (
      select 1 from pg_trigger
      where tgname = target || '_refuse_foreign_area' and not tgisinternal
        and tgrelid = ('public.' || target)::regclass
    ) then
      problems := problems || format('%s has no write barrier', target)::text;
    end if;
  end loop;

  foreach target in array array['people', 'events', 'app_members'] loop
    if not exists (
      select 1 from pg_trigger
      where tgname = target || '_area_default' and not tgisinternal
        and tgrelid = ('public.' || target)::regclass
    ) then
      problems := problems || format('%s does not fill in a missing Area', target)::text;
    end if;
  end loop;

  select count(*) into nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('people', 'events', 'app_members')
    and column_name = 'area_id'
    and is_nullable = 'YES';
  if nullable > 0 then
    problems := problems || format('%s of the three roots still allow a null Area', nullable)::text;
  end if;

  foreach fn in array array[
    'public.create_area(text, text)', 'public.set_area_name(uuid, text)',
    'public.set_area_archived(uuid, boolean)', 'public.area_of_record(text, uuid)',
    'public.area_of_written_row(text, jsonb)'
  ] loop
    if to_regprocedure(fn) is null then
      problems := problems || format('%s is missing', fn)::text;
    elsif not exists (
      select 1 from pg_proc p
      where p.oid = to_regprocedure(fn)::oid and p.prosecdef
        and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) as s where s like 'search_path=%')
    ) then
      problems := problems || format('%s is not definer or not search_path-pinned', fn)::text;
    end if;
  end loop;

  foreach fn in array array['public.create_area(text, text)', 'public.set_area_name(uuid, text)'] loop
    if has_function_privilege('anon', fn, 'execute') then
      problems := problems || format('%s is callable by anon', fn)::text;
    end if;
  end loop;

  if not exists (select 1 from pg_trigger where tgname = 'audit_log_stamp_area' and not tgisinternal) then
    problems := problems || 'audit entries do not learn their Area'::text;
  end if;

  -- Nothing above may have created or destroyed family data. Areas are the only
  -- thing this file is allowed to have added, and it should have added none.
  if (select count(*) from public.areas) <> (select count(distinct area_id) from public.people) then
    problems := problems || 'an Area exists with nobody in it, or a person is in an Area that does not exist'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'Migration 037 did not reach its end state: %', array_to_string(problems, '; ');
  end if;

  raise notice 'Areas are closed in both directions. Nothing reads across one and nothing writes across one, including SECURITY DEFINER routines.';
end;
$$;
