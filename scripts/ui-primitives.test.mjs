/**
 * ONE GENERIC PRIMITIVE SYSTEM, HELD SHUT.
 *
 * `scripts/shadcn-ui.test.mjs` asks whether each primitive BEHAVES — what role
 * it has, what it is called, whether it traps focus. This file asks the
 * different question Q16 was about: whether a SECOND generic primitive system
 * has grown back beside it.
 *
 * That question is mostly about what the source is allowed to say, so most of
 * what follows reads files and matches patterns — the right tool for "no screen
 * may import Radix directly". Two of them render instead, because "the product
 * layer's `Select` is a real `<select>`" is a fact about the DOM and no regex
 * over `index.tsx` establishes it.
 *
 * WHY EACH RULE EXISTS, RATHER THAN JUST WHAT IT FORBIDS:
 *
 *   Radix stays behind the wrappers  A screen that imports Radix directly gets
 *     stock shadcn colours and skips the `accent` -> `elevated` rename, the
 *     44px touch targets and the 16px field text that stops iOS zooming. The
 *     wrapper is where all of that lives.
 *
 *   One focus manager             Q13 deleted the second one. A hand-written
 *     `role="dialog"` is the exact defect it closed: the markup claims a
 *     dialog's contract and then does not trap Tab.
 *
 *   One `Select`                  Until Q16 there were two things by that name
 *     — a native `<select>` in the product layer and an unused vendored Radix
 *     listbox — and only one of them was ever rendered.
 *
 * These rules are deliberately scoped to GENERIC primitives. Nothing here has
 * an opinion about product components: `FinancialProgressBar` computes budget
 * state and `BottomTabs` is information architecture, and neither is a shadcn
 * component wearing a disguise.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test, { describe, after } from "node:test";

import { React, render } from "./dom/harness.mjs";

const h = React.createElement;
const root = process.cwd();

// Line endings are normalised on the way in, for the reason the rest of the
// suite normalises them: git checks LF out as CRLF here.
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/gu, "\n");

/** Every `.ts`/`.tsx` file under `src/`, as absolute paths. */
function sourceFiles(dir = join(root, "src")) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const ALL = sourceFiles();
const rel = (path) => relative(root, path).split(sep).join("/");
const UI_DIR = "src/app/components/ui/";
const inRegistry = (path) => rel(path).startsWith(UI_DIR);

let mounted = [];
const show = async (element) => {
  for (const view of mounted) await view.unmount();
  mounted = [];
  const view = await render(element);
  mounted.push(view);
  return view;
};
after(async () => {
  for (const view of mounted) await view.unmount();
});

const ui = await import("../src/app/components/ui/index.tsx");

// ===========================================================================
// 1. Radix reaches the app only through the canonical wrappers
// ===========================================================================

describe("Radix stays behind components/ui", () => {
  test("no file outside components/ui imports Radix", () => {
    const offenders = ALL
      .filter((path) => !inRegistry(path))
      .filter((path) => /from\s+"(radix-ui|@radix-ui\/[^"]+)"/u.test(read(path)))
      .map(rel);

    assert.deepEqual(
      offenders,
      [],
      "Radix must be imported only inside components/ui, where the product's "
      + "tokens, 44px targets and 16px field text are applied to it.",
    );
  });

  test("the wrappers really are where Radix lives", () => {
    // The rule above is only meaningful if something passes it. If every Radix
    // import vanished, the assertion would still be green and would be
    // guarding nothing.
    const importers = ALL
      .filter((path) => /from\s+"(radix-ui|@radix-ui\/[^"]+)"/u.test(read(path)))
      .map(rel);

    assert.ok(
      importers.length >= 8,
      `expected the registry to import Radix in several files, found ${importers.length}`,
    );
    assert.ok(importers.every((path) => path.startsWith(UI_DIR)));
  });
});

// ===========================================================================
// 2. One focus manager, and it is Radix's
// ===========================================================================

describe("one modal focus mechanism", () => {
  test("only the registry-backed primitives declare a dialog", () => {
    // `role="dialog"` and `aria-modal` are a PROMISE that focus is trapped.
    // Q13's defect was markup that made the promise without keeping it, so the
    // attributes are allowed only where a Radix `Dialog.Content` is underneath:
    // `Modal`, `ConfirmDialog` and `Sheet` in the product layer.
    const offenders = ALL
      .filter((path) => rel(path) !== `${UI_DIR}index.tsx`)
      .filter((path) => {
        // Strip comments first: the notification bell EXPLAINS at length why it
        // is a Radix dialog, and prose about `aria-modal` is not markup.
        const code = read(path)
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .replace(/^\s*\/\/.*$/gmu, "");
        return /role="dialog"|aria-modal=/u.test(code);
      })
      .map(rel);

    assert.deepEqual(offenders, [], "a dialog's contract comes from Radix, not from hand-written ARIA");
  });

  test("no hand-rolled focus trap or Escape handler survives", () => {
    // A focus trap is a document/window keydown listener that inspects Tab; an
    // Escape handler is one that inspects "Escape". Radix provides both, so
    // neither should appear in application code. The command palette's Cmd-K
    // listener is the one legitimate global key handler and looks at neither.
    const offenders = [];
    for (const path of ALL) {
      const code = read(path)
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^\s*\/\/.*$/gmu, "");
      if (!/(document|window)\.addEventListener\(\s*"keydown"/u.test(code)) continue;
      if (/"Tab"|key === "Escape"|\.key\s*===\s*"Escape"/u.test(code)) offenders.push(rel(path));
    }

    assert.deepEqual(
      offenders,
      [],
      "Tab cycling and Escape belong to Radix; a second focus manager is a second thing to get wrong",
    );
  });

  test("the notification bell is still built on the shared Dialog", () => {
    // Q13 rebuilt it from a hand-rolled panel. This is the assertion that stops
    // it drifting back, and it is a stronger statement than "no custom trap":
    // it names the mechanism it must be using.
    const bell = read(join(root, "src/app/components/notification-bell.tsx"));
    assert.match(bell, /from\s+"\.\/ui\/dialog"/u, "the bell must import the shared Dialog");
    assert.doesNotMatch(bell, /createPortal|useMounted/u, "no second portal or mount-gate implementation");
  });
});

// ===========================================================================
// 3. `Select` means one thing
// ===========================================================================

describe("Select", () => {
  test("the product layer's Select renders a native <select>", async () => {
    const { container } = await show(
      h(ui.Select, { value: "a", onChange: () => {}, "aria-label": "Pick one" },
        h("option", { value: "a" }, "A")),
    );

    const control = container.querySelector("select");
    assert.ok(control, "Select must render a real <select>, not a button-and-listbox");
    assert.equal(control.tagName, "SELECT");
    // A Radix trigger is a <button>, and a button inside the <label> that
    // `Field` wraps is not a labelled control. That is the whole reason.
    assert.equal(container.querySelector("button"), null);
  });

  test("Select still works inside Field's wrapping label", async () => {
    const { container } = await show(
      h(ui.Field, { label: "Payer" },
        h(ui.Select, { value: "a", onChange: () => {} }, h("option", { value: "a" }, "A"))),
    );

    const label = container.querySelector("label");
    const control = container.querySelector("select");
    assert.ok(label && control, "expected a label wrapping a select");
    assert.ok(label.contains(control), "Field associates by WRAPPING; a select must sit inside it");
    assert.equal(control.labels?.[0], label, "implicit association must actually resolve");
  });

  test("the unused Radix Select is gone and nothing reaches for it", () => {
    assert.equal(
      existsSync(join(root, "src/app/components/ui/select.tsx")),
      false,
      "ui/select.tsx had no importer for four phases; Q16 deleted it",
    );

    const offenders = ALL
      .filter((path) => /from\s+"[^"]*ui\/select"|from\s+"\.\/select"/u.test(read(path)))
      .map(rel);
    assert.deepEqual(offenders, [], "nothing may import the deleted Radix Select");
  });
});

// ===========================================================================
// 4. The dead UI hook stays dead
// ===========================================================================

test("use-mounted.ts is gone and unimported", () => {
  assert.equal(
    existsSync(join(root, "src/app/components/use-mounted.ts")),
    false,
    "Q13 removed its last consumer; Q16 removed the file",
  );

  const offenders = ALL
    .filter((path) => /from\s+"[^"]*use-mounted"/u.test(read(path)))
    .map(rel);
  assert.deepEqual(offenders, [], "nothing may import the deleted useMounted hook");
});

// ===========================================================================
// 5. The raw-element census
// ===========================================================================

describe("raw elements stay where they are justified", () => {
  test("the only hand-written <button> is the one that cannot use a component", () => {
    // `global-error.tsx` renders when the app shell itself has crashed. It
    // cannot assume Tailwind loaded or that any component tree is mountable,
    // so it carries a bare <button> with inline styles — the one place where
    // "do not depend on the design system" is the requirement.
    const offenders = ALL
      .filter((path) => {
        const code = read(path)
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .replace(/^\s*\/\/.*$/gmu, "");
        return /<button[\s>]/u.test(code);
      })
      .map(rel);

    assert.deepEqual(offenders, ["src/app/global-error.tsx"]);
  });

  test("the only hand-written <select> is the primitive itself", () => {
    const offenders = ALL
      .filter((path) => {
        const code = read(path)
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .replace(/^\s*\/\/.*$/gmu, "");
        return /<select[\s>]/u.test(code);
      })
      .map(rel);

    assert.deepEqual(offenders, [`${UI_DIR}native-select.tsx`]);
  });
});

// ===========================================================================
// 6. One icon strategy
// ===========================================================================

describe("icons", () => {
  test("icons.tsx wraps lucide rather than redrawing it", () => {
    // Q14 reported "two icon systems". There is one: lucide-react. `icons.tsx`
    // is a NAMED CATALOGUE over it that fixes the app's defaults — 20px, 1.8
    // stroke, always aria-hidden — for the glyphs used across many screens.
    // The moment it starts carrying hand-drawn <svg> paths for something lucide
    // already has, that stops being true.
    const icons = read(join(root, "src/app/components/icons.tsx"));
    assert.match(icons, /from\s+"lucide-react"/u, "the catalogue must source its glyphs from lucide");
    assert.doesNotMatch(icons, /<svg/u, "no hand-drawn duplicate of a lucide glyph belongs here");
  });

  test("every lucide glyph in a screen is hidden from assistive technology", () => {
    // Icons in this app are always decorative: the control beside them carries
    // the accessible name. An unhidden glyph injects its component name into
    // that name, which is how a button starts being announced "Plus Add person".
    const offenders = [];
    for (const path of ALL) {
      const code = read(path);
      const imported = code.match(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/u);
      if (!imported) continue;

      const glyphs = imported[1]
        .split(",")
        .map((name) => name.trim())
        .filter((name) => /^[A-Z][A-Za-z0-9]*$/u.test(name));
      if (!glyphs.length) continue;

      const body = code.slice(imported.index + imported[0].length);
      for (const glyph of glyphs) {
        const uses = body.matchAll(new RegExp(`<${glyph}(\\s[^>]*)?/?>`, "gu"));
        for (const use of uses) {
          if (!/aria-hidden/u.test(use[0])) offenders.push(`${rel(path)}: ${use[0]}`);
        }
      }
    }

    assert.deepEqual(offenders, [], "a decorative icon must carry aria-hidden");
  });
});
