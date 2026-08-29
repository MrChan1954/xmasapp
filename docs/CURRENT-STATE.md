# Current State

**Last updated:** 2026-08-29, at the end of the Claude Code usage-optimisation
pass that followed Q8.

This file is the handoff between phases. Update it at the end of every phase and
keep it short — it is meant to be read in full at the start of the next session.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Last completed phase | **Q8** |
| Q8 verdict | `Q8 PASS — READY FOR Q9` |
| Next phase | **Q9 — not started** |
| App commit | `e3dbb6a9a4341ef26b75810757f9336c8c35718e` ("Run the notification jobs, instead of reading them") |
| Branch | `main`, clean. **One local commit ahead of `origin/main`** — see below. |
| Serving Worker version | `6409c9a2-b68b-4ca0-987e-5c937ff3ab9a` |
| Migrations applied | **001–047**, immutable. No 048 exists. |
| Live site | `xmas-family.uk` |

## What the last phases established

- **Q6** — migration 047 (`area_scoped_person_routines`) applied; post-apply
  checks 17/17. Editing a person now asks which family you are standing in.
- **Q6 (fix)** — the pre-hydration theme bootstrap. Wrangler's esbuild
  `keep_names` injected `__name(...)` into `next-themes`' *serialised* script,
  throwing `ReferenceError: __name is not defined` on every page load. Fixed by
  `keep_names: false` in `wrangler.jsonc`. **Do not turn it back on.**
- **Q7** — settlement lifecycle proven against a real PostgreSQL.
- **Q8** — notification jobs are *run*, not merely read. The bell is
  **account-global** (it spans every Area the account belongs to) which is
  correct; fanout stays Area-scoped. The **8 protected notification rows are the
  historic Q4 leak — keep them.** The fanout defect itself is fixed and was
  re-proven live.

## Known, accepted state

- The bell spanning Areas is intended behaviour, not a leak.
- The 8 protected notification rows are historic evidence and must not be
  cleaned up.
- `rls_auto_enable` is a Supabase platform event-trigger function that no
  migration creates. It is benign. **Do not drop or adopt it.**

## Unpushed local commit

The commit "Stop noisy command output from filling the conversation" — docs and
Claude tooling only; no file under `src/`, `supabase/`, `public/` or any build
config is touched, and `next build` output is byte-identical before and after
(same 48 routes, same static/dynamic markers).

**Deliberately not pushed.** Pushing `main` triggers a Cloudflare Workers Build,
which would replace the serving Worker with a new version id for a functionally
identical Worker. Held so the recorded version above stays accurate. Push it
whenever convenient — bundling it with Q9's first real commit is fine.

## Tooling state (added in the usage-optimisation pass)

- `.claude/settings.json` registers a `PreToolUse` hook,
  `.claude/hooks/quiet-command.mjs`, which wraps noisy commands (installs,
  production builds, long test runs, mutation runs, linters). Full raw output
  goes to `.claude/logs/` (git-ignored); only failures, warnings and the final
  summary reach the conversation. It fails open and never touches destructive,
  database, deploy or git-writing commands.
- `docs/PROJECT-CONSTITUTION.md`, `docs/SECURITY-INVARIANTS.md`,
  `docs/QA-RULES.md`, `docs/PHASE-GATES.md` and this file replace the long
  preamble that phase prompts used to repeat.

## Starting Q9

In a **fresh** Claude session:

> Read `docs/PROJECT-CONSTITUTION.md`, `docs/SECURITY-INVARIANTS.md`,
> `docs/QA-RULES.md`, `docs/CURRENT-STATE.md` and `docs/PHASE-GATES.md`, then
> execute this phase. \<phase prompt\>

## Open risks

- Nothing blocking Q9.
- Pushing `main` auto-deploys. Any Q9 change reaching `main` is live within
  minutes.
