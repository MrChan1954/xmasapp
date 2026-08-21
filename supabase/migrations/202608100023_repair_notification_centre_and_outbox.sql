-- Catch-up: bring a database that skipped 019 and 020 to the final intended
-- notification schema.
--
-- WHY THIS FILE EXISTS
--   A production audit on 2026-08-21 found this exact state:
--
--     018 applied    push_subscriptions, notification_preferences,
--                    notification_events all present
--     019 NOT applied  no `notifications` table; `notification_events` never
--                      gained delivered_count / attempt_count / last_attempt_at
--     020 NOT applied  no `notification_outbox`, no enqueue_notification_event,
--                      none of the four enqueue triggers
--     021 applied    payment confirmations, INCLUDING its
--                    enqueue_payment_review_notification trigger -- but its
--                    block that widens the notification CHECK constraints took
--                    the `else raise notice` branch, because neither table
--                    existed to widen
--     022 applied    admin payment override
--
--   Applying 019 and 020 by hand now would rebuild the two tables with the
--   NARROW constraints they originally shipped -- the ones that do not list
--   'payment_review' -- and 021's widening has already run and will not run
--   again. Every payment review would then fail its CHECK. This file does the
--   whole catch-up in one reviewed step instead, and finishes by asserting the
--   end state rather than hoping for it.
--
-- A THIRD GAP, FOUND WHILE WRITING THIS
--   `notification_events.kind` (migration 018) is also limited to the original
--   four kinds. NOTHING has ever widened it -- not 019, not 020, not 021. The
--   dispatcher upserts every dispatch into that table, including
--   'payment_review' (src/lib/notification-dispatch.ts, and
--   src/app/owed/page.tsx calls notifyFamily("payment_review", ...) after a
--   review). So on the CURRENT production database a payment review already
--   fails to claim its ledger row. It is not fatal -- the dispatcher logs
--   `ledger-claim-failed` and sends anyway -- but the event is never recorded,
--   so it is never deduplicated and never retried correctly. Widened below.
--
-- SAFE TO RUN ON A DATABASE THAT ALREADY HAS 019 AND 020
--   Every statement is create-if-not-exists, create-or-replace, or a
--   drop-then-add of a constraint matched by its own definition. A database
--   that applied every migration in order reaches the same end state.
--
-- WHAT THIS FILE DOES NOT DO
--   * It does not edit migration 021 or 022, or re-run any part of them.
--   * It does not redefine enqueue_payment_review_notification -- 021 owns it
--     and it is already installed. This file only checks it is still there.
--   * It touches no budget, purchase, allocation, settlement, receipt or Owed
--     value, and creates no financial trigger.
--   * It backfills no rows. There is nothing to backfill: 019 and 020 shipped
--     no data migration, and the 10 existing notification_events rows keep
--     their values and gain the new counters at their defaults.
--   * It deletes nothing.

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
-- Everything below assumes 018's tables exist. If they do not, the database is
-- further behind than this file is designed for and should apply 018 first.
do $$
begin
  if pg_catalog.to_regclass('public.notification_events') is null then
    raise exception 'notification_events is missing. Apply migration 018 before this catch-up file.';
  end if;
  if pg_catalog.to_regclass('public.app_members') is null then
    raise exception 'app_members is missing. This database is not far enough along for this file.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. notifications  (from migration 019)
-- ---------------------------------------------------------------------------
-- One row per (meaningful event, recipient). The durable record; push is an
-- optional OS alert layered on top. The finished sentence is stored rather than
-- a foreign key into the financial tables, so this can never become a second,
-- disagreeing view of the money.
--
-- `event_kind` is created WITH 'payment_review' already in it, which is the
-- only difference from 019's original text.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  app_member_id uuid not null
    references public.app_members(id) on delete cascade,

  category text not null check (category in (
    'purchases', 'money_i_owe', 'money_owed_to_me', 'gift_ideas', 'gift_status'
  )),

  title text not null check (length(title) between 1 and 120),
  body text not null check (length(body) between 1 and 300),

  -- A site-relative path only: one leading slash, and explicitly not `//host`,
  -- which a browser resolves as protocol-relative and would follow off-site.
  target_url text not null check (target_url ~ '^/[^/]' or target_url = '/'),

  event_kind text check (event_kind in (
    'purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review'
  )),
  event_subject_id uuid,

  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_member_created_idx
  on public.notifications (app_member_id, created_at desc);
create index if not exists notifications_member_unread_idx
  on public.notifications (app_member_id)
  where read_at is null;

-- From 020: what makes writing the in-app rows idempotent, so a retry after a
-- half-finished attempt cannot duplicate them.
create unique index if not exists notifications_event_recipient_key
  on public.notifications (app_member_id, event_kind, event_subject_id, category);

alter table public.notifications enable row level security;

revoke all privileges on table public.notifications from public, anon, authenticated;
-- No INSERT and no DELETE for a browser session: creation is server-side only,
-- so a member cannot post into anybody's inbox -- including their own -- and
-- nobody can erase their own history.
grant select, update on table public.notifications to authenticated;

drop policy if exists "members read their own notifications" on public.notifications;
create policy "members read their own notifications"
on public.notifications
for select
to authenticated
using (app_member_id = public.current_app_member_id());

-- `using` decides which rows may be updated; `with check` stops an update
-- moving a row onto somebody else's membership.
--
-- There is deliberately NO Global Admin policy on this table. The Notification
-- Centre is personal, and an admin reading the family's inboxes would be a
-- straightforward privacy regression.
drop policy if exists "members update their own notifications" on public.notifications;
create policy "members update their own notifications"
on public.notifications
for update
to authenticated
using (app_member_id = public.current_app_member_id())
with check (app_member_id = public.current_app_member_id());

-- RLS decides WHICH rows a member may update; this decides WHAT they may
-- change. Without it "mark as read" is a general-purpose edit and a member
-- could rewrite their own notification's text or retarget its link.
create or replace function public.protect_notification_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.app_member_id is distinct from old.app_member_id
    or new.category is distinct from old.category
    or new.title is distinct from old.title
    or new.body is distinct from old.body
    or new.target_url is distinct from old.target_url
    or new.event_kind is distinct from old.event_kind
    or new.event_subject_id is distinct from old.event_subject_id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Only the read state of a notification can be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_notification_content() from public, anon, authenticated;

drop trigger if exists protect_notification_content on public.notifications;
create trigger protect_notification_content
  before update on public.notifications
  for each row execute function public.protect_notification_content();

-- ---------------------------------------------------------------------------
-- 2. notification_events catch-up  (from migration 019, plus the third gap)
-- ---------------------------------------------------------------------------
-- The retry split: "the event became notifications" and "the event reached a
-- device" are separate facts. 018 claimed the event BEFORE attempting delivery,
-- so a send that reached nobody was permanently marked handled.
--
-- Existing rows keep their values. `delivered_count` defaults to 0, which is
-- the correct reading for them: nothing was ever delivered.
alter table public.notification_events
  add column if not exists delivered_count integer not null default 0
    check (delivered_count >= 0),
  add column if not exists attempt_count integer not null default 0
    check (attempt_count >= 0),
  add column if not exists last_attempt_at timestamptz;

comment on column public.notification_events.delivered_count is
  'Push messages a push service has accepted for this event. 0 means delivery may be retried; the in-app notifications were still created exactly once.';

-- The third gap. 018 wrote this list and nothing has widened it since, but the
-- dispatcher claims a ledger row for EVERY kind it handles, payment_review
-- included. Widened by matching the constraint on its own definition, the same
-- technique 021 and 022 use, so the constraint's generated name does not matter.
do $$
declare
  existing_constraint record;
begin
  for existing_constraint in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.notification_events'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%gift_status%'
  loop
    execute format('alter table public.notification_events drop constraint %I', existing_constraint.conname);
  end loop;

  alter table public.notification_events
    add constraint notification_events_kind_check
    check (kind in ('purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. notification_outbox  (from migration 020)
-- ---------------------------------------------------------------------------
-- Deliberately tiny: what happened, to which row, and who did it. No message
-- text, no recipients, no money -- all three are derived at delivery time from
-- authoritative data. This table only guarantees the event is not lost when a
-- browser's fire-and-forget dispatch never arrives.
--
-- Created WITH 'payment_review' in the kind list, which is the only difference
-- from 020's original text.
create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review')),
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
  -- The same event arriving twice (a retried save, an edit landing on the same
  -- status) is one row, so the outbox cannot inflate a fan-out.
  unique (kind, subject_id, fingerprint)
);

create index if not exists notification_outbox_pending_idx
  on public.notification_outbox (created_at)
  where processed_at is null;

alter table public.notification_outbox enable row level security;

-- No grants and no policies, deliberately. Only the server's secret-key client
-- touches this table. The trigger functions are `security definer`, so they
-- insert without needing a grant for whoever's save fired them. RLS is on as a
-- backstop: with no policy, a browser session reaches nothing even if a grant
-- were added by mistake later.
revoke all privileges on table public.notification_outbox from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Enqueuing  (from migration 020)
-- ---------------------------------------------------------------------------
-- One helper, so every trigger has identical failure behaviour: an exception
-- here is caught and discarded. That is the entire point -- the write that
-- fired the trigger is financial and must commit whether or not anybody can be
-- told about it.
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

revoke all on function public.enqueue_purchase_notification() from public, anon, authenticated;

drop trigger if exists enqueue_purchase_notification on public.purchases;
create trigger enqueue_purchase_notification
  after insert on public.purchases
  for each row execute function public.enqueue_purchase_notification();

-- Purchased / wrapped progress. Only a real change of status, so re-saving a
-- purchase untouched queues nothing, and a soft delete (which moves
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

revoke all on function public.enqueue_gift_status_notification() from public, anon, authenticated;

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

revoke all on function public.enqueue_gift_idea_notification() from public, anon, authenticated;

drop trigger if exists enqueue_gift_idea_notification on public.gift_ideas;
create trigger enqueue_gift_idea_notification
  after insert on public.gift_ideas
  for each row execute function public.enqueue_gift_idea_notification();

-- A recorded repayment. Fires for an ordinary claim and for an admin override
-- alike; the dispatcher reads the receipt to decide the wording, so an override
-- is announced as an override rather than as something the payer said.
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

revoke all on function public.enqueue_payment_notification() from public, anon, authenticated;

drop trigger if exists enqueue_payment_notification on public.settlements;
create trigger enqueue_payment_notification
  after insert on public.settlements
  for each row execute function public.enqueue_payment_notification();

-- ---------------------------------------------------------------------------
-- 5. The constraints 021 could not widen
-- ---------------------------------------------------------------------------
-- On this production database the two tables did not exist when 021 ran, so its
-- widening block announced a notice and moved on. On a database that DID have
-- them, 021 already widened both and these statements simply restate the same
-- end state. Either way the constraints below are the final intended ones.
--
-- Matched by definition rather than by name, because 019 and 020 created these
-- inline and their generated names are not guaranteed.
do $$
declare
  existing_constraint record;
begin
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

  for existing_constraint in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%gift_status%'
  loop
    execute format('alter table public.notifications drop constraint %I', existing_constraint.conname);
  end loop;

  alter table public.notifications
    add constraint notifications_event_kind_check
    check (event_kind is null or event_kind in (
      'purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review'
    ));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Realtime for the bell  (from migration 019)
-- ---------------------------------------------------------------------------
-- Safe to stream, unlike push_subscriptions: Realtime evaluates each
-- subscriber's SELECT policy per row before delivering, and that policy is
-- `app_member_id = current_app_member_id()`. A member therefore only ever
-- receives their own notifications, which they could already read.
--
-- This is what raises the unread count on an open tab. Push is NOT used for
-- that -- it is an OS alert, not a data channel.
--
-- `notification_outbox` is deliberately NOT published: no browser may read it.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. 021's payment-review trigger is left exactly as it is
-- ---------------------------------------------------------------------------
-- It was installed when 021 ran and has been firing ever since -- into a
-- missing function, so its own exception handler swallowed each call and
-- nothing was queued. Now that enqueue_notification_event exists it starts
-- working, with no change needed here. Deliberately NOT redefined: 021 owns
-- that definition, and copying it into this file would create two sources of
-- truth for one trigger. Checked, not rewritten.
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgname = 'enqueue_payment_review_notification'
      and tgrelid = 'public.payment_receipts'::regclass
      and not tgisinternal
  ) then
    raise notice 'enqueue_payment_review_notification is missing from payment_receipts. Re-run migration 021 to reinstall it; everything else in this file is unaffected.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Assert the end state
-- ---------------------------------------------------------------------------
-- The whole reason this file exists is that a migration silently did less than
-- it looked like it did. So this one refuses to finish quietly if any part of
-- it did not take: a failure here rolls the file back and says exactly what is
-- missing, rather than leaving another half-applied schema behind.
do $$
declare
  missing text[] := array[]::text[];
  kind_target text[] := array['purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review'];
begin
  if pg_catalog.to_regclass('public.notifications') is null then
    missing := missing || 'table notifications';
  end if;
  if pg_catalog.to_regclass('public.notification_outbox') is null then
    missing := missing || 'table notification_outbox';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'enqueue_notification_event'
  ) then
    missing := missing || 'function enqueue_notification_event';
  end if;

  -- Every kind the application can dispatch must be accepted by all three
  -- CHECK constraints. This is the specific class of bug that shipped.
  for i in 1 .. array_length(kind_target, 1) loop
    if not exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.notification_events'::regclass
        and conname = 'notification_events_kind_check'
        and pg_catalog.pg_get_constraintdef(oid) like '%' || kind_target[i] || '%'
    ) then
      missing := missing || ('notification_events.kind missing ' || kind_target[i]);
    end if;
    if not exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.notification_outbox'::regclass
        and conname = 'notification_outbox_kind_check'
        and pg_catalog.pg_get_constraintdef(oid) like '%' || kind_target[i] || '%'
    ) then
      missing := missing || ('notification_outbox.kind missing ' || kind_target[i]);
    end if;
    if not exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.notifications'::regclass
        and conname = 'notifications_event_kind_check'
        and pg_catalog.pg_get_constraintdef(oid) like '%' || kind_target[i] || '%'
    ) then
      missing := missing || ('notifications.event_kind missing ' || kind_target[i]);
    end if;
  end loop;

  -- RLS must be on for the two tables a browser can name.
  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.notifications'::regclass and relrowsecurity
  ) then
    missing := missing || 'row level security on notifications';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.notification_outbox'::regclass and relrowsecurity
  ) then
    missing := missing || 'row level security on notification_outbox';
  end if;

  -- The four enqueue triggers.
  if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'enqueue_purchase_notification' and not tgisinternal) then
    missing := missing || 'trigger enqueue_purchase_notification';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'enqueue_gift_status_notification' and not tgisinternal) then
    missing := missing || 'trigger enqueue_gift_status_notification';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'enqueue_gift_idea_notification' and not tgisinternal) then
    missing := missing || 'trigger enqueue_gift_idea_notification';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'enqueue_payment_notification' and not tgisinternal) then
    missing := missing || 'trigger enqueue_payment_notification';
  end if;

  if array_length(missing, 1) is not null then
    raise exception 'Notification catch-up did not complete. Missing: %', array_to_string(missing, ', ');
  end if;

  raise notice 'Notification centre and outbox are at the final intended state.';
end;
$$;
