-- ============================================================
-- PART A: Chapter Library Migration
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Enable uuid extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Create chapter_library table
CREATE TABLE IF NOT EXISTS chapter_library (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  board            text        NOT NULL,
  class            integer     NOT NULL CHECK (class BETWEEN 1 AND 12),
  subject          text        NOT NULL,
  chapter_number   integer     NOT NULL,
  chapter_name     text        NOT NULL,
  topics           text        NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_chapter_library UNIQUE (board, class, subject, chapter_number)
);

-- 3. Index for fast lookup by board + class + subject
CREATE INDEX IF NOT EXISTS idx_chapter_library_lookup
  ON chapter_library (board, class, subject);

-- 4. RLS: enable and configure
ALTER TABLE chapter_library ENABLE ROW LEVEL SECURITY;

-- All authenticated users can SELECT
CREATE POLICY "chapter_library_select"
  ON chapter_library
  FOR SELECT
  TO authenticated
  USING (true);

-- Only service role can INSERT / UPDATE / DELETE
-- (service role bypasses RLS by default, but explicit policies make intent clear)
CREATE POLICY "chapter_library_insert_service"
  ON chapter_library
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "chapter_library_update_service"
  ON chapter_library
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "chapter_library_delete_service"
  ON chapter_library
  FOR DELETE
  TO service_role
  USING (true);

-- 5. Add nullable columns to existing daily_tests table
--    (safe ALTER — all existing rows remain unaffected, columns default to NULL)
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS chapter_library_id uuid REFERENCES chapter_library (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS selected_topics    text;

-- Optional: index for joining/filtering
CREATE INDEX IF NOT EXISTS idx_tests_chapter_library_id
  ON tests (chapter_library_id)
  WHERE chapter_library_id IS NOT NULL;
