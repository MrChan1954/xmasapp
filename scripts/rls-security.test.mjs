import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const migrationsDirectory = join(root, "supabase", "migrations");
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const authorizationMigrationName = "202608100010_harden_row_level_security.sql";
const validationMigrationName = "202608100011_validate_user_input.sql";
const atomicRecipientMigrationName = "202608100012_atomic_recipient_budget_allocations.sql";
const purchaseTrackingMigrationName = "202608100013_simplify_purchase_status_and_add_gift_location.sql";
const realtimeMigrationName = "202608100014_enable_realtime_for_shared_data.sql";
const auditMigrationName = "202608100015_add_admin_audit_log.sql";
const auditOpenMigrationName = "202608100016_open_audit_log_and_enrich_detail.sql";
const photosMigrationName = "202608100017_add_item_photos.sql";
const notificationsMigrationName = "202608100018_add_push_notifications.sql";
const authorizationMigration = readFileSync(
  join(migrationsDirectory, authorizationMigrationName),
  "utf8",
);
const validationMigration = readFileSync(join(migrationsDirectory, validationMigrationName), "utf8");
const atomicRecipientMigration = readFileSync(
  join(migrationsDirectory, atomicRecipientMigrationName),
  "utf8",
);
const purchaseTrackingMigration = readFileSync(
  join(migrationsDirectory, purchaseTrackingMigrationName),
  "utf8",
);
const realtimeMigration = readFileSync(join(migrationsDirectory, realtimeMigrationName), "utf8");
const auditMigration = readFileSync(join(migrationsDirectory, auditMigrationName), "utf8");
const auditOpenMigration = readFileSync(join(migrationsDirectory, auditOpenMigrationName), "utf8");
const photosMigration = readFileSync(join(migrationsDirectory, photosMigrationName), "utf8");
const notificationsMigration = readFileSync(join(migrationsDirectory, notificationsMigrationName), "utf8");

const applicationTables = [
  "christmas_events",
  "people",
  "christmas_recipients",
  "contributors",
  "recipient_contributions",
  "app_members",
  "gift_ideas",
  "purchases",
  "purchase_allocations",
  "settlements",
];

test("the authorization migration explicitly enables RLS on every application table", () => {
  // Deliberately pinned to the newest migration. Adding one fails this test on
  // purpose, so a schema change cannot land without this file being reviewed
  // and its checks extended to whatever the migration introduced.
  assert.equal(migrationFiles.at(-1), notificationsMigrationName);

  for (const table of applicationTables) {
    assert.match(
      authorizationMigration,
      new RegExp(`alter table public\\.${table} enable row level security;`, "i"),
      `${table} must have an explicit RLS enable statement`,
    );
  }
});

test("the hardening migration removes anonymous policies and table grants", () => {
  assert.match(authorizationMigration, /roles\s*&&\s*array\['anon',\s*'public'\]/i);

  for (const table of applicationTables) {
    assert.match(
      authorizationMigration,
      new RegExp(
        `revoke all privileges on table public\\.${table} from public, anon, authenticated;`,
        "i",
      ),
      `${table} must have normalized direct grants`,
    );
  }
});

test("browser clients cannot directly mutate financial history", () => {
  for (const table of ["purchases", "purchase_allocations", "settlements"]) {
    assert.match(
      authorizationMigration,
      new RegExp(`grant select on table public\\.${table} to authenticated;`, "i"),
    );
    assert.doesNotMatch(
      authorizationMigration,
      new RegExp(
        `grant[^;]*(?:insert|update|delete)[^;]*on table public\\.${table}`,
        "i",
      ),
    );
  }
});

test("recipient budgets and complete contributor plans use one canonical atomic RPC", () => {
  assert.match(
    validationMigration,
    /revoke insert, update on table public\.recipient_contributions from authenticated;/i,
  );
  assert.match(
    atomicRecipientMigration,
    /function public\.save_christmas_recipient_with_contributions[\s\S]*?is_active_app_member\(\)[\s\S]*?allocation_total <> p_budget_pennies[\s\S]*?allocation_count <> active_contributor_count/i,
  );
  assert.match(
    atomicRecipientMigration,
    /grant execute on function public\.save_christmas_recipient_with_contributions\(uuid, uuid, text, integer, jsonb\)[\s\S]*?to authenticated;/i,
  );
  assert.match(
    atomicRecipientMigration,
    /revoke all on function public\.save_christmas_recipient\(uuid, uuid, text, integer\)[\s\S]*?from public, anon, authenticated;/i,
  );
  assert.match(
    atomicRecipientMigration,
    /revoke all on function public\.save_recipient_contributions\(uuid, jsonb\)[\s\S]*?from public, anon, authenticated;/i,
  );
});

test("deferred database constraints reject every active recipient budget mismatch", () => {
  assert.match(
    atomicRecipientMigration,
    /create constraint trigger recipient_budget_allocation_invariant[\s\S]*?deferrable initially deferred/i,
  );
  assert.match(
    atomicRecipientMigration,
    /create constraint trigger recipient_contribution_allocation_invariant[\s\S]*?deferrable initially deferred/i,
  );
  assert.match(
    atomicRecipientMigration,
    /allocation_total <> target_budget_pennies[\s\S]*?Contributor allocations must equal the recipient budget exactly/i,
  );
});

test("the atomic RPC validates the complete plan before its first data write", () => {
  const functionBody = atomicRecipientMigration.match(
    /create or replace function public\.save_christmas_recipient_with_contributions[\s\S]*?\nend;\n\$\$;/i,
  )?.[0];
  assert.ok(functionBody);
  const firstWrite = functionBody.indexOf("insert into public.people");
  assert.ok(firstWrite > 0);
  for (const requiredValidation of [
    "allocation_total <> p_budget_pennies",
    "allocation_count <> active_contributor_count",
    "Contributors must be active for this Christmas event",
  ]) {
    assert.ok(
      functionBody.indexOf(requiredValidation) > -1
        && functionBody.indexOf(requiredValidation) < firstWrite,
      `${requiredValidation} must be checked before any recipient write`,
    );
  }
});

test("inactive memberships cannot read even their own app_members row", () => {
  assert.match(
    authorizationMigration,
    /create policy "active members may read own membership"[\s\S]*?for select[\s\S]*?to authenticated[\s\S]*?user_id\s*=\s*\(select auth\.uid\(\)\)[\s\S]*?active\s*=\s*true/i,
  );
});

test("every application-facing SECURITY DEFINER RPC denies anonymous execution", () => {
  const signatures = [
    "is_active_app_member\\(\\)",
    "claim_app_member\\(\\)",
    "is_app_admin\\(\\)",
    "set_christmas_recipient_active\\(uuid, boolean\\)",
    "current_app_member_id\\(\\)",
    "list_gift_ideas\\(uuid\\)",
    "save_purchase\\(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb\\)",
    "set_purchase_status\\(uuid, text\\)",
    "void_purchase\\(uuid\\)",
    "current_app_contributor_id\\(uuid\\)",
    "record_settlement\\(uuid, uuid, uuid, integer, date, text\\)",
    "void_settlement\\(uuid\\)",
  ];

  for (const signature of signatures) {
    assert.match(
      authorizationMigration,
      new RegExp(
        `revoke all on function public\\.${signature} from public, anon, authenticated;`,
        "i",
      ),
    );
    assert.match(
      authorizationMigration,
      new RegExp(`grant execute on function public\\.${signature} to authenticated;`, "i"),
    );
  }
});

test("older SECURITY DEFINER membership helpers now use a fixed empty search path", () => {
  for (const functionName of ["is_active_app_member", "claim_app_member"]) {
    assert.match(
        authorizationMigration,
      new RegExp(
        `create or replace function public\\.${functionName}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`,
        "i",
      ),
    );
  }
});

test("stored user text and URLs have authoritative database constraints", () => {
  for (const constraint of [
    "people_name_safe_check",
    "app_members_email_safe_check",
    "gift_ideas_title_safe_check",
    "gift_ideas_url_safe_check",
    "purchases_description_safe_check",
    "settlements_notes_safe_check",
  ]) {
    assert.match(validationMigration, new RegExp(`add constraint ${constraint}`, "i"));
  }
  assert.match(validationMigration, /gift_ideas_url_safe_check[\s\S]*?\^https\?\:\/\//i);
  assert.match(validationMigration, /revoke insert, update on table public\.gift_ideas from authenticated;/i);
  assert.match(validationMigration, /grant execute on function public\.save_gift_idea\(uuid, uuid, text, integer, text, text, text\) to authenticated;/i);
  assert.match(atomicRecipientMigration, /grant execute on function public\.save_christmas_recipient_with_contributions\(uuid, uuid, text, integer, jsonb\)[\s\S]*?to authenticated;/i);
});

test("application source cannot call either deprecated split recipient save path", () => {
  const sourceDirectory = join(root, "src");
  const sourceFiles = walk(sourceDirectory).filter((path) => /\.(?:ts|tsx|js|jsx)$/.test(path));
  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\.rpc\(\s*["']save_christmas_recipient["']/);
    assert.doesNotMatch(source, /\.rpc\(\s*["']save_recipient_contributions["']/);
  }
});

test("purchase status and gift location use the new canonical purchase RPC", () => {
  assert.match(
    purchaseTrackingMigration,
    /update public\.purchases[\s\S]*?status = 'purchased'[\s\S]*?where status in \('arrived', 'Purchased \/ Ordered', 'Arrived'\)/i,
  );
  assert.match(
    purchaseTrackingMigration,
    /purchases_status_two_state_check[\s\S]*?status in \('purchased', 'wrapped'\)/i,
  );
  assert.match(
    purchaseTrackingMigration,
    /gift_location_person_id uuid[\s\S]*?references public\.people\(id\) on delete set null/i,
  );
  assert.match(
    purchaseTrackingMigration,
    /function public\.save_purchase_with_location[\s\S]*?p_status not in \('purchased', 'wrapped'\)[\s\S]*?location_contributor\.christmas_event_id = recipient_event_id[\s\S]*?location_contributor\.person_id = p_gift_location_person_id[\s\S]*?location_contributor\.active = true/i,
  );
  assert.match(
    purchaseTrackingMigration,
    /revoke all on function public\.save_purchase\(uuid, uuid, text, integer, uuid, date, text, text, text, text, uuid, jsonb\)[\s\S]*?from public, anon, authenticated;/i,
  );
  assert.match(
    purchaseTrackingMigration,
    /grant execute on function public\.save_purchase_with_location\(uuid, uuid, text, integer, uuid, uuid, date, text, text, text, text, uuid, jsonb\)[\s\S]*?to authenticated;/i,
  );
});

test("application purchases cannot bypass location validation or use legacy statuses", () => {
  const sourceDirectory = join(root, "src");
  const sourceFiles = walk(sourceDirectory).filter((path) => /\.(?:ts|tsx|js|jsx)$/.test(path));
  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\.rpc\(\s*["']save_purchase["']/, `${path} must use the location-aware writer`);
  }
  const purchaseForm = readFileSync(join(root, "src", "app", "add-purchase", "purchase-form.tsx"), "utf8");
  assert.match(purchaseForm, /\.rpc\("save_purchase_with_location"/);
  assert.match(purchaseForm, /validateEnum\(status, \["purchased", "wrapped"\]/);
  assert.match(purchaseForm, /setGiftLocations\(nextContributors[\s\S]*?\.filter\(\(row\) => row\.active\)[\s\S]*?row\.personId/);
  assert.match(purchaseForm, /setAutomaticSnapshotLocked\(purchase\.split_type === "automatic"\)/);
  assert.match(purchaseForm, /setAllocations\(Object\.fromEntries\(\(allocationsResult\.data/);

  const owedMath = readFileSync(join(root, "src", "lib", "owed.ts"), "utf8");
  assert.doesNotMatch(owedMath, /gift_location_person_id/);
});

test("changing gift location cannot rewrite purchase responsibility or Owed inputs", () => {
  const wrapper = purchaseTrackingMigration.match(
    /create or replace function public\.save_purchase_with_location[\s\S]*?\nend;\n\$\$;/i,
  )?.[0];
  assert.ok(wrapper);
  assert.match(wrapper, /saved_purchase := public\.save_purchase\(/i);
  const locationUpdate = wrapper.slice(wrapper.indexOf("update public.purchases"));
  assert.match(locationUpdate, /set gift_location_person_id = p_gift_location_person_id/i);
  assert.doesNotMatch(locationUpdate, /purchase_allocations|responsibility_pennies|actual_price_pennies|checkout_payer_contributor_id/i);

  const owedSource = readFileSync(join(root, "src", "app", "owed", "owed-data.ts"), "utf8");
  assert.doesNotMatch(owedSource, /gift_location_person_id/);
});

test("secondary Payment Log navigation remains under More", () => {
  // The primary nav is now one shared list consumed by both the desktop icon
  // rail and the mobile tab bar, so this asserts against that list directly.
  const navItems = readFileSync(join(root, "src", "app", "components", "nav-items.ts"), "utf8");
  const primaryNav = navItems.match(/export const navItems[\s\S]*?\n\];/)?.[0];
  assert.ok(primaryNav);
  assert.doesNotMatch(primaryNav, /"\/payment-log"/);
  assert.match(primaryNav, /href: "\/more"/);
  // Payment Log still counts as being "under More" for active highlighting.
  assert.match(navItems, /moreMatch[\s\S]*?startsWith\("\/payment-log"\)/);

  const morePage = readFileSync(join(root, "src", "app", "more", "page.tsx"), "utf8");
  assert.match(morePage, /href="\/payment-log"[\s\S]*?Payment log/i);
});

test("contributor cards present responsibility spending without checkout totals", () => {
  const home = readFileSync(join(root, "src", "app", "page.tsx"), "utf8");
  assert.match(home, /purchase_allocations/);
  assert.match(home, /actualResponsibilityPennies/);
  assert.match(home, /contributor\.owed\?\.youOwePennies/);
  assert.doesNotMatch(home, /owedToYouPennies\s*-\s*contributor\.owed\.youOwePennies|You are owed/);
  assert.doesNotMatch(home, /Paid at checkout|checkoutPaidPennies/);
});

test("admin-only RPCs and server account management re-authorize the caller", () => {
  const adminMigration = readFileSync(
    join(migrationsDirectory, "202608100006_add_admin_access_controls.sql"),
    "utf8",
  );
  const settlementMigration = readFileSync(
    join(migrationsDirectory, "202608100009_add_settlements.sql"),
    "utf8",
  );
  const familyAccessAuthorization = readFileSync(
    join(root, "src", "utils", "supabase", "family-access-admin.ts"),
    "utf8",
  );

  assert.match(
    adminMigration,
    /create or replace function public\.is_app_admin\(\)[\s\S]*?user_id\s*=\s*\(select auth\.uid\(\)\)[\s\S]*?active\s*=\s*true[\s\S]*?role\s*=\s*'admin'/i,
  );
  assert.match(
    adminMigration,
    /function public\.set_christmas_recipient_active[\s\S]*?if not public\.is_app_admin\(\) then/i,
  );
  assert.match(
    settlementMigration,
    /function public\.void_settlement[\s\S]*?if not public\.is_app_admin\(\) then/i,
  );
  assert.match(
    settlementMigration,
    /if not public\.is_app_admin\(\) and current_contributor_id <> p_payee_contributor_id then/i,
  );
  assert.match(familyAccessAuthorization, /^import "server-only";/);
  assert.match(
    familyAccessAuthorization,
    /membership\.active\s*\|\|\s*membership\.role !== "admin"/,
  );
});

test("the server secret is absent from client components", () => {
  const sourceDirectory = join(root, "src");
  const sourceFiles = walk(sourceDirectory).filter((path) => /\.(?:ts|tsx|js|jsx)$/.test(path));

  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    if (/^[\s\uFEFF]*["']use client["'];/m.test(source)) {
      assert.doesNotMatch(source, /SUPABASE_SECRET_KEY/);
    }
  }
});

test("application source has no executable HTML or dynamic-code sinks", () => {
  const sourceDirectory = join(root, "src");
  const sourceFiles = walk(sourceDirectory).filter((path) => /\.(?:ts|tsx|js|jsx)$/.test(path));
  const forbiddenSinks = [
    /dangerouslySetInnerHTML\s*=/,
    /(?:^|[^\w.])(?:innerHTML|outerHTML)\s*=/m,
    /document\.write\s*\(/,
    /insertAdjacentHTML\s*\(/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
  ];

  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    for (const sink of forbiddenSinks) {
      assert.doesNotMatch(source, sink, `${path} must not contain ${sink}`);
    }
  }
});

test("stored gift URLs are validated again at the href sink", () => {
  const source = readFileSync(join(root, "src", "app", "people", "gift-ideas.tsx"), "utf8");
  assert.match(source, /safeHttpUrl\(idea\.url\)/);
  assert.match(source, /href=\{itemUrl\}[\s\S]*?rel="noopener noreferrer"/);
  assert.doesNotMatch(source, /href=\{idea\.url\}/);
});

test("source does not build PostgREST filter expressions from user input", () => {
  const sourceDirectory = join(root, "src");
  const sourceFiles = walk(sourceDirectory).filter((path) => /\.(?:ts|tsx|js|jsx)$/.test(path));
  for (const path of sourceFiles) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /\.or\s*\(/, `${path} must use query-builder parameters`);
  }
});

test("the request origin only relaxes to plain HTTP under next dev", async () => {
  // Executing the resolver is stronger than pattern-matching it: any refactor
  // that leaks the development relaxation into a built server fails here.
  const { resolveRequestOrigin } = await import("../src/lib/request-origin.ts");

  for (const host of [
    "192.168.0.11:3000",
    "10.0.0.5",
    "christmas.example.com",
    "localhost.attacker.example",
    "127.0.0.1.attacker.example",
  ]) {
    assert.equal(
      resolveRequestOrigin({ host, isDevelopment: false }),
      `https://${host}`,
      `${host} must stay HTTPS in a built server`,
    );
    // An unset NODE_ENV must fail closed rather than count as development.
    assert.equal(resolveRequestOrigin({ host }), `https://${host}`);
  }

  // The relaxation exists, and only under `next dev`.
  assert.equal(
    resolveRequestOrigin({ host: "192.168.0.11:3000", isDevelopment: true }),
    "http://192.168.0.11:3000",
  );

  // The resolver must stay environment-free, so the behaviour above is decided
  // entirely by the flag its caller passes. (Comments may still name NODE_ENV;
  // what must not appear is a read of it.)
  const resolver = readFileSync(join(root, "src", "lib", "request-origin.ts"), "utf8");
  assert.doesNotMatch(resolver, /process\.env/);
  assert.doesNotMatch(resolver, /globalThis\.process/);

  // The one caller that supplies that flag must derive it from NODE_ENV, as a
  // literal member expression the server bundle can inline.
  const wrapper = readFileSync(join(root, "src", "utils", "request-origin.ts"), "utf8");
  assert.match(wrapper, /^import "server-only";/);
  assert.match(wrapper, /isDevelopment: process\.env\.NODE_ENV === "development"/);
  assert.doesNotMatch(wrapper, /isDevelopment:\s*(?:true|false)/);

  // A configured origin must still reject embedded credentials and non-http(s)
  // schemes before it is trusted over the request headers.
  assert.match(resolver, /configuredUrl\.protocol === "http:" \|\| configuredUrl\.protocol === "https:"/);
  assert.match(resolver, /!configuredUrl\.username &&\s*!configuredUrl\.password/);
});

test("every request origin is derived through the single server helper", () => {
  const owners = new Set([
    join(root, "src", "lib", "request-origin.ts"),
    join(root, "src", "lib", "request-origin.test.ts"),
    join(root, "src", "utils", "request-origin.ts"),
  ]);
  const sourceFiles = walk(join(root, "src"))
    .filter((path) => /\.(?:ts|tsx|js|jsx)$/.test(path) && !owners.has(path));

  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /x-forwarded-proto/i, `${path} must use getRequestOrigin`);
    assert.doesNotMatch(source, /x-forwarded-host/i, `${path} must use getRequestOrigin`);
  }
});

test("admin mutations still compare the full request origin for exact equality", () => {
  const source = readFileSync(
    join(root, "src", "app", "api", "admin", "family-access", "route.ts"),
    "utf8",
  );

  // Every mutation must run the origin check, and it must compare whole origins
  // (scheme included) rather than only the host.
  assert.match(source, /const requestOrigin = assertSameOrigin\(request\);/);
  assert.match(source, /normalizedOrigin !== requestOrigin/);
  assert.match(source, /const requestOrigin = getRequestOrigin\(request\);/);
  assert.doesNotMatch(source, /\.host !==/);
});

test("realtime only streams tables that RLS already restricts to app members", () => {
  // Anything published here is delivered to browser clients, so the publication
  // must never contain a table an unauthenticated or non-member client can read.
  // Assert against executable SQL only; the comments in this migration discuss
  // the settings it deliberately does not use.
  const realtimeStatements = realtimeMigration.replace(/--[^\n]*/g, "");
  const published = [...realtimeStatements.matchAll(/^\s*'([a-z_]+)',?\s*$/gm)].map((m) => m[1]);
  assert.ok(published.length > 0, "the realtime migration must publish at least one table");

  for (const table of published) {
    assert.ok(
      applicationTables.includes(table),
      `${table} is published to realtime but is not a known application table`,
    );
    // Migration 010 revoked blanket grants and re-granted select to authenticated
    // only; that revoke is what keeps anon off the stream.
    assert.match(
      authorizationMigration,
      new RegExp(
        `revoke all privileges on table public\\.${table} from public, anon, authenticated;`,
        "i",
      ),
      `${table} must have normalized grants before it is streamed`,
    );
  }

  // app_members carries login emails and only ever resolves to the caller's own
  // row, so publishing it would add exposure without adding usefulness.
  assert.ok(!published.includes("app_members"), "app_members must not be streamed to clients");

  // `replica identity full` would put complete pre-change rows, including
  // financial columns, on the wire for every update.
  assert.doesNotMatch(realtimeStatements, /replica\s+identity\s+full/i);
});

test("realtime subscriptions never trust the streamed payload as data", () => {
  const sourceFiles = walk(join(root, "src")).filter((path) => /\.(?:ts|tsx)$/.test(path));

  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    if (!/postgres_changes/.test(source)) continue;

    // The stream is a change notification only. Reading `payload.new` / `payload.old`
    // would bypass the authorized fetch path that applies RLS and admin checks.
    assert.doesNotMatch(source, /payload\s*\.\s*(?:new|old)\b/, `${path} must refetch, not read the payload`);
  }
});

test("the audit log is readable by active members and writable by nobody", () => {
  const created = auditMigration.replace(/--[^\n]*/g, "");
  const opened = auditOpenMigration.replace(/--[^\n]*/g, "");

  assert.match(created, /alter table public\.audit_log enable row level security;/i);
  assert.match(
    created,
    /revoke all privileges on table public\.audit_log from public, anon, authenticated;/i,
  );

  // Migration 016 widened read access from admins to any active member, and the
  // admin-only policy must actually be dropped rather than left alongside.
  assert.match(opened, /drop policy if exists "admins read the audit log" on public\.audit_log;/i);
  assert.match(opened, /for select to authenticated\s+using \(public\.is_active_app_member\(\)\)/i);

  // Widening the audience makes the write lockdown matter more, not less: SELECT
  // is still the only grant and there is still no insert/update/delete policy,
  // so nobody — admin included — can edit or clear their own trail.
  assert.match(created, /grant select on table public\.audit_log to authenticated;/i);
  for (const migration of [created, opened]) {
    assert.doesNotMatch(migration, /grant [^;]*\b(insert|update|delete)\b[^;]*on table public\.audit_log/i);
    assert.doesNotMatch(migration, /for (insert|update|delete)[^;]*on public\.audit_log/i);
  }
});

test("the audit log never records a login email", () => {
  // The log is now visible to the whole family, so what the trigger copies into
  // it matters. `app_members.email` must never be one of them.
  for (const migration of [auditMigration, auditOpenMigration]) {
    const statements = migration.replace(/--[^\n]*/g, "");
    assert.doesNotMatch(statements, /->>\s*'email'/i);
    assert.doesNotMatch(statements, /\bm\.email\b|\bapp_members\.email\b/i);
    // Whole-row capture would sweep the email in by accident.
    assert.doesNotMatch(statements, /'details',\s*to_jsonb\((NEW|OLD)\)/i);
  }
});

test("every table that can add or remove records is audited", () => {
  const statements = auditMigration.replace(/--[^\n]*/g, "");

  // Soft deletes are the norm here, so these have to catch UPDATE as well or a
  // removal would go unrecorded.
  const softDeleted = {
    contributors: "active",
    christmas_recipients: "active",
    app_members: "active",
    purchases: "deleted_at",
    settlements: "voided_at",
  };
  for (const [table, column] of Object.entries(softDeleted)) {
    assert.match(
      statements,
      new RegExp(`after insert or update or delete on public\\.${table}[\\s\\S]{0,120}record_audit_event\\('${column}'\\)`, "i"),
      `${table} must audit its ${column} soft delete`,
    );
  }

  for (const table of ["people", "recipient_contributions", "purchase_allocations", "gift_ideas"]) {
    assert.match(
      statements,
      new RegExp(`after insert or delete on public\\.${table}`, "i"),
      `${table} must be audited`,
    );
  }

  // The trigger runs with definer rights, so it must pin its search path like
  // every other SECURITY DEFINER function in this schema.
  assert.match(statements, /create or replace function public\.record_audit_event\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i);
  assert.match(statements, /create or replace function public\.audit_actor_name\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i);
});

test("item photos are visible to exactly the people who can see the item", () => {
  const statements = photosMigration.replace(/--[^\n]*/g, "");

  assert.match(statements, /alter table public\.item_photos enable row level security;/i);
  assert.match(
    statements,
    /revoke all privileges on table public\.item_photos from public, anon, authenticated;/i,
  );

  // `purchases` and `gift_ideas` are both readable by any active member, so a
  // photo of one must use the same predicate — never a wider one.
  assert.match(statements, /for select to authenticated\s+using \(public\.is_active_app_member\(\)\)/i);

  // A photo must belong to exactly one item. Without this a row could point at
  // both, or at neither, and inherit the wrong visibility.
  assert.match(statements, /constraint item_photos_one_parent check/i);

  // No UPDATE: re-pointing a row at a different file would swap the image behind
  // an existing audit entry.
  assert.match(statements, /grant select, insert, delete on table public\.item_photos to authenticated;/i);
  assert.doesNotMatch(statements, /for update[^;]*on public\.item_photos/i);

  // Deleting the parent must take its photos with it.
  assert.match(statements, /purchase_id uuid references public\.purchases\(id\) on delete cascade/i);
  assert.match(statements, /gift_idea_id uuid references public\.gift_ideas\(id\) on delete cascade/i);
});

test("photo storage policies are scoped to the photo bucket alone", () => {
  const statements = photosMigration.replace(/--[^\n]*/g, "");

  // Every storage policy must name the bucket AND check membership. A policy
  // missing the bucket clause would apply to every bucket in the project.
  const storagePolicies = statements.match(/on storage\.objects[\s\S]*?;/g) ?? [];
  assert.ok(storagePolicies.length >= 3, "expected select, insert and delete storage policies");
  for (const policy of storagePolicies) {
    assert.match(policy, /bucket_id = 'item-photos'/, "storage policy must be scoped to the bucket");
    assert.match(policy, /public\.is_active_app_member\(\)/, "storage policy must require membership");
  }

  // The storage path is what a signed URL is minted against, and the activity
  // log is readable by the whole family.
  assert.doesNotMatch(statements, /resolved_subject := payload ->> 'storage_path'/i);
});

test("the notification tables are locked down and hold no financial data", () => {
  // These arrived after the hardening migration, so they carry their own
  // enable/revoke rather than being covered by the sweep above.
  for (const table of ["push_subscriptions", "notification_preferences", "notification_events"]) {
    assert.match(
      notificationsMigration,
      new RegExp(`alter table public\.${table} enable row level security;`, "i"),
      `${table} must have an explicit RLS enable statement`,
    );
    assert.match(
      notificationsMigration,
      new RegExp(`revoke all privileges on table public\.${table} from public, anon, authenticated;`, "i"),
      `${table} must have normalized direct grants`,
    );
  }

  // The send ledger is server-only: no browser token may read or write it.
  assert.doesNotMatch(notificationsMigration, /grant [a-z, ]+ on table public\.notification_events/i);

  // Push endpoints and device encryption keys are readable only by their owner,
  // and can only ever be written by the server's secret-key client.
  assert.doesNotMatch(
    notificationsMigration,
    /create policy[^;]*on public\.push_subscriptions\s+for (insert|update)/i,
  );

  // No money column lives in these tables. Asserted against the statements with
  // comments stripped, since the prose above them necessarily discusses
  // balances and amounts while explaining why none are stored.
  const statements = notificationsMigration.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(statements, /\b\w*(pennies|amount|balance|budget)\w*\s+(integer|numeric|bigint)/i);

  // None of them may join the Realtime publication: that would broadcast push
  // endpoints and per-device encryption keys to every subscribed client.
  assert.doesNotMatch(statements, /alter publication supabase_realtime/i);
});

test("the application CSP blocks object and frame embedding and production eval", () => {
  const source = readFileSync(join(root, "next.config.ts"), "utf8");
  assert.match(source, /object-src 'none'/);
  assert.match(source, /frame-src 'none'/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /isDevelopment \? " 'unsafe-eval'" : ""/);
});

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
