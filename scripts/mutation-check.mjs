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

import { summariseMutationRun } from "./mutation-summary.mjs";

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

  // -------------------------------------------------------------------------
  // Q2: the Area lifecycle. Ten breaks, one per rule that Q2 either added or
  // found broken.
  // -------------------------------------------------------------------------
  {
    name: "Q2-1. the Family Access gateway stops scoping its person lookup",
    file: "src/app/api/admin/family-access/route.ts",
    from: `      .eq("id", personId)
      .eq("area_id", areaId)`,
    to: `      .eq("id", personId)`,
    suites: ["scripts/areas-and-tenancy.test.mjs"],
  },
  {
    name: "Q2-2. Family Access authorises on ANY admin membership, not the selected family",
    file: "src/utils/supabase/family-access-admin.ts",
    from: "  const { user, member } = await getCurrentMember();",
    to: "  const { user, member } = await anyAdminMembership();",
    suites: ["scripts/areas-and-tenancy.test.mjs", "scripts/rls-security.test.mjs"],
  },
  {
    name: "Q2-3. the sole administrator is allowed to walk out",
    file: "supabase/migrations/202608100042_area_membership_lifecycle.sql",
    from: `  if mine.role = 'admin' then
    raise exception 'Hand this family over to somebody else before you leave it'
      using errcode = '42501';
  end if;`,
    to: "",
    suites: ["scripts/area-lifecycle.test.mjs"],
  },
  {
    name: "Q2-4. the handover demotes before it promotes, so the halves can part",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  update public.app_members set role = 'admin', updated_at = now() where id = incoming.id;
  update public.app_members set role = 'member', updated_at = now() where id = outgoing.id;`,
    to: `  update public.app_members set role = 'member', updated_at = now() where id = outgoing.id;
  update public.app_members set role = 'admin', updated_at = now() where id = incoming.id;`,
    suites: ["scripts/area-lifecycle.test.mjs"],
  },
  {
    name: "Q2-5. the handover stops checking the successor is active",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `    and m.area_id = p_area_id
    and m.active = true
    and m.person_id is not null;`,
    to: `    and m.area_id = p_area_id
    and m.person_id is not null;`,
    suites: ["scripts/area-lifecycle.test.mjs"],
  },
  {
    name: "Q2-6. the handover stops checking the successor is in this family",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  where m.id = p_new_admin_member_id
    and m.area_id = p_area_id
    and m.active = true`,
    to: `  where m.id = p_new_admin_member_id
    and m.active = true`,
    suites: ["scripts/area-lifecycle.test.mjs"],
  },
  {
    name: "Q2-7. account setup goes back to assuming one membership",
    file: "src/app/account-setup/page.tsx",
    from: `        .eq("active", true)
        .limit(1)
        .maybeSingle();`,
    to: "        .maybeSingle();",
    suites: ["scripts/areas-and-tenancy.test.mjs"],
  },
  {
    name: "Q2-8. creating a family copies the people out of another one",
    file: "supabase/migrations/202608100037_area_write_barrier.sql",
    from: `  insert into public.app_members (user_id, email, person_id, role, active, area_id)
  values (caller, caller_email, new_person, 'admin', true, new_area);`,
    to: `  insert into public.app_members (user_id, email, person_id, role, active, area_id)
  values (caller, caller_email, new_person, 'admin', true, new_area);

  insert into public.people (name, area_id)
  select p.name, new_area from public.people p where p.area_id <> new_area limit 5;`,
    suites: ["scripts/area-lifecycle.test.mjs"],
  },
  {
    name: "Q2-9. a deactivated membership still counts as being in the family",
    file: "supabase/migrations/202608100034_areas_and_memberships.sql",
    from: `    where m.user_id = (select auth.uid())
      and m.active = true
      and m.area_id = p_area_id
  );
$$;

create or replace function public.is_area_admin(p_area_id uuid)`,
    to: `    where m.user_id = (select auth.uid())
      and m.area_id = p_area_id
  );
$$;

create or replace function public.is_area_admin(p_area_id uuid)`,
    suites: ["scripts/area-lifecycle.test.mjs"],
  },
  {
    name: "Q2-10. an administrator may start their own birthday after all",
    file: "supabase/migrations/202608100043_birthday_planning_eligibility.sql",
    from: `  if new.event_type = 'birthday'
    and new.celebrant_person_id is not null
    and new.celebrant_person_id = public.current_person_in_area(new.area_id)
  then`,
    to: `  if new.event_type = 'birthday'
    and new.celebrant_person_id is not null
    and new.celebrant_person_id = public.current_person_in_area(new.area_id)
    and not public.is_area_admin(new.area_id)
  then`,
    suites: ["scripts/tenancy-runtime.test.mjs"],
  },
  {
    name: "Q2-11. the Q2 production check file gains a statement that writes",
    file: "docs/Q2-POST-APPLY-CHECKS.sql",
    from: "with checks as (",
    to: "delete from public.audit_log where false;" + String.fromCharCode(10) + "with checks as (",
    suites: ["scripts/production-checks.test.mjs"],
  },
  // -------------------------------------------------------------------------
  // Settings scope: the three scopes, and what happens when one leaks.
  // -------------------------------------------------------------------------
  {
    name: "Q2-12. Falling snow creeps back onto the event More screen",
    file: "src/app/events/[eventId]/more/event-more-screen.tsx",
    from: "      <SettingsGroup label={eventName}>",
    to: "      <SettingsGroup label=\"Appearance\"><p>Falling snow</p></SettingsGroup>" + String.fromCharCode(10) + "      <SettingsGroup label={eventName}>",
    suites: ["scripts/settings-navigation.test.mjs"],
  },
  {
    name: "Q2-13. an event offers Family access, as though the event scoped the family",
    file: "src/lib/settings-scopes.ts",
    from: "      key: \"event-payment-log\",",
    to: "      key: \"family-access\", title: \"Family access\", scope: \"event\", href: \"/more/family-access\", description: \"Invite family.\"," + String.fromCharCode(10) + "    }, {" + String.fromCharCode(10) + "      key: \"event-payment-log\",",
    suites: ["src/lib/settings-scopes.test.ts"],
  },
  {
    name: "Q2-14. Settings is dropped from the main navigation again",
    file: "src/app/components/nav-items.ts",
    from: '  { section: "settings", href: "/settings", label: "Settings", icon: Settings },',
    to: "",
    suites: ["scripts/settings-navigation.test.mjs"],
  },
  {
    name: "Q2-15. the mobile tab bar goes back to a hard-coded two columns",
    file: "src/app/components/bottom-tabs.tsx",
    from: "        GLOBAL_NAV.length === 2 ? \"grid-cols-2\" : GLOBAL_NAV.length === 4 ? \"grid-cols-4\" : \"grid-cols-3\",",
    to: "        \"grid-cols-2\",",
    suites: ["scripts/settings-navigation.test.mjs"],
  },
  // -------------------------------------------------------------------------
  // The QA safety layer. Q2 now tests inside the SAME database as the real
  // family, so these four are the difference between a safe test run and a
  // write into somebody's real Christmas.
  // -------------------------------------------------------------------------
  {
    name: "QA-1. the real Area is allowed onto the QA list",
    file: "scripts/qa/protected.mjs",
    from: "    if (protectedAreaIds.has(id)) {",
    to: "    if (false) {",
    suites: ["scripts/qa/protected.test.mjs"],
  },
  {
    name: "QA-2. the browser helper may navigate to the real Christmas",
    file: "scripts/qa/protected.mjs",
    from: "  for (const id of config.protectedEventIds) {",
    to: "  for (const id of []) {",
    suites: ["scripts/qa/protected.test.mjs"],
  },
  {
    name: "QA-3. the fixture loader accepts a real Person id",
    file: "scripts/qa/protected.mjs",
    from: "  if (config.protectedAreaIds.has(area)) {",
    to: "  if (false) {",
    suites: ["scripts/qa/protected.test.mjs"],
  },
  {
    name: "QA-4. the destructive membership helper stops checking its subjects",
    file: "scripts/qa/protected.mjs",
    from: "  for (const subject of subjects) {",
    to: "  for (const subject of []) {",
    suites: ["scripts/qa/protected.test.mjs"],
  },
  {
    name: "QA-5. the legacy Christmas redirect stops asking which family is on screen",
    file: "src/utils/supabase/events-server.ts",
    from: '    .eq("area_id", areaId)' + String.fromCharCode(10) + "    .limit(1)",
    to: "",
    suites: ["scripts/areas-and-tenancy.test.mjs"],
  },
  {
    name: "QA-6. leaving a family clears the remembered Area again, locking out a multi-family login",
    file: "src/app/api/areas/membership/route.ts",
    from: "    const next = resolveActiveArea((remaining.data ?? []).map(areaFromRow), null);",
    to: "    const next = null;",
    suites: ["scripts/area-lifecycle.test.mjs"],
  },
  {
    name: "QA-7. signing in stops asking which family, and signs a multi-family login straight out",
    file: "src/app/family-context.tsx",
    from: "      const outcome = await ensureAreaChosen();"
      + String.fromCharCode(10)
      + '      if (outcome === "chosen") { window.location.reload(); return; }',
    to: "",
    suites: ["scripts/area-lifecycle.test.mjs"],
  },
  {
    name: "QA-8. the way to start another family disappears from the switcher",
    file: "src/app/components/account-menu.tsx",
    from: "              {canCreate && (",
    to: "              {false && canCreate && (",
    suites: ["scripts/area-discoverability.test.mjs"],
  },
  {
    name: "QA-9. the family section hides again from anybody with only one family",
    file: "src/app/components/account-menu.tsx",
    from: "          {(canSwitch || canCreate) && (",
    to: "          {canSwitch && (",
    suites: ["scripts/area-discoverability.test.mjs"],
  },
  {
    name: "QA-10. global Settings stops offering the families this account belongs to",
    file: "src/app/settings/settings-screen.tsx",
    from: "      <YourFamilies />",
    to: "",
    suites: ["scripts/area-discoverability.test.mjs"],
  },
  {
    name: "QA-11. the lint gate goes back to linting the Cloudflare build output",
    file: "eslint.config.mjs",
    from: '    ".open-next/**",',
    to: "",
    suites: ["scripts/lint-gate.test.mjs"],
  },

  // -------------------------------------------------------------------------
  // Q3: Person, Contributor, Account and Admin are four things, in four places,
  // and every one of them belongs to exactly one family.
  // -------------------------------------------------------------------------
  {
    name: "Q3-1. a membership is written into the ACTING Area rather than the Person's own",
    file: "src/app/api/admin/family-access/route.ts",
    from: "    area_id: person.area_id,",
    to: "    area_id: areaId,",
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-2. giving access stops linking the existing Person",
    file: "src/app/api/admin/family-access/route.ts",
    from: "    person_id: person.id,",
    to: "    person_id: null,",
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-3. the contributor routine goes back to asking about the ACTING Area",
    file: "supabase/migrations/202608100044_area_scoped_person_administration.sql",
    from: `  if target_area is null or not public.is_area_admin(target_area) then
    -- One refusal for "no such person" and for "not your family", so the
    -- message cannot be used to discover who exists elsewhere.
    raise exception 'Only this family''s administrator can change who contributes'`,
    to: `  if not public.is_app_admin() then
    raise exception 'Only this family''s administrator can change who contributes'`,
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-4. archiving a person stops checking which family they are in",
    file: "supabase/migrations/202608100044_area_scoped_person_administration.sql",
    from: `  if target_area is null or not public.is_area_admin(target_area) then
    raise exception 'Only this family''s administrator can archive one of its people'`,
    to: `  if not public.is_app_admin() then
    raise exception 'Only this family''s administrator can archive one of its people'`,
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-5. renaming a person stops checking which family they are in",
    file: "supabase/migrations/202608100044_area_scoped_person_administration.sql",
    from: `  if target_area is null or not public.is_area_admin(target_area) then
    raise exception 'Only this family''s administrator can rename one of its people'`,
    to: `  if not public.is_app_admin() then
    raise exception 'Only this family''s administrator can rename one of its people'`,
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-6. archiving a person deletes them instead of keeping their history",
    file: "supabase/migrations/202608100044_area_scoped_person_administration.sql",
    from: `  update public.people
  set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,`,
    to: `  delete from public.people where id = p_person_id and p_archived;
  update public.people
  set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,`,
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-7. the People directory stops scoping its account badges to this family",
    file: "src/utils/supabase/people-server.ts",
    from: `    .select("person_id,user_id,active,role")
    .eq("area_id", areaId);`,
    to: `    .select("person_id,user_id,active,role");`,
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-8. the service-role account list stops filtering by Area",
    file: "src/app/api/admin/family-access/route.ts",
    from: `        .select("id, name, area_id, is_family_contributor")
        .eq("area_id", context.areaId)
        .order("name"),`,
    to: `        .select("id, name, area_id, is_family_contributor")
        .order("name"),`,
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-9. the Person profile stops saying the contributor toggle is not a login",
    file: "src/app/people/[id]/person-admin-panel.tsx",
    from: "it neither gives nor removes account access, and it does not",
    to: "it also gives them account access, and it may",
    suites: ["scripts/people-and-access.test.mjs"],
  },
  {
    name: "Q3-10. user-facing Global Admin wording comes back",
    file: "src/app/people/[id]/person-admin-panel.tsx",
    from: `              ? "Admin of this family"`,
    to: `              ? "Global Admin"`,
    suites: ["scripts/people-and-access.test.mjs"],
  },

  // -------------------------------------------------------------------------
  // Q3 SECURITY: one family at a time. Each of these reopens a cross-Area hole
  // that was PROVEN reachable before migration 045, so a survivor here is a
  // real escalation nobody would notice.
  // -------------------------------------------------------------------------
  {
    name: "Q3S-1. the guard stops comparing the target Area with the acting one",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "    if acting <> p_area_id then",
    to: "    if false then",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-2. the guard trusts the acting Area instead of the row's own",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "  perform public.require_acting_area(public.area_of_event(p_event_id));\n  if not public.is_app_admin() then\n    raise exception 'Global Admin access required to archive an event'",
    to: "  perform public.require_acting_area(public.acting_area());\n  if not public.is_app_admin() then\n    raise exception 'Global Admin access required to archive an event'",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-3. event update loses its target-Area check",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "  perform public.require_acting_area(public.area_of_event(p_event_id));\n  if not public.is_app_admin() then\n    raise exception 'Global Admin access required to change an event'",
    to: "  if not public.is_app_admin() then\n    raise exception 'Global Admin access required to change an event'",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-4. adding a recipient stops checking the event's Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "  perform public.require_acting_area(public.area_of_event(p_event_id));\n  if not public.is_app_admin() then\n    raise exception 'Global Admin access required to add a recipient'",
    to: "  if not public.is_app_admin() then\n    raise exception 'Global Admin access required to add a recipient'",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-5. recipient activation stops checking the recipient's Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "  perform public.require_acting_area(public.area_of_recipient(p_christmas_recipient_id));",
    to: "",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-6. the confirmed-payment routine stops checking the event's Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "  perform public.require_acting_area(public.area_of_event(p_christmas_event_id));\n  if not public.is_app_admin() then",
    to: "  if not public.is_app_admin() then",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    // The FIRST settlement guard in the file is `review_payment`'s -- the
    // routine that confirms somebody else's money arrived.
    name: "Q3S-7. confirming a payment stops checking the settlement's Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "  perform public.require_acting_area(public.area_of_settlement(p_settlement_id));",
    to: "",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    // The FIRST purchase guard in the file is `set_purchase_status`'s.
    name: "Q3S-8. changing a purchase stops checking its Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "  perform public.require_acting_area(public.area_of_purchase(p_purchase_id));",
    to: "",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-9. a dual administrator may mutate the family they are NOT standing in",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "      raise exception 'That belongs to another family. Switch to that family first.'\n        using errcode = '42501';\n    end if;\n    return;",
    to: "      return;\n    end if;\n    return;",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-10. omitting the Area header becomes the way round the guard",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "  if memberships <> 1 then\n    raise exception 'Say which family you are working in.' using errcode = '42501';\n  end if;",
    to: "  if false then\n    raise exception 'Say which family you are working in.' using errcode = '42501';\n  end if;",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-11. anon regains execute on the guarded routines",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "    execute format('revoke all on function %s from public, anon', fn);",
    to: "    execute format('grant execute on function %s to anon', fn);",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },
  {
    name: "Q3S-12. the guard loses its pinned search_path",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: "returns void\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = ''",
    to: "returns void\nlanguage plpgsql\nstable\nsecurity definer",
    suites: ["scripts/area-mutation-security.test.mjs"],
  },

  // -------------------------------------------------------------------------
  // Q4: an event is an occasion; a recipient is a role somebody holds in one.
  // Blurring the two, or letting either escape its family, is the whole list.
  // -------------------------------------------------------------------------
  {
    name: "Q4-1. the events list stops scoping to the family on screen",
    file: "src/utils/supabase/events-server.ts",
    from: `db.from("events").select(EVENT_COLUMNS).eq("area_id", areaId),`,
    to: `db.from("events").select(EVENT_COLUMNS),`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-2. opening one event stops checking which family it is in",
    file: "src/utils/supabase/events-server.ts",
    from: `.from("events").select(EVENT_COLUMNS).eq("id", validId.value).eq("area_id", areaId).maybeSingle();`,
    to: `.from("events").select(EVENT_COLUMNS).eq("id", validId.value).maybeSingle();`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-3. an event card counts archived recipients as people it is for",
    file: "src/utils/supabase/events-server.ts",
    from: `  const recipients = (recipientResult.data ?? []).filter((row) => row.active);`,
    to: `  const recipients = (recipientResult.data ?? []);`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-4. the events index stops naming which family it is listing",
    file: "src/app/events-dashboard.tsx",
    from: `        eyebrow={areaName}`,
    to: `        eyebrow="Family gift planner"`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-5. an event screen can rename the durable Person again",
    file: "src/app/people/person-modal.tsx",
    from: `        name: person.name,
        budgetPennies: parsedBudget.value,`,
    to: `        name: name,
        budgetPennies: parsedBudget.value,`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-6. the recipient editor offers a Name field again",
    file: "src/app/people/person-modal.tsx",
    from: `      <Field label="Budget" className="mt-4">`,
    to: `      <Field label="Name" className="mt-4"><Input value={name} onChange={() => {}} /></Field>
      <Field label="Budget" className="mt-4">`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-7. adding a recipient stops checking the event's Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to add a recipient'`,
    to: `  if not public.is_app_admin() then
    raise exception 'Global Admin access required to add a recipient'`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-8. removing a recipient hard-deletes them and their history",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  update public.christmas_recipients
  set active = p_active, updated_at = now()
  where id = p_christmas_recipient_id
  returning * into updated_recipient;`,
    to: `  delete from public.christmas_recipients
  where id = p_christmas_recipient_id
  returning * into updated_recipient;`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-9. event contributor management stops checking the event's Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to change contributors'`,
    to: `  if not public.is_app_admin() then
    raise exception 'Global Admin access required to change contributors'`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-10. archiving an event stops checking the event's Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Global Admin access required to archive an event'`,
    to: `  if not public.is_app_admin() then
    raise exception 'Global Admin access required to archive an event'`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-11. deleting an event stops caring whether it is empty",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  if blocking_count > 0 then
    raise exception
      'This event has % % and cannot be deleted. Archive it instead`,
    to: `  if false then
    raise exception
      'This event has % % and cannot be deleted. Archive it instead`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-11b. deleting an event stops checking the event's Area",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  perform public.require_acting_area(public.area_of_event(p_event_id));
  if not public.is_app_admin() then
    raise exception 'Only the Global Admin can delete an event'`,
    to: `  if not public.is_app_admin() then
    raise exception 'Only the Global Admin can delete an event'`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-12. Christmas uniqueness loses its Area dimension",
    file: "supabase/migrations/202608100035_area_integrity.sql",
    from: `  on public.events (area_id, year)`,
    to: `  on public.events (year)`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-13. a custom event title becomes globally unique instead of per family",
    file: "supabase/migrations/202608100035_area_integrity.sql",
    from: `  on public.events (area_id, lower(trim(name)), event_date);`,
    to: `  on public.events (lower(trim(name)), event_date);`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-14. global settings creep back into an event's settings screen",
    file: "src/app/events/[eventId]/settings/settings-screen.tsx",
    from: `export function EventSettingsScreen(`,
    to: `const CREEP = "Family access";
export function EventSettingsScreen(`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-15. adding somebody twice stops reusing their existing recipient row",
    file: "supabase/migrations/202608100045_area_scoped_mutation_hardening.sql",
    from: `  on conflict (christmas_event_id, person_id)
  do update set active = true
  returning * into saved_recipient;`,
    to: `  on conflict (christmas_event_id, person_id)
  do update set budget_pennies = public.christmas_recipients.budget_pennies
  returning * into saved_recipient;`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-16. an event page stops resolving its event through the gate",
    file: "src/app/events/[eventId]/settings/page.tsx",
    from: `requireEvent(`,
    to: `getEventUnchecked(`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },

  // -------------------------------------------------------------------------
  // Q4, second pass: the two rules the audit found were asserted by reading the
  // SQL rather than by running it. A regular expression cannot tell a key of
  // (person, year) from a key of (person, date), and it cannot tell a policy
  // that hides a birthday from one that merely mentions hiding it.
  // -------------------------------------------------------------------------
  {
    name: "Q4-17. a birthday becomes unique per DATE instead of per YEAR",
    file: "supabase/migrations/202608100026_add_birthdays_and_event_administration.sql",
    from: `  on public.events (celebrant_person_id, (extract(year from event_date)))`,
    to: `  on public.events (celebrant_person_id, event_date)`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  // MIGRATION 036, NOT 031, IS WHERE BIRTHDAY PRIVACY ACTUALLY LIVES.
  //
  // 031 introduced the rule; 036 dropped and recreated the same policies to add
  // the Area predicate, and its versions are the ones the database ends up
  // with. Mutating 031 changes a policy that is replaced later in the chain, so
  // the final schema is untouched -- which is exactly what happened on the
  // first attempt at these two: both survived. 031 catches its own mutation
  // with an end-state block, and that block is still worth having, but it runs
  // before 036 overwrites its work and therefore protects nothing at the end.
  // The rule that ships is 036's, so that is what gets broken here.
  {
    name: "Q4-18. the celebrant can see their own birthday EVENT again",
    file: "supabase/migrations/202608100036_area_scoped_visibility.sql",
    from: `    public.is_active_app_member()
    and public.is_area_member(area_id)
    and not public.is_own_birthday_event(id)`,
    to: `    public.is_active_app_member()
    and public.is_area_member(area_id)`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-19. the celebrant can see what the family paid each other for their present",
    file: "supabase/migrations/202608100036_area_scoped_visibility.sql",
    from: `create policy "active members read family settlements"
  on public.settlements for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_event(christmas_event_id))
    and not public.is_own_birthday_event(christmas_event_id)
  );`,
    to: `create policy "active members read family settlements"
  on public.settlements for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_event(christmas_event_id))
  );`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-20. a filtered mutation run reports a misleading denominator again",
    file: "scripts/mutation-summary.mjs",
    from: "return `${caught}/${selectedCount} mutations caught${scope}.`;",
    to: "return `${caught}/${totalCount} mutations caught${scope}.`;",
    suites: ["scripts/mutation-gate.test.mjs"],
  },

  // -------------------------------------------------------------------------
  // AND THE SAME TWO RULES BROKEN WITHOUT LOOKING BROKEN.
  //
  // A check that searches a policy for the words `is_own_birthday` -- which is
  // what migration 031's end-state block does -- passes on both of these. The
  // function is still called, from the same policy, on the same table. It is
  // handed an id that does not exist, so it always answers false, so `not
  // false` shows everybody everything. Nothing but an assertion about what a
  // reader can actually SEE can tell these apart from the real thing.
  // -------------------------------------------------------------------------
  {
    name: "Q4-21. birthday privacy on the EVENT is neutered while still looking present",
    file: "supabase/migrations/202608100036_area_scoped_visibility.sql",
    from: `    and not public.is_own_birthday_event(id)`,
    to: `    and not public.is_own_birthday_event('00000000-0000-0000-0000-000000000000'::uuid)`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    name: "Q4-22. birthday privacy on the MONEY is neutered while still looking present",
    file: "supabase/migrations/202608100036_area_scoped_visibility.sql",
    from: `create policy "active members read family settlements"
  on public.settlements for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_event(christmas_event_id))
    and not public.is_own_birthday_event(christmas_event_id)
  );`,
    to: `create policy "active members read family settlements"
  on public.settlements for select
  using (
    public.is_active_app_member()
    and public.is_area_member(public.area_of_event(christmas_event_id))
    and not public.is_own_birthday_event('00000000-0000-0000-0000-000000000000'::uuid)
  );`,
    suites: ["scripts/events-and-recipients.test.mjs"],
  },
  {
    /*
     * THE CROSS-AREA BROADCAST. `loadFamilyContext` draws its audience through
     * the admin client, so the Area argument is the only thing standing between
     * one family notification and every other family phones. Dropping it
     * restores the default -- `null`, meaning everybody -- while the call still
     * reads as though it were scoped.
     */
    name: "Q4-23. the live notification path stops naming the Area its audience comes from",
    file: "src/utils/supabase/notifications-server.ts",
    from: `  const context = await loadFamilyContext(reader, admin as unknown as DataClient, eventId, undefined, areaId);`,
    to: `  const context = await loadFamilyContext(reader, admin as unknown as DataClient, eventId);`,
    suites: ["scripts/notification-security.test.mjs"],
  },
  {
    name: "Q4-24. the outbox retry path stops naming the Area its audience comes from",
    file: "src/utils/supabase/notifications-server.ts",
    from: `  const context = await loadFamilyContext(admin, admin, eventId, undefined, areaId);`,
    to: `  const context = await loadFamilyContext(admin, admin, eventId, undefined, null);`,
    suites: ["scripts/notification-security.test.mjs"],
  },
  {
    /*
     * F2. The Area predicate IS the fix. Without it row level security hands
     * back every Area the READER belongs to, and the picker renders another
     * family by name -- twenty-three People in a two-person family, measured.
     */
    name: "Q4-25. the event settings People read goes Area-blind again",
    file: "src/app/events/[eventId]/settings/page.tsx",
    from: `    db.from("people").select("id,name,is_family_contributor").eq("area_id", areaId).order("name"),`,
    to: `    db.from("people").select("id,name,is_family_contributor").order("name"),`,
    suites: ["scripts/event-people-scope.test.mjs"],
  },
  {
    name: "Q4-26. the add-recipient directory goes Area-blind again",
    file: "src/app/people/people-screen.tsx",
    from: `      const withArchive = await db.from("people").select("id,name,archived_at").eq("area_id", areaId).order("name");`,
    to: `      const withArchive = await db.from("people").select("id,name,archived_at").order("name");`,
    suites: ["scripts/event-people-scope.test.mjs"],
  },
  {
    /*
     * F3. Restores the exact shape that made the dialog unusable: a bare
     * `name`, which in a browser resolves to `window.name` -- the empty string --
     * so every submit refused with "Enter a name." beside no name field.
     */
    name: "Q4-27. the add-recipient dialog validates a name it never collects again",
    file: "src/app/people/people-screen.tsx",
    from: `    const chosen = directory.find((entry) => entry.personId === personId);`,
    to: `    const validName = validateRequiredText(name, { field: "a name" });
    if (!validName.ok) { setError(validName.error); return; }
    const chosen = directory.find((entry) => entry.personId === personId);`,
    suites: ["scripts/event-people-scope.test.mjs"],
  },
  {
    /* F4. One duplicate mapping removed: that case loses its wording. */
    name: "Q4-28. the name-and-date duplicate loses its friendly wording",
    file: "src/lib/event-errors.ts",
    from: `  if (/name_and_date|name.*date/iu.test(message)) {`,
    to: `  if (/name_and_date_and_definitely_not_this/iu.test(message)) {`,
    suites: ["src/lib/event-errors.test.ts"],
  },
  {
    /*
     * F4, THE ORIGINAL BUG. The old mapper ended in `return message`, which is
     * exactly how a raw index name reached production. Restoring that
     * fall-through must fail the sweep that says no input may name internals.
     */
    name: "Q4-29. a failed event write falls through to the database's own text again",
    file: "src/lib/event-errors.ts",
    from: `  return fallback;`,
    to: `  return message || fallback;`,
    suites: ["src/lib/event-errors.test.ts"],
  },
  {
    /*
     * F3. Excluding INACTIVE recipients too is what made a removed person
     * unreachable from the dialog that is supposed to bring them back.
     */
    name: "Q4-30. a removed recipient disappears from the add-recipient dropdown again",
    file: "src/app/people/people-screen.tsx",
    from: `      alreadyRecipientPersonIds={people.filter((person) => person.active).map((person) => person.personId)}`,
    to: `      alreadyRecipientPersonIds={people.map((person) => person.personId)}`,
    suites: ["scripts/event-people-scope.test.mjs"],
  },
  {
    /*
     * PRE-Q5. THE BUG ITSELF, PUT BACK.
     *
     * The event chrome asking only for an id and trusting row level security to
     * mean "in this family". It does not: RLS answers for the READER, and a
     * login in two families passes it in both.
     */
    name: "Q5-1. the event chrome stops scoping its lookup to the selected Area",
    file: "src/app/family-context.tsx",
    from: `      .eq("id", eventId)
      .eq("area_id", currentAreaId)`,
    to: `      .eq("id", eventId)`,
    suites: ["scripts/area-context.test.mjs"],
  },
  {
    /*
     * PRE-Q5. Clearing only the NAME, which is the half-fix that looks right.
     * The recipient read below then still runs on the foreign event, loading its
     * people, budgets and totals into the same provider.
     */
    name: "Q5-2. a foreign event clears its name but still loads its people",
    file: "src/app/family-context.tsx",
    from: `    if (!eventRow.data) {
      setPeople([]); setEvent(null); setError(null); setLoading(false); return;
    }`,
    to: `    if (!eventRow.data) { setEvent(null); }`,
    suites: ["scripts/area-context.test.mjs"],
  },
  {
    /*
     * PRE-Q5. The other half-fix: the foreign event's PEOPLE are dropped but
     * the previously resolved event is left sitting in the provider. Nothing on
     * the current screen is foreign, so it reads as safe -- and the masthead
     * still names an event the reader has navigated away from.
     */
    name: "Q5-3. a foreign event leaves the previous event's name in the chrome",
    file: "src/app/family-context.tsx",
    from: `    if (!eventRow.data) {
      setPeople([]); setEvent(null); setError(null); setLoading(false); return;
    }`,
    to: `    if (!eventRow.data) {
      setPeople([]); setError(null); setLoading(false); return;
    }`,
    suites: ["scripts/area-context.test.mjs"],
  },
  {
    /*
     * Q5. THE BUG ITSELF. The acting-Area predicate comes off the DELETE
     * policy, leaving the membership question that a login in two families
     * answers yes to in both. Measured on 001-045: this is what let somebody
     * standing in Bravo delete Alpha's gift idea.
     */
    name: "Q5-4. the gift idea delete policy stops asking which family you are standing in",
    file: "supabase/migrations/202608100046_area_scoped_gift_idea_removal.sql",
    from: `    and public.is_acting_area(public.area_of_recipient(christmas_recipient_id))
    and not public.is_own_birthday_recipient(christmas_recipient_id)
    and not exists (`,
    to: `    and not public.is_own_birthday_recipient(christmas_recipient_id)
    and not exists (`,
    suites: DB_SUITES,
  },
  {
    /*
     * Q5. The provenance guard comes off, so deleting a bought idea is allowed
     * again and `on delete set null` quietly empties the purchase's reason.
     */
    name: "Q5-5. a purchased gift idea becomes deletable again",
    file: "supabase/migrations/202608100046_area_scoped_gift_idea_removal.sql",
    from: `    and not exists (
      select 1
      from public.purchases p
      where p.originating_gift_idea_id = public.gift_ideas.id
        and p.deleted_at is null
    )`,
    to: "",
    suites: DB_SUITES,
  },
  {
    /*
     * Q5. The routine stops refusing a bought idea, so the friendly sentence
     * disappears and the delete falls through to whatever the policy allows.
     */
    name: "Q5-6. remove_gift_idea stops protecting a purchase's provenance",
    file: "supabase/migrations/202608100046_area_scoped_gift_idea_removal.sql",
    from: `  if exists (
    select 1
    from public.purchases
    where originating_gift_idea_id = p_gift_idea_id
      and deleted_at is null
  ) then`,
    to: `  if false then`,
    suites: DB_SUITES,
  },
  {
    /*
     * Q5. `is_acting_area` stops disagreeing with anything -- the predicate the
     * new policies are built on always says yes. Every acting-Area rule this
     * migration added evaporates at once.
     */
    name: "Q5-8. the acting-Area predicate always agrees",
    file: "supabase/migrations/202608100046_area_scoped_gift_idea_removal.sql",
    from: `  if acting is not null then
    return acting = p_area_id;
  end if;`,
    to: `  if acting is not null then
    return true;
  end if;`,
    suites: DB_SUITES,
  },
  {
    /*
     * Q5. The application goes back to deleting the row itself, bypassing the
     * routine. With the grant revoked this now fails outright -- but the source
     * sweep is what stops the grant being handed back to "fix" it.
     */
    name: "Q5-9. the gift idea screen deletes the row directly again",
    file: "src/app/people/gift-ideas.tsx",
    from: `    const result = await createClient().rpc("remove_gift_idea", {
      p_gift_idea_id: idea.id,
    });`,
    to: `    const result = await createClient()
      .from("gift_ideas")
      .delete()
      .eq("id", idea.id)
      .eq("christmas_recipient_id", recipientId);`,
    suites: ["scripts/gift-idea-lifecycle.test.mjs"],
  },
  {
    /*
     * Q5. Remove is offered on an idea that has already been bought -- the
     * button the server will refuse, and the sentence that used to lie.
     */
    name: "Q5-10. a bought idea is offered for removal again",
    file: "src/app/people/gift-ideas.tsx",
    from: `                {!purchasedIdeaIds.has(idea.id) && (
                  <Button variant="dangerGhost" onClick={() => { setConfirming(idea); setError(null); setNotice(null); }}>Remove</Button>
                )}`,
    to: `                <Button variant="dangerGhost" onClick={() => { setConfirming(idea); setError(null); setNotice(null); }}>Remove</Button>`,
    suites: ["scripts/gift-idea-lifecycle.test.mjs"],
  },
  {
    /*
     * Q5. The buy-this-idea prefill stops being bounded to the event, so an
     * `?idea=` from the other family copies its title and price onto the form.
     */
    name: "Q5-11. the purchase prefill reads a gift idea from any family",
    file: "src/app/add-purchase/purchase-form.tsx",
    from: `            .eq("id", ideaId).in("christmas_recipient_id", recipientIds).maybeSingle()`,
    to: `            .eq("id", ideaId).maybeSingle()`,
    suites: ["scripts/gift-idea-lifecycle.test.mjs"],
  },
];

function runSuite(suite) {
  try {
    execFileSync(process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        /*
         * THE SAME WAY `test:all` RUNS THEM.
         *
         * Suites that render components import `.tsx`, which Node cannot load
         * without this hook -- and a suite that cannot even load EXITS NON-ZERO,
         * which this runner would have read as "the mutation was caught". That
         * is the one failure mode a mutation harness must not have: it reports
         * a hole in the tests as proof there isn't one. Passing the hook to
         * every suite costs nothing (it only claims `.tsx`) and removes the
         * chance of a false catch entirely.
         */
        "--import", "./scripts/dom/tsx-hook-register.mjs",
        "--test", suite,
      ],
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

// An optional argument runs one family of mutations -- `node scripts/mutation-check.mjs Q4`
// -- while no argument runs every one of them, which is what the gate does.
const only = process.argv[2] ?? "";
const selected = only ? MUTATIONS.filter((m) => m.name.startsWith(only)) : MUTATIONS;
if (only && selected.length === 0) {
  console.error(`No mutation name starts with "${only}".`);
  process.exit(1);
}

let caught = 0;
const survived = [];

for (const mutation of selected) {
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

// THE DENOMINATOR IS WHAT WAS RUN, NOT WHAT EXISTS. See mutation-summary.mjs
// for the sentence itself and for the reading it used to produce.
console.log("\n" + summariseMutationRun({
  caught,
  selectedCount: selected.length,
  totalCount: MUTATIONS.length,
  filter: only,
}));
if (survived.length > 0) {
  console.log("Survivors:");
  for (const name of survived) console.log(`  - ${name}`);
}
process.exit(survived.length === 0 ? 0 : 1);
