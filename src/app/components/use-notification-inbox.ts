"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRealtimeRefresh } from "./use-realtime-refresh";

/**
 * The Notification Centre's data.
 *
 * Kept live by the app's EXISTING Realtime layer — the same
 * `useRealtimeRefresh` every other screen uses — and not by Web Push. Push is
 * an OS alert for when the app is closed; using it to drive UI state would tie
 * the bell to a permission the user may never grant, and would make the count
 * wrong for anyone who declined notifications.
 *
 * Supabase applies each subscriber's RLS SELECT policy before delivering a
 * change, and the policy on `notifications` is `app_member_id =
 * current_app_member_id()`, so a member is only ever woken by their own rows.
 * The event itself is treated as "something changed" and the list is refetched
 * through the authorized route, exactly as the Christmas screens already do.
 */
export type InboxNotification = {
  id: string;
  category: string;
  title: string;
  body: string;
  targetUrl: string;
  readAt: string | null;
  createdAt: string;
};

const INBOX_ENDPOINT = "/api/notifications/inbox";

function useInboxState() {
  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(INBOX_ENDPOINT, { cache: "no-store" });
      if (!response.ok) {
        // A signed-out session or a database that has not had the migration
        // applied yet must not break the header the bell lives in.
        setUnavailable(true);
        return;
      }
      const body = await response.json();
      setNotifications(Array.isArray(body.notifications) ? body.notifications : []);
      setUnreadCount(typeof body.unreadCount === "number" ? body.unreadCount : 0);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred by a tick, the same shape `people/purchases.tsx` uses: the first
    // load must not run synchronously inside the effect, and the bell is chrome
    // that should never delay the page it sits above.
    const handle = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(handle);
  }, [refresh]);

  // One subscription, mounted once with the bell in the persistent app frame,
  // so navigating between screens does not tear it down and rebuild it.
  useRealtimeRefresh(["notifications"], refresh, { enabled: !unavailable });

  /**
   * Optimistic: the badge must drop the instant a notification is opened, or
   * tapping one and watching the count linger reads as a bug. The refetch that
   * follows reconciles with the server.
   */
  const markRead = useCallback(async (id: string) => {
    setNotifications((current) =>
      current.map((row) => (row.id === id && !row.readAt ? { ...row, readAt: new Date().toISOString() } : row)),
    );
    setUnreadCount((current) => Math.max(0, current - 1));

    await fetch(INBOX_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    await refresh();
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setNotifications((current) => current.map((row) => (row.readAt ? row : { ...row, readAt: now })));
    setUnreadCount(0);

    await fetch(INBOX_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
    await refresh();
  }, [refresh]);

  return { notifications, unreadCount, loading, unavailable, refresh, markRead, markAllRead };
}

/** "just now", "5m", "3h", "2d" — compact enough for a dense list. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "just now";

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}


/**
 * One inbox for the whole session.
 *
 * Mounted from `AppFrame`, which survives client-side navigation, rather than
 * from the bell itself — the bell lives in `TopBar`, which `AppShell` rebuilds
 * on every route change. Hooked up there, each navigation would tear down the
 * Realtime channel and open a new one, and refetch the list to redraw a count
 * it already had. One provider means one subscription for as long as the app is
 * open, which is what the rest of the app does too.
 */
const InboxContext = createContext<ReturnType<typeof useInboxState> | null>(null);

export function NotificationInboxProvider({ children }: { children: ReactNode }) {
  return createElement(InboxContext.Provider, { value: useInboxState() }, children);
}

export function useNotificationInbox() {
  const value = useContext(InboxContext);
  if (!value) {
    throw new Error("useNotificationInbox must be used inside NotificationInboxProvider.");
  }
  return value;
}
