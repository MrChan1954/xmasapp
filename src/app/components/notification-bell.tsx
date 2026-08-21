"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bell, Check, Gift, Lightbulb, PoundSterling, Sparkles, Wallet } from "lucide-react";
import { cx } from "./cx";
import { relativeTime, useNotificationInbox, type InboxNotification } from "./use-notification-inbox";

/**
 * The Notification Centre, hung off the app header.
 *
 * One component for both shapes: an anchored dropdown from `sm:` upwards, and a
 * bottom sheet on a phone, where a 320px panel pinned to the top-right corner
 * would be unreachable with a thumb. Both render the same list, so there is one
 * set of behaviour to reason about.
 *
 * Rendered from `TopBar`, which only exists inside `AppShell` — and `AppFrame`
 * hands auth routes their children bare — so the bell can never appear on the
 * sign-in screens.
 */

const CATEGORY_ICONS: Record<string, typeof Bell> = {
  purchases: Gift,
  money_i_owe: PoundSterling,
  money_owed_to_me: Wallet,
  gift_ideas: Lightbulb,
  gift_status: Sparkles,
};

export function NotificationBell() {
  const router = useRouter();
  const { notifications, unreadCount, loading, unavailable, markRead, markAllRead } = useNotificationInbox();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Nothing to offer if the inbox cannot be read — a signed-out header, or a
  // database without the migration. Better an absent bell than a broken one.
  if (unavailable) return null;

  const open_ = (notification: InboxNotification) => {
    setOpen(false);
    if (!notification.readAt) void markRead(notification.id);
    // `targetUrl` is constrained to an internal path by a CHECK constraint when
    // it is stored and re-validated when it is read, so this is always in-app.
    router.push(notification.targetUrl);
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "relative flex h-11 w-11 items-center justify-center rounded-full border transition",
          open ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface-2 text-ink-700 hover:border-line-strong",
        )}
      >
        <Bell aria-hidden size={18} strokeWidth={1.9} />
        {unreadCount > 0 && (
          // A count, not just a dot: "3 things happened" is worth knowing before
          // deciding to open it. Capped so a long absence cannot stretch the
          // header. `tabular-nums` stops the badge resizing as the count changes.
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-ground bg-berry px-1 text-[10px] font-bold tabular-nums text-white"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Phone only: a scrim behind the sheet, so the page behind reads as
              inert and a tap anywhere dismisses it. */}
          <div aria-hidden className="fixed inset-0 z-40 bg-scrim sm:hidden" onClick={() => setOpen(false)} />

          <div
            role="dialog"
            aria-label="Notifications"
            className={cx(
              "z-50 flex flex-col overflow-hidden border-line bg-surface shadow-modal",
              // Phone: a bottom sheet within thumb reach, clearing the home
              // indicator. Desktop: anchored under the bell.
              "fixed inset-x-0 bottom-0 max-h-[75vh] rounded-t-3xl border-t pb-[env(safe-area-inset-bottom)]",
              "sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-auto sm:top-[calc(100%+0.5rem)] sm:max-h-[28rem] sm:w-[22rem] sm:rounded-2xl sm:border sm:pb-0",
            )}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <h2 className="font-display text-base font-semibold text-ink-900">Notifications</h2>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-accent hover:bg-accent-soft"
                >
                  <Check aria-hidden size={14} strokeWidth={2.2} />
                  Mark all read
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto dialog-scroll">
              {loading && <p className="px-4 py-8 text-center text-sm text-ink-600">Loading…</p>}

              {!loading && notifications.length === 0 && (
                <div className="px-6 py-10 text-center">
                  <Bell aria-hidden size={22} strokeWidth={1.6} className="mx-auto text-ink-400" />
                  <p className="mt-3 text-sm font-semibold text-ink-900">Nothing yet</p>
                  <p className="mt-1 text-sm leading-6 text-ink-600">
                    Purchases, payments and gift ideas from the rest of the family will show up here.
                  </p>
                </div>
              )}

              {notifications.map((notification) => {
                const Icon = CATEGORY_ICONS[notification.category] ?? Bell;
                const unread = !notification.readAt;

                return (
                  <button
                    key={notification.id}
                    type="button"
                    onClick={() => open_(notification)}
                    className={cx(
                      "flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition last:border-b-0",
                      unread ? "bg-accent-soft/40 hover:bg-accent-soft/70" : "hover:bg-hover-veil",
                    )}
                  >
                    <span
                      className={cx(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl",
                        unread ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-400",
                      )}
                    >
                      <Icon aria-hidden size={16} strokeWidth={1.9} />
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className={cx("block text-sm leading-5", unread ? "font-semibold text-ink-900" : "font-medium text-ink-700")}>
                        {notification.title}
                      </span>
                      <span className="mt-0.5 block text-sm leading-5 text-ink-600">{notification.body}</span>
                      <span className="mt-1 block text-xs text-ink-400">{relativeTime(notification.createdAt)}</span>
                    </span>

                    {/* The unread marker is a dot rather than a coloured row on
                        its own: the tinted background above is easy to miss in
                        bright sun, and a dot is unambiguous. */}
                    {unread && <span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
