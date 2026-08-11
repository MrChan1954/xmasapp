import "server-only";

<<<<<<< HEAD
export function getRequestOrigin(request: Request) {
  const configuredOrigin = process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL;
  if (configuredOrigin) {
    try {
      const configuredUrl = new URL(configuredOrigin);
      if (
        (configuredUrl.protocol === "http:" || configuredUrl.protocol === "https:") &&
        !configuredUrl.username &&
        !configuredUrl.password
      ) {
        return configuredUrl.origin;
      }
    } catch {
      // Fall back to the framework-normalized request URL below.
    }
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
    throw new Error("The request origin is not HTTP or HTTPS.");
  }
  return requestUrl.origin;
=======
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
 * expression on purpose: this module is pulled into the proxy bundle through
 * `src/utils/supabase/proxy.ts`, and that is the form the compiler can inline.
 * A dynamic read would arrive as `undefined`.
 */
export function getRequestOrigin(request: Request) {
  return resolveRequestOrigin({
    configuredOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL,
    forwardedHost: request.headers.get("x-forwarded-host"),
    host: request.headers.get("host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    isDevelopment: process.env.NODE_ENV === "development",
  });
>>>>>>> 7534a2d (redesign and realtime)
}
