#!/usr/bin/env node
/**
 * DO THE TESTS ACTUALLY CATCH ANYTHING?
 *
 * A suite that passes proves the code does what it does. It does not prove the
 * suite would notice if the code stopped. This breaks each rule that matters,
 * one at a time, runs the suite that is supposed to care, puts the file back,
 * and reports whether the break was caught.
 *
 * A MUTATION THAT SURVIVES IS A HOLE IN THE TESTS, not a passing grade.
 *
 * The SQL mutations are the interesting ones: since `scripts/pg/rehearsal.mjs`
 * arrived, a broken policy or a removed condition is caught by a real
 * PostgreSQL refusing (or failing to refuse) a real query -- not by a regular
 * expression noticing that a line changed.
 *
 *   node scripts/mutation-check.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DB_SUITES = ["scripts/tenancy-runtime.test.mjs", "scripts/migration-execution.test.mjs"];

const MUTATIONS = [
  {
    name: "1. Family Access stops scoping its listing to one family",
    file: "src/app/api/admin/family-access/route.ts",
    from: `        .eq("area_id", context.areaId)
        .order("name"),`,
    to: `        .order("name"),`,
    suites: ["scripts/areas-and-tenancy.test.mjs"],
  },
  {
    name: "2. a multi-Area login falls back to its first membership",
    file: "src/utils/supabase/current-member.ts",
    from: "  return { user, member: chosen ?? null };",
    to: "  return { user, member: chosen ?? rows[0] };",
    suites: ["scripts/areas-and-tenancy.test.mjs"],
  },
  {
    name: "3. the Area condition comes off contributor eligibility",
    file: "supabase/migrations/202608100039_area_aware_contributor_permissions.sql",
    from: `      and m.area_id = p_area_id
      -- The person really is in the Area the membership claims. 035's guard
      -- makes this true for every row it has seen; asserting it here means a
      -- row that predates the guard cannot borrow a permission with it.
      and p.area_id = p_area_id`,
    to: "",
    suites: DB_SUITES,
  },
  {
    name: "4. the celebrant's own birthday gift ideas are reopened",
    file: "supabase/migrations/202608100036_area_scoped_visibility.sql",
    from: `    and not public.is_own_birthday_recipient(christmas_recipient_id)
  );

drop policy if exists "active members add gift ideas" on public.gift_ideas;`,
    to: `  );

drop policy if exists "active members add gift ideas" on public.gift_ideas;`,
    suites: DB_SUITES,
  },
  {
    name: "5. the wishlist stops anchoring its author",
    file: "supabase/migrations/202608100040_own_birthday_wishlist.sql",
    from: `  -- Supplied by a browser rather than derived: check it, do not trust it.
  if not exists (
    select 1 from public.app_members m
    where m.id = new.created_by_app_member_id
      and m.area_id = owning_area
      and m.person_id = new.person_id
      and m.active = true
  ) then
    raise exception 'A wishlist entry must be written by the birthday person'
      using errcode = '42501';
  end if;`,
    to: "",
    suites: DB_SUITES,
  },
  {
    name: "6. the notification audience stops being narrowed to one family",
    file: "src/lib/notification-dispatch.ts",
    from: `      ? admin.from("app_members").select("id,person_id,contributor_id,active").eq("active", true).eq("area_id", areaId)
      : admin.from("app_members").select("id,person_id,contributor_id,active").eq("active", true),`,
    to: `      ? admin.from("app_members").select("id,person_id,contributor_id,active").eq("active", true)
      : admin.from("app_members").select("id,person_id,contributor_id,active").eq("active", true),`,
    suites: ["scripts/areas-and-tenancy.test.mjs"],
  },
  {
    name: "7. an Area-specific loader stops filtering by the Area on screen",
    file: "src/utils/supabase/birthdays-server.ts",
    from: `      .select("id,name,birthday_month,birthday_day,birthday_year,is_family_contributor")
      .eq("area_id", areaId)`,
    to: `      .select("id,name,birthday_month,birthday_day,birthday_year,is_family_contributor")`,
    suites: ["scripts/areas-and-tenancy.test.mjs"],
  },
  {
    name: "8. the events dashboard stops filtering by the Area on screen",
    file: "src/utils/supabase/events-server.ts",
    from: `db.from("events").select(EVENT_COLUMNS).eq("area_id", areaId),`,
    to: `db.from("events").select(EVENT_COLUMNS),`,
    suites: ["scripts/areas-and-tenancy.test.mjs"],
  },
  {
    name: "9. set_person_birthday goes back to asking the global question",
    file: "supabase/migrations/202608100039_area_aware_contributor_permissions.sql",
    from: `      public.is_area_admin(target_area)
      or public.is_area_contributor_member(target_area)`,
    to: `      public.is_app_admin()
      or public.is_family_contributor_member()`,
    suites: DB_SUITES,
  },
  {
    name: "10. list_gift_ideas stops checking which family the recipient is in",
    file: "supabase/migrations/202608100039_area_aware_contributor_permissions.sql",
    from: `  owning_area := public.area_of_recipient(p_christmas_recipient_id);
  if owning_area is null or not public.is_area_member(owning_area) then
    raise exception 'Active app membership required'
      using errcode = '42501';
  end if;`,
    to: "  owning_area := public.area_of_recipient(p_christmas_recipient_id);",
    suites: DB_SUITES,
  },
  {
    name: "11. the wishlist write policies stop asking who the writer is",
    file: "supabase/migrations/202608100040_own_birthday_wishlist.sql",
    from: `  with check (
    public.is_area_member(area_id)
    and public.is_own_wishlist_person(person_id)
    and public.is_own_app_member(created_by_app_member_id)
  );`,
    to: `  with check (
    public.is_area_member(area_id)
  );`,
    suites: DB_SUITES,
  },
  {
    name: "12. the production check file gains a statement that writes",
    file: "docs/PHASE-5-POST-APPLY-CHECKS.sql",
    from: "with checks as (",
    to: "delete from public.people where false;\n\nwith checks as (",
    suites: ["scripts/production-checks.test.mjs"],
  },
  {
    name: "13. the production check file goes back to asking the CLI migration table",
    file: "docs/PHASE-5-POST-APPLY-CHECKS.sql",
    from: "with checks as (",
    to: "with checks as (\n\nselect 1 as sort, 'x'::text as section, 'y'::text as check_name,\n       'INFO'::text as verdict,\n       (select count(*)::text from supabase_migrations.schema_migrations) as detail\nunion all",
    suites: ["scripts/production-checks.test.mjs"],
  },
];

function runSuite(suite) {
  try {
    execFileSync(process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", suite],
      { cwd: ROOT, stdio: "pipe" });
    return null;
  } catch (error) {
    const output = String(error.stdout ?? "");
    // A migration whose own end-state block refuses to apply is the STRONGEST
    // catch there is: the change never reaches a database at all. Reporting
    // that as "the first test failed" would hide what actually happened.
    const endState = /did not reach its end state: ([^\n']*)/u.exec(output);
    if (endState) {
      return `the migration REFUSED TO APPLY -- ${endState[1].trim().slice(0, 110)}`;
    }
    if (new RegExp(String.raw`\d{12}_[a-z_]+\.sql failed: `, "u").test(output)) {
      return "the migration chain refused to build";
    }

    const first = output.split("\n").map((l) => l.trim()).find((l) => l.startsWith("✖ "));
    return first ?? "(failed)";
  }
}

let caught = 0;
const survived = [];

for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file);
  const original = readFileSync(path, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const needle = mutation.from.replace(/\r\n/g, "\n").split("\n").join(eol);

  if (!original.includes(needle)) {
    console.log(`  ??  ${mutation.name}\n      COULD NOT APPLY -- the code it breaks has moved. Inconclusive.`);
    survived.push(mutation.name);
    continue;
  }

  writeFileSync(path, original.replace(needle, mutation.to.replace(/\r\n/g, "\n").split("\n").join(eol)));

  let failure = null;
  try {
    for (const suite of mutation.suites) {
      failure = runSuite(suite);
      if (failure) break;
    }
  } finally {
    writeFileSync(path, original);
  }

  if (failure) {
    caught += 1;
    console.log(`  ok  ${mutation.name}\n      caught by: ${failure}`);
  } else {
    survived.push(mutation.name);
    console.log(`  !!  ${mutation.name}\n      SURVIVED -- nothing failed`);
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught.`);
if (survived.length > 0) {
  console.log("Survivors:");
  for (const name of survived) console.log(`  - ${name}`);
}
process.exit(survived.length === 0 ? 0 : 1);
