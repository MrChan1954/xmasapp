import "server-only";

import { resolveRequestOrigin } from "@/lib/request-origin";

/**
 * The origin the browser used to reach us, derived from this request.
 *
 * All of the rules live in `resolveRequestOrigin` so they stay unit-testable;
 * this wrapper only supplies the server-side inputs. `NODE_ENV` is read here
 * rather than captured at module scope so the value always reflects the runtime
 * the request is actually served by.
 *
 * Each environment read is written as a literal `process.env.X` member
 * expression on purpose: that is the form the compiler can inline into a server
 * bundle. A dynamic read (`process.env[name]`) would arrive as `undefined`.
 */
export function getRequestOrigin(request: Request) {
  return resolveRequestOrigin({
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL,
    forwardedHost: request.headers.get("x-forwarded-host"),
    host: request.headers.get("host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    isDevelopment: process.env.NODE_ENV === "development",
  });
}

/**
 * WHETHER THIS STATE-CHANGING REQUEST CAME FROM ONE OF OUR OWN PAGES.
 *
 * A second lock, never the first one: every route that asks this is also
 * authorised by the database, which refuses the caller on its own terms
 * whatever the origin header says. What this stops is the shape the database
 * cannot see -- another site quietly POSTing with somebody's session cookies
 * attached, so a request they never made arrives looking exactly like one they
 * did.
 *
 * A MISSING ORIGIN IS A REFUSAL. Browsers send `Origin` on every POST and PUT,
 * so an absent one is not an ordinary page; treating it as trustworthy would
 * make the check optional for anybody who simply left it out.
 *
 * One helper rather than one per route, because three copies of a security
 * check are three chances for one of them to be subtly different.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === getRequestOrigin(request);
  } catch {
    return false;
  }
}
