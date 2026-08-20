-- Two-sided payment confirmation.
--
-- WHAT CHANGES, IN ONE SENTENCE
--   A recorded payment is a CLAIM until the person who should have received it
--   says how much actually arrived, and only the confirmed part of a claim ever
--   reduces an Owed balance.
--
-- WHY
--   Until now `record_settlement` could only be called by the receiver, so a
--   payment row and a settled debt were the same thing. That is safe but
--   one-sided: the payer cannot tell anyone they have paid, and the receiver
--   has to remember to record it. Letting the payer record it without this
--   split would be worse -- money would leave a balance because the person who
--   owes it said so.
--
-- THE MODEL
--   settlements       one row per payment CLAIM. `amount_pennies` is what the
--                     payer says they sent and is never rewritten.
--                     `confirmed_amount_pennies` is what the receiver has
--                     acknowledged arriving, and is the only figure that moves
--                     a balance.
--   payment_receipts  append-only history of every review action taken on a
--                     claim. Three GBP 10 confirmations of a GBP 30 claim are
--                     three rows, not one number overwritten three times.
--
--   `settlements.status` is a STORED GENERATED column derived from those two
--   figures plus `rejected_at` / `voided_at`. It cannot drift from the money,
--   because the database recomputes it on every write rather than trusting
--   anybody to keep a second field in step.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It does not change any budget, contributor plan, purchase, allocation,
--     recipient or checkout-payer row, or any of the functions that write them.
--   * It does not change how a purchase creates an obligation. Owed is still
--     purchase allocations minus payments; only the definition of "a payment"
--     narrows, from "claimed" to "confirmed".
--   * It does not delete or rewrite a single existing payment. Every payment
--     already recorded was recorded BY ITS RECEIVER, so every one of them is
--     migrated as confirmed in full, with a receipt row explaining why. No
--     existing settled payment becomes pending.

-- ---------------------------------------------------------------------------
-- 1. Confirmation state on the existing payment row
-- ---------------------------------------------------------------------------
-- Additive columns only. `amount_pennies` -- the claim -- keeps its meaning and
-- its value, which is what preserves the audit trail.
do $$
declare
  -- True only on the first application, which is what makes the historical
  -- backfill below safe to keep in the same file as the schema change: a re-run
  -- cannot re-confirm a payment that is legitimately pending.
  is_first_application boolean := not exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.settlements'::regclass
      and attname = 'confirmed_amount_pennies'
      and not attisdropped
  );
begin
  alter table public.settlements
    add column if not exists confirmed_amount_pennies integer not null default 0,
    add column if not exists confirmed_at timestamptz,
    add column if not exists last_reviewed_at timestamptz,
    add column if not exists reviewed_by_app_member_id uuid
      references public.app_members(id) on delete restrict,
    add column if not exists rejected_at timestamptz,
    add column if not exists rejection_reason text;

  if is_first_application then
    -- THE DATA MIGRATION. Every existing row was created through the old
    -- `record_settlement`, which refused any caller who was not the payee or a
    -- Global Admin. So these are payments the receiver had already
    -- acknowledged, and treating them as anything other than confirmed in full
    -- would silently reopen settled debts and change everybody's balance.
    update public.settlements
    set
      confirmed_amount_pennies = amount_pennies,
      confirmed_at = coalesce(confirmed_at, created_at),
      last_reviewed_at = coalesce(last_reviewed_at, created_at),
      reviewed_by_app_member_id = coalesce(reviewed_by_app_member_id, recorded_by_app_member_id);
  end if;
end;
$$;

-- The invariant the whole feature rests on: a receiver can never confirm more
-- than was claimed. Enforced by the database as well as by the review function,
-- so no future caller can break it.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.settlements'::regclass
      and conname = 'settlements_confirmed_within_claim_check'
  ) then
    alter table public.settlements
      add constraint settlements_confirmed_within_claim_check
      check (
        confirmed_amount_pennies >= 0
        and confirmed_amount_pennies <= amount_pennies
      );
  end if;

  -- Same shape as `settlements_notes_safe_check` from migration 011: a real
  -- sentence, bounded, and free of control characters.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.settlements'::regclass
      and conname = 'settlements_rejection_reason_safe_check'
  ) then
    alter table public.settlements
      add constraint settlements_rejection_reason_safe_check
      check (
        rejection_reason is null
        or (
          length(trim(rejection_reason)) between 1 and 500
          and translate(rejection_reason, E'\n\r\t', '') !~ '[[:cntrl:]]'
        )
      );
  end if;

  -- A rejection is a statement about a specific moment, so the reason and the
  -- timestamp travel together or not at all.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.settlements'::regclass
      and conname = 'settlements_rejection_recorded_check'
  ) then
    alter table public.settlements
      add constraint settlements_rejection_recorded_check
      check (
        (rejected_at is null and rejection_reason is null)
        or (rejected_at is not null and rejection_reason is not null)
      );
  end if;
end;
$$;

-- The status every screen reads. Generated, not stored-and-maintained, so
-- "Confirmed" can never be shown next to a figure that says otherwise.
--
--   voided               an admin correction, or a payer withdrawing an
--                        unreviewed claim. Ignored by Owed entirely.
--   confirmed            the receiver has acknowledged the full claim.
--   partially_confirmed  some of it arrived. If `rejected_at` is also set, the
--                        receiver has closed the remainder as not received.
--   rejected             the receiver says none of it arrived.
--   pending              waiting for the receiver.
alter table public.settlements
  add column if not exists status text
  generated always as (
    case
      when voided_at is not null then 'voided'
      when confirmed_amount_pennies >= amount_pennies then 'confirmed'
      when confirmed_amount_pennies > 0 then 'partially_confirmed'
      when rejected_at is not null then 'rejected'
      else 'pending'
    end
  ) stored;

comment on column public.settlements.amount_pennies is
  'What the payer claims they sent. Never rewritten by a review, and never on its own a reason to reduce an Owed balance.';
comment on column public.settlements.confirmed_amount_pennies is
  'What the receiver has acknowledged arriving. THIS is the only figure that reduces Owed. See src/lib/owed.ts.';

-- The Owed screen's new question: "does anybody owe me a confirmation?"
create index if not exists settlements_awaiting_review_idx
  on public.settlements (christmas_event_id, payee_contributor_id)
  where voided_at is null and rejected_at is null;

-- ---------------------------------------------------------------------------
-- 2. payment_receipts -- append-only review history
-- ---------------------------------------------------------------------------
-- One row per review action. This is what makes repeated partial confirmation
-- honest: 10 then 15 then 5 against a 30 claim leaves three rows saying who
-- confirmed what and when, instead of a single field mutated three times.
--
-- The pair columns are denormalised from the settlement so the read policy can
-- be the same shape as the one on `settlements` without a join on every row.
-- The review function is the only writer, and it copies them from the
-- settlement it has already locked.
create table if not exists public.payment_receipts (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null
    references public.settlements(id) on delete restrict,
  christmas_event_id uuid not null
    references public.christmas_events(id) on delete restrict,
  payer_contributor_id uuid not null
    references public.contributors(id) on delete restrict,
  payee_contributor_id uuid not null
    references public.contributors(id) on delete restrict,

  action text not null check (action in ('confirm', 'reject')),

  -- What this action covers: the amount confirmed, or the unconfirmed
  -- remainder a rejection closed. Confirmations must be positive; the sum of
  -- the confirmations for a settlement is its `confirmed_amount_pennies`.
  amount_pennies integer not null
    check (amount_pennies >= 0),
  check (action <> 'confirm' or amount_pennies > 0),

  reason text
    check (
      reason is null
      or (
        length(trim(reason)) between 1 and 500
        and translate(reason, E'\n\r\t', '') !~ '[[:cntrl:]]'
      )
    ),
  check (action <> 'reject' or reason is not null),

  -- Where the row came from, so the log can be honest about history it did not
  -- witness:
  --   review        the receiver pressed a button in the app
  --   auto_receipt  the receiver recorded the payment themselves, which is the
  --                 same act of acknowledgement in one step
  --   migration     written by this file for a payment that predates
  --                 confirmations entirely
  source text not null default 'review'
    check (source in ('review', 'auto_receipt', 'migration')),

  reviewed_by_app_member_id uuid not null
    references public.app_members(id) on delete restrict,
  reviewer_contributor_id uuid not null
    references public.contributors(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists payment_receipts_settlement_idx
  on public.payment_receipts (settlement_id, created_at);
create index if not exists payment_receipts_event_pair_idx
  on public.payment_receipts (christmas_event_id, payer_contributor_id, payee_contributor_id);

-- The history for payments that existed before confirmations did. Written once,
-- and only for rows this file has just migrated, so the Payment Log can explain
-- their "Confirmed" status rather than asserting it from nowhere.
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
)
select
  settlement.id,
  settlement.christmas_event_id,
  settlement.payer_contributor_id,
  settlement.payee_contributor_id,
  'confirm',
  settlement.amount_pennies,
  null,
  'migration',
  settlement.recorded_by_app_member_id,
  settlement.payee_contributor_id
from public.settlements as settlement
where settlement.confirmed_amount_pennies = settlement.amount_pennies
  and not exists (
    select 1 from public.payment_receipts as receipt
    where receipt.settlement_id = settlement.id
  );

alter table public.payment_receipts enable row level security;

-- Same audience as the payment itself: the two people involved, plus Global
-- Admin for the whole event.
drop policy if exists "members read relevant payment receipts" on public.payment_receipts;
create policy "members read relevant payment receipts"
on public.payment_receipts
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

-- Financial history: readable by the people it concerns, writable only by the
-- reviewed function below.
revoke all privileges on table public.payment_receipts from public, anon, authenticated;
grant select on table public.payment_receipts to authenticated;

-- Append-only in the strongest sense available: even a client holding elevated
-- rights cannot quietly edit or erase a confirmation after the fact.
create or replace function public.payment_receipts_are_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Payment confirmation history cannot be changed or deleted'
    using errcode = '42501';
end;
$$;

drop trigger if exists payment_receipts_are_append_only on public.payment_receipts;
create trigger payment_receipts_are_append_only
  before update or delete on public.payment_receipts
  for each row execute function public.payment_receipts_are_append_only();

-- ---------------------------------------------------------------------------
-- 3. Recording a payment
-- ---------------------------------------------------------------------------
-- Same signature as migration 009, because every caller and every grant stays
-- valid. What changes is who may call it and what state the row starts in:
--
--   the payer records it   -> a claim. Pending. Owed does not move.
--   the payee records it   -> they are the one who confirms, so recording it is
--                             itself the confirmation. Confirmed in full, with
--                             an `auto_receipt` row. This is exactly the old
--                             behaviour, preserved.
--   an admin records it    -> a claim, pending the real receiver's review.
--                             Global Admin deliberately does NOT get to settle
--                             somebody else's money by asserting it arrived.
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

  if not public.is_app_admin()
    and current_contributor_id <> p_payee_contributor_id
    and current_contributor_id <> p_payer_contributor_id
  then
    raise exception 'Only the payer, the receiver or Global Admin can record this payment'
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
-- 4. Reviewing a payment
-- ---------------------------------------------------------------------------
-- The one way a payment is ever confirmed, partly confirmed or rejected.
--
-- AUTHORIZATION
--   The caller's contributor for this Christmas must be the payment's PAYEE.
--   Not the payer -- nobody confirms their own payment. Not an unrelated
--   member. And deliberately not Global Admin either: an admin can void a
--   payment (a correction that gives money BACK to a balance) but cannot assert
--   that money arrived in somebody else's bank account.
--
-- CONCURRENCY
--   The settlement row is locked FOR UPDATE before its confirmed total is read,
--   so two devices confirming the same claim at the same time are serialized:
--   the second one sees the first one's total and can only confirm what is
--   genuinely left. The table's CHECK constraint is the backstop under that.
create or replace function public.review_payment(
  p_settlement_id uuid,
  p_action text,
  p_amount_pennies integer,
  p_reason text
)
returns public.payment_receipts
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_member_id uuid;
  current_contributor_id uuid;
  existing_settlement public.settlements;
  remaining_pennies integer;
  applied_pennies integer;
  clean_reason text;
  saved_receipt public.payment_receipts;
  pair_lock_key text;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  current_member_id := public.current_app_member_id();
  if current_member_id is null then
    raise exception 'An active contributor account is required' using errcode = '42501';
  end if;

  if p_action is null or p_action not in ('confirm', 'reject') then
    raise exception 'Choose whether the payment was received' using errcode = '23514';
  end if;

  -- Read once, unlocked, purely to learn which pair this payment belongs to.
  select * into existing_settlement
  from public.settlements
  where id = p_settlement_id;

  if not found then
    raise exception 'Payment record not found' using errcode = 'P0002';
  end if;

  -- Then take the pair lock BEFORE the row lock, in the same order
  -- `record_settlement` takes them. Two operations on one pair are therefore
  -- serialized in a fixed order, so a review and a new claim cannot both size
  -- themselves against a balance the other is halfway through changing, and
  -- neither can deadlock against the other.
  pair_lock_key := least(existing_settlement.payer_contributor_id::text, existing_settlement.payee_contributor_id::text)
    || '|'
    || greatest(existing_settlement.payer_contributor_id::text, existing_settlement.payee_contributor_id::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(existing_settlement.christmas_event_id::text),
    pg_catalog.hashtext(pair_lock_key)
  );

  -- Re-read under a row lock. This is the copy every figure below is derived
  -- from: whatever another device committed while this call was waiting for the
  -- lock is now visible, so a second confirmation can only take what is left.
  select * into existing_settlement
  from public.settlements
  where id = p_settlement_id
  for update;

  if not found then
    raise exception 'Payment record not found' using errcode = 'P0002';
  end if;

  current_contributor_id := public.current_app_contributor_id(existing_settlement.christmas_event_id);
  if current_contributor_id is null
    or current_contributor_id <> existing_settlement.payee_contributor_id
  then
    raise exception 'Only the person this payment was sent to can review it'
      using errcode = '42501';
  end if;

  if existing_settlement.voided_at is not null then
    raise exception 'This payment record has been voided and cannot be reviewed'
      using errcode = '23514';
  end if;
  if existing_settlement.rejected_at is not null then
    raise exception 'This payment has already been reviewed as not received'
      using errcode = '23514';
  end if;

  remaining_pennies := existing_settlement.amount_pennies - existing_settlement.confirmed_amount_pennies;
  if remaining_pennies <= 0 then
    raise exception 'This payment is already confirmed in full' using errcode = '23514';
  end if;

  if p_action = 'confirm' then
    if p_amount_pennies is null or p_amount_pennies <= 0 then
      raise exception 'Enter how much you received' using errcode = '23514';
    end if;
    if p_amount_pennies > remaining_pennies then
      raise exception 'You cannot confirm more than the amount still unconfirmed'
        using errcode = '23514';
    end if;
    applied_pennies := p_amount_pennies;
    clean_reason := null;

    update public.settlements
    set
      confirmed_amount_pennies = confirmed_amount_pennies + applied_pennies,
      last_reviewed_at = now(),
      reviewed_by_app_member_id = current_member_id,
      confirmed_at = case
        when confirmed_amount_pennies + applied_pennies >= amount_pennies then now()
        else confirmed_at
      end
    where id = existing_settlement.id;
  else
    clean_reason := nullif(trim(coalesce(p_reason, '')), '');
    if clean_reason is null then
      raise exception 'Say why the payment has not arrived' using errcode = '23514';
    end if;
    if length(clean_reason) > 500 then
      raise exception 'Keep the reason under 500 characters' using errcode = '23514';
    end if;
    -- A rejection closes whatever is still unconfirmed. Anything already
    -- confirmed stays confirmed: the receiver said that part did arrive, and
    -- taking it back would rewrite history.
    applied_pennies := remaining_pennies;

    update public.settlements
    set
      rejected_at = now(),
      rejection_reason = clean_reason,
      last_reviewed_at = now(),
      reviewed_by_app_member_id = current_member_id
    where id = existing_settlement.id;
  end if;

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
    existing_settlement.id,
    existing_settlement.christmas_event_id,
    existing_settlement.payer_contributor_id,
    existing_settlement.payee_contributor_id,
    p_action,
    applied_pennies,
    clean_reason,
    'review',
    current_member_id,
    current_contributor_id
  )
  returning * into saved_receipt;

  return saved_receipt;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Voiding, extended by exactly one case
-- ---------------------------------------------------------------------------
-- Global Admin keeps the correction power it already had. Added: a payer may
-- withdraw their OWN claim while it is still untouched -- nothing confirmed and
-- nothing rejected. That can only ever remove a claim that was moving no money,
-- so it cannot corrupt a balance, and it is what stops a mistyped claim
-- reserving somebody's outstanding balance forever.
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
  current_contributor_id uuid;
  existing_settlement public.settlements;
  saved_settlement public.settlements;
  pair_lock_key text;
begin
  if not public.is_active_app_member() then
    raise exception 'Active app membership required' using errcode = '42501';
  end if;
  current_member_id := public.current_app_member_id();

  select * into existing_settlement
  from public.settlements
  where id = p_settlement_id
    and voided_at is null
  for update;

  if not found then
    raise exception 'Active payment record not found' using errcode = 'P0002';
  end if;

  if not public.is_app_admin() then
    current_contributor_id := public.current_app_contributor_id(existing_settlement.christmas_event_id);
    if current_contributor_id is null
      or current_contributor_id <> existing_settlement.payer_contributor_id
      or existing_settlement.confirmed_amount_pennies > 0
      or existing_settlement.rejected_at is not null
    then
      raise exception 'Only Global Admin can void a payment'
        using errcode = '42501';
    end if;
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

-- Start from nothing and grant back, so none of these can be reached by an
-- anonymous token even if a default privilege changes underneath us.
revoke all on function public.record_settlement(uuid, uuid, uuid, integer, date, text) from public, anon, authenticated;
grant execute on function public.record_settlement(uuid, uuid, uuid, integer, date, text) to authenticated;

revoke all on function public.void_settlement(uuid) from public, anon, authenticated;
grant execute on function public.void_settlement(uuid) to authenticated;

revoke all on function public.review_payment(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.review_payment(uuid, text, integer, text) to authenticated;

revoke all on function public.payment_receipts_are_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Notifications
-- ---------------------------------------------------------------------------
-- A review is a new kind of notifiable event, so the two check constraints that
-- list the kinds are widened. Nothing else about the notification system
-- changes: same outbox, same dispatcher, same push transport, same preference
-- categories.
--
-- BOTH TABLES ARE OPTIONAL HERE.
--   `notifications` arrives with migration 019 and `notification_outbox` with
--   020, and a database may be on 018 or older. Payment confirmation is a
--   financial feature and must not refuse to install because an alerting table
--   is not there yet -- so each is widened only if it exists, and skipping one
--   is announced rather than silently ignored. Re-running this file after
--   applying 019/020 picks up whichever was missed.
do $$
declare
  existing_constraint record;
begin
  if pg_catalog.to_regclass('public.notification_outbox') is not null then
    for existing_constraint in
      select conname
      from pg_catalog.pg_constraint
      where conrelid = 'public.notification_outbox'::regclass
        and contype = 'c'
        and pg_catalog.pg_get_constraintdef(oid) ilike '%gift_status%'
    loop
      execute format('alter table public.notification_outbox drop constraint %I', existing_constraint.conname);
    end loop;

    alter table public.notification_outbox
      add constraint notification_outbox_kind_check
      check (kind in ('purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review'));
  else
    raise notice 'notification_outbox does not exist, so its kind list was not widened. Apply migration 020, then re-run this migration to enable retryable payment-review notifications.';
  end if;

  if pg_catalog.to_regclass('public.notifications') is not null then
    for existing_constraint in
      select conname
      from pg_catalog.pg_constraint
      where conrelid = 'public.notifications'::regclass
        and contype = 'c'
        and pg_catalog.pg_get_constraintdef(oid) ilike '%event_kind%'
    loop
      execute format('alter table public.notifications drop constraint %I', existing_constraint.conname);
    end loop;

    alter table public.notifications
      add constraint notifications_event_kind_check
      check (event_kind is null or event_kind in ('purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review'));
  else
    raise notice 'notifications does not exist, so its event kind list was not widened. Apply migration 019, then re-run this migration to record payment reviews in the Notification Centre.';
  end if;
end;
$$;

-- The review event, queued inside the same transaction as the review itself, so
-- the payer is told whether or not the browser ever reaches the dispatch route.
--
-- Keyed by the RECEIPT, not the settlement: three partial confirmations of one
-- payment are three separate things the payer needs to hear about, and the
-- notification tables are unique per (kind, subject, fingerprint).
--
-- `auto_receipt` and `migration` rows are skipped. The first is already covered
-- by the payment's own notification, and the second describes history nobody
-- should be alerted about after the fact.
--
-- Every failure is caught and discarded, for the same reason migration 020's
-- triggers do it: the write that fired this is financial and must commit
-- whether or not anybody can be told about it. That includes the case where
-- `enqueue_notification_event` does not exist at all because migration 020 has
-- not been applied -- a missing alerting table must never be able to roll back
-- a confirmation.
create or replace function public.enqueue_payment_review_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source = 'review' then
    perform public.enqueue_notification_event(
      'payment_review', new.id, 'reviewed', new.reviewed_by_app_member_id
    );
  end if;
  return null;
exception
  when others then
    return null;
end;
$$;

revoke all on function public.enqueue_payment_review_notification() from public, anon, authenticated;

drop trigger if exists enqueue_payment_review_notification on public.payment_receipts;
create trigger enqueue_payment_review_notification
  after insert on public.payment_receipts
  for each row execute function public.enqueue_payment_review_notification();

-- ---------------------------------------------------------------------------
-- 7. Realtime
-- ---------------------------------------------------------------------------
-- `settlements` is already published by migration 014, and every review updates
-- its settlement row in the same transaction as it inserts a receipt. So the
-- existing subscription is what makes a pending payment, a confirmation and a
-- changed Owed figure all appear without a refresh, and `payment_receipts` is
-- deliberately NOT added: it would deliver a second event for the same change
-- and make every open tab refetch twice.

-- ---------------------------------------------------------------------------
-- 8. Audit
-- ---------------------------------------------------------------------------
-- No new trigger on `admin_audit_log`. `payment_receipts` IS the audit trail for
-- reviews -- append-only, attributed, and readable by the people involved -- and
-- the existing settlements trigger continues to record voids.
