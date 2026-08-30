# Q15 — Database canonical-system audit

**Read on demand.** Does Gift Planner have exactly one authoritative database
system per business concept, and what in the current schema is redundant?

**Taken at:** 2026-08-30. HEAD `7a1fce3`, migrations 001–050, working tree clean.
**No database object was created, altered or dropped. Migration 051 was NOT
written.** Every probe below ran against a disposable in-memory PGlite built
from the committed migrations; production was never connected to.

---

## 1. Method

Same rehearsal as Q14 — `scripts/pg/rehearsal.mjs` replays all fifty migrations
plus `seed.sql` and the `rls_auto_enable` fixture into a real PostgreSQL 18 —
but Q15 goes further than reading catalogues. Where a question could be settled
by *running* something, it was:

- **`DROP FUNCTION … RESTRICT`** was executed against the three suspected
  orphans. PostgreSQL refuses a RESTRICT drop if any catalogue object depends on
  the function, so a clean drop is the database's own testimony that nothing
  depends on it. Stronger than any grep.
- **`TRUNCATE` and DML were attempted as a real `authenticated` session**,
  through `request()` — the same `set local role` + JWT claims + pre-request
  hook shape PostgREST uses — to find out what the wide grants actually buy.
- Callers were resolved from `pg_proc.prosrc` of the **final** definition of
  every routine, never from migration text. A routine that migration 012 called
  and migration 045 stopped calling counts as uncalled here, which is the point.

**Historical migration text is not a runtime caller.** Several tests match on
the text of migrations 012, 031 and 039; those assertions describe immutable
files and survive any future change to the live schema. They are recorded below
where they matter and excluded from the dependency verdicts where they do not.

---

## 2. Correction carried in from the user: the Q12 post-apply checks

Q14 recorded that `docs/Q12-POST-APPLY-CHECKS.sql` had never been run. **That
was wrong.** It was run manually in the Supabase SQL Editor after migration 050
and every check passed. Recorded here so the fact stops drifting:

| Check | Production result |
| ----- | ----------------- |
| Both privacy columns exist | pass |
| `celebrant_person_id` has no FK | pass |
| Coherence constraint present | pass |
| Partial index present | pass |
| `audit_log` SELECT policy carries all four clauses | pass |
| All three own-birthday guards present | pass |
| All four stamping routines write privacy metadata | pass |
| `anon` has no grant on `audit_log` | pass |
| Entries stamped with `celebrant_person_id` | **92** |
| Entries marked `birthday_privacy_unknown` | **154** |
| Entries both stamped and unknown | **0** |
| Structural disagreements | **0** |
| Unclassified planning-sensitive rows | **0** |
| Christmas / non-birthday rows wrongly stamped | **0** |
| Historic Area-less audit rows, still Area-less | **26** |
| `audit_log` total at that check | **464** |
| Privacy verdict split | birthday 92 · not-a-birthday 172 · not-sensitive 46 · unresolvable 154 |
| Distinct celebrants protected | **11** |

**Do not carry "Q12 post-apply checks unrun" forward again.** What those checks
did *not* cover is grants and index statistics — so UNKNOWN-2 and UNKNOWN-3 from
Q14 stand on their own merits, not on this.

---

## 3. One system per concept

Legend — **Split intentional?** answers "is more than one object involved on
purpose", not "is there a duplicate".

### Areas / tenancy — ONE SYSTEM. Confidence: **High**

| | |
| --- | --- |
| Source of truth | `areas` |
| Canonical modules | `lib/areas.ts` (holds `AREA_COOKIE = "gp_area"`, single-sourced), `utils/supabase/areas-server.ts`, `utils/area-cookie.ts`, `app/family-context.tsx` |
| Canonical routines | `create_area`, `set_area_name`, `set_area_archived`, `leave_area`, `transfer_area_admin` |
| Acting-Area mechanism | **one**: `claim_active_area()` installed as `pgrst.db_pre_request` on `authenticator`, read back by `acting_area()`, asserted by `require_acting_area()` (22 routines) and `is_acting_area()` |
| Membership scope | **one**: `is_area_member(area_id)` — 24 policies |
| Write barrier | **one**: `refuse_foreign_area_write` — 13 tables |
| Parallel/legacy path | **none found.** No pre-Areas "family" or "tenant" scoping survives. |

**Two mechanisms, deliberately, and they answer different questions.** RLS asks
*may this account see this Area at all* (`is_area_member` — membership).
The acting Area asks *which Area is this request about* and is enforced for
writes by `refuse_foreign_area_write` and for reads by the application's own
`.eq("area_id", areaId)`. Measured: a member of three Areas, acting in Alpha,
can `SELECT` wishlist rows from all three; a member of Bravo alone sees only
Bravo. That is the design, not a leak — and it is why the write barrier exists
rather than being folded into the read policies.

### People / identity — ONE SYSTEM. Confidence: **High**

`people` is the one person record. `auth.users` is login identity and is
**intentionally separate**; `app_members` is the join between them, per Area.
There is no second profile model. `create_person`, `set_person_name`,
`set_person_archived`, `set_person_birthday` are the only writers, all
Area-derived since migration 047. No stale account→person mapping was found:
`app_members.person_id` is the live link and every reader uses it.

### Membership / admin / roles — ONE SYSTEM. Confidence: **High**

`app_members` with `role in ('admin','member')` and `active`. Admin questions go
through `is_app_admin()` (acting Area since 038) and `is_area_admin(area_id)`;
`is_own_app_member` guards self-reads in 9 policies. Integrity is held by
`refuse_area_without_one_admin` and `refuse_last_admin_removal`. Migration 004's
`role = 'family'` default was normalised to `member` before migration 034 and no
row carries it now. **No parallel roles system.**

### Contributors — ONE SYSTEM, THREE LAYERS. Confidence: **High**

This one needed the most care, and the four pieces are **not** duplicates of one
another. They answer different questions:

| Piece | What it is | Class |
| ----- | ---------- | ----- |
| `people.is_family_contributor` | **Contributor truth.** Is this person, in this Area, someone who chips in? A property of the person. | **REQUIRED** |
| `contributors` (row per event) | **Participation.** Is this person a contributor *to this occasion*? Carries `active`, and purchase allocations point at it. | **REQUIRED** |
| `app_members.contributor_id` | A denormalised pointer from a membership to one `contributors` row. **Written only by migration 004's original insert — nothing has written it since.** | **LEGACY BUT LIVE** |
| `is_area_contributor_member(area_id)` | The Area-aware predicate. | **REQUIRED** |
| `is_family_contributor_member()` | Its pre-Areas ancestor, kept by 039 for name compatibility. | **REDUNDANT** |

`app_members.contributor_id` is read by five places —
`current_app_contributor_id` (which prefers it, then falls back to
`person_id`), `app/owed/owed-data.ts:86`, `app/add-purchase/purchase-form.tsx:206`,
`api/admin/family-access/route.ts` (surfaced in the membership payload, and
commented there as *"a legacy tie-break"*), and `lib/notification-dispatch.ts`.
**Every one of them already has a `person_id` fallback**, which is why the
column being frozen since 004 has never shown. Removing it needs a small runtime
refactor and **no data migration**; it is not urgent and it is not a duplicate
source of truth, because nothing writes it.

**Contributor changes affect future purchases only**, and that invariant lives in
`purchase_allocations` being an immutable snapshot — not in any of the four
pieces above. Confirmed: no routine rewrites an existing allocation.

### Events — ONE MODEL. Confidence: **High**

`events` is the single model; `event_type` distinguishes `christmas` from
`birthday`. Both semantics use it — there is no separate birthday table.

**`events.year` is REQUIRED, not legacy.** It is not redundant with
`event_date`; it carries the Christmas uniqueness key:

```
events_one_christmas_per_area_year_idx  UNIQUE (area_id, year) WHERE event_type = 'christmas'
events_christmas_has_year_check         CHECK (event_type <> 'christmas' OR year IS NOT NULL)
events_year_range_check                 CHECK (year IS NULL OR year BETWEEN 1900 AND 2999)
```

Birthdays key off `EXTRACT(year FROM event_date)` in their own partial unique
index, so the two never collide. Dropping `year` would drop the "one Christmas
per family per year" invariant.

**The `christmas_events` view is SUPPORTING, and is not a second source of
truth.** It is `security_invoker=true, check_option=cascaded` over `events`:

```sql
SELECT id, year, name, created_at FROM events WHERE event_type = 'christmas';
```

No independent state, RLS applies through it, and writes through it cannot
escape `event_type = 'christmas'`. Consumers, in the final schema — **three
routines and no application code**: `area_of_record` (branches on the table name
`'christmas_events'`), `save_christmas_recipient_with_contributions`
(validation), and `save_christmas_recipient` (itself redundant — §4).
`events-server.ts:235` carries a comment saying the app deliberately reads
`events` instead. **It should remain** while the legacy `/owed`-era routes and
`area_of_record`'s table-name branch do.

### Recipients — ONE REPRESENTATION. Confidence: **High**

`christmas_recipients` (row per person per event), unique on
`(christmas_event_id, person_id)`. `add_event_recipient`,
`save_christmas_recipient_with_contributions` and
`set_christmas_recipient_active` are the writers. `protect_event_scope_identity`
and `enforce_event_scope_integrity` stop a row being moved between events.

### Budgets / contributions — ONE SYSTEM. Confidence: **High**

`christmas_recipients.budget_pennies` is the recipient's target;
`recipient_contributions.planned_amount_pennies` is who covers it. The two are
tied by `enforce_recipient_budget_allocation_invariant` on both tables.
**Recipient budgets are targets, not caps** — confirmed: no routine refuses a
purchase for exceeding one. `save_christmas_recipient_with_contributions` is the
single atomic writer; it inlines the work the two redundant routines in §4 once
did.

### Gift ideas — ONE SYSTEM. Confidence: **High**

`gift_ideas`, with `save_gift_idea` / `remove_gift_idea` / `list_gift_ideas` as
the only routines and one provenance path: `gift_ideas.suggested_by_app_member_id`,
guarded by `refuse_cross_area_idea_author` and frozen by
`protect_gift_idea_identity`. Removal is `remove_gift_idea` alone —
`purchases.originating_gift_idea_id` is `ON DELETE SET NULL`, so a removed idea
never orphans a purchase.

### Purchases / allocations — ONE LIFECYCLE. Confidence: **High**

One entry point chain: `save_purchase_with_location` → `save_purchase`. One
status mechanism: `purchases.status`, moved only by `set_purchase_status` and
`void_purchase`. One allocation system: `purchase_allocations`, unique on
`(purchase_id, contributor_id)`, written inside `save_purchase` and never
rewritten afterwards — the immutable historical snapshot the money invariants
depend on. **No second purchase path exists.**

### Settlements / payments — ONE STATE MACHINE. Confidence: **High**

`settlements` holds the state; `payment_receipts` is the append-only history,
enforced by the `payment_receipts_are_append_only` trigger. Transitions:
`record_settlement` → `review_payment` → `void_settlement`, plus
`admin_record_confirmed_payment` for a payment recorded out of band.
**Receiver confirmation is authoritative** — Q12 proved at the database layer
that an Area admin is explicitly refused as a confirmer, and that has not
changed. "Owed" is computed, not stored: `lib/owed.ts` and
`app/owed/owed-data.ts` derive it from purchases, allocations and confirmed
settlements. **There is no parallel payment ledger** — one state table, one
receipt table, one derivation.

### Notifications — ONE PIPELINE, THREE STAGES. Confidence: **High**

Not three systems. Three stages of one:

| Table | Stage |
| ----- | ----- |
| `notification_events` | the domain event, deduplicated on `(kind, subject_id, fingerprint)` |
| `notification_outbox` | the retry queue for push delivery, same dedup key |
| `notifications` | the per-member inbox row, unique per event per recipient |

One fanout mechanism: five `enqueue_*` triggers → `enqueue_notification_event()`
→ `lib/notification-dispatch.ts`, which is the **only** writer of all three
tables. One read/unread system: `notifications.read_at`, written by
`markNotificationsRead`. One device registry: `push_subscriptions`, unique on
`endpoint`. Content is frozen by `protect_notification_content`. The bell is
deliberately **account-global** and stays that way.

### Audit / activity — ONE TRAIL. Confidence: **High**

`audit_log` and nothing else — there is no second activity store. Writers are
exactly three trigger functions: `record_audit_event` (10 tables),
`record_birthday_audit_event` (`people`), and `stamp_audit_area` (a `BEFORE`
trigger on `audit_log` itself that derives `area_id` via `area_of_record` and,
since 050, the birthday-privacy metadata). **Migrations 049/050 are the current
canonical audit-metadata path**, confirmed by the production results in §2. The
26 Area-less historic rows and the 154 `birthday_privacy_unknown` rows stay as
they are, by decision.

### Settings — ONE STORE PER CATEGORY. Confidence: **High**

`lib/settings-scopes.ts` names three scopes (global / area / event) and each
category has exactly one home:

| Category | Store |
| -------- | ----- |
| Notification preferences | `notification_preferences` (DB, per `app_member`) |
| Theme | `next-themes` → `localStorage` |
| Falling snow | `localStorage` (`festive-context.tsx`) |
| Password | Supabase Auth |
| Area name / membership | `areas`, `app_members` via routines |
| Event settings | `events` via `update_event`, `set_event_status` |

No setting is stored in two places.

### Birthdays / privacy — ONE REPRESENTATION, ONE MECHANISM. Confidence: **High**

One birthday representation: `people.birthday_month/_day/_year`, with
`birthday_occurrence_date()` deriving an occurrence. Planning is an `events` row
with `event_type = 'birthday'`.

One privacy mechanism, and **birthday self-privacy beats Admin**: the four
`is_own_birthday_*` predicates (16 policies between them), `is_own_wishlist_person`
(3), `refuse_starting_own_birthday`, `anchor_wishlist_idea`, and — for the audit
trail — 050's `celebrant_person_id` / `birthday_privacy_unknown` stamping.
**No competing old privacy helper is still wired in.** The one survivor,
`is_family_contributor_member`, is a *contributor* predicate rather than a
privacy one and reaches nothing; see §4.

---

## 4. The three Q15 legacy candidates — dependency proof

Each was checked against **eight** dependency kinds, then the database was asked
directly.

### A. `is_family_contributor_member()` → **REDUNDANT**

`SECURITY DEFINER`, `search_path` pinned, `EXECUTE` to `authenticated` and
`service_role`.

| Dependency kind | Result |
| --------------- | ------ |
| Other SQL functions | **NONE** |
| RLS policies | **NONE** |
| Trigger attachments | **NONE** |
| Constraints / indexes / views | **NONE** |
| `src/` application code | **NONE** |
| API routes / service-role modules | **NONE** |
| `.github/` background jobs | **NONE** |
| PostgREST pre-request hook | **NONE** (the hook is `claim_active_area`) |

Superseded by `is_area_contributor_member(uuid)` in migration 039, which kept
the old name alive as a delegating wrapper. `scripts/birthday-wishlist.test.mjs`
already calls it "legacy" and asserts that `set_person_birthday` does *not* use
it.

**`DROP FUNCTION public.is_family_contributor_member() RESTRICT` succeeded** in
the rehearsal, and no remaining routine body names it.

**One companion change is required, and it is the reason this is not a
one-line drop.** `scripts/mutation-check.mjs` mutation **9** — *"set_person_birthday
goes back to asking the global question"* — reverts migration 039 so the routine
calls `is_app_admin() or is_family_contributor_member()`. PostgreSQL does not
track function-to-function dependencies inside a `$$` body, so a later drop
would succeed and the mutant would then die of *"function does not exist"* at
runtime. Per `CLAUDE.md`, **a mutation must be killed by a behavioural test, and
an undefined-function error is not a behavioural kill.** Mutation 9 must be
rewritten in the same change that drops the function, or the drop deferred.

The three test files that match its *name* — `rls-security.test.mjs`,
`migration-execution.test.mjs`, `birthday-wishlist.test.mjs` — all assert against
migration 031/039 **text**, or against a rehearsal built `through` migration 039.
None reads the final catalogue. All three survive a drop unchanged; verified by
reading each assertion and each `buildRehearsal({ through: … })` scope.

### B. `save_christmas_recipient(uuid, uuid, text, integer)` → **REDUNDANT**

`service_role` / `postgres` only — **`authenticated` cannot reach it at all**,
revoked by migration 012 and never re-granted.

All eight dependency kinds: **NONE**. Superseded by
`save_christmas_recipient_with_contributions`, which does the recipient save and
the allocations in one transaction. **`DROP … RESTRICT` succeeded.**

Its body still calls `is_app_admin()` globally and inserts into `people` without
an `area_id` — behaviour that predates Areas. It is unreachable, so this is
latent rather than live, but it is one more reason not to leave it lying about.

### C. `save_recipient_contributions(uuid, jsonb)` → **REDUNDANT**

Identical position: `service_role`/`postgres` only, all eight dependency kinds
**NONE**, superseded by the same atomic routine, **`DROP … RESTRICT`
succeeded**.

### The migration-047 note that no longer matches

Migration 047's rationale lists all three of `save_purchase`,
`save_christmas_recipient` and `save_recipient_contributions` as *"inner
routines … reached only through wrappers that 045 already guards"*. That is
**true of `save_purchase` alone** — `save_purchase_with_location` really does
call it, so `save_purchase` is **SUPPORTING, not redundant**. It is no longer
true of the other two. Reality is stricter than the note, so nothing is at risk;
the migration is immutable and is not edited.

### After all three drops, the catalogue is unchanged elsewhere

Functions 96 → **93**. Policies **37**, triggers **61**, indexes **77** — all
identical. `is_area_contributor_member` and
`save_christmas_recipient_with_contributions` still present;
`set_person_birthday` still raises its own authorization refusal.

---

## 5. The wide grants — a real finding

Q14 flagged `areas` and `birthday_wishlist_ideas` as carrying `authenticated =
arwdDxtm` (everything) while their policies permit far less, and could not say
whether that was deliberate. **It is not deliberate, and it is not harmless in
the way "RLS constrains it" suggests.**

**Where it comes from.** Supabase's project default privileges —
`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES
TO postgres, anon, authenticated, service_role` — hand every new table ALL to
`authenticated`. Every other table's migration revoked first and granted back
narrowly. These two did not:

- migration 034: `grant select on table public.areas to authenticated;` — no revoke
- migration 040: `revoke all … from anon;` then `grant select, insert, update, delete … to authenticated;` — revokes `anon`, never `authenticated`

So both tables keep the blanket default *plus* the intended grant. They are the
**only two** of the twenty-three that do.

**Why it matters: RLS does not constrain `TRUNCATE`.** Row policies are never
consulted for a truncate; it is a table-level privilege only. Measured in the
rehearsal, as an ordinary `authenticated` member acting in their own Area:

| Statement | `areas` | `birthday_wishlist_ideas` |
| --------- | ------- | ------------------------- |
| `SELECT` | allowed, RLS-narrowed | allowed, RLS-narrowed |
| `INSERT` | **refused** by RLS | refused |
| `UPDATE` | allowed, **0 rows** (no policy matches) | allowed, 0 rows |
| `DELETE` | allowed, **0 rows** | allowed, 0 rows |
| `TRUNCATE` | refused — *"cannot truncate a table referenced in a foreign key constraint"* | **SUCCEEDED** |

Control: `TRUNCATE` on `people`, `events` and `audit_log` was refused with
*permission denied* — those tables were revoked properly.

Measured impact on `birthday_wishlist_ideas`: three Areas holding one wishlist
row each, **all three destroyed**, including the Area the member was not acting
in. RLS narrowed the member's `DELETE` to their own rows, exactly as designed;
`TRUNCATE` ignored it entirely.

**Is it exploitable today? No — and that is the uncomfortable part.** PostgREST
maps only GET/POST/PATCH/DELETE onto SELECT/INSERT/UPDATE/DELETE plus RPC. There
is no TRUNCATE verb, no `SECURITY INVOKER` routine issues one, and a browser
holds a JWT rather than database credentials. **The protection is the client
protocol's verb set, not the grant.** `CLAUDE.md` is explicit that *UI hiding is
never authorization; the database must refuse on its own* — the same reasoning
applies to protocol-shape hiding. And `areas` is protected only by an accident
of its foreign keys, which a future schema change could remove without anyone
connecting the two.

**Classification: broader than needed; candidate for tightening.**
Not changed in Q15.

---

## 6. Index usage — UNKNOWN, deliberately

`pg_stat_user_indexes` was **not** read: this session has no production database
connection, and the phase forbids mutation but does not grant one. The rehearsal
has zero statistics by construction, and **no index may be judged on that** —
a fresh in-memory database has never served a query.

All 77 indexes are therefore **UNKNOWN for removal purposes** and **REQUIRED in
practice** until measured. Note that a meaningful number are not performance
objects at all but **invariants** — `events_one_christmas_per_area_year_idx`,
`events_one_birthday_per_person_per_year_idx`,
`purchases_one_active_purchase_per_idea_idx`,
`birthday_wishlist_one_wish_per_year_idx`,
`app_members_one_membership_per_person_idx`, `notifications_event_recipient_key`,
`item_photos_storage_path_key`, `push_subscriptions_endpoint_key` and the
various `_key` uniques. **Those are not candidates for removal at any scan
count**, and a Q16 that reads `idx_scan` must exclude every unique and partial
unique index before drawing conclusions.

---

## 7. Classification of every object Q14 flagged

| Object | Class | Basis |
| ------ | ----- | ----- |
| `is_family_contributor_member()` | **REDUNDANT** | 8/8 dependency kinds none; clean RESTRICT drop |
| `save_christmas_recipient(…)` | **REDUNDANT** | 8/8 none; unreachable by `authenticated`; clean drop |
| `save_recipient_contributions(…)` | **REDUNDANT** | 8/8 none; unreachable by `authenticated`; clean drop |
| `save_purchase(…)` | **SUPPORTING** | called by `save_purchase_with_location` |
| `christmas_events` view | **SUPPORTING** | 3 routine consumers; `security_invoker`, no independent state |
| `events.year` | **REQUIRED** | carries the Christmas uniqueness key and two check constraints |
| `app_members.contributor_id` | **LEGACY BUT LIVE** | frozen since 004; 5 readers, all with a `person_id` fallback |
| `authenticated` grant on `areas` | **BROADER THAN NEEDED** | default-privilege residue; TRUNCATE blocked only by FKs |
| `authenticated` grant on `birthday_wishlist_ideas` | **BROADER THAN NEEDED** | default-privilege residue; TRUNCATE demonstrably works |
| All 77 indexes | **UNKNOWN / REQUIRED in practice** | no production statistics; many are invariants |
| 12 trigger functions with `anon` EXECUTE | **SUPPORTING, harmless** | PostgreSQL refuses direct invocation (`0A000`) |
| `rls_auto_enable` + its event trigger | **SUPPORTING (platform)** | Supabase state; do not adopt or drop |
| `birthday_reminders`, `birthday_budget_summaries`, `notification_events`, `notification_outbox` | **REQUIRED** | no grant, no policy, service-role only — correct by design |

---

## 8. Proposed migration 051 — NOT WRITTEN, AWAITING APPROVAL

Presented for review as `CLAUDE.md` requires. **Nothing has been written or
applied.**

**1. Exact objects proposed for removal or change**

```sql
drop function if exists public.is_family_contributor_member();
drop function if exists public.save_christmas_recipient(uuid, uuid, text, integer);
drop function if exists public.save_recipient_contributions(uuid, jsonb);

revoke all on table public.areas from authenticated;
grant select on table public.areas to authenticated;

revoke all on table public.birthday_wishlist_ideas from authenticated;
grant select, insert, update, delete on table public.birthday_wishlist_ideas to authenticated;
```

**2. Why each is redundant or wrong**
The three routines have no caller of any kind and are superseded by
`is_area_contributor_member` and
`save_christmas_recipient_with_contributions`. The two grants hand
`authenticated` TRUNCATE, REFERENCES, TRIGGER and MAINTAIN that no code path
uses and that RLS cannot constrain; the revoke-then-grant restores exactly the
privileges migrations 034 and 040 intended.

**3. Dependency proof** — §4 and §5 above: eight dependency kinds each, plus
`DROP … RESTRICT` succeeding in the rehearsal, plus a measured TRUNCATE.

**4. Security impact** — **Strictly narrowing.** Removes one orphaned routine
from the `authenticated` RPC surface and removes a cross-Area destructive
capability that currently survives only because PostgREST has no verb for it.
No policy, predicate or guard is touched. No routine loses a check.

**5. Data impact** — **None.** No row is read, written or deleted. The
`revoke`/`grant` pair is a catalogue change. `Our family` and Christmas 2026 are
untouched.

**6. Backup requirement** — a fresh production backup **before applying**, via
`.github/workflows/database-backup.yml` (or a manual run of it), with the dump
verified by `scripts/verify-backup-dump.awk`. The workflow runs `17 3 * * *`; do
not rely on an overnight run — take one deliberately and confirm it.

**7. Migration 051 outline**
Header explaining what is dropped and why, quoting the dependency proof. The
three drops, each with `if exists`. The two revoke-then-grant pairs. A closing
`do $$ … $$` end-state block in the house style, asserting: the three routines
are absent; `is_area_contributor_member` and
`save_christmas_recipient_with_contributions` are present; `authenticated` holds
exactly `SELECT` on `areas` and exactly `SELECT, INSERT, UPDATE, DELETE` on
`birthday_wishlist_ideas`; and the policy, trigger and index counts are
unchanged at 37 / 61 / 77.

**8. Rehearsal plan**
Replay 001–051 in PGlite and assert the end state. Re-run
`test:migrations`, `test:security`, `test:rls-matrix`, `test:tenancy-runtime`,
`test:area-mutation-security`, `test:birthday-wishlist`, `test:events-recipients`,
then the full suite. **Rewrite mutation 9 first** (§4A) and prove the rewritten
mutant is still killed behaviourally. Add a new mutation that restores the
TRUNCATE grant and is killed by a test that actually attempts a truncate as
`authenticated` — the finding in §5 currently has no test holding it.

**9. Rollback plan** — `docs/Q15-051-ROLLBACK.sql`, in the shape of
`docs/Q12-050-ROLLBACK.sql`: re-create the three routines verbatim from
migrations 031/039 and 011/012 (bodies are recoverable from the immutable
files), and re-issue `grant all on table … to authenticated` for the two tables.
Both halves are catalogue-only, so rollback loses no data.

**10. Post-apply checks** — `docs/Q15-POST-APPLY-CHECKS.sql`, one read-only
`SELECT` in the house style: the three routines absent; their replacements
present; `has_function_privilege('authenticated', …)` false for the dropped
names; `relacl` on both tables showing exactly the intended letters and **no
`D`**; policy/trigger/index counts unchanged; and a row count on
`birthday_wishlist_ideas` and `areas` proving nothing was destroyed.

**Is migration 051 recommended?** Yes for the two grants — that closes a real,
measured gap. The three routine drops are tidying and could ride along or wait.
**Neither has been written. Neither may be applied without explicit approval.**

---

## 9. Unknowns still open

**U-1 — production index statistics.** No production connection this session.
Settled by one read-only `SELECT` on `pg_stat_user_indexes`, excluding every
unique/partial-unique index first. Risk of acting early: a dropped index is a
silent performance regression on real family data with no staging.

**U-2 — whether production's `relacl` matches the rehearsal's.** The rehearsal's
default-privilege block is copied from a real production dump, so the wide
grants are very likely faithful — but §5's conclusion should be confirmed by
reading `pg_class.relacl` for `areas` and `birthday_wishlist_ideas` in the SQL
Editor before any 051 is applied.

**U-3 — the three `*-taylor*` operator scripts.** Carried forward from Q14,
unchanged: static analysis cannot prove a human does not run them. A question
for the user, not for a grep.

---

## 10. What this phase did not do

No database object created, altered or dropped. No migration written. No
production connection opened, no production row read or written. `Our family`
and Christmas 2026 untouched. No grant changed. No security control weakened.
The only changes in the working tree are this file, the two corrections to
`docs/CURRENT-STATE.md` and `docs/Q14-SYSTEM-INVENTORY.md`, and the migration
range in `CLAUDE.md`.
