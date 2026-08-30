# Q18 — one implementation per concept

What Q17 handed over as "three live, correct duplicates", settled. Q18 changed
no database object: **migrations still end at 051.**

Every consolidation here is behaviour-preserving. Nothing in this phase changes
what a screen shows, what a form submits, or what a routine is allowed to do.

---

## 1. `priceInput` — four copies, now one

**The concept.** Pennies as the string an editable money field holds: no
currency symbol, no thousands separator, and no trailing `.00`, so a £30 budget
opens as `30` and can be submitted unedited.

| | |
| --- | --- |
| Was in | `add-purchase/purchase-form.tsx`, `people/gift-ideas.tsx`, `people/person-modal.tsx`, `people/recipient-allocation-editor.tsx` |
| Now in | **`src/lib/currency.ts`**, beside `formatPennies` |
| Callers migrated | 4 files, 13 call sites |
| Copies removed | 4 |

**The four were already identical.** Two spelled the regex `/\.00$/` and two
`/\.00$/u`; the `u` flag changes nothing for that pattern. There was no
divergence to reconcile — which is the good case, and is why this could be a
straight move.

**Why `currency.ts` and not a new utility module.** The money module already
existed and already owned the other direction. Putting the two next to each
other is also what makes the difference between them legible, and that
difference is the whole point of having two: `formatPennies` adds a `£` and a
thousands separator, and a field seeded from it **cannot be submitted
unedited**, because `parseMoneyToPennies` refuses the string it holds. Mutation
`Q18-1` is exactly that mistake.

**One deliberate inconsistency, preserved.** `formatPennies` throws on a
non-safe-integer and `priceInput` does not — it rounds, as all four copies did.
Every caller feeds it an integer penny column straight from the database, and a
field that refused to render would take a whole screen down; the parse on the
way back out is where invalid money is caught. Behaviour was held still rather
than improved, because this phase is not the place to change what a form does.

**Proved by** six tests in `src/lib/currency.test.ts`: whole pounds, pence with
and without a leading zero, the absence of symbol and separator asserted against
`formatPennies` in the same test, negative amounts, the two-digits-or-none
shape, and the non-throwing behaviour asserted beside `formatPennies`'s throw.

---

## 2. `todayInput` — two copies, now one

**The concept.** The default value of a `<input type="date">`: today, as the
calendar date **on the device the form is open on**.

| | |
| --- | --- |
| Was in | `add-purchase/purchase-form.tsx`, `owed/owed-screen.tsx` |
| Now in | **`src/lib/input-validation.ts`**, beside `validateDateInput` |
| Callers migrated | 2 files, 3 call sites |
| Copies removed | 2 |

**Both copies had the same semantics**, differing only in local variable names.
Both shifted the instant by `getTimezoneOffset()` before slicing the ISO string,
which is the trick that makes the UTC fields of the shifted instant read as the
local calendar fields of the real one.

**Why `input-validation.ts`.** The module already owned the `YYYY-MM-DD` form
vocabulary in `validateDateInput`. The value a field opens on and the check it
faces on the way back in now sit together, and one of the tests asserts they
agree.

**The canonical version takes an optional `Date`** (`todayInput(now = new
Date())`). Callers are unchanged; the parameter exists so the timezone behaviour
can be tested at a fixed instant instead of mocked.

**Proved by** five tests in `src/lib/input-validation.test.ts`. The interesting
cases are all timezone cases and a process has one timezone, so each runs in a
child process with `TZ` set: Kiritimati (UTC+14) and Niue (UTC−11) at 23:30 UTC
on New Year's Day, British Summer Time moving the date where GMT does not, the
local midnight boundary at 22:59:59 and 23:00:00 UTC, and the round trip through
`validateDateInput`. **Demonstrated to distinguish:** against a naive
`now.toISOString().slice(0, 10)`, three of the five fail.

---

## 3. `progressPresentation` — two copies, now one

**The concept.** How a person's budget position reads: the badge word and the
badge colour for a `PurchaseProgressStatus`.

| | |
| --- | --- |
| Was in | `people/people-screen.tsx`, `people/person-modal.tsx` |
| Now in | **`src/app/components/financial-progress.tsx`** |
| Callers migrated | 2 files |
| Copies removed | 2, plus a third copy of the label half (below) |

**Why that module.** `FinancialProgressBar` already owned how budget progress is
presented, including the words "Budget reached" for a reached budget. The badge
and the bar it sits beside now take that vocabulary from one place.

**A third copy the audit had not counted.** `people-screen.tsx` also carried
`statusFilterLabel`, which returned the same four strings for the filter chips.
It is gone; the chips call `progressPresentation(status).label`. The chip a
person clicks and the badge they were reading can no longer drift apart.

**Preserved:** budgets remain targets, not caps — `budget_reached` is `success`
and `over_budget` is a rendered state, not a refusal. Percentages, the
zero-budget path, the aria semantics and the colour rules all live in
`calculateFinancialProgress` and `FinancialProgressBar` and were not touched.

### 3a. The product-wording question Q17 raised — answered by the tones

Q17 asked whether the dashboard's "Complete" and the people screens' "Budget
reached" were an intentional difference. **They are, and the evidence is
stronger than the wording.** `events-dashboard.tsx` has its own `statusLabel`
and `statusTone`, and the tones differ too:

| status | people screens | events dashboard |
| --- | --- | --- |
| `not_started` | `neutral` | `neutral` |
| `in_progress` | **`warning`** | **`gold`** |
| `budget_reached` | `success` ("Budget reached") | `success` (**"Complete"**) |
| `over_budget` | **`danger`** ("Over budget") | **`warning`** |

**Two of the four states differ, in the word AND in the colour.** An event card
is summarising a whole occasion rather than one person: "Complete" reads better
for a whole Christmas, and one recipient over budget is a warning rather than a
danger. This was never one helper copied twice — it is a second presentation of
the same status, and it stays that way. `canonical-paths.test.mjs` asserts the
dashboard still says `"Complete"` and still tones `in_progress` `gold`, and that
it does **not** import `progressPresentation`.

---

## 4. A fourth duplicate the sweep found: `londonDateInput`

Not in Q17's list, and a genuine one. `payment-log-server.ts` carried a private
`londonDateInput()` whose body was identical to the exported `londonToday()` in
`birthdays-server.ts` — same `Intl.DateTimeFormat`, same `Europe/London`, same
assembly. Different name, so no name-based audit would pair them.

It is gone; `payment-log-server.ts` imports `londonToday`, which is what
`people-server.ts` already did. **The family's timezone is now spelled out in
exactly one file**, and a test asserts it.

### The two "today" functions are deliberately not one

| | `todayInput` | `londonToday` |
| --- | --- | --- |
| Answers in | the reader's device timezone | `Europe/London` |
| Used for | the default value of a purchase or payment date field | birthdays, reminders, dashboard "today" |
| Why | the form defaults to the day the person filling it is having | a birthday is a fixed calendar date wherever it is read from |

For a family in the UK the two agree, which is exactly why merging them would
look safe and be wrong. Both are asserted to keep their own mechanism.

---

## 5. `*-taylor*` operator scripts — all three removed

The user confirmed they do not use or want them, which lifted Q17's
`MANUAL-USE UNKNOWN`. Repository safety was then proved rather than assumed.

| Script | Lines |
| --- | --- |
| `scripts/setup-taylor.mjs` | 60 |
| `scripts/set-taylor-password.mjs` | 145 |
| `scripts/admin-account-target.mjs` | 54 |

**Checked and clear:** no `package.json` script, neither GitHub workflow
(`birthday-reminders.yml`, `database-backup.yml` — neither installs node modules
or runs a script), no import from any `src/` module, no test. The only mentions
anywhere were in three history documents and in each other.
`admin-account-target.mjs` existed solely to hold the other two's email out of
the repository, so it went with them.

**Q17's "nothing supersedes them" was wrong, and this is why they could go.**
`claim_app_member()` is the canonical path that attaches a login to an
`app_members` row: migration 042 documents it, and it runs on **every** auth
callback (`auth/callback/route.ts`) and in `account-setup/page.tsx`. It is row
level security-guarded and deliberately narrow — the row must have had no login
at all, the id must be the caller's own, the address must be theirs, and the
Area may not change. `setup-taylor.mjs` did the same `UPDATE` with the service
role, which bypasses both RLS and the write barrier. Removing it removes a
bypass, not a capability. Password reset without the email flow remains
available in the Supabase dashboard, and `setup-taylor.mjs` ended by calling
`resetPasswordForEmail` anyway — the ordinary flow.

**One Q17 claim corrected.** `setup-taylor.mjs --verify-only` was described as a
read-only mode. It is not: the `app_members` UPDATE runs before the
`verifyOnly` branch is reached, so an operator "just checking" would have
written to production.

**End state: no person-specific operator script remains**, and
`canonical-paths.test.mjs` fails if one returns, or if any script in `scripts/`
starts writing `app_members` with the service role.

---

## 6. Package manager and lockfile

**Canonical package manager: `pnpm`. Canonical lockfile: `pnpm-lock.yaml`.**

Confirmed by the user from the Cloudflare Workers Builds configuration for
`xmasapp`: build `pnpm run build`, deploy `pnpm run deploy`, version
`pnpm run upload`, root `/`, production branch `main`.

**`package-lock.json` is deleted.** Nothing required it: no workflow installs
node modules at all, no script invokes npm, there is no `.npmrc`, and
`package.json` declared no `packageManager`. npm command examples in developer
documentation are not a reason to keep a lockfile — production install
determinism is what a lockfile is for, and that comes from pnpm.

**Two lockfiles were not merely redundant, they had already disagreed.** Q16
recorded `lucide-react` resolving to 1.33.0 in one and 1.31.0 in the other. Both
satisfied `^1.31.0`, so neither was invalid; production simply installed a tree
nobody had built or tested. That cannot recur now.

**Clean validation.** `package.json` and `pnpm-lock.yaml` were copied to a
scratch directory — the working `node_modules` was never touched — and
`pnpm install --frozen-lockfile --ignore-scripts` was run there with
`npx pnpm@10`.

- **pnpm v10.34.5**, resolved by `npx pnpm@10`; Corepack (0.34.0) is installed
  but was not used, and pnpm is not on `PATH`.
- **Install succeeded** in 32.9s, resolving `lucide-react 1.33.0` — the same
  version the npm-installed working copy has.
- **`pnpm-lock.yaml` is byte-identical afterwards**, SHA-256
  `9dfeb23c…d72ae4` before and after, and unmodified in the repository.
- `pnpm run test:canonical-paths` and **`pnpm run build`** — the exact Cloudflare
  build command — both succeed in the repository.
- **No npm lockfile was regenerated.**

**No `packageManager` field was added.** The prompt allowed one only on
evidence of an exact version the repo already expects, and there is none:
`SHADCN-UI.md` says `pnpm@10`, and `lockfileVersion: '9.0'` is written by both
pnpm 9 and pnpm 10. Cloudflare detects pnpm from the lockfile and builds
correctly today; pinning whatever patch `npx pnpm@10` resolved to this afternoon
would change how production installs on no authority at all. Recorded as a
deliberate non-change.

---

## 7. The wider duplicate sweep

Every top-level `function`/`const` definition in `src/` was collected and grouped
by name: **28 names appear in more than one file.** Classified:

| Classification | Count | Examples |
| --- | --- | --- |
| **False positive** — a common local name, different bodies and concerns | 11 | `submit` (10 files), `save` (6), `load`, `remove`, `run`, `toggle`, `handle`, `PersonCard`, `StatusBadge` |
| **Intentional — framework** | 3 | `GET`, `POST`, `PUT` route handler exports |
| **Intentional — registry primitive plus product wrapper** | 8 | `Badge`, `Card`, `Button`, `Input`, `Sheet*`, `Skeleton`, `Textarea`: `ui/index.tsx` imports the stock file and wraps it. Exactly Q16's architecture |
| **Intentional — one per runtime** | 2 | `createClient` (browser/server); `rememberedAreaId` (Next `cookies()` vs `document.cookie`) — and **`AREA_COOKIE` itself is defined once**, in `src/lib/areas.ts` |
| **Intentional — one canonical routine, two screens calling it** | 1 | `voidPayment` in `owed-screen` and `payment-log-screen`: different local state and error wording, both calling the one `void_settlement` RPC |
| **Tiny, and an idiom rather than a concept** | 1 | `pad` — `String(value).padStart(2, "0")` in `birthdays.ts` and `uk-occasions.ts`. Two identical lines with no decision in them; left inlined rather than given a cross-module import |
| **Consolidated in this phase** | 1 | `londonDateInput` → `londonToday` (§4) |
| **Deferred with a reason** | 1 | `signOut` (below) |

**The known three were not symptoms of a wider cluster.** Money parsing, date
generation, progress-state calculation, Area helpers, auth helpers, permission
helpers, notification logic, settings access and request helpers each have one
implementation.

### The two candidates deliberately not done

**`signOut`** is byte-identical in `account/page.tsx` and `account-menu.tsx` —
four lines, and a real hazard: if sign-out ever needs to clear the Area cookie,
one copy gets it and the other does not. It is **not** done here because
verifying it requires signing the family out on the live site, which the QA
rules forbid, and shipping an unverifiable change to the auth path is worse than
the duplication. **Q19's first candidate.**

**`createAdminClient`** in `family-access-admin.ts` and `notifications-server.ts`
each build a service-role client and throw their own domain error type
(`FamilyAccessError` vs `NotificationError`). Merging needs either a shared error
or an injected constructor, on the most security-sensitive client in the app.
Separate architectural work, not a drive-by.

---

## 8. Compatibility route shims — unchanged, and not duplicate systems

`/add-purchase`, `/more`, `/owed` and `/payment-log` stay. They are
**compatibility paths, not second business systems**: they hold URLs that
persisted notification rows and browser history still point at. `/owed` is not
even legacy — `notification-content.ts` declares `OWED_URL = "/owed"` and writes
it as the `url` of every money notification the app creates today. Q18 produced
no production-history evidence that would justify removing any of the other
three, and did not look for it.

---

## 9. What holds this shut

`scripts/canonical-paths.test.mjs` — 13 tests, run by `test:all` and by
`npm run test:canonical-paths`.

It **counts definitions, not filenames**, so moving a helper is free and
duplicating one is not. It holds: one definition each of `priceInput`,
`todayInput`, `progressPresentation` and `londonToday`; `getTimezoneOffset` and
`timeZone: "Europe/London"` each appearing in exactly one file; the four labels
and tones `progressPresentation` returns; the dashboard keeping its own wording
and tones and not importing the shared helper; the two "today" functions keeping
their different mechanisms; no `*taylor*` script; no script writing `app_members`
with the service role; and one lockfile.

**Demonstrated to fail:** a `priceInput` copy added back to `person-modal.tsx`
turns the first test red.

Four mutations, all killed by a named behavioural test:

| Mutation | The defect | Killed by |
| --- | --- | --- |
| `Q18-1` | the money field is seeded with display money (`formatPennies`) | `an editable money field opens on whole pounds without a trailing .00` |
| `Q18-2` | the date field falls back to the UTC calendar day | `a date field opens on the reader's calendar day, not on UTC's` |
| `Q18-3` | reaching a budget is toned `danger` | `a person's budget position reads the same word and colour everywhere` |
| `Q18-4` | a screen grows its own copy of a canonical helper again | `priceInput is defined once, in the money module` |

**A note on `Q18-1`, kept because it will happen again.** Its `from` string was
first written inside a template literal, where `\.` evaluates to `.` — so the
pattern the harness searched for was not the one in the file, and it reported
`COULD NOT APPLY — the code it breaks has moved. Inconclusive.` That is the
harness working: an unapplied mutation is reported as inconclusive rather than
counted as caught. A regex in a mutation's `from` needs its backslash doubled.

---

## 10. Net effect

| | |
| --- | --- |
| Duplicate helper implementations removed | **9** (4 `priceInput`, 2 `todayInput`, 2 `progressPresentation`, 1 `londonDateInput`) — plus `statusFilterLabel`, a third copy of the label half |
| Canonical implementations created | **3** (`priceInput`, `todayInput`, `progressPresentation`); `londonToday` was already canonical |
| Files deleted | **4** (three operator scripts, one lockfile) |
| Lines of committed lockfile removed | ~536 KB |
| Database change | **none** — migrations still end at 051 |
| Tests | 1,725 → **1,749** |
| Mutations | 141 → **145**, zero survivors |
