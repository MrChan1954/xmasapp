import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const parserPath = join(root, "scripts", "verify-backup-dump.awk");

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
  // A data dump with no rows in it fails. (The COPY parsing itself is covered
  // by the fixture-driven tests further down, which run the real parser.)
  assert.match(verify, /DATA_ROWS/, "the data dump must be required to contain rows");
  assert.match(verify, /exit 1/, "a failed check must fail the run");
  assert.match(verify, /::error::/, "failures must be annotated so they are visible in the run summary");

  // roles.sql and schema.sql validation must survive every change to the data
  // checks -- all three files are needed to restore.
  assert.match(verify, /for FILE in roles\.sql schema\.sql data\.sql/, "all three dumps must be size-checked");
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

test("the data dump is written in COPY format", () => {
  // The first manual run failed verification because it was not. Without
  // `--use-copy` the Supabase CLI writes per-row INSERT statements, and the
  // verification below looks for COPY blocks. The dump was good; the command
  // and the check disagreed about format.
  const dataStep = workflow
    .split(/^ {6}- name: /m)
    .find((step) => step.startsWith("Dump application data"));
  assert.ok(dataStep, "there must be a data dump step");
  assert.match(dataStep, /--data-only/, "it must dump data, not schema");
  assert.match(dataStep, /--use-copy/, "without --use-copy the CLI emits INSERTs and verification fails");

  // Only the data dump takes --use-copy; roles and schema are DDL and would
  // reject it. Counted over dump INVOCATIONS, since the flag is also named in
  // the surrounding comment and in the verification's error message.
  const invocations = workflow
    .split("\n")
    .filter((line) => line.includes("supabase db dump --db-url"));
  assert.equal(invocations.length, 3, "roles, schema, data");
  assert.equal(
    invocations.filter((line) => line.includes("--use-copy")).length,
    1,
    "--use-copy belongs on the data dump alone",
  );
  for (const line of invocations) {
    if (line.includes("--use-copy")) assert.match(line, /--data-only/, "only the data dump may use it");
  }
});

test("the data dump is summarised by a real parser, not a fragile grep", () => {
  const verifyAt = workflow.indexOf("- name: Verify the dump is real");
  const verify = workflow.slice(verifyAt, workflow.indexOf("uses: actions/upload-artifact"));

  // Two runs were rejected by greps that assumed the exact text of a COPY
  // header. The parser is now a file the tests below actually execute.
  assert.ok(existsSync(parserPath), "the dump parser must exist");
  assert.match(verify, /-f scripts\/verify-backup-dump\.awk/, "verification must use the parser");
  assert.match(verify, /read -r COPY_BLOCKS PUBLIC_BLOCKS DATA_ROWS CORE_COUNT CORE_TABLES/);
  // The parser needs the repository on disk.
  assert.match(workflow, /uses: actions\/checkout@v\d/, "the workspace must be checked out");

  // No `^COPY public\.`-style assumption may survive anywhere in the workflow.
  assert.doesNotMatch(
    verify,
    /grep[^\n]*\^COPY/,
    "COPY headers must not be matched by grep against an assumed exact form",
  );

  // Three independent failure conditions, each able to fail the run.
  assert.match(verify, /if \[ "\$COPY_BLOCKS" -eq 0 \]/);
  assert.match(verify, /if \[ "\$DATA_ROWS" -eq 0 \]/);
  assert.match(verify, /if \[ "\$CORE_COUNT" -eq 0 \]/);
  assert.match(verify, /::error::[^\n]*--use-copy/, "a format failure must name its cause");
  assert.match(verify, /::error::[^\n]*not a single row of data/, "a hollow dump must say so");
  assert.match(verify, /::error::[^\n]*core application table/, "a scope failure must say so");

  // The core-table list is passed to the parser, not embedded in a grep.
  assert.match(
    verify,
    /-v CORE='\^\(people\|contributors\|christmas_recipients\|app_members\|purchases\|settlements\)\$'/,
  );

  // The manifest records the figures, so a backup can be spot-checked without
  // being unpacked.
  for (const field of ["copy_blocks", "public_copy_blocks", "data_rows", "core_tables"]) {
    assert.match(verify, new RegExp(`${field}: \\$\\{`), `MANIFEST must record ${field}`);
  }
});

test("the parser never prints row contents", () => {
  const parser = readFileSync(parserPath, "utf8");
  // Rows are the family's purchases and payments, and this runs in a public
  // CI log. Only aggregates and table names may be emitted.
  const prints = parser.match(/^\s*(print|printf)[^\n]*/gm) ?? [];
  assert.equal(prints.length, 1, "exactly one output statement, in END");
  assert.match(prints[0], /printf "%d %d %d %d %s\\n"/, "counts and table names only");
  assert.doesNotMatch(parser, /print\s+\$0/, "a row must never be echoed");
  // Row lines are counted, never captured.
  assert.match(parser, /in_block && NF\s*\{\s*\n?\s*rows\+\+/);
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

// ---------------------------------------------------------------------------
// The dump parser, run for real
// ---------------------------------------------------------------------------
// Everything above asserts what the workflow SAYS. These run the actual parser
// the workflow runs, against dumps in every shape pg_dump can produce.
//
// This is the part that was missing when two good backups were rejected: the
// checks were greps asserting an exact header string, and no test ever fed a
// real COPY header through them. The specific break was
// --quote-all-identifiers, which the Supabase CLI passes, so the header is
// `COPY "public"."people" (...) FROM stdin;` and `^COPY public\.` matched none.

const CORE_PATTERN = "^(people|contributors|christmas_recipients|app_members|purchases|settlements)$";

/** The exact policy the workflow applies to the parser's output. */
function verdictFor(source) {
  if (source.length === 0) return { accepted: false, reasons: ["empty file"] };

  const fixture = join(tmpdir(), `dump-fixture-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.sql`);
  writeFileSync(fixture, source);
  let summary;
  try {
    summary = execFileSync("awk", ["-v", `CORE=${CORE_PATTERN}`, "-f", parserPath, fixture], {
      encoding: "utf8",
    }).trim();
  } finally {
    rmSync(fixture, { force: true });
  }

  const [blocks, publicBlocks, rows, coreCount, coreTables] = summary.split(" ");
  const reasons = [];
  if (Number(blocks) === 0) reasons.push("no COPY statements");
  if (Number(rows) === 0) reasons.push("no rows");
  if (Number(coreCount) === 0) reasons.push("no core table");
  return {
    accepted: reasons.length === 0,
    reasons,
    blocks: Number(blocks),
    publicBlocks: Number(publicBlocks),
    rows: Number(rows),
    coreTables,
  };
}

/** gawk/mawk ships with Git Bash and with every ubuntu runner. */
const awkAvailable = (() => {
  try {
    execFileSync("awk", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync("awk", ["BEGIN{}"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
})();

test("the parser accepts unquoted COPY identifiers", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  const verdict = verdictFor(
    'COPY public.people (id, name) FROM stdin;\n1\tTaylor\n2\tJade\n\\.\n',
  );
  assert.equal(verdict.accepted, true, verdict.reasons.join(", "));
  assert.equal(verdict.rows, 2);
  assert.equal(verdict.coreTables, "people");
});

test("the parser accepts fully quoted COPY identifiers", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  // THE FORM THAT BROKE TWO BACKUP RUNS. The Supabase CLI runs pg_dump with
  // --quote-all-identifiers, so this is what production actually produces.
  const verdict = verdictFor(
    'COPY "public"."people" ("id", "name") FROM stdin;\n1\tTaylor\n2\tJade\n3\tPaige\n\\.\n',
  );
  assert.equal(verdict.accepted, true, verdict.reasons.join(", "));
  assert.equal(verdict.blocks, 1);
  assert.equal(verdict.rows, 3);
  assert.equal(verdict.coreTables, "people");
});

test("the parser accepts mixed quoted and unquoted identifiers", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  // Both mixtures, plus a header with no column list at all.
  const verdict = verdictFor([
    'COPY public."people" (id) FROM stdin;',
    "1",
    "\\.",
    "",
    'COPY "public".settlements ("id") FROM stdin;',
    "aaa",
    "\\.",
    "",
    'COPY "public"."purchases" FROM stdin;',
    "bbb",
    "\\.",
    "",
  ].join("\n"));
  assert.equal(verdict.accepted, true, verdict.reasons.join(", "));
  assert.equal(verdict.blocks, 3);
  assert.equal(verdict.rows, 3);
  assert.deepEqual(verdict.coreTables.split(",").sort(), ["people", "purchases", "settlements"]);
});

test("the parser rejects a hollow dump of empty COPY blocks", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  // The failure mode the row count exists for: every table present, no data.
  // A header-counting check would call this a healthy backup.
  const verdict = verdictFor([
    'COPY "public"."people" ("id") FROM stdin;',
    "\\.",
    'COPY "public"."purchases" ("id") FROM stdin;',
    "\\.",
    "",
  ].join("\n"));
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.blocks, 2, "the headers are there...");
  assert.equal(verdict.rows, 0, "...but there is no data behind them");
  assert.ok(verdict.reasons.includes("no rows"));
});

test("the parser rejects an INSERT-only dump", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  // What `--data-only` produces WITHOUT `--use-copy`.
  const verdict = verdictFor([
    "--",
    "-- Data for Name: people; Type: TABLE DATA; Schema: public",
    "--",
    "",
    "INSERT INTO \"public\".\"people\" (\"id\", \"name\") VALUES (1, 'Taylor');",
    "INSERT INTO \"public\".\"people\" (\"id\", \"name\") VALUES (2, 'Jade');",
    "",
  ].join("\n"));
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.blocks, 0);
  assert.ok(verdict.reasons.includes("no COPY statements"));
});

test("the parser rejects an empty file", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  assert.equal(verdictFor("").accepted, false);
});

test("the parser rejects a dump of unrelated tables only", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  // Real COPY blocks with real rows, but nothing the Christmas app is about.
  // A dump scoped to the wrong tables is not a backup of this application.
  const verdict = verdictFor([
    'COPY "public"."notification_outbox" ("id") FROM stdin;',
    "x",
    "\\.",
    "",
  ].join("\n"));
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.rows, 1, "there is data...");
  assert.equal(verdict.coreTables, "-", "...but none of it is application data");
  assert.ok(verdict.reasons.includes("no core table"));
});

test("the parser does not count another schema as application data", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  const verdict = verdictFor('COPY "auth"."users" ("id") FROM stdin;\nx\n\\.\n');
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.blocks, 1, "it is a COPY block...");
  assert.equal(verdict.publicBlocks, 0, "...but not in public");
  assert.ok(verdict.reasons.includes("no core table"));
});

test("a realistic production dump is accepted", (t) => {
  if (!awkAvailable) return t.skip("awk is not available on this machine");
  // Quoted identifiers throughout, one legitimately empty table, comment
  // banners and blank lines between blocks — the shape pg_dump really emits.
  const verdict = verdictFor([
    "--",
    "-- Data for Name: people; Type: TABLE DATA; Schema: public; Owner: postgres",
    "--",
    "",
    'COPY "public"."people" ("id", "name") FROM stdin;',
    "1\tTaylor",
    "2\tJade",
    "\\.",
    "",
    "",
    'COPY "public"."purchase_allocations" ("purchase_id", "contributor_id", "responsibility_pennies") FROM stdin;',
    "p1\tc1\t2359",
    "p1\tc2\t2359",
    "p1\tc3\t2358",
    "\\.",
    "",
    "",
    'COPY "public"."settlements" ("id", "amount_pennies") FROM stdin;',
    "s1\t2359",
    "\\.",
    "",
    "",
    'COPY "public"."notification_outbox" ("id") FROM stdin;',
    "\\.",
    "",
  ].join("\n"));
  assert.equal(verdict.accepted, true, verdict.reasons.join(", "));
  assert.equal(verdict.blocks, 4, "four tables dumped");
  assert.equal(verdict.rows, 6, "the empty table contributes no rows");
  assert.deepEqual(verdict.coreTables.split(",").sort(), ["people", "settlements"]);
});
