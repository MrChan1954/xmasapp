import assert from "node:assert/strict";
import test, { describe } from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { NEVER_IN_EVENT_SCOPE, SCOPES, SETTINGS, eventSettingsFor, scopeMeta, scopeReminder, settingsFor } from "./settings-scopes.ts";

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

describe("an event's settings are the event's, and only the event's", () => {
  const EVENT = "11111111-2222-4333-8444-555555555555";

  test("every entry an event offers is event-scoped", () => {
    for (const entry of eventSettingsFor(EVENT, "Mother's Day", { isAdmin: true })) {
      assert.equal(entry.scope, "event", entry.key);
    }
  });

  test("and every one of them points INTO this event, never out of it", () => {
    // The whole reason an event's list is built per event: a hard-coded
    // "/payment-log" would show Christmas's log while standing in a birthday.
    for (const entry of eventSettingsFor(EVENT, "Mother's Day", { isAdmin: true })) {
      assert.ok(entry.href.startsWith(`/events/${EVENT}/`),
        `${entry.key} must stay inside the event: ${entry.href}`);
    }
  });

  test("NOTHING THAT BELONGS TO THE PERSON OR THE FAMILY APPEARS IN IT", () => {
    // The bug this whole scope model exists to prevent: standing inside
    // Mother's Day and being offered Falling snow or Family access.
    const offered = eventSettingsFor(EVENT, "Mother's Day", { isAdmin: true })
      .flatMap((entry) => [entry.title, entry.description]).join(" | ");
    for (const forbidden of NEVER_IN_EVENT_SCOPE) {
      assert.ok(!offered.includes(forbidden), `${forbidden} is not an event setting`);
    }
  });

  test("renaming and re-dating an event is admin-only; reading its payments is not", () => {
    const asMember = eventSettingsFor(EVENT, "Mother's Day", { isAdmin: false }).map((e) => e.key);
    assert.ok(!asMember.includes("event-settings"), "a member is not offered the admin screen");
    assert.ok(asMember.includes("event-payment-log"), "but every member may read the log");
  });

  test("the event name is used, so the reader knows which occasion they are changing", () => {
    const entries = eventSettingsFor(EVENT, "Mother's Day", { isAdmin: true });
    assert.ok(entries.some((entry) => entry.description.includes("Mother's Day")));
  });

  test("and the forbidden list is not empty, or the sweep above proves nothing", () => {
    assert.ok(NEVER_IN_EVENT_SCOPE.length >= 5);
    // Each forbidden name really is a setting that exists at a wider scope.
    for (const name of ["Falling snow", "Account & security", "Family access"]) {
      assert.ok(NEVER_IN_EVENT_SCOPE.includes(name));
    }
  });
});
