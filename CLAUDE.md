# Gift Planner

A private gift-and-occasion planner used by one real family. Next.js (App
Router) / TypeScript / Supabase Postgres / Cloudflare Workers via OpenNext
(worker `xmasapp`). Live at `https://xmas-family.uk/`. **Production data is
real and there is no staging environment.**

This Next.js differs from training data. Before changing framework-specific
behaviour, consult the installed docs in `node_modules/next/dist/docs/`.

## Security invariants

Break one and the phase fails, whatever else it achieved. Reasoning lives in
`docs/SECURITY-AND-QA.md`.

- The **selected/acting Area** is authoritative for every read and write.
- Membership in another Area does **not** authorize acting there.
- UI hiding is **never** authorization; the database must refuse on its own.
- `SECURITY DEFINER` routines bypass RLS — they need trusted Area derivation and
  acting-Area protection.
- **Birthday self-privacy beats Admin.**
- Own-birthday secret financial/gift data must not leak through reads, routes,
  notifications or browser payloads.
- Service-role code must authenticate, authorize and **explicitly scope** — it
  bypasses both RLS and the write barrier.
- Cross-Area integrity must remain **zero**.

## Financial and domain invariants

- Money is **integer pennies**, never floats. `formatPennies` throws on a
  non-safe-integer, and that throw is a feature. GBP.
- Recipient budgets are **targets, not caps**.
- `people.is_family_contributor` is contributor truth.
- Purchase allocations are **immutable historical snapshots**.
- Contributor changes affect **future** purchases only.
- Owed = gross outgoing outstanding debt. Pending and rejected payments do not
  reduce Owed. **Receiver confirmation is authoritative.**
- Receipts and history stay auditable and append-only where designed.

## Production safety

- `Our family` and Christmas 2026 are **real data**.
- Browser and database QA must not mutate protected real-family data. QA
  mutations happen only in QA Areas (`.qa-areas.local.json`, never committed).
- The protected notification baseline includes the historic **8 leaked rows**.
  Do not run cleanup without explicit approval.
- Live browser QA uses `xmas-family.uk` — never localhost as user-facing
  evidence. Browser is **Microsoft Edge**; genuine mobile QA uses Edge + CDP
  emulation.

## Migrations

- Applied migrations are **immutable**; `supabase/migrations/` is append-only.
- Applied range: **001–052**.
- If a new migration seems genuinely needed, **STOP for explicit user review**
  before writing or applying it, unless the phase prompt says otherwise.
- Production migrations are applied **manually**.
- Runtime code depending on a migration must not reach auto-deploy before the
  database is ready.

## Git and deployment

- Pushing `main` **auto-deploys production** through Cloudflare Workers Builds.
- Do not also run a manual deploy after a normal `main` push.
- Docs/tooling-only local commits may be held back, so a push does not trigger a
  pointless production build.
- Never stage env files, profiles, build artifacts or secrets.

## Testing and QA gates

- Focused tests while implementing; **full regression once** at the final gate;
  **mutation suite once** at the final gate.
- A mutation must be killed by an intended **behavioural** test — a checksum or
  build-only failure is not a kill. A survivor is a finding, not a pass.
- Final gates: TypeScript (`npx tsc --noEmit`), ESLint, production build,
  `npm run check:worker-bundle`, `git diff --check`.
- Noisy commands are wrapped by a `PreToolUse` hook. **Run them bare** — not
  chained with `&&` or `;`, not piped, not redirected; the hook deliberately
  skips composite commands, so chaining defeats it. Open the full log only to
  diagnose a failure.

## Model and effort

- Default fresh coding session: **Claude Opus 5 + High**.
- xhigh / Extra High is exceptional, not the default. Cheaper or lower models are
  likewise exceptional.
- **Never recommend changing model or effort mid-session.** Such changes may be
  raised only after `/clear`, at a fresh-session boundary.
- If no change is needed, say exactly: `Keep Opus 5 High. No change needed.`

## Fresh-session workflow

At the end of every major task or phase:

1. Finish the fixes and migrations.
2. Obtain the final PASS verdict.
3. Update `docs/CURRENT-STATE.md`.
4. **STOP.**
5. Tell the user to `/clear`.
6. Only after the clear, discuss model/effort for the next session.
7. The next phase starts in a fresh session.

**Never continue into the next phase in the same conversation.** Cost per turn
scales with accumulated context, not with the work in it.

## Phase start

Read `docs/CURRENT-STATE.md`, plus `docs/SECURITY-AND-QA.md` when the phase
genuinely touches security, data or live QA. Then follow the phase prompt.

## Report format

End a phase with these sections, a few lines each — not an implementation story:

Verdict; start/final commit; migration status; key implementation and security
findings; focused tests; full regression; mutations; TypeScript/ESLint/build;
deployment; desktop QA; mobile QA; protected fingerprint; cross-Area integrity;
remaining risks; clear-chat instruction.

Verdict is exactly one of `Q<n> PASS — READY FOR Q<n+1>`, `Q<n> NEEDS FIX`, or
`Q<n> BLOCKED`. Do not soften it; a gate that was not run is not a pass. The
final line is `CLEAR THIS CLAUDE CHAT NOW. START Q<n+1> IN A FRESH SESSION.`

## Where else to look

| You want | Look in |
| -------- | ------- |
| What is deployed right now, and what is next | `docs/CURRENT-STATE.md` |
| Security reasoning, QA rules, fingerprints, mobile QA | `docs/SECURITY-AND-QA.md` |
| UI registry and component conventions | `docs/SHADCN-UI.md` |
| Backup operations | `docs/database-backups.md` |
| That runbook | `docs/removing-an-empty-event.md` |
| Post-apply verification for a migration | `docs/Q*-POST-APPLY-CHECKS.sql` |
