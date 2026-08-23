/**
 * The Event model, as plain data and pure functions.
 *
 * The application used to mean one thing — Christmas 2026 — and now means a
 * family with several events. This file is the shared vocabulary for that:
 * which kinds of event exist, what each one is called and looks like, what a
 * valid event is, where an event lives in the URL space, and how a list of
 * events is ordered for a dashboard.
 *
 * DELIBERATELY PURE
 *   Nothing here reads the database, and nothing here computes money. Budgets,
 *   spend, responsibility and Owed stay exactly where they already are —
 *   `src/lib/purchases.ts`, `src/lib/recipient-allocations.ts` and
 *   `src/lib/owed.ts` — and the Event layer only ever decides WHICH rows those
 *   engines are given. An event type is an icon and a set of setup defaults; it
 *   is never a separate financial system.
 *
 * THE VALIDATORS MIRROR THE DATABASE
 *   Every rule in `validateEventInput` exists as a CHECK constraint or a
 *   foreign key in migration 025. The copy here is for a fast, friendly message
 *   in the browser; the database remains the authority, exactly as
 *   `input-validation.ts` mirrors the constraints from migration 011.
 */

// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { INPUT_LIMITS, validateDateInput, validateEnum, validateOptionalText, validateRequiredText, validateUuid, type ValidationResult } from "./input-validation.ts";

export const EVENT_TYPES = [
  "christmas",
  "birthday",
  "easter",
  "wedding",
  "anniversary",
  "other",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ["active", "archived"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * The sections an event offers. This list IS the URL segment list: each entry
 * other than "home" is a real folder under `src/app/events/[eventId]/`, so a
 * typo here cannot produce a link that resolves to nothing.
 */
export const EVENT_SECTIONS = ["home", "people", "add-purchase", "owed", "more", "payment-log"] as const;
export type EventSection = (typeof EVENT_SECTIONS)[number];

export const EVENT_DESCRIPTION_LIMIT = 1_000;

/**
 * What a type changes, and what it does not.
 *
 * `celebrantIsRecipient` and `celebrantContributes` are the birthday
 * convenience the setup screen starts from — Paige receives, and does not chip
 * in for her own present. They are defaults for a form, never a rule: the admin
 * can change both, which is why they live here as data rather than as a branch
 * inside the setup code.
 */
export type EventTypeMeta = {
  type: EventType;
  label: string;
  icon: string;
  /** Whether the event is about one particular person. */
  requiresCelebrant: boolean;
  allowsCelebrant: boolean;
  celebrantIsRecipient: boolean;
  celebrantContributes: boolean;
  /** Christmas is the only type identified by a year, for historical reasons. */
  usesYear: boolean;
};

const EVENT_TYPE_META: Record<EventType, EventTypeMeta> = {
  christmas: {
    type: "christmas",
    label: "Christmas",
    icon: "🎄",
    requiresCelebrant: false,
    allowsCelebrant: false,
    celebrantIsRecipient: false,
    celebrantContributes: true,
    usesYear: true,
  },
  birthday: {
    type: "birthday",
    label: "Birthday",
    icon: "🎂",
    requiresCelebrant: true,
    allowsCelebrant: true,
    celebrantIsRecipient: true,
    celebrantContributes: false,
    usesYear: false,
  },
  easter: {
    type: "easter",
    label: "Easter",
    icon: "🐣",
    requiresCelebrant: false,
    allowsCelebrant: false,
    celebrantIsRecipient: false,
    celebrantContributes: true,
    usesYear: false,
  },
  wedding: {
    type: "wedding",
    label: "Wedding",
    icon: "💍",
    requiresCelebrant: false,
    allowsCelebrant: true,
    celebrantIsRecipient: true,
    celebrantContributes: false,
    usesYear: false,
  },
  anniversary: {
    type: "anniversary",
    label: "Anniversary",
    icon: "❤️",
    requiresCelebrant: false,
    allowsCelebrant: true,
    celebrantIsRecipient: true,
    celebrantContributes: false,
    usesYear: false,
  },
  other: {
    type: "other",
    label: "Event",
    icon: "🎁",
    requiresCelebrant: false,
    allowsCelebrant: true,
    celebrantIsRecipient: false,
    celebrantContributes: true,
    usesYear: false,
  },
};

/**
 * Metadata for a type, including one the database has learned about and this
 * build has not. A future event type must never blank out an event card.
 */
export function eventTypeMeta(type: string): EventTypeMeta {
  return EVENT_TYPE_META[type as EventType] ?? EVENT_TYPE_META.other;
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

export function isEventStatus(value: unknown): value is EventStatus {
  return typeof value === "string" && (EVENT_STATUSES as readonly string[]).includes(value);
}

/** One event, as every screen above the database sees it. */
export type EventSummary = {
  id: string;
  name: string;
  type: EventType | string;
  /** ISO `YYYY-MM-DD`. */
  eventDate: string;
  status: EventStatus | string;
  year: number | null;
  celebrantPersonId: string | null;
  description: string | null;
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
// Event context belongs in the URL, not in a React provider. A refreshed tab, a
// bookmark, a notification deep link and a shared link must all land back in
// the same event, and a server loader must be able to read the event from the
// request rather than trusting the client to tell it.

export const EVENTS_ROOT = "/events";

/**
 * The path for an event, or one of its sections.
 *
 * Returns null for anything that is not a real event id, so a caller cannot
 * accidentally build `/events/undefined` or smuggle a path segment through an
 * id. The section list is closed for the same reason.
 */
export function eventPath(eventId: string, section: EventSection = "home"): string | null {
  const validId = validateUuid(eventId);
  if (!validId.ok) return null;
  if (!(EVENT_SECTIONS as readonly string[]).includes(section)) return null;
  return section === "home"
    ? `${EVENTS_ROOT}/${validId.value}`
    : `${EVENTS_ROOT}/${validId.value}/${section}`;
}

/**
 * The event id inside an in-app path, or null.
 *
 * Used to decide which event a link belongs to without re-deriving the route
 * shape in three places. It reads a path only — never a full URL — because
 * every link this app produces is site-relative by construction.
 */
export function eventIdFromPath(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith(`${EVENTS_ROOT}/`)) return null;
  const [, , rawId] = path.split("?")[0].split("#")[0].split("/");
  const validId = validateUuid(rawId ?? "");
  return validId.ok ? validId.value : null;
}

/**
 * Which section of an event a path is in, or null when it is not inside one.
 *
 * The navigation highlights the active tab from this rather than from a pile of
 * `startsWith` tests, so adding a section means adding one entry to
 * `EVENT_SECTIONS` and nothing else.
 */
export function eventSectionFromPath(path: string): EventSection | null {
  if (!eventIdFromPath(path)) return null;
  const segments = path.split("?")[0].split("#")[0].split("/");
  const section = segments[3];
  if (!section) return "home";
  return (EVENT_SECTIONS as readonly string[]).includes(section) ? (section as EventSection) : null;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** "25 December 2026", in the family's own locale and never shifted by a timezone. */
export function formatEventDate(isoDate: string): string {
  const valid = validateDateInput(isoDate);
  if (!valid.ok) return "";
  const [year, month, day] = valid.value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** "🎄 Christmas 2026". The icon is part of how people tell events apart. */
export function eventDisplayName(event: Pick<EventSummary, "name" | "type">): string {
  return `${eventTypeMeta(event.type).icon} ${event.name}`.trim();
}

// ---------------------------------------------------------------------------
// Dashboard ordering
// ---------------------------------------------------------------------------

export type PartitionedEvents<T extends EventSummary> = {
  /** Today or later, soonest first — what the family is actually planning. */
  upcoming: T[];
  /** Already happened, most recent first. */
  past: T[];
  /** Deliberately put away. Never mixed into the primary list. */
  archived: T[];
};

/**
 * Split events into the three lists a dashboard shows.
 *
 * `today` is passed in rather than read from the clock so the result is
 * deterministic, and so a server render and the browser that hydrates it cannot
 * disagree about which side of midnight they are on.
 */
export function partitionEvents<T extends EventSummary>(
  events: readonly T[],
  today: string,
): PartitionedEvents<T> {
  const validToday = validateDateInput(today);
  const boundary = validToday.ok ? validToday.value : "";

  const upcoming: T[] = [];
  const past: T[] = [];
  const archived: T[] = [];

  for (const event of events) {
    if (event.status === "archived") {
      archived.push(event);
      continue;
    }
    if (boundary && event.eventDate < boundary) past.push(event);
    else upcoming.push(event);
  }

  return {
    upcoming: [...upcoming].sort(byDateThenName(1)),
    past: [...past].sort(byDateThenName(-1)),
    archived: [...archived].sort(byDateThenName(-1)),
  };
}

function byDateThenName(direction: 1 | -1) {
  return <T extends EventSummary>(left: T, right: T) => {
    if (left.eventDate !== right.eventDate) {
      return left.eventDate < right.eventDate ? -direction : direction;
    }
    return left.name.localeCompare(right.name, "en-GB");
  };
}

// ---------------------------------------------------------------------------
// Setup defaults
// ---------------------------------------------------------------------------

export type EventSetupDefaults = {
  /** People who should start as recipients of this event. */
  recipientPersonIds: string[];
  /** People who should start UNticked as contributors. */
  excludedContributorPersonIds: string[];
};

/**
 * What the create-event form should start with.
 *
 * For a birthday: the birthday person receives, and is left out of paying for
 * their own present. Every one of these is a starting position the admin can
 * overturn before saving — this function decides the default, never the rule.
 */
export function defaultEventSetup(
  type: string,
  celebrantPersonId: string | null,
): EventSetupDefaults {
  const meta = eventTypeMeta(type);
  const celebrant = celebrantPersonId && validateUuid(celebrantPersonId).ok
    ? celebrantPersonId
    : null;
  if (!celebrant || !meta.allowsCelebrant) {
    return { recipientPersonIds: [], excludedContributorPersonIds: [] };
  }
  return {
    recipientPersonIds: meta.celebrantIsRecipient ? [celebrant] : [],
    excludedContributorPersonIds: meta.celebrantContributes ? [] : [celebrant],
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type EventInput = {
  name: unknown;
  type: unknown;
  eventDate: unknown;
  status?: unknown;
  year?: unknown;
  celebrantPersonId?: unknown;
  description?: unknown;
};

export type ValidatedEvent = {
  name: string;
  type: EventType;
  eventDate: string;
  status: EventStatus;
  year: number | null;
  celebrantPersonId: string | null;
  description: string | null;
};

/**
 * Every rule migration 025 enforces, checked here first so the person filling
 * in the form is told which field is wrong instead of being handed a constraint
 * name. The database still decides; this only decides what to say.
 */
export function validateEventInput(input: EventInput): ValidationResult<ValidatedEvent> {
  const name = validateRequiredText(input.name, { field: "an event name", maxLength: INPUT_LIMITS.name });
  if (!name.ok) return name;

  const type = validateEnum(input.type, EVENT_TYPES, "Choose what kind of event this is.");
  if (!type.ok) return type;
  const meta = EVENT_TYPE_META[type.value];

  const eventDate = validateDateInput(input.eventDate, "Choose the date this event is for.");
  if (!eventDate.ok) return eventDate;

  const status = input.status === undefined
    ? { ok: true as const, value: "active" as EventStatus }
    : validateEnum(input.status, EVENT_STATUSES, "Choose whether this event is active or archived.");
  if (!status.ok) return status;

  const description = validateOptionalText(input.description, {
    field: "the event description",
    maxLength: EVENT_DESCRIPTION_LIMIT,
    multiline: true,
  });
  if (!description.ok) return description;

  let celebrantPersonId: string | null = null;
  if (input.celebrantPersonId !== null && input.celebrantPersonId !== undefined && input.celebrantPersonId !== "") {
    const celebrant = validateUuid(input.celebrantPersonId, "Choose who this event is for.");
    if (!celebrant.ok) return celebrant;
    celebrantPersonId = celebrant.value;
  }
  if (celebrantPersonId && !meta.allowsCelebrant) {
    return { ok: false, error: `A ${meta.label.toLowerCase()} event is not about one person.` };
  }
  if (!celebrantPersonId && meta.requiresCelebrant) {
    return { ok: false, error: `Choose whose ${meta.label.toLowerCase()} this is.` };
  }

  // Christmas keeps its year because every existing screen, function and saved
  // link finds Christmas by it. Nothing else has one, so nothing else can
  // collide with it.
  let year: number | null = null;
  if (meta.usesYear) {
    const rawYear = input.year ?? Number(eventDate.value.slice(0, 4));
    if (typeof rawYear !== "number" || !Number.isInteger(rawYear) || rawYear < 1900 || rawYear > 2999) {
      return { ok: false, error: "Enter the Christmas year." };
    }
    year = rawYear;
  } else if (typeof input.year === "number" && Number.isInteger(input.year)) {
    return { ok: false, error: `Only Christmas events are identified by a year.` };
  }

  return {
    ok: true,
    value: {
      name: name.value,
      type: type.value,
      eventDate: eventDate.value,
      status: status.value,
      year,
      celebrantPersonId,
      description: description.value,
    },
  };
}
