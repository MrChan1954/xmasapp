import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { resolveRequestOrigin } from "./request-origin.ts";

const headers = (overrides: Record<string, string | null> = {}) => ({
  configuredOrigin: null,
  forwardedHost: null,
  host: null,
  forwardedProto: null,
  ...overrides,
});

test("a development server on a LAN address keeps the http scheme the browser used", () => {
  assert.equal(
    resolveRequestOrigin({ ...headers({ host: "192.168.0.11:3000" }), isDevelopment: true }),
    "http://192.168.0.11:3000",
  );
  assert.equal(
    resolveRequestOrigin({ ...headers({ host: "my-laptop.local:3000" }), isDevelopment: true }),
    "http://my-laptop.local:3000",
  );
});

test("a built server keeps https as the scheme fallback for non-loopback hosts", () => {
  assert.equal(
    resolveRequestOrigin({ ...headers({ host: "192.168.0.11:3000" }), isDevelopment: false }),
    "https://192.168.0.11:3000",
  );
  assert.equal(
    resolveRequestOrigin({ ...headers({ host: "christmas.example.com" }), isDevelopment: false }),
    "https://christmas.example.com",
  );
});

test("the development relaxation is opt-in, so an unset NODE_ENV still means https", () => {
  // `isDevelopment` omitted entirely, as it would be if NODE_ENV were unset in a
  // server started outside `next dev`.
  assert.equal(
    resolveRequestOrigin(headers({ host: "192.168.0.11:3000" })),
    "https://192.168.0.11:3000",
  );
  for (const isDevelopment of [undefined, null, "", "yes", 1]) {
    assert.equal(
      resolveRequestOrigin({
        ...headers({ host: "christmas.example.com" }),
        isDevelopment: isDevelopment as never,
      }),
      "https://christmas.example.com",
      `${JSON.stringify(isDevelopment)} must not enable the development relaxation`,
    );
  }
});

test("loopback hosts stay on http in every environment", () => {
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "localhost", "127.0.0.1"]) {
    assert.equal(
      resolveRequestOrigin({ ...headers({ host }), isDevelopment: false }),
      `http://${host}`,
    );
    assert.equal(
      resolveRequestOrigin({ ...headers({ host }), isDevelopment: true }),
      `http://${host}`,
    );
  }
});

test("only exact loopback hosts skip https, so a lookalike domain does not", () => {
  for (const host of [
    "localhost.attacker.example",
    "127.0.0.1.attacker.example",
    "localhostx",
    "notlocalhost",
  ]) {
    assert.equal(
      resolveRequestOrigin({ ...headers({ host }), isDevelopment: false }),
      `https://${host}`,
      `${host} must not be treated as loopback`,
    );
  }
});

test("a proxy's forwarded protocol wins over the environment fallback", () => {
  assert.equal(
    resolveRequestOrigin({
      ...headers({ host: "192.168.0.11:3000", forwardedProto: "https" }),
      isDevelopment: true,
    }),
    "https://192.168.0.11:3000",
  );
  assert.equal(
    resolveRequestOrigin({
      ...headers({ host: "christmas.example.com", forwardedProto: "http" }),
      isDevelopment: false,
    }),
    "http://christmas.example.com",
  );
});

test("forwarded headers use only the first entry of a proxy chain", () => {
  assert.equal(
    resolveRequestOrigin({
      ...headers({
        host: "internal:8080",
        forwardedHost: "christmas.example.com, internal.proxy",
        forwardedProto: "https, http",
      }),
      isDevelopment: false,
    }),
    "https://christmas.example.com",
  );
});

test("an unrecognised forwarded protocol falls back instead of being echoed", () => {
  assert.equal(
    resolveRequestOrigin({
      ...headers({ host: "christmas.example.com", forwardedProto: "javascript" }),
      isDevelopment: false,
    }),
    "https://christmas.example.com",
  );
});

test("bracketed IPv6 literals are accepted as hosts", () => {
  assert.equal(
    resolveRequestOrigin({ ...headers({ host: "[fe80::1]:3000" }), isDevelopment: true }),
    "http://[fe80::1]:3000",
  );
});

test("a configured origin outranks every request header", () => {
  assert.equal(
    resolveRequestOrigin({
      ...headers({ configuredOrigin: "https://christmas.example.com", host: "attacker.test" }),
      isDevelopment: false,
    }),
    "https://christmas.example.com",
  );
  assert.equal(
    resolveRequestOrigin({
      ...headers({ configuredOrigin: "https://christmas.example.com/setup?x=1", host: "attacker.test" }),
      isDevelopment: false,
    }),
    "https://christmas.example.com",
  );
});

test("an unusable configured origin falls through to the request headers", () => {
  const cases = [
    "not a url",
    "ftp://christmas.example.com",
    "https://user:pass@christmas.example.com",
  ];
  for (const configuredOrigin of cases) {
    assert.equal(
      resolveRequestOrigin({
        ...headers({ configuredOrigin, host: "192.168.0.11:3000" }),
        isDevelopment: true,
      }),
      "http://192.168.0.11:3000",
      `${configuredOrigin} must not be trusted as an origin`,
    );
  }
});

test("a missing or malformed host is rejected rather than echoed into a URL", () => {
  const cases = [null, "", "   ", "host with spaces", "host/path", "host:notaport", "https://host"];
  for (const host of cases) {
    assert.throws(
      () => resolveRequestOrigin({ ...headers({ host }), isDevelopment: true }),
      /host is missing or malformed/,
      `${JSON.stringify(host)} must be rejected`,
    );
  }
});
