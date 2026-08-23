import { NextResponse } from "next/server";
import { createClient as createAdminSupabaseClient } from "@supabase/supabase-js";
import { londonToday } from "@/utils/supabase/birthdays-server";
import { flushNotificationOutbox } from "@/utils/supabase/notifications-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * The daily birthday reminder sweep.
 *
 * WHY THIS IS AN ENDPOINT AND NOT A TIMER IN THE APP
 *   Reminders must arrive whether or not anybody has the app open. A scheduled
 *   GitHub Actions workflow calls this once a day; the repository already
 *   schedules the database backup the same way, so this adds a caller rather
 *   than a second piece of infrastructure. Cloudflare cron triggers were the
 *   alternative and were rejected: the OpenNext worker exports a fetch handler,
 *   and wrapping it to add a `scheduled` export means owning generated code.
 *
 * WHAT IT DOES, AND DELIBERATELY DOES NOT DO
 *   It decides WHICH reminders are due and hands them to the EXISTING
 *   notification outbox. It sends nothing itself, writes no notification row,
 *   and knows nothing about push. Everything after "this is due" is the
 *   pipeline that already delivers purchases and payments — same dedupe, same
 *   retries, same Notification Centre, same Web Push.
 *
 * TWO SWEEPS, ONE JOB
 *   Every day: the one-week and one-day reminders, from the PERMANENT birthday
 *   dates. On the 1st of the month, additionally: a budgeting summary for each
 *   contributor with money planned towards a birthday falling in that month.
 *
 *   They are deliberately not the same thing. The first says a birthday is
 *   coming and needs only a date. The second says how much YOU have put aside
 *   and needs the contribution plan inside that year's occurrence — so it is
 *   sent to nobody when no occurrence or no plan exists, and it invents no
 *   figure of its own.
 *
 *   One job rather than two schedules: the daily sweep already runs, already
 *   resolves the family's own date, and already owns the outbox handover.
 *
 * IDEMPOTENCE
 *   Two layers, both in the database, neither in memory:
 *     1. `claim_birthday_reminder` inserts a row unique on
 *        (person, occurrence year, stage). Only the caller that wins the insert
 *        proceeds, so a second run the same day claims nothing.
 *     2. The outbox is unique on (kind, subject, fingerprint), so even a
 *        re-enqueued row converges on one send.
 *   Next year is a different occurrence year, so the same stage sends again —
 *   which is the annual renewal, with nothing deleted or reset to achieve it.
 */
export async function POST(request: Request) {
  const secret = process.env.BIRTHDAY_REMINDER_SECRET;
  if (!secret) {
    // Fail closed. An unauthenticated "send all birthday reminders" endpoint is
    // exactly what must never exist, so a missing secret disables the route
    // rather than opening it.
    console.error("[birthday-reminders] BIRTHDAY_REMINDER_SECRET is not configured");
    return NextResponse.json({ error: "Not configured." }, { status: 503, headers: noStoreHeaders });
  }

  // Constant-time-ish comparison on equal-length strings, and never logged.
  const presented = request.headers.get("x-reminder-secret") ?? "";
  if (!secretsMatch(presented, secret)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401, headers: noStoreHeaders });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseSecretKey) {
    return NextResponse.json({ error: "Not configured." }, { status: 503, headers: noStoreHeaders });
  }

  const admin = createAdminSupabaseClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  // The date the family is living in, not a UTC instant.
  const today = londonToday();

  const due = await admin.rpc("due_birthday_reminders", { p_today: today });
  if (due.error) {
    console.error("[birthday-reminders] due list failed", { code: due.error.code });
    return NextResponse.json({ error: "Reminders could not be evaluated." }, { status: 502, headers: noStoreHeaders });
  }

  type DueRow = {
    person_id: string;
    person_name: string;
    occurrence_year: number;
    occurrence_date: string;
    stage: string;
  };

  let claimed = 0;
  let queued = 0;
  for (const row of (due.data ?? []) as DueRow[]) {
    const claim = await admin.rpc("claim_birthday_reminder", {
      p_person_id: row.person_id,
      p_occurrence_year: row.occurrence_year,
      p_stage: row.stage,
      p_occurrence_date: row.occurrence_date,
    });
    // A lost race is not an error: somebody else already claimed this exact
    // reminder, and it will be delivered once.
    if (claim.error || claim.data !== true) continue;
    claimed += 1;

    const reminder = await admin
      .from("birthday_reminders")
      .select("id")
      .eq("person_id", row.person_id)
      .eq("occurrence_year", row.occurrence_year)
      .eq("stage", row.stage)
      .maybeSingle();
    if (reminder.error || !reminder.data) continue;

    // Into the EXISTING outbox. If this insert fails the claim still stands and
    // the reminder is not re-queued tomorrow — which is the deliberate
    // trade-off: a reminder is better missed than sent twice, and the row is
    // still visible in `birthday_reminders` for anybody investigating.
    const enqueued = await admin
      .from("notification_outbox")
      .insert({
        kind: "birthday_reminder",
        subject_id: reminder.data.id,
        fingerprint: `${row.occurrence_year}:${row.stage}`,
        actor_app_member_id: null,
      })
      .select("id");
    if (!enqueued.error) queued += 1;
  }

  // -------------------------------------------------------------------------
  // The 1st of the month: what each contributor has planned for the birthdays
  // in it.
  //
  // The day check lives in the database function as well, so a sweep run on any
  // other day produces nothing at all and cannot be made to.
  // -------------------------------------------------------------------------
  let budgetClaimed = 0;
  let budgetQueued = 0;

  const budgetRows = await admin.rpc("due_birthday_budget_summaries", { p_today: today });
  if (budgetRows.error) {
    console.error("[birthday-reminders] budget list failed", { code: budgetRows.error.code });
  } else {
    type BudgetRow = {
      contributor_person_id: string;
      celebrant_name: string;
      event_date: string;
      planned_amount_pennies: number;
    };

    // One summary per contributor, however many birthdays they are budgeting
    // for. Three notifications at eight in the morning is noise; one that names
    // each birthday and totals them is something to act on.
    const byContributor = new Map<string, BudgetRow[]>();
    for (const row of (budgetRows.data ?? []) as BudgetRow[]) {
      const existing = byContributor.get(row.contributor_person_id) ?? [];
      existing.push(row);
      byContributor.set(row.contributor_person_id, existing);
    }

    const month = today.slice(0, 7);

    for (const [contributorPersonId, rows] of byContributor) {
      const lines = rows.map((row) => ({
        celebrant_name: row.celebrant_name,
        event_date: isoDate(row.event_date),
        planned_amount_pennies: Number(row.planned_amount_pennies),
      }));
      // Integer pennies, summed here and checked again by the database when the
      // claim is made, so the total and the list cannot disagree.
      const totalPennies = lines.reduce((sum, line) => sum + line.planned_amount_pennies, 0);
      if (totalPennies <= 0) continue;

      const claim = await admin.rpc("claim_birthday_budget_summary", {
        p_contributor_person_id: contributorPersonId,
        p_budget_month: month,
        p_total_pennies: totalPennies,
        p_birthday_count: lines.length,
        p_lines: lines,
      });
      // A lost race is not an error: somebody else already claimed this exact
      // month for this person, and it will be delivered once.
      if (claim.error || !claim.data) continue;
      budgetClaimed += 1;

      const enqueued = await admin
        .from("notification_outbox")
        .insert({
          kind: "birthday_budget_month",
          subject_id: claim.data as string,
          fingerprint: month,
          actor_app_member_id: null,
        })
        .select("id");
      if (!enqueued.error) budgetQueued += 1;
    }
  }

  // Deliver what was just queued, on this request, rather than waiting for
  // somebody to open the app.
  const reports = await flushNotificationOutbox();

  // Counts only. No name, no date, no birthday, no secret.
  console.info("[birthday-reminders] swept", {
    due: (due.data ?? []).length,
    claimed,
    queued,
    budgetClaimed,
    budgetQueued,
    delivered: reports.reduce((sum, report) => sum + report.delivered, 0),
  });

  return NextResponse.json(
    { due: (due.data ?? []).length, claimed, queued, budgetClaimed, budgetQueued },
    { headers: noStoreHeaders },
  );
}

/**
 * `YYYY-MM-DD`, whatever the driver handed over.
 *
 * PostgREST returns a `date` as a string, but a direct driver returns a `Date`,
 * and `String(aDate).slice(0, 10)` is "Fri Nov 06" — which would be stored in
 * the claim and read straight back out into the notification. The claim is
 * durable, so this is not a glitch a refresh would fix.
 */
function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}/u.test(text) ? text.slice(0, 10) : text;
}

function secretsMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
