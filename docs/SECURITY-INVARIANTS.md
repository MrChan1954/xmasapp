# Security Invariants

Rules that must hold after every change. A phase that breaks one of these fails,
regardless of what else it achieved. Each is enforced in the database, not only
in the application — the application is not trusted to be the only caller.

## 1. An Area is a tenant boundary

Every domain row carries a non-null `area_id`. A signed-in caller may read and
write only rows in an Area they are a member of.

This is enforced in **two** places, because one is not enough:

- **Reading** — row level security policies (migration 036). These stop one Area
  seeing another.
- **Writing** — a trigger-based write barrier (migration 037). RLS alone does not
  stop cross-Area *writes*, because almost every write goes through a
  `SECURITY DEFINER` routine and definer rights bypass RLS by design. Triggers
  are not bypassed, so the barrier is stated there.

**Never remove `area_id`'s NOT NULL constraint.** It is what makes the guards
total rather than best-effort.

## 2. The service role is exempt, and therefore carries its own scoping

The write barrier exempts callers with no `auth.uid()` — the notification
dispatcher, the reminder job, the admin client and every migration. This is
deliberate and necessary; those callers have no membership to check.

**Consequence:** service-role code bypasses RLS *and* the write barrier. Any
code path using the service role must pass and honour an explicit Area itself.
Scoping is entirely the caller's responsibility there. A missing Area filter in
service-role code is a cross-family data leak with nothing behind it to catch it.

## 3. The selected Area governs the whole request

A user may belong to more than one Area. The Area they are *acting in* is
explicit, never guessed. Reads, writes, navigation chrome, notifications and
person administration are all scoped to it. A user who belongs to two Areas is
asked which, rather than defaulted into one silently.

A stale or hostile Area value in a cookie or request must be rejected against
live membership, not trusted.

## 4. The birthday person must not learn what they are getting

The celebrant can see and edit **their own wishlist** (migration 040 — a separate
table, deliberately not a hole in `gift_ideas`). They must never see:

- gift ideas recorded for them,
- purchases made for them,
- contributions, amounts or who is paying,
- notifications or reminders about their own birthday planning,
- any dashboard total that would let them infer the above.

This was implemented as a new table rather than an exception in the gift-idea
policies precisely so that no policy carve-out can later widen by accident.

## 5. Money is integer pennies

All amounts are integers. `formatPennies` throws on a non-safe-integer input.
Rounding happens once, at the boundary, via `formatPounds`. Never store or
compute money as a float; never let a float reach the database.

## 6. Migrations are immutable and append-only

`supabase/migrations/` currently holds **001–047**, all applied in production. An
applied migration is never edited or deleted. Fix forward with a new numbered
migration, and add its post-apply checks to `docs/`.

## 7. Notifications are account-global, fanout is Area-scoped

The notification bell spans every Area the account belongs to — that is correct
and intended. What must stay scoped is **fanout**: a notification is created only
for members of the Area the triggering event belongs to. A historic leak from Q4
left 8 protected rows in place; they are kept deliberately as evidence and must
not be cleaned up.

## 8. Nothing in the product may know about QA

The product must not import `scripts/qa/protected.mjs` and must not know a
protected Area id exists. This is proved by
`scripts/qa/no-product-coupling.test.mjs`. A QA Area must be exactly as isolated
as a real one; a marker the product could read would defeat that.

## How these are proved

- `npm run test:security`, `test:tenancy`, `test:tenancy-runtime`,
  `test:area-mutation-security`, `test:notification-area-scope`,
  `test:event-people-scope`, `test:qa-guard`
- `npm run test:mutations` — breaks each rule that matters and checks the suite
  notices. **A surviving mutation is a hole in the tests, not a pass.**
- `scripts/pg/rehearsal.mjs` — runs policies against a real PostgreSQL, so a
  broken policy is caught by the database refusing, not by a regex.
