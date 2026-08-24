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

test("the Person profile shows the three facts separately", () => {
  const screen = read(...APP, "people", "[id]", "person-profile-screen.tsx");

  assert.match(screen, /Account access/u);
  assert.match(screen, /Contributor</u);
  assert.match(screen, /ACCOUNT_LABEL\[account\.status\]/u);
  assert.match(screen, /person\.isFamilyContributor \? "Yes" : "No"/u);

  // Four words for four states, so none of them can be read as another.
  assert.match(screen, /none: "No account"/u);
  assert.match(screen, /invited: "Invited, not signed in yet"/u);
  assert.match(screen, /active: "Active"/u);
  assert.match(screen, /disabled: "Disabled"/u);
});

test("the profile says removing access keeps the person", () => {
  const screen = read(...APP, "people", "[id]", "person-profile-screen.tsx");
  assert.match(screen, /Removing account access keeps this person/u);
  assert.match(screen, /Give account access/u);
  assert.match(screen, /Manage account access/u);

  // NEVER "delete person". The two are different actions on different things,
  // and the wording is the only thing standing between them on screen.
  assert.ok(!screen.includes("Delete person"), "access is not deletion");
  assert.ok(!screen.includes("Remove person"));
});

test("the access section is admin-only, and does not become a second backend", () => {
  const screen = read(...APP, "people", "[id]", "person-profile-screen.tsx");
  const start = screen.indexOf("{isAdmin && (");
  assert.ok(start > 0, "the section is gated on the reader being an admin");

  // It LINKS to Family Access rather than reimplementing it. Two screens that
  // both create accounts are two places for the rules to differ.
  const section = screen.slice(start, screen.indexOf("</section>", start));
  assert.match(section, /href="\/more\/family-access"/u);
  for (const forbidden of ["fetch(", ".rpc(", "createClient"]) {
    assert.ok(!section.includes(forbidden), `the profile must not ${forbidden} account changes itself`);
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
