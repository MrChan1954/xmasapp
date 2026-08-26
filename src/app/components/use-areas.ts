"use client";

import { useCallback, useEffect, useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { AREA_COOKIE, areaChoices, areaFromRow, resolveActiveArea, shouldOfferCreate, shouldOfferSwitcher, type Area, type AreaChoice } from "@/lib/areas.ts";
import { createClient } from "@/utils/supabase/client";

/**
 * The families this account belongs to, read the ordinary way.
 *
 * `areas` has one policy -- `is_area_member(id)` -- so this select returns the
 * caller's own families and there is no query anyone can write from a browser
 * that returns somebody else's. Nothing here filters for safety; the database
 * has already done it.
 */
export function useAreas() {
  // ONE PIECE OF STATE, SET ONCE. The list and the remembered choice are only
  // meaningful together -- a list without the choice would briefly resolve to
  // the wrong family and flash the wrong name in the menu.
  const [loaded, setLoaded] = useState<{ areas: Area[]; remembered: string | null } | null>(null);

  useEffect(() => {
    let live = true;

    const found = typeof document === "undefined"
      ? undefined
      : document.cookie.split("; ").find((entry) => entry.startsWith(`${AREA_COOKIE}=`));
    const remembered = found ? decodeURIComponent(found.slice(AREA_COOKIE.length + 1)) : null;

    void createClient()
      .from("areas")
      .select("id,name,archived_at")
      .then(({ data }) => {
        if (!live) return;
        setLoaded({ areas: (data ?? []).map(areaFromRow), remembered });
      });

    return () => { live = false; };
  }, []);

  const areas = loaded?.areas ?? null;
  const active: Area | null = loaded ? resolveActiveArea(loaded.areas, loaded.remembered) : null;

  /**
   * Switching reloads the whole page rather than re-fetching in place.
   *
   * EVERY SCREEN IS ABOUT ONE FAMILY. Half the app re-querying under a new Area
   * while the other half still holds the previous one's rows is a window in
   * which two families are on screen together, and no amount of care in
   * individual components closes it. A reload is the honest way to change
   * something this fundamental.
   */
  const switchTo = useCallback(async (areaId: string) => {
    const response = await fetch("/api/areas", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ areaId }),
    });
    if (!response.ok) return false;
    window.location.assign(new URL("/", window.location.origin).toString());
    return true;
  }, []);

  return {
    loading: areas === null,
    areas: areas ?? [],
    active,
    choices: areas ? (areaChoices(areas, active?.id ?? null) as AreaChoice[]) : [],
    canSwitch: areas ? shouldOfferSwitcher(areas) : false,
    /*
     * WHETHER TO SHOW THE WAY TO A SECOND FAMILY.
     *
     * Separate from `canSwitch` on purpose, and this is the whole point of the
     * distinction: somebody with ONE family cannot switch, so the menu showed
     * them no family section at all -- and the route to starting another was
     * therefore invisible to precisely the people who had never started one.
     */
    canCreate: areas ? shouldOfferCreate(areas) : false,
    switchTo,
  };
}
