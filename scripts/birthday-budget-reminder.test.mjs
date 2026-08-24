import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ---------------------------------------------------------------------------
// The monthly birthday budgeting reminder.
//
// TWO WARNINGS THAT MUST NOT BE CONFLATED
//
//   THE BIRTHDAY IS COMING     one week before, one day before, from the
//                              PERMANENT date on `people`. Works for anybody
//                              whose birthday is recorded, planned or not.
//
//   YOU HAVE MONEY PUT ASIDE   the 1st of the month, from the CONTRIBUTION PLAN
//                              inside that year's occurrence. Sent only to
//                              somebody who actually has an amount, and never
//                              invented when there is no plan.
//
// The tests below hold both halves of that: the money reminder is driven by
// real plan data and nothing else, and the calendar reminders are untouched.
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Line endings are normalised on the way in. Git stores LF and checks files out
// as CRLF on Windows, so a multi-line pattern written with \n silently stops
// matching a file nobody has edited -- a false failure about the product,
// caused by a checkout setting.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");

const { planBirthdayBudgetNotifications, DEFAULT_NOTIFICATION_PREFERENCES } =
  await import("../src/lib/notification-audience.ts");
const { formatPennies } = await import("../src/lib/currency.ts");
const { REMINDER_STAGES } = await import("../src/lib/birthdays.ts");

const migration = read("supabase", "migrations", "202608100029_add_monthly_birthday_budget_reminder.sql");
const route = read("src", "app", "api", "birthdays", "reminders", "route.ts");
const dispatch = read("src", "lib", "notification-dispatch.ts");
const audience = read("src", "lib", "notification-audience.ts");

const member = (appMemberId, name, overrides = {}) => ({
  appMemberId,
  personId: `${appMemberId}-person`,
  name,
  contributorId: `${appMemberId}-contributor`,
  preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...overrides },
});

const TAYLOR = member("taylor", "Taylor");
const JADE = member("jade", "Jade");
const KIRSTEN = member("kirsten", "Kirsten");
const OPTED_OUT = member("quiet", "Quiet", { birthdays: false });
const FAMILY = [TAYLOR, JADE, KIRSTEN, OPTED_OUT];

const plan = (appMemberId, lines) => planBirthdayBudgetNotifications(
  {
    appMemberId,
    lines,
    totalPennies: lines.reduce((sum, line) => sum + line.plannedPennies, 0),
    monthLabel: "2026-11",
  },
  FAMILY,
);

const ONE_BIRTHDAY = { celebrantName: "Robin", dateLabel: "6 November", plannedPennies: 3000 };

// ---------------------------------------------------------------------------
// 1-2. The amount is the contributor's own, from the plan
// ---------------------------------------------------------------------------

test("1. a contributor planned at £30 is told £30", () => {
  const [notification] = plan("taylor", [ONE_BIRTHDAY]);
  assert.equal(notification.appMemberId, "taylor");
  assert.equal(notification.payload.title, "🎂 Birthday spending this month");
  assert.match(notification.payload.body, /Robin's birthday is 6 November\./u);
  assert.match(notification.payload.body, /You have £30 planned towards it\./u);
  assert.equal(notification.payload.category, "birthdays");
  assert.equal(notification.payload.url, "/birthdays");
});

test("2. unequal contributions produce different amounts for different people", () => {
  const [taylor] = plan("taylor", [{ ...ONE_BIRTHDAY, plannedPennies: 3000 }]);
  const [jade] = plan("jade", [{ ...ONE_BIRTHDAY, plannedPennies: 2500 }]);
  assert.match(taylor.payload.body, /£30/u);
  assert.match(jade.payload.body, /£25/u);
  assert.notEqual(taylor.payload.body, jade.payload.body);

  // Nothing anywhere divides a budget or assumes a share.
  for (const source of [route, dispatch, audience]) {
    assert.doesNotMatch(source, /\/\s*members\.length|\/\s*contributors\.length|Math\.round\([^)]*\/\s*\d/u,
      "no notification code may divide a budget");
  }
  // And the amount is read, not computed, in SQL.
  assert.match(migration, /sum\(contribution\.planned_amount_pennies\)::integer as planned_amount_pennies/u);
});

// ---------------------------------------------------------------------------
// 3-5. Who is left out
// ---------------------------------------------------------------------------

test("3. a contributor planned at zero receives nothing", () => {
  assert.deepEqual(plan("kirsten", []), [], "no lines, no notification");
  assert.deepEqual(
    planBirthdayBudgetNotifications(
      { appMemberId: "kirsten", lines: [{ ...ONE_BIRTHDAY, plannedPennies: 0 }], totalPennies: 0, monthLabel: "2026-11" },
      FAMILY,
    ),
    [],
    "a zero total is not a reminder",
  );
  // The database refuses to claim one, so it cannot even reach this point.
  assert.match(migration, /having sum\(contribution\.planned_amount_pennies\) > 0/u);
  assert.match(migration, /total_pennies integer not null check \(total_pennies > 0\)/u);
  assert.match(migration, /A budget reminder needs a positive amount/u);
});

test("4. the celebrant is never asked to club together for their own present", () => {
  assert.match(
    migration,
    /and contributor_person\.id <> event\.celebrant_person_id/u,
    "excluded in the query that finds who is due",
  );
  // Not a filter applied afterwards in TypeScript, where a later refactor could
  // drop it: the person is never in the result set at all. The sweep names the
  // celebrant in the copy, but never decides who is left out.
  const DECIDES = new RegExp(String.raw`celebrant[^\n]*(!==|===|filter|exclude)`, "iu");
  assert.doesNotMatch(route, DECIDES, "the sweep must not re-implement the exclusion");
});

test("5. a family member with no planned contribution is not notified", () => {
  // The audience is exactly one person: the one the summary belongs to.
  const planned = plan("taylor", [ONE_BIRTHDAY]);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].appMemberId, "taylor");
  assert.match(audience, /const member = members\.find\(\(candidate\) => candidate\.appMemberId === event\.appMemberId\);/u);

  // Somebody who has turned birthday notifications off gets none either.
  assert.deepEqual(plan("quiet", [ONE_BIRTHDAY]), []);
  // And an unknown member is not invented.
  assert.deepEqual(plan("nobody", [ONE_BIRTHDAY]), []);
});

// ---------------------------------------------------------------------------
// 6-8. Several birthdays in one month
// ---------------------------------------------------------------------------

test("6-7. several birthdays become ONE summary, totalled exactly", () => {
  const lines = [
    { celebrantName: "Robin", dateLabel: "6 November", plannedPennies: 3000 },
    { celebrantName: "Mum", dateLabel: "12 November", plannedPennies: 2500 },
    { celebrantName: "Eden", dateLabel: "20 November", plannedPennies: 2000 },
  ];
  const planned = plan("taylor", lines);
  assert.equal(planned.length, 1, "one notification, not three");

  const { body } = planned[0].payload;
  assert.match(body, /You have 3 birthdays to budget for:/u);
  assert.match(body, /Robin — £30/u);
  assert.match(body, /Mum — £25/u);
  assert.match(body, /Eden — £20/u);
  assert.match(body, /Total planned: £75/u);

  // Integer pennies, and the total is the exact sum of what is listed.
  const total = lines.reduce((sum, line) => sum + line.plannedPennies, 0);
  assert.equal(total, 7500);
  assert.ok(Number.isSafeInteger(total));
  assert.equal(formatPennies(total), "£75");

  // Awkward amounts stay exact — no floating point anywhere near this.
  const odd = [
    { celebrantName: "A", dateLabel: "1 November", plannedPennies: 333 },
    { celebrantName: "B", dateLabel: "2 November", plannedPennies: 333 },
    { celebrantName: "C", dateLabel: "3 November", plannedPennies: 334 },
  ];
  assert.match(plan("jade", odd)[0].payload.body, /Total planned: £10\b/u);
});

test("8. two contributors receive their own totals, never each other's", () => {
  const taylorBody = plan("taylor", [
    { celebrantName: "Robin", dateLabel: "6 November", plannedPennies: 3000 },
    { celebrantName: "Mum", dateLabel: "12 November", plannedPennies: 2000 },
  ])[0].payload.body;
  const jadeBody = plan("jade", [
    { celebrantName: "Robin", dateLabel: "6 November", plannedPennies: 2500 },
  ])[0].payload.body;

  assert.match(taylorBody, /Total planned: £50/u);
  assert.match(jadeBody, /You have £25 planned towards it\./u);
  assert.doesNotMatch(jadeBody, /£50/u, "one person's total must not appear in another's message");

  // The sweep groups by contributor before claiming anything.
  assert.match(route, /const byContributor = new Map<string, BudgetRow\[\]>\(\);/u);
  assert.match(route, /for \(const \[contributorPersonId, rows\] of byContributor\)/u);
});

// ---------------------------------------------------------------------------
// 9-10. When it runs, and how often
// ---------------------------------------------------------------------------

test("9. a retried sweep on the same 1st sends nothing twice", () => {
  // The durable claim IS the dedupe identity: person + month.
  assert.match(migration, /unique \(contributor_person_id, budget_month\)/u);
  assert.match(migration, /on conflict \(contributor_person_id, budget_month\) do nothing/u);
  assert.match(migration, /return claimed_id;/u, "only the winner is given a subject to send");

  // A person already claimed for the month drops out of the due list, so a
  // retry finds nothing rather than racing on the insert.
  assert.match(
    migration,
    /and not exists \(\s*\n\s*select 1\s*\n\s*from public\.birthday_budget_summaries as sent/u,
  );

  // The sweep skips anybody whose claim it did not win, and the outbox is
  // unique on (kind, subject, fingerprint) as a second layer.
  assert.match(route, /if \(claim\.error \|\| !claim\.data\) continue;/u);
  assert.match(route, /kind: "birthday_budget_month"/u);
  assert.match(route, /fingerprint: month/u);
});

test("10. no other day of the month produces a money reminder", () => {
  // The day check is in the DATABASE, so a sweep run on the 2nd produces
  // nothing at all and cannot be talked into it by a caller.
  assert.match(migration, /extract\(day from p_today\) = 1/u);

  // The route passes the family's own date straight through and applies no day
  // logic of its own — there is only one place this rule lives.
  assert.match(route, /rpc\("due_birthday_budget_summaries", \{ p_today: today \}\)/u);
  assert.doesNotMatch(route, /getDate\(\)|day === 1|=== "01"/u, "the day rule is not duplicated here");
});

// ---------------------------------------------------------------------------
// 11-12. A date alone is not an amount
// ---------------------------------------------------------------------------

test("11. a birthday with no planning occurrence produces no figure", () => {
  // The query starts FROM the occurrence and its plan. No occurrence means no
  // row, and there is no fallback that would invent one.
  assert.match(migration, /from public\.events as event/u);
  assert.match(migration, /join public\.recipient_contributions as contribution/u);
  assert.doesNotMatch(migration, /coalesce\([^)]*planned_amount_pennies[^)]*,\s*\d/u,
    "a missing plan must not default to a number");

  // And nothing in the sweep creates an occurrence in order to have something
  // to talk about.
  assert.doesNotMatch(route, /create_event|add_event_recipient|set_event_contributor/u);
  assert.doesNotMatch(migration, /insert into public\.events|insert into public\.christmas_recipients/u);
});

test("12. a permanent date alone still gets the week and day reminders", () => {
  const reminders = read("supabase", "migrations", "202608100027_two_stage_birthday_reminders_and_safe_event_deletion.sql");
  // Those come from `people`, not from any event.
  assert.match(reminders, /from public\.people as person/u);
  assert.doesNotMatch(reminders, /join public\.recipient_contributions/u,
    "the calendar reminders must not need a plan");
  // 029 does not touch them.
  assert.doesNotMatch(migration, /create or replace function public\.due_birthday_reminders/u);
  assert.doesNotMatch(migration, /create or replace function public\.claim_birthday_reminder/u);
});

// ---------------------------------------------------------------------------
// 13-14. Which month, and whose clock
// ---------------------------------------------------------------------------

test("13. December's sweep does not reach into January", () => {
  assert.match(
    migration,
    /date_trunc\('month', event\.event_date\) = date_trunc\('month', p_today\)/u,
    "the birthday must fall in the same calendar month as the sweep",
  );
  // Not a window of N days, which is what would spill across the boundary.
  assert.doesNotMatch(migration, /interval '\d+ days'/u);
  assert.doesNotMatch(migration, /event_date between/u);
});

test("14. the family's own calendar date is authoritative", () => {
  assert.match(route, /const today = londonToday\(\)/u);
  assert.match(route, /const month = today\.slice\(0, 7\)/u, "the month comes from that same date");
  assert.doesNotMatch(route, /new Date\(\)\.toISOString\(\)\.slice/u, "never a UTC instant");

  const server = read("src", "utils", "supabase", "birthdays-server.ts");
  assert.match(server, /timeZone: "Europe\/London"/u);

  // The claim stores that month, so what was sent and when are the same fact.
  assert.match(migration, /check \(budget_month ~ '\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'\)/u);
});

// ---------------------------------------------------------------------------
// 15-16. Nothing else moved
// ---------------------------------------------------------------------------

test("15. the one-week and one-day reminders are unchanged", () => {
  assert.deepEqual(REMINDER_STAGES.map((stage) => stage.stage), ["one_week", "one_day"]);

  // Still swept every day, before and independently of the monthly block.
  assert.ok(
    route.indexOf('rpc("due_birthday_reminders"') < route.indexOf('rpc("due_birthday_budget_summaries"'),
    "the daily reminders are evaluated first, and unconditionally",
  );
  assert.match(route, /rpc\("claim_birthday_reminder"/u);
  // Two different kinds, never merged.
  assert.match(route, /kind: "birthday_reminder"/u);
  assert.match(route, /kind: "birthday_budget_month"/u);
  assert.notEqual(
    dispatch.indexOf('kind === "birthday_reminder"'),
    dispatch.indexOf('kind === "birthday_budget_month"'),
    "the dispatcher handles them separately",
  );
});

test("16. no financial table is written, and Christmas cannot be involved", () => {
  // 029 reads the plan and writes only its own bookkeeping table.
  for (const table of [
    "purchases", "purchase_allocations", "settlements", "payment_receipts",
    "recipient_contributions", "christmas_recipients", "contributors", "events", "people",
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(String.raw`(insert into|update|delete from)\s+public\.${table}\b`, "iu"),
      `029 must not write ${table}`,
    );
  }
  assert.match(migration, /insert into public\.birthday_budget_summaries/u, "only its own table");

  // The sweep writes the claim and the outbox, and nothing else.
  const writes = [...route.matchAll(/\.from\("(\w+)"\)\s*\n?\s*\.(insert|update|upsert|delete)\(/gu)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(writes)], ["notification_outbox"], "the sweep writes only the outbox");

  // Only birthdays are ever considered, so a Christmas contribution cannot be
  // picked up by this at all.
  assert.match(migration, /event\.event_type = 'birthday'/u);
  assert.doesNotMatch(migration, /'christmas'/u);
});

test("the summary reads its own claimed row, with a plain table read", () => {
  // The dispatcher's client is deliberately `{ from }` only, so the pipeline
  // cannot call a function or write anything. The claim therefore carries
  // everything the message needs — which also means the message says what was
  // true when the month opened, not what the plan happens to be at send time.
  assert.match(dispatch, /\.from\("birthday_budget_summaries"\)/u);
  assert.doesNotMatch(dispatch, /reader\.rpc\(/u, "the dispatcher must not need an RPC");
  assert.match(migration, /lines jsonb not null/u);
  assert.match(migration, /The total does not match the birthdays it lists/u,
    "the database refuses a claim whose total disagrees with its own list");
  assert.match(dispatch, /if \(totalPennies !== Number\(row\.total_pennies\) \|\| totalPennies <= 0\) return null;/u,
    "and the dispatcher checks the same equality before sending");
});
