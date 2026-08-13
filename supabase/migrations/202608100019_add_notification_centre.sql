-- The in-app Notification Centre, plus retry-safe push delivery.
--
-- Additive. Migration 018 is not edited; the only change to an existing table
-- is two new bookkeeping columns on `notification_events`, which is 018's own
-- dispatch ledger. No Christmas or financial table is touched, and nothing here
-- computes a balance — Owed still lives entirely in `src/lib/owed.ts`.
--
-- WHY THIS EXISTS
--   Push is best-effort and opt-in per device. A member with push switched off,
--   or on a browser that cannot do push at all, must still be able to see what
--   happened. So the notification row is the durable record and the OS alert is
--   an optional extra layered on top of it.

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
-- One row per (meaningful event, recipient). Written only by the server's
-- secret-key client, after it has verified the acting member really performed
-- the action.
--
-- Deliberately stores the finished sentence rather than a foreign key into the
-- financial tables. Two reasons: a notification is a record of what was true
-- when it happened ("you now owe Taylor £8.33") and would read as a lie if it
-- silently re-rendered from today's balance; and it keeps this table free of
-- any join into purchases or settlements, so the Notification Centre can never
-- become a second, disagreeing view of the money.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  app_member_id uuid not null
    references public.app_members(id) on delete cascade,

  -- Matches the five switches on More -> Notifications.
  category text not null check (category in (
    'purchases', 'money_i_owe', 'money_owed_to_me', 'gift_ideas', 'gift_status'
  )),

  title text not null check (length(title) between 1 and 120),
  body text not null check (length(body) between 1 and 300),

  -- Where tapping it goes. Constrained to a site-relative path: a single
  -- leading slash, and explicitly not `//host`, which browsers resolve as
  -- protocol-relative and would send someone off-site. The database refuses to
  -- store anything else, so an off-site notification target cannot exist.
  target_url text not null check (target_url ~ '^/[^/]' or target_url = '/'),

  -- Which event produced this, for tracing only. Never joined to for display.
  event_kind text check (event_kind in ('purchase', 'payment', 'gift_idea', 'gift_status')),
  event_subject_id uuid,

  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- The bell's two queries: newest first, and the unread count.
create index if not exists notifications_member_created_idx
  on public.notifications (app_member_id, created_at desc);
create index if not exists notifications_member_unread_idx
  on public.notifications (app_member_id)
  where read_at is null;

alter table public.notifications enable row level security;

revoke all privileges on table public.notifications from public, anon, authenticated;
-- No INSERT and no DELETE for a browser session. Creation is server-side only,
-- so a member cannot post a notification into anyone's inbox — including their
-- own — and nobody has to tidy up their own history.
grant select, update on table public.notifications to authenticated;

drop policy if exists "members read their own notifications" on public.notifications;
create policy "members read their own notifications"
on public.notifications
for select
to authenticated
using (app_member_id = public.current_app_member_id());

-- Marking read. `using` and `with check` are both scoped to the caller's own
-- membership: `using` decides which rows may be updated, `with check` stops the
-- update moving a row onto somebody else's membership.
--
-- Note there is deliberately no Global Admin policy anywhere on this table. The
-- Notification Centre is personal, and an admin reading the family's inboxes
-- would be a straightforward privacy regression.
drop policy if exists "members update their own notifications" on public.notifications;
create policy "members update their own notifications"
on public.notifications
for update
to authenticated
using (app_member_id = public.current_app_member_id())
with check (app_member_id = public.current_app_member_id());

-- RLS decides WHICH rows a member may update; this decides WHAT they may
-- change. Without it, "mark as read" is a general-purpose edit of the row and a
-- member could rewrite their own notification's text or retarget its link.
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

drop trigger if exists protect_notification_content on public.notifications;
create trigger protect_notification_content
  before update on public.notifications
  for each row execute function public.protect_notification_content();

-- ---------------------------------------------------------------------------
-- Realtime for the bell
-- ---------------------------------------------------------------------------
-- Unlike `push_subscriptions`, this table is safe to stream: Realtime evaluates
-- each subscriber's SELECT policy per row before delivering it, and that policy
-- is `app_member_id = current_app_member_id()`. A member therefore only ever
-- receives their own notifications, which they could already read.
--
-- This is what raises the unread count on an open tab. Push is NOT used for
-- that — it is an OS alert, not a data channel.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;

-- Default replica identity: the primary key travels on delete, and no old-row
-- values are broadcast. The client treats an event purely as "something
-- changed" and refetches through its own authorized query, exactly as
-- `use-realtime-refresh.ts` already does for the Christmas tables.

-- ---------------------------------------------------------------------------
-- Retry-safe push delivery
-- ---------------------------------------------------------------------------
-- The bug these columns fix: 018 claimed the event BEFORE attempting delivery,
-- so a send that failed for any reason — a missing key, a push service outage,
-- nobody subscribed yet — left the event permanently marked as handled and
-- every later retry was suppressed as a duplicate.
--
-- Splitting "the event has been turned into notifications" from "the event has
-- reached at least one device" makes both halves correct at once: the in-app
-- rows are still created exactly once, while a delivery that reached nobody can
-- be attempted again.
alter table public.notification_events
  add column if not exists delivered_count integer not null default 0
    check (delivered_count >= 0),
  add column if not exists attempt_count integer not null default 0
    check (attempt_count >= 0),
  add column if not exists last_attempt_at timestamptz;

comment on column public.notification_events.delivered_count is
  'Push messages a push service has accepted for this event. 0 means delivery may be retried; the in-app notifications were still created exactly once.';

-- Existing rows predate this split. They were claimed under the old code, which
-- only ever reached this table after building a plan, and their in-app
-- notifications do not exist because that table did not exist yet. Leaving
-- delivered_count at 0 makes them retryable, which is the correct reading:
-- nothing was ever delivered for them.
