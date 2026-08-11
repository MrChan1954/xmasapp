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

    const register = () => {
      // `updateViaCache: "none"` stops the browser serving the worker script
      // itself from the HTTP cache, so a deploy is picked up promptly.
      void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
        // An unavailable service worker must never break the app: everything
        // here is an enhancement, and the site works fully without it.
      });
    };

    // Deferred to `load` so registration never competes with the first paint or
    // the initial Supabase requests.
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
