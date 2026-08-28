/**
 * THE SENTENCE A PERSON READS AT THE END OF A MUTATION RUN.
 *
 * WHY THIS IS ITS OWN MODULE. It used to be a template string inside the
 * runner, counted against every mutation declared in the file rather than
 * against the ones that actually ran. So `node scripts/mutation-check.mjs Q4`
 * ran seventeen mutations, caught all seventeen, and reported
 *
 *     17/78 mutations caught.
 *
 * which says sixty-one survived. The exit code and the survivor list were
 * correct throughout -- the only broken thing was the line anybody reads. A
 * gate that reports a false catastrophe gets ignored the same way a gate that
 * reports a false success does.
 *
 * It lives here, rather than in the runner, so it can be tested without
 * importing a module whose top level mutates the working tree. The runner has
 * one job and does it on import; this has none and can be asked questions.
 */

/**
 * @param {object} run
 * @param {number} run.caught          how many mutations a suite failed on
 * @param {number} run.selectedCount   how many mutations actually ran
 * @param {number} run.totalCount      how many mutations exist in the file
 * @param {string} run.filter          the name prefix that was run, or ""
 * @returns {string} the summary line, without its trailing newline
 */
export function summariseMutationRun({ caught, selectedCount, totalCount, filter }) {
  // A FILTERED RUN SAYS SO. "17/17 mutations caught" on its own is
  // indistinguishable from the whole gate having passed, and somebody reading a
  // log after the fact has no other way to tell the difference.
  const scope = filter
    ? ` (filtered to "${filter}"; ${totalCount} exist in total)`
    : "";
  return `${caught}/${selectedCount} mutations caught${scope}.`;
}
