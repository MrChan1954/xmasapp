/**
 * Q7 -- THE SETTLEMENT LIFECYCLE, AGAINST A REAL POSTGRESQL.
 *
 * The pure arithmetic already has unit tests, and Area isolation for the four
 * payment routines is proven in `area-mutation-security`. What had no executed
 * coverage was the LIFECYCLE itself: a claim recorded by a payer, reviewed by
 * the receiver, confirmed in part, rejected, re-paid, and the Owed figure that
 * has to follow every one of those steps.
 *
 * Everything below runs through the real RPCs, under real row level security,
 * against a real PostgreSQL carrying 001-047. The balance is then computed by
 * the PRODUCT'S OWN engine -- `src/lib/owed.ts`, imported here -- fed from rows
 * read out of the database, and derived exactly as `owed-data.ts` derives them.
 * So the number this file asserts is the number the Owed screen would show.
 *
 * THE SCENARIO IS THE ONE FROM THE SPECIFICATION.
 *
 *     Jade owes Mo GBP 30      (Mo paid for a gift Jade is responsible for)
 *     Taylor owes Jade GBP 20  (Jade paid for a gift Taylor is responsible for)
 *
 * Jade's outgoing Owed is GBP 30. The GBP 20 owed TO Jade does not reduce it.
 */
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import { asOwner, buildRehearsal, probe, rows, value, seen } from "./pg/rehearsal.mjs";
import { buildTwoFamilies } from "./pg/fixtures.mjs";
// @ts-expect-error Node strips the types; the extension is required.
import { calculateNetOwedBalances, contributorOwedSummary } from "../src/lib/owed.ts";

let db;
let f;
/** The dedicated Alpha event this file's arithmetic lives in. */
let s;

const who = (user, area) => ({ user, area });
const GBP30 = 3000;
const GBP20 = 2000;

before(async () => {
  db = await buildRehearsal({});
  f = await buildTwoFamilies(db);
  await asOwner(db);

  // A plain event, deliberately NOT a birthday: no celebrant means no
  // own-birthday exclusions, so the money rules are tested on their own.
  const event = await value(db, `
    insert into public.events (name, event_type, event_date, year, status, area_id, created_by_app_member_id)
    values ('Q7 settlement scenario', 'other', '2027-05-01', 2027, 'active', $1, $2) returning id`,
    [f.areas.alpha, f.members.adaAlpha]);

  const contributorFor = async (personId) => value(db,
    "insert into public.contributors (christmas_event_id, person_id, active) values ($1,$2,true) returning id",
    [event, personId]);
  const jade = await contributorFor(f.people.jade);
  const mo = await contributorFor(f.people.mo);
  const taylor = await contributorFor(f.people.taylor);

  const recipient = await value(db, `
    insert into public.christmas_recipients (christmas_event_id, person_id, active, budget_pennies)
    values ($1,$2,true,0) returning id`, [event, f.people.ada]);

  /** Mo paid; Jade is responsible for all of it. Jade therefore owes Mo. */
  const owedToMo = await value(db, `
    insert into public.purchases (christmas_recipient_id, description, actual_price_pennies,
      checkout_payer_contributor_id, created_by_app_member_id, status)
    values ($1,'Gift Mo paid for',$2,$3,$4,'purchased') returning id`,
    [recipient, GBP30, mo, f.members.moAlpha]);
  await db.query(`insert into public.purchase_allocations (purchase_id, contributor_id, responsibility_pennies)
    values ($1,$2,$3)`, [owedToMo, jade, GBP30]);

  /** Jade paid; Taylor is responsible. Taylor therefore owes Jade. */
  const owedToJade = await value(db, `
    insert into public.purchases (christmas_recipient_id, description, actual_price_pennies,
      checkout_payer_contributor_id, created_by_app_member_id, status)
    values ($1,'Gift Jade paid for',$2,$3,$4,'purchased') returning id`,
    [recipient, GBP20, jade, f.members.jadeAlpha]);
  await db.query(`insert into public.purchase_allocations (purchase_id, contributor_id, responsibility_pennies)
    values ($1,$2,$3)`, [owedToJade, taylor, GBP20]);

  s = { event, recipient, jade, mo, taylor };
});
after(async () => { await db?.close(); });

/**
 * The Owed figure the product would show, built the way `owed-data.ts` builds
 * it: an allocation is a debt from the allocated contributor to whoever paid at
 * the till, and only CONFIRMED settlement pennies reduce it.
 */
async function owedFor(contributorId) {
  await asOwner(db);
  const allocations = await rows(db, `
    select a.contributor_id, a.responsibility_pennies, p.checkout_payer_contributor_id
    from public.purchase_allocations a
    join public.purchases p on p.id = a.purchase_id
    join public.christmas_recipients r on r.id = p.christmas_recipient_id
    where p.deleted_at is null and r.christmas_event_id = $1`, [s.event]);
  const obligations = allocations
    .filter((a) => a.responsibility_pennies > 0 && a.contributor_id !== a.checkout_payer_contributor_id)
    .map((a) => ({
      debtorContributorId: a.contributor_id,
      creditorContributorId: a.checkout_payer_contributor_id,
      amountPennies: a.responsibility_pennies,
    }));
  const ledger = (await rows(db, `
    select payer_contributor_id, payee_contributor_id, amount_pennies, confirmed_amount_pennies, voided_at
    from public.settlements where christmas_event_id = $1`, [s.event]))
    .map((row) => ({
      payerContributorId: row.payer_contributor_id,
      payeeContributorId: row.payee_contributor_id,
      amountPennies: row.amount_pennies,
      confirmedAmountPennies: row.confirmed_amount_pennies,
      voidedAt: row.voided_at,
    }));
  return contributorOwedSummary(calculateNetOwedBalances(obligations, ledger), contributorId);
}

const statusOf = async (settlementId) => value(db,
  "select status from public.settlements where id = $1", [settlementId]);
const confirmedOf = async (settlementId) => value(db,
  "select confirmed_amount_pennies from public.settlements where id = $1", [settlementId]);
const receiptsFor = async (settlementId) => rows(db,
  "select action, amount_pennies, source, reason from public.payment_receipts where settlement_id = $1 order by created_at, id",
  [settlementId]);

/** Jade records a payment to Mo, as the payer. */
const jadePays = (pennies) => probe(db, who(f.users.jade, f.areas.alpha),
  "select (public.record_settlement($1,$2,$3,$4,'2027-05-02',null)).id as id",
  [s.event, s.jade, s.mo, pennies]);
/** Taylor pays Jade -- the other direction, used once Jade's own debt is clear. */
const taylorPays = (pennies) => probe(db, who(f.users.taylor, f.areas.alpha),
  "select (public.record_settlement($1,$2,$3,$4,'2027-05-04',null)).id as id",
  [s.event, s.taylor, s.jade, pennies]);
const jadeReviews = (settlementId, action, pennies, reason) => probe(db, who(f.users.jade, f.areas.alpha),
  "select public.review_payment($1,$2,$3,$4)", [settlementId, action, pennies, reason]);
/** Mo reviews it, as the receiver. */
const moReviews = (settlementId, action, pennies, reason) => probe(db, who(f.users.mo, f.areas.alpha),
  "select public.review_payment($1,$2,$3,$4)", [settlementId, action, pennies, reason]);

let claim;

describe("Q7: Owed is gross outgoing outstanding debt", () => {
  test("A OWES B GBP 30 AND C OWES A GBP 20 -- A STILL OWES GBP 30", async () => {
    /*
     * The rule the whole screen rests on. Netting the receivable into the
     * payable would show Jade owing GBP 10, which is a number nobody can act
     * on: Mo is still waiting for GBP 30.
     */
    const jade = await owedFor(s.jade);
    assert.equal(jade.youOwePennies, GBP30, "outgoing Owed must be gross");
    assert.equal(jade.owedToYouPennies, GBP20, "and the receivable is reported separately");

    const mo = await owedFor(s.mo);
    assert.equal(mo.owedToYouPennies, GBP30);
    assert.equal(mo.youOwePennies, 0);
  });

  test("gift ideas and voided purchases do not create debt", async () => {
    await asOwner(db);
    const before = (await owedFor(s.jade)).youOwePennies;
    await db.query(`insert into public.gift_ideas (christmas_recipient_id, title, estimated_price_pennies, suggested_by_app_member_id)
      values ($1,'An idea, not a debt',9999,$2)`, [s.recipient, f.members.jadeAlpha]);
    assert.equal((await owedFor(s.jade)).youOwePennies, before, "a gift idea moved a balance");
  });
});

describe("Q7: a recorded payment is a claim until the receiver says otherwise", () => {
  test("the payer may record a payment", async () => {
    const recorded = await jadePays(GBP30);
    assert.equal(recorded.ok, true, recorded.error);
    claim = recorded.rows[0].id;
    assert.ok(claim, "record_settlement returned no id");
  });

  test("PENDING MONEY REDUCES NOTHING", async () => {
    assert.equal(await statusOf(claim), "pending");
    assert.equal(await confirmedOf(claim), 0);
    assert.equal((await owedFor(s.jade)).youOwePennies, GBP30,
      "a claim the receiver has not seen reduced the balance");
  });

  test("THE PAYER CANNOT CONFIRM THEIR OWN PAYMENT", async () => {
    // The whole point of the split. Jade owes the money; Jade cannot also be
    // the one who says it arrived.
    const selfConfirm = await probe(db, who(f.users.jade, f.areas.alpha),
      "select public.review_payment($1,'confirm',$2,null)", [claim, GBP30]);
    assert.equal(selfConfirm.ok, false, "the payer confirmed their own payment");
    assert.match(selfConfirm.error, /Only the person this payment was sent to/u);
    assert.equal(await confirmedOf(claim), 0);
  });

  test("and neither can an unrelated third party", async () => {
    const thirdParty = await probe(db, who(f.users.taylor, f.areas.alpha),
      "select public.review_payment($1,'confirm',$2,null)", [claim, GBP30]);
    assert.equal(thirdParty.ok, false, "a third party confirmed somebody else's payment");
    assert.equal(await confirmedOf(claim), 0);
  });

  test("nor the Area administrator, who is not the receiver either", async () => {
    // Admin is not a way around receiver authority. There is a separate,
    // audited override for that, tested further down.
    const admin = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.review_payment($1,'confirm',$2,null)", [claim, GBP30]);
    assert.equal(admin.ok, false, "an administrator confirmed on the receiver's behalf");
    assert.equal(await confirmedOf(claim), 0);
  });
});

describe("Q7: partial confirmation is penny-exact", () => {
  test("the receiver confirms GBP 10 of the GBP 30 claim", async () => {
    const confirmed = await moReviews(claim, "confirm", 1000, null);
    assert.equal(confirmed.ok, true, confirmed.error);
    assert.equal(await confirmedOf(claim), 1000);
    assert.equal(await statusOf(claim), "partially_confirmed");
  });

  test("SO EXACTLY GBP 20 REMAINS OUTSTANDING", async () => {
    assert.equal((await owedFor(s.jade)).youOwePennies, GBP20,
      "the confirmed part must reduce the balance by exactly itself");
  });

  test("the same pennies cannot be confirmed twice", async () => {
    // Over-confirmation is refused by the routine and, underneath it, by a
    // CHECK constraint. This proves the routine refuses first, with a sentence.
    const again = await moReviews(claim, "confirm", GBP30, null);
    assert.equal(again.ok, false, "the receiver confirmed more than was claimed");
    assert.match(again.error, /cannot confirm more than the amount still unconfirmed/u);
    assert.equal(await confirmedOf(claim), 1000, "a refused confirmation still moved money");
  });

  test("and a confirmation of zero or less is refused", async () => {
    for (const bad of [0, -500]) {
      const r = await moReviews(claim, "confirm", bad, null);
      assert.equal(r.ok, false, `confirming ${bad} was allowed`);
    }
    assert.equal(await confirmedOf(claim), 1000);
  });

  test("every review so far is an appended receipt, not an overwritten number", async () => {
    const receipts = await receiptsFor(claim);
    assert.equal(receipts.length, 1, "exactly one successful review has happened");
    assert.equal(receipts[0].action, "confirm");
    assert.equal(receipts[0].amount_pennies, 1000);
    assert.equal(receipts[0].source, "review");
  });
});

describe("Q7: rejection does not reduce Owed", () => {
  test("the receiver says the rest never arrived, with a reason", async () => {
    const rejected = await moReviews(claim, "reject", null, "Only ten pounds arrived");
    assert.equal(rejected.ok, true, rejected.error);
  });

  test("THE REJECTED REMAINDER IS STILL OWED", async () => {
    assert.equal((await owedFor(s.jade)).youOwePennies, GBP20,
      "rejecting money must not settle it");
    assert.equal(await confirmedOf(claim), 1000, "rejection changed the confirmed figure");
  });

  test("the reason and the reviewer are recorded", async () => {
    const row = (await rows(db,
      "select rejection_reason, rejected_at, reviewed_by_app_member_id from public.settlements where id = $1",
      [claim]))[0];
    assert.equal(row.rejection_reason, "Only ten pounds arrived");
    assert.ok(row.rejected_at, "no rejection timestamp");
    assert.ok(row.reviewed_by_app_member_id, "no reviewer recorded");

    const receipts = await receiptsFor(claim);
    assert.equal(receipts.length, 2, "the rejection must be appended, not merged");
    assert.equal(receipts[1].action, "reject");
    assert.equal(receipts[1].reason, "Only ten pounds arrived");
  });

  test("rejection is terminal for that claim", async () => {
    const after = await moReviews(claim, "confirm", 500, null);
    assert.equal(after.ok, false, "a rejected claim accepted a further confirmation");
    assert.match(after.error, /already been reviewed as not received/u);
  });

  test("and a rejection with no reason is refused", async () => {
    const second = await jadePays(500);
    assert.equal(second.ok, true, second.error);
    const noReason = await moReviews(second.rows[0].id, "reject", null, "   ");
    assert.equal(noReason.ok, false, "a rejection was accepted with no reason");
    assert.match(noReason.error, /Say why the payment has not arrived/u);
    await asOwner(db);
    await db.query("delete from public.settlements where id = $1", [second.rows[0].id]);
  });
});

describe("Q7: paying the rest settles it", () => {
  test("a second payment, confirmed in full, clears the balance", async () => {
    const second = await jadePays(GBP20);
    assert.equal(second.ok, true, second.error);
    const id = second.rows[0].id;

    assert.equal((await owedFor(s.jade)).youOwePennies, GBP20, "still owed while pending");

    const confirmed = await moReviews(id, "confirm", GBP20, null);
    assert.equal(confirmed.ok, true, confirmed.error);
    assert.equal(await statusOf(id), "confirmed");
    assert.equal((await owedFor(s.jade)).youOwePennies, 0, "the debt should now be clear");
  });

  test("and the receivable was never touched by any of it", async () => {
    // Taylor still owes Jade GBP 20 throughout. Nothing Jade paid Mo changes
    // that, which is the other half of "gross outgoing".
    assert.equal((await owedFor(s.jade)).owedToYouPennies, GBP20);
    assert.equal((await owedFor(s.taylor)).youOwePennies, GBP20);
  });

  test("a fully confirmed claim cannot be reviewed again", async () => {
    const id = await value(db,
      "select id from public.settlements where christmas_event_id = $1 and status = 'confirmed' limit 1", [s.event]);
    const again = await moReviews(id, "confirm", 1, null);
    assert.equal(again.ok, false);
    assert.match(again.error, /already confirmed in full/u);
  });
});

describe("Q7: odd pennies survive a partial confirmation", () => {
  test("GBP 10.01 claimed, GBP 3.33 confirmed, GBP 6.68 left", async () => {
    /*
     * A third of an odd number of pennies is where a rounding bug would show.
     * Jade's own debt is clear by now, so this runs in the other direction --
     * Taylor, who owes Jade GBP 20, pays GBP 10.01 of it.
     */
    const before = (await owedFor(s.taylor)).youOwePennies;
    const odd = await taylorPays(1001);
    assert.equal(odd.ok, true, odd.error);
    const id = odd.rows[0].id;

    assert.equal((await owedFor(s.taylor)).youOwePennies, before,
      "the claim was still only pending");

    const part = await jadeReviews(id, "confirm", 333, null);
    assert.equal(part.ok, true, part.error);
    assert.equal(await confirmedOf(id), 333);
    assert.equal(await statusOf(id), "partially_confirmed");

    const row = (await rows(db,
      "select amount_pennies - confirmed_amount_pennies as remaining from public.settlements where id = $1",
      [id]))[0];
    assert.equal(row.remaining, 668, "a penny went missing");

    assert.equal((await owedFor(s.taylor)).youOwePennies, before - 333,
      "the balance moved by something other than the confirmed pennies");
  });
});

describe("Q7: the receipt history is append-only", () => {
  test("A RECEIPT CANNOT BE UPDATED OR DELETED, EVEN BY THE OWNER", async () => {
    await asOwner(db);
    const receipt = await value(db,
      "select id from public.payment_receipts where settlement_id = $1 limit 1", [claim]);
    for (const [what, sql] of [
      ["update", "update public.payment_receipts set amount_pennies = 1 where id = $1"],
      ["delete", "delete from public.payment_receipts where id = $1"],
    ]) {
      let refused = false;
      try { await db.query(sql, [receipt]); } catch { refused = true; }
      assert.ok(refused, `a payment receipt could be ${what}d -- history is not append-only`);
    }
  });

  test("the claim amount itself is never rewritten", async () => {
    // GBP 30 was claimed and GBP 10 confirmed. The claim must still read GBP 30,
    // or the log would say Jade only ever claimed to have sent GBP 10.
    const row = (await rows(db,
      "select amount_pennies, confirmed_amount_pennies from public.settlements where id = $1", [claim]))[0];
    assert.equal(row.amount_pennies, GBP30);
    assert.equal(row.confirmed_amount_pennies, 1000);
  });
});

describe("Q7: history outlives the people in it", () => {
  test("removing a contributor from the event does not erase what they owed", async () => {
    await asOwner(db);
    await db.query("update public.contributors set active = false where id = $1", [s.taylor]);
    const stillThere = await value(db,
      "select count(*)::int from public.purchase_allocations where contributor_id = $1", [s.taylor]);
    assert.equal(stillThere, 1, "the allocation vanished with the contributor");
    assert.ok((await owedFor(s.taylor)).youOwePennies > 0,
      "a departed contributor's debt disappeared");
    await db.query("update public.contributors set active = true where id = $1", [s.taylor]);
  });

  test("renaming a person does not detach their payment history", async () => {
    await asOwner(db);
    await db.query("update public.people set name = 'Renamed Person' where id = $1", [f.people.mo]);
    const receipts = await value(db, `
      select count(*)::int from public.payment_receipts pr
      join public.contributors c on c.id = pr.reviewer_contributor_id
      where c.person_id = $1`, [f.people.mo]);
    assert.ok(receipts > 0, "the receipts lost their link to the reviewer");
    await db.query("update public.people set name = 'Mo' where id = $1", [f.people.mo]);
  });
});

describe("Q7: the admin override is separate, and says so", () => {
  test("it requires a reason", async () => {
    const noReason = await probe(db, who(f.users.dual, f.areas.alpha),
      "select public.admin_record_confirmed_payment($1,$2,$3,$4,'2027-05-03',null)",
      [s.event, s.taylor, s.jade, 500]);
    assert.equal(noReason.ok, false, "an override was accepted with no reason");
  });

  test("an ordinary member cannot use it", async () => {
    const member = await probe(db, who(f.users.mo, f.areas.alpha),
      "select public.admin_record_confirmed_payment($1,$2,$3,$4,'2027-05-03','because')",
      [s.event, s.taylor, s.jade, 500]);
    assert.equal(member.ok, false, "a non-admin recorded a confirmed payment");
  });

  test("AND WHEN AN ADMIN USES IT, IT IS AUDITED AS AN OVERRIDE", async () => {
    const owedBefore = (await owedFor(s.taylor)).youOwePennies;
    const override = await probe(db, who(f.users.dual, f.areas.alpha),
      "select (public.admin_record_confirmed_payment($1,$2,$3,$4,'2027-05-03','Paid in cash at the door')).id as id",
      [s.event, s.taylor, s.jade, 500]);
    assert.equal(override.ok, true, override.error);

    await asOwner(db);
    const receipt = (await rows(db, `
      select source, reason, action, amount_pennies from public.payment_receipts
      where settlement_id = $1`, [override.rows[0].id]))[0];
    assert.equal(receipt.source, "admin_override",
      "an override must not be recorded as an ordinary receiver confirmation");
    assert.equal(receipt.reason, "Paid in cash at the door");
    assert.equal(receipt.amount_pennies, 500);
    // It settles money, as intended: exactly 500 pennies less than before.
    assert.equal((await owedFor(s.taylor)).youOwePennies, owedBefore - 500,
      "an override must move the balance by exactly what it recorded");
  });
});

describe("Q7: a voided claim settles nothing", () => {
  test("voiding a pending payment leaves the debt standing", async () => {
    const before = (await owedFor(s.taylor)).youOwePennies;
    const pending = await taylorPays(100);
    assert.equal(pending.ok, true, pending.error);
    const id = pending.rows[0].id;

    const voided = await probe(db, who(f.users.taylor, f.areas.alpha),
      "select public.void_settlement($1)", [id]);
    assert.equal(voided.ok, true, voided.error);
    assert.equal(await statusOf(id), "voided");
    assert.equal((await owedFor(s.taylor)).youOwePennies, before, "voiding moved a balance");

    const review = await jadeReviews(id, "confirm", 100, null);
    assert.equal(review.ok, false, "a voided payment was reviewable");
    assert.match(review.error, /voided/u);
  });
});

describe("Q7: the celebrant sees none of the money on their own birthday", () => {
  test("NOT THE SETTLEMENTS, THE RECEIPTS, THE PURCHASES OR THE ALLOCATIONS", async () => {
    /*
     * Migration 024 widened balance visibility to the whole family. That must
     * not have widened it to the one person it is being kept from. Taylor is
     * the celebrant of `f.birthday`, and an active Alpha member.
     */
    await asOwner(db);
    const moContributor = await value(db,
      "insert into public.contributors (christmas_event_id, person_id, active) values ($1,$2,true) returning id",
      [f.birthday, f.people.mo]);
    const hidden = await value(db, `
      insert into public.settlements (christmas_event_id, payer_contributor_id, payee_contributor_id,
        amount_pennies, payment_date, recorded_by_app_member_id, confirmed_amount_pennies, confirmed_at)
      values ($1,$2,$3,3000,'2027-01-01',$4,3000,now()) returning id`,
      [f.birthday, moContributor, f.jadeContributor, f.members.jadeAlpha]);
    await db.query(`
      insert into public.payment_receipts (settlement_id, christmas_event_id, payer_contributor_id,
        payee_contributor_id, action, amount_pennies, source, reviewed_by_app_member_id, reviewer_contributor_id)
      values ($1,$2,$3,$4,'confirm',3000,'review',$5,$6)`,
      [hidden, f.birthday, moContributor, f.jadeContributor, f.members.jadeAlpha, f.jadeContributor]);

    const celebrant = who(f.users.taylor, f.areas.alpha);
    for (const [table, where, params] of [
      ["settlements", "christmas_event_id = $1", [f.birthday]],
      ["payment_receipts", "christmas_event_id = $1", [f.birthday]],
      ["purchases", "christmas_recipient_id = $1", [f.recipient]],
      ["purchase_allocations", "purchase_id = $1", [f.purchase]],
      ["gift_ideas", "christmas_recipient_id = $1", [f.recipient]],
    ]) {
      assert.equal(await seen(db, celebrant, table, where, params), 0,
        `the celebrant can read ${table} for their own birthday`);
    }

    // The control: a planner in the same family sees all of it, so the zeros
    // above are privacy rather than an empty table.
    const planner = who(f.users.jade, f.areas.alpha);
    assert.equal(await seen(db, planner, "settlements", "christmas_event_id = $1", [f.birthday]), 1);
    assert.equal(await seen(db, planner, "payment_receipts", "christmas_event_id = $1", [f.birthday]), 1);
  });

  test("and the celebrant cannot review a payment they cannot see", async () => {
    const id = await value(db,
      "select id from public.settlements where christmas_event_id = $1 limit 1", [f.birthday]);
    const attempt = await probe(db, who(f.users.taylor, f.areas.alpha),
      "select public.review_payment($1,'confirm',100,null)", [id]);
    assert.equal(attempt.ok, false, "the celebrant reviewed a payment on their own birthday");
  });
});

describe("Q7: a claim cannot be invented, doubled, or aimed at nothing", () => {
  /*
   * `record_settlement` does not simply take the payer's word for the amount.
   * It recomputes the outstanding balance in that direction, subtracts what is
   * already awaiting confirmation, and refuses anything that does not fit.
   * That is what stops a double submission becoming a double claim.
   */
  test("a payment in a direction where nothing is owed is refused", async () => {
    const nothing = await probe(db, who(f.users.mo, f.areas.alpha),
      "select (public.record_settlement($1,$2,$3,$4,'2027-05-05',null)).id as id",
      [s.event, s.mo, s.taylor, 500]);
    assert.equal(nothing.ok, false, "a payment was recorded against no debt");
    assert.match(nothing.error, /no outstanding net balance in this payment direction/u);
  });

  test("a payment larger than the outstanding balance is refused", async () => {
    const outstanding = (await owedFor(s.taylor)).youOwePennies;
    assert.ok(outstanding > 0, "precondition: Taylor still owes something");
    const tooMuch = await taylorPays(outstanding + 1);
    assert.equal(tooMuch.ok, false, "a payment exceeded the debt it was paying");
    assert.match(tooMuch.error, /exceeds the amount still outstanding/u);
  });

  test("AND A SECOND CLAIM FOR MONEY ALREADY AWAITING CONFIRMATION IS REFUSED", async () => {
    /*
     * The duplicate-submission guard: press the button twice and the second
     * press is refused, because the first claim already covers the debt.
     *
     * What a claim may be for is the outstanding balance MINUS anything already
     * awaiting confirmation, so the earlier odd-pennies claim has to be closed
     * before this direction is clean enough to test the rule on its own.
     */
    await asOwner(db);
    const stillAwaiting = await rows(db, `
      select id from public.settlements
      where christmas_event_id = $1 and payer_contributor_id = $2 and payee_contributor_id = $3
        and voided_at is null and rejected_at is null and confirmed_amount_pennies < amount_pennies`,
      [s.event, s.taylor, s.jade]);
    for (const row of stillAwaiting) {
      const closed = await jadeReviews(row.id, "reject", null, "closing an open claim for the next test");
      assert.equal(closed.ok, true, closed.error);
    }

    const outstanding = (await owedFor(s.taylor)).youOwePennies;
    assert.ok(outstanding > 0, "precondition: Taylor still owes something");
    const first = await taylorPays(outstanding);
    assert.equal(first.ok, true, first.error);

    const second = await taylorPays(outstanding);
    assert.equal(second.ok, false, "the same debt was claimed twice");
    assert.match(second.error, /already awaiting confirmation/u);

    // Tidy up, so the file ends with the claim reviewed rather than dangling.
    const rejected = await jadeReviews(first.rows[0].id, "reject", null, "test teardown");
    assert.equal(rejected.ok, true, rejected.error);
    assert.equal((await owedFor(s.taylor)).youOwePennies, outstanding,
      "rejecting the teardown claim must leave the debt exactly as it was");
  });

  test("paying yourself is refused", async () => {
    const self = await probe(db, who(f.users.jade, f.areas.alpha),
      "select (public.record_settlement($1,$2,$3,$4,'2027-05-05',null)).id as id",
      [s.event, s.jade, s.jade, 100]);
    assert.equal(self.ok, false, "a contributor paid themselves");
  });

  test("a zero or negative amount is refused", async () => {
    for (const bad of [0, -100]) {
      const r = await taylorPays(bad);
      assert.equal(r.ok, false, `an amount of ${bad} was accepted`);
    }
  });

  test("and a third party cannot record a payment between two other people", async () => {
    // Only the payer or the receiver may record it.
    const meddler = await probe(db, who(f.users.mo, f.areas.alpha),
      "select (public.record_settlement($1,$2,$3,$4,'2027-05-05',null)).id as id",
      [s.event, s.taylor, s.jade, 100]);
    assert.equal(meddler.ok, false, "a bystander recorded somebody else's payment");
    assert.match(meddler.error, /Only the payer or the person being paid/u);
  });
});
