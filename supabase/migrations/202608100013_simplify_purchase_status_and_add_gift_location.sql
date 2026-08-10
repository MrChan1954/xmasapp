-- Simplify purchase tracking to Purchased/Wrapped and add an optional,
-- relational physical gift location. Existing financial snapshots, purchase
-- amounts, checkout payers, and settlements are not changed.

alter table public.purchases
  drop constraint if exists purchases_status_check;

update public.purchases
set status = 'purchased'
where status in ('arrived', 'Purchased / Ordered', 'Arrived');

alter table public.purchases
  add constraint purchases_status_two_state_check
  check (status in ('purchased', 'wrapped'));

alter table public.purchases
  add column gift_location_person_id uuid
  references public.people(id) on delete set null;

create index purchases_gift_location_person_idx
  on public.purchases (gift_location_person_id)
  where gift_location_person_id is not null and deleted_at is null;

-- Keep the proven purchase/allocation transaction from migration 008 as the
-- financial writer. This canonical application entry point validates the new
-- field and status, calls that writer in the same transaction, then stores the
-- location. Location never participates in responsibility or Owed math.
create or replace function public.save_purchase_with_location(
  p_purchase_id uuid,
  p_christmas_recipient_id uuid,
  p_description text,
  p_actual_price_pennies integer,
  p_checkout_payer_contributor_id uuid,
  p_gift_location_person_id uuid,
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
  recipient_event_id uuid;
  saved_purchase public.purchases;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  if p_status not in ('purchased', 'wrapped') then
    raise exception 'Choose Purchased or Wrapped' using errcode = '23514';
  end if;

  select christmas_event_id
  into recipient_event_id
  from public.christmas_recipients
  where id = p_christmas_recipient_id;

  if not found then
    raise exception 'Christmas recipient not found' using errcode = 'P0002';
  end if;

  if p_gift_location_person_id is not null and not exists (
    select 1
    from public.contributors as location_contributor
    where location_contributor.christmas_event_id = recipient_event_id
      and location_contributor.person_id = p_gift_location_person_id
      and location_contributor.active = true
  ) then
    raise exception 'Choose an active contributor as the gift location'
      using errcode = '23514';
  end if;

  saved_purchase := public.save_purchase(
    p_purchase_id,
    p_christmas_recipient_id,
    p_description,
    p_actual_price_pennies,
    p_checkout_payer_contributor_id,
    p_purchase_date,
    p_retailer,
    p_notes,
    p_status,
    p_split_type,
    p_originating_gift_idea_id,
    p_allocations
  );

  update public.purchases
  set gift_location_person_id = p_gift_location_person_id
  where id = saved_purchase.id
  returning * into saved_purchase;

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
  if p_status not in ('purchased', 'wrapped') then
    raise exception 'Choose Purchased or Wrapped' using errcode = '23514';
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

revoke all on function public.save_purchase(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.save_purchase_with_location(uuid, uuid, text, integer, uuid, uuid, date, text, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.set_purchase_status(uuid, text)
  from public, anon, authenticated;

grant execute on function public.save_purchase_with_location(uuid, uuid, text, integer, uuid, uuid, date, text, text, text, text, uuid, jsonb)
  to authenticated;
grant execute on function public.set_purchase_status(uuid, text)
  to authenticated;
