# One-time Setup: Add the DB Secrets

The backup workflow needs two GitHub secrets to connect to Supabase.

## Required Secrets

### 1. `SUPABASE_DB_PASSWORD`
The actual Postgres password (NOT the service role key).

**How to find it:**
1. Go to: https://supabase.com/dashboard/project/YOUR_PROJECT_REF/settings/database
2. Scroll to **Connection string** or **Database password**
3. Copy the password (reset it if you've never seen it)

### 2. `SUPABASE_DB_HOST`
The Postgres host for your project.

**How to find it:**
1. Go to: https://supabase.com/dashboard/project/YOUR_PROJECT_REF/settings/database
2. Under **Connection string**, the host looks like: `db.<your-project-ref>.supabase.co`
3. Copy just the hostname

## How to Add Both Secrets to GitHub

1. Go to your GitHub repo
2. **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret** for each:

| Name | Value |
|------|-------|
| `SUPABASE_DB_PASSWORD` | Your Postgres password |
| `SUPABASE_DB_HOST` | `db.<your-project-ref>.supabase.co` |

## Test It Manually

After adding the secrets, go to:
**Actions** → **Daily Database Backup** → **Run workflow** → **Run workflow**

A successful run will show a green checkmark and a downloadable artifact.
