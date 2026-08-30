# Current State

**Last updated:** 2026-08-30, after the Gift Planner brand rename.

The handoff between phases. Current facts only — history lives in git.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Live site | `https://xmas-family.uk/` |
| Last completed phase | **Q13 — release polish** |
| Q13 verdict | `Q13 PASS — RELEASE POLISH COMPLETE` |
| Next phase | **Q14 — not started; nothing outstanding requires one** |
| Branch | `main` |
| Local HEAD | this docs commit, held back |
| origin/main | `d4bacd8` — the brand rename, carrying the held Q13 closeout |
| Serving Worker | `ea1ccdad-247f-41f9-9486-a09b2458fd28` |
| Product name | **Gift Planner** |
| Migrations applied | **001–050**, immutable. **Q13 needed none.** |

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

- Full regression **1,690 tests, all passing** (1,674 + 16 new).
- Mutations **134/134 caught, zero survivors** (130 + `Q13-1`…`Q13-4`).
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
- **`docs/Q12-POST-APPLY-CHECKS.sql` has still not been run against
  production.** It is read-only and ready; run it in the SQL Editor to confirm
  050 in place.
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
