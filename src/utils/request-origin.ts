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
