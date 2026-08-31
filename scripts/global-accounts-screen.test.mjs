/**
 * THE GLOBAL APPROVAL QUEUE, RENDERED.
 *
 * `/admin/accounts` is the one screen in Q19 that a signed-out browser cannot
 * reach -- the server page answers a redirect, and rightly. So it is rendered
 * here instead, against a fixture standing in for `list_accounts()`, which is
 * what makes "the queue works" a measured claim rather than a hopeful one until
 * public sign-up is enabled and a real administrator can open it.
 *
 * WHAT IS WORTH PROVING BY RENDERING, RATHER THAN BY READING THE SOURCE:
 *
 *   * the queue draws the accounts it is given, and the filters partition them;
 *   * an unconfirmed account IS NOT OFFERED APPROVAL, because
 *     `set_account_status` refuses that combination and a button that is going
 *     to be refused is worse than no button;
 *   * NOBODY IS OFFERED A DECISION ABOUT THEMSELVES, for the same reason;
 *   * a decision goes through a confirmation before it goes anywhere, and the
 *     note it carries is bounded at the 500 the routine enforces;
 *   * and the RPC it finally calls is the right one, with the right arguments.
 *
 * NOTHING HERE IS THE BOUNDARY. `list_accounts`, `set_account_status`,
 * `grant_global_admin` and `revoke_global_admin` each ask `is_global_admin()`
 * for themselves and raise 42501 -- proved against a real PostgreSQL in
 * `scripts/global-approval.test.mjs`. This is about the screen.
 */
import assert from "node:assert/strict";
import test, { describe, beforeEach } from "node:test";

import { React, act, byRole, click, render } from "./dom/harness.mjs";
import { fake } from "./dom/stubs/supabase-client.mjs";

const h = React.createElement;

const { GlobalAccountsScreen } = await import("../src/app/admin/accounts/global-accounts-screen.tsx");

const ME = "user-1";

/** Four accounts, one of each status, plus the reader's own. */
const QUEUE = [
  {
    user_id: "u-pending", email: "newcomer@example.test", email_confirmed: true,
    status: "pending", is_global_admin: false, signed_up_at: "2026-08-20T09:00:00Z",
    decided_at: null, decided_by: null, decision_note: null,
  },
  {
    user_id: "u-unconfirmed", email: "unconfirmed@example.test", email_confirmed: false,
    status: "pending", is_global_admin: false, signed_up_at: "2026-08-21T09:00:00Z",
    decided_at: null, decided_by: null, decision_note: null,
  },
  {
    user_id: "u-approved", email: "member@example.test", email_confirmed: true,
    status: "approved", is_global_admin: false, signed_up_at: "2026-08-10T09:00:00Z",
    decided_at: "2026-08-11T09:00:00Z", decided_by: ME, decision_note: null,
  },
  {
    user_id: "u-suspended", email: "paused@example.test", email_confirmed: true,
    status: "suspended", is_global_admin: false, signed_up_at: "2026-08-12T09:00:00Z",
    decided_at: "2026-08-13T09:00:00Z", decided_by: ME, decision_note: "On hold while we ask.",
  },
  {
    user_id: ME, email: "admin@example.test", email_confirmed: true,
    status: "approved", is_global_admin: true, signed_up_at: "2026-08-01T09:00:00Z",
    decided_at: "2026-08-01T09:00:00Z", decided_by: null, decision_note: null,
  },
];

/** Every RPC the screen made, in order. */
const calls = () => fake.rpcCalls.filter((call) => call.name !== "my_account_status");

async function mount() {
  const view = await render(h(GlobalAccountsScreen));
  // The screen loads from a `setTimeout(0)` and then awaits the RPC.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return view;
}

const cardFor = (container, email) =>
  [...container.querySelectorAll("article")].find((article) => article.textContent.includes(email));

/**
 * A filter chip, found by its label.
 *
 * Not by accessible name: `FilterChip` renders its count inside the button, so
 * the computed name is "Approved2" rather than "Approved 2" -- correct markup,
 * and a brittle thing for a test to spell out.
 */
const filterChip = (container, label) =>
  [...container.querySelectorAll('button[aria-pressed]')]
    .find((button) => button.textContent.trim().startsWith(label));

beforeEach(() => {
  fake.reset({});
  fake.rpc.list_accounts = async () => ({ data: QUEUE, error: null });
  fake.rpc.set_account_status = async () => ({ data: null, error: null });
  fake.rpc.grant_global_admin = async () => ({ data: null, error: null });
  fake.rpc.revoke_global_admin = async () => ({ data: null, error: null });
});

describe("the queue", () => {
  test("opens on the accounts that need a decision", async () => {
    const view = await mount();
    const text = view.container.textContent;

    // `pending` is the default filter, because it is the only one with work in it.
    assert.match(text, /newcomer@example\.test/u);
    assert.match(text, /unconfirmed@example\.test/u);
    assert.ok(!text.includes("member@example.test"), "an approved account is not waiting for anything");
    await view.unmount();
  });

  test("ONE FETCH, and the counts come out of it", async () => {
    /*
     * `list_accounts` takes an optional status, and calling it five times to
     * fill in five counts would be five queries where one already carries every
     * row the counts are made of.
     */
    const view = await mount();
    assert.deepEqual(calls().map((call) => call.name), ["list_accounts"]);
    assert.deepEqual(calls()[0].args, { p_status: null });

    const text = view.container.textContent;
    assert.match(text, /Pending2/u, "two accounts are undecided");
    assert.match(text, /Approved2/u, "the reader and one member");
    assert.match(text, /Suspended1/u);
    assert.match(text, /All5/u);
    await view.unmount();
  });

  test("and every status can be looked at", async () => {
    const view = await mount();
    await click(filterChip(view.container, "Approved"));
    const text = view.container.textContent;
    assert.match(text, /member@example\.test/u);
    assert.ok(!text.includes("newcomer@example.test"));
    await view.unmount();
  });

  test("IT CARRIES NO FAMILY DATA, because the routine sends none", async () => {
    const view = await mount();
    const text = view.container.textContent;
    for (const leak of ["budget", "birthday", "recipient", "purchase", "£"]) {
      assert.ok(!text.toLowerCase().includes(leak.toLowerCase()),
        `the queue rendered the word "${leak}"`);
    }
    await view.unmount();
  });
});

describe("what may be decided, and by whom", () => {
  test("AN UNCONFIRMED ACCOUNT IS NOT OFFERED APPROVAL", async () => {
    // `set_account_status` raises 42501 for one. Withholding the button is the
    // courtesy; the refusal is the rule.
    const view = await mount();
    const card = cardFor(view.container, "unconfirmed@example.test");
    assert.match(card.textContent, /Email not confirmed/u);
    assert.ok(![...card.querySelectorAll("button")].some((button) => /Approve/u.test(button.textContent)),
      "approval must not be offered for an address nobody has proved they own");
    // It may still be rejected or suspended: neither needs a confirmed address.
    assert.ok([...card.querySelectorAll("button")].some((button) => /Reject/u.test(button.textContent)));
    await view.unmount();
  });

  test("and a confirmed one is", async () => {
    const view = await mount();
    const card = cardFor(view.container, "newcomer@example.test");
    assert.match(card.textContent, /Email confirmed/u);
    assert.ok([...card.querySelectorAll("button")].some((button) => button.textContent.trim() === "Approve"));
    await view.unmount();
  });

  test("NOBODY IS OFFERED A DECISION ABOUT THEMSELVES", async () => {
    /*
     * `set_account_status` refuses a caller who names themselves -- not because
     * self-approval is worse than approving a confederate, but because the
     * reviewer and the reviewed being the same person is the one case an audit
     * trail cannot make sense of.
     */
    const view = await mount();
    await click(filterChip(view.container, "All"));
    const own = cardFor(view.container, "admin@example.test");
    assert.match(own.textContent, /Nobody decides their own account\./u);
    for (const word of ["Approve", "Reject", "Suspend"]) {
      assert.ok(![...own.querySelectorAll("button")].some((button) => new RegExp(word, "u").test(button.textContent)),
        `${word} must not be offered on the reader's own account`);
    }
    await view.unmount();
  });

  test("but standing yourself down is, because the database allows exactly that", async () => {
    // `revoke_global_admin` refuses only the LAST administrator, so this is a
    // legitimate thing to do right up until you are the only one left.
    const view = await mount();
    await click(filterChip(view.container, "All"));
    const own = cardFor(view.container, "admin@example.test");
    assert.ok([...own.querySelectorAll("button")]
      .some((button) => /Stand down as administrator/u.test(button.textContent)));
    await view.unmount();
  });

  test("appointing one is offered only for an approved account", async () => {
    const view = await mount();
    await click(filterChip(view.container, "All"));
    const approved = cardFor(view.container, "member@example.test");
    assert.ok([...approved.querySelectorAll("button")]
      .some((button) => /Make administrator/u.test(button.textContent)),
    "an approved account may be appointed");

    const pending = cardFor(view.container, "newcomer@example.test");
    assert.ok(![...pending.querySelectorAll("button")]
      .some((button) => /Make administrator/u.test(button.textContent)),
    "`grant_global_admin` requires an approved account, so it must not be offered for an undecided one");
    await view.unmount();
  });
});

describe("making a decision", () => {
  test("A CONFIRMATION COMES FIRST, and nothing is written until it is taken", async () => {
    const view = await mount();
    const card = cardFor(view.container, "newcomer@example.test");
    await click([...card.querySelectorAll("button")].find((button) => button.textContent.trim() === "Approve"));

    // An alertdialog, which -- unlike a plain dialog -- a stray backdrop click
    // cannot dismiss. That is the whole reason `ConfirmDialog` is one.
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog, "a consequential action must confirm");
    assert.match(dialog.textContent, /Approve newcomer@example\.test\?/u);
    assert.deepEqual(calls().map((call) => call.name), ["list_accounts"],
      "opening the confirmation must write nothing");

    await click(byRole(dialog, "button", "Approve account"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const decision = calls().find((call) => call.name === "set_account_status");
    assert.ok(decision, "taking the confirmation calls the routine");
    assert.deepEqual(decision.args, { p_user_id: "u-pending", p_status: "approved", p_note: null });
    await view.unmount();
  });

  test("cancelling writes nothing at all", async () => {
    const view = await mount();
    const card = cardFor(view.container, "newcomer@example.test");
    await click([...card.querySelectorAll("button")].find((button) => button.textContent.trim() === "Approve"));
    await click(byRole(document.querySelector('[role="alertdialog"]'), "button", "Cancel"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    assert.deepEqual(calls().map((call) => call.name), ["list_accounts"]);
    await view.unmount();
  });

  test("THE NOTE IS BOUNDED AT THE 500 THE ROUTINE ENFORCES", async () => {
    // The routine raises 22001 past 500 characters. Stopping the field there is
    // the courtesy; the refusal is the rule.
    const view = await mount();
    const card = cardFor(view.container, "newcomer@example.test");
    await click([...card.querySelectorAll("button")].find((button) => /Reject/u.test(button.textContent)));

    const dialog = document.querySelector('[role="alertdialog"]');
    const note = dialog.querySelector("textarea");
    assert.ok(note, "a decision may carry a note for the record");
    assert.equal(note.maxLength, 500);
    assert.match(dialog.textContent, /0 of 500 characters\./u);
    await view.unmount();
  });

  test("and a refusal from the database is shown rather than swallowed", async () => {
    fake.rpc.set_account_status = async () => ({
      data: null,
      error: { code: "42501", message: "Only a Gift Planner administrator can decide an account" },
    });

    const view = await mount();
    const card = cardFor(view.container, "newcomer@example.test");
    await click([...card.querySelectorAll("button")].find((button) => button.textContent.trim() === "Approve"));
    await click(byRole(document.querySelector('[role="alertdialog"]'), "button", "Approve account"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    assert.match(view.container.textContent, /could not be saved|not permitted|administrator/iu,
      "the reader has to be told the decision did not take");
    await view.unmount();
  });
});
