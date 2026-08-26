import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Line endings normalised: git stores LF and checks out CRLF on Windows.
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");
const APP = ["src", "app"];

const { personAccountFrom } = await import("../src/lib/people.ts");

/**
 * Phase 4 -- four concepts, kept four.
 *
 *   PERSON       a durable family record
 *   MEMBER       an account that can sign in
 *   CONTRIBUTOR  eligible to share the cost of gifts
 *   ADMIN        structural administration
 *
 * The failure this suite exists to prevent is any pair of them collapsing into
 * one another -- most easily "has an account" quietly becoming "may plan".
 */

test("a membership is read as four states, and absence is one of them", () => {
  assert.deepEqual(personAccountFrom(null), { status: "none", isAdmin: false });

  // INVITED IS NOT ACTIVE. The admin has created the row and nobody has signed
  // in against it; showing that as active would tell a family somebody has
  // access they have not taken up.
  assert.deepEqual(personAccountFrom({ userId: null, active: true, role: "member" }),
    { status: "invited", isAdmin: false });
  assert.deepEqual(personAccountFrom({ userId: "u1", active: true, role: "member" }),
    { status: "active", isAdmin: false });
  assert.deepEqual(personAccountFrom({ userId: "u1", active: false, role: "member" }),
    { status: "disabled", isAdmin: false });
});

test("admin is a property of the membership, never inferred from anything else", () => {
  assert.equal(personAccountFrom({ userId: "u1", active: true, role: "admin" }).isAdmin, true);
  assert.equal(personAccountFrom({ userId: "u1", active: true, role: "member" }).isAdmin, false);

  // A disabled admin is still recorded as an admin -- the role and the access
  // are separate facts, and conflating them is how a demotion happens by
  // accident.
  assert.equal(personAccountFrom({ userId: "u1", active: false, role: "admin" }).isAdmin, true);
  assert.equal(personAccountFrom({ userId: "u1", active: false, role: "admin" }).status, "disabled");

  // No account is not an admin, and never a role by default.
  assert.equal(personAccountFrom(null).isAdmin, false);
});

test("nothing in the account model knows about contributors", () => {
  // Contributor eligibility lives on the PERSON, so somebody can be eligible
  // with no account at all. If it ever leaked into this type, "has an account"
  // and "may plan" would start travelling together.
  const model = read("src", "lib", "people.ts");
  const account = model.slice(model.indexOf("export type PersonAccount"), model.indexOf("export type PersonDirectoryEntry"));
  assert.ok(!account.includes("isFamilyContributor"), "the account type must not carry eligibility");
  assert.ok(!account.includes("contributor"), "not even by name");
});

test("creating a person creates a person and nothing else", () => {
  const form = read(...APP, "people", "new", "add-person-form.tsx");
  const rpcs = [...form.matchAll(/\.rpc\("([a-z_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(rpcs)], ["create_person"]);

  const migration = read("supabase", "migrations", "202608100032_people_directory.sql");
  const creation = migration.slice(migration.indexOf("function public.create_person("));
  assert.ok(!creation.includes("is_family_contributor"), "no eligibility");
  assert.ok(!creation.includes("app_members"), "no membership");
  assert.ok(!creation.includes("auth.users"), "no auth user");
  assert.ok(!creation.includes("'admin'"), "and certainly no role");
});

test("the Person profile shows the FOUR facts separately", () => {
  /*
   * PERSON, CONTRIBUTOR, ACCOUNT, ADMIN.
   *
   * The profile used to show three of them in one read-only list and call the
   * fourth "Global Admin" -- the pre-Areas name for a role that is now
   * per-family. Each is its own labelled thing now, and each says in its own
   * words what it does NOT do, because the reader's model of these four is
   * built on this screen or nowhere.
   */
  const panel = read(...APP, "people", "[id]", "person-admin-panel.tsx");

  assert.match(panel, /title="Account access"/u);
  assert.match(panel, /title="Contributor"/u);
  assert.match(panel, /label="Role in this family"/u);
  assert.match(panel, /label="Family"/u, "which family this person is in, named on the page");

  // Four words for four states, so none of them can be read as another.
  assert.match(panel, /none: "No account"/u);
  assert.match(panel, /invited: "Invited, not signed in yet"/u);
  assert.match(panel, /disabled: "Disabled"/u);

  // AND THE ROLE IS AREA-SCOPED, in words. "Global Admin" described a power
  // that reached every family; no such power exists.
  assert.match(panel, /Admin of this family/u);
  assert.ok(!panel.includes("Global Admin"), "administration is per family now");
});

test("the profile says removing access keeps the person", () => {
  const panel = read(...APP, "people", "[id]", "person-admin-panel.tsx");
  assert.match(panel, /Removing account access keeps this person/u);
  assert.match(panel, /account access/u);
  assert.match(panel, /Manage account access/u);

  // NEVER "delete person". The two are different actions on different things,
  // and the wording is the only thing standing between them on screen.
  assert.ok(!panel.includes("Delete person"), "access is not deletion");
  assert.ok(!panel.includes("Remove person"));
});

test("the profile edits the PERSON, and never the account", () => {
  /*
   * THE LINE THIS TEST DEFENDS. The profile may change facts about a PERSON --
   * their name, their birthday, whether they contribute, whether they are
   * archived. It may NOT create a login, disable one, or change its email:
   * that is Family Access's job, and two screens that both write accounts are
   * two places for the rules to differ.
   *
   * So the account section is read-only and LINKS; the person section writes.
   */
  const panel = read(...APP, "people", "[id]", "person-admin-panel.tsx");

  const summary = panel.slice(panel.indexOf("export function PersonAccountSummary"));
  assert.match(summary, /href="\/more\/family-access"/u, "it points at the one place accounts change");
  for (const name of ["fetch(", ".rpc(", "createClient("]) {
    assert.ok(!summary.includes(name), `the account summary must not ${name} account changes itself`);
  }

  // The person half DOES write, through routines that check the Area itself.
  for (const routine of ["set_person_name", "set_person_birthday", "set_family_contributor", "set_person_archived"]) {
    assert.ok(panel.includes(routine), `${routine} is how a person fact is changed`);
  }
  // And never through anything that touches a membership.
  for (const forbidden of ["app_members", "auth.admin", "inviteUserByEmail"]) {
    assert.ok(!panel.includes(forbidden), `the profile must not touch ${forbidden}`);
  }
});

test("the membership is read through row level security, never assumed", () => {
  const loader = read("src", "utils", "supabase", "people-server.ts");
  assert.match(loader, /\.from\("app_members"\)[\s\S]{0,140}\.eq\("person_id", personId\)/u);
  assert.match(loader, /personAccountFrom\(/u);
  // An error or an empty result is "nothing to show", not an assumption about
  // what the reader may not see.
  assert.match(loader, /membershipRow\.error \|\| !membershipRow\.data\s*\n?\s*\? null/u);
  assert.ok(!loader.includes("SUPABASE_SECRET_KEY"), "no service-role client");
});

test("event contributor pickers still read the pool, not the member list", () => {
  // A member who is not a contributor must not become selectable.
  for (const [file, expected] of [
    [[...APP, "events", "new", "create-event-form.tsx"], /people\.filter\(\(person\) => person\.isFamilyContributor\)/u],
    [[...APP, "events", "[eventId]", "settings", "settings-screen.tsx"], /person\.isFamilyContributor \|\| contributorPersonIds\.includes/u],
  ]) {
    const source = read(...file);
    assert.match(source, expected, file.join("/"));
    assert.ok(!source.includes("app_members"), `${file.join("/")} must not pick contributors from accounts`);
  }
});

test("email is not the durable identity of anybody", () => {
  // Email changes. Person id does not, and history joins on it.
  const loader = read("src", "utils", "supabase", "people-server.ts");
  assert.ok(!loader.includes("email"), "the profile loader never touches an email");

  // Comments stripped: the model explains what an invited account IS, and
  // saying the word is not the same as storing the value.
  const model = read("src", "lib", "people.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  assert.ok(!model.includes("email"), "and the model carries no email field");
});
