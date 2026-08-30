# Current State

**Last updated:** 2026-08-30, after Q16 closed.

The handoff between phases. Current facts only — history lives in git.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Live site | `https://xmas-family.uk/` |
| Last completed phase | **Q16 — the UI primitive audit and cleanup** |
| Q16 verdict | `Q16 PASS — SHADCN/RADIX IS THE CANONICAL PRIMITIVE SYSTEM` |
| Next phase | **Q17 — the repository-wide dead-code audit** |
| Branch | `main` |
| Local HEAD | one commit ahead of `origin/main` — this closeout, **held back deliberately** (docs only) |
| origin/main | `9f5551c` — Q16's runtime work, deployed |
| Serving Worker | `7797eb98-1ff1-4f49-9108-d749a146a949` |
| Product name | **Gift Planner** |
| Migrations applied | **001–051**, immutable. 051 applied manually 2026-08-30. |

## Q16 — shadcn/Radix is the canonical UI primitive system

`docs/Q16-SHADCN-CANONICALIZATION.md` is the audit and the primitive matrix.
Read on demand. **No database change; migrations still end at 051.**

**No duplicate generic primitive was found — the count is zero.** Every
Radix import in the repository (11 files) is inside `src/app/components/ui/`;
not one screen or product component reaches past the wrappers. There is one
focus-trap mechanism, Radix's, and one Escape mechanism. The one global keydown
listener in the app is the command palette's ⌘K.

**What Q16 actually removed was stale documentation, not a parallel system.**
`SHADCN-UI.md` had described `notification-bell.tsx` as a hand-rolled panel with
its own focus-return for four phases after **Q13 rebuilt it on the shared Radix
`Dialog`**. Two of Q14's three UI findings were also wrong: the "two icon
systems" are one — `icons.tsx` imports from `lucide-react` and is a named
catalogue over it, not a rival — and the `Select` naming collision dissolved
when the unused half was deleted.

Changes, all UI-only:

- **Deleted `ui/select.tsx`** (zero importers of any kind; `SHADCN-UI.md` §11
  had said to delete it at the next audit) and **`use-mounted.ts`** (zero
  importers since Q13). Deleting the first leaves exactly one `Select` in the
  codebase, so **no rename was needed and 11 call sites were left alone.**
- **Three hand-spelled form fields became `Field`** — two in `create-area-form`,
  one in `family-settings-screen`, each of which was reproducing `Field`'s own
  markup down to its `mt-2` spacing. Their labels move `text-ink-700` →
  `text-ink-900`, converging on every other form label in the app.
- **Six lucide glyphs gained `aria-hidden`**, all in stock registry files
  vendored after that convention was written. Found by the new test, not by eye.

**`scripts/ui-primitives.test.mjs` is what stops it growing back** — 13 tests
holding four invariants: Radix only inside `components/ui/`; no hand-written
`role="dialog"`/`aria-modal` and no hand-rolled Tab or Escape handler; `Select`
renders a real `<select>`; every lucide glyph carries `aria-hidden`. Mutations
`Q16-1`…`Q16-4` put each defect back and all four are killed behaviourally.

Kept deliberately, with reasons in the audit: `FinancialProgressBar` (domain
state, not a `Progress` duplicate), `BottomTabs` (navigation, not a tablist),
`components/popover.tsx` (a wrapper that keeps `Menu` and `Popover` apart), the
native `Select`, and one raw `<button>` in `global-error.tsx`.

**Handed to Q17:** the five unreferenced starter SVGs in `public/`, and the
still-open Q14 question of whether the three `*-taylor*` operator scripts are
run by hand.

**Live QA on Worker `7797eb98`, Edge, entirely read-only.** Desktop 1440×900:
seven screens, no horizontal overflow, one `h1` each, **zero controls without an
accessible name**. The migrated Family-name field wraps its input, is named
exactly "Family name" — the policy paragraph correctly stays out of that name —
and is 48px tall at 16px. The account menu opens with 8 items and **zero
unhidden SVGs**, which is the `aria-hidden` fix visible in production. Q13's
bell is untouched: `aria-modal="true"`, named "Notifications", 352×448, focus
inside, **0 escapes in 12 Tabs**, Escape returns focus to the bell.

Mobile 390×844 at DPR 3, `mobile: true`, 5 touch points, coarse pointer: seven
screens with no overflow, the field still 48px/16px and inside the viewport, the
bottom nav 390 wide with three 125×51 targets, and the bell opened by a genuine
`Input.dispatchTouchEvent` as a 390×633 bottom sheet, full width, bottom flush,
fully on screen, focus inside, scrim over the viewport. Identical to Q13's
numbers.

**Protected fingerprint taken before and after: identical, and identical to the
baseline** — notifications 37, people 19, events 15, appMembers 4, recipients
35, Christmas 2026 active with 19 recipients, `crossAreaTotal` 0.

## Migration 051 — applied, and verified against production

`supabase/migrations/202608100051_drop_superseded_routines_and_narrow_table_grants.sql`
(SHA-256 `0760ce5d…12f369`) was applied manually in the Supabase SQL Editor on
2026-08-30 and **verified against a production `pg_dump` taken afterwards**
(backup run `33330291190`, 19:15:14Z).

It did two things. It dropped `is_family_contributor_member`,
`save_christmas_recipient` and `save_recipient_contributions` — three routines
with no caller of any kind, each proved by a clean `DROP … RESTRICT` in a
rehearsal first. And it narrowed `authenticated` on `areas` to `SELECT` and on
`birthday_wishlist_ideas` to `SELECT, INSERT, UPDATE, DELETE`.

**Why the grant half mattered.** Those two tables were the only ones in the
schema still carrying Supabase's blanket default grant, which includes
**TRUNCATE — and row level security is never consulted for TRUNCATE**. Measured
in a rehearsal before the fix: an ordinary member truncated
`birthday_wishlist_ideas` and destroyed three Areas' wishlists, including an
Area they were not acting in. It was never reachable through PostgREST, which
has no TRUNCATE verb, so nothing was ever at risk — but the protection was the
client protocol rather than the grant, and `areas` was shielded only by an
accident of its foreign keys.

**Production diff, whole:** eleven `GRANT`/`REVOKE` lines. Seven belonged to the
three dropped routines and went with them; the two blanket table grants became
two narrow ones. Functions 96 → 93. Policies, triggers, indexes and RLS all
unchanged. **`data_rows` 1,111 → 1,111 and `data_bytes` byte-identical** — the
migration reads and writes no row, and the two dumps prove it.

`docs/Q15-051-POST-APPLY-CHECKS.sql` is the read-only re-check (18 checks, FAIL
rows sort to the top). `docs/Q15-051-ROLLBACK.sql` undoes it — read its header
first: half of it deliberately re-opens the hole.

**The rule that stops this recurring** is `scripts/table-privileges.test.mjs` §4.
It names no table: it sweeps every table in `public` and fails if any of them
hands a browser role anything beyond the four DML verbs. Mutation `051-2` puts
that defect on a third table and is killed by that sweep.

## Q15 — the database audit behind that migration

`docs/Q15-DATABASE-CANONICAL-SYSTEM.md` is the audit. Read on demand. Its §8
proposal has since been written, rehearsed, applied and verified — that is
migration 051 above, so read §8 as history rather than as a pending decision.

**Gift Planner has exactly one authoritative database system per business
concept.** Every concept was checked — Areas, identity, membership, admin,
contributors, events, recipients, budgets, gift ideas, purchases, allocations,
settlements, receipts, notifications, audit, settings, birthdays and privacy.
**No competing or duplicate active path was found anywhere.** The multi-object
subsystems (three notification tables, three contributor layers) are stages and
layers of one system, not rivals.

**The security finding it raised is now closed** by migration 051 above. Q15
found `authenticated` holding `TRUNCATE` on `areas` and
`birthday_wishlist_ideas`; 051 took it away and
`scripts/table-privileges.test.mjs` now holds that shut.

**One Q15 claim turned out to be wrong, and the correction is worth keeping.**
Q15 predicted that dropping `is_family_contributor_member` would make mutation 9
die of "undefined function". It would not have. Mutation 9 edited migration
**039**, but **047 redefines `set_person_birthday`** — so the mutant never
reached the schema the tests query, and what killed it was 039's own apply-time
*text* assertion, which 039 admits in its own comment is a text check because it
"needs two Areas and a login in both, and this block creates none". The fixtures
do create exactly that. Mutation 9 now breaks the live definition in 047 and is
killed behaviourally by `a plain member cannot`. **The lesson generalises: a
mutation aimed at a migration that a later migration overwrites is testing
nothing.**

Confirmed REQUIRED, not legacy: **`events.year`** carries the "one Christmas per
family per year" unique index and two check constraints. The **`christmas_events`
view** is a `security_invoker` read convenience over `events` with no independent
state — not a second source of truth. **`app_members.contributor_id`** is legacy
but live: frozen since migration 004, five readers, every one with a `person_id`
fallback.

## Q14 — the inventory

`docs/Q14-SYSTEM-INVENTORY.md` is the map later cleanup phases work from. It is
read-on-demand; do not load it unless a phase needs it. **Q14 changed no runtime
code, no migration and no production data** — the whole database inventory came
from replaying the fifty committed migrations into a disposable PGlite and
querying the resulting catalogues, so it records the end state rather than the
sum of what the migrations say they do.

Headlines: 22 tables, 1 view, 96 application functions (93 `SECURITY DEFINER`,
25 of them trigger functions, 60 reachable over PostgREST), 37 RLS policies, 61
triggers, 77 indexes. On the app side, 31 page routes, 13 route handlers, **no
server actions and no middleware** — every write is an RPC or a route handler.
172 of 174 production source files are reachable from a route.

Three DB routines have no caller in the final schema —
`is_family_contributor_member`, `save_christmas_recipient`,
`save_recipient_contributions` — **all three dropped by migration 051**. Two app
files have no importer, `components/ui/select.tsx` and
`components/use-mounted.ts` — **both deleted by Q16**. Five starter SVGs in
`public/` are referenced nowhere and are **still there, for Q17**.

Of Q14's four unknowns, **Q15 settled two**: the wide grants are Supabase
default-privilege residue and are broader than needed, and the Q12 post-apply
checks had in fact already been run and passed — Q14 was wrong about that. Two
stay open: whether the three `*-taylor*` operator scripts are still run by hand,
and which indexes production actually uses. Neither can be settled without
either asking the user or opening a read-only production connection.

**`CLAUDE.md`'s migration range said 001–047. It is now 001–051.**

Q13 closed the four product-quality gaps the final site audit left open, and
proved on the live site the one thing Q9, Q10, Q11 and Q12 each had to record as
NOT RUN.

## What Q13 fixed

- **The Notification Centre now traps focus.** It announced `role="dialog"` and
  then let Tab walk out of it into a page that was still fully interactive
  behind a scrim saying otherwise. It is a Radix `Dialog` now — the foundation
  `Modal`, the command palette and the account menu already stand on — so the
  trap, `aria-modal`, Escape, and the return of focus to the bell all come from
  one place. `useMounted` and `createPortal` are gone with it.
- **The breadcrumb has a 44×44 target.** Its own box was 16px tall, under WCAG
  2.2's 24px floor. `.touch-target` in `globals.css` grows the HIT AREA with a
  pseudo-element and leaves the 12px type alone, so nothing moves. Same
  technique `ui/switch.tsx` already used for its own control.
- **`/people/<id>` no longer skips a heading level.** The admin cards are the
  first sections under the page's `h1`, so they are `h2`. `text-lg` stays: the
  level answers "what is this part of", the class answers "how loud is it".
- **One ellipsis, spelled one way.** Thirty-nine user-facing `...` became `…`,
  which was already the majority convention. Spreads, comments, an abbreviated
  SQL statement and a quoted database error are untouched — none is prose.

## Why the bell needed rebuilding rather than patching

There is one `Dialog.Content` per dialog, and it is the thing focus is trapped
inside. The two shapes used to be rendered together and hidden from each other
with `hidden sm:flex` / `sm:hidden`, and a hidden second Content is still a
second dialog with its own trap. So the breakpoint is read once through
`matchMedia` and `useSyncExternalStore` — the pattern `useFestive` and
`usePwaInstall` already use — and only the matching shape is built.

Two details are load-bearing and were verified live:

- **The phone sheet is still portalled and the desktop dropdown still is not.**
  The header's `backdrop-blur-md` makes it a containing block for `fixed`
  descendants, which is what once pinned the sheet inside a 64px strip. The
  dropdown is `absolute` against the trigger's own `relative` wrapper, a nearer
  positioned ancestor, and was never affected.
- **The dropdown deliberately has no overlay.** In Radix's Dialog the SCROLL
  LOCK lives on the overlay, and this shape never locked the page. Closing on an
  outside click does not need one: the content's own dismissable layer listens
  on the document.

## The celebrant's live view — NO LONGER OUTSTANDING

Q9, Q10, Q11 and Q12 each recorded `NOT RUN — SECOND IDENTITY REQUIRED` for
proving in a browser that a birthday celebrant sees none of their own birthday.
**No second identity was needed.** The signed-in human is `Robin QA Charlie` in
the QA Charlie Area — an Admin *and* a Contributor *and* a celebrant, which is
the hardest case there is. Read-only, on `xmas-family.uk`:

- their own person page draws "You can't view your own birthday gifts", and its
  Gift history lists QA Mother's Day, QA Live Q4 Custom and QA Shadcn Desktop
  Check — **their own birthday event is absent**, while Sam's page, viewed by
  the same reader, does show "🎂 Sam QA Charlie's Birthday";
- `/birthdays` shows Sam's card with "Budget £30 · Open planning" and their own
  card with **neither** — no budget, no planning entry;
- `/more/activity` renders 262 lines and 41 money figures, and the only
  birthday line names **Sam**, not the reader. That is migration 050's effect,
  proven by a real celebrant in a real browser;
- the notification inbox carries gift ideas for Sam and for Taylor and seven
  "You owe Paige" rows, and **nothing about the reader's own birthday**.

Being the Area's admin did not help them, which is the invariant.

## Verification state

- Full regression **1,725 tests, all passing** — Q15's 1,712 plus Q16's 13.
- Mutations **141/141 caught, zero survivors** (137 + `Q16-1`…`Q16-4`). Every
  Q16 kill was behavioural and named the intended assertion; none was a build
  or parse failure.
- TypeScript, ESLint, production build and worker bundle all clean.
- `scripts/interface-polish.test.mjs` is new and renders the bell into a real
  DOM, because a focus trap is behaviour: **12 of its 14 original assertions
  fail against the previous implementation**, and the two that pass are Escape
  and focus return — exactly what the old limitation said already worked.

## Protected baseline

Taken before deployment and again after all live QA. **Identical, and identical
to Q12's.** Nothing was written to the real family; every live check was a read.

| Field | Value |
| ----- | ----- |
| `realFamilyNotifications` | **37** (includes the historic 8 leaked Q4 rows) |
| `people` / `appMembers` | **19 / 4** |
| `events` / `recipients` | **15 / 35** |
| Christmas 2026 | active, **19** recipients |
| `crossAreaTotal` | **0** |

## Live QA

Microsoft Edge over CDP, in the already-signed-in session, against
`xmas-family.uk` on Worker `2cd2ad03`.

**Desktop (1440×900).** Focus enters the panel on open; twelve Tabs and eight
Shift+Tabs never leave it; Escape closes it and focus returns to the bell.
`aria-modal="true"`, named "Notifications", dropdown 352×448 anchored under the
trigger. Activity: 75 entries, 41 money figures, no raw table names, no error
text. Breadcrumb: own box 16px and 12px type, but the hit test succeeds 21px
above and below its centre and fails at 30px — a real 44px target. Heading
outline h1 → h2×6 → h3 → h4, no skips, one `h1`. No document overflow.

**Mobile (390×844, DPR 3, `mobile: true`, touch on).** `innerWidth` 390,
`innerHeight` 844, `devicePixelRatio` 3, `maxTouchPoints` 5, coarse pointer.
Opened by a genuine `Input.dispatchTouchEvent`, the sheet is portalled out of
the header, full width, bottom flush with the viewport, 633px tall and entirely
on screen, with a scrim covering the viewport and a list that scrolls inside
itself. The trap holds here too. Bottom nav unaffected: 390 wide, three 125×51
targets. No document overflow on home, people, person, owed or birthdays.

**The `/more/activity` filter strip is not an overflow.** Six chips sit wider
than the viewport, every one of them inside a `overflow-x: auto` div, and the
document's `scrollWidth` equals its `clientWidth`. That strip is meant to scroll.

**Accessibility sweep, seven live screens.** No interactive control without an
accessible name, no nested interactive controls, no `tabindex="-1"` traps, one
`h1` each. The only sub-24px box is the Falling snow switch's visible track,
which already carries its own 44×44 `before:` hit area.

**Branding.** Favicon 200, apple-touch-icon 200, manifest "Family Gift Planner"
with all four icons 200. No Christmas-tree references in the head. That name is
the one the rename below replaced; the icons are unchanged.

## After Q13 — the brand rename

The product is called **Gift Planner**. It had been called three things at once:
"Family Budget" on the desktop rail, "the Christmas app" in two account-setup
messages and the family-access role card, and "Family Gift Planner" everywhere
else. All of them now say Gift Planner — manifest `name` and `short_name`, the
browser tab, the iOS Home Screen title, the auth wordmark, the install card, the
push-notification fallback, the offline page, and the sticky bar's fallback for
a path no route claims.

**The installation was relabelled, not replaced.** `id`, `start_url`, `scope`,
both colours and all four `-v2` icon paths are byte-for-byte what they were, so
an existing Home Screen install keeps its place and its green tile. Nothing in
the domain moved: `Our family`, Areas, Christmas 2026, the tree ornament and the
`christmas-budget` push tag are vocabulary, not the product's name.

**Guarded by `npm run test:brand`.** A name has to be spelt out at every surface
that shows it — a manifest cannot import a constant, and neither can a static
offline page — so `scripts/app-brand.test.mjs` scans everything the app ships and
fails on any of the three retired names, comments included. Proved to fail: it
was run against a deliberately reverted manifest name and rail wordmark and
caught both.

**Verified live** on `ea1ccdad` in Edge, desktop 1440x900 and a genuine 390x844
CDP viewport at DPR 3 with touch. Tab title, manifest, all seven icon URLs 200,
sticky bar naming the screen at both widths, rail hidden at 390, no retired name
in any DOM, no horizontal overflow on the dashboard, People, Birthdays, Settings,
Family settings, Notifications, Account or the auth screen. The signed-out login
eyebrow is source-verified only: `/login` redirects an authenticated session to
`/`, and signing the family out to look at it is not allowed.

## Accepted state and open risks

- Nothing blocking. Everything below is non-blocking and was judged, not missed.
- **Settlement browser E2E is still `NOT RUN — SECOND IDENTITY REQUIRED`.** It
  needs a payer and a receiver at the same time. The browser holds exactly one
  authenticated session and one Supabase auth cookie, and the rules forbid
  asking for anybody's password or signing the user into a synthetic account.
  Not a blocker: Q12 proved settlement authorization at the database layer,
  including that the Area admin is explicitly refused as a confirmer.
- **`docs/Q12-POST-APPLY-CHECKS.sql` HAS been run against production**, in the
  SQL Editor after migration 050, and every check passed. Q14 recorded the
  opposite; that was Q14's error and Q15 corrected it. Results in
  `docs/Q15-DATABASE-CANONICAL-SYSTEM.md` §2. No re-run needed.
- The notification bell is deliberately **account-global** and stays that way.
- The 8 protected notification rows are historic Q4 evidence. Do not clean up.
- The 26 Area-less audit rows stay Area-less. Do not backfill them.
- The 154 audit rows marked `birthday_privacy_unknown` are hidden from
  everybody, deliberately. Do not try to recover them.
- `rls_auto_enable` is Supabase platform state. **Do not drop or adopt it.**
- `no-store` on documents means every back/forward navigation refetches.
- Twelve trigger functions still carry `anon` EXECUTE from the platform default.
  Harmless: PostgreSQL refuses to invoke a trigger function directly (`0A000`).
- Both `package-lock.json` and `pnpm-lock.yaml` are committed and resolve
  identically.
- The four limitations Q13 closed are gone from this list on purpose. Each is
  now held by a mutation (`Q13-1`…`Q13-4`) that puts the exact defect back.

## Starting the next phase

In a **fresh** Claude session (Opus 5, High):

> Read `CLAUDE.md` (loaded automatically) and `docs/CURRENT-STATE.md`. Read
> `docs/SECURITY-AND-QA.md` if this phase touches security, data or live QA.
> Then execute this phase. \<phase prompt\>

**Push the closeout commit with the next phase's work.** It is docs-only and on
its own would trigger a production build that changes nothing.
