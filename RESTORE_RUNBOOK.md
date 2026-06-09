# Database Restore Runbook

This document explains how to restore the Eduvo database from a backup.
Keep this file up to date and make sure at least one other person knows where it is.

---

## Where Backups Live

Backups run automatically every day at 02:00 UTC via GitHub Actions.

**To find them:**
1. Go to your GitHub repo → **Actions** tab
2. Click **Daily Database Backup** in the left sidebar
3. Click any successful run
4. Scroll to the **Artifacts** section at the bottom
5. Download the `.sql.gz` file

Backups are retained for **90 days**.

---

## How to Restore

### Prerequisites
- PostgreSQL client installed (`psql`, `pg_restore`)
- The Supabase DB password (stored in GitHub Secrets as `SUPABASE_DB_PASSWORD`)

### Steps

```bash
# 1. Download the artifact from GitHub Actions and decompress it
gunzip eduvo-backup-YYYY-MM-DD_HH-MM-SS.sql.gz

# 2. Connect and restore
psql \
  --host=db.gkbqltztadukfbknnqqd.supabase.co \
  --port=5432 \
  --username=postgres \
  --dbname=postgres \
  < eduvo-backup-YYYY-MM-DD_HH-MM-SS.sql
```

You will be prompted for the Supabase DB password.

> ⚠️ This overwrites existing data. Only run this when you intend a full restore.

---

## Partial Restore (single table)

If only one table was corrupted or accidentally deleted:

```bash
# Extract just that table from the dump
gunzip -c eduvo-backup-*.sql.gz | grep -A 999999 "COPY public.students " | \
  head -n $(gunzip -c eduvo-backup-*.sql.gz | grep -n "^\\\." | head -1 | cut -d: -f1) \
  > students_only.sql

# Or use pg_restore with a custom-format dump (--format=custom in pg_dump)
# For plain SQL dumps, manually extract the relevant COPY block and run it.
```

For single-table restores, the safest approach is to copy the data out of the dump
into a temporary table, verify it, then swap.

---

## What the Backup Contains

- All tables in the `public` schema
- All data rows
- Indexes and constraints are NOT included (they come from your migration files)

To restore indexes after a full restore, re-run:
```
backend-api/supabase-indexes.sql
```

---

## When to Upgrade

Switch to **Supabase Pro ($25/mo)** before your second school onboards.
Pro gives you managed daily backups + 7-day restore window without any of this manual process.

Dashboard: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/settings/addons

---

## Contacts

| Role | Name | Contact |
|------|------|---------|
| DB owner | (you) | — |
| Supabase support | — | https://supabase.com/support |

---

*Last updated: June 2026*
