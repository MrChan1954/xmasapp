import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Line endings normalised: git stores LF and checks out CRLF on Windows, so a
// multi-line pattern would otherwise stop matching a file nobody had edited.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");
const APP = ["src", "app"];

const {
  groupGiftHistory, partitionGiftHistory, totalGiftCount, totalSpentPennies,
} = await import("../src/lib/people.ts");

/**
 * Phase 3 -- People are the directory, and gift history is a projection.
 *
 * THE ONE MISTAKE THAT MATTERS is showing somebody a gift that was not theirs,
 * or a total that was not about them. Both are easy: everybody in a
 * multi-recipient Christmas participates in the same event, and the event's own
 * total is right there. The tests below are mostly about what must NOT appear.
 */

const shell = (over = {}) => ({
  eventId: "e1", eventName: "Christmas 2026", eventType: "christmas",
  eventDate: "2026-12-25", eventStatus: "active", budgetPennies: 6000, ...over,
});
const gift = (id, pennies, over = {}) => ({
  purchaseId: id, description: id, pricePennies: pennies,
  purchaseDate: "2026-11-01", status: "purchased", ...over,
});

test("history groups by event, and sums only that person's own purchases", () => {
  const [entry] = groupGiftHistory([
    shell(),
    shell({ gift: gift("headset", 3500) }),
    shell({ gift: gift("socks", 500) }),
  ]);

  assert.equal(entry.eventId, "e1");
  assert.equal(entry.spentPennies, 4000, "£35 + £5, in integer pennies");
  assert.equal(entry.gifts.length, 2);
  assert.equal(entry.budgetPennies, 6000, "the budget is theirs, from their recipient row");
});

test("a repeated row cannot double-count a gift", () => {
  // The join that produces these rows fans out across ideas, so the same
  // purchase legitimately arrives more than once. Counting it twice would
  // inflate a real family's spend.
  const [entry] = groupGiftHistory([
    shell({ gift: gift("headset", 3500) }),
    shell({ gift: gift("headset", 3500) }),
    shell({ gift: gift("headset", 3500) }),
  ]);
  assert.equal(entry.gifts.length, 1);
  assert.equal(entry.spentPennies, 3500, "once, not three times");
});

test("an idea is never a gift and never a penny of spend", () => {
  const [entry] = groupGiftHistory([
    shell({ gift: gift("headset", 3500) }),
    shell({ idea: { giftIdeaId: "i1", title: "A bike", estimatedPricePennies: 20000 } }),
    shell({ idea: { giftIdeaId: "i1", title: "A bike", estimatedPricePennies: 20000 } }),
  ]);

  assert.equal(entry.spentPennies, 3500, "a £200 idea adds nothing");
  assert.equal(entry.gifts.length, 1);
  assert.equal(entry.ideas.length, 1, "and is not double-counted either");
  assert.equal(totalGiftCount([entry]), 1, "an idea is not a gift");
});

test("several events become several entries, newest first", () => {
  const history = groupGiftHistory([
    shell({ eventId: "x", eventName: "Christmas 2025", eventDate: "2025-12-25", gift: gift("a", 100) }),
    shell({ eventId: "h", eventName: "Halloween", eventType: "other", eventDate: "2026-10-31", gift: gift("b", 200) }),
    shell({ eventId: "c", eventName: "Christmas 2026", eventDate: "2026-12-25", gift: gift("c", 300) }),
  ]);

  assert.deepEqual(history.map((entry) => entry.eventName), ["Christmas 2026", "Halloween", "Christmas 2025"]);
  assert.equal(totalSpentPennies(history), 600);
  assert.equal(totalGiftCount(history), 3);
});

test("an event they are in but nothing was bought for is still part of the answer", () => {
  const [entry] = groupGiftHistory([shell({ eventName: "Halloween", budgetPennies: 2000 })]);
  assert.equal(entry.spentPennies, 0);
  assert.equal(entry.gifts.length, 0);
  assert.equal(entry.budgetPennies, 2000, "'£20 budgeted, nothing bought yet' is an answer");
});

test("coming up and previously are split by date, and archived events stay", () => {
  const history = groupGiftHistory([
    shell({ eventId: "past", eventName: "Christmas 2025", eventDate: "2025-12-25", gift: gift("a", 100) }),
    shell({ eventId: "soon", eventName: "Halloween", eventDate: "2026-10-31", gift: gift("b", 200) }),
    shell({ eventId: "gone", eventName: "Easter 2026", eventDate: "2026-04-05", eventStatus: "archived", gift: gift("c", 300) }),
  ]);
  const { current, previous } = partitionGiftHistory(history, "2026-08-24");

  assert.deepEqual(current.map((entry) => entry.eventId), ["soon"]);

  // ARCHIVED IS NOT ERASED. "What did we get Eden last Christmas" has to keep
  // working after somebody tidies up, so an archived event is history rather
  // than absent -- newest first, like the rest of the past.
  assert.deepEqual(previous.map((entry) => entry.eventId), ["gone", "past"]);
  assert.equal(previous.find((entry) => entry.eventId === "gone").eventStatus, "archived");
  assert.equal(previous.find((entry) => entry.eventId === "gone").spentPennies, 300, "with its money intact");
});

test("an active event whose date has passed is history too", () => {
  const history = groupGiftHistory([shell({ eventDate: "2026-01-01" })]);
  const { current, previous } = partitionGiftHistory(history, "2026-08-24");
  assert.equal(current.length, 0, "it is not coming up; it has been");
  assert.equal(previous.length, 1);
});

// ---------------------------------------------------------------------------
// The wiring: routes, the loader, and what must not leak through them
// ---------------------------------------------------------------------------

test("history is derived from the recipient row, never from event participation", () => {
  const loader = read("src", "utils", "supabase", "people-server.ts");

  // THE JOIN IS THE PROOF OF OWNERSHIP. It starts at this person's recipient
  // rows, so a purchase appears only when the database says it was for them.
  assert.match(loader, /\.from\("christmas_recipients"\)[\s\S]{0,120}\.eq\("person_id", personId\)/u);
  assert.match(loader, /\.in\("christmas_recipient_id", recipientIds\)/u);

  // The two ways of getting this wrong.
  assert.ok(!loader.includes("gift_location_person_id"),
    "where a present is hidden is not who it is for");
  assert.ok(!loader.includes('from("contributors")'),
    "contributing to an event is not receiving from it");
});

test("deleted purchases stay deleted, and no second history store exists", () => {
  const loader = read("src", "utils", "supabase", "people-server.ts");
  assert.match(loader, /\.is\("deleted_at", null\)/u, "a voided purchase is not history");

  for (const name of ["person_gift_history", "gift_history", "person_history"]) {
    assert.ok(!loader.includes(name), `${name} would be a cache of data the database already has`);
  }
});

test("the profile route serves a person and still answers the old link", () => {
  const page = read(...APP, "people", "[id]", "page.tsx");
  assert.match(page, /loadPersonProfile\(id\)/u);
  assert.match(page, /<PersonProfileScreen/u);
  // The id in a pre-Checkpoint-2 notification is a CHRISTMAS RECIPIENT id, so
  // anything that is not a person falls through to the redirect it always had.
  assert.match(page, /if \(!profile\) return redirectLegacyRoute\("people"/u);

  const directory = read(...APP, "people", "page.tsx");
  assert.match(directory, /if \(person\) return redirectLegacyRoute\("people"/u, "?person= still forwards");
  assert.match(directory, /loadPeopleDirectory\(\)/u);
});

test("the profile never renders a figure that is not about this person", () => {
  const screen = read(...APP, "people", "[id]", "person-profile-screen.tsx");

  // The event's own total includes everybody else's presents.
  assert.match(screen, /formatPennies\(entry\.spentPennies\)/u);
  assert.ok(!screen.includes("eventSpentPennies"), "never the event's total");
  assert.match(screen, /spent on them/u, "and the wording says whose it is");

  // Ideas are labelled and kept out of every total.
  assert.match(screen, /Ideas · not bought/u);
  assert.match(screen, /totalSpentPennies\(history\)/u);
  assert.match(screen, /totalGiftCount\(history\)/u);
});

test("the person's own profile says why their birthday is missing from it", () => {
  const screen = read(...APP, "people", "[id]", "person-profile-screen.tsx");

  // Row level security removed it before this page existed, so `history` simply
  // has no entry. Saying so is the difference between a deliberate rule and a
  // page that looks broken.
  assert.match(screen, /\{isSelf && \(/u);
  assert.match(screen, /You can&apos;t view your own birthday gifts/u);

  // And it is birthday-ONLY: everything else stays visible to them.
  assert.match(screen, /Everything else the family has bought you is below/u);
  const loader = read("src", "utils", "supabase", "people-server.ts");
  assert.match(loader, /isSelf: viewerPersonId !== null && viewerPersonId === person\.personId/u);
  assert.ok(!loader.includes("if (isSelf) return"), "self must not hide the whole profile");
});

test("adding a person creates a person, and decides nothing else about them", () => {
  const form = read(...APP, "people", "new", "add-person-form.tsx");
  assert.match(form, /\.rpc\("create_person", \{/u, "one call, so a bad date leaves nothing behind");

  const rpcs = [...form.matchAll(/\.rpc\("([a-z_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(rpcs)], ["create_person"]);
  for (const forbidden of ["set_family_contributor", "app_members", "claim_app_member", "is_family_contributor"]) {
    assert.ok(!form.includes(forbidden), `adding a person must not touch ${forbidden}`);
  }

  // Admin-gated on the server before it renders, and in the database again.
  const page = read(...APP, "people", "new", "page.tsx");
  assert.match(page, /member\.role !== "admin"/u);
});

test("an event picks an EXISTING person, and never types one into existence", () => {
  const screen = read(...APP, "people", "people-screen.tsx");

  // THE BUG THIS REPLACES. `save_christmas_recipient_with_contributions` takes
  // a NAME and, with no recipient id, runs `insert into public.people (name)`
  // unconditionally -- so "Eden" on Christmas and "Eden" on Halloween became
  // two Eden rows with separate birthdays and separate histories.
  assert.match(screen, /onSave\(chosen\.personId, chosen\.name,/u);
  assert.match(screen, /addExistingPerson\(\{ personId, name,/u);
  assert.ok(!screen.includes("saveRecipient({ name"), "adding must not go through the name path");

  const context = read(...APP, "family-context.tsx");
  assert.match(context, /\.rpc\("add_event_recipient", \{/u, "an existing person is LINKED to the event");
  const adder = context.slice(context.indexOf("const addExistingPerson"), context.indexOf("const saveRecipient"));
  assert.match(adder, /p_person_id: validPerson\.value/u);
  assert.match(adder, /p_christmas_recipient_id: recipientId/u,
    "the budget call carries a recipient id, so it takes its update path and creates nobody");
});

test("archived people leave the picker and stay in the history", () => {
  const screen = read(...APP, "people", "people-screen.tsx");
  assert.match(screen, /archived_at == null/u, "archived people are not offered for something new");
  assert.match(screen, /alreadyRecipientPersonIds\.includes/u, "nor is somebody already on the event");

  // The directory can still show them, and the profile still explains itself.
  const directory = read(...APP, "people", "people-directory-screen.tsx");
  assert.match(directory, /filter === "archived"/u);
  const profile = read(...APP, "people", "[id]", "person-profile-screen.tsx");
  assert.match(profile, /person\.archivedAt && \(/u);
  assert.match(profile, /everything already recorded for them is untouched/u);
});
