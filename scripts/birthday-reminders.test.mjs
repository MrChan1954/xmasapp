import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// The automatic birthday reminders.
//
// Three properties matter, and they are the three that are hard to get right:
//
//   IDEMPOTENCE  running the sweep twice in a day sends nothing twice.
//   RENEWAL      running it next year sends again, with nothing reset to
//                achieve that.
//   AUTHORITY    nobody but the scheduler can make it run.
//
// The first two are enforced by the database and are tested here against the
// migration; the third is enforced by the route and is tested against the
// route. The delivery itself is the existing outbox pipeline, which has its own
// suites -- this one deliberately stops at "handed over".
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Line endings are normalised on the way in. Git stores LF and checks files out
// as CRLF on Windows, so a multi-line pattern written with \n silently stops
// matching a file nobody has edited -- a false failure about the product,
// caused by a checkout setting.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");

const sql = read("supabase", "migrations", "202608100026_add_birthdays_and_event_administration.sql");
const route = read("src", "app", "api", "birthdays", "reminders", "route.ts");
const workflow = read(".github", "workflows", "birthday-reminders.yml");
const content = read("src", "lib", "notification-content.ts");
const dispatch = read("src", "lib", "notification-dispatch.ts");

// ---------------------------------------------------------------------------
// 1. Idempotence
// ---------------------------------------------------------------------------

test("a reminder can only be claimed once, and the claim is the database's decision", () => {
  // Not a flag in memory, not a check-then-insert. The claim is an INSERT
  // against a unique key, so two callers racing on the same second produce one
  // winner and one loser rather than two reminders.
  const start = sql.indexOf("function public.claim_birthday_reminder(");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  assert.ok(start > 0, "claim_birthday_reminder must exist");
  assert.match(body, /insert into public\.birthday_reminders/u);
  assert.match(body, /on conflict[\s\S]*do nothing/u, "a lost race must be silent, not an error");
  assert.match(body, /returns boolean/u, "the caller is told whether it won");

  assert.match(
    sql,
    /unique \(person_id, occurrence_year, stage\)/u,
    "the uniqueness that makes the claim work",
  );
});

test("the sweep sends only what it actually claimed", () => {
  // The one line that makes a second run of the day silent: a claim that did
  // not win is skipped before anything is queued.
  assert.match(
    route,
    /if \(claim\.error \|\| claim\.data !== true\) continue;/u,
    "a lost or failed claim must skip the send",
  );
  // And the queueing happens after the claim, never before it.
  assert.ok(
    route.indexOf('rpc("claim_birthday_reminder"') < route.indexOf('from("notification_outbox")'),
    "claim first, queue second",
  );
});

test("the outbox is the second layer, so even a re-queued row converges on one send", () => {
  // The fingerprint is the occurrence year and the stage, which is exactly the
  // identity of the reminder. Two rows for the same reminder collapse.
  assert.match(route, /fingerprint: `\$\{row\.occurrence_year\}:\$\{row\.stage\}`/u);
  assert.match(route, /kind: "birthday_reminder"/u);
  assert.match(route, /subject_id: reminder\.data\.id/u, "the subject is the reminder row, not the person");
});

test("a failure to queue does not silently re-send tomorrow", () => {
  // The deliberate trade-off, stated in the route and asserted here so it
  // cannot be quietly reversed into a retry loop that sends duplicates.
  assert.match(route, /better missed than sent twice/u, "the trade-off must be written down");
  assert.doesNotMatch(route, /delete\(\)[\s\S]{0,120}birthday_reminders/u, "a claim is never rolled back to retry");
});

// ---------------------------------------------------------------------------
// 2. Annual renewal without a reset
// ---------------------------------------------------------------------------

test("next year's reminder is a different row, so nothing has to be cleared for it to send", () => {
  // THE NO-DESTRUCTIVE-RESET PROPERTY.
  //
  // The claim key contains the OCCURRENCE year. 2027's one_month reminder is
  // therefore a different row from 2026's, and sending it requires no deletion,
  // no January job and no "reset" of any kind. Nothing in the migration or the
  // route removes a reminder, and this asserts that directly.
  assert.doesNotMatch(sql, /delete from public\.birthday_reminders/iu);
  assert.doesNotMatch(route, /\.delete\(\)/u, "the sweep never deletes anything");
  assert.doesNotMatch(workflow, /delete|reset|truncate/iu, "the schedule never runs a cleanup");

  // The due list derives the occurrence year from the date being evaluated
  // rather than from the calendar year, which is what makes a December
  // reminder for a January birthday belong to the following year.
  const start = sql.indexOf("function public.due_birthday_reminders(");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  assert.match(body, /occurrence_year/u);
  assert.match(body, /birthday_occurrence_date/u, "the same clamp rule the app uses");
});

test("the sweep is driven by a date it is given, not by a hidden clock", () => {
  // `due_birthday_reminders(p_today)` takes the day as an argument, which is
  // what makes it testable and what lets the route resolve "today" in the
  // family's timezone rather than in UTC.
  assert.match(sql, /function public\.due_birthday_reminders\(\s*p_today date/u);
  assert.match(route, /const today = londonToday\(\)/u);
  assert.match(route, /p_today: today/u);
  assert.doesNotMatch(route, /new Date\(\)\.toISOString\(\)\.slice/u, "UTC is not the family's today");
});

test("there are exactly three stages in the database as well as in the app", () => {
  assert.match(
    sql,
    /stage text not null check \(stage in \('one_month', 'one_week', 'one_day'\)\)/u,
    "a fourth stage cannot be inserted",
  );
});

// ---------------------------------------------------------------------------
// 3. Authority
// ---------------------------------------------------------------------------

test("the endpoint refuses everybody who cannot present the scheduler's secret", () => {
  assert.match(route, /x-reminder-secret/u, "the secret travels in a header, not the URL");
  assert.match(route, /status: 401/u, "a wrong secret is refused");
  assert.match(route, /secretsMatch\(presented, secret\)/u);
  // Length-independent comparison, so a wrong guess leaks no timing signal
  // beyond its length.
  assert.match(route, /difference \|= presented\.charCodeAt\(index\) \^ expected\.charCodeAt\(index\)/u);
});

test("a missing secret disables the endpoint rather than opening it", () => {
  // Fail closed. An unauthenticated "send every birthday reminder" endpoint is
  // precisely what must never exist, so the absent-configuration branch must
  // return before any work is done.
  assert.match(route, /if \(!secret\) \{/u);
  assert.ok(
    route.indexOf("if (!secret) {") < route.indexOf('rpc("due_birthday_reminders"'),
    "the check must come before anything is read",
  );
  assert.match(route, /status: 503/u);
});

test("it is POST only, and no browser session can reach it", () => {
  assert.match(route, /export async function POST\(/u);
  assert.doesNotMatch(route, /export async function GET\(/u, "a GET would be reachable by a link");
  // It uses the service-role client, and that is not a shortcut: the reminder
  // functions are revoked from every browser role, so no signed-in session can
  // call them however it dresses up the request.
  //
  // THROUGH THE CANONICAL MODULE SINCE Q19, rather than by reading
  // `SUPABASE_SECRET_KEY` here. `src/utils/supabase/service-role.ts` is the one
  // place in `src/` that reads the key -- `scripts/canonical-paths.test.mjs`
  // counts the occurrences -- and it carries the header explaining what a
  // client built from it bypasses.
  assert.match(route, /createServiceRoleClient\(\)/u);
  assert.doesNotMatch(route, /SUPABASE_SECRET_KEY/u, "the key is read in exactly one module");
  assert.match(sql, /revoke all on function public\.due_birthday_reminders\(date\) from public, anon, authenticated/u);
});

test("nothing about a birthday is ever written to a log", () => {
  // Logs are the easiest accidental leak: a run summary in a public Actions log
  // must not say whose birthday it is.
  const logs = [...route.matchAll(/console\.(info|error|warn|log)\(([\s\S]*?)\);/gu)].map((match) => match[2]);
  assert.ok(logs.length > 0, "the sweep does log its counts");
  for (const logged of logs) {
    assert.doesNotMatch(logged, /person_name|occurrence_date|row\.person_id|name/u, "no personal data in a log line");
    // The NAME of the setting is fine to log -- that is how an operator learns
    // it is missing. The VALUE must never appear, in any form.
    assert.doesNotMatch(logged, /\$\{\s*(secret|presented|expected)\b/u, "no secret value in a log line");
    assert.doesNotMatch(logged, /\bprocess\.env\b/u, "no environment value in a log line");
  }
});

test("the schedule runs once a day, reads nothing from the repository, and echoes no secret", () => {
  assert.match(workflow, /- cron: "0 8 \* \* \*"/u, "once a day");
  assert.match(workflow, /permissions:\s*\n\s*contents: read/u, "read-only token");
  assert.match(workflow, /--header "x-reminder-secret: \$\{REMINDER_SECRET\}"/u, "header, not URL");
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{?REMINDER_SECRET/u, "the secret is never echoed");
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{\{ secrets\./u, "no secret is interpolated into a log line");
  // A second run must not race the first into duplicate work.
  assert.match(workflow, /concurrency:/u);
});

// ---------------------------------------------------------------------------
// 4. What the reminder says
// ---------------------------------------------------------------------------

test("the notification keeps the action in the title and never goes to the birthday person", () => {
  assert.match(content, /export function birthdayReminderNotification\(/u);
  // The Checkpoint 3 copy rule, still held: the TITLE says what is happening.
  const start = content.indexOf("export function birthdayReminderNotification(");
  // The signature's return-type line also begins with "}", so the end of the
  // function is the first "}" that is alone on its line.
  const body = content.slice(start, content.indexOf("\n}\n", start));
  assert.match(body, /title:/u);
  assert.match(body, /🎂/u, "birthdays have their own glyph, so the list is scannable");
  assert.match(body, /tag: `birthday:/u, "an event-independent collapse key");

  // The audience is decided in the dispatcher, not in the copy, and the
  // celebrant is excluded there.
  assert.match(dispatch, /birthday_reminder/u);
});

test("a birthday with no app account behind it does not corrupt the dedupe ledger", () => {
  // Most families have somebody with a birthday and no login -- a child, or
  // anybody who has simply never been invited. The reminder still has to go
  // out, and it has to go out ONCE.
  //
  // `notification_events.actor_app_member_id` is a foreign key to
  // `app_members`. Putting a PERSON id there is rejected at insert time, and
  // the drain treats a failed ledger claim as "send anyway, undeduplicated" --
  // so the wrong id would not fail loudly, it would quietly cost the family the
  // protection against a duplicate send. Null is the correct value, and the
  // column has always allowed it.
  const start = dispatch.lastIndexOf('if (kind === "birthday_reminder") {');
  assert.ok(start > 0, "the birthday branch must exist");
  const branch = dispatch.slice(start);
  assert.ok(
    branch.includes("actorAppMemberId: celebrant?.appMemberId ?? null,"),
    "no person id in an app_members column",
  );
  assert.ok(
    !branch.includes("actorAppMemberId: celebrant?.appMemberId ?? row.person_id"),
    "a person id is not an app member id",
  );

  // The exclusion of the birthday person from their own audience does not
  // depend on that value, so a missing account cannot cause somebody to be
  // reminded to buy their own present.
  const audience = read("src", "lib", "notification-audience.ts");
  assert.ok(
    audience.includes("member.appMemberId !== event.celebrantAppMemberId && member.preferences.birthdays"),
    "the celebrant is excluded by their own field, and preferences are honoured",
  );
});

test("a birthday reminder carries no event, and the pipeline expects that", () => {
  // A birthday exists whether or not anybody has created an event for it, so
  // the reminder's event context is legitimately null. Checkpoint 3 made the
  // context per-event; this asserts the eventless path is deliberate rather
  // than an unhandled case.
  assert.match(dispatch, /EVENTLESS_KINDS/u);
  assert.match(dispatch, /FAMILY_WIDE/u, "the eventless context has its own cache key");
});
