-- Repayment records for purchase-derived contributor balances.
-- Purchase allocations remain the immutable source of responsibility. Debts
-- are calculated from those snapshots and checkout payers; this table records
-- only money actually repaid between contributors.

create or replace function public.current_app_contributor_id(
  p_christmas_event_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select contributor.id
  from public.app_members as member
  join public.contributors as contributor
    on contributor.christmas_event_id = p_christmas_event_id
   and (
     contributor.id = member.contributor_id
     or contributor.person_id = member.person_id
   )
  where member.user_id = (select auth.uid())
    and member.active = true
    and contributor.active = true
  order by (contributor.id = member.contributor_id) desc
  limit 1;
$$;

revoke all on function public.current_app_contributor_id(uuid) from public;
revoke all on function public.current_app_contributor_id(uuid) from anon;
grant execute on function public.current_app_contributor_id(uuid) to authenticated;

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  christmas_event_id uuid not null
    references public.christmas_events(id) on delete restrict,
  payer_contributor_id uuid not null
    references public.contributors(id) on delete restrict,
  payee_contributor_id uuid not null
    references public.contributors(id) on delete restrict,
  amount_pennies integer not null
    check (amount_pennies > 0),
  payment_date date not null default current_date,
  recorded_by_app_member_id uuid not null
    default public.current_app_member_id()
    references public.app_members(id) on delete restrict,
  notes text
    check (notes is null or length(notes) <= 2000),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by_app_member_id uuid
    references public.app_members(id) on delete restrict,
  check (payer_contributor_id <> payee_contributor_id)
);

create index settlements_event_pair_date_idx
  on public.settlements (
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    payment_date desc
  );

alter table public.settlements enable row level security;

-- A normal member can read settlement history involving their contributor.
-- Global Admin can read all pairs for the event. Purchase obligations remain
-- readable through the existing active-member purchase policies.
create policy "members read relevant settlements"
on public.settlements
for select
to authenticated
using (
  public.is_active_app_member()
  and (
    public.is_app_admin()
    or payer_contributor_id = public.current_app_contributor_id(christmas_event_id)
    or payee_contributor_id = public.current_app_contributor_id(christmas_event_id)
  )
);

-- Settlement mutations must be atomic and permission checked by the functions
-- below. Browser sessions cannot insert, update, or delete rows directly.
revoke all on table public.settlements from public, anon;
revoke insert, update, delete on table public.settlements from authenticated;
grant select on table public.settlements to authenticated;

create or replace function public.record_settlement(
  p_christmas_event_id uuid,
  p_payer_contributor_id uuid,
  p_payee_contributor_id uuid,
  p_amount_pennies integer,
  p_payment_date date,
  p_notes text
)
returns public.settlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_member_id uuid;
  current_contributor_id uuid;
  forward_obligations bigint;
  reverse_obligations bigint;
  forward_settlements bigint;
  reverse_settlements bigint;
  outstanding_pennies bigint;
  saved_settlement public.settlements;
  pair_lock_key text;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;

  current_member_id := public.current_app_member_id();
  current_contributor_id := public.current_app_contributor_id(p_christmas_event_id);
  if current_member_id is null or current_contributor_id is null then
    raise exception 'An active contributor account is required' using errcode = '42501';
  end if;

  if not public.is_app_admin() and current_contributor_id <> p_payee_contributor_id then
    raise exception 'Only the payment receiver or Global Admin can confirm this payment'
      using errcode = '42501';
  end if;
  if p_payer_contributor_id = p_payee_contributor_id then
    raise exception 'Payment payer and receiver must be different'
      using errcode = '23514';
  end if;
  if p_amount_pennies is null or p_amount_pennies <= 0 then
    raise exception 'Payment amount must be greater than zero'
      using errcode = '23514';
  end if;
  if p_payment_date is null then
    raise exception 'Enter a payment date' using errcode = '23514';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    raise exception 'Payment notes are too long' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.contributors
    where id = p_payer_contributor_id
      and christmas_event_id = p_christmas_event_id
  ) or not exists (
    select 1
    from public.contributors
    where id = p_payee_contributor_id
      and christmas_event_id = p_christmas_event_id
  ) then
    raise exception 'Both payment contributors must belong to this Christmas event'
      using errcode = '23514';
  end if;

  -- Serialize recordings for the same event/pair so simultaneous confirmations
  -- cannot both pass the overpayment check.
  pair_lock_key := least(p_payer_contributor_id::text, p_payee_contributor_id::text)
    || '|'
    || greatest(p_payer_contributor_id::text, p_payee_contributor_id::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_christmas_event_id::text),
    pg_catalog.hashtext(pair_lock_key)
  );

  select coalesce(sum(allocation.responsibility_pennies), 0)
  into forward_obligations
  from public.purchase_allocations as allocation
  join public.purchases as purchase on purchase.id = allocation.purchase_id
  join public.christmas_recipients as recipient
    on recipient.id = purchase.christmas_recipient_id
  where recipient.christmas_event_id = p_christmas_event_id
    and purchase.deleted_at is null
    and allocation.contributor_id = p_payer_contributor_id
    and purchase.checkout_payer_contributor_id = p_payee_contributor_id;

  select coalesce(sum(allocation.responsibility_pennies), 0)
  into reverse_obligations
  from public.purchase_allocations as allocation
  join public.purchases as purchase on purchase.id = allocation.purchase_id
  join public.christmas_recipients as recipient
    on recipient.id = purchase.christmas_recipient_id
  where recipient.christmas_event_id = p_christmas_event_id
    and purchase.deleted_at is null
    and allocation.contributor_id = p_payee_contributor_id
    and purchase.checkout_payer_contributor_id = p_payer_contributor_id;

  select coalesce(sum(amount_pennies), 0)
  into forward_settlements
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null;

  select coalesce(sum(amount_pennies), 0)
  into reverse_settlements
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payee_contributor_id
    and payee_contributor_id = p_payer_contributor_id
    and voided_at is null;

  outstanding_pennies := forward_obligations
    - reverse_obligations
    - forward_settlements
    + reverse_settlements;

  if outstanding_pennies <= 0 then
    raise exception 'There is no outstanding net balance in this payment direction'
      using errcode = '23514';
  end if;
  if p_amount_pennies > outstanding_pennies then
    raise exception 'Payment exceeds the current outstanding net balance'
      using errcode = '23514';
  end if;

  insert into public.settlements (
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    amount_pennies,
    payment_date,
    recorded_by_app_member_id,
    notes
  ) values (
    p_christmas_event_id,
    p_payer_contributor_id,
    p_payee_contributor_id,
    p_amount_pennies,
    p_payment_date,
    current_member_id,
    nullif(trim(p_notes), '')
  )
  returning * into saved_settlement;

  return saved_settlement;
end;
$$;

create or replace function public.void_settlement(
  p_settlement_id uuid
)
returns public.settlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_member_id uuid;
  existing_settlement public.settlements;
  saved_settlement public.settlements;
  pair_lock_key text;
begin
  if not public.is_app_admin() then
    raise exception 'Only Global Admin can void a payment'
      using errcode = '42501';
  end if;
  current_member_id := public.current_app_member_id();

  select * into existing_settlement
  from public.settlements
  where id = p_settlement_id
    and voided_at is null;

  if not found then
    raise exception 'Active payment record not found' using errcode = 'P0002';
  end if;

  pair_lock_key := least(existing_settlement.payer_contributor_id::text, existing_settlement.payee_contributor_id::text)
    || '|'
    || greatest(existing_settlement.payer_contributor_id::text, existing_settlement.payee_contributor_id::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(existing_settlement.christmas_event_id::text),
    pg_catalog.hashtext(pair_lock_key)
  );

  update public.settlements
  set
    voided_at = now(),
    voided_by_app_member_id = current_member_id
  where id = p_settlement_id
    and voided_at is null
  returning * into saved_settlement;

  if not found then
    raise exception 'Payment was already voided' using errcode = '23514';
  end if;
  return saved_settlement;
end;
$$;

revoke all on function public.record_settlement(uuid, uuid, uuid, integer, date, text) from public;
revoke all on function public.record_settlement(uuid, uuid, uuid, integer, date, text) from anon;
grant execute on function public.record_settlement(uuid, uuid, uuid, integer, date, text) to authenticated;

revoke all on function public.void_settlement(uuid) from public;
revoke all on function public.void_settlement(uuid) from anon;
grant execute on function public.void_settlement(uuid) to authenticated;
