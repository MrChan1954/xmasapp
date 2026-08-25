/**
 * THE GUARD THAT STANDS BETWEEN QA AND THE REAL FAMILY.
 *
 * The decision this file serves: QA now happens inside the SAME database as the
 * real family, in synthetic Areas of its own. That is a reasonable use of a
 * tenant boundary -- it is the same RLS, the same membership rules and the same
 * RPCs the product uses, which is exactly what makes the test meaningful. But it
 * removes the crudest safety net there is. There is no longer a separate
 * database whose worst case is "the QA copy broke".
 *
 * So the net has to be rebuilt deliberately, and this is it.
 *
 * WHAT THIS IS NOT
 *
 *   NOT PRODUCT AUTHORIZATION. Nothing here decides what a signed-in person may
 *   do. That is RLS, the write barrier, and the SECURITY DEFINER routines, and
 *   it stays there. This file cannot grant anything; it can only refuse.
 *   `scripts/qa/no-product-coupling.test.mjs` proves the product does not import
 *   it and does not know the protected id exists.
 *
 *   NOT A BYPASS. It disables no policy, holds no service-role reasoning, and
 *   makes nothing reachable that was not already reachable.
 *
 *   NOT SCHEMA. No migration, no column, no marker on a row. A QA Area is
 *   identified by a list of ids in a file that is never committed, so the
 *   database cannot tell a QA Area from any other -- which is the point. A QA
 *   Area must be exactly as isolated as a real one, and a marker the product
 *   could read would be a way for it to stop being so.
 *
 * EVERYTHING HERE FAILS CLOSED. A missing config, an unparseable one, an id that
 * cannot be resolved to an Area, a row that cannot be read: every one of those
 * is a refusal, never a shrug. The failure mode of a QA tool that guesses is a
 * write into somebody's real Christmas.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The un-committed file listing what is protected and what is fair game. */
export const CONFIG_PATH = join(HERE, "..", "..", ".qa-areas.local.json");

/** Refusals are their own type so a caller cannot mistake one for a bug. */
export class ProtectedTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtectedTargetError";
  }
}

const refuse = (message) => { throw new ProtectedTargetError(message); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const asIdSet = (value, field) => {
  if (!Array.isArray(value)) refuse(`${field} must be a list of ids`);
  for (const id of value) {
    if (typeof id !== "string" || !UUID.test(id)) refuse(`${field} contains something that is not an id: ${String(id)}`);
  }
  return new Set(value.map((id) => id.toLowerCase()));
};

/**
 * READ THE CONFIG, AND REFUSE ANYTHING AMBIGUOUS.
 *
 * `read` is injectable so the tests can run the real logic against synthetic
 * ids rather than against whatever happens to be on this machine.
 */
export function loadQaConfig({ path = CONFIG_PATH, read = readFileSync } = {}) {
  let raw;
  try {
    raw = read(path, "utf8");
  } catch {
    refuse(
      `No QA configuration at ${path}. Every QA write is refused until it exists, ` +
      "because without it nothing here knows which Areas are synthetic.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse(`The QA configuration at ${path} is not valid JSON.`);
  }

  const protectedAreaIds = asIdSet(parsed.protectedAreaIds, "protectedAreaIds");
  const protectedEventIds = asIdSet(parsed.protectedEventIds, "protectedEventIds");
  const qaAreaIds = asIdSet(parsed.qaAreaIds, "qaAreaIds");

  if (protectedAreaIds.size === 0) {
    refuse("protectedAreaIds is empty. Refusing rather than assuming nothing needs protecting.");
  }

  /*
   * THE OVERLAP CHECK -- the single most important line in this file.
   *
   * The realistic accident is not somebody typing the real Area id into a
   * destructive command on purpose. It is the real id being pasted into the QA
   * list during setup, after which every guard below would cheerfully agree
   * that the real family's Area is a fine place to run destructive tests. So
   * an id that appears on both lists is a broken config, not a permission.
   */
  for (const id of qaAreaIds) {
    if (protectedAreaIds.has(id)) {
      refuse(`Area ${id} is listed as BOTH protected and QA. Refusing to treat the real family as a test tenant.`);
    }
  }

  if (qaAreaIds.size === 0) {
    refuse(
      "qaAreaIds is empty. No synthetic Area exists yet, so there is nowhere safe to write " +
      "and every QA write is refused.",
    );
  }

  return { protectedAreaIds, protectedEventIds, qaAreaIds };
}

/** The config with no QA Areas yet -- readable, but every write still refused. */
export function loadProtectedOnly({ path = CONFIG_PATH, read = readFileSync } = {}) {
  try {
    return loadQaConfig({ path, read });
  } catch (error) {
    if (!(error instanceof ProtectedTargetError)) throw error;
    // The protected half is still worth having on its own: the fingerprint and
    // the read-only checks need it before any QA Area exists.
    const parsed = JSON.parse(read(path, "utf8"));
    return {
      protectedAreaIds: asIdSet(parsed.protectedAreaIds, "protectedAreaIds"),
      protectedEventIds: asIdSet(parsed.protectedEventIds, "protectedEventIds"),
      qaAreaIds: new Set(),
    };
  }
}

const lower = (id) => (typeof id === "string" ? id.toLowerCase() : id);

/**
 * MAY QA WRITE TO THIS AREA?
 *
 * Allow-list, never deny-list. "Not the real Area" is not good enough: an Area
 * created by a half-finished test run is not protected and not synthetic, and
 * writing to it is still wrong.
 */
export function assertQaArea(config, areaId) {
  if (typeof areaId !== "string" || !UUID.test(areaId)) {
    refuse(`Not an Area id: ${String(areaId)}`);
  }
  const id = lower(areaId);
  if (config.protectedAreaIds.has(id)) {
    refuse(`Area ${areaId} is the REAL FAMILY. QA may not write to it.`);
  }
  if (!config.qaAreaIds.has(id)) {
    refuse(`Area ${areaId} is not a known QA Area. QA writes only where it was told it may.`);
  }
  return areaId;
}

/** The real Christmas, and anything else named as untouchable. */
export function assertNotProtectedEvent(config, eventId) {
  if (typeof eventId !== "string" || !UUID.test(eventId)) {
    refuse(`Not an event id: ${String(eventId)}`);
  }
  if (config.protectedEventIds.has(lower(eventId))) {
    refuse(`Event ${eventId} is protected real data. QA may not open or change it.`);
  }
  return eventId;
}

/**
 * WHERE THE BROWSER IS ALLOWED TO GO.
 *
 * A browser test does not write through this module -- it clicks. So the
 * refusal has to happen at the address bar: any URL naming a protected Area or
 * a protected event is refused before it is opened, because the damage from
 * "just looking" at the real Christmas is a screenshot of the family's real
 * spending in a transcript.
 */
export function assertSafeUrl(config, url) {
  if (typeof url !== "string" || url.length === 0) refuse("Not a URL.");
  const haystack = url.toLowerCase();
  for (const id of config.protectedAreaIds) {
    if (haystack.includes(id)) refuse(`That URL names the real family's Area: ${url}`);
  }
  for (const id of config.protectedEventIds) {
    if (haystack.includes(id)) refuse(`That URL names a protected event: ${url}`);
  }
  return url;
}

/**
 * IS THIS ROW SOMETHING QA MAY TOUCH?
 *
 * The static lists above cannot name every real person and membership, and
 * listing them would mean copying the family's ids into a file. So this asks
 * the database instead: resolve the row, read the Area it lives in, and refuse
 * unless that Area is a known QA Area.
 *
 * `resolve` is the caller's read function, `(table, id) => { area_id } | null`.
 * A row that cannot be resolved is refused -- an unknown row is not a safe one.
 */
export async function assertRowInQaArea(config, resolve, table, id) {
  if (typeof id !== "string" || !UUID.test(id)) {
    refuse(`Not a ${table} id: ${String(id)}`);
  }

  const row = await resolve(table, id);
  if (!row || typeof row.area_id !== "string") {
    refuse(`Could not establish which Area ${table} ${id} belongs to. Refusing rather than guessing.`);
  }

  const area = lower(row.area_id);
  if (config.protectedAreaIds.has(area)) {
    refuse(`${table} ${id} belongs to the REAL FAMILY. QA may not use it.`);
  }
  if (!config.qaAreaIds.has(area)) {
    refuse(`${table} ${id} is in Area ${row.area_id}, which is not a known QA Area.`);
  }
  return id;
}

/**
 * The one door every destructive QA helper goes through.
 *
 * Takes the write as a thunk so the guard cannot be "called" and then ignored:
 * there is no ordering mistake available, because the check and the write are
 * the same expression.
 */
export async function qaWrite(config, { areaId, eventId = null, subjects = [], resolve = null }, write) {
  assertQaArea(config, areaId);
  if (eventId) assertNotProtectedEvent(config, eventId);
  for (const subject of subjects) {
    if (!resolve) refuse("A subject was named but no way to resolve its Area was given.");
    await assertRowInQaArea(config, resolve, subject.table, subject.id);
  }
  return write();
}
