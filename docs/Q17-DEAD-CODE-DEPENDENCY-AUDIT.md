# Q17 — dead code, duplicate code and dependency audit

**Verdict:** `Q17 CONDITIONAL PASS — UNCERTAIN CANDIDATES DOCUMENTED`
**Date:** 2026-08-30. **No database change; migrations still end at 051.**

The phase that went looking for things nothing needs. It found less dead
application code than expected — Q14's and Q16's cleanups had already taken
most of it — and one real defect in the *test* estate that no previous phase
had measured: four mutations that could never have reached the schema they
claimed to guard.

---

## 1. Whole-repo reachability — nothing unreachable in `src/`

The import graph was rebuilt from scratch rather than trusted from Q14. Every
`.ts`/`.tsx`/`.mjs`/`.js` file was parsed for `import`, `export … from`,
`import()` and `require()`, specifiers were resolved through the `@/ → src/`
alias and Node's extension/index rules, and the graph was walked from every
entry point: Next's file-based route files, every `*.test.*`, everything in
`scripts/`, the root config files and `.claude/hooks/`.

**Every module in `src/` is reachable. There are zero unimported application
files.** Q14's "172 of 174" is now 174 of 174 — Q16 deleted the two that were
not (`ui/select.tsx`, `use-mounted.ts`) and nothing has replaced them.

Three files fell out of the walk and all three are alive by design:

| File | Why the graph misses it | Verdict |
| ---- | ----------------------- | ------- |
| `public/sw.js` | Registered by URL from `pwa-runtime.tsx`, never imported | **Keep** |
| `scripts/dom/stubs/next-link.mjs` | Named as a *string* in `tsx-hook.mjs`'s `STUBS` map | **Keep** |
| `scripts/dom/stubs/area-choice-client.mjs` | Same `STUBS` map | **Keep** |

That `STUBS` map is exactly the hazard rule 8 warns about: five modules whose
only reference is a string literal in a resolver hook. A reachability tool that
did not read it would have proposed deleting them.

Every non-`.mjs` asset under `scripts/` also has a live consumer:
`verify-backup-dump.awk` (the backup workflow, twice, plus its test),
`pg/production-objects.sql` (`migration-execution.test.mjs`),
`pg/applied-migrations.sha256`, and `qa/areas.example.json`
(`no-product-coupling.test.mjs`).

---

## 2. Dead exports — fourteen removed, and why the rest stay

153 exported names have no consumer outside their own file. Almost all of them
are legitimate and stay; the audit's work was telling the categories apart.

**Kept — exported types that name a function's own public shape.** About ninety
of these (`EventStatus`, `PaymentClaim`, `OwedReceiptDetail`, `FamilyContext`…).
They are the return and parameter types of exported functions. Removing the
`export` keyword would not delete a line of shipped code and would make the
modules harder to consume.

**Kept — vendored shadcn registry surface.** `CardHeader`, `SheetTrigger`,
`DropdownMenuSub`, `AlertDialogPortal`, `TableCaption` and about forty more.
These files are *registry output*, and `components.json` is live tooling: the
registry is the upstream, and hand-trimming its output makes the next
`shadcn` update a conflict instead of a diff. Q16 made shadcn/Radix the
canonical primitive layer; keeping its files whole is part of that decision.

**Removed — fourteen names with no consumer of any kind**, each verified by a
whole-repo search that found exactly one occurrence, the declaration itself:

| Removed | Where | Evidence |
| ------- | ----- | -------- |
| `inputClasses` | `ui/index.tsx` | A compatibility alias for `fieldClasses`. Its own comment said it existed "for the handful of places that compose a bespoke control" — Q16 converted the last of those to `Field`, leaving none. |
| `isUuid` | `lib/input-validation.ts` | A predicate wrapper over `validateUuid`, which is used. Never called, never tested. |
| `hasDisallowedControlCharacters` | `lib/input-validation.ts` | An exported wrapper over the private `containsDisallowedControlCharacters`, which is used three times. The wrapper never was. |
| `purchaseStatusLabel` | `lib/purchases.ts` | Superseded: three screens each grew their own status vocabulary (§5), and none of them uses this one's SHOUTED labels. |
| `nextBirthdayFor` | `utils/supabase/people-server.ts` | A one-line wrapper over `nextBirthdayOccurrence`. Its import went with it. |
| `IconCalendar`, `IconChevronLeft`, `IconDots`, `IconLock`, `IconMail`, `IconPencil`, `IconRefresh`, `IconScales` | `components/icons.tsx` | Eight of twenty-five glyph names nothing renders. The eight `lucide-react` imports behind them went too. |

`icons.tsx` gained a note saying the set is demand-driven, so the next reader
knows an unused name is a defect rather than a spare.

---

## 3. `GiftCompleteBurst` — dead since the commit that wrote it

`components/festive/celebration.tsx` exported a one-shot speck animation for
the moment a recipient's gifts were finished. Nothing imported it. `git log -S`
across all history finds **no commit that ever wrote `<GiftCompleteBurst`** — it
was added in the `a28c0ee` redesign alongside `CompleteRibbon` and never wired
up. Removed, together with its three now-unused React imports and the
`.burst-speck` rule and `@keyframes burst` in `globals.css` that existed only
for it.

**Rule 16 was applied, not waived.** The festive layer is not being trimmed for
being festive: `CompleteRibbon` in the same file is on every completed recipient
card and stays, and the snow, garland and ornaments are untouched. This one
component goes because it has never run, not because it is seasonal.

---

## 4. Duplicate implementation — one class removed, three handed on

498 function bodies were normalised (comments stripped, whitespace collapsed)
and hashed to find genuine duplicates rather than similar-looking code.

**Handed to Q18 — live, correct, duplicated:**

| Duplicate | Copies | Why not now |
| --------- | ------ | ----------- |
| `priceInput(pennies)` | **4** — `add-purchase/purchase-form.tsx:637`, `people/gift-ideas.tsx:460`, `people/person-modal.tsx:542`, `people/recipient-allocation-editor.tsx:207` | Money formatting is a stated invariant domain. The canonical home is `lib/currency.ts` beside `formatPennies`, and moving it there deserves its own test rather than a drive-by edit. Two copies spell the regex `/\.00$/` and two `/\.00$/u`; they behave identically. |
| `progressPresentation(status)` | **2**, byte-identical — `people/people-screen.tsx:421`, `people/person-modal.tsx:546` | Picking its home means first deciding whether it should also absorb `events-dashboard.tsx`'s deliberately different pair (below). That is a vocabulary decision, not a cleanup. |
| `todayInput()` | **2** — `add-purchase/purchase-form.tsx:714`, `owed/owed-screen.tsx:1172` | Semantically identical local-date ISO slice, written across four lines in one and three in the other. Date formatting, same argument as money. |

**Intentional separation, confirmed and left alone:**

- `lib/request-origin.ts` (pure, unit-testable rules) and
  `utils/request-origin.ts` (`server-only`, supplies `process.env` and headers).
  Two files, one implementation; the split is what makes the rules testable.
- `events-dashboard.tsx`'s `statusLabel`/`statusTone` versus
  `progressPresentation`. They disagree **on purpose** — the dashboard says
  "Complete" where the people screens say "Budget reached", and tones over
  budget as `warning` rather than `danger`. Its own comment says so.
- `StatusBadge` in `family-access-client.tsx` and `payment-log-screen.tsx`:
  same name, different status vocabularies, different domains.
- Every `ui/index.tsx` ↔ `ui/<primitive>.tsx` same-name pair (`Button`, `Card`,
  `Input`, `Sheet`, `Skeleton`, `Textarea`, `Badge`, `Popover`). This is Q16's
  architecture: the product wrapper over the registry component.

**Accepted, not worth consolidating:** `pad(value)` — one line
(`String(value).padStart(2, "0")`) in both `lib/birthdays.ts` and
`lib/uk-occasions.ts`. Sharing it would couple two unrelated domain modules to
save one line.

**False positives:** the `GET`/`POST`/`PUT` route-handler exports. Framework
entry points that must share a name.

---

## 5. Routes and redirects — all four shims stay, and `/owed` is not legacy

`/add-purchase`, `/more`, `/owed` and `/payment-log` are one-line compatibility
pages over the shared `redirectLegacyRoute(section)`, which resolves the current
Area's Christmas and forwards into `/events/<id>/<section>`.

**`/owed` is not a legacy path at all, and Q14 understated it.** Q14 warned that
old notification rows might point there. They do — but so does the code running
right now: `lib/notification-content.ts` declares `OWED_URL = "/owed"` and uses
it as the `url` of **every money notification the app writes today** (nine call
sites), and `notification-audience.ts` writes the same literal. Removing that
page would break the tap target of every current and historic money
notification. It is a permanent route wearing a redirect's clothes.

The other three carry no reference from current code. They also cannot be proved
harmless to remove: whether a persisted `notifications.url` or an audit row
still holds `/more`, `/payment-log` or `/add-purchase` is a question about
production *data*, and this phase reads no production data. Each costs eight
lines and is covered by `event-isolation` and `event-routing`.
**All four kept.** Removing them is not a code question and should not be
answered as one.

---

## 6. The `*-taylor*` operator scripts — KEEP, and the Q14 unknown is now narrower

Q14 and Q15 recorded these as UNKNOWN-1/U-3 because static analysis cannot see a
human typing a command. It still cannot. But the repository says more about them
than "no importer":

- `set-taylor-password.mjs` **refuses to run without an interactive TTY**
  (`if (!process.stdin.isTTY || !process.stdout.isTTY) throw`). A script that
  demands a terminal is written to be typed, not scheduled.
- `admin-account-target.mjs` was **generalised after it was written**: the email
  was hard-coded in both scripts and became `--email=` / `ADMIN_EMAIL`, with no
  default and an explicit refusal to guess, "because these scripts create and
  modify real accounts against the production service-role key". Nobody
  parameterises a script they have stopped running.
- Nothing supersedes them. They are the only path in the repository that links
  an Auth user to an `app_members` row or resets that account's password
  without the email flow — the recovery route if the family's admin is locked
  out. `setup-taylor.mjs` also has a read-only `--verify-only` mode.
- They are absent from `package.json`, both GitHub workflows, and every test.

**Classification: `MANUAL-USE UNKNOWN` — and kept.** The evidence points at
live, deliberately-maintained operator tooling rather than residue.

**What the user would need to confirm to close this:** simply whether they have
run `node scripts/setup-taylor.mjs` or `node scripts/set-taylor-password.mjs`
by hand since the family went live, and whether they would want that recovery
path if they were locked out of the admin account. A "no" to both is what would
make deletion safe; nothing in the repository can supply it.

---

## 7. Assets and styles — five starter SVGs gone, one near-miss

**Removed:** `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`,
`window.svg`. `create-next-app` starter artwork. Searched across `src/`,
`public/`, `scripts/`, every config file, `sw.js`, `_headers`,
`manifest.ts` and the whole docs tree: **the only mentions anywhere are the two
audit documents recording that they are unreferenced.** `pwa-assets.test.mjs`
enumerates the icons it needs by name and never touches them, and it still
passes.

**Kept:** all five `-v2` PWA icons, `app-logo.png` (the master artwork the icon
generator reads and the test verifies), `favicon.ico`, `icon.png`,
`apple-icon.png`, `offline.html`, `_headers`, `sw.js`.

**The near-miss.** A CSS sweep flagged `.garland-bulb-berry`, `-gold`, `-green`
and `-warm` as defined-but-unreferenced. They are live:
`festive/garland.tsx:53` builds the class as
`` `garland-bulb-${bulb.tone}` ``. Deleting them would have put the Christmas
garland's bulbs on screen unstyled. Kept, and recorded here as the reason a
CSS orphan sweep is not a delete list.

Apart from `.burst-speck` and `@keyframes burst` — removed in §3 with the
component they served — **`globals.css` has no orphan rule or keyframe.** The
sixty-odd `--color-*` / `--radius-*` / `--font-*` tokens the sweep also flagged
are Tailwind v4 `@theme` declarations: they are consumed by generated utility
classes (`bg-accent`, `text-ink-700`), not by `var()`, so "never read" is the
tool being wrong, not the tokens being dead.

---

## 8. Dependencies — every direct dependency is used. Nothing removed.

Import counting alone was not trusted; each package was traced to the thing that
actually needs it.

| Package | Used by |
| ------- | ------- |
| `@opennextjs/cloudflare` | `open-next.config.ts`; the `preview`/`deploy`/`upload` scripts |
| `@supabase/ssr` | `utils/supabase/client.ts`, `server.ts` |
| `@supabase/supabase-js` | route handlers, both operator scripts |
| `class-variance-authority` | `ui/alert.tsx`, `badge.tsx`, `button.tsx`, `card.tsx` |
| `clsx` + `tailwind-merge` | `lib/cn.ts`, the shadcn `cn` helper |
| `lucide-react` | `icons.tsx` and 23 other files |
| `next` / `react` / `react-dom` | throughout |
| `next-themes` | `components/theme-provider.tsx` |
| `radix-ui` | the 11 files in `components/ui/` |
| `@electric-sql/pglite` | `scripts/pg/rehearsal.mjs` — the migration replay every DB test runs on |
| `@tailwindcss/postcss` | `postcss.config.mjs` |
| `tailwindcss` | `@import "tailwindcss"` at the top of `globals.css` |
| `esbuild` | `scripts/dom/tsx-hook.mjs` (JSX for `node --test`), `theme-bootstrap.test.mjs` |
| `eslint` + `eslint-config-next` | `eslint.config.mjs`, `lint-gate.test.mjs` |
| `jsdom` | `scripts/dom/harness.mjs` |
| `sharp` | `generate-pwa-icons.mjs`, and `pwa-assets.test.mjs` measures the icons with it |
| `typescript`, `@types/node`, `@types/react`, `@types/react-dom` | the `tsc --noEmit` gate and the build's TypeScript step |
| `wrangler` | `check:worker-bundle`, `cf-typegen`, and `wrangler.jsonc`'s `$schema` |

**All 12 dependencies and all 13 devDependencies are used. Q14's finding holds
after Q16's and Q17's removals** — deleting eight `lucide-react` glyph imports
did not make the package unused, and removing `inputClasses` did not orphan
`fieldClasses`, which the shadcn `Input`, `Textarea` and `NativeSelect` all wear.

---

## 9. Lockfiles — both kept, and this is a question for the user

Both `package-lock.json` (536 KB) and `pnpm-lock.yaml` (364 KB) are committed,
generated two minutes apart, and CURRENT-STATE already records that they resolve
identically.

What the repository can prove:

- `package.json` has **no `packageManager` field**, so nothing in the repo
  declares a winner.
- **Neither GitHub workflow installs node modules.** `birthday-reminders.yml`
  and `database-backup.yml` are cron jobs against Supabase; no CI job would
  notice either lockfile disappearing.
- **npm is what installed this working copy** — `node_modules/.package-lock.json`
  is present and pnpm's `node_modules/.modules.yaml` is not.

What it cannot prove: **what Cloudflare Workers Builds does.** Production is
built by Cloudflare's Git integration, whose package-manager detection is
configured in its dashboard, not in this repository. With both lockfiles present
its choice is not visible from here, and deleting the one it happens to use
would change how production installs on the very next push — with no staging
environment to find out on.

**Both kept.** To close this, the user needs to read the install command /
detected package manager in the Cloudflare Workers Builds settings for
`xmasapp`. If it is npm, `pnpm-lock.yaml` can go; if pnpm, `package-lock.json`
can. Whichever survives, a clean install and build should be run before the
other is deleted.

---

## 10. The real finding — four mutations that were testing nothing

Q15 left a rule behind, quoted in Q17's own brief:

> A mutation aimed at an implementation overwritten later is testing nothing.

Q16 applied it to one mutation. **Nobody had applied it to all of them.** This
phase did, mechanically: the `MUTATIONS` array was evaluated rather than parsed,
all 141 entries recovered, the 67 that edit a migration located inside the
`create or replace function` block they fall in, and each of those function
names checked against every later migration for a redefinition or a drop.

**Four mutations were editing definitions that a later migration overwrites:**

| Mutation | Edited | Redefined by |
| -------- | ------ | ------------ |
| `Q2-3. the sole administrator is allowed to walk out` | 042's `leave_area` | **045** |
| `Q3-3. the contributor routine goes back to asking about the ACTING Area` | 044's `set_family_contributor` | **047** |
| `Q3-4. archiving a person stops checking which family they are in` | 044's `set_person_archived` | **047** |
| `Q3-5. renaming a person stops checking which family they are in` | 044's `set_person_name` | **047** |

Run individually, all four reported `caught by: the migration REFUSED TO APPLY`.
The defect never reached the installed schema; what noticed was the migration's
own apply-time text check. By this project's own rule that is not a kill.

**All four were re-pointed at the definition that is actually installed**, the
way Q16 re-pointed mutation 9 and Q6 re-pointed Q3-6. The defect each expresses
is unchanged — `Q2-3` still deletes the "hand this family over first" guard;
`Q3-3/4/5` still swap the target-Area admin question for the acting-Area
`is_app_admin()`, which is the exact hole migration 044 was written to close.
Each now dies against a real request:

| Mutation | Was | Now caught by |
| -------- | --- | ------------- |
| `Q2-3` | migration refused to apply | ✖ `THE ADMINISTRATOR MAY NOT, and is told what to do instead` |
| `Q3-3` | migration refused to apply | ✖ `CONTRIBUTOR: refused across the Area boundary` |
| `Q3-4` | migration refused to apply | ✖ `ARCHIVE: refused across the Area boundary` |
| `Q3-5` | migration refused to apply | ✖ `RENAME: refused across the Area boundary` |

They remain distinct from `Q6-6/7/8`, which edit the same three routines in 047
but remove `is_acting_area(target_area)` and leave the target-Area question in
place. Two different properties, two different failing tests.

**Re-run of the whole audit after the fix: zero mutations target a superseded
definition.**

### The 15 that still die at apply time are a different thing

126 of 141 mutations are now killed by a named failing test, up from 122. The
other 15 are killed by a migration's own end-state block — but every one of them
now edits an **effective** object, and the block that catches it is querying the
resulting schema (`policy "…" no longer hides the reader`,
`public.save_purchase(…) went missing`, `every table, every browser role`), not
comparing text against itself. A schema-state assertion on the installed object
is a real check. The four that were removed were not: they compared a migration
against its own source while the schema went on unchanged.

---

## 11. Tests, fixtures and the service worker

**No test, helper or fixture was removed.** Every suite in `scripts/` runs under
`test:all`'s glob even when it has no dedicated `test:*` script
(`financial-planning`, `gift-idea-lifecycle`); the five DOM stubs are reached
through the `STUBS` map; `pg/fixtures.mjs`, `pg/rehearsal.mjs`, `qa/protected.mjs`
and `qa/fingerprint.mjs` all have importers. Test count is unchanged at 1,725.

**One obsolete assertion is recorded and kept.**
`birthday-wishlist.test.mjs:194–199` asserts the body of
`is_family_contributor_member` in migration 039 — a routine **migration 051
dropped**. It reads immutable migration text so it cannot fail, and the property
it guarded is now held far more strongly by `table-privileges.test.mjs`, which
asserts the routine is gone and that `select public.is_family_contributor_member()`
no longer resolves. Removing it would reduce the test count without removing a
risk, which rule 14 forbids; it is documented here instead. The same is true of
the `is_family_contributor_member` references in `rls-security.test.mjs` — they
assert what migrations 026/031 did, which is history, not current behaviour.

**Service worker and PWA: no defect, nothing changed.** `sw.js` was read end to
end. `CACHE_VERSION` is `v2` and the comment explains what `v1` held and why it
had to be dropped. Both notification icons are the `-v2` paths and both exist —
`pwa-assets.test.mjs` re-derives that list from the worker's own source and
checks each file is on disk. Nothing references a retired icon or a retired
brand name. There is one install branch, one activate branch, one offline
fallback and no duplicate of any of them. The `/offline.html` → `/offline`
behaviour is handled deliberately (`cache.put` with a re-wrapped body rather
than `cache.add`, because Cloudflare's 307 would otherwise store a `redirected`
response that `respondWith` rejects) and `_headers` sets `no-cache` on both
paths for the same reason. **Documented, pre-existing, correct — not touched.**

---

## 12. Removal manifest

| Item | Category | Evidence | Risk | Confidence | Action |
| ---- | -------- | -------- | ---- | ---------- | ------ |
| 5 starter SVGs | asset | zero references in source, CSS, config, manifest, `sw.js`, `_headers`, docs | none | HIGH | **removed** |
| `GiftCompleteBurst` | dead component | no importer; `git log -S` finds no render, ever | none | HIGH | **removed** |
| `.burst-speck`, `@keyframes burst` | orphan CSS | existed only for the above | none | HIGH | **removed** |
| `inputClasses` | compatibility alias | zero consumers; its own comment names a set that is now empty | none | HIGH | **removed** |
| `isUuid`, `hasDisallowedControlCharacters` | dead exports | wrappers over used functions; never called or tested | none | HIGH | **removed** |
| `purchaseStatusLabel` | superseded | three screens have their own vocabularies | none | HIGH | **removed** |
| `nextBirthdayFor` | dead export | one-line wrapper, no consumer | none | HIGH | **removed** |
| 8 `Icon*` glyphs | dead exports | one occurrence each, the declaration | none | HIGH | **removed** |
| `Q2-3`, `Q3-3`, `Q3-4`, `Q3-5` | mutations on superseded definitions | each re-run and observed dying at apply time | test-only | HIGH | **re-pointed and re-proved** |
| `/owed` shim | route | current code writes `"/owed"` into every money notification | breaks live notifications | — | **keep** |
| `/more`, `/payment-log`, `/add-purchase` shims | routes | no current writer, but persisted rows unreadable from here | breaks old links | MEDIUM | **keep** |
| 3 `*-taylor*` scripts | operator tooling | TTY-gated, parameterised after the fact, unsuperseded | locks out account recovery | MEDIUM | **keep** |
| one of two lockfiles | build state | canonical manager not declared anywhere in the repo | changes production install | LOW | **keep both** |
| `priceInput` ×4, `progressPresentation` ×2, `todayInput` ×2 | live duplicates | identical normalised bodies | needs a home decision | — | **Q18** |
| `birthday-wishlist.test.mjs:194` | obsolete assertion | targets a routine 051 dropped | reduces count, removes no risk | — | **keep** |

---

## 13. Gates

| Gate | Result |
| ---- | ------ |
| TypeScript `tsc --noEmit` | clean |
| ESLint | clean |
| Full regression | **1,725 / 1,725**, 223 suites, 0 failures |
| Mutations | **141 / 141 caught**, zero survivors; **126 behavioural** (was 122), 15 schema-state |
| Superseded mutation targets | **0 of 67** (was 4) |
| Production build | clean, 31 page routes + 13 handlers |
| `check:worker-bundle` | clean |
| `git diff --check` | clean |
| Database | **untouched. Migrations still 001–051.** |

Net: **13 files, 61 insertions, 132 deletions**, five files deleted. Most of the
insertions are the comments explaining the four re-pointed mutations, so the
shipped-code reduction is larger than the line count suggests.

---

## 14. Live QA — Worker `fa57b868`, Edge, read-only

Deployed by Cloudflare from `8195581`, which carried Q16's held docs commit.

Seven screens — home, People, Birthdays, Events, Activity, Settings,
Notifications — at **desktop 1440×900** and at a genuine **390×844, DPR 3,
`mobile: true`, `maxTouchPoints` 5, coarse pointer** (CDP
`Emulation.setDeviceMetricsOverride`, not a narrowed window).

| Check | Desktop | Mobile |
| ----- | ------- | ------ |
| HTTP status, all seven | 200 | 200 |
| Horizontal overflow | none | none |
| `h1` per screen | 1 | 1 |
| Broken images | 0 | 0 |
| HTTP responses ≥ 400 while browsing | **0** | **0** |

The only failed requests at either width are `net::ERR_ABORTED` on Next's
`?_rsc=` prefetches — a navigation cancelling a prefetch the previous screen
started, which a seven-hop script produces by construction.

**Assets.** The manifest is "Gift Planner", `id`/`start_url`/`scope` all `/`,
**all four icons 200**; `favicon.ico`, `icon.png`, `apple-icon.png`, `sw.js` and
`/offline` all 200. The five deleted SVGs return **404 and nothing asks for
them** — the single console 404 at each width is the probe that requested one
deliberately.

**Protected fingerprint, after all QA:** notifications **37**, people **19**,
events **15**, appMembers **4**, recipients **35**, Christmas 2026 active with
**19** recipients, `crossAreaTotal` **0**. Identical to the baseline; every
check was a read.
