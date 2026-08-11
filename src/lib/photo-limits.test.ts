import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { MAX_PHOTOS, photoIntake } from "./photo-limits.ts";

test("the first photo on an empty item is accepted", () => {
  // The regression that prompted this: picking one photo with none held showed
  // the limit warning and added nothing.
  const intake = photoIntake(0, 1);
  assert.equal(intake.accepted, 1);
  assert.equal(intake.rejected, 0);
  assert.equal(intake.atLimit, false);
});

test("a whole batch fits while there is room", () => {
  const intake = photoIntake(2, 5);
  assert.equal(intake.room, MAX_PHOTOS - 2);
  assert.equal(intake.accepted, 5);
  assert.equal(intake.rejected, 0);
});

test("a batch that overflows is accepted up to the limit", () => {
  const intake = photoIntake(10, 5);
  assert.equal(intake.accepted, 2);
  assert.equal(intake.rejected, 3);
  assert.equal(intake.atLimit, false);
});

test("nothing is accepted once the item is full", () => {
  const intake = photoIntake(MAX_PHOTOS, 1);
  assert.equal(intake.room, 0);
  assert.equal(intake.accepted, 0);
  assert.equal(intake.rejected, 1);
  assert.equal(intake.atLimit, true);
});

test("a count somehow past the limit does not produce negative room", () => {
  const intake = photoIntake(MAX_PHOTOS + 3, 2);
  assert.equal(intake.room, 0);
  assert.equal(intake.accepted, 0);
  assert.equal(intake.atLimit, true);
});
