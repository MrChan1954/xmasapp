/**
 * THE LINT GATE HAS TO BE HONEST, OR IT STOPS BEING READ.
 *
 * WHAT WENT WRONG. `opennextjs-cloudflare build` writes a bundled copy of the
 * whole application into `.open-next/` -- minified chunks, the Worker entry,
 * vendored `next` internals. Git ignores that directory. ESLint did not. So
 * `npm run lint` was clean on a fresh clone and, the moment anybody ran a
 * deploy build, reported 1,389 errors and 17,902 warnings across 290 generated
 * files. Found by running the lint gate after a real deploy.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. Nobody triages nineteen thousand problems
 * in code they did not write, so the gate gets skipped -- and the next real
 * error in `src/` is one line among them. A check that fails for reasons nobody
 * caused is worse than no check.
 *
 * IT IS RUN, NOT READ. These assertions ask the real ESLint, with the real
 * config, whether it would lint a path. A test that searched
 * `eslint.config.mjs` for a string would pass on a config that never loads.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ESLint } from "eslint";

import { ROOT } from "./pg/rehearsal.mjs";

const eslint = new ESLint({ cwd: ROOT });
const ignored = (relative) => eslint.isPathIgnored(join(ROOT, relative));

/** The directories this project's build scripts generate. */
const BUILD_OUTPUT = [
  // `next build`
  ".next/static/chunks/main.js",
  // `opennextjs-cloudflare build` -- the one that was missing
  ".open-next/worker.js",
  ".open-next/server-functions/default/handler.mjs",
  ".open-next/assets/_next/static/chunks/anything.js",
];

describe("ESLint does not lint the code the build wrote", () => {
  for (const path of BUILD_OUTPUT) {
    test(`${path} is ignored`, async () => {
      assert.equal(await ignored(path), true,
        `${path} is generated. Linting it reports thousands of problems nobody caused.`);
    });
  }

  test("AND THE PROJECT'S OWN SOURCE IS STILL LINTED, or this proves nothing", async () => {
    // A config that ignored everything would pass every assertion above.
    for (const path of [
      "src/lib/areas.ts",
      "src/app/components/account-menu.tsx",
      "src/utils/supabase/area-choice-client.ts",
      "eslint.config.mjs",
    ]) {
      assert.equal(await ignored(path), false, `${path} must still be linted`);
    }
  });

  test("THE IGNORE IS THE DIRECTORY, NOT THE NAME", async () => {
    /*
     * The near miss worth pinning. `open-next.config.ts` is REAL, hand-written
     * source and it sits at the repository root, one character away from the
     * generated directory. A looser pattern -- `**\/open-next*`, or an
     * unanchored `open-next` -- would silently stop linting the file that
     * configures the deployment, which is the last file anybody would want
     * unchecked.
     */
    for (const path of ["open-next.config.ts", "open-next-decoy.ts", "src/open-next-decoy.ts"]) {
      assert.equal(await ignored(path), false, `${path} is source, not build output`);
    }
  });

  test("every build directory git ignores, ESLint ignores too", async () => {
    /*
     * The rule the miss broke. `.open-next/` was in `.gitignore` from the day
     * the Cloudflare adapter arrived -- the repo knew it was generated. Only
     * the lint config did not.
     */
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8").replace(/\r\n/gu, "\n");
    const generated = [".next", ".open-next", "out", "build"]
      .filter((dir) => new RegExp(`^/?${dir.replace(".", "\\.")}/?$`, "mu").test(gitignore));

    assert.ok(generated.includes(".open-next"),
      "the Cloudflare build output must be git-ignored, or this test is checking the wrong thing");

    for (const dir of generated) {
      assert.equal(await ignored(`${dir}/generated-file.js`), true,
        `${dir} is git-ignored as build output, so ESLint must ignore it as well`);
    }
  });
});
