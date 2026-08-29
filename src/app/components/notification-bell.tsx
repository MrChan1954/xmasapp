"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bell, Check, Gift, Lightbulb, PoundSterling, Sparkles, Wallet } from "lucide-react";
import { cx } from "./cx";
import { Button } from "./ui";
import { useMounted } from "./use-mounted";
import { relativeTime, useNotificationInbox, type InboxNotification } from "./use-notification-inbox";

/**
 * The Notification Centre, hung off the app header.
 *
 * Two shapes, one list: an anchored dropdown from `sm:` upwards, and a bottom
 * sheet on a phone, where a 320px panel pinned to the top-right corner would be
 * unreachable with a thumb.
 *
 * WHY THE PHONE SHEET IS PORTALLED
 *   `TopBar`'s header carries `backdrop-blur-md`, and `backdrop-filter` makes an
 *   element a containing block for `position: fixed` descendants. The sheet used
 *   to be a `fixed inset-x-0 bottom-0` sibling of the trigger, inside that
 *   header — so it resolved against the header's ~64px box rather than the
 *   viewport. Its bottom edge pinned to the bottom of the header and the panel
 *   grew upward, off the top of the screen, leaving only its last few pixels
 *   visible. In a notification row the timestamp is the bottom line, so a phone
 *   showed "14m ago" and nothing else, with the page visible below because the
 *   scrim was trapped in the same 64px strip.
 *
 *   Rendering it into `document.body` takes it out of that containing block
 *   entirely. The desktop dropdown is deliberately NOT portalled: it is
 *   `absolute`, which resolves against the trigger's own `relative` wrapper and
 *   was never affected.
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

/**
 * What to show if a row ever arrives without its sentence.
 *
 * The renderer is deliberately kind-agnostic: it prints the `title` and `body`
 * the dispatcher already composed, so a new event kind needs no branch here and
 * cannot fall through one. This is the backstop for the other direction — a row
 * that somehow carries no text at all must still say something, and must never
 * reduce to a bare timestamp.
 */
// Event-neutral: this line stands in for a purchase, a payment, a gift idea or
// a birthday reminder, and only one of those is about Christmas.
const FALLBACK_TITLE = "Something happened in your family planning";

export function NotificationBell() {
  const router = useRouter();
  const { notifications, unreadCount, loading, unavailable, markRead, markAllRead } = useNotificationInbox();
  const [open, setOpen] = useState(false);
  const mounted = useMounted();
  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The phone sheet lives in a portal, so it is NOT inside `root`. Without
      // this second check every tap on a notification would count as an outside
      // click and close the sheet before the tap could land.
      if (root.current?.contains(target) || sheet.current?.contains(target)) return;
      setOpen(false);
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

  const panel = (
    <InboxPanel
      notifications={notifications}
      unreadCount={unreadCount}
      loading={loading}
      onOpen={open_}
      onMarkAllRead={() => void markAllRead()}
    />
  );

  return (
    <div ref={root} className="relative">
      <Button
        ref={triggerRef}
        variant="secondary"
        size="icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "relative rounded-full",
          open ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface-2 text-ink-700",
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
      </Button>

      {open && (
        <>
          {/* Desktop: anchored under the bell. `absolute`, so it resolves
              against the wrapper above and the header's backdrop-filter is
              irrelevant to it. Hidden below `sm:`. */}
          <div
            role="dialog"
            aria-label="Notifications"
            className="absolute right-0 top-[calc(100%+0.5rem)] z-50 hidden max-h-[28rem] w-[22rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-modal sm:flex"
          >
            {panel}
          </div>

          {/* Phone: portalled to <body> so `fixed` means the viewport. */}
          {mounted && createPortal(
            <div className="sm:hidden">
              {/* A scrim behind the sheet, so the page behind reads as inert.
                  It carries no handler of its own: the document-level
                  pointerdown above already treats a tap here as outside the
                  panel, and a div that listens for clicks but cannot be
                  reached by a keyboard is exactly the pattern to avoid. */}
              <div aria-hidden className="fixed inset-0 z-40 bg-scrim" />

              <div
                ref={sheet}
                role="dialog"
                aria-label="Notifications"
                className={cx(
                  "fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden",
                  "rounded-t-3xl border-t border-line bg-surface shadow-modal",
                  // `dvh`, not `vh`: on iOS `vh` is the LARGE viewport and
                  // includes the browser chrome, so 75vh can be taller than what
                  // is actually on screen. `dvh` tracks the visible height.
                  "max-h-[75dvh]",
                  // Clears the home indicator in an installed app; 0 elsewhere.
                  "pb-[env(safe-area-inset-bottom)]",
                )}
              >
                {panel}
              </div>
            </div>,
            document.body,
          )}
        </>
      )}
    </div>
  );
}

/**
 * The list itself, identical in both shapes so there is one set of behaviour to
 * reason about. Only one copy is ever displayed: the desktop wrapper is
 * `hidden sm:flex`, the phone wrapper `sm:hidden`.
 */
function InboxPanel({
  notifications,
  unreadCount,
  loading,
  onOpen,
  onMarkAllRead,
}: {
  notifications: InboxNotification[];
  unreadCount: number;
  loading: boolean;
  onOpen: (notification: InboxNotification) => void;
  onMarkAllRead: () => void;
}): ReactNode {
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="font-display text-base font-semibold text-ink-900">Notifications</h2>
        {unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onMarkAllRead}
            className="px-2 text-xs text-accent hover:bg-accent-soft hover:text-accent"
          >
            <Check aria-hidden size={14} strokeWidth={2.2} />
            Mark all read
          </Button>
        )}
      </div>

      {/* `min-h-0` is what lets this shrink inside the flex column and scroll
          rather than pushing the panel past its max height.
          `overscroll-contain` stops a flick at the end of the list scrolling
          the page underneath on iOS. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain dialog-scroll">
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
          const title = notification.title?.trim() || FALLBACK_TITLE;
          const body = notification.body?.trim();

          return (
            <Button
              key={notification.id}
              variant="ghost"
              onClick={() => onOpen(notification)}
              className={cx(
                "flex h-auto w-full items-start justify-start gap-3 rounded-none border-b border-line px-4 py-3 text-left whitespace-normal last:border-b-0",
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

              {/* `min-w-0` lets the text column shrink so long words wrap
                  instead of forcing the row wider than the panel;
                  `break-words` handles a single unbroken string. */}
              <span className="min-w-0 flex-1">
                <span className={cx("block break-words text-sm leading-5", unread ? "font-semibold text-ink-900" : "font-medium text-ink-700")}>
                  {title}
                </span>
                {body && <span className="mt-0.5 block break-words text-sm leading-5 text-ink-600">{body}</span>}
                <span className="mt-1 block text-xs text-ink-400">{relativeTime(notification.createdAt)}</span>
              </span>

              {/* The unread marker is a dot rather than a coloured row on its
                  own: the tinted background above is easy to miss in bright sun,
                  and a dot is unambiguous. */}
              {unread && <span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />}
            </Button>
          );
        })}
      </div>
    </>
  );
}
