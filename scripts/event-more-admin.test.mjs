/**
 * WHO THE EVENT'S MORE SCREEN THINKS YOU ARE.
 *
 * THE BUG THIS FILE EXISTS FOR. The screen used to discover whether the reader
 * administered the family by sending a GET to `/api/admin/family-access` and
 * reading the role off the HTTP status: `ok` meant admin, 401/403 meant not,
 * anything else meant "we could not check". Q19 rewrote that route -- migration
 * 052 moved every read into `list_area_access()` -- and its GET handler went
 * with the rest. Next answers a GET to a POST-only route with 405, which is
 * none of the three cases, so every reader fell into the third and saw:
 *
 *     We could not check whether you administer this family, so admin-only
 *     entries are hidden.
 *
 * An administrator was told their own role was unknowable, live, in production.
 *
 * WHY THESE TESTS RENDER RATHER THAN READ THE SOURCE. A source-string test
 * would have been perfectly happy with the broken version: the fetch was there,
 * the branches were there, and the word `isAdmin` was there. What was wrong was
 * what the code DID when it ran. So the real `FamilyProvider` is mounted over
 * the real screen and the question asked is what ends up on the page.
 *
 * THE ADMIN-ONLY ENTRY IS "Event settings". "Payment log" is offered to
 * everybody and is the control: a test that only checked for absence would pass
 * against a screen that rendered nothing at all.
 */
import assert from "node:assert/strict";
import test, { describe, beforeEach } from "node:test";

import { React, act, render } from "./dom/harness.mjs";
import { fake } from "./dom/stubs/supabase-client.mjs";
import { membership } from "./dom/stubs/current-member-client.mjs";
import { navigation } from "./dom/stubs/next-navigation.mjs";

const h = React.createElement;

const { FamilyProvider } = await import("../src/app/family-context.tsx");
// `AppFrame` supplies this in production, above every screen that has chrome.
// The tree here is the tree there, so the shell renders exactly as it really does.
const { NotificationInboxProvider } = await import("../src/app/components/use-notification-inbox.ts");
const { EventMoreScreen } = await import("../src/app/events/[eventId]/more/event-more-screen.tsx");

const ALPHA = "11111111-1111-4111-8111-111111111111";
const CHARLIE = "22222222-2222-4222-8222-222222222222";
const ALPHA_EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_NAME = "QA Alpha Christmas";

const ADMIN_ONLY = /Event settings/u;
const EVERYONE = /Payment log/u;
const CANNOT_CHECK = /could not check whether you administer/u;

function tables() {
  return {
    events: [
      {
        id: ALPHA_EVENT, area_id: ALPHA, name: EVENT_NAME, event_type: "christmas",
        event_date: "2099-12-25", status: "active", year: 2099, celebrant_person_id: null,
      },
    ],
    christmas_recipients: [],
    people: [],
    app_members: [],
  };
}

/** A seat in one family, carrying the role it has THERE. */
const seat = (areaId, role) => ({
  id: `member-${areaId}-${role}`,
  person_id: `person-${areaId}`,
  contributor_id: null,
  role,
  active: true,
  area_id: areaId,
});

async function mount(member) {
  navigation.reset(`/events/${ALPHA_EVENT}/more`);
  membership.current = member;

  const view = await render(
    h(FamilyProvider, null,
      h(NotificationInboxProvider, null,
        h(EventMoreScreen, { eventId: ALPHA_EVENT, eventName: EVENT_NAME }))),
  );
  // The provider defers its first load by a timeout, then awaits several reads.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return { view, text: () => view.container.textContent };
}

beforeEach(() => {
  fake.reset(tables());
  membership.current = null;
  navigation.reset("/");
});

// ===========================================================================
// The family administrator -- the person the entries exist for
// ===========================================================================

describe("a Family admin of the selected Area", () => {
  test("SEES THE ADMIN-ONLY ENTRY", async () => {
    const { text, view } = await mount(seat(ALPHA, "admin"));
    assert.match(text(), ADMIN_ONLY,
      "the administrator of this family was not offered the admin-only entry");
    await view.unmount();
  });

  test("and is NOT told their role could not be checked", async () => {
    const { text, view } = await mount(seat(ALPHA, "admin"));
    assert.doesNotMatch(text(), CANNOT_CHECK,
      "the live regression: an administrator told their own role is unknowable");
    await view.unmount();
  });
});

// ===========================================================================
// Everybody else
// ===========================================================================

describe("an ordinary member of the selected Area", () => {
  test("does not see the admin-only entry", async () => {
    const { text, view } = await mount(seat(ALPHA, "member"));
    assert.doesNotMatch(text(), ADMIN_ONLY);
    await view.unmount();
  });

  test("but still gets the entries that are not admin-only", async () => {
    const { text, view } = await mount(seat(ALPHA, "member"));
    assert.match(text(), EVERYONE,
      "the control -- a screen rendering nothing would pass the test above");
    await view.unmount();
  });

  test("and sees no warning, because nothing failed", async () => {
    const { text, view } = await mount(seat(ALPHA, "member"));
    assert.doesNotMatch(text(), CANNOT_CHECK);
    await view.unmount();
  });
});

// ===========================================================================
// THE ROLE SEPARATION. Three kinds of administrator, and only one of them
// administers THIS family.
// ===========================================================================

describe("role separation", () => {
  test("ADMIN OF ANOTHER FAMILY IS NOT ADMIN HERE", async () => {
    // The same login: an administrator in Charlie, an ordinary member in Alpha,
    // standing in Alpha. The seat decides, not the account.
    const { text, view } = await mount(seat(ALPHA, "member"));
    assert.doesNotMatch(text(), ADMIN_ONLY, "admin rights carried across an Area boundary");
    assert.match(text(), EVERYONE);
    await view.unmount();
  });

  test("and the SELECTED Area is what decides", async () => {
    // The mirror of the case above: the same login standing in the family it
    // does administer. Without this, hiding everything always would pass.
    const { text, view } = await mount(seat(CHARLIE, "admin"));
    assert.match(text(), ADMIN_ONLY, "the role of the selected Area is what the screen must read");
    await view.unmount();
  });

  test("A GIFT PLANNER GLOBAL ADMIN IS NOT A FAMILY ADMIN", async () => {
    /*
     * The whole point of having two kinds of administrator. `my_account_status`
     * says this account may approve Gift Planner accounts. It says nothing
     * about anybody's family, and must not be readable as though it did.
     */
    fake.rpc.my_account_status = () => ({
      data: [{ status: "approved", is_global_admin: true, email_confirmed: true }],
      error: null,
    });
    const { text, view } = await mount(seat(ALPHA, "member"));
    assert.doesNotMatch(text(), ADMIN_ONLY,
      "a Gift Planner administrator was handed a family's admin entries");
    assert.match(text(), EVERYONE);
    await view.unmount();
  });
});

// ===========================================================================
// Failure, which must close rather than open
// ===========================================================================

describe("when the role cannot be established", () => {
  test("IT FAILS CLOSED, and says so", async () => {
    /*
     * `getCurrentMemberClient` returns null both for a membership read that
     * failed AND for a login in several families with no family remembered --
     * it refuses to guess between them, which is what stops admin rights
     * leaking across an Area boundary. Both arrive here identically, and both
     * must hide the entry rather than reveal it.
     */
    const { text, view } = await mount(null);
    assert.doesNotMatch(text(), ADMIN_ONLY, "an unresolved role must never open anything");
    assert.match(text(), CANNOT_CHECK, "and the reader should be told the check did not happen");
    await view.unmount();
  });
});

// ===========================================================================
// And the statement that the old probe is gone for good
// ===========================================================================

describe("the screen no longer infers a role from a route", () => {
  test("it asks the family context and nothing else", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/app/events/[eventId]/more/event-more-screen.tsx", import.meta.url),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    assert.ok(!code.includes("fetch("),
      "a role is not a status code -- this screen must not probe an endpoint to find one");
    assert.ok(!code.includes("/api/admin/family-access"));
    assert.match(code, /useFamily\(\)/u);
  });
});
