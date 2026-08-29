import Link from "next/link";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeDaysAway, describeTurningAge, formatBirthday, nextBirthdayOccurrence } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { eventPath, eventTypeMeta, formatEventDate } from "@/lib/events.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { partitionGiftHistory, totalGiftCount, totalSpentPennies, type PersonAccount, type PersonDirectoryEntry, type PersonEventHistory } from "@/lib/people.ts";
import { formatPennies } from "@/lib/currency";
import { AppShell, PageHeader } from "../../components/app-shell";
import { GarlandRule } from "../../components/festive/garland";
import { Badge, EmptyState } from "../../components/ui";
import { PersonAccountSummary, PersonAdminPanel } from "./person-admin-panel";

/**
 * One person: who they are, and what has actually been bought for them.
 *
 * EVERY FIGURE HERE IS THIS PERSON'S OWN. The spend on an event card is the sum
 * of the purchases whose recipient row names THEM -- not the event's total,
 * which includes everybody else's presents and would tell a family they spent
 * £400 on one child.
 *
 * IDEAS ARE NOT GIFTS and are never added to a total. They are listed under
 * their own heading because "we thought about this" and "we bought this" are
 * different answers to "what did we get Eden".
 */
export function PersonProfileScreen({
  person,
  history,
  isSelf,
  account,
  isAdmin,
  canEditBirthdays,
  areaName,
  today,
}: {
  person: PersonDirectoryEntry;
  history: PersonEventHistory[];
  isSelf: boolean;
  account: PersonAccount;
  isAdmin: boolean;
  canEditBirthdays: boolean;
  areaName: string;
  today: string;
}) {
  const next = person.birthday ? nextBirthdayOccurrence(person.birthday, today) : null;
  const turning = person.birthday && next ? describeTurningAge(person.birthday, next.year) : null;
  const { current, previous } = partitionGiftHistory(history, today);
  const spent = totalSpentPennies(history);
  const gifts = totalGiftCount(history);

  return (
    /* The sticky bar names the person and leads back to the directory they were
       opened from. Without both it read "Family Gift Planner" with no way up,
       which is the app's name rather than an answer to "where am I". */
    <AppShell width="default" title={person.name} parent={{ href: "/people", label: "People" }}>
      <PageHeader
        eyebrow="People"
        title={person.name}
        description={person.birthday
          ? [
            formatBirthday(person.birthday.month, person.birthday.day),
            next ? describeDaysAway(next.daysAway) : null,
            turning,
          ].filter(Boolean).join(" · ")
          : "No birthday recorded yet."}
      />

      {person.archivedAt && (
        <p className="mt-4 rounded-xl border border-line bg-surface-3 px-4 py-3 text-sm text-ink-700">
          This person is archived. They are not offered when choosing who a new event is for,
          and everything already recorded for them is untouched.
        </p>
      )}

      {/* WHO THEY ARE, WHETHER THEY CAN SIGN IN, WHETHER THEY CHIP IN, AND WHO
          RUNS THIS FAMILY -- shown as the four separate facts they are, never
          as one status. Admin only, because nobody else may read a membership
          row, and showing everybody a status the database refuses to tell them
          would just be showing them a wrong one. */}
      {isAdmin && (
        <div className="mt-6">
          <PersonAccountSummary person={person} account={account} areaName={areaName} />
        </div>
      )}

      <PersonAdminPanel
        person={person}
        account={account}
        isAdmin={isAdmin}
        canEditBirthdays={canEditBirthdays}
        areaName={areaName}
        isSelf={isSelf}
      />

      {!person.birthday && !canEditBirthdays && (
        <p className="mt-4 text-sm text-ink-600">
          No birthday added yet. An admin or a family contributor can add one.
        </p>
      )}

      {/* THE ONE PERSON WHO CANNOT SEE ALL OF THIS. Their own birthday planning
          was removed by row level security before this page was built, so
          `history` simply has no entry for it. Saying so is the difference
          between a deliberate rule and a page that looks broken -- and it is
          birthday-only: everything else bought for them is still below. */}
      {isSelf && (
        <section className="mt-6 rounded-2xl border border-line bg-accent-soft p-5">
          <p aria-hidden className="text-2xl leading-none">🎁</p>
          <h2 className="mt-2 font-display text-lg font-semibold text-ink-900">
            You can&apos;t view your own birthday gifts
          </h2>
          <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-700">
            Your birthday planning is hidden here so your presents stay a surprise.
            Everything else the family has bought you is below.
          </p>
        </section>
      )}

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
          <h2 className="font-display text-2xl font-semibold text-ink-900">Gift history</h2>
          {gifts > 0 && (
            <p className="text-xs font-semibold tracking-eyebrow text-ink-600 uppercase">
              {formatPennies(spent)} · {gifts} {gifts === 1 ? "gift" : "gifts"}
            </p>
          )}
        </div>
        <GarlandRule className="mt-4" />

        {history.length === 0
          ? (
            <EmptyState
              className="mt-6"
              illustration="star"
              title="Nothing recorded yet"
              body={isSelf
                ? "Anything bought for you outside your birthday will appear here."
                : "They have not been added to an event yet. Add them to one and their gifts appear here."}
            />
          )
          : (
            <>
              <HistoryGroup title="Coming up" entries={current} isAdmin={isAdmin} />
              <HistoryGroup title="Previously" entries={previous} isAdmin={isAdmin} />
            </>
          )}
      </section>
    </AppShell>
  );
}

function HistoryGroup({
  title,
  entries,
  isAdmin,
}: {
  title: string;
  entries: PersonEventHistory[];
  isAdmin: boolean;
}) {
  if (entries.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="text-xs font-semibold tracking-eyebrow text-ink-600 uppercase">{title}</h3>
      <div className="mt-3 space-y-4">
        {entries.map((entry) => <EventHistoryCard key={entry.eventId} entry={entry} isAdmin={isAdmin} />)}
      </div>
    </div>
  );
}

function EventHistoryCard({ entry, isAdmin }: { entry: PersonEventHistory; isAdmin: boolean }) {
  const meta = eventTypeMeta(entry.eventType);
  const href = eventPath(entry.eventId);

  return (
    <article
      className={"rounded-2xl border border-line bg-surface p-5 shadow-sm"
        + (entry.eventStatus === "archived" ? " opacity-80" : "")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-display text-lg leading-snug font-semibold break-words text-ink-900">
            {/* The EVENT'S OWN NAME. A renamed event reads correctly here with
                nothing about its history moving, because the link is the id. */}
            <span aria-hidden className="mr-1.5">{meta.icon}</span>
            {entry.eventName}
          </h4>
          <p className="mt-1 text-xs font-medium text-ink-600">{formatEventDate(entry.eventDate)}</p>
        </div>
        {entry.eventStatus === "archived" && <Badge tone="neutral">Archived</Badge>}
      </div>

      <p className="mt-3 text-sm font-semibold text-ink-900">
        {formatPennies(entry.spentPennies)}
        <span className="font-medium text-ink-600">
          {" "}spent on them{entry.budgetPennies > 0 ? ` of ${formatPennies(entry.budgetPennies)} budget` : ""}
        </span>
      </p>

      {entry.gifts.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {entry.gifts.map((gift) => (
            <li key={gift.purchaseId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="min-w-0 break-words text-ink-900">
                {gift.description}
                {gift.status === "wrapped" && <span className="ml-1.5 text-xs text-ink-600">· wrapped</span>}
              </span>
              <span className="font-semibold tabular-nums text-ink-900">{formatPennies(gift.pricePennies)}</span>
            </li>
          ))}
        </ul>
      )}

      {entry.ideas.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          {/* LABELLED, AND NEVER COUNTED. An idea has cost nobody anything and
              must not inflate a spend or a gift count. */}
          <p className="text-xs font-semibold tracking-eyebrow text-ink-600 uppercase">
            Ideas · not bought
          </p>
          <ul className="mt-1.5 space-y-1 text-sm text-ink-700">
            {entry.ideas.map((idea) => <li key={idea.giftIdeaId} className="break-words">{idea.title}</li>)}
          </ul>
        </div>
      )}

      {entry.gifts.length === 0 && entry.ideas.length === 0 && (
        <p className="mt-3 text-sm text-ink-600">Nothing recorded for them in this one yet.</p>
      )}

      {href && (
        <p className="mt-4">
          <Link href={href} className="text-xs font-semibold tracking-eyebrow text-accent uppercase">
            {isAdmin ? "Open event →" : "Open →"}
          </Link>
        </p>
      )}
    </article>
  );
}
