# Gift Planner

A private gift-and-occasion planner for one family: people, events (Christmas and
birthdays), gift ideas, purchases, contributions and who owes whom.

**Stack:** Next.js (App Router) · TypeScript · Supabase Postgres with row level
security · Cloudflare Workers via OpenNext.

**Production:** <https://xmas-family.uk/> — pushing `main` auto-deploys through
Cloudflare Workers Builds. There is no staging environment, and production data
is real family data.

```bash
npm run dev     # local development
npm run test:all  # full regression
```

**Before changing anything,** read `CLAUDE.md` for the durable rules
(security invariants, money handling, migrations, deployment) and
`docs/SECURITY-AND-QA.md` for the QA rules that apply because QA runs against the
live site and the live database.
