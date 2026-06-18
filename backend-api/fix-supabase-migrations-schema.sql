-- ============================================================
-- Fix: supabase_migrations.schema_migrations does not exist
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================

-- Create the supabase_migrations schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS supabase_migrations;

-- Create the schema_migrations table that Supabase/PgBouncer expects
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version      text    NOT NULL PRIMARY KEY,
  statements   text[],
  name         text
);

-- Grant access to the roles that need it
GRANT USAGE ON SCHEMA supabase_migrations TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA supabase_migrations TO postgres, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA supabase_migrations TO anon, authenticated;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
