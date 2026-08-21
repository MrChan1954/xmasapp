-- Global Admin uses the normal payment flow, and gets one explicit override.
--
-- WHAT WAS WRONG
--   Migration 021 already decided auto-confirmation by asking "is the caller the
--   person being paid?", never "is the caller an admin" -- so an admin
--   recording their own outgoing payment did correctly create a pending claim.
--   What it also did was let a Global Admin record a payment for a pair they
--   are not part of at all. That is a broader permission on the ordinary
--   action, and it is enough to make testing as an admin not the same
--   experience a normal member gets.
--
-- WHAT THIS MIGRATION DOES
--   1. `record_settlement` now admits exactly two people: the payer and the
--      person being paid. Global Admin gets no extra reach and no different
--      semantics. Admin is no longer a factor in this function at all.
--   2. A separate `admin_record_confirmed_payment` exists for the exceptional
--      case -- money that genuinely moved outside the app and needs putting in
--      the ledger. It is admin-only, demands a written reason, and records
--      itself as an override rather than pretending anybody confirmed anything.
--
-- WHAT IT DOES NOT CHANGE
--   Nothing about pending / partially confirmed / confirmed / rejected, partial
--   receipts, rejection reasons, the Owed calculation, review_payment, voiding,
--   RLS on any table, Realtime, or the notification transport. The state model
--   from 021 is untouched; only who may create a payment, and one new way to
--   create one that is confirmed from the start.

-- ---------------------------------------------------------------------------
-- 1. A fourth kind of receipt
-- ---------------------------------------------------------------------------
-- `payment_receipts.source` gains 'admin_override', and an override must carry
-- the reason it happened. The reason column already exists -- it is what a
-- rejection uses -- so this adds a rule, not a field.
do $$
declare
  existing_constraint record;
begin
  for existing_constraint in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.payment_receipts'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%auto_receipt%'
  loop
    execute format('alter table public.payment_receipts drop constraint %I', existing_constraint.conname);
  end loop;

  alter table public.payment_receipts
    add constraint payment_receipts_source_check
    check (source in ('review', 'auto_receipt', 'migration', 'admin_override'));

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.payment_receipts'::regclass
      and conname = 'payment_receipts_override_reason_check'
  ) then
    -- An override with no explanation is the one thing this feature must never
    -- allow: it would be indistinguishable from a normal confirmation and
    -- unanswerable a year later.
    alter table public.payment_receipts
      add constraint payment_receipts_override_reason_check
      check (source <> 'admin_override' or reason is not null);
  end if;
end;
$$;

comment on column public.payment_receipts.source is
  'How this acknowledgement came about: review (the receiver pressed a button), auto_receipt (the receiver recorded the payment themselves), migration (predates confirmations), admin_override (a Global Admin recorded it as confirmed, with a reason, without the receiver confirming).';

-- ---------------------------------------------------------------------------
-- 2. The ordinary payment, with no admin case at all
-- ---------------------------------------------------------------------------
-- Identical to migration 021 except for the authorization block. Behaviour is
-- decided purely by the caller's RELATIONSHIP to the payment:
--
--   caller is the payer     -> a claim. Pending. Owed does not move.
--   caller is the payee     -> they are the one who confirms, so recording it
--                              is itself the confirmation.
--   caller is anybody else  -> refused, Global Admin included.
--
-- `is_app_admin()` is deliberately absent from this function. An admin testing
-- the app therefore walks exactly the path a normal member walks.
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
  caller_is_receiver boolean;
  forward_obligations bigint;
  reverse_obligations bigint;
  forward_confirmed bigint;
  reverse_confirmed bigint;
  forward_awaiting bigint;
  outstanding_pennies bigint;
  claimable_pennies bigint;
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

  -- The whole authorization rule, and it does not mention roles.
  if current_contributor_id <> p_payee_contributor_id
    and current_contributor_id <> p_payer_contributor_id
  then
    raise exception 'Only the payer or the person being paid can record this payment'
      using errcode = '42501';
  end if;
  caller_is_receiver := current_contributor_id = p_payee_contributor_id;

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

  -- Serialize recordings for the same event/pair so two devices cannot both
  -- pass the limit check below with the same headroom.
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

  -- Only CONFIRMED money has moved a balance, so only confirmed money counts
  -- here. This mirrors `calculateNetOwedBalances` in src/lib/owed.ts exactly.
  select coalesce(sum(confirmed_amount_pennies), 0)
  into forward_confirmed
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null;

  select coalesce(sum(confirmed_amount_pennies), 0)
  into reverse_confirmed
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payee_contributor_id
    and payee_contributor_id = p_payer_contributor_id
    and voided_at is null;

  -- Claims already waiting on this receiver reserve their share of the debt.
  -- Without this, the same 20 could be claimed five times over.
  select coalesce(sum(amount_pennies - confirmed_amount_pennies), 0)
  into forward_awaiting
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null
    and rejected_at is null;

  outstanding_pennies := forward_obligations
    - reverse_obligations
    - forward_confirmed
    + reverse_confirmed;
  claimable_pennies := outstanding_pennies - forward_awaiting;

  if outstanding_pennies <= 0 then
    raise exception 'There is no outstanding net balance in this payment direction'
      using errcode = '23514';
  end if;
  if claimable_pennies <= 0 then
    raise exception 'Every outstanding penny in this direction is already awaiting confirmation'
      using errcode = '23514';
  end if;
  if p_amount_pennies > claimable_pennies then
    raise exception 'Payment exceeds the amount still outstanding and unclaimed'
      using errcode = '23514';
  end if;

  insert into public.settlements (
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    amount_pennies,
    payment_date,
    recorded_by_app_member_id,
    notes,
    confirmed_amount_pennies,
    confirmed_at,
    last_reviewed_at,
    reviewed_by_app_member_id
  ) values (
    p_christmas_event_id,
    p_payer_contributor_id,
    p_payee_contributor_id,
    p_amount_pennies,
    p_payment_date,
    current_member_id,
    nullif(trim(p_notes), ''),
    case when caller_is_receiver then p_amount_pennies else 0 end,
    case when caller_is_receiver then now() else null end,
    case when caller_is_receiver then now() else null end,
    case when caller_is_receiver then current_member_id else null end
  )
  returning * into saved_settlement;

  if caller_is_receiver then
    insert into public.payment_receipts (
      settlement_id,
      christmas_event_id,
      payer_contributor_id,
      payee_contributor_id,
      action,
      amount_pennies,
      source,
      reviewed_by_app_member_id,
      reviewer_contributor_id
    ) values (
      saved_settlement.id,
      p_christmas_event_id,
      p_payer_contributor_id,
      p_payee_contributor_id,
      'confirm',
      p_amount_pennies,
      'auto_receipt',
      current_member_id,
      current_contributor_id
    );
  end if;

  return saved_settlement;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The admin override
-- ---------------------------------------------------------------------------
-- For money that genuinely moved and never reached the app: a Global Admin
-- records it as already confirmed, and says why.
--
-- WHAT IT IS NOT
--   It is not a shortcut past a receiver who has not got round to confirming.
--   It is not usable by the admin to settle their OWN debt: an admin who is the
--   payer is refused outright, because confirming your own payment is exactly
--   the thing two-sided confirmation exists to prevent, and a role must not buy
--   a way around it. An admin who is the payee does not need this function at
--   all -- recording it normally already confirms it.
--
-- WHAT IT RECORDS
--   A settlement confirmed in full, plus an `admin_override` receipt carrying
--   the admin's member id, the moment, and the written reason. The Payment Log
--   reads that receipt and labels the payment as an admin confirmation rather
--   than letting it pass for an ordinary one.
--
-- The reviewer on the receipt is the PAYEE, because that is whose
-- acknowledgement is being stood in for; the app member is the admin, because
-- that is who actually acted. Both are recorded, so neither is implied.
create or replace function public.admin_record_confirmed_payment(
  p_christmas_event_id uuid,
  p_payer_contributor_id uuid,
  p_payee_contributor_id uuid,
  p_amount_pennies integer,
  p_payment_date date,
  p_reason text
)
returns public.settlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_member_id uuid;
  current_contributor_id uuid;
  clean_reason text;
  forward_obligations bigint;
  reverse_obligations bigint;
  forward_confirmed bigint;
  reverse_confirmed bigint;
  forward_awaiting bigint;
  outstanding_pennies bigint;
  claimable_pennies bigint;
  saved_settlement public.settlements;
  pair_lock_key text;
begin
  if not public.is_app_admin() then
    raise exception 'Only Global Admin can record a confirmed payment on behalf of others'
      using errcode = '42501';
  end if;

  current_member_id := public.current_app_member_id();
  if current_member_id is null then
    raise exception 'An active membership is required' using errcode = '42501';
  end if;
  current_contributor_id := public.current_app_contributor_id(p_christmas_event_id);

  -- No self-dealing. An admin may reconcile other people's money, never their
  -- own debt.
  if current_contributor_id is not null
    and current_contributor_id = p_payer_contributor_id
  then
    raise exception 'You cannot confirm your own payment. Record it normally and let the other person confirm it.'
      using errcode = '42501';
  end if;

  clean_reason := nullif(trim(coalesce(p_reason, '')), '');
  if clean_reason is null then
    raise exception 'Give a reason for recording this payment as already confirmed'
      using errcode = '23514';
  end if;
  if length(clean_reason) > 500 then
    raise exception 'Keep the reason under 500 characters' using errcode = '23514';
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

  select coalesce(sum(confirmed_amount_pennies), 0)
  into forward_confirmed
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null;

  select coalesce(sum(confirmed_amount_pennies), 0)
  into reverse_confirmed
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payee_contributor_id
    and payee_contributor_id = p_payer_contributor_id
    and voided_at is null;

  select coalesce(sum(amount_pennies - confirmed_amount_pennies), 0)
  into forward_awaiting
  from public.settlements
  where christmas_event_id = p_christmas_event_id
    and payer_contributor_id = p_payer_contributor_id
    and payee_contributor_id = p_payee_contributor_id
    and voided_at is null
    and rejected_at is null;

  outstanding_pennies := forward_obligations
    - reverse_obligations
    - forward_confirmed
    + reverse_confirmed;
  claimable_pennies := outstanding_pennies - forward_awaiting;

  -- Same ceiling as the ordinary path. An override corrects the ledger; it
  -- cannot invent a debt in the opposite direction, and the admin should
  -- reject or void the pending claim rather than confirm the same money twice.
  if outstanding_pennies <= 0 then
    raise exception 'There is no outstanding net balance in this payment direction'
      using errcode = '23514';
  end if;
  if claimable_pennies <= 0 then
    raise exception 'Every outstanding penny in this direction is already awaiting confirmation'
      using errcode = '23514';
  end if;
  if p_amount_pennies > claimable_pennies then
    raise exception 'Payment exceeds the amount still outstanding and unclaimed'
      using errcode = '23514';
  end if;

  insert into public.settlements (
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    amount_pennies,
    payment_date,
    recorded_by_app_member_id,
    notes,
    confirmed_amount_pennies,
    confirmed_at,
    last_reviewed_at,
    reviewed_by_app_member_id
  ) values (
    p_christmas_event_id,
    p_payer_contributor_id,
    p_payee_contributor_id,
    p_amount_pennies,
    p_payment_date,
    current_member_id,
    null,
    p_amount_pennies,
    now(),
    now(),
    current_member_id
  )
  returning * into saved_settlement;

  insert into public.payment_receipts (
    settlement_id,
    christmas_event_id,
    payer_contributor_id,
    payee_contributor_id,
    action,
    amount_pennies,
    reason,
    source,
    reviewed_by_app_member_id,
    reviewer_contributor_id
  ) values (
    saved_settlement.id,
    p_christmas_event_id,
    p_payer_contributor_id,
    p_payee_contributor_id,
    'confirm',
    p_amount_pennies,
    clean_reason,
    'admin_override',
    current_member_id,
    p_payee_contributor_id
  );

  return saved_settlement;
end;
$$;

-- Start from nothing and grant back. Authorization lives inside the function,
-- so the grant is to every signed-in member and the admin check is what stops
-- them: a normal member calling this gets 42501 and writes nothing.
revoke all on function public.record_settlement(uuid, uuid, uuid, integer, date, text) from public, anon, authenticated;
grant execute on function public.record_settlement(uuid, uuid, uuid, integer, date, text) to authenticated;

revoke all on function public.admin_record_confirmed_payment(uuid, uuid, uuid, integer, date, text) from public, anon, authenticated;
grant execute on function public.admin_record_confirmed_payment(uuid, uuid, uuid, integer, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Notifications
-- ---------------------------------------------------------------------------
-- Nothing to add. An override inserts a settlement, so migration 020's existing
-- insert trigger queues the same 'payment' event it queues for any other
-- payment, and the dispatcher reads the receipt to decide the wording -- "an
-- admin recorded a confirmed payment", never "Jade says they paid you".
--
-- The receipt trigger from 021 fires too and ignores it: that trigger only
-- queues rows whose source is 'review', and an override is not a review.
