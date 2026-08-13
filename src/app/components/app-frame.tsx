"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { BottomTabs } from "./bottom-tabs";
import { IconRail } from "./icon-rail";
import { NotificationInboxProvider } from "./use-notification-inbox";
import { isAuthRoute } from "./nav-items";

/**
 * The persistent navigation frame, rendered once from the root layout.
 *
 * The rail and the tab bar live here rather than inside `AppShell` because a
 * layout survives client-side navigation while a page does not. When the rail
 * sat in `AppShell`, every route change destroyed and rebuilt its DOM node, so
 * the hover-expanded width collapsed back to the rail's base width and only
 * re-expanded once the browser re-evaluated `:hover` — the rail visibly shut and
 * reopened under a stationary cursor. Mounted here, the same node persists and
 * its hover state is never interrupted.
 *
 * Signed-out routes render their own full-screen frame (`AuthScreen`), so they
 * get the children bare — no chrome, and no flex wrapper to fight with.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isAuthRoute(pathname)) return <>{children}</>;

  return (
    // `dvh` rather than `vh`: in an installed app and in mobile Safari the
    // dynamic viewport is the honest full height, where `100vh` can overshoot
    // and leave the page scrollable by the height of browser chrome.
    // The inbox provider lives here, not in the header: this component survives
    // client-side navigation while `AppShell` (and so `TopBar`, and so the bell)
    // is rebuilt on every route change. One provider means one Realtime channel
    // for the whole session instead of one per page view.
    <NotificationInboxProvider>
      <div className="flex min-h-[100dvh] bg-ground text-ink-900">
        <IconRail />
        {children}
        <BottomTabs />
      </div>
    </NotificationInboxProvider>
  );
}
