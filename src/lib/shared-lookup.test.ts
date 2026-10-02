import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Node's built-in type-stripping test runner requires the explicit extension.
import { createSharedLookup } from "./shared-lookup.ts";

function clock(start = 0) {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

function counter<T>(answer: (call: number) => T) {
  let calls = 0;
  return { run: async () => answer(++calls), get calls() { return calls; } };
}

test("concurrent callers asking the same question share one request", async () => {
  const share = createSharedLookup(5000, clock().now);
  const lookup = counter((call) => `user-${call}`);
  const answers = await Promise.all([1, 2, 3].map(() => share("user", "token-a", lookup.run)));
  assert.deepEqual(answers, ["user-1", "user-1", "user-1"]);
  assert.equal(lookup.calls, 1);
});

test("a different key -- another session or another family -- is asked afresh", async () => {
  const share = createSharedLookup(5000, clock().now);
  const lookup = counter((call) => `answer-${call}`);
  assert.equal(await share("member", "token-a|area-1", lookup.run), "answer-1");
  assert.equal(await share("member", "token-a|area-2", lookup.run), "answer-2");
  assert.equal(await share("member", "token-b|area-2", lookup.run), "answer-3");
  assert.equal(lookup.calls, 3);
});

test("the answer is only shared for the window, then asked again", async () => {
  const time = clock();
  const share = createSharedLookup(5000, time.now);
  const lookup = counter((call) => call);
  assert.equal(await share("status", "token-a", lookup.run), 1);
  time.advance(4999);
  assert.equal(await share("status", "token-a", lookup.run), 1);
  time.advance(1);
  assert.equal(await share("status", "token-a", lookup.run), 2);
});

test("different questions under one key never answer for each other", async () => {
  const share = createSharedLookup(5000, clock().now);
  assert.equal(await share("user", "token-a", async () => "the user"), "the user");
  assert.equal(await share("status", "token-a", async () => "the status"), "the status");
});

test("a failed request is forgotten, not repeated to the next caller", async () => {
  const share = createSharedLookup(5000, clock().now);
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls === 1) throw new Error("network"); return "recovered"; };
  await assert.rejects(share("user", "token-a", flaky), /network/);
  assert.equal(await share("user", "token-a", flaky), "recovered");
  assert.equal(calls, 2);
});
