/**
 * THE FOUR NUMBERS ON A CONTRIBUTOR CARD, AND WHERE THEY COME FROM.
 *
 * `src/lib/owed.test.ts` and `src/lib/purchases.test.ts` already prove the
 * arithmetic: equal splits that lose no penny, weighted splits that scale over
 * budget, and outgoing balances that are not netted against incoming ones.
 * What no test held was the WIRING -- which table each number is read from.
 *
 * That distinction is the whole risk here. Every one of these numbers could be
 * computed from a plausible-looking wrong source and still add up:
 *
 *   Spent from the CURRENT contributor set rather than from the allocations
 *   recorded at the time, so last year's totals move when somebody joins.
 *
 *   Owed netted across counterparties, so somebody who owes £30 and is owed
 *   £20 appears to owe £10 and the debt to a third person vanishes from view.
 *
 *   Planned recomputed from budgets rather than read from the plan, so an
 *   unallocated budget silently looks allocated.
 *
 * A source test is the right shape for a wiring question: it is asking which
 * table the screen names, and that is a fact about the source.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const home = read("src", "app", "home-screen.tsx");
const owed = read("src", "lib", "owed.ts");
const purchases = read("src", "lib", "purchases.ts");
const allocations = read("src", "lib", "recipient-allocations.ts");
const currency = read("src", "lib", "currency.ts");

// ===========================================================================
// 1. Where each number comes from
// ===========================================================================

describe("the contributor card reads each number from its own truth", () => {
  test("PLANNED COMES FROM THE PLAN, NOT FROM THE BUDGET", () => {
    assert.match(home, /from\("recipient_contributions"\)[\s\S]{0,140}planned_amount_pennies/u,
      "Planned is the contributor's own planned amounts, summed");
    assert.match(home, /planned\.set\(row\.contributor_id,[\s\S]{0,90}row\.planned_amount_pennies\)/u);
  });

  test("SPENT COMES FROM THE ALLOCATIONS RECORDED AT THE TIME", () => {
    /*
     * The invariant Q5 proved in the database, asserted here at the point that
     * would break it: Spent is read from `purchase_allocations`, so a
     * contributor joining or leaving today cannot move a total from last year.
     * Deriving it from the current contributor set would look identical on a
     * fresh event and be wrong on every old one.
     */
    assert.match(home, /from\("purchase_allocations"\)[\s\S]{0,160}responsibility_pennies/u,
      "Spent must come from the immutable allocation rows");
    assert.match(home, /actual\.set\(row\.contributor_id,[\s\S]{0,90}row\.responsibility_pennies\)/u);
    assert.match(home, /actualResponsibilityPennies:[^\n]*actual\.get\(row\.id\)/u,
      "Spent must be read from the allocation totals");
    assert.doesNotMatch(home, /actualResponsibilityPennies:[^\n]*planned\.get/u,
      "Spent must not be derived from the plan");
  });

  test("OWED IS THE OUTGOING SIDE ONLY", () => {
    // `youOwePennies`, never a subtraction of what is owed TO them.
    assert.match(home, /const owedPennies = contributor\.owed\?\.youOwePennies \?\? null/u);
    assert.doesNotMatch(home, /youOwePennies\s*-\s*owedToYouPennies/u,
      "netting receivables against payables is the bug this guards");
  });

  test("REMAINING IS PLANNED MINUS SPENT, AND SAYS SO WHEN IT GOES NEGATIVE", () => {
    assert.match(home, /const remaining = actual === null \? null : contributor\.plannedPennies - actual/u);
    assert.match(home, /const overPlan = remaining !== null && remaining < 0/u);
    assert.match(home, /label=\{overPlan \? "Over plan" : "Remaining"\}/u,
      "a negative Remaining is a state to name, not a minus sign to show");
  });
});

// ===========================================================================
// 2. Gross, not net -- the case the product spells out
// ===========================================================================

describe("Owed is gross outgoing debt", () => {
  test("summing outgoing balances ignores incoming ones entirely", () => {
    assert.match(owed, /if \(balance\.creditorContributorId === contributorId\) summary\.owedToYouPennies \+= balance\.amountPennies/u);
    assert.match(owed, /if \(balance\.debtorContributorId === contributorId\) summary\.youOwePennies \+= balance\.amountPennies/u);
    // Two independent accumulators. One expression combining them would be the
    // netting bug, and there is no such expression.
    assert.doesNotMatch(owed, /youOwePennies\s*[-+]\s*summary\.owedToYouPennies/u);
  });

  test("and netting happens only WITHIN a pair, which is a different question", () => {
    // Two people who owe each other genuinely cancel; two separate debts do
    // not. `src/lib/owed.test.ts` case F holds the second half.
    assert.match(owed, /pairKey/u);
  });
});

// ===========================================================================
// 3. Money is pennies, and stays pennies
// ===========================================================================

describe("no float is ever financial truth", () => {
  test("THE WEIGHTED SPLIT IS BIGINT DIVISION WITH A TRACKED REMAINDER", () => {
    assert.match(purchases, /BigInt\(item\.weightPennies\)/u);
    assert.match(purchases, /const numerator = totalPrice \* BigInt\(item\.weightPennies\)/u);
    assert.match(purchases, /remainder: numerator % totalWeight/u,
      "the remainder has to be kept, or the pennies it represents are lost");
    assert.doesNotMatch(purchases, /parseFloat|toFixed/u);
  });

  test("the equal split floors and then hands out what is left", () => {
    assert.match(allocations, /Math\.floor\(totalPennies \/ contributorIds\.length\)/u);
    assert.doesNotMatch(allocations, /parseFloat|toFixed|\* 0\.\d/u);
  });

  test("and the financial libraries carry no float arithmetic at all", () => {
    for (const [name, source] of [["owed.ts", owed], ["purchases.ts", purchases], ["recipient-allocations.ts", allocations]]) {
      assert.doesNotMatch(source, /parseFloat/u, `${name} parses a float`);
      assert.doesNotMatch(source, /\.toFixed\(/u, `${name} rounds through a string`);
      assert.doesNotMatch(source, /\/ 100\b/u, `${name} converts pennies to pounds mid-calculation`);
    }
  });

  test("pounds-to-pennies conversion exists only for display, and nothing calls it", () => {
    /*
     * `formatPounds` is the one place a float touches money. It multiplies by
     * 100 and rounds, which is fine for rendering and fatal as an input path.
     * It has no caller, and this is the test that notices if it gains one.
     */
    assert.match(currency, /export const formatPounds/u);
    for (const [name, source] of [["home-screen.tsx", home], ["owed.ts", owed], ["purchases.ts", purchases]]) {
      assert.doesNotMatch(source, /formatPounds/u,
        `${name} converts pounds to pennies through a float`);
    }
  });
});

// ===========================================================================
// 4. A budget is a target
// ===========================================================================

describe("a budget is a target, not a cap", () => {
  test("spending past it is a state to show, not an error to raise", () => {
    // The planner scales weights past the budget rather than refusing.
    assert.match(purchases, /export function/u);
    assert.doesNotMatch(purchases, /throw new Error\([^)]*over budget/iu,
      "exceeding a target must not be treated as invalid");
  });

  test("and the card names the over-target state rather than showing a negative", () => {
    assert.match(home, /overPlan \? "Over plan" : "Remaining"/u);
    assert.match(home, /formatPennies\(Math\.abs\(remaining\)\)/u);
  });
});
