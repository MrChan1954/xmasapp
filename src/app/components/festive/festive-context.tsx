"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "xmas-snow";
const CHANGE_EVENT = "xmas-snow-change";
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeSnow(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readSnow() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true; // private mode / storage disabled
  }
}

function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia(MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Decorative-motion preferences.
 *
 * Both values come from outside React — localStorage and a media query — so
 * they are read through `useSyncExternalStore` rather than mirrored into state
 * by an effect. The server snapshots are the defaults, which keeps the first
 * client render identical to the server's.
 *
 * `snow` is the raw user choice: reduced motion is enforced in CSS
 * (`.snow { display: none }`), and `reducedMotion` is exposed for the few
 * components that must swap behaviour rather than simply hide.
 */
export function useFestive() {
  const snow = useSyncExternalStore(subscribeSnow, readSnow, () => true);
  const reducedMotion = useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(MOTION_QUERY).matches,
    () => false,
  );

  const setSnow = useCallback((value: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
    } catch {
      /* ignore — the event below still updates this session */
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { snow, setSnow, reducedMotion };
}

/**
 * Kept as a component so the provider tree in the root layout reads the same as
 * the other contexts; `useFestive` needs no provider state of its own.
 */
export function FestiveProvider({ children }: { children: React.ReactNode }) {
  return children;
}
