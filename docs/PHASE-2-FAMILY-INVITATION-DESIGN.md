# Roadmap Phase 2 — Family Invitation Architecture

**Design only.** No migration, no runtime change. Migration 053 is Phase 3.

Read with `docs/CURRENT-STATE.md` and `docs/SECURITY-AND-QA.md`.

> **The five open decisions are closed.** They were answered by the user after
> the first pass of this document, and the design below has been updated to
> match — this is the settled version, not a proposal. The answers, and what
> each one changed, are recorded in §16.

---

## 0. Decisions taken

| # | Decision | Effect on this design |
| - | -------- | --------------------- |
| 1 | **Re-invite after decline: ALLOW** | Unchanged from the first pass, now confirmed. A decline is not permanent; a reissue is an explicit, audited event (`invitation_reissued`), not a silent revival. |
| 2 | **Admin labels: COLLAPSE to one neutral `Invitation pending`** | `awaiting_signup` and `awaiting_acceptance` are **deleted from the design**. The admin is never told whether the address has an account. This removes the last residual enumeration signal — §7, §3, §11 and §14 #14 all changed. |
| 3 | **Expiry: NONE** | Unchanged, now confirmed. No `expires_at`, no derived `expired`, no sweeper. Revoke is the only way an invitation ends without an answer. |
| 4 | **Invitation email audit: YES, through a narrow boundary** | A fourth new routine, `record_invitation_delivery(uuid, text)`, is added to 053, called with the admin's own session. The service-role route gains **no** audit-writing power. Its outcome vocabulary had to be made branch-blind to stay consistent with decision 2 — §13, §7. |
| 5 | **Second QA mailbox: YES, LATER** | No address is invented here. QA Alpha, QA Charlie and Tricketts are **not** to be deleted before the live invitation tests complete; QA Bravo stays. |

---

## 1. What is actually there today

Read from migrations 004, 006, 011, 033, 034, 035, 037, 041, 042, 052 and the
runtime, not assumed.

### `app_members`, as it stands after 052

```
id             uuid pk
user_id        uuid null  -> auth.users on delete set null
email          text null  (lower/trimmed; app_members_email_safe_check)
person_id      uuid null  -> people
contributor_id uuid null
role           text not null default 'member'   check in ('admin','member')
active         boolean not null default true
area_id        uuid NOT NULL -> areas           (037 made it not null)
created_at / updated_at
```

Guards that matter here:

| Object | Rule |
| ------ | ---- |
| `app_members_one_membership_per_person_idx` | one seat per person row |
| `app_members_email_per_area_idx` | unique `(area_id, lower(email))` |
| `app_members_user_per_area_idx` | unique `(area_id, user_id)` |
| `app_members_exactly_one_admin` (041, deferred constraint trigger) | exactly one active admin per Area |
| `app_members_require_person_link` (033) | a seat names a person |
| `app_members_area_default` + the write barrier (037/042) | Area defaulting and foreign-Area refusal |
| `audit_app_members` (015) | audit row on insert/update/delete, watching `active` |

### The shapes a row can already have

- `user_id IS NULL, active = true` — **an invitation**. Nobody has claimed it.
- `user_id = <uuid>, active = true` — **a membership**.
- `active = false` — access switched off; `user_id` kept unless `p_unlink`.

**Every permission predicate in the schema requires `user_id = auth.uid()`.**
`is_active_app_member`, `is_area_member`, `is_area_admin`, `is_own_app_member`,
`is_app_admin` and `is_area_contributor_member` were all redefined in 052 §9 to
`user_id = (select auth.uid()) and active = true and is_globally_approved()`.
So an unclaimed invitation row **grants nothing**, today, by construction. That
is the single most important measured fact in this design.

### The routines

| Routine | Behaviour |
| ------- | --------- |
| `grant_area_access(person, email)` | acting-Area admin only; Area derived from the **person**; never writes `user_id`; refuses the admin seat; refuses an address belonging to a different account |
| `revoke_area_access(person, unlink)` | acting-Area admin only; `active = false`; `p_unlink` also nulls `user_id`; refuses the admin seat and self-removal |
| `list_area_access()` | acting-Area admin only; **no Area parameter, no email parameter** |
| `claim_app_member()` | **the defect.** See below |

### `claim_app_member()` — the exact conflict

```sql
update public.app_members m
set user_id = caller, updated_at = now()
where lower(m.email) = caller_email     -- caller's CONFIRMED auth email
  and m.user_id is null
  and m.active = true
  and not exists (... a seat this login already holds in that Area ...);
```

It is called on **every sign-in and every auth callback** —
`src/app/login/page.tsx:99`, `src/app/auth/callback/route.ts` (via
`claimInvitations()`), `src/app/account-setup/page.tsx:127`, all through
`src/utils/supabase/account-status-server.ts:46`.

It has **no `WHERE id =`**. It claims *every* matching invitation across *every*
Area in one statement, with no consent step, and returns a bare boolean — so the
caller cannot even tell which families were joined.

> **Confirming an email address, or merely signing in, silently joins every
> family that has typed that address into Family Access.**

That is precisely what the product requirement forbids. It is not a bug in 052 —
it was the intended design when invitations were private and issued by one
trusted person — but it is incompatible with public sign-up plus explicit
Accept/Decline.

### The write barrier, and why it constrains the design

`refuse_foreign_area_write()` (037, redefined 042) fires on `app_members` under
definer rights and refuses any write touching an Area the caller is not already
a member of. 042 added **one narrow exemption**:

```
app_members + UPDATE
  and old.user_id is null
  and new.user_id = auth.uid()
  and new.area_id is not distinct from old.area_id
  and lower(new.email) = lower(caller's auth.users.email)
```

**Accept fits through that hole exactly as it stands.** An accept that only sets
`user_id` (plus `updated_at`) needs no barrier change.

**Decline does not.** A decline writes something other than `user_id` on a row
whose Area the caller is not in, so the barrier refuses it. Decline is the one
operation that forces a barrier redefinition in 053.

### Notifications — measured, not assumed

`notifications.app_member_id` is `NOT NULL REFERENCES app_members(id)`, and its
RLS policy is `is_own_app_member(app_member_id)`, which requires
`user_id = auth.uid() AND active AND is_globally_approved()`.

> **A pre-membership invitee cannot read a notification row addressed to their
> own unclaimed seat.** `user_id` is null, so the predicate is false.

`notifications.category` is also a closed CHECK of five family/money words.
Using that table for invitations would require widening the CHECK *and* a policy
that reads a row without an active membership — drilling a hole through the exact
wall 052 §9b was written to close. **Rejected.**

---

## 2. Design Question 1 — source of truth

**Decision: `app_members` remains canonical. No second invitation table.**

It already models both halves without ambiguity, and with the strongest possible
property: the discriminator between "invitation" and "membership" is `user_id`,
which is *the same column every permission predicate already reads*. There is no
way for an invitation to be mistaken for a membership, because "is a membership"
is defined as "has a `user_id` matching the caller".

A second table would be strictly worse here:

- it would need its own `(area_id, lower(email))` uniqueness, duplicating
  `app_members_email_per_area_idx`, and the two could disagree;
- acceptance becomes a two-table transaction — insert a seat, mark the
  invitation — and every failure mode between them is a membership with no
  invitation, or an invitation with a phantom membership;
- `list_area_access()` would need a `full outer join` to answer one question per
  person, and "which one wins" becomes new, untested logic on a screen that
  currently has none;
- the person link (`app_members_one_membership_per_person_idx`) would have no
  counterpart, so two invitations could name one person.

**What `app_members` genuinely cannot express today:** *declined*. A declined
invitation and a revoked-then-unlinked seat are byte-identical
(`user_id IS NULL, active = false`). That is a real ambiguity, and it is the
only one.

**Minimum honest fix:** one nullable column, `declined_at timestamptz`. Not a
`state` enum — a persisted enum alongside `user_id` and `active` is three sources
of truth for one fact and can contradict itself. Every other state is **derived**
from `(user_id, active, declined_at)` plus the account's global status.

Trade-off accepted: `app_members` carries a column meaningful only in the
unclaimed half of its life. That is cheaper than a table that can disagree with
the one the permission system reads.

---

## 3. Design Question 7 — the state machine

### Persisted (three fields, nothing else)

| Field | Meaning |
| ----- | ------- |
| `user_id` | null = nobody has accepted. Non-null = accepted, and by whom |
| `active` | the family admin's switch |
| `declined_at` | **new.** Non-null = the invitee said no |

### Derived (never stored)

| State | Derivation | Who sees it |
| ----- | ---------- | ----------- |
| `no_access` | no seat row | admin |
| `invited` | `user_id IS NULL, active, declined_at IS NULL` | both |
| `awaiting_global_approval` | `user_id NOT NULL, active`, account not `approved` | both |
| `active` | `user_id NOT NULL, active`, account `approved`, email confirmed | both |
| `declined` | `declined_at NOT NULL` (implies `active = false`) | admin |
| `revoked` | `active = false, declined_at IS NULL` | admin |

**Six states, and every one of them is a pure function of columns the database
already holds.** Decision 2 removed the two that were not: `awaiting_signup` and
`awaiting_acceptance` split `invited` by whether an `auth.users` row existed for
the address, which is exactly the fact the admin must not learn. They are gone
from the design, not merely hidden — nothing derives them, no routine returns
them, and no route computes them for display.

The consequence is worth stating plainly: **`list_area_access()` plus the pure
mapping in `src/lib/family-access.ts` is now the whole of the admin's status
model.** No server-side knowledge is mixed into it, so the screen can be proven
correct by unit tests over fixture rows alone.

**No expiry.** Recommended: none in v1. An expiry is a persisted timestamp that
silently changes behaviour with no actor and no audit row, and this installation
has one real family. Revoke is the explicit form of the same intent. If expiry is
ever wanted it is `expires_at` + a derived `expired` state and **no new
transition** — the design does not have to change to accommodate it later.

### Transition table

| From | Event | Actor | To | Enforcement |
| ---- | ----- | ----- | -- | ----------- |
| `no_access` | `grant_area_access(person, email)` | Area admin | `invited` | acting Area + `is_area_admin` |
| `invited` | `grant_area_access` (new address) | Area admin | `invited` | re-address allowed only while `user_id IS NULL` |
| `invited` | `accept_family_invitation(id)` | the invitee | `awaiting_global_approval` or `active` | RPC + existing barrier exemption |
| `invited` | `decline_family_invitation(id)` | the invitee | `declined` | RPC + **new** barrier exemption |
| `invited` | `revoke_area_access(person)` | Area admin | `revoked` | RPC |
| `declined` | `grant_area_access(person, email)` | Area admin | `invited` (clears `declined_at`) | `grant_area_access` redefined in 053 |
| `revoked` | `grant_area_access(person, email)` | Area admin | `invited` | RPC |
| `awaiting_global_approval` | `set_account_status('approved')` | global admin | `active` | 052, unchanged |
| `active` / `awaiting_global_approval` | `revoke_area_access(person)` | Area admin | `revoked` (keeps `user_id`) | 052, unchanged |
| `active` | `leave_area(area)` | the member | `revoked` | 042, unchanged |
| `revoked` (claimed) | `grant_area_access` with the same confirmed address | Area admin | `active` / `awaiting_global_approval` | 052, unchanged |
| `revoked` (claimed) | `revoke_area_access(person, unlink => true)` | Area admin | empty seat | 052, unchanged |
| **anything** | replay of accept/decline | anyone | **no state change** | §13 |

Unreachable by construction: `declined` → accepted without an intervening grant;
`active` → `declined` (decline only touches `user_id IS NULL` rows).

---

## 4. Design Question 13 — `claim_app_member()` disposition

**Retired in behaviour, retained in name: the body becomes a constant `false`.**

Not narrowed, not split. The routine's entire body *is* the auto-join. Narrowing
it to "claim only the invitation you name" **is** `accept_family_invitation`, so
keeping both would be two names for one thing and two places for the barrier
exemption to be got wrong.

053 replaces the body with:

```sql
create or replace function public.claim_app_member()
returns boolean language sql immutable
set search_path = ''
as $$ select false $$;
```

- Every current caller already treats `false` as the normal case ("nothing was
  waiting on this address").
- **Deploy order is safe in both directions.** The database may go first — the
  old runtime keeps calling it and simply stops joining anyone. The runtime may
  not go first, but it does not need to. This satisfies the Migrations rule that
  runtime code depending on a migration must not auto-deploy before the database
  is ready.
- `EXECUTE` stays granted to `authenticated` so an in-flight browser session does
  not start erroring mid-upgrade.
- It is `drop`ped in a later migration once no caller remains.

**Guarantee delivered:** after 053 there is no code path anywhere in which
confirming or signing into an email address changes any row of `app_members`.

### Every runtime caller Phase 5 must update

| File | Change |
| ---- | ------ |
| `src/utils/supabase/account-status-server.ts:46` (`claimInvitations`) | delete the function |
| `src/app/auth/callback/route.ts` | drop the `claimInvitations()` call and its log line |
| `src/app/login/page.tsx:99` | drop the call |
| `src/app/account-setup/page.tsx:127` | drop the call |
| `src/app/api/admin/family-access/route.ts:61` (comment) | reword |
| `src/app/more/family-access/family-access-client.tsx:60` (comment) | reword |
| `src/app/check-email/page.tsx:14` (comment) | reword |
| `scripts/canonical-paths.test.mjs:147-173` | canonical path becomes `accept_family_invitation`; assertion inverts |
| `scripts/account-approval-runtime.test.mjs:729-746` | ditto |
| `scripts/area-lifecycle.test.mjs:608-709,895` | rewritten against the new routines |
| `scripts/global-approval.test.mjs:669-831,924,1072,1753` | rewritten |
| `scripts/area-mutation-security.test.mjs:412` | inventory line updated |
| `scripts/mutation-check.mjs:1856` (Q19-6) | mutation retargeted at `accept_family_invitation` |
| `scripts/production-checks.test.mjs:846` | rollback-header assertion updated |
| `scripts/global-approval-rollback.test.mjs:40` | updated |

---

## 5. Design Question 2 — the database contract

Three routines serve the **invitee**, and are specified here. A fourth,
`record_invitation_delivery(uuid, text)`, serves the **administrator's route**
and is specified in §13 where the audit design that motivates it lives.

All four are `SECURITY DEFINER`, `set search_path = ''`,
`revoke all from public, anon`, `grant execute to authenticated` — the file's
existing house style. **None of the four takes a user id, an email or an Area.**
The three below resolve the caller from `auth.uid()` and the confirmed email
from `auth.users`.

### `list_my_family_invitations()`

| | |
| - | - |
| Purpose | The invitations addressed to the caller's own confirmed email that they have neither accepted nor declined |
| Caller | Any signed-in account, **including a globally pending one** |
| Inputs | none |
| Returns | `(invitation_id uuid, area_name text, invited_as text, invited_at timestamptz)` |
| Authorization | `auth.uid()` is not null. **No global-approval gate** — a pending account must be able to see an invitation; that is the product requirement |
| DEFINER? | **Yes, required.** `app_members` RLS only lets a caller read a row they already hold, which is false for every invitation by definition |
| `search_path` | `''` |
| Email resolution | `select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null`. Null → zero rows |
| Cannot be pointed elsewhere | No parameter of any kind; the `WHERE` is `lower(m.email) = <that value>` |
| Data disclosed | `areas.name`, the invited seat's own `people.name`, and the timestamp. **Nothing financial, no event, no other person, no member list.** Justified: the invitee is being asked to consent to joining *that named family as that named person*, and cannot answer without both |
| Audit | none — it is a read |
| Failure | Zero rows for: signed out, unconfirmed email, refused account, nothing pending. Never an error, so the surface cannot distinguish those |

Row filter, exactly:

```
m.user_id is null
and m.active = true
and m.declined_at is null
and lower(m.email) = caller_confirmed_email
and not exists (select 1 from app_members mine
                where mine.area_id = m.area_id and mine.user_id = auth.uid())
```

The last clause is inherited from 042 for the same reason: an invitation into a
family you are already in is not offerable — `app_members_user_per_area_idx`
would refuse the accept.

### `accept_family_invitation(p_invitation_id uuid)`

| | |
| - | - |
| Purpose | Turn one named invitation into a membership |
| Caller | The invitee |
| Inputs | `p_invitation_id` — an `app_members.id` |
| Returns | `uuid` — the Area joined, so the client can switch straight to it |
| Authorization | Signed in; confirmed email; account **not `rejected` and not `suspended`**; the row is unclaimed, active, not declined, and addressed to that confirmed email |
| DEFINER? | Yes — RLS would not let the caller see or update the row |
| `search_path` | `''` |
| Email resolution | as above; unconfirmed → refuse |
| Cannot be pointed at another's invitation | The id selects a row; the row is only accepted if `lower(m.email) = caller_confirmed_email`. **The id is a selector, never a credential** |
| Write | `update app_members set user_id = auth.uid(), updated_at = now() where id = p_invitation_id` — and **nothing else**, which is exactly the shape 042's existing barrier exemption already permits |
| Audit | `audit_app_members` fires automatically (015); 053 adds an explicit row, `action='added'`, `summary='Joined <family>'`, `area_id` = the row's Area |
| Failure | `42501` "That invitation is not yours." for a wrong / absent / claimed / declined / inactive row — **one sentence for all of them**, so a guessed UUID is indistinguishable from a real one belonging to somebody else. Distinct sentences only for an unconfirmed email and a refused account |

**Global approval is deliberately *not* required to accept.** Measured
justification: every permission predicate already carries `is_globally_approved()`,
so a membership held by a pending account grants zero reads and zero writes — and
052 already ships `awaiting_global_approval` as a first-class Family Access status
for exactly this shape. Accepting while pending therefore satisfies "once globally
approved, accepted family membership becomes usable immediately" with no new gate
and no new state. `rejected` and `suspended` are refused, because those are
decisions a person took.

### `decline_family_invitation(p_invitation_id uuid)`

| | |
| - | - |
| Purpose | Refuse one named invitation, permanently, without joining |
| Caller | The invitee |
| Inputs | `p_invitation_id` |
| Returns | `void` |
| Authorization | Identical to accept, **except** a `rejected`/`suspended` account **may** decline — declining reduces access and must never be blocked |
| DEFINER? | Yes |
| `search_path` | `''` |
| Write | `update app_members set active = false, declined_at = now(), updated_at = now() where id = p_invitation_id`. `user_id` stays null |
| Barrier | **Requires a new exemption branch in `refuse_foreign_area_write()`** (§9) |
| Audit | Explicit row: `action='removed'`, `summary='Declined the invitation to <family>'`, `area_id` = the row's Area, `actor_user_id` = the invitee |
| Failure | The same single sentence as accept |

**Nothing else is proposed, and one thing is specifically forbidden.** No
`family_invitation_exists(email)`, no `invitation_delivery_plan(person)` and no
`resolve_account_by_email()`. Each is an enumeration oracle wearing a
business-logic hat; the delivery branch is decided inside the route, used, and
discarded (§7).

`record_invitation_delivery` is not an exception to that rule — it is told the
outcome, it does not compute one, and its two permitted words describe both
branches identically (§13).

`grant_area_access` and `revoke_area_access` are redefined in 053 only to
understand `declined_at`; `list_area_access()` only to return it.

---

## 6. Design Question 3 — email matching

Normalization is already settled by the schema and must not be re-invented:
`app_members_email_safe_check` requires `email = lower(trim(email))`, and
`grant_area_access` normalises with `lower(btrim(...))` before inserting. The
comparison in the three invitee routines is `lower(m.email) = lower(u.email)` on a
column already stored normalised — belt and braces, matching 042.

| Case | Outcome | Where enforced |
| ---- | ------- | -------------- |
| Case differs (`Ann@x.com` vs `ann@x.com`) | **Allowed normally** | schema CHECK + `lower()` comparison |
| Unconfirmed Auth email | **Fail closed.** `email_confirmed_at is not null` is a conjunct of the lookup, so the caller resolves to null and every routine returns empty / refuses | the three invitee routines |
| Auth email changed **after** the invite was created | **Fail closed, silently.** The invitation stops matching and leaves the invitee's list; the admin still sees it pending and can re-address. Correct — an invitation is to an *address*, and the address is how the family identified the person |
| Auth email changed **after** acceptance | **No effect.** `user_id` is identity from that moment; `app_members.email` is a stale cache, and 052's `grant_area_access` already says so and heals it on a matching re-grant |
| Duplicate `auth.users` rows for one address | **Cannot exist** — `auth.users.email` is unique in GoTrue. If forced, each is a distinct `auth.uid()`; whichever confirmed identity signs in first accepts, and `app_members_user_per_area_idx` blocks the second. **Fail closed by index, no special code**; Phase 3 asserts the uniqueness rather than coding around it |
| Duplicate invitation email inside one family | **Impossible.** `app_members_email_per_area_idx` is unique on `(area_id, lower(email))`, and `grant_area_access` raises `23505` with a sentence first. **Conflict, reported** |
| Same email invited to **several** families | **Allowed normally, and it is the point.** One row per family; each accepted or declined independently |
| One person linked to two accounts | **Impossible.** `app_members_one_membership_per_person_idx` is unique on `person_id` |
| One account in several families | **Allowed normally.** Uniqueness on `user_id` is *per Area* since 035 — that is what makes the Area switcher possible at all |
| Invitation to the caller's own address, in an Area they are already in | **Not offered, and accept refuses** — the `not exists` clause plus the unique index |

---

## 7. Design Question 4 — existing-account detection without an oracle

**The trusted boundary is `src/app/api/admin/family-access/route.ts`, using the
service role, and the answer never leaves it.**

**No project-wide `listUsers` is required, and none may return.** 052's whole
point was deleting `listAllAuthUsers` — up to a hundred pages of every account on
the installation, fetched to answer a question about one family.

**Preferred narrower lookup: none at all — branch on the invite call itself.**

```
POST /api/admin/family-access { action: "send-invite", personId }
  -> the seat's address comes from the seat, never from the request (already true)
  -> admin.auth.admin.inviteUserByEmail(seatEmail, { redirectTo })
       success                        -> no account existed; Resend has sent the setup mail
       error email_exists / 422       -> an account already exists; send nothing
       any other error                -> log server-side, report a generic delivery failure
  -> respond, in both of the first two cases, with exactly:
       { ok: true, message: "Invitation created." }
```

One targeted Admin call, no search, no enumeration surface, and the branch is
decided by GoTrue rather than by a lookup we have to keep honest. `getUserById`
cannot be used: before acceptance there is no `user_id` to pass — which is
precisely why 052 could get away with a targeted lookup and this cannot.

**What the admin is told:** `Invitation created.` — identical bytes on both
branches. Never "that email already has a Gift Planner account", and never a
differently-worded success. `list_area_access()` continues to disclose
`account_status` **only for a claimed seat** (`case when m.user_id is null then
null`), which is already enumeration-safe and stays exactly as it is.

**No residual. Decision 2 closed the last one.** The first pass of this document
proposed keeping two admin labels, `Awaiting sign-up` and `Invitation sent`,
which between them disclosed whether the address had an account. That is
withdrawn. The admin sees **`Invitation pending`** in both cases.

So the account-existence fact now lives in exactly one place and has exactly one
lifetime: **it is decided inside the route, used to choose whether to send an
email, and discarded before the response is built.** It is never returned to a
browser, never stored in a column, never derivable from a status label, and never
reachable through any routine. The system still "knows internally what delivery
action is needed", as the decision requires — for the duration of one request.

**The audit row must not leak it either, and this is a real trap.** `audit_log`
is readable by **every member of the family**, not only its administrator (015's
`members read the audit log` policy). So a delivery record that said *email
sent* in one branch and *no email needed* in the other would be the same oracle
again — slower, but persistent, and visible to more people than the screen was.
An admin could seat a person, point an invitation at any address, and read the
answer out of the activity log.

So the recorded outcome vocabulary is deliberately **two words that do not
distinguish the branch**:

| Outcome | Means | Which branch produced it |
| ------- | ----- | ------------------------ |
| `ready` | the invitation is issued and the invitee can act on it | **both** — an account existed, *or* the setup email was sent successfully |
| `undelivered` | an email was needed and the send failed | only the no-account branch, and only on failure |

`ready` is the honest common outcome of both success paths, and it is the one
the admin actually needs ("it worked, stop resending"). `undelivered` is the one
that requires action. A reader of the log — member or administrator — cannot
tell an existing account from a successfully emailed new one, because the two
produce byte-identical rows.

This is a small reinterpretation of decision 4's "delivery attempt/success", and
it is deliberate: recording the attempt *literally* would have re-opened the hole
decision 2 was taken to close. The attempt and its success are still recorded —
just in a vocabulary that carries no account-existence bit. See §13.

**If the Auth call fails:** the invitation is **already created** —
`grant_area_access` ran first, in its own transaction, and succeeded. The response
says so and offers a retry:

> `Invitation created. The email could not be sent — try Resend invitation.`

This is required by "invitation creation should still succeed independently of
email delivery". Delivery is a best-effort side effect of a committed database
fact, never the other way round.

---

## 8. Design Question 5 — delivery, both paths

### A. Existing account

- **No signup email. No Auth email of any kind.**
- The invitation becomes visible through `list_my_family_invitations()` the next
  time the invitee loads any global surface. No email is needed for the flow to
  complete.
- **No `notifications` row.** Measured reason in §1: `notifications.app_member_id`
  is a not-null FK to `app_members` and its policy is `is_own_app_member(...)`,
  which requires `user_id = auth.uid()` — false for every invitation. A row
  written there would be unreadable by its own recipient, and making it readable
  means weakening the very policy 052 §9b was written to strengthen.
- **Decision: invitations are projected into the UI from `app_members`, not
  materialised as notification rows.** One source of truth, and the bell's Area
  rules are untouched.
- Optional Phase 5 nicety, explicitly *out of scope for 053*: a plain
  transactional "you have an invitation" email sent by the route via Resend,
  carrying no family name. Deferred, not designed here.

### B. No account

- `inviteUserByEmail` — **`invite`, not magic link, not signup, not recovery.**
  - `invite` creates the `auth.users` row unconfirmed and mints a one-time link;
    following it confirms the address and lands on `/account-setup` to set a
    password. That is the flow `/account-setup` and the callback's implicit
    handoff already implement and which already works in production.
  - `magiclink` would sign them in with no password, leaving an account they can
    never sign in to again unaided.
  - `signup` requires a password the admin would have to invent.
  - `recovery` is for an account that already exists.
- **Enumeration resistance:** unchanged. The route already returns a generic 502
  sentence on failure and logs the real reason server-side.
- **Session retention:** already correct and must not regress. `auth/callback`
  no longer reads `app_members`; it routes on `my_account_status()` alone, and
  `destinationFor('pending', ...)` sends a newly confirmed invitee to
  `/account-pending` — **not** `/login`. With `claim_app_member` retired the
  callback loses its last membership-shaped side effect and gets simpler.
- **Redirect allowlist:** `passwordSetupRedirect(requestOrigin)` derives from
  `getRequestOrigin`, so production sends `https://xmas-family.uk/auth/callback`.
  Phase 5 re-verifies the GoTrue allow-list rather than assuming it.
- **Logging:** the route logs `status`, `code` and `redirectTo` only. Action links
  and passwords are never logged, and `copy-setup-link` returns the link in a
  `private, no-store` body. Unchanged, and it stays unchanged.

---

## 9. Design Questions 6 + 10 — where invitations appear

**Canonical UX: one global surface, `/invitations`, plus the identical invitation
card embedded inline on the screens an invitee can actually be pinned to. The
notification bell is not used and does not change.**

Why not the bell: it is Area-scoped through `app_member_id` (measured, §1), it
renders inside `AppFrame` chrome that `isBareRoute()` suppresses on every global
route, and a pending account never reaches a screen that draws it. Putting
invitations there would mean the population that most needs to see them is the
population that cannot.

Why not `/account`: it is not in `GLOBAL_ROUTES`, so it carries family chrome and
`destinationFor` bounces a pending account away from it.

| Population | `destinationFor` pins them to | Where the invitation appears |
| ---------- | ---------------------------- | ---------------------------- |
| Signed in, email unconfirmed | `/check-email` | nowhere — correct; confirm first |
| **Globally pending** | `/account-pending` **and nowhere else** | **inline card on `/account-pending`** |
| Rejected / suspended | `/account-rejected` | nothing shown. Decline stays callable, but no surface offers it |
| Approved, **zero** Areas | `/` renders `CreateAreaForm first` | **inline card above the create-family form** — "you were invited" must beat "start a family" |
| Approved, Areas but no valid choice | `/` renders `AreaChooser` | **inline card above the chooser** |
| Approved, inside a family | dashboard | **account-menu item `Invitations (n)`** → `/invitations` |

`/invitations` is added to `GLOBAL_ROUTES` so it renders bare, loads no Area and
resolves no membership. **`destinationFor` is not changed**: a pending account is
pinned to `/account-pending`, and it gets the identical card component rendered in
place there rather than a route it would be redirected away from.

### Notification content rules

If a Phase-5 email or push is ever added, the text ceiling is fixed here:

> **Invitation to Tricketts** — You've been invited to join Tricketts.
> Accept · Decline

Family name and the invited person's own name, nothing else. **No push before
membership** — push subscriptions key on `app_member_id` and are gated by
`is_own_app_member`, so there is no subscription to send to. Read/unread does not
apply: an invitation is not a notification, it is a pending decision, and it
leaves the list when answered.

**Follow-up notifications on decline/revoke:** none. A decline that emailed the
admin would tell them the address is monitored; a revoke that emailed the invitee
would be a message about a family they never joined. The admin learns both from
Family Access status, which is a pull.

---

## 10. Design Question 14 — anticipated migration 053 diff

Migrations 001–052 remain immutable and untouched. **053 is not written in this
phase.**

### Preflight
Assert 052's end state — `app_accounts` exists, the seven-word
`audit_log_action_check`, and the seven gated predicates all carry
`is_globally_approved()`. Refuse to apply otherwise, in the style of 052 §0.

### Tables / columns
```sql
alter table public.app_members
  add column if not exists declined_at timestamptz;

comment on column public.app_members.declined_at is '...';

alter table public.app_members
  add constraint app_members_declined_is_unclaimed
  check (declined_at is null or (user_id is null and active = false)) not valid;
```
`not valid` matches 011's house style: no existing row can violate it
(`declined_at` is null everywhere) and validation is not a table rewrite.

### Indexes
```sql
create index if not exists app_members_open_invitation_idx
  on public.app_members (lower(email))
  where user_id is null and active = true and declined_at is null;
```
One partial index; `list_my_family_invitations()` is its only reader.

### Constraints
Only the CHECK above. **`audit_log_action_check` is NOT widened** — every
invitation event maps onto `added` / `removed` / `restored`, which is honest and
avoids a third widening of a constraint already widened twice.

### Policies
**None added, none dropped.** All four new routines are `SECURITY DEFINER`;
`app_members` keeps exactly the one 052 policy. Deliberate: a policy letting a
non-member read an `app_members` row would be a new hole, and the routines need
none.

### Routines added
`list_my_family_invitations()`, `accept_family_invitation(uuid)`,
`decline_family_invitation(uuid)`, and — from decision 4 —
`record_invitation_delivery(uuid, text)` (§13). Four, not three.

### Routines redefined
- **`refuse_foreign_area_write()`** — 042's body reproduced byte for byte plus
  **one branch**, exactly as 042 itself did to 037's:
  ```
  app_members + UPDATE
    and old.user_id is null and new.user_id is null
    and old.active = true and new.active = false
    and new.declined_at is not null and old.declined_at is null
    and new.area_id is not distinct from old.area_id
    and lower(new.email) = lower(caller's confirmed auth email)
  ```
  As narrow as the case: an unclaimed row, addressed to the caller, going
  inactive and declined, in the same Area, with no login attached before or
  after. It can move nothing between families and grant nothing to anybody.
- **`grant_area_access(uuid, text)`** — the two `update` branches also
  `set declined_at = null`. Nothing else changes.
- **`list_area_access()`** — returns one extra column, `declined_at`, so the
  client can tell `declined` from `revoked`.
- **`claim_app_member()`** — body replaced with `select false` (§4).

### Routines revoked / granted
`revoke all ... from public, anon` + `grant execute ... to authenticated` on all
four new routines. No grant is widened, and **no grant is given to the service
role** — it needs none, because it writes no audit (§13).
`claim_app_member` keeps its existing grant through the transition.

### Trigger changes
None. `refuse_foreign_area_write` is redefined, not re-attached;
`audit_app_members` already fires on the updates both new routines perform.

### Backfill
**None, and that is a deliberate statement rather than an omission.**
`declined_at` is null on every existing row, which is the correct meaning for all
of them. No existing invitation is retroactively declined and no existing
membership is disturbed.

One behavioural note that is *not* a backfill: the instant 053 applies, any
outstanding unclaimed invitation stops being auto-claimable and starts requiring
Accept. **Phase 3 must confirm by live read, before applying, that production
holds no unclaimed invitation outside the QA Areas.** If any exist in `Our
family`, the correct handling is to tell those people to accept — not to backfill.

### Rollback (`docs/Q20-053-ROLLBACK.sql`, written in Phase 3)
1. `create or replace` 042's `refuse_foreign_area_write()` and 052's
   `grant_area_access`, `list_area_access` and `claim_app_member` at their exact
   prior definitions, copied from the applied migration files.
2. `drop function` the four new routines.
3. `drop index app_members_open_invitation_idx`.
4. `alter table app_members drop constraint app_members_declined_is_unclaimed`.
5. `alter table app_members drop column declined_at` — **destructive of decline
   history only**; the script says so out loud, and the pre-apply backup is the
   recovery path.
6. Post-rollback assertion that `claim_app_member` claims again and that no
   membership row changed.

**Deploy order:** 053 is applied manually **first**; the Phase 5 runtime that
calls the new routines is pushed only afterwards. Safe in both directions,
because the stubbed `claim_app_member` keeps the old runtime working and the new
runtime's routines exist before it ships.

---

## 11. Design Question 8 — Family Access UX

The admin never meets a database word:

```
Settings -> Family Access
  [ every person in this family, with a status chip ]

  Jade   No access   [ Give access ]
    -> "Where should we send Jade's invitation?"   [ email ]
    -> "Invitation created."
```

`grant_area_access(person, email)`, then the route's delivery branch, in that
order — and the message is identical whichever branch ran (§7).

### Canonical labels

| Label | Derived from | Admin can act |
| ----- | ------------ | ------------- |
| **No access** | no seat row | Give access |
| **Invitation pending** | `user_id IS NULL, active, declined_at IS NULL` | Resend invitation, Change address, Cancel invitation |
| **Waiting for Gift Planner approval** | accepted, account not approved | **nothing** — and the screen says so, as it already does |
| **Active** | accepted, approved, confirmed | Remove access |
| **Declined** | `declined_at` set | Invite again |
| **Revoked** | inactive, not declined | Give access again |

**Six labels, and all six are pure functions of one `list_area_access()` row.**
That is decision 2's real payoff: `areaAccessStatus()` in
`src/lib/family-access.ts` gains exactly one branch (`declined`), stays pure,
stays unit-testable against fixture rows, and — the part that matters — **no
server-derived knowledge is mixed into the admin's status model at all**. There
is no longer any code path by which the screen can learn, or accidentally
display, whether an address has a Gift Planner account.

`Invitation pending` is deliberately the same word regardless of what the
delivery branch did. **Resend invitation stays offered in every pending case**,
including the one where an account already exists and no email was ever sent —
because hiding the button in that case would restore the distinction the label
just removed. Resending against an existing account is harmless: the route's
branch refuses to send and the response is the same neutral sentence.

`Awaiting sign-up`, `Awaiting acceptance` and `Invitation sent` are all
withdrawn. Each of them described the invitee's *account*, and the admin's
screen has no business describing that — only whose court the ball is in, which
`Invitation pending` says exactly.

**The protected admin seat is untouched.** `grant_area_access` and
`revoke_area_access` both refuse `role = 'admin'`, the route refuses it a third
time, and `isAdminSeat()` draws no control for it. 053 changes none of that, and
the two new invitee routines cannot reach an admin seat at all — an admin seat
always has a `user_id`, and both routines require `user_id IS NULL`.

---

## 12. Design Question 9 — reinvite / revoke / decline, made deterministic

| Scenario | Outcome |
| -------- | ------- |
| Admin revokes a **pending** invite | `active = false`, `declined_at` stays null → **Revoked**. It leaves the invitee's list immediately (the list requires `active`) |
| Admin re-invites the **same** address | The row exists and is unclaimed → `grant_area_access` updates it: `active = true`, `declined_at = null`. **Same row, same id** — one seat, one person |
| Invitee **declines** | `active = false, declined_at = now()` → **Declined**. Admin sees it. No email to anyone |
| Admin invites again **after a decline** | **Allowed.** `declined_at` is cleared and `active = true` → pending again. Deliberate: a decline answers one asking, not all of them, and the family has exactly one admin who is a real relative |
| Admin **changes the address** on a pending invite | Allowed while `user_id IS NULL` (052's existing branch), and it now also clears `declined_at`. The old address's invitation leaves that person's list on their next load |
| Admin changes the address on a **claimed** seat | **Refused**, unchanged from 052: *That seat already belongs to a different account. Remove its access first.* |
| Accepted member **loses access** | `revoke_area_access(person)` → `active = false`, `user_id` kept → **Revoked**. Every predicate goes false immediately, and their notification rows become unreadable (`is_own_app_member` requires `active`) |
| Revoked member **invited again**, same confirmed address | 052's existing branch restores the seat straight to **Active** — **no new Accept required**, because they consented once and `user_id` was never cleared. Deterministic and intentional |
| Revoked-and-**unlinked** member invited again | `user_id` was nulled, so it is a fresh invitation and **Accept is required again**. That is the difference `p_unlink` has always meant |
| Admin touches **their own** admin seat | Refused in the database, in the route and in the UI. `transfer_area_admin` / `leave_area` are the only paths. Unchanged |

---

## 13. Design Question 11 — audit model

`audit_log` gains no column and no action word. `stamp_audit_area()` is **not**
redefined — for every event below the Area is derivable from the `app_members`
record itself via `area_of_record`, which is step 1 of the trigger and the most
trustworthy of its three.

| Event | Actor | Target (`record_id`) | `area_id` | `action` | `details` |
| ----- | ----- | -------------------- | --------- | -------- | --------- |
| `invitation_created` | Area admin | `app_members.id` | the family | `added` | `{}` |
| `invitation_reissued` | Area admin | same seat | the family | `restored` | `{previous_state: 'declined' \| 'revoked'}` |
| `invitation_delivery` | Area admin | same seat | the family | `added` | `{outcome: 'ready' \| 'undelivered'}` |
| `invitation_accepted` | **the invitee** | same seat | the family | `added` | `{}` |
| `invitation_declined` | **the invitee** | same seat | the family | `removed` | `{}` |
| `invitation_revoked` | Area admin | same seat | the family | `removed` | `{}` |
| `membership_revoked` | Area admin | same seat | the family | `removed` | `{unlinked: true \| false}` |

**Is `area_id NULL` ever appropriate here? No — not once.** Global `NULL` is
reserved by 052 for `table_name = 'app_accounts'`, and `stamp_audit_area()` forces
it there. Every invitation event is an event *in a family*: it names a family's
person and a family's seat, and hiding it from that family's activity log would
remove the only record the family has of who was let in. The invitee is not yet a
member when they accept, but the event is still the family's.

**Never stored, in `details` or anywhere else:** the email address in any form —
**including its domain**, which the first pass proposed and which is withdrawn,
because `audit_log` is readable by every member of the family and the seat
already carries the address for the one person entitled to see it. Also never:
the email body, the setup or action URL, any token, any provider key or secret,
and any `user_id` belonging to an account outside this family. The `record_id`
is the seat, and the seat is enough — everything else is a join a reader with
permission can already make.

### The delivery event, and the narrow boundary it goes through

Decision 4 asked for delivery to be audited **without** handing the service-role
route generic audit-writing power. It does not get any. 053 adds a seventh
routine:

```
record_invitation_delivery(p_person_id uuid, p_outcome text)
```

| | |
| - | - |
| Purpose | Record that an invitation was issued and whether the invitee can act on it |
| Caller | The Family Access route, **using the administrator's own session client — not the service role** |
| Authorization | `require_acting_area(area_of_person(p_person_id))` + `is_area_admin(...)`, exactly like `grant_area_access`. Identical shape, identical refusals |
| Inputs | the person, and an outcome constrained to `'ready'` or `'undelivered'` — anything else raises `22023` |
| Writes | **one** `audit_log` row, with `table_name`, `record_id`, `action`, `summary` and `area_id` all chosen by the routine. The caller supplies neither the Area nor the wording |
| DEFINER? | Yes, `search_path = ''`, `authenticated` only |

Three properties follow, and each is the point:

1. **The route cannot write an arbitrary audit row.** It can record one fact
   about one person in the family it has already been authorised for. It cannot
   forge an actor, an Area, an action word or a summary.
2. **`area_id` is never NULL**, as decision 4 requires, and it is not merely
   *passed* — it is derived inside the routine from the person, so a wrong Area
   is not expressible. `stamp_audit_area()` needs no change and none is made.
3. **The service role writes no audit at all.** This preserves the rule that
   service-role code must authenticate, authorize and explicitly scope: here it
   does not have to, because it is not the one writing.

The route already holds an authenticated session — `requireFamilyAccessAdmin()`
resolves the caller through `getCurrentMember()`, which uses the caller's own
client — so this needs a server-side Supabase client the route can already
construct, and no new privilege anywhere.

**One ordering rule for Phase 5:** the delivery row is written **after** the Auth
call returns, so its outcome is a fact rather than an intention; and a failure to
write it must never turn a created invitation into an error response. The
invitation is the committed truth (§7); the audit row and the email are both
best-effort records of what happened to it.

---

## 14. Design Question 12 — security / abuse matrix

| # | Attack | Expected result | Enforcing layer | Test |
| - | ------ | --------------- | --------------- | ---- |
| 1 | A accepts B's invitation id | Refused `42501`, generic sentence, no row changes | `accept_family_invitation`: `lower(m.email) = caller's confirmed email` | P3 DB |
| 2 | Attacker guesses an invitation UUID | Identical refusal to #1 — a valid id belonging to another and a nonexistent id are indistinguishable | same routine, single error path | P3 DB |
| 3 | Unconfirmed email accepts | Refused — the email lookup carries `email_confirmed_at is not null`, so the caller resolves to null | the three invitee routines | P3 DB |
| 4 | Globally **rejected** account accepts | Refused `42501` (may still decline) | `accept_family_invitation` status check | P3 DB |
| 5 | Globally **suspended** account accepts | Refused `42501` | same | P3 DB |
| 6 | Family admin in Area A invites into Area B | Refused — Area derived from `area_of_person`, then `require_acting_area` + `is_area_admin` | `grant_area_access` (052, unchanged) | P3 DB |
| 7 | Global admin uses the global role as Area membership | No Area read, no Area write. `is_global_admin()` appears in exactly one policy, on `audit_log`, restricted to `area_id is null and table_name='app_accounts'` | 052 §8 | P3 DB |
| 8 | Invitation address differs only by case | **Accepted normally** | schema CHECK + routine comparison | P3 DB |
| 9 | Account changes email after being invited | Invitation stops matching; fails closed; no membership | routine comparison | P3 DB |
| 10 | Duplicate Auth records for one address | Impossible (`auth.users.email` unique); if forced, `app_members_user_per_area_idx` refuses the second accept | GoTrue + index | P3 DB — asserted, not coded around |
| 11 | Accepted member **replays** Accept | No-op refusal, no second row, no escalation — `user_id IS NULL` is false | routine + unique index | P3 DB |
| 12 | Declined invite replay | No-op refusal — `declined_at IS NULL` is false | routine + CHECK | P3 DB |
| 13 | Revoked invite replay | No-op refusal — `active = true` is false | routine | P3 DB |
| 14 | Invitation endpoint as an enumeration oracle | `Invitation created.` byte-identical on both branches; **one** admin label (`Invitation pending`) for both; `list_area_access` still returns null `account_status` for unclaimed seats; no email-taking RPC exists | route (§7) + `list_area_access` (052) + the collapsed label (§11) | P3 DB **and** P5 live |
| 14b | **Audit log as a slower enumeration oracle** | Refused by vocabulary: `invitation_delivery` records `ready` for *both* success branches, so a family member reading the log cannot tell an existing account from a newly emailed one. No address, no domain, no link is stored | `record_invitation_delivery` (§13) | P3 DB — assert the two branches produce byte-identical audit rows |
| 15 | Existing account wrongly sent an Auth invite/setup email | Cannot happen — `inviteUserByEmail` refuses with `email_exists` and the route sends nothing | GoTrue + route branch | P5 live, mailbox-verified |
| 16 | No-account email never sent, but admin sees "success" | **Explicitly prevented** — `Invitation created. The email could not be sent — try Resend invitation.` The invitation is real either way | route error branch | P3 runtime + P5 live |
| 17 | Area data leaks in a pre-membership surface | `list_my_family_invitations()` returns family name, own person name, timestamp. Nothing else. No notification row is created at all | the routine's column list | P3 DB + P5 browser-payload inspection |
| 18 | Service-role route trusts a client-supplied Area/user id | Body allowlist is `{action, personId}`; the address comes from the seat; the Area comes from `requireFamilyAccessAdmin()` | route (052, unchanged) | P3 runtime |
| 19 | Stale `gp_area` cookie points at another family | `claim_active_area`/`act_in_area` refuse an Area `is_area_member` rejects, and **the new routines read no acting Area at all** | 038 + routine design | P3 DB |
| 20 | Accept mutates contributor / event roles | Accept writes `user_id` and `updated_at` only — never `role`, `contributor_id`, `person_id`, `area_id`, or any `people` column | the routine's `SET` list, asserted column by column | P3 DB |

Two invariants this matrix protects, restated: **cross-Area integrity must remain
zero**, and **UI hiding is never authorization** — every row above is refused by
the database with the browser removed.

---

## 15. Design Question 15 — test plan

### Phase 3 — migration rehearsal (`scripts/*.test.mjs` against a rehearsal DB)

**Lifecycle.** Existing **approved** account invited → sees it → accepts → active.
Existing **pending** account invited → sees it → accepts → membership exists and
grants **zero** reads until approved, then works immediately. **Rejected** invited
→ sees nothing, accept refused, decline permitted. **Suspended** → same.
**No-account** address invited → row created, list empty for everyone, becomes
visible after the account confirms. **Unconfirmed** account → sees nothing, accept
refused.

**Authorization.** Wrong account accepts by id (#1); guessed UUID (#2); the two
refusals are the same sentence. Accept; decline; revoke; replay of each; re-invite
after decline; re-invite after revoke, both linked and unlinked.

**Integrity.** Duplicate email in one Area refused with `23505`. Same address
invited to two Areas, both accepted, both memberships intact and independent. A
member of Area A cannot be invited into Area B's seat. The protected admin seat
refuses grant, revoke, accept and decline.

**Non-mutation.** An accept changes exactly `user_id` and `updated_at` on exactly
one row — asserted column by column, plus an assertion that nothing changed in
`people`, `contributors`, `christmas_recipients` or `events` (#20).

**Barrier.** The new decline branch is proven to be the *only* new thing it
permits — a sweep attempting every other `app_members` write from a non-member,
expecting `42501` on all of them.

**Surfaces.** `list_my_family_invitations()` returns no financial column, no
event and no third-party person — asserted from `pg_attribute`, not by reading the
source. No routine anywhere accepts an email or a user id as a parameter.

**Enumeration (decision 2), asserted at the database.** `list_area_access()`
returns the *same* row shape for an unclaimed seat whether or not an account
exists for its address — `account_status` and `email_confirmed` are null in both
cases, which 052 already guarantees and Phase 3 re-proves directly. And the
audit assertion: invite an address with an account, invite one without, and
compare the resulting `audit_log` rows column by column — **they must be
identical but for `record_id` and `occurred_at`**. `record_invitation_delivery`
refuses any outcome word outside `ready` / `undelivered`, refuses a person in
another Area, and refuses a caller who is not that Area's administrator.

**Retirement.** `claim_app_member()` returns false and mutates nothing for a
confirmed invited address that would previously have been auto-joined. **This is
the test that proves the product requirement.**

**Post-apply.** `docs/Q20-053-POST-APPLY-CHECKS.sql` in 052's style — one
PASS/FAIL row per assertion. Rollback rehearsed and re-verified in the same
session.

### Phase 3/5 — runtime, local

Family Access renders all **six** statuses from fixture rows (pure-function tests
on `areaAccessStatus`), and a test asserts that **no label anywhere in the client
varies with account existence** — the two withdrawn strings must not appear in
`src/`. Existing account → in-app invitation only, **no Auth call made**.
No-account → exactly one `inviteUserByEmail`. Both → byte-identical success
message **and** an identical `Invitation pending` chip. Delivery failure →
invitation persists and the message says so.
Accept/Decline UI from `/account-pending`, from `/` onboarding, from `/` chooser
and from `/invitations`. Approved zero-Area shows the card **above** the create
form. Area chooser refreshes and offers the new family after accept. **No
`claim_app_member` call remains anywhere in `src/`.**

Gates, once, at the end: `npx tsc --noEmit`, ESLint, production build,
`npm run check:worker-bundle`, `git diff --check`, full regression, mutation
suite. A survivor is a finding.

### Phase 5 — live, `xmas-family.uk`, QA Areas only

Existing-account invitation end to end. No-account invitation end to end,
including the real Resend email and the confirmation link. **Session retained** —
the invitee is never bounced to `/login`. Global approval while an invitation is
outstanding, then Accept, then immediate usability. Decline. Revoke. Re-invite
after decline. Two Areas held by one account, switcher correct. Mobile (Edge +
CDP emulation). No email address and no other family's name in any browser payload
on a pre-membership surface. **Protected fingerprint:** `Our family`, Christmas
2026 and the 8 historic notification rows unchanged before and after. **Cross-Area
integrity zero.**

---

## 16. Decisions, as answered

**No open questions remain.** All five were closed by the user; the design above
is the settled result.

### 1. Re-invite after decline — **ALLOW**

A decline is not permanent. A Family admin may invite the same person again
later. The reissue is **explicit and audited**, never a silent revival:
`grant_area_access` clears `declined_at` and sets `active = true`, and the event
is logged as `invitation_reissued` with `previous_state: 'declined'` (§12, §13).
The invitee must then Accept again — a cleared decline restores an *invitation*,
never a membership.

### 2. Admin-facing labels — **COLLAPSE to `Invitation pending`**

`Awaiting sign-up`, `Awaiting acceptance` and `Invitation sent` are **withdrawn
from the design**. Six labels remain, all pure functions of one
`list_area_access()` row (§11).

This is the decision with the widest blast radius, and it reached four places:

- **§3** — two derived states deleted; the state machine no longer contains any
  state that needs knowledge outside the database.
- **§7** — the "accepted residual" is gone. Account existence now lives for the
  duration of one request, inside the route, and is discarded.
- **§11** — one label, and **Resend invitation stays offered in every pending
  case**, because hiding it for existing accounts would rebuild the distinction.
- **§13** — the audit vocabulary had to change too. `audit_log` is readable by
  every member of the family, so a per-branch delivery record would have been
  the same oracle in slower, more durable form. `ready` covers both success
  branches (§7, §14 #14b).

The system still derives internally what delivery action is needed. It simply
never persists or returns that bit.

### 3. Invitation expiry — **NONE**

No `expires_at`, no derived `expired` state, no sweeper, no new transition in
053. Revoke is the only way an invitation ends without an answer. Provider-level
expiry on Auth setup and recovery links is unaffected and unchanged — those are
GoTrue's, and a stale one is re-minted by Resend invitation.

### 4. Invitation email audit — **YES, through a narrow boundary**

Recorded, and the service-role route gains **no** generic audit-writing power.
053 adds `record_invitation_delivery(p_person_id, p_outcome)`, called with the
administrator's own session rather than the service role, which authorises itself
exactly as `grant_area_access` does and chooses the Area, action word and summary
itself (§13). `area_id` is derived from the person and **is never NULL**. Nothing
sensitive is stored: no address — **not even its domain**, which the first pass
proposed and which is withdrawn — no body, no URL, no token, no key.

### 5. Second QA mailbox — **YES, LATER**

No address is invented here and none is assumed. The live no-account E2E is
gated on the user supplying a disposable mailbox at that point.

> **Cleanup hold, recorded here so a later phase does not undo it:**
> **QA Alpha, QA Charlie and Tricketts must not be deleted** until the live
> invitation tests that use them are complete. QA Bravo stays unless explicitly
> requested otherwise. `Our family` and Christmas 2026 remain protected
> throughout and are touched by nothing in this design.

---

## 17. Exact scope for Phase 3

Write and rehearse migration 053 — `declined_at` + its CHECK + one partial index;
**four** new routines (`list_my_family_invitations`, `accept_family_invitation`,
`decline_family_invitation`, `record_invitation_delivery`); four redefinitions
(`refuse_foreign_area_write`, `grant_area_access`, `list_area_access`,
`claim_app_member` → stub); no policy change; no backfill; no expiry. Produce
`docs/Q20-053-POST-APPLY-CHECKS.sql` and `docs/Q20-053-ROLLBACK.sql`. Run the
database matrix above, **including the two enumeration assertions** (§15: the
identical `list_area_access` row shape, and the byte-identical audit rows across
the two delivery branches). Confirm by live read that production holds no
unclaimed non-QA invitation.

**Do not apply to production and do not touch runtime source** — that is
Phase 4/5.
