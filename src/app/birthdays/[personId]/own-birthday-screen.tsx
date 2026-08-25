// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeDaysAway, describeTurningAge, formatBirthday, nextBirthdayOccurrence, type Birthday } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { WISHLIST_HEADLINE, WISHLIST_INTRO, type WishlistEntry } from "@/lib/wishlist.ts";
import { AppShell, PageHeader } from "../../components/app-shell";
import { GarlandRule } from "../../components/festive/garland";
import { WishlistEditor } from "./wishlist-editor";

/**
 * What somebody sees when they open their OWN birthday.
 *
 * NOT AN ERROR, AND NOT A 404. Both would be lies, and a 404 in particular
 * would read as "the app is broken" to the one person guaranteed to try this.
 *
 * IT USED TO BE A CLOSED DOOR. The screen said "You can't see what you're
 * getting" and stopped there, which was true about the presents and wrong about
 * the birthday: there was one useful thing this person could do here and the
 * page did not let them do it. Now it is their wishlist, and the sentence about
 * the presents is the reassurance underneath it rather than the whole page.
 *
 * WHAT THIS SCREEN MAY SHOW
 *   Their own name, their own date, the age they are turning, and the list they
 *   wrote themselves. None of those is a secret: the date is on the family
 *   calendar, the age follows from it, and the list is theirs.
 *
 * WHAT IT MAY NEVER SHOW, AND STRUCTURALLY CANNOT
 *   Purchases, prices paid, purchasers, status, budget, spend, remaining,
 *   contributors, allocations, payments, or the family's own gift ideas. None
 *   of those reaches this component: the loader returns `current: null` and
 *   `previous: []` for the celebrant, and the wishlist arrives from
 *   `birthday_wishlist_ideas`, a table with no foreign key into the planning at
 *   all. There is nothing here to forget to hide.
 *
 * WHAT IS ACTUALLY ENFORCING IT
 *   Migrations 031, 036 and 040, not this screen. By the time the page renders,
 *   the reader's own birthday event, its budget, its contributors, its ideas,
 *   its purchases and its money have already been removed from every query they
 *   can make -- through the app or by calling the database directly. This is
 *   the explanation, not the lock.
 */
export function OwnBirthdayScreen({
  personId,
  personName,
  birthday,
  year,
  today,
  wishlist,
  wishlistYear,
  canWrite,
}: {
  personId: string;
  personName: string;
  birthday: Birthday | null;
  year: number;
  today: string;
  wishlist: WishlistEntry[];
  /** The birthday the list is for. Null when no date is recorded. */
  wishlistYear: number | null;
  canWrite: boolean;
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
          {WISHLIST_HEADLINE}
        </h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-700">
          {WISHLIST_INTRO}
        </p>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-600">
          This applies to admins too. It is not a permission you can be given.
        </p>
      </section>

      {wishlistYear === null
        ? (
          /**
           * NO DATE, NO LIST. A wish is filed under the birthday it is for, and
           * without a recorded birthday there is no year to file it under.
           *
           * This says nothing about the family: it is a fact about this
           * person's own record, which they can see on the header above.
           */
          <section className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-sm">
            <p className="text-sm leading-relaxed text-ink-700">
              Once your birthday date is saved you can start a list here. Ask
              whoever looks after the family calendar to add it.
            </p>
          </section>
        )
        : (
          <WishlistEditor
            personId={personId}
            occurrenceYear={wishlistYear}
            initial={wishlist}
            canWrite={canWrite}
          />
        )}
    </AppShell>
  );
}
