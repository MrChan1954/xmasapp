/**
 * THE SELECTED AREA OWNS THE EVENT CHROME.
 *
 * `getEvent` on the server has always carried `.eq("area_id", ...)`, so an
 * event URL belonging to another family 404s. The CLIENT provider that feeds
 * the global chrome did not: it asked only `.eq("id", eventId)` and leaned on
 * row level security. RLS narrows rows to the Areas the READER belongs to,
 * which is the right permission and the wrong question -- a login in two
 * families passes it in both. So standing in QA Charlie and opening a QA Alpha
 * event URL produced a page that 404ed while the masthead, the event nav and
 * the tab title all went on naming the Alpha event. Found in live browser QA.
 *
 * These tests render the REAL `FamilyProvider` against a fixture that holds
 * both families' rows -- exactly what RLS hands a two-family login -- and ask
 * what the chrome ends up saying. A source-string test could not tell the
 * difference between a query that is scoped and one that merely looks scoped;
 * this can, and it fails if the `area_id` predicate is removed.
 */
import assert from "node:assert/strict";
import test, { describe, beforeEach } from "node:test";

import { React, act, render } from "./dom/harness.mjs";
import { fake } from "./dom/stubs/supabase-client.mjs";
import { membership } from "./dom/stubs/current-member-client.mjs";
import { navigation } from "./dom/stubs/next-navigation.mjs";

const h = React.createElement;

const { FamilyProvider, useFamily } = await import("../src/app/family-context.tsx");

const ALPHA = "11111111-1111-4111-8111-111111111111";
const CHARLIE = "22222222-2222-4222-8222-222222222222";
const ALPHA_EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHARLIE_EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNKNOWN_EVENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ALPHA_NAME = "QA Alpha Mother's Day";
const CHARLIE_NAME = "QA Charlie Mother's Day";

/**
 * Both families' rows, because that is what the database really returns to this
 * login. If the fixture only held the selected family's rows the tests would
 * pass no matter what the application asked for, which is the trap.
 */
function bothFamilies() {
  return {
    events: [
      { id: ALPHA_EVENT, area_id: ALPHA, name: ALPHA_NAME, event_type: "custom", event_date: "2099-03-07", status: "active", year: null, celebrant_person_id: null },
      { id: CHARLIE_EVENT, area_id: CHARLIE, name: CHARLIE_NAME, event_type: "custom", event_date: "2099-03-07", status: "active", year: null, celebrant_person_id: null },
    ],
    christmas_recipients: [
      { id: "rec-alpha", christmas_event_id: ALPHA_EVENT, person_id: "p-alpha", active: true, budget_pennies: 1500 },
      { id: "rec-charlie", christmas_event_id: CHARLIE_EVENT, person_id: "p-charlie", active: true, budget_pennies: 2500 },
    ],
    people: [
      { id: "p-alpha", name: "Devon QA Alpha" },
      { id: "p-charlie", name: "Robin QA Charlie" },
    ],
    gift_ideas: [],
    purchases: [],
  };
}

/** What the chrome would be able to say, once the provider has settled. */
function Probe({ seen }) {
  const family = useFamily();
  seen.current = {
    eventName: family.event?.name ?? null,
    eventId: family.event?.id ?? null,
    areaId: family.areaId,
    peopleNames: family.people.map((person) => person.name),
    loading: family.loading,
  };
  // Rendered, not just recorded: "the name never appears in the chrome" is a
  // question about the DOM, and this is the DOM the chrome would build from.
  return h("div", null, family.event?.name ?? "");
}

/** Mount the provider at `pathname`, with `areaId` selected, and let it settle. */
async function mount({ pathname, areaId, tables = bothFamilies() }) {
  fake.reset(tables);
  navigation.reset(pathname);
  if (areaId === null) membership.reset(null);
  else membership.selectArea(areaId);

  const seen = { current: null };
  const view = await render(h(FamilyProvider, null, h(Probe, { seen })));
  // The provider defers its first load by a timeout, then awaits several reads.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { view, seen, text: () => view.container.textContent };
}

const eventPath = (id) => `/events/${id}`;

beforeEach(() => {
  fake.reset({});
  membership.reset(null);
  navigation.reset("/");
});

// ===========================================================================
// The control: the family on screen owns its own event
// ===========================================================================

describe("an event opened from its own family", () => {
  test("resolves, and names itself in the chrome", async () => {
    const { seen, text, view } = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: ALPHA });
    assert.equal(seen.current.eventId, ALPHA_EVENT);
    assert.equal(seen.current.eventName, ALPHA_NAME);
    assert.match(text(), /QA Alpha Mother's Day/u);
    await view.unmount();
  });

  test("and brings its own people, not the other family's", async () => {
    const { seen, view } = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: ALPHA });
    assert.deepEqual(seen.current.peopleNames, ["Devon QA Alpha"]);
    await view.unmount();
  });
});

// ===========================================================================
// The regression: a foreign event must not reach the chrome
// ===========================================================================

describe("an event belonging to the family NOT on screen", () => {
  test("DOES NOT RESOLVE INTO THE GLOBAL CONTEXT", async () => {
    const { seen, view } = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: CHARLIE });
    assert.equal(seen.current.eventId, null,
      "the provider resolved an event from a family the reader is not standing in");
    assert.equal(seen.current.eventName, null);
    await view.unmount();
  });

  test("AND ITS NAME NEVER REACHES THE DOM", async () => {
    const { text, view } = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: CHARLIE });
    assert.doesNotMatch(text(), /QA Alpha/u,
      "a foreign event name was rendered in the chrome");
    await view.unmount();
  });

  test("and none of its people, budgets or counts are loaded either", async () => {
    const { seen, view } = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: CHARLIE });
    assert.deepEqual(seen.current.peopleNames, [],
      "clearing only the name would still leave the foreign event's people in the provider");
    await view.unmount();
  });

  test("the read that fetched it asked for the selected Area", async () => {
    const { view } = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: CHARLIE });
    const [filters] = fake.filtersFor("events");
    assert.ok(filters, "no read of the events table was made at all");
    assert.ok(filters.some((filter) => filter.startsWith("eq:area_id=")),
      `the events read carried no area_id predicate: ${JSON.stringify(filters)}`);
    await view.unmount();
  });

  test("BELONGING TO BOTH FAMILIES DOES NOT WEAKEN IT", async () => {
    /*
     * The whole difficulty of this bug. This login is a member -- an ADMIN --
     * in both families, so row level security returns the Alpha row perfectly
     * legitimately, and the fixture reflects that: the Alpha event is present
     * and readable. Being entitled to read it in Alpha is not permission to
     * show it while standing in Charlie.
     */
    const tables = bothFamilies();
    const { seen, text, view } = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: CHARLIE, tables });
    assert.ok(tables.events.some((row) => row.id === ALPHA_EVENT),
      "precondition: the foreign event really is readable by this login");
    assert.equal(seen.current.eventName, null);
    assert.doesNotMatch(text(), /QA Alpha/u);
    await view.unmount();
  });
});

// ===========================================================================
// Switching back
// ===========================================================================

describe("switching back to the family the event belongs to", () => {
  test("lets the same event resolve again", async () => {
    const denied = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: CHARLIE });
    assert.equal(denied.seen.current.eventName, null);
    await denied.view.unmount();

    const allowed = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: ALPHA });
    assert.equal(allowed.seen.current.eventName, ALPHA_NAME,
      "the denial must be about the selected Area, not about the event");
    await allowed.view.unmount();
  });
});

// ===========================================================================
// Stale context: the address bar changes under a mounted provider
// ===========================================================================

describe("stale event context", () => {
  test("BACK ONTO A FOREIGN EVENT ROUTE CLEARS THE CHROME", async () => {
    /*
     * The history case, which no server gate sees. Switching family is a full
     * page load to "/", so pressing Back returns to the previous family's event
     * URL and the provider re-renders on the client alone. Here: the reader is
     * standing in Charlie on its own event, then navigates back to the Alpha
     * event route without the selected Area changing.
     */
    const { seen, text, view } = await mount({ pathname: eventPath(CHARLIE_EVENT), areaId: CHARLIE });
    assert.equal(seen.current.eventName, CHARLIE_NAME, "precondition: Charlie's own event resolved");

    navigation.pathname = eventPath(ALPHA_EVENT);
    await view.update(h(FamilyProvider, null, h(Probe, { seen })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    assert.equal(seen.current.eventName, null,
      "going back to a foreign event route left the previous event in the chrome");
    assert.doesNotMatch(text(), /QA Alpha/u);
    await view.unmount();
  });

  test("leaving an event route clears it too", async () => {
    const { seen, view } = await mount({ pathname: eventPath(CHARLIE_EVENT), areaId: CHARLIE });
    assert.equal(seen.current.eventName, CHARLIE_NAME);

    navigation.pathname = "/";
    await view.update(h(FamilyProvider, null, h(Probe, { seen })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    assert.equal(seen.current.eventName, null);
    assert.deepEqual(seen.current.peopleNames, []);
    await view.unmount();
  });
});

// ===========================================================================
// Ids that are not events
// ===========================================================================

describe("ids that resolve to nothing", () => {
  test("a malformed id is safe, and asks the database nothing", async () => {
    const { seen, view } = await mount({ pathname: "/events/not-a-uuid", areaId: CHARLIE });
    assert.equal(seen.current.eventName, null);
    assert.equal(fake.filtersFor("events").length, 0,
      "a malformed id must not become a query");
    await view.unmount();
  });

  test("an unknown id is safe", async () => {
    const { seen, text, view } = await mount({ pathname: eventPath(UNKNOWN_EVENT), areaId: CHARLIE });
    assert.equal(seen.current.eventName, null);
    assert.equal(text(), "");
    await view.unmount();
  });

  test("and so is having no family selected at all", async () => {
    // No membership resolved means no family has been chosen. There is no Area
    // to scope to, so there is nothing safe to show and nothing is shown.
    const { seen, text, view } = await mount({ pathname: eventPath(ALPHA_EVENT), areaId: null });
    assert.equal(seen.current.eventName, null,
      "with no family selected the provider must not resolve an event");
    assert.equal(text(), "");
    assert.equal(fake.filtersFor("events").length, 0);
    await view.unmount();
  });
});
