# Current State

**Last updated:** 2026-08-30, at the end of Q9 (settings, navigation, mobile, PWA).

This file is the handoff between phases. Update it at the end of every phase and
keep it short — it is meant to be read in full at the start of the next session.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Last completed phase | **Q9** |
| Q9 verdict | `Q9 PASS — READY FOR Q10` |
| Next phase | **Q10 — not started** |
| App commit | `1f1d559a2bb2a0bd995aea0ff3005a355512582f` ("Stop a switched-away family coming back on the Back button") |
| Branch | `main`, clean, pushed. |
| Serving Worker version | `5b3ce060-ba95-4618-9a00-07ec036c076e` |
| Migrations applied | **001–047**, immutable. No 048 exists, and Q9 needed none. |
| Live site | `xmas-family.uk` |

## What the last phases established

- **Q6** — migration 047 (`area_scoped_person_routines`) applied; post-apply
  checks 17/17. Editing a person now asks which family you are standing in.
- **Q6 (fix)** — the pre-hydration theme bootstrap. Wrangler's esbuild
  `keep_names` injected `__name(...)` into `next-themes`' *serialised* script.
  Fixed by `keep_names: false` in `wrangler.jsonc`. **Do not turn it back on.**
- **Q7** — settlement lifecycle proven against a real PostgreSQL.
- **Q8** — notification jobs are *run*, not merely read. The bell is
  **account-global** (it spans every Area the account belongs to) which is
  correct; fanout stays Area-scoped. The **8 protected notification rows are the
  historic Q4 leak — keep them.**
- **Q9** — the shell. Four defects, all found by measuring the deployed site:

  1. **Documents were storable.** Every rendered page is `force-dynamic`,
     personalised and Area-scoped, and every one came back `Cache-Control:
     no-cache` with **no ETag, no Last-Modified, and a `Vary` that did not list
     `Cookie`**. With no validator there is nothing to revalidate with, so a
     history navigation reused the stored copy outright. Switching family and
     pressing Back put the previous family's event back on screen — named and
     dated — while the server, asked directly, returned 404. Documents are
     **`no-store`** now, which also keeps them out of the back/forward cache.
     Hashed build output, `/sw.js`, `/icons` and the manifest keep their own
     rules (verified against a real wrangler bundle and again live).
  2. **The sticky bar named the app, not the screen** on `/settings`,
     `/settings/family`, `/people`, `/birthdays` and `/areas/new`, and
     `/settings/family` had no way back up to `/settings`.
  3. **Family access and Activity breadcrumbed to the events dashboard**, though
     both are Area settings catalogued on `/settings/family`.
  4. **Archiving a whole family did not confirm**, while archiving one event
     did. It now uses the shared `ConfirmDialog`.

  Plus: the shadcn `Switch` was a 32×18 touch target; it keeps that appearance
  and gains a 44×44 hit area.

  `pageTitleFor` and the route-title table **moved from
  `src/app/components/nav-items.ts` to `src/lib/navigation.ts`** as part of the
  fix. In `nav-items` it could only be checked by matching a regex against the
  source, which cannot notice routes that were never added; next door it is a
  function the tests now call directly.

## Known, accepted state

- The bell spanning Areas is intended behaviour, not a leak.
- The 8 protected notification rows are historic evidence and must not be
  cleaned up.
- `rls_auto_enable` is a Supabase platform event-trigger function that no
  migration creates. It is benign. **Do not drop or adopt it.**
- **Recovery from a lost `gp_area` cookie is deterministic, not a prompt.**
  `ensureAreaChosen` picks `resolveActiveArea` — live families before archived,
  then alphabetically — and writes it. For an account in several families that
  means landing in whichever sorts first, which for the QA account is the real
  family. Decided in Q2 (the alternative locked people out) and unchanged.
  Nothing is *written* under a guessed Area: `getCurrentMember` still refuses to
  resolve a membership when there are several and no cookie matches.
- **Edge will not size a window below ~516px outer / 492px inner**, so browser
  QA measures the phone layout at 492 CSS px, not 390. Both the `sm` (640) and
  `lg` (1024) breakpoints are below that, so the phone layout is genuinely
  exercised; a 390px-only overflow would not be.

## Q9 fingerprint note — read before comparing counts

The protected fingerprint moved during Q9 and **it was not QA**:

| field | pre | post |
| ----- | --- | ---- |
| `realFamilyNotifications` | 37 | **37** |
| `people` / `appMembers` | 19 / 4 | **19 / 4** |
| Christmas 2026 | active, 19 recipients | **active, 19 recipients** |
| `crossAreaTotal` | 0 | **0** |
| `events` | 14 | 15 |
| `recipients` | 34 | 35 |

A birthday event, its recipient, its contributors and its contributions were
created in the real family at `2026-08-29T23:32:04Z`, with a contribution edit
41 seconds earlier. `audit_log` attributes all of it to actor `285861da…`,
which has **386 entries going back to 2026-08-12** — the family's everyday
account, in ordinary use. QA made **no writes at all** this phase: every browser
action was a navigation or a read, plus one confirmation dialog opened and
cancelled.

This is the expected consequence of QA running against the live app with no
staging environment. **Take the pre-deploy fingerprint as close to deployment as
possible**, and expect `events`/`recipients` to move if the family is awake.

## Tooling state

- `.claude/settings.json` registers a `PreToolUse` hook,
  `.claude/hooks/quiet-command.mjs`, which wraps noisy commands. Full raw output
  goes to `.claude/logs/` (git-ignored). Run noisy commands **bare**.
- The Q8 usage-optimisation commit `9e458f7` is now pushed, bundled with Q9.

## Starting Q10

In a **fresh** Claude session:

> Read `docs/PROJECT-CONSTITUTION.md`, `docs/SECURITY-INVARIANTS.md`,
> `docs/QA-RULES.md`, `docs/CURRENT-STATE.md` and `docs/PHASE-GATES.md`, then
> execute this phase. \<phase prompt\>

## Open risks

- Nothing blocking Q10.
- Pushing `main` auto-deploys. Any change reaching `main` is live within minutes.
- `no-store` on documents means every back/forward navigation refetches the
  page. That is the intended trade — correctness over a saved round trip — but
  it is a real change to how the app feels on a slow connection, and Q10's audit
  should look at it with fresh eyes.
