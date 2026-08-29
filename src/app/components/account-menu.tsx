"use client";

import { useRouter } from "next/navigation";
import { Check, Home, LogOut, Plus, Settings, ShieldCheck, Snowflake, User } from "lucide-react";
import { useEffect, useState } from "react";
import { CREATE_AREA_LABEL, CREATE_AREA_PATH } from "@/lib/areas";
import { createClient } from "@/utils/supabase/client";
import { useFamily } from "../family-context";
import { useFestive } from "./festive/festive-context";
import { Menu, MenuCheckboxItem, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSection } from "./popover";
import { useAreas } from "./use-areas";

export function AccountMenu() {
  const router = useRouter();
  // FamilyProvider short-circuits on auth routes, so tolerate an empty role.
  const { isAdmin } = useFamily();
  const { snow, setSnow, reducedMotion } = useFestive();
  const { active, choices, canSwitch, canCreate, switchTo } = useAreas();
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
    <Menu
      label="Account menu"
      trigger={() => (
        <span
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface-2 text-xs font-semibold text-ink-700 hover:border-line-strong group-data-[state=open]/trigger:ring-2 group-data-[state=open]/trigger:ring-accent/30"
        >
          {initials}
        </span>
      )}
    >
          <MenuSection>
            <div className="px-3 py-2">
              <p className="truncate text-sm font-semibold text-ink-900">{email || "Signed in"}</p>
              {active && <p className="mt-0.5 truncate text-xs font-semibold text-ink-500">{active.name}</p>}
              {isAdmin && (
                <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-gold">
                  <ShieldCheck aria-hidden size={13} strokeWidth={2} />
                  Family admin
                </p>
              )}
            </div>
          </MenuSection>

          {/*
            THE FAMILY SECTION IS NOT ONLY A SWITCHER.

            It used to be: it rendered when there was more than one family and
            not otherwise, which is right for a CHOOSER -- a list with one entry
            is a control that can only ever do nothing. But it also carried the
            only route to starting another family, so somebody with one family
            was shown nothing at all, and "start another" was reachable only by
            knowing that `/areas/new` exists and typing it. The people who most
            needed the door were the only ones who could not see it.

            So the two questions are asked separately now: LIST when there is
            something to switch to, OFFER TO CREATE whenever they already have
            one. This menu is in the top bar at every width, so the phone gets
            the same door as the desktop without a second implementation.
          */}
          {(canSwitch || canCreate) && (
            <MenuSection label="Family">
              {canSwitch && (
                <MenuRadioGroup value={active?.id ?? ""}>
                  {choices.map((choice) => (
                    <MenuRadioItem
                      key={choice.id}
                      value={choice.id}
                      onSelect={() => { if (!choice.active) void switchTo(choice.id); }}
                      icon={<Home aria-hidden size={16} strokeWidth={1.8} />}
                    >
                      <span className="flex-1 truncate">{choice.name}</span>
                      {choice.archivedAt && <span className="text-xs font-semibold text-ink-400">Archived</span>}
                      {choice.active && <Check aria-hidden size={15} strokeWidth={2.2} className="text-gold" />}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              )}

              {canCreate && (
                /*
                 * A LINK, not a button that creates anything. It opens the
                 * existing `/areas/new` form -- the same screen a brand new
                 * account is given -- and nothing exists until that form is
                 * submitted. There is no second copy of create-a-family here.
                 *
                 * Ruled off from the families above it, so it reads as an
                 * action rather than as one more family to switch into.
                 */
                <div className={canSwitch ? "mt-1.5 border-t border-line pt-1.5" : ""}>
                  <MenuItem
                    href={CREATE_AREA_PATH}
                    icon={<Plus aria-hidden size={16} strokeWidth={2} />}
                  >
                    {CREATE_AREA_LABEL}
                  </MenuItem>
                </div>
              )}
            </MenuSection>
          )}

          <MenuSection label="Appearance">
            <MenuCheckboxItem
              checked={snow}
              disabled={reducedMotion}
              onCheckedChange={setSnow}
              icon={<Snowflake aria-hidden size={16} strokeWidth={1.8} />}
            >
              <span className="flex-1">Falling snow</span>
              <span className="text-xs font-semibold text-ink-400">
                {reducedMotion ? "Off (reduced motion)" : snow ? "On" : "Off"}
              </span>
            </MenuCheckboxItem>
          </MenuSection>

          <MenuSection>
            <MenuItem href="/account" icon={<User aria-hidden size={16} strokeWidth={1.8} />}>
              Account &amp; security
            </MenuItem>
            {/* THE GLOBAL scope. What follows this person into every family
                they belong to. A family's own settings, and an event's, are
                reached from inside the family they belong to -- see
                src/lib/settings-scopes.ts. */}
            <MenuItem href="/settings" icon={<Settings aria-hidden size={16} strokeWidth={1.8} />}>
              Settings
            </MenuItem>
            <MenuItem
              tone="danger"
              icon={<LogOut aria-hidden size={16} strokeWidth={1.8} />}
              onClick={() => { void signOut(); }}
            >
              Sign out
            </MenuItem>
          </MenuSection>
    </Menu>
  );
}
