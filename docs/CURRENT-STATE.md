# Current State

**Last updated:** 2026-08-30, at the Q10 closeout.

The handoff between phases. Current facts only — history lives in git.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Live site | `https://xmas-family.uk/` |
| Last completed phase | **Q10 — hostile production readiness and security audit** |
| Q10 verdict | `Q10 PASS — PRODUCTION READINESS VERIFIED` |
| Next phase | **Q11 — not started** |
| Branch | `main` |
| Local HEAD | this closeout commit, on top of `c20b6bf` |
| origin/main | `c20b6bf` — the latest **pushed runtime** commit |
| Ahead of origin | 1 commit, **docs only**, deliberately unpushed |
| Serving Worker | `110b9e71-72d7-420c-9d68-69bcbcd6daa0` |
| Migrations applied | **001–048**, immutable. 048 is Q10's. |

The two pre-Q10 docs commits that Q9 held back were carried by Q10's first
runtime push, as planned. Q10's three runtime pushes each triggered one
automatic Cloudflare build; no manual deploy was run.

This closeout is held back for the same reason Q9's was: a docs-only push
would trigger a production Worker build for nothing. **Q11's first legitimate
runtime push should carry it.**

## Migration 048

`202608100048_revoke_area_helper_grants.sql` — a grant revoke and nothing else.
No table, policy, column or row was touched.

`area_of_record`, `area_of_written_row` and `audit_actor_name` are internal
`SECURITY DEFINER` helpers that had kept Supabase's blanket default grant, so
PostgREST served them as **anonymous** RPC endpoints. Proven against production
with only the publishable key: `area_of_record('events', <the real Christmas
2026 event id>)` returned the real family's Area id, with RLS never consulted.

Now refused `42501` for `anon` **and** `authenticated` — both halves verified
live, the second using a real member's own access token. `area_of_event`,
`area_of_recipient`, `area_of_purchase` and `area_of_gift_idea` deliberately
keep their grants: they are named in 21 RLS policy expressions and reads break
without them. `claim_active_area` stays anon-callable — it is PostgREST's
`db-pre-request` hook and sign-in fails without it.

Rollback, if ever needed, is one `grant execute … to anon, authenticated;`.

## Verification state

- Full regression **1,607 tests, all passing**.
- Mutations **124/124 caught, zero survivors, and now zero build-shaped kills** —
  102 by behavioural assertions, 22 by the database refusing to apply a
  mutated migration.
- TypeScript, ESLint, production build and worker bundle all clean.
- **Cross-Area integrity = 0** at both the pre-deploy and post-QA fingerprints.

## Protected baseline

| Field | Value |
| ----- | ----- |
| `realFamilyNotifications` | **37** (includes the historic 8 leaked Q4 rows) |
| `people` / `appMembers` | **19 / 4** |
| `events` / `recipients` | **15 / 35** |
| Christmas 2026 | active, 19 recipients |
| `crossAreaTotal` | **0** |

Identical at the Q10 baseline, pre-deploy and post-QA fingerprints. Q10 wrote
nothing to protected data: its browser QA was read-only, and the only thing it
ever wrote was the session's own Area cookie, restored afterwards.

## What Q10 fixed

- **The three anon-callable definer helpers** — migration 048, above.
- **`/more/activity` ignored the acting Area.** `audit_log`'s policy is
  `is_active_app_member() AND is_area_member(area_id)` — which families you
  *belong to*, not which one you are *standing in* — and the screen sent no
  Area of its own. For a login in one family those are the same sentence; for
  one in several they are not. Live QA, with the cookie asserted at each read,
  got the same 300 entries in the real family and in a QA Area, byte for byte.
  **Not a cross-tenant leak** — a member of one family alone still saw only
  that one — but the acting-Area rule is what the application rests on. Now 300
  entries in the real family, 8 in the QA Area, **0 shared**.
- **`readDeviceStatus` counted push devices across every family.** It is the
  admin client and `push_subscriptions` has no `area_id`, so nothing underneath
  scoped it. That disclosed a cross-family count *and* hid a true warning: the
  Notifications screen says "nobody else can receive these yet" only when the
  count is zero, so one device in another family suppressed it. Verified live:
  a QA Area now reports 0, the real family reports its own 2.
- **One long gift name widened every activity row.** Grid items do not shrink
  below min-content, so a single unbreakable run pushed all 300 rows from 358
  to 407px and scrolled the page sideways by 33px at 390px wide. `min-w-0` plus
  `break-words`; verified with the long name on screen.
- **The mutation gate scored a kill it had not earned.** `String.replace` reads
  `$$` in a replacement as an escaped dollar, so Q2-9's dollar-quoted SQL
  reached disk as `$;`, migration 034 failed to *parse*, and that counted as a
  kill. It reported 124/124 while one scenario had never run. The replacement
  is a function now, and Q2-9 is genuinely caught by a behavioural assertion.

## Accepted state and open risks

- Nothing blocking Q11.
- **The notification bell is deliberately account-global** and stays that way.
  The Activity screen was never meant to be and is now Area-scoped; if any
  other screen is ever meant to span families, document it there.
- The 8 protected notification rows are historic Q4 evidence. Do not clean up.
- `rls_auto_enable` is Supabase platform state. **Do not drop or adopt it.**
- **`no-store` on documents means every back/forward navigation refetches.**
  Re-audited in Q10 with fresh eyes and confirmed live on the deployed Worker;
  the trade is still correct.
- **Twelve trigger functions still carry `anon` EXECUTE** from the platform
  default. Harmless and left alone: PostgreSQL refuses to invoke a trigger
  function directly whatever the grant says (`0A000`), which Q10 proved for
  each of them rather than assuming.
- **Both `package-lock.json` and `pnpm-lock.yaml` are committed.** They resolve
  every direct dependency identically, so whichever Cloudflare picks builds the
  same tree. `npm audit` reports 0 vulnerabilities.
- **Second-identity browser tests were NOT RUN.** Anything needing a second
  human — the receiver-confirms-a-payment half of settlement — has no second
  authenticated session available. It is covered by `settlement-lifecycle`
  against a real PostgreSQL, so it is proven, just not browser-proven.

## Starting Q11

In a **fresh** Claude session (Opus 5, High):

> Read `CLAUDE.md` (loaded automatically) and `docs/CURRENT-STATE.md`. Read
> `docs/SECURITY-AND-QA.md` if this phase touches security, data or live QA.
> Then execute this phase. \<phase prompt\>
