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
 */

const CACHE_VERSION = "v1";
const CACHE_NAME = `xmas-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

// The offline fallback has to be in place before it is needed. It is the only
// precached file, and the only cached thing that is not content-hashed.
const PRECACHE = [OFFLINE_URL];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // Individually, so one missing file cannot fail the whole install.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
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
