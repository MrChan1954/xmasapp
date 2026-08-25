/**
 * TWO FAMILIES, ONE LOGIN IN BOTH, AND A BIRTHDAY WITH SECRETS IN IT.
 *
 * The shape every Area rule needs to be tested against, built through the REAL
 * routines wherever one exists -- `create_area`, `create_person`,
 * `set_family_contributor`, `start_birthday_planning`, `save_gift_idea` -- each
 * driven through `request()`, which is one PostgREST request in one transaction
 * with the pre-request hook running inside it. The fixture therefore exercises
 * the same path the application does, hook included.
 *
 * WHERE THERE IS NO ROUTINE, the fixture writes as the owner and names the Area
 * explicitly. That is not a shortcut: it is exactly what the Family Access route
 * does with the service role, and building it that way means the tests cover
 * that shape too.
 *
 * WHO IS WHO
 *
 *   ALPHA             BRAVO             CHARLIE
 *   -----             -----             -------
 *   Ada    admin      Bea    admin      Cass   admin
 *   Jade   contributor Jo    member
 *   Taylor member     Jem    member
 *   Mo     member     Sam    contributor
 *
 *   `dual`   is Ada in Alpha, Cass in Charlie, and Jo in Bravo -- an
 *            administrator of two families and an ordinary member of a third.
 *            The account the old "exactly one membership" rule locked out.
 *   `jade`   is Jade in Alpha, where she is a CONTRIBUTOR, and Jem in Bravo,
 *            where she is not. The combination that used to hand an Alpha
 *            contributor the right to edit Bravo's birthdays.
 *   `taylor` is the celebrant. Alpha is planning their birthday, holds a secret
 *            idea from Jade, and has bought against it.
 *
 * There is also the LEGACY Area migration 034's backfill created for the seeded
 * family. Nobody here belongs to it, which makes it the third party every
 * "must not see" assertion is measured against.
 */
import { asOwner, attempt, literal, request, value } from "./rehearsal.mjs";

const USERS = ["dual", "bravoadmin", "jade", "taylor", "mo", "sam"];

export async function buildTwoFamilies(db) {
  await asOwner(db);

  const users = {};
  for (const name of USERS) {
    users[name] = await value(
      db,
      `insert into auth.users (email, email_confirmed_at)
       values (${literal(`${name}@example.test`)}, now()) returning id`,
    );
  }

  const legacy = await value(db, "select id from public.areas order by created_at limit 1");

  // -------------------------------------------------------------------------
  // Three Areas, each created by its own administrator through the one routine
  // that can create one.
  // -------------------------------------------------------------------------
  const alpha = await rpc(db, users.dual, null, "select public.create_area($1, $2)", ["Alpha", "Ada"]);
  const bravo = await rpc(db, users.bravoadmin, null, "select public.create_area($1, $2)", ["Bravo", "Bea"]);
  const charlie = await rpc(db, users.dual, null, "select public.create_area($1, $2)", ["Charlie", "Cass"]);

  const people = {
    ada: await personNamed(db, alpha, "Ada"),
    bea: await personNamed(db, bravo, "Bea"),
    cass: await personNamed(db, charlie, "Cass"),
  };

  // -------------------------------------------------------------------------
  // Everybody else, added by that Area's administrator through `create_person`
  // -- which asks `is_app_admin()`, which after migration 038 answers about the
  // Area the pre-request hook claimed. The hook is load-bearing right here.
  // -------------------------------------------------------------------------
  people.jade = await addPerson(db, users.dual, alpha, "Jade");
  people.taylor = await addPerson(db, users.dual, alpha, "Taylor", { month: 3, day: 14, year: 1996 });
  people.mo = await addPerson(db, users.dual, alpha, "Mo");

  people.jo = await addPerson(db, users.bravoadmin, bravo, "Jo");
  people.jem = await addPerson(db, users.bravoadmin, bravo, "Jem");
  people.sam = await addPerson(db, users.bravoadmin, bravo, "Sam", { month: 6, day: 2, year: 1990 });

  await rpc(db, users.dual, alpha, "select public.set_family_contributor($1, true)", [people.jade]);
  await rpc(db, users.dual, alpha,
    "select id from public.set_person_birthday($1, 9::smallint, 9::smallint, 1985::smallint)", [people.ada]);
  await rpc(db, users.bravoadmin, bravo, "select public.set_family_contributor($1, true)", [people.sam]);

  // -------------------------------------------------------------------------
  // Memberships. No routine creates one: that is the Family Access route, which
  // runs as the service role and names the Area explicitly. Same shape here.
  // -------------------------------------------------------------------------
  await asOwner(db);
  const members = {
    adaAlpha: await memberId(db, alpha, people.ada),
    beaBravo: await memberId(db, bravo, people.bea),
    cassCharlie: await memberId(db, charlie, people.cass),
    jadeAlpha: await link(db, alpha, people.jade, users.jade),
    taylorAlpha: await link(db, alpha, people.taylor, users.taylor),
    moAlpha: await link(db, alpha, people.mo, users.mo),
    joBravo: await link(db, bravo, people.jo, users.dual),
    jemBravo: await link(db, bravo, people.jem, users.jade),
    samBravo: await link(db, bravo, people.sam, users.sam),
  };

  // -------------------------------------------------------------------------
  // Alpha is planning Taylor's birthday, and has already bought something.
  // -------------------------------------------------------------------------
  const birthday = await rpc(
    db, users.dual, alpha,
    "select id from public.start_birthday_planning($1, $2, $3, $4, $5::jsonb)",
    [people.taylor, "Taylor's birthday 2027", "2027-03-14", 9000,
      JSON.stringify([{ person_id: people.jade, pennies: 9000 }])],
  );
  const recipient = await value(
    db,
    "select id from public.christmas_recipients where christmas_event_id = $1 and person_id = $2",
    [birthday, people.taylor],
  );

  // A SECRET IDEA, written by a family member, for the celebrant's birthday.
  const secretIdea = await rpc(
    db, users.jade, alpha,
    "select id from public.save_gift_idea(null, $1, $2, $3, null, null, $4)",
    [recipient, "Surprise weekend away", 12900, "do not tell Taylor"],
  );

  const jadeContributor = await value(
    db,
    "select id from public.contributors where christmas_event_id = $1 and person_id = $2",
    [birthday, people.jade],
  );

  await asOwner(db);
  const purchase = await value(
    db,
    `insert into public.purchases
       (christmas_recipient_id, description, actual_price_pennies,
        checkout_payer_contributor_id, created_by_app_member_id,
        originating_gift_idea_id, status)
     values ($1, 'Weekend away', 12900, $2, $3, $4, 'wrapped') returning id`,
    [recipient, jadeContributor, members.jadeAlpha, secretIdea],
  );

  // -------------------------------------------------------------------------
  // ALPHA IS ALSO PLANNING ITS ADMINISTRATOR'S OWN BIRTHDAY.
  //
  // Ada administers Alpha, so this is the case where the celebrant holds every
  // permission the application has. The surprise rule has to outrank all of
  // them, and this is how that gets tested without needing to hand the role
  // over -- which, as `the administrator can never be changed` proves, cannot
  // be done at all.
  // -------------------------------------------------------------------------
  /*
   * BUILT WITH OWNER RIGHTS, BECAUSE NOTHING ELSE CAN BUILD IT.
   *
   * `start_birthday_planning` requires the caller to be this Area's
   * administrator AND refuses anybody setting up their own birthday (migration
   * 031: you cannot be financially entangled with your own). Alpha has exactly
   * one administrator, and she is the celebrant -- so no caller exists who can
   * do this through the routine.
   *
   * That is a real consequence of "one administrator per Area", recorded by the
   * test `an Area's administrator can never be changed, and their own birthday
   * cannot be planned`. Here the rows are written directly, which is the shape a
   * service-role tool would use, so the PRIVACY rule underneath still gets
   * tested against the case that matters most: the celebrant holding every
   * permission there is.
   */
  await asOwner(db);
  const adminBirthday = await value(db, `
    insert into public.events (area_id, name, event_type, event_date, celebrant_person_id, year, status)
    values ($1, 'Ada''s birthday 2027', 'birthday', '2027-09-09', $2, null, 'active') returning id`,
  [alpha, people.ada]);
  const adminRecipient = await value(db, `
    -- Budget zero, and no contributors: migration 012 requires a recipient's
    -- allocations to equal its budget exactly, and the amount is beside the
    -- point here. What is being tested is whether the celebrant can see the
    -- planning at all.
    insert into public.christmas_recipients (christmas_event_id, person_id, budget_pennies, active)
    values ($1, $2, 0, true) returning id`, [adminBirthday, people.ada]);
  const adminSecretIdea = await rpc(
    db, users.jade, alpha,
    "select id from public.save_gift_idea(null, $1, $2, $3, null, null, null)",
    [adminRecipient, "Something for Ada", 4000],
  );

  // Bravo plans Sam's birthday, so there is one in each family.
  const bravoBirthday = await rpc(
    db, users.bravoadmin, bravo,
    "select id from public.start_birthday_planning($1, $2, $3, $4, $5::jsonb)",
    [people.sam, "Sam's birthday 2027", "2027-06-02", 5000,
      JSON.stringify([{ person_id: people.bea, pennies: 5000 }])],
  );
  const bravoRecipient = await value(
    db,
    "select id from public.christmas_recipients where christmas_event_id = $1 and person_id = $2",
    [bravoBirthday, people.sam],
  );

  await asOwner(db);
  return {
    users, people, members,
    areas: { alpha, bravo, charlie, legacy },
    birthday, recipient, secretIdea, purchase, jadeContributor,
    adminBirthday, adminRecipient, adminSecretIdea,
    bravoBirthday, bravoRecipient,
  };
}

/** One request, one statement, the first column back. Throws on refusal. */
async function rpc(db, user, area, sql, params) {
  const result = await request(db, { user, area }, async (tx) => attempt(tx, sql, params));
  if (!result.ok) throw new Error(`${sql.slice(0, 60)}: ${result.error}`);
  return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
}

async function personNamed(db, areaId, name) {
  return value(db, "select id from public.people where area_id = $1 and name = $2", [areaId, name]);
}

async function addPerson(db, adminUser, areaId, name, birthday = null) {
  return rpc(
    db, adminUser, areaId,
    "select id from public.create_person($1, $2::smallint, $3::smallint, $4::smallint)",
    [name, birthday?.month ?? null, birthday?.day ?? null, birthday?.year ?? null],
  );
}

async function memberId(db, areaId, personId) {
  return value(db, "select id from public.app_members where area_id = $1 and person_id = $2", [areaId, personId]);
}

/** A membership with its Area named explicitly -- the service-role shape. */
async function link(db, areaId, personId, userId) {
  return value(
    db,
    `insert into public.app_members (area_id, person_id, user_id, email, role, active)
     values ($1, $2, $3, $4, 'member', true) returning id`,
    [areaId, personId, userId, `${personId.slice(0, 8)}@example.test`],
  );
}
