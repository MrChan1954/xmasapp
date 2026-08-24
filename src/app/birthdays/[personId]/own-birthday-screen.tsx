// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeDaysAway, describeTurningAge, formatBirthday, nextBirthdayOccurrence, type Birthday } from "@/lib/birthdays.ts";
import { AppShell, PageHeader } from "../../components/app-shell";
import { GarlandRule } from "../../components/festive/garland";

/**
 * What somebody sees when they open their OWN birthday.
 *
 * NOT AN ERROR, AND NOT A 404. Both would be lies, and a 404 in particular
 * would read as "the app is broken" to the one person guaranteed to try this.
 * This is a deliberate state with a friendly explanation, because being kept
 * out of your own surprise is the feature working.
 *
 * WHAT IS ACTUALLY ENFORCING IT
 *   Migration 031's row level security, not this screen. By the time the page
 *   renders, the reader's own birthday event, its budget, its contributors, its
 *   ideas, its purchases and its money have already been removed from every
 *   query they can make -- through the app or by calling the database directly.
 *   This is the explanation, not the lock.
 *
 * WHAT THEY MAY STILL SEE
 *   Their own date, and the age they are turning. Neither is a secret: the date
 *   is on the family calendar and the age follows from it. The presents are the
 *   secret.
 */
export function OwnBirthdayScreen({
  personName,
  birthday,
  year,
  today,
}: {
  personName: string;
  birthday: Birthday | null;
  year: number;
  today: string;
}) {
  const next = birthday ? nextBirthdayOccurrence(birthday, today) : null;
  const turning = birthday ? describeTurningAge(birthday, next ? next.year : year) : null;

  return (
    <AppShell width="default">
      <PageHeader
        eyebrow="Your birthday"
        title={personName}
        description={birthday
          ? [
            formatBirthday(birthday.month, birthday.day),
            next ? describeDaysAway(next.daysAway) : null,
            turning,
          ].filter(Boolean).join(" · ")
          : "No birthday saved yet."}
      />

      <GarlandRule className="mt-6" />

      <section className="mt-8 rounded-2xl border border-line bg-accent-soft p-6 sm:p-8">
        <p aria-hidden className="text-3xl leading-none">🎁</p>
        <h2 className="mt-3 font-display text-xl font-semibold text-ink-900">
          You can&apos;t see what you&apos;re getting
        </h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-700">
          Your birthday planning is hidden from you so your presents stay a surprise.
          Everyone else in the family can see it — budgets, ideas and gifts — but you
          can&apos;t, and neither can you start it off yourself.
        </p>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-600">
          This applies to admins too. It is not a permission you can be given.
        </p>
      </section>
    </AppShell>
  );
}
