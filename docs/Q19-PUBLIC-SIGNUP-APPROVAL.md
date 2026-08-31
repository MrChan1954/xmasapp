# Q19 — Public sign-up, global approval and Area onboarding

The record of migration 052 **and of the runtime it made possible**.

**052 is applied and verified in production, and Gift Planner has one global
administrator.** The runtime is **built, tested and held locally** — not pushed,
not deployed. **Public sign-up is still OFF in the Auth project and Confirm
Email is unchanged**, so nobody can reach `/sign-up` yet and no confirmation
email has ever been sent.

The launch checklist is at the end of this document.

---

## The one sentence

Being able to sign in stops being the same thing as being allowed in.

```
auth.users            you can sign in
  → app_accounts      a human has approved you for Gift Planner
     → app_members    a family has invited you into it
        → role        what you may do inside that family
```

Everything Q10–Q18 built — Area isolation, acting-Area semantics, birthday
privacy, settlement authority — is untouched. It now sits behind one more door.

---

## Why it was needed

Sign-up was never public, so "has an `auth.users` row" and "belongs here" were
the same population and the database never had to tell them apart. The moment
anybody on the internet can create an account, every routine that asked only
*are you signed in?* is answering the wrong question.

`create_area` was the sharp one. It let **any** signed-in account create a
family, name itself that family's administrator, and start writing.

---

## What 052 contains

| | Count | |
|---|---|---|
| New table | 1 | `public.app_accounts` |
| New routines | 10 | see below |
| Redefined routines | **9** | six by design, **three found by rehearsal** |
| Policies changed | 2 | one replaced, one added |
| Constraint widened | 1 | `audit_log_action_check` |
| Rows created | backfill only | derived, never listed |

### The table

`public.app_accounts` — one row per Gift Planner account, upstream of every
Area. **RLS on, zero policies, and not one privilege for `anon` or
`authenticated`.** A browser never reads it; status arrives through
`my_account_status()` and the queue through `list_accounts()`.

**A missing row means NOT APPROVED.** Fail-closed is the whole design.

The three refused states are not interchangeable in the catalogue, even though
they behave identically at the door:

| State | Row? | `status` |
|---|---|---|
| undecided / never reviewed | usually **none** | — (reads as `pending`) |
| rejected | **yes** | `rejected` |
| suspended | **yes** | `suspended` |

### The ten new routines

`is_globally_approved()` · `is_global_admin()` · `my_account_status()` ·
`list_accounts(text)` · `set_account_status(uuid, text, text)` ·
`grant_global_admin(uuid)` · `revoke_global_admin(uuid)` ·
`grant_area_access(uuid, text)` · `revoke_area_access(uuid, boolean)` ·
`list_area_access()`

Every one: SECURITY DEFINER, `search_path` pinned to `''`, fully qualified,
explicit authorisation, revoked from `public`/`anon`, granted to
`authenticated`. Measured in the catalogue, not assumed —
`scripts/global-approval.test.mjs` asks `has_function_privilege` about each.

### The nine redefinitions

Six were named in the approved design:

`is_active_app_member()` · `is_area_member(uuid)` · `is_area_admin(uuid)` ·
`create_area(text, text)` · `claim_app_member()` · `stamp_audit_area()`

**Three more came out of the rehearsal**, and they are the most interesting
thing in this phase.

---

## The three findings

### 1. `is_own_app_member` — a real leak, closed

The approved inventory gated the three *Area* predicates. It missed the fourth
membership predicate, which keys on an `app_member_id` rather than an `area_id`
and therefore gates `notifications`, `notification_preferences` and
`push_subscriptions` — **the three tables an Area-shaped sweep does not look
at.**

Measured on a database carrying 052 without this redefinition, an account set
to `rejected` while holding a claimed active membership:

```
rejected   notifications= 1   prefs= 1   push= 1
```

A notification row carries the gift itself — title and body, e.g. *"Surprise
weekend away"*. So the approved rule *"pending, rejected and suspended are
blocked from ALL Area data at the database layer"* **was not true with six
redefinitions.** It is with seven.

### 2. `is_app_admin` and `is_area_contributor_member` — found by a survivor

The first mutation run reported **one survivor**: taking the approval gate off
`is_area_admin` broke nothing any test could see. The reason was a hole in the
tests, not the migration: every test that suspended an account suspended an
ordinary **member**, for whom `is_area_admin` answers false either way.

Suspending an **administrator** instead, and asking every permission predicate
in the schema what it thought:

```
is_active_app_member()        false   ← gated
is_area_member(bravo)         false   ← gated
is_area_admin(bravo)          false   ← gated
is_own_app_member(...)        false   ← gated
is_app_admin()                TRUE    ← not gated
is_area_contributor_member()  TRUE    ← not gated
```

**Neither let a suspended account do anything**, and that was measured too, not
assumed: every read is zero and all nineteen administrator-level writes are
refused, because each is backstopped by a predicate that *is* gated. They are
fixed anyway — "you are still this family's administrator" is a dangerous thing
for the database to keep saying to somebody it has locked out. It is true until
one refactor makes it load-bearing.

`is_app_admin` reaches `is_area_admin` through its acting-Area branch, which was
already gated; what needed the conjunct was the **other** branch — one
membership, no Area on screen.

### 3. `audit_log.action` had a closed vocabulary

`action` has allowed only `added, removed, restored` since 015, plus `handover`
since 041. A global account decision is none of those. 052 widens it to include
`decided`, `granted`, `revoked` — the same one-line change 041 made, for the
same reason. **Widening a CHECK can invalidate no existing row.**

---

## What is deliberately left ungated

Locked in by a named test, so adding a gate to either group is a decision
somebody makes on purpose rather than a drift nobody noticed.

| Routine | Why |
|---|---|
| `is_acting_area(uuid)` | A **scoping** test — "is this row in the family on screen" — never an authorisation. Every policy that uses it also asks a gated membership predicate, and it answers `true` for a null argument by design (045); a gate would turn "no such row" into "you may not". |
| `current_person_id()`, `current_app_member_id()`, `current_member_in_area()`, `current_person_in_area()` | Identity resolvers, not permissions: they answer *who* you are. Every policy comparing against one also asks a gated predicate. `current_person_id()` is half of 050's birthday-privacy comparison, and changing what it returns is not a thing to do in passing. |

---

## The rules the routines enforce

### Family Access, moved into the database

`grant_area_access` and `revoke_area_access` replace what the Family Access
route does today with the **service role** — which bypasses both RLS and the
write barrier, so every rule it obeys is one it applies to itself. Now the rules
are the database's own.

**Neither ever writes `user_id`.** Attaching a login to an invitation is
`claim_app_member`'s job and nothing else's, because only the claimant can prove
which login is theirs. An administrator who could write `user_id` could hand any
family seat to any account.

`grant_area_access`, by branch:

| Existing seat | What happens |
|---|---|
| none | unclaimed invitation created; `user_id` not even in the column list |
| unclaimed | re-addressed (a mistyped address is fixed here); `user_id` stays null |
| claimed, address = its account's **current confirmed** Auth email | reactivated, stale cached `app_members.email` healed, `user_id` unchanged |
| claimed, address differs | **refused** — revoke with `p_unlink` and let the new address claim the empty seat itself |
| claimed, account's email never confirmed | **refused** |

The identity is `user_id` and the live `auth.users.email` — **not** the `email`
column beside it, which is a cache of what the address was at claim time and may
be years stale. Granting against the stale value is refused; granting against
the live one heals the cache.

`revoke_area_access` disables and keeps `user_id` and the address, so restoring
access restores *the same person's* seat rather than opening it to whoever asks.
`p_unlink => true` is the only path that clears the login.

Both refuse the administrator's own seat: administration moves through
`transfer_area_admin` and departs through `leave_area`, which keep the
"exactly one active administrator" invariant these routines know nothing about.

> **A note on `revoke_area_access`'s two guards.** It refuses `role = 'admin'`
> *and* refuses self-removal. Because an Area has exactly one active
> administrator (035), and the caller must be that administrator, these two
> guards catch **the same row** — there is no reachable case that only one of
> them refuses. Both are kept as defence in depth, and both are tested; but a
> mutation of either *in isolation* is unkillable by construction, so the
> corresponding mutation is aimed at `grant_area_access`'s admin refusal, which
> **is** independently reachable and is the seat-takeover path that matters.

### Global administration

Appointing a Gift Planner administrator creates **no family membership**. A
global administrator with no Areas sees no gift, no budget, no birthday and no
name — proven, not asserted.

- `set_account_status` — global admins only; never oneself; never approving an
  unconfirmed email; any status but `approved` clears the admin flag, and
  re-approval does **not** restore it. A 500-character, control-character-safe
  note.
- `grant_global_admin` — target must exist, be confirmed, and be approved.
- `revoke_global_admin` — refuses to remove the last one.
- The CHECK `app_accounts_admin_must_be_approved` makes an unapproved
  administrator unreachable even by direct SQL.

### The global audit trail

Every decision writes `table_name = 'app_accounts'`, `area_id = NULL`,
`celebrant_person_id = NULL`, `birthday_privacy_unknown = false`,
`actor_name = NULL`, no subject, no amount.

`stamp_audit_area` returns early for `app_accounts` and **sets** `area_id` to
null rather than merely leaving it, so a caller who supplies one cannot smuggle
a global entry into a family's log. Without that early return, step 2 of that
function would stamp the deciding administrator's own family onto the row.

The reading policy is **permissive**, so it is OR'd with the family one — which
means all five of its restrictions have to hold on their own. `table_name =
'app_accounts'` is there alongside `area_id is null` because there are historic
Area-less rows that 049 could not attribute to any family, and this must not be
a door onto those.

---

## The backfill

Confirmed-only, **derived, never listed**. Not one hard-coded uuid in the file.

```
approved  ⇔  active claimed membership  AND  auth.users.email_confirmed_at IS NOT NULL
```

Everybody else stays undecided and is reviewed by a person — including an active
membership whose address was never confirmed. That is not a bug: an unconfirmed
address is an address nobody has proved they own, so the membership may belong
to whoever typed it into a sign-up form. `decided_by` is null because there was
no decider; inventing one would be a lie in the only table whose job is
recording who decided what.

---

## The production census — RUN, read-only

Taken **2026-08-31**, through the Auth Admin API (`GET /auth/v1/admin/users`)
and PostgREST with the service key. Every request a GET.

| | Count |
|---|---|
| Total `auth.users` | **5** |
| **A** — active claimed + confirmed | **5** |
| **B** — active claimed + UNCONFIRMED | **0** |
| **C** — no active claimed membership | **0** |
| Unclaimed invitations | **0** |
| `app_members` rows | 10 |

**Category B is zero, so nothing blocks the apply.** All five accounts would be
approved automatically; nobody loses access at the moment 052 applies.

Category A, oldest first — **the bootstrap candidates. The user chooses; this
document does not.**

| UUID | Email | Signed up | Last sign-in | Active memberships |
|---|---|---|---|---|
| `285861da-27cd-44fa-899c-8f4e6e46ca36` | tstward10@hotmail.co.uk | 2026-08-10 | 2026-08-30 | 3 |
| `c576e136-f68c-4733-80cd-f88948f2197a` | kirsten3lizabeth@gmail.com | 2026-08-11 | 2026-08-12 | 1 |
| `866208aa-483c-4750-b9e6-fdb05a21c9b7` | jadeward19@hotmail.co.uk | 2026-08-11 | 2026-08-12 | 1 |
| `b35884a8-5ad4-4c83-8026-8c00a689205f` | paigenicole66@googlemail.com | 2026-08-11 | 2026-08-12 | 1 |
| `68111dc8-45a9-4f50-b7e0-c3b0640f7ea8` | qa-alpha-admin-20260825@example.com | 2026-08-25 | 2026-08-25 | 3 |

> **Worth noticing:** the last row is the **QA account**, and the backfill
> approves it like any other — it holds three active claimed memberships and a
> confirmed address, so it meets the rule exactly. That is correct behaviour and
> it keeps QA working through the upgrade. It is flagged because "the QA login
> is now a globally approved Gift Planner account" should be a fact somebody has
> read, not one they discover.

`docs/Q19-052-PRE-APPLY-AUTH-CENSUS.sql` is the same census as one read-only
statement for the SQL Editor. Re-run it immediately before applying: these
numbers are from 2026-08-31 and a new sign-up would change them.

---

## The bootstrap — RUN AND VERIFIED, 2026-08-31

> **Applied.** Migration 052 was applied to production by hand on 2026-08-31 at
> 01:06:23 UTC, and the first global administrator was appointed at 01:18:25
> UTC. The record is at the end of this section; the statement below is kept
> verbatim because it is what was run, and because `revoke_global_admin`
> refusing to remove the last administrator means this is the only path back if
> the role is ever emptied.
>
> **It will not run a second time.** Guard 1 raises as soon as any
> administrator exists. Do not re-run it; use `grant_global_admin(uuid)`.

Migration 052 finishes with **zero** global administrators, by design, and its
own end-state block refuses to complete if that is not true. The first one
cannot be appointed by `grant_global_admin`, which requires a caller who is
already one.

**Run this only after 052 has applied and after the census has been reviewed.**
Replace the uuid with one the user has chosen from category A. Nothing else in
it is editable, and it refuses rather than guesses.

```sql
-- BOOTSTRAP THE FIRST GIFT PLANNER ADMINISTRATOR
--
-- Supply the uuid at execution time. No email, no name, no lookup by address:
-- an address is not an identity until somebody has confirmed it, and this
-- statement is not the place to decide who owns one.
do $$
declare
  target uuid := '00000000-0000-0000-0000-000000000000';   -- <<< PASTE THE UUID
  affected integer;
begin
  if target = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Paste the chosen uuid from Category A of the census first';
  end if;

  -- 1. There must not already be one. This statement is for the FIRST.
  if exists (select 1 from public.app_accounts where is_global_admin) then
    raise exception 'Gift Planner already has % administrator(s). Use grant_global_admin instead.',
      (select count(*) from public.app_accounts where is_global_admin);
  end if;

  -- 2. The account must exist and have confirmed its address.
  if not exists (
    select 1 from auth.users u where u.id = target and u.email_confirmed_at is not null
  ) then
    raise exception 'That account does not exist, or has never confirmed its email address';
  end if;

  -- 3. And it must already be approved -- by the backfill or by a person.
  if not exists (
    select 1 from public.app_accounts a where a.user_id = target and a.status = 'approved'
  ) then
    raise exception 'That account is not approved. Approve it before appointing it.';
  end if;

  update public.app_accounts
  set is_global_admin = true, updated_at = now()
  where user_id = target;

  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'Expected to update exactly 1 row, updated %', affected;
  end if;

  raise notice 'Gift Planner now has its first administrator. Record this in the deployment notes.';
end;
$$;
```

**No audit row is written, and that is deliberate.** There is no acting global
administrator to name as the actor, and inventing one would put a false entry in
the table whose only job is recording who decided what. **The bootstrap is
recorded in the deployment documentation instead** — write down the date, the
uuid, and who ran it, here:

```
Migration 052 applied:  2026-08-31 01:06:23 UTC  (Supabase SQL Editor, by hand)
Bootstrap performed:    2026-08-31 01:18:25 UTC  (Supabase SQL Editor, by hand)
Target uuid:            285861da-27cd-44fa-899c-8f4e6e46ca36
Target email:           tstward10@hotmail.co.uk   (human-readable note only --
                        the statement takes the uuid, never the address, and
                        neither value appears in runtime code or a migration)
Run by:                 the project owner
SQL Editor result:      Success. No rows returned
```

**Verification outcome — PASS.** Read-only, through the two approved production
read paths (a post-apply schema dump for the catalogue, PostgREST and the Auth
Admin API for rows). Every request a GET.

- **052 post-apply:** all 40 checks of `docs/Q19-052-POST-APPLY-CHECKS.sql`
  executed — 37 PASS, 0 FAIL, 0 REVIEW, 3 INFO. `app_accounts` exists with RLS
  on, zero policies and no privilege of any kind for `anon` or `authenticated`;
  the ten new routines are all `SECURITY DEFINER` with `search_path` pinned,
  executable by `authenticated` and by **no** `anon`; the nine redefinitions
  carry the gate; 049's acting-Area logic survived the redefinition of
  `stamp_audit_area`; 050's audit policy is untouched and the action vocabulary
  was widened, not replaced; every 051 invariant still holds.
- **Backfill:** 5 accounts, all `approved`, none with an unconfirmed address.
- **Bootstrap:** exactly one row updated. Exactly one global administrator, and
  it is the uuid above — approved, email confirmed 2026-08-10. `decided_at`
  still shows the 052 backfill; only `updated_at` moved.
- **Nothing else moved.** The target's memberships stayed 3 active of 4;
  `app_members` stayed at 10 rows with no timestamp touched; the protected
  fingerprint stayed at notifications 37, people 19, events 15, appMembers 4,
  recipients 35, Christmas 2026 active with 19 recipients; cross-Area total 0.
- **Census unchanged:** 5 auth users, A 5, B 0, C 0, 0 unclaimed invitations.

**The bootstrap intentionally produced no application audit actor.** `audit_log`
holds **zero** rows with `table_name = 'app_accounts'`, and no row of any kind
was written during the window — the newest entry is still 2026-08-30 13:33:20
UTC, out of 464. That is the designed behaviour: there was no acting global
administrator to name, and inventing one would have put a false entry in the
table whose only job is recording who decided what. This document is the record
instead. Every *subsequent* decision goes through `set_account_status` and
`grant_global_admin`, which do write an audit row, with a real actor.

---

## The runtime — BUILT, TESTED, AND NOT YET DEPLOYED

Part three. Everything below exists in the repository and passes every local
gate. **It has not been pushed, public sign-up is still OFF in the Auth project,
and Confirm Email is unchanged.** Production is still serving the old runtime.

### The one decision, in one place

`src/lib/account-status.ts` imports nothing, which is the point: the whole of
"where does this account belong" is a pure function a test can call.

| State | Meaning | Destination |
|---|---|---|
| `signed_out` | `my_account_status()` returned no row | `/login` |
| `email_unverified` | an address nobody has proved they own | `/check-email` |
| `pending` | undecided — **including no `app_accounts` row at all** | `/account-pending` |
| `approved` | let in | the app |
| `rejected` | refused | `/account-rejected` |
| `suspended` | refused | `/account-rejected` |

Three rules are worth stating because getting any of them backwards is a defect:

1. **A missing row is `pending`, and an unknown status is `pending`.** The
   routine already coalesces the first; the second is for the migration that
   adds a sixth status one day and meets a browser that has not been reloaded.
2. **Refusal beats an unconfirmed address.** A rejected account is refused
   before its email is even considered — "go and confirm your address" is an
   instruction that leads nowhere, and it would disclose that the refusal exists.
3. **`rejected` and `suspended` share one destination AND one screen.** They are
   distinct in the catalogue; telling them apart on screen would let somebody
   probe which decision was taken about them.

Two adapters fetch the row and do no deciding —
`account-status-{client,server}.ts` — so a server render and the browser that
hydrates it cannot disagree. **A failed call reads as `signed_out`, never as
approved.**

### What the runtime adds

| Route | Who | What it is |
|---|---|---|
| `/sign-up` | public | email + password + confirm. Enumeration-resistant. |
| `/check-email` | signed in, unconfirmed | the confirmation step, with a way out |
| `/account-pending` | `pending` | "Waiting for an admin to approve your account." |
| `/account-rejected` | `rejected` / `suspended` | one neutral sentence |
| `/admin/accounts` | global admins | the queue — approve / reject / suspend / appoint |
| `/` | approved | onboarding, **Area chooser**, or the dashboard |

### The defect this phase exists to remove

Signing in, the auth callback and account setup each read `app_members`, found
nothing, and called `signOut()`. Under public sign-up that is **wrong in both
directions at once**:

* an **approved account with no family** was signed out of an account it is
  perfectly entitled to — which is what everybody is for the first few minutes
  after being approved, and would have been every single sign-up; and
* a **rejected account with a family** was let in, because the membership row
  was all anybody asked about.

Membership is a family's decision. Approval is Gift Planner's, and it is
upstream. `scripts/account-approval-gate.test.mjs` renders the real
`FamilyProvider` and measures both, rather than asserting about the source.

### The front door has three shapes

`areaEntryFor(areas, remembered)` — pure, so the rule is testable:

* **no family** → the onboarding, which is the existing `CreateAreaForm`.
  Legitimate, not an error.
* **families, no valid choice** → **the chooser, even for exactly one family.**
  `resolveActiveArea` would happily pick the only one, and for every other
  screen it should — a bookmarked event with no cookie must show the event. The
  front door is where the app commits to whose people, money and history it is
  about, and making that commitment silently is how a stale cookie used to walk
  a two-family login into the wrong family without ever saying so.
* **remembered family still theirs** → straight to the dashboard, no extra hop.

`/` performs **exactly one redirect**, and it is the global status. Every Area
outcome is rendered.

### Family Access, rewritten onto the database

The route was **855 lines and eight actions**; it is a couple of hundred and
three. Reading is `list_area_access()`, granting is `grant_area_access()`,
revoking is `revoke_area_access()` — all through the caller's own session, where
the routine checks `is_area_admin(acting_area())` itself.

**The project-wide Auth enumeration is gone entirely.** `listAllAuthUsers`
fetched up to a hundred pages of every account on the installation to answer a
question about one family, and it is how Family Access could tell whether an
address had an account somewhere its administrator cannot see. It has no caller
and no longer exists.

**Three elevated actions survive, and only because the Supabase Admin API is the
only thing that can perform them:** `send-invite`, `copy-setup-link`,
`copy-reset-link`. Ordinary password reset is a public Auth call the browser
makes for itself, so routing it through the service role added a privilege and
no capability. **None of the three writes a row**, and the address they send to
comes from the seat, never from the request.

Five statuses replace four. The new one is `awaiting_global_approval` — a seat
that HAS been claimed by an account Gift Planner has not approved. The old
`pending` was hiding two situations with different people to chase, and in this
one the family administrator can do nothing at all:

> This family's access is ready. Their Gift Planner account is still waiting for
> approval, which only a Gift Planner administrator can give.

### Q18's two deferred consolidations, settled

* **`signOut` → `src/utils/supabase/sign-out.ts`.** Q18 left two byte-identical
  copies because verifying a change to the sign-out path means signing the real
  family out of the live site. Q19 has **five** callers, three of which have no
  account menu to reach. Q18 also named the hazard exactly — "if sign-out ever
  needs to clear the Area cookie, one copy gets it and the other does not". It
  does need to, because the chooser makes a stale `gp_area` the difference
  between asking which family and walking into one.
* **`createAdminClient` → `src/utils/supabase/service-role.ts`.** Q18 could not
  merge them because each threw its own domain error; a fourth copy had appeared
  by Q19. The split is what made them mergeable: one module owns the key and
  throws one low-level `ServiceRoleUnavailableError`, and each boundary
  translates it into the message its callers already expect. **No injected
  constructor** — a seam that lets a caller supply its own client is a seam that
  lets a caller supply one built somewhere else.

`scripts/canonical-paths.test.mjs` counts both: `auth.signOut()` in one file,
`process.env.SUPABASE_SECRET_KEY` in one file.

### `/admin/accounts` carries no family, and that is walked rather than read

A Gift Planner administrator with **no family** must see no gift, no budget, no
birthday and no name. The test walks the route's **transitive** import graph —
a direct import is easy to notice in review; the way this breaks is a helper
three modules down. One exemption is stated rather than hidden: `client.ts` and
`server.ts` read `AREA_COOKIE` to attach `x-area-id`, so `@/lib/areas` is
reachable from anything that talks to the database at all. That header is not a
family resolution and cannot become one here — `my_account_status()` and
`list_accounts()` consult no acting Area, and `stamp_audit_area` returns early
for `app_accounts` and **sets** `area_id` to null.

The walk carries a **positive control**: the same walk from `/more/family-access`
must find `current-member.ts`, so a resolver that silently returned null for
everything fails rather than passing vacuously.

A family administrator who finds the route gets `notFound()`, not a 403: a 403
confirms there is a queue behind it to somebody who has just gone looking.

### Gates — part three

| Gate | Result |
|---|---|
| Full regression `test:all` | **2,023 / 2,023** (1,939 before) |
| New: `test:account-approval-runtime` | 63 |
| New: the rendered gate + the rendered queue | 9 + 13 |
| Mutations | **169 / 169**, zero survivors (162 + 7 new) |
| TypeScript / ESLint / build / Worker bundle | clean |
| Migrations 001–052 | **untouched**; 052 still `f541b6ee…de61d` |
| Local browser QA, desktop 1440×900 and 390×844 DPR 3 | **75 / 75** |

**Four mutations had to be RETARGETED, not just added**, and that is the Q15
rule doing its job: `1`, `Q3-1`, `Q3-2` and `Q3-8` all aimed at Family Access
code migration 052 deleted, and `Q16-2` anchored on a lucide import this phase
extended. Every one reported `COULD NOT APPLY — Inconclusive`, which is a
survivor, not a pass. Each now breaks the same rule in the place it actually
lives, and each was verified individually before the full run.

### What is NOT tested, and cannot be until the launch

* **No end-to-end sign-up.** Public sign-up is off and Confirm Email is
  unchanged, so no confirmation email has ever been sent by this runtime.
* **No live `/admin/accounts` as a real administrator.** The screen is rendered
  against a fixture and the signed-out refusal is proved in a browser; an actual
  approval decision has never been taken through the UI.
* **No live Area chooser and no live Family Access.** Both are covered by unit
  tests and source assertions, not by a browser.
* Browser QA ran against **localhost**, because production is still serving the
  old runtime. Nothing was submitted and no production row was touched.

---

## Gates — parts one and two (migration 052)

| Gate | Result |
|---|---|
| Focused suite `test:global-approval` | **147 / 147** |
| Rollback rehearsal `test:global-approval-rollback` | **18 / 18** |
| Full regression `test:all` | **1,939 / 1,939** |
| Mutations | **162 / 162**, zero survivors (145 + 17 new) |
| TypeScript / ESLint / build / Worker bundle | clean |
| Migrations 001–051, before and after every mutation run | **byte-identical** |
| Protected fingerprint, before and after | **unchanged** |
| Cross-Area integrity | **0** |

---

## The files

| File | What it is |
|---|---|
| `supabase/migrations/202608100052_global_account_approval.sql` | the migration. **APPLIED 2026-08-31.** |
| `docs/Q19-052-PRE-APPLY-AUTH-CENSUS.sql` | read-only. Run **before** applying. |
| `docs/Q19-052-POST-APPLY-CHECKS.sql` | read-only. Run **after** applying, and again after the bootstrap. |
| `docs/Q19-052-ROLLBACK.sql` | rehearsed. **Read its header before running it.** |
| `scripts/global-approval.test.mjs` | the database rehearsal suite (147) |
| `scripts/global-approval-rollback.test.mjs` | the rollback, executed and compared to a pre-052 database |
| `src/lib/account-status.ts` | **the whole decision, as a pure function** |
| `src/lib/family-access.ts` | one `list_area_access()` row → one of five words |
| `src/utils/supabase/service-role.ts` | the only module in `src/` that reads the secret key |
| `src/utils/supabase/sign-out.ts` | the only `auth.signOut()` in the application |
| `scripts/account-approval-runtime.test.mjs` | the runtime rules, and the import-graph walk (63) |
| `scripts/account-approval-gate.test.mjs` | the gate, **rendered** (9) |
| `scripts/global-accounts-screen.test.mjs` | the queue, **rendered** (13) |

---

## The sequence — where it stands

Steps 1–6 are **done**. Step 7 is the next session.

1. ~~The user reviews the census and chooses the bootstrap uuid.~~
2. ~~Migration 052 applied manually in the SQL Editor.~~ 2026-08-31 01:06:23 UTC.
3. ~~`docs/Q19-052-POST-APPLY-CHECKS.sql` run and read.~~ 37 PASS / 0 FAIL.
4. ~~The bootstrap statement run with the chosen uuid, and recorded above.~~
5. ~~Post-apply checks run again.~~ Check 504 flipped to REVIEW, correctly.
6. ~~Build the runtime and review it.~~ Built, tested, **committed locally and
   not pushed**.
7. **Configure Supabase Auth, push, let Cloudflare deploy, and do live QA.**

**The order matters, and step 7 is where it still bites.** Runtime code that
depends on 052 must not reach auto-deploy before the database is ready — it is —
and **`/sign-up` must not be reachable before there is an administrator to
approve anybody** — there is one.

---

## The launch checklist — NOTHING HERE HAS BEEN CHANGED YET

Every item below is a **manual change in the Supabase dashboard**, and none of
them has been made. The model has changed no Auth setting and has read none of
them this session; each is written as something to verify rather than assume.

### Auth settings to set

| Setting | Where | Required value |
|---|---|---|
| **Confirm email** | Authentication → Sign In / Providers → Email | **ON** |
| **Allow new users to sign up** | Authentication → Sign In / Providers | **ON** |
| **Site URL** | Authentication → URL Configuration | `https://xmas-family.uk` |
| **Minimum password length** | Authentication → Sign In / Providers → Email | ≤ 8, to match the form |

**Confirm Email ON is not optional.** With it off, `signUp` returns a session
immediately and `email_confirmed_at` is set without anybody proving they own the
address — and `claim_app_member()` believes a confirmed address. Signing up as
somebody else's address would then be enough to walk into their family. The
runtime survives the misconfiguration (it routes the new session to
`/account-pending`), but the invitation-claiming rule does not.

### Redirect URLs to allow

Supabase only honours `redirect_to` when it matches an allowed Redirect URL;
otherwise it silently falls back to the Site URL. All three flows come back
through the same callback:

```
https://xmas-family.uk/auth/callback
https://xmas-family.uk/auth/callback?next=/account-setup
https://xmas-family.uk/auth/callback?next=/reset-password
```

Add `https://xmas-family.uk/**` if the project uses wildcards. **Do not remove
whatever is there today** — the invitation and recovery links already in flight
depend on it.

### Delivery to test, in this order

1. **Confirmation email** — sign up with a real address you control and confirm
   it. This is the flow that has never run.
2. **Forgot / reset password** — re-test, because the redirect list changed.
3. **Family Access invitation and both copy-link actions** — they use the
   Supabase Admin API, and the invite redirect is the same one.

### Limits and quota to review

* **Auth rate limits** (Authentication → Rate Limits): sign-ups per hour, and
  emails per hour. The default email allowance on the built-in SMTP is small and
  is shared by confirmation, recovery and invitation.
* **SMTP**: if the project still uses Supabase's built-in sender, the quota is
  the binding constraint on how many people can sign up in a day. A custom SMTP
  provider is the fix if it bites.

**No CAPTCHA.** There is no evidence it is needed: this is a private planner for
one family, the door it opens leads to a screen saying "wait for approval", and
every account still has to be approved by a person. Add one if the queue starts
filling with strangers, not before.

### Then, and only then

1. `git push` — the three held commits plus the runtime commit. Cloudflare
   Workers Builds deploys `main` automatically; **do not also deploy by hand.**
2. Check the deployment succeeded before touching the Auth settings, so a build
   failure is never diagnosed at the same time as an Auth change.
3. Live browser QA on `xmas-family.uk`: the sign-in screen offers **Create
   account**; a real sign-up; the confirmation email; `/account-pending`;
   approval through `/admin/accounts` by the bootstrapped administrator; then
   the Area chooser and Family Access, **in a QA Area only**.
4. Take the protected fingerprint before and after. `Our family` and Christmas
   2026 must not move.
