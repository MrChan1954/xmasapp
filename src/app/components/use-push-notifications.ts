"use client";

import { useCallback, useEffect, useState } from "react";
import { base64UrlToBytes } from "@/lib/web-push";

/**
 * Everything the Notifications screen needs to describe, enable and disable
 * push on the device it is running on.
 *
 * NOTHING HERE RUNS ON ITS OWN. Permission is requested only inside `enable`,
 * which only ever runs from a click. The effect below reads
 * `Notification.permission` and asks the service worker whether a subscription
 * already exists, both of which are passive: neither shows a prompt. A browser
 * permission prompt that appears without the user asking for it is the fastest
 * way to get notifications blocked forever, and on iOS `requestPermission`
 * outside a user gesture is rejected outright.
 */
export type PushState =
  /** Still working out where we are. */
  | "checking"
  /** No Push API — an iOS browser that is not an installed app, or an old one. */
  | "unsupported"
  /** iOS/iPadOS Safari in a normal tab: supported, but only once installed. */
  | "needs-install"
  /** Permission denied at the browser or OS level; we cannot re-ask. */
  | "blocked"
  /** Supported and permitted, but this device is not subscribed. */
  | "disabled"
  /** Subscribed and stored on the server. */
  | "enabled";

export type PushStatus = {
  state: PushState;
  /** How many of the member's devices are registered, this one included. */
  deviceCount: number;
  /**
   * How many OTHER members have push switched on somewhere. A count only — no
   * names, no devices.
   *
   * Surfaced because of a real failure: every registered device belonged to one
   * person, so every notification they triggered was correctly suppressed by
   * actor exclusion and reached nobody, while the page cheerfully said
   * "Enabled". Knowing nobody else can receive anything is the difference
   * between a broken system and an empty one.
   */
  otherMembersWithPush: number;
  busy: boolean;
  error: string | null;
};

const SUBSCRIBE_ENDPOINT = "/api/notifications/subscribe";

export function usePushNotifications(isIosSafari: boolean, isInstalled: boolean) {
  const [status, setStatus] = useState<PushStatus>({
    state: "checking",
    deviceCount: 0,
    otherMembersWithPush: 0,
    busy: false,
    error: null,
  });

  /**
   * Work out the current state without prompting for anything.
   *
   * The server is asked whether it still holds this browser's endpoint, because
   * the two can disagree: clearing site data drops the browser's subscription
   * while the row survives, and a row deleted after a push service reported it
   * dead leaves a subscription the server no longer knows about. The server's
   * answer wins, and `enable` re-registers either way.
   */
  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;

    // Checked BEFORE feature detection, not after. iOS gained Web Push in 16.4
    // but only for Home Screen apps, and Safari's behaviour in a normal tab has
    // varied by version — sometimes the APIs are absent, sometimes they are
    // present and every call fails. Either way the answer is the same and it is
    // never "your browser does not support this": install it first.
    if (isIosSafari && !isInstalled) {
      setStatus({ state: "needs-install", deviceCount: 0, otherMembersWithPush: 0, busy: false, error: null });
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setStatus({ state: "unsupported", deviceCount: 0, otherMembersWithPush: 0, busy: false, error: null });
      return;
    }

    if (Notification.permission === "denied") {
      setStatus({ state: "blocked", deviceCount: 0, otherMembersWithPush: 0, busy: false, error: null });
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      const response = await fetch(SUBSCRIBE_ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ endpoint: subscription?.endpoint ?? null }),
      });
      const body = response.ok
        ? await response.json()
        : { thisDeviceRegistered: false, deviceCount: 0, otherMembersWithPush: 0 };

      setStatus({
        state: subscription && body.thisDeviceRegistered ? "enabled" : "disabled",
        deviceCount: typeof body.deviceCount === "number" ? body.deviceCount : 0,
        otherMembersWithPush: typeof body.otherMembersWithPush === "number" ? body.otherMembersWithPush : 0,
        busy: false,
        error: null,
      });
    } catch {
      setStatus({ state: "disabled", deviceCount: 0, otherMembersWithPush: 0, busy: false, error: null });
    }
  }, [isIosSafari, isInstalled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * The deliberate action: ask for permission, subscribe, store the result.
   *
   * Must be called straight from a click handler. Safari requires the
   * permission request to happen inside the user gesture, so nothing may be
   * awaited before `requestPermission`.
   */
  const enable = useCallback(async () => {
    setStatus((current) => ({ ...current, busy: true, error: null }));
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus({
          state: permission === "denied" ? "blocked" : "disabled",
          deviceCount: 0,
          otherMembersWithPush: 0,
          busy: false,
          error: null,
        });
        return;
      }

      const keyResponse = await fetch("/api/notifications/key", { cache: "no-store" });
      if (!keyResponse.ok) throw new Error("Notifications are not set up on the server yet.");
      const { publicKey } = await keyResponse.json();

      const registration = await navigator.serviceWorker.ready;
      // Reuse an existing subscription when there is one: re-subscribing would
      // mint a new endpoint and orphan the stored row.
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({
          // Every browser that implements Web Push requires an encrypted
          // payload, so this is not optional.
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        });

      const json = subscription.toJSON();
      const response = await fetch(SUBSCRIBE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          p256dh: json.keys?.p256dh,
          auth: json.keys?.auth,
          platform: detectPlatform(),
        }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error ?? "This device could not be registered.");
      }

      await refresh();
    } catch (error) {
      setStatus((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "Notifications could not be turned on.",
      }));
    }
  }, [refresh]);

  /**
   * Turn this device off, and only this device.
   *
   * The browser subscription is dropped and the server row deleted, leaving
   * every other device the member has registered untouched — the whole reason
   * subscriptions are stored per device rather than per person.
   */
  const disable = useCallback(async () => {
    setStatus((current) => ({ ...current, busy: true, error: null }));
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Tell the server first: once `unsubscribe()` resolves the endpoint is
        // gone from this browser and the row could never be matched again.
        await fetch(SUBSCRIBE_ENDPOINT, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }

      await refresh();
    } catch (error) {
      setStatus((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "Notifications could not be turned off.",
      }));
    }
  }, [refresh]);

  return { status, enable, disable };
}

/**
 * A coarse platform bucket, used only to label the device in the member's own
 * settings ("iPhone or iPad"). Never an identifier: no user agent string, no
 * version, no fingerprint is sent or stored.
 */
function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh/.test(ua)) return "mac";
  return "other";
}
