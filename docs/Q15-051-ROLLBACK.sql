-- =============================================================================
-- ROLLBACK FOR MIGRATION 051
-- =============================================================================
--
-- WHAT THIS UNDOES
--
--   Migration 051 did two things:
--     1. dropped is_family_contributor_member, save_christmas_recipient and
--        save_recipient_contributions -- three routines nothing calls;
--     2. narrowed `authenticated` on public.areas to SELECT, and on
--        public.birthday_wishlist_ideas to SELECT/INSERT/UPDATE/DELETE, taking
--        away TRUNCATE, REFERENCES, TRIGGER and (on PostgreSQL 17+) MAINTAIN.
--
--   This file puts both back, exactly as production held them beforehand.
--
-- READ THIS BEFORE RUNNING IT
--
--   Half of this file RE-OPENS A HOLE ON PURPOSE. Row level security is never
--   consulted for TRUNCATE, so restoring the blanket grant restores the ability
--   of any signed-in family member to empty `areas` and
--   `birthday_wishlist_ideas` for every family at once, given a way to issue
--   the statement. That was the state before 051 and it is what "rollback"
--   means -- but run section 2 only if you actually intend it. Sections 1 and 2
--   are independent and can be run separately.
--
-- WHAT IT DOES NOT DO
--
--   It reads no row and writes no row. Every statement here is a catalogue
--   change, so nothing in the family's data can be lost by running it, and row
--   counts are unaffected either way.
--
-- HOW TO RUN IT
--
--   Supabase SQL Editor, paste the whole file, Run. It is idempotent: the
--   CREATE OR REPLACEs and the grants reach the same place the second time.
--
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Put the three routines back
--
-- These bodies are COPIED VERBATIM from the production schema dump taken by
-- .github/workflows/database-backup.yml on 2026-08-30 at 18:40:06Z (run
-- 33328658398) -- a pg_dump of the live database as it stood immediately before
-- migration 051 was written. They are not reconstructions from migration text.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."is_family_contributor_member"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select case
    -- Said which Area they are acting in: answer about that one.
    when public.acting_area() is not null
      then public.is_area_contributor_member(public.acting_area())
    -- Said nothing: answer only when there is nothing to guess between.
    else exists (
      select 1
      from public.app_members m
      join public.people p on p.id = m.person_id
      where m.user_id = (select auth.uid())
        and m.active = true
        and p.is_family_contributor
        and (
          select count(*)
          from public.app_members m2
          where m2.user_id = (select auth.uid()) and m2.active = true
        ) = 1
    )
  end;
$$;

CREATE OR REPLACE FUNCTION "public"."save_christmas_recipient"("p_christmas_recipient_id" "uuid", "p_christmas_event_id" "uuid", "p_name" "text", "p_budget_pennies" integer) RETURNS "public"."christmas_recipients"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  linked_person_id uuid;
  linked_event_id uuid;
  saved_recipient public.christmas_recipients;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required' using errcode = '42501';
  end if;
  if p_name is null
     or length(trim(p_name)) not between 1 and 100
     or trim(p_name) ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid person name' using errcode = '23514';
  end if;
  if p_budget_pennies is null or p_budget_pennies < 0 then
    raise exception 'Enter a valid Christmas budget' using errcode = '23514';
  end if;

  if p_christmas_recipient_id is null then
    if p_christmas_event_id is null or not exists (
      select 1 from public.christmas_events where id = p_christmas_event_id
    ) then
      raise exception 'Christmas event not found' using errcode = 'P0002';
    end if;

    insert into public.people (name)
    values (trim(p_name))
    returning id into linked_person_id;

    insert into public.christmas_recipients (
      christmas_event_id,
      person_id,
      budget_pennies,
      active
    ) values (
      p_christmas_event_id,
      linked_person_id,
      p_budget_pennies,
      true
    ) returning * into saved_recipient;
  else
    select person_id, christmas_event_id
    into linked_person_id, linked_event_id
    from public.christmas_recipients
    where id = p_christmas_recipient_id;

    if linked_person_id is null then
      raise exception 'Christmas recipient not found' using errcode = 'P0002';
    end if;
    if p_christmas_event_id is not null and p_christmas_event_id <> linked_event_id then
      raise exception 'A recipient cannot be moved to another Christmas event'
        using errcode = '23514';
    end if;

    update public.people
    set name = trim(p_name), updated_at = now()
    where id = linked_person_id;

    update public.christmas_recipients
    set budget_pennies = p_budget_pennies, updated_at = now()
    where id = p_christmas_recipient_id
    returning * into saved_recipient;
  end if;

  return saved_recipient;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."save_recipient_contributions"("p_christmas_recipient_id" "uuid", "p_allocations" "jsonb") RETURNS SETOF "public"."recipient_contributions"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  recipient_event_id uuid;
  recipient_budget_pennies integer;
  allocation_count integer;
  distinct_contributor_count integer;
  allocation_total numeric;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;

  select christmas_event_id, budget_pennies
  into recipient_event_id, recipient_budget_pennies
  from public.christmas_recipients
  where id = p_christmas_recipient_id;

  if recipient_event_id is null then
    raise exception 'Christmas recipient not found' using errcode = 'P0002';
  end if;
  if p_allocations is null
     or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'At least one contributor allocation is required'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_allocations) as allocation(item)
    where jsonb_typeof(item) <> 'object'
       or not (item ? 'contributor_id')
       or not (item ? 'planned_amount_pennies')
       or coalesce(item ->> 'contributor_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(item ->> 'planned_amount_pennies', '') !~ '^[0-9]+$'
  ) then
    raise exception 'Contributor allocations are invalid' using errcode = '23514';
  end if;

  select
    count(*),
    count(distinct item ->> 'contributor_id'),
    coalesce(sum((item ->> 'planned_amount_pennies')::numeric), 0)
  into allocation_count, distinct_contributor_count, allocation_total
  from jsonb_array_elements(p_allocations) as allocation(item);

  if allocation_count <> distinct_contributor_count then
    raise exception 'Each contributor can appear only once' using errcode = '23514';
  end if;
  if allocation_total > 2147483647 then
    raise exception 'Contributor allocation is too large' using errcode = '22003';
  end if;
  if allocation_total <> recipient_budget_pennies then
    raise exception 'Contributor allocations must equal the recipient budget exactly'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_allocations) as allocation(item)
    left join public.contributors as contributor
      on contributor.id = (item ->> 'contributor_id')::uuid
    where contributor.id is null
       or contributor.christmas_event_id <> recipient_event_id
       or contributor.active = false
  ) then
    raise exception 'Contributors must be active for this Christmas event'
      using errcode = '23514';
  end if;

  update public.recipient_contributions
  set planned_amount_pennies = 0, updated_at = now()
  where christmas_recipient_id = p_christmas_recipient_id;

  insert into public.recipient_contributions (
    christmas_recipient_id,
    contributor_id,
    planned_amount_pennies,
    updated_at
  )
  select
    p_christmas_recipient_id,
    (item ->> 'contributor_id')::uuid,
    (item ->> 'planned_amount_pennies')::integer,
    now()
  from jsonb_array_elements(p_allocations) as allocation(item)
  on conflict (christmas_recipient_id, contributor_id)
  do update set
    planned_amount_pennies = excluded.planned_amount_pennies,
    updated_at = excluded.updated_at;

  return query
  select contribution.*
  from public.recipient_contributions as contribution
  where contribution.christmas_recipient_id = p_christmas_recipient_id;
end;
$_$;


ALTER FUNCTION "public"."save_recipient_contributions"("p_christmas_recipient_id" "uuid", "p_allocations" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_area_archived"("p_area_id" "uuid", "p_archived" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- MIGRATION 045: the Area of the row being changed, not the Area the
  -- caller happens to be standing in. See the file header.
  perform public.require_acting_area(p_area_id);
  if not public.is_area_admin(p_area_id) then
    raise exception 'Only this Area''s administrator can archive it' using errcode = '42501';
  end if;
  update public.areas
  set archived_at = case when p_archived then now() else null end,
      updated_at = now()
  where id = p_area_id;
end;
$$;

-- The grants exactly as production held them: 012 and 031 revoked from
-- `public` and `anon`, and only `is_family_contributor_member` was ever given
-- back to `authenticated`.

revoke all on function public.is_family_contributor_member() from public, anon;
grant execute on function public.is_family_contributor_member() to authenticated, service_role;

revoke all on function public.save_christmas_recipient(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.save_christmas_recipient(uuid, uuid, text, integer) to service_role;

revoke all on function public.save_recipient_contributions(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_recipient_contributions(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Put the blanket table grants back
--
-- This restores the PRE-051 state, which is Supabase's project default plus the
-- grants migrations 034 and 040 added on top. It re-opens TRUNCATE to
-- `authenticated` on both tables. That is what "rollback" means here; do not
-- run this half unless you actually intend to undo the hardening.
-- ---------------------------------------------------------------------------

grant all on table public.areas to authenticated;
grant all on table public.birthday_wishlist_ideas to authenticated;

comment on table public.areas is null;
comment on table public.birthday_wishlist_ideas is null;

-- ---------------------------------------------------------------------------
-- 3. End state -- the pre-051 shape, asserted
-- ---------------------------------------------------------------------------

do $$
declare
  problems text[] := array[]::text[];
  back text;
  granted text[];
begin
  foreach back in array array[
    'public.is_family_contributor_member()',
    'public.save_christmas_recipient(uuid, uuid, text, integer)',
    'public.save_recipient_contributions(uuid, jsonb)'
  ] loop
    if to_regprocedure(back) is null then
      problems := problems || format('%s was not restored', back)::text;
    end if;
  end loop;

  if not has_function_privilege('authenticated', 'public.is_family_contributor_member()', 'execute') then
    problems := problems || 'is_family_contributor_member is not callable by authenticated again'::text;
  end if;
  if has_function_privilege('authenticated', 'public.save_christmas_recipient(uuid, uuid, text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.save_recipient_contributions(uuid, jsonb)', 'execute') then
    problems := problems || 'the two save_* routines must stay closed to authenticated, as they were'::text;
  end if;

  select array_agg(privilege_type order by privilege_type) into granted
  from pg_class c, aclexplode(c.relacl) a
  where c.oid = 'public.areas'::regclass and a.grantee = 'authenticated'::regrole;
  if not ('TRUNCATE' = any(granted)) then
    problems := problems || 'public.areas did not go back to the blanket grant'::text;
  end if;

  select array_agg(privilege_type order by privilege_type) into granted
  from pg_class c, aclexplode(c.relacl) a
  where c.oid = 'public.birthday_wishlist_ideas'::regclass and a.grantee = 'authenticated'::regrole;
  if not ('TRUNCATE' = any(granted)) then
    problems := problems || 'public.birthday_wishlist_ideas did not go back to the blanket grant'::text;
  end if;

  if exists (
    select 1 from pg_class c, aclexplode(c.relacl) a
    where c.oid in ('public.areas'::regclass, 'public.birthday_wishlist_ideas'::regclass)
      and a.grantee = 'anon'::regrole
  ) then
    problems := problems || 'anon gained a privilege it never had'::text;
  end if;

  if array_length(problems, 1) is null then
    raise notice 'Rollback of 051 complete: three routines restored with their original grants; both tables back to the pre-051 blanket grant. NO DATA WAS TOUCHED.';
  else
    raise exception 'Rollback of 051 did not reach the pre-051 state: %', array_to_string(problems, '; ');
  end if;
end;
$$;
