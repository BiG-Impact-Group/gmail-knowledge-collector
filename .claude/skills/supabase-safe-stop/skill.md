---
name: supabase-safe-stop
description: >
  MANDATORY: Always use this procedure before running `supabase stop` or any command
  that would stop or reset local Supabase. Dumps the database first to prevent data loss.
  `supabase stop` removes Docker volumes and permanently deletes all local data.
---

# Supabase Safe Stop

You MUST follow this procedure any time you need to stop, restart, or reset the local Supabase instance. Skipping the dump will permanently destroy all local data (products, endorsements, exclusions, users, tenants, etc.).

## CRITICAL RULE

**Never run `supabase stop`, `supabase db reset`, or `docker volume prune` without completing Step 1 first.**

If you were about to run one of those commands, stop and do this instead.

## Step 1 — Dump the Database

Run the dump and timestamp it:

```bash
npx supabase db dump -f supabase/backups/local_$(date +%Y%m%d_%H%M%S).sql
```

If the `supabase/backups/` directory doesn't exist, create it first:

```bash
mkdir -p supabase/backups
```

Confirm the dump file exists and is non-zero bytes before proceeding:

```bash
ls -lh supabase/backups/
```

## Step 2 — Stop Supabase

Only after the dump is confirmed:

```bash
npx supabase stop
```

## Step 3 — Start Supabase

```bash
npx supabase start
```

## Step 4 — Restore the Dump

After Supabase is back up, restore from the dump:

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres < supabase/backups/<dump_filename>.sql
```

Use the most recent dump file from `supabase/backups/`.

## Step 5 — Verify

```bash
node -e "
const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
client.connect().then(async () => {
  const [e, ex, p] = await Promise.all([
    client.query('SELECT COUNT(*) FROM product_endorsements'),
    client.query('SELECT COUNT(*) FROM product_exclusions'),
    client.query('SELECT COUNT(*) FROM products'),
  ]);
  console.log('Products:', p.rows[0].count, '| Endorsements:', e.rows[0].count, '| Exclusions:', ex.rows[0].count);
  client.end();
}).catch(e => console.error(e.message));
"
```

## When This Skill Applies

- Any `supabase stop` command
- Any `supabase db reset` command
- Any Docker volume removal (`docker volume prune`, `docker rm -v`, etc.)
- Any full Supabase restart for troubleshooting

## Notes

- Backup files are gitignored (large SQL dumps should not be committed)
- The dump includes all schema + data — it is a full restore
- Auth users are in the `auth` schema and ARE included in the dump
- If the restore fails due to migration conflicts, apply migrations first (`supabase db push --local`) then restore only the data tables
