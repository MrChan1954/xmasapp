/**
 * THE QA SAFETY LAYER MUST NOT BECOME PART OF THE PRODUCT.
 *
 * The danger in a same-database QA strategy is not only "QA writes to the real
 * Area". It is the quieter one: the protected id leaking out of the QA tooling
 * and into the application, where it would become a second, private
 * authorization rule that RLS knows nothing about. A product that behaves
 * differently for one hard-coded Area is a product whose security can no longer
 * be read off its policies.
 *
 * So the boundary is asserted from both sides:
 *
 *   THE PRODUCT DOES NOT IMPORT THE GUARD. It cannot call it, so it cannot come
 *   to depend on it.
 *
 *   THE PRODUCT HARD-CODES NO IDS AT ALL. Not the real Area's, not any. The
 *   sweep is absolute rather than a search for the one id that matters, because
 *   "no ids in the product" is a rule somebody can keep, and "no THAT id" is
 *   one they will paste past.
 *
 *   THE FILE NAMING THE REAL AREA IS NEVER COMMITTED.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../pg/rehearsal.mjs";
import { CONFIG_PATH } from "./protected.mjs";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;

/** Every product source file: `src`, excluding its own tests. */
function productFiles() {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name)) found.push(next);
    }
  };
  walk("src");
  return found;
}

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

describe("the QA guard is tooling, never product behaviour", () => {
  test("no product file imports the QA safety layer", () => {
    const offenders = productFiles().filter((file) => {
      const source = read(file);
      return source.includes("scripts/qa") || source.includes("qa/protected");
    });
    assert.deepEqual(offenders, [],
      "QA tooling in the product would be a private authorization rule RLS cannot see");
  });

  test("THE PRODUCT HARD-CODES NO AREA, EVENT, PERSON OR MEMBERSHIP ID", () => {
    /*
     * An absolute rule, deliberately. The thing actually being prevented is the
     * real Area id appearing in runtime authorization; a sweep for that one id
     * would pass on the day somebody pastes a different one in.
     */
    const offenders = [];
    for (const file of productFiles()) {
      for (const found of read(file).matchAll(UUID)) {
        offenders.push(`${file}: ${found[0]}`);
      }
    }
    assert.deepEqual(offenders, [],
      "the product must derive every id from the request or the database, never carry one");
  });

  test("and no migration carries one either", () => {
    const offenders = [];
    for (const name of readdirSync(join(ROOT, "supabase", "migrations"))) {
      if (!name.endsWith(".sql")) continue;
      const sql = readFileSync(join(ROOT, "supabase", "migrations", name), "utf8");
      for (const found of sql.matchAll(UUID)) {
        // All-zero and all-same ids are placeholders in comments and examples,
        // not references to anybody's real row.
        if (/^(.)\1{7}-/u.test(found[0]) || found[0].startsWith("00000000-")) continue;
        offenders.push(`${name}: ${found[0]}`);
      }
    }
    assert.deepEqual(offenders, [], "a migration naming a real row would be data, not schema");
  });
});

describe("the file that names the real family is never committed", () => {
  test("git ignores it", () => {
    // Asked of git itself rather than by reading .gitignore, because what
    // matters is the answer git gives, not the rule somebody meant to write.
    const output = execFileSync("git", ["check-ignore", "-v", ".qa-areas.local.json"], {
      cwd: ROOT, encoding: "utf8",
    });
    assert.match(output, /\.qa-areas\.local\.json/u);
  });

  test("and it is not in the index", () => {
    const tracked = execFileSync("git", ["ls-files", ".qa-areas.local.json"], {
      cwd: ROOT, encoding: "utf8",
    });
    assert.equal(tracked.trim(), "", "the real family's Area id must never be committed");
  });

  test("the committed example carries only placeholder ids", () => {
    const example = read("scripts/qa/areas.example.json");
    for (const found of example.matchAll(UUID)) {
      assert.match(found[0], /^00000000-/u, `the example must not carry a real id: ${found[0]}`);
    }
  });
});

describe("if this machine has the real config, nothing else has copied it", () => {
  test("no protected id appears anywhere in the committed tree", (t) => {
    if (!existsSync(CONFIG_PATH)) {
      t.skip("no local QA config on this machine -- nothing to check against");
      return;
    }
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const secrets = [...(parsed.protectedAreaIds ?? []), ...(parsed.protectedEventIds ?? [])]
      .map((id) => String(id).toLowerCase());
    assert.ok(secrets.length > 0, "the config must name what it protects");

    const searched = [
      ...productFiles(),
      ...readdirSync(join(ROOT, "scripts")).filter((n) => n.endsWith(".mjs")).map((n) => `scripts/${n}`),
      ...readdirSync(join(ROOT, "scripts", "qa")).map((n) => `scripts/qa/${n}`),
      ...readdirSync(join(ROOT, "docs")).filter((n) => n.endsWith(".sql")).map((n) => `docs/${n}`),
    ];

    const offenders = [];
    for (const file of searched) {
      const source = read(file).toLowerCase();
      for (const secret of secrets) {
        if (source.includes(secret)) offenders.push(file);
      }
    }
    assert.deepEqual([...new Set(offenders)], [],
      "the protected ids belong in the un-committed config and nowhere else");
  });
});
