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
