# Phase Gates

What a phase must pass before it may claim a verdict, and what must happen when
it does. These are the same for every phase.

## The gates

Run in this order. Do not skip a gate because "nothing there changed" — say so
explicitly in the report instead.

| # | Gate | Command |
| - | ---- | ------- |
| 1 | Focused tests for what changed | the relevant `npm run test:*` scripts |
| 2 | Full regression | `npm run test:all` |
| 3 | Mutation gate | `npm run test:mutations` — a surviving mutation is a hole in the tests |
| 4 | TypeScript | `npx tsc --noEmit` |
| 5 | ESLint | `npx eslint` |
| 6 | Production build | `npm run build` |
| 7 | Worker bundle | `npm run check:worker-bundle` |
| 8 | Pre-deploy fingerprint | `node scripts/qa/fingerprint.mjs` |
| 9 | Deploy, then desktop + mobile QA on `xmas-family.uk` | see `docs/QA-RULES.md` |
| 10 | Post-QA fingerprint, compared with #8 | protected counts must be unchanged |

Migrations, when a phase adds one:

- new numbered file in `supabase/migrations/`, never an edit to an applied one;
- post-apply checks written to `docs/Q<n>-POST-APPLY-CHECKS.sql`;
- all checks pass, and the pass count is quoted in the report.

## Verdict

A phase ends with exactly one line:

- `Q<n> PASS — READY FOR Q<n+1>`
- `Q<n> NEEDS FIX`
- `Q<n> BLOCKED`

Do not soften a verdict. A gate that was not run is not a pass; report it as
skipped and say why.

## The handoff rule — this is not optional

At the end of every completed phase:

1. Finish the fixes and migrations.
2. Obtain the final `PASS — READY FOR …` verdict.
3. Update `docs/CURRENT-STATE.md` with commit, Worker version, migration range,
   what was established and any accepted state.
4. **STOP.**
5. Tell the user to clear the Claude Code conversation.
6. The next phase starts in a **fresh** Claude session.
7. That session reads the five source-of-truth docs plus the new phase prompt.

**Never continue automatically into the next phase in the same conversation.**

### Why

Cost per turn is driven by the size of the conversation, not by the work in it.
Every turn re-reads the whole accumulated context. Measured on the Q8 session:
796 assistant turns, context growing to ~653,000 tokens, ~279M cumulative
cache-read tokens — the last tenth of the conversation cost more than the first
half. Carrying a finished phase forward pays that toll again on every turn of the
next one, for context that is no longer relevant.

A fresh session with these docs starts at a few thousand tokens instead of
hundreds of thousands, and loses nothing that was written down.

## Final line

When a phase passes, the last line of the report must be:

`CLEAR THIS CLAUDE CHAT NOW. START Q<n+1> IN A FRESH SESSION.`
