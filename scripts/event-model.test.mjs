import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Migration 025, read as text.
 *
 * WHY TEXT
 *   Nothing in this repository can run Postgres, so no test here can execute
 *   the SQL. What it CAN do is hold the file to the promises the Event layer is
 *   built on, every one of which is visible in the text: that it renames rather
 *   than rebuilds, that it never writes to a financial table, that the
 *   compatibility view cannot leak, that both guards exist on every table they
 *   claim to protect, and that the file measures the money before and after and
 *   refuses to finish if a penny moved.
 *
 *   The arithmetic half of the proof lives in `scripts/event-scoping.test.mjs`,
 *   which runs the real Owed engine over a two-event family. The runtime half
 *   is the migration's own assertion blocks, which fire when it is applied.
 */

const root = process.cwd();
const migrationsDirectory = join(root, "supabase", "migrations");
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const eventMigrationName = "202608100025_generalise_christmas_into_events.sql";
const birthdayMigrationName = "202608100026_add_birthdays_and_event_administration.sql";
const birthdayMigration = readFileSync(join(migrationsDirectory, birthdayMigrationName), "utf8").replace(/\r\n/gu, "\n");
const birthdayMigrationCode = birthdayMigration.replace(/--[^\n]*/g, "");

const reminderMigrationName = "202608100027_two_stage_birthday_reminders_and_safe_event_deletion.sql";
const reminderMigration = readFileSync(join(migrationsDirectory, reminderMigrationName), "utf8").replace(/\r\n/gu, "\n");
const reminderMigrationCode = reminderMigration.replace(/--[^\n]*/g, "");

const occasionMigrationName = "202608100028_add_mothers_and_fathers_day.sql";
const occasionMigration = readFileSync(join(migrationsDirectory, occasionMigrationName), "utf8").replace(/\r\n/gu, "\n");
const occasionMigrationCode = occasionMigration.replace(/--[^\n]*/g, "");

const budgetMigrationName = "202608100029_add_monthly_birthday_budget_reminder.sql";
const budgetMigration = readFileSync(join(migrationsDirectory, budgetMigrationName), "utf8").replace(/\r\n/gu, "\n");
const budgetMigrationCode = budgetMigration.replace(/--[^\n]*/g, "");

const contributorMigrationName = "202608100030_family_contributors_and_atomic_setup.sql";
const privacyMigrationName = "202608100031_birthday_privacy_and_contributor_birthday_edits.sql";
const peopleMigrationName = "202608100032_people_directory.sql";
const membershipMigrationName = "202608100033_membership_guards.sql";
const contributorMigration = readFileSync(join(migrationsDirectory, contributorMigrationName), "utf8").replace(/\r\n/gu, "\n");
const contributorMigrationCode = contributorMigration.replace(/--[^\n]*/g, "");
const eventMigration = readFileSync(join(migrationsDirectory, eventMigrationName), "utf8").replace(/\r\n/gu, "\n");
/** Comments explain the reasoning at length; assertions about CODE must ignore them. */
const eventMigrationCode = eventMigration.replace(/--[^\n]*/g, "");

/**
 * Every financial table. If the Event layer writes to one of these, the whole
 * premise -- "the ids do not change, so the money does not move" -- is false.
 */
const financialTables = [
  "christmas_recipients",
  "contributors",
  "recipient_contributions",
  "gift_ideas",
  "purchases",
  "purchase_allocations",
  "settlements",
  "payment_receipts",
];

// ---------------------------------------------------------------------------
// The migration history is append-only
// ---------------------------------------------------------------------------

test("migration 047 is the newest migration, and nothing else has been added", () => {
  // Pinned deliberately. Adding a migration fails this test on purpose, so a
  // schema change cannot land without this file being reviewed and its checks
  // extended to whatever the new migration introduced.
  //
  // 026 is Checkpoint 4: birthdays on people, the event administration
  // functions, and the reminder bookkeeping. Its own promises are held by
  // `scripts/event-administration.test.mjs` and
  // `scripts/birthday-reminders.test.mjs`; what THIS file still owns is that
  // 025 remains the Event layer and that 026 did not disturb it.
  assert.equal(migrationFiles.at(-1), "202608100047_area_scoped_person_routines.sql");
  assert.equal(migrationFiles.at(-2), "202608100046_area_scoped_gift_idea_removal.sql");
  assert.equal(migrationFiles.at(-3), "202608100045_area_scoped_mutation_hardening.sql");
  assert.equal(migrationFiles.at(-4), "202608100044_area_scoped_person_administration.sql");
  assert.equal(migrationFiles.at(-5), "202608100043_birthday_planning_eligibility.sql");
  assert.equal(migrationFiles.at(-6), "202608100042_area_membership_lifecycle.sql");
  assert.equal(migrationFiles.at(-7), "202608100041_area_admin_handover.sql");
  assert.equal(migrationFiles.at(-8), "202608100040_own_birthday_wishlist.sql");
  assert.equal(migrationFiles.at(-9), "202608100039_area_aware_contributor_permissions.sql");
  assert.equal(migrationFiles.at(-10), "202608100038_acting_area.sql", "038 is still present, unedited");
  assert.ok(migrationFiles.includes(membershipMigrationName), "033 is still present, unedited");
  assert.equal(migrationFiles.length, 47);

  /*
   * 039 ONWARDS REWRITE NO ROW.
   *
   * 039 replaces four function bodies and adds one trigger; 040 adds one empty
   * table. 041-043 are Q2's Area lifecycle. 044 is Q3: two function bodies that
   * asked "am I an administrator?" without ever asking "of WHICH family?", and
   * one new one so a misspelled name can be corrected at all.
   *
   * Between them they are the whole of the post-Phase-5 work, and not one of
   * them is allowed to touch a single piece of existing family data --
   * Christmas 2026 included, which is live money.
   */
  for (const name of [
    "202608100039_area_aware_contributor_permissions.sql",
    "202608100040_own_birthday_wishlist.sql",
    "202608100041_area_admin_handover.sql",
    "202608100042_area_membership_lifecycle.sql",
    "202608100043_birthday_planning_eligibility.sql",
    "202608100044_area_scoped_person_administration.sql",
    "202608100045_area_scoped_mutation_hardening.sql",
  ]) {
    const sql = readFileSync(join(migrationsDirectory, name), "utf8")
      .replace(/\r\n/gu, "\n")
      // Function bodies stripped first: a routine that inserts an event is a
      // routine, not a backfill. Migration 043 supersedes one that does exactly
      // that, and reproducing it is the point of the file.
      .replace(/create or replace function[\s\S]*?\$\$;/gu, "")
      .toLowerCase();
    for (const forbidden of [
      "drop table", "drop column", "truncate", "delete from public.",
      "update public.purchases", "update public.christmas_recipients",
      "update public.purchase_allocations", "update public.settlements",
      "update public.contributors", "update public.recipient_contributions",
      "update public.payment_receipts", "update public.events",
      "insert into public.purchases", "insert into public.events",
      "alter table public.purchases", "alter table public.events",
    ]) {
      assert.ok(!sql.includes(forbidden), `${name} must not ${forbidden}`);
    }
  }
  for (const name of [
    eventMigrationName, birthdayMigrationName, reminderMigrationName,
    occasionMigrationName, budgetMigrationName, contributorMigrationName,
    privacyMigrationName,
  ]) {
    assert.ok(migrationFiles.includes(name), `${name} is still present, unedited`);
  }

  // 032 is the People directory: one nullable column and two functions. It
  // rewrites no row, and a nullable column means no backfill can go wrong.
  const people = readFileSync(join(migrationsDirectory, peopleMigrationName), "utf8").replace(/\r\n/gu, "\n");
  for (const forbidden of ["drop table", "drop column", "delete from public.", "truncate", "update public.purchases"]) {
    assert.ok(!people.toLowerCase().includes(forbidden), `032 must not ${forbidden}`);
  }
  assert.match(people, /add column if not exists archived_at timestamptz;/u, "nullable, so nothing needs backfilling");

  // 031 is birthday self-privacy and contributor birthday edits. It adds
  // policies, predicates and two triggers -- and touches no table, no column
  // and no row. If it ever grows a DDL statement against family data, that is a
  // different kind of migration and belongs in a different review.
  const privacy = readFileSync(join(migrationsDirectory, privacyMigrationName), "utf8").replace(/\r\n/gu, "\n");
  for (const forbidden of [
    "drop table", "drop column", "alter table public.purchases",
    "alter table public.settlements", "delete from public.", "truncate",
  ]) {
    assert.ok(!privacy.toLowerCase().includes(forbidden), `031 must not ${forbidden}`);
  }
});

test("026 and 027 leave the Event layer and the money exactly as 025 left them", () => {
  // The reason this file can keep making claims about the Event layer after
  // later migrations landed: each one adds, and adds only.
  for (const [label, code] of [
    ["026", birthdayMigrationCode],
    ["027", reminderMigrationCode],
    ["028", occasionMigrationCode],
    ["029", budgetMigrationCode],
    ["030", contributorMigrationCode],
  ]) {
    for (const table of financialTables) {
      assert.doesNotMatch(
        code,
        new RegExp(`(alter table|drop table)\\s+(if exists\\s+)?public\\.${table}\\b`, "i"),
        `${label} must not alter ${table}`,
      );
    }
    // The two guards 025 installed are not redefined, dropped or disabled.
    assert.doesNotMatch(code, /drop trigger[^;]*protect_event_scope_identity/i);
    assert.doesNotMatch(code, /drop trigger[^;]*enforce_event_scope_integrity/i);
    assert.doesNotMatch(code, /alter table[^;]*disable trigger/i);
  }
});

test("027 deletes an event only through the guarded function, never with a bare statement", () => {
  // The one `delete from public.events` in the repository lives inside
  // `delete_event_if_empty`, after six count checks and an admin check. A
  // second one anywhere would be a way round all of it.
  const deletes = reminderMigrationCode.match(/delete from public\.events/gu) ?? [];
  assert.equal(deletes.length, 1, "exactly one delete statement");

  const start = reminderMigration.indexOf("function public.delete_event_if_empty(");
  const body = reminderMigration.slice(start, reminderMigration.indexOf("$;", start));
  assert.ok(body.includes("delete from public.events"), "and it is inside the guarded function");
  assert.ok(
    body.indexOf("is_app_admin()") < body.indexOf("delete from public.events"),
    "the admin check comes first",
  );
  assert.ok(
    body.indexOf("blocking_count > 0") < body.indexOf("delete from public.events"),
    "the emptiness check comes before the delete",
  );
});

test("no already-applied migration has been edited", () => {
  // Migrations 001-024 are live in production. Editing one would mean the
  // database and the repository disagree about what has been applied, and the
  // disagreement would be silent. This fingerprint makes it loud.
  //
  // If this fails: the fix is a NEW migration, never an edit to an old one.
  const applied = migrationFiles.filter((name) => name < "202608100025");
  assert.equal(applied.length, 24);

  const fingerprint = createHash("sha256");
  for (const name of applied) {
    fingerprint.update(name);
    fingerprint.update("\0");
    fingerprint.update(readFileSync(join(migrationsDirectory, name)));
    fingerprint.update("\0");
  }
  assert.equal(
    fingerprint.digest("hex"),
    "000ab0ed01e26751ff1cba9e0885b4058747758cb6f3cf763d0652532770a9af",
    "an already-applied migration was changed",
  );
});

test("the file is structurally whole", () => {
  // Dollar-quoted blocks come in pairs. An unbalanced one is the classic way a
  // hand-edited migration becomes a syntax error at the worst possible moment.
  assert.equal((eventMigration.match(/\$\$/g) ?? []).length % 2, 0, "unbalanced $$ quoting");

  // Every dollar-quoted body is opened either by `do $$` or by `as $$`, and
  // every one of them is closed by a line that is exactly `$$;`.
  const anonymousBlocks = (eventMigration.match(/^do \$\$$/gm) ?? []).length;
  const functionBodies = (eventMigration.match(/^as \$\$$/gm) ?? []).length;
  const terminators = (eventMigration.match(/^\$\$;$/gm) ?? []).length;
  assert.equal(
    terminators,
    anonymousBlocks + functionBodies,
    `${anonymousBlocks} do-blocks and ${functionBodies} function bodies, but ${terminators} terminators`,
  );
  assert.ok(anonymousBlocks >= 6, "the file is built from guarded blocks");
  assert.equal(functionBodies, 3, "the owed digest and the two guard functions");
  assert.doesNotMatch(eventMigration, /\t/, "tabs make a migration hard to read in a diff");
  // No transaction control of its own: the migration runner owns that, and a
  // stray commit would break the all-or-nothing guarantee.
  assert.doesNotMatch(eventMigrationCode, /^\s*(begin|commit|rollback)\s*;/im);
});

// ---------------------------------------------------------------------------
// It generalises rather than rebuilds
// ---------------------------------------------------------------------------

test("christmas_events is renamed, never recreated and repopulated", () => {
  assert.match(eventMigrationCode, /alter table public\.christmas_events rename to events;/);

  // A rename keeps every id. A create-and-copy would mint new ones and orphan
  // every christmas_event_id in the database.
  assert.doesNotMatch(eventMigrationCode, /create table[^;]*public\.events/i);
  assert.doesNotMatch(eventMigrationCode, /insert into public\.events/i);
  assert.doesNotMatch(eventMigrationCode, /drop table[^;]*public\./i);
  assert.doesNotMatch(eventMigrationCode, /gen_random_uuid\(\)/i, "no new event ids are minted");
});

test("it refuses to run against a database it does not recognise", () => {
  assert.match(eventMigration, /This migration has already been applied/);
  assert.match(eventMigration, /Apply migrations 001-024 before this file/);
  assert.match(eventMigrationCode, /if pg_catalog\.to_regclass\('public\.christmas_events'\) is null then/);
  for (const table of [...financialTables, "people", "app_members"]) {
    assert.ok(
      eventMigrationCode.includes(`'${table}'`),
      `the preconditions must require ${table}`,
    );
  }
});

test("the Event table gains everything a birthday or an Easter needs", () => {
  for (const column of [
    "event_type", "event_date", "description", "celebrant_person_id",
    "status", "created_by_app_member_id", "updated_at",
  ]) {
    assert.match(
      eventMigrationCode,
      new RegExp(`add column if not exists ${column}\\b`),
      `events must gain ${column}`,
    );
  }

  for (const type of ["christmas", "birthday", "easter", "wedding", "anniversary", "other"]) {
    assert.ok(
      /events_type_known_check[\s\S]*?check \(event_type in \(([^)]*)\)\)/.exec(eventMigrationCode)?.[1]?.includes(`'${type}'`),
      `${type} must be a known event type`,
    );
  }

  // The type is an icon and a set of defaults. It must never be a default,
  // because a silently-Christmas event is exactly the bug being removed.
  assert.doesNotMatch(eventMigrationCode, /alter column event_type set default/i);
  assert.match(eventMigrationCode, /alter column event_type set not null/);
  assert.match(eventMigrationCode, /alter column event_date set not null/);
  assert.match(eventMigrationCode, /alter column status set not null/);
});

test("the single-Christmas assumption is removed, and the true part of it kept", () => {
  assert.match(eventMigrationCode, /alter column year drop not null/);
  assert.match(eventMigrationCode, /contype = 'u'/, "the unique-on-year constraint is looked up and dropped");
  assert.match(
    eventMigrationCode,
    /create unique index if not exists events_one_christmas_per_year_idx\s*\n\s*on public\.events \(year\)\s*\n\s*where event_type = 'christmas'/,
  );
  assert.match(eventMigrationCode, /events_christmas_has_year_check/);
});

test("an event's relationships are declared, not implied", () => {
  assert.match(
    eventMigrationCode,
    /add constraint events_celebrant_person_fkey\s*\n\s*foreign key \(celebrant_person_id\) references public\.people\(id\)/,
  );
  assert.match(
    eventMigrationCode,
    /add constraint events_created_by_app_member_fkey\s*\n\s*foreign key \(created_by_app_member_id\) references public\.app_members\(id\)/,
  );
  // People are global. A celebrant is a reference to the one person row, never
  // a copy of a name.
  assert.doesNotMatch(eventMigrationCode, /celebrant_name/i);
  assert.match(eventMigrationCode, /events_birthday_names_its_celebrant_check/);
  assert.match(eventMigrationCode, /events_christmas_has_no_celebrant_check/);
});

test("the dashboard's queries have indexes to run on", () => {
  for (const index of [
    "events_status_date_idx",
    "events_type_date_idx",
    "events_celebrant_idx",
    "events_name_and_date_unique_idx",
  ]) {
    assert.ok(eventMigrationCode.includes(index), `${index} must exist`);
  }
});

// ---------------------------------------------------------------------------
// It never touches money
// ---------------------------------------------------------------------------

test("not one financial row is written, deleted or recalculated", () => {
  for (const table of financialTables) {
    assert.doesNotMatch(
      eventMigrationCode,
      new RegExp(`(insert into|update|delete from|truncate)\\s+public\\.${table}\\b`, "i"),
      `${table} must not be written by the Event migration`,
    );
  }

  // The one UPDATE in the file, and it is on the event row itself.
  const updates = eventMigrationCode.match(/update\s+public\.\w+/gi) ?? [];
  assert.deepEqual(updates.map((line) => line.replace(/\s+/g, " ")), ["update public.events"]);

  // No penny column is so much as named on the left of an assignment.
  assert.doesNotMatch(eventMigrationCode, /set[^;]*\b(amount_pennies|confirmed_amount_pennies|responsibility_pennies|budget_pennies|planned_amount_pennies|actual_price_pennies)\s*=/i);

  // And none of the proven financial entry points is redefined.
  for (const entryPoint of [
    "save_purchase", "save_purchase_with_location", "record_settlement",
    "review_payment", "admin_record_confirmed_payment", "void_settlement",
    "void_purchase", "save_christmas_recipient_with_contributions",
    "set_christmas_recipient_active", "save_recipient_contributions",
  ]) {
    assert.doesNotMatch(
      eventMigrationCode,
      new RegExp(`create (or replace )?function public\\.${entryPoint}\\b`, "i"),
      `${entryPoint} must be left exactly as it was`,
    );
  }
});

test("it measures every financial figure before, and proves it again after", () => {
  for (const measure of [
    "budget_pennies", "planned_pennies", "spend_pennies", "allocation_pennies",
    "claimed_pennies", "confirmed_pennies", "receipt_pennies", "gift_idea_pennies",
    "recipient_count", "contributor_count", "settlement_count", "receipt_count",
  ]) {
    assert.ok(eventMigrationCode.includes(measure), `the baseline must record ${measure}`);
    assert.ok(
      eventMigrationCode.split(measure).length >= 3,
      `${measure} must be measured before AND after`,
    );
  }

  assert.match(eventMigration, /The Event layer changed financial data, which it must never do/);
  assert.match(eventMigrationCode, /create or replace function pg_temp\.event_owed_digest\(p_event_id uuid\)/);
  // Temporary on purpose: a verification helper must not survive as a permanent
  // object nobody calls.
  assert.match(eventMigrationCode, /drop function if exists pg_temp\.event_owed_digest\(uuid\)/);
});

test("the Owed digest is the same arithmetic the application performs", () => {
  const digest = /create or replace function pg_temp\.event_owed_digest[\s\S]*?\$\$;/.exec(eventMigration)?.[0];
  assert.ok(digest, "the digest function must exist");

  // Only confirmed money reduces a balance. This is the single most important
  // line in src/lib/owed.ts, and a digest that used amount_pennies would
  // "prove" a balance the app has never shown.
  assert.match(digest, /confirmed_amount_pennies/);
  assert.doesNotMatch(digest.replace(/confirmed_amount_pennies/g, ""), /amount_pennies/);

  // The same three exclusions the engine makes.
  assert.match(digest, /purchase\.deleted_at is null/);
  assert.match(digest, /settlement\.voided_at is null/);
  assert.match(digest, /allocation\.contributor_id <> purchase\.checkout_payer_contributor_id/);
  assert.match(digest, /settlement\.payer_contributor_id <> settlement\.payee_contributor_id/);

  // And it can be asked for one event, which is what proves the Christmas
  // balance is the whole of the family balance.
  assert.match(digest, /p_event_id is null or recipient\.christmas_event_id = p_event_id/);
  assert.match(digest, /p_event_id is null or settlement\.christmas_event_id = p_event_id/);
  assert.match(eventMigration, /Christmas Owed is no longer the whole of the family Owed/);
});

test("it refuses to install its guards over data that would fail them", () => {
  assert.match(eventMigration, /Existing data is not event-clean/);
  for (const phrase of [
    "recipient_contributions cross two events",
    "purchases were paid for by a contributor from another event",
    "purchase_allocations name a contributor from another event",
    "settlements involve a contributor from another event",
    "payment_receipts disagree with their payment about the event",
  ]) {
    assert.ok(eventMigration.includes(phrase), `the pre-flight must check: ${phrase}`);
  }
});

// ---------------------------------------------------------------------------
// The compatibility view
// ---------------------------------------------------------------------------

test("christmas_events becomes a view that only ever shows Christmas", () => {
  const view = /create view public\.christmas_events[\s\S]*?;/.exec(eventMigrationCode)?.[0];
  assert.ok(view, "the compatibility view must exist");

  // Without security_invoker a view runs as its owner and hands every row to
  // anybody holding the SELECT grant. That would be a privilege escalation
  // dressed up as a rename.
  assert.match(view, /with \(security_invoker = true, check_option = cascaded\)/);
  // A single-table view with a WHERE clause is auto-updatable in PostgreSQL, so
  // the WHERE has to bind writes as well as reads.
  assert.match(eventMigration, /the christmas_events view has no check option/);
  assert.match(view, /where event\.event_type = 'christmas'/);

  // The four columns the existing code reads, and nothing new.
  for (const column of ["id", "year", "name", "created_at"]) {
    assert.match(view, new RegExp(`event\\.${column}\\b`));
  }
  assert.doesNotMatch(view, /event\.(event_type|status|celebrant_person_id|description|created_by_app_member_id)\s*(,|\n\s*from)/);

  assert.match(eventMigrationCode, /grant select on public\.christmas_events to authenticated;/);
  assert.match(eventMigrationCode, /revoke all privileges on public\.christmas_events from public, anon, authenticated;/);
});

test("the view is documented as load-bearing, because two live functions read it", () => {
  assert.match(eventMigration, /Do not drop it until every caller reads public\.events directly/);
  // Migrations 011 and 012 contain `select 1 from public.christmas_events`
  // inside SECURITY DEFINER functions this migration deliberately does not
  // redefine. If that stops being true, the comment is a lie.
  const recipientMigration = readFileSync(
    join(migrationsDirectory, "202608100012_atomic_recipient_budget_allocations.sql"),
    "utf8",
  );
  assert.match(recipientMigration, /from public\.christmas_events/);
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test("events are readable by active members and writable by nobody", () => {
  assert.match(eventMigrationCode, /alter table public\.events enable row level security;/);
  assert.match(
    eventMigrationCode,
    /create policy "active members read events"\s*\non public\.events\s*\nfor select\s*\nto authenticated\s*\nusing \(public\.is_active_app_member\(\)\);/,
  );

  assert.match(eventMigrationCode, /revoke all privileges on table public\.events from public, anon, authenticated;/);
  assert.match(eventMigrationCode, /grant select on table public\.events to authenticated;/);

  // No write path at all, for anybody. Creating an event is Checkpoint 4.
  assert.doesNotMatch(eventMigrationCode, /grant (insert|update|delete|all)[^;]*on table public\.events/i);
  assert.doesNotMatch(eventMigrationCode, /for (insert|update|delete|all)\s*\non public\.events/i);
  assert.match(eventMigration, /a browser role can write to events/);
  assert.match(eventMigration, /a direct write policy exists on events/);

  // Nothing anonymous, anywhere.
  assert.doesNotMatch(eventMigrationCode, /\bto anon\b/i);
  assert.match(eventMigration, /an anonymous policy exists on events/);
});

test("both new functions are locked down like every other one in this schema", () => {
  for (const guard of ["protect_event_scope_identity", "enforce_event_scope_integrity"]) {
    assert.match(
      eventMigrationCode,
      new RegExp(`create or replace function public\\.${guard}\\(\\)[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`),
      `${guard} must be a definer function with a fixed empty search path`,
    );
    assert.match(
      eventMigrationCode,
      new RegExp(`revoke all on function public\\.${guard}\\(\\) from public, anon, authenticated;`),
      `${guard} must not be callable directly`,
    );
    assert.doesNotMatch(
      eventMigrationCode,
      new RegExp(`grant execute on function public\\.${guard}`),
      `${guard} is a trigger, not an entry point`,
    );
  }
});

// ---------------------------------------------------------------------------
// Two events can never meet
// ---------------------------------------------------------------------------

test("an event link can never be moved once it exists", () => {
  const guarded = [
    "christmas_recipients", "contributors", "recipient_contributions",
    "purchases", "purchase_allocations", "settlements",
  ];
  for (const table of guarded) {
    assert.match(
      eventMigrationCode,
      new RegExp(`create trigger protect_event_scope_identity\\s*\\n\\s*before update on public\\.${table}\\b`),
      `${table} must refuse to have its event link rewritten`,
    );
  }

  // The claim the design rests on: a single event id on the parent is enough
  // BECAUSE the link cannot move. Each of these is the sentence a caller sees.
  for (const refusal of [
    "A recipient cannot be moved to another event",
    "A contributor cannot be moved to another event",
    "A purchase cannot be moved to another recipient",
    "A payment cannot be moved to another event",
    "A payment cannot be moved between contributors",
    "A responsibility snapshot cannot be moved to another purchase or contributor",
    "A contributor allocation cannot be moved to another recipient or contributor",
  ]) {
    assert.ok(eventMigration.includes(refusal), `missing refusal: ${refusal}`);
  }
});

test("a row can never be created across two events", () => {
  for (const table of [
    "recipient_contributions", "purchases", "purchase_allocations",
    "settlements", "payment_receipts",
  ]) {
    assert.match(
      eventMigrationCode,
      new RegExp(`create constraint trigger enforce_event_scope_integrity\\s*\\nafter [a-z ]*on public\\.${table}\\b`),
      `${table} must be checked for cross-event references`,
    );
  }

  // Deferred, matching migration 012's budget invariant: the canonical RPCs
  // replace whole allocation snapshots inside one transaction, so the check
  // belongs at commit rather than after each statement.
  assert.equal(
    (eventMigrationCode.match(/deferrable initially deferred/g) ?? []).length,
    5,
    "every cross-event check must be deferred, or a mid-transaction snapshot rebuild would fail",
  );

  for (const refusal of [
    "A contributor allocation must stay inside one event",
    "The checkout payer must belong to the same event as the recipient",
    "A purchase responsibility must name a contributor from the same event",
    "A payment must stay inside one event",
    "A payment confirmation must stay inside one event",
  ]) {
    assert.ok(eventMigration.includes(refusal), `missing refusal: ${refusal}`);
  }
});

test("the guards raise or do nothing, and never change a row", () => {
  const guards = /create or replace function public\.(protect_event_scope_identity|enforce_event_scope_integrity)[\s\S]*?\$\$;/g;
  const bodies = eventMigration.match(guards) ?? [];
  assert.equal(bodies.length, 2);

  for (const body of bodies) {
    const code = body.replace(/--[^\n]*/g, "");
    assert.doesNotMatch(code, /(insert into|update|delete from)\s+public\./i, "a guard must never write");
    assert.doesNotMatch(code, /\bnew\.\w+\s*(:?)=[^=]/, "a guard must never assign to the row");
    assert.match(code, /raise exception/);
  }
});

// ---------------------------------------------------------------------------
// The end-state assertion
// ---------------------------------------------------------------------------

test("the migration cannot finish having done half its job", () => {
  assert.match(eventMigration, /The Event layer did not install cleanly/);
  for (const problem of [
    "public.events does not exist",
    "row level security is off on public.events",
    "the christmas_events compatibility view is missing",
    "christmas_events is not a view",
    "public.events is missing one of its new columns",
    "public.events is missing one of its new constraints",
    "one Christmas per year is no longer enforced",
    "has no event immutability guard",
    "has no cross-event integrity guard",
    "the Christmas event did not survive the generalisation",
    "the Christmas event is invisible through the compatibility view",
  ]) {
    assert.ok(eventMigration.includes(problem), `the end-state check must detect: ${problem}`);
  }
});

test("PostgREST is told the shape changed", () => {
  // Without this the API keeps serving the old schema cache and
  // `christmas_events` looks like it vanished rather than became a view.
  assert.match(eventMigrationCode, /notify pgrst, 'reload schema';/);
});
