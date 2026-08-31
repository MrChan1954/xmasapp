"use client";

import { useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { CREATE_AREA_LABEL, CREATE_AREA_PATH, sortAreas, type Area } from "@/lib/areas.ts";
import { AppShell, PageHeader } from "./components/app-shell";
import { Button, ButtonLink, Notice } from "./components/ui";

/**
 * WHICH FAMILY, ASKED RATHER THAN GUESSED.
 *
 * WHEN THIS APPEARS: an approved account that belongs to at least one family
 * and whose `gp_area` cookie names none of them. A new browser, a private
 * window, a cleared cookie, a second device, a cookie that expired, or a family
 * that has just been left -- and now also the first visit after signing out,
 * because sign-out clears the cookie deliberately.
 *
 * WHY IT IS OFFERED EVEN FOR ONE FAMILY, which is the part that looks wrong and
 * is not. `resolveActiveArea` would happily pick the only one, and for every
 * other screen it should: opening a bookmarked event with no cookie must show
 * the event. But the FRONT DOOR is where the app commits to whose people, whose
 * money and whose history it is about, and making that commitment silently on
 * somebody's behalf is precisely how a stale cookie used to walk a two-family
 * login into the wrong family without ever saying so. One tap, once per
 * browser, and it names the family out loud.
 *
 * NOTHING HERE IS A PERMISSION. The list arrives from `areas`, whose only
 * policy is `is_area_member(id)` -- and since migration 052 that predicate also
 * requires global approval -- so it holds this account's own families and
 * cannot be made to hold anybody else's. Choosing decides what is DISPLAYED;
 * `claim_active_area` re-checks the membership table before it believes the
 * header the cookie becomes.
 */
export function AreaChooser({ areas }: { areas: Area[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ordered = sortAreas(areas);

  const choose = async (areaId: string) => {
    setBusy(areaId);
    setError(null);
    try {
      const response = await fetch("/api/areas", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ areaId }),
      });
      if (!response.ok) {
        setError("That family could not be opened. Try again.");
        setBusy(null);
        return;
      }
      /*
       * A FULL LOAD, not a client navigation, for the same reason switching
       * family reloads: every read from here on has to carry the new Area, and
       * half a screen holding one family while the other half fetches another
       * is not a state worth having.
       */
      window.location.assign(new URL("/", window.location.origin).toString());
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
      setBusy(null);
    }
  };

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow="Welcome back"
        title="Which family?"
        description="Everything you plan lives inside a family. Choose the one you want to open — this browser will remember it."
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}

      <ul className="mt-6 grid max-w-lg gap-3">
        {ordered.map((area) => (
          <li key={area.id}>
            <Button
              variant="secondary"
              size="lg"
              disabled={busy !== null}
              onClick={() => void choose(area.id)}
              className="w-full justify-between"
            >
              <span className="truncate">{area.name}</span>
              <span className="ml-3 shrink-0 text-xs font-semibold text-ink-500">
                {busy === area.id ? "Opening…" : area.archivedAt ? "Archived" : "Open"}
              </span>
            </Button>
          </li>
        ))}
      </ul>

      {/*
        THE OTHER DOOR, and the reason it is here rather than only in the
        account menu: somebody landing on this screen may be here because they
        have just left their last shared family and want one of their own. It
        is a LINK to the existing `/areas/new` form -- the same screen a brand
        new account is given -- so there is no second create-a-family
        implementation anywhere in the app.
      */}
      <div className="mt-8 max-w-lg border-t border-line pt-6">
        <p className="text-sm leading-6 text-ink-600">
          Starting somewhere new? A separate family has its own people, events and money, and
          nothing is shared between them.
        </p>
        <ButtonLink href={CREATE_AREA_PATH} variant="gold" size="lg" className="mt-4">
          {CREATE_AREA_LABEL}
        </ButtonLink>
      </div>
    </AppShell>
  );
}
