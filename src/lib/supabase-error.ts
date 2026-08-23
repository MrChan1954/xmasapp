/**
 * Turning a Supabase failure into something a person can act on.
 *
 * WHY THIS EXISTS
 *   Two live regressions in Checkpoint 4.1 were reported as "it did not work".
 *   Both had failed for a specific reason the database had already given us --
 *   and both screens had thrown that reason away, keeping only `error.message`.
 *   A message alone cannot distinguish "you are not an admin" (42501) from "the
 *   API has not seen this function yet" (PGRST202) from "the browser could not
 *   reach the server at all", and those need three different responses.
 *
 *   So: every failure keeps its code, and every screen shows it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not translate, soften or swallow. A database exception raised by
 *   one of our own SECURITY DEFINER functions is already written for the person
 *   reading it -- "This event has 4 purchases and cannot be deleted. Archive it
 *   instead." -- and rewriting that here would lose the only accurate sentence
 *   in the chain.
 */

/** The shape supabase-js returns on `{ data, error }`. */
export type SupabaseErrorLike = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
} | null | undefined;

/**
 * One line, suitable for a Notice.
 *
 * The database's own sentence comes first, because when it is one of ours it is
 * the most useful thing on the screen. The code follows in brackets so it can
 * be read out, searched for, or quoted in a bug report.
 */
export function describeSupabaseError(error: SupabaseErrorLike, fallback: string): string {
  if (!error) return fallback;

  const message = typeof error.message === "string" ? error.message.trim() : "";
  const hint = typeof error.hint === "string" ? error.hint.trim() : "";
  const details = typeof error.details === "string" ? error.details.trim() : "";
  const code = typeof error.code === "string" ? error.code.trim() : "";

  // `details` is usually the more specific of the two when both are present,
  // and PostgREST puts its "did you mean" guidance in `hint`.
  const body = message || details || hint || fallback;
  const extra = message && hint && hint !== message ? ` ${hint}` : "";

  return code ? `${body}${extra} (${code})` : `${body}${extra}`;
}

/**
 * The same, for something that was thrown rather than returned.
 *
 * A `fetch` that never reaches the server rejects instead of resolving with an
 * `{ error }`, and an uncaught rejection inside a click handler is how a screen
 * ends up silently doing nothing. Every call site that can throw routes through
 * here so the reader is told, rather than left looking at an unchanged page.
 */
export function describeThrown(thrown: unknown, fallback: string): string {
  if (thrown && typeof thrown === "object" && ("message" in thrown || "code" in thrown)) {
    return describeSupabaseError(thrown as SupabaseErrorLike, fallback);
  }
  if (typeof thrown === "string" && thrown.trim()) return thrown.trim();
  return fallback;
}
