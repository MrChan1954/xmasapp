/**
 * PHASE 5, AT THE APPLICATION LAYER.
 *
 * The database refuses to let one family read or write another (migrations
 * 034-038, rehearsed against real PostgreSQL). These tests are about the half
 * that lives in this repository: that every request says which family it is
 * about, that nothing resolves a membership by guessing, and that a person can
 * always tell which family is on screen.
 *
 * Read as SOURCE, not as behaviour, for the same reason the other suites here
 * do: these are server components and route handlers that need a live Supabase
 * and a browser to run. What can be proved from the source is that the wiring
 * exists and that the dangerous shapes do not.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

/** Git stores LF and checks out CRLF, so normalise before matching anything. */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** The same source with its commentary removed, so prose ABOUT a rule is never mistaken for a breach of it. */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

describe("every request says which family it is about", () => {
  test("the server client sends the Area as a header", () => {
    const source = read("src/utils/supabase/server.ts");
    assert.match(source, /x-area-id/);
    assert.match(source, /AREA_COOKIE/);
  });

  test("and so does the browser client, which talks to PostgREST directly", () => {
    const source = read("src/utils/supabase/client.ts");
    assert.match(source, /x-area-id/);
  });

  test("the header is not treated as authority anywhere in the app", () => {
    // It names a family; it does not grant one. `claim_active_area` checks the
    // membership table, and the comment saying so has to stay with the code
    // that sends it or the next reader will assume the opposite.
    const source = read("src/utils/supabase/server.ts");
    assert.match(source, /NOT A PERMISSION/i);
  });
});

describe("nothing resolves a membership by guessing", () => {
  const source = read("src/utils/supabase/current-member.ts");

  test("the single-row assumption is gone", () => {
    // `maybeSingle()` on a query that can now return two rows is the exact bug
    // Areas introduce: it either throws or answers about the wrong family.
    // The CALL, not the word: the comment above the function explains why it
    // used to be there and has to keep saying so.
    assert.ok(!withoutComments(source).includes(".maybeSingle("),
      "current-member.ts must not assume one membership");
  });

  test("two memberships and no choice made resolves to none, not to one of them", () => {
    assert.match(source, /rows\.length === 1/);
    assert.match(source, /chosen \?\? null/);
  });

  test("and the choice is read from the remembered Area", () => {
    assert.match(source, /AREA_COOKIE/);
    assert.match(source, /area_id === remembered/);
  });
});

describe("an account with no family is offered one", () => {
  test("the dashboard renders the setup screen rather than an empty dashboard", () => {
    const source = read("src/app/page.tsx");
    // `needsSetup` until Q19; `areaEntryFor` since, because the front door has
    // three answers rather than two and the middle one -- families, but no
    // valid choice among them -- had nowhere to live in a boolean.
    assert.match(source, /areaEntryFor/);
    assert.ok(source.includes("<CreateAreaForm first />"));
  });

  test("the setup screen creates the family, the person and the administrator together", () => {
    const source = read("src/app/api/areas/route.ts");
    assert.match(source, /create_area/);
    assert.match(source, /p_person_name/);
  });

  test("and an account that HAS a family never sees it", () => {
    // The setup screen is the absence of a family, not a permission check: it
    // must be guarded by the entry classification and nothing else.
    const source = read("src/app/page.tsx");
    const branch = source.slice(source.indexOf('if (entry === "onboarding")'));
    const create = branch.indexOf("<CreateAreaForm first />");
    assert.ok(create > -1, "the setup screen should be rendered from the onboarding branch");
    // Nothing between the branch and the form may end it, so the form is
    // genuinely inside the no-family case rather than merely after it.
    assert.ok(!branch.slice(0, create).includes('if (entry === "chooser")'));
  });

  test("and the root still redirects for NO family reason whatsoever", () => {
    /*
     * "/" is the PWA start_url and the one route that must resolve to itself
     * -- historically it was how the front door kept ending up inside
     * Christmas. This used to be "never redirects at all", and Q19 gave it one
     * legitimate exception: an account the DATABASE has not let into Gift
     * Planner has no dashboard to be shown instead, and is sent to the screen
     * that explains itself.
     *
     * So the rule is narrower rather than gone: exactly one redirect, and its
     * argument comes from `destinationFor` -- never from an Area, a membership
     * or an event. All three Area outcomes are still RENDERED.
     */
    const source = read("src/app/page.tsx");
    const calls = source.match(/\bredirect\([^)]*\)/gu) ?? [];
    assert.deepEqual(calls, ["redirect(destination)"],
      "the only redirect from the root is the global account status");
    assert.match(source, /const destination = destinationFor\(status\.state, HOME_PATH\)/u);
    // All three Area outcomes still RENDER. 053 added an invitation above two
    // of them, which changes what they render and not whether they redirect.
    assert.match(source, /if \(entry === "onboarding"\) \{/u);
    assert.match(source, /<CreateAreaForm first \/>/u);
    assert.ok(source.includes('if (entry === "chooser") return <ChooserWithInvitations areas={areas} />;'));
    assert.match(source, /<AreaChooser areas=\{areas\} \/>/u);
  });

  test("and an approved account is never signed out for having no family", () => {
    /*
     * THE DEFECT Q19 EXISTS TO REMOVE, pinned at the two places that used to
     * commit it. Signing in read `app_members`, found nothing, and called
     * `signOut()`; so did the auth callback. Under public sign-up that is
     * everybody, for the first few minutes of their account.
     */
    for (const path of ["src/app/login/page.tsx", "src/app/auth/callback/route.ts", "src/app/account-setup/page.tsx"]) {
      const source = withoutComments(read(path));
      assert.ok(!/auth\.signOut\(\)/u.test(source),
        `${path} must not sign anybody out for lacking a family`);
    }
  });
});

describe("a person can always tell which family is on screen", () => {
  const menu = read("src/app/components/account-menu.tsx");

  test("the account menu names the current family", () => {
    assert.match(menu, /active && /);
    assert.match(menu, /\{active\.name\}/);
  });

  test("the switcher lists every family, marking the current one", () => {
    assert.match(menu, /choices\.map/);
    // Marking the current one is now the radio group's job: the item whose
    // value matches the group's value is the checked one, and Radix writes
    // aria-checked from that.
    assert.match(menu, /<MenuRadioGroup value=\{active\?\.id \?\? ""\}>/);
    assert.match(menu, /value=\{choice\.id\}/);
    const popover = read("src/app/components/popover.tsx");
    assert.match(popover, /<DropdownMenuRadioItem/);
  });

  test("but the LIST is not offered when there is nowhere to switch to", () => {
    /*
     * A chooser with one entry is a control that can only ever do nothing, so
     * the list is still gated on there being a choice.
     *
     * WHAT CHANGED, AND WHY THE ASSERTION MOVED. This used to gate the whole
     * SECTION -- and the section is also where the way to start another family
     * lives. So somebody with one family was shown no family section at all,
     * and `/areas/new` became reachable only by typing it: the people who had
     * never started a second family were the only ones who could not find out
     * how. The two questions are separate now, and this one is unchanged.
     */
    assert.match(menu, /\{canSwitch && \([\s\S]{0,200}?choices\.map/);
  });

  test("and the SECTION appears whenever either question has an answer", () => {
    assert.match(menu, /\{\(canSwitch \|\| canCreate\) && \(/);
    // Proved as behaviour in `src/lib/areas.test.ts`, and swept across the
    // screens in `scripts/area-discoverability.test.mjs`.
    assert.match(menu, /CREATE_AREA_PATH/);
  });

  test("and switching goes through the route that writes the cookie", () => {
    const hook = read("src/app/components/use-areas.ts");
    assert.match(hook, /"\/api\/areas"/);
    assert.match(hook, /method: "PUT"/);
  });

  test("switching reloads rather than re-rendering in place", () => {
    // Half the app under the new family and half still holding the old one's
    // rows is a window in which two families are on screen at once.
    const hook = read("src/app/components/use-areas.ts");
    assert.match(hook, /window\.location\.assign/);
  });
});

describe("the three settings scopes are wired, not just described", () => {
  test("the account menu points at the global scope", () => {
    const menu = read("src/app/components/account-menu.tsx");
    assert.match(menu, /href="\/settings"/);
  });

  test("the global screen says it follows the person", () => {
    const source = read("src/app/settings/settings-screen.tsx");
    assert.match(source, /scopeReminder\("global"/);
  });

  test("the family screen says it applies to one family, and names it", () => {
    const source = read("src/app/settings/family/family-settings-screen.tsx");
    assert.match(source, /scopeReminder\("area", areaName\)/);
    assert.match(source, /title=\{areaName\}/);
  });

  test("renaming is authorised by the RPC, not by hiding the field", () => {
    const route = read("src/app/api/areas/name/route.ts");
    assert.match(route, /set_area_name/);
    const screen = read("src/app/settings/family/family-settings-screen.tsx");
    assert.match(screen, /NOTHING HERE IS THE PERMISSION/);
  });

  test("and admin status is read from THIS family's membership", () => {
    // A global role would make somebody an administrator of a family they had
    // merely joined.
    const page = read("src/app/settings/family/page.tsx");
    assert.match(page, /const isAdmin = member\?\.role === "admin" && member\?\.area_id === areaId;/,
      "the role must come from the membership in the family on screen");
  });
});

describe("no family is named in the source", () => {
  const FILES = [
    "src/lib/areas.ts",
    "src/lib/settings-scopes.ts",
    "src/app/areas/new/create-area-form.tsx",
    "src/app/settings/settings-screen.tsx",
    "src/app/settings/family/family-settings-screen.tsx",
    "src/utils/supabase/areas-server.ts",
  ];

  test("nothing ships a real family's name as a default or a placeholder", () => {
    // "The Taylors" appears in areas.ts only as an example inside a comment or
    // a placeholder attribute; a real one must never be a fallback value.
    for (const file of FILES) {
      const source = read(file);
      assert.ok(!/Jade|Kirsten|Paige/i.test(source), `${file} names a real person`);
    }
  });

  test("and a missing name renders as a neutral word, never 'undefined'", () => {
    const source = read("src/lib/areas.ts");
    assert.match(source, /return trimmed && trimmed\.length > 0 \? trimmed : "Your family"/);
  });
});

// ---------------------------------------------------------------------------
// POST-PHASE-5 HARDENING
//
// Migrations 034-038 are live. These are the gaps that only became visible once
// they were: places where the application still asked a question that has no
// answer for a login belonging to two families, or asked it of every family at
// once. None of them can show one family's data to somebody outside it -- row
// level security still refuses that. What they do is put two families on one
// screen, or in one audience, which is its own kind of wrong.
// ---------------------------------------------------------------------------

describe("a screen shows ONE family, not every family the reader belongs to", () => {
  const loader = read("src/utils/supabase/birthdays-server.ts");

  test("the birthday loaders scope EVERY read to the Area on screen", () => {
    /*
     * Row level security returns every Area the reader belongs to, which is
     * correct as a permission and wrong as a screen: unscoped, a login in two
     * families gets both families' people interleaved into one list.
     *
     * ASSERTED PER QUERY, NOT AS A COUNT. Splitting the source on `.from("`
     * gives one chunk per query that ends exactly where the next one begins,
     * so a chain that has lost its filter cannot be excused by the chain
     * underneath it still having one. A count let precisely that through.
     */
    // The two tables that CARRY an Area. Everything else in these loaders --
    // recipients, purchases, gift ideas -- reaches its Area through an event,
    // and is read with `.in("christmas_event_id", eventIds)` from the
    // already-scoped event list. That is migration 036's own argument, and it
    // is why those tables have no area_id to filter on.
    const AREA_SCOPED = ["people", "events"];
    const chunks = loader.split('.from("').slice(1);
    let checked = 0;

    for (const chunk of chunks) {
      const table = chunk.slice(0, chunk.indexOf('"'));
      if (!AREA_SCOPED.includes(table)) continue;
      checked += 1;
      assert.match(chunk, /\.eq\("area_id", areaId\)/u,
        `this read of ${table} is not scoped to the Area on screen`);
    }

    // Six: people and events on the dashboard; people, events, the contributor
    // pool and the buyer names in the workspace. A seventh would be a read that
    // nobody has thought about yet, and it would arrive already scoped.
    assert.equal(checked, 6, "every Area-owned read in the birthday loaders is checked");
  });

  test("and so does every other loader whose screen is one family", () => {
    /*
     * The same sweep, applied to the loaders behind the dashboard, the events
     * list, the People directory and one person's profile. Each backs a screen
     * about ONE family, and row level security hands back every family the
     * reader belongs to unless the query says otherwise.
     */
    const AREA_OWNED = ["people", "events"];
    for (const file of ["src/utils/supabase/events-server.ts", "src/utils/supabase/people-server.ts"]) {
      const source = read(file);
      let checked = 0;
      for (const chunk of source.split('.from("').slice(1)) {
        const table = chunk.slice(0, chunk.indexOf('"'));
        if (!AREA_OWNED.includes(table)) continue;
        // A read narrowed to ids that came from an already-scoped query is
        // scoped by construction; `.in("id", ...)` is that shape.
        if (/\.in\("id",/u.test(chunk.slice(0, 300))) continue;
        checked += 1;
        assert.match(chunk, /\.eq\("area_id", areaId\)/u,
          `${file}: this read of ${table} is not scoped to the Area on screen`);
      }
      assert.ok(checked > 0, `${file} must have at least one Area-owned read to check`);
    }
  });
});

describe("a notification reaches one family", () => {
  const dispatch = read("src/lib/notification-dispatch.ts");

  test("the Area is resolved from the queued row's own subject", () => {
    assert.match(dispatch, /export async function resolveSubjectAreaId\(/u);
    // Three routes, because a queued row reaches its family three ways: through
    // its event, through the person a reminder is about, or through the
    // membership a budget summary belongs to.
    assert.match(dispatch, /if \(eventId\) \{/u);
    assert.match(dispatch, /kind === "birthday_reminder"/u);
    assert.match(dispatch, /kind === "birthday_budget_month"/u);
  });

  test("and the audience is narrowed to it", () => {
    // The dispatcher reads memberships with the ADMIN client, which bypasses
    // row level security by design -- it has to know members it is not. That is
    // exactly why the Area has to be applied by hand here, and why leaving it
    // out would push one family's purchase to another family's phones.
    assert.match(dispatch, /\.eq\("active", true\)\.eq\("area_id", areaId\)/u);
    assert.match(dispatch, /const areaId = await resolveSubjectAreaId\(kind, subjectId, eventId, admin\);/u);
  });

  test("two families do not share a cached audience", () => {
    assert.match(dispatch, /FAMILY_WIDE\}:\$\{areaId \?\? "none"\}/u);
  });
});

describe("a SECURITY DEFINER reader is Area-scoped by hand, because no policy will do it", () => {
  const areaAuth = read("supabase/migrations/202608100039_area_aware_contributor_permissions.sql");
  const body = (name) => {
    const start = areaAuth.indexOf("create or replace function public." + name);
    assert.ok(start > 0, name + " must be defined");
    return areaAuth.slice(start, areaAuth.indexOf("$$;", start));
  };

  test("list_gift_ideas checks the caller belongs to the recipient's Area", () => {
    // Migration 036 scoped every POLICY. A definer routine is precisely what
    // bypasses a policy, so 036 could not reach this one -- and until 039 any
    // active member of any family could read any recipient's gift ideas:
    // titles, prices, links, notes, and who suggested them.
    const listIdeas = body("list_gift_ideas");
    assert.match(listIdeas, /public\.area_of_recipient\(p_christmas_recipient_id\)/u);
    assert.match(listIdeas, /not public\.is_area_member\(owning_area\)/u);
    assert.match(listIdeas, /public\.is_own_birthday_recipient\(p_christmas_recipient_id\)/u);
  });
});

describe("privileged operations derive their Area rather than being told it", () => {
  const areaAuth = read("supabase/migrations/202608100039_area_aware_contributor_permissions.sql");

  test("set_person_birthday reads the Area off the person being edited", () => {
    const start = areaAuth.indexOf("create or replace function public.set_person_birthday");
    const body = areaAuth.slice(start, areaAuth.indexOf("$$;", start));
    assert.match(body, /target_area := public\.area_of_person\(p_person_id\);/u);
    assert.match(body, /public\.is_area_admin\(target_area\)/u);
    assert.match(body, /public\.is_area_contributor_member\(target_area\)/u);

    /*
     * AND NOT FROM THE REQUEST.
     *
     * `is_app_admin()` answers about the Area an `x-area-id` header claimed,
     * through the PostgREST pre-request hook in 038. That hook is a global
     * request side effect: if it ever stops running, everything that depends on
     * it quietly changes answer. A check that reads its Area off the row it is
     * about cannot change answer, because the person being edited belongs to
     * the family they belong to in every request there has ever been.
     */
    assert.ok(!body.includes("is_app_admin"), "it must not ask the global question");
    assert.ok(!body.includes("acting_area"), "nor read the acting Area");
  });

  test("the hook is still there for the fifty routines written before Areas", () => {
    // Not removed -- it is what lets `create_person`, `record_purchase` and the
    // rest keep working for a login in two families. It is simply no longer
    // what decides a birthday edit.
    const acting = read("supabase/migrations/202608100038_acting_area.sql");
    assert.match(acting, /pgrst\.db_pre_request/u);
    assert.match(read("src/utils/supabase/server.ts"), /x-area-id/u);
  });

  test("and there is a way to find out whether it actually works", () => {
    /*
     * IT CANNOT BE PROVED FROM THE SQL EDITOR, which is not PostgREST and never
     * runs the hook, nor with the service key, which has no membership for the
     * hook to check. It needs a real signed-in member going through PostgREST,
     * which is what this script is.
     */
    const script = read("scripts/verify-pre-request-hook.mjs");
    assert.match(script, /rpc\/acting_area/u);
    assert.match(script, /x-area-id/u);
    for (const probe of [
      "no x-area-id header leaves no acting Area",
      "x-area-id naming an Area the caller IS in becomes the acting Area",
      "x-area-id naming an Area the caller is NOT in is ignored",
      "a malformed x-area-id is ignored and the request still succeeds",
    ]) {
      assert.ok(script.includes(probe), "the verification must probe: " + probe);
    }
    assert.ok(!script.includes("SUPABASE_SECRET_KEY"),
      "and must never use the service key, which would prove nothing");
  });
});

describe("Family access is one family's, even though it runs as the service role", () => {
  const gate = read("src/utils/supabase/family-access-admin.ts");
  const route = read("src/app/api/admin/family-access/route.ts");
  const screen = read("src/app/more/family-access/family-access-client.tsx");

  test("the permission check resolves the family on screen, and returns it", () => {
    /*
     * IT USED TO REQUIRE EXACTLY ONE MEMBERSHIP, which locked out the very
     * person the switcher exists for: administer Alpha, belong to Bravo, and
     * the count was two, so Family Access refused them in BOTH.
     *
     * Now it asks `getCurrentMember` -- the same resolver every other screen
     * uses -- so there is one answer to "which family is this about" and not
     * two that can disagree.
     */
    assert.match(gate, /const \{ user, member \} = await getCurrentMember\(\);/u);
    assert.ok(!gate.includes("memberships.length !== 1"),
      "the exactly-one-membership lockout must be gone");
    assert.ok(!gate.includes('.from("app_members")'),
      "and the gate must not resolve a membership by hand");

    // The role is read from THAT membership, so administering one family says
    // nothing about another.
    assert.match(gate, /member\.role !== "admin"/u);
    assert.match(gate, /!member\.active/u, "and a deactivated membership is refused");
    assert.match(gate, /const areaId = \(member\.area_id as string \| null\) \?\? null;/u);
    assert.match(gate, /areaId,\n  \};/u, "and hands it to the route");
  });

  test("a member who is not this family's admin is refused exactly like a stranger", () => {
    // One message for both, so nobody can probe which families an account is in.
    const refusals = [...gate.matchAll(/new FamilyAccessError\(\s*403,\s*\n?\s*"([^"]+)"/gu)]
      .map((match) => match[1]);
    assert.ok(refusals.length >= 1);
    assert.ok(refusals.some((message) => /admin/iu.test(message)));
  });

  test("READING, GRANTING AND REVOKING ARE THE DATABASE'S NOW, not this route's", () => {
    /*
     * MIGRATION 052 IS WHAT SHRANK THIS ROUTE FROM 855 LINES TO A COUPLE OF
     * HUNDRED, and the shrinkage IS the security work. Everything below used to
     * be done here with the service role -- which bypasses row level security
     * AND migration 037's write barrier, so every rule it obeyed was a rule it
     * applied to itself. Now the rules are the database's own.
     *
     * The screen calls the three routines directly, through the caller's OWN
     * session, where `is_area_admin(acting_area())` is checked by the routine.
     */
    assert.match(screen, /rpc\("list_area_access"\)/u);
    assert.match(screen, /rpc\("revoke_area_access"/u);
    assert.ok(screen.includes('"/api/admin/family-access"'),
      "and the Admin-API actions still go through the route");

    /*
     * PHASE 5A MOVED THE GRANT, AND ONLY THE GRANT, BEHIND THE ROUTE -- and it
     * is still not the route's write. `grant_area_access` runs there with the
     * ADMINISTRATOR'S OWN SESSION, so `require_acting_area` and
     * `is_area_admin` still decide; handing it the service role would remove
     * the only thing checking it.
     *
     * Why it had to move: inviting was two presses, and the second one was
     * offered only on a seat the screen had labelled "Awaiting sign-up" -- a
     * label that exists to say the address has no Gift Planner account. Making
     * the invitation and delivering it one act is what removes the
     * intermediate state an administrator could read the answer off.
     */
    assert.ok(!withoutComments(screen).includes('rpc("grant_area_access"'));
    assert.match(route, /session\.rpc\("grant_area_access"/u);
    assert.ok(!route.includes('admin.rpc("grant_area_access"'),
      "the service role must never call a routine that authorises itself from auth.uid()");
  });

  test("AND THE ROUTE WRITES NOTHING AT ALL ANY MORE", () => {
    /*
     * THE STRONGEST STATEMENT THIS FILE CAN MAKE ABOUT IT. A read with the
     * service role that forgets an Area shows one family another family's rows;
     * a WRITE that forgets one changes them. There are no writes left to
     * forget: `app_members` is written by `grant_area_access`,
     * `revoke_area_access` and `claim_app_member`, and by nothing else anywhere.
     */
    for (const mutator of [".insert(", ".update(", ".upsert(", ".delete("]) {
      assert.ok(!route.includes(mutator),
        `the route must not ${mutator} -- granting and revoking are RPCs now`);
    }
  });

  test("NO PROJECT-WIDE AUTH ENUMERATION SURVIVES", () => {
    /*
     * `listAllAuthUsers` fetched up to a hundred pages of EVERY ACCOUNT ON THE
     * INSTALLATION to answer a question about one family, and it is how Family
     * Access could tell whether an address had an account somewhere its
     * administrator cannot see. `list_area_access()` takes no email parameter,
     * so there is nothing left to point anywhere.
     *
     * `getUserById` is deliberately still allowed: it asks about the single
     * account a seat this Area owns is already attached to, which discloses
     * nothing the seat did not already say.
     */
    // The CODE, not the commentary: both files explain what used to be here,
    // and prose about a removed enumeration is not one.
    assert.ok(!withoutComments(route).includes("listAllAuthUsers"),
      "the enumeration must be gone from the route");
    assert.ok(!withoutComments(gate).includes("listAllAuthUsers"),
      "and from the helper that used to export it");
    assert.ok(!withoutComments(route).includes("listUsers"), "and no hand-rolled replacement");
    assert.ok(!withoutComments(screen).includes("listUsers"));
  });

  test("THE SERVICE ROLE READS NO TABLE AT ALL ANY MORE", () => {
    /*
     * IT USED TO READ TWO, AND SCOPE THEM BY HAND. Nothing underneath will do
     * that: the service role bypasses row level security, and migration 037's
     * write barrier exempts a caller with no `auth.uid()` -- which is exactly
     * what the service role is. Scoping there was the only scoping there was,
     * and an `.eq("area_id", areaId)` that goes missing in an edit is a family
     * reading another family's rows.
     *
     * Phase 5A deleted the problem instead of guarding it. Every read is
     * `list_area_access()` through the administrator's own session, and that
     * routine TAKES NO AREA PARAMETER -- so there is no filter left to forget
     * and nothing to point elsewhere.
     */
    assert.deepEqual(route.split('.from("').slice(1), [], "no table access in this route");
    assert.ok(!route.includes('.eq("area_id"'), "and no hand-written Area filter to lose");
    assert.match(route, /session\.rpc\("list_area_access"\)/u);
  });

  test("a person from another family is not found rather than refused", () => {
    /*
     * They are ABSENT from `list_area_access()`'s answer, because it returns
     * the acting Area's people and nothing else. Every caller here treats
     * absent as the same 404 an id that names nobody gets, which tells the
     * caller nothing about another family.
     */
    assert.match(route, /\.find\(\(candidate\) => candidate\.person_id === personId\)/u);
    assert.match(route, /This family member was not found/u);

    const runtime = read("src/lib/family-invitations.ts");
    assert.match(runtime, /rows\.find\(\(candidate\) => candidate\.person_id === request\.personId\) \?\? null/u);
    assert.match(runtime, /return \{ ok: false, status: 404, message: NOT_IN_THIS_FAMILY \}/u);
  });

  test("THE ADDRESS IS CHECKED TWICE, AND THE DATABASE HAS THE LAST WORD", () => {
    /*
     * `email` came back into the body in Phase 5A, because inviting is one
     * press again and the administrator types the address in the same act. It
     * is not trusted for being there: `validateEmail` checks its shape in the
     * runtime, and `grant_area_access` checks it again in the database, where
     * the unique index on `(area_id, lower(email))` and the refusal to
     * re-address a CLAIMED seat are the rules that actually bind.
     *
     * `delivery` and `role` stay gone. There is no account to create from a
     * request body and no role to choose.
     */
    const body = route.slice(route.indexOf("async function readBody("));
    assert.match(body, /const allowedKeys = new Set\(\["action", "personId", "email"\]\);/u);
    assert.ok(!body.includes('"role"'), "no role may be chosen from a request");
    assert.ok(!body.includes('"delivery"'));

    const runtime = read("src/lib/family-invitations.ts");
    assert.match(runtime, /const email = validateEmail\(request\.email\);/u);
    assert.match(runtime, /if \(!email\.ok\) return \{ ok: false, status: 400/u,
      "and a malformed address never reaches Auth or the database");
  });
});

describe("nothing in the app assumes one login means one membership", () => {
  /**
   * THE SHAPE AREAS MADE DANGEROUS.
   *
   * `.maybeSingle()` does not return the first row when a query matches two --
   * it ERRORS. Every caller in this application reads that error as "not a
   * member" and fails closed, so a login that belongs to two families silently
   * loses whatever the query was for: their login, their notification settings,
   * their admin controls, the Payment Log, the purchase form.
   *
   * Two shapes are safe, and this sweeps for anything that is neither:
   *
   *   RESOLVED   `getCurrentMember` / `getCurrentMemberClient` -- picks the
   *              membership for the family on screen.
   *   COUNTED    `.limit(1)` before `.maybeSingle()` -- for the genuinely
   *              Area-blind question "does this login belong ANYWHERE", which
   *              is what login, the auth callback and account setup ask.
   */
  const sourceFiles = () => {
    const found = [];
    const walk = (relative) => {
      for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${relative}/${entry.name}`);
        else if (/\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name)) {
          found.push(`${relative}/${entry.name}`);
        }
      }
    };
    walk("src");
    return found;
  };

  test("every membership query keyed on a LOGIN is resolved or explicitly limited", () => {
    /*
     * Only a query filtered by `user_id` can match more than one row: one login
     * may hold a membership in each family. A lookup by `id` or by
     * `person_id` is unique by construction -- the primary key, and migration
     * 033's one-membership-per-person index -- so `maybeSingle()` is exactly
     * right for those and flagging them would be noise.
     *
     * Each query is bounded at the next `;` OR the next `.from(`, whichever
     * comes first, so a safe query cannot be blamed for a sibling's
     * `maybeSingle()` further down the same Promise.all.
     */
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = read(file);
      for (const chunk of source.split('.from("app_members")').slice(1)) {
        const statement = chunk.split(/;|\.from\(/u)[0];
        if (!statement.includes('.eq("user_id"')) continue;
        if (!statement.includes(".maybeSingle()")) continue;
        if (statement.includes(".limit(1)")) continue;
        offenders.push(`${file} uses maybeSingle() on a login-keyed membership query without limit(1)`);
      }
    }
    assert.deepEqual(offenders, [],
      "maybeSingle() on a login-keyed membership query ERRORS for somebody in two families");
  });

  test("and the sweep is looking at something -- there are login-keyed queries to check", () => {
    // A sweep that matches nothing passes for the wrong reason.
    const checked = sourceFiles().flatMap((file) =>
      read(file).split('.from("app_members")').slice(1)
        .map((chunk) => chunk.split(/;|\.from\(/u)[0])
        .filter((statement) => statement.includes('.eq("user_id"')));
    assert.ok(checked.length >= 3, `expected several login-keyed queries, found ${checked.length}`);
    // And every one of them limits, because none of them may assume.
    assert.ok(checked.every((statement) =>
      !statement.includes(".maybeSingle()") || statement.includes(".limit(1)")));
  });

  test("and the identity lookups go through the one resolver", () => {
    // These need to know WHICH person and WHICH role, so an existence check is
    // not enough -- they have to resolve the family on screen.
    for (const [file, resolver] of [
      ["src/utils/supabase/birthdays-server.ts", "getCurrentMember"],
      ["src/utils/supabase/people-server.ts", "getCurrentMember"],
      ["src/utils/supabase/events-server.ts", "getCurrentMember"],
      ["src/utils/supabase/payment-log-server.ts", "getCurrentMember"],
      ["src/utils/supabase/notifications-server.ts", "getCurrentMember"],
      ["src/utils/supabase/family-access-admin.ts", "getCurrentMember"],
      ["src/app/owed/owed-data.ts", "getCurrentMemberClient"],
      ["src/app/family-context.tsx", "getCurrentMemberClient"],
      ["src/app/add-purchase/purchase-form.tsx", "getCurrentMemberClient"],
      ["src/app/more/notifications/page.tsx", "getCurrentMemberClient"],
    ]) {
      assert.match(read(file), new RegExp(`${resolver}\\(`, "u"),
        `${file} must resolve the membership for the family on screen`);
    }
  });

  test("the two resolvers refuse to guess, rather than picking one", () => {
    for (const file of [
      "src/utils/supabase/current-member.ts",
      "src/utils/supabase/current-member-client.ts",
    ]) {
      const source = read(file);
      assert.match(source, /rows\.length === 1/u, "one membership is answered directly");
      assert.match(source, /chosen \?\? null/u, "and several with no choice made resolve to none");
      // Both files EXPLAIN maybeSingle() at length in prose, so the ban has to
      // be read against the code alone, or the explanation trips it.
      assert.ok(!withoutComments(source).includes(".maybeSingle("),
        `${file} must not assume one membership`);
    }
  });
});

describe("a legacy link cannot carry somebody into another family", () => {
  /**
   * FOUND IN LIVE BROWSER QA, not by reading the source.
   *
   * `/people/<id>` falls back to a legacy redirect when the id is not a person
   * the reader can see -- and that redirect resolved "Christmas 2026" by year
   * alone. Row level security narrowed it to the reader's own families, which
   * is the right permission and the wrong question: standing in the second
   * family, a stale link redirected into the FIRST family's Christmas.
   *
   * No data crossed -- the destination authorises itself by its own Area -- but
   * an app must not steer somebody out of the family they are looking at, and
   * `maybeSingle()` on a query that can match twice is the same bug this whole
   * phase exists to remove.
   */
  const source = read("src/utils/supabase/events-server.ts");
  const legacy = source.match(/export async function legacyChristmasEventId[\s\S]*?\n\}/u)?.[0];

  test("the legacy Christmas is resolved inside ONE Area", () => {
    assert.ok(legacy, "legacyChristmasEventId must exist");
    assert.match(legacy, /rememberedAreaId\(\)/u, "it must ask which family is on screen");
    assert.match(legacy, /\.eq\("area_id", areaId\)/u, "and filter by it");
  });

  test("and it refuses rather than guessing when no family is selected", () => {
    assert.match(legacy, /if \(!areaId\) return null;/u,
      "with no Area chosen the caller falls back to the dashboard, not to somebody else's event");
  });

  test("IT READS events, NOT the compatibility view, which has no area_id", () => {
    // The first version of this fix filtered `christmas_events` by area_id.
    // That view predates Areas and exposes only id, year, name, created_at,
    // so the filter was a 42703: every legacy redirect would have degraded to
    // the dashboard for everybody, and every source-text test still passed.
    // `scripts/migration-execution.test.mjs` now runs the shape for real.
    assert.match(legacy, /\.from\("events"\)/u, "it must read the events table");
    assert.ok(!legacy.includes('from("christmas_events")'),
      "the compatibility view cannot be filtered by Area");
    assert.match(legacy, /\.eq\("event_type", "christmas"\)/u,
      "and must say which kind of event it means, since events holds them all");
  });

  test("the query is limited, because two families may each have a Christmas 2026", () => {
    // Without this, `maybeSingle()` ERRORS the moment a second Area has one.
    assert.match(legacy, /\.limit\(1\)/u);
  });
});

describe("no Area-sensitive lookup assumes one family", () => {
  /**
   * THE SWEEP WIDENED.
   *
   * The original one only inspected `app_members` queries keyed on `user_id`,
   * because that was the shape Areas obviously broke. The Christmas defect was
   * the same class of bug in a table nobody thought to sweep: a lookup whose
   * result set grows by one every time a family is added, resolved with
   * `maybeSingle()` and no Area filter.
   *
   * `events`, `areas` and `people` are all per-Area, so a query against them
   * that expects at most one row must say which Area it means.
   */
  const AREA_SCOPED_TABLES = ["events", "areas", "people", "christmas_events"];

  const bounded = (chunk) => chunk.split(/;|\.from\(/u)[0];

  /** Every product source file. Declared here rather than shared, so this
   *  sweep keeps working wherever it is moved to. */
  const sourceFiles = () => {
    const found = [];
    const walk = (relative) => {
      for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${relative}/${entry.name}`);
        else if (/\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name)) {
          found.push(`${relative}/${entry.name}`);
        }
      }
    };
    walk("src");
    return found;
  };

  test("every single-row read of a per-Area table names the Area, or a unique id", () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const source = withoutComments(read(file));
      for (const table of AREA_SCOPED_TABLES) {
        for (const chunk of source.split(`.from("${table}")`).slice(1)) {
          const statement = bounded(chunk);
          if (!statement.includes(".maybeSingle()") && !statement.includes(".single()")) continue;

          // A lookup by primary key is unique whatever the Area, and so is one
          // already narrowed to an Area.
          const byUniqueId = /\.eq\("id",/u.test(statement);
          const byArea = /\.eq\("area_id",/u.test(statement);
          const limited = statement.includes(".limit(1)");
          if (byUniqueId || (byArea && limited)) continue;

          offenders.push(`${file}: ${table} resolved to one row without an Area`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      "a per-Area table read with maybeSingle() ERRORS, or answers about the wrong family, once a second Area exists");
  });

  test("and the sweep has something to sweep", () => {
    // A sweep that matches nothing passes for the wrong reason.
    let seen = 0;
    for (const file of sourceFiles()) {
      const source = withoutComments(read(file));
      for (const table of AREA_SCOPED_TABLES) {
        seen += source.split(`.from("${table}")`).length - 1;
      }
    }
    assert.ok(seen >= 5, `expected several per-Area reads to inspect, found ${seen}`);
  });
});
