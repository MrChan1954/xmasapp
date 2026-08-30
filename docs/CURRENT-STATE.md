# Current State

**Last updated:** 2026-08-30, after the pre-Q10 context cleanup.

The handoff between phases. Current facts only — history lives in git.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Live site | `https://xmas-family.uk/` |
| Last completed phase | **Q9** |
| Q9 verdict | `Q9 PASS — READY FOR Q10` |
| Next phase | **Q10 — not started** |
| Branch | `main` |
| Local HEAD | the context-cleanup commit, on top of `73c1c8f` (Q9 closeout) |
| origin/main | `846faca` — the latest **pushed runtime** commit |
| Ahead of origin | 2 commits, **docs/tooling only**, deliberately unpushed |
| Serving Worker | `f8f136f0-208b-48ca-8299-816b0e0b41e9` |
| Migrations applied | **001–047**, immutable. No 048 exists; Q9 needed none. |

Pushing `main` auto-deploys production through Cloudflare Workers Builds, so the
two local commits are held back: a docs-only push would trigger a pointless
Worker build. **The first legitimate Q10 runtime push should carry them.**

## Verification state

- Q1–Q9 complete. Q9 passed every gate: focused tests, full regression, mutation
  suite, TypeScript, ESLint, production build and worker bundle.
- The regression suite was last reported at roughly **1,595 tests, all passing**
  at the Q9 final gate. This cleanup pass did **not** re-run it — it changed only
  documentation and Claude tooling — so treat that as last-known, not re-proven.
- **Cross-Area integrity = 0**, confirmed at the Q9 post-QA fingerprint.

## Protected baseline

| Field | Value |
| ----- | ----- |
| `realFamilyNotifications` | **37** (includes the historic 8 leaked Q4 rows) |
| `people` / `appMembers` | **19 / 4** |
| Christmas 2026 | active, 19 recipients |
| `crossAreaTotal` | **0** |

`events` and `recipients` moved during Q9 (14→15 and 34→35). That was **not QA**:
`audit_log` attributes the writes to the family's everyday account in ordinary
use. QA made no writes. Take the pre-deploy fingerprint as close to deployment as
possible, and expect these two to drift if the family is awake.

## Accepted state and open risks

- Nothing blocking Q10.
- The notification bell spanning Areas is intended, not a leak. The 8 protected
  notification rows are historic evidence; do not clean them up.
- `rls_auto_enable` is a Supabase platform event-trigger function that no
  migration creates. Benign — **do not drop or adopt it**.
- **Recovery from a lost `gp_area` cookie is deterministic, not a prompt.**
  `ensureAreaChosen` picks `resolveActiveArea` — live families before archived,
  then alphabetically — and writes it. For an account in several families that
  means landing in whichever sorts first, which for the QA account is the real
  family. Decided in Q2 (the alternative locked people out) and unchanged.
  Nothing is *written* under a guessed Area: `getCurrentMember` still refuses to
  resolve a membership when there are several and no cookie matches.
- **`no-store` on documents means every back/forward navigation refetches.** That
  is the intended trade — correctness over a saved round trip — but it changes how
  the app feels on a slow connection. Q10 should look at it with fresh eyes.
- Two output-reduction hooks are active: the project's
  `.claude/hooks/quiet-command.mjs` and a global one outside this repo. The
  project hook wins. Harmless, but worth knowing if wrapping behaves oddly.

## Starting Q10

In a **fresh** Claude session (Opus 5, High):

> Read `CLAUDE.md` (loaded automatically) and `docs/CURRENT-STATE.md`. Read
> `docs/SECURITY-AND-QA.md` if this phase touches security, data or live QA.
> Then execute this phase. \<phase prompt\>
