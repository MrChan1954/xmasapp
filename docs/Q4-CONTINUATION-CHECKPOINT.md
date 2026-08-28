# Q4 checkpoint — 2026-08-28

Where the Q4 continuation pass stopped, and what is left. Nothing is committed,
pushed or deployed. No migration was written or applied.

## State of the tree

`HEAD` == `origin/main` == `7e72564` (Q3). All Q4 work is local and uncommitted.

| File | State | What it is |
|---|---|---|
| `src/lib/events.ts` | modified | `recipientSummary()` |
| `src/utils/supabase/events-server.ts` | modified | `activeRecipientCount` on `EventRecord` |
| `src/app/events-dashboard.tsx` | modified | `areaName` prop; recipient count on cards |
| `src/app/page.tsx` | modified | passes `areaLabel(active)` |
| `src/app/people/person-modal.tsx` | modified | **removes the Name field** from the recipient editor |
| `scripts/mutation-check.mjs` | modified | Q4 mutations; `only` filter; honest denominator |
| `package.json` | modified | `test:events-recipients`, `test:mutation-gate` |
| `scripts/events-and-recipients.test.mjs` | **untracked** | Q4 suite, 52 tests |
| `scripts/mutation-gate.test.mjs` | **untracked** | 5 tests pinning the denominator |
| `scripts/mutation-summary.mjs` | **untracked** | the summary sentence, extracted so it can be tested |
| `docs/Q4-CONTINUATION-CHECKPOINT.md` | **untracked** | this file |

**Four of these are untracked.** A `git clean` destroys the entire Q4 test
effort. Do not run one.

## What this pass added

1. **Mutation denominator fixed.** A filtered run counted catches against every
   mutation in the file, so `mutation-check.mjs Q4` reported `17/78 mutations
   caught` — a sentence that says sixty-one holes were found. Now
   `17/17 … (filtered to "Q4"; 84 exist in total)`. The sentence was extracted
   into `scripts/mutation-summary.mjs` because the runner mutates the working
   tree on import and cannot be asked a question without it starting to edit
   files.

2. **Birthday uniqueness is now executed, not read.** Six tests against real
   PostgreSQL: same person + same year refused with `23505` (using a different
   name *and* date, so migration 035's name/date index cannot be the thing
   refusing); different year allowed; different person same year allowed; a
   person with the same *name* in another Area allowed on the very same day;
   archiving frees the year again, which is migration 026's deliberate escape
   hatch.

3. **Birthday celebrant privacy is now covered at the event level.** Nine tests
   over the whole surface an event page loads — event, recipients, contributors,
   contribution plans, gift ideas, purchases, purchase allocations, settlements,
   payment receipts and item photos. The money layer had no coverage at all
   before this. Also covered: the buyer's identity as a column; the event's
   absence from the dashboard's own query shape; that `people` and `app_members`
   stay readable (migration 031 is explicit that a birthday *date* is not a
   secret); and that the administrator-as-celebrant is blocked identically.

4. **Six new mutations, Q4-17 … Q4-22.** All caught.

## The finding worth remembering

The first versions of the privacy mutations targeted migration **031** and
**both survived**.

Migration 031 introduces birthday privacy. Migration **036** drops and recreates
the same policies to add the Area predicate, and 036's versions are what the
database ends up with. So 031's end-state block — which asks whether each
policy's `qual` still mentions `is_own_birthday` — runs *before* its own work is
overwritten, and protects nothing in the final schema.

Mutations retargeted to 036. Two further mutations (Q4-21, Q4-22) keep the
function name exactly where any text-based guard looks for it and hand it an id
that does not exist, so `not false` shows everybody everything while the
migration applies happily. Those two are caught only by the new assertions,
which is the point of them.

## Gates, all green as of this checkpoint

| Gate | Result |
|---|---|
| Full regression | 1317 tests, 1317 pass, 0 fail, 0 skipped, 0 todo, 56 suites |
| Focused suites | 631 pass across 21 suites |
| Mutations (run alone) | **84/84 caught**, 0 survivors |
| TypeScript | clean |
| ESLint | clean |
| Production build | succeeds |
| `git diff --check` | clean |
| Migrations | 001–045 byte-for-byte untouched; no 046 |

Never run `test:mutations` alongside other suites — it rewrites source files on
disk and produces false failures in anything running concurrently.

## What is left

**Browser QA — none of it has run.** Confirmed from data, not from source: no
QA-Area row has been written since 2026-08-26T19:26Z, and every recent QA row is
membership work from Q3.

Outstanding journeys: Events index; create Custom event; special-event creation;
recipient add / duplicate / deactivate / reactivate; event contributors; event
Settings; event More; Birthday privacy; multi-Area switching; cross-Area
tampering; mobile at 390×844; console/network review; post-QA fingerprint.

### The blocker

Browser QA needs a signed-in session at `https://xmas-family.uk/`.

- Use **Chrome**. Of the connected browsers, Chrome drives the site fully
  (navigation, screenshots, `javascript_tool`). The Edge instance cannot be
  driven at all: it reports navigation success but reads back as
  `edge://newtab/`, and denies both JavaScript and screenshots on this domain.
- Browser display names are reassigned as instances connect. Match on
  `deviceId`, not on the name.
- Sign-in must be done by the user. No auth account may be created.

### Note on what the deployed site can prove

`xmas-family.uk` serves the **deployed Q3 build**. Three Q4 items therefore have
no deployed code behind them and cannot be verified there:

- the Area name as the Events index eyebrow
- the recipient count on event cards
- the removed Name field in the recipient editor

Everything else on the QA list exercises behaviour that is already live.

## Separate production issue, unrelated to Q4

`xmas-family.uk` reportedly fails to load in Edge and Safari (phone and
computer) while working in Chrome and Firefox. Measured from this machine:

- DNS resolves (`104.21.20.34`, `172.67.191.74`, plus AAAA)
- TLS 1.2 and 1.3 both negotiate; `ssl_verify_result 0`
- chain is complete and verifies: leaf → GTS WE1 → GTS Root R4, cross-signed by
  GlobalSign Root CA — a root present in every OS trust store
- `HTTP 200`, HSTS `max-age=31536000; includeSubDomains`

The server is healthy. The one real gap found: **`www.xmas-family.uk` is
NXDOMAIN.** With `includeSubDomains` on HSTS, anything reaching `www.` is forced
to HTTPS and then fails to resolve, with no fallback. Adding a `www` record that
redirects to the apex is worth doing regardless.

Still unknown, and needed to diagnose further: the exact failure shown in
Edge/Safari (unreachable vs certificate warning vs SmartScreen block vs
spinner), and whether typing the full `https://xmas-family.uk/` behaves
differently from typing the bare host.

This is present on deployed Q3 and is not a Q4 regression.

---

## Update — 2026-08-28, live-domain pass

Q4 is no longer uncommitted. Browser QA moved to the live domain at the user's
instruction, which meant deploying first.

### One defect fixed in this pass

**The notification audience was Area-blind.** `loadFamilyContext` builds its
audience through the admin client, which bypasses row level security so the
dispatcher can see who to leave out. Its `areaId` parameter defaults to `null`,
and null means *every membership in the database*. `dispatchNotificationEvent`
and `dispatchOutboxEvent` both omitted it.

Measured against the real database: two gift ideas added inside one QA Area
produced **fifteen notifications across four Areas — eight of them delivered to
a different family's members**, titled “New gift idea for <person>”, naming
somebody those readers have no relationship to and linking to an event they
cannot open.

Fixed by resolving the subject's Area and passing it at both call sites.
TypeScript only; no migration. Pinned by two tests and mutations Q4-23/Q4-24.

### Defects found and NOT fixed (all pre-existing, all live before this pass)

| # | What | Where |
|---|---|---|
| F2 | Event settings recipient/contributor pickers and the add-recipient dropdown list People from every Area the account belongs to, including the real family, by name | `src/app/events/[eventId]/settings/page.tsx:21`, `src/app/people/people-screen.tsx:458` |
| F3 | Add-recipient dialog can never submit: it validates a `name` that no field sets, so the bare identifier resolves to `window.name` (`""`) and always refuses with “Enter a name.” | `src/app/people/people-screen.tsx:530` |
| F4 | Duplicate event shows raw Postgres text, because the friendly-error branches still match index names migration 035 renamed | `src/app/events/new/create-event-form.tsx:514,517` |

F2 is disclosure only — the write barrier correctly refuses a foreign Person
with `23514`. F3 blocks a documented Q4 journey through that route; the Event
settings chips remain a working path.

