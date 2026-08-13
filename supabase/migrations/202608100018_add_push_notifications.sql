-- Web Push notification delivery.
--
-- Additive only. No existing table, column, policy, function, grant, or
-- Christmas row is modified: purchases, purchase_allocations, settlements,
-- gift_ideas, contributors and recipient_contributions are untouched, and the
-- Owed calculation continues to live entirely in application code
-- (`src/lib/owed.ts`) over those tables. Nothing here computes a balance.
--
-- Three tables:
--   push_subscriptions      one row per browser-on-a-device, many per member
--   notification_preferences one row per member, five plain on/off choices
--   notification_events     the send ledger, which makes dispatch idempotent
--
-- None of them are added to the `supabase_realtime` publication. Push
-- subscription rows carry endpoint URLs and per-device encryption keys, and
-- streaming them would put that material on every subscriber's websocket.
-- Realtime keeps its existing job of syncing Christmas data to open tabs.

-- ---------------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------------
-- Exactly the four values RFC 8291 delivery needs — endpoint, the device's
-- P-256 public key, its auth secret — plus enough bookkeeping to show the user
-- a plain-language device list and to retire dead endpoints. No user agent
-- string, no IP address, no session or token material.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  app_member_id uuid not null
    references public.app_members(id) on delete cascade,

  -- The push service URL. Unique across the whole table, not per member: the
  -- browser mints one endpoint per (device, origin), so the same endpoint
  -- arriving again is always the same physical device re-registering. Making it
  -- globally unique also means a device that changes hands cannot end up
  -- delivering one person's notifications to another's member row.
  endpoint text not null unique
    check (endpoint ~ '^https://' and length(endpoint) <= 2048),

  -- Base64url, from PushSubscription.getKey(). 65 raw bytes -> 87-88 chars.
  p256dh text not null
    check (length(p256dh) between 80 and 200),
  -- Base64url, 16 raw bytes -> 22-24 chars.
  auth text not null
    check (length(auth) between 16 and 60),

  -- "iPhone", "Windows PC", "Android phone". Derived server-side from a coarse
  -- platform hint so the settings page can say something human. Never an
  -- identifier, and never shown to anyone but the owner.
  device_label text
    check (device_label is null or length(device_label) <= 60),

  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_delivery_at timestamptz,
  -- Consecutive soft failures. A push service reporting 404/410 means the
  -- endpoint is permanently gone and the row is deleted outright instead.
  failure_count integer not null default 0
    check (failure_count >= 0)
);

create index if not exists push_subscriptions_member_idx
  on public.push_subscriptions (app_member_id, created_at desc);

alter table public.push_subscriptions enable row level security;

-- Start from nothing, then grant back only what a browser session legitimately
-- needs. INSERT and UPDATE are deliberately absent: registering a device goes
-- through `/api/notifications/subscribe`, which checks the session and binds
-- the row to the caller's own membership. Without an INSERT policy a browser
-- token cannot write a subscription row against somebody else's member id even
-- if it forged the body.
revoke all privileges on table public.push_subscriptions from public, anon, authenticated;
grant select, delete on table public.push_subscriptions to authenticated;

drop policy if exists "members read their own devices" on public.push_subscriptions;
create policy "members read their own devices"
on public.push_subscriptions
for select
to authenticated
using (app_member_id = public.current_app_member_id());

-- So "turn notifications off on this device" still works if the API route is
-- unreachable. Scoped identically, so it can only ever remove the caller's own.
drop policy if exists "members remove their own devices" on public.push_subscriptions;
create policy "members remove their own devices"
on public.push_subscriptions
for delete
to authenticated
using (app_member_id = public.current_app_member_id());

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------
-- Preferences belong to the person, not the device: Taylor's choice of "tell me
-- about gift ideas" should hold on his phone and his PC alike. Which devices
-- receive anything at all is what push_subscriptions decides.
--
-- Every column defaults to true, and a member with no row at all is treated as
-- fully opted in by the dispatcher. Someone who has never opened this screen
-- but has enabled notifications on a device still gets them.
create table if not exists public.notification_preferences (
  app_member_id uuid primary key
    references public.app_members(id) on delete cascade,
  purchases boolean not null default true,
  money_i_owe boolean not null default true,
  money_owed_to_me boolean not null default true,
  gift_ideas boolean not null default true,
  gift_status boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

revoke all privileges on table public.notification_preferences from public, anon, authenticated;
grant select, insert, update on table public.notification_preferences to authenticated;

-- Safe to expose directly to the browser: five booleans, keyed to the caller's
-- own membership on read and on write. `with check` on both statements is what
-- stops a member inserting or retargeting a row onto another member's id.
drop policy if exists "members read their own notification preferences" on public.notification_preferences;
create policy "members read their own notification preferences"
on public.notification_preferences
for select
to authenticated
using (app_member_id = public.current_app_member_id());

drop policy if exists "members create their own notification preferences" on public.notification_preferences;
create policy "members create their own notification preferences"
on public.notification_preferences
for insert
to authenticated
with check (app_member_id = public.current_app_member_id());

drop policy if exists "members update their own notification preferences" on public.notification_preferences;
create policy "members update their own notification preferences"
on public.notification_preferences
for update
to authenticated
using (app_member_id = public.current_app_member_id())
with check (app_member_id = public.current_app_member_id());

-- ---------------------------------------------------------------------------
-- notification_events
-- ---------------------------------------------------------------------------
-- The dispatch ledger, and the reason one action produces one notification.
--
-- Saving a purchase writes a `purchases` row and several `purchase_allocations`
-- rows in a single transaction, and the client may retry a request it never saw
-- the response to. The unique key below turns "send for this event" into an
-- insert that either succeeds once or conflicts; the dispatcher sends only when
-- it wins the insert. Nothing here is keyed to a database row count, so the
-- number of allocations a purchase generates cannot change how many
-- notifications go out.
--
-- No grants at all. Only the server's secret-key client touches this.
create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('purchase', 'payment', 'gift_idea', 'gift_status')),
  -- The purchase / settlement / gift idea the event is about.
  subject_id uuid not null,
  -- Distinguishes repeatable events on one subject: a purchase can be marked
  -- wrapped after being marked purchased, and both are worth sending once.
  fingerprint text not null
    check (length(fingerprint) between 1 and 200),
  actor_app_member_id uuid
    references public.app_members(id) on delete set null,
  recipient_count integer not null default 0
    check (recipient_count >= 0),
  created_at timestamptz not null default now(),
  unique (kind, subject_id, fingerprint)
);

create index if not exists notification_events_created_idx
  on public.notification_events (created_at desc);

alter table public.notification_events enable row level security;
revoke all privileges on table public.notification_events from public, anon, authenticated;
