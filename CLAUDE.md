@AGENTS.md

# Family Gift Planner

A private gift-and-occasion planner used by one real family. Production data is
real. There is no staging environment.

## Always true

- **Pushing `main` auto-deploys production** (Cloudflare Workers Builds). Never
  push work that has not passed its gates.
- **Migrations are immutable.** `supabase/migrations/` is append-only; 001–047
  are applied. Fix forward with a new migration.
- **Money is integer pennies**, never floats.
- **Area scoping is the security boundary.** Every read and write is scoped to
  the Area the user is acting in. Service-role code bypasses both RLS and the
  write barrier, so it must carry its own Area filter.
- **The birthday person must never learn what they are getting** — they see only
  their own wishlist.
- **Protected production data is never written by QA.** QA Areas are listed in
  `.qa-areas.local.json`, which is never committed.

## Running noisy commands

Builds, installs, full test runs, mutation runs and linters are wrapped by a
`PreToolUse` hook so their output does not flood the conversation. **Run them
bare** — on their own, not chained with `&&` or `;` and not piped. The hook
deliberately leaves composite, piped and redirected commands alone, so chaining
one defeats it and the full output lands in context.

## Before starting a phase

Read these first — they replace the long preamble phase prompts used to repeat:

`docs/PROJECT-CONSTITUTION.md`, `docs/SECURITY-INVARIANTS.md`,
`docs/QA-RULES.md`, `docs/CURRENT-STATE.md`, `docs/PHASE-GATES.md`.

Phase-specific instructions come from the prompt the user supplies. Run the gates
in `docs/PHASE-GATES.md`; report using `docs/PHASE-REPORT-TEMPLATE.md`.

## At the end of a phase

Update `docs/CURRENT-STATE.md`, give the verdict, then **stop** and tell the user
to clear the conversation. The next phase starts in a fresh session. Never
continue into the next phase in the same conversation.
