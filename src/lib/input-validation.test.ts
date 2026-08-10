import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import * as validation from "./input-validation.ts";

const {
  INPUT_LIMITS,
  parseMoneyToPennies,
  safeHttpUrl,
  validateDateInput,
  validateEmail,
  validateEnum,
  validateHttpUrl,
  validateOptionalText,
  validateRequiredText,
  validateUuid,
} = validation;

const xssPayloads = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '\"><svg onload=alert(1)>',
  '<iframe src="https://example.com"></iframe>',
];

test("stored plain text remains data when React renders it for another user", () => {
  for (const payload of xssPayloads) {
    const validation = validateRequiredText(payload, {
      field: "a gift name",
      maxLength: INPUT_LIMITS.title,
    });
    assert.equal(validation.ok, true);
    if (!validation.ok) continue;

    const html = renderToStaticMarkup(createElement("p", null, validation.value));
    assert.doesNotMatch(html, /<(?:script|img|svg|iframe)\b/iu);
    assert.match(html, /&lt;/u);
  }

  const attributeHtml = renderToStaticMarkup(
    createElement("span", { title: '\"><svg onload=alert(1)>' }, "Gift"),
  );
  assert.doesNotMatch(attributeHtml, /<svg\b/iu);
  assert.match(attributeHtml, /title="&quot;&gt;&lt;svg/u);
});

test("normal punctuation, currency, Unicode and intentional line breaks are preserved", () => {
  const values = ["Mum & Dad", "Taylor's Gift", "£12.50", "Café 🎁"];
  for (const value of values) {
    const result = validateRequiredText(value, { field: "a name", maxLength: 100 });
    assert.deepEqual(result, { ok: true, value });
  }
  assert.deepEqual(
    validateRequiredText(" Christmas present ", { field: "a gift name", maxLength: 200 }),
    { ok: true, value: "Christmas present" },
  );
  assert.deepEqual(
    validateOptionalText("Size 6\nMum's favourite", { field: "notes", maxLength: 4_000, multiline: true }),
    { ok: true, value: "Size 6\nMum's favourite" },
  );

  const html = renderToStaticMarkup(createElement("span", null, "Mum & Dad"));
  assert.equal(html, "<span>Mum &amp; Dad</span>");
  assert.doesNotMatch(html, /&amp;amp;/u);
});

test("control characters are rejected without stripping legitimate text", () => {
  assert.equal(validateRequiredText("Mum\u0000Dad", { field: "a name", maxLength: 100 }).ok, false);
  assert.equal(validateOptionalText("Line one\nLine two", { field: "notes", maxLength: 4_000, multiline: true }).ok, true);
});

test("only parsed HTTP and HTTPS product links can reach href", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "https://user:secret@example.com/item",
    "not a URL",
  ]) {
    assert.equal(validateHttpUrl(value).ok, false, value);
    assert.equal(safeHttpUrl(value), null, value);
  }

  assert.deepEqual(validateHttpUrl("https://example.com/gift?q=Mum%20%26%20Dad"), {
    ok: true,
    value: "https://example.com/gift?q=Mum%20%26%20Dad",
  });
  assert.equal(safeHttpUrl("http://example.com/item"), "http://example.com/item");
});

test("emails are bounded and normalized without an over-strict RFC parser", () => {
  assert.deepEqual(validateEmail("  Taylor.O'Gift+family@Example.co.uk  "), {
    ok: true,
    value: "taylor.o'gift+family@example.co.uk",
  });
  assert.equal(validateEmail("missing-at.example.com").ok, false);
  assert.equal(validateEmail(`${"a".repeat(245)}@example.com`).ok, false);
});

test("money is parsed exactly into bounded integer pennies", () => {
  assert.deepEqual(parseMoneyToPennies("£12.50"), { ok: true, value: 1_250 });
  assert.deepEqual(parseMoneyToPennies("1,234.5"), { ok: true, value: 123_450 });
  for (const value of ["NaN", "Infinity", "1e3", "12.345", "1,2,3", "<script>", "-1"]) {
    assert.equal(parseMoneyToPennies(value).ok, false, value);
  }
  assert.equal(parseMoneyToPennies("1".repeat(INPUT_LIMITS.money + 1)).ok, false);
  assert.equal(parseMoneyToPennies("21474836.48").ok, false);
});

test("UUID, enum and date validators reject malformed sensitive values", () => {
  assert.equal(validateUuid("24d043d8-6482-4c0a-82e7-34c6ba9c4dde").ok, true);
  assert.equal(validateUuid("not-a-uuid").ok, false);
  assert.equal(validateEnum("wrapped", ["purchased", "arrived", "wrapped"] as const, "Invalid status.").ok, true);
  assert.equal(validateEnum("deleted", ["purchased", "arrived", "wrapped"] as const, "Invalid status.").ok, false);
  assert.equal(validateDateInput("2026-12-25").ok, true);
  assert.equal(validateDateInput("2026-02-30").ok, false);
});
