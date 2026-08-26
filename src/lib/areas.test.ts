import assert from "node:assert/strict";
import test, { describe } from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { AREA_COOKIE, CREATE_AREA_LABEL, CREATE_AREA_PATH, areaChoices, areaFromRow, areaLabel, needsFirstArea, resolveActiveArea, shouldOfferCreate, shouldOfferSwitcher, sortAreas, validateAreaName, type Area } from "./areas.ts";

const area = (id: string, name: string, archivedAt: string | null = null): Area => ({ id, name, archivedAt });

const HOME = area("a1", "The Taylors");
const OTHER = area("a2", "Beach house");
const OLD = area("a3", "Old flat", "2026-01-01T00:00:00Z");

describe("which family to show", () => {
  test("the remembered one, when it is still theirs", () => {
    assert.equal(resolveActiveArea([HOME, OTHER], "a2")?.id, "a2");
  });

  test("a cookie for a family they have left is ignored, not obeyed", () => {
    // Obeying it would render a screen with nothing on it and no explanation.
    assert.equal(resolveActiveArea([HOME], "a2")?.id, "a1");
  });

  test("with nothing remembered, the first live family alphabetically", () => {
    assert.equal(resolveActiveArea([OTHER, HOME], null)?.id, "a2");
  });

  test("an archived family is never chosen for you", () => {
    assert.equal(resolveActiveArea([OLD, HOME], undefined)?.id, "a1");
  });

  test("but can still be chosen deliberately", () => {
    assert.equal(resolveActiveArea([OLD, HOME], "a3")?.id, "a3");
  });

  test("when every family is archived, one of them is still shown", () => {
    assert.equal(resolveActiveArea([OLD], null)?.id, "a3");
  });

  test("and somebody with no family gets nothing rather than a guess", () => {
    assert.equal(resolveActiveArea([], "a1"), null);
    assert.equal(needsFirstArea([]), true);
    assert.equal(needsFirstArea([HOME]), false);
  });
});

describe("the switcher", () => {
  test("is offered only when there is somewhere to switch to", () => {
    assert.equal(shouldOfferSwitcher([]), false);
    assert.equal(shouldOfferSwitcher([HOME]), false);
    assert.equal(shouldOfferSwitcher([HOME, OTHER]), true);
  });

  test("lists live families first, archived last, each alphabetically", () => {
    const names = sortAreas([OLD, OTHER, HOME]).map((a) => a.name);
    assert.deepEqual(names, ["Beach house", "The Taylors", "Old flat"]);
  });

  test("marks exactly one entry as the current family", () => {
    const choices = areaChoices([HOME, OTHER], "a1");
    assert.deepEqual(choices.map((c) => c.active), [false, true]);
  });

  test("and marks none when there is no current family", () => {
    assert.ok(areaChoices([HOME, OTHER], null).every((c) => !c.active));
  });
});

describe("names", () => {
  test("a blank one is refused before it reaches the server", () => {
    assert.equal(validateAreaName("   ").ok, false);
  });

  test("surrounding space is trimmed rather than rejected", () => {
    const result = validateAreaName("  The Taylors  ");
    assert.deepEqual(result, { ok: true, value: "The Taylors" });
  });

  test("something unstorable is refused with a reason", () => {
    const result = validateAreaName("Tab\there");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /cannot store/);
  });

  test("and a missing name never renders as 'undefined'", () => {
    assert.equal(areaLabel(null), "Your family");
    assert.equal(areaLabel(area("a1", "   ")), "Your family");
    assert.equal(areaLabel(HOME), "The Taylors");
  });
});

describe("rows from the database", () => {
  test("an Area with no archived_at column reads as live", () => {
    assert.deepEqual(areaFromRow({ id: "a1", name: "The Taylors" }),
      { id: "a1", name: "The Taylors", archivedAt: null });
  });

  test("and the cookie name is stable, because a browser remembers it", () => {
    assert.equal(AREA_COOKIE, "gp_area");
  });
});

describe("the way to another family", () => {
  /**
   * `/areas/new` shipped with Areas and was linked from NO screen in the app.
   * The switcher listed what somebody already had and stopped there, so a
   * second family was reachable only by knowing the route and typing it -- and
   * the switcher itself was hidden from anybody with one family, which is
   * exactly who needed it.
   */
  test("offered to anybody who already has a family", () => {
    assert.equal(shouldOfferCreate([HOME]), true, "ONE family is the case that was invisible");
    assert.equal(shouldOfferCreate([HOME, OTHER]), true);
    assert.equal(shouldOfferCreate([OLD]), true, "even if the only one is archived");
  });

  test("and NOT to an account with none, which is already looking at the form", () => {
    // The root renders `CreateAreaForm` for them. A menu item pointing at the
    // screen they are on is noise, not discovery.
    assert.equal(shouldOfferCreate([]), false);
  });

  test("it is a different question from whether there is anything to switch to", () => {
    // Conflating the two is the entire bug: no switch, therefore no menu,
    // therefore no door.
    assert.equal(shouldOfferSwitcher([HOME]), false);
    assert.equal(shouldOfferCreate([HOME]), true);
  });

  test("the route and the wording are written down once", () => {
    // So the account menu, Settings and the tests cannot each name their own.
    assert.equal(CREATE_AREA_PATH, "/areas/new");
    assert.equal(CREATE_AREA_LABEL, "Create new family");
  });
});
