"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronRight, Search } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeDaysAway, describeTurningAge, formatBirthday, nextBirthdayOccurrence } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { type PersonAccount, type PersonDirectoryEntry } from "@/lib/people.ts";
import { AppShell, PageHeader } from "../components/app-shell";
import { GarlandRule } from "../components/festive/garland";
import { ButtonLink, EmptyState, FilterChip, Input, cx } from "../components/ui";

type Filter = "active" | "archived" | "no_birthday";

/**
 * The family directory.
 *
 * A DIRECTORY, NOT AN EVENT SCREEN. What belongs on a card here is who somebody
 * IS -- their name, their birthday, the age they are turning. What does not is
 * every event they have ever appeared in: that is history, it belongs inside
 * the profile, and putting it here would make the list unreadable for exactly
 * the families who need it most.
 *
 * Adding, renaming and archiving a person all live on the profile, because they
 * are things you do TO one person and this screen is about finding them.
 */
export function PeopleDirectoryScreen({
  people,
  today,
  isAdmin,
  canEditBirthdays,
  accounts,
}: {
  people: PersonDirectoryEntry[];
  today: string;
  isAdmin: boolean;
  canEditBirthdays: boolean;
  accounts: Record<string, PersonAccount>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("active");

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people
      .filter((person) => {
        if (filter === "archived") return person.archivedAt !== null;
        if (filter === "no_birthday") return person.archivedAt === null && person.birthday === null;
        return person.archivedAt === null;
      })
      .filter((person) => needle === "" || person.name.toLowerCase().includes(needle));
  }, [people, query, filter]);

  const archivedCount = people.filter((person) => person.archivedAt !== null).length;
  const missingCount = people.filter((person) => person.archivedAt === null && person.birthday === null).length;

  return (
    <AppShell width="default">
      <PageHeader
        eyebrow="Family gift planner"
        title="People"
        description="Everybody the family plans for. Open somebody to see their birthday and everything that has been bought for them."
        actions={isAdmin ? (
          <ButtonLink href="/people/new" size="lg" className="w-full sm:w-auto">
            Add person
          </ButtonLink>
        ) : null}
      />

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Search people</span>
          <Search size={16} aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-600" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            className="pl-10"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <FilterChip active={filter === "active"} onClick={() => setFilter("active")}>
            Active
          </FilterChip>
          {missingCount > 0 && (
            <FilterChip active={filter === "no_birthday"} onClick={() => setFilter("no_birthday")}>
              No birthday ({missingCount})
            </FilterChip>
          )}
          {archivedCount > 0 && (
            <FilterChip active={filter === "archived"} onClick={() => setFilter("archived")}>
              Archived ({archivedCount})
            </FilterChip>
          )}
        </div>
      </div>

      <GarlandRule className="mt-5" />

      {shown.length === 0
        ? (
          <EmptyState
            className="mt-8"
            illustration="star"
            title={query.trim() ? "Nobody matches that" : "Nobody here yet"}
            body={query.trim()
              ? "Try a different name, or clear the search."
              : isAdmin
                ? "Add the family one at a time. You can record a birthday at the same time."
                : "An admin has not added anybody yet."}
          />
        )
        : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((person) => (
              <PersonCard
                key={person.personId}
                person={person}
                today={today}
                account={accounts[person.personId] ?? null}
              />
            ))}
          </div>
        )}

      {!canEditBirthdays && (
        <p className="mt-8 text-xs text-ink-600">
          Birthdays are added by an admin or a family contributor.
        </p>
      )}
    </AppShell>
  );
}

function PersonCard({
  person,
  today,
  account,
}: {
  person: PersonDirectoryEntry;
  today: string;
  account: PersonAccount | null;
}) {
  const next = person.birthday ? nextBirthdayOccurrence(person.birthday, today) : null;
  const turning = person.birthday && next ? describeTurningAge(person.birthday, next.year) : null;

  return (
    <Link
      href={`/people/${person.personId}`}
      className={cx(
        "group flex min-h-[5.5rem] items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm transition",
        "hover:border-accent/40 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        person.archivedAt && "opacity-70",
      )}
    >
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-base leading-snug font-semibold break-words text-ink-900">
          {person.name}
        </h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs font-medium text-ink-600">
          <CalendarDays size={13} aria-hidden className="shrink-0" />
          {person.birthday
            ? formatBirthday(person.birthday.month, person.birthday.day)
            : "Birthday not added"}
          {next && (
            <>
              <span aria-hidden>·</span>
              <span>{describeDaysAway(next.daysAway)}</span>
            </>
          )}
        </p>
        {turning && <p className="mt-1 text-xs font-semibold text-accent">{turning}</p>}
        <PersonTags person={person} account={account} />
      </div>
      <ChevronRight size={16} aria-hidden className="shrink-0 text-ink-600" />
    </Link>
  );
}

/**
 * WHAT THIS PERSON IS, AS SEPARATE WORDS.
 *
 * PERSON is the card itself -- everybody here is one. The tags are the other
 * three facts, and each is shown only when it is TRUE, so an ordinary person
 * with no account and no contributor flag carries no tags at all and the list
 * stays readable for the families who are mostly that.
 *
 * "Can sign in" is deliberately not a tag: a login is not a status somebody
 * wears, and most people never need one. Only the states worth noticing appear
 * -- an invitation nobody has taken up, and access that has been switched off.
 */
function PersonTags({
  person,
  account,
}: {
  person: PersonDirectoryEntry;
  account: PersonAccount | null;
}) {
  const tags: Array<{ key: string; label: string; tone: string }> = [];

  if (person.archivedAt) {
    tags.push({ key: "archived", label: "Archived", tone: "border-line bg-surface-3 text-ink-600" });
  }
  // ADMIN is a property of the membership, never of the person.
  if (account?.isAdmin) {
    tags.push({ key: "admin", label: "Admin", tone: "border-gold/30 bg-gold-soft text-gold" });
  }
  if (account?.status === "invited") {
    tags.push({ key: "invited", label: "Invited", tone: "border-line bg-surface-2 text-ink-700" });
  }
  if (account?.status === "disabled") {
    tags.push({ key: "disabled", label: "Access off", tone: "border-line bg-surface-3 text-ink-600" });
  }
  // CONTRIBUTOR is a property of the person, and has nothing to do with logging in.
  if (person.isFamilyContributor) {
    tags.push({ key: "contributor", label: "Contributor", tone: "border-accent/30 bg-accent-soft text-accent" });
  }

  if (tags.length === 0) return null;

  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <li
          key={tag.key}
          className={cx("rounded-full border px-2 py-0.5 text-[11px] font-semibold", tag.tone)}
        >
          {tag.label}
        </li>
      ))}
    </ul>
  );
}
