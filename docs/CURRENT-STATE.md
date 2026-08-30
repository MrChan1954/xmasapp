# Current State

**Last updated:** 2026-08-30, at the Q12 closeout.

The handoff between phases. Current facts only — history lives in git.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Live site | `https://xmas-family.uk/` |
| Last completed phase | **Q12 — RLS permission-matrix verification** |
| Q12 verdict | `RLS MATRIX PASS — DATABASE AUTHORIZATION VERIFIED` |
| Next phase | **Q13 — not started** |
| Branch | `main` |
| Local HEAD | this closeout commit |
| origin/main | `70bb707` until Q12's push |
| Serving Worker | `1c9993d1-a0f4-4747-819b-25fb89eb344f` until Q12's push |
| Migrations applied | **001–050**, immutable. 050 is Q12's. |

Q12 found three ways the birthday celebrant could reach their own surprise, and
closed all three. **Migration 050 was applied manually to production before any
code was pushed**, which is the required order: nothing in the repository
depends on it, but the policy had to be live before the phase could close.

## Migration 050

`202608100050_audit_birthday_privacy_subject.sql` — two columns on `audit_log`,
a coherence CHECK, one partial index, a two-pass backfill, one narrowed policy
and seven `create or replace function`. No table, no grant, no trigger
definition, no other policy.

**What was wrong.** Ten tables carry an own-birthday exclusion in their SELECT
policy. `audit_log` belongs in that family and never joined it — its policy was
`is_active_app_member() and is_area_member(area_id)`, which answers *whose
family* and says nothing about *whose surprise*. The entries carry `subject` and
`amount_pennies`, and More → Activity renders both, so **the celebrant was shown
the name and the price of their own present on an ordinary screen**. Being the
Area's administrator made it worse, not better.

**Why a stamp and not a lookup.** An audit entry for a hard delete is written
after the row has gone, and `details` has been `'{}'::jsonb` since 015, so at
read time there is nothing left to resolve from. 050 records the subject while
the write context still exists — the same reasoning 049 used for the Area.

`celebrant_person_id` is a **plain uuid with no foreign key**, deliberately.
`record_id` and `actor_user_id` are plain uuids for the same reason, and 015
says why: an audit record that changes retrospectively is not much of an audit
record. A cascade or `SET NULL` would let deleting some other row make an audit
entry *more* visible, which is the whole class of bug being fixed; `ON DELETE
RESTRICT` would hand the audit log a veto over deleting a person, for ever.

**The two-pass backfill, reviewed before it ran.** 92 entries resolved
deterministically to a birthday celebrant and were stamped. 154 entries could
not be resolved — the source record is gone and no payload was ever kept — and
were marked `birthday_privacy_unknown`, which hides them from **everybody**.
Guessing from a name, a subject or an amount was refused. Both populations were
counted on production first, reviewed, and the migration then proved row-for-row
to touch exactly those two sets and nothing else.

**The 154 are gone from Activity for every member.** That is the accepted trade:
a handful of old deletions disappearing is a smaller harm than one birthday
being spoiled. Do not try to recover them.

## What Q12 fixed

- **RLS-1 — `audit_log` told the celebrant what they were getting.** The policy
  now carries an own-birthday clause and a fail-closed clause.
- **RLS-2 — `set_purchase_status` and `void_purchase` returned the row.**
  Definer rights bypass the RLS that hides an own-birthday purchase, and both
  routines return `public.purchases`, so the celebrant got back the description
  and the price. Both now refuse.
- **RLS-3 — `save_gift_idea` never asked about the caller's own birthday.** It
  refused another Area but let the celebrant overwrite the idea recorded for
  them. It now refuses.

## What was verified and found sound

The whole database authorization surface, executed rather than read, in
`scripts/rls-permission-matrix.test.mjs` (45 tests) and summarised in
`docs/RLS-PERMISSION-MATRIX.md`:

- **34 cross-Area attacks, all refused**, including the decisive case: `dual`
  administers Alpha *and* Charlie, so every role check passes and only the
  acting-Area check can refuse. Controls prove the tests are not vacuous.
- **Anonymous holds no grant on any table or view.** Only `acting_area()` and
  `claim_active_area()` are callable, and the 13 trigger functions that still
  carry `anon` EXECUTE cannot be invoked (`0A000`).
- **All 22 tables have RLS**; the one view is `security_invoker`.
- **Settlement authorization is fully proven at the database layer** — the gap
  Q9–Q11 recorded as NOT RUN. Only the payer or receiver may record; **only the
  receiver may confirm or reject, and the Area admin is explicitly refused**.
  The override is admin-only and cannot cross a family line. Receipts are
  append-only to everyone.
- **Reads are membership-scoped, writes are acting-Area-scoped.** Deliberate,
  and why every screen must filter by acting Area itself.

## Verification state

- Full regression **1,674 tests, all passing** (1,629 + 45 new).
- Mutations **130/130 caught, zero survivors**.
- TypeScript, ESLint, production build and worker bundle all clean.

**Six mutations had been silently neutered by 050** and were retargeted at it.
They edited migration 045's copy of routines that 050 now redefines, so 050's
`create or replace` won and the mutation changed nothing — two surfaced as
survivors and four were being caught for unrelated reasons. **A mutation must
target the definition that actually takes effect.** Six more (`Q12-1`…`Q12-6`)
were added for 050's own policy clauses and guards.

## Protected baseline

050 writes only two new columns on `audit_log`, so no fingerprint count can have
moved: it inserts and deletes nothing, and touches no `people`, `app_members`,
`events`, `recipients` or `notifications` row. The fingerprint itself was not
re-run — it needs the service key, and this session's access to that path is
blocked. **Run `scripts/qa/fingerprint.mjs` before the next phase** and confirm
`crossAreaTotal` is still 0.

| Field | Value |
| ----- | ----- |
| `realFamilyNotifications` | **37** (includes the historic 8 leaked Q4 rows) |
| `people` / `appMembers` | **19 / 4** |
| `events` / `recipients` | **15 / 35** |
| `crossAreaTotal` | **0** |

## Live QA

`/more/activity` on `xmas-family.uk`, read-only, after 050 was applied: signed
in, no error, no empty state, **75 entries and 41 money figures still rendering**
— so the new policy did not over-block the ordinary member's view. Nothing was
written; the real family's data was only read.

## Accepted state and open risks

- Nothing blocking. Everything below is non-blocking and was judged, not missed.
- **The celebrant's live view was NOT RUN — SECOND IDENTITY REQUIRED.** Proving
  on the live site that a celebrant sees none of their own birthday needs a
  second human. It is proven against a real PostgreSQL in the matrix suite, and
  the population it depends on was counted on production, but the browser half
  is still open — the same gap Q9, Q10 and Q11 each recorded.
- **`docs/Q12-POST-APPLY-CHECKS.sql` has not been run against production.** It
  is read-only and ready; run it in the SQL Editor to confirm 050 in place.
- The notification sheet does not move focus into itself.
- The top-bar breadcrumb is 16px tall, under the 24px WCAG 2.2 minimum.
- `/people/<id>` goes h1 → h3, skipping a level.
- Ellipsis style is mixed — `...` and `…` both appear.
- The notification bell is deliberately **account-global** and stays that way.
- The 8 protected notification rows are historic Q4 evidence. Do not clean up.
- The 26 Area-less audit rows stay Area-less. Do not backfill them.
- `rls_auto_enable` is Supabase platform state. **Do not drop or adopt it.**
- `no-store` on documents means every back/forward navigation refetches.
- Twelve trigger functions still carry `anon` EXECUTE from the platform default.
  Harmless: PostgreSQL refuses to invoke a trigger function directly (`0A000`).
- Both `package-lock.json` and `pnpm-lock.yaml` are committed and resolve
  identically.

## Rolling back 050, if it ever comes to that

`docs/Q12-050-ROLLBACK.sql`, rehearsed against a database that had 050 applied:
it restores all seven routine bodies byte-identically, restores the 036 policy
text, and drops the index, the constraint and both columns. Order matters — the
routines and the policy reference the columns, so they go back first. Nothing
historical is lost, because 050 wrote nothing else.

## Starting Q13

In a **fresh** Claude session (Opus 5, High):

> Read `CLAUDE.md` (loaded automatically) and `docs/CURRENT-STATE.md`. Read
> `docs/SECURITY-AND-QA.md` if this phase touches security, data or live QA.
> Then execute this phase. \<phase prompt\>
