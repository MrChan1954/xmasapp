"use client";

import { useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { validateAreaName } from "@/lib/areas.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { scopeReminder, settingsFor } from "@/lib/settings-scopes.ts";
import { AppShell, PageHeader } from "../../components/app-shell";
import { IconCake, IconHistory, IconPeople, IconSettings } from "../../components/icons";
import { SettingsGroup, SettingsRow } from "../../components/settings-list";
import { Notice } from "../../components/ui";

const ICONS: Record<string, React.ReactNode> = {
  "family-access": <IconPeople size={20} />,
  people: <IconPeople size={20} />,
  birthdays: <IconCake size={20} />,
  activity: <IconHistory size={20} />,
  "family-name": <IconSettings size={20} />,
};

/**
 * ONE FAMILY'S settings.
 *
 * The family is named in the title and again in the line underneath, because
 * this is the screen where getting the family wrong costs the most: renaming,
 * inviting and archiving all read identically whichever family you are in.
 *
 * NOTHING HERE IS THE PERMISSION. The rename below calls `set_area_name`, which
 * refuses anyone who is not this Area's administrator; hiding the field from a
 * member is courtesy, not security.
 */
export function FamilySettingsScreen({
  areaId,
  areaName,
  isAdmin,
}: {
  areaId: string | null;
  areaName: string;
  isAdmin: boolean;
}) {
  const entries = settingsFor("area", { isAdmin }).filter((entry) => entry.key !== "family-name");

  return (
    <AppShell width="narrow">
      <PageHeader eyebrow="Settings" title={areaName} description={scopeReminder("area", areaName)} />

      {isAdmin && areaId && <RenameFamily areaId={areaId} current={areaName} />}

      <SettingsGroup label="This family">
        {entries.map((entry) => (
          <SettingsRow
            key={entry.key}
            href={entry.href}
            title={entry.title}
            description={entry.description}
            icon={ICONS[entry.key] ?? <IconSettings size={20} />}
          />
        ))}
      </SettingsGroup>
    </AppShell>
  );
}

function RenameFamily({ areaId, current }: { areaId: string; current: string }) {
  const [name, setName] = useState(current);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const checked = validateAreaName(name);
    if (!checked.ok) { setError(checked.reason); return; }

    setState("saving");
    try {
      const response = await fetch("/api/areas/name", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ areaId, name: checked.value }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "We could not save that name.");
        setState("idle");
        return;
      }
      setState("saved");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
      setState("idle");
    }
  };

  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Name</h2>
      <form onSubmit={save} className="mt-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
        <label className="block text-sm font-semibold text-ink-700">
          Family name
          <input
            className="mt-2 w-full rounded-xl border border-line bg-surface-1 px-3.5 py-2.5 text-sm text-ink-900 outline-none focus:border-line-strong"
            value={name}
            onChange={(event) => { setName(event.target.value); setState("idle"); }}
            maxLength={80}
            autoComplete="off"
          />
        </label>
        <p className="mt-2 text-xs leading-5 text-ink-500">
          Only this family sees the change. Nobody in another family is told, because nobody in
          another family knows this one exists.
        </p>

        {error && <Notice tone="warning" className="mt-4">{error}</Notice>}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={state === "saving" || name.trim() === current}
            className="min-h-11 rounded-xl bg-gold px-5 text-sm font-semibold text-ink-900 disabled:opacity-60"
          >
            {state === "saving" ? "Saving…" : "Save name"}
          </button>
          {state === "saved" && <span className="text-sm font-semibold text-ink-600">Saved.</span>}
        </div>
      </form>
    </section>
  );
}
