/**
 * A DISPOSABLE POSTGRESQL, SHAPED LIKE SUPABASE.
 *
 * WHY THIS EXISTS. Every rule that matters in this application lives in the
 * database: row level security, SECURITY DEFINER routines, triggers, grants.
 * Reading the SQL and asserting on its text proves the rule was WRITTEN. It
 * cannot prove the rule WORKS -- that a policy attaches, that a definer routine
 * refuses, that a trigger fires, that a login in two Areas is answered about
 * the right one. Only running it proves that.
 *
 * PGlite is real PostgreSQL 18 compiled to WebAssembly. Real roles, real RLS,
 * real triggers, real `SET ROLE`. It costs about a second and a half to replay
 * the entire migration history into a fresh one, so every suite that needs a
 * database builds its own and throws it away.
 *
 * THE MIGRATIONS ARE READ FROM DISK, BYTE FOR BYTE, AND NEVER EDITED. Anything
 * this environment needs that Supabase would have provided, and anything that
 * happened to the production database OUTSIDE the migration chain, is declared
 * in `PLATFORM` or `INTERLEAVED` below and reported by name when the chain runs.
 * A rehearsal that needed help must never be mistaken for one that did not.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

export function migrationNames() {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
}

export function migrationSql(name) {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

// ---------------------------------------------------------------------------
// The platform
//
// `auth.uid()` is Supabase's own definition: it reads the JWT claims PostgREST
// puts into the transaction. Setting `request.jwt.claims` is therefore exactly
// how a test signs somebody in -- the same mechanism, not an imitation of it.
// ---------------------------------------------------------------------------

const PLATFORM = `
create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login;
  end if;
end;
$$;

grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;

-- SUPABASE'S PROJECT DEFAULT PRIVILEGES, copied from the production schema dump.
--
-- Every table, sequence and function created by the postgres role in public is
-- granted to all four roles automatically. This is why service_role can read
-- and write everything without any migration saying so -- and therefore why a
-- route that uses it has no boundary but the one it applies itself. It is also
-- why the migrations REVOKE from anon explicitly wherever they mean to: the
-- default handed it a grant they have to take back.
alter default privileges for role postgres in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to postgres, anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- The columns this application actually reads. last_sign_in_at is not used
-- by any migration or policy; it is here because the Q19 auth census reports
-- it, and a census that cannot be rehearsed is a census nobody has run.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$fn$;

create or replace function auth.role()
returns text
language sql
stable
as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$fn$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- Supabase Storage, reduced to the one table migration 017 writes policies on.
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid, created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;
insert into storage.buckets (id, name, public)
values ('item-photos', 'item-photos', false) on conflict do nothing;
`;

// ---------------------------------------------------------------------------
// Migrations that do not PARSE on PostgreSQL 18
//
// They are applied, they are immutable, and they are NOT edited. What happens
// instead is that a semantically identical statement is substituted FOR THE
// REHEARSAL ONLY, and the substitution is reported.
//
// EACH ONE IS ALSO A FINDING. A migration that cannot replay on PostgreSQL 18
// cannot be replayed at all the day the production instance moves to 18, which
// matters for rebuilding from a backup.
// ---------------------------------------------------------------------------

export const SHIMS = {
  "202608100003_fix_jaden_jade_contribution.sql": {
    why: "UPDATE ... FROM references the update target `rc` inside a JOIN's ON clause. PostgreSQL 18 rejects it: 'invalid reference to FROM-clause entry for table rc'.",
    equivalence: "Rewritten as UPDATE ... WHERE EXISTS over the same joins. Same rows, same columns, same values.",
    sql: `
update public.recipient_contributions rc
set planned_amount_pennies = 0, updated_at = now()
where exists (
  select 1
  from public.christmas_recipients r
  join public.people recipient_person on recipient_person.id = r.person_id
  join public.contributors c on c.id = rc.contributor_id
  join public.people contributor_person on contributor_person.id = c.person_id
  where rc.christmas_recipient_id = r.id
    and recipient_person.name = 'Jaden'
    and contributor_person.name = 'Jade'
    and r.christmas_event_id = c.christmas_event_id
);`,
  },
};

// ---------------------------------------------------------------------------
// Things the production database had that no migration creates
// ---------------------------------------------------------------------------

/**
 * `supabase/seed_contributors.sql`, with its three plpgsql locals renamed.
 *
 * As written it fails on PostgreSQL 18 with 'column reference "contributor_id"
 * is ambiguous': the local shadows the column named in ON CONFLICT. Written out
 * here rather than derived by string surgery so a reviewer can diff the two and
 * see that only the local names moved.
 *
 * Its re-insert of the four contributor people is also dropped, because
 * `on conflict do nothing` there relies on a unique index on `people.name` that
 * does not exist -- replaying it would create four duplicates production never
 * had. `seed.sql` has already inserted all four.
 */
const SEED_CONTRIBUTORS_REHEARSAL = () => `
do $$
declare v_event_id uuid; v_contributor_id uuid; v_recipient_id uuid; contributor_name text; recipient_name text; amount integer;
begin
  select id into v_event_id from public.christmas_events where year = 2026;
  foreach contributor_name in array array['Jade','Kirsten','Paige','Taylor'] loop
    insert into public.contributors (christmas_event_id, person_id)
    select v_event_id, id from public.people where name = contributor_name on conflict do nothing;
  end loop;
  for recipient_name in select name from public.people where name in ('Mum','Dad','Jade','Kirsten','Paige','Taylor','Eden','Lucas','Eliza','Maggie','Harry','Grandma','Joanne','Ian','Owen','Reece','Kerry','Glynn','Jaden') loop
    select r.id into v_recipient_id from public.christmas_recipients r join public.people p on p.id = r.person_id where r.christmas_event_id = v_event_id and p.name = recipient_name;
    for contributor_name in select unnest(array['Jade','Kirsten','Paige','Taylor']) loop
      select c.id into v_contributor_id from public.contributors c join public.people p on p.id = c.person_id where c.christmas_event_id = v_event_id and p.name = contributor_name;
      amount := case when recipient_name = 'Mum' or recipient_name = 'Dad' then 2500 when recipient_name = 'Jaden' and contributor_name = 'Jade' then 0 when recipient_name in ('Jade','Kirsten','Paige','Taylor','Eden','Lucas','Eliza','Maggie','Harry','Grandma','Joanne','Jaden') then case when recipient_name = contributor_name or (recipient_name in ('Lucas','Eliza','Maggie') and contributor_name = 'Kirsten') or (recipient_name = 'Harry' and contributor_name = 'Paige') then 0 else 1500 end when recipient_name = 'Ian' or recipient_name = 'Reece' or recipient_name = 'Kerry' then 1000 when recipient_name = 'Owen' then case when contributor_name = 'Jade' then 0 else 1000 end else 500 end;
      insert into public.recipient_contributions (christmas_recipient_id, contributor_id, planned_amount_pennies)
      values (v_recipient_id, v_contributor_id, amount)
      on conflict (christmas_recipient_id, contributor_id) do update set planned_amount_pennies = excluded.planned_amount_pennies;
    end loop;
  end loop;
end $$;`;

export const INTERLEAVED = {
  "202608100002_create_contributors.sql": [
    {
      label: "seed.sql",
      why: "The nineteen people and their Christmas 2026 budgets. Migration 027's own end-state test inserts against `public.people`, so a database with nobody in it fails an assertion that passed in production.",
      sql: () => readFileSync(join(ROOT, "supabase", "seed.sql"), "utf8"),
    },
    {
      label: "seed_contributors.sql (locals renamed, de-duplicated)",
      why: "As written it fails on PostgreSQL 18 with 'column reference \"contributor_id\" is ambiguous'.",
      sql: SEED_CONTRIBUTORS_REHEARSAL,
    },
  ],

  "202608100033_membership_guards.sql": [
    {
      label: "roles normalised, one administrator appointed",
      why:
        "Migration 004 inserts memberships with its column default role = 'family'; migration 011 then adds check (role in ('admin','member')) NOT VALID, which leaves those rows alone until something UPDATES them -- and migration 034's backfill is that something. " +
        "FINDING: a database still holding a 'family' role would have FAILED migration 034. Production reached 034 with none left, so this reproduces the state 034 actually met.",
      sql: () => `
        update public.app_members set role = 'member' where role not in ('admin', 'member');
        update public.app_members set role = 'admin'
        where id = (select id from public.app_members order by created_at, id limit 1);
      `,
    },
  ],
};

// ---------------------------------------------------------------------------

export async function freshDatabase() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(PLATFORM);
  return db;
}

/**
 * Apply one migration exactly as written.
 *
 * PGlite sends the whole file as one simple query, which PostgreSQL runs in an
 * implicit transaction -- so a migration that fails half way leaves nothing
 * behind, the same guarantee `supabase db push` gives.
 */
export async function applyMigration(db, name) {
  const shim = SHIMS[name];
  try {
    await db.exec(shim ? shim.sql : migrationSql(name));
    return { name, ok: true, shimmed: Boolean(shim) };
  } catch (error) {
    return { name, ok: false, error: firstLine(error), detail: error.detail ?? null };
  }
}

/**
 * Replay the history into a fresh database.
 *
 * `through` stops after that migration, which is how a test proves what a
 * migration CHANGED rather than only what it left behind.
 */
export async function buildRehearsal({ through = null, log = () => {} } = {}) {
  const db = await freshDatabase();
  const applied = [];
  for (const name of migrationNames()) {
    const result = await applyMigration(db, name);
    if (!result.ok) {
      await db.close();
      throw new Error(`${name} failed: ${result.error}${result.detail ? ` | ${result.detail}` : ""}`);
    }
    applied.push(result);
    log(`${result.shimmed ? "shim" : "ok  "} ${name}`);
    for (const step of INTERLEAVED[name] ?? []) {
      await db.exec(step.sql());
      log(`data ${step.label}`);
    }
    if (name === through) break;
  }
  db.appliedMigrations = applied;
  return db;
}

// ---------------------------------------------------------------------------
// One request
//
// THE ACTING AREA IS TRANSACTION-LOCAL, AND THAT IS THE WHOLE POINT OF IT.
// `claim_active_area` sets it with `is_local => true` so it dies with the
// transaction and cannot survive on a pooled connection into somebody else's
// request. A test that called the hook in one statement and the routine in the
// next would therefore be testing nothing: the claim would already be gone.
//
// PostgREST runs a request as ONE transaction --
//
//     begin;
//     set local role authenticated;
//     set local request.jwt.claims = '...';
//     select public.claim_active_area();   -- the pre-request hook
//     <the actual query>;
//     commit;
//
// -- and `request()` is that, faithfully, including reading the hook's name
// back out of `pg_db_role_setting` rather than hard-coding it. If migration 038
// ever stopped configuring it, this would stop calling anything and every test
// that depends on an acting Area would fail.
// ---------------------------------------------------------------------------

/**
 * Run one PostgREST-shaped request and return whatever the body returns.
 *
 *   user  the signed-in account, or null for a signed-out visitor
 *   role  the database role PostgREST would switch to
 *   area  what the browser put in `x-area-id`; omit to send no header at all
 */
export async function request(db, { user = null, role = null, area = undefined }, body) {
  const chosenRole = role ?? (user ? "authenticated" : "anon");
  const hookName = await preRequestFunction(db);

  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${chosenRole};`);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      user ? JSON.stringify({ sub: user, role: chosenRole }) : "",
    ]);
    await tx.query("select set_config('request.headers', $1, true)", [
      JSON.stringify(area === undefined || area === null ? {} : { "x-area-id": String(area) }),
    ]);
    if (hookName) await tx.query(`select ${hookName}()`);
    return body(tx);
  });
}

/** What the `authenticator` role is configured to run before every request. */
export async function preRequestFunction(db) {
  return value(db, `
    select (regexp_match(array_to_string(s.setconfig, ' '), 'pgrst\\.db_pre_request=([a-z_.]+)'))[1]
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
    where r.rolname = 'authenticator'`);
}

/** The migration runner's own rights: what a migration or a fixture uses. */
export async function asOwner(db) {
  await db.exec("reset role;");
  await db.exec("select set_config('request.jwt.claims', '', false);");
  await db.exec("select set_config('app.acting_area', '', false);");
  await db.exec("select set_config('request.headers', '', false);");
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

export function literal(input) {
  return `'${String(input).replaceAll("'", "''")}'`;
}

function firstLine(error) {
  return String(error?.message ?? error).split("\n")[0];
}

/** Run something and return the failure instead of throwing it. */
export async function attempt(db, sql, params) {
  try {
    const result = params ? await db.query(sql, params) : await db.query(sql);
    return { ok: true, rows: result.rows, count: result.rows.length };
  } catch (error) {
    return { ok: false, error: firstLine(error), code: error.code ?? null };
  }
}

/** The first column of the first row, or undefined. */
export async function value(db, sql, params) {
  const result = params ? await db.query(sql, params) : await db.query(sql);
  const row = result.rows[0];
  return row ? Object.values(row)[0] : undefined;
}

export async function rows(db, sql, params) {
  const result = params ? await db.query(sql, params) : await db.query(sql);
  return result.rows;
}

/** How many rows this role can actually see. */
export async function visible(db, table, where = "true") {
  const result = await attempt(db, `select count(*)::int as n from public.${table} where ${where}`);
  return result.ok ? result.rows[0].n : `REFUSED: ${result.error}`;
}

/**
 * ONE REQUEST, ONE STATEMENT, AND THE REFUSAL INSTEAD OF THE THROW.
 *
 * The shape almost every security assertion needs: be somebody, claim an Area,
 * try one thing, and find out whether the database allowed it. A statement that
 * errors aborts its transaction, so the rollback is what keeps a refused probe
 * from poisoning the next one.
 */
export async function probe(db, who, sql, params) {
  try {
    const result = await request(db, who, (tx) => (params ? tx.query(sql, params) : tx.query(sql)));
    return { ok: true, rows: result.rows, count: result.rows.length };
  } catch (error) {
    return { ok: false, error: firstLine(error), code: error.code ?? null, rows: [], count: 0 };
  }
}

/** The single value a probe returned, or the refusal. */
export async function probeValue(db, who, sql, params) {
  const result = await probe(db, who, sql, params);
  if (!result.ok) return result;
  return { ok: true, value: result.rows[0] ? Object.values(result.rows[0])[0] : undefined };
}

/** How many rows of a table this caller can actually see, through RLS. */
export async function seen(db, who, table, where = "true", params) {
  const result = await probe(db, who, `select count(*)::int as n from public.${table} where ${where}`, params);
  return result.ok ? result.rows[0].n : `REFUSED(${result.error})`;
}
