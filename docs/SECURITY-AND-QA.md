# Security and QA

Why the guards are shaped the way they are, and what QA may touch. `CLAUDE.md`
states these rules in one line each; this file carries the reasoning. Read it
when a phase touches security, tenancy, live data or browser QA.

## Area scoping

Every domain row carries a non-null `area_id`. **Never remove that NOT NULL** — it
is what makes the guards total rather than best-effort. Enforcement is in **two**
places because one is not enough:

- **Reads** — RLS policies (migration 036) stop one Area seeing another.
- **Writes** — a trigger-based write barrier (migration 037). RLS alone does not
  stop cross-Area *writes*: almost every write goes through a `SECURITY DEFINER`
  routine and definer rights bypass RLS by design. Triggers are not bypassed, so
  the barrier is stated there.

**Membership is not authorization.** A user may belong to several Areas; the one
they are *acting in* is explicit, never guessed, and governs the whole request —
reads, writes, navigation chrome, notifications, person administration. A stale or
hostile Area value in a cookie is re-checked against live membership, not trusted.
Hiding a control in the UI authorizes nothing; the database must refuse on its own.

**The service role is exempt, so it scopes itself.** The barrier exempts callers
with no `auth.uid()` — the notification dispatcher, the reminder job, the admin
client, every migration — because they have no membership to check. The
consequence is that service-role code bypasses RLS *and* the barrier, so it must
authenticate, authorize and carry an explicit Area filter itself. A missing filter
there is a cross-family leak with nothing behind it to catch it.

## Birthday privacy

The celebrant sees and edits **their own wishlist** (migration 040 — a separate
table, deliberately not a hole in `gift_ideas`, so no policy carve-out can widen by
accident). They must never see gift ideas recorded for them, purchases,
contributions, amounts, who is paying, notifications about their own planning, or
any total that lets them infer those — through reads, routes, notifications or
browser payloads.

**Self-privacy outranks Admin.** Being an Area admin does not entitle someone to
their own secret data. The check answers `self_private` before it reads any
planning, so neither the values nor the *shape* of what renders can carry the secret.

## Notifications

The bell is **account-global** — it spans every Area the account belongs to, and
that is intended. What stays Area-scoped is **fanout**: a notification is created
only for members of the Area the triggering event belongs to.

The **8 protected notification rows are the historic Q4 leak**: real production
data, kept as evidence. `docs/Q4-LEAKED-NOTIFICATION-CLEANUP.sql` exists but must
not be run without explicit user approval.

## QA against live production

There is no staging environment. QA runs against the live app and the live
database, so every rule here exists because the "it's only a test copy" safety net
does not.

- **URL** `https://xmas-family.uk` — never localhost as user-facing evidence. The
  live site is what the family gets; a local render proves nothing about the
  deployed Worker.
- **Browser** Microsoft Edge, driven with Playwright channel `msedge`.
- **Database** the family's own Supabase project, in synthetic Areas.

`.qa-areas.local.json` (repo root, git-ignored, **never commit**) names
`protectedAreaIds` (the real family), `protectedEventIds` and `qaAreaIds` (what QA
may write to). `scripts/qa/protected.mjs` is the guard and it **fails closed**: a
missing config, an unparseable one or an unknown id all refuse. While `qaAreaIds`
is empty every QA write is refused — the correct state, not a bug. The guard can
only refuse; it grants nothing, and product authorization stays in RLS, the barrier
and the definer routines.

**The product must not know QA exists** — it must not import the guard or know a
protected id exists, proved by `scripts/qa/no-product-coupling.test.mjs`. A QA Area
must be exactly as isolated as a real one; a marker the product could read defeats
that. Never write to a protected Area or event, and never run destructive SQL
against production to "check" something. Read instead.

**Point cross-Area attack tests the safe way round.** The QA account is admin of
both the protected family *and* a QA Area, which is what makes it the right
fixture: probing from an Area where the caller is a mere member proves the admin
check, not the Area check, and has produced a false green before. Aim the attack
**from** the protected Area **into** QA data, never the reverse, so that a stray
write lands on disposable rows.

## Fingerprints

`scripts/qa/fingerprint.mjs` takes a **read-only**, count-based fingerprint of the
real family. Take it before deploying and again after live QA, so "did QA touch
anything real?" is answered by the database rather than from memory. Every request
in it is a GET; it uses the service role because counting across Areas requires
seeing across them — exactly why it must never gain a write.

Take the pre-deploy fingerprint **as close to deployment as possible**: the family
uses the app while QA runs, so `events`/`recipients` can move without QA writing
anything. `crossAreaTotal` must be **0**. A difference you cannot explain is a
protected-data incident: stop, report, do not continue.

## Mobile QA

Edge will not size a *window* below ~516px outer / 492px inner, so resizing is not
how to reach a phone viewport. Use CDP: start Edge with
`--remote-debugging-port=9222`, connect Playwright with `connectOverCDP`, and send
`Emulation.setDeviceMetricsOverride` for a true 390x844 CSS viewport at DPR 3 with
touch, inside the already-signed-in session. Edge must be fully closed before the
flag takes effect, so this needs the user to relaunch it.

## How this is proved

`npm run test:security`, `test:tenancy`, `test:tenancy-runtime`,
`test:area-mutation-security`, `test:notification-area-scope`,
`test:event-people-scope`, `test:qa-guard`, `test:qa-readiness`.

`npm run test:mutations` breaks each rule that matters and checks the suite
notices. A mutation must be killed by a **behavioural** test asserting the live
final definitions — a checksum or build-only failure is not a kill. **A surviving
mutation is a hole in the tests, not a pass.**

`scripts/pg/rehearsal.mjs` runs policies against a real PostgreSQL, so a broken
policy is caught by the database refusing, not by a regex.

## A build trap worth knowing

`wrangler.jsonc` sets **`keep_names: false`** and it must stay false. With it on,
wrangler's esbuild injects `__name(...)` into `next-themes`' *serialised*
pre-hydration bootstrap, which then throws in the browser before hydration.
