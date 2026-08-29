# shadcn/ui as the UI foundation

**Status: implemented.** shadcn/ui is the primary reusable primitive foundation
for this application. Every button, field, dialog, menu and table in the product
resolves to a registry component under `src/app/components/ui/`.

This document describes what exists. It replaces an earlier audit-and-plan
version of the same file.

---

## 1. The shape of it, in one paragraph

Registry components live in `src/app/components/ui/*.tsx`. They are real shadcn
source, added through the CLI, and then **restyled onto this app's existing
design tokens** rather than left in stock shadcn colours. On top of them sits
`src/app/components/ui/index.tsx` — the product layer — which exports the
vocabulary the ~40 screens already spoke (`Button variant="tonal"`, `Field`,
`Modal`, `DataTable`, `EmptyState`, …) and is now implemented in terms of the
primitives. **No screen imports a registry component directly for anything the
product layer already covers**, so a change to the foundation is one edit, not
forty.

```
src/app/components/ui/
  button.tsx  input.tsx  textarea.tsx  native-select.tsx  label.tsx
  badge.tsx   card.tsx   alert.tsx     skeleton.tsx       table.tsx
  dialog.tsx  alert-dialog.tsx  sheet.tsx  dropdown-menu.tsx
  popover.tsx select.tsx  checkbox.tsx  switch.tsx
  index.tsx   <- the product layer; every screen imports THIS
```

---

## 2. The MCP server, and how Claude Code loads it

`.mcp.json` is committed at the repository root:

```json
{
  "mcpServers": {
    "shadcn": {
      "command": "npx",
      "args": ["shadcn@latest", "mcp"]
    }
  }
}
```

It contains no secrets — it is a command line. Committing it makes the registry
available to everyone who opens the repository instead of being a machine-local
dependency somebody has to be told about.

**Claude Code reads `.mcp.json` when a session STARTS.** Creating the file
mid-session does not register its tools; the session has to be restarted, and
the project-scoped server approved when prompted. Approval is recorded in
`.claude/settings.local.json` as `enabledMcpjsonServers: ["shadcn"]`.

The seven tools it provides:

| Tool | What it is for |
|---|---|
| `get_project_registries` | which registries this project can pull from |
| `list_items_in_registries` | enumerate what exists |
| `search_items_in_registries` | find a component by need |
| `view_items_in_registries` | read a component before adopting it |
| `get_item_examples_from_registries` | official usage examples |
| `get_add_command_for_items` | the exact install command |
| `get_audit_checklist` | post-install verification |

One quirk worth knowing: `search_items_in_registries` and
`list_items_in_registries` render each result's add command as
`[object Promise]`. That is a formatting bug in the server, not a broken
registry — `get_add_command_for_items` returns the real command.

### The rule for Q5 onward

> **When a reusable UI primitive is needed, check the shadcn registry through
> the MCP first.** Search it, view the source, and adopt it if it fits. Write a
> bespoke component only when the registry has nothing for the job, or when the
> registry component's model actively fights a product requirement — and say
> which, in a comment, where the component lives.

"It would be quicker to hand-write a div" is not a reason. The registry
components carry keyboard behaviour, ARIA and focus management that a
hand-written control silently does not; that gap is what §6 below was mostly
about.

---

## 3. `components.json`

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/app/components",
    "utils": "@/lib/cn",
    "ui": "@/app/components/ui",
    "lib": "@/lib",
    "hooks": "@/app/components"
  },
  "registries": {}
}
```

`tailwind.config` is **empty on purpose**: this is Tailwind v4, which has no
`tailwind.config.js`. Anything that reads this file and tries to patch a v3
config is following the wrong recipe.

`aliases.ui` pointing at `@/app/components/ui` is why the old
`src/app/components/ui.tsx` became `src/app/components/ui/index.tsx`. A file and
a directory of the same name cannot coexist — `ui.tsx` wins resolution and the
registry components become unreachable. Every existing import ended in `/ui`, so
the move changed no call site.

---

## 4. Theme and tokens

**`globals.css`'s palette was not touched.** The warm-editorial identity — paper
grounds, ink text, the evergreen accent, the gold and berry, the pine plates,
the three shadow scales — is unchanged and remains the source of truth for
colour.

What was added is a **bridge**: shadcn's semantic vocabulary defined as pointers
into that palette, inside the existing `@theme inline` block.

| shadcn token | points at | meaning here |
|---|---|---|
| `background` / `foreground` | `--ground` / `--ink-900` | the page |
| `card`, `popover` | `--surface` | a raised panel |
| `primary` | `--accent` | the brand green |
| `secondary`, `muted` | `--surface-2` | a quiet fill |
| `elevated` | `--surface-2` | **shadcn's "accent"** — see below |
| `destructive` | `--berry-strong` | a dangerous action |
| `border` / `input` | `--line` / `--line-strong` | hairlines |
| `ring` | `--ring` | already existed |

### The one rename

shadcn's `--accent` means *"the surface a menu item takes on hover"*. This app's
`--accent` is the **brand green**. Both compile to the same `bg-accent` utility,
so a stock registry component's hover state would have turned solid brand green.

The registry files were rewritten to say **`elevated`** instead
(`bg-elevated`, `text-elevated-foreground`). `bg-accent` therefore still means
the brand, everywhere, unambiguously. If you add a new registry component, run
the same rename on it.

### Radius

Tailwind's radius scale is already overridden in `@theme` (`--radius-lg: 0.5rem`
and friends) — crisper corners than stock, which is the editorial look. Registry
components use `rounded-md`/`rounded-lg`/`rounded-xl` and inherit it. A bare
`--radius` is also defined too. Nothing reads it today — it is there because a
few registry components read `var(--radius)` directly rather than through a
`rounded-*` utility, so a newly added one lands on this app's corner scale
instead of silently falling back to stock.

---

## 5. `cn` vs `cx` — two class helpers, on purpose

| | `cx` (`src/app/components/cx.ts`) | `cn` (`src/lib/cn.ts`) |
|---|---|---|
| does | joins truthy strings | `clsx` + `tailwind-merge` |
| resolves Tailwind conflicts | **no** | **yes** — a later `bg-*` wins |
| used by | the product layer | every file in `ui/` |

`cn` is what lets a primitive publish a default look and still accept a
`className` override. `cx` stays in the product layer, where the rule is the
opposite: variation is expressed through explicit props (`tone`, `variant`,
`size`) and a passed `className` is layout only — spacing, positioning,
visibility — never colour.

`cx` deliberately has no `"use client"`, so server components can call it.

---

## 6. What each primitive is, and what changed

### Button — the product's design language, in shadcn's structure

`button.tsx` keeps registry structure (cva, `data-slot`, `asChild` via Radix
`Slot`, the focus-visible ring, `aria-invalid` handling, `[&_svg]` sizing) and
replaces the palette. The seven product variants are the ones the app already
had; shadcn's own names are kept as **aliases** so vendored components stay
on-brand:

```
default -> primary      destructive -> danger
outline -> secondary    link        -> unchanged
```

Sizes are the product's, with a **44px minimum target** — this app is used on
phones and every control has to be thumb-safe. `size="icon"` is `size-11` for
the same reason, not shadcn's `size-9`.

### Fields — Input, Textarea, NativeSelect

All three wear one shared `fieldClasses` (exported from `input.tsx`): 48px tall,
`rounded-xl`, surface fill, hairline border, and the app's soft 4px accent focus
halo rather than shadcn's 3px ring.

`text-base` (16px) is load-bearing and shadcn's stock `md:text-sm` is
deliberately dropped: **iOS Safari zooms the viewport when a focused input's
text is under 16px, and never zooms back out.** There is a test for this.

### Select — native by default

Ordinary "pick one of these" fields use `NativeSelect`, a real `<select>`,
because:

- on a phone it opens the OS picker — a better control than a portalled
  listbox, with no scroll-locking or collision logic to get wrong;
- it is a real form control, so it works inside the `<label>` that `Field`
  wraps around it, and submits with the form;
- it cannot be positioned off-screen.

Radix `Select` (`select.tsx`) is kept as the **documented escape hatch** for
what the native control cannot express — rich option content, grouped options
with icons. It is not used yet.

### Field — implicit label association

`Field` wraps its control in a `<label>`, which associates the two without
id/`htmlFor` bookkeeping and cannot be left dangling when a field is copied.
This is why ordinary selects are native: a Radix trigger is a `<button>`, and a
button inside a label is not a labelled control.

`error` renders with `role="alert"`, so a validation failure is announced rather
than only turning something red.

### Modal / Sheet / ConfirmDialog — Radix owns the behaviour

The hand-rolled focus trap, Escape handler and scroll lock (`use-dialog.ts`,
~50 lines) **have been deleted**. Radix does all of it, plus inert-ing the page
behind, which the hand-rolled version never did.

**Focus-return is the one part Radix does not cover here, and it had to be kept.**
Radix returns focus to its own `DialogTrigger`; this app has none, because every
dialog is rendered conditionally (`{open && <Modal … />}`) and opened by an
ordinary button somewhere else on the page. With no trigger to remember, Radix
dropped focus on `<body>`: close "Add recipient" from the keyboard and you were
returned to the top of the document. `useReturnFocus()` in `ui/index.tsx`
captures the focused element during RENDER — an effect is too late, because
child effects run first and Radix has already moved focus into the panel by
then — and restores it a frame after unmount. `Modal`, `Sheet` and
`ConfirmDialog` all call it.

> This was **found in live browser QA, after every automated test passed**. It
> is the reason the "focus is only provable in a real browser" line was wrong
> and has been removed: jsdom has no focus *ring*, but it has
> `document.activeElement`, and four tests now hold the guarantee down.

The *geometry* was kept exactly, because it encodes real fixes:

- radius and scrolling live on **different elements** — with both on one, the
  native scrollbar paints inside the corner radius and squares it off;
- the safe-area inset lives on the panel, not on `ModalFooter`, because most
  modals have no footer and would otherwise sit under the home indicator;
- on mobile the panel is flush to the bottom edge; from `sm:` it floats.

The API is unchanged — render it conditionally, pass `onClose`. Radix is held
permanently open and its close events are routed to that callback, so all ~14
call sites work untouched.

**`aria-modal="true"` is set explicitly.** Radix does not set it (it relies on
inert-ing siblings); the dialog this replaced did, and dropping it would quietly
weaken what a screen reader is told.

`ConfirmDialog` is an **AlertDialog**, not a Dialog: announced as
`role="alertdialog"`, and it cannot be dismissed by clicking the backdrop — so a
stray click outside can never be the thing that deletes an event. While `busy`,
both buttons are disabled and Escape is ignored.

`ModalTitle` exists for the few dialogs that draw their own heading (command
search, the photo viewer): it makes the heading they already render *be* the
dialog's accessible name rather than adding a second one.

### Menu vs Popover — a split that had to happen

`popover.tsx` used to export one hand-rolled anchored panel used for two
different jobs, and the second job was the tell: the payment log's **filter
form** was rendered inside something announcing `role="menu"`. A menu's contract
is that arrows move between items and Tab leaves — exactly wrong for a panel of
text fields.

There are two primitives now:

| | backed by | for |
|---|---|---|
| `Menu`, `MenuItem`, `MenuSection`, `MenuRadioGroup`, `MenuRadioItem`, `MenuCheckboxItem` | `dropdown-menu.tsx` | a real menu — the account menu |
| `Popover` | `popover.tsx` | an anchored panel of arbitrary content — the filter disclosure |

The account menu's family switcher is now a real `MenuRadioGroup`, so it gets
roving tabindex, Home/End and typeahead. Both are collision-aware, which the
hand-rolled version was not: an end-aligned panel could previously run off the
side of a phone screen.

Trigger open-state is read off the DOM with
`group-data-[state=open]/trigger:` rather than mirrored in React state.

---

## 7. Product composites that were kept

These are **domain** components, not decoration, and they survive — rebuilt on
the primitives, with their APIs intact:

| Composite | Now built from | Why it stays |
|---|---|---|
| `MoneyInput` | bespoke (see exceptions) | the £ prefix and the wrapper-level focus ring |
| `Field` | `Label` + the field primitives | implicit label association |
| `EventCard` / `SectionCard` / `Card` | `card.tsx` with product tones | `tone="ink"` is a theme island |
| `EmptyState` | `Button` + ornament | product illustration and voice |
| `DataTable` / `DataCards` | `table.tsx` + `Button` | the responsive table↔cards switch |
| `Toolbar`, `ChipRow`, `FilterChip` | `Button` | layout and filter semantics |
| `DataList` / `DataRow` | `<dl>` | a description list is the right element |
| `Badge` | `badge.tsx` with product tones | budget states are domain semantics |
| `Notice` | `alert.tsx` with product tones | `role` switches on severity |
| `Segmented` | `Button` | a labelled `aria-pressed` group |
| app shell / mobile bottom nav | unchanged | product information architecture |

### `ToggleChip` — new, and a real deduplication

Five screens had each grown their own copy of the same "switch a person on or
off" control (event recipients, event contributors, event creation, birthday
planning, family access). They now share `ToggleChip`, so "selected" looks and
reads the same everywhere, and `aria-pressed` is guaranteed in one place instead
of five.

---

## 8. Accessibility conventions

- **Every dialog has an accessible name.** `ModalHeader`/`SheetHeader` provide
  it; bespoke headings use `ModalTitle`.
- **Destructive actions use `ConfirmDialog`** (AlertDialog), never a plain
  dialog, and never a bare button.
- **Icon-only buttons carry `aria-label`.** Audited: zero without one.
- **Decorative icons carry `aria-hidden`.**
- **Toggles carry `aria-pressed`; switches are `role="switch"`** (Radix
  `Switch`, adopted in two places that were hand-rolling it).
- **Errors are announced** — `role="alert"` for failures, `role="status"` for
  everything else, so a success does not interrupt.
- **No click-only non-semantic elements.** Audited: zero. An activatable table
  row carries `role="button"`, `tabIndex={0}` and an Enter/Space handler.
- **Status is never colour alone** — badges carry a dot and a word.
- **Closing a dialog returns focus to whatever opened it.** Radix's trigger-based
  version does not fire for a conditionally rendered dialog, so `useReturnFocus`
  does it; tested.
- Focus trap, Escape and keyboard menu navigation are Radix's, and confirmed in
  live browser QA.

---

## 9. Testing

`scripts/shadcn-ui.test.mjs` — **42 tests that render the real components into a
real DOM** and query them by role and accessible name, the way an assistive
technology would. That is the point: those questions survive a change of markup,
which is exactly the change this migration made.

Run it with `npm run test:shadcn-ui`; the whole suite is `npm run test:all`.

Infrastructure, all under `scripts/dom/`:

| File | Job |
|---|---|
| `tsx-hook.mjs` | esbuild transform so `node --test` can import `.tsx`; resolves `@/` and extensionless imports |
| `tsx-hook-register.mjs` | registers the hook via `--import` |
| `harness.mjs` | jsdom globals, `render`, and role/name queries |
| `stubs/next-link.mjs` | `next/link` resolves through Next's bundler, not plain Node |

Two things the harness had to get right, both of which fail *silently* if wrong:

1. **Node's globals win where Node has them.** Copying the whole jsdom window
   makes `queueMicrotask` call itself forever. But the **event classes must come
   from jsdom** — Radix constructs a `CustomEvent`, and jsdom rejects a foreign
   one with "parameter 1 is not of type Event".
2. **Every render starts from a clean document.** Dialogs portal to `<body>`, so
   unmounting a test's container does not remove them; a leaked dialog makes the
   next test assert against the wrong element.

Deliberately **not** tested here: layout. jsdom has no viewport, so "no
horizontal overflow at 390px" is proven in live browser QA.

Focus was on that list, and should not have been — see the box in §6. jsdom
honours `focus()` and reports `document.activeElement`, so "closing a dialog
puts the keyboard back on what opened it" is asked here now, in four tests that
fail if `useReturnFocus` is removed.

Dependencies added for this: `jsdom` and `esbuild` only. No testing-library —
the queries are 60 lines in `harness.mjs`.

---

## 10. Both lockfiles are maintained

`package-lock.json` **and** `pnpm-lock.yaml` are both committed and both kept
current. Neither may be deleted to make a tool's life easier.

- `node_modules` is installed with **npm**, and `npm run deploy` builds the
  Worker locally from it — so npm's resolution is what actually ships.
- `pnpm-lock.yaml` exists because Cloudflare/build tooling has previously used
  pnpm with a frozen lockfile. A frozen install fails outright against a stale
  lockfile, so letting it drift is a broken build waiting to happen.

**When dependencies change, update all three:** `package.json`,
`package-lock.json` (`npm install`), and `pnpm-lock.yaml`
(`npx pnpm@10 install --lockfile-only`). Then check they agree.

> **A pre-existing inconsistency, found and fixed by this migration.**
> `lucide-react` resolved to **1.33.0** in `package-lock.json` and **1.31.0** in
> `pnpm-lock.yaml`. Both satisfied `^1.31.0`, so neither lockfile was invalid —
> they simply described different trees, and the pnpm one described a tree that
> had never been built or tested. It was reconciled **onto 1.33.0**, the version
> actually installed, built and deployed. `package.json`'s range is untouched at
> `^1.31.0`; nothing was upgraded.
>
> Beware `pnpm update <pkg>`: it rewrites the **specifier** in `package.json`
> (it moved this one to `^1.35.0`), which is an upgrade, not a reconciliation.

Dependencies this migration added:

| Package | Why |
|---|---|
| `radix-ui` | the single package every registry component imports |
| `class-variance-authority` | variant maps |
| `clsx`, `tailwind-merge` | `cn` |
| `jsdom`, `esbuild` (dev) | the DOM test harness |

`sonner` was installed by the CLI as a dependency of the toast component, then
**removed along with `ui/sonner.tsx`**: this app's feedback pattern is the
inline `Notice`, which is contextual and already announced, and an unused global
toaster is a dependency with no reader.

---

## 11. Remaining bespoke UI, and why

Every one of these is deliberate.

| Where | What | Why shadcn is wrong for it |
|---|---|---|
| `src/app/global-error.tsx` | a `<button>` with inline `style` | it renders when the app shell has crashed; it cannot assume Tailwind or any component tree loaded |
| `ui/index.tsx` — `MoneyInput` | a bare `<input>` inside a styled wrapper | the wrapper holds the £ prefix **and wears the focus ring**; left to itself the input rings *itself*, starting after the £, which reads as a box inside a box |
| `command-search.tsx` | a borderless `<input>` | it is the palette's own search line, not a form field; a bordered box inside the dialog would be wrong |
| `photo-picker.tsx`, `photo-gallery.tsx` | `<input type="file" className="sr-only">` ×4 | a file input is triggered by a real `Button` next to it; there is no registry component for the hidden input itself |
| `notification-bell.tsx` | hand-rolled panel + `aria-hidden` scrim | it is two shapes at once (anchored on desktop, sheet on mobile) with its own Escape and focus-return; the scrim carries **no handler** — the document-level pointerdown already dismisses |
| `festive/*` | ornaments, garland, snow | product illustration |

Census after migration: **52 raw `<button>` → 1**; the raw inputs above are the
only ones left; **0 raw `<select>`** outside the primitive.

### Not installed, deliberately

`radio-group`, `scroll-area`, `separator`, `spinner`, `tabs` and `tooltip` were
added by the CLI and then removed: nothing uses them, and a vendored file with
no reader is debt, not a head start. They are one
`get_add_command_for_items` call away when a screen actually needs one.

**`select.tsx` is the one deliberate exception to that rule**, and it is worth
being explicit about because it looks like an oversight. It has no importer: the
product uses `NativeSelect` everywhere, for the reasons in §6. It is kept anyway
because the *choice* between the two is a live design decision this app will
face again, and a reader who needs rich option content should find the answer
vendored, tokenised and ready rather than have to rediscover why the native
control was preferred. If it is still unused when the next component audit
comes round, delete it — the reasoning above survives in this document.

---

## 12. If you are adding a component

1. Ask the MCP: `search_items_in_registries`, then `view_items_in_registries`.
2. `get_add_command_for_items`, and run it with **npx**, not pnpm — the CLI
   picks pnpm from `pnpm-lock.yaml` and pnpm is not installed here. Install any
   new dependency with `npm install` **first**; the CLI skips its own install
   step when nothing is missing, and writes the files.
3. Rename `accent` → `elevated` in the new file (§4).
4. Restyle it onto the tokens in §4. Do not leave stock shadcn colours.
5. If a screen would import it directly, ask whether it belongs in the product
   layer instead.
6. Add behaviour tests to `scripts/shadcn-ui.test.mjs` — role and accessible
   name, not classes.
7. Update both lockfiles (§10) and run `npm run test:all`.
