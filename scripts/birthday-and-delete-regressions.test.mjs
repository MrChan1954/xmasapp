import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ---------------------------------------------------------------------------
// Two live regressions, and the tests that would have caught them.
//
// WHAT ACTUALLY HAPPENED
//   1. A birthday was entered through the Birthdays screen. It never reached
//      the database — a production read confirmed the columns were still null —
//      and the screen gave no usable account of why.
//
//   2. An empty birthday occurrence was deleted. The app showed its generic
//      "Something went wrong" page, and the event was still there afterwards.
//
// THE TWO PROPERTIES THESE PROTECT
//   A write is not "successful" because nothing threw. It is successful when
//   the database hands back the row it wrote, and the screen checks.
//
//   A screen must never ask the server to reload a route whose subject it has
//   just deleted. That is not a rare race — it is the ordinary path, and it
//   turns a working delete into an error page.
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const birthdaysScreen = read("src", "app", "birthdays", "birthdays-screen.tsx");
const settingsScreen = read("src", "app", "events", "[eventId]", "settings", "settings-screen.tsx");
const createForm = read("src", "app", "events", "new", "create-event-form.tsx");
const migration26 = read("supabase", "migrations", "202608100026_add_birthdays_and_event_administration.sql");
const migration27 = read("supabase", "migrations", "202608100027_two_stage_birthday_reminders_and_safe_event_deletion.sql");

const { birthdayDateLooksLikeDateOfBirth } = await import("../src/lib/events.ts");
const { describeSupabaseError, describeThrown } = await import("../src/lib/supabase-error.ts");

/** The body of one function in a source file, by its opening line. */
function block(source, opening, closing) {
  const start = source.indexOf(opening);
  assert.ok(start > 0, `${opening} must exist`);
  const end = source.indexOf(closing, start);
  assert.ok(end > start, `${opening} must be terminated by ${closing}`);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. Saving a birthday calls the correct write path
// ---------------------------------------------------------------------------

test("1. saving a birthday goes through set_person_birthday and nothing else", () => {
  assert.match(birthdaysScreen, /rpc\("set_person_birthday", \{/u);
  // The four parameters the deployed API actually declares.
  for (const parameter of ["p_person_id", "p_month", "p_day", "p_year"]) {
    assert.match(birthdaysScreen, new RegExp(`${parameter}:`, "u"), `${parameter} must be sent`);
  }
  // Never a direct write to people: the columns are behind a SECURITY DEFINER
  // function that checks Global Admin, and a screen must not go round it.
  assert.doesNotMatch(
    birthdaysScreen,
    /from\("people"\)\s*\n?\s*\.(update|upsert|insert)\(/u,
    "the screen must not write people directly",
  );
  // And the database still refuses anybody else, whatever the screen does.
  const fn = block(migration26, "function public.set_person_birthday(", "$$;");
  assert.match(fn, /is_app_admin\(\)/u);
  assert.match(fn, /returns public\.people/u, "it returns the row it wrote, which is what proves the write");
});

// ---------------------------------------------------------------------------
// 2. A successful save shows immediately
// ---------------------------------------------------------------------------

test("2. a saved birthday appears at once, from the row the database returned", () => {
  // The returned row is kept and merged over the server props, so the list
  // below re-renders with the new date on this render rather than the next.
  assert.match(birthdaysScreen, /const \[confirmed, setConfirmed\] = useState<Record<string, PersonBirthday\["birthday"\]>>\(\{\}\);/u);
  assert.match(birthdaysScreen, /Object\.hasOwn\(confirmed, person\.personId\)/u);
  assert.match(birthdaysScreen, /const upcoming = useMemo\(\(\) => upcomingBirthdays\(shown, today\)/u,
    "the calendar must render the confirmed values, not the stale props");
  assert.match(birthdaysScreen, /const missing = useMemo\(\(\) => peopleWithoutBirthdays\(shown\)/u);

  // And the server render catches up, so a reload agrees with what is shown.
  const onSaved = block(birthdaysScreen, "onSaved={(person, birthday) => {", "onError=");
  assert.match(onSaved, /setConfirmed\(/u);
  assert.match(onSaved, /router\.refresh\(\);/u);
  assert.match(onSaved, /setSaved\(/u, "and the reader is told it worked");
});

// ---------------------------------------------------------------------------
// 3. A failed save says so
// ---------------------------------------------------------------------------

test("3. a failed birthday save produces a useful error, never a silent success", () => {
  const save = block(birthdaysScreen, "const save = async (clear: boolean) => {", "\n  };");

  // Every failure mode is handled, and each one reports rather than continues.
  assert.match(save, /if \(result\.error\) \{\s*\n\s*onError\(describeSupabaseError\(/u, "a returned error is described");
  assert.match(save, /catch \(thrown\) \{\s*\n\s*onError\(describeThrown\(/u, "a thrown failure is described");
  assert.match(save, /if \(!row \|\| typeof row !== "object"\) \{/u, "no row means no success");
  assert.match(save, /could not be confirmed by the database/u);

  // The specific lie this replaces: reporting success on the absence of an
  // error, without ever looking at what came back.
  assert.doesNotMatch(save, /onSaved\(\);/u, "success must carry the confirmed row");
  assert.match(save, /onSaved\(person, savedBirthday\);/u);

  // What was asked for and what was stored have to agree.
  assert.match(save, /The database saved something different from what was entered/u);

  // The error carries the database's code, so 42501 and PGRST202 are
  // distinguishable by the person reading the screen.
  assert.equal(describeSupabaseError({ message: "denied", code: "42501" }, "fallback"), "denied (42501)");
  assert.equal(describeSupabaseError(null, "fallback"), "fallback");
  assert.equal(describeThrown(new TypeError("Failed to fetch"), "fallback"), "Failed to fetch");
  assert.equal(describeThrown(undefined, "fallback"), "fallback");
});

// ---------------------------------------------------------------------------
// 4. Saving a birthday creates no event
// ---------------------------------------------------------------------------

test("4. saving a permanent birthday never creates a Birthday Event", () => {
  const save = block(birthdaysScreen, "const save = async (clear: boolean) => {", "\n  };");
  assert.doesNotMatch(save, /create_event|from\("events"\)/u, "the save writes a person, not an occasion");

  // Nor does the function, in the database.
  const fn = block(migration26, "function public.set_person_birthday(", "$$;");
  assert.doesNotMatch(fn, /insert into public\.events|public\.create_event/u);
  assert.doesNotMatch(fn, /christmas_recipients|contributors/u, "and it touches no event setup row");

  // The whole screen offers no shortcut that would create one as a side effect.
  assert.doesNotMatch(birthdaysScreen, /rpc\("create_event"/u);
});

test("4b. a date of birth typed into Create Event is questioned, not silently accepted", () => {
  // The production state that prompted this: an event called "Paige's Birthday"
  // dated thirty years ago, created because the date field on this form means
  // something different from the date field on the Birthdays page.
  assert.equal(birthdayDateLooksLikeDateOfBirth("2026-11-06", "2026-08-23"), null, "this year is fine");
  assert.equal(birthdayDateLooksLikeDateOfBirth("2025-11-06", "2026-08-23"), null, "last year is fine");
  const warning = birthdayDateLooksLikeDateOfBirth("1995-11-06", "2026-08-23");
  assert.ok(warning, "a date thirty years ago is questioned");
  assert.match(warning, /31 years ago/u);
  assert.match(warning, /Birthdays page/u, "and it says where the permanent date belongs");

  assert.match(createForm, /birthdayDateLooksLikeDateOfBirth\(date, today\)/u);
  assert.match(createForm, /type === "birthday" \?/u, "only for a birthday event");
  assert.match(createForm, /<Notice tone="warning">/u, "a warning, not a refusal");
  assert.match(createForm, /href="\/birthdays"/u);
});

// ---------------------------------------------------------------------------
// 5-6. A successful delete leaves, and never reloads what it deleted
// ---------------------------------------------------------------------------

test("5. a successful delete navigates away from the deleted event", () => {
  const fn = block(settingsScreen, "const deleteEvent = async () => {", "\n  };");
  assert.match(fn, /router\.replace\(destinationAfterDelete\)/u);
  assert.match(
    settingsScreen,
    /const destinationAfterDelete = event\.type === "birthday" && event\.celebrantPersonId\s*\n\s*\? `\/birthdays\/\$\{event\.celebrantPersonId\}`\s*\n\s*: "\/";/u,
    "a birthday occurrence returns to that person's birthdays, everything else to the dashboard",
  );
});

test("6. the deleted event is never fetched or rendered again", () => {
  // THE BUG, ASSERTED.
  //
  // The generic `run` helper refreshes the current route when it finishes.
  // For a rename that is right. For a delete it asks the server to load an
  // event that no longer exists, which is how a working delete produced an
  // error page. So the delete does not use `run`, and does not refresh.
  const fn = block(settingsScreen, "const deleteEvent = async () => {", "\n  };");
  assert.doesNotMatch(fn, /router\.refresh\(\)/u, "a delete must never refresh the route it just emptied");
  assert.doesNotMatch(fn, /\brun\(/u, "and must not go through the helper that does");

  // `run` still refreshes, because everything else on the screen stays put.
  const runHelper = block(settingsScreen, "const run = async (", "\n  };");
  assert.match(runHelper, /router\.refresh\(\);/u);

  // And once deleted, the screen renders nothing that reads the event.
  assert.match(settingsScreen, /const \[deleted, setDeleted\] = useState\(false\);/u);
  assert.match(settingsScreen, /setDeleted\(true\);/u);
  assert.match(settingsScreen, /if \(deleted\) \{/u);
  assert.ok(
    settingsScreen.indexOf("if (deleted) {") < settingsScreen.indexOf("if (!isAdmin) {"),
    "the deleted check must come before anything that renders the event",
  );
  // The order inside the handler: confirm, then mark, then leave.
  assert.ok(
    fn.indexOf("result.data !== true") < fn.indexOf("setDeleted(true)")
    && fn.indexOf("setDeleted(true)") < fn.indexOf("router.replace"),
    "confirm before marking, mark before navigating",
  );
});

// ---------------------------------------------------------------------------
// 7. A refused delete explains itself
// ---------------------------------------------------------------------------

test("7. a refused delete shows the database's reason, not the error boundary", () => {
  const fn = block(settingsScreen, "const deleteEvent = async () => {", "\n  };");
  assert.match(fn, /if \(result\.error\) \{\s*\n\s*setError\(describeSupabaseError\(/u);
  assert.match(fn, /catch \(thrown\) \{\s*\n\s*setError\(describeThrown\(/u,
    "a failed request must not become an unhandled rejection");
  assert.doesNotMatch(fn, /throw /u, "nothing here throws into the boundary");

  // The sentence the reader ends up seeing is the database's own.
  const guard = block(migration27, "function public.delete_event_if_empty(", "$$;");
  assert.match(guard, /Archive it instead/u);
  assert.match(guard, /and cannot be deleted/u);

  // And the screen shows whatever `error` holds.
  assert.match(settingsScreen, /\{error && <Notice tone="danger" className="mt-6">\{error\}<\/Notice>\}/u);
});

// ---------------------------------------------------------------------------
// 8. Deleting twice cannot corrupt anything
// ---------------------------------------------------------------------------

test("8. a repeated delete is refused cleanly and changes nothing", () => {
  // The second call finds no row and raises before touching anything. There is
  // no path in the function that deletes without first selecting the event.
  const guard = block(migration27, "function public.delete_event_if_empty(", "$$;");
  assert.match(guard, /select \* into target_event from public\.events where id = p_event_id;/u);
  assert.match(guard, /if not found then\s*\n\s*raise exception 'That event could not be found'/u);
  assert.ok(
    guard.indexOf("if not found then") < guard.indexOf("delete from public.events"),
    "the existence check comes before the delete",
  );
  // Exactly one delete, scoped to the checked event.
  assert.deepEqual(
    migration27.match(/delete from public\.events[^;]*/gu),
    ["delete from public.events where id = p_event_id"],
  );

  // In the browser, the button cannot be pressed twice into two requests: the
  // screen leaves the moment the first one is confirmed.
  assert.match(settingsScreen, /disabled=\{busy\}/u);
  assert.match(settingsScreen, /if \(deleted\) \{/u);
});

// ---------------------------------------------------------------------------
// 9. A birthday occurrence returns to Birthdays
// ---------------------------------------------------------------------------

test("9. deleting a birthday occurrence lands on that person's birthdays", () => {
  assert.match(settingsScreen, /`\/birthdays\/\$\{event\.celebrantPersonId\}`/u);
  // `/birthdays/<personId>` is now a resolver: with the occurrence deleted it
  // has nothing to redirect to and shows the setup screen, which is exactly
  // where somebody who has just removed a mistaken occurrence should land.
  const resolver = read("src", "app", "birthdays", "[personId]", "page.tsx");
  assert.match(resolver, /if \(workspace\.current\) \{/u);
  assert.match(resolver, /<StartPlanningScreen/u);

  // An unused occurrence is still reachable — from the history page, which is
  // where it is listed for the Global Admin to tidy up.
  const history = read(...["src","app","birthdays","[personId]","history","history-screen.tsx"]);
  assert.match(history, /eventPath\(occurrence\.eventId, "settings"\)/u);
  assert.match(history, /\{isAdmin && unused\.length > 0 && \(/u);
});

// ---------------------------------------------------------------------------
// 10. Christmas is still protected
// ---------------------------------------------------------------------------

test("10. an event holding anything at all still cannot be deleted", () => {
  const guard = block(migration27, "function public.delete_event_if_empty(", "$$;");
  for (const table of [
    "public.purchases", "public.purchase_allocations", "public.settlements",
    "public.payment_receipts", "public.gift_ideas",
  ]) {
    assert.ok(guard.includes(table), `${table} must still block a delete`);
    assert.ok(
      guard.indexOf(table) < guard.indexOf("delete from public.events"),
      `${table} must be checked before the delete`,
    );
  }
  assert.match(guard, /is_app_admin\(\)/u);
  assert.ok(
    guard.indexOf("is_app_admin()") < guard.indexOf("delete from public.events"),
    "and the admin check comes first",
  );

  // The screen only offers the control for an event it believes is empty, and
  // that belief is recomputed on the server every render.
  const page = read("src", "app", "events", "[eventId]", "settings", "page.tsx");
  assert.match(page, /const isEmpty = /u);
  assert.match(settingsScreen, /\{isEmpty && \(/u);
});

// ---------------------------------------------------------------------------
// 11. No financial logic changed
// ---------------------------------------------------------------------------

test("11. this fix changed no financial code and needs no migration", () => {
  // Nothing here writes money, and nothing here is a database change: both
  // problems were in the browser, and both fixes are too.
  for (const parts of [
    ["src", "app", "birthdays", "birthdays-screen.tsx"],
    ["src", "app", "events", "[eventId]", "settings", "settings-screen.tsx"],
    ["src", "app", "events", "new", "create-event-form.tsx"],
    ["src", "lib", "supabase-error.ts"],
  ]) {
    const source = read(...parts);
    assert.doesNotMatch(
      source,
      /from\("(purchases|purchase_allocations|settlements|payment_receipts|recipient_contributions)"\)\s*\n?\s*\.(insert|update|delete|upsert)\(/u,
      `${parts.at(-1)} must not write a financial table`,
    );
  }

  for (const parts of [
    ["src", "lib", "owed.ts"], ["src", "lib", "purchases.ts"],
    ["src", "lib", "recipient-allocations.ts"], ["src", "lib", "payment-confirmation.ts"],
  ]) {
    assert.doesNotMatch(
      read(...parts),
      /describeSupabaseError|set_person_birthday|delete_event_if_empty/u,
      `${parts.at(-1)} must be untouched by this fix`,
    );
  }

  // 027 is applied in production. It must not have moved.
  assert.match(migration27, /create or replace function public\.delete_event_if_empty\(p_event_id uuid\)/u);
  assert.equal(
    (migration27.match(/create or replace function public\.(\w+)\(/gu) ?? []).length,
    3,
    "027 still defines exactly the three functions it was applied with",
  );
});

// ---------------------------------------------------------------------------
// The general rule both bugs came from
// ---------------------------------------------------------------------------

test("no screen refreshes a route it has just navigated away from", () => {
  // Both live problems trace to the same shape: do the work, navigate, then
  // refresh — where the refresh reloads the page being left. Asserted across
  // every screen that navigates after a write.
  for (const [label, source] of [
    ["event settings", settingsScreen],
    ["create event", createForm],
  ]) {
    const replaces = [...source.matchAll(/router\.(replace|push)\(/gu)];
    for (const match of replaces) {
      const after = source.slice(match.index, match.index + 400);
      assert.doesNotMatch(
        after,
        /router\.(replace|push)\([^)]*\);[\s\S]{0,80}router\.refresh\(\)/u,
        `${label}: a refresh must not follow a navigation`,
      );
    }
  }
});
