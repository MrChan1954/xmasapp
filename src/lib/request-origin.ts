// host[:port], or a bracketed IPv6 literal. Anything else is not a host we will
// echo back into a URL.
const HOST_PATTERN = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/;

// Hosts that can only ever mean "this machine", where plain HTTP is the honest
// answer even in a built server. Matched exactly, never by prefix: a prefix test
// also accepts `localhost.attacker.example`.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type RequestOriginInput = {
  /** `APP_ORIGIN` / `NEXT_PUBLIC_APP_URL`, when either is configured. */
  configuredOrigin?: string | null;
  forwardedHost?: string | null;
  host?: string | null;
  forwardedProto?: string | null;
  /**
   * `NODE_ENV === "development"`. Opt-in to one known value rather than opt-out
   * of "production", so an unset or unexpected `NODE_ENV` fails closed to the
   * `https` fallback instead of relaxing it.
   */
  isDevelopment?: boolean;
};

export function firstHeaderValue(value: string | null | undefined) {
  // x-forwarded-* may carry a comma-separated chain; the first entry is the
  // value the original client saw.
  return value?.split(",")[0]?.trim() || null;
}

function isLoopbackHost(host: string) {
  return LOOPBACK_HOSTS.has(host.replace(/:\d{1,5}$/, "").toLowerCase());
}

/**
 * The origin the browser used to reach us.
 *
 * `APP_ORIGIN` / `NEXT_PUBLIC_APP_URL` win when set, and setting one in
 * production is recommended: it is the only source an attacker cannot influence,
 * and this value is used to build the password-setup and recovery links that get
 * emailed to people.
 *
 * Otherwise derive it from the forwarded/Host headers. `request.url` is NOT a
 * usable fallback here — Next builds it from the address the server is bound to,
 * so a dev server listening on 0.0.0.0 reports `http://0.0.0.0:3000` no matter
 * which host the browser actually asked for. That mismatch fails the same-origin
 * check on every admin POST.
 *
 * Trusting Host for the same-origin comparison is sound: CSRF is a browser
 * attack, and a browser always sets Host to the real target while setting Origin
 * to the attacker's site. Forging Host requires a non-browser client, which has
 * no victim cookies to ride on in the first place. This is the same signal
 * Next.js itself compares for Server Action origin checks.
 *
 * Scheme: an `x-forwarded-proto` from a real proxy always wins. Without one we
 * fall back to `https`, because a deployed app is served over TLS. Under
 * `next dev` we fall back to `http` instead, because the dev server serves plain
 * HTTP on every address it binds — including a LAN address such as
 * `192.168.0.11:3000`, which is not loopback but is still http. Assuming `https`
 * there produced an origin the browser never used, so every admin POST from
 * another device on the network was rejected. `isDevelopment` comes from
 * `NODE_ENV`, which no request can influence, so the relaxation cannot reach a
 * built server.
 *
 * This is still a real same-origin check in development, not a bypass: `Origin`
 * must equal `scheme://host` exactly, so a page on `http://evil.test` is still
 * rejected. Only one side of the comparison was wrong.
 */
export function resolveRequestOrigin(input: RequestOriginInput) {
  if (input.configuredOrigin) {
    try {
      const configuredUrl = new URL(input.configuredOrigin);
      if (
        (configuredUrl.protocol === "http:" || configuredUrl.protocol === "https:") &&
        !configuredUrl.username &&
        !configuredUrl.password
      ) {
        return configuredUrl.origin;
      }
    } catch {
      // Fall through to the request headers below.
    }
  }

  const host = firstHeaderValue(input.forwardedHost) ?? firstHeaderValue(input.host);
  if (!host || !HOST_PATTERN.test(host)) {
    throw new Error("The request host is missing or malformed.");
  }

  const forwardedProto = firstHeaderValue(input.forwardedProto);
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : isLoopbackHost(host) || input.isDevelopment === true
      ? "http"
      : "https";

  return `${protocol}://${host}`;
}
