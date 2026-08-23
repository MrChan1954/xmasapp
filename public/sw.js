/*
 * Service worker for the Christmas budget app.
 *
 * This app shows shared, live financial data — balances, purchases, Owed
 * figures — and receives Supabase Realtime updates. Serving any of that from a
 * cache would mean showing someone a number that is no longer true, so this
 * worker is deliberately as small as it can be while still doing its job.
 *
 * WHAT IT CACHES
 *   Only immutable, content-hashed build output under /_next/static/, plus the
 *   offline page. A hashed URL always names one exact set of bytes, so a cached
 *   copy of one can never be stale.
 *
 *   The icons are deliberately NOT cached: they are not content-hashed, so a
 *   cached copy would outlive a regeneration until CACHE_VERSION changed. They
 *   also gain nothing from it — a home-screen icon is fetched by the operating
 *   system's install machinery, which does not go through this worker, and the
 *   offline page inlines its own mark.
 *
 * WHAT IT NEVER TOUCHES — these are passed through untouched, with no
 * respondWith at all, so the browser handles them exactly as it would with no
 * service worker installed:
 *   - any request that is not GET
 *   - any cross-origin request (all Supabase REST and Realtime traffic)
 *   - anything under /api/
 *   - HTML documents / navigations, which always go to the network
 *
 * WHY STALE DATA IS IMPOSSIBLE
 *   Financial values only ever arrive via Supabase (cross-origin) or /api/
 *   (excluded). Neither is ever read from or written to a cache.
 *
 * WHY YOU CANNOT GET STUCK ON AN OLD VERSION
 *   HTML is never cached, so every load fetches the current document, which
 *   references the current hashed asset URLs. A deploy therefore takes effect
 *   on the next load. CACHE_VERSION additionally purges old caches on activate,
 *   and skipWaiting + clients.claim stop a new worker waiting behind an old tab.
 *
 *   That covers this worker's cache. The HTTP cache is handled alongside it:
 *   documents are served `Cache-Control: no-cache` (see `next.config.ts`), and
 *   `pwa-runtime.tsx` re-checks this script whenever the app returns to the
 *   foreground. Both exist because an installed app has no reload button — a
 *   browser tab can always be pulled to refresh, a home-screen app cannot.
 */

// Bumped from v1: the v1 cache holds an offline entry stored by `cache.add`,
// which followed the host's `/offline.html` -> `/offline` redirect and so
// carries the redirected flag. Returning such a response from `respondWith`
// for a navigation is a TypeError, which made the offline fallback throw
// instead of render. Renaming the cache drops those entries on activate.
const CACHE_VERSION = "v2";
const CACHE_NAME = `xmas-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

/**
 * Put the offline fallback in place before anything needs it. It is the only
 * precached file, and the only cached thing that is not content-hashed.
 *
 * `cache.add` is deliberately NOT used. Cloudflare's asset handler answers
 * `/offline.html` with a 307 to the extensionless `/offline`; `cache.add`
 * follows that and stores a response whose `redirected` flag is set, and the
 * one place this file is ever used — `respondWith` for a navigation — rejects
 * a redirected response outright. Re-wrapping the body in a fresh Response
 * clears the flag, so the fallback works whatever the host does with `.html`.
 */
async function precacheOfflinePage() {
  // `cache: "reload"` so a stale HTTP-cached copy cannot be frozen into Cache
  // Storage until CACHE_VERSION changes again.
  const response = await fetch(OFFLINE_URL, { cache: "reload", redirect: "follow" });
  if (!response.ok) return;

  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    OFFLINE_URL,
    new Response(await response.blob(), {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
}

self.addEventListener("install", (event) => {
  // A failed precache must not fail the install: the worker's main job is the
  // static-asset cache, and the site works fully without an offline page.
  event.waitUntil(
    precacheOfflinePage()
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Content-hashed build output only: a changed file always gets a new URL. */
function isCacheableAsset(url) {
  return url.pathname.startsWith("/_next/static/");
}

/* ===========================================================================
 * PUSH NOTIFICATIONS
 *
 * Added alongside the caching above, not in place of it. Nothing below reads
 * or writes Cache Storage, and nothing above changed: `fetch` still sends every
 * document to the network and still caches only hashed build output.
 *
 * A push message is an ALERT, never a data channel. The payload carries only
 * what the notification displays plus the route to open. It is never treated as
 * app state — opening the app runs the normal Supabase load, so what appears on
 * screen is always fetched fresh through RLS rather than taken from a message
 * that could be minutes old. Realtime keeps its own job of updating open tabs.
 * =========================================================================== */

const NOTIFICATION_ICON = "/icons/icon-192.png";
const NOTIFICATION_BADGE = "/icons/badge-96.png";

/**
 * Reduce a payload's `url` to an in-app path, or fall back to the home route.
 *
 * Payloads are generated by the server and are already restricted to real
 * routes, so this is defence in depth — but it is worth having, because the one
 * thing a tap must never do is leave the app. A `startsWith("/")` test is not
 * enough on its own: `//evil.example.com` passes it and then resolves to a
 * completely different origin, so the resolved origin is what gets checked.
 */
function sameOriginPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  try {
    const resolved = new URL(value, self.location.origin);
    return resolved.origin === self.location.origin ? resolved.pathname + resolved.search : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  // A push with no readable payload still has to show something: Chrome and
  // Firefox both display a generic "site updated in the background" notice if a
  // push event ends without showNotification, which would look like a bug.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === "string" && payload.title ? payload.title : "Family Gift Planner";
  const body = typeof payload.body === "string" ? payload.body : "";
  const url = sameOriginPath(payload.url);

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: NOTIFICATION_ICON,
      // Monochrome silhouette Android draws in the status bar. Ignored
      // elsewhere; without it Android substitutes a generic dot.
      badge: NOTIFICATION_BADGE,
      // Same tag replaces rather than stacks, so a phone that was asleep through
      // three balance changes wakes to one current figure.
      tag: typeof payload.tag === "string" && payload.tag ? payload.tag : "christmas-budget",
      // Replacing quietly: a re-alert for a figure the user has already seen is
      // exactly the kind of noise this app should not make.
      renotify: false,
      // Only what notificationclick needs. No ids, tokens or session material.
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Re-checked here rather than trusted from the notification: `data` was set
  // when the notification was shown, possibly by an older worker version.
  const target = new URL(
    sameOriginPath(event.notification.data && event.notification.data.url),
    self.location.origin,
  );

  event.waitUntil(
    self.clients
      // `includeUncontrolled` matters: a window opened before this worker took
      // control is still the user's open copy of the app, and opening a second
      // one on top of it is exactly the annoyance this handler exists to avoid.
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (new URL(client.url).origin !== self.location.origin) continue;
          // Focus the copy that is already open, then move it to the right
          // screen. `navigate` is not implemented everywhere, so a failure
          // falls back to focusing what is there rather than losing the tap.
          return client
            .focus()
            .then((focused) => (focused && focused.navigate ? focused.navigate(target.href) : focused))
            .catch(() => client.focus());
        }
        // Nothing open: launch the installed app, or a tab if it is not
        // installed. Both land on the same in-app route.
        return self.clients.openWindow(target.href);
      }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Not ours to handle. Returning without respondWith leaves the request
  // entirely to the browser.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // `/auth/` is excluded alongside `/api/`: those routes redirect as part of the
  // Supabase email-link flow, and an offline page there would be meaningless.
  // Nothing about signing in should pass through this worker.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Navigations: always the network, so the app and its data are current. The
  // cache is consulted only when the network actually fails, and then only to
  // show a static "no connection" page that contains no data.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL, { cacheName: CACHE_NAME }).then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }

  if (!isCacheableAsset(url)) return;

  // Cache-first is safe here precisely because these URLs are content-hashed:
  // a changed file gets a new URL, so a hit is always the right bytes.
  event.respondWith(
    caches.match(request, { cacheName: CACHE_NAME }).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.status === 200) {
          const copy = response.clone();
          // waitUntil, not a floating promise: the worker can be terminated as
          // soon as the response is returned, losing the write.
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      });
    }),
  );
});
