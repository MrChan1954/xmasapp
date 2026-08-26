/*
 * NO "use client" DIRECTIVE, deliberately, for the same reason
 * `current-member-client.ts` has none: a module marked "use client" turns every
 * export into a client reference and a server module that calls one throws at
 * render. This is browser code by virtue of reading `document.cookie` and
 * calling `fetch`, and it guards those rather than announcing itself.
 */
import { areaFromRow, resolveActiveArea } from "@/lib/areas";
import { createClient } from "./client";
import { rememberedAreaId } from "./current-member-client";

export type AreaChoiceOutcome =
  /** A family has just been chosen and remembered. The caller must RELOAD:
   *  every read from here on has to carry the new Area. */
  | "chosen"
  /** A choice was already made, or could not be written. Nothing changed. */
  | "unchanged"
  /** This login belongs to no family at all. Not a lockout -- a new account. */
  | "none";

/**
 * MAKE SURE THE BROWSER HAS CHOSEN A FAMILY.
 *
 * THE BUG THIS EXISTS FOR -- signing in and being signed straight back out.
 *
 * Three rules, each correct, catastrophic together:
 *
 *   1. `getCurrentMember` answers NOTHING for a login that belongs to several
 *      families and has not said which. Migration 038 does the same in the
 *      database, and for a good reason: picking one at random would show
 *      somebody the wrong family's people, money and history.
 *   2. `FamilyProvider` treats "no membership" as "your access was revoked",
 *      signs the session out and sends the reader to
 *      `/login?error=access_denied`.
 *   3. NOTHING IN THE SIGN-IN PATH EVER WROTE THE COOKIE. It was only ever
 *      written by the switcher, by creating a family, and -- until this
 *      checkpoint -- deleted outright on leaving one.
 *
 * So an account in two or more families with no `gp_area` cookie could not stay
 * signed in for the length of one render. A new browser, a cleared cookie, a
 * private window, a second device, a cookie that simply expired, or leaving a
 * family: every one of them ended in a sign-in screen that signed you out
 * again, for ever, with no way out from inside the app.
 *
 * THE FIX IS NOT TO LET THE APP GUESS. Rule 1 stays exactly as it is, because
 * it is what keeps two families apart. What was missing is that "no choice yet"
 * is not "no access": it is a question nobody had asked. This asks it, writes
 * the answer where every later request will find it, and leaves the refusal
 * intact for the case it was written for.
 *
 * The choice is `resolveActiveArea` -- live families before archived ones, then
 * alphabetically -- so it is the same family the switcher would have shown, the
 * same on every device, and the same on the next sign-in.
 *
 * IT WIDENS NOTHING. The list comes from `areas`, whose only policy is
 * `is_area_member(id)`, so it holds this login's own families and cannot be
 * made to hold anybody else's. Choosing among them decides what is DISPLAYED;
 * the database still authorises every row independently, and
 * `claim_active_area` re-checks the membership table before it believes the
 * header this cookie becomes.
 */
export async function ensureAreaChosen(): Promise<AreaChoiceOutcome> {
  const db = createClient();
  const { data, error } = await db.from("areas").select("id,name,archived_at");
  if (error) return "unchanged";

  const areas = (data ?? []).map(areaFromRow);
  if (areas.length === 0) return "none";

  const remembered = rememberedAreaId();
  const chosen = resolveActiveArea(areas, remembered);
  if (!chosen) return "none";

  /*
   * THE LOOP GUARD. If the cookie already names a family this login is really
   * in and a membership still would not resolve, writing the same value again
   * and reloading would spin for ever. `is_area_member` requires an ACTIVE
   * membership and `areas` is behind it, so this cannot happen -- which is
   * exactly why it is worth refusing to act on: something further upstream is
   * wrong, and a reload loop would hide it.
   */
  if (chosen.id === remembered) return "unchanged";

  const response = await fetch("/api/areas", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ areaId: chosen.id }),
  });
  return response.ok ? "chosen" : "unchanged";
}
