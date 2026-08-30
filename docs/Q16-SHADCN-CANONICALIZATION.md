# Q16 — shadcn/Radix as the canonical UI primitive system

**Verdict: `Q16 PASS`.** shadcn/Radix is the canonical generic UI primitive
system in Gift Planner, and nothing competes with it.

This is the UI counterpart to Q15's database audit: the same question — *is
there exactly one authoritative implementation per concept* — asked of the
interface layer instead of the schema. The answer came out the same way, and for
the same reason: the consolidation already happened, in Q5 and again in Q13, and
what Q16 found was **stale documentation describing a parallel system that no
longer exists**, plus two files nobody had got round to deleting.

---

## 1. What was looked for, and what was actually there

Q14's preliminary UI findings pointed at three things. All three were
investigated to a conclusion, and **two of the three turned out to be wrong**:

| Q14 said | Q16 found |
|---|---|
| `components/ui/select.tsx` has zero importers | **Correct.** Deleted. |
| A naming collision: two different `Select`s | **Correct, and it resolved itself** — deleting the unused one leaves exactly one `Select`, at zero call-site churn |
| Two icon systems coexist | **Wrong.** There is one — `lucide-react`. `icons.tsx` *imports from it* |

The third deserves saying plainly because it is the kind of finding that
survives by looking obvious. `icons.tsx` has `import { … } from "lucide-react"`
on its first line. It is a **named catalogue over lucide**, not a rival to it.

---

## 2. The primitive matrix

`ui/` = `src/app/components/ui/`. "Product layer" = `ui/index.tsx`, which every
screen imports; no screen imports a registry file directly for anything the
product layer covers.

| Primitive | Canonical implementation | Product-layer wrapper | Alternative implementation? | Class |
|---|---|---|---|---|
| Button | `ui/button.tsx` (cva, Radix `Slot`) | `Button`, `ButtonLink`, `buttonClasses` | none | A |
| Input | `ui/input.tsx` | `Input`, `Field` | `MoneyInput` — bare `<input>` in a ring-bearing wrapper | A + D |
| Textarea | `ui/textarea.tsx` | `Textarea` | none | A |
| Label | `ui/label.tsx` (Radix `Label`) | `Field` (wrapping `<label>`) | native `<label>` ×11, all wrapping canonical controls | A + B |
| Checkbox | `ui/checkbox.tsx` (Radix) | via screens | none | A |
| Switch | `ui/switch.tsx` (Radix) | via screens | none | A |
| Native select | `ui/native-select.tsx` | `Select` | none | A/B |
| Radix Select | **not vendored** — deleted in Q16 | — | — | F → removed |
| Dialog | `ui/dialog.tsx` (Radix) | `Modal`, `ModalHeader/Footer/Title` | none | A |
| AlertDialog | `ui/alert-dialog.tsx` (Radix) | `ConfirmDialog` | none | A |
| Sheet | `ui/sheet.tsx` (Radix Dialog) | `Sheet`, `SheetHeader/Footer` | none | A |
| DropdownMenu | `ui/dropdown-menu.tsx` (Radix) | `Menu`, `MenuItem`, `MenuSection`, `MenuRadioGroup`, `MenuRadioItem`, `MenuCheckboxItem` | none | A + D |
| Popover | `ui/popover.tsx` (Radix) | `Popover` (in `components/popover.tsx`) | none | A + D |
| Card | `ui/card.tsx` | `Card`, `SectionCard`, `EventCard` | none | A + D |
| Badge | `ui/badge.tsx` | `Badge` (product tones) | none | A + D |
| Alert | `ui/alert.tsx` | `Notice` (68 uses) | none | A + D |
| Table | `ui/table.tsx` | `DataTable` / `DataCards` | none | A + D |
| Skeleton | `ui/skeleton.tsx` | `Skeleton` | none | A |
| Toast / Sonner | **deliberately none** — the pattern is inline `Notice` | — | no rival toast state anywhere | justified |
| Progress | **not vendored** | — | `FinancialProgressBar` | **C** — see §5 |
| Tabs | **not vendored** | — | `BottomTabs` is navigation, not a tablist | **C** |
| Tooltip, Avatar, ScrollArea, Separator, Accordion, ContextMenu, Drawer, Combobox, Pagination, RadioGroup, command palette | **not vendored, not needed** | — | none — zero occurrences of each | n/a |

Radix `Separator` and `RadioGroup` *do* appear, but only as
`DropdownMenuSeparator` and `DropdownMenuRadioGroup` inside the menu primitive.
Neither is a standalone parallel implementation.

---

## 3. The strongest single piece of evidence

**Every Radix import in the repository is inside `components/ui/`.** Eleven
files import `radix-ui`; all eleven are registry components. Not one screen, not
one product component, reaches past the wrappers.

That is what makes the claim in the title true, and it is now a test rather than
a paragraph — `scripts/ui-primitives.test.mjs`, which was proved to fail when a
single `import { Tooltip } from "radix-ui"` was added to `top-bar.tsx`.

---

## 4. Category E — duplicate generic primitives

**None. Zero found.**

Every candidate was chased to its source and each turned out to be a wrapper
*over* the canonical primitive rather than a rival to it:

- **`components/popover.tsx`** looked like the most likely offender — a second
  file named `popover` sitting outside `ui/`, next to `ui/popover.tsx`. It
  imports both `ui/dropdown-menu` and `ui/popover` and exists to keep two things
  apart that must not be confused: `Menu` (a real `role="menu"`, arrows move
  between items, Tab leaves) and `Popover` (arbitrary content, Tab walks the
  fields). Category **D**, and a good one.
- **`notification-bell.tsx`** is documented in `SHADCN-UI.md` §11 as a
  hand-rolled panel with its own Escape and focus-return. **That documentation
  was four phases stale** — Q13 rebuilt it on the shared Radix `Dialog`. The
  file now imports `./ui/dialog` and hand-rolls nothing. Category **C**. The
  stale row has been removed from that document.
- **`FinancialProgressBar`** is not a Progress duplicate — see §5.
- **`command-search.tsx`** renders inside the product `Modal` and its one global
  keydown listener is the ⌘K shortcut, not a focus trap.

The one focus manager in this app is Radix's, everywhere, without exception.

---

## 5. `FinancialProgressBar` — the interesting judgment call

It is a bar that fills up, so shadcn's `Progress` looks like the obvious answer.
It is not, and the reason is the rule this phase was meant to apply:
**do not replace a good product component merely because it is custom.**

`Progress` renders a track and a fill from a number 0–100. This component takes
`actualPennies`, `plannedPennies` and a `mode`, calls `calculateFinancialProgress`,
and derives three domain states — under, `budget_reached`, `over_budget` — which
drive the fill colour (gold / success / berry), the label colour, and two
separate strings of copy that differ between "budget" and "plan". Its
`aria-valuenow` is deliberately clamped to 100 while its visible label says
"Over budget", because **budgets are targets, not caps** and the bar has to be
able to say so.

Adopting `Progress` underneath it would move a `<div>` and keep all of that.
It already carries a correct `role="progressbar"` with the full `aria-valuemin`
/`max`/`now`/`text` set. Category **C**, kept, unchanged.

---

## 6. Semantic HTML kept on purpose (category B)

- **`Select` is a real `<select>`.** It opens the OS picker on a phone, it
  submits with the form, it cannot be positioned off-screen, and — decisively —
  it is a real form control inside the `<label>` that `Field` wraps around it. A
  Radix trigger is a `<button>`, and a button inside a label is not a labelled
  control. 11 call sites.
- **Eleven native `<label>` elements outside `ui/`.** Every one wraps a
  canonical `Input` or `Select`, which is the same implicit-association
  technique `Field` itself uses. They exist where `Field`'s typography is wrong
  for the context: the payment-log filter grid wants `text-xs` compact labels,
  and three search boxes need `position: relative` to place their icon.
- **One raw `<button>`, in `global-error.tsx`**, which renders when the app
  shell has crashed and cannot assume Tailwind or any component tree loaded.
- **Four `<input type="file" className="sr-only">`** in the photo components,
  triggered by a real `Button` beside them. There is no registry component for a
  hidden file input.

---

## 7. What actually changed

### Deleted (category F, UI-only)

| File | Evidence |
|---|---|
| `src/app/components/ui/select.tsx` | Zero importers in `src/`, zero in `scripts/`, zero dynamic or config consumers. `SHADCN-UI.md` §11 itself said "if it is still unused when the next component audit comes round, delete it." |
| `src/app/components/use-mounted.ts` | Zero importers. Q13 removed its last consumer. The only surviving mention is a *negative* assertion in `notification-centre.test.mjs` that the bell no longer uses it — which still passes, and still means what it meant. |

### Forms — three fields brought onto the canonical pattern

`create-area-form.tsx` (×2) and `family-settings-screen.tsx` (×1) hand-spelled
`Field`'s own markup: a `<label className="block text-sm font-semibold">`
wrapping an `Input`, with `const field = "mt-2"` reproducing the exact spacing
`Field` applies to its child. They are `Field` now, so they inherit its
`required`, `error` (`role="alert"`) and `hint` support instead of being three
places that would have to be updated by hand.

**One deliberate visual convergence:** their labels were `text-ink-700` and
`Field` renders `text-ink-900`, so those three labels are now the same weight of
dark as every other form label in the app. That is the point of the change.

**One thing deliberately NOT moved.** The family-settings explanatory paragraph
stayed a sibling of the `Field` rather than becoming its `hint`. `Field` renders
`hint` *inside* the `<label>` that wraps the control, so a hint joins the input's
accessible name — right for a short instruction, wrong for two sentences of
policy prose. There is a comment at the call site saying so.

### Accessibility — six icons that had never been through the rule

`SHADCN-UI.md` §8 has said "decorative icons carry `aria-hidden`" since Q5, and
every screen obeys it. The new test checked the claim across all of `src/` and
found **six lucide glyphs without it**, all inside stock registry files that
were vendored after that convention was written: `checkbox.tsx`, `dialog.tsx`,
`dropdown-menu.tsx` ×3 and `sheet.tsx`. They carry it now.

Real effect: the dialog and sheet close buttons are named by an `sr-only`
"Close" and were fine, but the dropdown's check, circle and chevron markers sit
inside menu items whose names come from their text content.

### Added

`scripts/ui-primitives.test.mjs` — 13 tests, `npm run test:ui-primitives`, and
picked up by `npm run test:all` automatically.

---

## 8. `Select` — the naming conclusion

**Not renamed, and that is the finding, not an omission.**

Q14 flagged that `Select` in the product layer is a native `<select>` while
`ui/select.tsx` was a Radix listbox — two different things under one name.
Deleting the unused one **removes the collision completely**: there is now
exactly one `Select` in the codebase and nothing to disambiguate it from.
Renaming to `NativeSelect` would have touched 11 call sites across 8 files to
solve a problem that a deletion had already solved.

What it got instead is a doc comment at its export saying what it is and why,
and a test that renders it and fails unless a real `<select>` comes out.

---

## 9. The icon conclusion

**One icon source: `lucide-react`. One catalogue over it: `icons.tsx`.**

`icons.tsx` draws nothing. It imports 25 lucide glyphs, wraps each in the app's
defaults (20px, 1.8 stroke, always `aria-hidden`) and re-exports them as
`Icon*`. The only non-lucide glyphs it exports are the four festive ornaments,
which lucide has no equivalent for.

**Not consolidated further, deliberately.** 24 files import lucide directly and
12 use the catalogue. Forcing the 24 onto the catalogue would mean adding ~15
wrapper exports and would *lose* information: those call sites size their glyphs
13–28px at 1.6–2.2 stroke, all chosen optically against the text beside them.
The catalogue exists to make a shared vocabulary consistent, not to make every
icon in the app the same size.

The invariant that matters is `aria-hidden`, and that is now enforced on every
lucide element in `src/` rather than on the catalogue alone.

---

## 10. Modal / focus architecture

- **One focus trap mechanism**: Radix. `Modal`, `ConfirmDialog`, `Sheet`, the
  command palette, the account menu, the filter popover and the notification
  bell all resolve to it.
- **One Escape mechanism**: Radix's `onEscapeKeyDown`, with two deliberate
  vetoes — `ConfirmDialog` ignores Escape while `busy`, and `Modal`/`Sheet`
  ignore it when `dismissible` is false.
- **Focus return** is Radix's where a `DialogTrigger` exists (the bell) and
  `useReturnFocus()` where the dialog is rendered conditionally with no trigger
  (`Modal`, `Sheet`, `ConfirmDialog`).
- **No hand-written Tab cycling or Escape handler survives anywhere.** The only
  global keydown listener in the app is the command palette's ⌘K.
- **No second hidden modal tree.** Q13's `matchMedia` + `useSyncExternalStore`
  breakpoint read means the bell builds one `Dialog.Content`, never two.

Q13's notification focus behaviour was not regressed — `test:polish` 16/16 and
`test:notification-centre` still pass, and it was re-verified live.

---

## 11. Handed to Q17 (not touched here)

- **Five starter SVGs in `public/`** — `file.svg`, `globe.svg`, `next.svg`,
  `vercel.svg`, `window.svg`, referenced nowhere. Assets, not primitives.
- **The three `*-taylor*` operator scripts** — Q14 unknown, still open; needs
  the user, not a grep.
- Nothing else. No non-UI dead code was removed in this phase.

---

## 12. Justified exceptions that remain

Every one is deliberate, and each now has a test holding it rather than only a
paragraph:

1. `global-error.tsx`'s raw `<button>` — cannot depend on the design system.
2. `MoneyInput`'s bare `<input>` — the wrapper wears the focus ring so the £
   prefix sits inside it.
3. `command-search.tsx`'s borderless input — the palette's own search line.
4. Four `sr-only` file inputs in the photo components.
5. Eleven native `<label>`s wrapping canonical controls where `Field`'s
   typography is wrong for the context.
6. `Select` is native, on purpose.
7. No toast library — the feedback pattern is the inline, already-announced
   `Notice`.
8. `festive/*` — product illustration.
