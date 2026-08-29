/**
 * Class-name joiner.
 *
 * Lives in its own module (no "use client") so server components can call it —
 * a plain function exported from a client module becomes a client reference and
 * cannot be invoked during server render. `ui/index.tsx` re-exports it, so the
 * existing `import { cx } from "./ui"` call sites are unaffected.
 *
 * Note this does NOT resolve Tailwind conflicts: later classes do not reliably
 * beat earlier ones. Primitives should express variation through explicit props
 * (`tone`, `size`, `variant`) and treat a passed `className` as layout only —
 * spacing, positioning, visibility — never colour.
 */
export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}
