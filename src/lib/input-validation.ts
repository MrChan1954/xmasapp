export const INPUT_LIMITS = {
  name: 100,
  title: 200,
  retailer: 200,
  notes: 4_000,
  settlementNotes: 2_000,
  url: 2_048,
  email: 254,
  search: 200,
  money: 32,
  requestBody: 8_192,
} as const;

export const MAX_PENNIES = 2_147_483_647;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type TextOptions = {
  field: string;
  maxLength: number;
  multiline?: boolean;
};

const SINGLE_LINE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MULTILINE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function validateRequiredText(
  input: unknown,
  options: TextOptions,
): ValidationResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: `Enter ${options.field}.` };
  }

  const value = input.trim();
  if (!value) return { ok: false, error: `Enter ${options.field}.` };
  if (value.length > options.maxLength) {
    return {
      ok: false,
      error: `Keep ${options.field} under ${options.maxLength.toLocaleString("en-GB")} characters.`,
    };
  }
  if (containsDisallowedControlCharacters(value, Boolean(options.multiline))) {
    return { ok: false, error: `${sentenceCase(options.field)} contains unsupported control characters.` };
  }
  return { ok: true, value };
}

export function validateOptionalText(
  input: unknown,
  options: TextOptions,
): ValidationResult<string | null> {
  if (input === null || input === undefined || input === "") {
    return { ok: true, value: null };
  }
  if (typeof input !== "string") {
    return { ok: false, error: `${sentenceCase(options.field)} must be text.` };
  }

  const value = input.trim();
  if (!value) return { ok: true, value: null };
  const required = validateRequiredText(value, options);
  return required.ok ? { ok: true, value: required.value } : required;
}

export function parseMoneyToPennies(
  input: unknown,
  options: { field?: string; allowEmpty?: boolean; maxPennies?: number } = {},
): ValidationResult<number | null> {
  const field = options.field ?? "an amount";
  if (typeof input !== "string") {
    return { ok: false, error: `Enter ${field} such as 18, 35.00, or 0.99.` };
  }

  const rawValue = input.trim();
  if (rawValue.length > INPUT_LIMITS.money) {
    return { ok: false, error: `${sentenceCase(field)} is too large.` };
  }
  const value = rawValue.replace(/^£\s*/u, "");
  if (!value && options.allowEmpty) return { ok: true, value: null };
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/u.test(value)) {
    return { ok: false, error: `Enter ${field} such as 18, 35.00, or 0.99.` };
  }

  const [pounds, pence = ""] = value.replaceAll(",", "").split(".");
  const pennies = Number(pounds) * 100 + Number(pence.padEnd(2, "0"));
  const maximum = options.maxPennies ?? MAX_PENNIES;
  if (!Number.isSafeInteger(pennies) || pennies > maximum) {
    return { ok: false, error: `${sentenceCase(field)} is too large.` };
  }
  return { ok: true, value: pennies };
}

export function validateHttpUrl(input: unknown): ValidationResult<string | null> {
  if (input === null || input === undefined || input === "") {
    return { ok: true, value: null };
  }
  if (typeof input !== "string") {
    return { ok: false, error: "Enter a valid link beginning with http:// or https://." };
  }

  const value = input.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > INPUT_LIMITS.url) {
    return { ok: false, error: "That link is too long." };
  }
  if (containsDisallowedControlCharacters(value, false)) {
    return { ok: false, error: "That link contains unsupported characters." };
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: "Use a link beginning with http:// or https://." };
    }
    if (url.username || url.password) {
      return { ok: false, error: "Product links cannot include a username or password." };
    }
    if (url.href.length > INPUT_LIMITS.url) {
      return { ok: false, error: "That link is too long." };
    }
    return { ok: true, value: url.href };
  } catch {
    return { ok: false, error: "Enter a valid link beginning with http:// or https://." };
  }
}

export function safeHttpUrl(input: unknown) {
  const result = validateHttpUrl(input);
  return result.ok ? result.value : null;
}

export function validateEmail(input: unknown): ValidationResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "Enter a valid email address." };
  }

  const email = input.trim().toLowerCase();
  if (
    !email ||
    email.length > INPUT_LIMITS.email ||
    containsDisallowedControlCharacters(email, false) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    return { ok: false, error: "Enter a valid email address." };
  }
  return { ok: true, value: email };
}

export function validateUuid(
  input: unknown,
  message = "Select a valid item.",
): ValidationResult<string> {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    return { ok: false, error: message };
  }
  return { ok: true, value: input.toLowerCase() };
}

export function isUuid(input: unknown): input is string {
  return validateUuid(input).ok;
}

export function validateEnum<const Value extends string>(
  input: unknown,
  allowed: readonly Value[],
  message: string,
): ValidationResult<Value> {
  return typeof input === "string" && allowed.includes(input as Value)
    ? { ok: true, value: input as Value }
    : { ok: false, error: message };
}

export function validateDateInput(
  input: unknown,
  message = "Choose a valid date.",
): ValidationResult<string> {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(input)) {
    return { ok: false, error: message };
  }
  const [year, month, day] = input.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: message };
  }
  return { ok: true, value: input };
}

export function hasDisallowedControlCharacters(input: string, multiline = false) {
  return containsDisallowedControlCharacters(input, multiline);
}

function containsDisallowedControlCharacters(value: string, multiline: boolean) {
  return (multiline ? MULTILINE_CONTROL_CHARACTERS : SINGLE_LINE_CONTROL_CHARACTERS).test(value);
}

function sentenceCase(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : "Value";
}
