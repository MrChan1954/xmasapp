"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "../../../../utils/supabase/client";
import { AppShell, PageHeader } from "../../components/app-shell";
import { Button, Notice, Skeleton, cx } from "../../components/ui";
import { useIsIosSafari, usePwaInstall } from "../../components/use-pwa-install";
import { usePushNotifications } from "../../components/use-push-notifications";
import type { NotificationPreferences } from "@/lib/notification-audience";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/lib/notification-audience";

/**
 * More → Notifications.
 *
 * Two halves, matching how the system actually works:
 *
 *   This device  — whether THIS phone or PC is switched on. Push permission is
 *                  granted per browser install, so an answer here can only ever
 *                  be about the device in your hand. Turning it off on a phone
 *                  leaves a PC receiving.
 *   Notify me about — what you want to hear about, which follows you to every
 *                  device you have switched on.
 *
 * No Web Push vocabulary reaches the screen: no endpoints, no subscriptions, no
 * VAPID, no permission API names. The technical state is translated into one of
 * five plain sentences.
 */

const CATEGORIES: { key: keyof NotificationPreferences; title: string; description: string }[] = [
  { key: "purchases", title: "Purchases", description: "When someone else adds a purchase." },
  { key: "money_i_owe", title: "Money I owe", description: "When something changes what you owe someone." },
  { key: "money_owed_to_me", title: "Money owed to me", description: "When someone owes you, or records a payment to you." },
  { key: "gift_ideas", title: "Gift ideas", description: "When someone adds a new gift idea." },
  { key: "gift_status", title: "Gift status", description: "When a gift you helped pay for is marked purchased or wrapped." },
];

export default function NotificationsPage() {
  const isIosSafari = useIsIosSafari();
  const { installed } = usePwaInstall();
  const { status, enable, disable } = usePushNotifications(isIosSafari, installed);

  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const db = createClient();
      const auth = await db.auth.getUser();
      if (!auth.data.user) return;

      const member = await db
        .from("app_members")
        .select("id")
        .eq("user_id", auth.data.user.id)
        .eq("active", true)
        .maybeSingle();
      if (!active || !member.data) return;

      const stored = await db
        .from("notification_preferences")
        .select("purchases,money_i_owe,money_owed_to_me,gift_ideas,gift_status")
        .eq("app_member_id", member.data.id)
        .maybeSingle();
      if (!active) return;

      // No row yet is not an error: a member who has never opened this screen is
      // opted in to everything, which is what the dispatcher assumes too.
      setPreferences(stored.data ?? DEFAULT_NOTIFICATION_PREFERENCES);
    };

    void load().catch(() => {
      if (active) setPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
    });
    return () => { active = false; };
  }, []);

  /**
   * Optimistic, because a checkbox that lags behind the finger feels broken.
   * A failed write is rolled back and reported rather than left looking saved.
   */
  const toggle = useCallback(async (key: keyof NotificationPreferences, value: boolean) => {
    if (!preferences) return;
    const previous = preferences;
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    setPreferencesError(null);

    const db = createClient();
    const auth = await db.auth.getUser();
    const member = auth.data.user
      ? await db.from("app_members").select("id").eq("user_id", auth.data.user.id).eq("active", true).maybeSingle()
      : null;

    if (!member?.data) {
      setPreferences(previous);
      setPreferencesError("Your settings could not be saved. Please try again.");
      return;
    }

    // RLS restricts both the insert and the update to the caller's own row, so
    // this cannot write anyone else's preferences even though the id is sent.
    const result = await db
      .from("notification_preferences")
      .upsert({ app_member_id: member.data.id, ...next, updated_at: new Date().toISOString() }, { onConflict: "app_member_id" });

    if (result.error) {
      setPreferences(previous);
      setPreferencesError(
        result.error.code === "42P01" || result.error.code === "PGRST205"
          ? "Notifications are not ready yet. Apply the notifications migration, then try again."
          : "Your settings could not be saved. Please try again.",
      );
    }
  }, [preferences]);

  const otherDevices = Math.max(0, status.deviceCount - (status.state === "enabled" ? 1 : 0));

  return (
    <AppShell width="narrow" title="Notifications" parent={{ href: "/more", label: "More" }}>
      <PageHeader
        title="Notifications"
        description="Get told when something happens while the app is closed."
      />

      <section className="mt-8">
        <h2 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">This device</h2>
        <div className="mt-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
          {status.state === "checking"
            ? <Skeleton className="h-16" />
            : <DeviceState
              state={status.state}
              busy={status.busy}
              otherDevices={otherDevices}
              onEnable={() => void enable()}
              onDisable={() => void disable()}
            />}
          {status.error && <Notice tone="danger" className="mt-4">{status.error}</Notice>}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Notify me about</h2>
        <p className="mt-2 text-sm leading-6 text-ink-600">
          These apply to every device you have switched on.
        </p>

        {preferencesError && <Notice tone="danger" className="mt-3">{preferencesError}</Notice>}

        <div className="mt-3 rounded-2xl border border-line bg-surface shadow-card">
          {preferences === null
            ? <div className="p-5"><Skeleton className="h-40" /></div>
            : CATEGORIES.map((category, index) => (
              <div
                key={category.key}
                className={cx(
                  "flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4",
                  index > 0 && "border-t border-line",
                )}
              >
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold">{category.title}</h3>
                  <p className="mt-0.5 text-sm leading-5 text-ink-600">{category.description}</p>
                </div>
                <Switch
                  label={category.title}
                  checked={preferences[category.key]}
                  onChange={(value) => void toggle(category.key, value)}
                />
              </div>
            ))}
        </div>
      </section>
    </AppShell>
  );
}

/** The one sentence that says where this device stands, plus its one action. */
function DeviceState({
  state,
  busy,
  otherDevices,
  onEnable,
  onDisable,
}: {
  state: Exclude<ReturnType<typeof usePushNotifications>["status"]["state"], "checking">;
  busy: boolean;
  otherDevices: number;
  onEnable: () => void;
  onDisable: () => void;
}) {
  if (state === "needs-install") {
    return (
      <div>
        <h3 className="font-display text-lg font-semibold">Add to your Home Screen first</h3>
        <p className="mt-1 text-sm leading-6 text-ink-600">
          iPhone and iPad only allow notifications for apps saved to the Home Screen.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm leading-6 text-ink-600">
          <li>Tap the Share button at the bottom of Safari.</li>
          <li>Choose <span className="font-semibold text-ink-900">Add to Home Screen</span>.</li>
          <li>Open Christmas Budget from your Home Screen, then come back here.</li>
        </ol>
      </div>
    );
  }

  if (state === "unsupported") {
    return (
      <div>
        <h3 className="font-display text-lg font-semibold">Not available on this browser</h3>
        <p className="mt-1 text-sm leading-6 text-ink-600">
          This browser cannot show notifications. Try Chrome or Edge on Windows and Android, or
          install the app to your Home Screen on iPhone. Everything else in the app works as normal.
        </p>
      </div>
    );
  }

  if (state === "blocked") {
    return (
      <div>
        <h3 className="font-display text-lg font-semibold">Blocked by your device</h3>
        <p className="mt-1 text-sm leading-6 text-ink-600">
          Notifications are switched off for this app in your browser or device settings. We cannot
          turn them back on from here — allow notifications for Christmas Budget in those settings,
          then return to this page.
        </p>
      </div>
    );
  }

  if (state === "enabled") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-4">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold">Enabled on this device</h3>
          <p className="mt-1 text-sm leading-6 text-ink-600">
            {otherDevices > 0
              ? `Also on ${otherDevices} other ${otherDevices === 1 ? "device" : "devices"}. Turning this off leaves those on.`
              : "You will be told about anything you have switched on below."}
          </p>
        </div>
        <Button variant="secondary" onClick={onDisable} disabled={busy}>
          {busy ? "Turning off…" : "Turn off on this device"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-4">
      <div className="min-w-0">
        <h3 className="font-display text-lg font-semibold">Off on this device</h3>
        <p className="mt-1 text-sm leading-6 text-ink-600">
          {otherDevices > 0
            ? `Still on for ${otherDevices} other ${otherDevices === 1 ? "device" : "devices"}.`
            : "Your browser will ask for permission when you turn this on."}
        </p>
      </div>
      <Button onClick={onEnable} disabled={busy}>
        {busy ? "Turning on…" : "Enable notifications"}
      </Button>
    </div>
  );
}

/** The same switch the More page uses for falling snow, so nothing new is invented. */
function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-7 w-12 shrink-0 rounded-full border transition",
        checked ? "border-accent bg-accent" : "border-line-strong bg-surface-3",
      )}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden
        className={cx(
          "absolute top-1/2 block h-5 w-5 -translate-y-1/2 rounded-full bg-surface shadow-card transition-[left]",
          checked ? "left-[calc(100%-1.375rem)]" : "left-0.5",
        )}
      />
    </button>
  );
}
