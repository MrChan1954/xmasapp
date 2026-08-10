-- Actual Christmas purchases and immutable responsibility snapshots.
-- Depends on 202608100007_add_gift_ideas.sql for current_app_member_id() and
-- the optional originating gift idea relationship.

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  christmas_recipient_id uuid not null
    references public.christmas_recipients(id) on delete restrict,
  description text not null
    check (length(trim(description)) between 1 and 200),
  actual_price_pennies integer not null
    check (actual_price_pennies >= 0),
  checkout_payer_contributor_id uuid not null
    references public.contributors(id) on delete restrict,
  created_by_app_member_id uuid not null
    default public.current_app_member_id()
    references public.app_members(id) on delete restrict,
  updated_by_app_member_id uuid
    references public.app_members(id) on delete restrict,
  purchase_date date not null default current_date,
  retailer text
    check (retailer is null or length(retailer) <= 200),
  notes text
    check (notes is null or length(notes) <= 4000),
  status text not null default 'purchased'
    check (status in ('purchased', 'arrived', 'wrapped')),
  split_type text not null default 'automatic'
    check (split_type in ('automatic', 'custom')),
  originating_gift_idea_id uuid
    references public.gift_ideas(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by_app_member_id uuid
    references public.app_members(id) on delete restrict
);

create table public.purchase_allocations (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null
    references public.purchases(id) on delete cascade,
  contributor_id uuid not null
    references public.contributors(id) on delete restrict,
  responsibility_pennies integer not null
    check (responsibility_pennies >= 0),
  created_at timestamptz not null default now(),
  unique (purchase_id, contributor_id)
);

create index purchases_recipient_date_idx
  on public.purchases (christmas_recipient_id, purchase_date desc, created_at desc);

create index purchases_checkout_payer_idx
  on public.purchases (checkout_payer_contributor_id)
  where deleted_at is null;

create unique index purchases_one_active_purchase_per_idea_idx
  on public.purchases (originating_gift_idea_id)
  where originating_gift_idea_id is not null and deleted_at is null;

create index purchase_allocations_contributor_idx
  on public.purchase_allocations (contributor_id, purchase_id);

alter table public.purchases enable row level security;
alter table public.purchase_allocations enable row level security;

create policy "active members read purchases"
on public.purchases
for select
to authenticated
using (public.is_active_app_member());

create policy "active members read purchase allocations"
on public.purchase_allocations
for select
to authenticated
using (public.is_active_app_member());

-- Financial writes only use the validated SECURITY DEFINER functions below.
-- Browser sessions can read snapshots but cannot partially change a purchase
-- or its allocations with direct table operations.
revoke all on table public.purchases from public, anon;
revoke all on table public.purchase_allocations from public, anon;
revoke insert, update, delete on table public.purchases from authenticated;
revoke insert, update, delete on table public.purchase_allocations from authenticated;
grant select on table public.purchases to authenticated;
grant select on table public.purchase_allocations to authenticated;

create or replace function public.save_purchase(
  p_purchase_id uuid,
  p_christmas_recipient_id uuid,
  p_description text,
  p_actual_price_pennies integer,
  p_checkout_payer_contributor_id uuid,
  p_purchase_date date,
  p_retailer text,
  p_notes text,
  p_status text,
  p_split_type text,
  p_originating_gift_idea_id uuid,
  p_allocations jsonb
)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_member_id uuid;
  recipient_event_id uuid;
  recipient_is_active boolean;
  existing_purchase public.purchases;
  saved_purchase public.purchases;
  allocation_count integer;
  distinct_contributor_count integer;
  allocation_total numeric;
  is_new boolean := p_purchase_id is null;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;

  current_member_id := public.current_app_member_id();
  if current_member_id is null then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;

  select christmas_event_id, active
  into recipient_event_id, recipient_is_active
  from public.christmas_recipients
  where id = p_christmas_recipient_id;

  if recipient_event_id is null then
    raise exception 'Christmas recipient not found' using errcode = 'P0002';
  end if;
  if is_new and not recipient_is_active then
    raise exception 'Purchases can only be added for an active Christmas recipient'
      using errcode = '23514';
  end if;

  if not is_new then
    select * into existing_purchase
    from public.purchases
    where id = p_purchase_id
      and deleted_at is null;

    if not found then
      raise exception 'Purchase not found' using errcode = 'P0002';
    end if;
    if existing_purchase.christmas_recipient_id <> p_christmas_recipient_id then
      raise exception 'A purchase cannot be moved to another recipient'
        using errcode = '23514';
    end if;
  end if;

  if p_description is null
     or length(trim(p_description)) < 1
     or length(trim(p_description)) > 200 then
    raise exception 'Enter a purchase description' using errcode = '23514';
  end if;
  if p_actual_price_pennies is null or p_actual_price_pennies < 0 then
    raise exception 'Enter a valid purchase price' using errcode = '23514';
  end if;
  if p_purchase_date is null then
    raise exception 'Enter a purchase date' using errcode = '23514';
  end if;
  if p_status not in ('purchased', 'arrived', 'wrapped') then
    raise exception 'Choose a valid purchase status' using errcode = '23514';
  end if;
  if p_split_type not in ('automatic', 'custom') then
    raise exception 'Choose a valid responsibility split type' using errcode = '23514';
  end if;
  if p_retailer is not null and length(p_retailer) > 200 then
    raise exception 'Retailer is too long' using errcode = '23514';
  end if;
  if p_notes is not null and length(p_notes) > 4000 then
    raise exception 'Notes are too long' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.contributors
    where id = p_checkout_payer_contributor_id
      and christmas_event_id = recipient_event_id
      and active = true
  ) then
    raise exception 'Checkout payer must be an active contributor for this Christmas'
      using errcode = '23514';
  end if;

  if p_originating_gift_idea_id is not null and not exists (
    select 1
    from public.gift_ideas
    where id = p_originating_gift_idea_id
      and christmas_recipient_id = p_christmas_recipient_id
  ) then
    raise exception 'The originating gift idea does not belong to this recipient'
      using errcode = '23514';
  end if;

  if p_allocations is null
     or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'At least one responsibility allocation is required'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_allocations) as allocation(item)
    where jsonb_typeof(item) <> 'object'
       or not (item ? 'contributor_id')
       or not (item ? 'responsibility_pennies')
       or coalesce(item ->> 'contributor_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(item ->> 'responsibility_pennies', '') !~ '^[0-9]+$'
  ) then
    raise exception 'Purchase allocations are invalid' using errcode = '23514';
  end if;

  select
    count(*),
    count(distinct item ->> 'contributor_id'),
    coalesce(sum((item ->> 'responsibility_pennies')::numeric), 0)
  into allocation_count, distinct_contributor_count, allocation_total
  from jsonb_array_elements(p_allocations) as allocation(item);

  if allocation_count <> distinct_contributor_count then
    raise exception 'Each contributor can appear only once in a purchase split'
      using errcode = '23514';
  end if;
  if allocation_total <> p_actual_price_pennies then
    raise exception 'Purchase responsibilities must equal the purchase price exactly'
      using errcode = '23514';
  end if;
  if allocation_total > 2147483647 then
    raise exception 'Purchase allocation is too large' using errcode = '22003';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_allocations) as allocation(item)
    left join public.contributors as contributor
      on contributor.id = (item ->> 'contributor_id')::uuid
    where contributor.id is null
       or contributor.christmas_event_id <> recipient_event_id
       or (
         is_new
         and contributor.active = false
       )
       or (
         not is_new
         and contributor.active = false
         and not exists (
           select 1
           from public.purchase_allocations as old_allocation
           where old_allocation.purchase_id = p_purchase_id
             and old_allocation.contributor_id = contributor.id
         )
       )
  ) then
    raise exception 'Responsibility contributors must belong to this Christmas'
      using errcode = '23514';
  end if;

  if is_new then
    insert into public.purchases (
      christmas_recipient_id,
      description,
      actual_price_pennies,
      checkout_payer_contributor_id,
      created_by_app_member_id,
      updated_by_app_member_id,
      purchase_date,
      retailer,
      notes,
      status,
      split_type,
      originating_gift_idea_id
    ) values (
      p_christmas_recipient_id,
      trim(p_description),
      p_actual_price_pennies,
      p_checkout_payer_contributor_id,
      current_member_id,
      current_member_id,
      p_purchase_date,
      nullif(trim(p_retailer), ''),
      nullif(trim(p_notes), ''),
      p_status,
      p_split_type,
      p_originating_gift_idea_id
    ) returning * into saved_purchase;
  else
    update public.purchases
    set
      description = trim(p_description),
      actual_price_pennies = p_actual_price_pennies,
      checkout_payer_contributor_id = p_checkout_payer_contributor_id,
      updated_by_app_member_id = current_member_id,
      purchase_date = p_purchase_date,
      retailer = nullif(trim(p_retailer), ''),
      notes = nullif(trim(p_notes), ''),
      status = p_status,
      split_type = p_split_type,
      originating_gift_idea_id = p_originating_gift_idea_id,
      updated_at = now()
    where id = p_purchase_id
      and deleted_at is null
    returning * into saved_purchase;

    delete from public.purchase_allocations
    where purchase_id = p_purchase_id;
  end if;

  insert into public.purchase_allocations (
    purchase_id,
    contributor_id,
    responsibility_pennies
  )
  select
    saved_purchase.id,
    (item ->> 'contributor_id')::uuid,
    (item ->> 'responsibility_pennies')::integer
  from jsonb_array_elements(p_allocations) as allocation(item);

  return saved_purchase;
end;
$$;

create or replace function public.set_purchase_status(
  p_purchase_id uuid,
  p_status text
)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_purchase public.purchases;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  if p_status not in ('purchased', 'arrived', 'wrapped') then
    raise exception 'Choose a valid purchase status' using errcode = '23514';
  end if;

  update public.purchases
  set
    status = p_status,
    updated_by_app_member_id = public.current_app_member_id(),
    updated_at = now()
  where id = p_purchase_id
    and deleted_at is null
  returning * into saved_purchase;

  if not found then
    raise exception 'Purchase not found' using errcode = 'P0002';
  end if;
  return saved_purchase;
end;
$$;

create or replace function public.void_purchase(
  p_purchase_id uuid
)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_purchase public.purchases;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;

  update public.purchases
  set
    deleted_at = now(),
    deleted_by_app_member_id = public.current_app_member_id(),
    updated_by_app_member_id = public.current_app_member_id(),
    updated_at = now()
  where id = p_purchase_id
    and deleted_at is null
  returning * into saved_purchase;

  if not found then
    raise exception 'Purchase not found' using errcode = 'P0002';
  end if;
  return saved_purchase;
end;
$$;

revoke all on function public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb) from public;
revoke all on function public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb) from anon;
grant execute on function public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb) to authenticated;

revoke all on function public.set_purchase_status(uuid, text) from public;
revoke all on function public.set_purchase_status(uuid, text) from anon;
grant execute on function public.set_purchase_status(uuid, text) to authenticated;

revoke all on function public.void_purchase(uuid) from public;
revoke all on function public.void_purchase(uuid) from anon;
grant execute on function public.void_purchase(uuid) to authenticated;
