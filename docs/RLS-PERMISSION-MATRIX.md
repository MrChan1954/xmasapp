# RLS permission matrix

What each kind of caller may do to each protected surface, and where that is
proved. **`scripts/rls-permission-matrix.test.mjs` is the source of truth** —
it executes every cell below against a real PostgreSQL. This file is the
summary; if the two disagree, the test is right.

Read it when changing a policy, a `SECURITY DEFINER` routine or a grant.
Reasoning about *why* the guards are shaped this way lives in
`docs/SECURITY-AND-QA.md`.

## The three outcomes

A test that cannot tell these apart will accept a setup failure as a security
control, so the suite names which one it expects.

| Outcome | What happened |
| ------- | ------------- |
| **allowed** | the statement ran and returned rows |
| **hidden** | the statement ran and returned nothing — RLS filtered it away |
| **refused** | the database raised, with a SQLSTATE (`42501` for a missing grant) |

## Callers

| # | Caller | In the fixture |
| - | ------ | -------------- |
| A | signed out | `anon` |
| B | signed in, no membership | `outsider` |
| C | member | Mo, in Alpha |
| D | member of another family | Sam, in Bravo |
| E | contributor | Jade, in Alpha |
| F | Area administrator | Ada (`dual`), acting in Alpha |
| G | **admin of two families** | `dual` — admin of Alpha *and* Charlie, member of Bravo |
| H | birthday celebrant | Taylor, in Alpha |
| I | celebrant **who is also the admin** | Ada, whose own birthday Alpha is planning |
| J | service role | server code only; bypasses RLS *and* the write barrier |

Caller **G** is the one that matters. Standing in Alpha and reaching for
Charlie, every *role* check passes — so only a check against the Area they are
**standing in** can refuse it. Aiming an attack at a family where the caller is
a mere member proves the admin check, not the Area check.

## The surface

All 22 tables have RLS enabled; **`anon` holds no grant on any table or view**.
The one view, `christmas_events`, is `security_invoker=true`, so it reads with
the caller's rights rather than its owner's.

The write surface a browser really has is much smaller than the policy list
suggests: most domain tables grant `authenticated` **SELECT only**, so their
write policies are unreachable and every write goes through a `SECURITY
DEFINER` routine instead.

| Surface | Scope | SELECT | INSERT / UPDATE / DELETE by a client |
| ------- | ----- | ------ | ------------------------------------ |
| `people`, `events`, `christmas_recipients`, `contributors`, `gift_ideas`, `purchases`, `purchase_allocations`, `recipient_contributions` | Area | members of the Area, **minus own-birthday rows** | refused — no grant; routines only |
| `settlements`, `payment_receipts` | Area (via event) | as above | refused — append-only to every client, admin included |
| `audit_log` | Area | members of the Area | refused — trigger-written only |
| `areas` | Area | members | refused (no write policy) |
| `app_members` | Area | own membership; admins see the Area's | refused |
| `birthday_wishlist_ideas` | Area | any member — a wishlist is meant to be read | **the celebrant only**, for their own |
| `notifications`, `notification_preferences`, `push_subscriptions` | **account, not Area** | own rows only | own rows; `notifications` allows the read flag and nothing else |
| `notification_events`, `notification_outbox`, `birthday_reminders`, `birthday_budget_summaries` | service role | refused (`42501`) | refused — RLS on, no policy, no grant |

## The rules the matrix proves

1. **The acting Area governs every mutating routine.** 34 cross-Area calls were
   attempted from Alpha against Bravo *and* against Charlie; all 34 refused,
   and the same calls succeed when the caller stands in the right Area.
2. **Membership is not permission to act.** Belonging to Alpha and Bravo does
   not let an Alpha-acting caller write into Bravo.
3. **A hostile or stale `x-area-id` yields no acting Area**, not somebody
   else's. An account in three families with no choice made gets none — never a
   guess.
4. **Reads are membership-scoped; writes are acting-Area-scoped.** RLS SELECT
   policies ask which families you *belong to*. This is deliberate and it is
   why every screen must filter by the acting Area itself — `/more/activity`
   does, and Q10 fixed it when it did not.
5. **Self-privacy outranks Admin.** The celebrant sees none of their own
   planning, even holding every permission the application has.
6. **Money moves only between its two people.** Only the payer or the receiver
   may record a payment; **only the receiver may confirm or reject it** — an
   Area administrator is refused. The audited override
   (`admin_record_confirmed_payment`) is admin-only and cannot cross a family
   line.
7. **Evidence is append-only.** No client may rewrite or delete a receipt.

## Open findings

Three tests in section **J** of the suite are **failing on purpose**. They state
the rule the application is supposed to keep and do not yet hold. Each needs a
policy or routine change, so each waits on **migration 050**; none can be
repaired in application code, because the rule must hold for anything holding a
session key, not only for the screens this repository draws.

| ID | Surface | What leaks |
| -- | ------- | ---------- |
| **RLS-1** | `audit_log` SELECT policy | The celebrant is shown the **name and price** of their own present. The policy never gained the `NOT is_own_birthday_...` clause every other planning table has, and More → Activity renders `subject` and `amount_pennies`. |
| **RLS-2** | `set_purchase_status`, `void_purchase` | Both are `SECURITY DEFINER` and **return the row**, so definer rights hand the celebrant the description and price that `purchases`' own policy withholds. |
| **RLS-3** | `save_gift_idea` | Refuses another Area, but never asks whether the recipient is the caller's **own** birthday — so the celebrant can overwrite the idea recorded for them, and the returned row names who suggested it. |

## Running it

```
npm run test:rls-matrix
```
