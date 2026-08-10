-- Keep each active recipient's budget and planned contributor allocation as
-- one financial invariant. This migration validates existing rows but does
-- not change any Christmas data.

do $$
begin
  if exists (
    select 1
    from public.christmas_recipients as recipient
    left join public.recipient_contributions as contribution
      on contribution.christmas_recipient_id = recipient.id
    where recipient.active = true
    group by recipient.id, recipient.budget_pennies
    having coalesce(sum(contribution.planned_amount_pennies), 0) <> recipient.budget_pennies
  ) then
    raise exception 'Cannot install recipient budget invariant while active recipients are mismatched'
      using errcode = '23514';
  end if;
end;
$$;

-- A deferred constraint trigger lets the canonical RPC replace the whole
-- allocation snapshot inside one transaction while still rejecting a
-- mismatch at commit time from any future write path.
create or replace function public.enforce_recipient_budget_allocation_invariant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_recipient_id uuid;
  target_budget_pennies integer;
  target_is_active boolean;
  allocation_total bigint;
begin
  if tg_table_name = 'christmas_recipients' then
    target_recipient_id := new.id;
  elsif tg_op = 'DELETE' then
    target_recipient_id := old.christmas_recipient_id;
  else
    target_recipient_id := new.christmas_recipient_id;
  end if;

  select budget_pennies, active
  into target_budget_pennies, target_is_active
  from public.christmas_recipients
  where id = target_recipient_id;

  if not found or not target_is_active then
    return null;
  end if;

  select coalesce(sum(planned_amount_pennies), 0)
  into allocation_total
  from public.recipient_contributions
  where christmas_recipient_id = target_recipient_id;

  if allocation_total <> target_budget_pennies then
    raise exception 'Contributor allocations must equal the recipient budget exactly'
      using errcode = '23514';
  end if;

  -- A direct row move is not used by the app, but validate the old recipient
  -- too so even a privileged maintenance update cannot strand it mismatched.
  if tg_table_name = 'recipient_contributions' then
    if tg_op = 'UPDATE'
       and old.christmas_recipient_id is distinct from new.christmas_recipient_id then
      select budget_pennies, active
      into target_budget_pennies, target_is_active
      from public.christmas_recipients
      where id = old.christmas_recipient_id;

      if found and target_is_active then
        select coalesce(sum(planned_amount_pennies), 0)
        into allocation_total
        from public.recipient_contributions
        where christmas_recipient_id = old.christmas_recipient_id;

        if allocation_total <> target_budget_pennies then
          raise exception 'Contributor allocations must equal the recipient budget exactly'
            using errcode = '23514';
        end if;
      end if;
    end if;
  end if;

  return null;
end;
$$;

drop trigger if exists recipient_budget_allocation_invariant
  on public.christmas_recipients;
create constraint trigger recipient_budget_allocation_invariant
after insert or update of budget_pennies, active
on public.christmas_recipients
deferrable initially deferred
for each row
execute function public.enforce_recipient_budget_allocation_invariant();

drop trigger if exists recipient_contribution_allocation_invariant
  on public.recipient_contributions;
create constraint trigger recipient_contribution_allocation_invariant
after insert or update or delete
on public.recipient_contributions
deferrable initially deferred
for each row
execute function public.enforce_recipient_budget_allocation_invariant();

-- Canonical recipient planning write. For a new recipient, only Global Admin
-- may create the person and recipient. For an existing recipient, any active
-- member may replace allocations, while changing the name or budget still
-- requires Global Admin. All validation happens before the first data write.
create or replace function public.save_christmas_recipient_with_contributions(
  p_christmas_recipient_id uuid,
  p_christmas_event_id uuid,
  p_name text,
  p_budget_pennies integer,
  p_allocations jsonb
)
returns public.christmas_recipients
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_event_id uuid;
  linked_person_id uuid;
  existing_name text;
  existing_budget_pennies integer;
  existing_is_active boolean;
  details_changed boolean := false;
  allocation_count integer;
  distinct_contributor_count integer;
  active_contributor_count integer;
  allocation_total numeric;
  saved_recipient public.christmas_recipients;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
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
    if not public.is_app_admin() then
      raise exception 'Global Admin access required' using errcode = '42501';
    end if;
    if p_christmas_event_id is null or not exists (
      select 1
      from public.christmas_events
      where id = p_christmas_event_id
    ) then
      raise exception 'Christmas event not found' using errcode = 'P0002';
    end if;
    target_event_id := p_christmas_event_id;
  else
    select
      recipient.christmas_event_id,
      recipient.person_id,
      recipient.budget_pennies,
      recipient.active,
      person.name
    into
      target_event_id,
      linked_person_id,
      existing_budget_pennies,
      existing_is_active,
      existing_name
    from public.christmas_recipients as recipient
    join public.people as person on person.id = recipient.person_id
    where recipient.id = p_christmas_recipient_id
    for update of recipient, person;

    if not found then
      raise exception 'Christmas recipient not found' using errcode = 'P0002';
    end if;
    if not existing_is_active then
      raise exception 'Only active Christmas recipients can be edited'
        using errcode = '23514';
    end if;
    if p_christmas_event_id is not null and p_christmas_event_id <> target_event_id then
      raise exception 'A recipient cannot be moved to another Christmas event'
        using errcode = '23514';
    end if;

    details_changed := trim(p_name) is distinct from existing_name
      or p_budget_pennies is distinct from existing_budget_pennies;
    if details_changed and not public.is_app_admin() then
      raise exception 'Global Admin access required to change recipient details'
        using errcode = '42501';
    end if;
  end if;

  -- Serialize this snapshot against Family Access contributor activation or
  -- deactivation so the definition of "every active contributor" cannot
  -- change between validation and commit.
  lock table public.contributors in share mode;

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'A complete contributor allocation plan is required'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_allocations) as allocation(item)
    where jsonb_typeof(item) <> 'object'
       or not (item ? 'contributor_id')
       or not (item ? 'planned_amount_pennies')
       or jsonb_typeof(item -> 'contributor_id') <> 'string'
       or jsonb_typeof(item -> 'planned_amount_pennies') <> 'number'
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
  if allocation_total <> p_budget_pennies then
    raise exception 'Contributor allocations must equal the recipient budget exactly'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_allocations) as allocation(item)
    left join public.contributors as contributor
      on contributor.id = (item ->> 'contributor_id')::uuid
    where contributor.id is null
       or contributor.christmas_event_id <> target_event_id
       or contributor.active = false
  ) then
    raise exception 'Contributors must be active for this Christmas event'
      using errcode = '23514';
  end if;

  select count(*)
  into active_contributor_count
  from public.contributors
  where christmas_event_id = target_event_id
    and active = true;

  if allocation_count <> active_contributor_count then
    raise exception 'The allocation plan must include every active contributor exactly once'
      using errcode = '23514';
  end if;

  if p_christmas_recipient_id is null then
    insert into public.people (name)
    values (trim(p_name))
    returning id into linked_person_id;

    insert into public.christmas_recipients (
      christmas_event_id,
      person_id,
      budget_pennies,
      active
    ) values (
      target_event_id,
      linked_person_id,
      p_budget_pennies,
      true
    ) returning * into saved_recipient;
  else
    if details_changed then
      update public.people
      set name = trim(p_name), updated_at = now()
      where id = linked_person_id;

      update public.christmas_recipients
      set budget_pennies = p_budget_pennies, updated_at = now()
      where id = p_christmas_recipient_id
      returning * into saved_recipient;
    else
      select *
      into saved_recipient
      from public.christmas_recipients
      where id = p_christmas_recipient_id;
    end if;
  end if;

  delete from public.recipient_contributions
  where christmas_recipient_id = saved_recipient.id;

  insert into public.recipient_contributions (
    christmas_recipient_id,
    contributor_id,
    planned_amount_pennies,
    updated_at
  )
  select
    saved_recipient.id,
    (item ->> 'contributor_id')::uuid,
    (item ->> 'planned_amount_pennies')::integer,
    now()
  from jsonb_array_elements(p_allocations) as allocation(item);

  return saved_recipient;
end;
$$;

-- Keep the old functions in place for migration compatibility, but ordinary
-- authenticated application clients can only use the canonical atomic RPC.
revoke all on function public.save_christmas_recipient(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.save_recipient_contributions(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.save_christmas_recipient_with_contributions(uuid, uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.enforce_recipient_budget_allocation_invariant()
  from public, anon, authenticated;

grant execute on function public.save_christmas_recipient_with_contributions(uuid, uuid, text, integer, jsonb)
  to authenticated;

-- Restoring a legacy inactive recipient must not activate a mismatched budget.
create or replace function public.set_christmas_recipient_active(
  p_christmas_recipient_id uuid,
  p_active boolean
)
returns public.christmas_recipients
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_recipient public.christmas_recipients;
  recipient_budget_pennies integer;
  allocation_total bigint;
begin
  if not public.is_app_admin() then
    raise exception 'Global Admin access required'
      using errcode = '42501';
  end if;

  if p_active then
    select recipient.budget_pennies,
      coalesce(sum(contribution.planned_amount_pennies), 0)
    into recipient_budget_pennies, allocation_total
    from public.christmas_recipients as recipient
    left join public.recipient_contributions as contribution
      on contribution.christmas_recipient_id = recipient.id
    where recipient.id = p_christmas_recipient_id
    group by recipient.id, recipient.budget_pennies;

    if not found then
      raise exception 'Christmas recipient not found' using errcode = 'P0002';
    end if;
    if allocation_total <> recipient_budget_pennies then
      raise exception 'Contributor allocations must equal the recipient budget before restoring this person'
        using errcode = '23514';
    end if;
  end if;

  update public.christmas_recipients
  set active = p_active, updated_at = now()
  where id = p_christmas_recipient_id
  returning * into updated_recipient;

  if not found then
    raise exception 'Christmas recipient not found' using errcode = 'P0002';
  end if;

  return updated_recipient;
end;
$$;

revoke all on function public.set_christmas_recipient_active(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_christmas_recipient_active(uuid, boolean)
  to authenticated;
