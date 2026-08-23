"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventTypeMeta, validateEventInput } from "@/lib/events.ts";
import { INPUT_LIMITS } from "@/lib/input-validation";
import { createClient } from "@/utils/supabase/client";
import { AppShell, PageHeader } from "../../../components/app-shell";
import { GarlandRule } from "../../../components/festive/garland";
import {
  Badge, Button, ConfirmDialog, Field, Input, Notice, Textarea, cx,
} from "../../../components/ui";

export type SettingsPerson = { personId: string; name: string };

export type EventSettings = {
  id: string;
  name: string;
  type: string;
  eventDate: string;
  description: string | null;
  status: string;
  celebrantPersonId: string | null;
};

/**
 * Event Settings: the structural administration of one named event.
 *
 * THIS IS WHERE CONTRIBUTOR MANAGEMENT NOW LIVES.
 *
 * Family Access used to add and remove contributors against "the current
 * Christmas", because contributor editing had no event to belong to. It does
 * now: every button below names the event in the URL, so a birthday's
 * contributors are edited on the birthday and Christmas is not involved.
 *
 * Every action calls a SECURITY DEFINER function that checks Global Admin
 * itself. Hiding these controls is a courtesy, not the boundary.
 */
export function EventSettingsScreen({
  event,
  people,
  recipientPersonIds,
  contributorPersonIds,
  isAdmin,
  isEmpty = false,
}: {
  event: EventSettings;
  people: SettingsPerson[];
  recipientPersonIds: string[];
  contributorPersonIds: string[];
  isAdmin: boolean;
  /**
   * Nothing has ever been recorded here: no purchase, no gift idea, no payment.
   * Shows the delete control. It is NOT the authorization -- the database
   * repeats every check inside the delete itself.
   */
  isEmpty?: boolean;
}) {
  const router = useRouter();
  const meta = eventTypeMeta(event.type);

  const [name, setName] = useState(event.name);
  const [date, setDate] = useState(event.eventDate);
  const [description, setDescription] = useState(event.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The Supabase builder is thenable rather than a Promise, so the parameter
  // is typed as what it resolves to rather than as a Promise of it.
  const run = async (work: () => PromiseLike<{ error: { message: string } | null }>, done?: () => void) => {
    setError(null);
    setSaved(false);
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (result.error) { setError(result.error.message || "That change could not be saved."); return; }
    done?.();
    router.refresh();
  };

  const saveDetails = () => {
    const validation = validateEventInput({
      name,
      type: event.type,
      eventDate: date,
      celebrantPersonId: event.celebrantPersonId,
    });
    if (!validation.ok) { setError(validation.error); return; }
    void run(
      () => createClient().rpc("update_event", {
        p_event_id: event.id,
        p_name: validation.value.name,
        p_event_date: validation.value.eventDate,
        p_description: description.trim() || null,
      }),
      () => setSaved(true),
    );
  };

  const setStatus = (status: "active" | "archived") =>
    void run(() => createClient().rpc("set_event_status", { p_event_id: event.id, p_status: status }));

  const setContributor = (personId: string, active: boolean) =>
    void run(() => createClient().rpc("set_event_contributor", {
      p_event_id: event.id,
      p_person_id: personId,
      p_active: active,
    }));

  const deleteEvent = () =>
    void run(
      () => createClient().rpc("delete_event_if_empty", { p_event_id: event.id }),
      () => router.replace("/"),
    );

  const addRecipient = (personId: string) =>
    void run(() => createClient().rpc("add_event_recipient", {
      p_event_id: event.id,
      p_person_id: personId,
    }));

  if (!isAdmin) {
    return (
      <AppShell width="narrow">
        <PageHeader eyebrow={event.name} title="Event settings" />
        <Notice tone="info" className="mt-6">
          Only the Global Admin can change an event&apos;s details, recipients or contributors.
        </Notice>
      </AppShell>
    );
  }

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow={`${meta.icon} ${meta.label}`}
        title="Event settings"
        description="Rename the event, move its date, choose who receives and who chips in."
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}
      {saved && <Notice tone="success" className="mt-6">Saved.</Notice>}

      <section className="mt-8 space-y-4">
        <h2 className="font-display text-xl font-semibold text-ink-900">Details</h2>
        <GarlandRule />
        <Field label="Event name" required>
          <Input value={name} maxLength={INPUT_LIMITS.name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Date"
          required
          hint={event.type === "birthday"
            ? "This changes THIS event only. The person's saved birthday is edited on the Birthdays page and is not affected."
            : undefined}
        >
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Description" hint="Optional.">
          <Textarea rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Button className="min-h-11" disabled={busy} onClick={saveDetails}>
          {busy ? "Saving…" : "Save details"}
        </Button>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-xl font-semibold text-ink-900">Recipients</h2>
        <p className="mt-1.5 text-sm leading-6 text-ink-600">
          Who this event is buying for. Adding somebody here uses the family member who already
          exists — it never creates a second copy of them. Removing a recipient is done from the
          People screen, which keeps their purchases.
        </p>
        <GarlandRule className="mt-4" />
        <div className="mt-5 flex flex-wrap gap-2">
          {people.map((person) => {
            const on = recipientPersonIds.includes(person.personId);
            return (
              <button
                key={person.personId}
                type="button"
                disabled={busy || on}
                aria-pressed={on}
                onClick={() => addRecipient(person.personId)}
                className={cx(
                  "min-h-11 rounded-xl border px-3.5 text-sm font-semibold",
                  on ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-600 hover:bg-hover-veil",
                )}
              >
                {person.name}{on ? " ✓" : ""}
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-xl font-semibold text-ink-900">Contributors</h2>
        <p className="mt-1.5 text-sm leading-6 text-ink-600">
          Who shares the cost. Changes apply to FUTURE planning only — every purchase already
          recorded keeps the responsibility split it was saved with.
        </p>
        <GarlandRule className="mt-4" />
        <div className="mt-5 flex flex-wrap gap-2">
          {people.map((person) => {
            const on = contributorPersonIds.includes(person.personId);
            const isCelebrant = person.personId === event.celebrantPersonId;
            return (
              <button
                key={person.personId}
                type="button"
                disabled={busy}
                aria-pressed={on}
                onClick={() => setContributor(person.personId, !on)}
                className={cx(
                  "min-h-11 rounded-xl border px-3.5 text-sm font-semibold",
                  on ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-600 hover:bg-hover-veil",
                )}
              >
                {person.name}{isCelebrant ? " 🎂" : ""}
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-xl font-semibold text-ink-900">
          {event.status === "archived" ? "Archived" : "Archive"}
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-ink-600">
          Archiving takes the event off the main list. Nothing is deleted: every purchase,
          payment and balance stays exactly where it is, and the event can be reopened.
        </p>
        <GarlandRule className="mt-4" />
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {event.status === "archived"
            ? (
              <>
                <Badge tone="neutral">Archived</Badge>
                <Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => setStatus("active")}>
                  <RotateCcw size={16} aria-hidden />
                  Reopen event
                </Button>
              </>
            )
            : (
              <Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => setConfirmArchive(true)}>
                <Archive size={16} aria-hidden />
                Archive event
              </Button>
            )}
        </div>
      </section>

      {/* Only for an occurrence that never held anything. The moment a purchase,
          a gift idea or a payment exists, this section is not rendered and the
          database refuses the call anyway. */}
      {isEmpty && (
        <section className="mt-12">
          <h2 className="font-display text-xl font-semibold text-ink-900">Delete</h2>
          <p className="mt-1.5 text-sm leading-6 text-ink-600">
            Nothing has been recorded against this event — no purchases, no gift ideas,
            no payments — so it can be removed completely rather than archived. Once
            anything is recorded, this option disappears and archiving is the only way
            to take it off the list.
          </p>
          <GarlandRule className="mt-4" />
          <div className="mt-5">
            <Button variant="ghost" className="min-h-11 text-berry" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={16} aria-hidden />
              Delete this event
            </Button>
          </div>
        </section>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${event.name}?`}
          body="It is removed completely, along with its recipient and contributor setup. Nothing else is affected, and the deletion is recorded in the activity log. This cannot be undone."
          confirmLabel="Delete event"
          onConfirm={() => { setConfirmDelete(false); deleteEvent(); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {confirmArchive && (
        <ConfirmDialog
          title={`Archive ${event.name}?`}
          body="It moves to the Archived list. Nothing is deleted, and you can reopen it at any time."
          confirmLabel="Archive event"
          onConfirm={() => { setConfirmArchive(false); setStatus("archived"); }}
          onCancel={() => setConfirmArchive(false)}
        />
      )}
    </AppShell>
  );
}
