# One-time Setup: Add the DB Password Secret

The backup workflow needs your Supabase database password to connect.
This is NOT the service role key — it's the actual Postgres password.

## How to Find Your DB Password

1. Go to: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/settings/database
2. Scroll to **Connection string** or **Database password**
3. Copy the password (you may need to reset it if you've never seen it)

## How to Add It to GitHub

1. Go to your GitHub repo
2. **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name:  `SUPABASE_DB_PASSWORD`
5. Value: (paste the password from Supabase)
6. Click **Add secret**

That's it. The workflow will pick it up automatically on the next run.

## Test It Manually

After adding the secret, go to:
**Actions** → **Daily Database Backup** → **Run workflow** → **Run workflow**

A successful run will show a green checkmark and an artifact you can download.
