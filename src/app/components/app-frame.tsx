"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { BottomTabs } from "./bottom-tabs";
import { IconRail } from "./icon-rail";
import { NotificationInboxProvider } from "./use-notification-inbox";
import { isBareRoute } from "./nav-items";

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
 *
 * SO DO THE GLOBAL ROUTES, since Q19, and for a stronger reason than looks.
 * `/account-pending`, `/account-rejected` and `/admin/accounts` belong to an
 * account rather than to a family, and two of the three are reachable by
 * somebody who is in no family at all. The rail and the tab bar are built from
 * an Area; rendering them there would put a family's navigation in front of
 * somebody the database has not let into one, and `IconRail` would go looking
 * for an Area that does not exist. `isBareRoute` covers both kinds, so the
 * frame and `FamilyProvider` cannot disagree about which screens have chrome.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isBareRoute(pathname)) return <>{children}</>;

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
