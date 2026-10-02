/**
 * ONE ANSWER FOR A BURST OF IDENTICAL QUESTIONS.
 *
 * A page load in the browser used to ask "who is signed in", "what is this
 * account's status" and "which membership is on screen" five to seven times
 * over: the family context, the account menu, the bell and each screen asked
 * for themselves, mostly one after another. This shares the answer -- the
 * in-flight request, and then its result for a few seconds -- between callers
 * asking the SAME question under the SAME key.
 *
 * NOTHING HERE IS A PERMISSION. It is only used for lookups that decide what
 * the UI shows; every row is still behind row level security, which asks for
 * itself on every request. The key is what keeps it honest: callers put the
 * session token (and, for a membership, the selected Area) in it, so signing
 * in, signing out, a token refresh or switching family is a different key and
 * a fresh answer.
 *
 * A request that FAILS is forgotten at once, so a transient error is never
 * repeated back to the next caller.
 */
export type SharedLookup = <T>(name: string, key: string, run: () => Promise<T>) => Promise<T>;

export function createSharedLookup(shareForMs: number, now: () => number = Date.now): SharedLookup {
  const entries = new Map<string, { key: string; at: number; value: Promise<unknown> }>();

  return function share<T>(name: string, key: string, run: () => Promise<T>): Promise<T> {
    const hit = entries.get(name);
    if (hit && hit.key === key && now() - hit.at < shareForMs) return hit.value as Promise<T>;

    const value = run();
    entries.set(name, { key, at: now(), value });
    value.catch(() => {
      if (entries.get(name)?.value === value) entries.delete(name);
    });
    return value;
  };
}
