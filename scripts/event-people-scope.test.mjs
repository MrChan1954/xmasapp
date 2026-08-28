/**
 * WHOSE PEOPLE AN EVENT MAY OFFER, AND HOW ONE IS ADDED.
 *
 * Two defects, both found in a real browser against production, both fixed
 * here and pinned so they cannot come back.
 *
 * F2 -- THE PICKER WAS AREA-BLIND ON READ. Event settings loaded
 *      `from("people").select(...).order("name")` with no Area predicate. Row
 *      level security is not the boundary for that read: it returns every Area
 *      the READER belongs to, which is correct as a permission and wrong as a
 *      picker. Measured on production: a QA family with TWO People offered
 *      TWENTY-THREE, nineteen of them a different family's, by name. It never
 *      became a write -- migration 045 refuses a foreign Person with 23514 --
 *      so it was disclosure, not corruption. Disclosure of real names is still
 *      the thing to fix.
 *
 * F3 -- THE ADD RECIPIENT DIALOG COULD NOT SUBMIT. Q4 removed the Name field
 *      from that dialog on purpose, because an event may not rename the durable
 *      Person. What it left behind was `validateRequiredText(name, ...)` in the
 *      submit handler -- and no `name` exists in that component, so the bare
 *      identifier resolved to `window.name`, which is the empty string. Every
 *      submit refused with "Enter a name." beside no name field at all. The
 *      intended route into an event was impossible on Q3 and on Q4.
 *
 * THE DATABASE HALF IS RUN, NOT READ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe, before, after } from "node:test";

import { ROOT, buildRehearsal, probe } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n");
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\{\/\*[\s\S]*?\*\/\}/gu, "").replace(/^\s*\/\/.*$/gmu, "");

let db;
let f;
const who = (user, area) => ({ user, area });

before(async () => { db = await buildRehearsal({}); f = await buildTwoFamilies(db); });
after(async () => { await db?.close(); });

// ===========================================================================
// F2. The read that feeds the picker
// ===========================================================================

describe("F2: an event's People picker offers one family, not every family the reader is in", () => {
  test("THE ROOT CAUSE, PROVEN: an unscoped read really does return several families", async () => {
    /*
     * This is what the settings page issued. `users.dual` administers Alpha
     * and Charlie and belongs to Bravo, so row level security hands back all
     * three -- correctly. The page then rendered the lot.
     */
    const unscoped = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id, name, area_id from public.people");
    assert.ok(unscoped.ok, unscoped.error);

    const areas = new Set(unscoped.rows.map((r) => r.area_id));
    assert.ok(areas.size > 1,
      `an unscoped read returns more than one family (got ${areas.size}) -- which is the bug`);
    assert.ok(areas.has(f.areas.bravo),
      "including a family the reader merely belongs to and is not acting in");
  });

  test("SCOPED TO THE EVENT'S AREA, only that family's People come back", async () => {
    const scoped = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id, name, area_id from public.people where area_id = $1 order by name", [f.areas.alpha]);
    assert.ok(scoped.ok, scoped.error);
    assert.ok(scoped.rows.length > 0, "Alpha's own People are still offered");

    for (const row of scoped.rows) {
      assert.equal(row.area_id, f.areas.alpha, "every offered Person belongs to the event's Area");
    }
  });

  test("A CHARLIE EVENT OFFERS CHARLIE, and the same login proves it is not a coincidence", async () => {
    const charlie = await probe(db, who(f.users.dual, f.areas.charlie),
      "select id, name, area_id from public.people where area_id = $1", [f.areas.charlie]);
    assert.ok(charlie.ok, charlie.error);
    assert.ok(charlie.rows.length > 0);
    for (const row of charlie.rows) assert.equal(row.area_id, f.areas.charlie);

    // The SAME account, one Area over, gets a different and disjoint list.
    const alpha = await probe(db, who(f.users.dual, f.areas.alpha),
      "select id from public.people where area_id = $1", [f.areas.alpha]);
    const charlieIds = new Set(charlie.rows.map((r) => r.id));
    const overlap = alpha.rows.filter((r) => charlieIds.has(r.id));
    assert.deepEqual(overlap, [], "no Person appears in both families' pickers");
  });

  test("A FOREIGN PERSON'S NAME IS ABSENT from the scoped list entirely", async () => {
    const scoped = await probe(db, who(f.users.dual, f.areas.alpha),
      "select name from public.people where area_id = $1", [f.areas.alpha]);
    const names = scoped.rows.map((r) => r.name);

    // Bea and Jo live in Bravo. Neither may be nameable from an Alpha event.
    assert.ok(!names.includes("Bea"), "a Bravo person is not offered on an Alpha event");
    assert.ok(!names.includes("Jo"), "nor another one");
    assert.ok(names.includes("Ada"), "while Alpha's own people still are");
  });

  test("AND THE WRITE BARRIER STILL REFUSES A FORGED FOREIGN PERSON", async () => {
    /*
     * The read fix is about what is SHOWN. This is the boundary, and it has to
     * keep holding on its own: somebody who hand-writes a request with a
     * foreign Person id never got the list from the picker anyway.
     */
    const forged = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.add_event_recipient($1, $2)", [f.birthday, f.people.bea]);
    assert.equal(forged.ok, false, "adding a Bravo person to an Alpha event must be refused");
    assert.match(String(forged.error), /different Area|23514|area/iu,
      `expected an Area refusal, got: ${forged.error}`);
  });

  test("THE SOURCE: every People read behind an event's pickers names an Area", () => {
    const settings = withoutComments(read("src", "app", "events", "[eventId]", "settings", "page.tsx"));
    const peopleRead = settings.split('.from("people")')[1] ?? "";
    assert.ok(peopleRead.length > 0, "the settings page still reads people");
    assert.match(peopleRead.split(";")[0], /\.eq\("area_id"/u,
      "the settings page's People read must carry an Area predicate");

    const screen = withoutComments(read("src", "app", "people", "people-screen.tsx"));
    for (const chunk of screen.split('.from("people")').slice(1)) {
      const statement = chunk.split(/;|\.from\(/u)[0];
      // A read already narrowed to specific ids cannot leak a whole family.
      if (/\.in\("id",/u.test(statement)) continue;
      assert.match(statement, /\.eq\("area_id"/u,
        `an unconstrained People read in people-screen.tsx must name an Area: ${statement.slice(0, 90)}`);
    }
  });

  test("and the picker FAILS CLOSED: no Area means no People, never everybody", () => {
    const screen = withoutComments(read("src", "app", "people", "people-screen.tsx"));
    assert.match(screen, /if \(!areaId\) \{ setDirectory\(\[\]\)/u,
      "an unknown Area empties the directory rather than falling back to an unscoped read");

    const settings = withoutComments(read("src", "app", "events", "[eventId]", "settings", "page.tsx"));
    assert.match(settings, /if \(!areaId\) notFound\(\)/u,
      "the server page refuses rather than rendering every Person");
  });
});

// ===========================================================================
// F3. The dialog that could not submit
// ===========================================================================

describe("F3: the Add recipient dialog chooses a Person and submits", () => {
  const screen = () => withoutComments(read("src", "app", "people", "people-screen.tsx"));

  test("THE REGRESSION ITSELF: nothing validates a name this dialog never collects", () => {
    const source = screen();
    assert.doesNotMatch(source, /validateRequiredText\(\s*name\s*,/u,
      "the submit handler must not validate a `name` the dialog does not set -- " +
      "a bare `name` resolves to window.name and refuses every submit");
    assert.doesNotMatch(source, /validateRequiredText/u,
      "and the import goes with it, so the shape cannot quietly return");
  });

  test("the person is CHOSEN, and the choice is what is validated", () => {
    const source = screen();
    const submit = source.slice(source.indexOf("const submit = async"));
    const body = submit.slice(0, submit.indexOf("\n  };"));

    assert.match(body, /directory\.find\(\(entry\) => entry\.personId === personId\)/u,
      "the selected Person is resolved from the family directory");
    assert.match(body, /if \(!chosen\)/u, "and a missing choice is the refusal, not a missing name");
    assert.match(body, /onSave\(chosen\.personId, chosen\.name/u,
      "their existing name travels with them, so nobody is renamed by this screen");
  });

  test("NO NAME FIELD CAME BACK, and no free-text Person creation with it", () => {
    const source = screen();
    const form = source.slice(source.indexOf("function AddForm"));
    assert.doesNotMatch(form, /<Input[^>]*label="Name"/u, "no Name field in the dialog");
    assert.doesNotMatch(form, /insert into public\.people|\.from\("people"\)\.insert/u,
      "and no path that creates a Person from typed text");
    assert.match(form, /Somebody new is added to People first/u,
      "the dialog still says where a new person actually comes from");
  });

  test("DOUBLE SUBMIT IS REFUSED TWICE OVER", () => {
    const source = screen();
    assert.match(source, /if \(saving\) return;/u, "the handler refuses a second run while one is in flight");
    assert.match(source, /disabled=\{saving \|\| !canSave\}/u, "and the button is disabled meanwhile");
  });

  test("somebody already on the event is not offered again", () => {
    const source = screen();
    assert.match(source, /alreadyRecipientPersonIds/u,
      "the dropdown excludes existing recipients, so a duplicate add is not reachable");
  });

  test("BUT SOMEBODY REMOVED FROM IT IS, so the dialog can bring them back", () => {
    /*
     * The exclusion used to cover every recipient row, active or not. Removing
     * somebody therefore took them out of the dropdown as well, and the only
     * route back was the Event settings chips -- which is not where anybody
     * looks. `add_event_recipient` reactivates the existing row rather than
     * creating a second, so offering them is safe.
     */
    const source = screen();
    assert.match(source, /alreadyRecipientPersonIds=\{people\.filter\(\(person\) => person\.active\)/u,
      "only ACTIVE recipients are excluded from the dropdown");
  });

  /*
   * WHAT THE DIALOG DOES ONCE IT SUBMITS -- reusing an existing recipient row
   * rather than creating a second, and refusing a foreign Person -- is proven
   * against a real database in `events-and-recipients.test.mjs`
   * ("and re-adding a REMOVED recipient reactivates them rather than making a
   * second", "A PERSON FROM ANOTHER FAMILY CANNOT BE A RECIPIENT HERE"). It is
   * not repeated here; this file covers the dialog that reaches it.
   */
});
