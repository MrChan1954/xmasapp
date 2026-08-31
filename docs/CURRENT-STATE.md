# Current State

**Last updated:** 2026-08-31, after roadmap Phase 5B put the invitee's side of
the invitation live.

The handoff between phases. Current facts only — history lives in git.

## Migration 054 is LIVE — a family's invitation now approves the account

**Applied to production 2026-08-31, between 23:10 and 23:13 UTC**, manually, in
one run. Migrations are now **001–054**.

**The rule.** `FAMILY ADMIN INVITES + INVITEE ACCEPTS = approved Gift Planner
account.` Both halves are required and neither is new: `grant_area_access`
already proved only an Area's own administrator may invite, into their own
Area; `accept_family_invitation` already proved only the owner of the confirmed
address may take it. 054 stops discarding an authority that was already
established, so an invited person no longer waits for a platform administrator
who has never met them.

**What did NOT change:**

- **Public sign-up still waits.** An account with no accepted invitation is
  `pending` and a Gift Planner administrator decides it, exactly as before.
- **Rejected and suspended cannot be laundered.** They are refused *before* any
  write; an invitation may vouch for somebody nobody has decided about, never
  overturn a decision somebody made.
- **Nobody becomes a global administrator.** `is_global_admin` is false on
  insert and untouched on update.
- **Approval is durable.** Losing the sponsoring membership later leaves the
  account approved and the person in the legitimate zero-family state.
- **Sponsorship grants one family**, the accepted one. Every other Area still
  asks `is_area_member` for itself.

### The one-time backfill, and what it actually did

054 also settled the people who had already accepted before it existed — they
would never call `accept_family_invitation` again, so section 1 alone would have
left them waiting forever. **Exactly two accounts**, both matching the read-only
preflight taken minutes earlier:

| Account | Sponsoring family | Evidence |
| ------- | ----------------- | -------- |
| `189bf7c4…` (QA test identity) | QA Charlie | its own `Joined QA Charlie` entry |
| `bdc15e0d…` (**a real person**) | **Tricketts** | its own `Joined Tricketts` entry |

The second is Ben's family member, who accepted a genuine invitation at 22:24
the previous evening and had been sitting in the pending queue ever since. They
are approved now, without anybody asking them to accept anything again — which
is the whole point of the migration.

**The predicate is audit evidence, never `user_id is not null`.** That would
have been true of every membership this installation has ever had, including
seats an administrator attached by hand and seats the retired auto-join claimed
without asking. Proof is the entry `accept_family_invitation` writes, and four
things no other path produces together: the record is that seat, **the actor is
the invitee**, the Area agrees, and the summary is `Joined <family>`. The
summary is load-bearing: `record_audit_event` writes `app_members added` for
every trigger entry, including a founder's own admin seat, which matches on
every other clause. **Thirteen of fifteen claimed seats were correctly
excluded** — eleven for having no invitee-authored acceptance, two for already
being approved.

### Verified after the apply, read-only

Exactly 2 sponsored; both the expected candidates; neither a global admin;
`decided_by` null on both — no human is invented as approver. Two `decided`
audit rows, `source = 'family_invitation_backfill'`, each naming its sponsoring
Area, seat and original acceptance, with no address, token, password or link.
**`app_members` unchanged at 15 rows; Tricketts unchanged at 3 seats / 3
claimed; 5 admin seats; 0 declined.** `app_accounts` 7 → 9, all approved;
`auth.users` 9. Protected fingerprint exactly baseline: 37 · 19 · 15 · 4 · 35 ·
19, `crossAreaTotal` 0.

**Backup before the apply:** workflow run `33449348645`, artifact
`supabase-backup-2026-08-31`, 23 public COPY blocks, 1138 data rows, taken at
commit `1cc0995`.

**Rollback:** `docs/manual-sql/Q21-054-ROLLBACK.sql` restores 053's routine and
stops future sponsorship. It deliberately carries **no blanket undo** — the two
approvals it granted are decisions about people, and reversing one costs a named
administrator and a reason through `set_account_status`.

## CORRECTION — Tricketts is a REAL family, not a QA fixture

Earlier notes on this page called Tricketts a **user-confirmed throwaway** and
scheduled it for deletion at the final closeout, alongside QA Alpha and QA
Charlie. **That was wrong, and acting on it would have destroyed a real
family's data.**

`.qa-areas.local.json` is the authority, and it always was. It lists exactly
three QA Areas — **QA Alpha, QA Bravo, QA Charlie** — and one protected Area,
**Our family**. Tricketts appears in neither list. It was created live on
2026-08-31 at 14:32 UTC through the new runtime, and its **admin seat belongs to
a different real person's address**, not to this account.

The rules from here:

- **Tricketts is REAL and READ-ONLY.** Treat it as `Our family` is treated,
  minus the protected fingerprint.
- **Final QA cleanup must NEVER include Tricketts.** Only QA Alpha, QA Bravo
  and QA Charlie are deletable.
- **Any future mutation of Tricketts needs its own explicit approval**, asked
  for and given at the time.
- The Phase 6A Accept into Tricketts was legitimate: the misclassification was
  surfaced to the user *before* the write, and they approved it knowing
  Tricketts is a real family. That membership stands and is not undone here.

An Area in neither list is **unclassified, and unclassified means real**. Do not
infer QA status from a name that looks like a test.

## Phase 5B — the invited person can answer, and production serves it

**The invitation runtime is complete on both sides and deployed.** Migration 053
gave the invitee three routines in August and no screen to use them from; there
is one now.

| Fact | Value |
| ---- | ----- |
| Commit | `d21aa5e`, pushed |
| Cloudflare version | `5030bfa1-16d6-4fb6-9e25-971e5d4cd6ce`, 100% traffic, created 2026-08-31T20:43:21Z |
| Migrations | still **001–053**. Phase 5B needed none. |

**The surface is `/invitations`, and it is global.** It is in `GLOBAL_ROUTES`,
so `AppFrame` draws no chrome and `FamilyProvider` does no Area work — verified
live: **zero `<nav>` elements** on the page. It resolves no membership, no
acting Area and no `gp_area`, which is what lets somebody in **no family at
all** open it. An Area-scoped notification could not have carried this:
`notifications` sits behind `is_area_member`, so a row about a family you have
not joined is a row you cannot read.

**A globally pending account may stand there** — the one routing change, via
`PENDING_ALLOWED` in `src/lib/account-status.ts`. 053 already decided it:
accepting while pending creates a membership that grants nothing, because every
permission predicate carries `is_globally_approved()`.

**Accept does not select the family it just joined.** `accept_family_invitation`
returns the Area id and the screen ignores it.

**Where it appears:** `/invitations`, the zero-family onboarding (above *create
a family*), the Area chooser (`ChooserWithInvitations`), and `/account-pending`.
`compact` renders nothing when none is waiting, so those screens are unchanged
for everybody else.

**`claimInvitations()` is a no-op that keeps its call sites.** It calls
`claim_app_member()`, which 053 reduced to `select false`. Its documentation
used to describe the pre-053 behaviour as current — *"the one routine that may
write `app_members.user_id`"* — which would have led a reader to believe sign-in
still joins people, or to "repair" it. The comment now says the truth and a test
pins it. **Removing the call sites belongs with dropping the routine, in one
change** — see Phase 6 below.

**The notification bell is deliberately not integrated.** Forcing invitations
into `notifications` means weakening the policy that keeps every family's
notifications private, to deliver one sentence. Polish, later.

### Live QA, read-only, on deployment `5030bfa1`

The signed-in QA account has a **real open invitation to Tricketts**, so the
populated state was exercised rather than only the empty one. Desktop 1440×900
and mobile 390×844: `Your invitations` → *Invitation to Tricketts* → "You have
been invited to join Tricketts as Taylor." → Accept / Decline, both 48px. No
horizontal overflow at either size, no application console errors, no Area
chrome. **Neither button was pressed** — the Tricketts seat is still `invited`,
unclaimed and undeclined, and the all-Areas membership total is still 12.

Root `/` still renders Our family's dashboard normally for that account: a
pending invitation to another family changes nothing about the acting one.

## Every Phase 5A gate passed, and it is pushed

| Gate | Result |
| ---- | ------ |
| TypeScript `npx tsc --noEmit` | PASS |
| ESLint | PASS — 0 errors (2 pre-existing warnings in `scripts/family-invitations.test.mjs`) |
| `npm run build` | PASS |
| `npm run test:all` | PASS — 2166 tests, 293 suites, 0 fail |
| `git diff --check` | PASS |
| `npx opennextjs-cloudflare build` | PASS |
| `npm run check:worker-bundle` | PASS — 81 assets, 10535.98 KiB / gzip 2297.46 KiB, exit 0 |

### The local toolchain, and the trap in it

**pnpm is not installed on this machine, and must not be installed globally to
get round that.** OpenNext reads `pnpm-lock.yaml`, decides the project is
pnpm's, and `execSync`s `pnpm build` — so `pnpm` has to be resolvable by a
`cmd.exe` child. Corepack provides it without touching the Node installation or
the repository:

```
corepack enable pnpm --install-directory <a scratch dir>
corepack prepare pnpm@10.34.5 --activate
```

then put that scratch dir on `PATH` for the build. No global install, no
`packageManager` field, no manifest change.

**Pin 10.34.5. Do not let Corepack pick the latest.** Corepack's default is
pnpm **11**, and pnpm 11 runs an implicit `pnpm install` before `pnpm run` —
which **silently relinked `node_modules` to the isolated layout** and then
failed on `ERR_PNPM_IGNORED_BUILDS`. The isolated layout is exactly what cannot
build the OpenNext bundle on Windows:

```
Error: EPERM: operation not permitted, symlink
  node_modules\.pnpm\@next+env@16.3.0\node_modules\@next\env -> ...
```

pnpm 11 also drops an untracked `pnpm-workspace.yaml` (an `allowBuilds` stub) in
the repository root. **Delete it.** It is a tooling artifact and nothing here
should carry it.

**The recovery, which is also the setup, is one command:**

```
CI=true pnpm install --frozen-lockfile --config.node-linker=hoisted
```

`--frozen-lockfile` is what guarantees no lockfile write — `pnpm-lock.yaml` is
still SHA-256 `9dfeb23c…d72ae4`, byte-identical to the value Q17 recorded. `CI`
is needed only because pnpm refuses to purge `node_modules` without a TTY.
Afterwards `node_modules/.pnpm` holds only `lock.yaml` and the tree is flat,
which is how the bundle builds.

**`--skipNextBuild` is not a shortcut round any of this.** `next.config.ts` does
not set `output: "standalone"` — OpenNext supplies that when it runs the build
itself — so skipping it dies on a missing
`.next/standalone/.next/server/pages-manifest.json`.

**Why the gate is not optional.** It is the check that caught the `__name`
theme-bootstrap failure: wrangler's esbuild injects helpers into serialised
inline scripts, and that breaks only in the bundled Worker, never in
`next build`.

## Roadmap Phase 5A — the family admin can invite, and learns nothing by doing it

**The requirement.** A family administrator may invite any address they can
type. They may **not** find out whether that address already has a Gift Planner
account. Everything below is that sentence or a consequence of it.

**One press, two private branches, one answer.** `Give access` → email →
submit → `Invitation created.` Underneath:

| The address | What happens | What the admin is told |
| ----------- | ------------ | ---------------------- |
| already has an account | the invitation is created and left for the invitee's Phase 5B screen. **No signup or setup email.** | `Invitation created.` |
| has no account | the invitation is created **and** the Supabase/Resend account-setup email is sent | `Invitation created.` |

Both answers are `200` with the same two fields and the same sentence, and
`scripts/family-invitation-runtime.test.mjs` compares them with `deepEqual` and
by serialised body rather than asserting each separately.

**The branch is the attempt, not a lookup.** Nothing asks Auth whether an
address is registered. `inviteUserByEmail` refuses an already-registered address
*before* it sends anything, and that refusal is the only signal —
`classifySetupEmailError` folds it into `ready` and it never leaves the server.
No `listUsers`, no `listAllAuthUsers`, no `getUserById`, and a sweep over every
file in `src/` proves it.

**Where the code lives.**

| File | What it is |
| ---- | ---------- |
| `src/lib/family-invitations.ts` | the decision. Holds no client, no key, no session — the four privileged operations are passed in, which is what lets the tests run the real decision with the branch chosen by a fake. |
| `src/app/api/admin/family-access/route.ts` | the adapter. Calls `grant_area_access`, `record_invitation_delivery` and `list_area_access` on the **administrator's own session**, never the service role, because those routines authorise themselves from `auth.uid()`. |
| `src/lib/family-access.ts` | six states, derived from 053's row shape. |
| `src/app/more/family-access/family-access-client.tsx` | the screen. |

**Six states, and two labels deleted.** `Awaiting sign-up` is gone: it existed to
say the address had no account, on a badge. `invited` / **Invitation pending**
replaces it and reads identically on both branches. `declined` is new — 053's
`declined_at`, asked *before* `revoked` because the CHECK constraint makes a
declined row `active = false` too, so asking the other way round makes every
decline read as the administrator's own doing.

| State | Label |
| ----- | ----- |
| `no_access` | No access |
| `invited` | Invitation pending |
| `awaiting_global_approval` | Waiting for Gift Planner approval |
| `active` | Active |
| `declined` | Declined |
| `revoked` | Revoked |

**Two actions were deleted, and that is the security work.**

- `send-invite` was a *second* press, offered only on a seat labelled "Awaiting
  sign-up". The two-step was an oracle with a state machine around it. Creating
  the invitation and delivering it are one act now, so there is no intermediate
  state to read the answer off.
- `copy-setup-link` minted `generateLink({ type: "invite" })`, which GoTrue
  **refuses** for an address that already has an account — a link for a
  stranger, an error for a member. That was the cleanest account-existence
  oracle in the application. There is no version of it that keeps the
  convenience and loses the disclosure, so it is not there. **This is a product
  capability that was removed**; a family that cannot receive email reliably has
  no setup-link path until something better is designed.

`copy-reset-link` survives, for a seat that is already **claimed** — no
existence question arises, and `recovery` vs `magiclink` now comes from
`list_area_access`'s own `email_confirmed`, so the route reads no table at all.

**The failure sentence names nothing.** Only the no-account branch can fail to
send, so "the email did not go out" would be the oracle by the long route. A
failed send and a refused audit write both answer with one string that mentions
neither email, account, sign-up nor provider — and says the true, useful part:
the invitation exists, try again. The invitation is never lost, and a failed
send activates no membership.

**The audit is 053's, unchanged.** `record_invitation_delivery(person, outcome)`
with the closed vocabulary `ready` / `undelivered`, called with the
administrator's session. Both success branches write `ready`. No address, no
domain, no body, no link, no token.

**Re-invite works and stays consent-based.** `grant_area_access` clears
`declined_at` and sets `active = true`, and never writes `user_id` — so a
reissue restores an *invitation*, not a membership. The invitee must accept
again in Phase 5B.

**No migration.** 053 supports all of this as designed. There is still no 054.

### Phase 5B still owns everything the invitee sees

Not built, deliberately: the `/invitations` route, the Accept and Decline
buttons, global pending-invitation cards, notification-bell integration, the
Area-chooser refresh after Accept. `claim_app_member()` remains 053's
`select false` no-op and no new silent auto-claim helper was created.

## Where the project stands

| Fact | Value |
| ---- | ----- |
| Live site | `https://xmas-family.uk/` |
| Last completed phase | **Roadmap Phase 4C — the corrected post-apply checks run end-to-end at 0 FAIL, and the accidental rollback table dropped from production.** |
| Q19 verdict | `LAUNCH STEP 1 PASS — READY FOR LIVE SIGN-UP E2E` |
| Next phase | **The family invitation runtime.** The database is ready; **no invitation UI exists yet** — nothing in the runtime lists, sends, accepts or declines an invitation. |
| Migration 053 | **APPLIED TO PRODUCTION**, 2026-08-31, between 17:31 and 18:30 UTC. Verified live read-only: `app_members.declined_at` exists and all four routines are exposed, SECURITY DEFINER, `search_path=""`. |
| Cleanup hold | **QA Alpha, QA Charlie and QA Bravo** are the only deletable QA Areas, and none goes before the live invitation tests finish. **Tricketts is NOT one of them** — see the correction at the top of this page. |
| Branch | `main` |
| Local HEAD | see git; Phase 4B pushed the three held commits plus its own. |
| origin/main | the Phase 4B commit. The three commits held back since Phase 3 are no longer held. |
| Serving Worker | **the Q19 runtime.** `/sign-up` returns 200 live; `/login` offers *Create an account*. |
| Product name | **Gift Planner** |
| Migrations applied | **001–053**, immutable. 053 applied manually 2026-08-31; there is no 054. |
| Migration **052** | **APPLIED and verified.** 37 PASS / 0 FAIL across its 40 post-apply checks. |
| Public sign-up | **ON**, and **Confirm Email is ON**. Both machine-read from GoTrue, not taken on trust. |
| Global administrators | **one**, bootstrapped 2026-08-31 01:18:25 UTC. |

> **The single most important fact on this page.** The runtime is live, the
> front door is open and Auth email now reaches a real address — but **nobody
> has ever completed a real sign-up**. That is the next phase, and it needs one
> email address the user chooses.

## Roadmap Phase 4C — the database contract for 053 is closed

The corrected `docs/Q20-053-POST-APPLY-CHECKS.sql` was finally run end-to-end in
the Supabase SQL editor, and returned **0 FAIL**. The callable
`SECURITY DEFINER` sweep passed. `rls_auto_enable` no longer appears as a
failure: the check is now event-trigger aware and reports it as **INFO** — an
`event_trigger`, `SECURITY DEFINER`, `search_path=pg_catalog`, platform state
that no migration here creates and none should adopt. That was the Phase 4B
false positive, and it is resolved rather than merely tolerated.

Production is healthy. Cloudflare version
`e907381b-c86f-4bbc-ad27-5af5fd9898c4` serves 100% of traffic and the live site
answers **200**. Wrangler does not surface the originating commit for a Workers
Build (`Source: Unknown`, `Tag: -`), so the version is **not provably** the
build of `1e79bf0`; it does not need to be, because that commit touched only
`docs/` and `scripts/` and changed no runtime source at all.

The accidental rollback table was inspected and then removed — see *Closed in
Phase 4C* below. **No production schema changed other than that one
`DROP TABLE`.** Migration 053 was neither reapplied nor rolled back, and there
is still no migration 054.

Protected fingerprint after the drop, from `scripts/qa/fingerprint.mjs`:
notifications 37, people 19, events 15, appMembers 4, recipients 35, Christmas
2026 active recipients 19, `crossAreaTotal` 0 — unchanged. Note that
`appMembers: 4` counts **Our family**; the all-Areas membership total is **12**,
reported by the same run as `memberRowsChecked`. The two are not the same number
and should not be reconciled against each other. All five Areas remain: Our
family, QA Alpha, QA Bravo, QA Charlie, Tricketts. One invitation is open and
awaiting an answer.

**The invitation runtime is still not implemented.** 053's database contract is
complete and now fully closed out; the UI that would use it does not exist.

## Roadmap Phase 4 and 4B — migration 053 applied, and the one FAIL explained

**Migration 053 is live.** It was applied manually on 2026-08-31, in the window
between the 17:31 UTC backup (which has no `declined_at`) and the 18:30 UTC one
(which has it, and all four routines). Verified independently and read-only
against the live database: `app_members.declined_at` is selectable, and
`list_my_family_invitations`, `accept_family_invitation`,
`decline_family_invitation` and `record_invitation_delivery` are all exposed,
all `SECURITY DEFINER`, all pinned to the empty search path.

**The backup reference.** Backup workflow run `33419857093`,
`2026-08-31T17:31:11Z`, taken before the apply — 1111 data rows, 23 public COPY
blocks. The post-apply dump is run `33425294174`, `2026-08-31T18:30:37Z` — 1124
rows, 24 blocks.

**The rollback mishap, factually.** `docs/Q20-053-ROLLBACK.sql` was run against
production by accident after the apply, and **053 was re-applied successfully
afterwards**. No membership row was created or destroyed: the rollback copies
every row into `public.app_members_053_backup` before it touches anything, and
that copy is still there — see the open item below.

### The one FAIL was a false positive, and the predicate was wrong

The first production run of `docs/Q20-053-POST-APPLY-CHECKS.sql` reported
exactly one FAIL, from the schema-wide check `NO SECURITY DEFINER routine
anywhere has a mutable search_path`, naming `rls_auto_enable`.

**The cause.** That check treated every `SECURITY DEFINER` routine in `public`
as unsafe unless its `proconfig` contained `search_path=""`.
`public.rls_auto_enable` is a definer, and it *is* pinned — but to `pg_catalog`,
not to the empty string. It also **returns `event_trigger`**, so it is not a
routine anybody can call: no call shape reaches it, which
`migration-execution.test.mjs` proves by trying three of them. It is Supabase
platform state — no migration in this repository creates it, and 053 did not
touch it. All four of 053's own routines passed the strict rule.

**The correction**, in `docs/Q20-053-POST-APPLY-CHECKS.sql`:

| Change | What it is |
| ------ | ---------- |
| The sweep is now over **callable** routines | one clause added: `and p.prorettype <> 'pg_catalog.event_trigger'::regtype` |
| Nothing else was relaxed | a definer with `search_path=public`, one with `search_path=pg_catalog`, and one with no `proconfig` at all all still FAIL |
| The exception is by return type, never by name | no check excuses a routine because of what it is called |
| Event triggers are reviewed, not hidden | a new row names every definer event trigger with its pinning: **INFO** while each is pinned, **REVIEW** the moment one is not |

Evaluated against production's own post-apply schema dump, the corrected sweep
reports **PASS, detail `none`**, over 102 callable definers; the old predicate
reports FAIL naming `rls_auto_enable`, which is the reported failure reproduced
exactly. The review row reports INFO, naming the one definer event trigger in
`public`.

**No migration 054 was written**, and none is needed. Repinning
`rls_auto_enable` to the empty search path would adopt platform state into
migration-owned schema for no security gain.

### The rehearsal now carries the platform object too

Phase 3 missed this because the rehearsal builds its schema from migrations
alone, and production also holds objects no migration creates.
`scripts/pg/production-objects.sql` — the function and its event trigger,
verbatim from the production dump — is now loaded by
`family-invitations-rollback.test.mjs` for both the post-apply run and the
rollback run. A PASS there now means what a PASS in the SQL editor means. It
also reproduces a second production fact: the rollback's backup table came out
with row level security already on, because this trigger turned it on.

### Closed in Phase 4C — the rollback residue is gone

`public.app_members_053_backup` **no longer exists**. Phase 4C dropped it from
production on 2026-08-31, after explicit user approval, with a single
`DROP TABLE` and **no `CASCADE`** — so Postgres itself was the dependency gate.

It held **12** rows, not the 13 recorded here earlier; live `public.app_members`
holds 12 as well, and every backup row matched a live `app_members.id`. The
snapshot contained nothing that was not already live, so dropping it destroyed
no history.

Two things the earlier note got wrong, both worth keeping:

- It was described as **not exposed**. That was half right. RLS was on with zero
  policies, so `anon` read no *rows* — but the `CREATE TABLE AS` had inherited
  the `public` schema's default grants, so the browser role still held `SELECT`
  on the table. `GET /rest/v1/app_members_053_backup` with the publishable key
  answered **200 `[]`**, where `app_members` and `notifications` both answer
  **401 permission denied**. A table of real membership rows was resting on one
  layer where every comparable table has two. That is now moot, and it is the
  reason removing it was worth doing rather than merely tidy.
- The row count was 13. It was 12.

Dependency inspection before the drop found nothing pointing at it: no inbound
or outbound foreign keys, no user triggers, no indexes or constraints, no
dependent views, no routine referencing it, no non-trivial `pg_depend` rows, and
no replication publication. `docs/INSPECT-BACKUP-TABLE.sql` is the read-only
report that established this; it is deliberately untracked.

Verified read-only after the drop: the table is absent from the schema cache for
**both** `service_role` and `anon` (`PGRST205`), while `public.app_members`,
`app_members.declined_at` and all four routines 053 added remain present.

### What is NOT done

**There is no invitation runtime.** Nothing in the UI lists, sends, accepts or
declines a family invitation, and no real invitation has been sent. 053 gave the
database the routines and the consent rule, and that is all it gave.

## Roadmap Phase 1 — two live regressions, and what caused them

**The event More screen told everybody their role was unknowable.** It worked
out whether the reader administered the family by sending a GET to
`/api/admin/family-access` and reading the answer off the status code: `ok`
meant admin, 401/403 meant not, anything else meant "we could not check". Q19
moved every read of that route into the database and left only a POST, so the
GET began answering **405** — none of the three cases — and every reader fell
into the third. The family's own administrator lost the entries the warning was
hiding.

**The fix is the role source, not the message.** `FamilyProvider` has resolved
the membership for the family on screen all along, and the navigation chrome has
been reading it the whole time; the screen now asks the same question of the
same source. That carries the separations with it: the **selected Area** decides,
an account in several families with none chosen resolves to nothing rather than a
guess, and a Gift Planner global administrator is still nobody's family
administrator. It fails closed — an unresolved role hides the entries.

**`/admin/accounts` is no longer a dead end.** It offers **Back to Gift
Planner**, an anchor to `/` — the one place that decides between the dashboard,
the Area chooser and first-family onboarding. Sign out remains, separately. The
route still resolves no Area to draw it, and the transitive import walk in
`scripts/account-approval-runtime.test.mjs` still proves that.

`scripts/event-more-admin.test.mjs` is new and renders the real provider over
the real screen, because the broken version would have satisfied any test that
only read the source.

**Not yet verified live:** both fixes need a signed-in browser, and none was
available to that session. The signed-out smoke passed at 1440×900 and 390×844
DPR 3.

## A fifth Area exists: "Tricketts"

Created live 2026-08-31 14:32 UTC with one admin and one member — the first
family made through the new runtime. **This was recorded as a throwaway and that was
wrong** — see the correction at the top of this page. It is a real family, it
is not deleted at closeout, and it is not mutated without separate approval. `Our family` is untouched: every protected value is unchanged
and `crossAreaTotal` is still 0.

## SMTP — configured, and proved to deliver

Auth email goes out through **Resend** (`smtp.resend.com:465`, sender
`Gift Planner <no-reply@auth.xmas-family.uk>`, domain `auth.xmas-family.uk`
verified). Supabase's built-in mailer is no longer in the path.

**Proved, not assumed.** One password-reset request for a real existing address
was submitted through the live `/forgot-password` form on 2026-08-31.
`/auth/v1/recover` returned **200** — a broken SMTP host fails there with a
500 — and the email **arrived**. No password was changed, no link followed, no
account state touched.

**One caveat that matters for launch.** It landed in **junk**, not the inbox.
Hotmail/Outlook filters a newly verified sending domain with no reputation, and
a confirmation email a family member never finds is, from their side, an email
that never came. Worth a DMARC record and a warm-up before telling people to
sign up — and worth telling the first few to check their spam folder.

**Not inspected:** Resend's own delivery events. Reading them needs the user's
authenticated Resend session, which is not reachable from this environment.

## Q19 launch step 1 — configured, pushed, deployed, smoke-tested

**Auth configuration, machine-read** from `GET /auth/v1/settings` and from
non-mutating `/auth/v1/verify` probes rather than from the dashboard:

| Setting | Value | How it was read |
| ------- | ----- | --------------- |
| Confirm Email | **ON** (`mailer_autoconfirm: false`) | settings endpoint |
| Public sign-up | **ON** (`disable_signup: false`) | settings endpoint |
| Email provider | enabled | settings endpoint |
| Site URL | `https://xmas-family.uk/` | verify probe with no `redirect_to` |
| SMTP | **built-in Supabase service — USER-CONFIRMED, not machine-read** | user checked the dashboard |
| Rate limits / quota | **not read** — dashboard-only, and no management token exists here | — |

Public sign-up was **already ON** when this phase started, contrary to the
brief's assumption. It was left on, on the user's decision: the exposure already
existed, 052's approval gate was already live in the database, and pushing the
new runtime shrank the window in which a new account met a runtime that signed
it out.

**The redirect allow-list is tight, and was proved so.** Each of the three URLs
the runtime actually asks for is accepted, and a control URL is not — a rejected
`redirect_to` falls back to the Site URL, which is what makes the probe
discriminating:

| Probed | Result |
| ------ | ------ |
| `https://xmas-family.uk/auth/callback` (sign-up confirmation) | accepted |
| `https://xmas-family.uk/auth/callback?next=/reset-password` (forgot password) | accepted |
| `https://xmas-family.uk/auth/callback?next=/account-setup` (admin invite) | accepted |
| `https://xmas-family.uk/account-setup`, any other path on that origin | accepted |
| `http://`, `localhost`, `www.`, a look-alike subdomain, `workers.dev` | **rejected** |

**Deployment.** `d36d47d..12909e2` pushed to `main`; Cloudflare Workers Builds
auto-deployed it. `/sign-up` went 404 → 200 about 60 seconds after the push.
No manual deploy was run.

**Live signed-out smoke — passed.** `/login` (with *Create an account* linking
to `/sign-up`), `/sign-up` (email, password, confirm password, correct copy),
`/account-pending`, `/account-rejected` and `/check-email` all render; none
carries any Area data; `/admin/accounts` redirects to `/login`;
`/api/supabase-health` refuses an unauthenticated caller. No horizontal
overflow at 1440×900 or at 390×844 DPR 3, and no application console errors —
the only console error seen appears identically on `example.com` and is Edge's
own.

**Protected fingerprint, taken after deployment:** notifications 37, people 19,
events 15, appMembers 4, recipients 35, Christmas 2026 active with 19
recipients, `crossAreaTotal` **0**. Unchanged.

**QA Alpha, QA Bravo and QA Charlie all still exist**, deliberately. They are
the safe mutation targets for the live E2E phase and are removed only at the
final closeout, preserving `Our family`.

**What is NOT tested.** No production account has been created. No confirmation
email has been sent or received. The approval path, the rejection path, Area
onboarding and the invite/claim path have never run against production. An
existing account's sign-in was not exercised — no credential was available to
this session, and guessing one is not a smoke test.

**One local toolchain note.** `node_modules` is now installed by pnpm from
`pnpm-lock.yaml` with a **hoisted** (flat) linker. The isolated layout that
pnpm installs by default cannot build the OpenNext bundle on Windows, which
needs symlinks; the hoisted tree builds it cleanly. Nothing in the repository
was changed to achieve that.

## Q19 part three — the runtime, built and held

`docs/Q19-PUBLIC-SIGNUP-APPROVAL.md` is the record. It carries the census, the
bootstrap statement, the runtime design **and the launch checklist**. Read it
before doing anything to production or to the Auth project.

**One sentence:** the app now asks the database whether an account is allowed in
before it reads a single family row, and stops signing people out for not having
a family yet.

### What was built

Six routes — `/sign-up`, `/check-email`, `/account-pending`,
`/account-rejected`, `/admin/accounts`, and a three-shaped `/`. One pure
decision function, `src/lib/account-status.ts`, that every entry point shares:
sign-in, the auth callback, account setup, the front door and `FamilyProvider`
all ask the same question and get the same answer.

**The defect it removes.** Signing in read `app_members`, found nothing, and
called `signOut()` — so did the auth callback and account setup. That is wrong
in both directions at once under public sign-up: an **approved account with no
family** was signed out of an account it is entitled to (which is everybody, for
the first few minutes), and a **rejected account with a family** was let in,
because the membership row was all anybody asked about. Membership is a family's
decision; approval is Gift Planner's, and it is upstream.

**Family Access is the database's now.** The route went from 855 lines and eight
actions to a couple of hundred and three. `list_area_access()`,
`grant_area_access()` and `revoke_area_access()` do the work through the
caller's own session. **The project-wide Auth enumeration is gone** —
`listAllAuthUsers` fetched up to a hundred pages of every account on the
installation to answer a question about one family. The three survivors are the
three the Supabase Admin API alone can do: send an invitation, mint a setup
link, mint a recovery link. **None of them writes a row.**

**Q18's two deferred consolidations are settled.** `signOut` has one home and
now clears `gp_area`, which neither copy ever did; `createAdminClient` has one
home, and `src/utils/supabase/service-role.ts` is the only module in `src/` that
reads `SUPABASE_SECRET_KEY`. Both are held by counting tests.

**The front door asks rather than guesses.** With families but no valid `gp_area`
cookie it renders a chooser — **even for exactly one family**. That is the one
place the app commits to whose people, money and history it is about, and making
that commitment silently is how a stale cookie used to walk a two-family login
into the wrong family without saying so. Everywhere else, `resolveActiveArea`
still falls back, so bookmarks and deep links are unchanged.

### Gates

Full regression **2,023 / 2,023** (was 1,939). Mutations **169 / 169**, zero
survivors — 7 new, and **four retargeted**: `1`, `Q3-1`, `Q3-2` and `Q3-8` all
aimed at Family Access code 052 deleted and were reporting `COULD NOT APPLY`,
which is a survivor rather than a pass. TypeScript, ESLint, production build and
the Worker bundle are clean. Migrations 001–052 are byte-identical; 052 is still
`f541b6ee…de61d`.

Local browser QA on Edge over CDP at desktop 1440×900 and a genuine 390×844
DPR 3: **75 / 75**. Signed out throughout, against localhost, because production
is still serving the old runtime. Nothing was submitted and **no production row
was touched**.

### What is NOT proven, and cannot be until the launch

No end-to-end sign-up, because public sign-up is off and no confirmation email
has ever been sent by this runtime. No live `/admin/accounts` as a real
administrator — the screen is rendered against a fixture and its signed-out
refusal is proved in a browser, but no approval decision has been taken through
the UI. No live Area chooser and no live Family Access. **None of that may be
described as passing until the launch session runs it.**

## Q19 parts one and two — migration 052 is applied, and Gift Planner has an administrator

**One sentence:** being able to sign in stops being the same thing as being
allowed in. A new table, `public.app_accounts`, sits **upstream of every Area** —
`auth.users` → `app_accounts` → `app_members` → role.

**052 is applied.** Production ran it at 2026-08-31 01:06:23 UTC and the first
global administrator was appointed at 01:18:25 UTC. Both were run by hand in the
Supabase SQL Editor; everything the model did was a GET. The full record —
timestamps, uuid, verification outcome — is in
`docs/Q19-PUBLIC-SIGNUP-APPROVAL.md`.

**Public sign-up is still off**, and Supabase's Confirm Email setting is
unchanged. 052 built the door; nothing has opened it.

### What 052 is

One table, ten new routines, **nine** redefinitions, two policies, one widened
CHECK. `app_accounts` has RLS on, **zero policies, and not one privilege for
`anon` or `authenticated`** — a browser reads its status through
`my_account_status()` and nowhere else. **A missing row means NOT APPROVED.**

Six redefinitions were designed. **Three came out of the rehearsal**, and they
are the reason this phase was worth running rather than writing:

1. **`is_own_app_member` was a real leak.** It gates `notifications`,
   `notification_preferences` and `push_subscriptions` — the three tables keyed
   on a membership rather than an Area, and therefore the three an Area-shaped
   sweep never looks at. Measured without the fix, a **rejected** account with a
   claimed membership still read its own notification rows, and a notification
   carries the gift itself. The approved rule "blocked from ALL Area data" was
   not true with six redefinitions.
2. **`is_app_admin` and `is_area_contributor_member`**, found by a **surviving
   mutation**. Every isolation test suspended an ordinary *member*, for whom
   `is_area_admin` answers false either way; suspending an **administrator**
   showed both predicates still saying yes. Neither let a suspended account do
   anything — nineteen writes were attempted and all nineteen refused — but a
   database that keeps telling somebody it has locked out that they run a family
   is one refactor from a hole.
3. **`audit_log.action` had a closed vocabulary** (`added, removed, restored,
   handover`). 052 widens it by three, exactly as 041 did, which invalidates no
   existing row.

`is_acting_area` and the four `current_*` identity resolvers are **deliberately
left ungated**, with reasons, and a named test locks that choice in.

### The production census — run, read-only, clean

| | |
| --- | --- |
| Total `auth.users` | **5** |
| Category A (auto-approved) | **5** |
| Category B (unconfirmed, **blocks**) | **0** |
| Category C (no active membership) | **0** |
| Unclaimed invitations | **0** |

**Nothing blocks the apply.** Nobody loses access. Note that the **QA account
is one of the five** and is approved by the backfill like any other — correct,
and worth knowing rather than discovering.

The five candidates were in `docs/Q19-PUBLIC-SIGNUP-APPROVAL.md`, and the user
chose. **Gift Planner now has exactly one global administrator.** A second is
appointed with `grant_global_admin(uuid)` by a caller who already is one — the
bootstrap statement refuses to run again.

### Where that leaves the sequence

Steps 1–6 are **done**: census reviewed, 052 applied, post-apply checks run,
bootstrap run and recorded, checks re-run after it, and the runtime built and
reviewed. What remains is step 7 — **enable Supabase Auth sign-up and Confirm
Email, push, deploy, and do live QA.** In that order, and the launch checklist
in `docs/Q19-PUBLIC-SIGNUP-APPROVAL.md` is what it is done from.

## Q18 — one implementation per concept

`docs/Q18-CANONICAL-APPLICATION-PATHS.md` is the record. Read on demand.
**No database change; migrations still end at 051.** Everything here is
behaviour-preserving.

**The three duplicates Q17 handed over are gone, each to the module that already
owned its concept** — not to a new one, and not to a generic utility layer.

- **`priceInput`, four copies → `src/lib/currency.ts`**, beside `formatPennies`.
  All four were already identical (two spelled the regex `/\.00$/` and two
  `/\.00$/u`, which is the same pattern). 13 call sites migrated. Putting the
  two functions together is also what makes their difference legible: a field
  seeded from `formatPennies` carries a `£` and a thousands separator and
  **cannot be submitted unedited**, because `parseMoneyToPennies` refuses it.
- **`todayInput`, two copies → `src/lib/input-validation.ts`**, beside
  `validateDateInput`, so the value a date field opens on and the check it faces
  on the way back in now sit together. It takes an optional `Date` so the
  timezone behaviour can be tested at a fixed instant rather than mocked.
- **`progressPresentation`, two copies → `financial-progress.tsx`**, beside the
  bar whose "Budget reached" wording it matches. **A third copy of the label half
  turned up on the way**: `people-screen`'s `statusFilterLabel` returned the same
  four strings for the filter chips, and is gone — the chips now read
  `progressPresentation(status).label`, so the chip clicked and the badge read
  can no longer drift apart.

**The product-wording question Q17 raised is answered, and the tones answer it
more strongly than the words.** `events-dashboard.tsx` has its own `statusLabel`
and `statusTone`, and **two of the four states differ in the colour as well as
the word** — `in_progress` is `gold` there and `warning` on a person,
`over_budget` is `warning` there and `danger` on a person. It was never one
helper copied twice; it is a second presentation of the same status, and it
stays. A test asserts the dashboard still says "Complete", still tones
`in_progress` `gold`, and does **not** import the shared helper.

**A fourth duplicate no name-based audit would have found.**
`payment-log-server.ts` carried a private `londonDateInput()` whose body was
identical to `birthdays-server.ts`'s exported `londonToday()` — same
`Intl.DateTimeFormat`, same `Europe/London`, different name. It is gone; the
family's timezone is now written in exactly one file. It stays distinct from
`todayInput`, which answers in the **reader's device** timezone: a birthday is a
fixed calendar date wherever it is read from, while a purchase or payment date
defaults to the day the person filling the form is having. For a UK family the
two agree, which is exactly why merging them would look safe and be wrong.

**The three `*-taylor*` operator scripts are deleted**, the user having
confirmed they are not wanted. Repository safety was then proved, not assumed:
no `package.json` script, neither workflow (neither installs node modules at
all), no `src/` import, no test — only history documents and each other.
`admin-account-target.mjs` existed solely to hold the other two's email out of
the repository and went with them.

**Q17's "nothing supersedes them" was wrong, and that is why they could go.**
`claim_app_member()` is the canonical path that attaches a login to an
`app_members` row; migration 042 documents it and it runs on **every** auth
callback and in account setup, RLS-guarded and deliberately narrow.
`setup-taylor.mjs` did the same `UPDATE` with the service role, which bypasses
both RLS and the write barrier — removing it removes a bypass, not a capability.
**And its `--verify-only` was not read-only**: the write ran before the branch
was reached, so an operator "just checking" would have written to production.

**pnpm is the package manager and `pnpm-lock.yaml` is the only lockfile.**
The user confirmed Cloudflare Workers Builds runs `pnpm run build`,
`pnpm run deploy` and `pnpm run upload` from `/` on `main`.
`package-lock.json` is deleted: nothing required it, no workflow installs node
modules, no script invokes npm, there is no `.npmrc`. Two lockfiles were not
merely redundant — **they had already disagreed**, resolving `lucide-react` to
1.33.0 and 1.31.0, so production once installed a tree nobody had built.
Validated in a scratch directory, leaving the working `node_modules` untouched:
`pnpm install --frozen-lockfile` under **pnpm v10.34.5** succeeded and
`pnpm-lock.yaml` is **byte-identical afterwards** (SHA-256 `9dfeb23c…d72ae4`).
`pnpm run build` — the exact Cloudflare command — succeeds in the repository.
**No `packageManager` field was added**, deliberately: there is no evidence of
an exact version the repo expects, and pinning whatever `npx pnpm@10` resolved
to would change how production installs on no authority. `SHADCN-UI.md` §10 has
been rewritten; it used to instruct that both lockfiles be kept.

**The wider sweep says the three were not symptoms of a cluster.** Every
top-level definition in `src/` was grouped by name: 28 names repeat, and all but
two are false positives (`submit` in 10 files, `save` in 6 — local handlers),
framework requirements (`GET`/`POST`/`PUT`), registry-primitive-plus-wrapper
pairs (`Badge`, `Card`, `Input`… — `ui/index.tsx` imports the stock file and
wraps it, which is Q16's architecture), one-per-runtime pairs (`createClient`,
`rememberedAreaId` — and `AREA_COOKIE` itself is defined **once**), or two
screens calling one canonical RPC (`voidPayment` → `void_settlement`).

**Two duplicates are left standing on purpose, and both are Q19's business:**

- **`signOut`** is byte-identical in `account/page.tsx` and `account-menu.tsx`.
  Four lines, and a real hazard — if sign-out ever needs to clear the Area
  cookie, one copy gets it and the other does not. **Not done here because
  verifying it means signing the family out on the live site, which the QA rules
  forbid**, and shipping an unverifiable change to the auth path is worse than
  the duplication.
- **`createAdminClient`** in `family-access-admin.ts` and
  `notifications-server.ts` each build a service-role client and throw their own
  domain error type. Merging needs a shared error or an injected constructor, on
  the most security-sensitive client in the app. Separate architectural work.

`pad` (`String(value).padStart(2, "0")`) is in two lib modules and stays
inlined: two identical lines with no decision in them are an idiom, not a
concept.

**The four route shims are unchanged and are compatibility paths, not duplicate
business systems.** `/owed` is not even legacy — `notification-content.ts`
writes `OWED_URL = "/owed"` as the `url` of every money notification today.

**`scripts/canonical-paths.test.mjs` is what stops it growing back** — 13 tests
that **count definitions rather than filenames**, so moving a helper is free and
copying one is not. Proved to fail: a `priceInput` copy added back to
`person-modal.tsx` turns it red. Mutations `Q18-1`…`Q18-4` put back the four
defects the consolidation now makes reachable from everywhere at once, and all
four are killed by a named behavioural test.

**One harness lesson worth keeping.** `Q18-1`'s `from` string was first written
inside a template literal, where `\.` evaluates to `.` — so the pattern searched
for was not the one in the file and the run reported
`COULD NOT APPLY — the code it breaks has moved. Inconclusive.` That is the
harness working: an unapplied mutation is never counted as caught. **A regex in
a mutation's `from` needs its backslash doubled.**

**Live QA on Edge over CDP against `xmas-family.uk`, entirely read-only, acting
in QA Charlie.** Ten screens at desktop 1440×900 and at a genuine 390×844, DPR 3,
`mobile: true`, 5 touch points, coarse pointer: home, People, Birthdays, Events,
Settings, the event, its people, add-purchase, owed and payment log. **All 200,
one `h1` each, no horizontal overflow at either width, and zero failed
requests.**

The three helpers were read off the live page rather than inferred:

- **`todayInput`** — the add-purchase date field holds `2026-08-30`, the local
  calendar date, at both widths.
- **`priceInput`** — Sam QA Charlie's 1500-penny budget opens the edit field on
  exactly `"15"`: no symbol, no separator, no trailing `.00`. 46px tall at 16px,
  inside the viewport at 390.
- **`progressPresentation`** — the event people screen draws "Budget reached" ×1
  and "Not started" ×2, and **the filter chips read "Not started 2 · In progress
  0 · Budget reached 1 · Over budget 0"** — the folded `statusFilterLabel`, with
  counts matching the badges. The person modal shows three "Budget reached".

The modal was opened at 390 by a genuine `Input.dispatchTouchEvent`: full width
390, bottom flush at 844, 793 tall, entirely on screen, `aria-modal="true"`,
named "Sam QA Charlie", focus inside, Escape closes it. Bottom nav 390 wide, 68
tall, five 75px targets. **Nothing was submitted and nothing was saved.**

**Protected fingerprint taken before deployment and again after all QA:
identical, and identical to the baseline** — notifications 37, people 19, events
15, appMembers 4, recipients 35, Christmas 2026 active with 19 recipients,
`crossAreaTotal` 0.

## Q17 — what nothing runs, and four mutations that proved nothing

`docs/Q17-DEAD-CODE-DEPENDENCY-AUDIT.md` is the audit and the removal manifest.
Read on demand. **No database change; migrations still end at 051.**

**Every module in `src/` is reachable.** The import graph was rebuilt from the
entry points rather than trusted from Q14, and Q14's "172 of 174" is now 174 of
174 — Q16 deleted the two that were not. Three files fall out of the walk and
all three are alive by design: `public/sw.js` is registered by URL, and two
`scripts/dom/stubs/` modules are named as **strings** in `tsx-hook.mjs`'s
`STUBS` map. A tool that did not read that map would have proposed deleting
them.

**Removed:** the five `create-next-app` SVGs; `GiftCompleteBurst`, which
`git log -S` proves was never rendered in any commit, plus the `.burst-speck`
rule and keyframes that existed only for it; and fourteen exported names with no
consumer of any kind — `inputClasses` (a compatibility alias for a set Q16
emptied), `isUuid` and `hasDisallowedControlCharacters` (wrappers over functions
that are used), `purchaseStatusLabel` (superseded by three screens' own
vocabularies), `nextBirthdayFor`, and eight `Icon*` glyphs with their
`lucide-react` imports.

**`CompleteRibbon`, the snow, the garland and the ornaments are untouched.** The
festive layer is not being trimmed for being festive.

**The real find was in the mutation harness.** Q15 left the rule that a mutation
aimed at an implementation a later migration overwrites is testing nothing; Q16
applied it to one mutation, and nobody had applied it to all of them. All 141
were checked mechanically against the final schema. **Four were still doing it:**
`Q2-3` edited 042's `leave_area`, which **045** redefines, and `Q3-3/4/5` edited
044's person routines, which **047** redefines. Run individually, every one
reported `caught by: the migration REFUSED TO APPLY` — the defect never reached
the installed schema and a text check noticed. All four now edit the installed
definition and die against a real refused request (`THE ADMINISTRATOR MAY NOT`,
`CONTRIBUTOR/ARCHIVE/RENAME: refused across the Area boundary`). They stay
distinct from `Q6-6/7/8`, which break the *acting*-Area half of the same guards.
**Behavioural kills went 122 → 126 of 141, and superseded targets 4 → 0.**

**`/owed` is not a legacy redirect and Q14 understated it.** Q14 warned that old
notification rows might point there; the code running today points there too —
`notification-content.ts` declares `OWED_URL = "/owed"` and uses it as the `url`
of every money notification the app writes. All four shims stay.

**The three `*-taylor*` scripts stay, classified `MANUAL-USE UNKNOWN`.**
`set-taylor-password.mjs` refuses to run without an interactive TTY,
`admin-account-target.mjs` was *generalised* after it was written, and nothing
supersedes them — they are the only path that links an Auth user to an
`app_members` row or resets that password without the email flow. To close the
question the user need only say whether they have run either by hand since the
family went live, and whether they would want that recovery path if locked out.

**Every direct dependency is still used**, all 12 and all 13. Deleting eight
`lucide-react` glyph imports did not orphan the package.

**A near-miss worth remembering.** A CSS sweep flagged `.garland-bulb-berry`,
`-gold`, `-green` and `-warm` as unreferenced. `garland.tsx:53` builds the class
as `` `garland-bulb-${bulb.tone}` ``. Deleting them would have put the garland's
bulbs on screen unstyled.

**Live QA on Worker `fa57b868`, Edge over CDP, entirely read-only.** Seven
screens — home, People, Birthdays, Events, Activity, Settings, Notifications —
at desktop 1440×900 and at a genuine 390×844, DPR 3, `mobile: true`, 5 touch
points, coarse pointer. **All 200, no horizontal overflow anywhere, one `h1`
each, zero broken images, and zero HTTP responses ≥ 400 while browsing.** The
only failed requests at either width are `net::ERR_ABORTED` on Next's `?_rsc=`
prefetches, which is a navigation cancelling a prefetch, not an error. The
manifest still says "Gift Planner" with `id`, `start_url` and `scope` all `/`
and **all four icons 200**, alongside `favicon.ico`, `icon.png`,
`apple-icon.png`, `sw.js` and `/offline`. The five deleted SVGs now return
**404, and no page requests them** — the only 404 in the console is the probe
that asked for one on purpose.

**Protected fingerprint after live QA: identical to the baseline** —
notifications 37, people 19, events 15, appMembers 4, recipients 35, Christmas
2026 active with 19 recipients, `crossAreaTotal` 0. Nothing was written.

**Handed to Q18:** three live, correct duplicates — `priceInput` in **four**
files, `progressPresentation` in two (byte-identical), and `todayInput` in two.
All are money or date formatting, so each wants its own test rather than a
drive-by edit. `events-dashboard.tsx`'s deliberately different status wording
("Complete" where the people screens say "Budget reached") must be decided
before `progressPresentation` gets a home.

## Q16 — shadcn/Radix is the canonical UI primitive system

`docs/Q16-SHADCN-CANONICALIZATION.md` is the audit and the primitive matrix.
Read on demand. **No database change; migrations still end at 051.**

**No duplicate generic primitive was found — the count is zero.** Every
Radix import in the repository (11 files) is inside `src/app/components/ui/`;
not one screen or product component reaches past the wrappers. There is one
focus-trap mechanism, Radix's, and one Escape mechanism. The one global keydown
listener in the app is the command palette's ⌘K.

**What Q16 actually removed was stale documentation, not a parallel system.**
`SHADCN-UI.md` had described `notification-bell.tsx` as a hand-rolled panel with
its own focus-return for four phases after **Q13 rebuilt it on the shared Radix
`Dialog`**. Two of Q14's three UI findings were also wrong: the "two icon
systems" are one — `icons.tsx` imports from `lucide-react` and is a named
catalogue over it, not a rival — and the `Select` naming collision dissolved
when the unused half was deleted.

Changes, all UI-only:

- **Deleted `ui/select.tsx`** (zero importers of any kind; `SHADCN-UI.md` §11
  had said to delete it at the next audit) and **`use-mounted.ts`** (zero
  importers since Q13). Deleting the first leaves exactly one `Select` in the
  codebase, so **no rename was needed and 11 call sites were left alone.**
- **Three hand-spelled form fields became `Field`** — two in `create-area-form`,
  one in `family-settings-screen`, each of which was reproducing `Field`'s own
  markup down to its `mt-2` spacing. Their labels move `text-ink-700` →
  `text-ink-900`, converging on every other form label in the app.
- **Six lucide glyphs gained `aria-hidden`**, all in stock registry files
  vendored after that convention was written. Found by the new test, not by eye.

**`scripts/ui-primitives.test.mjs` is what stops it growing back** — 13 tests
holding four invariants: Radix only inside `components/ui/`; no hand-written
`role="dialog"`/`aria-modal` and no hand-rolled Tab or Escape handler; `Select`
renders a real `<select>`; every lucide glyph carries `aria-hidden`. Mutations
`Q16-1`…`Q16-4` put each defect back and all four are killed behaviourally.

Kept deliberately, with reasons in the audit: `FinancialProgressBar` (domain
state, not a `Progress` duplicate), `BottomTabs` (navigation, not a tablist),
`components/popover.tsx` (a wrapper that keeps `Menu` and `Popover` apart), the
native `Select`, and one raw `<button>` in `global-error.tsx`.

**Handed to Q17, and both now settled:** the five unreferenced starter SVGs are
deleted, and the `*-taylor*` scripts are kept as live operator tooling with one
narrow question left for the user (see Q17 above).

**Live QA on Worker `7797eb98`, Edge, entirely read-only.** Desktop 1440×900:
seven screens, no horizontal overflow, one `h1` each, **zero controls without an
accessible name**. The migrated Family-name field wraps its input, is named
exactly "Family name" — the policy paragraph correctly stays out of that name —
and is 48px tall at 16px. The account menu opens with 8 items and **zero
unhidden SVGs**, which is the `aria-hidden` fix visible in production. Q13's
bell is untouched: `aria-modal="true"`, named "Notifications", 352×448, focus
inside, **0 escapes in 12 Tabs**, Escape returns focus to the bell.

Mobile 390×844 at DPR 3, `mobile: true`, 5 touch points, coarse pointer: seven
screens with no overflow, the field still 48px/16px and inside the viewport, the
bottom nav 390 wide with three 125×51 targets, and the bell opened by a genuine
`Input.dispatchTouchEvent` as a 390×633 bottom sheet, full width, bottom flush,
fully on screen, focus inside, scrim over the viewport. Identical to Q13's
numbers.

**Protected fingerprint taken before and after: identical, and identical to the
baseline** — notifications 37, people 19, events 15, appMembers 4, recipients
35, Christmas 2026 active with 19 recipients, `crossAreaTotal` 0.

## Migration 051 — applied, and verified against production

`supabase/migrations/202608100051_drop_superseded_routines_and_narrow_table_grants.sql`
(SHA-256 `0760ce5d…12f369`) was applied manually in the Supabase SQL Editor on
2026-08-30 and **verified against a production `pg_dump` taken afterwards**
(backup run `33330291190`, 19:15:14Z).

It did two things. It dropped `is_family_contributor_member`,
`save_christmas_recipient` and `save_recipient_contributions` — three routines
with no caller of any kind, each proved by a clean `DROP … RESTRICT` in a
rehearsal first. And it narrowed `authenticated` on `areas` to `SELECT` and on
`birthday_wishlist_ideas` to `SELECT, INSERT, UPDATE, DELETE`.

**Why the grant half mattered.** Those two tables were the only ones in the
schema still carrying Supabase's blanket default grant, which includes
**TRUNCATE — and row level security is never consulted for TRUNCATE**. Measured
in a rehearsal before the fix: an ordinary member truncated
`birthday_wishlist_ideas` and destroyed three Areas' wishlists, including an
Area they were not acting in. It was never reachable through PostgREST, which
has no TRUNCATE verb, so nothing was ever at risk — but the protection was the
client protocol rather than the grant, and `areas` was shielded only by an
accident of its foreign keys.

**Production diff, whole:** eleven `GRANT`/`REVOKE` lines. Seven belonged to the
three dropped routines and went with them; the two blanket table grants became
two narrow ones. Functions 96 → 93. Policies, triggers, indexes and RLS all
unchanged. **`data_rows` 1,111 → 1,111 and `data_bytes` byte-identical** — the
migration reads and writes no row, and the two dumps prove it.

`docs/Q15-051-POST-APPLY-CHECKS.sql` is the read-only re-check (18 checks, FAIL
rows sort to the top). `docs/Q15-051-ROLLBACK.sql` undoes it — read its header
first: half of it deliberately re-opens the hole.

**The rule that stops this recurring** is `scripts/table-privileges.test.mjs` §4.
It names no table: it sweeps every table in `public` and fails if any of them
hands a browser role anything beyond the four DML verbs. Mutation `051-2` puts
that defect on a third table and is killed by that sweep.

## Q15 — the database audit behind that migration

`docs/Q15-DATABASE-CANONICAL-SYSTEM.md` is the audit. Read on demand. Its §8
proposal has since been written, rehearsed, applied and verified — that is
migration 051 above, so read §8 as history rather than as a pending decision.

**Gift Planner has exactly one authoritative database system per business
concept.** Every concept was checked — Areas, identity, membership, admin,
contributors, events, recipients, budgets, gift ideas, purchases, allocations,
settlements, receipts, notifications, audit, settings, birthdays and privacy.
**No competing or duplicate active path was found anywhere.** The multi-object
subsystems (three notification tables, three contributor layers) are stages and
layers of one system, not rivals.

**The security finding it raised is now closed** by migration 051 above. Q15
found `authenticated` holding `TRUNCATE` on `areas` and
`birthday_wishlist_ideas`; 051 took it away and
`scripts/table-privileges.test.mjs` now holds that shut.

**One Q15 claim turned out to be wrong, and the correction is worth keeping.**
Q15 predicted that dropping `is_family_contributor_member` would make mutation 9
die of "undefined function". It would not have. Mutation 9 edited migration
**039**, but **047 redefines `set_person_birthday`** — so the mutant never
reached the schema the tests query, and what killed it was 039's own apply-time
*text* assertion, which 039 admits in its own comment is a text check because it
"needs two Areas and a login in both, and this block creates none". The fixtures
do create exactly that. Mutation 9 now breaks the live definition in 047 and is
killed behaviourally by `a plain member cannot`. **The lesson generalises: a
mutation aimed at a migration that a later migration overwrites is testing
nothing.**

Confirmed REQUIRED, not legacy: **`events.year`** carries the "one Christmas per
family per year" unique index and two check constraints. The **`christmas_events`
view** is a `security_invoker` read convenience over `events` with no independent
state — not a second source of truth. **`app_members.contributor_id`** is legacy
but live: frozen since migration 004, five readers, every one with a `person_id`
fallback.

## Q14 — the inventory

`docs/Q14-SYSTEM-INVENTORY.md` is the map later cleanup phases work from. It is
read-on-demand; do not load it unless a phase needs it. **Q14 changed no runtime
code, no migration and no production data** — the whole database inventory came
from replaying the fifty committed migrations into a disposable PGlite and
querying the resulting catalogues, so it records the end state rather than the
sum of what the migrations say they do.

Headlines: 22 tables, 1 view, 96 application functions (93 `SECURITY DEFINER`,
25 of them trigger functions, 60 reachable over PostgREST), 37 RLS policies, 61
triggers, 77 indexes. On the app side, 31 page routes, 13 route handlers, **no
server actions and no middleware** — every write is an RPC or a route handler.
172 of 174 production source files are reachable from a route.

Three DB routines have no caller in the final schema —
`is_family_contributor_member`, `save_christmas_recipient`,
`save_recipient_contributions` — **all three dropped by migration 051**. Two app
files have no importer, `components/ui/select.tsx` and
`components/use-mounted.ts` — **both deleted by Q16**. Five starter SVGs in
`public/` were referenced nowhere — **deleted by Q17**.

Of Q14's four unknowns, **Q15 settled two** — the wide grants are Supabase
default-privilege residue and are broader than needed, and the Q12 post-apply
checks had in fact already been run and passed — and **Q17 settled the third**
as far as the repository can: the `*-taylor*` scripts are live operator tooling
and are kept. One stays open: **which indexes production actually uses**, which
needs a read-only production connection.

**`CLAUDE.md`'s migration range said 001–047. It is now 001–051.**

Q13 closed the four product-quality gaps the final site audit left open, and
proved on the live site the one thing Q9, Q10, Q11 and Q12 each had to record as
NOT RUN.

## What Q13 fixed

- **The Notification Centre now traps focus.** It announced `role="dialog"` and
  then let Tab walk out of it into a page that was still fully interactive
  behind a scrim saying otherwise. It is a Radix `Dialog` now — the foundation
  `Modal`, the command palette and the account menu already stand on — so the
  trap, `aria-modal`, Escape, and the return of focus to the bell all come from
  one place. `useMounted` and `createPortal` are gone with it.
- **The breadcrumb has a 44×44 target.** Its own box was 16px tall, under WCAG
  2.2's 24px floor. `.touch-target` in `globals.css` grows the HIT AREA with a
  pseudo-element and leaves the 12px type alone, so nothing moves. Same
  technique `ui/switch.tsx` already used for its own control.
- **`/people/<id>` no longer skips a heading level.** The admin cards are the
  first sections under the page's `h1`, so they are `h2`. `text-lg` stays: the
  level answers "what is this part of", the class answers "how loud is it".
- **One ellipsis, spelled one way.** Thirty-nine user-facing `...` became `…`,
  which was already the majority convention. Spreads, comments, an abbreviated
  SQL statement and a quoted database error are untouched — none is prose.

## Why the bell needed rebuilding rather than patching

There is one `Dialog.Content` per dialog, and it is the thing focus is trapped
inside. The two shapes used to be rendered together and hidden from each other
with `hidden sm:flex` / `sm:hidden`, and a hidden second Content is still a
second dialog with its own trap. So the breakpoint is read once through
`matchMedia` and `useSyncExternalStore` — the pattern `useFestive` and
`usePwaInstall` already use — and only the matching shape is built.

Two details are load-bearing and were verified live:

- **The phone sheet is still portalled and the desktop dropdown still is not.**
  The header's `backdrop-blur-md` makes it a containing block for `fixed`
  descendants, which is what once pinned the sheet inside a 64px strip. The
  dropdown is `absolute` against the trigger's own `relative` wrapper, a nearer
  positioned ancestor, and was never affected.
- **The dropdown deliberately has no overlay.** In Radix's Dialog the SCROLL
  LOCK lives on the overlay, and this shape never locked the page. Closing on an
  outside click does not need one: the content's own dismissable layer listens
  on the document.

## The celebrant's live view — NO LONGER OUTSTANDING

Q9, Q10, Q11 and Q12 each recorded `NOT RUN — SECOND IDENTITY REQUIRED` for
proving in a browser that a birthday celebrant sees none of their own birthday.
**No second identity was needed.** The signed-in human is `Robin QA Charlie` in
the QA Charlie Area — an Admin *and* a Contributor *and* a celebrant, which is
the hardest case there is. Read-only, on `xmas-family.uk`:

- their own person page draws "You can't view your own birthday gifts", and its
  Gift history lists QA Mother's Day, QA Live Q4 Custom and QA Shadcn Desktop
  Check — **their own birthday event is absent**, while Sam's page, viewed by
  the same reader, does show "🎂 Sam QA Charlie's Birthday";
- `/birthdays` shows Sam's card with "Budget £30 · Open planning" and their own
  card with **neither** — no budget, no planning entry;
- `/more/activity` renders 262 lines and 41 money figures, and the only
  birthday line names **Sam**, not the reader. That is migration 050's effect,
  proven by a real celebrant in a real browser;
- the notification inbox carries gift ideas for Sam and for Taylor and seven
  "You owe Paige" rows, and **nothing about the reader's own birthday**.

Being the Area's admin did not help them, which is the invariant.

## Verification state

- Full regression **1,939 tests, all passing**. Q19 added 190: the 147 of
  `global-approval`, the 18 of the rollback rehearsal, the doc-file tests, and
  the per-migration tests that grow with the chain.
- Mutations **162/162 caught, zero survivors** (145 + Q19's 17). Sixteen of the
  seventeen are killed by a **named behavioural assertion**; the seventeenth
  (the backfill's confirmed-email rule) also fails seven named tests, and the
  harness simply reports the stronger signal — 052's own end-state block
  refusing, which is a data assertion against real rows rather than a parse or
  build failure.
- **Every Q19 mutation leaves the migration applying cleanly.** 052's end-state
  block looks for each gate *by name*, so a mutation that deleted one would be
  caught by the migration and would prove nothing about the tests. They keep the
  string and break the meaning — `X` becomes `(X or true)` — leaving behaviour
  as the only thing that can notice.
- **Q2-8 and Q2-9 were re-aimed at 052**, which now redefines `create_area` and
  `is_area_member`. Left alone they survived: the mutant never reached the
  schema. Same failure mode Q17 fixed for 047, same fix.
- Migrations **001–051 were byte-identical before and after every mutation run**,
  and 052 was restored exactly. Hashed and compared, not assumed.
- Previously, at Q18: full regression 1,749; mutations **145/145 caught**. **130 are killed by a named
  failing test** (Q18's four are all behavioural) and 15 by a migration's own
  end-state block — and after Q17 every one of those 15 edits an object that is actually
  installed, so the block is querying the resulting schema rather than comparing
  a migration with its own text. **Zero mutations target a superseded
  definition**; Q17 re-checked all 141 and re-pointed the four that did.
- TypeScript, ESLint, production build and worker bundle all clean.
- `scripts/interface-polish.test.mjs` is new and renders the bell into a real
  DOM, because a focus trap is behaviour: **12 of its 14 original assertions
  fail against the previous implementation**, and the two that pass are Escape
  and focus return — exactly what the old limitation said already worked.

## Protected baseline

Taken before deployment and again after all live QA. **Identical, and identical
to Q12's.** Nothing was written to the real family; every live check was a read.

| Field | Value |
| ----- | ----- |
| `realFamilyNotifications` | **37** (includes the historic 8 leaked Q4 rows) |
| `people` / `appMembers` | **19 / 4** |
| `events` / `recipients` | **15 / 35** |
| Christmas 2026 | active, **19** recipients |
| `crossAreaTotal` | **0** |

## Live QA

Microsoft Edge over CDP, in the already-signed-in session, against
`xmas-family.uk` on Worker `2cd2ad03`.

**Desktop (1440×900).** Focus enters the panel on open; twelve Tabs and eight
Shift+Tabs never leave it; Escape closes it and focus returns to the bell.
`aria-modal="true"`, named "Notifications", dropdown 352×448 anchored under the
trigger. Activity: 75 entries, 41 money figures, no raw table names, no error
text. Breadcrumb: own box 16px and 12px type, but the hit test succeeds 21px
above and below its centre and fails at 30px — a real 44px target. Heading
outline h1 → h2×6 → h3 → h4, no skips, one `h1`. No document overflow.

**Mobile (390×844, DPR 3, `mobile: true`, touch on).** `innerWidth` 390,
`innerHeight` 844, `devicePixelRatio` 3, `maxTouchPoints` 5, coarse pointer.
Opened by a genuine `Input.dispatchTouchEvent`, the sheet is portalled out of
the header, full width, bottom flush with the viewport, 633px tall and entirely
on screen, with a scrim covering the viewport and a list that scrolls inside
itself. The trap holds here too. Bottom nav unaffected: 390 wide, three 125×51
targets. No document overflow on home, people, person, owed or birthdays.

**The `/more/activity` filter strip is not an overflow.** Six chips sit wider
than the viewport, every one of them inside a `overflow-x: auto` div, and the
document's `scrollWidth` equals its `clientWidth`. That strip is meant to scroll.

**Accessibility sweep, seven live screens.** No interactive control without an
accessible name, no nested interactive controls, no `tabindex="-1"` traps, one
`h1` each. The only sub-24px box is the Falling snow switch's visible track,
which already carries its own 44×44 `before:` hit area.

**Branding.** Favicon 200, apple-touch-icon 200, manifest "Family Gift Planner"
with all four icons 200. No Christmas-tree references in the head. That name is
the one the rename below replaced; the icons are unchanged.

## After Q13 — the brand rename

The product is called **Gift Planner**. It had been called three things at once:
"Family Budget" on the desktop rail, "the Christmas app" in two account-setup
messages and the family-access role card, and "Family Gift Planner" everywhere
else. All of them now say Gift Planner — manifest `name` and `short_name`, the
browser tab, the iOS Home Screen title, the auth wordmark, the install card, the
push-notification fallback, the offline page, and the sticky bar's fallback for
a path no route claims.

**The installation was relabelled, not replaced.** `id`, `start_url`, `scope`,
both colours and all four `-v2` icon paths are byte-for-byte what they were, so
an existing Home Screen install keeps its place and its green tile. Nothing in
the domain moved: `Our family`, Areas, Christmas 2026, the tree ornament and the
`christmas-budget` push tag are vocabulary, not the product's name.

**Guarded by `npm run test:brand`.** A name has to be spelt out at every surface
that shows it — a manifest cannot import a constant, and neither can a static
offline page — so `scripts/app-brand.test.mjs` scans everything the app ships and
fails on any of the three retired names, comments included. Proved to fail: it
was run against a deliberately reverted manifest name and rail wordmark and
caught both.

**Verified live** on `ea1ccdad` in Edge, desktop 1440x900 and a genuine 390x844
CDP viewport at DPR 3 with touch. Tab title, manifest, all seven icon URLs 200,
sticky bar naming the screen at both widths, rail hidden at 390, no retired name
in any DOM, no horizontal overflow on the dashboard, People, Birthdays, Settings,
Family settings, Notifications, Account or the auth screen. The signed-out login
eyebrow is source-verified only: `/login` redirects an authenticated session to
`/`, and signing the family out to look at it is not allowed.

## Accepted state and open risks

- Nothing blocking. Everything below is non-blocking and was judged, not missed.
- **Settlement browser E2E is still `NOT RUN — SECOND IDENTITY REQUIRED`.** It
  needs a payer and a receiver at the same time. The browser holds exactly one
  authenticated session and one Supabase auth cookie, and the rules forbid
  asking for anybody's password or signing the user into a synthetic account.
  Not a blocker: Q12 proved settlement authorization at the database layer,
  including that the Area admin is explicitly refused as a confirmer.
- **`docs/Q12-POST-APPLY-CHECKS.sql` HAS been run against production**, in the
  SQL Editor after migration 050, and every check passed. Q14 recorded the
  opposite; that was Q14's error and Q15 corrected it. Results in
  `docs/Q15-DATABASE-CANONICAL-SYSTEM.md` §2. No re-run needed.
- The notification bell is deliberately **account-global** and stays that way.
- The 8 protected notification rows are historic Q4 evidence. Do not clean up.
- The 26 Area-less audit rows stay Area-less. Do not backfill them.
- The 154 audit rows marked `birthday_privacy_unknown` are hidden from
  everybody, deliberately. Do not try to recover them.
- `rls_auto_enable` is Supabase platform state. **Do not drop or adopt it.**
- `no-store` on documents means every back/forward navigation refetches.
- Twelve trigger functions still carry `anon` EXECUTE from the platform default.
  Harmless: PostgreSQL refuses to invoke a trigger function directly (`0A000`).
- **The lockfile question is closed.** pnpm is the package manager,
  `pnpm-lock.yaml` is the only lockfile, and `package-lock.json` is deleted —
  see Q18 above. This working copy's `node_modules` was installed by **npm**
  and was deliberately not reinstalled; it resolves the same `lucide-react`
  1.33.0 the frozen pnpm install does. A future `pnpm install` here is safe but
  was not needed to prove the lockfile.
- **The serving Worker version for Q18 is unrecorded.**
  `wrangler deployments list` was blocked by the sandbox classifier, so the
  version id could not be read. The push deployed and the live site was verified
  end-to-end; if the id matters, read it from the Cloudflare dashboard.
- `birthday-wishlist.test.mjs:194` still asserts the body of
  `is_family_contributor_member`, which **migration 051 dropped**. It reads
  immutable migration text so it cannot fail, and `table-privileges.test.mjs`
  holds the stronger invariant that the routine is gone. Kept deliberately —
  removing it would cut the test count without removing a risk.
- The four limitations Q13 closed are gone from this list on purpose. Each is
  now held by a mutation (`Q13-1`…`Q13-4`) that puts the exact defect back.

## Starting the next phase

**The next phase begins with a decision only you can make: which Category A
uuid becomes the first Gift Planner administrator.** Nothing in Q19 part two can
start before that.

In a **fresh** Claude session (Opus 5, High):

> Read `CLAUDE.md` (loaded automatically) and `docs/CURRENT-STATE.md`. Read
> `docs/SECURITY-AND-QA.md` if this phase touches security, data or live QA.
> Then execute this phase. \<phase prompt\>

**Q19's work is still held back, and 052 being applied is no longer the reason.**
The database is now ahead of the repository, which is the safe direction. What
holds the push is that the sign-up runtime is unbuilt: pushing `main`
auto-deploys, and the right moment to deploy is once the runtime exists and has
been reviewed, not before. Q18's closeout commit rides along with it.

**Q17's two open questions are both answered and closed** — pnpm is the package
manager, and the `*-taylor*` scripts were unwanted and are deleted. Q18 leaves
no question that only the user can answer.

## Roadmap Phase 3 — migration 053 written and rehearsed, NOT applied

**Verdict: `PHASE 3 CONDITIONAL PASS`.** 053 is written, applies cleanly to a
disposable PostgreSQL, passes its own end-state block and its post-apply checks,
rolls back and re-applies. **It is not applied to production and must not be
until the thirteen pre-053 test assertions listed below are updated.**

| Fact | Value |
| ---- | ----- |
| Migration file | `supabase/migrations/202608100053_family_invitation_consent.sql` |
| Applied to production? | **NO.** Production still carries 001–052 only. |
| Rehearsal environment | PGlite (real PostgreSQL 18, WebAssembly), `scripts/pg/rehearsal.mjs`. In-process, thrown away per suite. **Never production; no production connection was opened in this phase.** |
| Post-apply checks | `docs/Q20-053-POST-APPLY-CHECKS.sql` — 30 checks, 0 FAIL on the rehearsal DB |
| Rollback | `docs/Q20-053-ROLLBACK.sql` — executed in full, 0 FAIL, and 053 re-applied on top |
| New tests | `scripts/family-invitations.test.mjs` (62 pass) and `scripts/family-invitations-rollback.test.mjs` (12 pass) |
| Migrations 001–052 | untouched; the checksum manifest still matches |

### What 053 changes

`app_members.declined_at` + `app_members_declined_is_unclaimed` (CHECK, `not
valid`) + `app_members_open_invitation_idx` (partial). Four routines added —
`list_my_family_invitations()`, `accept_family_invitation(uuid)`,
`decline_family_invitation(uuid)`, `record_invitation_delivery(uuid, text)`.
Four redefined — `refuse_foreign_area_write()` gains one decline exemption,
`grant_area_access` clears `declined_at`, `list_area_access` returns it
(dropped and recreated, because the return type widens), and
`claim_app_member()` becomes `select false`. No policy, no backfill, no expiry,
no widening of `audit_log_action_check`, no grant to `service_role`.

### THE BLOCKER — thirteen assertions still describe the pre-053 world

053 sits in `supabase/migrations/`, and `buildRehearsal()` reads that directory,
so every suite now builds on a 053 database. Thirteen assertions across six
files still assert the auto-join, or count migrations, or inventory routines:

- `migration-execution.test.mjs` — "052 is the newest" (52 → 53), the replay
  list, and the RLS-enable sweep.
- `global-approval.test.mjs` — the `claim_app_member` section (four cases), and
  `claim_app_member() stopped being SECURITY DEFINER` (it is now
  `language sql immutable`, as the design specifies).
- `area-lifecycle.test.mjs` — "claiming an invitation", "one login must never
  hold two seats in one family".
- `area-mutation-security.test.mjs` — **the one worth reading.** Its inventory
  flags the three invitee routines as "neither derives its target Area nor calls
  the guard". That is correct and deliberate: they read no acting Area at all
  (design §14 #19), and they authorize on the caller's own confirmed address
  instead. The test needs an allowlist entry naming that reason, not a change to
  the migration.
- `account-approval-gate.test.mjs`, `rls-security.test.mjs` — the same shapes.

**None of the thirteen is a defect in 053.** All are tests that pinned the
behaviour 053 exists to remove. They must be updated — and the whole suite
green — before Phase 4 applies anything to production.

### Also outstanding before Phase 4

- **The production read-only precheck was not run.** Confirm from production
  that migrations stop at 052 and count open unclaimed invitations
  (`user_id is null and active and declined_at is null` — the column does not
  exist there yet, so the first two conjuncts) before applying. Section 5 of the
  post-apply file does that census without selecting an address.
- **One deviation from the design, recorded:** §13 wanted an
  `invitation_reissued` audit row carrying `{previous_state}`. 053 relies on the
  existing `record_audit_event` trigger, which already reports the
  inactive→active crossing as `restored`, Area-attributed. Adding an explicit
  row would have written two audit rows for one event. The reissue is audited;
  the `previous_state` detail is not stored.

## Roadmap Phase 3B — the twenty stale assertions, and the production preflight

**Verdict: `PHASE 3B PASS`.** The full suite is **2115/2115, 0 fail** against a
database carrying 001–053. Production was inspected read-only and is still on
052. **053 remains unapplied.**

> **Superseded.** 053 was applied in Phase 4. See "Roadmap Phase 4 and 4B"
> above for the current state.

### The Phase 3 blocker said thirteen. The suite said twenty.

Phase 3 counted assertions by reading the six files it knew about; running
`npm run test:all` found **twenty failing tests across eight files**, including
three the report never named. All twenty were tests pinning the world 053
exists to change. **Not one was a defect in 053, and not one security rule was
relaxed to make it pass.**

| Category | Where | Old invariant | New invariant |
| -------- | ----- | ------------- | ------------- |
| **Migration inventory** (6 tests) | `migration-execution` ×2, `event-model`, `event-administration`, `birthday-wishlist`, `rls-security` | 052 is the newest; there are 52 migrations; every positional offset counts back from 052 | 053 is the newest; there are 53; every offset moved together by one, and 053 is named with a review note saying what it adds — one nullable column, four routines, no table, no policy, no grant to `anon` or `service_role` |
| **Sign-in no longer joins you** (7 tests) | `area-lifecycle` ×3, `global-approval` ×4 | `claim_app_member()` attaches the caller to every open invitation addressed to their confirmed address, in every family, on every sign-in | Signing in joins nobody. Membership begins with `accept_family_invitation(uuid)` naming **one** invitation, and every old refusal — unconfirmed address, revoked seat, somebody else's row, a second seat in a family they are already in — is now asked of the routine that can actually write |
| **`claim_app_member()` is not a definer** (1 test) | `global-approval` | all **nine** routines 052 redefined are pinned SECURITY DEFINERs | **eight** are. The ninth deliberately is not — see below |
| **The pre-member exemption** (1 test) | `area-mutation-security` | *every* authenticated mutation either derives its target Area or calls `require_acting_area()` | the blanket rule is unchanged; two routines are allowlisted **by name, with a reason, and with a test that makes them earn it** |
| **Post-apply files, run out of their era** (5 tests) | `production-checks` ×5 | Q3's, Q6's and Q19's check files are run against the *full* migration stack | each is run against **the database its own migration produced** — Q3 at 045, Q6 at **052** (its drift sweep names 052's routines, so "against a 047 database" was already stale), Q19 at 052. That is the state production is in, and each file must still pass completely there |

### `claim_app_member()` stays a non-definer stub. Deliberately.

Restoring SECURITY DEFINER to satisfy the old catalogue expectation was
**refused**. The privilege existed to let the routine write `app_members` on the
caller's behalf; 053 removed that write, so nothing justifies it any more.

It cannot simply be dropped either: the deployed Worker's auth callback still
calls it on every sign-in, and a missing routine would be an error on the way in
rather than a no-op. So it stays — reachable and inert.

A new focused test asserts this **in the positive**, so restoring the privilege
fails loudly: not a definer; `language sql`; the body is `select false` and
mentions no `update`, no `insert into`, no `delete from`, not even
`app_members`; `authenticated` can still execute it and `anon` cannot; and a
signed-in stranger calling it leaves the count of attached seats unchanged.
`service_role` keeps execute from Supabase's own default privileges, as it does
for every routine in this schema — 053 grants it nothing new.

### The `require_acting_area()` exception is two names wide

`accept_family_invitation` and `decline_family_invitation` are allowlisted in
`scripts/area-mutation-security.test.mjs`. The guard is not merely unnecessary
for them, it is **unaskable**: an acting Area can only be claimed by an existing
member, so it would refuse every caller these routines exist for.

What stands in for it is narrower, and a new three-test block proves it against
the catalogue and against a real call:

- each takes **exactly one uuid** (`p_invitation_id uuid`) — no email
  parameter, no user uuid parameter;
- the caller comes from `auth.uid()`, the address from `auth.users`, and only
  with `email_confirmed_at is not null`;
- `m.id = p_invitation_id` **alongside** `lower(m.email) = caller_email`, never
  instead of it — the id **selects**, the address **authorizes**;
- neither mentions `acting_area`, and the Area is read **off the selected row**;
- both are still pinned definers with a pinned `search_path`, unreachable by
  `anon`;
- and cross-Area targeting is proved impossible behaviourally: an account
  genuinely invited to Bravo, **handed the id** of an open Alpha invitation, is
  refused by both routines, and the Alpha row is left unclaimed, undeclined and
  active.

The blanket rule still covers every other Area-scoped mutation.

### Reissue → `restored`. One audit row, and no second one added.

Confirmed and left as 053 wrote it. A reissued invitation crosses the `active`
boundary, `record_audit_event` already reports that crossing as a single
Area-attributed **`restored`** row, and adding an explicit `invitation_reissued`
row would have written two audit rows for one event. The audit action vocabulary
is **not** widened. The mapping is:

> product event **invitation reissued** → canonical audit action **`restored`**

`scripts/family-invitations.test.mjs` holds it: exactly one row, correct Area,
correct target, no duplicate, no address or other sensitive metadata in it.

### Test totals

| Run | Result |
| --- | ------ |
| Full regression, `npm run test:all` | **2115 pass / 0 fail**, 284 suites, ~42 s |
| Before reconciliation, same command | 2111 pass / **20 fail** |
| `family-invitations` + rollback | 62 + 12, unchanged and still green |
| Migrations 001–040 checksum manifest | matches; **no applied migration edited** |
| Migration inventory | 053 is newest; **no 054**; 041–053 correctly unpinned |
| Mutation suite | **NOT RUN.** No migration and no runtime source changed — only test definitions. One residual noted below |

### Production read-only preflight — 2026-08-31 17:11 UTC

GET only, service key, PostgREST. No RPC was invoked and nothing was written.

| Check | Result |
| ----- | ------ |
| `app_members.declined_at` | **absent** — `column app_members.declined_at does not exist` |
| 053's four routines exposed | **none** of them |
| `claim_app_member` exposed | yes — the 052-era routine, as expected |
| Migration state | **001–052 only. 053 IS NOT APPLIED.** |

**Protected fingerprint — unchanged, every value:** notifications 37, people 19,
events 15, appMembers 4, recipients 35, Christmas 2026 active with 19
recipients, `crossAreaTotal` **0**.

**QA Area census — all five Areas present, none deleted:** `Our family`,
`QA Alpha`, `QA Bravo`, `QA Charlie`, `Tricketts`. None archived. The cleanup
hold stands for the QA Areas. **Tricketts is not a QA Area and must never be
deleted in QA cleanup** — see the correction at the top of this page.

**Unclaimed invitation census — RUN, and safely.** Classified **by Area id
only**; no address was selected or printed. Production holds **one** open
unclaimed invitation (`user_id is null and active`), and it is in
**`Tricketts`** — recorded here as a throwaway, which was wrong. **Zero in `Our family`, and zero
unexpected non-QA invitations.** 12 `app_members` rows across all five Areas.

### The one residual, and it is not a blocker

The mutation suite was not run, and one target is worth naming: a mutation that
stripped `security definer` from `claim_app_member` **in 052** was previously
killed by the nine-definer assertion. It no longer can be — but not because of
anything Phase 3B changed. 053 redefines that routine as a non-definer on top of
052, so on a full-stack rehearsal the mutation is invisible whatever the tests
say. The 052-era version of that assertion is still enforced, against a 052
database, by `docs/Q19-052-POST-APPLY-CHECKS.sql` in `production-checks`.

### Exact Phase 4 scope

1. Apply `supabase/migrations/202608100053_family_invitation_consent.sql` to
   production **manually**, as every migration before it.
2. Run `docs/Q20-053-POST-APPLY-CHECKS.sql` — 30 checks, 0 FAIL expected.
3. Re-take the protected fingerprint and confirm all seven values unchanged.
4. `docs/Q20-053-ROLLBACK.sql` is the escape hatch, rehearsed in full.
5. **Only then** push the local commits, because nothing in the runtime depends
   on 053 yet — the invitation UI is a later phase.

**Not done in Phase 3B, deliberately:** no apply, no push, no deploy, no runtime
or UI change, no QA Area deleted, no invitation UI.
