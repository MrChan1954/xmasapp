/**
 * THE BIRTHDAY PERSON'S OWN WISHLIST, AND THE AREA-AWARE PERMISSIONS AROUND IT.
 *
 * Two things landed together and are tested together, because they are the same
 * question asked twice: WHICH AREA IS THIS ABOUT?
 *
 *   039  Birthday editing and gift-idea reading stopped answering "somewhere"
 *        and started answering about one Area, derived from the row being acted
 *        on rather than from the request.
 *   040  The birthday person got a list of their own, in a table that has no
 *        way to reach the planning.
 *
 * HOW THESE READ. As SOURCE -- the migration SQL and the application files --
 * for the same reason every other suite in this directory does: the rules live
 * in row level security and SECURITY DEFINER routines, and running them needs a
 * live PostgreSQL, two Areas, two logins and a browser. What CAN be proved here
 * is that the rule is written, that it is written in the one place that decides,
 * and that the shapes which would break it are absent.
 *
 * The behavioural half -- what `canWriteWishlist` and `toWishlistEntry` actually
 * do with every combination of Area and person -- is in
 * `src/lib/wishlist.test.ts`, where it can be executed rather than read.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
/** Git stores LF and checks out CRLF, so normalise before matching anything. */
const read = (...parts) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/gu, "\n");
const migrationsDirectory = join(root, "supabase", "migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();

const AREA_AUTH = "202608100039_area_aware_contributor_permissions.sql";
const WISHLIST = "202608100040_own_birthday_wishlist.sql";

const areaAuth = read("supabase", "migrations", AREA_AUTH);
const wishlist = read("supabase", "migrations", WISHLIST);

/**
 * One function's body, from `create or replace function public.<name>` to the
 * `$$;` that closes it.
 *
 * Slicing rather than searching the whole file is the point: a migration that
 * mentions `is_area_admin` in a comment three hundred lines away must not be
 * able to satisfy an assertion about what a particular routine checks.
 */
function functionBody(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.ok(start > 0, `${name} must be defined`);
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start, `${name} must be closed`);
  return sql.slice(start, end);
}

/** One policy, from `create policy "<name>"` to the statement's semicolon. */
function policyBody(sql, name) {
  const start = sql.indexOf(`create policy "${name}"`);
  assert.ok(start > 0, `the policy "${name}" must exist`);
  const end = sql.indexOf(";", start);
  return sql.slice(start, end);
}

// ===========================================================================
// 0. Nothing that is already applied has been touched
// ===========================================================================

describe("migrations 001-038 are applied and immutable", () => {
  test("039 and 040 are where they were, with Q2's work above them", () => {
    // Q2 added 041-043, Q3 added 044 and 045, Q5 added 046, Q6 added 047,
    // Q10 added 048 (a grant revoke; it defines no function and no policy),
    // Q11 added 049 (one `create or replace` on the audit-log Area stamper; no
    // table, policy, grant or trigger), and Q12 added 050 (two privacy columns
    // on `audit_log` and an own-birthday clause in its read policy; it does not
    // touch `birthday_wishlist_ideas`, whose own policies 040 still owns).
    // What matters here is POSITIONAL: that 039 and 040 have not moved and
    // nothing has been slipped in between them. The total is asserted as well,
    // so that a new migration is a deliberate edit to this line rather than
    // something that arrives unnoticed.
    // Q15 added 051 (three superseded routines dropped, and the blanket table
    // grant narrowed on `areas` and `birthday_wishlist_ideas`). It drops no
    // policy and changes no wishlist behaviour: 040 still owns every policy on
    // this table. What 051 DOES change here is the table grant, and that is
    // asserted below rather than left implied.
    assert.equal(migrationFiles.indexOf(WISHLIST), migrationFiles.indexOf(AREA_AUTH) + 1);
    assert.equal(migrationFiles.indexOf(AREA_AUTH), 38, "039 is the thirty-ninth migration");
    assert.equal(migrationFiles.length, 51);
  });

  test("no earlier migration mentions the new ones", () => {
    // An applied migration that has learned about 039 is an applied migration
    // somebody has edited.
    for (const name of migrationFiles.filter((n) => Number(n.slice(8, 12)) <= 38)) {
      const sql = read("supabase", "migrations", name).toLowerCase();
      for (const forbidden of ["birthday_wishlist_ideas", "is_area_contributor_member", "is_own_wishlist_person"]) {
        assert.ok(!sql.includes(forbidden), `${name} mentions ${forbidden}, so it has been edited`);
      }
    }
  });

  test("and both new migrations refuse to run out of order", () => {
    assert.match(areaAuth, /Migration 038 has not been applied/u);
    assert.match(wishlist, /Migration 039 has not been applied/u);
  });

  test("neither creates, deletes or rewrites a row of family data", () => {
    for (const [name, sql] of [[AREA_AUTH, areaAuth], [WISHLIST, wishlist]]) {
      /*
       * FUNCTION BODIES ARE NOT MIGRATION STATEMENTS.
       *
       * `set_person_birthday` updates `people` -- that is what the routine is
       * for, and it has done so since 026. What must not appear is a statement
       * the MIGRATION runs, once, against data that is already there. Stripping
       * the bodies is what tells the two apart.
       */
      const lower = sql.replace(/create or replace function[\s\S]*?\$\$;/gu, "").toLowerCase();
      for (const forbidden of [
        "drop table", "drop column", "truncate", "delete from public.",
        "update public.people", "update public.events", "update public.purchases",
        "update public.christmas_recipients", "update public.gift_ideas",
        "update public.contributors", "update public.settlements",
        "update public.purchase_allocations", "update public.app_members",
      ]) {
        assert.ok(!lower.includes(forbidden), `${name} must not ${forbidden}`);
      }
    }
  });
});

// ===========================================================================
// 1. PART 3 -- contributor birthday editing is Area-aware
// ===========================================================================

describe("a contributor may edit birthdays in THEIR OWN Area, and only there", () => {
  const contributor = functionBody(areaAuth, "is_area_contributor_member");
  const setBirthday = functionBody(areaAuth, "set_person_birthday");

  test("the eligibility check is asked about one Area", () => {
    assert.match(contributor, /is_area_contributor_member\(p_area_id uuid\)/u);
    assert.match(contributor, /m\.area_id = p_area_id/u, "the membership must be in that Area");
    assert.match(contributor, /p\.area_id = p_area_id/u, "and so must the person it is judged by");
    assert.match(contributor, /p\.is_family_contributor/u);
  });

  test("it is definer, pinned, and closed to anon", () => {
    assert.match(contributor, /security definer/u);
    assert.match(contributor, /set search_path = ''/u);
    assert.match(areaAuth, /revoke all on function public\.is_area_contributor_member\(uuid\) from public, anon;/u);
    assert.match(areaAuth, /grant execute on function public\.is_area_contributor_member\(uuid\) to authenticated;/u);
  });

  test("THE AREA COMES FROM THE PERSON BEING EDITED, not from the request", () => {
    // A contributor in Alpha editing a Bravo person resolves Bravo here, and is
    // then asked whether they are entitled in BRAVO. They are not.
    assert.match(setBirthday, /target_area := public\.area_of_person\(p_person_id\);/u);
    assert.match(setBirthday, /public\.is_area_admin\(target_area\)/u);
    assert.match(setBirthday, /public\.is_area_contributor_member\(target_area\)/u);
  });

  test("and it does not depend on the pre-request hook", () => {
    // THE POINT OF DERIVING IT. `is_app_admin()` answers about whichever Area
    // an `x-area-id` header claimed, and a privileged operation whose
    // authorization rests on a header having been honoured fails open the day
    // the hook stops running.
    assert.ok(!setBirthday.includes("is_app_admin"), "set_person_birthday must not ask the global question");
    assert.ok(!setBirthday.includes("acting_area"), "nor read the acting Area");
    assert.ok(!setBirthday.includes("is_family_contributor_member"), "nor the global contributor question");
  });

  test("a refusal names no Area and distinguishes no case", () => {
    // A person that does not exist and a person in a family the caller cannot
    // see get the SAME refusal. Telling them apart would let anybody with a
    // login probe uuids for people in families they cannot see.
    const refusals = [...setBirthday.matchAll(/raise exception '([^']*)'[\s\S]*?errcode = '42501'/gu)];
    assert.equal(refusals.length, 1, "there is one authorization refusal");
    assert.doesNotMatch(refusals[0][1], /not found|no such|does not exist/iu);
  });

  test("every validation migration 026 wrote is still there, unchanged", () => {
    // The only thing 039 was allowed to change is the authorization line.
    for (const rule of [
      /Enter both a month and a day, or neither/u,
      /Choose a month between January and December/u,
      /That day does not exist in that month/u,
      /Enter a realistic year of birth, or leave it blank/u,
      /when 2 then 29/u,
      /p_year not between 1900 and 2200/u,
    ]) {
      assert.match(setBirthday, rule);
    }
  });

  test("the global contributor question refuses to guess, like the three in 036", () => {
    const legacy = functionBody(areaAuth, "is_family_contributor_member");
    assert.match(legacy, /public\.acting_area\(\) is not null/u, "it honours a stated Area");
    assert.match(legacy, /is_area_contributor_member\(public\.acting_area\(\)\)/u);
    assert.match(legacy, /\) = 1/u, "and otherwise answers only when there is nothing to guess between");
  });

  test("the app offers the button on the same rule the database enforces", () => {
    const loader = read("src", "utils", "supabase", "birthdays-server.ts");
    // The role from THIS Area's membership, and the contributor flag from that
    // membership's own person -- both narrowed by the same `areaId`.
    assert.match(loader, /const isAdmin = member\.role === "admin";/u);
    assert.match(loader, /canEditBirthdays: isAdmin\s*\|\| people\.some\(\(entry\) => entry\.personId === viewerPersonId && entry\.isFamilyContributor\)/u);
    assert.match(loader, /\.eq\("area_id", areaId\)/u);
  });

  test("and a person from another Area cannot be reached at all", () => {
    const loader = read("src", "utils", "supabase", "birthdays-server.ts");
    const workspace = loader.slice(loader.indexOf("export async function loadBirthdayWorkspace"));
    assert.match(workspace, /\.eq\("id", personId\)\s*\n\s*\.eq\("area_id", areaId\)/u,
      "the person is fetched through the Area on screen or not at all");
  });
});

// ===========================================================================
// 2. PART 4 -- the wishlist itself
// ===========================================================================

describe("the wishlist table cannot reach the planning", () => {
  test("it names an Area, a person and a year, and nothing else", () => {
    const table = wishlist.slice(
      wishlist.indexOf("create table if not exists public.birthday_wishlist_ideas"),
      wishlist.indexOf("comment on table public.birthday_wishlist_ideas"),
    );

    // THE WHOLE PRIVACY ARGUMENT, AS A SCHEMA. There is no column here that
    // could say a wish had been acted on, so there is nothing to hide.
    for (const forbidden of [
      "christmas_recipient_id", "christmas_event_id", "purchase_id",
      "originating_gift_idea_id", "gift_idea_id", "contributor_id",
      "status", "purchased", "wrapped", "actual_price", "budget_pennies",
      "bought", "deleted_at",
    ]) {
      assert.ok(!table.includes(forbidden), `the wishlist must not carry ${forbidden}`);
    }

    for (const required of ["area_id", "person_id", "occurrence_year", "title", "created_by_app_member_id"]) {
      assert.ok(table.includes(required), `the wishlist must carry ${required}`);
    }
  });

  test("its only foreign keys are to areas, people and app_members", () => {
    const table = wishlist.slice(
      wishlist.indexOf("create table if not exists public.birthday_wishlist_ideas"),
      wishlist.indexOf("comment on table public.birthday_wishlist_ideas"),
    );
    const references = [...table.matchAll(/references public\.(\w+)/gu)].map((match) => match[1]).sort();
    assert.deepEqual([...new Set(references)], ["app_members", "areas", "people"]);
  });

  test("and the migration asserts that for itself, so a later column cannot smuggle one in", () => {
    assert.match(wishlist, /the wishlist has a foreign key into the planning/u);
    assert.match(wishlist, /target\.relname not in \('areas', 'people', 'app_members'\)/u);
  });

  test("it is filed by YEAR, so the list exists whether or not planning has started", () => {
    // A wishlist that only worked once a recipient row existed would tell the
    // celebrant that planning had started, which is the one fact the dashboard
    // card goes to some trouble never to reveal.
    assert.match(wishlist, /occurrence_year smallint not null/u);
    assert.match(wishlist, /whether or not anybody has started planning/u);
  });

  test("the input rules match the ones gift ideas already carry", () => {
    const table = wishlist.slice(
      wishlist.indexOf("create table if not exists public.birthday_wishlist_ideas"),
      wishlist.indexOf("comment on table public.birthday_wishlist_ideas"),
    );
    assert.match(table, /length\(trim\(title\)\) between 1 and 200/u);
    assert.match(table, /trim\(title\) !~ '\[\[:cntrl:\]\]'/u);
    assert.match(table, /\^https\?:\/\//u, "a link is http or https");
    assert.match(table, /estimated_price_pennies >= 0/u);
  });
});

describe("only the birthday person writes it, resolved inside one Area", () => {
  const own = functionBody(wishlist, "is_own_wishlist_person");

  test("the rule compares the reader's person IN THAT PERSON'S OWN AREA", () => {
    // Both halves from one Area. An identity match in another cannot answer a
    // question about this one, because the comparison never crosses one.
    assert.match(own, /p\.id = public\.current_person_in_area\(p\.area_id\)/u);
    assert.match(own, /security definer/u);
    assert.match(own, /set search_path = ''/u);
  });

  test("it consults no role, so an administrator gains nothing", () => {
    for (const forbidden of ["is_app_admin", "is_area_admin", "role = 'admin'", "is_family_contributor"]) {
      assert.ok(!own.includes(forbidden), `the wishlist rule must not consult ${forbidden}`);
    }
  });

  test("all three write policies ask it, and the read policy does not", () => {
    for (const name of [
      "the birthday person writes their own wishlist",
      "the birthday person edits their own wishlist",
      "the birthday person removes their own wishlist entries",
    ]) {
      const policy = policyBody(wishlist, name);
      assert.match(policy, /public\.is_own_wishlist_person\(person_id\)/u, `${name} must check the writer`);
      assert.match(policy, /public\.is_area_member\(area_id\)/u, `${name} must be Area-scoped`);
    }

    // READING IS FOR THE WHOLE FAMILY, celebrant included. There is no secret
    // in this table: they wrote every row of it.
    const readPolicy = policyBody(wishlist, "members read wishlists in their area");
    assert.match(readPolicy, /for select/u);
    assert.match(readPolicy, /public\.is_area_member\(area_id\)/u);
    assert.ok(!readPolicy.includes("is_own_wishlist_person"),
      "the family must be able to read the list they are buying from");
  });

  test("the row is anchored to its person rather than to what the browser sent", () => {
    const anchor = functionBody(wishlist, "anchor_wishlist_idea");
    assert.match(anchor, /owning_area := public\.area_of_person\(new\.person_id\);/u);
    assert.match(anchor, /new\.area_id := owning_area;/u);
    assert.match(anchor, /public\.current_member_in_area\(owning_area\)/u);

    // And the membership it is credited to really is the birthday person's own,
    // in that Area, and active.
    assert.match(anchor, /m\.area_id = owning_area/u);
    assert.match(anchor, /m\.person_id = new\.person_id/u);
    assert.match(anchor, /m\.active = true/u);

    // On update, everything that decides whose row it is goes back.
    assert.match(anchor, /new\.person_id := old\.person_id;/u);
    assert.match(anchor, /new\.area_id := old\.area_id;/u);
    assert.match(anchor, /new\.occurrence_year := old\.occurrence_year;/u);
    assert.match(anchor, /new\.created_by_app_member_id := old\.created_by_app_member_id;/u);
  });

  test("the trigger that derives the Area runs before the one that checks it", () => {
    // Postgres fires before-row triggers in NAME order, which is what migration
    // 037 relies on too. `_anchor` sorts before `_refuse_foreign_area`.
    assert.ok("birthday_wishlist_ideas_anchor" < "birthday_wishlist_ideas_refuse_foreign_area");
    assert.match(wishlist, /create trigger birthday_wishlist_ideas_anchor/u);
    assert.match(wishlist, /create trigger birthday_wishlist_ideas_refuse_foreign_area/u);
  });

  test("the write barrier from 037 covers the new table too", () => {
    assert.match(wishlist, /when 'birthday_wishlist_ideas' then \(p_row ->> 'area_id'\)::uuid/u);
    // And every other line of 037's dispatch is reproduced, not dropped.
    for (const table of [
      "people", "events", "app_members", "christmas_recipients", "contributors",
      "settlements", "payment_receipts", "purchases", "gift_ideas",
      "recipient_contributions", "purchase_allocations", "item_photos",
    ]) {
      assert.match(wishlist, new RegExp(`when '${table}' then`, "u"),
        `replacing area_of_written_row must not drop ${table}`);
    }
  });

  test("anon can reach none of it", () => {
    assert.match(wishlist, /revoke all on table public\.birthday_wishlist_ideas from anon;/u);
    assert.match(wishlist, /revoke all on function public\.is_own_wishlist_person\(uuid\) from public, anon;/u);
  });
});

// ===========================================================================
// 3. What the celebrant still cannot see
// ===========================================================================

describe("everything hidden from the birthday person is still hidden", () => {
  test("040 asserts every own-birthday policy is still in place", () => {
    // Written into the migration's own end state, so a wishlist that arrived
    // alongside a loosened purchase policy fails to apply rather than shipping.
    for (const policy of [
      "active members read events",
      "active members read recipients",
      "active members read contributors",
      "active members read gift ideas",
      "active members read purchases",
      "active members read purchase allocations",
      "active members read contributions",
      "active members read family settlements",
      "active members read family payment receipts",
    ]) {
      assert.ok(wishlist.includes(`'${policy}'`), `040 must assert that "${policy}" still hides the celebrant`);
    }
    assert.match(wishlist, /no longer hides the reader''s own birthday/u);
  });

  test("040 replaces none of them", () => {
    // It names them to CHECK them. If it also dropped or created one, the check
    // would be checking its own work.
    for (const policy of ["active members read purchases", "active members read gift ideas"]) {
      assert.ok(!wishlist.includes(`drop policy if exists "${policy}"`), `040 must not replace "${policy}"`);
      assert.ok(!wishlist.includes(`create policy "${policy}"`), `040 must not rewrite "${policy}"`);
    }
  });

  test("the four birthday predicates are untouched and asserted present", () => {
    for (const fn of [
      "is_own_birthday_event", "is_own_birthday_recipient",
      "is_own_birthday_purchase", "is_own_birthday_gift_idea",
    ]) {
      assert.ok(!wishlist.includes(`create or replace function public.${fn}`), `040 must not redefine ${fn}`);
      assert.ok(wishlist.includes(`'${fn}'`), `040 must assert ${fn} is still there`);
    }
  });

  test("the celebrant's own screen reaches the wishlist table and nothing else", () => {
    const editor = read("src", "app", "birthdays", "[personId]", "wishlist-editor.tsx");
    const tables = [...editor.matchAll(/\.from\("(\w+)"\)/gu)].map((match) => match[1]);
    assert.deepEqual([...new Set(tables)], ["birthday_wishlist_ideas"]);
    assert.ok(!editor.includes(".rpc("),
      "and calls no SECURITY DEFINER routine, which is what bypasses a policy");
  });

  test("and the projection it renders through carries no purchase field", () => {
    const lib = read("src", "lib", "wishlist.ts");
    const projection = lib.slice(
      lib.indexOf("export function toWishlistEntry"),
      lib.indexOf("/** Newest first"),
    );
    assert.ok(!projection.includes("..."), "the projection must not spread an unknown row");
    for (const forbidden of ["purchase", "status", "bought", "budget", "spent", "contributor"]) {
      assert.ok(!projection.toLowerCase().includes(forbidden), `the projection must not carry ${forbidden}`);
    }
  });
});

// ===========================================================================
// 4. Family-added ideas stay where the family put them
// ===========================================================================

describe("a family member's private idea can never arrive on the wishlist", () => {
  test("nothing copies, moves or mirrors a gift idea into it", () => {
    assert.ok(!wishlist.includes("insert into public.birthday_wishlist_ideas"),
      "the migration writes no wish");
    assert.ok(!wishlist.includes("from public.gift_ideas"),
      "and reads no gift idea");
  });

  test("nothing in the application writes one either", () => {
    const sources = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, ...dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk([...dir, entry.name]);
        else if (/\.(ts|tsx)$/u.test(entry.name)) sources.push([...dir, entry.name]);
      }
    };
    walk(["src"]);

    const writers = sources.filter((parts) => {
      const source = read(...parts);
      const at = source.indexOf('from("birthday_wishlist_ideas")');
      if (at < 0) return false;
      return /\.(insert|update|upsert|delete)\(/u.test(source);
    });

    // Exactly one file writes it: the birthday person's own editor. The
    // planner's panel reads and no more.
    assert.deepEqual(
      writers.map((parts) => parts.join("/")),
      ["src/app/birthdays/[personId]/wishlist-editor.tsx"],
    );

    const panel = read("src", "app", "components", "wishlist-panel.tsx");
    assert.match(panel, /from\("birthday_wishlist_ideas"\)/u);
    for (const write of [".insert(", ".update(", ".upsert(", ".delete("]) {
      assert.ok(!panel.includes(write), `the planner's panel must not ${write}`);
    }
  });

  test("and the planner's panel says whose list it is", () => {
    const panel = read("src", "app", "components", "wishlist-panel.tsx");
    assert.match(panel, /WISHLIST_PLANNER_HEADING/u);
    assert.match(panel, /WISHLIST_PLANNER_NOTE/u);
  });
});

// ===========================================================================
// 5. Purchase-linked ideas, and notification privacy
// ===========================================================================

describe("buying what somebody asked for tells them nothing", () => {
  test("a purchase links to a gift idea, never to a wish", () => {
    // `purchases.originating_gift_idea_id` names a `gift_ideas` row. There is
    // no column anywhere that names a wishlist row, so there is no state a
    // purchase could push back onto one.
    const all = migrationFiles.map((name) => read("supabase", "migrations", name)).join("\n");
    assert.ok(!/references public\.birthday_wishlist_ideas/u.test(all),
      "nothing may point at a wish, or buying one could mark it");
  });

  test("the wish stays on the list, because nothing can take it off", () => {
    assert.ok(!wishlist.includes("on delete cascade") || wishlist.includes("references public.people(id) on delete cascade"),
      "the only cascade is from the person the list belongs to");
    assert.ok(!/create trigger[\s\S]*?on public\.purchases/u.test(wishlist),
      "040 attaches nothing to purchases");
    assert.ok(!/create trigger[\s\S]*?on public\.gift_ideas/u.test(wishlist),
      "040 attaches nothing to gift ideas");
  });

  test("the celebrant is removed from their own birthday's audience, before any planner runs", () => {
    // The existing rule, re-asserted here because the wishlist makes it load
    // bearing in a new way: a celebrant who now has a screen of their own must
    // still never be told "Jade bought your AirPods".
    const dispatch = read("src", "lib", "notification-dispatch.ts");
    assert.match(dispatch, /const hiddenFromPersonId = subjectRow\?\.event_type === "birthday"/u);
    assert.match(dispatch, /hiddenFromPersonId === null \|\| membership\.person_id !== hiddenFromPersonId/u);

    // The exclusion happens where the audience is BUILT, not in each planner.
    const built = dispatch.indexOf("const members: NotifiableMember[] = memberships.data");
    const filter = dispatch.indexOf("hiddenFromPersonId === null || membership.person_id !== hiddenFromPersonId");
    assert.ok(built > 0 && filter > built, "the celebrant is filtered out as the audience is built");
  });

  test("and the subject is read with admin rights, so an empty read cannot fail open", () => {
    const dispatch = read("src", "lib", "notification-dispatch.ts");
    assert.match(dispatch, /admin\.from\("events"\)\.select\("event_type,celebrant_person_id"\)/u);
  });

  test("the audience is drawn from ONE family, which admin rights would otherwise ignore", () => {
    // The dispatcher reads `app_members` with the admin client so it can see
    // members it is not. Admin rights bypass row level security, so the Area
    // has to be applied by hand -- without it, a second Area's members would be
    // in the audience for this Area's purchase.
    const dispatch = read("src", "lib", "notification-dispatch.ts");
    assert.match(dispatch, /export async function resolveSubjectAreaId\(/u);
    assert.match(dispatch, /\.eq\("active", true\)\.eq\("area_id", areaId\)/u);
    assert.match(dispatch, /const areaId = await resolveSubjectAreaId\(kind, subjectId, eventId, admin\);/u);
  });

  test("no notification kind exists for a wish", () => {
    // A wish is not a family event: nothing enqueues one, so there is no
    // message that could name it.
    const dispatch = read("src", "lib", "notification-dispatch.ts");
    assert.ok(!dispatch.includes("birthday_wishlist_ideas"), "the dispatcher knows nothing about wishes");
    const notify = read("src", "app", "components", "notify-family.ts");
    assert.ok(!notify.includes("wishlist"), "and nothing asks it to");
    const editor = read("src", "app", "birthdays", "[personId]", "wishlist-editor.tsx");
    assert.ok(!editor.includes("notifyFamily"), "adding a wish notifies nobody");
  });
});

// ===========================================================================
// 6. The routes the celebrant may and may not reach
// ===========================================================================

describe("the celebrant gets the safe route, and only the safe route", () => {
  const page = read("src", "app", "birthdays", "[personId]", "page.tsx");

  test("their own birthday resolves to the wishlist screen, never to an event", () => {
    const selfCheck = page.indexOf("workspace.isSelf");
    const redirectCall = page.indexOf("redirect(destination)");
    assert.ok(selfCheck > 0 && redirectCall > selfCheck, "the privacy check comes first");

    // The celebrant's branch ONLY -- it ends where everybody else's begins.
    const selfArm = page.slice(selfCheck, page.indexOf("if (workspace.current)", selfCheck));
    assert.ok(selfArm.length > 0, "the celebrant must have a branch of their own");
    assert.ok(!selfArm.includes("redirect("), "their own birthday is not a redirect");
    assert.ok(!selfArm.includes("eventPath("), "and never resolves to an Event Home");
    assert.match(selfArm, /<OwnBirthdayScreen/u);
  });

  test("the dashboard card links only to that route", () => {
    const dashboard = read("src", "app", "events-dashboard.tsx");
    const from = dashboard.indexOf("function BirthdayCard");
    const next = dashboard.indexOf("\nfunction ", from + 1);
    const card = dashboard.slice(from, next > 0 ? next : undefined);
    assert.match(card, /href=\{birthdayWorkspacePath\(person\.personId\)\}/u);
    assert.ok(!card.includes("eventPath("), "the birthday card never links to an event");
  });

  test("and its call to action offers the wishlist, not the planning", () => {
    const dashboard = read("src", "app", "events-dashboard.tsx");
    const card = dashboard
      .slice(dashboard.indexOf("function BirthdayCard"))
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    const action = card.slice(card.indexOf('<div className="mt-auto'));
    const privateLabel = action.slice(action.indexOf("isPrivate"), action.indexOf(": planning ?"));
    assert.match(privateLabel, /SELF_PRIVATE_CTA/u);
    for (const forbidden of ["Start planning", "Open →", "Budget", "Purchased"]) {
      assert.ok(!privateLabel.includes(forbidden), `the self card must not offer ${forbidden}`);
    }
  });

  test("the loader hands the celebrant a list and nothing else", () => {
    const loader = read("src", "utils", "supabase", "birthdays-server.ts");
    const selfArm = loader.slice(
      loader.indexOf("if (isSelf || events.length === 0) {"),
      loader.indexOf("const eventIds = events.map"),
    );
    assert.match(selfArm, /current: null/u, "no occurrence");
    assert.match(selfArm, /previous: \[\], unused: \[\]/u, "no history");
    assert.match(selfArm, /eligibleContributors: isSelf \? \[\] : eligibleContributors/u, "no contributor pool");
    assert.match(selfArm, /wishlist, wishlistYear: listYear, canWriteWishlist: mayWriteWishlist/u);
  });

  test("the list is read before that branch, so it does not depend on planning existing", () => {
    const loader = read("src", "utils", "supabase", "birthdays-server.ts");
    const listRead = loader.indexOf('from("birthday_wishlist_ideas")');
    const branch = loader.indexOf("if (isSelf || events.length === 0) {");
    assert.ok(listRead > 0 && listRead < branch,
      "a list that appeared only once planning had started would reveal that planning had started");
  });
});

// ===========================================================================
// 7. PART 2 -- the definer reader that bypassed row level security
// ===========================================================================

describe("list_gift_ideas no longer reads across an Area, or past a birthday", () => {
  const listIdeas = functionBody(areaAuth, "list_gift_ideas");

  test("it derives the Area from the recipient and checks the caller belongs to it", () => {
    // This is a SECURITY DEFINER routine, so 036's policies do not apply to it.
    // Before 039 any active member of any Area could read every gift idea for
    // any recipient anywhere -- titles, prices, links, notes and suggesters.
    assert.match(listIdeas, /owning_area := public\.area_of_recipient\(p_christmas_recipient_id\);/u);
    assert.match(listIdeas, /not public\.is_area_member\(owning_area\)/u);
  });

  test("and it keeps the surprise rule that the definer rights had bypassed", () => {
    assert.match(listIdeas, /public\.is_own_birthday_recipient\(p_christmas_recipient_id\)/u);
  });

  test("the celebrant gets no rows rather than an error", () => {
    // An error would confirm that a recipient row for their birthday exists,
    // which is itself something they are told nowhere else.
    const guard = listIdeas.slice(listIdeas.indexOf("is_own_birthday_recipient"));
    assert.match(guard, /then\s*\n\s*return;/u, "it returns empty, not an exception");
  });

  test("an idea is credited to a membership from its own Area", () => {
    const author = functionBody(areaAuth, "refuse_cross_area_idea_author");
    assert.match(author, /public\.area_of_recipient\(new\.christmas_recipient_id\)/u);
    assert.match(author, /raise exception 'That member belongs to a different Area'/u);
    assert.match(areaAuth, /create trigger gift_ideas_refuse_cross_area_author\nbefore insert on public\.gift_ideas/u,
      "insert only -- 007 already makes the column immutable on update");
  });
});
