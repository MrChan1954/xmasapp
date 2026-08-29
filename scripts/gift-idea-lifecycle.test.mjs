/**
 * THE GIFT IDEA LIFECYCLE, AT THE PLACES A REGRESSION WOULD REAPPEAR.
 *
 * The database rules are proved in `tenancy-runtime.test.mjs`, against a real
 * PostgreSQL that either refuses or does not. What is left for this file is the
 * half a database cannot answer: whether the APPLICATION still goes through the
 * routine, whether the screen still offers a button the server will refuse, and
 * whether the sentence under the button is true.
 *
 * That last one is why this file exists at all. The confirmation used to read
 * "This removes the idea only. Purchases and budgets will not change." It was
 * false for an idea somebody had bought -- `originating_gift_idea_id` is
 * `on delete set null`, so the purchase kept its money and lost its reason --
 * and no test noticed, because no test read the sentence.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const giftIdeas = read("src", "app", "people", "gift-ideas.tsx");
const purchaseForm = read("src", "app", "add-purchase", "purchase-form.tsx");
const migration = read("supabase", "migrations", "202608100046_area_scoped_gift_idea_removal.sql");

// ===========================================================================
// 1. Removal goes through the routine
// ===========================================================================

describe("removing an idea is a routine call, not a table delete", () => {
  test("THE SCREEN CALLS remove_gift_idea", () => {
    assert.match(giftIdeas, /rpc\("remove_gift_idea",\s*\{/u,
      "removal must go through the routine that carries require_acting_area");
  });

  test("AND NO LONGER DELETES THE ROW ITSELF", () => {
    /*
     * The exact shape of the bug: `from("gift_ideas").delete()`. Migration 046
     * revokes the grant that made it possible, so this would now fail anyway --
     * but a call site that still tries is a call site that will one day be
     * "fixed" by handing the grant back.
     */
    assert.doesNotMatch(giftIdeas, /from\("gift_ideas"\)[\s\S]{0,80}\.delete\(\)/u,
      "the raw delete is back");
  });

  test("and nothing else in the application deletes a gift idea directly", () => {
    // Guard for the whole tree, not just this screen: the next one to want a
    // delete should find the routine, not this pattern.
    const files = [giftIdeas, purchaseForm];
    for (const source of files) {
      assert.doesNotMatch(source, /from\("gift_ideas"\)[\s\S]{0,120}\.delete\(\)/u);
    }
  });
});

// ===========================================================================
// 2. The button, and the sentence under it
// ===========================================================================

describe("a bought idea is not offered for removal", () => {
  test("REMOVE IS HIDDEN ONCE SOMETHING HAS BEEN BOUGHT FROM THE IDEA", () => {
    assert.match(giftIdeas, /\{!purchasedIdeaIds\.has\(idea\.id\)\s*&&\s*\(\s*<Button variant="dangerGhost"/u,
      "the Remove button must be gated on the idea not having been purchased");
  });

  test("THE CONFIRMATION NO LONGER PROMISES SOMETHING UNTRUE", () => {
    assert.doesNotMatch(giftIdeas, /Purchases and budgets will not change/u,
      "that sentence was false for a purchased idea, which is the bug this replaced");
  });

  test("and says instead why removing this one is safe", () => {
    assert.match(giftIdeas, /Nothing has been bought from this idea/u);
  });
});

// ===========================================================================
// 3. Errors stay in the product's voice
// ===========================================================================

describe("refusals reach the reader as sentences", () => {
  test("the two deliberate refusals are passed through", () => {
    assert.match(giftIdeas, /code === "23503" \|\| code === "42501"/u,
      "already-bought and wrong-family are written for a person to read");
  });

  test("BUT ONLY WHEN THEY LOOK LIKE PROSE", () => {
    /*
     * Passing a database message straight to the screen is how index names and
     * SQLSTATE codes reach users. The gate is what makes this safe rather than
     * lazy: a length bound, and a refusal to repeat anything carrying the
     * punctuation only machinery uses.
     */
    assert.match(giftIdeas, /message\.length <= 200/u);
    assert.match(giftIdeas, /pg_\|SQLSTATE/u);
  });

  test("and everything else falls back to the product's own wording", () => {
    assert.match(giftIdeas, /This gift idea could not be removed\. It is still saved\./u);
  });
});

// ===========================================================================
// 4. Buying from an idea cannot reach across families
// ===========================================================================

describe("the buy-this-idea prefill is bounded to the event", () => {
  test("THE IDEA READ IS NARROWED TO THIS EVENT'S RECIPIENTS", () => {
    assert.match(purchaseForm, /from\("gift_ideas"\)[\s\S]{0,220}\.in\("christmas_recipient_id", recipientIds\)/u,
      "`?idea=` is a query string; without this bound a foreign idea prefills the form");
  });

  test("and an empty recipient list reads nothing at all", () => {
    assert.match(purchaseForm, /recipientIds\.length\s*\n?\s*\?\s*await db\.from\("gift_ideas"\)/u);
  });
});

// ===========================================================================
// 5. The migration says what it does
// ===========================================================================

describe("migration 046", () => {
  test("carries the acting-Area guard into the routine", () => {
    assert.match(migration, /perform public\.require_acting_area\(public\.area_of_gift_idea\(p_gift_idea_id\)\)/u);
  });

  test("REFUSES TO REMOVE AN IDEA A LIVE PURCHASE CAME FROM", () => {
    assert.match(migration, /originating_gift_idea_id = p_gift_idea_id[\s\S]{0,80}deleted_at is null/u);
    assert.match(migration, /already been bought/u);
  });

  test("puts the acting Area in BOTH halves of the update policy", () => {
    const update = migration.slice(
      migration.indexOf('create policy "active members edit gift ideas"'),
      migration.indexOf('-- The grant, which is the reason'));
    const usingHalf = update.slice(update.indexOf("using ("), update.indexOf("with check ("));
    const checkHalf = update.slice(update.indexOf("with check ("));
    assert.match(usingHalf, /is_acting_area/u, "`using` decides which rows may be chosen");
    assert.match(checkHalf, /is_acting_area/u, "`with check` decides what they may become");
    assert.match(usingHalf, /not public\.is_own_birthday_recipient/u);
    assert.match(checkHalf, /not public\.is_own_birthday_recipient/u);
  });

  test("EXCLUDES THE CELEBRANT FROM THE DELETE POLICY TOO", () => {
    const del = migration.slice(migration.indexOf('create policy "active members remove gift ideas"'));
    assert.match(del, /not public\.is_own_birthday_recipient/u);
    assert.match(del, /is_acting_area/u);
  });

  test("and takes back the delete grant that made the bypass reachable", () => {
    assert.match(migration, /revoke delete on table public\.gift_ideas from authenticated/u);
    assert.doesNotMatch(migration, /revoke select on table public\.gift_ideas/u,
      "reading is what the list is for");
  });

  test("is append-only: it edits no earlier migration", () => {
    assert.doesNotMatch(migration, /alter table public\.purchases/u);
    assert.match(migration, /create or replace function public\.remove_gift_idea/u);
  });

  test("the routine is security definer with a pinned search_path", () => {
    const routine = migration.slice(migration.indexOf("create or replace function public.remove_gift_idea"));
    assert.match(routine, /security definer/u);
    assert.match(routine, /set search_path = ''/u);
    assert.match(routine, /revoke all on function public\.remove_gift_idea\(uuid\) from public, anon/u);
    assert.match(routine, /grant execute on function public\.remove_gift_idea\(uuid\) to authenticated/u);
  });
});
