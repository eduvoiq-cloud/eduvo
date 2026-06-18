# Eduvo — Deployment & Migration Guide

## Fresh Database Setup

When provisioning a new Supabase project, run the SQL migration files **in this exact order**.
Skipping or reordering them will cause missing columns, broken foreign keys, or silent auth failures
(e.g. student login doing a full-table scan because the phone index doesn't exist yet).

```
1. backend-api/supabase-schema.sql                          ← base tables + RLS policies
2. backend-api/supabase-migrations.sql                      ← column additions, indexes, triggers
3. backend-api/supabase-migrations-production-hardening.sql ← security hardening, bcrypt rounds comment, idx_students_phone_number
4. backend-api/add-*.sql  (alphabetical order)              ← feature additions
5. backend-api/fix-*.sql  (alphabetical order)              ← schema corrections
6. backend-api/migrate-*.sql                                ← data migrations (if any)
```

> **Critical:** `supabase-migrations-production-hardening.sql` adds
> `idx_students_phone_number`. Without this index, every student login
> triggers a full table scan — with 10 000 students this degrades to
> seconds per login.

---

## Verifying RLS Is Enabled on Every Table

After running all migrations, confirm Row Level Security is active:

```sql
SELECT tablename, rowsecurity
FROM   pg_tables
WHERE  schemaname = 'public'
ORDER  BY tablename;
```

Every row must show `rowsecurity = true`. Tables added by later migrations
(`recovery_packs`, `integrity_logs`, `monthly_recovery_schedules`, etc.) must
also have RLS enabled. The `supabase-migrations-production-hardening.sql`
file enables RLS on the base tables; verify the feature-addition scripts do
the same for any new tables they create.

---

## Required Environment Variables

Set these in Railway (backend) before starting the server. The app will refuse
to boot if any of the first four are missing.

### Backend (Railway)

| Variable                   | Description                                               |
|----------------------------|-----------------------------------------------------------|
| `SUPABASE_URL`             | Supabase project URL                                      |
| `SUPABASE_ANON_KEY`        | Supabase anon/public key                                  |
| `SUPABASE_SERVICE_ROLE_KEY`| Supabase service role key — **never expose client-side**  |
| `JWT_SECRET`               | Random 32-byte hex (`openssl rand -hex 32`)               |
| `CRON_SECRET`              | Random 32-byte hex — used to authenticate cron endpoints  |
| `CORS_ORIGINS`             | Comma-separated list of allowed origins, e.g. `https://eduvo.vercel.app` |
| `FIREBASE_PROJECT_ID`      | Firebase project ID                                       |
| `FIREBASE_CLIENT_EMAIL`    | Firebase service account email                            |
| `FIREBASE_PRIVATE_KEY`     | Firebase RSA private key (keep `\n` escaped)              |
| `GEMINI_API_KEY`           | Google Gemini API key                                     |
| `RESEND_API_KEY`           | Resend email API key                                      |
| `SENTRY_DSN`               | Sentry DSN (optional but strongly recommended in prod)    |
| `NODE_ENV`                 | Set to `production`                                       |

> **`CORS_ORIGINS` must be set in production.** If it is missing, the app
> logs an error at startup and all browser requests from the web dashboard
> will be blocked (empty allow-list = fail-closed). The mobile app is
> unaffected because it sends no `Origin` header.

### Web Dashboard (Vercel)

| Variable              | Description                                           |
|-----------------------|-------------------------------------------------------|
| `RAILWAY_API_URL`     | Full Railway backend URL (server-side only, no NEXT_PUBLIC_ prefix) |
| `NEXT_PUBLIC_SUPABASE_URL`     | Supabase project URL (client-side)           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`| Supabase anon key (client-side, safe to expose) |
| `SENTRY_AUTH_TOKEN`   | For source map upload during build (optional)         |

---

## CORS Note

API requests with **no `Origin` header** (mobile app, curl, Postman,
server-to-server) are allowed unconditionally. Browser CORS enforcement does
not apply to these callers — JWT authentication is the sole access gate for
them. This is intentional and standard practice for REST APIs that serve
both browser and non-browser clients.

---

## Rate Limiter Trust Proxy Dependency

All rate limiters use `validate: false` to suppress the express-rate-limit
startup check. This is safe **only because** `app.set('trust proxy', 1)` is
set in `src/index.ts`. If that line is ever removed, rate limiters will apply
to the Railway proxy IP instead of real client IPs, silently making them
ineffective. Re-enable `validate: true` in `src/middleware/rateLimit.ts` if
the trust proxy configuration changes.
