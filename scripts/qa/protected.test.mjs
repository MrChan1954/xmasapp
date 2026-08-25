/**
 * THE GUARD IS ONLY WORTH HAVING IF IT REFUSES.
 *
 * Every test here runs the real functions from `protected.mjs` against
 * SYNTHETIC ids. Nothing in this file knows the real family's Area id, and it
 * must stay that way -- a test that hard-codes the thing it is protecting is
 * one search-and-replace away from being the leak.
 *
 * The shape under test is "fail closed": the interesting assertion is almost
 * always that something THREW, not that something worked.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ProtectedTargetError, assertNotProtectedEvent, assertQaArea, assertRowInQaArea,
  assertSafeUrl, loadQaConfig, qaWrite,
} from "./protected.mjs";

// Synthetic throughout. REAL is "the real family" only in this file's fiction.
const REAL_AREA = "aaaaaaaa-0000-4000-8000-000000000001";
const REAL_EVENT = "aaaaaaaa-0000-4000-8000-000000000002";
const REAL_PERSON = "aaaaaaaa-0000-4000-8000-000000000003";
const REAL_MEMBER = "aaaaaaaa-0000-4000-8000-000000000004";
const QA_ALPHA = "bbbbbbbb-0000-4000-8000-000000000001";
const QA_BRAVO = "bbbbbbbb-0000-4000-8000-000000000002";
const QA_PERSON = "bbbbbbbb-0000-4000-8000-000000000003";
const STRANGER_AREA = "cccccccc-0000-4000-8000-000000000001";

const configFile = (overrides = {}) => JSON.stringify({
  protectedAreaIds: [REAL_AREA],
  protectedEventIds: [REAL_EVENT],
  qaAreaIds: [QA_ALPHA, QA_BRAVO],
  ...overrides,
});

const withConfig = (overrides) =>
  loadQaConfig({ path: "(test)", read: () => configFile(overrides) });

const config = withConfig();

/** Stands in for a database read: which Area does this row live in? */
const resolve = async (table, id) => {
  const rows = {
    [REAL_PERSON]: { area_id: REAL_AREA },
    [REAL_MEMBER]: { area_id: REAL_AREA },
    [QA_PERSON]: { area_id: QA_ALPHA },
    "cccccccc-0000-4000-8000-000000000009": { area_id: STRANGER_AREA },
  };
  return rows[id] ?? null;
};

const refuses = async (fn, matching) => {
  await assert.rejects(async () => fn(), (error) => {
    assert.ok(error instanceof ProtectedTargetError, `expected a refusal, got ${error?.name}: ${error?.message}`);
    if (matching) assert.match(error.message, matching);
    return true;
  });
};

const refusesSync = (fn, matching) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ProtectedTargetError, `expected a refusal, got ${error?.name}`);
    if (matching) assert.match(error.message, matching);
    return true;
  });
};

// ===========================================================================
// 1. The configuration itself
// ===========================================================================

describe("the QA configuration refuses to be ambiguous", () => {
  test("a missing config file refuses everything rather than defaulting", () => {
    refusesSync(
      () => loadQaConfig({ path: "(nowhere)", read: () => { throw new Error("ENOENT"); } }),
      /No QA configuration/u,
    );
  });

  test("an unparseable config refuses too", () => {
    refusesSync(() => loadQaConfig({ path: "(test)", read: () => "{ not json" }), /not valid JSON/u);
  });

  test("AN AREA ON BOTH LISTS IS A BROKEN CONFIG, NOT A PERMISSION", () => {
    // The realistic accident: the real id pasted into the QA list during setup.
    refusesSync(
      () => withConfig({ qaAreaIds: [REAL_AREA, QA_ALPHA] }),
      /BOTH protected and QA/u,
    );
  });

  test("no protected Area named means nothing is being protected, so refuse", () => {
    refusesSync(() => withConfig({ protectedAreaIds: [] }), /Refusing rather than assuming/u);
  });

  test("no QA Area yet means there is nowhere safe to write, so refuse", () => {
    // This is the correct state BEFORE the rollout: the guard is armed and
    // every write is denied because no synthetic tenant exists.
    refusesSync(() => withConfig({ qaAreaIds: [] }), /No synthetic Area exists yet/u);
  });

  test("anything that is not an id is refused rather than coerced", () => {
    refusesSync(() => withConfig({ qaAreaIds: ["the qa one"] }), /not an id/u);
    refusesSync(() => withConfig({ protectedAreaIds: "all of them" }), /must be a list/u);
  });
});

// ===========================================================================
// 2. Areas
// ===========================================================================

describe("which Area QA may write to", () => {
  test("a known QA Area is allowed", () => {
    assert.equal(assertQaArea(config, QA_ALPHA), QA_ALPHA);
    assert.equal(assertQaArea(config, QA_BRAVO), QA_BRAVO);
  });

  test("THE REAL FAMILY'S AREA IS REFUSED", () => {
    refusesSync(() => assertQaArea(config, REAL_AREA), /REAL FAMILY/u);
  });

  test("and so is an Area that is merely unknown", () => {
    // Allow-list, not deny-list. An Area left behind by a half-finished test
    // run is neither protected nor synthetic, and writing to it is still wrong.
    refusesSync(() => assertQaArea(config, STRANGER_AREA), /not a known QA Area/u);
  });

  test("case does not launder an id", () => {
    refusesSync(() => assertQaArea(config, REAL_AREA.toUpperCase()), /REAL FAMILY/u);
  });

  test("nonsense is refused rather than passed through", () => {
    for (const bad of [null, undefined, "", "../../etc", 42]) {
      refusesSync(() => assertQaArea(config, bad), /Not an Area id/u);
    }
  });
});

// ===========================================================================
// 3. Events, and the browser's address bar
// ===========================================================================

describe("the real Christmas is not a QA subject", () => {
  test("the protected event is refused", () => {
    refusesSync(() => assertNotProtectedEvent(config, REAL_EVENT), /protected real data/u);
  });

  test("a synthetic event id is fine", () => {
    const qaEvent = "bbbbbbbb-0000-4000-8000-00000000000e";
    assert.equal(assertNotProtectedEvent(config, qaEvent), qaEvent);
  });

  test("A BROWSER MAY NOT EVEN OPEN THE REAL CHRISTMAS", () => {
    // Not a write, but a screenshot of the family's real spending is its own
    // kind of harm, so the refusal happens at the address bar.
    refusesSync(
      () => assertSafeUrl(config, `http://localhost:3000/events/${REAL_EVENT}`),
      /protected event/u,
    );
  });

  test("nor any URL naming the real Area", () => {
    refusesSync(
      () => assertSafeUrl(config, `http://localhost:3000/?area=${REAL_AREA.toUpperCase()}`),
      /real family's Area/u,
    );
  });

  test("an ordinary QA URL is allowed", () => {
    const url = `http://localhost:3000/events/bbbbbbbb-0000-4000-8000-00000000000e/settings`;
    assert.equal(assertSafeUrl(config, url), url);
  });
});

// ===========================================================================
// 4. Rows resolved against the database
// ===========================================================================

describe("a row is safe only if it demonstrably lives in a QA Area", () => {
  test("a synthetic person is allowed", async () => {
    assert.equal(await assertRowInQaArea(config, resolve, "people", QA_PERSON), QA_PERSON);
  });

  test("A REAL PERSON IS REFUSED, even though no list names them", async () => {
    // The static lists cannot enumerate every real person without copying the
    // family's ids into a file, so the Area is asked instead.
    await refuses(() => assertRowInQaArea(config, resolve, "people", REAL_PERSON), /REAL FAMILY/u);
  });

  test("A REAL MEMBERSHIP IS REFUSED for the same reason", async () => {
    await refuses(() => assertRowInQaArea(config, resolve, "app_members", REAL_MEMBER), /REAL FAMILY/u);
  });

  test("A ROW THAT CANNOT BE RESOLVED IS REFUSED, not assumed harmless", async () => {
    await refuses(
      () => assertRowInQaArea(config, resolve, "people", "bbbbbbbb-0000-4000-8000-0000000000ff"),
      /Refusing rather than guessing/u,
    );
  });

  test("and a row in some third Area is refused as well", async () => {
    await refuses(
      () => assertRowInQaArea(config, resolve, "people", "cccccccc-0000-4000-8000-000000000009"),
      /not a known QA Area/u,
    );
  });
});

// ===========================================================================
// 5. The one door
// ===========================================================================

describe("qaWrite checks and writes in the same breath", () => {
  test("a well-formed QA write goes through", async () => {
    let written = false;
    await qaWrite(config, { areaId: QA_ALPHA, subjects: [{ table: "people", id: QA_PERSON }], resolve },
      () => { written = true; return "done"; });
    assert.equal(written, true);
  });

  test("THE WRITE NEVER RUNS WHEN THE AREA IS THE REAL ONE", async () => {
    let written = false;
    await refuses(
      () => qaWrite(config, { areaId: REAL_AREA }, () => { written = true; }),
      /REAL FAMILY/u,
    );
    assert.equal(written, false, "the refusal must come BEFORE the write, not after");
  });

  test("nor when a named subject turns out to be real", async () => {
    let written = false;
    await refuses(
      () => qaWrite(config,
        { areaId: QA_ALPHA, subjects: [{ table: "app_members", id: REAL_MEMBER }], resolve },
        () => { written = true; }),
      /REAL FAMILY/u,
    );
    assert.equal(written, false);
  });

  test("nor when the real Christmas is named", async () => {
    let written = false;
    await refuses(
      () => qaWrite(config, { areaId: QA_ALPHA, eventId: REAL_EVENT }, () => { written = true; }),
      /protected real data/u,
    );
    assert.equal(written, false);
  });

  test("naming a subject with no way to resolve it is refused, not skipped", async () => {
    await refuses(
      () => qaWrite(config, { areaId: QA_ALPHA, subjects: [{ table: "people", id: QA_PERSON }] }, () => {}),
      /no way to resolve/u,
    );
  });
});
