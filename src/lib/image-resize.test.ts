import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { fittedSize, scaleToFit } from "./image-resize.ts";

test("photos larger than the box are scaled down by their longest edge", () => {
  // A typical portrait phone photo.
  assert.deepEqual(fittedSize(3024, 4032, 1600), { width: 1200, height: 1600 });
  // The same photo landscape.
  assert.deepEqual(fittedSize(4032, 3024, 1600), { width: 1600, height: 1200 });
  // Square.
  assert.deepEqual(fittedSize(2000, 2000, 1600), { width: 1600, height: 1600 });
});

test("photos already inside the box are never enlarged", () => {
  assert.equal(scaleToFit(800, 600, 1600), 1);
  assert.deepEqual(fittedSize(800, 600, 1600), { width: 800, height: 600 });
  // Exactly on the boundary.
  assert.deepEqual(fittedSize(1600, 900, 1600), { width: 1600, height: 900 });
});

test("aspect ratio survives the resize", () => {
  const source = { width: 4032, height: 3024 };
  const fitted = fittedSize(source.width, source.height, 1600);
  const before = source.width / source.height;
  const after = fitted.width / fitted.height;
  assert.ok(Math.abs(before - after) < 0.01, `ratio drifted: ${before} -> ${after}`);
});

test("extreme shapes never round away to a zero dimension", () => {
  // A panorama: the short edge would round to 0 without a floor.
  const fitted = fittedSize(20000, 100, 1600);
  assert.ok(fitted.height >= 1, "height collapsed to zero");
  assert.equal(fitted.width, 1600);
});

test("a degenerate size does not divide by zero", () => {
  assert.equal(scaleToFit(0, 0, 1600), 1);
});
