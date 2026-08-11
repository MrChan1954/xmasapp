"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * `false` on the server and during the first client render, `true` afterwards.
 *
 * Used by controls that cannot know their state until hydration (the theme
 * toggle), so the markup React renders on the client first matches the server.
 */
export function useMounted() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
