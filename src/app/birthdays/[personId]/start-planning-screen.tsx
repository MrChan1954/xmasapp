"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Cake, Plus } from "lucide-react";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeDaysAway, describeTurningAge, formatBirthday, nextBirthdayOccurrence, suggestedBirthdayEventName, type Birthday } from "@/lib/birthdays.ts";
import { formatPennies } from "@/lib/currency";
import { INPUT_LIMITS, parseMoneyToPennies } from "@/lib/input-validation";
import { splitPenniesEqually } from "@/lib/recipient-allocations";
import { describeThrown } from "@/lib/supabase-error";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { describeEventWriteError } from "@/lib/event-errors.ts";
import { createClient } from "@/utils/supabase/client";
import { AppShell, PageHeader } from "../../components/app-shell";
import { WishlistPanel } from "../../components/wishlist-panel";
import { GarlandRule } from "../../components/festive/garland";
import { Button, ButtonLink, EmptyState, Field, MoneyInput, Notice, cx } from "../../components/ui";

export type EligibleContributor = { personId: string; name: string };

/**
 * Starting one year of somebody's birthday planning.
 *
 * WHY THIS EXISTS RATHER THAN A BARE "CREATE"
 *   Creating an empty occurrence and then hunting through Settings for the
 *   budget and the split is how a birthday ends up with £0 planned and a
 *   monthly reminder that never fires. Everything the plan needs is asked for
 *   here, once, and written in a single transaction.
 *
 * NOTHING IS CREATED UNTIL SUBMIT
 *   Opening this page creates nothing. Cancelling creates nothing. Only a valid
 *   submission does, and it is one call to `start_birthday_planning`, which
 *   either produces a complete birthday or nothing at all.
 *
 * WHO IS OFFERED
 *   The family's contributor pool, minus the birthday person — decided by
 *   person identity in the loader, and enforced again by the database, which
 *   refuses an amount assigned to anybody outside the pool.
 */
export function StartPlanningScreen({
  personId,
  personName,
  birthday,
  year,
  occurrenceDate,
  contributors,
  isAdmin,
}: {
  personId: string;
  personName: string;
  birthday: Birthday | null;
  year: number;
  occurrenceDate: string | null;
  contributors: EligibleContributor[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const firstName = personName.split(" ")[0];

  const [budget, setBudget] = useState("");
  const [chosen, setChosen] = useState<string[]>(contributors.map((person) => person.personId));
  const [manual, setManual] = useState<Record<string, string>>({});
  const [splitMode, setSplitMode] = useState<"equal" | "manual">("equal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const budgetPennies = useMemo(() => {
    const parsed = parseMoneyToPennies(budget, { field: "a budget" });
    return parsed.ok && parsed.value !== null ? parsed.value : null;
  }, [budget]);

  /**
   * The split.
   *
   * Equal mode uses `splitPenniesEqually`, which is the app's existing
   * remainder-distributing splitter — the same one the recipient editor uses.
   * There is no second algorithm here, and no penny goes missing.
   */
  const allocations = useMemo(() => {
    if (budgetPennies === null || chosen.length === 0) return null;
    if (splitMode === "equal") {
      try {
        return splitPenniesEqually(budgetPennies, chosen)
          .map((row) => ({ personId: row.contributorId, pennies: row.plannedAmountPennies }));
      } catch {
        return null;
      }
    }
    const rows = chosen.map((id) => {
      const parsed = parseMoneyToPennies(manual[id] ?? "", { field: "an amount" });
      return { personId: id, pennies: parsed.ok && parsed.value !== null ? parsed.value : null };
    });
    return rows.some((row) => row.pennies === null)
      ? null
      : rows.map((row) => ({ personId: row.personId, pennies: row.pennies as number }));
  }, [budgetPennies, chosen, manual, splitMode]);

  const plannedTotal = allocations?.reduce((sum, row) => sum + row.pennies, 0) ?? null;
  const totalsMatch = budgetPennies !== null && plannedTotal !== null && plannedTotal === budgetPennies;

  const next = birthday ? nextBirthdayOccurrence(birthday, `${year}-01-01`) : null;
  // The age they turn on the occurrence being planned -- so the person setting
  // a budget can see it is the 30th and not a 31st. Null when no year of birth
  // is recorded, and then nothing is shown.
  const turning = birthday ? describeTurningAge(birthday, year) : null;
  const withTurning = (summary: string) => turning ? `${summary} · ${turning}` : summary;

  if (!birthday || !occurrenceDate) {
    return (
      <AppShell width="narrow">
        <PageHeader eyebrow="Birthdays" title={personName} />
        <EmptyState
          className="mt-8"
          illustration="star"
          title="No birthday saved"
          body={isAdmin
            ? "Add the date on the Birthdays page first — planning is for a date the family knows."
            : "An admin has not recorded this birthday yet."}
        />
        <div className="mt-6">
          <ButtonLink href="/birthdays" variant="secondary">All birthdays</ButtonLink>
        </div>
      </AppShell>
    );
  }

  if (!isAdmin) {
    return (
      <AppShell width="narrow">
        <PageHeader
          eyebrow="Birthdays"
          title={personName}
          description={withTurning(`${formatBirthday(birthday.month, birthday.day)}${next ? ` · ${describeDaysAway(next.daysAway)}` : ""}`)}
        />
        <Notice tone="info" className="mt-6">
          Nothing has been planned for {firstName}&apos;s {year} birthday yet. An admin starts the
          planning, and it will appear here once they have.
        </Notice>
        <WishlistPanel
          personId={personId}
          personName={personName}
          occurrenceYear={next ? next.year : year}
          className="mt-6"
        />
        <div className="mt-6">
          <ButtonLink href="/birthdays" variant="secondary">All birthdays</ButtonLink>
        </div>
      </AppShell>
    );
  }

  const toggle = (id: string) => {
    setError(null);
    setChosen((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]);
  };

  const start = async () => {
    setError(null);

    if (budgetPennies === null) { setError("Enter a budget."); return; }
    if (chosen.length === 0) { setError("Choose at least one person to contribute."); return; }
    if (!allocations) { setError("Enter an amount for everybody contributing."); return; }
    if (!totalsMatch) {
      setError(
        `The amounts add up to ${formatPennies(plannedTotal ?? 0)} but the budget is ${formatPennies(budgetPennies)}.`,
      );
      return;
    }

    setSaving(true);
    try {
      // ONE call. The database creates the occurrence, the recipient, the
      // budget, the contributors and the plan together, or nothing at all.
      const result = await createClient().rpc("start_birthday_planning", {
        p_celebrant_person_id: personId,
        p_name: suggestedBirthdayEventName(personName, year),
        p_event_date: occurrenceDate,
        p_budget_pennies: budgetPennies,
        p_contributions: allocations.map((row) => ({ person_id: row.personId, pennies: row.pennies })),
      });

      if (result.error) {
        // One birthday per person per year is a unique index; a second attempt
        // must read as a sentence, not as `events_one_birthday_..._idx`.
        setError(describeEventWriteError(result.error, "The birthday could not be set up."));
        return;
      }
      const created = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!created?.id) {
        setError("The setup could not be confirmed by the database, so nothing was created. Please try again.");
        return;
      }

      // Straight to the real Event Home. No landing page in between, and no
      // refresh of the route being left.
      router.replace(`/events/${created.id}`);
    } catch (thrown) {
      setError(describeThrown(thrown, "The birthday could not be set up. Check your connection and try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell width="narrow" title="Start planning">
      <PageHeader
        eyebrow="Birthdays"
        title={`Start ${suggestedBirthdayEventName(personName, year)}`}
        description={withTurning(`${formatBirthday(birthday.month, birthday.day)} ${year}${next ? ` · ${describeDaysAway(next.daysAway)}` : ""}`)}
        actions={<ButtonLink href="/birthdays" variant="secondary" size="lg" className="w-full sm:w-auto">Cancel</ButtonLink>}
      />

      {error && <Notice tone="danger" className="mt-6">{error}</Notice>}

      {/* What they said they would like, before anybody decides a budget. It is
          the only thing on this page the birthday person wrote, and the only
          thing on it they will ever see. */}
      <WishlistPanel
        personId={personId}
        personName={personName}
        occurrenceYear={year}
        className="mt-8"
      />

      <section className="mt-8 space-y-4">
        <h2 className="font-display text-xl font-semibold text-ink-900">Budget</h2>
        <GarlandRule />
        <Field label="Budget" required hint={`What the family plans to spend on ${firstName} this year.`}>
          <MoneyInput
            value={budget}
            maxLength={INPUT_LIMITS.money}
            onValueChange={(next) => { setBudget(next); setError(null); }}
          />
        </Field>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold text-ink-900">Who is contributing?</h2>
        <p className="mt-1.5 text-sm leading-6 text-ink-600">
          {contributors.length === 0
            ? "Nobody is set up as a family contributor yet. Add somebody in Family access first."
            : `${firstName} is not on this list — nobody chips in for their own present.`}
        </p>
        <GarlandRule className="mt-4" />

        {contributors.length === 0
          ? (
            <div className="mt-5">
              <ButtonLink href="/more/family-access" variant="tonal">Manage contributors</ButtonLink>
            </div>
          )
          : (
            <div className="mt-5 flex flex-wrap gap-2">
              {contributors.map((person) => {
                const on = chosen.includes(person.personId);
                return (
                  <button
                    key={person.personId}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(person.personId)}
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
          )}
      </section>

      {chosen.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-xl font-semibold text-ink-900">Split</h2>
          <GarlandRule className="mt-4" />
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              variant={splitMode === "equal" ? "primary" : "secondary"}
              className="min-h-11"
              onClick={() => { setSplitMode("equal"); setError(null); }}
            >
              Split equally
            </Button>
            <Button
              variant={splitMode === "manual" ? "primary" : "secondary"}
              className="min-h-11"
              onClick={() => {
                // Seed the manual boxes from the equal split, so adjusting one
                // amount does not mean typing all of them.
                if (budgetPennies !== null && chosen.length > 0) {
                  const seeded: Record<string, string> = {};
                  for (const row of splitPenniesEqually(budgetPennies, chosen)) {
                    seeded[row.contributorId] = (row.plannedAmountPennies / 100).toFixed(2);
                  }
                  setManual(seeded);
                }
                setSplitMode("manual");
                setError(null);
              }}
            >
              Adjust amounts
            </Button>
          </div>

          <ul className="mt-5 divide-y divide-line rounded-2xl border border-line bg-surface">
            {chosen.map((id) => {
              const person = contributors.find((entry) => entry.personId === id);
              const share = allocations?.find((row) => row.personId === id);
              return (
                <li key={id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <span className="min-w-0 font-semibold text-ink-900">{person?.name ?? "Someone"}</span>
                  {splitMode === "equal"
                    ? <span className="font-semibold tabular-nums text-ink-900">{formatPennies(share?.pennies ?? 0)}</span>
                    : (
                      <span className="w-32">
                        <MoneyInput
                          value={manual[id] ?? ""}
                          maxLength={INPUT_LIMITS.money}
                          compact
                          onValueChange={(next) => { setManual((current) => ({ ...current, [id]: next })); setError(null); }}
                        />
                      </span>
                    )}
                </li>
              );
            })}
          </ul>

          <p className={cx(
            "mt-3 text-sm font-semibold",
            totalsMatch ? "text-ink-600" : "text-berry",
          )}>
            {plannedTotal === null || budgetPennies === null
              ? "Enter a budget and the amounts."
              : totalsMatch
                ? `Total ${formatPennies(plannedTotal)} — matches the budget.`
                : `Total ${formatPennies(plannedTotal)} of ${formatPennies(budgetPennies)}. They must match exactly.`}
          </p>
        </section>
      )}

      <div className="mt-10 flex flex-wrap gap-3">
        <Button
          size="lg"
          className="min-h-11"
          disabled={saving || !totalsMatch || chosen.length === 0}
          onClick={() => void start()}
        >
          {saving ? "Starting…" : <><Plus size={18} aria-hidden />Start planning</>}
        </Button>
        <ButtonLink href="/birthdays" variant="secondary" size="lg" className="min-h-11">
          <Cake size={18} aria-hidden />
          All birthdays
        </ButtonLink>
      </div>
    </AppShell>
  );
}
