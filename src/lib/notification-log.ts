/**
 * Safe structured logging for the notification pipeline.
 *
 * The whole reason push failed silently for so long is that nothing in the send
 * path ever said anything. `notifyFamily` swallows errors by design (a saved
 * purchase must not fail because a phone could not be reached), the dispatcher
 * returned a count nobody read, and the push service's HTTP status was thrown
 * away. So there was no way to tell "nobody is subscribed" apart from "the
 * encryption is wrong" apart from "the key is missing".
 *
 * These lines land in `wrangler tail` / the Cloudflare dashboard.
 *
 * WHAT MAY NEVER BE LOGGED — a Worker log is readable by anyone with dashboard
 * access and is retained by a third party:
 *   - the VAPID private key, or any part of it
 *   - a subscription's `auth` secret or `p256dh` key
 *   - the Supabase secret key or any access token
 *   - a complete push endpoint URL (its path identifies a specific device)
 *   - notification body text, which quotes real money and real names
 *
 * Only the push service's HOSTNAME is recorded, never the path.
 */

export type NotificationLogFields = {
  stage: string;
  kind?: string;
  /** Members the event was planned for. */
  recipients?: number;
  /** Device rows found for those members. */
  subscriptions?: number;
  /** Push service hostname only — never the endpoint path. */
  pushHost?: string;
  /** The real HTTP status from the push service. */
  status?: number;
  outcome?: string;
  deduplicated?: boolean;
  suppressedByPreference?: number;
  removedInvalid?: number;
  inAppCreated?: number;
  delivered?: number;
  failed?: number;
  reason?: string;
};

export function logNotification(fields: NotificationLogFields): void {
  // One line, one JSON object: greppable in `wrangler tail`, and impossible to
  // accidentally interpolate a secret into by string concatenation.
  console.log(`[notifications] ${JSON.stringify(fields)}`);
}

/**
 * The push service's hostname, for logs.
 *
 * The path of a push endpoint is a per-device bearer token — anyone holding it
 * can send that device notifications — so it must never reach a log line.
 */
export function pushServiceHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid-endpoint";
  }
}

/**
 * Plain-language reading of a push service's HTTP status, for diagnostics shown
 * to the signed-in user by "Send test notification".
 *
 * Deliberately actionable: the point is to tell someone whether the problem is
 * their device, their configuration, or the push service being down.
 */
export function describePushStatus(status: number): string {
  if (status === 201 || status === 202 || status === 200) return "Accepted by the push service.";
  if (status === 400) return "The push service rejected the request as malformed.";
  if (status === 401 || status === 403) {
    return "The push service rejected this app's notification keys. The VAPID keys on the server may not match the ones this device subscribed with.";
  }
  if (status === 404 || status === 410) {
    return "This device's subscription has expired. Turn notifications off and on again to re-register it.";
  }
  if (status === 413) return "The notification was too large to send.";
  if (status === 429) return "The push service is rate limiting this app. Try again shortly.";
  if (status >= 500) return "The push service is having problems. Try again shortly.";
  if (status === 0) return "The push service could not be reached.";
  return `The push service returned an unexpected response (${status}).`;
}
