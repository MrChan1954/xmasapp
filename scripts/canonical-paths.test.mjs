/**
 * One implementation per concept, and the differences that are on purpose.
 *
 * Q17 found three helpers written out four, two and two times in active
 * screens. Q18 gave each of them one home. These tests are what stops a fourth
 * copy appearing: they count DEFINITIONS, not filenames, so moving a helper is
 * free and duplicating it is not.
 *
 * They also pin the two places where a near-identical thing is deliberately NOT
 * shared -- the event dashboard's status wording, and the two different answers
 * to "what day is it". Both look like duplicates to a grep and neither is one,
 * so each is asserted to still differ.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { progressPresentation } = await import("../src/app/components/financial-progress.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(relative) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) found.push(full);
    }
  };
  walk(join(root, relative));
  return found;
}

const sources = sourceFiles("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));
const relative = (path) => path.replace(root, "").replace(/\\/gu, "/");

/**
 * Files declaring a top-level binding of this name.
 *
 * No `g` flag on purpose: a global regex carries `lastIndex` between `.test()`
 * calls, so reusing one across a list silently skips every other file.
 */
function definitionsOf(name) {
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\s*[:=])`, "u");
  return sources.filter((file) => pattern.test(file.text)).map((file) => relative(file.path));
}

// ---------------------------------------------------------------------------
// 1. One definition each
// ---------------------------------------------------------------------------

test("priceInput is defined once, in the money module", () => {
  assert.deepEqual(definitionsOf("priceInput"), ["src/lib/currency.ts"]);
});

test("todayInput is defined once, beside the validator that reads it back", () => {
  assert.deepEqual(definitionsOf("todayInput"), ["src/lib/input-validation.ts"]);
});

test("progressPresentation is defined once, beside the progress bar", () => {
  assert.deepEqual(definitionsOf("progressPresentation"), ["src/app/components/financial-progress.tsx"]);
});

test("londonToday is defined once, and the family timezone is spelled out once", () => {
  assert.deepEqual(definitionsOf("londonToday"), ["src/utils/supabase/birthdays-server.ts"]);
  const zoneUsers = sources
    .filter((file) => file.text.includes('timeZone: "Europe/London"'))
    .map((file) => relative(file.path));
  assert.deepEqual(zoneUsers, ["src/utils/supabase/birthdays-server.ts"]);
});

test("no screen re-derives a local calendar date for itself", () => {
  // The offset shift is the whole of `todayInput`. A second one anywhere in
  // `src` is a second answer to the same question.
  const offsetUsers = sources
    .filter((file) => file.text.includes("getTimezoneOffset"))
    .map((file) => relative(file.path));
  assert.deepEqual(offsetUsers, ["src/lib/input-validation.ts"]);
});

// ---------------------------------------------------------------------------
// 2. What the one implementation actually says
// ---------------------------------------------------------------------------

test("a person's budget position reads the same word and colour everywhere", () => {
  assert.deepEqual(progressPresentation("not_started"), { label: "Not started", tone: "neutral" });
  assert.deepEqual(progressPresentation("in_progress"), { label: "In progress", tone: "warning" });
  assert.deepEqual(progressPresentation("budget_reached"), { label: "Budget reached", tone: "success" });
  assert.deepEqual(progressPresentation("over_budget"), { label: "Over budget", tone: "danger" });
});

test("budgets are targets, so reaching one is a success and passing it is still a state", () => {
  assert.equal(progressPresentation("budget_reached").tone, "success");
  assert.equal(progressPresentation("over_budget").tone, "danger");
  assert.notEqual(progressPresentation("over_budget").label, progressPresentation("budget_reached").label);
});

test("the filter chips and the badges take their four words from the same place", () => {
  const screen = readFileSync(join(root, "src/app/people/people-screen.tsx"), "utf8");
  assert.ok(!screen.includes("statusFilterLabel"), "the chips used to carry their own copy of these words");
  assert.ok(screen.includes("progressPresentation(status).label"));
});

// ---------------------------------------------------------------------------
// 3. The differences that are deliberate
// ---------------------------------------------------------------------------

test("the event dashboard keeps its own status wording and its own tones", () => {
  // An event card summarises an occasion, not a person: "Complete" reads better
  // than "Budget reached" for a whole Christmas, and one recipient over budget
  // is a warning rather than a danger. Two of the four states differ, in the
  // word AND in the colour, so this is a second presentation of the same
  // status -- not a stale copy of the one above.
  const dashboard = readFileSync(join(root, "src/app/events-dashboard.tsx"), "utf8");
  assert.ok(dashboard.includes('if (status === "budget_reached") return "Complete";'));
  assert.ok(dashboard.includes('if (status === "in_progress") return "gold";'));
  assert.ok(dashboard.includes('if (status === "not_started") return "neutral";'));
  assert.ok(!dashboard.includes("progressPresentation"), "the dashboard must not quietly adopt the person wording");
  assert.ok(!dashboard.includes("Budget reached"));
});

test("device-local today and family-timezone today stay two different functions", () => {
  // A birthday is a fixed calendar date wherever it is read from; a purchase
  // date defaults to the day the person filling the form is having. Collapsing
  // these would move a birthday for anybody reading from another country.
  const validation = readFileSync(join(root, "src/lib/input-validation.ts"), "utf8");
  const birthdays = readFileSync(join(root, "src/utils/supabase/birthdays-server.ts"), "utf8");
  assert.ok(validation.includes("getTimezoneOffset"), "todayInput answers in the reader's zone");
  assert.ok(!validation.includes("Europe/London"), "todayInput must not be pinned to one country");
  assert.ok(birthdays.includes('timeZone: "Europe/London"'), "londonToday answers in the family's zone");
});

// ---------------------------------------------------------------------------
// 4. No person-specific operator tooling
// ---------------------------------------------------------------------------

const scriptNames = readdirSync(join(root, "scripts")).filter((name) => name.endsWith(".mjs"));

test("no script in the repository is named after one member of the family", () => {
  assert.deepEqual(scriptNames.filter((name) => /taylor/iu.test(name)), []);
});

test("linking a login to a membership is the database's job, not a script's", () => {
  // `claim_app_member()` is the canonical path and runs on every auth callback.
  // A service-role script doing the same UPDATE bypasses both row level
  // security and the write barrier, which is what the security invariants
  // forbid -- and it is why the removed operator scripts were not a capability
  // worth keeping.
  // THREE CALLERS SINCE Q19, AND STILL ONE IMPLEMENTATION. The sign-in form
  // joined the callback and account setup, because a family can grant access
  // at any time -- including long after somebody signed up and confirmed -- and
  // claiming only on an email link left that invitation unclaimed until the
  // person happened to be sent another one. The server pair go through
  // `claimInvitations`, which is a two-line wrapper over the same RPC in
  // `account-status-server.ts`; the browser calls it directly.
  const claim = /rpc\("claim_app_member"\)/u;
  const claimSites = [
    ["src/utils/supabase/account-status-server.ts", claim],
    ["src/app/auth/callback/route.ts", /claimInvitations\(\)/u],
    ["src/app/account-setup/page.tsx", claim],
    ["src/app/login/page.tsx", claim],
  ];
  for (const [path, pattern] of claimSites) {
    assert.match(readFileSync(join(root, path), "utf8"), pattern, `${path} must take the canonical claim path`);
  }
  for (const name of scriptNames) {
    const text = readFileSync(join(root, "scripts", name), "utf8");
    assert.ok(
      !/from\("app_members"\)[\s\S]{0,300}\.update\(/u.test(text),
      `${name} writes app_members with the service role; claim_app_member is the supported path`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. One package manager
// ---------------------------------------------------------------------------

test("pnpm-lock.yaml is the only lockfile", () => {
  // Cloudflare Workers Builds runs `pnpm run build`, so pnpm-lock.yaml is what
  // production resolves from. A second lockfile can describe a different tree
  // than the one that ships, which is exactly what happened to `lucide-react`.
  assert.ok(existsSync(join(root, "pnpm-lock.yaml")));
  assert.ok(!existsSync(join(root, "package-lock.json")));
  assert.ok(!existsSync(join(root, "yarn.lock")));
  assert.ok(!existsSync(join(root, "bun.lockb")));
});

// ---------------------------------------------------------------------------
// 6. The two Q18 deferred, settled in Q19
//
// Both were named in Q18's report as duplicates left standing ON PURPOSE, with
// reasons. Q19 is where the reasons ran out.
// ---------------------------------------------------------------------------

/** The code, with commentary stripped: prose about a rule is not a breach of it. */
const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

test("SIGNING OUT IS DEFINED ONCE, and every screen calls that one", () => {
  /*
   * Q18 FOUND TWO BYTE-IDENTICAL COPIES and deliberately left them: verifying a
   * change to the sign-out path means signing the real family out of the live
   * site, which the QA rules forbid, and shipping an unverifiable change to the
   * auth path is worse than the duplication.
   *
   * Q19 has FIVE callers -- the account screen, the account menu, the pending
   * screen, the refused screen and the global admin queue -- and the last three
   * have no account menu to reach. Q18 also named the exact hazard: "if
   * sign-out ever needs to clear the Area cookie, one copy gets it and the
   * other does not." It does need to, because Q19's chooser makes a stale
   * `gp_area` the difference between asking which family and walking into one.
   *
   * COUNTED, NOT NAMED. `auth.signOut()` may appear in exactly one file.
   */
  const callers = sources
    .filter((file) => withoutComments(file.text).includes("auth.signOut()"))
    .map((file) => relative(file.path));
  assert.deepEqual(callers, ["src/utils/supabase/sign-out.ts"]);

  const canonical = readFileSync(join(root, "src/utils/supabase/sign-out.ts"), "utf8");
  assert.match(canonical, /await createClient\(\)\.auth\.signOut\(\);/u, "1. end the session");
  assert.match(canonical, /forgetAreaCookie\(\);/u, "2. forget the family");
  assert.match(canonical, /redirectToLogin\(\);/u, "3. and hard-navigate away");
  assert.match(canonical, /window\.location\.assign/u,
    "a client navigation would leave every provider holding the old session's rows");

  // And the five screens that need it import it rather than rebuilding it.
  for (const screen of [
    "src/app/account/page.tsx",
    "src/app/components/account-menu.tsx",
    "src/app/account-pending/page.tsx",
    "src/app/account-rejected/page.tsx",
    "src/app/check-email/page.tsx",
    "src/app/admin/accounts/global-accounts-screen.tsx",
  ]) {
    assert.match(readFileSync(join(root, screen), "utf8"),
      /import \{ signOut \} from "@\/utils\/supabase\/sign-out";/u,
      `${screen} must use the canonical sign-out`);
  }
});

test("THE SERVICE-ROLE KEY IS READ IN ONE MODULE, and that module says what it costs", () => {
  /*
   * Q18 FOUND TWO HAND-ROLLED CONSTRUCTORS and could not merge them: each threw
   * its own domain error, on the most security-sensitive client in the
   * application, and merging needed either a shared error or an injected
   * constructor. A fourth copy had appeared by Q19.
   *
   * The split is what made them mergeable. `service-role.ts` owns the key and
   * throws ONE low-level `ServiceRoleUnavailableError`; each domain boundary
   * catches it and re-throws its own type, so every 503 a browser sees is
   * unchanged. There is deliberately NO injected constructor: a seam that lets
   * a caller supply its own client is a seam that lets a caller supply one
   * built somewhere else.
   */
  const readers = sources
    .filter((file) => file.text.includes("process.env.SUPABASE_SECRET_KEY"))
    .map((file) => relative(file.path));
  assert.deepEqual(readers, ["src/utils/supabase/service-role.ts"]);

  const builders = sources
    .filter((file) => /createClient as createAdminSupabaseClient/u.test(file.text))
    .map((file) => relative(file.path));
  assert.deepEqual(builders, [], "no second service-role constructor anywhere in src");

  const canonical = readFileSync(join(root, "src/utils/supabase/service-role.ts"), "utf8");
  assert.match(canonical, /import "server-only";/u, "it must be unreachable from a browser bundle");
  assert.match(canonical, /BYPASSES ROW LEVEL SECURITY \*AND\* THE WRITE BARRIER/u,
    "the header has to say what a client built here skips");
  for (const duty of ["AUTHENTICATE", "AUTHORIZE", "SCOPE"]) {
    assert.ok(canonical.includes(duty), `and name the caller's duty to ${duty}`);
  }
  assert.match(canonical, /persistSession: false/u, "this client is never a person");

  // The four boundaries that build one each translate the low-level error.
  for (const boundary of [
    "src/utils/supabase/family-access-admin.ts",
    "src/utils/supabase/notifications-server.ts",
    "src/utils/supabase/payment-log-server.ts",
    "src/app/api/birthdays/reminders/route.ts",
  ]) {
    const text = readFileSync(join(root, boundary), "utf8");
    assert.match(text, /createServiceRoleClient\(\)/u, `${boundary} must use the one factory`);
    assert.match(text, /ServiceRoleUnavailableError/u, `${boundary} must translate its error`);
  }
});
