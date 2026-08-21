# Database backups

Git backs up the **schema** (`supabase/migrations/`) and the **code**.
It backs up **none of the data**.

Every purchase, payment, contributor, contribution plan and membership exists in
exactly one place: hosted Supabase. This workflow is what stops that being a
single point of failure.

---

## What is backed up

`.github/workflows/database-backup.yml` produces three files per run:

| File | Contents |
|---|---|
| `roles.sql` | Database roles and their grants |
| `schema.sql` | Every table, index, constraint, RLS policy, function and trigger |
| `data.sql` | Every row in every table — purchases, allocations, settlements, payment receipts, contributors, contribution plans, recipients, memberships, gift ideas, audit log, notification tables |
| `MANIFEST.txt` | Date, trigger, commit SHA, file sizes and `COPY` block count, for spot-checking a backup without unpacking it |

## What is **not** backed up

These are real gaps. Know about them before you need them.

- **Supabase Auth users** — passwords and identities live in the `auth` schema,
  which `supabase db dump` does not include. After a restore to a *new* project,
  family members must be re-invited and set new passwords. `app_members` rows
  survive, so roles and links are preserved; only the login credentials are not.
- **Storage objects** — item photos live in a Supabase Storage bucket. The
  `item_photos` table rows are backed up; the image files are not.
- **Cloudflare Worker secrets** — `SUPABASE_SECRET_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `APP_ORIGIN`. Keep these somewhere safe
  independently; losing the VAPID pair invalidates every push subscription.
- **Push subscriptions are backed up but not portable** — the rows restore, but
  the endpoints are tied to the original VAPID key pair.

## Where backups appear

GitHub → **Actions** tab → **Database backup** → pick a run → **Artifacts**, at
the bottom of the run summary.

Artifacts are named `supabase-backup-YYYY-MM-DD` and are **retained for 30
days**. Dumps are never committed to the repository — the workflow writes them
to the runner's temp directory and they leave only as an artifact.

> **Because retention is 30 days, this is not an archive.** If you want a
> permanent record — for example a snapshot of the final Christmas 2026
> position — download that day's artifact and store it somewhere durable.

## Schedule and manual runs

- **Daily** at 03:17 UTC.
- **Manually:** Actions → Database backup → *Run workflow* → optionally type a
  reason → *Run workflow*. Do this before applying any migration.

## Required GitHub secret

One secret, in **Settings → Secrets and variables → Actions → New repository
secret**:

| Name | Value |
|---|---|
| `SUPABASE_DB_URL` | The Postgres connection string, including the password |

**Where to get it:** Supabase dashboard → your project → **Connect** (top of the
page) → **Session pooler** → copy the URI. Replace `[YOUR-PASSWORD]` with your
database password. If you do not have it, reset it under **Settings → Database →
Database password** (this rotates the password; update the secret afterwards).

It looks like this — note the username carries the project ref, and the host is
`pooler.supabase.com`, not `db.…supabase.co`:

```
postgresql://postgres.YOUR-PROJECT-REF:YOUR-PASSWORD@aws-0-YOUR-REGION.pooler.supabase.com:5432/postgres
```

Copy it verbatim from the dashboard rather than typing it out — the region and
the `aws-N-` prefix vary by project.

### Why the session pooler and not the direct connection

GitHub-hosted runners (`ubuntu-latest`) are **IPv4-only**. Supabase's direct
endpoint `db.<ref>.supabase.co:5432` resolves to **IPv6** unless the project has
the IPv4 add-on, so a workflow pointed at it fails to connect at all. Supavisor's
**session** pooler is reachable over IPv4 and holds one real Postgres session per
client, which is what `pg_dump` needs.

> **Use port 5432 (session mode). Never port 6543.**
> Port `6543` is Supavisor's **transaction** mode: it multiplexes statements
> across backends and does not hold a session, so `pg_dump` cannot take a
> consistent snapshot and the dump fails or comes back incomplete. The workflow
> rejects a `:6543` connection string before it starts dumping.

**Direct connection is a valid alternative** — but only if this project has the
Supabase **IPv4 add-on** (Settings → Add-ons), or you move the workflow to a
self-hosted runner with IPv6. In that case the string is
`postgresql://postgres:YOUR-PASSWORD@db.YOUR-PROJECT-REF.supabase.co:5432/postgres`
and nothing else in the workflow needs to change; it is still port 5432 and
still a real session.

The workflow checks only that this secret is *present*. Its value is never
printed, never written to a file, and never passed anywhere it could be logged.

## How a failed dump is caught

A backup that "succeeds" but produces an empty file is worse than one that
fails, because it looks like protection until the day you need it. Before
anything is uploaded, the workflow fails the run if:

- any of the three files is missing or zero bytes;
- `schema.sql` does not define all of `purchases`, `purchase_allocations`,
  `settlements`, `payment_receipts`, `contributors`, `recipient_contributions`,
  `christmas_recipients`, `app_members`;
- `data.sql` contains no `COPY public.` blocks at all.

Every step runs under `set -euo pipefail`, and the upload uses
`if-no-files-found: error`, so an empty directory fails rather than producing an
empty artifact.

A failed run shows as a red ✗ in the Actions tab and GitHub emails the
repository owner.

---

## Restore procedure (high level)

There is **no restore workflow, deliberately.** Restoring overwrites live data
and must never be a single mis-click in the Actions tab. Do it by hand,
carefully.

> Restore into a **new or empty** Supabase project first and verify it there.
> Only consider touching the live project once you have confirmed the restored
> copy reconciles.

1. **Stop writes.** Tell the family to stop using the app, or take the
   Cloudflare Worker offline.
2. **Take a fresh backup first, if the current database is reachable at all.**
   Even a damaged database is evidence.
3. Download the chosen artifact from the Actions tab and unzip it. Check
   `MANIFEST.txt` is the date you expect.
4. Create a new Supabase project and get its direct connection string.
5. Restore in order — roles, then schema, then data:
   ```
   psql "$TARGET_DB_URL" -f roles.sql
   psql "$TARGET_DB_URL" -f schema.sql
   psql "$TARGET_DB_URL" -f data.sql
   ```
6. **Verify before trusting it.** At minimum confirm that allocations still sum
   to their purchase price and that Owed reconciles:
   ```sql
   -- Must return zero rows.
   select p.id
   from public.purchases p
   join public.purchase_allocations a on a.purchase_id = p.id
   where p.deleted_at is null
   group by p.id, p.actual_price_pennies
   having sum(a.responsibility_pennies) <> p.actual_price_pennies;

   -- Must return zero rows.
   select id from public.settlements
   where confirmed_amount_pennies > amount_pennies;
   ```
7. Re-invite Auth users and have them set new passwords (see *What is not
   backed up*).
8. Re-upload item photos if they matter, or accept the gaps.
9. Point the app at the new project: update `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`
   (`wrangler secret put <NAME>`), then redeploy.

## Also worth having

This workflow is a portable, self-owned backup. It is not a replacement for
Supabase's own point-in-time recovery, which can roll back to a moment rather
than to 03:17 that morning. PITR availability depends on your plan tier — check
**Settings → Add-ons → Point-in-Time Recovery** in the Supabase dashboard and
enable it if the Christmas data is worth the cost to you.
