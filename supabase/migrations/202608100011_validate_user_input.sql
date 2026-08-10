-- Authoritative validation for every browser-editable stored value.
--
-- Existing rows are left untouched. New CHECK constraints are NOT VALID so
-- deployment cannot fail because of legacy data, while PostgreSQL still
-- enforces them for every new or changed row.

alter table public.christmas_events
  add constraint christmas_events_name_safe_check
  check (
    length(trim(name)) between 1 and 100
    and trim(name) !~ '[[:cntrl:]]'
  ) not valid;

alter table public.people
  add constraint people_name_safe_check
  check (
    length(trim(name)) between 1 and 100
    and trim(name) !~ '[[:cntrl:]]'
  ) not valid;

alter table public.app_members
  add constraint app_members_role_known_check
  check (role in ('admin', 'member')) not valid;

alter table public.app_members
  add constraint app_members_email_safe_check
  check (
    email is null
    or (
      length(email) between 3 and 254
      and email = lower(trim(email))
      and email !~ '[[:space:][:cntrl:]]'
      and email ~ '^[^@]+@[^@]+\.[^@]+$'
    )
  ) not valid;

alter table public.gift_ideas
  add constraint gift_ideas_title_safe_check
  check (
    length(trim(title)) between 1 and 200
    and trim(title) !~ '[[:cntrl:]]'
  ) not valid;

alter table public.gift_ideas
  add constraint gift_ideas_retailer_safe_check
  check (
    retailer is null
    or (
      length(trim(retailer)) between 1 and 200
      and trim(retailer) !~ '[[:cntrl:]]'
    )
  ) not valid;

alter table public.gift_ideas
  add constraint gift_ideas_url_safe_check
  check (
    url is null
    or (
      length(url) between 1 and 2048
      and url = trim(url)
      and url !~ '[[:space:][:cntrl:]]'
      and url ~* '^https?://[^/?#@]+([/?#][^[:space:]]*)?$'
    )
  ) not valid;

alter table public.gift_ideas
  add constraint gift_ideas_notes_safe_check
  check (
    notes is null
    or (
      length(trim(notes)) between 1 and 4000
      and translate(notes, E'\n\r\t', '') !~ '[[:cntrl:]]'
    )
  ) not valid;

alter table public.purchases
  add constraint purchases_description_safe_check
  check (
    length(trim(description)) between 1 and 200
    and trim(description) !~ '[[:cntrl:]]'
  ) not valid;

alter table public.purchases
  add constraint purchases_retailer_safe_check
  check (
    retailer is null
    or (
      length(trim(retailer)) between 1 and 200
      and trim(retailer) !~ '[[:cntrl:]]'
    )
  ) not valid;

alter table public.purchases
  add constraint purchases_notes_safe_check
  check (
    notes is null
    or (
      length(trim(notes)) between 1 and 4000
      and translate(notes, E'\n\r\t', '') !~ '[[:cntrl:]]'
    )
  ) not valid;

alter table public.settlements
  add constraint settlements_notes_safe_check
  check (
    notes is null
    or (
      length(trim(notes)) between 1 and 2000
      and translate(notes, E'\n\r\t', '') !~ '[[:cntrl:]]'
    )
  ) not valid;

-- Person and recipient writes are now atomic and independently authorized.
create or replace function public.save_christmas_recipient(
  p_christmas_recipient_id uuid,
  p_christmas_event_id uuid,
  p_name text,
  p_budget_pennies integer
)
returns public.christmas_recipients
language plpgsql
security definer
set search_path = ''
as $$
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

-- Gift idea writes use one validated entry point. Rich HTML is not supported;
-- prose remains plain text and URLs must use an HTTP(S) origin without userinfo.
create or replace function public.save_gift_idea(
  p_gift_idea_id uuid,
  p_christmas_recipient_id uuid,
  p_title text,
  p_estimated_price_pennies integer,
  p_retailer text,
  p_url text,
  p_notes text
)
returns public.gift_ideas
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_idea public.gift_ideas;
  existing_recipient_id uuid;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  if p_christmas_recipient_id is null or not exists (
    select 1 from public.christmas_recipients where id = p_christmas_recipient_id
  ) then
    raise exception 'Christmas recipient not found' using errcode = 'P0002';
  end if;
  if p_title is null
     or length(trim(p_title)) not between 1 and 200
     or trim(p_title) ~ '[[:cntrl:]]' then
    raise exception 'Enter a valid gift idea' using errcode = '23514';
  end if;
  if p_estimated_price_pennies is not null and p_estimated_price_pennies < 0 then
    raise exception 'Enter a valid estimated price' using errcode = '23514';
  end if;
  if p_retailer is not null and (
    length(trim(p_retailer)) not between 1 and 200
    or trim(p_retailer) ~ '[[:cntrl:]]'
  ) then
    raise exception 'Enter a valid retailer' using errcode = '23514';
  end if;
  if p_notes is not null and (
    length(trim(p_notes)) not between 1 and 4000
    or translate(p_notes, E'\n\r\t', '') ~ '[[:cntrl:]]'
  ) then
    raise exception 'Enter valid gift notes' using errcode = '23514';
  end if;
  if p_url is not null and (
    length(p_url) not between 1 and 2048
    or p_url <> trim(p_url)
    or p_url ~ '[[:space:][:cntrl:]]'
    or p_url !~* '^https?://[^/?#@]+([/?#][^[:space:]]*)?$'
  ) then
    raise exception 'Enter a valid HTTP or HTTPS product link' using errcode = '23514';
  end if;

  if p_gift_idea_id is null then
    if not exists (
      select 1
      from public.christmas_recipients
      where id = p_christmas_recipient_id and active = true
    ) then
      raise exception 'Gift ideas can only be added for an active recipient'
        using errcode = '23514';
    end if;

    insert into public.gift_ideas (
      christmas_recipient_id,
      title,
      estimated_price_pennies,
      retailer,
      url,
      notes,
      suggested_by_app_member_id
    ) values (
      p_christmas_recipient_id,
      trim(p_title),
      p_estimated_price_pennies,
      nullif(trim(p_retailer), ''),
      nullif(trim(p_url), ''),
      nullif(trim(p_notes), ''),
      public.current_app_member_id()
    ) returning * into saved_idea;
  else
    select christmas_recipient_id into existing_recipient_id
    from public.gift_ideas
    where id = p_gift_idea_id;

    if existing_recipient_id is null then
      raise exception 'Gift idea not found' using errcode = 'P0002';
    end if;
    if existing_recipient_id <> p_christmas_recipient_id then
      raise exception 'A gift idea cannot be moved to another recipient'
        using errcode = '23514';
    end if;

    update public.gift_ideas
    set
      title = trim(p_title),
      estimated_price_pennies = p_estimated_price_pennies,
      retailer = nullif(trim(p_retailer), ''),
      url = nullif(trim(p_url), ''),
      notes = nullif(trim(p_notes), ''),
      updated_at = now()
    where id = p_gift_idea_id
    returning * into saved_idea;
  end if;

  return saved_idea;
end;
$$;

-- Contributor allocations are financial planning values. Validate IDs, event
-- membership, integer pennies, uniqueness, and the exact budget total in one
-- transaction before replacing the active snapshot.
create or replace function public.save_recipient_contributions(
  p_christmas_recipient_id uuid,
  p_allocations jsonb
)
returns setof public.recipient_contributions
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Browser clients may read these tables, but stored-value mutations now use
-- the independently validating functions above.
revoke insert, update on table public.people from authenticated;
revoke insert, update on table public.christmas_recipients from authenticated;
revoke insert, update on table public.recipient_contributions from authenticated;
revoke insert, update on table public.gift_ideas from authenticated;

revoke all on function public.save_christmas_recipient(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.save_gift_idea(uuid, uuid, text, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.save_recipient_contributions(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.save_christmas_recipient(uuid, uuid, text, integer) to authenticated;
grant execute on function public.save_gift_idea(uuid, uuid, text, integer, text, text, text) to authenticated;
grant execute on function public.save_recipient_contributions(uuid, jsonb) to authenticated;
