"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { validateAreaName } from "@/lib/areas.ts";
import { AppShell, PageHeader } from "../../components/app-shell";
import { Button, Field, Input, Notice } from "../../components/ui";

/**
 * The first screen of a brand new account, and the way an existing one starts a
 * second family.
 *
 * TWO FIELDS, BOTH REQUIRED, BECAUSE A FAMILY WITH NEITHER IS UNUSABLE. Without
 * a name nobody can tell two families apart in the switcher; without a person
 * the founder has no one to be, cannot be a contributor, and cannot receive a
 * gift. `create_area` writes all three rows -- the Area, the person, the
 * administrator -- in one transaction, so there is no half-made family to clean
 * up if anything here fails.
 */
export function CreateAreaForm({ first }: { first: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [personName, setPersonName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const checkedName = validateAreaName(name);
    if (!checkedName.ok) { setError(checkedName.reason); return; }
    const checkedPerson = validateAreaName(personName);
    if (!checkedPerson.ok) { setError("Tell us your name so the family knows who you are."); return; }

    setSaving(true);
    try {
      const response = await fetch("/api/areas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: checkedName.value, personName: checkedPerson.value }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "We could not create that family.");
        setSaving(false);
        return;
      }
      // A full load, not a client navigation: everything on screen from here is
      // read under the new family's Area, and the server client picks that up
      // from the cookie the route has just written.
      window.location.assign(new URL("/", window.location.origin).toString());
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
      setSaving(false);
    }
  };

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow={first ? "Welcome" : "New family"}
        title={first ? "Set up your family" : "Start another family"}
        description={
          first
            ? "Everything you plan lives inside a family. Nobody outside it can see any of it."
            : "A separate family, with its own people, events and money. Nothing is shared between them."
        }
      />

      <form onSubmit={submit} className="mt-6 max-w-lg">
        <Field label="Family name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="The Taylors"
            autoComplete="off"
            maxLength={80}
          />
        </Field>

        <Field
          label="Your name"
          className="mt-5"
          hint={<>You will be this family&rsquo;s first person and its administrator.</>}
        >
          <Input
            value={personName}
            onChange={(event) => setPersonName(event.target.value)}
            placeholder="How the family should see you"
            autoComplete="name"
            maxLength={80}
          />
        </Field>

        {error && <Notice tone="warning" className="mt-5">{error}</Notice>}

        <Button
          type="submit"
          variant="gold"
          disabled={saving}
          className="mt-6"
        >
          {saving ? "Creating…" : first ? "Create my family" : "Create family"}
        </Button>

        {!first && (
          <Button
            variant="ghost"
            onClick={() => router.back()}
            className="ml-3"
          >
            Cancel
          </Button>
        )}
      </form>
    </AppShell>
  );
}
