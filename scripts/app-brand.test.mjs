import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * ===========================================================================
 * THE APPLICATION'S OWN NAME
 * ===========================================================================
 *
 * The product is called `Gift Planner`. It has been called three other things
 * on the way here -- "Family Budget" on the desktop rail, "the Christmas app"
 * in two account messages, and "Family Gift Planner" everywhere else -- and the
 * reason those drifted apart is that no single place asserted what the name is.
 * A name is spelt out at each surface that shows it (a manifest cannot import a
 * constant, and neither can a static offline page), so the guard has to be a
 * scan rather than one equality check.
 *
 * WHAT IS DELIBERATELY NOT HERE. The family, the Areas, `Our family`, Christmas
 * as an EVENT, the Christmas tree ornament and the `christmas-budget`
 * notification tag are all domain vocabulary, not the product's name, and
 * renaming the product must leave every one of them alone.
 */

const root = process.cwd();
const BRAND = "Gift Planner";
const { default: manifest } = await import("../src/app/manifest.ts");
const { DEFAULT_PAGE_TITLE } = await import("../src/lib/navigation.ts");

const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

test("the installed app is called Gift Planner", () => {
  const value = manifest();
  assert.equal(value.name, BRAND);
  assert.equal(value.short_name, BRAND);
});

/**
 * A display name is not an identity. Android keys an installation on `id`, and
 * rotating it for a rename would offer a SECOND install beside the one already
 * on the family's phones instead of relabelling it.
 */
test("renaming did not disturb the installed app's identity", () => {
  const value = manifest();
  assert.equal(value.id, "/");
  assert.equal(value.start_url, "/");
  assert.equal(value.scope, "/");
  assert.equal(value.display, "standalone");
  assert.equal(value.theme_color, "#fbf8f3");
  assert.equal(value.background_color, "#fbf8f3");
});

test("the approved green artwork is still what the manifest points at", () => {
  const declared = manifest().icons.map((icon) => `${icon.src} ${icon.purpose}`);
  assert.deepEqual(declared.sort(), [
    "/icons/icon-192-v2.png any",
    "/icons/icon-512-v2.png any",
    "/icons/maskable-192-v2.png maskable",
    "/icons/maskable-512-v2.png maskable",
  ]);

  for (const icon of manifest().icons) {
    assert.ok(existsSync(join(root, "public", icon.src)), `${icon.src} is declared but missing`);
  }

  // The browser tab and the iOS Home Screen are generated from these three by
  // file convention rather than from the manifest, so they are checked apart.
  for (const file of ["favicon.ico", "icon.png", "apple-icon.png"]) {
    assert.ok(existsSync(join(root, "src", "app", file)), `src/app/${file} must stay committed`);
  }
});

test("the browser tab and the iOS Home Screen both say Gift Planner", () => {
  const layout = read("src", "app", "layout.tsx");
  assert.match(layout, /^\s*title: "Gift Planner",$/mu);
  // `appleWebApp.title` is what iOS writes under the Home Screen icon.
  assert.match(layout, /appleWebApp: \{\s*capable: true,\s*title: "Gift Planner",/u);
});

/**
 * The sticky bar names the SCREEN; the app's name is only the fallback for a
 * path no route claims. That convention is unchanged -- what changed is the
 * name it falls back to.
 */
test("the page-title fallback is the app's name and nothing else", () => {
  assert.equal(DEFAULT_PAGE_TITLE, BRAND);
});

test("a push with no readable payload is titled Gift Planner", () => {
  assert.match(read("public", "sw.js"), /: "Gift Planner";/u);
});

const RETIRED = ["Family Gift Planner", "Family gift planner", "Family Budget", "Christmas app"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".html", ".css"];

function* runtimeFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* runtimeFiles(path);
    else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) yield path;
  }
}

/**
 * Comments count. A retired name left in prose is how the next reader learns
 * the wrong one, and there is nowhere in the shipped source it has to survive:
 * the three comments that recorded an old sticky-bar defect now describe it as
 * "the application's own name", which is what the defect was actually about.
 */
test("NO RETIRED NAME SURVIVES ANYWHERE THE APP SHIPS", () => {
  const offenders = [];
  for (const dir of ["src", "public"]) {
    for (const file of runtimeFiles(join(root, dir))) {
      const source = readFileSync(file, "utf8");
      for (const name of RETIRED) {
        if (source.includes(name)) offenders.push(`${relative(root, file)} still says "${name}"`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
