# Checkpoint 4.3 Recovered Handoff

Reconstructed on **2026-08-24** from the repository itself (`git status`, `git diff`,
untracked file contents, and a full verification run). The previous session's chat
was lost; nothing below is taken from that report — every claim cites a file in the
current working tree.

**This reconstruction was read-only.** No source file was edited, nothing was
committed, pushed, deployed or applied to any database. The only two files created
are this one and `docs/CHECKPOINT-4.3-WORKING-DIFF.txt`.

---

## Current Git state

| | |
|---|---|
| **Branch** | `main` |
| **HEAD** | `56ab4ebba171eacd960bae7b8007208671b44981` — *Complete family gift planner event and birthday updates* |
| **Staged** | **nothing** (`git diff --cached` is empty) |
| **Stash** | **empty** (`git stash list` returns nothing) |
| **Modified** | 31 tracked files + 1 deletion = **32 diff entries** |
| **Untracked** | **5 files** (excluding the two docs created by this reconstruction) |
| **Total** | 894 insertions, 517 deletions across tracked files |

### Recent commits

```
56ab4eb Complete family gift planner event and birthday updates   <- HEAD
29bb7e5 Fix birthday workspace server rendering
0c89355 Fix birthday saving and empty event deletion
3d6972f Refine birthday and single-recipient event experience
c3eea1f Add event creation and birthday reminders
```

**All of Checkpoint 4.3 is uncommitted.** It exists only in the working tree.

### Modified files (31)

```
 M .github/workflows/database-backup.yml
 M package.json
 M scripts/backup-workflow.test.mjs
 M scripts/birthday-and-delete-regressions.test.mjs
 M scripts/birthday-experience.test.mjs
 M scripts/event-administration.test.mjs
 M scripts/event-model.test.mjs
 M scripts/occasions-and-workspace.test.mjs
 M scripts/rls-security.test.mjs
 M src/app/add-purchase/purchase-form.tsx
 M src/app/api/admin/family-access/route.ts
 M src/app/birthdays/[personId]/page.tsx
 M src/app/events-dashboard.tsx
 M src/app/events/[eventId]/more/page.tsx
 M src/app/events/[eventId]/people/page.tsx
 M src/app/events/[eventId]/settings/page.tsx
 M src/app/events/[eventId]/settings/settings-screen.tsx
 M src/app/events/new/create-event-form.tsx
 M src/app/events/new/page.tsx
 M src/app/family-context.tsx
 M src/app/more/activity/activity-client.tsx
 M src/app/more/family-access/family-access-client.tsx
 M src/app/more/more-screen.tsx
 M src/app/more/notifications/page.tsx
 M src/app/people/people-screen.tsx
 M src/app/people/person-modal.tsx
 M src/app/people/purchases.tsx
 M src/app/people/recipient-allocation-editor.tsx
 M src/lib/events.ts
 M src/lib/uk-occasions.ts
 M src/utils/supabase/birthdays-server.ts
```

### Deleted file (1)

```
 D src/app/birthdays/[personId]/workspace-screen.tsx   (-338 lines)
```

### Untracked files (5)

```
?? scripts/checkpoint-4-3.test.mjs                                        (575 lines)
?? src/app/birthdays/[personId]/start-planning-screen.tsx                 (338 lines)
?? src/app/birthdays/[personId]/history/page.tsx                          ( 38 lines)
?? src/app/birthdays/[personId]/history/history-screen.tsx                (135 lines)
?? supabase/migrations/202608100030_family_contributors_and_atomic_setup.sql (395 lines)
```

---

## What was implemented

### Requirement-by-requirement verdict

| # | Requirement | Status |
|---|---|---|
| 1 | Richer Upcoming Birthday dashboard cards | **PARTIAL** — built but not wired |
| 2 | Budget / spent / remaining / progress / gift + idea counts | **PARTIAL** — same wiring gap |
| 3 | Remove the redundant Birthday intermediate workspace | **COMPLETE** |
| 4 | `/birthdays/[personId]` acts as a resolver to Event Home | **COMPLETE** |
| 5 | Birthday Start Planning asks for budget + contributors first | **COMPLETE** |
| 6 | Neutral "Budget" wording instead of "Christmas budget" | **COMPLETE** |
| 7 | Explicit family-level contributor pool | **COMPLETE** (in code; migration unapplied) |
| 8 | Global Admin contributor management | **COMPLETE** (in code; migration unapplied) |
| 9 | Christmas creatable again | **COMPLETE** |
| 10 | Easter uses the same multi-recipient event architecture | **COMPLETE** |
| 11 | Next-upcoming-occurrence year selection | **COMPLETE** |
| 12 | Global Admin administers normal family/event setup in-app | **COMPLETE** |
| 13 | Future public-app compatibility, no multi-household yet | **COMPLETE as scoped** |
| — | *(post-chat)* Remove duplicate top-level Birthdays button | **NOT STARTED** |

---

### 1–2. Richer Upcoming Birthday cards — **PARTIAL**

Everything needed exists and is correct, but **the data never reaches the card.**

**Built (loader):** `src/utils/supabase/birthdays-server.ts`
- New exported type `BirthdayPlanning` — `{ eventId, eventName, year, budgetPennies, spentPennies, giftCount, ideaCount }`.
- New exported type `FamilyPerson = PersonBirthday & { isFamilyContributor: boolean }`.
- `FamilyBirthdays` gains `planningByPerson: Record<string, BirthdayPlanning>`.
- `loadFamilyBirthdays()` now resolves each person's **next** occurrence year via
  `nextBirthdayOccurrence`, selects only the matching active birthday events, and
  aggregates from the same rows Event Home reads:
  - budget from active `christmas_recipients.budget_pennies`
  - spend + gift count from `purchases` where `deleted_at is null`
  - idea count from `gift_ideas` minus ideas already purchased
    (`originating_gift_idea_id`)

**Built (card):** `src/app/events-dashboard.tsx`
- `EventsDashboard` accepts `planningByPerson` and forwards it through
  `UpcomingBirthdaysSection` → `BirthdayCard`.
- `BirthdayCard` renders spent-of-budget, a `FinancialProgressBar` (`mode="budget"`,
  which is where the **remaining** figure comes from — there is no separate
  "remaining" number on the card), gift and idea counts, and a status badge from
  `purchaseProgressStatus`. New helpers `statusLabel` / `statusTone` map onto the
  existing badge vocabulary.
- No planning → *"Planning not started yet"*, never "£0 of £0".
- Grid changed `xl:grid-cols-4` → `xl:grid-cols-3` to fit the extra content.

**The gap — this is the headline unfinished item:**
`src/app/page.tsx` was **never modified** (it is not in the modified list). It calls
`loadFamilyBirthdays()` at `src/app/page.tsx:45`, uses only `.people`, and renders
`<EventsDashboard>` at `src/app/page.tsx:59` **without** `planningByPerson`. The prop
defaults to `{}`, so **every Upcoming Birthday card currently renders "Planning not
started yet"** even for a fully planned birthday. All the aggregation work in the
loader is computed and thrown away.

### 3. Redundant intermediate workspace removed — **COMPLETE**

`src/app/birthdays/[personId]/workspace-screen.tsx` is deleted (338 lines). It was the
financial landing page that duplicated Event Home one tap earlier. Its two genuinely
useful parts were rehomed, not lost:
- previous years → the new history route (below)
- unused-occurrence tidy-up → `history-screen.tsx`

### 4. `/birthdays/[personId]` is a resolver — **COMPLETE**

`src/app/birthdays/[personId]/page.tsx` (renamed `BirthdayWorkspacePage` →
`BirthdayPage`):
- `loadBirthdayWorkspace(personId)` → `notFound()` if null (unknown person and
  unauthorised reader are indistinguishable).
- If `workspace.current` exists → `redirect(eventPath(workspace.current.eventId))`.
- Otherwise → `<StartPlanningScreen>`.
- `redirect` and `notFound` are deliberately at top level, never inside `try/catch`.

Also new: **`/birthdays/[personId]/history`** (`history/page.tsx` +
`history/history-screen.tsx`), read-only previous years, linked from the birthday's
own More screen via `celebrantPersonId` (`src/app/events/[eventId]/more/page.tsx`,
`src/app/more/more-screen.tsx`).

### 5. Start Planning asks for budget + contributors first — **COMPLETE**

`src/app/birthdays/[personId]/start-planning-screen.tsx` (new, 338 lines):
- Asks for budget, contributor selection, and equal-or-manual split **before**
  anything is created. Opening or cancelling the page creates nothing.
- Equal split reuses `splitPenniesEqually` — no second splitter.
- Client-side check that the plan totals the budget exactly before enabling submit.
- **One** call: `createClient().rpc("start_birthday_planning", { p_celebrant_person_id,
  p_name, p_event_date, p_budget_pennies, p_contributions })`.
- On success → `router.replace("/events/<id>")`, straight to Event Home.
- Non-admin and no-birthday-recorded states render explanatory screens, not the form.

Loader support in `birthdays-server.ts`: `BirthdayWorkspace` gains
`nextOccurrenceDate` and `eligibleContributors` (the pool, minus the celebrant).

### 6. Neutral "Budget" wording — **COMPLETE**

"Christmas budget" / "Christmas list" / "Remove from Christmas" replaced with neutral
wording across: `src/app/family-context.tsx`, `src/app/people/person-modal.tsx`,
`src/app/people/people-screen.tsx`, `src/app/people/purchases.tsx`,
`src/app/people/recipient-allocation-editor.tsx`,
`src/app/add-purchase/purchase-form.tsx`, `src/app/more/activity/activity-client.tsx`,
`src/app/more/notifications/page.tsx` ("Christmas Budget" → "Family Gift Planner").
Pinned by `checkpoint-4-3.test.mjs` → *"shared screens do not call an event Christmas"*.

### 7. Family-level contributor pool — **COMPLETE in code**

- **DB:** `people.is_family_contributor boolean not null default false`, partial index
  `people_family_contributors_idx`, backfilled from anyone already an active row in
  `contributors` (derived from data — no names hard-coded).
- **Reads:** `birthdays-server.ts`, `src/app/events/[eventId]/settings/page.tsx`,
  `src/app/api/admin/family-access/route.ts` all now select the column.
- **Semantics:** recipient pickers still offer **everybody**; contributor pickers offer
  **only the pool**. `create-event-form.tsx` builds `contributorPool` and uses it for
  every `applyTypeDefaults` branch. `settings-screen.tsx` uses
  `contributorChoices = pool ∪ already-contributing-on-this-event`, so removing
  somebody from the pool cannot strand their existing money off-screen.

### 8. Global Admin contributor management — **COMPLETE in code**

- **RPC:** `public.set_family_contributor(uuid, boolean)` — SECURITY DEFINER,
  `search_path = ''`, `is_app_admin()` checked inside, revoked from `anon`, granted to
  `authenticated`. Deliberately **shallow**: it flips one boolean and rewrites no plan,
  allocation or payment.
- **UI:** new `ContributorPool` section at the top of
  `src/app/more/family-access/family-access-client.tsx` — toggle chips, live count
  ("N of M people"), reload on change.
- **API:** `/api/admin/family-access` returns `isFamilyContributor` per person.

### 9. Christmas creatable again — **COMPLETE**

`src/lib/events.ts`: `SPECIAL_EVENT_TYPES` now begins with `"christmas"`. The comment
records the reasoning: a family needs Christmas 2027, and a brand-new household has
none. Duplicates are prevented by the **database** (migration 025's
`events_one_christmas_per_year_idx`), not by hiding the option. Birthday remains
absent from the wizard by design.

### 10. Easter uses the multi-recipient architecture — **COMPLETE**

`eventTypeMeta.easter` has `allowsCelebrant: false` (`src/lib/events.ts:147-152`), and
`applyTypeDefaults("easter")` clears the celebrant, starts with no recipients and
defaults contributors to the pool — the same generic path as Mother's/Father's Day and
Christmas. No Easter-specific recipient handling exists anywhere.

### 11. Next-upcoming-occurrence year selection — **COMPLETE**

- `src/lib/uk-occasions.ts`: new `nextOccurrenceYear(eventType, today, taken[])` —
  walks forward up to 25 years, treats **today** as still upcoming, and skips years
  already taken by an active event.
- `src/app/events/new/page.tsx`: builds `takenYears` from `listEvents()` (active only)
  and passes it in.
- `create-event-form.tsx`: `applyTypeDefaults` uses it instead of
  `new Date().getUTCFullYear()`. The old local `nextOccurrenceYear` for birthdays was
  replaced by `nextBirthdayYear(birthday, today)`, which takes the **family's** date
  rather than reading the clock (BST correctness).

### 12. Global Admin administers setup in-app — **COMPLETE**

Contributor pool (Family access) + Create Event wizard with Christmas restored and
correct year defaults + per-event recipients/contributors (Event Settings) + atomic
birthday setup. Additionally, an event that names a celebrant now shows a fixed single
recipient and never offers "Add recipient" — decided by `celebrantPersonId !== null`,
never by event type (`people-screen.tsx`, `settings-screen.tsx`).

### 13. Public-app compatibility, no multi-household — **COMPLETE as scoped**

No household/tenant column, table or scope was introduced — correct, that was
explicitly out of scope. What was done is the groundwork: the backfill derives from
data rather than a name list, the migration handles the "family has no events yet"
case as a normal outcome, and `checkpoint-4-3.test.mjs` pins *"no family member,
family size, year or event id is hard-coded anywhere"*.

### Also implemented (not on the original list)

- **`scripts/checkpoint-4-3.test.mjs`** — 575 lines, 33 tests, plus
  `npm run test:checkpoint-4-3` in `package.json`.
- **Backup guard:** `.github/workflows/database-backup.yml` adds
  `is_family_contributor` to the required-columns loop, with an explicit ordering
  warning (see Migration status).
- Existing suites updated to match: `event-model` (30 migrations, 030 newest),
  `event-administration` (new *"030 adds two admin paths and rewrites no financial
  history"*), `birthday-experience`, `birthday-and-delete-regressions`,
  `occasions-and-workspace`, `rls-security`, `backup-workflow`.

---

## What remains unfinished

1. **`src/app/page.tsx` does not pass `planningByPerson`.** *(Highest priority —
   it silently defeats the checkpoint's headline feature.)* The loader computes the
   whole aggregate and `page.tsx` discards it, so every birthday card reads "Planning
   not started yet". One prop, plus threading it out of the `Promise.allSettled`
   birthday branch at `src/app/page.tsx:44-56`.
2. **The duplicate top-level Birthdays button is still there.** See *New pending UI
   requirement* below.
3. **Migration 030 is unapplied** (see below) — until it is, the app cannot run
   against the live database at all.
4. **Nothing is committed.** The entire checkpoint is uncommitted working-tree state
   with no stash backup. A `git checkout .` would destroy ~1,500 lines of work.
5. **No test covers the `page.tsx` → dashboard wiring.** `checkpoint-4-3.test.mjs`
   asserts the card *renders* the figures; nothing asserts the page *supplies* them,
   which is exactly why item 1 passed 33/33 tests unnoticed.
6. **No documentation** for the contributor pool as a family-facing concept
   (`docs/` has only `database-backups.md` and `removing-an-empty-event.md`).

---

## Migration status

| | |
|---|---|
| **Does 030 exist?** | **Yes** |
| **Exact filename** | `supabase/migrations/202608100030_family_contributors_and_atomic_setup.sql` |
| **Tracked in git?** | **No — untracked, never committed** |
| **Any later migration?** | **No.** 030 is the newest of exactly 30 files. |
| **Applied?** | **Evidence says NOT APPLIED to production** |

### Evidence for "not applied"

The strongest evidence is a comment the previous session wrote into
`.github/workflows/database-backup.yml`:

> `# ORDERING: is_family_contributor arrives with migration 030. This list must not`
> `# reach the default branch before that migration is applied, or the nightly backup`
> `# will report a valid dump as invalid.`

That instruction only makes sense if 030 was still unapplied when it was written, and
it is corroborated by: the migration being untracked, nothing committed, and no
migration-runner state in the repo (`supabase/` has only `migrations/` and two seed
files — application is manual). `docs/database-backups.md:70` records the identical
discipline for migration 026.

Separately, the migration's own header says *"the runtime preflight proved it by
refusing a second Christmas 2026"* — a preflight was evidently run against **some**
PostgreSQL during the lost session, but **no preflight script exists in the repo**, so
which database it ran against cannot be determined from the repository. **Do not read
that comment as proof of production application.**

### What 030 changes

**New column**
- `public.people.is_family_contributor boolean not null default false`, with a column
  comment and partial index `people_family_contributors_idx on people (id) where
  is_family_contributor`.

**Backfill (idempotent)**
- Sets `true` for anyone appearing in `contributors` with `active` — derived purely
  from existing data. Names nobody. A family with no events sets nobody, and that is
  treated as correct, not a failure. Raises a `notice` with the counts.

**New functions / RPCs** (both SECURITY DEFINER, `search_path = ''`, `revoke ... from
public, anon`, `grant execute ... to authenticated`, `is_app_admin()` enforced inside)
1. `public.set_family_contributor(p_person_id uuid, p_eligible boolean) returns people`
2. `public.start_birthday_planning(p_celebrant_person_id uuid, p_name text,
   p_event_date date, p_budget_pennies integer, p_contributions jsonb) returns events`

**Atomic birthday setup** — `start_birthday_planning` creates, in one transaction: the
`events` row (`event_type='birthday'`, `status='active'`), the `contributors` rows, the
`christmas_recipients` row for the celebrant with its budget, and a full
`recipient_contributions` plan (every active contributor gets a row, at their planned
amount or zero). It validates name/date/budget, refuses a celebrant contributing to
their own birthday, refuses anyone outside the pool (`42501`), and refuses a plan whose
total ≠ budget — so the caller is told which number is wrong instead of hitting
migration 012's commit-time invariant.

**Constraints / RLS / grants**
- No new RLS policies. `people` is already read-only to browsers and written only via
  SECURITY DEFINER functions, so eligibility inherits the existing authorization.
- No new constraint. **Note the migration adds NO Christmas duplicate guard** — its
  section 4 is a comment explaining that migration 025's
  `events_one_christmas_per_year_idx` (`unique (year) where event_type='christmas'`)
  already does the job, and section 6 asserts that index still exists.

**Preflight / end-state guards**
- Refuses to run unless 025 (`public.events`), 026 (`create_event`) and 029
  (`birthday_budget_summaries`) are present.
- End-state block verifies: the column exists; the backfill made nobody eligible who
  is not an existing active contributor; both new functions are definer +
  `search_path`-pinned; neither is executable by `anon`; 025's Christmas index is
  intact; and `due_birthday_budget_summaries` is unchanged.

**Known asymmetry documented in the migration (not a bug, a product decision):**
the Christmas uniqueness index has no `status` predicate, so archiving Christmas 2027
does **not** free 2027. Birthdays differ — their index is scoped to active rows, so
archiving a mistaken birthday does free that person's year.

---

## Test status

Run **before** the instruction to skip verification, against the working tree as it
stands. Nothing was changed to make anything pass.

| Check | Command | Result |
|---|---|---|
| Full test suite | `node --test` over all 36 test files | **596 / 596 pass, 0 fail** |
| New checkpoint suite | `npm run test:checkpoint-4-3` | **33 / 33 pass, 0 fail** |
| TypeScript | `npx tsc --noEmit` | **clean, exit 0** |
| ESLint | `npm run lint` | **clean, no output** |
| Production build | `npm run build` | **succeeds** — 41 routes, incl. `/birthdays/[personId]` and `/birthdays/[personId]/history` |
| Whitespace | `git diff --check` | **clean, exit 0** |

Environment: Node v24.11.0, Next 16.3.0. Suite duration ~700 ms.

**Read this result carefully:** everything green is real, but it did **not** catch the
`page.tsx` wiring gap, because no test asserts that the page supplies
`planningByPerson`. Green here means "nothing is broken", not "the feature works".

---

## Known risks / bugs

1. **CRITICAL — dashboard birthday money never renders.** `src/app/page.tsx` omits
   `planningByPerson`; the prop defaults to `{}`; every card falls into the
   "Planning not started yet" branch. Silent, type-clean, and test-clean.
2. **HIGH — the app cannot run against a database without 030.** Four queries now
   select `is_family_contributor`
   (`birthdays-server.ts`, `events/[eventId]/settings/page.tsx`,
   `api/admin/family-access/route.ts`). Against an unmigrated database these fail with
   an undefined-column error, which surfaces as *"The family's birthdays could not be
   loaded"* on the dashboard and breaks Event Settings and Family access. **Apply 030
   before running this tree against the live database.**
3. **HIGH — everything is uncommitted and unstashed.** No recovery point exists.
4. **MEDIUM — backup-workflow ordering trap.** The `is_family_contributor` guard in
   `.github/workflows/database-backup.yml` must not reach the default branch before
   030 is applied, or every nightly backup will report a valid dump as invalid. The
   comment says so; the sequencing is the operator's responsibility.
5. **MEDIUM — contributor pool starts empty for a family with no `contributors` rows.**
   The backfill derives from data, so a fresh household gets nobody, and
   `create-event-form.tsx` then shows *"Nobody is set up as a family contributor yet.
   Add somebody in Family access first."* Correct by design, but it is a setup step
   somebody must know to perform.
6. **LOW — `start_birthday_planning` is untested against real PostgreSQL in-repo.**
   `checkpoint-4-3.test.mjs` reads the SQL as text; it does not execute it. The
   transaction semantics, the `42501` pool check and the total-vs-budget check are
   unverified by any committed test.
7. **LOW — `loadBirthdayWorkspace` adds an unconditional extra query** for
   `eligibleContributors`, even on the redirect path where the value is discarded.
   Harmless, mildly wasteful.
8. **LOW — line endings.** Many files report `LF will be replaced by CRLF`. Cosmetic;
   `git diff --check` is clean.

---

## Production safety

**Christmas 2026 is LIVE and holds real family financial data. It is read-only for
this work.**

- This reconstruction performed **no** production write, no migration application, no
  deploy, no push, and no commit. It read the repository only.
- Migration 030 does not touch Christmas 2026. Its own header states it changes no
  budget, plan, purchase, allocation, settlement, receipt or Owed value that already
  exists, redefines none of the functions that write them, and rewrites no birthday,
  reminder or occurrence. `scripts/event-administration.test.mjs` enforces this: 030
  may define only `set_family_contributor` and `start_birthday_planning`, and must not
  write `purchases`, `purchase_allocations`, `settlements` or `payment_receipts`.
- Migrations 001–024 are fingerprinted by `scripts/event-model.test.mjs` (SHA-256
  `000ab0ed01e26751ff1cba9e0885b4058747758cb6f3cf763d0652532770a9af`) and are
  **unedited**. Migrations 025–029 are live and unedited.
- **No previous Christmas fingerprint was found in local notes.** Nothing of the kind
  exists in `docs/`, `README.md` or elsewhere in the tree, and none has been invented
  here. The only fingerprint in the repository is the migrations 001–024 hash above.
- Per `docs/database-backups.md:91`, run the backup workflow **before** applying any
  migration.

---

## New pending UI requirement

**Status: OUTSTANDING. The current diff does not implement it.**

The root Events dashboard shows Birthdays twice:

1. A large secondary `ButtonLink` in the `PageHeader` actions —
   `src/app/events-dashboard.tsx:86-89`:
   ```tsx
   <ButtonLink href="/birthdays" variant="secondary" size="lg" className="w-full sm:w-auto">
     <Cake size={18} aria-hidden />
     Birthdays
   </ButtonLink>
   ```
2. The **Upcoming birthdays** section with its "All birthdays →" link —
   `src/app/events-dashboard.tsx:152-160`.

The top button is redundant on **both** desktop and mobile.

**Required change**
- Remove the large top-level Birthdays button from the dashboard header
  (`src/app/events-dashboard.tsx:83-89`, including its explanatory comment).
- Keep **Upcoming birthdays** as the dashboard's Birthday section.
- Keep the **"All birthdays →"** link (`events-dashboard.tsx:154-159`).
- Keep the dedicated `/birthdays` page.
- Do **not** remove Birthday navigation elsewhere where it genuinely belongs —
  specifically `src/app/more/more-screen.tsx` (`IconCake`) and the new
  *Previous birthdays* link on a birthday's More screen.

**Watch for:** removing the button leaves `Cake` possibly unused in the
`lucide-react` import at `events-dashboard.tsx:4` — ESLint will flag it. Also,
`isAdmin` is used elsewhere in the header, so the `<>…</>` fragment may collapse to a
single conditional child.

---

## FIRST THING TO DO NEXT

**Create a recovery point before anything else:** commit the working tree (all 31
modified files, the deletion, and all 5 untracked files) to a new branch —
`git checkout -b checkpoint-4.3` then `git add -A && git commit`. Roughly 1,500 lines
of unversioned work with no stash currently sits one careless command from
destruction, and every fix below is safer once it exists.

---

## RESUME PROMPT

> Continuing Checkpoint 4.3 on the Family Gift Planner. Read
> `docs/HANDOFF-CHECKPOINT-4.3-RECOVERED.md` first — it reconstructs the full state.
>
> Christmas 2026 is live production financial data: do not write to production, do not
> apply migrations, and do not deploy without asking me.
>
> Work in this order:
>
> 1. Commit the current working tree to a new branch `checkpoint-4.3` (nothing is
>    committed and there is no stash).
> 2. Fix the critical wiring bug: `src/app/page.tsx` calls `loadFamilyBirthdays()` but
>    never passes `planningByPerson` to `<EventsDashboard>`, so every Upcoming Birthday
>    card renders "Planning not started yet" regardless of real planning. Thread it
>    through the `Promise.allSettled` birthday branch, and add a test that pins the
>    page supplying it — `scripts/checkpoint-4-3.test.mjs` only checks that the card
>    renders it.
> 3. Remove the duplicate large "Birthdays" button from the dashboard header
>    (`src/app/events-dashboard.tsx:83-89`). Keep the Upcoming birthdays section, the
>    "All birthdays →" link, the `/birthdays` page, and Birthday navigation on the More
>    screens. Tidy the now-unused `Cake` import.
> 4. Re-run: `npx tsc --noEmit`, `npm run lint`, the full test suite
>    (`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test scripts/*.test.mjs
>    src/lib/*.test.ts`), and `npm run build`. Baseline is 596/596 passing, all clean.
>
> Migration `202608100030_family_contributors_and_atomic_setup.sql` is written but
> **unapplied and untracked**. Do not apply it. Tell me when the code is ready and I
> will decide when to run it — and note that
> `.github/workflows/database-backup.yml`'s new `is_family_contributor` guard must not
> reach the default branch before that migration is applied.
