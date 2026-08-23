import "server-only";

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { type Birthday, type PersonBirthday } from "@/lib/birthdays.ts";
import { createClient } from "./server";

/**
 * The family's birthdays, read on the server.
 *
 * Birthdays live on `people`, which every active member may read and nobody may
 * write from a browser, so this is an ordinary RLS-scoped select: a signed-out
 * visitor gets nothing, and a member gets the same list the calendar shows.
 */

export type FamilyBirthdays = {
  people: PersonBirthday[];
  /** Active Birthday Events, keyed by `<personId>:<year>` for the calendar. */
  birthdayEventsByPersonYear: Record<string, { id: string; name: string }>;
  isAdmin: boolean;
  /** Today, in the family's own timezone. Never derived from a UTC instant. */
  today: string;
};

export async function loadFamilyBirthdays(): Promise<FamilyBirthdays> {
  const db = await createClient();
  const today = londonToday();

  const { data: auth } = await db.auth.getUser();
  if (!auth.user) {
    return { people: [], birthdayEventsByPersonYear: {}, isAdmin: false, today };
  }

  const [membership, peopleResult, eventResult] = await Promise.all([
    db.from("app_members").select("role").eq("user_id", auth.user.id).eq("active", true).maybeSingle(),
    db.from("people").select("id,name,birthday_month,birthday_day,birthday_year").order("name"),
    // Only birthdays, only active ones: an archived event must not present
    // itself as "this year is already set up".
    db.from("events")
      .select("id,name,event_date,celebrant_person_id")
      .eq("event_type", "birthday")
      .eq("status", "active"),
  ]);

  if (!membership.data) {
    return { people: [], birthdayEventsByPersonYear: {}, isAdmin: false, today };
  }
  if (peopleResult.error) throw new Error("The family's birthdays could not be loaded.");

  const people: PersonBirthday[] = (peopleResult.data ?? []).map((row) => ({
    personId: row.id as string,
    name: row.name as string,
    birthday: row.birthday_month === null || row.birthday_day === null
      ? null
      : {
        month: Number(row.birthday_month),
        day: Number(row.birthday_day),
        year: row.birthday_year === null ? null : Number(row.birthday_year),
      } satisfies Birthday,
  }));

  const birthdayEventsByPersonYear: Record<string, { id: string; name: string }> = {};
  for (const row of eventResult.data ?? []) {
    if (!row.celebrant_person_id) continue;
    const year = String(row.event_date).slice(0, 4);
    birthdayEventsByPersonYear[`${row.celebrant_person_id}:${year}`] = {
      id: row.id as string,
      name: row.name as string,
    };
  }

  return {
    people,
    birthdayEventsByPersonYear,
    isAdmin: membership.data.role === "admin",
    today,
  };
}

/**
 * Today, as a calendar date in the family's timezone.
 *
 * A birthday is a calendar date, so "today" has to be one too. Taking it from a
 * UTC instant is exactly what puts a reminder on the wrong day at half past
 * midnight in British Summer Time.
 */
export function londonToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
