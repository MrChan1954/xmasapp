/**
 * THE GATE HAS TO REPORT ITSELF HONESTLY, OR IT STOPS BEING READ.
 *
 * `scripts/mutation-check.mjs` breaks the code on purpose and reports whether
 * the tests noticed. Its exit code and its survivor list were always right.
 * Its SUMMARY LINE was not: it counted catches against every mutation declared
 * in the file rather than against the ones that had actually run, so
 *
 *     node scripts/mutation-check.mjs Q4
 *
 * ran seventeen mutations, caught all seventeen, and printed
 * "17/78 mutations caught." -- a sentence that says sixty-one holes were found
 * in the test suite. Nobody who read that would trust the next line of it.
 *
 * WHY THE FUNCTION AND NOT THE SCRIPT. The runner mutates the working tree on
 * import: there is no way to ask it a question without it starting to edit
 * files. So the sentence lives in `scripts/mutation-summary.mjs`, which has no
 * side effects, and is asked here directly. These are real calls with real
 * return values -- not a regular expression looking for `selected.length` in
 * somebody's source.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { summariseMutationRun } from "./mutation-summary.mjs";

describe("a mutation run counts what it ran", () => {
  test("THE REGRESSION ITSELF: a filtered run does not count against the whole file", () => {
    const line = summariseMutationRun({ caught: 17, selectedCount: 17, totalCount: 78, filter: "Q4" });

    assert.match(line, /^17\/17 /u,
      "seventeen of seventeen ran and were caught; 17/78 says sixty-one survived");
    assert.ok(!line.startsWith("17/78"), "this is the exact sentence that shipped wrong");
  });

  test("and it says it was filtered, so 17/17 cannot be read as the whole gate", () => {
    const line = summariseMutationRun({ caught: 17, selectedCount: 17, totalCount: 78, filter: "Q4" });
    assert.match(line, /filtered to "Q4"/u, "which family of mutations ran");
    assert.match(line, /78 exist in total/u, "and how many there are, so the scope is legible");
  });

  test("an unfiltered run is the plain sentence, with no scope note to explain away", () => {
    const line = summariseMutationRun({ caught: 78, selectedCount: 78, totalCount: 78, filter: "" });
    assert.equal(line, "78/78 mutations caught.");
  });

  test("A SURVIVOR IS STILL VISIBLE IN A FILTERED RUN", () => {
    /*
     * The failure the wrong denominator could have hidden in the other
     * direction: if the number were ever pinned to the count that ran, a real
     * survivor must still make the two figures differ. 16/17 is a hole in the
     * tests and has to read as one.
     */
    const line = summariseMutationRun({ caught: 16, selectedCount: 17, totalCount: 78, filter: "Q4" });
    assert.match(line, /^16\/17 /u, "one mutation survived and the line must show it");
  });

  test("a single-mutation run reads correctly rather than as 1 of everything", () => {
    const line = summariseMutationRun({ caught: 1, selectedCount: 1, totalCount: 78, filter: "Q4-4" });
    assert.match(line, /^1\/1 /u);
  });
});
