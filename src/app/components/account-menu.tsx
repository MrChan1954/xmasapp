"use client";

import { Check, Home, LogOut, Plus, Settings, ShieldCheck, Snowflake, User, UserCog } from "lucide-react";
import { useEffect, useState } from "react";
import { CREATE_AREA_LABEL, CREATE_AREA_PATH } from "@/lib/areas";
import { GLOBAL_ADMIN_PATH } from "@/lib/account-status";
import { loadAccountStatusClient } from "@/utils/supabase/account-status-client";
import { createClient } from "@/utils/supabase/client";
import { signOut } from "@/utils/supabase/sign-out";
import { useFamily } from "../family-context";
import { useFestive } from "./festive/festive-context";
import { Menu, MenuCheckboxItem, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSection } from "./popover";
import { useAreas } from "./use-areas";

export function AccountMenu() {
  // FamilyProvider short-circuits on auth routes, so tolerate an empty role.
  const { isAdmin } = useFamily();
  const { snow, setSnow, reducedMotion } = useFestive();
  const { active, choices, canSwitch, canCreate, switchTo } = useAreas();
  const [email, setEmail] = useState("");
  /**
   * WHETHER TO OFFER THE GLOBAL QUEUE AT ALL.
   *
   * `/admin/accounts` answers `notFound()` to anybody who is not a Gift Planner
   * administrator, which is the right refusal and a terrible way to find the
   * screen: without a link, the only route to it is knowing the path and typing
   * it, which is exactly the fault Q16 found with `/areas/new`.
   *
   * READ FROM `my_account_status()`, NEVER FROM THE TABLE, and hiding the item
   * is not what keeps anybody out -- `list_accounts` and `set_account_status`
   * each ask `is_global_admin()` for themselves and raise 42501. This decides
   * whether the door is visible.
   *
   * IT IS NOT THE FAMILY ADMIN FLAG BESIDE IT. `isAdmin` above is this
   * account's role in the family on screen; being one says nothing whatsoever
   * about the other, which is the whole point of having two kinds.
   */
  const [isGlobalAdmin, setIsGlobalAdmin] = useState(false);

  useEffect(() => {
    let live = true;
    void createClient().auth.getUser().then(({ data }) => { if (live) setEmail(data.user?.email ?? ""); });
    void loadAccountStatusClient().then((status) => { if (live) setIsGlobalAdmin(status.isGlobalAdmin); });
    return () => { live = false; };
  }, []);

  /*
   * Sign-out is `@/utils/supabase/sign-out` now, and no longer a four-line copy
   * of it here. Q18 found this byte-identical to the one in `/account` and left
   * both alone, because verifying a change to the sign-out path means signing
   * the family out of the live site; Q19 has to settle it, because the pending
   * and refused screens and the global admin queue all need it and none of them
   * has an account menu. The shared one also clears `gp_area`, which neither
   * copy ever did.
   */

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
            {/* THE INSTALLATION scope, above even the global one. Who may use
                Gift Planner at all -- no family, no gift, no money. Shown only
                to the handful of accounts that administer it. */}
            {isGlobalAdmin && (
              <MenuItem href={GLOBAL_ADMIN_PATH} icon={<UserCog aria-hidden size={16} strokeWidth={1.8} />}>
                Gift Planner accounts
              </MenuItem>
            )}
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
