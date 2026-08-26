"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { isValidBirthday, isValidBirthYear } from "@/lib/birthdays.ts";
import { INPUT_LIMITS } from "@/lib/input-validation";
import { describeSupabaseError, describeThrown } from "@/lib/supabase-error";
import { createClient } from "@/utils/supabase/client";
import { AppShell, PageHeader } from "../../components/app-shell";
import { Button, Field, Input, Notice } from "../../components/ui";

/**
 * A person, and their birthday, in one step.
 *
 * THE BIRTHDAY IS OPTIONAL AND ON THIS PAGE, which is the point. It used to be
 * a second job on a second screen -- add the person here, go to Birthdays, find
 * them, add the date -- and the second half is exactly the half that never got
 * done. It writes to the SAME permanent fields the Birthdays screen writes; a
 * person has one birthday, stored once.
 *
 * ONE CALL. `create_person` inserts the person and records the birthday in one
 * transaction, so a bad date cannot leave a half-added person behind. It also
 * refuses to make them a contributor, a member or an admin: adding somebody to
 * the directory says they are family, and nothing else.
 */
export function AddPersonForm({ existingNames = [] }: { existingNames?: string[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [year, setYear] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wantsBirthday = month !== "" || day !== "";
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const yearNumber = year === "" ? null : Number(year);

  const birthdayValid = !wantsBirthday
    || (isValidBirthday(monthNumber, dayNumber) && isValidBirthYear(yearNumber));
  const canSave = name.trim().length > 0 && birthdayValid && !saving;

  /*
   * A WARNING, NEVER A REFUSAL. Two people in one family really can share a
   * name, so this says what it sees and gets out of the way. Compared
   * case-insensitively and on the trimmed value, because "  eden" and "Eden"
   * are the duplicate somebody is about to create by accident.
   */
  const duplicate = existingNames.find(
    (existing) => existing.trim().toLowerCase() === name.trim().toLowerCase(),
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await createClient().rpc("create_person", {
        p_name: name.trim(),
        p_month: wantsBirthday ? monthNumber : null,
        p_day: wantsBirthday ? dayNumber : null,
        p_year: wantsBirthday && yearNumber !== null ? yearNumber : null,
      });
      if (result.error) {
        setError(describeSupabaseError(result.error, "That person could not be added."));
        setSaving(false);
        return;
      }
      const created = result.data as { id?: string } | null;
      router.replace(created?.id ? `/people/${created.id}` : "/people");
      router.refresh();
    } catch (thrown) {
      setError(describeThrown(thrown, "That person could not be added."));
      setSaving(false);
    }
  };

  return (
    <AppShell width="narrow">
      <PageHeader
        eyebrow="People"
        title="Add person"
        description="Everyone the family buys for. A birthday is optional — you can add it now or later."
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}

      <section className="mt-6 space-y-4">
        <Field label="Name" required>
          <Input
            value={name}
            maxLength={INPUT_LIMITS.name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Eden"
          />
        </Field>

        <Field
          label="Birthday"
          hint="Optional. The day and month are what reminders and ages use; the year is only needed to show the age they are turning."
        >
          <div className="flex gap-2">
            <Input
              value={day}
              inputMode="numeric"
              placeholder="Day"
              aria-label="Day"
              onChange={(event) => setDay(event.target.value.replace(/[^0-9]/gu, "").slice(0, 2))}
            />
            <Input
              value={month}
              inputMode="numeric"
              placeholder="Month"
              aria-label="Month"
              onChange={(event) => setMonth(event.target.value.replace(/[^0-9]/gu, "").slice(0, 2))}
            />
            <Input
              value={year}
              inputMode="numeric"
              placeholder="Year"
              aria-label="Year of birth"
              onChange={(event) => setYear(event.target.value.replace(/[^0-9]/gu, "").slice(0, 4))}
            />
          </div>
        </Field>

        {duplicate && (
          <Notice tone="warning">
            {duplicate} is already in this family. You can still add another — families do have two
            people with the same name — but if this is the same person, open them instead.
          </Notice>
        )}

        {wantsBirthday && !birthdayValid && (
          <p className="text-sm text-berry">
            That is not a real date. Enter a day and a month that exist together.
          </p>
        )}

        <div className="flex flex-wrap gap-3 pt-2">
          <Button className="min-h-11" disabled={!canSave} onClick={() => void save()}>
            {saving ? "Adding…" : "Add person"}
          </Button>
          <Button variant="ghost" className="min-h-11" disabled={saving} onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </section>
    </AppShell>
  );
}
