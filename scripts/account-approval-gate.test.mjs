/**
 * THE GLOBAL GATE, RENDERED RATHER THAN READ.
 *
 * `scripts/account-approval-runtime.test.mjs` calls the pure decision and reads
 * the wiring. This file renders the REAL `FamilyProvider` against a fixture and
 * asks what actually happens to each kind of account -- which is the only way
 * to prove that the decision is on the path rather than merely present in the
 * file, and the only way to prove the thing that matters most about Q19:
 *
 *   AN APPROVED ACCOUNT WITH NO FAMILY IS NOT SIGNED OUT.
 *
 * That was the defect. Signing in read `app_members`, found nothing, and called
 * `signOut()`; so did the auth callback and account setup. Under public sign-up
 * a brand new account has no membership BY DEFINITION, so everybody who ever
 * signed up would have confirmed their address and been thrown out for it. A
 * source-string test could not tell the difference between a sign-out that has
 * been removed and one that has moved; this can.
 *
 * THE FIXTURE IS NOT THE BOUNDARY. Row level security refuses the rows, and
 * migration 052 put `is_globally_approved()` inside every membership predicate
 * the policies are built from -- proved against a real PostgreSQL in
 * `scripts/global-approval.test.mjs`. What is proved here is that the app sends
 * each account to the screen that explains itself, and does not sign anybody
 * out on the way.
 */
import assert from "node:assert/strict";
import test, { describe, beforeEach } from "node:test";

import { React, act, render } from "./dom/harness.mjs";
import { fake } from "./dom/stubs/supabase-client.mjs";
import { membership } from "./dom/stubs/current-member-client.mjs";
import { navigation } from "./dom/stubs/next-navigation.mjs";

const h = React.createElement;

const { FamilyProvider } = await import("../src/app/family-context.tsx");

const AREA = "11111111-1111-4111-8111-111111111111";

/** What `my_account_status()` answers, for the account under test. */
function status(over) {
  fake.rpc.my_account_status = async () => ({
    data: [{ status: "pending", is_global_admin: false, email_confirmed: true, ...over }],
    error: null,
  });
}

/** Nobody signed in at all: the routine returns no row. */
function signedOut() {
  fake.user = null;
  fake.rpc.my_account_status = async () => ({ data: [], error: null });
}

/**
 * Mount the provider and let it settle.
 *
 * The view is RETURNED so every test can unmount it. A root left mounted keeps
 * jsdom's timers and React's act environment alive, and the run never exits --
 * which reads as a hang rather than as a failure, so it is worth being strict
 * about.
 */
async function mountProvider() {
  const view = await render(h(FamilyProvider, null, h("p", null, "the app")));
  // The provider defers its first load by a timeout, then awaits several reads.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return view;
}

/** Which family tables the provider actually asked for. */
const familyTablesRead = () => [...new Set(fake.queries.map((query) => query.table))];

beforeEach(() => {
  fake.reset({
    events: [],
    christmas_recipients: [],
    people: [],
    gift_ideas: [],
    purchases: [],
    areas: [{ id: AREA, name: "QA Alpha", archived_at: null }],
  });
  membership.reset(null);
  navigation.reset("/");
});

describe("an account the database has not let in", () => {
  test("PENDING GOES TO THE PENDING SCREEN, and reads no family table on the way", async () => {
    /*
     * A missing `app_accounts` row and an explicit `pending` one are the same
     * answer -- undecided is undecided -- and `my_account_status()` already
     * coalesces them, which is why the fixture only has to send one.
     */
    membership.selectArea(AREA);
    status({ status: "pending" });
    const view = await mountProvider();

    assert.ok(navigation.replaced.includes("/account-pending"),
      "an undecided account must be told what it is waiting for");
    assert.deepEqual(familyTablesRead(), [],
      "and the gate must run BEFORE the first family read, not after it");
    await view.unmount();
  });

  test("REJECTED AND SUSPENDED SHARE ONE SCREEN, so neither can tell which it is", async () => {
    for (const decision of ["rejected", "suspended"]) {
      fake.reset({ areas: [] });
      membership.reset(null);
      navigation.reset("/");
      membership.selectArea(AREA);
      status({ status: decision });
      const view = await mountProvider();

      assert.ok(navigation.replaced.includes("/account-rejected"),
        `a ${decision} account must be refused`);
      assert.ok(!navigation.replaced.includes("/account-pending"),
        "and must not be told it is merely waiting");
      assert.deepEqual(familyTablesRead(), [], "with no family read at all");
      await view.unmount();
    }
  });

  test("A REFUSED ACCOUNT WITH A PERFECTLY GOOD MEMBERSHIP IS STILL REFUSED", async () => {
    /*
     * THE HALF THE OLD CHECK GOT BACKWARDS. Sign-in asked `app_members` and
     * nothing else, so a rejected account holding an active membership sailed
     * straight in -- the membership row was all anybody looked at. Membership
     * is a FAMILY's decision; approval is GIFT PLANNER's, and it is upstream.
     */
    membership.selectArea(AREA);
    status({ status: "rejected" });
    navigation.reset("/events/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const view = await mountProvider();

    assert.ok(navigation.replaced.includes("/account-rejected"));
    assert.deepEqual(familyTablesRead(), [], "an active membership buys nothing here");
    await view.unmount();
  });

  test("an unconfirmed address is sent to confirm it, not told it is waiting", async () => {
    membership.selectArea(AREA);
    status({ status: "pending", email_confirmed: false });
    const view = await mountProvider();

    assert.ok(navigation.replaced.includes("/check-email"));
    assert.ok(!navigation.replaced.includes("/account-pending"),
      "there is a step outstanding that this person can actually take");
    await view.unmount();
  });

  test("and nobody signed in still goes to the sign-in form", async () => {
    signedOut();
    const view = await mountProvider();
    assert.ok(navigation.replaced.includes("/login"));
    await view.unmount();
  });
});

describe("an approved account", () => {
  test("IS NEVER SIGNED OUT FOR HAVING NO FAMILY", async () => {
    /*
     * THE DEFECT THIS WHOLE PHASE EXISTS TO REMOVE, measured rather than
     * asserted about. Approved, no membership: the provider used to call
     * `signOut()` and send them to `/login?error=access_denied`. It now sends
     * them to the onboarding at `/`, still signed in.
     */
    membership.reset(null);
    status({ status: "approved" });
    navigation.reset("/people");
    const view = await mountProvider();

    assert.ok(!navigation.replaced.some((href) => href.startsWith("/login")),
      "an approved account must not be returned to the sign-in form");
    assert.ok(!navigation.replaced.includes("/account-pending"));
    assert.ok(!navigation.replaced.includes("/account-rejected"));
    assert.ok(navigation.replaced.includes("/"),
      "it is offered the onboarding instead, which is where a family is started");
    await view.unmount();
  });

  test("and is left alone once it is already at the front door", async () => {
    // `/` renders the onboarding itself, so redirecting to it from it would be
    // a loop.
    membership.reset(null);
    status({ status: "approved" });
    navigation.reset("/");
    const view = await mountProvider();

    assert.deepEqual(navigation.replaced, []);
    await view.unmount();
  });

  test("WITH A FAMILY, IT IS SIMPLY IN THE APP", async () => {
    membership.selectArea(AREA);
    status({ status: "approved" });
    navigation.reset("/");
    const view = await mountProvider();

    assert.deepEqual(navigation.replaced, [], "no redirect of any kind");
    await view.unmount();
  });

  test("and the gate is one RPC, never a read of the table itself", async () => {
    membership.selectArea(AREA);
    status({ status: "approved" });
    const view = await mountProvider();

    assert.ok(fake.rpcCalls.some((call) => call.name === "my_account_status"),
      "the status arrives through the routine");
    assert.ok(!fake.queries.some((query) => query.table === "app_accounts"),
      "app_accounts holds no privilege for a browser and must never be queried");
    await view.unmount();
  });
});
