import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Checkpoint 4: creating, editing and archiving events, and recording
// birthdays -- proved at the boundary that actually enforces them.
//
// The rule this whole file exists to hold: UI HIDING IS NOT AUTHORISATION.
// Every screen Checkpoint 4 adds is admin-only in the browser, and every one of
// those screens is a courtesy. The refusals asserted below are in the database,
// where a hand-made request lands too.
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Line endings are normalised on the way in. Git stores LF and checks files out
// as CRLF on Windows, so a multi-line pattern written with \n silently stops
// matching a file nobody has edited -- a false failure about the product,
// caused by a checkout setting.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");

const MIGRATION = "202608100026_add_birthdays_and_event_administration.sql";
const sql = read("supabase", "migrations", MIGRATION);

const REMINDER_MIGRATION = "202608100027_two_stage_birthday_reminders_and_safe_event_deletion.sql";
const reminderSql = read("supabase", "migrations", REMINDER_MIGRATION);

const OCCASION_MIGRATION = "202608100028_add_mothers_and_fathers_day.sql";
const occasionSql = read("supabase", "migrations", OCCASION_MIGRATION);

const BUDGET_MIGRATION = "202608100029_add_monthly_birthday_budget_reminder.sql";
const budgetSql = read("supabase", "migrations", BUDGET_MIGRATION);

const CONTRIBUTOR_MIGRATION = "202608100030_family_contributors_and_atomic_setup.sql";
const PRIVACY_MIGRATION = "202608100031_birthday_privacy_and_contributor_birthday_edits.sql";
const PEOPLE_MIGRATION = "202608100032_people_directory.sql";
const MEMBERSHIP_MIGRATION = "202608100033_membership_guards.sql";
const contributorSql = read("supabase", "migrations", CONTRIBUTOR_MIGRATION);

/** The body of one `create ... function public.<name>(` block. */
function functionBody(name) {
  const start = sql.indexOf(`function public.${name}(`);
  assert.ok(start > 0, `${name} must exist in ${MIGRATION}`);
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start, `${name} must be terminated`);
  return sql.slice(start, end);
}

const ADMIN_WRITES = [
  "set_person_birthday",
  "create_event",
  "update_event",
  "set_event_status",
  "set_event_contributor",
  "add_event_recipient",
];

// ---------------------------------------------------------------------------
// 1. Migration hygiene -- the same invariants every applied migration holds
// ---------------------------------------------------------------------------

const AREA_MIGRATIONS = [
  "202608100034_areas_and_memberships.sql",
  "202608100035_area_integrity.sql",
  "202608100036_area_scoped_visibility.sql",
  "202608100037_area_write_barrier.sql",
  "202608100038_acting_area.sql",
];

/**
 * The hardening that follows Phase 5's five, once 034-038 were live.
 *
 * 039 makes the authorization Phase 5 left Area-blind ask about one Area; 040
 * adds the birthday person's own wishlist. Neither edits an applied migration,
 * which is what the ordering below is really asserting.
 */
const HARDENING_MIGRATIONS = [
  "202608100039_area_aware_contributor_permissions.sql",
  "202608100040_own_birthday_wishlist.sql",
];

/**
 * Q2: the Area lifecycle. 041 makes an administrator replaceable, 042 makes a
 * membership leavable, 043 stops the administrator's own birthday being
 * unplannable -- three consequences of the same rule, fixed in the order they
 * depend on each other.
 */
const LIFECYCLE_MIGRATIONS = [
  "202608100041_area_admin_handover.sql",
  "202608100042_area_membership_lifecycle.sql",
  "202608100043_birthday_planning_eligibility.sql",
];

test("026 to 033 are still in order, with Phase 5's Areas on top", () => {
  const files = readdirSync(join(root, "supabase", "migrations")).filter((name) => name.endsWith(".sql")).sort();
  // 026-033 keep their order relative to each other; everything newer sits
  // above them, so every offset moves together and nothing about 026-033
  // changes.
  assert.equal(files.at(-22), MIGRATION, "026 must come first of these");
  assert.equal(files.at(-21), REMINDER_MIGRATION, "then 027");
  assert.equal(files.at(-20), OCCASION_MIGRATION, "then 028");
  assert.equal(files.at(-19), BUDGET_MIGRATION, "then 029");
  assert.equal(files.at(-18), CONTRIBUTOR_MIGRATION, "then 030");
  assert.equal(files.at(-17), PRIVACY_MIGRATION, "then 031");
  assert.equal(files.at(-16), PEOPLE_MIGRATION, "then 032");
  assert.equal(files.at(-15), MEMBERSHIP_MIGRATION, "then 033");
  assert.deepEqual(files.slice(-14, -9), AREA_MIGRATIONS, "then Phase 5's five, in order");
  assert.deepEqual(files.slice(-9, -7), HARDENING_MIGRATIONS, "then the Q1 hardening");
  assert.deepEqual(files.slice(-7, -4), LIFECYCLE_MIGRATIONS, "and Q2's Area lifecycle on top of that");
  // Q3's 044 sits above all of it. Named here so adding another migration is
  // still a deliberate act that has to come back through this file.
  assert.equal(files.at(-4), "202608100044_area_scoped_person_administration.sql");
  assert.equal(files.at(-3), "202608100045_area_scoped_mutation_hardening.sql");
  // Q5 adds 046, which closes the one gift/purchase write 045 could not reach.
  assert.equal(files.at(-2), "202608100046_area_scoped_gift_idea_removal.sql");
  // Q6 adds 047: the four person routines that authorised in one family and
  // wrote in another.
  assert.equal(files.at(-1), "202608100047_area_scoped_person_routines.sql");
  for (const prefix of ["202608100026", "202608100027", "202608100028", "202608100029", "202608100030", "202608100031", "202608100032", "202608100033"]) {
    assert.equal(
      files.filter((name) => name.startsWith(prefix)).length,
      1,
      `there must be exactly one migration ${prefix.slice(-3)}`,
    );
  }
});

test("030 adds two admin paths and rewrites no financial history", () => {
  const redefined = [...contributorSql.matchAll(/create or replace function public\.(\w+)\(/gu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    redefined,
    ["set_family_contributor", "start_birthday_planning"],
    "030 may define only its own two functions",
  );
  for (const untouched of ADMIN_WRITES) {
    assert.ok(!redefined.includes(untouched), `${untouched} must be left exactly as it was`);
  }
  // It writes only the new column and the rows a new birthday needs.
  for (const table of ["purchases", "purchase_allocations", "settlements", "payment_receipts"]) {
    assert.doesNotMatch(
      contributorSql,
      new RegExp(String.raw`(insert into|update|delete from)\s+public\.${table}\b`, "iu"),
      `030 must not write ${table}`,
    );
  }
  assert.doesNotMatch(contributorSql, /drop table|truncate/iu, "it removes nothing");
});

test("029 adds the budget reminder and touches no admin write path", () => {
  const redefined = [...budgetSql.matchAll(/create or replace function public\.(\w+)\(/gu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    redefined,
    ["claim_birthday_budget_summary", "due_birthday_budget_summaries"],
    "029 may define only its own two functions",
  );
  for (const untouched of ADMIN_WRITES) {
    assert.ok(!redefined.includes(untouched), `${untouched} must be left exactly as it was`);
  }
  // The week and day reminders are a different feature and stay untouched.
  assert.ok(!redefined.includes("due_birthday_reminders"), "the week/day sweep is not redefined");
  assert.ok(!redefined.includes("claim_birthday_reminder"), "nor its claim");
  assert.doesNotMatch(budgetSql, /drop table|truncate|delete from public\./iu, "it removes nothing");
});

test("028 adds two occasions and takes nothing away", () => {
  // The only function it replaces is create_event, and only to widen a list.
  const redefined = [...occasionSql.matchAll(/create or replace function public\.(\w+)\(/gu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(redefined, ["create_event"], "028 may replace create_event and nothing else");

  for (const untouched of ADMIN_WRITES.filter((name) => name !== "create_event")) {
    assert.ok(!redefined.includes(untouched), `${untouched} must be left exactly as it was`);
  }
  assert.doesNotMatch(occasionSql, /drop table|truncate|delete from public\./iu, "it removes nothing");
  assert.doesNotMatch(occasionSql, /insert into public\.events[^;]*values[^;]*'mothers_day'[^;]*;/iu,
    "and creates no event of its own outside its own end-state probe rollback");
});

test("every function it defines is search_path-pinned and explicitly granted", () => {
  // An unpinned search_path on a SECURITY DEFINER function is a privilege
  // escalation: the caller chooses which schema the function's own table
  // references resolve to.
  const defined = [...sql.matchAll(/create or replace function public\.(\w+)\(/gu)].map((match) => match[1]);
  assert.ok(defined.length >= ADMIN_WRITES.length, "the admin write functions must all be defined here");

  for (const name of defined) {
    const body = functionBody(name);
    assert.match(body, /set search_path = ''/u, `${name} must pin an empty search_path`);
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${name}\\(`, "u"),
      `${name} must revoke the default grant before granting anything`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Authorisation is in the database
// ---------------------------------------------------------------------------

test("every write Checkpoint 4 adds refuses a non-admin in the database itself", () => {
  for (const name of ADMIN_WRITES) {
    const body = functionBody(name);
    assert.match(
      body,
      /is_app_admin\(\)/u,
      `${name} must check Global Admin itself, not trust the screen that called it`,
    );
    assert.match(body, /raise exception/iu, `${name} must refuse rather than return quietly`);
    assert.match(body, /security definer/u, `${name} runs as definer, which is why it must check`);
  }
});

test("the browser roles can execute the admin writes but cannot touch the tables behind them", () => {
  // The functions are the ONLY door. `events` in particular has no write grant
  // and no write policy for any browser session, so a hand-made PostgREST call
  // cannot insert an event even with a valid login.
  for (const name of ADMIN_WRITES) {
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated`, "u"),
      `${name} must be callable by a signed-in session`,
    );
  }
  assert.doesNotMatch(
    sql,
    /grant (insert|update|delete)[^;]*on table public\.events to (authenticated|anon)/iu,
    "no browser role may write events directly",
  );
});

test("the reminder machinery is invisible to the browser entirely", () => {
  // `birthday_reminders` is bookkeeping for a background job. A member has no
  // reason to read it and no reason to be able to forge one, so it has RLS on,
  // no policy, and no grant -- which is a closed door rather than a locked one.
  assert.match(sql, /alter table public\.birthday_reminders enable row level security/u);
  assert.doesNotMatch(
    sql,
    /create policy[^;]*on public\.birthday_reminders/iu,
    "birthday_reminders must have no policy at all",
  );
  assert.doesNotMatch(
    sql,
    /grant [^;]*on table public\.birthday_reminders to (authenticated|anon)/iu,
    "birthday_reminders must not be granted to a browser role",
  );

  for (const name of ["due_birthday_reminders", "claim_birthday_reminder"]) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${name}\\([^)]*\\)\\s*from public, anon, authenticated`, "su"),
      `${name} must be revoked from every browser role`,
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to (authenticated|anon)`, "u"),
      `${name} must not be re-granted to a browser role`,
    );
  }
});

test("a birthday cannot be stored as a date that does not exist", () => {
  // Checked by the database, so a direct PostgREST update is refused the same
  // way the form is. The clamp for 29 February is a DISPLAY rule; storage is
  // exact.
  assert.match(sql, /check \([^)]*birthday_month[^)]*between 1 and 12/su);
  assert.match(sql, /birthday_day/u);
  assert.match(sql, /birthday_year/u);
  // Month and day travel together: half a birthday is not a birthday.
  assert.match(
    sql,
    /\(birthday_month is null and birthday_day is null\)\s*\n?\s*or \(birthday_month is not null and birthday_day is not null\)/u,
    "month and day must be set or cleared together",
  );
});

// ---------------------------------------------------------------------------
// 3. Annual renewal, and the absence of a destructive reset
// ---------------------------------------------------------------------------

test("nothing in the migration deletes or resets birthday data on a date boundary", () => {
  // THE CHECKPOINT 4 PROHIBITION, ASSERTED.
  //
  // "Renews logically with no destructive January reset" means the renewal is
  // arithmetic, not a maintenance job. There must therefore be no statement
  // anywhere that clears birthdays or reminders on a schedule.
  assert.doesNotMatch(sql, /delete from public\.birthday_reminders/iu, "reminders are never bulk-deleted");
  assert.doesNotMatch(sql, /truncate\s+(table\s+)?(if exists\s+)?public\./iu, "nothing is truncated");
  assert.doesNotMatch(
    sql,
    /update public\.people set birthday_/iu,
    "no statement rewrites stored birthdays",
  );

  // The uniqueness that makes renewal automatic: the occurrence YEAR is part of
  // the key, so next year's reminder is a different row and no cleanup is
  // needed for it to be allowed to send.
  assert.match(
    sql,
    /unique \(person_id, occurrence_year, stage\)/u,
    "a reminder is unique per person, per occurrence year, per stage",
  );
});

test("a birthday event is created deliberately, once per person per year at most", () => {
  // Checkpoint 4 forbids creating birthday events automatically. The database
  // does not create them; it only refuses a SECOND active one for the same
  // person and year, so a double submit cannot produce two.
  assert.match(
    sql,
    /create unique index[^;]*events_one_birthday_per_person_per_year_idx[^;]*celebrant_person_id[^;]*event_type = 'birthday'[^;]*status = 'active'/su,
    "one active birthday event per person per year",
  );
  // Nothing schedules or loops over people to make events.
  assert.doesNotMatch(sql, /insert into public\.events[^;]*from public\.people/isu, "no bulk event creation");
});

// ---------------------------------------------------------------------------
// 4. The screens
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Event Settings holds event-scoped controls, and only those
// ---------------------------------------------------------------------------

test("Event Settings contains exactly the controls that belong to one event", () => {
  const settings = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");

  // What belongs: the event's own details, its people, its money, and the two
  // ways of taking it off the list.
  for (const heading of ["Details", "Recipients", "Contributors", "Danger zone", "Delete"]) {
    assert.ok(settings.includes(`>${heading}<`), `Event Settings should offer ${heading}`);
  }
  // Archive reads "Archived" once it has been, so it is matched by its ternary.
  assert.match(settings, /\{event\.status === "archived" \? "Archived" : "Archive"\}/u);
});

test("nothing account-level, family-level or global has leaked into it", () => {
  const settings = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");
  const logic = settings.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");

  // These are the scopes that will become Global and Area settings in Phase 5.
  // Any of them appearing here is a control in the wrong place, and moving it
  // later is far harder than never putting it here.
  for (const foreign of [
    "family-access", "Family access", "/more", "notification", "Notification",
    "push_subscriptions", "app_members", "claim_app_member", "set_family_contributor",
    "set_person_birthday", "Create Area", "profile", "password", "sign out",
  ]) {
    assert.ok(!logic.includes(foreign), `Event Settings must not contain ${foreign}`);
  }
});

test("every write it does make is event-scoped and admin-checked", () => {
  const settings = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");

  // Each RPC takes an event id, or an id that belongs to one. None of them can
  // reach outside the event being edited.
  const rpcs = [...settings.matchAll(/\.rpc\("([a-z_]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual([...new Set(rpcs)], [
    "add_event_recipient", "delete_event_if_empty",
    "set_event_contributor", "set_event_status", "update_event",
  ], "Event Settings may call these and nothing else");

  // REMOVING a recipient is deliberately NOT here. It happens on the People
  // screen, because taking somebody off an event has to keep their purchases
  // and that screen is where the purchases are. The capability was not deleted
  // when the control was placed -- `set_christmas_recipient_active` still
  // exists and is still reachable.
  assert.match(settings, /Removing a recipient is done from the People screen/u);
  const family = read("src", "app", "family-context.tsx");
  assert.match(family, /\.rpc\("set_christmas_recipient_active"/u, "the capability is still wired up");

  // And the screen refuses to render its controls to a non-admin, over and
  // above the database checking each call itself.
  assert.match(settings, /if \(!isAdmin\) \{/u);
  assert.match(settings, /Only this family(&apos;|’)s admin can change an event/u);
});

test("the event's own title is its identity on the settings screen", () => {
  const settings = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");
  // "🎁 Event settings" told the reader nothing about which event they were
  // editing. The name does.
  assert.match(settings, /eyebrow=\{`\$\{meta\.icon\} \$\{event\.name\}`\}/u);
  assert.ok(!settings.includes("eyebrow={`${meta.icon} ${meta.label}`}"), "not the type label");
});

test("the destructive actions keep their guards", () => {
  const settings = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");

  // Delete is offered only for an event that never held anything, and the
  // database refuses it regardless.
  assert.match(settings, /\{isEmpty && \(/u);
  assert.match(settings, /\.rpc\("delete_event_if_empty"/u);
  // Both destructive actions confirm first.
  assert.match(settings, /confirmDelete && \(/u);
  assert.match(settings, /confirmArchive && \(/u);
  assert.match(settings, /Archiving takes the event off the main list\. Nothing is deleted/u);
});

test("every Checkpoint 4 screen gates on the server before it renders", () => {
  const createPage = read("src", "app", "events", "new", "page.tsx");
  assert.match(createPage, /member\.role !== "admin"\) redirect\("\/"\)/u);
  assert.ok(
    createPage.indexOf('redirect("/")') < createPage.indexOf("<CreateEventForm"),
    "the redirect must come before the form is rendered",
  );

  const settingsPage = read("src", "app", "events", "[eventId]", "settings", "page.tsx");
  assert.match(settingsPage, /await requireEvent\(eventId\)/u, "settings must validate the event in the URL");
  assert.doesNotMatch(settingsPage, /eq\("year"/u, "settings must not resolve an event by year");

  // Birthdays is family-wide and readable by everyone; only the EDITING is
  // restricted, and the flag it passes is a courtesy over the RPC's own check.
  //
  // That flag is no longer `isAdmin`. Migration 031 widened birthday-date
  // maintenance to family contributors, so the screen is told the answer to the
  // question it actually asks -- "may this reader edit a date" -- rather than a
  // role it would have to translate. The database checks the same two things
  // itself, so a stale flag can only cost a button, never a write.
  const birthdaysPage = read("src", "app", "birthdays", "page.tsx");
  assert.match(birthdaysPage, /canEditBirthdays=\{/u, "the screen is told whether to offer editing");
  assert.match(birthdaysPage, /canEditBirthdays=\{data\.canEditBirthdays\}/u, "and told it by the server");
  assert.doesNotMatch(birthdaysPage, /redirect\("\/"\)/u, "reading birthdays is not admin-only");

  // The signed-out render offers nothing, rather than defaulting to permitted.
  assert.match(birthdaysPage, /canEditBirthdays=\{false\}/u, "a failed load may not offer editing");
});

test("no screen writes to an event, a recipient or a contributor except through the RPCs", () => {
  const screens = [
    ["src", "app", "events", "new", "create-event-form.tsx"],
    ["src", "app", "events", "[eventId]", "settings", "settings-screen.tsx"],
    ["src", "app", "birthdays", "birthdays-screen.tsx"],
  ];
  for (const parts of screens) {
    const source = read(...parts);
    assert.doesNotMatch(
      source,
      /from\("(events|christmas_events|christmas_recipients|contributors|people)"\)\s*\n?\s*\.(insert|update|delete|upsert)\(/u,
      `${parts.at(-1)} must not write a table directly`,
    );
    assert.match(source, /\.rpc\(/u, `${parts.at(-1)} writes through a guarded function`);
  }
});

test("editing a birthday event's date does not edit the person's birthday", () => {
  // Two different facts. The event's date is when the family is celebrating;
  // the person's birthday is when they were born. Conflating them would rewrite
  // a permanent record every time somebody moved a party to the weekend.
  const settings = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");
  assert.match(settings, /rpc\("update_event"/u);
  assert.doesNotMatch(settings, /set_person_birthday/u, "event settings must not touch a stored birthday");
  assert.match(settings, /saved birthday is edited on the Birthdays page/u, "and it must say so");

  const updateEvent = functionBody("update_event");
  assert.doesNotMatch(updateEvent, /birthday_month|birthday_day|birthday_year/u, "update_event never writes a birthday");
});

test("creating a birthday event never invents the birthday it is for", () => {
  // The date comes from the person's stored birthday or from the admin typing
  // it. Checkpoint 4's instruction is that no real birthday is hard-coded, so
  // the creation path must contain no month/day literal at all.
  const form = read("src", "app", "events", "new", "create-event-form.tsx");
  assert.doesNotMatch(form, /Paige/iu, "no family member is named in source");
  assert.doesNotMatch(
    form,
    /(month|day)\s*[:=]\s*\d+\s*,\s*(month|day)\s*[:=]\s*\d+/u,
    "no month/day pair is baked in as a default",
  );
  const createEvent = functionBody("create_event");
  assert.doesNotMatch(createEvent, /interval|current_date \+/u, "create_event does not guess a date");
});

test("no real family birthday appears anywhere in the repository's source or SQL", () => {
  // The standing Checkpoint 4 instruction, enforced across the whole tree
  // rather than one file: the real dates are entered through the app by an
  // authorised person and live only in the database.
  //
  // The check is per LINE, not per file. The family's names appear legitimately
  // in comments and in assertions like this one; what must never be committed
  // is a name sitting next to a date. Both halves are assembled here from
  // pieces so that this guard cannot trip over its own source.
  const NAMES = ["P" + "aige"];
  const DATE = /\b(?:6\s+Nov|Nov\w*\s+6\b|1{2}-0?6\b)/iu;

  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, ...dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
      if (entry.isDirectory()) { walk([...dir, entry.name]); continue; }
      if (!/\.(ts|tsx|mjs|sql)$/u.test(entry.name)) continue;
      const lines = read(...dir, entry.name).split("\n");
      for (const [index, line] of lines.entries()) {
        const named = NAMES.some((name) => line.toLowerCase().includes(name.toLowerCase()));
        if (named && DATE.test(line)) offenders.push(`${[...dir, entry.name].join("/")}:${index + 1}`);
      }
    }
  };
  walk(["src"]);
  walk(["scripts"]);
  walk(["supabase"]);
  assert.deepEqual(offenders, [], "a real family birthday was committed to source");
});

// ---------------------------------------------------------------------------
// 5. Christmas is untouched
// ---------------------------------------------------------------------------

test("026 changes no financial table, function or amount", () => {
  // Checkpoint 4 adds birthdays and administration. It must not go near the
  // money, which is what makes "Christmas 2026 is identical to the penny" a
  // property of the migration rather than something to re-measure.
  // recipient_contributions is deliberately NOT on this list: a new event, a
  // new contributor and a new recipient each have to appear in the plan at
  // ZERO, or migration 012's budget invariant rejects the first real edit. The
  // separate assertion below proves every amount it writes is zero.
  const FINANCIAL = [
    "purchases", "purchase_allocations", "settlements", "payment_receipts",
    "payment_confirmations",
  ];
  for (const table of FINANCIAL) {
    assert.doesNotMatch(
      sql,
      new RegExp(`(alter table|drop table|truncate)\\s+(if exists\\s+)?public\\.${table}\\b`, "iu"),
      `026 must not alter ${table}`,
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`(insert into|update|delete from)\\s+public\\.${table}\\b`, "iu"),
      `026 must not write ${table}`,
    );
  }
  for (const fn of ["record_settlement", "record_purchase", "confirm_settlement", "owed"]) {
    assert.doesNotMatch(
      sql,
      new RegExp(`create or replace function public\\.${fn}\\b`, "iu"),
      `026 must not redefine ${fn}`,
    );
  }
});

test("every planned amount 026 writes is zero, so no money is invented", () => {
  // The one financial table Checkpoint 4 touches, and the reason it is safe.
  // Each insert selects a literal 0 into planned_amount_pennies; none of them
  // copies, sums or scales an existing amount.
  const inserts = [...sql.matchAll(
    /insert into public\.recipient_contributions \(\s*christmas_recipient_id, contributor_id, planned_amount_pennies\s*\)([\s\S]*?);/gu,
  )];
  assert.ok(inserts.length >= 3, "the three creation paths must each seed a plan");
  for (const [, body] of inserts) {
    assert.match(body, /,\s*0\s*\n/u, "the planned amount must be a literal zero");
    assert.doesNotMatch(body, /planned_amount_pennies\s*[+*-]/u, "no arithmetic on an existing amount");
  }

  // And nothing anywhere in 026 updates an amount that already exists.
  assert.doesNotMatch(
    sql,
    /update public\.recipient_contributions[\s\S]{0,200}?planned_amount_pennies/iu,
    "026 must never rewrite a planned amount",
  );
});

test("027 replaces only the two reminder functions, and leaves the rest of 026 alone", () => {
  // A migration that "just changes the reminder stages" is exactly the kind
  // that quietly re-creates a neighbouring function with an older body. The
  // admin write functions are the ones that would matter: silently reverting
  // one would undo an authorization check with no diff to notice.
  const redefined = [...reminderSql.matchAll(/create or replace function public\.(\w+)\(/gu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    redefined,
    ["claim_birthday_reminder", "delete_event_if_empty", "due_birthday_reminders"],
    "027 may only replace the two reminder functions and add the delete",
  );

  for (const untouched of ADMIN_WRITES) {
    assert.ok(!redefined.includes(untouched), `${untouched} must be left exactly as 026 wrote it`);
  }

  // And it must not drop or re-create anything 026 built either.
  assert.doesNotMatch(reminderSql, /drop function[^;]*(create_event|set_person_birthday|update_event)/iu);
  assert.doesNotMatch(reminderSql, /drop table[^;]*birthday_reminders/iu, "the reminder history table survives");
});

test("the Christmas compatibility view is left exactly as migration 025 left it", () => {
  assert.doesNotMatch(sql, /create or replace view public\.christmas_events/iu);
  assert.doesNotMatch(sql, /drop view[^;]*christmas_events/iu);
});
