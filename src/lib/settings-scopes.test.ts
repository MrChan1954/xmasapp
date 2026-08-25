import assert from "node:assert/strict";
import test, { describe } from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { SCOPES, SETTINGS, scopeMeta, scopeReminder, settingsFor } from "./settings-scopes.ts";

describe("every setting has a scope, and the right one", () => {
  test("what follows the person is global, not per family", () => {
    // Filed under a family, a notification preference would silently stop
    // applying the moment somebody switched.
    for (const key of ["account", "notifications", "appearance"]) {
      assert.equal(SETTINGS.find((s) => s.key === key)?.scope, "global", key);
    }
  });

  test("what belongs to one family is area, not global", () => {
    // Filed globally, renaming a family would rename both of them.
    for (const key of ["family-name", "family-access", "people", "birthdays", "activity"]) {
      assert.equal(SETTINGS.find((s) => s.key === key)?.scope, "area", key);
    }
  });

  test("no setting is listed twice", () => {
    const keys = SETTINGS.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  test("and every one of them goes somewhere", () => {
    for (const entry of SETTINGS) assert.ok(entry.href.startsWith("/"), entry.key);
  });
});

describe("who sees what", () => {
  test("an ordinary member is not offered the administrator's entries", () => {
    const keys = settingsFor("area", { isAdmin: false }).map((s) => s.key);
    assert.ok(!keys.includes("family-access"));
    assert.ok(!keys.includes("family-name"));
    assert.ok(keys.includes("people"), "but still sees what everyone can open");
  });

  test("an administrator is offered all of them", () => {
    const keys = settingsFor("area", { isAdmin: true }).map((s) => s.key);
    assert.ok(keys.includes("family-access"));
    assert.ok(keys.includes("family-name"));
  });

  test("the global list is the same for everybody", () => {
    assert.deepEqual(
      settingsFor("global", { isAdmin: false }).map((s) => s.key),
      settingsFor("global", { isAdmin: true }).map((s) => s.key),
    );
  });

  test("hiding an entry is not the permission - the screens behind them re-check", () => {
    // This list decides what is OFFERED. Every admin-only destination is a page
    // or an RPC that authorises independently, so a member who types the URL
    // still gets nothing.
    const adminOnly = SETTINGS.filter((s) => s.adminOnly).map((s) => s.href);
    assert.ok(adminOnly.length > 0);
  });
});

describe("saying how far a setting reaches", () => {
  test("the family scope names the family it means", () => {
    assert.equal(scopeReminder("area", "The Taylors"),
      "These apply to The Taylors only. No other family sees them.");
  });

  test("the global scope says the opposite, in as many words", () => {
    assert.match(scopeReminder("global", "The Taylors"), /every family/);
  });

  test("and each scope has a heading and a reach", () => {
    assert.equal(SCOPES.length, 3);
    for (const scope of ["global", "area", "event"] as const) {
      const meta = scopeMeta(scope);
      assert.ok(meta.title.length > 0);
      assert.ok(meta.reach.length > 0);
    }
  });
});
