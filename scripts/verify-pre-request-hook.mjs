#!/usr/bin/env node
/**
 * DOES THE POSTGREST PRE-REQUEST HOOK ACTUALLY WORK?
 *
 * Migration 038 asks PostgREST to run `public.claim_active_area` before every
 * request, and that one line is what the whole multi-Area application rests on:
 * it turns the `x-area-id` header into an acting Area INSIDE the request
 * transaction, which is the only place it can be set, and which is what lets
 * `is_app_admin()` answer about the family on screen instead of refusing to
 * guess.
 *
 * IT CANNOT BE PROVED FROM THE SQL EDITOR. The SQL editor is not PostgREST and
 * never runs the hook, so `select acting_area()` there returns null whether the
 * hook works or not. It cannot be proved with the service key either: the hook
 * checks `is_area_member`, the service role has no `auth.uid()`, and so the
 * claim is correctly refused for reasons that have nothing to do with whether
 * the hook ran. The proof needs a REAL SIGNED-IN MEMBER going through PostgREST,
 * which is exactly what this script is.
 *
 * NOTHING HERE WRITES A ROW. Every call is a read: `acting_area()` reads a
 * transaction-local setting, `is_app_admin()` and `is_area_member()` read the
 * membership table, and the Area list is an ordinary select behind row level
 * security. Signing in is the only side effect, and it is an ordinary login.
 *
 * USAGE
 *   node scripts/verify-pre-request-hook.mjs <email> <password>
 *     or
 *   VERIFY_EMAIL=... VERIFY_PASSWORD=... node scripts/verify-pre-request-hook.mjs
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY from
 * .env.local. The service key is never used and never read.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  let raw = "";
  try {
    raw = readFileSync(join(ROOT, ".env.local"), "utf8");
  } catch {
    return {};
  }
  return Object.fromEntries(
    raw.split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
}

const env = { ...loadEnv(), ...process.env };
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const EMAIL = process.argv[2] ?? env.VERIFY_EMAIL;
const PASSWORD = process.argv[3] ?? env.VERIFY_PASSWORD;

if (!URL_BASE || !ANON) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set (.env.local).");
  process.exit(2);
}
if (!EMAIL || !PASSWORD) {
  console.error("Usage: node scripts/verify-pre-request-hook.mjs <email> <password>");
  process.exit(2);
}

/** An Area id that is a well-formed uuid and belongs to nobody. */
const NOT_AN_AREA = "00000000-0000-4000-8000-000000000000";
/** Not a uuid at all. The hook must ignore it rather than fail the request. */
const NONSENSE = "not-a-uuid";

async function signIn() {
  const response = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) {
    console.error(`Sign-in failed (${response.status}). ${await response.text()}`);
    process.exit(1);
  }
  const body = await response.json();
  return body.access_token;
}

/** One PostgREST call, optionally carrying the header the hook reads. */
async function call(token, path, { area, method = "POST", body = "{}" } = {}) {
  const headers = {
    apikey: ANON,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (area !== undefined) headers["x-area-id"] = area;

  const response = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* leave as text */ }
  return { status: response.status, value: parsed };
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const mark = passed === null ? "  ?" : passed ? "  ✔" : "  ✘";
  console.log(`${mark} ${name}`);
  if (detail) console.log(`      ${detail}`);
}

const token = await signIn();

// ---------------------------------------------------------------------------
// Which Areas is this account really in? Ordinary select, behind row level
// security -- so this list IS the authority the hook is checked against.
// ---------------------------------------------------------------------------
const areasResponse = await call(token, "areas?select=id,name,archived_at", { method: "GET" });
if (areasResponse.status !== 200 || !Array.isArray(areasResponse.value)) {
  console.error("Could not read the Area list:", areasResponse);
  process.exit(1);
}
const areas = areasResponse.value;
console.log(`\nSigned in. This account belongs to ${areas.length} Area${areas.length === 1 ? "" : "s"}.`);
for (const area of areas) console.log(`  · ${area.id}  ${area.name}${area.archived_at ? "  (archived)" : ""}`);
if (areas.length === 0) {
  console.error("\nThis account belongs to no Area, so there is nothing to claim. Use a member's login.");
  process.exit(1);
}
console.log("");

// ---------------------------------------------------------------------------
// 1. THE HOOK IS REACHABLE AT ALL.
// ---------------------------------------------------------------------------
const bare = await call(token, "rpc/acting_area");
record(
  "acting_area() is exposed and callable",
  bare.status === 200,
  `status ${bare.status}, value ${JSON.stringify(bare.value)}`,
);

// ---------------------------------------------------------------------------
// 2. NO HEADER -> NO CLAIM. Whatever else is true, a request that says nothing
//    must act in no Area. The single-Area fallback in 036 depends on it.
// ---------------------------------------------------------------------------
record(
  "no x-area-id header leaves no acting Area",
  bare.value === null,
  `acting_area() = ${JSON.stringify(bare.value)}`,
);

// ---------------------------------------------------------------------------
// 3. THE HEADER IS HONOURED. *THE* TEST. If this fails, the hook is not
//    running -- and a login with two memberships loses every admin RPC.
// ---------------------------------------------------------------------------
const mine = areas[0].id;
const claimed = await call(token, "rpc/acting_area", { area: mine });
const hookWorks = claimed.value === mine;
record(
  "x-area-id naming an Area the caller IS in becomes the acting Area",
  hookWorks,
  `sent ${mine}, acting_area() = ${JSON.stringify(claimed.value)}`,
);

// ---------------------------------------------------------------------------
// 4. AN AREA THE CALLER IS NOT IN IS IGNORED, NOT OBEYED, AND NOT AN ERROR.
//    Ignored rather than refused on purpose: a stale cookie from a family
//    somebody has left must not break every request they make.
// ---------------------------------------------------------------------------
const foreign = await call(token, "rpc/acting_area", { area: NOT_AN_AREA });
record(
  "x-area-id naming an Area the caller is NOT in is ignored",
  foreign.status === 200 && foreign.value === null,
  `status ${foreign.status}, acting_area() = ${JSON.stringify(foreign.value)}`,
);

// ---------------------------------------------------------------------------
// 5. A MALFORMED HEADER IS IGNORED, AND DOES NOT FAIL THE REQUEST.
// ---------------------------------------------------------------------------
const junk = await call(token, "rpc/acting_area", { area: NONSENSE });
record(
  "a malformed x-area-id is ignored and the request still succeeds",
  junk.status === 200 && junk.value === null,
  `status ${junk.status}, acting_area() = ${JSON.stringify(junk.value)}`,
);

// ---------------------------------------------------------------------------
// 6. AN EMPTY HEADER BEHAVES AS NO HEADER.
// ---------------------------------------------------------------------------
const blank = await call(token, "rpc/acting_area", { area: "" });
record(
  "an empty x-area-id behaves as no header",
  blank.status === 200 && blank.value === null,
  `status ${blank.status}, acting_area() = ${JSON.stringify(blank.value)}`,
);

// ---------------------------------------------------------------------------
// 7. THE CLAIM IS NOT A PERMISSION. Claiming an Area gets you a member's
//    rights there, never an administrator's -- `is_app_admin()` still reads the
//    membership table.
// ---------------------------------------------------------------------------
for (const area of areas) {
  const admin = await call(token, "rpc/is_app_admin", { area: area.id });
  const member = await call(token, "rpc/is_area_member", { area: area.id, body: JSON.stringify({ p_area_id: area.id }) });
  const areaAdmin = await call(token, "rpc/is_area_admin", { area: area.id, body: JSON.stringify({ p_area_id: area.id }) });
  const person = await call(token, "rpc/current_person_in_area", { area: area.id, body: JSON.stringify({ p_area_id: area.id }) });

  record(
    `acting in ${area.name}: is_app_admin() agrees with is_area_admin()`,
    admin.value === areaAdmin.value,
    `is_app_admin=${JSON.stringify(admin.value)} is_area_admin=${JSON.stringify(areaAdmin.value)} ` +
    `is_area_member=${JSON.stringify(member.value)} person=${JSON.stringify(person.value)}`,
  );
}

// ---------------------------------------------------------------------------
// 8. A SINGLE-AREA ACCOUNT STILL WORKS WITH NO HEADER AT ALL -- the shape every
//    account has today, and the one that must not regress when the app starts
//    sending the header.
// ---------------------------------------------------------------------------
if (areas.length === 1) {
  const withoutHeader = await call(token, "rpc/is_app_admin");
  const withHeader = await call(token, "rpc/is_app_admin", { area: areas[0].id });
  record(
    "a single-Area account gets the same answer with and without the header",
    withoutHeader.value === withHeader.value,
    `without=${JSON.stringify(withoutHeader.value)} with=${JSON.stringify(withHeader.value)}`,
  );
} else {
  const withoutHeader = await call(token, "rpc/is_app_admin");
  record(
    "a multi-Area account that says nothing is refused rather than guessed at",
    withoutHeader.value === false,
    `is_app_admin() with no header = ${JSON.stringify(withoutHeader.value)}`,
  );
}

// ---------------------------------------------------------------------------
console.log("");
const failed = results.filter((entry) => entry.passed === false);
if (!hookWorks) {
  console.log("VERDICT: the pre-request hook is NOT taking effect.");
  console.log("");
  console.log("  The application still works for anyone who belongs to exactly one Area:");
  console.log("  every legacy question falls back to the single-membership answer. What");
  console.log("  breaks is a login that belongs to TWO -- is_app_admin() returns false in");
  console.log("  both, so every admin RPC is refused. That is a loss of function, not a");
  console.log("  loss of safety: nothing becomes readable or writable that was not before.");
  console.log("");
  console.log("  Check, in this order:");
  console.log("    1. select setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole");
  console.log("       where r.rolname = 'authenticator';   -- expect pgrst.db_pre_request");
  console.log("    2. notify pgrst, 'reload config';       -- PostgREST re-reads role settings");
  console.log("    3. has_function_privilege('authenticator','public.claim_active_area()','execute')");
} else {
  console.log(`VERDICT: the pre-request hook is working. ${results.length - failed.length}/${results.length} checks passed.`);
}
process.exit(failed.length === 0 && hookWorks ? 0 : 1);
