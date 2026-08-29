/**
 * THE SHADCN FOUNDATION, EXERCISED RATHER THAN READ.
 *
 * Every other UI assertion in this repository reads a `.tsx` file and matches a
 * regular expression against it. That is the right tool for "this screen must
 * not carry a Name field" — a rule about what the source is allowed to say —
 * but it is the wrong tool for "the confirm dialog is announced as an alert and
 * cannot be dismissed by clicking the backdrop". A regex cannot tell you that;
 * only rendering can.
 *
 * So this file renders the real components into a real DOM and asks the
 * questions a screen reader would ask: what ROLE is this, what is it CALLED, is
 * it PRESSED, is it DISABLED. Those questions survive a change of markup, which
 * is precisely the change that just happened underneath them.
 *
 * What is deliberately NOT here: anything that depends on LAYOUT. jsdom has no
 * viewport, so "the sheet does not overflow at 390px" is proven in live browser
 * QA instead, not faked here.
 *
 * Focus used to be on that list too, and it should not have been. jsdom has no
 * focus RING, but it has `document.activeElement` and it honours `focus()` —
 * and the one dialog regression this migration actually shipped was a focus
 * one, found by a person in a browser after every test in this file had passed.
 * The cost of asking the question here is six lines. See "focus return", below.
 */
import assert from "node:assert/strict";
import test, { describe, after } from "node:test";

import {
  React,
  accessibleName,
  act,
  allByRole,
  byRole,
  changeValue,
  click,
  pressKey,
  queryByRole,
  render,
} from "./dom/harness.mjs";

const h = React.createElement;

const ui = await import("../src/app/components/ui/index.tsx");
const { Switch } = await import("../src/app/components/ui/switch.tsx");
const { describeEventWriteError } = await import("../src/lib/event-errors.ts");

/*
 * Every render starts from a clean document.
 *
 * Dialogs PORTAL to <body>, so they are not inside the container a test
 * renders into and are not swept away by unmounting it. Leave one behind and
 * the next test's `byRole(document.body, ...)` quietly finds the previous
 * test's dialog — which is how a passing suite starts asserting against the
 * wrong element.
 */
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

// ===========================================================================
// 1. Button
// ===========================================================================

describe("Button", () => {
  test("IT IS A REAL BUTTON, NAMED BY ITS LABEL", async () => {
    const view = await show(h(ui.Button, {}, "Add recipient"));
    const button = byRole(view.container, "button", "Add recipient");
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.getAttribute("type"), "button",
      "a button inside a form must not submit it by accident");
  });

  test("a disabled button is disabled to the DOM, not just faded", async () => {
    let clicks = 0;
    const view = await show(h(ui.Button, { disabled: true, onClick: () => { clicks += 1; } }, "Save"));
    const button = byRole(view.container, "button", "Save");

    assert.equal(button.disabled, true);
    await click(button);
    assert.equal(clicks, 0, "a disabled button must not fire its handler");
  });

  test("the busy label is what a person is told while work is in flight", async () => {
    /*
     * This app spells "loading" as a swapped label plus `disabled` rather than a
     * spinner prop, so the guarantee to pin is that the two move together: the
     * button says what is happening AND cannot be pressed again.
     */
    const view = await show(h(ui.Button, { disabled: true }, "Saving…"));
    const button = byRole(view.container, "button", "Saving…");
    assert.equal(button.disabled, true);
    assert.match(accessibleName(button), /Saving/u);
  });

  test("every product variant still renders a button", async () => {
    for (const variant of ["primary", "secondary", "tonal", "ghost", "danger", "dangerGhost", "gold"]) {
      const view = await show(h(ui.Button, { variant }, variant));
      const button = byRole(view.container, "button", variant);
      assert.equal(button.getAttribute("data-variant"), variant,
        "the variant reaches the DOM, so a visual regression is attributable");
    }
  });

  test("an icon-only button still has a name", async () => {
    const view = await show(h(ui.Button, { size: "icon", "aria-label": "Close" }, "×"));
    const button = byRole(view.container, "button", "Close");
    assert.equal(accessibleName(button), "Close",
      "an icon button whose only content is a glyph must carry aria-label");
  });
});

// ===========================================================================
// 2. Fields, and the label that names them
// ===========================================================================

describe("Field", () => {
  test("THE LABEL NAMES THE CONTROL", async () => {
    const view = await show(
      h(ui.Field, { label: "Budget" }, h(ui.Input, { defaultValue: "" })),
    );
    const input = byRole(view.container, "textbox");
    assert.match(accessibleName(input), /Budget/u,
      "a field whose label is not associated is an unlabelled field");
  });

  test("a required field says so beyond a red asterisk", async () => {
    const view = await show(
      h(ui.Field, { label: "Name", required: true }, h(ui.Input, { required: true, defaultValue: "" })),
    );
    const input = byRole(view.container, "textbox");
    assert.equal(input.required, true, "the requirement is on the control, not only in the ink");
  });

  test("an error is ANNOUNCED, not merely coloured", async () => {
    const view = await show(
      h(ui.Field, { label: "Email", error: "That email is already in use." },
        h(ui.Input, { defaultValue: "" })),
    );
    const alert = byRole(view.container, "alert");
    assert.match(alert.textContent, /already in use/u);
  });

  test("the text size does not invite iOS to zoom the page", async () => {
    /*
     * Safari zooms the viewport when a focused input's font-size is under 16px,
     * and never zooms back out. shadcn's stock Input drops to 14px at `md:`;
     * this app's must not.
     */
    const view = await show(h(ui.Input, { defaultValue: "" }));
    const input = byRole(view.container, "textbox");
    const classes = input.getAttribute("class") ?? "";
    assert.match(classes, /\btext-base\b/u);
    assert.ok(!/\bmd:text-sm\b/u.test(classes), "16px must survive at every width");
  });
});

// ===========================================================================
// 3. Select — the native one, which is what the app uses
// ===========================================================================

describe("Select", () => {
  test("it is a real <select>, and selecting reports the value", async () => {
    let chosen = null;
    const view = await show(
      h(ui.Field, { label: "Who takes over" },
        h(ui.Select, { value: "", onChange: (event) => { chosen = event.target.value; } },
          h("option", { value: "" }, "Choose somebody…"),
          h("option", { value: "person-1" }, "Ada"),
          h("option", { value: "person-2" }, "Grace"),
        ),
      ),
    );

    const select = byRole(view.container, "combobox");
    assert.equal(select.tagName, "SELECT",
      "the native control is deliberate: it opens the OS picker on a phone and works inside a <label>");
    assert.match(accessibleName(select), /Who takes over/u);

    await changeValue(select, "person-2");
    assert.equal(chosen, "person-2");
  });

  test("its options are the ones it was given, in order", async () => {
    const view = await show(
      h(ui.Select, { defaultValue: "" },
        h("option", { value: "" }, "Choose"),
        h("option", { value: "a" }, "Ada"),
        h("option", { value: "b" }, "Grace"),
      ),
    );
    const select = byRole(view.container, "combobox");
    assert.deepEqual([...select.options].map((option) => option.textContent), ["Choose", "Ada", "Grace"]);
  });
});

// ===========================================================================
// 4. ToggleChip — the control the recipient and contributor pickers are made of
// ===========================================================================

describe("ToggleChip", () => {
  test("A TOGGLE ANNOUNCES WHETHER IT IS ON", async () => {
    const off = await show(h(ui.ToggleChip, { on: false, onClick: () => {} }, "Ada"));
    assert.equal(byRole(off.container, "button", "Ada").getAttribute("aria-pressed"), "false");

    const on = await show(h(ui.ToggleChip, { on: true, onClick: () => {} }, "Grace"));
    assert.equal(byRole(on.container, "button", "Grace").getAttribute("aria-pressed"), "true");
  });

  test("pressing it reports the person, once", async () => {
    let pressed = 0;
    const view = await show(h(ui.ToggleChip, { on: false, onClick: () => { pressed += 1; } }, "Ada"));
    await click(byRole(view.container, "button", "Ada"));
    assert.equal(pressed, 1);
  });

  test("a disabled chip cannot be pressed", async () => {
    let pressed = 0;
    const view = await show(
      h(ui.ToggleChip, { on: true, disabled: true, onClick: () => { pressed += 1; } }, "Ada"),
    );
    const chip = byRole(view.container, "button", "Ada");
    assert.equal(chip.disabled, true);
    await click(chip);
    assert.equal(pressed, 0, "an already-added recipient must not be addable twice");
  });

  test("F2/F3: A PICKER SHOWS EXACTLY THE PEOPLE IT WAS GIVEN, AND NO NAME BOX", async () => {
    /*
     * The Area-scoped picker's job, at the level a DOM test can prove it: the
     * people offered are the people passed in, each is a toggle, and there is
     * nowhere to type a new name. Which people the SERVER is allowed to pass is
     * proven against a real database in scripts/event-people-scope.test.mjs.
     */
    const sameAreaPeople = [
      { personId: "alpha-1", name: "Ada" },
      { personId: "alpha-2", name: "Grace" },
    ];
    const added = [];
    const view = await show(
      h("div", { role: "group", "aria-label": "Add a recipient" },
        sameAreaPeople.map((person) =>
          h(ui.ToggleChip, {
            key: person.personId,
            on: false,
            onClick: () => added.push(person.personId),
          }, person.name),
        ),
      ),
    );

    const chips = allByRole(view.container, "button");
    assert.equal(chips.length, 2, "only the people from this event's Area are offered");
    assert.deepEqual(chips.map((chip) => accessibleName(chip)), ["Ada", "Grace"]);

    assert.equal(queryByRole(view.container, "textbox"), null,
      "THERE IS NO FREE-TEXT NAME FIELD: a recipient is an existing person, not a new one");

    await click(chips[0]);
    assert.deepEqual(added, ["alpha-1"], "choosing a person submits that person's id");
  });
});

// ===========================================================================
// 5. Modal — a real dialog
// ===========================================================================

describe("Modal", () => {
  test("IT IS ANNOUNCED AS A MODAL DIALOG, NAMED BY ITS HEADING", async () => {
    const view = await show(
      h(ui.Modal, { labelledBy: "t", onClose: () => {} },
        h(ui.ModalHeader, { id: "t", title: "Add recipient", onClose: () => {} }),
      ),
    );
    const dialog = byRole(document.body, "dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.match(accessibleName(dialog), /Add recipient/u,
      "the heading must BE the dialog's name, not merely sit inside it");
    await view.unmount();
  });

  test("Escape closes it", async () => {
    let closed = 0;
    const view = await show(
      h(ui.Modal, { labelledBy: "t", onClose: () => { closed += 1; } },
        h(ui.ModalHeader, { id: "t", title: "Add recipient", onClose: () => {} }),
      ),
    );
    await pressKey(document, "Escape");
    assert.equal(closed, 1);
    await view.unmount();
  });

  test("but not while it is saving", async () => {
    let closed = 0;
    const view = await show(
      h(ui.Modal, { labelledBy: "t", dismissible: false, onClose: () => { closed += 1; } },
        h(ui.ModalHeader, { id: "t", title: "Saving", onClose: () => {} }),
      ),
    );
    await pressKey(document, "Escape");
    assert.equal(closed, 0, "a dialog mid-write must not vanish under the work");
    await view.unmount();
  });

  test("the close button has a name a screen reader can read", async () => {
    const view = await show(
      h(ui.Modal, { labelledBy: "t", onClose: () => {} },
        h(ui.ModalHeader, { id: "t", title: "Add recipient", onClose: () => {} }),
      ),
    );
    const close = byRole(document.body, "button", "Close");
    assert.equal(accessibleName(close), "Close");
    await view.unmount();
  });

  test("and pressing it closes", async () => {
    let closed = 0;
    const view = await show(
      h(ui.Modal, { labelledBy: "t", onClose: () => {} },
        h(ui.ModalHeader, { id: "t", title: "Add recipient", onClose: () => { closed += 1; } }),
      ),
    );
    await click(byRole(document.body, "button", "Close"));
    assert.equal(closed, 1);
    await view.unmount();
  });
});

// ===========================================================================
// 5b. Focus return — the regression that live QA caught
// ===========================================================================

/*
 * WHERE THE KEYBOARD ENDS UP WHEN A DIALOG CLOSES.
 *
 * Radix returns focus to its own `DialogTrigger`. This app has none: dialogs
 * are rendered conditionally and opened by an ordinary button elsewhere on the
 * page, so there was nothing for Radix to go back to and focus landed on
 * <body> — a keyboard user closing "Add recipient" was returned to the top of
 * the document, and a screen reader lost its place entirely.
 *
 * The dialog this migration replaced restored focus on unmount. These tests
 * exist so that guarantee cannot be dropped again silently.
 */
describe("focus return", () => {
  /** Radix and the restore both settle on a later frame. */
  const settle = () => act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });

  async function opensAndCloses(dialogFor) {
    const opener = document.createElement("button");
    opener.textContent = "Add recipient";
    document.body.appendChild(opener);
    opener.focus();
    assert.equal(document.activeElement, opener, "precondition: the opener has focus");

    const view = await show(dialogFor());
    assert.notEqual(document.activeElement, opener, "the dialog must take focus while it is open");

    await view.unmount();
    await settle();
    return opener;
  }

  test("CLOSING A MODAL PUTS THE KEYBOARD BACK ON WHAT OPENED IT", async () => {
    const opener = await opensAndCloses(() =>
      h(ui.Modal, { labelledBy: "t", onClose: () => {} },
        h(ui.ModalHeader, { id: "t", title: "Add recipient", onClose: () => {} }),
      ),
    );
    assert.equal(document.activeElement, opener,
      "focus fell to <body>: a keyboard user is back at the top of the page");
  });

  test("so does closing a Sheet", async () => {
    const opener = await opensAndCloses(() =>
      h(ui.Sheet, { labelledBy: "s", onClose: () => {} },
        h(ui.SheetHeader, { id: "s", title: "Filters", onClose: () => {} }),
      ),
    );
    assert.equal(document.activeElement, opener);
  });

  test("and so does dismissing a ConfirmDialog", async () => {
    const opener = await opensAndCloses(() =>
      h(ui.ConfirmDialog, {
        title: "Delete this event?",
        body: "Everything in it goes too.",
        confirmLabel: "Delete",
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    assert.equal(document.activeElement, opener);
  });

  test("but an opener that has left the page is not chased", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const view = await show(
      h(ui.Modal, { labelledBy: "t", onClose: () => {} },
        h(ui.ModalHeader, { id: "t", title: "Gone", onClose: () => {} }),
      ),
    );
    // The shape of a dialog that saved and navigated: the screen behind it is
    // replaced while the panel is closing.
    opener.remove();
    await view.unmount();
    await settle();
    // Nothing to assert about WHERE focus is — only that restoring did not
    // throw on a detached node.
    assert.ok(true);
  });
});

// ===========================================================================
// 6. ConfirmDialog — the destructive one
// ===========================================================================

describe("ConfirmDialog", () => {
  const base = {
    title: "Delete this event?",
    body: "Everything in it goes too.",
    confirmLabel: "Delete",
    onCancel: () => {},
    onConfirm: () => {},
  };

  test("A DESTRUCTIVE CONFIRMATION IS AN ALERTDIALOG, NOT A DIALOG", async () => {
    const view = await show(h(ui.ConfirmDialog, base));
    const dialog = byRole(document.body, "alertdialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.match(accessibleName(dialog), /Delete this event\?/u);
    await view.unmount();
  });

  test("it offers exactly cancel and confirm, and confirm says what it does", async () => {
    const view = await show(h(ui.ConfirmDialog, base));
    const dialog = byRole(document.body, "alertdialog");
    assert.ok(queryByRole(dialog, "button", "Cancel"), "there is always a way out");
    assert.ok(queryByRole(dialog, "button", "Delete"),
      "the confirm button names the action, not 'OK'");
    await view.unmount();
  });

  test("confirming calls back exactly once", async () => {
    let confirmed = 0;
    const view = await show(h(ui.ConfirmDialog, { ...base, onConfirm: () => { confirmed += 1; } }));
    await click(byRole(document.body, "button", "Delete"));
    assert.equal(confirmed, 1);
    await view.unmount();
  });

  test("cancelling calls back and does not delete", async () => {
    let confirmed = 0;
    let cancelled = 0;
    const view = await show(h(ui.ConfirmDialog, {
      ...base,
      onCancel: () => { cancelled += 1; },
      onConfirm: () => { confirmed += 1; },
    }));
    await click(byRole(document.body, "button", "Cancel"));
    assert.equal(cancelled, 1);
    assert.equal(confirmed, 0);
    await view.unmount();
  });

  test("WHILE IT IS WORKING, NEITHER BUTTON CAN BE PRESSED AGAIN", async () => {
    let confirmed = 0;
    const view = await show(h(ui.ConfirmDialog, {
      ...base,
      busy: true,
      busyLabel: "Deleting…",
      onConfirm: () => { confirmed += 1; },
    }));
    const confirm = byRole(document.body, "button", "Deleting…");
    assert.equal(confirm.disabled, true);
    assert.equal(byRole(document.body, "button", "Cancel").disabled, true);
    await click(confirm);
    assert.equal(confirmed, 0, "a double-press must not delete twice");
    await view.unmount();
  });

  test("and Escape does not abandon it mid-delete", async () => {
    let cancelled = 0;
    const view = await show(h(ui.ConfirmDialog, {
      ...base,
      busy: true,
      onCancel: () => { cancelled += 1; },
    }));
    await pressKey(document, "Escape");
    assert.equal(cancelled, 0);
    await view.unmount();
  });
});

// ===========================================================================
// 7. Sheet
// ===========================================================================

describe("Sheet", () => {
  test("it is a dialog too, named by its header", async () => {
    const view = await show(
      h(ui.Sheet, { labelledBy: "filters-title", onClose: () => {} },
        h(ui.SheetHeader, { id: "filters-title", title: "Filters", onClose: () => {} }),
      ),
    );
    const dialog = byRole(document.body, "dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.match(accessibleName(dialog), /Filters/u);
    await view.unmount();
  });

  test("Escape closes it", async () => {
    let closed = 0;
    const view = await show(
      h(ui.Sheet, { labelledBy: "filters-title", onClose: () => { closed += 1; } },
        h(ui.SheetHeader, { id: "filters-title", title: "Filters", onClose: () => {} }),
      ),
    );
    await pressKey(document, "Escape");
    assert.equal(closed, 1);
    await view.unmount();
  });
});

// ===========================================================================
// 8. Switch
// ===========================================================================

describe("Switch", () => {
  test("it is a switch, and reports its state", async () => {
    const view = await show(h(Switch, { checked: true, onCheckedChange: () => {}, "aria-label": "Falling snow" }));
    const control = byRole(view.container, "switch", "Falling snow");
    assert.equal(control.getAttribute("aria-checked"), "true");
  });

  test("toggling reports the new value", async () => {
    let next = null;
    const view = await show(
      h(Switch, { checked: false, onCheckedChange: (value) => { next = value; }, "aria-label": "Birthdays" }),
    );
    await click(byRole(view.container, "switch", "Birthdays"));
    assert.equal(next, true);
  });

  test("a disabled switch does not change", async () => {
    let changed = 0;
    const view = await show(
      h(Switch, { checked: false, disabled: true, onCheckedChange: () => { changed += 1; }, "aria-label": "Snow" }),
    );
    await click(byRole(view.container, "switch", "Snow"));
    assert.equal(changed, 0);
  });
});

// ===========================================================================
// 9. Notice / Badge — status that does not depend on colour alone
// ===========================================================================

describe("status surfaces", () => {
  test("F4: A DUPLICATE-EVENT ERROR IS RENDERED IN PLAIN ENGLISH", async () => {
    /*
     * The wording is decided by describeEventWriteError and pinned by
     * src/lib/event-errors.test.ts. What is proven HERE is the other half:
     * that whatever it returns reaches the screen as an announced alert, and
     * that no database vocabulary rides along with it.
     */
    const message = describeEventWriteError(
      { code: "23505", message: 'duplicate key value violates unique constraint "events_name_and_date_per_area_idx"' },
      { name: "Christmas 2026", occasion: "christmas" },
    );

    const view = await show(h(ui.Notice, { tone: "danger" }, message));
    const alert = byRole(view.container, "alert");

    assert.equal(alert.textContent.trim(), message);
    for (const leak of ["23505", "idx", "constraint", "SQLSTATE", "postgres", "PostgREST", "duplicate key"]) {
      assert.ok(!alert.textContent.toLowerCase().includes(leak.toLowerCase()),
        `the screen must not show "${leak}"`);
    }
  });

  test("a failure interrupts; anything else waits its turn", async () => {
    const bad = await show(h(ui.Notice, { tone: "danger" }, "That did not save."));
    assert.ok(queryByRole(bad.container, "alert"), "a failure is assertive");

    const good = await show(h(ui.Notice, { tone: "success" }, "Saved."));
    assert.ok(queryByRole(good.container, "status"), "a success is polite");
  });

  test("a dismissible notice has a named dismiss control", async () => {
    let dismissed = 0;
    const view = await show(
      h(ui.Notice, { tone: "success", onDismiss: () => { dismissed += 1; } }, "Saved."),
    );
    const dismiss = byRole(view.container, "button", "Dismiss message");
    await click(dismiss);
    assert.equal(dismissed, 1);
  });

  test("a badge does not rely on colour alone", async () => {
    const view = await show(h(ui.Badge, { tone: "danger" }, "Over budget"));
    assert.match(view.container.textContent, /Over budget/u,
      "the state is written in words, not only painted");
  });
});

// ===========================================================================
// 10. DataTable — the row that behaves like a button must say so
// ===========================================================================

describe("DataTable", () => {
  const columns = [
    { key: "name", header: "Name", cell: (row) => row.name },
    { key: "total", header: "Total", align: "right", sortable: true, cell: (row) => row.total },
  ];
  const rows = [{ id: "1", name: "Ada", total: "£10.00" }];

  test("it is a table with a header row", async () => {
    const view = await show(
      h(ui.DataTable, { columns, rows, rowKey: (row) => row.id }),
    );
    assert.ok(queryByRole(view.container, "table"));
    assert.ok(queryByRole(view.container, "columnheader", "Name"));
  });

  test("AN ACTIVATABLE ROW IS ANNOUNCED AS ONE, AND WORKS FROM THE KEYBOARD", async () => {
    const opened = [];
    const view = await show(
      h(ui.DataTable, {
        columns,
        rows,
        rowKey: (row) => row.id,
        onRowActivate: (row) => opened.push(row.id),
      }),
    );

    const row = byRole(view.container, "button", "Ada");
    assert.equal(row.tagName, "TR");
    assert.equal(row.getAttribute("tabindex"), "0", "it must be reachable by Tab");

    await pressKey(row, "Enter");
    assert.deepEqual(opened, ["1"], "Enter opens the row, not just a mouse click");
  });

  test("a sortable column exposes its sort direction", async () => {
    const view = await show(
      h(ui.DataTable, {
        columns,
        rows,
        rowKey: (row) => row.id,
        sort: { key: "total", direction: "asc" },
        onSort: () => {},
      }),
    );
    const header = byRole(view.container, "columnheader", "Total");
    assert.equal(header.getAttribute("aria-sort"), "ascending");
  });
});
