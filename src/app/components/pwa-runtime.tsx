"use client";

import { useEffect } from "react";
import { watchInstallPrompt } from "./use-pwa-install";

/**
 * The two pieces of PWA plumbing that must be running before any page needs
 * them, mounted once from the root layout.
 *
 * Registering `/sw.js` is what lets Chromium offer a native install prompt —
 * see that file for what it does and does not cache. `watchInstallPrompt`
 * catches `beforeinstallprompt`, which fires once shortly after the first load;
 * the More page mounts far too late to catch it itself.
 *
 * Renders nothing and never blocks: the site works fully without either.
 */
export function PwaRuntime(): null {
  useEffect(() => {
    // Deliberately not production-gated. The event is harmless to hold, and
    // gating it would make the install button untestable in a local production
    // build.
    watchInstallPrompt();
  }, []);

  useEffect(() => {
    // In development a service worker only gets in the way of hot reloading —
    // and a LAN address over plain http is not a secure context anyway.
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // Assigned by `register`, removed on unmount whichever path ran.
    let checkForUpdate: (() => void) | undefined;

    const register = () => {
      // `updateViaCache: "none"` stops the browser serving the worker script
      // itself from the HTTP cache, so a deploy is picked up promptly.
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => {
          /**
           * An installed app is a long-lived Android task: tapping the home
           * screen icon usually resumes the existing task rather than starting
           * a fresh navigation, and there is no reload button to force one. So
           * ask the browser to re-check `/sw.js` every time the app is brought
           * back to the foreground. A deploy then installs its new worker —
           * which purges the previous cache generation on activate — without
           * waiting for the user to happen to navigate.
           *
           * Deliberately no automatic `location.reload()` on `controllerchange`:
           * this app has purchase and payment forms, and reloading underneath
           * someone mid-entry would lose their input. Documents are network-only
           * in the worker and `no-cache` over HTTP, so the next navigation picks
           * the new build up on its own.
           */
          checkForUpdate = () => {
            if (document.visibilityState !== "visible") return;
            void registration.update().catch(() => {});
          };
          document.addEventListener("visibilitychange", checkForUpdate);
        })
        .catch(() => {
          // An unavailable service worker must never break the app: everything
          // here is an enhancement, and the site works fully without it.
        });
    };

    // Deferred to `load` so registration never competes with the first paint or
    // the initial Supabase requests.
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
    }

    return () => {
      window.removeEventListener("load", register);
      if (checkForUpdate) document.removeEventListener("visibilitychange", checkForUpdate);
    };
  }, []);

  return null;
}
