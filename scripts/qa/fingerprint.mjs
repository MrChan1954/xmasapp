/**
 * A READ-ONLY FINGERPRINT OF THE REAL FAMILY.
 *
 * Taken before a deployment and again after live QA, so the two can be compared
 * and the question "did QA touch anything real?" is answered by the database
 * rather than from recollection.
 *
 * IT ONLY EVER READS. Every request below is a GET. There is no insert, update,
 * delete or mutating RPC anywhere in this file, and that is deliberate rather
 * than incidental: counting across Areas requires seeing across them, so this
 * uses the service role — which bypasses RLS *and* the Area write barrier. A
 * write from here would land silently, with no policy able to refuse it.
 *
 * It talks to PostgREST directly rather than through supabase-js. An exact
 * count comes back in the `Content-Range` header, which is a documented part of
 * the REST contract and does not depend on a client's head-request behaviour.
 *
 * The Areas it reports on come from `.qa-areas.local.json`, which is never
 * committed, so running this writes no real id into the repository.
 *
 * Usage:  node scripts/qa/fingerprint.mjs [label]
 */
import { readFileSync } from "node:fs";

import { loadProtectedOnly } from "./protected.mjs";

/* --- env ---------------------------------------------------------------- */

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SECRET_KEY;
if (!BASE || !KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required");

const headers = (extra = {}) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra });

async function get(path) {
  const response = await fetch(`${BASE}/rest/v1/${path}`, { method: "GET", headers: headers() });
  const body = await response.text();
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status} ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : [];
}

/** An exact row count, read from PostgREST's Content-Range header. */
async function count(path) {
  const response = await fetch(`${BASE}/rest/v1/${path}`, {
    method: "GET",
    headers: headers({ Prefer: "count=exact", Range: "0-0" }),
  });
  if (!response.ok) {
    throw new Error(`COUNT ${path} -> ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const range = response.headers.get("content-range") ?? "";
  const total = range.split("/")[1];
  if (!total || total === "*") throw new Error(`COUNT ${path} -> no exact count in "${range}"`);
  return Number(total);
}

/* --- the protected Area -------------------------------------------------- */

const { protectedAreaIds, protectedEventIds } = loadProtectedOnly();
const [areaId] = [...protectedAreaIds];
const [protectedEventId] = [...protectedEventIds];
if (!areaId) throw new Error("no protected Area configured");

const label = process.argv[2] ?? "fingerprint";
const out = { label, takenAt: new Date().toISOString() };

/*
 * NOTIFICATIONS BELONGING TO THE REAL FAMILY.
 *
 * A notification carries no Area of its own — it is addressed to an app
 * member, and the member is what belongs to an Area. That indirection is
 * exactly what Q4 F1 was about, so the count follows the same join the
 * product's audience code does rather than assuming a column.
 */
out.realFamilyNotifications = await count(
  `notifications?select=id,app_members!inner(area_id)&app_members.area_id=eq.${areaId}`,
);

/* Its people, events and members, so a stray write anywhere shows up. */
out.people = await count(`people?select=id&area_id=eq.${areaId}`);
out.events = await count(`events?select=id&area_id=eq.${areaId}`);
out.appMembers = await count(`app_members?select=id&area_id=eq.${areaId}`);
out.recipients = await count(
  `christmas_recipients?select=id,events!inner(area_id)&events.area_id=eq.${areaId}`,
);

/* Christmas 2026 specifically — the protected event. */
if (protectedEventId) {
  const [event] = await get(
    `events?select=id,name,event_date,year,area_id,status&id=eq.${protectedEventId}`,
  );
  out.protectedEvent = event
    ? {
        name: event.name,
        date: event.event_date,
        year: event.year,
        status: event.status,
        inProtectedArea: event.area_id === areaId,
        recipients: await count(`christmas_recipients?select=id&christmas_event_id=eq.${event.id}`),
      }
    : null;
}

/*
 * CROSS-AREA INTEGRITY.
 *
 * A recipient is a person's place in one event. The person and the event must
 * therefore belong to the SAME Area — a recipient joining an event in one
 * family to a person in another is the precise shape of the Q4 F2 bug, and
 * this is the number that has to be zero. It is checked across every Area,
 * not only the protected one, because a leak has two ends.
 */
const mismatches = {};

const recipientRows = await get(
  "christmas_recipients?select=id,events!inner(area_id),people!inner(area_id)",
);
mismatches.recipientEventVsPerson = recipientRows.filter(
  (row) => row.events?.area_id !== row.people?.area_id,
).length;
out.recipientRowsChecked = recipientRows.length;

const memberRows = await get("app_members?select=id,area_id,people!inner(area_id)");
mismatches.memberVsPerson = memberRows.filter(
  (row) => row.area_id !== row.people?.area_id,
).length;
out.memberRowsChecked = memberRows.length;

out.crossAreaMismatches = mismatches;
out.crossAreaTotal = Object.values(mismatches).reduce((a, b) => a + b, 0);

console.log(JSON.stringify(out, null, 2));
