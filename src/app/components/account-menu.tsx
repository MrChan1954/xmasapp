"use client";

import { useRouter } from "next/navigation";
import { LogOut, Settings, ShieldCheck, Snowflake, User } from "lucide-react";
import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useFamily } from "../family-context";
import { useFestive } from "./festive/festive-context";
import { Popover, PopoverItem, PopoverSection } from "./popover";

export function AccountMenu() {
  const router = useRouter();
  // FamilyProvider short-circuits on auth routes, so tolerate an empty role.
  const { isAdmin } = useFamily();
  const { snow, setSnow, reducedMotion } = useFestive();
  const [email, setEmail] = useState("");

  useEffect(() => {
    void createClient().auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const signOut = async () => {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  const initials = (email.split("@")[0] || "?").slice(0, 2).toUpperCase();

  return (
    <Popover
      label="Account menu"
      trigger={({ open }) => (
        <span
          className={
            "flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface-2 text-xs font-semibold text-ink-700 " +
            (open ? "ring-2 ring-accent/30" : "hover:border-line-strong")
          }
        >
          {initials}
        </span>
      )}
    >
      {(close) => (
        <>
          <PopoverSection>
            <div className="px-3 py-2">
              <p className="truncate text-sm font-semibold text-ink-900">{email || "Signed in"}</p>
              {isAdmin && (
                <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-gold">
                  <ShieldCheck aria-hidden size={13} strokeWidth={2} />
                  Global Admin
                </p>
              )}
            </div>
          </PopoverSection>

          <PopoverSection label="Appearance">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={snow}
              disabled={reducedMotion}
              onClick={() => setSnow(!snow)}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm font-semibold text-ink-700 hover:bg-hover-veil hover:text-ink-900 disabled:opacity-50"
            >
              <Snowflake aria-hidden size={16} strokeWidth={1.8} />
              <span className="flex-1">Falling snow</span>
              <span className="text-xs font-semibold text-ink-400">
                {reducedMotion ? "Off (reduced motion)" : snow ? "On" : "Off"}
              </span>
            </button>
          </PopoverSection>

          <PopoverSection>
            <PopoverItem href="/account" icon={<User aria-hidden size={16} strokeWidth={1.8} />}>
              Account &amp; security
            </PopoverItem>
            <PopoverItem href="/more" icon={<Settings aria-hidden size={16} strokeWidth={1.8} />}>
              Settings
            </PopoverItem>
            <PopoverItem
              tone="danger"
              icon={<LogOut aria-hidden size={16} strokeWidth={1.8} />}
              onClick={() => { close(); void signOut(); }}
            >
              Sign out
            </PopoverItem>
          </PopoverSection>
        </>
      )}
    </Popover>
  );
}
