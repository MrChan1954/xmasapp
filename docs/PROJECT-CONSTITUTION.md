# Project Constitution — Family Gift Planner

The durable facts about this project. Read this first in any new session.
Nothing here is phase-specific; if a statement here stops being true, change it
here rather than restating it in a prompt.

## What this is

A private gift-and-occasion planner used by one real family. It tracks people,
events (Christmas and birthdays), gift ideas, purchases, contributions and who
owes whom. It is not a demo. Every row in production is real family data.

## Stack

| Layer      | Choice |
| ---------- | ------ |
| App        | Next.js (App Router). **This Next.js differs from training data — read `node_modules/next/dist/docs/` before writing framework code.** |
| Runtime    | Cloudflare Workers via OpenNext (`.open-next/worker.js`, worker name `xmasapp`) |
| Database   | Supabase Postgres, with row level security throughout |
| UI         | shadcn/ui — see `docs/SHADCN-UI.md` |
| Tests      | `node --test` (67 test files across `scripts/`, `scripts/qa/`, `src/lib/`) |
| Live site  | `xmas-family.uk` |

## The rules that do not change

1. **Pushing `main` auto-deploys production.** Cloudflare Workers Builds is wired
   to the repo. There is no separate release step and no staging environment. A
   commit that lands on `main` is in front of the family within minutes. Never
   push work that has not passed its gates.

2. **Migrations are immutable.** `supabase/migrations/` is append-only. A
   migration that has been applied is never edited, renumbered or deleted — it is
   corrected by a new one. Applied set: **001–047**.

3. **Money is integer pennies.** Never floats. `formatPennies` throws on a
   non-integer, and that throw is a feature. Currency formatting is GBP.

4. **Production data is protected.** QA runs in synthetic Areas inside the same
   database as the real family. The real Area id lives in `.qa-areas.local.json`,
   which is never committed. See `docs/QA-RULES.md`.

5. **Area scoping is the security boundary.** Every read and write is scoped to
   the Area the user is acting in. See `docs/SECURITY-INVARIANTS.md`.

6. **The birthday person must not learn what they are getting.** See
   `docs/SECURITY-INVARIANTS.md`.

## Where things live

| You want | Look in |
| -------- | ------- |
| Security rules that must never regress | `docs/SECURITY-INVARIANTS.md` |
| What QA may and may not touch | `docs/QA-RULES.md` |
| What is deployed right now | `docs/CURRENT-STATE.md` |
| What a phase must pass before it ends | `docs/PHASE-GATES.md` |
| Post-apply SQL checks per phase | `docs/Q*-POST-APPLY-CHECKS.sql` |
| Backup policy | `docs/database-backups.md` |
| UI conventions | `docs/SHADCN-UI.md` |

## How work is organised

Work proceeds in numbered phases (Q1, Q2, …). Each phase is driven by a prompt
supplied by the user at the start of a **fresh** Claude Code session. The prompt
says what to build; these docs say what is always true. A phase ends with an
explicit verdict and a handoff written into `docs/CURRENT-STATE.md`.

**Do not carry one phase into the next in the same conversation.** See
`docs/PHASE-GATES.md` for the handoff rule and why it exists.

## Working style

- Read before writing. The migrations and `src/lib/*.ts` files carry long
  explanatory headers that say *why* a rule exists; they are the real spec.
- Prefer a new migration over editing schema by hand.
- Never weaken a test to make it pass.
- Never disable a lint rule to make a build succeed.
- Noisy commands (installs, builds, full test runs, mutation runs, linters) are
  wrapped automatically by a hook so their output does not flood the
  conversation — the complete log path is printed with every result. See
  `.claude/hooks/quiet-command.mjs`.
- **Run a noisy command bare.** The hook leaves composite, piped and redirected
  commands alone on purpose, so `npm run test:all` is wrapped but
  `echo x && npm run test:all` is not, and its full output lands in context.
  Do not hand-pipe to `| tail` any more; the hook does it better and keeps the
  failures.
