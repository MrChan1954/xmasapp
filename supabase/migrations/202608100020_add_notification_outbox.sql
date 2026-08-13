-- A database-backed outbox, so a real event cannot be lost by a browser.
--
-- WHY THIS EXISTS
--   Until now the only thing that turned a saved purchase into a notification
--   was a `fetch` the browser fired after the write. That request is best
--   effort by construction: if it never left the device, was cut short, or the
--   server rejected it, nothing anywhere recorded that an event had happened
--   and no retry was possible. The action was saved and the family was never
--   told, silently.
--
--   These triggers move the record of "something notifiable happened" into the
--   same transaction as the write itself. If the purchase exists, the outbox
--   row exists. Delivery can then be attempted as many times as it takes, by
--   whichever request gets there first.
--
-- ADDITIVE ONLY. No financial behaviour changes:
--   * no budget, allocation, split, settlement or Owed value is read or written
--   * no existing column, policy, grant, function or RLS rule is modified
--   * the trigger functions only ever INSERT into the new table below, and each
--     swallows its own errors, so a notification problem can never fail — or
--     roll back — a purchase, a gift idea or a payment.

-- ---------------------------------------------------------------------------
-- notification_outbox
-- ---------------------------------------------------------------------------
-- Deliberately tiny: what happened, to which row, and who did it. No message
-- text, no recipients, no money. All three are derived at delivery time from
-- authoritative data by `src/lib/notification-dispatch.ts`, exactly as they are
-- for the immediate path — this table only guarantees the event is not lost.
create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('purchase', 'payment', 'gift_idea', 'gift_status')),
  -- The purchase / settlement / gift idea this is about.
  subject_id uuid not null,
  -- Matches `notification_events.fingerprint`, so an outbox row and a live
  -- dispatch for the same event converge on one ledger entry and one send.
  fingerprint text not null
    check (length(fingerprint) between 1 and 200),
  -- Taken from the row's own actor column by the trigger, never from a client.
  actor_app_member_id uuid
    references public.app_members(id) on delete set null,
  created_at timestamptz not null default now(),
  attempts integer not null default 0
    check (attempts >= 0),
  last_attempt_at timestamptz,
  processed_at timestamptz,
  -- The same event arriving twice (a retried save, an edit that lands on the
  -- same status) is one row, so the outbox cannot inflate a fan-out.
  unique (kind, subject_id, fingerprint)
);

-- The drain's only query: the oldest handful of unprocessed rows.
create index if not exists notification_outbox_pending_idx
  on public.notification_outbox (created_at)
  where processed_at is null;

alter table public.notification_outbox enable row level security;

-- No grants at all, and no policies. Only the server's secret-key client reads
-- or writes this, the same as `notification_events`. The trigger functions are
-- `security definer`, so they insert without needing a grant for the member
-- whose save fired them.
revoke all privileges on table public.notification_outbox from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enqueuing
-- ---------------------------------------------------------------------------
-- One helper, so every trigger below has identical failure behaviour: an
-- exception here is caught and discarded. That is the whole point — the write
-- that fired this trigger is financial and must commit regardless of whether
-- anybody can be notified about it.
create or replace function public.enqueue_notification_event(
  p_kind text,
  p_subject_id uuid,
  p_fingerprint text,
  p_actor_app_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_outbox (kind, subject_id, fingerprint, actor_app_member_id)
  values (p_kind, p_subject_id, p_fingerprint, p_actor_app_member_id)
  on conflict (kind, subject_id, fingerprint) do nothing;
exception
  when others then
    -- Never propagate. A failure to queue a notification is not a reason to
    -- lose a purchase.
    null;
end;
$$;

revoke all on function public.enqueue_notification_event(text, uuid, text, uuid)
  from public, anon, authenticated;

-- A new purchase.
create or replace function public.enqueue_purchase_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null then
    perform public.enqueue_notification_event(
      'purchase', new.id, 'created', new.created_by_app_member_id
    );
  end if;
  return null;
end;
$$;

drop trigger if exists enqueue_purchase_notification on public.purchases;
create trigger enqueue_purchase_notification
  after insert on public.purchases
  for each row execute function public.enqueue_purchase_notification();

-- Purchased / wrapped progress. Only a real change of status, so re-saving a
-- purchase without touching it queues nothing, and a soft delete (which moves
-- `deleted_at`, not `status`) queues nothing either.
create or replace function public.enqueue_gift_status_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null
    and new.status is distinct from old.status
    and new.status in ('purchased', 'wrapped')
  then
    perform public.enqueue_notification_event(
      'gift_status', new.id, 'status:' || new.status, new.updated_by_app_member_id
    );
  end if;
  return null;
end;
$$;

drop trigger if exists enqueue_gift_status_notification on public.purchases;
create trigger enqueue_gift_status_notification
  after update of status on public.purchases
  for each row execute function public.enqueue_gift_status_notification();

-- A new gift idea. Edits are not news and are deliberately not queued.
create or replace function public.enqueue_gift_idea_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_notification_event(
    'gift_idea', new.id, 'created', new.suggested_by_app_member_id
  );
  return null;
end;
$$;

drop trigger if exists enqueue_gift_idea_notification on public.gift_ideas;
create trigger enqueue_gift_idea_notification
  after insert on public.gift_ideas
  for each row execute function public.enqueue_gift_idea_notification();

-- A recorded repayment.
create or replace function public.enqueue_payment_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.voided_at is null then
    perform public.enqueue_notification_event(
      'payment', new.id, 'recorded', new.recorded_by_app_member_id
    );
  end if;
  return null;
end;
$$;

drop trigger if exists enqueue_payment_notification on public.settlements;
create trigger enqueue_payment_notification
  after insert on public.settlements
  for each row execute function public.enqueue_payment_notification();

-- ---------------------------------------------------------------------------
-- Idempotent Notification Centre rows
-- ---------------------------------------------------------------------------
-- 019 wrote the in-app rows only when the dispatcher won the race to claim the
-- event. That was correct as long as claiming and delivering happened together,
-- but with the outbox a first attempt can claim the event and then die before
-- writing anything, and the retry would skip the rows forever.
--
-- With this key the writer can simply insert on every attempt and let the
-- database discard repeats, which is true idempotence rather than a guess about
-- whether somebody else got there first.
create unique index if not exists notifications_event_recipient_key
  on public.notifications (app_member_id, event_kind, event_subject_id, category);
