import "server-only";

import { createClient as createAdminSupabaseClient } from "@supabase/supabase-js";
import type { PaymentLogRecord, PaymentLogResponse } from "@/lib/payment-log";
import { createClient as createSessionClient } from "../../../utils/supabase/server";

const CHRISTMAS_YEAR = 2026;

export class PaymentLogServerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "PaymentLogServerError";
  }
}

export async function loadPaymentLog(): Promise<PaymentLogResponse> {
  const session = await createSessionClient();
  const auth = await session.auth.getUser();
  if (auth.error || !auth.data.user) throw new PaymentLogServerError(401, "You must sign in to view the Payment Log.");

  const [membershipResult, eventResult] = await Promise.all([
    session
      .from("app_members")
      .select("id,person_id,contributor_id,role,active")
      .eq("user_id", auth.data.user.id)
      .eq("active", true)
      .maybeSingle(),
    session.from("christmas_events").select("id,year").eq("year", CHRISTMAS_YEAR).maybeSingle(),
  ]);
  if (membershipResult.error || !membershipResult.data) throw new PaymentLogServerError(403, "Your active family membership could not be verified.");
  if (eventResult.error || !eventResult.data) throw new PaymentLogServerError(503, "Christmas 2026 could not be loaded.");
  const membership = membershipResult.data;
  const event = eventResult.data;

  const [contributorsResult, settlementsResult] = await Promise.all([
    session
      .from("contributors")
      .select("id,person_id,active")
      .eq("christmas_event_id", event.id),
    session
      .from("settlements")
      .select("id,payer_contributor_id,payee_contributor_id,amount_pennies,payment_date,recorded_by_app_member_id,notes,created_at,voided_at,voided_by_app_member_id")
      .eq("christmas_event_id", event.id)
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  if (contributorsResult.error) throw new PaymentLogServerError(503, "Christmas contributors could not be loaded.");
  if (settlementsResult.error) throw new PaymentLogServerError(503, paymentLogDatabaseError(settlementsResult.error.code));

  const currentContributor = contributorsResult.data.find((contributor) =>
    contributor.active && (
      contributor.id === membership.contributor_id
      || contributor.person_id === membership.person_id
    ),
  );
  if (!currentContributor) throw new PaymentLogServerError(403, "Your account is not linked to an active Christmas contributor.");

  const settlementRows = settlementsResult.data;
  const appMemberIds = [...new Set(settlementRows.flatMap((row) => [
    row.recorded_by_app_member_id,
    ...(row.voided_by_app_member_id ? [row.voided_by_app_member_id] : []),
  ]))];
  const appMembers = appMemberIds.length
    ? await loadAppMembers(appMemberIds)
    : [];

  const personIds = [...new Set([
    ...contributorsResult.data.map((contributor) => contributor.person_id),
    ...appMembers.flatMap((member) => member.person_id ? [member.person_id] : []),
  ])];
  const peopleResult = personIds.length
    ? await session.from("people").select("id,name").in("id", personIds)
    : { data: [], error: null };
  if (peopleResult.error) throw new PaymentLogServerError(503, "Payment participant names could not be loaded.");

  const namesByPersonId = new Map(peopleResult.data.map((person) => [person.id, person.name]));
  const namesByContributorId = new Map(contributorsResult.data.map((contributor) => [
    contributor.id,
    namesByPersonId.get(contributor.person_id) ?? "Unknown contributor (account link missing)",
  ]));
  const namesByAppMemberId = new Map(appMembers.map((member) => [
    member.id,
    member.person_id
      ? namesByPersonId.get(member.person_id) ?? "Unknown member (person link missing)"
      : "Unknown member (person link missing)",
  ]));

  const records: PaymentLogRecord[] = settlementRows.map((row) => ({
    id: row.id,
    eventYear: event.year,
    payerContributorId: row.payer_contributor_id,
    payerName: namesByContributorId.get(row.payer_contributor_id) ?? "Unknown contributor (record link missing)",
    payeeContributorId: row.payee_contributor_id,
    payeeName: namesByContributorId.get(row.payee_contributor_id) ?? "Unknown contributor (record link missing)",
    amountPennies: row.amount_pennies,
    paymentDate: row.payment_date,
    recordedByAppMemberId: row.recorded_by_app_member_id,
    recordedByName: namesByAppMemberId.get(row.recorded_by_app_member_id) ?? "Unknown member (record link missing)",
    recordedAt: row.created_at,
    notes: row.notes,
    voidedAt: row.voided_at,
    voidedByAppMemberId: row.voided_by_app_member_id,
    voidedByName: row.voided_by_app_member_id
      ? namesByAppMemberId.get(row.voided_by_app_member_id) ?? "Unknown member (record link missing)"
      : null,
  }));

  const contributors = contributorsResult.data.map((contributor) => ({
    id: contributor.id,
    name: namesByContributorId.get(contributor.id) ?? "Unknown contributor (record link missing)",
  })).sort((left, right) => left.name.localeCompare(right.name, "en-GB"));
  const recorders = appMembers.map((member) => ({
    id: member.id,
    name: namesByAppMemberId.get(member.id) ?? "Unknown member (record link missing)",
  })).sort((left, right) => left.name.localeCompare(right.name, "en-GB"));

  return {
    eventId: event.id,
    eventYear: event.year,
    today: londonDateInput(),
    currentContributorId: currentContributor.id,
    currentAppMemberId: membership.id,
    isAdmin: membership.role === "admin",
    contributors,
    recorders,
    records,
  };
}

async function loadAppMembers(ids: string[]) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseSecretKey) throw new PaymentLogServerError(503, "Payment Log name resolution is not configured on the server.");
  const admin = createAdminSupabaseClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const result = await admin.from("app_members").select("id,person_id").in("id", ids);
  if (result.error) throw new PaymentLogServerError(503, "Payment recorder names could not be resolved.");
  return result.data;
}

function londonDateInput() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function paymentLogDatabaseError(code?: string) {
  if (code === "42P01" || code === "PGRST205") return "The existing settlements migration must be applied before Payment Log can load.";
  return "Payment records could not be loaded.";
}
