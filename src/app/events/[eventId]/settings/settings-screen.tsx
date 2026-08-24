"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventTypeMeta, hasFixedSingleRecipient, validateEventInput } from "@/lib/events.ts";
import { INPUT_LIMITS } from "@/lib/input-validation";
import { describeSupabaseError, describeThrown } from "@/lib/supabase-error";
import { createClient } from "@/utils/supabase/client";
import { AppShell, PageHeader } from "../../../components/app-shell";
import { GarlandRule } from "../../../components/festive/garland";
import {
  Badge, Button, ConfirmDialog, Field, Input, Notice, Textarea, cx,
} from "../../../components/ui";

export type SettingsPerson = {
  personId: string;
  name: string;
  /** In the family's contributor pool — may be OFFERED as a contributor. */
  isFamilyContributor: boolean;
};

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
  // Set the moment the database confirms the delete. From then on this screen
  // renders nothing that reads the event, because the event is gone.
  const [deleted, setDeleted] = useState(false);

  /**
   * Every change on this screen that STAYS on this screen.
   *
   * It refreshes afterwards, which is right for a rename or an archive: the
   * server component above re-renders with the new values. It is exactly wrong
   * for a delete -- refreshing a route whose event no longer exists asks the
   * server to load something that is not there -- so the delete does not use
   * this. That is the bug behind the live "Something went wrong" report.
   *
   * The Supabase builder is thenable rather than a Promise, so the parameter is
   * typed as what it resolves to rather than as a Promise of it.
   */
  const run = async (
    work: () => PromiseLike<{ error: { message: string; code?: string | null; details?: string | null; hint?: string | null } | null }>,
    done?: () => void,
  ) => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const result = await work();
      if (result.error) {
        // The database's own sentence, with its code. Never a shrug.
        setError(describeSupabaseError(result.error, "That change could not be saved."));
        return;
      }
      done?.();
      router.refresh();
    } catch (thrown) {
      // A request that never reached the server rejects rather than resolving.
      // Without this it would be an unhandled rejection in a click handler:
      // the button would stop spinning and the screen would say nothing.
      setError(describeThrown(thrown, "That change could not be saved. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
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

  /**
   * Where the reader goes after this event stops existing.
   *
   * A birthday occurrence belongs to a person, so the honest destination is
   * that person's birthday page -- they were looking at Taylor's birthday, and
   * they still are. Anything else goes back to the dashboard.
   */
  const destinationAfterDelete = event.type === "birthday" && event.celebrantPersonId
    ? `/birthdays/${event.celebrantPersonId}`
    : "/";

  /**
   * Delete, and leave.
   *
   * DELIBERATELY NOT `run`.
   *
   * `run` refreshes the current route when it finishes, and the current route
   * is `/events/<this id>/settings`. Once the event is deleted that route has
   * nothing to load, so refreshing it asks the server for a row that no longer
   * exists -- which is how a successful delete ended up showing the generic
   * error page instead of going anywhere.
   *
   * So this does the opposite, in order:
   *   1. call the database and wait for it to confirm,
   *   2. mark the screen deleted, so nothing here renders the event again,
   *   3. navigate away -- and never refresh what we just left.
   *
   * A refusal (the event turned out to hold something) is shown right here, on
   * this screen, with the database's own explanation. It must never reach the
   * error boundary: "This event has 4 purchases, archive it instead" is a
   * useful sentence and "Something went wrong" is not.
   */
  const deleteEvent = async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const result = await createClient().rpc("delete_event_if_empty", { p_event_id: event.id });

      if (result.error) {
        setError(describeSupabaseError(result.error, "This event could not be deleted."));
        return;
      }
      // The function returns true, and only true. Anything else means the call
      // went somewhere unexpected, and treating it as success would leave the
      // reader believing something happened that did not.
      if (result.data !== true) {
        setError("The delete could not be confirmed, so nothing was changed. Please try again.");
        return;
      }

      setDeleted(true);
      router.replace(destinationAfterDelete);
    } catch (thrown) {
      setError(describeThrown(thrown, "This event could not be deleted. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Who to offer as a contributor.
   *
   * The family's contributor pool, PLUS anybody already contributing to this
   * event. That second half matters: taking somebody out of the pool must not
   * make an existing contributor vanish from the one screen that can remove
   * them — their money would stay assigned with no way to see it.
   */
  const contributorChoices = people.filter((person) =>
    person.isFamilyContributor || contributorPersonIds.includes(person.personId));

  /**
   * An event that names a celebrant is ABOUT that person.
   *
   * So it shows its one recipient and offers no way to add a second: a
   * birthday with two recipients is a mistake, not a configuration.
   *
   * THE TEST IS THE EVENT TYPE. It used to be "does this event name a
   * celebrant", which locked recipients on a wedding or an anniversary too --
   * events that name somebody and may still legitimately gain a second
   * recipient. `hasFixedSingleRecipient` is the one place that rule lives.
   */
  const isAboutOnePerson = hasFixedSingleRecipient(event);
  const recipientChoices = isAboutOnePerson
    ? people.filter((person) => recipientPersonIds.includes(person.personId))
    : people;

  const addRecipient = (personId: string) =>
    void run(() => createClient().rpc("add_event_recipient", {
      p_event_id: event.id,
      p_person_id: personId,
    }));

  // Deleted, and on the way out. Rendering the event's name, date, recipients
  // or contributors now would be rendering something that no longer exists.
  if (deleted) {
    return (
      <AppShell width="narrow">
        <PageHeader eyebrow="Deleted" title="Event removed" />
        <Notice tone="success" className="mt-6">
          The event was deleted. Taking you back…
        </Notice>
      </AppShell>
    );
  }

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
      {/* THE EVENT'S OWN NAME IS ITS IDENTITY, here as everywhere else. This
          used to read "🎁 Event settings" for anything the app had no type
          label for, which told the reader nothing about which event they were
          editing. The icon still comes from the type -- 🎄 for Christmas, 🎂
          for a birthday, 🎁 otherwise -- because that is decoration, not
          identity. */}
      <PageHeader
        eyebrow={`${meta.icon} ${event.name}`}
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
          {isAboutOnePerson
            ? "This event is about one person, so its recipient is fixed. Everything else — budget, contributors, gifts and Owed — works exactly as it does anywhere else."
            : "Who this event is buying for. Adding somebody here uses the family member who already exists — it never creates a second copy of them. Removing a recipient is done from the People screen, which keeps their purchases."}
        </p>
        <GarlandRule className="mt-4" />
        <div className="mt-5 flex flex-wrap gap-2">
          {recipientChoices.map((person) => {
            const on = recipientPersonIds.includes(person.personId);
            return (
              <button
                key={person.personId}
                type="button"
                disabled={busy || on || isAboutOnePerson}
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
          {contributorChoices.map((person) => {
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

      {/* Everything that takes an event off the list, in one place at the
          bottom, so the two ways of doing it are read together and the
          reversible one is met first. */}
      <section className="mt-14">
        <h2 className="font-display text-xl font-semibold text-ink-900">Danger zone</h2>
        <GarlandRule className="mt-4" />
      </section>

      <section className="mt-8">
        <h3 className="font-display text-lg font-semibold text-ink-900">
          {event.status === "archived" ? "Archived" : "Archive"}
        </h3>
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
        <section className="mt-10">
          <h3 className="font-display text-lg font-semibold text-ink-900">Delete</h3>
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
          onConfirm={() => { setConfirmDelete(false); void deleteEvent(); }}
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
