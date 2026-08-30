"use client";

import { useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { validateAreaName } from "@/lib/areas.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { scopeReminder, settingsFor } from "@/lib/settings-scopes.ts";
import { AppShell, PageHeader } from "../../components/app-shell";
import { IconCake, IconHistory, IconPeople, IconSettings } from "../../components/icons";
import { SettingsGroup, SettingsRow } from "../../components/settings-list";
import { Button, ConfirmDialog, Field, Input, Notice, Select } from "../../components/ui";

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
/** Somebody in this family who could be handed the running of it. */
export type Successor = { memberId: string; name: string };

export function FamilySettingsScreen({
  areaId,
  areaName,
  isAdmin,
  archived = false,
  canLeave = false,
  hasAnotherArea = false,
  successors = [],
}: {
  areaId: string | null;
  areaName: string;
  isAdmin: boolean;
  archived?: boolean;
  canLeave?: boolean;
  hasAnotherArea?: boolean;
  successors?: Successor[];
}) {
  const entries = settingsFor("area", { isAdmin }).filter((entry) => entry.key !== "family-name");

  return (
    <AppShell width="narrow">
      <PageHeader eyebrow="Settings" title={areaName} description={scopeReminder("area", areaName)} />

      {isAdmin && areaId && <RenameFamily areaId={areaId} current={areaName} />}

      {archived && (
        <Notice tone="info" className="mt-6">
          This family is archived. It is still here and nothing in it has been deleted --
          it just stays out of the way.
        </Notice>
      )}

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

      {areaId && (
        <Administration
          areaId={areaId}
          areaName={areaName}
          isAdmin={isAdmin}
          archived={archived}
          canLeave={canLeave}
          hasAnotherArea={hasAnotherArea}
          successors={successors}
        />
      )}
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
        <Field label="Family name">
          <Input
            value={name}
            onChange={(event) => { setName(event.target.value); setState("idle"); }}
            maxLength={80}
            autoComplete="off"
          />
        </Field>
        {/*
          * Deliberately a sibling of the Field rather than its `hint`. `Field`
          * renders the hint INSIDE the <label>, which wraps the control — so a
          * hint joins the input's accessible name. That is right for a short
          * instruction and wrong for two sentences of policy prose.
          */}
        <p className="mt-2 text-xs leading-5 text-ink-500">
          Only this family sees the change. Nobody in another family is told, because nobody in
          another family knows this one exists.
        </p>

        {error && <Notice tone="warning" className="mt-4">{error}</Notice>}

        <div className="mt-4 flex items-center gap-3">
          <Button
            type="submit"
            variant="gold"
            disabled={state === "saving" || name.trim() === current}
          >
            {state === "saving" ? "Saving…" : "Save name"}
          </Button>
          {state === "saved" && <span className="text-sm font-semibold text-ink-600">Saved.</span>}
        </div>
      </form>
    </section>
  );
}


/**
 * THE THINGS THAT CHANGE WHO RUNS THIS FAMILY, OR WHETHER YOU ARE IN IT.
 *
 * All three go to one route, which calls one database routine each. NOTHING
 * HERE IS THE PERMISSION: `transfer_area_admin` refuses anybody who is not this
 * family's administrator, `leave_area` refuses the administrator until they
 * have handed over, and `set_area_archived` refuses anybody else. Showing or
 * hiding a control is courtesy; the answer is Postgres's.
 *
 * WHY THE WORDING MATTERS AS MUCH AS THE BUTTONS. "Remove access" reads like
 * "delete this person", and it is not: the person, their birthday, their gifts
 * and every penny of the family's history stay exactly where they are. Each
 * confirmation below says so in the sentence, not in a footnote.
 */
function Administration({
  areaId,
  areaName,
  isAdmin,
  archived,
  canLeave,
  hasAnotherArea,
  successors,
}: {
  areaId: string;
  areaName: string;
  isAdmin: boolean;
  archived: boolean;
  canLeave: boolean;
  hasAnotherArea: boolean;
  successors: Successor[];
}) {
  const [successor, setSuccessor] = useState("");
  const [confirming, setConfirming] = useState<"handover" | "leave" | "archive" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const act = async (action: string, extra: Record<string, string> = {}) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch("/api/areas/membership", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, areaId, ...extra }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "That could not be done.");
        setBusy(false);
        return;
      }
      setDone(typeof body.message === "string" ? body.message : "Done.");
      setConfirming(null);
      // The whole app's idea of who you are here has just changed, so the whole
      // app is reloaded rather than one panel re-rendered.
      window.location.assign(action === "leave" ? "/" : "/settings/family");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
      setBusy(false);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold tracking-eyebrow text-gold uppercase">Administration</h2>

      {error && <Notice tone="warning" className="mt-3">{error}</Notice>}
      {done && <Notice tone="success" className="mt-3">{done}</Notice>}

      {isAdmin && (
        <div className="mt-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ink-900">Hand over {areaName}</h3>
          <p className="mt-1.5 text-xs leading-5 text-ink-600">
            One person runs a family at a time. Choosing somebody here makes them the admin and
            makes you an ordinary member, in one step — there is never a moment where the family
            has two admins or none. You keep your place, your person and all your history.
          </p>

          {successors.length === 0
            ? (
              <p className="mt-4 text-sm text-ink-600">
                There is nobody to hand over to yet. Give somebody else an account in Family
                access first.
              </p>
            )
            : confirming === "handover"
            ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-ink-900">
                  Make {successors.find((entry) => entry.memberId === successor)?.name} the admin
                  of {areaName}?
                </p>
                <p className="mt-1 text-xs leading-5 text-ink-600">
                  You will not be able to undo this yourself — only they will be able to hand it
                  back.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="gold"
                    disabled={busy}
                    onClick={() => void act("transfer-admin", { memberId: successor })}
                  >
                    {busy ? "Handing over…" : "Yes, hand it over"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                  >
                    Keep it
                  </Button>
                </div>
              </div>
            )
            : (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <label className="sr-only" htmlFor="successor">Who takes over</label>
                <Select
                  id="successor"
                  value={successor}
                  onChange={(event) => setSuccessor(event.target.value)}
                  className="w-auto min-w-56"
                >
                  <option value="">Choose somebody…</option>
                  {successors.map((entry) => (
                    <option key={entry.memberId} value={entry.memberId}>{entry.name}</option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  disabled={!successor || busy}
                  onClick={() => setConfirming("handover")}
                >
                  Hand over…
                </Button>
              </div>
            )}
        </div>
      )}

      {isAdmin && (
        <div className="mt-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ink-900">
            {archived ? "Bring this family back" : "Put this family away"}
          </h3>
          <p className="mt-1.5 text-xs leading-5 text-ink-600">
            {archived
              ? "It will show up in the switcher again."
              : "Archiving hides a family you are finished with. Nothing is deleted — the people, the years, the gifts and the money all stay, and you can bring it back whenever you like."}
          </p>
          {/*
            IT ASKS FIRST, like every other thing on this screen that changes
            who sees what.

            THE BUG THIS CLOSES. This button called `act("archive")` straight
            from the click. Handing over asks, leaving asks, and archiving a
            single occasion asks -- the same shared `ConfirmDialog` -- but
            putting away the WHOLE FAMILY, which is the widest of the four, was
            one tap. The `confirming` state above already had "archive" in its
            union and nothing ever set it, which is what half-finished looks
            like.

            Archiving is reversible, and that is an argument for the wording,
            not for skipping the question: it takes the family out of the
            switcher for EVERY member at once, and `resolveActiveArea` never
            picks an archived family for anybody again. A mis-tap is felt by
            people who were not the one tapping.
          */}
          <div className="mt-4">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => (archived ? void act("unarchive") : setConfirming("archive"))}
            >
              {archived ? "Bring it back" : "Archive this family"}
            </Button>
          </div>

          {confirming === "archive" && (
            <ConfirmDialog
              title={`Put ${areaName} away?`}
              body={`It leaves the switcher for everybody in it, not just for you. Nothing is deleted — the people, the events, the gifts and the money all stay — and you can bring it back from this screen whenever you like.`}
              confirmLabel="Archive this family"
              busyLabel="Archiving…"
              busy={busy}
              danger={false}
              onConfirm={() => void act("archive")}
              onCancel={() => setConfirming(null)}
            />
          )}
        </div>
      )}

      <div className="mt-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink-900">Leave {areaName}</h3>

        {isAdmin
          ? (
            <p className="mt-1.5 text-xs leading-5 text-ink-600">
              You run this family, so you cannot leave it yet. Hand it over to somebody else
              above, and then you can.
            </p>
          )
          : (
            <>
              <p className="mt-1.5 text-xs leading-5 text-ink-600">
                This gives up your own access to {areaName}. It does not remove you as a person,
                and it deletes nothing — your birthday, your gifts and everything the family has
                recorded stay exactly as they are. An admin can let you back in later.
                {!hasAnotherArea && " You do not belong to another family, so you would be signed out of everything."}
              </p>

              {confirming === "leave"
                ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      variant="dangerGhost"
                      className="border border-berry-soft-border bg-berry-soft"
                      disabled={busy || !canLeave}
                      onClick={() => void act("leave")}
                    >
                      {busy ? "Leaving…" : `Yes, leave ${areaName}`}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      Stay
                    </Button>
                  </div>
                )
                : (
                  <div className="mt-4">
                    <Button
                      variant="secondary"
                      disabled={busy || !canLeave}
                      onClick={() => setConfirming("leave")}
                    >
                      Leave this family…
                    </Button>
                  </div>
                )}
            </>
          )}
      </div>
    </section>
  );
}
