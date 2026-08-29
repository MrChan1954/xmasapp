import { Lightbulb } from "lucide-react";
import { formatPennies } from "@/lib/currency";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath } from "@/lib/events.ts";
import type { BirthdayOccurrence } from "@/utils/supabase/birthdays-server";
import { AppShell, PageHeader } from "../../../components/app-shell";
import { GarlandRule } from "../../../components/festive/garland";
import { ButtonLink, EmptyState } from "../../../components/ui";
// NOT from "./ui": this is a Server Component, and `ui/index.tsx` is "use client".
// A plain function exported from a client module becomes a client reference,
// and calling one during a server render throws.
import { cx } from "../../../components/cx";

/**
 * Previous birthdays, read-only.
 *
 * A year appears only if something actually happened in it. An occurrence
 * created and never used is not "the year nobody bought anything"; it is an
 * empty row, and it is listed separately for the Global Admin to tidy up rather
 * than presented as history.
 */
export function BirthdayHistoryScreen({
  personName,
  previous,
  unused,
  isAdmin,
}: {
  personName: string;
  previous: BirthdayOccurrence[];
  unused: BirthdayOccurrence[];
  isAdmin: boolean;
}) {
  const firstName = personName.split(" ")[0];

  return (
    <AppShell width="narrow" title="Previous birthdays">
      <PageHeader
        eyebrow={personName}
        title="Previous birthdays"
        description={`What the family got ${firstName} in earlier years, what it cost, and who paid.`}
        actions={<ButtonLink href="/birthdays" variant="secondary" size="lg" className="w-full sm:w-auto">All birthdays</ButtonLink>}
      />

      {previous.length === 0
        ? (
          <EmptyState
            className="mt-8"
            illustration="star"
            title="No previous birthdays recorded"
            body={`Once a birthday has been planned and gifts bought, ${firstName}'s earlier years appear here.`}
          />
        )
        : (
          <div className="mt-8 space-y-4">
            {previous.map((occurrence) => (
              <article key={occurrence.eventId} className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <h2 className="font-display text-lg font-semibold text-ink-900">{occurrence.year}</h2>
                  <p className="text-sm font-semibold tabular-nums text-ink-900">
                    {formatPennies(occurrence.spentPennies)}
                    <span className="font-medium text-ink-600"> spent</span>
                  </p>
                </div>

                {occurrence.gifts.length > 0
                  ? (
                    <ul className="mt-3 divide-y divide-line">
                      {occurrence.gifts.map((gift) => (
                        <li key={gift.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
                          <span className="min-w-0 break-words text-sm font-medium text-ink-900">{gift.description}</span>
                          <span className="flex items-baseline gap-2 text-sm">
                            {gift.buyerName && <span className="text-xs font-medium text-ink-600">{gift.buyerName}</span>}
                            <span className="font-semibold tabular-nums text-ink-900">{formatPennies(gift.pricePennies)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )
                  : <p className="mt-3 text-sm text-ink-600">Nothing was bought, but there were ideas.</p>}

                {occurrence.openIdeas.length > 0 && (
                  <div className="mt-4 border-t border-line pt-4">
                    <p className="flex items-center gap-1.5 text-xs font-semibold tracking-eyebrow text-gold uppercase">
                      <Lightbulb size={14} aria-hidden />
                      Ideas nobody bought
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {occurrence.openIdeas.map((idea) => (
                        <li key={idea.id} className={cx(
                          "rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-600",
                        )}>
                          {idea.title}
                          {idea.estimatedPricePennies !== null && (
                            <span className="text-ink-400"> · {formatPennies(idea.estimatedPricePennies)}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-ink-600">Still worth a look for {firstName} this year.</p>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

      {isAdmin && unused.length > 0 && (
        <section className="mt-12">
          <h2 className="font-display text-xl font-semibold text-ink-900">Unused planning</h2>
          <p className="mt-1.5 text-sm leading-6 text-ink-600">
            Started and never used — nothing was bought, and no ideas were added. These are not
            counted as previous birthdays. Open the settings to tidy one up; anything with a
            purchase or an idea in it can only be archived.
          </p>
          <GarlandRule className="mt-4" />
          <ul className="mt-5 divide-y divide-line rounded-2xl border border-line bg-surface">
            {unused.map((occurrence) => (
              <li key={occurrence.eventId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <span className="min-w-0">
                  <span className="block font-semibold text-ink-900">{occurrence.year}</span>
                  <span className="block text-xs text-ink-600">
                    {occurrence.eventDate}{occurrence.status === "archived" ? " · archived" : ""}
                  </span>
                </span>
                <ButtonLink href={eventPath(occurrence.eventId, "settings") ?? "/"} variant="ghost" className="min-h-11">
                  Settings
                </ButtonLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}
