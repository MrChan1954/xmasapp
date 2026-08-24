"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronRight, Search } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeDaysAway, describeTurningAge, formatBirthday, nextBirthdayOccurrence } from "@/lib/birthdays.ts";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { type PersonDirectoryEntry } from "@/lib/people.ts";
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
}: {
  people: PersonDirectoryEntry[];
  today: string;
  isAdmin: boolean;
  canEditBirthdays: boolean;
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
              <PersonCard key={person.personId} person={person} today={today} />
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

function PersonCard({ person, today }: { person: PersonDirectoryEntry; today: string }) {
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
        {person.archivedAt && (
          <p className="mt-1 text-xs font-semibold tracking-eyebrow text-ink-600 uppercase">Archived</p>
        )}
      </div>
      <ChevronRight size={16} aria-hidden className="shrink-0 text-ink-600" />
    </Link>
  );
}
