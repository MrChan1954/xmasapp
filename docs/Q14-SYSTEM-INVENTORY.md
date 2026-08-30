# Q14 — Whole-system inventory and reachability map

**Read on demand.** This is the map later cleanup phases work from. It records
what exists, what reaches what, and — where the evidence does not settle it —
says so instead of guessing.

**Taken at:** 2026-08-30. Local HEAD `cbf6fcf`, migrations 001–050.
**Nothing in this phase was deleted, renamed, refactored or migrated.**

## How the database side was derived

Not by reading migration text. `scripts/pg/rehearsal.mjs` replays all fifty
migrations, plus `seed.sql`, plus the `rls_auto_enable` production fixture, into
a real PostgreSQL 18 (PGlite), and the catalogues of the **resulting** database
were then queried directly — `pg_class`, `pg_proc`, `pg_policies`, `pg_trigger`,
`pg_constraint`, `pg_indexes`, `pg_proc.proacl`. So every count below is the
end state, not the sum of what the migrations say they do.

Callers were resolved the same way: `pg_proc.prosrc` of the **final** definition
of each routine, searched for every other routine's name. A routine that
migration 012 called and migration 045 stopped calling shows here as uncalled,
which is the whole point.

---

## 1. Database inventory

### Counts

| Object | Count |
| ------ | ----- |
| Tables | **22** (all `relrowsecurity = true`) |
| Views | **1** (`christmas_events`) |
| Materialized views | **0** |
| Columns | **217** |
| Foreign keys | **51** |
| Unique constraints | **10** (plus unique indexes, counted under indexes) |
| Check constraints | **84** |
| Indexes | **77** |
| Triggers (non-internal) | **61** |
| RLS policies (`public`) | **37** |
| RLS policies (`storage`) | **3** |
| Application functions | **96** |
| — `SECURITY DEFINER` | **93** |
| — `SECURITY INVOKER` | **3** (`acting_area`, `birthday_occurrence_date`, `protect_gift_idea_identity`) |
| — trigger / event-trigger functions | **25** |
| — callable routines | **71** |
| — `EXECUTE` to `authenticated` (the PostgREST/RPC surface) | **60** |
| — `service_role` / `postgres` only | **11** |
| Sequences | **1** (`audit_log_id_seq`) |
| Extensions | **2** (`pgcrypto` in `public`, `plpgsql`) |
| Event triggers | **1** (`rls_auto_enable_on_ddl` — platform) |
| Storage buckets | **1** (`item-photos`, private) |

`pgcrypto` contributes a further 37 functions to `public`. They are excluded
from every count above; the 96 are the application's own.

### Tables, and what governs each

| Table | Cols | Policies | Triggers | Idx | `authenticated` grant | Class |
| ----- | ---: | -------: | -------: | --: | --------------------- | ----- |
| `areas` | 5 | 1 (S) | 0 | 1 | ALL | CANONICAL |
| `app_members` | 10 | 2 (S) | 7 | 5 | `r` | CANONICAL |
| `people` | 10 | 3 (S,I,U) | 4 | 6 | `r` | CANONICAL |
| `events` | 12 | 1 (S) | 4 | 9 | `r` | CANONICAL |
| `christmas_recipients` | 7 | 3 (S,I,U) | 5 | 2 | `r` | CANONICAL |
| `contributors` | 5 | 1 (S) | 5 | 2 | `r` | CANONICAL |
| `recipient_contributions` | 6 | 3 (S,I,U) | 5 | 2 | `r` | CANONICAL |
| `gift_ideas` | 10 | 4 (S,I,U,D) | 5 | 2 | `r` | CANONICAL |
| `purchases` | 18 | 1 (S) | 7 | 5 | `r` | CANONICAL |
| `purchase_allocations` | 5 | 1 (S) | 4 | 3 | `r` | CANONICAL |
| `settlements` | 18 | 1 (S) | 5 | 3 | `r` | CANONICAL |
| `payment_receipts` | 12 | 1 (S) | 4 | 3 | `r` | CANONICAL |
| `item_photos` | 9 | 3 (S,I,D) | 2 | 4 | `ard` | CANONICAL |
| `birthday_wishlist_ideas` | 11 | 4 (S,I,U,D) | 2 | 4 | ALL | CANONICAL |
| `notifications` | 10 | 2 (S,U) | 1 | 4 | `rw` | CANONICAL |
| `notification_preferences` | 8 | 3 (S,I,U) | 0 | 1 | `arw` | CANONICAL |
| `push_subscriptions` | 10 | 2 (S,D) | 0 | 3 | `rd` | CANONICAL |
| `audit_log` | 15 | 1 (S) | 1 | 7 | `r` | CANONICAL |
| `notification_events` | 10 | **0** | 0 | 3 | **none** | SUPPORTING |
| `notification_outbox` | 9 | **0** | 0 | 3 | **none** | SUPPORTING |
| `birthday_reminders` | 6 | **0** | 0 | 3 | **none** | SUPPORTING |
| `birthday_budget_summaries` | 7 | **0** | 0 | 2 | **none** | SUPPORTING |

The last four are deliberately unreachable by `authenticated`: no grant and no
policy, so RLS denies even if a grant were ever added. They are the background
job's own bookkeeping, written only through `service_role` from
`/api/birthdays/reminders` and `/api/notifications/dispatch`.

**Two tables carry a wider grant than their policies use** — `areas` and
`birthday_wishlist_ideas` both have `arwdDxtm` to `authenticated`. `areas` has
only a `SELECT` policy, so RLS refuses every write regardless; writes go through
`create_area` / `set_area_name` / `set_area_archived`. This is defence in one
layer rather than two. Not a defect, and **not to be "tightened" casually** —
see §6, UNKNOWN-3.

### The one view

`christmas_events` — `SELECT`-only to `authenticated`, `security_invoker`, with
a check option, created by migration 025 when `christmas_events` the table was
renamed to `events`. **SUPPORTING, still live.** Not dead: `area_of_record` and
`area_of_written_row` both branch on the table name `'christmas_events'`, and
`save_purchase`'s validation reads it. Application code deliberately does not —
`events-server.ts:235` carries a comment saying so.

### RLS policy helpers, by weight

| Helper | Policies depending on it |
| ------ | -----------------------: |
| `is_area_member(uuid)` | 24 |
| `is_active_app_member()` | 20 |
| `is_own_app_member(uuid)` | 9 |
| `area_of_recipient(uuid)` | 8 |
| `area_of_event(uuid)` | 6 |
| `is_area_admin(uuid)` | 5 |
| `is_own_birthday_event(uuid)` | 5 |
| `is_own_birthday_recipient(uuid)` | 5 |
| `area_of_purchase(uuid)` | 4 |
| `is_own_wishlist_person(uuid)` | 3 |
| `area_of_gift_idea(uuid)` | 3 |
| `is_acting_area(uuid)` | 2 |
| `is_own_birthday_purchase(uuid)` | 2 |
| `is_own_birthday_gift_idea(uuid)` | 1 |
| `current_person_id()` | 1 |

**None of these is unused, and none is callable-but-orphaned** — every one is
load-bearing for at least one policy. They appear in no `.rpc()` call from
`src/`, which is exactly right: they are the database's own vocabulary.

### The write barrier

`refuse_foreign_area_write` is attached to **13 tables**. `record_audit_event`
to **10**. `enforce_event_scope_integrity` to **5**, `refuse_cross_area_person`
to **5**, `protect_event_scope_identity` to **4**. The acting Area is claimed by
`claim_active_area`, wired as PostgREST's `pgrst.db_pre_request` on the
`authenticator` role — verified present in the resulting catalogue, not assumed.

### Storage

One private bucket, `item-photos`, with three `storage.objects` policies
(SELECT / INSERT / DELETE for active members). No UPDATE policy — photos are
replaced by delete-then-insert. CANONICAL.

---

## 2. Application inventory

### Counts

| Surface | Count |
| ------- | ----: |
| `.ts` / `.tsx` files under `src/` | **193** (174 production, 19 colocated `*.test.ts`) |
| Page routes | **31** |
| Route handlers | **13** |
| **Server actions (`"use server"`)** | **0** |
| Middleware | **0** (no `middleware.ts` anywhere) |
| Next.js special files | `layout.tsx`, `error.tsx`, `global-error.tsx`, `not-found.tsx`, `manifest.ts`, one `loading.tsx` |
| Client components (`"use client"`) | **76** |
| shadcn registry primitives (`ui/*.tsx`) | **19** |
| Product-layer exports (`ui/index.tsx`) | **37** |
| Non-`ui` components under `components/` | **34** |
| `src/lib/` modules | **28** production + 19 tests |
| `src/utils/` modules | **15** |
| Test scripts (`scripts/*.test.mjs` + `qa/`) | **48** |
| Non-test scripts and harnesses | **13** |
| Public assets | 13 files |
| GitHub Actions workflows | **2** |

**This application has no server actions and no middleware.** Every mutation is
either a client-side `supabase.rpc()` against a `SECURITY DEFINER` routine, or a
`fetch` to one of the 13 route handlers. That is a single, uniform architecture
and worth stating plainly, because a reader arriving from most Next.js codebases
will look for `"use server"` and find nothing.

### Routing

**31 page routes.** Canonical event-scoped screens live under
`/events/[eventId]/…`. Four top-level pages are **pure legacy redirect shims**
and hold no UI at all:

| Shim | Forwards to | Why it exists |
| ---- | ----------- | ------------- |
| `/add-purchase` | `/events/<christmas-2026>/add-purchase` | old links |
| `/more` | `/events/<christmas-2026>/more` | old links |
| `/owed` | `/events/<christmas-2026>/owed` | **every money notification written before Checkpoint 2 targets this path** |
| `/payment-log` | `/events/<christmas-2026>/payment-log` | old links |

All four call `redirectLegacyRoute` in `events-server.ts`, whose own comment
says it "should be deleted once they have aged out". **`/owed` is the one that
cannot simply be deleted**: the protected baseline keeps 37 real notification
rows, and the pre-Checkpoint-2 ones among them point at `/owed`. Removing the
shim breaks a link in a real family's inbox.

`/people` and `/people/[id]` are **not** shims — they render the person
directory and profile, and only fall back to `redirectLegacyRoute` for a
`?person=` query or an unresolvable id.

`/more` redirects, but `/more/activity`, `/more/family-access` and
`/more/notifications` are canonical screens. The parent path and its children do
different things.

**13 route handlers.** `/api/admin/family-access`, `/api/areas`,
`/api/areas/membership`, `/api/areas/name`, `/api/birthdays/reminders`,
`/api/notifications/{dispatch,inbox,key,subscribe,test}`, `/api/payment-log`,
`/api/supabase-health`, `/auth/callback`.

### Screens living under legacy directories

Four canonical screen components sit in the same folders as the shims, and are
imported *upwards* by the event-scoped routes:

| Component | Imported by |
| --------- | ----------- |
| `app/owed/owed-screen.tsx` | `/events/[eventId]/owed` |
| `app/owed/owed-summary.tsx`, `owed-data.ts` | `home-screen.tsx`, `owed-screen.tsx` |
| `app/payment-log/payment-log-screen.tsx` | `/events/[eventId]/payment-log` |
| `app/add-purchase/purchase-form.tsx` | `/events/[eventId]/add-purchase` |
| `app/people/people-screen.tsx` | `/events/[eventId]/people` |

So `src/app/owed/` contains one dead-ish shim and three live modules. A cleanup
phase that deletes the directory deletes working screens. **Flagged.**

`app/people/` holds **two different screens with confusingly similar names**:
`people-screen.tsx` (event recipient management, reached from
`/events/[eventId]/people`) and `people-directory-screen.tsx` (the person
directory at `/people`). Both are live. Neither is a duplicate of the other.

### Service-role modules

Four places in `src/` read `SUPABASE_SECRET_KEY` and therefore bypass both RLS
and the write barrier:

| Module | Reached from | Scoping |
| ------ | ------------ | ------- |
| `utils/supabase/family-access-admin.ts` | `/api/admin/family-access`, `/more/family-access` | `requireFamilyAccessAdmin` resolves the member through the caller's **own** session, then reads the role from that membership |
| `utils/supabase/notifications-server.ts` | 6 importers (the five `/api/notifications/*` handlers, `/more/notifications`) | per-member |
| `utils/supabase/payment-log-server.ts` | `/api/payment-log` | per-event |
| `app/api/birthdays/reminders/route.ts` | GitHub Actions cron, `BIRTHDAY_REMINDER_SECRET` | per-Area, derived in SQL |

### Environment surface

`APP_ORIGIN`, `BIRTHDAY_REMINDER_SECRET`, `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NODE_ENV`,
`SUPABASE_SECRET_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.
(`process.env.X` also appears — it is a documented literal in
`utils/request-origin.ts` explaining why dynamic reads do not inline.)

### Scheduled work

| Workflow | Schedule | Calls |
| -------- | -------- | ----- |
| `.github/workflows/birthday-reminders.yml` | `0 8 * * *` | `POST /api/birthdays/reminders` with `BIRTHDAY_REMINDER_SECRET` |
| `.github/workflows/database-backup.yml` | `17 3 * * *` | `pg_dump` via Supabase CLI; verified by `scripts/verify-backup-dump.awk` |

There is **no Cloudflare cron trigger** — `wrangler.jsonc` declares none. GitHub
Actions is the only scheduler.

### Platform / PWA

`public/sw.js` (256 lines, push + offline), `public/offline.html`,
`public/_headers` (authoritative for static assets in production),
`src/app/manifest.ts` (generated, so `_headers` cannot match it — cached by
`next.config.ts` instead), `components/pwa-runtime.tsx`,
`components/use-pwa-install.ts`, `components/install-card.tsx`, five `-v2` icons.

---

## 3. Canonical subsystem map

| Subsystem | Canonical table(s) | Canonical app module(s) | Canonical DB routines | Confidence |
| --------- | ------------------ | ----------------------- | --------------------- | ---------- |
| Areas / tenancy | `areas` | `lib/areas.ts`, `utils/supabase/areas-server.ts`, `utils/area-cookie.ts`, `app/family-context.tsx` | `create_area`, `set_area_name`, `set_area_archived`, `leave_area`, `claim_active_area`, `acting_area`, `act_in_area`, `is_acting_area`, `require_acting_area`, `is_area_member` | **High** |
| Person identity | `people` | `lib/people.ts`, `utils/supabase/people-server.ts` | `create_person`, `set_person_name`, `set_person_archived`, `area_of_person`, `current_person_id`, `current_person_in_area` | **High** |
| App membership | `app_members` | `utils/supabase/current-member.ts` (+ `-client`) | `claim_app_member`, `current_app_member_id`, `current_member_in_area`, `is_active_app_member`, `is_own_app_member` | **High** |
| Admin / roles | `app_members.role` | `utils/supabase/family-access-admin.ts` | `is_app_admin`, `is_area_admin`, `transfer_area_admin`, `refuse_area_without_one_admin`, `refuse_last_admin_removal` | **High** |
| Contributors | `contributors`, `people.is_family_contributor` | `lib/recipient-allocations.ts` | `set_event_contributor`, `set_family_contributor`, `current_app_contributor_id`, `is_area_contributor_member`, `refuse_celebrant_as_own_contributor` | **High** |
| Events | `events` (+ `christmas_events` view) | `lib/events.ts`, `utils/supabase/events-server.ts` | `create_event`, `update_event`, `set_event_status`, `delete_event_if_empty`, `area_of_event` | **High** |
| Recipients | `christmas_recipients` | `app/people/people-screen.tsx` | `add_event_recipient`, `save_christmas_recipient_with_contributions`, `set_christmas_recipient_active`, `area_of_recipient` | **High** |
| Budgets / contributions | `recipient_contributions` | `lib/recipient-allocations.ts`, `app/people/recipient-allocation-editor.tsx` | `save_christmas_recipient_with_contributions`, `enforce_recipient_budget_allocation_invariant` | **High** |
| Gift ideas | `gift_ideas` | `app/people/gift-ideas.tsx` | `save_gift_idea`, `remove_gift_idea`, `list_gift_ideas`, `area_of_gift_idea`, `protect_gift_idea_identity`, `refuse_cross_area_idea_author` | **High** |
| Purchases | `purchases` | `lib/purchases.ts`, `app/add-purchase/purchase-form.tsx` | `save_purchase_with_location` → `save_purchase`, `set_purchase_status`, `void_purchase`, `area_of_purchase` | **High** |
| Purchase allocations | `purchase_allocations` | `lib/purchases.ts` | written inside `save_purchase`; immutable snapshot | **High** |
| Settlements / payments | `settlements` | `lib/owed.ts`, `lib/payment-confirmation.ts` | `record_settlement`, `review_payment`, `void_settlement`, `admin_record_confirmed_payment`, `area_of_settlement` | **High** |
| Payment receipts / history | `payment_receipts` | `lib/payment-log.ts`, `utils/supabase/payment-log-server.ts` | `review_payment`; `payment_receipts_are_append_only` | **High** |
| Notifications | `notifications` (inbox), `notification_events` (domain event), `notification_outbox` (retry queue) | `lib/notification-dispatch.ts`, `lib/notification-audience.ts`, `lib/notification-content.ts`, `utils/supabase/notifications-server.ts` | `enqueue_notification_event` + five `enqueue_*` triggers; `protect_notification_content` | **High** |
| Push devices | `push_subscriptions` | `lib/web-push.ts`, `components/use-push-notifications.ts`, `public/sw.js` | none (table writes via service role) | **High** |
| Audit / activity | `audit_log` | `app/more/activity/activity-client.tsx`, `lib/notification-log.ts` | `record_audit_event` (10 tables), `record_birthday_audit_event`, `stamp_audit_area`, `area_of_record`, `audit_actor_name` | **High** |
| Settings | `notification_preferences` | `lib/settings-scopes.ts`, `app/settings/*` | none | **High** |
| Birthdays | `people.birthday_*`, `events` (`event_type='birthday'`), `birthday_reminders`, `birthday_budget_summaries` | `lib/birthdays.ts`, `utils/supabase/birthdays-server.ts` | `start_birthday_planning`, `set_person_birthday`, `birthday_occurrence_date`, `due_birthday_reminders`, `claim_birthday_reminder`, `due_birthday_budget_summaries`, `claim_birthday_budget_summary` | **High** |
| Birthday privacy | `audit_log.celebrant_person_id` / `.birthday_privacy_unknown`, `birthday_wishlist_ideas` | `lib/wishlist.ts`, `app/birthdays/[personId]/own-birthday-screen.tsx` | `is_own_birthday_event/gift_idea/purchase/recipient`, `is_own_wishlist_person`, `refuse_starting_own_birthday`, `anchor_wishlist_idea` | **High** |
| Auth / session | `auth.users` (platform) | `utils/supabase/server.ts`, `client.ts`, `app/auth/callback/route.ts` | `claim_app_member` | **High** |
| PWA / service worker | — | `public/sw.js`, `components/pwa-runtime.tsx`, `app/manifest.ts` | — | **High** |
| UI primitive layer | — | `components/ui/index.tsx` over `components/ui/*.tsx` | — | **High** |

---

## 4. Legacy / superseded candidates

Each has evidence. **None was touched in this phase.**

### DB-1 — `is_family_contributor_member()` — LEGACY, and the strongest candidate

Superseded by `is_area_contributor_member(uuid)` in migration 039. In the final
schema it is called by **no policy, no trigger, no other routine, and no
application code**. Its body is now a wrapper that delegates to the Area-aware
version, with a fallback for a login that has exactly one membership and sent no
`x-area-id`. Migration 039 kept its name and signature deliberately; migration
047 did not remove it; `scripts/birthday-wishlist.test.mjs:190` already calls it
"legacy" and asserts the current `set_person_birthday` does *not* use it.

It still carries `EXECUTE` to `authenticated`, so it is the **one orphaned
routine in the whole schema that is reachable over PostgREST**. It leaks
nothing — it answers a boolean about the caller's own membership — but it is
live surface with no reader.

### DB-2 / DB-3 — `save_christmas_recipient`, `save_recipient_contributions` — SUPERSEDED

Both are `service_role`/`postgres` only, so `authenticated` cannot reach them,
and in the final schema **neither has any caller**.
`save_christmas_recipient_with_contributions` inlines both jobs.

**This contradicts migration 047's own rationale**, which lists them beside
`save_purchase` as "inner routines … reached only through wrappers that 045
already guards". That is true of `save_purchase` — `save_purchase_with_location`
does call it — and no longer true of these two. The reality is *stricter* than
the document, not looser, so nothing is at risk; the note is simply stale.

### APP-1 — `src/app/components/ui/select.tsx` — deliberately kept, now due

Zero importers. The Radix `Select`; the product uses `NativeSelect` everywhere.
`docs/SHADCN-UI.md` §11 keeps it on purpose and says, verbatim: *"If it is still
unused when the next component audit comes round, delete it — the reasoning
above survives in this document."* **Q14 is that audit.** The condition the
document set has been met.

### APP-2 — the four legacy redirect shims

`/add-purchase`, `/more`, `/owed`, `/payment-log`. `/owed` is load-bearing for
real pre-Checkpoint-2 notification rows and must outlive the others.

### DB-4 — `app_members.contributor_id` — legacy but live

Described in `api/admin/family-access/route.ts:729` as "a legacy tie-break".
Still read by `current_app_contributor_id` (which prefers it, then falls back to
`person_id`), `owed-data.ts`, `notification-dispatch.ts` and
`current-member.ts`. **Not removable** without changing contributor resolution.

### DB-5 — `events.year` and the `christmas_events` view — legacy but live

`year` is read by `legacyChristmasEventId` and exposed by the view; the view is
read by `area_of_record`, `area_of_written_row` and `save_purchase`. Both are
tied to the same clock as APP-2: they go when the legacy paths go, not before.

---

## 5. Unused candidates

| Item | Evidence | Risk if removed |
| ---- | -------- | --------------- |
| `src/app/components/use-mounted.ts` | `useMounted` is exported and imported by **nothing**. Q13 removed its last consumer (the notification bell), and `scripts/notification-centre.test.mjs:353` asserts the bell no longer uses it. Only other mention is a passing comment in `use-pwa-install.ts`. | **None.** A genuine leftover. |
| `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg` | Zero references in `src/`, `public/`, `scripts/` or any config. `create-next-app` starter assets. They ship in `.open-next/assets`. | **None.** |
| `src/app/components/ui/select.tsx` | See APP-1 — unused, but the *decision* to keep it was deliberate and documented. | Low; the rationale survives in `SHADCN-UI.md`. |
| `scripts/setup-taylor.mjs`, `set-taylor-password.mjs`, `admin-account-target.mjs` | Not in `package.json`, not in either workflow, not referenced from any test or doc — they reference only each other. Operator scripts that create/reset one admin Auth account. | **Uncertain — see UNKNOWN-1.** Do not delete on static evidence alone. |
| `scripts/checkpoint-4-3.test.mjs` | Runs under `test:all` and passes; the name refers to a checkpoint scheme no longer used. | None to delete-risk; this is a **naming** observation, not a dead-code one. |

Nothing else in `src/` is unreachable. Of 174 production `.ts`/`.tsx` files,
**172 are reachable** from a page, layout, route handler or other Next.js entry;
the two that are not are `ui/select.tsx` and `use-mounted.ts`.

---

## 6. Unknowns — evidence incomplete

**UNKNOWN-1 — the three `*-taylor*` operator scripts.**
*Why uncertain:* static analysis proves nothing imports them; it cannot prove a
human does not run them by hand during account recovery.
*What would settle it:* the user saying whether admin account creation/reset is
still done this way, or a documented replacement.
*Risk if removed prematurely:* losing the only scripted path to repair an
Admin's Auth account on a system with no staging environment.

**UNKNOWN-2 — index usage.**
*Why uncertain:* all 77 indexes were derived from the rehearsal catalogue. Which
ones production actually **uses** needs `pg_stat_user_indexes.idx_scan` from the
live database, which was not read in this phase.
*What would settle it:* one read-only `SELECT` against `pg_stat_user_indexes` in
the Supabase SQL Editor.
*Risk if removed prematurely:* a dropped index is a silent performance
regression on real family data with no staging to catch it. **Assume every index
is needed until measured.**

**UNKNOWN-3 — the wider-than-needed grants on `areas` and
`birthday_wishlist_ideas`.**
*Why uncertain:* `authenticated` holds `arwdDxtm` on both while policies permit
far less. RLS makes this safe today. Whether the grant is deliberate (matching
Supabase's project default privileges, which the rehearsal's `PLATFORM` block
documents) or an oversight is not settled by the migration text.
*What would settle it:* reading migrations 034/040 for an explicit `grant`, and
confirming production's `relacl` matches the rehearsal's.
*Risk if changed prematurely:* revoking a grant a routine silently depends on
would break Area creation or wishlist editing in production, with no staging.

**UNKNOWN-4 — whether production's catalogue matches the rehearsal's.**
*Why uncertain:* the rehearsal is a faithful replay, but production has had
`rls_auto_enable` and other platform state applied outside the migration chain,
and `docs/Q12-POST-APPLY-CHECKS.sql` **has still never been run**.
*What would settle it:* running that read-only file in the SQL Editor.
*Risk:* everything in §1 is "what fifty migrations produce", which is the right
baseline but is not the same statement as "what production holds".

**UNKNOWN-5 — the twelve trigger functions still carrying `anon` EXECUTE.**
Carried forward from `CURRENT-STATE.md`. Confirmed still present in the
resulting catalogue (visible as `anon=X/postgres` on the trigger functions in
§1). Harmless — PostgreSQL refuses to invoke a trigger function directly
(`0A000`) — but it is inherited platform default, not a decision.

---

## 7. Reachability findings

1. **Every one of the 96 application functions is referenced somewhere.** There
   are no orphans invisible to all four dependency kinds (app code, policies,
   triggers, other routines). The three in §4 are orphaned only in the narrower
   sense of having no *caller* in the final schema.
2. **30 of the 60 `authenticated`-callable routines are never called by
   `src/` via `.rpc()`** — and 29 of those 30 are policy helpers or routine
   helpers that are supposed to be called from inside the database. The
   thirtieth is `is_family_contributor_member` (DB-1).
3. **11 routines are `service_role`/`postgres` only.** Seven are reached: four
   from `/api/birthdays/reminders` (`due_*`, `claim_*`), three from inside other
   routines. Three are the orphans DB-2/DB-3 and `save_purchase`'s wrapper
   chain. `area_of_record`, `area_of_written_row`, `audit_actor_name` and
   `enqueue_notification_event` are all trigger-internal.
4. **The acting-Area chain is intact end to end:** `claim_active_area` is
   installed as `pgrst.db_pre_request` on `authenticator`; `acting_area()` is
   read by 8 routines; `require_acting_area` by 22; `refuse_foreign_area_write`
   guards 13 tables.
5. **No server actions, no middleware.** All writes are RPC or route handler.
6. **`AREA_COOKIE` is single-sourced** in `src/lib/areas.ts`. The two
   `rememberedAreaId` functions (`areas-server.ts` async over `cookies()`,
   `current-member-client.ts` sync over `document.cookie`) are a deliberate
   server/client pair reading the same constant — **not** a duplicate to merge.
7. **`request-origin` is a two-file pair, not a duplicate**: `lib/` holds the
   pure, unit-tested rules; `utils/` is the thin `server-only` wrapper that
   supplies `process.env` as inlinable literals.

---

## 8. shadcn / custom primitive inventory (preliminary)

`components.json`: style `new-york`, `rsc: true`, base colour `neutral`, CSS
variables, `lucide` icons, aliases pointing at `@/app/components/ui` and
`@/lib/cn`. `.mcp.json` commits the shadcn MCP server.

**19 registry primitives** in `src/app/components/ui/`:

| Primitive | Importers | Note |
| --------- | --------: | ---- |
| `index.tsx` (product layer) | 43 | every screen imports this |
| `button.tsx` | 3 | via `index`, `dialog`, `alert-dialog` |
| `input.tsx` | 3 | via `index`, `native-select`, `textarea` |
| `dialog.tsx` | 2 | `index` + `notification-bell` (Q13) |
| `switch.tsx` | 2 | settings + notifications directly |
| `alert.tsx`, `alert-dialog.tsx`, `badge.tsx`, `card.tsx`, `label.tsx`, `native-select.tsx`, `sheet.tsx`, `skeleton.tsx`, `table.tsx`, `textarea.tsx` | 1 each | via `index` |
| `checkbox.tsx` | 1 | `recipient-allocation-editor` directly |
| `dropdown-menu.tsx`, `popover.tsx` | 1 each | via `components/popover.tsx` |
| **`select.tsx`** | **0** | APP-1 |

The product layer exports **37** names — `Button`, `ButtonLink`, `Field`,
`Input`, `MoneyInput`, `Select`, `Textarea`, `Segmented`, `Badge`, `Card`,
`SectionCard`, `Toolbar`, `ChipRow`, `FilterChip`, `ToggleChip`, `DataTable`,
`DataCards`, `DataList`, `DataRow`, `Column`, `EmptyState`, `Notice`, `Stat`,
`Skeleton`, `Modal`, `ModalHeader`, `ModalTitle`, `ModalFooter`,
`ConfirmDialog`, `Sheet`, `SheetHeader`, `SheetFooter`, `cx`, plus five types.

Note the name collision worth knowing about: **`Select` exported from
`ui/index.tsx` is a native `<select>`**, unrelated to `ui/select.tsx`'s Radix
`Select`. That is why the Radix file looks used when grepped naively and is not.

Custom (non-registry) primitives that a later phase may want to judge:
`components/popover.tsx` (a wrapper over `dropdown-menu` + `popover`),
`components/icons.tsx` (12 importers, hand-rolled SVGs alongside 25 files using
`lucide-react`), `components/festive/*` (product illustration, out of scope).

**Two icon systems coexist** — `components/icons.tsx` (12 importers) and
`lucide-react` (25 files). Both are live. Worth a decision in a later phase; not
a defect.

---

## 9. Dependencies (preliminary)

**All 12 runtime dependencies are used.** No unused runtime dependency was
found.

| Dependency | Where |
| ---------- | ----- |
| `react` / `react-dom` | 80 / 2 files |
| `next` | 69 files |
| `lucide-react` | 25 files |
| `radix-ui` | 12 files (all under `ui/`) |
| `@supabase/supabase-js` | 7 files |
| `@supabase/ssr` | 2 (`utils/supabase/server.ts`, `client.ts`) |
| `class-variance-authority` | 4 (`ui/` variants) |
| `next-themes` | 2 (`theme-provider`, `theme-bootstrap` test) |
| `clsx` + `tailwind-merge` | `lib/cn.ts` |
| `@opennextjs/cloudflare` | `open-next.config.ts` |

**All 13 devDependencies are used.** `@electric-sql/pglite` → `pg/rehearsal.mjs`;
`esbuild` → `dom/tsx-hook.mjs`, `theme-bootstrap.test.mjs`; `jsdom` →
`dom/harness.mjs`; `sharp` → `generate-pwa-icons.mjs`, `pwa-assets.test.mjs`;
the rest are toolchain.

**Both `package-lock.json` and `pnpm-lock.yaml` are committed** and, per
`CURRENT-STATE.md`, resolve identically. `SHADCN-UI.md` warns the shadcn CLI
picks pnpm from the lockfile and that pnpm is not installed here. Carrying two
lockfiles is a standing hazard rather than a defect. Not resolved in this phase.

---

## 10. Contradictions found

1. **`CLAUDE.md` says "Applied range: 001–047".** The repository holds fifty
   migrations, `docs/CURRENT-STATE.md` says 001–050, and the Q14 prompt says
   001–050. `CLAUDE.md` is three migrations stale. *Documentation only; no
   runtime effect.* **Not corrected in this phase** — the rules forbid edits
   without approval, and this is the kind of one-line fix worth doing
   deliberately at the start of Q15.
2. **Migration 047's rationale is stale about two routines.** It lists
   `save_christmas_recipient` and `save_recipient_contributions` as inner
   routines reached through guarded wrappers. In the final schema nothing calls
   them at all. Reality is stricter than the note. See DB-2/DB-3.
3. **`CURRENT-STATE.md` records 1,690 tests.** The suite now reports **1,697**
   — the brand-rename work added `scripts/app-brand.test.mjs` after the
   Verification-state table was written. Both numbers were correct when written.
4. **`SHADCN-UI.md` lists `select.tsx` among the installed set** while its own
   §11 explains it has no importer. Not an error — the document is internally
   consistent — but a reader skimming §1 will believe it is in use.

---

## 11. Recommended scope for Q15–Q19

Ordered so that each phase's risk is bounded and nothing depends on a later
phase's evidence.

**Q15 — zero-risk removals and documentation truth.**
Delete `use-mounted.ts` and the five starter SVGs. Delete `ui/select.tsx` on
`SHADCN-UI.md`'s own standing instruction, and record it there. Correct
`CLAUDE.md`'s migration range to 001–050. Note the stale rationale in 047 in
this file rather than editing the immutable migration. Confirm with a test that
nothing imported the deleted files. **No database change, no migration.**

**Q16 — settle the unknowns, read-only.**
Run `docs/Q12-POST-APPLY-CHECKS.sql`. Read `pg_stat_user_indexes` and
`pg_proc.proacl` from production, and diff production's catalogue against the
rehearsal's — that closes UNKNOWN-2, UNKNOWN-3 and UNKNOWN-4 in one sitting and
turns §1 from "what the migrations produce" into "what production holds". Ask
the user about the `*-taylor*` scripts (UNKNOWN-1). **Still no writes.**

**Q17 — the DB legacy surface, and the first migration since 050.**
With Q16's evidence, decide on `is_family_contributor_member`,
`save_christmas_recipient` and `save_recipient_contributions`. If they go, that
is migration **051**, and `CLAUDE.md`'s rule applies: **stop for explicit user
review before writing it.** Each removal needs a mutation that puts the routine
back and a test that fails.

**Q18 — the legacy routes.**
`/add-purchase`, `/more`, `/payment-log` can go once the `christmas_events`
view, `events.year` and `legacyChristmasEventId` are shown to have no other
reader. **`/owed` stays** until the pre-Checkpoint-2 notification rows that
target it are gone, and those are inside the protected baseline. Consider
instead rewriting *those rows'* `target_url` — which is a data change to real
family notifications and needs explicit approval.

**Q19 — UI consistency.**
Decide between `components/icons.tsx` and `lucide-react`. Decide whether the
`src/app/owed/`, `src/app/payment-log/`, `src/app/add-purchase/` and
`src/app/people/` directories should hold canonical screens for
`/events/[eventId]/…` routes, or whether the screens should move. Resolve the
two-lockfile situation.

---

## 12. What this phase did not do

No file under `src/`, `supabase/` or `public/` was created, edited, renamed or
deleted. No migration was written or applied. No database row was read from or
written to production — the entire database inventory came from a disposable
in-memory PGlite built from the committed migrations. No deployment, no push.
The only change in the working tree is this file.
