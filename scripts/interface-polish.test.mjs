/**
 * THE FOUR POLISH DEFECTS Q13 CLOSED, EACH PINNED SO IT CANNOT COME BACK.
 *
 * None of these was a suspicion. All four were carried forward as known,
 * recorded limitations for several phases:
 *
 *   1. the Notification Centre announced `role="dialog"` and then let Tab walk
 *      straight out of it into the page behind the scrim;
 *   2. the top bar's breadcrumb was about 16px tall -- under WCAG 2.2's 24px
 *      floor, and well under the 44px this product uses everywhere else;
 *   3. `/people/<id>` went h1 then h3, so a screen reader's heading list lost a
 *      level with nothing in it;
 *   4. user-facing copy spelled the same pause two ways, `...` and `…`.
 *
 * The first is proven by RENDERING, because a focus trap is behaviour and no
 * amount of reading the source establishes it -- the version this replaced
 * looked entirely correct and trapped nothing. The rest are proven by reading,
 * because they are facts about a stylesheet, about markup levels and about
 * copy, and jsdom has no viewport to measure a 44px box in. Their live
 * counterparts are the browser QA that runs against `xmas-family.uk`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe, after } from "node:test";

import { React, accessibleName, act, allByRole, byRole, click, queryByRole, render } from "./dom/harness.mjs";

const h = React.createElement;

const root = process.cwd();
// Line endings are normalised on the way in, for the reason the rest of the
// suite normalises them: git checks LF out as CRLF here.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");

// ===========================================================================
// 1. The Notification Centre traps focus
// ===========================================================================

/**
 * The inbox reaches the network through `fetch` and Realtime through the
 * Supabase client, and both are already stubbed for this suite -- the client by
 * the module hook, `fetch` here, because it is a global rather than an import.
 */
const INBOX = {
  unreadCount: 2,
  notifications: [
    {
      id: "n1",
      category: "purchases",
      title: "A present was recorded",
      body: "Something for the shelf",
      targetUrl: "/events/e1",
      readAt: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "n2",
      category: "money_i_owe",
      title: "You owe for a shared present",
      body: "£12.50",
      targetUrl: "/owed",
      readAt: null,
      createdAt: new Date().toISOString(),
    },
  ],
};

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;

globalThis.fetch = async () => ({
  ok: true,
  json: async () => INBOX,
});

/** Choose which of the bell's two shapes gets built, before it is rendered. */
function setViewport(wide) {
  window.matchMedia = (query) => ({
    matches: wide,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}

const { NotificationBell } = await import("../src/app/components/notification-bell.tsx");
const { NotificationInboxProvider } = await import("../src/app/components/use-notification-inbox.ts");

let mounted = [];

/**
 * A bell, with somewhere outside it for focus to escape TO.
 *
 * The two bare buttons are the whole point of the fixture: a trap that is only
 * asserted against an empty page proves nothing, because there is nowhere else
 * for focus to go.
 */
const showBell = async ({ wide }) => {
  for (const view of mounted) await view.unmount();
  mounted = [];
  setViewport(wide);
  const view = await render(
    h(
      "div",
      null,
      h("button", { type: "button" }, "Before"),
      h(NotificationInboxProvider, null, h(NotificationBell)),
      h("button", { type: "button" }, "After"),
    ),
  );
  mounted.push(view);
  // The first inbox load is deferred by a tick on purpose, so the bell never
  // delays the page it sits above. Let it land before asserting on counts.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
  return view;
};

after(async () => {
  for (const view of mounted) await view.unmount();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
});

const pressTab = async (target, { shift = false } = {}) => {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Tab", shiftKey: shift, bubbles: true, cancelable: true,
    }));
  });
};

const openBell = async (view) => {
  const trigger = byRole(view.container, "button", "Notifications");
  await click(trigger);
  const dialog = byRole(document.body, "dialog");
  return { trigger, dialog };
};

for (const wide of [false, true]) {
  const shape = wide ? "the desktop dropdown" : "the phone sheet";

  describe(`Notification Centre — ${shape}`, () => {
    test("IT IS A DIALOG, NAMED BY THE HEADING IT ALREADY DREW", async () => {
      const view = await showBell({ wide });
      assert.equal(queryByRole(document.body, "dialog"), null, "nothing is open to begin with");

      const { dialog } = await openBell(view);
      assert.equal(dialog.getAttribute("aria-modal"), "true",
        "a panel that says dialog owes the page modality");
      assert.equal(accessibleName(dialog), "Notifications",
        "the visible heading is the name, not a second invisible one");
    });

    test("OPENING IT MOVES FOCUS INTO IT", async () => {
      const view = await showBell({ wide });
      const { dialog } = await openBell(view);
      assert.ok(dialog.contains(document.activeElement),
        "focus stayed outside the dialog, so a keyboard user never reached the list");
    });

    test("TAB DOES NOT LEAVE IT", async () => {
      const view = await showBell({ wide });
      const { dialog } = await openBell(view);

      const inside = allByRole(dialog, "button");
      assert.ok(inside.length >= 2, "the fixture needs more than one stop to prove a cycle");
      const first = inside[0];
      const last = inside[inside.length - 1];

      // Forwards off the end wraps to the beginning...
      await act(async () => { last.focus(); });
      await pressTab(last);
      assert.equal(document.activeElement, first,
        "Tab off the last control left the dialog instead of cycling");

      // ...and backwards off the beginning wraps to the end.
      await act(async () => { first.focus(); });
      await pressTab(first, { shift: true });
      assert.equal(document.activeElement, last,
        "Shift+Tab off the first control left the dialog instead of cycling");
    });

    test("FOCUS SENT OUTSIDE IS BROUGHT BACK", async () => {
      const view = await showBell({ wide });
      const { dialog } = await openBell(view);

      // Whatever moved it -- a stray script, a browser find bar, the address
      // bar handing focus back to the document -- an open modal dialog takes it
      // back. This is the assertion the old implementation could not pass.
      const outside = byRole(view.container, "button", "After");
      await act(async () => { outside.focus(); });
      assert.ok(dialog.contains(document.activeElement),
        "focus escaped to the page behind an open dialog");
    });

    test("ESCAPE CLOSES IT AND GIVES THE BELL ITS FOCUS BACK", async () => {
      const view = await showBell({ wide });
      const { trigger, dialog } = await openBell(view);

      await act(async () => {
        dialog.dispatchEvent(new window.KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true,
        }));
      });
      // Radix restores focus on its own timer as the panel unmounts.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });

      assert.equal(queryByRole(document.body, "dialog"), null, "Escape must close it");
      assert.equal(document.activeElement, trigger,
        "focus was dropped on the body instead of returned to the bell");
    });
  });
}

test("the phone sheet is portalled out of the header, the dropdown is not", async () => {
  const phone = await showBell({ wide: false });
  const { trigger: bell, dialog: sheet } = await openBell(phone);
  assert.ok(!bell.parentElement.contains(sheet),
    "the sheet must escape the header's backdrop-filter containing block");

  const desktop = await showBell({ wide: true });
  const { trigger, dialog: dropdown } = await openBell(desktop);
  assert.ok(trigger.parentElement.contains(dropdown),
    "the dropdown is `absolute` and must stay inside the trigger's own wrapper");
});

// ===========================================================================
// 2. The breadcrumb's hit area
// ===========================================================================

describe("Top bar breadcrumb", () => {
  const css = read("src", "app", "globals.css");
  const topBar = read("src", "app", "components", "top-bar.tsx");

  test("THE TARGET IS 44px, AND THE TYPE IS STILL SMALL", () => {
    const rule = css.slice(css.indexOf(".touch-target::after"), css.indexOf(".burst-speck"));
    assert.match(rule, /height:\s*44px/);
    assert.match(rule, /min-width:\s*44px/);
    assert.match(rule, /position:\s*absolute/,
      "the extra area must not take part in layout, or the bar grows");
    assert.match(css, /\.touch-target \{\s*\n\s*position: relative;/,
      "the pseudo-element needs a containing block to be centred on");

    // From the breadcrumb's own opening brace to the next `</Link>` AFTER it --
    // the home mark above it is a Link too, and slicing from the first one
    // would hand this assertion an empty string that matches nothing and
    // therefore fails for the wrong reason.
    const breadcrumbAt = topBar.indexOf("{parent && (");
    const breadcrumb = topBar.slice(breadcrumbAt, topBar.indexOf("</Link>", breadcrumbAt));
    assert.match(breadcrumb, /className="touch-target /);
    assert.match(breadcrumb, /text-xs/, "the visible label stays quiet; only the target grew");
  });
});

// ===========================================================================
// 3. The person page's heading outline
// ===========================================================================

describe("Person detail headings", () => {
  const panel = read("src", "app", "people", "[id]", "person-admin-panel.tsx");
  const screen = read("src", "app", "people", "[id]", "person-profile-screen.tsx");

  test("NO LEVEL IS SKIPPED UNDER THE PAGE'S h1", () => {
    // `PageHeader` draws the only h1 on the page.
    const shell = read("src", "app", "components", "app-shell.tsx");
    assert.equal((shell.match(/<h1/g) ?? []).length, 1);

    // The admin cards are the first sections under it, so they are h2. They were
    // h3, which is the whole defect: h1 -> h3, with no h2 in between.
    assert.match(panel, /<h2 className="font-display text-lg font-semibold text-ink-900">\{title\}<\/h2>/);
    assert.doesNotMatch(panel, /<h3/, "nothing in this file may sit at a level with no parent");

    // Everything the screen itself draws, in document order, must step by at
    // most one. h2 sections, h3 groups inside them, h4 event cards inside those.
    const levels = [...screen.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
    assert.deepEqual([...new Set(levels)].sort(), [2, 3, 4]);
    let previous = 1; // the h1 from PageHeader, above all of these
    for (const level of levels) {
      assert.ok(level <= previous + 1, `h${previous} is followed by h${level}, skipping a level`);
      previous = level;
    }
  });

  test("THE LEVEL IS CHOSEN BY POSITION AND THE SIZE BY CSS", () => {
    // The reason the fix is safe: the card heading kept `text-lg`, so promoting
    // it changed the outline and not the design. A heading level picked for its
    // default size is how the skip got there in the first place.
    assert.match(panel, /<h2 className="font-display text-lg/);
  });
});

// ===========================================================================
// 4. One ellipsis, spelled one way
// ===========================================================================

/**
 * Every `.ts`/`.tsx` under `src`, except the tests -- a test fixture is allowed
 * to carry an abbreviated copy of somebody else's error message.
 */
function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * The file with its comments removed.
 *
 * Crude on purpose: a line whose first non-space characters open or continue a
 * comment is dropped whole. That is enough, because the `...` this rule is NOT
 * about -- an abbreviated SQL statement, an elided route, a quoted database
 * error, a spread written out in prose -- all live in JSDoc blocks, and none of
 * this repository's comments trail a line of code that also contains a string.
 * A real parser would be the wrong trade here: it would be a second thing that
 * can be wrong, in service of a rule about punctuation.
 */
const withoutComments = (source) => source
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join("\n");

describe("User-facing copy", () => {
  test("THE ELLIPSIS IS ALWAYS `…`, NEVER THREE FULL STOPS", () => {
    /*
     * The app said "Saving..." on one screen and "Saving…" on the next -- the
     * same word, the same wait, two different characters. This is not a
     * blanket ban on three dots: a spread, a range in a comment and an elided
     * error message are all still spelled `...`, and none of them is prose.
     * What is checked is the two places a reader actually sees: the inside of
     * a double-quoted string, and JSX text between two tags.
     */
    const offenders = [];
    for (const file of sourceFiles(join(root, "src"))) {
      const source = withoutComments(readFileSync(file, "utf8").replace(/\r\n/gu, "\n"));
      const relative = file.slice(root.length + 1).replaceAll("\\", "/");

      /*
       * Line by line, and by SPLITTING on the quote rather than matching
       * across it. A pattern that requires the dots to be inside the quotes
       * can begin its match at the closing quote of an innocent string and end
       * at the opening quote of the next one -- so a spread sitting in the code
       * between two className attributes reads as copy, which is exactly what
       * the first draft of this reported. Splitting cannot do that: on any one
       * line the odd-numbered pieces ARE the strings and the even-numbered ones
       * are the code between them.
       */
      for (const line of source.split("\n")) {
        const pieces = line.split('"');
        for (let index = 1; index < pieces.length; index += 2) {
          if (pieces[index].includes("...")) offenders.push(`${relative}  "${pieces[index]}"`);
        }
      }
      for (const [, text] of source.matchAll(/>([^<>{}\n]*\.\.\.[^<>{}\n]*)</gu)) {
        offenders.push(`${relative}  ${text.trim()}`);
      }
    }

    assert.deepEqual(offenders, [],
      `user-facing copy must use "…":\n  ${offenders.join("\n  ")}`);
  });

  test("AND THE CONVENTION IS ACTUALLY IN USE, so the rule above is not vacuous", () => {
    // A rule that passes because nothing anywhere pauses would be worthless.
    const busy = readFileSync(join(root, "src", "app", "owed", "owed-screen.tsx"), "utf8");
    assert.match(busy, /"Recording…"/u);
  });
});
