# Current State

**Last updated:** 2026-08-30, at the Q11 closeout.

The handoff between phases. Current facts only — history lives in git.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Live site | `https://xmas-family.uk/` |
| Last completed phase | **Q11 — final full-site audit and release acceptance** |
| Q11 verdict | `FINAL AUDIT PASS — RELEASE ACCEPTED` |
| Next phase | **Q12 — not started** |
| Branch | `main` |
| Local HEAD | this closeout commit, on top of `70bb707` |
| origin/main | `70bb707` — the latest **pushed runtime** commit |
| Ahead of origin | 1 commit, **docs only**, deliberately unpushed |
| Serving Worker | `1c9993d1-a0f4-4747-819b-25fb89eb344f` |
| Migrations applied | **001–049**, immutable. 049 is Q11's. |

Q11 pushed once. That push carried Q10's held-back docs commit, as planned, and
triggered one automatic Cloudflare build. No manual deploy was run.

This closeout is held back for the same reason Q9's and Q10's were: a docs-only
push would trigger a production Worker build for nothing. **Q12's first
legitimate runtime push should carry it.**

## Migration 049

`202608100049_audit_area_from_acting_area.sql` — one
`create or replace function public.stamp_audit_area()` and nothing else. No
table, column, index, policy, grant or trigger, and no existing row updated.

An audit entry for a **hard delete** is written by an AFTER trigger, so the row
is already gone and `area_of_record` returns null; `people_birthday` is not a
table, so it never resolves either. 037's fallback then refuses, correctly, to
choose between several memberships — which left the entry with **no Area**, and
once Q10 scoped `/more/activity` to the acting Area those entries could never
appear again. Only accounts in more than one family were affected.

049 consults `acting_area()` between the two existing steps. That is a
membership-checked statement of place, not a guess: `claim_active_area` sets it
only `if is_area_member(wanted)` and `act_in_area` raises otherwise. **The
refusal to choose between several memberships is unchanged**, and a rehearsal
scenario asserts it still refuses.

Applied manually and verified live: the production schema diff across 049 is 24
lines, all inside `stamp_audit_area` plus its comment.

Rollback, if ever needed, is re-applying 037's body — the same function without
the middle branch.

## The 26 historical Area-less audit rows

**Left exactly as they are, deliberately.** 26 of 462 rows carry no `area_id`:
14 `recipient_contributions/removed`, 4 `contributors/removed`, 4
`gift_ideas/removed`, 4 `people_birthday/added`, all written by the one account
with several memberships between 2026-08-25 and 2026-08-30.

**22 of the 26 refer to records that no longer exist**, so their Area cannot be
recovered from data — only guessed from that account's three memberships.
Writing a guess into an append-only audit log to tidy a screen is worse than the
gap it would hide. They stay invisible on Activity; do not backfill them.

## Verification state

- Full regression **1,629 tests, all passing**.
- Mutations **124/124 caught, zero survivors** — 102 by behavioural assertions,
  22 by the database refusing to apply a mutated migration, and **zero
  build-shaped kills**.
- TypeScript, ESLint, production build and worker bundle all clean.
- **Cross-Area integrity = 0** at every fingerprint.

## Protected baseline

| Field | Value |
| ----- | ----- |
| `realFamilyNotifications` | **37** (includes the historic 8 leaked Q4 rows) |
| `people` / `appMembers` | **19 / 4** |
| `events` / `recipients` | **15 / 35** |
| Christmas 2026 | active, 19 recipients |
| `crossAreaTotal` | **0** |

Identical at all four Q11 fingerprints — baseline, mid-audit, post-QA and
closeout — and identical to Q10's. Q11's browser mutations happened only in QA
Charlie.

## What Q11 fixed

- **A person's birthday screen had the app's name at the top.** The sticky bar
  on `/birthdays/<personId>` read "Family Gift Planner" with no chevron — the
  one screen the birthday person themself is sent to, and Birthdays is not on
  the mobile tab bar, so the celebrant had no marked way back. Q9 filled the
  title table from the top-level routes and never walked the directory beneath.
  Fixed in the table, not on the pages.
- **Three database table names were on the Activity screen.** The real family's
  filter row read `... | Contributors | events | Gift ideas | item_photos |
  people_birthday | ...`. The label map was written against the nine tables 015
  audits and never caught up with 017's photos or the four later migrations that
  name a kind themselves. The expectation is derived from the migrations now.
- **The search button had no accessible name on a phone.** Both its pieces of
  text are hidden by responsive classes, and `display: none` content takes no
  part in the accessible name — so below `sm:` it was an unlabelled button in
  the top bar of every signed-in screen. Measured through CDP: exactly one
  unnamed control on each of twenty routes at 390x844, zero at desktop width.
- **Deletions were missing from the Activity log** — migration 049, above.
- **The app called itself a Christmas app on every home screen.** Every icon was
  drawn in code from the `tree` ornament. The icons now come from the approved
  `app-logo.png`; the generator crops, scales and re-encodes it and draws
  nothing.

## The app icon

`app-logo.png` at the repository root is the **master**, and is committed
because `scripts/generate-pwa-icons.mjs` and `scripts/pwa-assets.test.mjs` both
depend on it. `npm run icons` regenerates everything; the outputs are committed
so the build never needs sharp.

- `any` 192/512, `apple-icon` 180, `favicon` 32/16 — the tile, edge to edge.
- `maskable` 192/512 — the **uncropped** master, whose furthest artwork pixel
  sits at 63% of the half-width against a safe circle of 80%. Verified under a
  real circular crop in Edge.
- `badge-96` — a silhouette lifted from the artwork, 17% coverage. Android keeps
  only the alpha, so an opaque image would badge as a solid block.

**The manifest paths carry `-v2` on purpose.** They are not content-hashed, and
an installed PWA can keep a launcher icon until the manifest names a different
URL. `icon.png`, `apple-icon.png` and `favicon.ico` keep their names because
Next already emits them as `/icon.png?icon.<hash>.png`.

**The Christmas tree is still in the product and must stay** — it is the glyph
for a Christmas event, in the ornaments, the garland and the snow on Event Home.
Only the application's identity changed.

**An already-installed PWA may need removing and reinstalling**, or an OS
icon-cache refresh, before the new icon appears.

## Accepted state and open risks

- Nothing blocking. Everything below is non-blocking and was judged, not missed.
- **The notification sheet does not move focus into itself.** It is a
  hand-rolled `role="dialog"` with a scrim; Escape dismisses it and returns
  focus to the bell, and the trigger carries `aria-haspopup`/`aria-expanded`,
  but focus is not moved in or trapped. Every Radix dialog in the app does both.
- **The top-bar breadcrumb is 16px tall**, under the 24px WCAG 2.2 target
  minimum. It is a secondary affordance and never the only way back.
- **`/people/<id>` goes h1 → h3**, skipping a level.
- **Ellipsis style is mixed** — `...` and `…` both appear, twice in the same
  file for the same word. Cosmetic; left alone rather than touched in a
  release-acceptance pass.
- The notification bell is deliberately **account-global** and stays that way.
- The 8 protected notification rows are historic Q4 evidence. Do not clean up.
- `rls_auto_enable` is Supabase platform state. **Do not drop or adopt it.**
- **`no-store` on documents means every back/forward navigation refetches.**
  Re-confirmed live in Q11: browser Back after switching family does not restore
  the old family's screen — a foreign event id 404s instead.
- Twelve trigger functions still carry `anon` EXECUTE from the platform default.
  Harmless: PostgreSQL refuses to invoke a trigger function directly (`0A000`).
- Both `package-lock.json` and `pnpm-lock.yaml` are committed and resolve
  identically.
- **Second-identity browser tests were NOT RUN**, again. The receiver-confirms
  half of settlement needs a second human. Q11 exercised the half one identity
  can legitimately reach — receiver records a payment, Owed £7.50 → £6.50,
  admin voids it, Owed back to £7.50, record retained — and the rest stays
  proven by `settlement-lifecycle` against a real PostgreSQL.
- **Trusted keyboard events could not be delivered over CDP** in this
  environment: `Input.dispatchKeyEvent` never reached the page even with the
  window brought to front. Escape handling was proven by synthetic events plus
  source, not by a real key press.

## Starting Q12

In a **fresh** Claude session (Opus 5, High):

> Read `CLAUDE.md` (loaded automatically) and `docs/CURRENT-STATE.md`. Read
> `docs/SECURITY-AND-QA.md` if this phase touches security, data or live QA.
> Then execute this phase. \<phase prompt\>
