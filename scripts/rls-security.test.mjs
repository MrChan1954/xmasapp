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
const notificationCentreMigrationName = "202608100019_add_notification_centre.sql";
const notificationOutboxMigrationName = "202608100020_add_notification_outbox.sql";
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
const notificationCentreMigration = readFileSync(join(migrationsDirectory, notificationCentreMigrationName), "utf8");
const notificationOutboxMigration = readFileSync(join(migrationsDirectory, notificationOutboxMigrationName), "utf8");
const paymentConfirmationsMigrationName = "202608100021_add_payment_confirmations.sql";
const adminOverrideMigrationName = "202608100022_separate_admin_payment_override.sql";
const paymentConfirmationsMigration = readFileSync(join(migrationsDirectory, paymentConfirmationsMigrationName), "utf8");
const adminOverrideMigration = readFileSync(join(migrationsDirectory, adminOverrideMigrationName), "utf8");
const notificationRepairMigrationName = "202608100023_repair_notification_centre_and_outbox.sql";
const notificationRepairMigration = readFileSync(join(migrationsDirectory, notificationRepairMigrationName), "utf8");
const balanceVisibilityMigrationName = "202608100024_family_wide_balance_visibility.sql";
const balanceVisibilityMigration = readFileSync(join(migrationsDirectory, balanceVisibilityMigrationName), "utf8");

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
  assert.equal(migrationFiles.at(-1), balanceVisibilityMigrationName);

  for (const table of applicationTables) {
    assert.match(
      authorizationMigration,
      new RegExp(`alter table public\\.${table} enable row level security;`, "i"),
      `${table} must have an explicit RLS enable statement`,
    );
  }

  // What 020 introduces: one server-only table, and four AFTER triggers on
  // financial tables that may only ever insert into it.
  assert.match(notificationOutboxMigration, /alter table public\.notification_outbox enable row level security;/);
  assert.match(notificationOutboxMigration, /revoke all privileges on table public\.notification_outbox from public, anon, authenticated;/);
  assert.doesNotMatch(notificationOutboxMigration, /grant [a-z, ]+ on table public\./);

  for (const table of applicationTables) {
    // The triggers attach to purchases, gift_ideas and settlements, which is
    // allowed; rewriting any of those rows is not.
    assert.doesNotMatch(
      notificationOutboxMigration.replace(/--[^\n]*/g, ""),
      new RegExp(`(update|delete from|insert into)\\s+public\\.${table}\\b`, "i"),
      `${table} must not be written by the outbox migration`,
    );
  }
  // Every trigger is AFTER, returns null, and swallows its own errors, so a
  // notification problem cannot roll back a purchase or a payment.
  assert.equal((notificationOutboxMigration.match(/^create trigger /gm) ?? []).length, 4);
  assert.doesNotMatch(notificationOutboxMigration, /^\s*before (insert|update|delete) on/im);
  assert.match(notificationOutboxMigration, /exception\s*\n\s*when others then/);
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

test("the Notification Centre is personal and cannot be written from a browser", () => {
  assert.match(notificationCentreMigration, /alter table public\.notifications enable row level security;/);
  assert.match(
    notificationCentreMigration,
    /revoke all privileges on table public\.notifications from public, anon, authenticated;/,
  );

  // Read and mark-read only. No INSERT means a member cannot plant a
  // notification in anyone's inbox; no DELETE means history is not rewritable.
  assert.match(notificationCentreMigration, /grant select, update on table public\.notifications to authenticated;/);
  assert.doesNotMatch(
    notificationCentreMigration,
    /create policy[^;]*on public\.notifications\s+for (insert|delete)/i,
  );

  // Every policy is scoped to the caller's own membership, and there is no
  // Global Admin exception anywhere: an admin reading the family's inboxes
  // would be a privacy regression, not a feature.
  const policies = notificationCentreMigration.match(/create policy[\s\S]*?on public\.notifications[\s\S]*?;/g) ?? [];
  assert.ok(policies.length >= 2);
  for (const policy of policies) {
    assert.match(policy, /app_member_id = public\.current_app_member_id\(\)/);
  }
  assert.doesNotMatch(notificationCentreMigration, /is_app_admin/);
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

// ---------------------------------------------------------------------------
// Two-sided payment confirmation (migration 021)
// ---------------------------------------------------------------------------
// The rules below cannot be checked by running a function: they are properties
// of the migration itself. A policy loosened, a lock removed or an admin
// bypass added would leave every unit test passing and the money unguarded.

test("only the person a payment was sent to can review it", () => {
  const review = paymentConfirmationsMigration.match(
    /create or replace function public\.review_payment[\s\S]*?\n\$\$;/,
  )[0];

  // The caller's contributor for THIS Christmas must be the payee. Not the
  // payer, so nobody confirms their own payment, and not an unrelated member.
  assert.match(
    review,
    /current_contributor_id := public\.current_app_contributor_id\(existing_settlement\.christmas_event_id\);[\s\S]*?current_contributor_id <> existing_settlement\.payee_contributor_id[\s\S]*?raise exception 'Only the person this payment was sent to can review it'/,
  );
  assert.match(review, /using errcode = '42501'/);

  // Deliberately no admin bypass: an admin may void a payment, which gives
  // money back to a balance, but may not assert that money arrived.
  assert.doesNotMatch(
    review,
    /is_app_admin\(\)/,
    "Global Admin must not be able to confirm somebody else's payment",
  );
});

test("a confirmation is bounded by the claim, in the function and in the table", () => {
  const review = paymentConfirmationsMigration.match(
    /create or replace function public\.review_payment[\s\S]*?\n\$\$;/,
  )[0];

  assert.match(review, /remaining_pennies := existing_settlement\.amount_pennies - existing_settlement\.confirmed_amount_pennies;/);
  assert.match(review, /p_amount_pennies > remaining_pennies[\s\S]*?raise exception 'You cannot confirm more than the amount still unconfirmed'/);
  assert.match(review, /p_amount_pennies <= 0[\s\S]*?raise exception 'Enter how much you received'/);

  // The backstop under the function: no caller of any kind can leave a row
  // claiming less than has been confirmed against it.
  assert.match(
    paymentConfirmationsMigration,
    /add constraint settlements_confirmed_within_claim_check\s*check \(\s*confirmed_amount_pennies >= 0\s*and confirmed_amount_pennies <= amount_pennies\s*\)/,
  );
});

test("two devices cannot confirm the same claim twice", () => {
  const review = paymentConfirmationsMigration.match(
    /create or replace function public\.review_payment[\s\S]*?\n\$\$;/,
  )[0];

  // The row is locked BEFORE its confirmed total is read, so the second
  // transaction waits and then sees the first one's total.
  assert.match(review, /select \* into existing_settlement\s*from public\.settlements\s*where id = p_settlement_id\s*for update;/);
  assert.ok(
    review.indexOf("for update;") < review.indexOf("remaining_pennies :="),
    "the lock must be taken before the remaining amount is calculated",
  );
  // And the pair is serialized as well, so a review and a new claim cannot
  // size themselves against the same headroom. The pair lock is taken FIRST,
  // in the same order `record_settlement` takes it, so the two can never
  // deadlock against each other.
  assert.match(review, /pg_catalog\.pg_advisory_xact_lock\(/);
  assert.ok(
    review.indexOf("pg_advisory_xact_lock") < review.indexOf("for update;"),
    "the pair lock must be taken before the row lock",
  );
});

test("a rejection must carry a reason, and cannot erase what already arrived", () => {
  const review = paymentConfirmationsMigration.match(
    /create or replace function public\.review_payment[\s\S]*?\n\$\$;/,
  )[0];

  assert.match(review, /clean_reason is null[\s\S]*?raise exception 'Say why the payment has not arrived'/);
  // A rejection sets `rejected_at` and closes the remainder. It must never
  // reduce `confirmed_amount_pennies`, which would rewrite an acknowledgement.
  const rejectBranch = review.slice(review.indexOf("else"), review.indexOf("insert into public.payment_receipts"));
  assert.doesNotMatch(rejectBranch, /confirmed_amount_pennies\s*=/);
  assert.match(rejectBranch, /rejected_at = now\(\)/);

  assert.match(
    paymentConfirmationsMigration,
    /add constraint settlements_rejection_recorded_check[\s\S]*?rejected_at is not null and rejection_reason is not null/,
  );
});

test("confirmation history is append-only and readable only by the two people involved", () => {
  assert.match(paymentConfirmationsMigration, /alter table public\.payment_receipts enable row level security;/);
  assert.match(paymentConfirmationsMigration, /revoke all privileges on table public\.payment_receipts from public, anon, authenticated;/);
  assert.match(paymentConfirmationsMigration, /grant select on table public\.payment_receipts to authenticated;/);

  // No INSERT, UPDATE or DELETE policy exists at all, so the only writer is the
  // SECURITY DEFINER function above.
  assert.doesNotMatch(
    paymentConfirmationsMigration,
    /create policy[^;]*on public\.payment_receipts\s*\n?\s*for (insert|update|delete|all)/i,
  );
  const selectPolicy = paymentConfirmationsMigration.match(
    /create policy "members read relevant payment receipts"[\s\S]*?;/,
  )[0];
  assert.match(selectPolicy, /payer_contributor_id = public\.current_app_contributor_id\(christmas_event_id\)/);
  assert.match(selectPolicy, /payee_contributor_id = public\.current_app_contributor_id\(christmas_event_id\)/);

  // Even a client with elevated rights cannot edit or delete a confirmation.
  assert.match(
    paymentConfirmationsMigration,
    /create trigger payment_receipts_are_append_only\s*before update or delete on public\.payment_receipts/,
  );
  assert.match(
    paymentConfirmationsMigration,
    /function public\.payment_receipts_are_append_only\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/,
  );
});

test("recording a payment still cannot be done by an unrelated member", () => {
  const record = paymentConfirmationsMigration.match(
    /create or replace function public\.record_settlement[\s\S]*?\n\$\$;/,
  )[0];

  assert.match(
    record,
    /not public\.is_app_admin\(\)\s*and current_contributor_id <> p_payee_contributor_id\s*and current_contributor_id <> p_payer_contributor_id\s*then\s*raise exception 'Only the payer, the receiver or Global Admin can record this payment'/,
  );
  // Only the receiver's own record confirms itself. Everybody else's is a claim.
  assert.match(record, /caller_is_receiver := current_contributor_id = p_payee_contributor_id;/);
  assert.match(record, /case when caller_is_receiver then p_amount_pennies else 0 end/);
  // Owed is netted from CONFIRMED money, exactly as the TypeScript engine does.
  assert.match(record, /select coalesce\(sum\(confirmed_amount_pennies\), 0\)\s*into forward_confirmed/);
  assert.match(record, /claimable_pennies := outstanding_pennies - forward_awaiting;/);
});

test("a payer may withdraw only an untouched claim of their own", () => {
  const voidFunction = paymentConfirmationsMigration.match(
    /create or replace function public\.void_settlement[\s\S]*?\n\$\$;/,
  )[0];

  assert.match(voidFunction, /if not public\.is_app_admin\(\) then/);
  assert.match(
    voidFunction,
    /current_contributor_id <> existing_settlement\.payer_contributor_id\s*or existing_settlement\.confirmed_amount_pennies > 0\s*or existing_settlement\.rejected_at is not null\s*then\s*raise exception 'Only Global Admin can void a payment'/,
  );
  assert.match(voidFunction, /for update;/);
});

test("every new function is revoked from anonymous callers and granted only to members", () => {
  for (const signature of [
    "record_settlement\\(uuid, uuid, uuid, integer, date, text\\)",
    "void_settlement\\(uuid\\)",
    "review_payment\\(uuid, text, integer, text\\)",
  ]) {
    assert.match(
      paymentConfirmationsMigration,
      new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated;`, "i"),
    );
    assert.match(
      paymentConfirmationsMigration,
      new RegExp(`grant execute on function public\\.${signature} to authenticated;`, "i"),
    );
  }
  // The trigger helpers are reachable by nobody.
  for (const helper of ["payment_receipts_are_append_only\\(\\)", "enqueue_payment_review_notification\\(\\)"]) {
    assert.match(
      paymentConfirmationsMigration,
      new RegExp(`revoke all on function public\\.${helper} from public, anon, authenticated;`, "i"),
    );
    assert.doesNotMatch(
      paymentConfirmationsMigration,
      new RegExp(`grant execute on function public\\.${helper}`, "i"),
    );
  }
  // Every SECURITY DEFINER function added here pins its search path.
  const definers = paymentConfirmationsMigration.match(/security definer/g) ?? [];
  const pinned = paymentConfirmationsMigration.match(/security definer\s*\nset search_path = ''/g) ?? [];
  assert.equal(definers.length, pinned.length, "a definer without a fixed search_path is a privilege escalation");
});

test("the migration changes payment state and nothing else about Christmas", () => {
  const statements = paymentConfirmationsMigration.replace(/--[^\n]*/g, "");

  // Budgets, plans, purchases and allocations are not touched at all.
  for (const table of ["purchases", "purchase_allocations", "recipient_contributions", "christmas_recipients", "gift_ideas", "contributors", "people"]) {
    assert.doesNotMatch(statements, new RegExp(`alter table public\\.${table}\\b`, "i"), `${table} must not be altered`);
    assert.doesNotMatch(statements, new RegExp(`(update|delete from|insert into)\\s+public\\.${table}\\b`, "i"), `${table} must not be written`);
  }
  // No financial history is ever deleted.
  assert.doesNotMatch(statements, /delete from public\.(settlements|payment_receipts)/i);
  assert.doesNotMatch(statements, /drop table/i);
  // Direct mutation of settlements stays impossible from a browser session.
  assert.doesNotMatch(statements, /grant [a-z, ]*(insert|update|delete)[a-z, ]* on table public\.settlements/i);
});

test("existing settled payments migrate as confirmed in full, once", () => {
  // The one-shot guard: the backfill runs only when the column did not exist,
  // so re-applying the file cannot confirm a payment that is legitimately
  // pending.
  assert.match(
    paymentConfirmationsMigration,
    /is_first_application boolean := not exists \([\s\S]*?attname = 'confirmed_amount_pennies'/,
  );
  assert.match(
    paymentConfirmationsMigration,
    /if is_first_application then[\s\S]*?update public\.settlements\s*set\s*confirmed_amount_pennies = amount_pennies/,
  );
  // And each of them gets a receipt explaining where that confirmation came
  // from, rather than a status asserted out of nowhere.
  assert.match(
    paymentConfirmationsMigration,
    /insert into public\.payment_receipts \([\s\S]*?'migration',/,
  );
  assert.match(
    paymentConfirmationsMigration,
    /where settlement\.confirmed_amount_pennies = settlement\.amount_pennies\s*and not exists \(/,
  );
});

test("a review is queued for notification inside its own transaction", () => {
  assert.match(
    paymentConfirmationsMigration,
    /create trigger enqueue_payment_review_notification\s*after insert on public\.payment_receipts/,
  );
  // AFTER, returns null, and only for a real review: a migrated row must not
  // notify anybody about history, and an auto receipt is already covered by the
  // payment's own notification.
  assert.match(paymentConfirmationsMigration, /if new\.source = 'review' then/);
  assert.doesNotMatch(paymentConfirmationsMigration, /^\s*before (insert) on public\.payment_receipts/im);

  // And it swallows its own failures, so a notification problem -- including
  // the notification tables not existing at all -- can never roll back a
  // confirmation. Same rule migration 020 applies to its own triggers.
  const trigger = paymentConfirmationsMigration.match(
    /create or replace function public\.enqueue_payment_review_notification[\s\S]*?\n\$\$;/,
  )[0];
  assert.match(trigger, /exception\s*\n\s*when others then/);
});

test("payment confirmation installs on a database that has no notification tables", () => {
  // The failure this test exists for: migration 021 refused to apply because
  // `notification_outbox` (migration 020) was not there, so a financial feature
  // was blocked by an alerting table. Both notification tables are optional and
  // widened only when present.
  const section = paymentConfirmationsMigration.slice(
    paymentConfirmationsMigration.indexOf("-- 6. Notifications"),
    paymentConfirmationsMigration.indexOf("create or replace function public.enqueue_payment_review_notification"),
  );

  for (const table of ["notification_outbox", "notifications"]) {
    assert.match(
      section,
      new RegExp(`if pg_catalog\\.to_regclass\\('public\\.${table}'\\) is not null then`),
      `${table} must be optional`,
    );
    // Skipping one is announced, so a half-applied schema is visible rather
    // than silently degraded.
    assert.match(section, new RegExp(`raise notice '${table} does not exist`));
  }

  // Every bare regclass cast in the whole file must be to a table this
  // migration can rely on. `settlements` is the only one.
  const casts = [...paymentConfirmationsMigration.matchAll(/'public\.(\w+)'::regclass/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(casts)].sort(), ["notification_outbox", "notifications", "settlements"]);
  for (const cast of ["notification_outbox", "notifications"]) {
    assert.ok(
      section.indexOf(`to_regclass('public.${cast}')`) < section.indexOf(`'public.${cast}'::regclass`),
      `${cast} must be guarded before it is cast`,
    );
  }
});

test("a confirmation reaches every open tab through the subscription that already exists", () => {
  // Realtime requirement, stated as the two facts it depends on.
  //
  // 1. Every review writes its settlement row in the same transaction as the
  //    receipt, so the `settlements` stream carries the change.
  const review = paymentConfirmationsMigration.match(
    /create or replace function public\.review_payment[\s\S]*?\n\$\$;/,
  )[0];
  assert.match(review, /update public\.settlements\s*set\s*confirmed_amount_pennies/);
  assert.match(review, /update public\.settlements\s*set\s*rejected_at = now\(\)/);
  assert.match(review, /insert into public\.payment_receipts/);

  // 2. `settlements` is already published, and no second publication entry is
  //    added -- `payment_receipts` would deliver a duplicate event for the same
  //    change and make every tab refetch twice.
  assert.match(realtimeMigration, /'settlements'/);
  assert.doesNotMatch(paymentConfirmationsMigration, /alter publication supabase_realtime add table/);

  // And the screens subscribe once each, to the tables they read.
  const owedPage = readFileSync(join(root, "src", "app", "owed", "page.tsx"), "utf8");
  const paymentLogPage = readFileSync(join(root, "src", "app", "payment-log", "page.tsx"), "utf8");
  for (const page of [owedPage, paymentLogPage]) {
    assert.equal((page.match(/useRealtimeRefresh\(/g) ?? []).length, 1, "one subscription per screen");
    assert.match(page, /"settlements"/);
  }
});

// ---------------------------------------------------------------------------
// Global Admin uses the normal payment flow (migration 022)
// ---------------------------------------------------------------------------

test("the ordinary payment function does not know what an admin is", () => {
  const record = adminOverrideMigration.match(
    /create or replace function public\.record_settlement[\s\S]*?\n\$\$;/,
  )[0];

  // The rule, in full: two people, decided by their relationship to the money.
  assert.match(
    record,
    /if current_contributor_id <> p_payee_contributor_id\s*and current_contributor_id <> p_payer_contributor_id\s*then\s*raise exception 'Only the payer or the person being paid can record this payment'/,
  );
  // The whole point of this migration: no role check anywhere in the ordinary
  // path, so an admin walks exactly the member's path.
  assert.doesNotMatch(record, /is_app_admin/, "admin must not appear in the ordinary payment flow");

  // Auto-confirmation is decided by being the receiver, and by nothing else.
  assert.match(record, /caller_is_receiver := current_contributor_id = p_payee_contributor_id;/);
  assert.match(record, /case when caller_is_receiver then p_amount_pennies else 0 end/);
  assert.doesNotMatch(
    record,
    /is_app_admin\(\)[\s\S]*?confirmed_amount_pennies/,
    "no path may auto-confirm because of a role",
  );
});

test("an admin recording their own outgoing payment gets a pending claim", () => {
  const record = adminOverrideMigration.match(
    /create or replace function public\.record_settlement[\s\S]*?\n\$\$;/,
  )[0];

  // The insert has exactly one condition on every confirmation column, and it
  // is `caller_is_receiver`. An admin who is the payer fails it like anybody
  // else, so their payment starts at zero confirmed and Owed does not move.
  const insert = record.slice(record.indexOf("insert into public.settlements"), record.indexOf("returning * into saved_settlement"));
  const conditions = insert.match(/case when (\w+) then/g) ?? [];
  assert.equal(conditions.length, 4, "confirmed amount, confirmed_at, last_reviewed_at, reviewed_by");
  assert.ok(conditions.every((condition) => condition === "case when caller_is_receiver then"));

  // And the auto receipt is written under the same single condition.
  assert.match(record, /if caller_is_receiver then\s*insert into public\.payment_receipts/);
});

test("the admin override is a separate function, admin-only, and refuses self-dealing", () => {
  const override = adminOverrideMigration.match(
    /create or replace function public\.admin_record_confirmed_payment[\s\S]*?\n\$\$;/,
  )[0];

  // Admin-gated at the top, before anything is read or written.
  assert.match(
    override,
    /begin\s*if not public\.is_app_admin\(\) then\s*raise exception 'Only Global Admin can record a confirmed payment on behalf of others'\s*using errcode = '42501';/,
  );
  // An admin cannot confirm a payment they themselves made -- the exact bypass
  // two-sided confirmation exists to prevent.
  assert.match(
    override,
    /current_contributor_id = p_payer_contributor_id\s*then\s*raise exception 'You cannot confirm your own payment/,
  );
  // A reason is mandatory, in the function and again in the table.
  assert.match(override, /clean_reason is null\s*then\s*raise exception 'Give a reason for recording this payment as already confirmed'/);
  assert.match(
    adminOverrideMigration,
    /add constraint payment_receipts_override_reason_check\s*check \(source <> 'admin_override' or reason is not null\)/,
  );
});

test("a forced payment is confirmed immediately and labelled as an override", () => {
  const override = adminOverrideMigration.match(
    /create or replace function public\.admin_record_confirmed_payment[\s\S]*?\n\$\$;/,
  )[0];

  // Confirmed in full at creation, so Owed moves straight away.
  const insert = override.slice(override.indexOf("insert into public.settlements"), override.indexOf("returning * into saved_settlement"));
  assert.match(insert, /p_amount_pennies,\s*now\(\),\s*now\(\),\s*current_member_id/);
  assert.doesNotMatch(insert, /case when/, "an override is never conditional");

  // And the receipt says what it is, who did it, and why.
  const receipt = override.slice(override.indexOf("insert into public.payment_receipts"));
  assert.match(receipt, /'admin_override'/);
  assert.match(receipt, /clean_reason/);
  assert.match(receipt, /current_member_id/);
  assert.match(
    adminOverrideMigration,
    /add constraint payment_receipts_source_check\s*check \(source in \('review', 'auto_receipt', 'migration', 'admin_override'\)\)/,
  );
  // It still cannot invent money: the same ceiling as the ordinary path.
  assert.match(override, /p_amount_pennies > claimable_pennies[\s\S]*?raise exception 'Payment exceeds the amount still outstanding and unclaimed'/);
});

test("the override is reachable only through its own function, never through the ordinary one", () => {
  for (const signature of [
    "record_settlement\\(uuid, uuid, uuid, integer, date, text\\)",
    "admin_record_confirmed_payment\\(uuid, uuid, uuid, integer, date, text\\)",
  ]) {
    assert.match(
      adminOverrideMigration,
      new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated;`, "i"),
    );
    assert.match(
      adminOverrideMigration,
      new RegExp(`grant execute on function public\\.${signature} to authenticated;`, "i"),
    );
  }
  // A normal member calling the override is refused by the function, not by a
  // hidden button: the check is the first statement in the body.
  const override = adminOverrideMigration.match(
    /create or replace function public\.admin_record_confirmed_payment[\s\S]*?\n\$\$;/,
  )[0];
  assert.ok(
    override.indexOf("is_app_admin()") < override.indexOf("insert into"),
    "authorization must precede any write",
  );
  assert.match(override, /security definer\s*\nset search_path = ''/);

  // The browser cannot reach the table directly either -- unchanged from 021,
  // and re-asserted here because this migration is the one that adds a second
  // way to write a settlement.
  assert.doesNotMatch(adminOverrideMigration, /grant [a-z, ]*(insert|update|delete)[a-z, ]* on table public\./i);
});

test("the admin override changes nothing about the confirmation state model", () => {
  const statements = adminOverrideMigration.replace(/--[^\n]*/g, "");

  // 021's review path, status column, receipts table and RLS are untouched.
  assert.doesNotMatch(statements, /create or replace function public\.review_payment/);
  assert.doesNotMatch(statements, /create or replace function public\.void_settlement/);
  assert.doesNotMatch(statements, /drop policy/i);
  assert.doesNotMatch(statements, /create policy/i);
  assert.doesNotMatch(statements, /alter table public\.settlements/i);
  assert.doesNotMatch(statements, /generated always as/i);
  assert.doesNotMatch(statements, /drop table|delete from/i);

  // It runs AFTER 021 and builds on it rather than repeating it: no second
  // receipts table, no second status column, and no second backfill. 021 wrote
  // one migration receipt per payment that already existed; doing that again on
  // the applied database would duplicate every one of them.
  assert.doesNotMatch(statements, /create table/i);
  assert.doesNotMatch(statements, /add column/i);
  const receiptInserts = statements.split(/insert into public\.payment_receipts/i).slice(1);
  assert.equal(receiptInserts.length, 2, "the ordinary auto-receipt and the override receipt, and nothing else");
  for (const chunk of receiptInserts) {
    const statement = chunk.slice(0, chunk.indexOf(";"));
    assert.match(statement, /\)\s*values\s*\(/i, "a receipt here is one literal row");
    assert.doesNotMatch(statement, /select/i, "never a SELECT over existing settlements");
  }

  // And no Christmas data is read or written.
  for (const table of ["recipient_contributions", "christmas_recipients", "gift_ideas", "people"]) {
    assert.doesNotMatch(statements, new RegExp(`(update|delete from|insert into)\\s+public\\.${table}\\b`, "i"));
  }
});

test("the Owed screen offers the ordinary payment action to the two people only", () => {
  const owedPage = readFileSync(join(root, "src", "app", "owed", "page.tsx"), "utf8");

  // The record button is gated on the reader's relationship to the balance,
  // with no admin term -- so an admin sees exactly what a member sees.
  assert.match(owedPage, /\{\(iOweThis \|\| iAmOwedThis\)/);
  assert.doesNotMatch(owedPage, /iOweThis \|\| iAmOwedThis \|\| isAdmin/);
  const breakdown = owedPage.slice(owedPage.indexOf("const canRecord ="), owedPage.indexOf("const voidPayment"));
  assert.doesNotMatch(breakdown, /isAdmin/, "the breakdown's record button must not be widened for admins");

  // The override lives in its own section, behind its own component, and calls
  // its own RPC. It is not adjacent to the ordinary button.
  assert.match(owedPage, /function AdminTools\(/);
  assert.match(owedPage, /Admin tools/);
  assert.match(owedPage, /\{data\.isAdmin && <AdminTools/);
  assert.match(owedPage, /rpc\("admin_record_confirmed_payment"/);
  // Rendered last, below the balances and below the reader's own payments, so
  // it is nowhere near the button people press every day.
  assert.ok(
    owedPage.indexOf("<AdminTools") > owedPage.indexOf("<BalanceSection"),
    "admin tools must sit below the ordinary payment actions",
  );
  assert.ok(
    owedPage.indexOf("<AdminTools") > owedPage.indexOf("<MyPaymentsSection"),
    "admin tools must sit below the reader's own payments",
  );

  // The Payment Log never lets an override pass for an ordinary confirmation.
  const paymentLogPage = readFileSync(join(root, "src", "app", "payment-log", "page.tsx"), "utf8");
  assert.match(paymentLogPage, /isAdminConfirmedPayment\(record\) && <Badge tone="gold">Admin confirmed<\/Badge>/);
  assert.match(paymentLogPage, /adminOverrideReason\(record\)/);
});

// ---------------------------------------------------------------------------
// The final intended notification schema (migration 023)
// ---------------------------------------------------------------------------
// These tests exist because of a specific production failure. Migrations 019
// and 020 were never applied to the hosted database, and every test in this
// file passed anyway: each one asserted the TEXT of a migration file, and the
// files were perfect. Nothing asserted what the schema had to end up being once
// all of them had run.
//
// So these are written the other way round. They describe the end state the
// application requires, and the catch-up migration has to satisfy it.

test("the catch-up migration creates every notification object production was missing", () => {
  // The three objects the audit proved absent: PGRST205 for both tables and
  // PGRST202 for the function.
  assert.match(notificationRepairMigration, /create table if not exists public\.notifications \(/);
  assert.match(notificationRepairMigration, /create table if not exists public\.notification_outbox \(/);
  assert.match(
    notificationRepairMigration,
    /create or replace function public\.enqueue_notification_event\(\s*p_kind text,\s*p_subject_id uuid,\s*p_fingerprint text,\s*p_actor_app_member_id uuid\s*\)/,
  );

  // 019's columns on 018's ledger. Without these the retry accounting silently
  // does nothing, because the dispatcher selects columns that do not exist.
  for (const column of ["delivered_count", "attempt_count", "last_attempt_at"]) {
    assert.match(
      notificationRepairMigration,
      new RegExp(`add column if not exists ${column}`),
      `${column} must be added to notification_events`,
    );
  }

  // 020's four enqueue triggers, and 020's idempotence key for the in-app rows.
  for (const trigger of [
    "enqueue_purchase_notification",
    "enqueue_gift_status_notification",
    "enqueue_gift_idea_notification",
    "enqueue_payment_notification",
  ]) {
    assert.match(notificationRepairMigration, new RegExp(`create trigger ${trigger}`), trigger);
  }
  assert.match(notificationRepairMigration, /create unique index if not exists notifications_event_recipient_key/);
});

test("every notification kind the app can dispatch is accepted by all three CHECK constraints", () => {
  // Derived from the application, not hand-listed. `payment_review` was added
  // to this union and to 021, but 021's widening block ran against tables that
  // did not exist and took its `raise notice` branch -- and nothing ever
  // widened `notification_events.kind` at all. A kind the app can send that a
  // constraint rejects is exactly the bug that shipped, so the source of truth
  // for this test is the union itself.
  const notifyFamily = readFileSync(join(root, "src", "app", "components", "notify-family.ts"), "utf8");
  const union = notifyFamily.match(/export type NotifiableEvent =([^;]+);/);
  assert.ok(union, "NotifiableEvent union must be readable from notify-family.ts");
  const kinds = [...union[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(kinds.includes("payment_review"), "the union must still carry the kind that caused the outage");
  assert.ok(kinds.length >= 5, "expected at least five dispatchable kinds");

  const constraints = {
    notification_events_kind_check: /add constraint notification_events_kind_check\s*check \(kind in \(([^)]*)\)\)/,
    notification_outbox_kind_check: /add constraint notification_outbox_kind_check\s*check \(kind in \(([^)]*)\)\)/,
    notifications_event_kind_check: /add constraint notifications_event_kind_check\s*check \(event_kind is null or event_kind in \(([\s\S]*?)\)\)/,
  };

  for (const [name, pattern] of Object.entries(constraints)) {
    const found = notificationRepairMigration.match(pattern);
    assert.ok(found, `${name} must be declared in the catch-up migration`);
    for (const kind of kinds) {
      assert.match(found[1], new RegExp(`'${kind}'`), `${name} must accept '${kind}'`);
    }
  }

  // And the tables are CREATED with the wide list too, not narrowed first and
  // widened after -- so a database that stops half way is still correct.
  assert.match(
    notificationRepairMigration,
    /create table if not exists public\.notification_outbox[\s\S]*?check \(kind in \([^)]*'payment_review'\)\)/,
  );
  assert.match(
    notificationRepairMigration,
    /create table if not exists public\.notifications[\s\S]*?event_kind text check \(event_kind in \([\s\S]*?'payment_review'\s*\)\)/,
  );
});

test("the catch-up migration refuses to finish quietly if it did not take", () => {
  // The whole reason it exists is that a migration once did less than it looked
  // like it did and nothing noticed for weeks.
  const guard = notificationRepairMigration.slice(notificationRepairMigration.indexOf("8. Assert the end state"));
  assert.match(guard, /raise exception 'Notification catch-up did not complete\. Missing: %'/);
  for (const required of [
    "table notifications",
    "table notification_outbox",
    "function enqueue_notification_event",
    "row level security on notifications",
    "row level security on notification_outbox",
  ]) {
    assert.ok(guard.includes(required), `the end-state assertion must check for: ${required}`);
  }
  // It also re-checks each kind against each constraint at apply time.
  assert.match(guard, /kind_target text\[\] := array\['purchase', 'payment', 'gift_idea', 'gift_status', 'payment_review'\]/);
});

test("notification centre RLS keeps every inbox private, including from Global Admin", () => {
  assert.match(notificationRepairMigration, /alter table public\.notifications enable row level security;/);
  assert.match(
    notificationRepairMigration,
    /create policy "members read their own notifications"[\s\S]*?for select[\s\S]*?using \(app_member_id = public\.current_app_member_id\(\)\)/,
  );
  // `with check` as well as `using`, or marking read could move a row onto
  // somebody else's membership.
  assert.match(
    notificationRepairMigration,
    /create policy "members update their own notifications"[\s\S]*?for update[\s\S]*?using \(app_member_id = public\.current_app_member_id\(\)\)\s*with check \(app_member_id = public\.current_app_member_id\(\)\)/,
  );

  // A member may read and mark read. They may not create a notification in
  // anybody's inbox, and may not delete their own history.
  assert.match(notificationRepairMigration, /revoke all privileges on table public\.notifications from public, anon, authenticated;/);
  assert.match(notificationRepairMigration, /grant select, update on table public\.notifications to authenticated;/);
  assert.doesNotMatch(
    notificationRepairMigration,
    /grant[^;]*(?:insert|delete)[^;]*on table public\.notifications/i,
    "a member must never be able to write or erase notifications",
  );

  // Deliberately no admin policy: an admin reading the family's inboxes is a
  // privacy regression, not a feature.
  // `.slice(1)` because split() returns the file's preamble as element 0, and
  // that preamble contains the `drop policy ... on public.notifications` lines.
  const notificationPolicies = notificationRepairMigration
    .split("create policy")
    .slice(1)
    .filter((chunk) => chunk.includes("on public.notifications"));
  assert.equal(notificationPolicies.length, 2, "exactly two policies: read own, update own");
  for (const policy of notificationPolicies) {
    assert.doesNotMatch(policy, /is_app_admin/, "no admin bypass may exist on the Notification Centre");
  }

  // And the read state is the only thing an update may change.
  assert.match(
    notificationRepairMigration,
    /create or replace function public\.protect_notification_content[\s\S]*?raise exception 'Only the read state of a notification can be changed'/,
  );
  assert.match(notificationRepairMigration, /create trigger protect_notification_content\s*before update on public\.notifications/);
});

test("the outbox is server-controlled and never reaches a browser", () => {
  assert.match(notificationRepairMigration, /alter table public\.notification_outbox enable row level security;/);
  assert.match(notificationRepairMigration, /revoke all privileges on table public\.notification_outbox from public, anon, authenticated;/);
  // No grant of any kind, and no policy: with RLS on and no policy, a browser
  // session reaches nothing even if a grant were added by mistake later.
  assert.doesNotMatch(notificationRepairMigration, /grant [a-z, ]+ on table public\.notification_outbox/i);
  assert.doesNotMatch(
    notificationRepairMigration,
    /create policy[^;]*on public\.notification_outbox/i,
    "the outbox must have no policies at all",
  );

  // Realtime publishes the bell's table and must never publish the outbox.
  assert.match(notificationRepairMigration, /alter publication supabase_realtime add table public\.notifications;/);
  assert.doesNotMatch(notificationRepairMigration, /add table public\.notification_outbox/);

  // Every enqueue helper is revoked from callers: only the triggers use them.
  for (const helper of [
    "enqueue_notification_event\\(text, uuid, text, uuid\\)",
    "enqueue_purchase_notification\\(\\)",
    "enqueue_gift_status_notification\\(\\)",
    "enqueue_gift_idea_notification\\(\\)",
    "enqueue_payment_notification\\(\\)",
    "protect_notification_content\\(\\)",
  ]) {
    assert.match(
      notificationRepairMigration,
      // The longer signatures wrap onto a second line in the migration.
      new RegExp(`revoke all on function public\\.${helper}\\s*from public, anon, authenticated`, "i"),
      helper,
    );
    assert.doesNotMatch(
      notificationRepairMigration,
      new RegExp(`grant execute on function public\\.${helper}`, "i"),
      `${helper} must not be callable directly`,
    );
  }
});

test("a notification failure still cannot roll back a financial write", () => {
  // The single most important property in the whole notification stack: the
  // enqueue helper swallows everything, so a queue problem can never abort the
  // transaction that saved a purchase or a payment.
  const enqueue = notificationRepairMigration.match(
    /create or replace function public\.enqueue_notification_event[\s\S]*?\n\$\$;/,
  )[0];
  assert.match(enqueue, /exception\s*\n\s*when others then/);
  assert.match(enqueue, /on conflict \(kind, subject_id, fingerprint\) do nothing/);
  assert.doesNotMatch(enqueue, /raise exception/, "it must never propagate");

  // Every trigger is AFTER, so it cannot pre-empt the write it observes.
  const triggerStatements = notificationRepairMigration.match(/^create trigger [\s\S]*?;$/gm) ?? [];
  assert.ok(triggerStatements.length >= 5, "four enqueue triggers plus the content guard");
  for (const statement of triggerStatements) {
    if (statement.includes("protect_notification_content")) continue;
    assert.match(statement, /after (insert|update)/i, `must be an AFTER trigger: ${statement.slice(0, 60)}`);
  }

  // And nothing in this file writes to a financial table.
  const statements = notificationRepairMigration.replace(/--[^\n]*/g, "");
  for (const table of [
    "purchases", "purchase_allocations", "settlements", "payment_receipts",
    "recipient_contributions", "christmas_recipients", "contributors", "people",
  ]) {
    assert.doesNotMatch(
      statements,
      new RegExp(`(update|delete from|insert into)\\s+public\\.${table}\\b`, "i"),
      `${table} must not be written by the notification repair`,
    );
  }
  assert.doesNotMatch(statements, /drop table|truncate/i);
});

test("the catch-up migration leaves 021 and 022 alone and is safe to re-run", () => {
  const statements = notificationRepairMigration.replace(/--[^\n]*/g, "");

  // It must not redefine anything 021 or 022 owns.
  for (const owned of [
    "record_settlement",
    "review_payment",
    "void_settlement",
    "admin_record_confirmed_payment",
    "enqueue_payment_review_notification",
    "payment_receipts_are_append_only",
  ]) {
    assert.doesNotMatch(
      statements,
      new RegExp(`create or replace function public\\.${owned}`, "i"),
      `${owned} belongs to an already-applied migration and must not be redefined`,
    );
  }
  // 021's payment-review trigger is checked for, not rewritten.
  assert.match(notificationRepairMigration, /tgname = 'enqueue_payment_review_notification'/);
  assert.doesNotMatch(statements, /drop trigger if exists enqueue_payment_review_notification/);

  // Re-runnable on a database that already has 019 and 020, so applying every
  // migration in order on a fresh database reaches the same place.
  assert.match(statements, /create table if not exists public\.notifications/);
  assert.match(statements, /create table if not exists public\.notification_outbox/);
  assert.match(statements, /add column if not exists/);
  assert.equal((statements.match(/create index if not exists|create unique index if not exists/g) ?? []).length, 4);
  for (const policy of ["members read their own notifications", "members update their own notifications"]) {
    assert.match(statements, new RegExp(`drop policy if exists "${policy}" on public\\.notifications;`));
  }
  // Constraints are matched by definition, not by generated name.
  assert.match(statements, /pg_catalog\.pg_get_constraintdef\(oid\) ilike '%gift_status%'/);

  // Every SECURITY DEFINER function it adds pins its search path. Counted over
  // CODE only: the file also discusses `security definer` in prose, and a
  // comment is not a function.
  const code = notificationRepairMigration.replace(/--[^\n]*/g, "");
  const definers = (code.match(/security definer/g) ?? []).length;
  const pinned = (code.match(/security definer\s*\nset search_path = ''/g) ?? []).length;
  assert.equal(definers, 6, "the content guard, the enqueue helper, and four enqueue triggers");
  assert.equal(definers, pinned, "a definer without a fixed search_path is a privilege escalation");
});

// ---------------------------------------------------------------------------
// Contribution planning: who may change what
// ---------------------------------------------------------------------------
// The audit flagged `save_recipient_contributions` as requiring only membership
// rather than Global Admin. Reading the grants rather than the function body
// shows why that is not a hole: migration 012 revoked it from `authenticated`
// and never granted it back, so no browser session can call it at all.
//
// What members CAN do is the deliberate part, and these tests pin it.

test("both deprecated recipient RPCs are unreachable from any browser session", () => {
  for (const signature of [
    "save_recipient_contributions\\(uuid, jsonb\\)",
    "save_christmas_recipient\\(uuid, uuid, text, integer\\)",
  ]) {
    assert.match(
      atomicRecipientMigration,
      new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*?from public, anon, authenticated;`, "i"),
    );
  }
  // Revoked in 012 and never re-granted by anything after it. Scanning every
  // later migration is the assertion -- a future grant would revive a path that
  // bypasses the admin gate on recipient details.
  const laterMigrations = migrationFiles
    .filter((name) => name > atomicRecipientMigrationName)
    .map((name) => readFileSync(join(migrationsDirectory, name), "utf8"))
    .join("\n");
  for (const name of ["save_recipient_contributions", "save_christmas_recipient\\("]) {
    assert.doesNotMatch(
      laterMigrations,
      new RegExp(`grant execute on function public\\.${name}`, "i"),
      `${name} must stay revoked`,
    );
  }
});

test("members may plan together, but only Global Admin may change a budget or add a person", () => {
  const canonical = atomicRecipientMigration.match(
    /create or replace function public\.save_christmas_recipient_with_contributions[\s\S]*?\n\$\$;/,
  )[0];

  // Creating a recipient is admin-only.
  assert.match(
    canonical,
    /if p_christmas_recipient_id is null then\s*if not public\.is_app_admin\(\) then\s*raise exception 'Global Admin access required'/,
  );
  // Changing the NAME or the BUDGET of an existing recipient is admin-only.
  assert.match(
    canonical,
    /details_changed := trim\(p_name\) is distinct from existing_name\s*or p_budget_pennies is distinct from existing_budget_pennies;\s*if details_changed and not public\.is_app_admin\(\) then\s*raise exception 'Global Admin access required to change recipient details'/,
  );
  // Everything else -- redistributing the SAME budget between contributors --
  // is open to any active member. This is intended: planning is a family
  // activity. Asserted so a future change to it has to be deliberate.
  assert.match(canonical, /if not public\.is_active_app_member\(\) then\s*raise exception 'Active app membership required'/);
  // Archiving a person stays admin-only through its own function.
  assert.match(
    atomicRecipientMigration,
    /create or replace function public\.set_christmas_recipient_active[\s\S]*?is_app_admin\(\)/,
  );
});

test("changing a contribution plan can never rewrite historical purchase responsibility", () => {
  // The protection is structural: the planning writer touches exactly one
  // table, and purchase_allocations is not it. A purchase's split is a snapshot
  // taken when the purchase was saved, and only `save_purchase*` writes it.
  const canonical = atomicRecipientMigration.match(
    /create or replace function public\.save_christmas_recipient_with_contributions[\s\S]*?\n\$\$;/,
  )[0];
  assert.doesNotMatch(canonical, /purchase_allocations/i, "planning must never touch a purchase split");
  assert.doesNotMatch(canonical, /\bpublic\.purchases\b/i, "planning must never touch a purchase");
  assert.match(canonical, /insert into public\.recipient_contributions/i);

  // And the reverse: the purchase writers snapshot the split they are given and
  // never read a contribution plan at write time.
  //
  // `save_purchase_with_location` is a thin wrapper that validates the gift
  // location and delegates, so the snapshot itself lives in `save_purchase`
  // from migration 008. Both halves are checked.
  const purchaseWrapper = purchaseTrackingMigration.match(
    /create or replace function public\.save_purchase_with_location[\s\S]*?\n\$\$;/,
  )[0];
  assert.doesNotMatch(purchaseWrapper, /recipient_contributions/i, "a saved split must not be re-derived from today's plan");
  assert.match(purchaseWrapper, /saved_purchase := public\.save_purchase\(/, "the wrapper must delegate the split");

  const purchasesMigration = readFileSync(
    join(migrationsDirectory, "202608100008_add_purchases.sql"),
    "utf8",
  );
  const purchaseWriter = purchasesMigration.match(
    /create or replace function public\.save_purchase\([\s\S]*?\n\$\$;/,
  )[0];
  assert.doesNotMatch(purchaseWriter, /recipient_contributions/i, "the split comes from the caller, never from today's plan");
  assert.match(purchaseWriter, /insert into public\.purchase_allocations/i);
  // The invariant that makes a snapshot trustworthy: it must equal the price.
  assert.match(purchaseWriter, /allocation_total <> p_actual_price_pennies/);
});

test("the UI keeps recipient creation and removal behind Global Admin", () => {
  const peoplePage = readFileSync(join(root, "src", "app", "people", "page.tsx"), "utf8");
  const personModal = readFileSync(join(root, "src", "app", "people", "person-modal.tsx"), "utf8");
  // Adding a person.
  assert.match(peoplePage, /\{isAdmin && adding && <AddForm/);
  // Editing details and removing from Christmas.
  assert.match(personModal, /\{isAdmin && \(\s*<section[\s\S]*?Edit person[\s\S]*?Remove from Christmas/);
});

// ---------------------------------------------------------------------------
// Family-wide balance visibility (migration 024)
// ---------------------------------------------------------------------------
// Seeing a balance and changing one are separate permissions. These tests hold
// that line: the reads widen to every active member, and every write stays
// exactly where migrations 021 and 022 put it.

test("1-2. every active member can open both balance views", () => {
  const owedPage = readFileSync(join(root, "src", "app", "owed", "page.tsx"), "utf8");

  // The view switcher must not be behind an admin check any more.
  assert.match(owedPage, /ariaLabel="Balance view"/);
  const switcherAt = owedPage.indexOf('ariaLabel="Balance view"');
  const beforeSwitcher = owedPage.slice(Math.max(0, switcherAt - 700), switcherAt);
  assert.doesNotMatch(
    beforeSwitcher,
    /\{data\.isAdmin && \(\s*<div[^>]*>\s*<Segmented/,
    "the balance view switcher must not be admin-gated",
  );
  assert.doesNotMatch(beforeSwitcher, /\{data\.isAdmin && \($/m, "no admin wrapper immediately before the switcher");

  // Both options are still offered.
  assert.match(owedPage, /value: "mine", label: "My balances"/);
  assert.match(owedPage, /value: "all", label: "All balances"/);

  // "My balances" keeps its own summary and empty state.
  assert.match(owedPage, /label="You are owed"/);
  assert.match(owedPage, /label="You owe"/);
  assert.match(owedPage, /personalBalances\.length === 0\s*\?\s*<AllSettled \/>/);
});

test("3. a normal member can read the settlements behind another pair's balance", () => {
  // The reason the tab was restricted: this policy used to require the reader
  // to be one of the two people, so anybody else's balance came out as the
  // gross purchase total with the repayments silently filtered away.
  assert.match(
    balanceVisibilityMigration,
    /create policy "active members read family settlements"\s*on public\.settlements\s*for select\s*to authenticated\s*using \(public\.is_active_app_member\(\)\);/,
  );
  // The old, narrower policy is removed rather than left to sit alongside it.
  assert.match(
    balanceVisibilityMigration,
    /drop policy if exists "members read relevant settlements" on public\.settlements;/,
  );
  assert.doesNotMatch(
    balanceVisibilityMigration.match(/create policy "active members read family settlements"[\s\S]*?;/)[0],
    /is_app_admin|current_app_contributor_id/,
    "reading a family balance must not depend on role or on being a participant",
  );

  // Obligations were always readable by every active member -- that asymmetry
  // is what made the restricted settlements policy produce a wrong number.
  const purchasesMigration = readFileSync(
    join(migrationsDirectory, "202608100008_add_purchases.sql"),
    "utf8",
  );
  for (const table of ["purchases", "purchase allocations"]) {
    assert.match(
      purchasesMigration,
      new RegExp(`create policy "active members read ${table}"[\\s\\S]*?using \\(public\\.is_active_app_member\\(\\)\\)`),
      `${table} were already family-readable`,
    );
  }
});

test("4. Why this balance? is available for any pair, to any active member", () => {
  const owedPage = readFileSync(join(root, "src", "app", "owed", "page.tsx"), "utf8");

  // The explanation button is unconditional on every balance card.
  const card = owedPage.slice(owedPage.indexOf("function BalanceCard"), owedPage.indexOf("function Breakdown"));
  assert.match(card, /<Button variant="ghost" size="sm" onClick=\{onView\}>Why this balance\?<\/Button>/);
  assert.doesNotMatch(
    card.slice(card.indexOf("Why this balance?") - 200, card.indexOf("Why this balance?")),
    /isAdmin/,
    "the explanation must not be admin-gated",
  );

  // And the receipt history the panel renders is readable family-wide, or the
  // panel would show a confirmed figure with no account of the rest.
  assert.match(
    balanceVisibilityMigration,
    /create policy "active members read family payment receipts"\s*on public\.payment_receipts\s*for select\s*to authenticated\s*using \(public\.is_active_app_member\(\)\);/,
  );
  assert.match(
    balanceVisibilityMigration,
    /drop policy if exists "members read relevant payment receipts" on public\.payment_receipts;/,
  );
});

test("5. an unrelated member is shown the balance read-only, and refused by the database", () => {
  const owedPage = readFileSync(join(root, "src", "app", "owed", "page.tsx"), "utf8");

  // UI: no control at all for a non-participant -- not a disabled one.
  assert.match(
    owedPage,
    /\{\(iOweThis \|\| iAmOwedThis\)\s*\?\s*<Button variant="tonal"[^>]*>\{recordLabel\}<\/Button>\s*:\s*<span[^>]*>Only these two can record a payment<\/span>\}/,
  );
  assert.doesNotMatch(owedPage, /<Button[^>]*disabled=\{!\(iOweThis \|\| iAmOwedThis\)\}/, "no fake disabled button");

  // The breakdown's record button is gated on the same thing, with no role term.
  const breakdown = owedPage.slice(owedPage.indexOf("const canRecord ="), owedPage.indexOf("const voidPayment"));
  assert.doesNotMatch(breakdown, /isAdmin/);
  assert.match(breakdown, /creditorContributorId === data\.currentContributorId/);
  assert.match(breakdown, /debtorContributorId === data\.currentContributorId/);

  // Database: the ordinary payment function admits exactly two people, and
  // migration 024 does not touch it.
  const record = adminOverrideMigration.match(/create or replace function public\.record_settlement[\s\S]*?\n\$\$;/)[0];
  assert.match(
    record,
    /if current_contributor_id <> p_payee_contributor_id\s*and current_contributor_id <> p_payer_contributor_id\s*then\s*raise exception 'Only the payer or the person being paid can record this payment'/,
  );
});

test("6. an unrelated member cannot review, confirm, partly confirm or reject", () => {
  const review = paymentConfirmationsMigration.match(
    /create or replace function public\.review_payment[\s\S]*?\n\$\$;/,
  )[0];
  // Only the payee reviews. Not the payer, not an unrelated member, not an admin.
  assert.match(
    review,
    /raise exception 'Only the person this payment was sent to can review it'/,
  );
  assert.match(review, /current_contributor_id is null/);
  // A confirmation is still bounded by what is left unconfirmed.
  assert.match(review, /p_amount_pennies > remaining_pennies/);
  // Widening the read did not add a write route.
  assert.doesNotMatch(balanceVisibilityMigration, /create or replace function/i);
  assert.doesNotMatch(balanceVisibilityMigration, /^grant /im);
});

test("7-8. the payer can still record and the receiver can still review", () => {
  const record = adminOverrideMigration.match(/create or replace function public\.record_settlement[\s\S]*?\n\$\$;/)[0];
  // Recording is allowed for either party, and only the receiver's record
  // auto-confirms.
  assert.match(record, /caller_is_receiver := current_contributor_id = p_payee_contributor_id;/);
  assert.match(record, /case when caller_is_receiver then p_amount_pennies else 0 end/);

  const review = paymentConfirmationsMigration.match(
    /create or replace function public\.review_payment[\s\S]*?\n\$\$;/,
  )[0];
  assert.match(review, /for update;/, "the review still locks the row it is changing");
  assert.match(review, /pg_advisory_xact_lock/, "and still takes the pair lock first");
});

test("9-11. Global Admin sees the same tabs, with the same payment rules", () => {
  const owedPage = readFileSync(join(root, "src", "app", "owed", "page.tsx"), "utf8");

  // The switcher is not conditional at all, so an admin sees what a member sees.
  assert.equal(
    (owedPage.match(/ariaLabel="Balance view"/g) ?? []).length,
    1,
    "one switcher, rendered for everybody",
  );

  // The ordinary payment function still knows nothing about admins.
  const record = adminOverrideMigration.match(/create or replace function public\.record_settlement[\s\S]*?\n\$\$;/)[0];
  assert.doesNotMatch(record, /is_app_admin/);

  // The separate override survives, admin-only, reason required.
  const override = adminOverrideMigration.match(
    /create or replace function public\.admin_record_confirmed_payment[\s\S]*?\n\$\$;/,
  )[0];
  assert.match(override, /if not public\.is_app_admin\(\) then/);
  assert.match(override, /Give a reason for recording this payment as already confirmed/);
  // And it is still reached through its own clearly separated Admin tools area.
  assert.match(owedPage, /\{data\.isAdmin && <AdminTools/);
  assert.match(owedPage, /rpc\("admin_record_confirmed_payment"/);
  assert.ok(
    owedPage.indexOf("<AdminTools") > owedPage.indexOf("<BalanceSection"),
    "admin tools stay below the ordinary controls",
  );
});

test("12. inactive and signed-out visitors still see nothing", () => {
  // Every widened policy is still gated on active membership, and is granted to
  // `authenticated` only -- `anon` has no route in.
  for (const policy of [
    /create policy "active members read family settlements"[\s\S]*?using \(public\.is_active_app_member\(\)\)/,
    /create policy "active members read family payment receipts"[\s\S]*?using \(public\.is_active_app_member\(\)\)/,
  ]) {
    assert.match(balanceVisibilityMigration, policy);
  }
  assert.doesNotMatch(balanceVisibilityMigration, /to anon/i);
  assert.doesNotMatch(balanceVisibilityMigration, /to public\b/i);
  // `is_active_app_member` is the same function every other read already uses,
  // and it requires an active row for the caller's auth uid.
  assert.match(
    authorizationMigration,
    /create or replace function public\.is_active_app_member[\s\S]*?where user_id = \(select auth\.uid\(\)\)[\s\S]*?and active = true/,
  );
});

test("13. the visibility migration changes no money and no write permission", () => {
  const statements = balanceVisibilityMigration.replace(/--[^\n]*/g, "");

  // Reads only. No function, no trigger, no constraint, no column, no data.
  assert.doesNotMatch(statements, /create or replace function/i);
  assert.doesNotMatch(statements, /create trigger|drop trigger/i);
  assert.doesNotMatch(statements, /add constraint|drop constraint/i);
  assert.doesNotMatch(statements, /add column|drop column|alter column/i);
  assert.doesNotMatch(statements, /^\s*(insert into|update|delete from|truncate)/im);
  assert.doesNotMatch(statements, /generated always as/i);

  // No grant is issued or revoked: the tables stay SELECT-only to browsers.
  assert.doesNotMatch(statements, /^\s*grant /im);
  assert.doesNotMatch(statements, /^\s*revoke /im);

  // Only SELECT policies are created, and only on the two intended tables.
  const created = statements.match(/create policy[\s\S]*?;/g) ?? [];
  assert.equal(created.length, 2, "exactly two policies");
  for (const policy of created) {
    assert.match(policy, /for select/, "read-only");
    assert.doesNotMatch(policy, /with check/, "a SELECT policy has no with check");
    assert.match(policy, /on public\.(settlements|payment_receipts)/);
  }

  // The end-state block refuses to let a write grant coexist with this change.
  assert.match(statements, /privilege_type in \('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'\)/);
  assert.match(statements, /raise exception 'Balance visibility migration did not complete cleanly/);

  // And the append-only guarantee on review history is untouched.
  assert.doesNotMatch(statements, /payment_receipts_are_append_only/);
  assert.match(
    paymentConfirmationsMigration,
    /create trigger payment_receipts_are_append_only\s*before update or delete on public\.payment_receipts/,
  );
});
