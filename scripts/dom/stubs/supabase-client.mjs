/**
 * A Supabase client that answers from an in-memory fixture, for the DOM suite.
 *
 * THE POINT OF THIS FILE IS THAT IT DOES NOT SCOPE ANYTHING BY ITSELF.
 *
 * It holds every row the fixture gives it and applies exactly the filters the
 * caller asked for -- no more. That is a faithful model of the situation this
 * suite exists to pin down: row level security narrows rows to the Areas the
 * READER belongs to, so for a login that is a member of two families, both
 * families' rows are legitimately readable. The only thing that can keep one
 * family's event out of the other family's screen is the application asking for
 * it, with an explicit `area_id` predicate.
 *
 * So a query that forgets `.eq("area_id", ...)` gets the foreign row back here,
 * precisely as it did in production. A test that passes against this fake would
 * have failed in live QA, and vice versa.
 */

/**
 * THE DEFAULT GLOBAL STATUS, AND WHY IT IS `approved`.
 *
 * Migration 052 put `my_account_status()` in front of every screen in the app:
 * `FamilyProvider` asks it before it reads one family row, and sends anybody who
 * is not approved to `/check-email`, `/account-pending` or `/account-rejected`.
 * So a fixture that answered nothing would turn every DOM test in the suite
 * into "the sign-in redirect happened", whatever the test was about.
 *
 * `approved` is the state every one of those tests already assumed implicitly --
 * a signed-in member looking at their family -- so this preserves what they
 * mean. A test about the gate itself overrides `fake.rpc.my_account_status`.
 */
const APPROVED = () => ({
  data: [{ status: "approved", is_global_admin: false, email_confirmed: true }],
  error: null,
});

/** Everything the fake knows, and everything it was asked. */
export const fake = {
  user: { id: "user-1" },
  tables: {},
  queries: [],
  /** Named routines, by name. Anything unlisted answers `{ data: null }`. */
  rpc: { my_account_status: APPROVED },
  /** Every RPC the code under test called, in order, for forensics. */
  rpcCalls: [],
  reset(tables = {}) {
    this.user = { id: "user-1" };
    this.tables = tables;
    this.queries = [];
    this.rpc = { my_account_status: APPROVED };
    this.rpcCalls = [];
  },
  /** Every filter applied to the last read of `table`, for mutation forensics. */
  filtersFor(table) {
    return this.queries.filter((query) => query.table === table).map((query) => query.filters);
  },
};

function apply(rows, filters) {
  return filters.reduce((kept, [operator, column, value]) => {
    if (operator === "eq") return kept.filter((row) => row[column] === value);
    if (operator === "in") return kept.filter((row) => value.includes(row[column]));
    if (operator === "is") return kept.filter((row) => (row[column] ?? null) === value);
    return kept;
  }, rows);
}

function from(table) {
  const filters = [];
  const record = () => fake.queries.push({ table, filters: filters.map(([o, c, v]) => `${o}:${c}=${JSON.stringify(v)}`) });
  const rows = () => apply(fake.tables[table] ?? [], filters);

  const builder = {
    select() { return builder; },
    eq(column, value) { filters.push(["eq", column, value]); return builder; },
    in(column, values) { filters.push(["in", column, values]); return builder; },
    is(column, value) { filters.push(["is", column, value]); return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle() { record(); const found = rows(); return Promise.resolve({ data: found[0] ?? null, error: null }); },
    // The list queries are awaited directly, so the builder is itself a thenable.
    then(resolve, reject) {
      record();
      return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
    },
  };
  return builder;
}

/** Realtime is not what these tests are about; it only has to not explode. */
const channel = () => {
  const self = { on: () => self, subscribe: () => self, unsubscribe: () => {} };
  return self;
};

export const createClient = () => ({
  auth: {
    getUser: async () => ({ data: { user: fake.user }, error: null }),
    signOut: async () => ({ error: null }),
  },
  from,
  channel,
  removeChannel: () => {},
  rpc: async (name, args) => {
    fake.rpcCalls.push({ name, args: args ?? null });
    const handler = fake.rpc[name];
    return handler ? handler(args) : { data: null, error: null };
  },
});
