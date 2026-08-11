"use client";

import { useCallback, useSyncExternalStore } from "react";

/** The non-standard event Chromium fires when it is willing to install the app. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const STANDALONE_QUERY = "(display-mode: standalone)";

/*
 * Chromium fires `beforeinstallprompt` once, moments after the FIRST page load —
 * long before anyone opens More, and it is never re-dispatched for a listener
 * added later. A hook that only listened while its own component was mounted
 * would therefore never see it and the Install button could never appear, so
 * the event is caught once at app start and parked here. The hook is a
 * `useSyncExternalStore` view onto this module, the same shape
 * `festive-context.tsx` uses for its own out-of-React state.
 */
let promptEvent: InstallPromptEvent | null = null;
let watching = false;
const subscribers = new Set<() => void>();

function publish() {
  for (const notify of subscribers) notify();
}

/**
 * Called once from the root layout. The listeners are never removed: they need
 * to live as long as the document, which is exactly the window in which the
 * event can arrive, and re-adding them later could not recover a missed one.
 */
export function watchInstallPrompt() {
  if (watching) return;
  watching = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppresses Chrome's own mini-infobar, so the deliberate button under More
    // stays the only entry point and nothing is ever pushed at the user.
    event.preventDefault();
    promptEvent = event as InstallPromptEvent;
    publish();
  });

  window.addEventListener("appinstalled", () => {
    promptEvent = null;
    publish();
  });
}

function subscribePrompt(onChange: () => void) {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

function subscribeStandalone(onChange: () => void) {
  const query = window.matchMedia(STANDALONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isStandalone() {
  // iOS Safari predates the display-mode media query for home-screen apps and
  // reports this instead, so both have to be checked.
  return (
    window.matchMedia(STANDALONE_QUERY).matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

const noopSubscribe = () => () => {};

function detectIosSafari() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // Chrome, Firefox and Edge on iOS carry their own tokens but are all WebKit.
  return iOS && /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

/**
 * Everything the More page needs to offer installation, and nothing else — no
 * banner, no automatic prompt, no interception of the first visit.
 *
 * Both server snapshots are `false`, so the server renders the same "nothing to
 * offer" state the client starts in and the card can only appear after
 * hydration.
 */
export function usePwaInstall() {
  const installed = useSyncExternalStore(subscribeStandalone, isStandalone, () => false);
  const canPrompt = useSyncExternalStore(subscribePrompt, () => promptEvent !== null, () => false);

  const promptInstall = useCallback(async () => {
    const event = promptEvent;
    if (!event) return;
    // Cleared before awaiting: the event is single-use and calling prompt() twice
    // on the same one throws. Clearing first also hides the button immediately,
    // so a double tap cannot reach here twice.
    promptEvent = null;
    publish();
    await event.prompt();
  }, []);

  return { installed, canPrompt, promptInstall };
}

/**
 * True for iOS/iPadOS Safari, where installation is a manual Share-sheet action
 * that no API can trigger. Used only to decide which help text to show, never to
 * gate functionality. The answer cannot change for the life of the document, so
 * there is nothing to subscribe to — the same shape as `useMounted`.
 */
export function useIsIosSafari() {
  return useSyncExternalStore(noopSubscribe, detectIosSafari, () => false);
}
