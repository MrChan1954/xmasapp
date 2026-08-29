/**
 * THE PRE-HYDRATION THEME SCRIPT MUST SURVIVE BUNDLING.
 *
 * `next-themes` does not ship its bootstrap as a string. It takes a real
 * function and serialises it at render time:
 *
 *     <script>{`(${script.toString()})(${args})`}</script>
 *
 * That makes the script uniquely fragile, in a way no other client code is: a
 * bundler transform that rewrites the function's BODY travels into an inline
 * <script> that has none of the bundle's scope around it.
 *
 * WHAT SHIPPED. `wrangler deploy` bundles the Worker with esbuild, and wrangler
 * defaults `keep_names` to true. esbuild implements that by emitting a helper
 * call after each function declaration:
 *
 *     function k2(theme) { ... }
 *     __name(k2, "k2");
 *
 * `__name` is defined once at module scope, so the Worker itself is fine. The
 * serialised copy is not: every page load threw
 * `ReferenceError: __name is not defined`, the bootstrap never ran, and the
 * stored theme was only applied once React hydrated. Found in Q6 live QA on
 * 2026-08-29 and fixed by setting `keep_names: false` in `wrangler.jsonc`.
 *
 * WHAT THIS FILE DOES. It does not read the source and look for a string. It
 * takes the bootstrap function as the installed `next-themes` actually defines
 * it, puts it through esbuild the way the deploy does, serialises it exactly as
 * next-themes does, and EXECUTES the result in a fresh V8 context with a DOM
 * stub. A transform that breaks the script fails these tests.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

/**
 * The bootstrap function, lifted out of the installed package rather than
 * copied here -- a copy would keep passing after an upgrade changed the real
 * one. Found by its one unmistakable landmark and then brace-matched.
 */
function bootstrapSource() {
  const dist = read("node_modules", "next-themes", "dist", "index.mjs");
  const landmark = dist.indexOf("document.documentElement");
  assert.ok(landmark > 0, "next-themes no longer contains a documentElement bootstrap");

  // Walk back to the `=>{` that opens the function containing the landmark.
  const arrow = dist.lastIndexOf("=>{", landmark);
  assert.ok(arrow > 0, "could not find the arrow that opens the bootstrap");
  // ...and back again over its parameter list, to the `(`.
  const params = dist.lastIndexOf("(", arrow);
  assert.ok(params > 0, "could not find the bootstrap's parameter list");

  // Brace-match forward from the body's opening `{`.
  const open = arrow + 2;
  let depth = 0;
  let end = -1;
  for (let i = open; i < dist.length; i += 1) {
    if (dist[i] === "{") depth += 1;
    else if (dist[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > open, "the bootstrap function is unbalanced");
  return dist.slice(params, end + 1);
}

/**
 * Put the function through esbuild the way a deploy does, then serialise it the
 * way next-themes does.
 *
 * The bundle is EXECUTED and `.toString()` called on the real function, rather
 * than the text being sliced apart. That is precisely what happens on the
 * server at render time, so whatever comes back here is what the browser gets.
 */
async function serialise(source, keepNames) {
  const built = await esbuild.build({
    stdin: { contents: `export const script = ${source};`, loader: "js" },
    bundle: true, write: false, format: "iife", globalName: "mod", keepNames, minify: false,
  });
  const bundleScope = {};
  vm.createContext(bundleScope);
  new vm.Script(built.outputFiles[0].text).runInContext(bundleScope);
  assert.equal(typeof bundleScope.mod.script, "function",
    "the bundle did not produce a bootstrap function");
  return bundleScope.mod.script.toString();
}

/**
 * Run the serialised text with nothing around it -- which is the whole point.
 * A fresh context has none of the bundle's scope, so an injected helper call is
 * a ReferenceError here exactly as it is in an inline <script>.
 */
function runSerialised(fnSource, { prefersDark = false, stored = null, forced = null } = {}) {
  const el = {
    className: "",
    attributes: {},
    style: {},
    classList: {
      _set: new Set(),
      add(...c) { for (const x of c) this._set.add(x); el.className = [...this._set].join(" "); },
      remove(...c) { for (const x of c) this._set.delete(x); el.className = [...this._set].join(" "); },
    },
    setAttribute(name, value) { el.attributes[name] = value; },
  };

  const sandbox = {
    document: { documentElement: el },
    window: { matchMedia: (q) => ({ matches: /dark/u.test(q) ? prefersDark : !prefersDark }) },
    localStorage: { getItem: () => stored },
  };

  // The eight arguments the application actually passes, read off the live
  // document: attribute, storageKey, defaultTheme, forcedTheme, themes,
  // themesMap, enableSystem, enableColorScheme.
  const args = `("class","xmas-theme-system","system",${JSON.stringify(forced)},["light","dark"],null,true,true)`;
  const inline = `(${fnSource})${args}`;

  vm.createContext(sandbox);
  new vm.Script(inline).runInContext(sandbox);
  return el;
}

let clean;
let kept;

describe("the theme bootstrap survives the transform the deploy applies", () => {
  before(async () => {
    const source = bootstrapSource();
    clean = await serialise(source, false);
    kept = await serialise(source, true);
  });

  test("THE HARNESS CATCHES THE BUG THAT SHIPPED", () => {
    /*
     * The sensitivity check. Built with `keepNames: true` -- which is what
     * wrangler did by default -- the serialised script must fail here, or this
     * whole file is testing nothing. If a future esbuild stops injecting the
     * helper the guard is simply no longer needed, so that case is allowed.
     */
    if (!/__name\(/u.test(kept)) {
      console.log("    note: this esbuild no longer injects a keepNames helper");
      return;
    }
    assert.throws(() => runSerialised(kept), /__name is not defined/u,
      "a keepNames build must break the serialised bootstrap -- if it does not, "
      + "this harness would not have caught the defect found in Q6");
  });

  test("the shipped bootstrap contains no bundler helper call at all", () => {
    assert.ok(!/__name\(/u.test(clean),
      "the bootstrap carries an esbuild keepNames helper into the browser");
    assert.ok(!/__publicField|__defProp\(/u.test(clean),
      "the bootstrap carries some other bundler helper into the browser");
  });

  test("it runs, and applies dark when the system prefers dark", () => {
    const el = runSerialised(clean, { prefersDark: true });
    assert.equal(el.className, "dark");
    assert.equal(el.style.colorScheme, "dark");
  });

  test("it runs, and applies light when the system prefers light", () => {
    const el = runSerialised(clean, { prefersDark: false });
    assert.equal(el.className, "light");
    assert.equal(el.style.colorScheme, "light");
  });

  test("a stored choice beats the system preference", () => {
    // The setting the user actually made must win before first paint, which is
    // the entire reason this script is inlined ahead of hydration.
    const el = runSerialised(clean, { prefersDark: true, stored: "light" });
    assert.equal(el.className, "light");
    assert.equal(el.style.colorScheme, "light");
  });

  test("and it writes only the class and the colour scheme", () => {
    // Anything else on <html> before hydration is a hydration mismatch waiting
    // to happen: React renders <html> with no such attribute.
    const el = runSerialised(clean, { prefersDark: true });
    assert.deepEqual(Object.keys(el.attributes), [],
      `the bootstrap set unexpected attributes: ${JSON.stringify(el.attributes)}`);
    assert.deepEqual(Object.keys(el.style), ["colorScheme"]);
  });
});

describe("the build pipeline keeps it that way", () => {
  test("wrangler is told not to keep function names", () => {
    /*
     * The one-line guard. Without it wrangler's default puts the helper back on
     * the next deploy, and nothing else in the repository would notice.
     */
    const config = read("wrangler.jsonc");
    assert.match(config, /"keep_names"\s*:\s*false/u,
      "wrangler.jsonc must set keep_names:false, or the deploy re-breaks the "
      + "inlined theme script");
    assert.match(config, /next-themes/u,
      "the setting must say why it is there, or somebody will helpfully remove it");
  });

  test("A REAL WRANGLER BUNDLE, IF ONE HAS BEEN BUILT, CARRIES NO HELPER", () => {
    /*
     * The production-output assertion. `.open-next/worker.js` is OpenNext's
     * output and was always clean -- the helper was added by the wrangler pass
     * downstream of it, so only wrangler's own bundle proves anything.
     *
     *     npm run check:worker-bundle
     */
    const bundle = join(ROOT, ".open-next", ".worker-check", "worker.js");
    if (!existsSync(bundle)) {
      console.log("    skipped: run `npm run check:worker-bundle` to produce the bundle");
      return;
    }
    const text = readFileSync(bundle, "utf8");
    const helpers = text.match(/__name\(/gu) ?? [];
    assert.equal(helpers.length, 0,
      `the deployable Worker bundle contains ${helpers.length} keepNames helper calls; `
      + "any function serialised to the browser will reference an undefined __name");
  });
});
