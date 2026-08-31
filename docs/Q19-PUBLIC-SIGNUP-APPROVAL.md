# Q19 — Public sign-up, global approval and Area onboarding

The record of migration 052. **Built and rehearsed, not applied.** Production
still ends at 051 and there is still no public sign-up.

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

## Runtime implementation plan — DESIGN ONLY

Nothing below is built. It is the next session's work, and none of it may be
deployed before 052 is applied to production.

### Screens and routes

| Route | State | Behaviour |
|---|---|---|
| `/sign-up` | public | email + password. Confirmation email **required**. On success → `/check-email`, never straight into the app. |
| `/pending` | signed in, `status = 'pending'` (or no row) | "Your account is waiting to be approved." No family data, no navigation into the app. |
| `/no-access` | `rejected` / `suspended` | One sentence, no reason disclosed, no retry loop. |
| `/areas/new` | approved, any number of Areas | already exists; now reachable from onboarding |
| `/areas/choose` | approved, **zero** Areas | "Create a family, or wait to be invited." The approved-with-nothing state is legitimate and must not look like an error. |
| `/admin/accounts` | `is_global_admin()` | the global queue: approve / reject / suspend / re-open, appoint and stand down administrators. **Global admin only — a family administrator gets a 404-shaped refusal, not a 403 that confirms the route exists.** |
| `/more/family-access` | Area admin | rewritten onto `list_area_access()` / `grant_area_access()` / `revoke_area_access()` |

### The guard, in one place

A single server-side resolver, called from the layout, that asks
`my_account_status()` **once** per request and returns one of:
`signed-out` · `unconfirmed` · `pending` · `refused` · `approved-no-areas` ·
`approved`. Every route decides from that value. No route fetches
`app_accounts` — it holds no privilege on it and the attempt would fail anyway,
which is the point.

### Claim on sign-in

`claim_app_member()` already runs on the normal sign-in path. After 052 it
returns false for an unconfirmed address, so the onboarding flow must call it
**after** confirmation, not before — otherwise an invited user who signs up,
confirms, and returns will not have been attached to their seat.

### Absorbing Q18's two deferred consolidations

- **`signOut`** — one canonical implementation, used by the pending screen, the
  refused screen and the account menu. Three screens now need it, which is what
  makes the consolidation pay for itself.
- **`createAdminClient`** — the Family Access route stops needing the service
  role at all once `grant_area_access` and friends exist, so this consolidation
  is partly a *deletion*.

### Rules for the runtime

- No direct `app_accounts` fetch anywhere. Ever.
- No project-wide Auth enumeration in Family Access — `list_area_access()` takes
  no Area and no email parameter, so there is nothing to point elsewhere.
- Family Access must not report whether an address has an account outside this
  family. Existence is not disclosed.
- A rejected/suspended account must not be able to tell which it is.

---

## Gates, this session

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
| `supabase/migrations/202608100052_global_account_approval.sql` | the migration. **Not applied.** |
| `docs/Q19-052-PRE-APPLY-AUTH-CENSUS.sql` | read-only. Run **before** applying. |
| `docs/Q19-052-POST-APPLY-CHECKS.sql` | read-only. Run **after** applying, and again after the bootstrap. |
| `docs/Q19-052-ROLLBACK.sql` | rehearsed. **Read its header before running it.** |
| `scripts/global-approval.test.mjs` | the rehearsal suite |
| `scripts/global-approval-rollback.test.mjs` | the rollback, executed and compared to a pre-052 database |

---

## Blockers before production apply

1. The user reviews the census above and **chooses the bootstrap uuid**.
2. Migration 052 is applied manually in the SQL Editor.
3. `docs/Q19-052-POST-APPLY-CHECKS.sql` is run and read.
4. The bootstrap statement is run with the chosen uuid, and recorded above.
5. Post-apply checks are run **again** — check 504 flips from PASS to REVIEW,
   which is correct once an administrator exists.
6. Only then may the runtime be built, and only then may Supabase Auth sign-up
   and `/sign-up` be enabled.

**The order matters.** Runtime code that depends on 052 must not reach
auto-deploy before the database is ready, and `/sign-up` must not be reachable
before there is an administrator to approve anybody.
