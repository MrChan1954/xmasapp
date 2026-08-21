import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The backup is the only thing standing between a Supabase accident and the
 * permanent loss of every purchase and payment the family has recorded. Git
 * holds the schema and the code; it holds none of the data.
 *
 * A backup workflow is also the easiest thing in a repository to break without
 * noticing, because nobody looks at it until the day it is needed. These tests
 * pin the properties that make it worth having at all.
 *
 * Deliberately no YAML parser. The only one available here is `yaml`, which is
 * a hoisted transitive dependency this project never declared -- a safety net
 * that can vanish on the next `pnpm install` is not a safety net. Assertions
 * are made against the file's text, which is ours and stable.
 */

const root = process.cwd();
const workflowPath = join(root, ".github", "workflows", "database-backup.yml");
const docsPath = join(root, "docs", "database-backups.md");
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";

test("the backup workflow exists", () => {
  assert.ok(existsSync(workflowPath), "the daily database backup workflow must exist");
  assert.match(workflow, /^name: Database backup$/m);
  assert.match(workflow, /^jobs:$/m);
  assert.match(workflow, /^ {2}backup:$/m);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  // Tabs are invalid in YAML and are the classic way to break a workflow.
  assert.doesNotMatch(workflow, /\t/, "YAML must not contain tab characters");
});

test("it runs daily and can be triggered by hand", () => {
  // Manual, so a backup can be taken immediately before applying a migration.
  assert.match(workflow, /^ {2}workflow_dispatch:$/m, "a manual trigger must exist");

  // Daily. A fixed minute and hour, so it fires once a day rather than hourly.
  const cron = workflow.match(/- cron: "([^"]+)"/);
  assert.ok(cron, "a schedule must exist");
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron[1].trim().split(/\s+/);
  assert.match(minute, /^\d+$/, "a fixed minute, not a range or step");
  assert.match(hour, /^\d+$/, "a fixed hour, so it runs once a day and not hourly");
  assert.equal(dayOfMonth, "*");
  assert.equal(month, "*");
  assert.equal(dayOfWeek, "*");
  assert.equal((workflow.match(/- cron:/g) ?? []).length, 1, "exactly one schedule");
});

test("backups are retained for 30 days under a dated name", () => {
  assert.match(workflow, /uses: actions\/upload-artifact@v\d/, "the dump must be uploaded as an artifact");
  assert.match(workflow, /retention-days: 30\b/, "30-day retention is the documented promise");
  assert.match(
    workflow,
    /name: supabase-backup-\$\{\{ steps\.name\.outputs\.stamp \}\}/,
    "artifacts must be named recognisably AND dated, or each run overwrites the last",
  );
  // The stamp is a real date, computed at run time.
  assert.match(workflow, /date -u \+'%Y-%m-%d'/);
  // An empty directory must fail rather than publish an empty artifact that
  // looks like a backup.
  assert.match(workflow, /if-no-files-found: error/);
});

test("a failed dump cannot be mistaken for a successful backup", () => {
  // Roles, schema and data are dumped separately, and each step aborts on the
  // first error and on an unset variable. Matched on the invocation rather than
  // the step text, because the surrounding comments mention the command too.
  assert.equal(
    (workflow.match(/supabase db dump --db-url/g) ?? []).length,
    3,
    "roles, schema and data are dumped separately",
  );
  const dumpSteps = workflow
    .split(/^ {6}- name: /m)
    .filter((step) => step.includes("supabase db dump --db-url"));
  assert.equal(dumpSteps.length, 3);
  for (const step of dumpSteps) {
    assert.match(step, /set -euo pipefail/, "a dump step must abort on failure");
  }

  // Verification must run BEFORE the upload, or an invalid dump is published
  // before anybody checks it.
  const verifyAt = workflow.indexOf("- name: Verify the dump is real");
  const uploadAt = workflow.indexOf("uses: actions/upload-artifact");
  assert.ok(verifyAt > 0, "there must be a verification step");
  assert.ok(verifyAt < uploadAt, "verification must precede the upload");

  const verify = workflow.slice(verifyAt, uploadAt);
  // Empty files fail.
  assert.match(verify, /if \[ ! -s "\$\{DIR\}\/\$\{FILE\}" \]/, "each file must be checked for being non-empty");
  // A schema missing any financial table fails.
  for (const table of [
    "purchases", "purchase_allocations", "settlements", "payment_receipts",
    "contributors", "recipient_contributions", "christmas_recipients", "app_members",
  ]) {
    assert.ok(verify.includes(table), `the schema check must require ${table}`);
  }
  // A data dump with no rows in it fails.
  assert.match(verify, /COPY public\\\./, "the data dump must be required to contain rows");
  assert.match(verify, /exit 1/, "a failed check must fail the run");
  assert.match(verify, /::error::/, "failures must be annotated so they are visible in the run summary");
});

test("credentials are never echoed and dumps never enter the repository", () => {
  // The secret is passed through `env:` only, never interpolated into a log
  // line, a filename, or a command argument that gets printed.
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{\{\s*secrets\./, "a secret must never be echoed");
  // The VALUE must never be expanded into an echo. Naming the secret in an
  // error message is fine and is how the missing-secret failure explains itself
  // — `echo "::error::SUPABASE_DB_URL is not set"` carries no `$`.
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{?SUPABASE_DB_URL/, "a secret's value must never be echoed");
  // Presence is checked with -z, which reveals nothing about the value.
  assert.match(workflow, /if \[ -z "\$\{SUPABASE_DB_URL:-\}" \]/);

  // Dumps live outside the checkout, so nothing can sweep them into a commit.
  assert.match(workflow, /\$\{RUNNER_TEMP\}\/backup/, "dumps must live outside the checkout");
  assert.doesNotMatch(workflow, /git (add|commit|push)/, "a backup must never be committed");

  // The workflow only reads the repository.
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);

  // And nothing here can restore over production.
  assert.doesNotMatch(workflow, /psql[^\n]*-f /, "restoring is a documented manual procedure, never a workflow");
  assert.doesNotMatch(workflow, /supabase db (reset|push)/, "this workflow must not write to any database");
  assert.doesNotMatch(workflow, /--data-only[^\n]*--clean/, "no destructive dump flags");
});

test("the connection string is checked for the failure modes that cannot dump", () => {
  const guardAt = workflow.indexOf("- name: Check the connection string secret is present and usable");
  assert.ok(guardAt > 0, "the connection string must be validated before any dump runs");
  assert.ok(
    guardAt < workflow.indexOf("supabase db dump --db-url"),
    "validation must precede the first dump",
  );
  const guard = workflow.slice(guardAt, workflow.indexOf("- name: Install the Supabase CLI"));

  // Port 6543 is Supavisor TRANSACTION mode: no session, so pg_dump cannot take
  // a consistent snapshot. It must fail immediately, not part-way through.
  assert.match(guard, /\*:6543/, "a transaction-mode URI must be detected");
  assert.match(guard, /::error::[^\n]*6543/, "and rejected with an explanation");
  // Everything from the 6543 pattern to the end of its case branch must exit.
  assert.ok(
    guard.slice(guard.indexOf("*:6543"), guard.indexOf(";;", guard.indexOf("*:6543"))).includes("exit 1"),
    "a transaction-mode URI must fail the run",
  );

  // GitHub runners are IPv4-only; the direct endpoint is IPv6-only without the
  // add-on. A warning, not a failure -- a project WITH the add-on may use it.
  assert.match(guard, /db\.\*\.supabase\.co/, "the direct endpoint must be recognised");
  assert.match(guard, /::warning::[^\n]*IPv4/, "and warned about rather than blocked");

  // Still never echoes the value.
  assert.doesNotMatch(guard, /echo[^\n]*\$\{?SUPABASE_DB_URL/);
});

test("nothing anywhere recommends transaction mode for a dump", () => {
  const docs = readFileSync(docsPath, "utf8");
  for (const [label, text] of [["workflow", workflow], ["docs", docs]]) {
    const mentions = text
      .split("\n")
      .filter((candidate) => candidate.includes("6543"))
      // A shell `case` glob is the code that REJECTS 6543, not prose about it.
      .filter((candidate) => !/^\s*\*[^)]*\)\s*$/.test(candidate));

    assert.ok(mentions.length > 0, `${label}: port 6543 must be addressed explicitly`);
    for (const line of mentions) {
      assert.match(
        line,
        /never|not|reject|avoid|cannot|transaction/i,
        `${label}: every mention of port 6543 must be a warning, got: ${line.trim()}`,
      );
    }
  }

  // And no example anywhere hands 6543 to a tool as a connection string.
  for (const text of [workflow, docs]) {
    assert.doesNotMatch(text, /postgres(ql)?:\/\/[^\s"']*:6543/, "no sample URI may use transaction mode");
  }
});

test("the docs name the session pooler as the default connection string", () => {
  const docs = readFileSync(docsPath, "utf8");

  // The default, and why.
  assert.match(docs, /Session pooler/i, "the docs must name the Session pooler option in the dashboard");
  assert.match(docs, /pooler\.supabase\.com:5432/, "the example URI must be the session pooler on 5432");
  assert.match(docs, /postgres\.YOUR-PROJECT-REF/, "the pooler username carries the project ref");
  assert.match(docs, /IPv4-only/i, "the docs must explain why the direct connection is not the default");
  assert.match(docs, /IPv6/, "and what the direct endpoint actually resolves to");

  // The direct connection stays documented, but as a conditional alternative.
  const directSection = docs.slice(docs.indexOf("Direct connection is a valid alternative"));
  assert.ok(directSection.length > 0, "the direct connection must remain documented as an alternative");
  assert.match(directSection, /IPv4 add-on/i, "gated on the add-on");
  assert.match(directSection, /db\.YOUR-PROJECT-REF\.supabase\.co:5432/, "still port 5432");
});

test("gitignore keeps database dumps out of the repository", () => {
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  for (const pattern of ["*.dump", "*.sql.gz"]) {
    assert.ok(ignore.includes(pattern), `.gitignore must cover ${pattern}`);
  }
  // Dev logs, the other thing that got committed by accident.
  assert.ok(ignore.includes("*.log"), ".gitignore must cover stray dev logs");
  // Migrations are .sql and must NOT be swallowed by a broad ignore rule.
  assert.doesNotMatch(ignore, /^\*\.sql$/m, "ignoring *.sql would hide every migration");
  assert.doesNotMatch(ignore, /^supabase\//m, "the migrations directory must stay tracked");
});

test("the backup is documented, including what it does not cover", () => {
  assert.ok(existsSync(docsPath), "backups must be documented");
  const docs = readFileSync(docsPath, "utf8");

  // The honest gaps matter more than the happy path.
  for (const gap of ["Auth users", "Storage objects", "VAPID"]) {
    assert.ok(docs.includes(gap), `the docs must say that ${gap} are not backed up`);
  }
  // The operational essentials.
  assert.ok(docs.includes("SUPABASE_DB_URL"), "the required secret must be named");
  assert.ok(docs.includes("5432"), "the direct connection port must be given, not the pooler");
  assert.ok(docs.includes("30"), "retention must be stated");
  assert.ok(/restore/i.test(docs), "a restore procedure must exist");
  assert.ok(
    docs.includes("no restore workflow"),
    "the docs must say why restoring is deliberately manual",
  );
  // The restore instructions must include the checks that prove the restore is
  // sound, not just the commands that load it.
  assert.ok(docs.includes("responsibility_pennies"), "restore verification must check allocations");
  assert.ok(docs.includes("confirmed_amount_pennies"), "restore verification must check payments");
});
