-- ============================================================
-- Migration: Remove daily tests, enhance tests table
-- Run once in Supabase SQL editor
-- ============================================================

-- ── 1. Add new columns to tests table ─────────────────────────────────────────

ALTER TABLE public.tests
  ADD COLUMN IF NOT EXISTS board text,
  ADD COLUMN IF NOT EXISTS chapter text,
  ADD COLUMN IF NOT EXISTS language text,
  ADD COLUMN IF NOT EXISTS contributes_to_streak boolean NOT NULL DEFAULT false;

-- ── 2. Add 'test' as valid activity_type in streak_log ────────────────────────
-- The streak_log table may have a CHECK constraint. Drop and recreate it.
ALTER TABLE public.streak_log
  DROP CONSTRAINT IF EXISTS streak_log_activity_type_check;

ALTER TABLE public.streak_log
  ADD CONSTRAINT streak_log_activity_type_check
  CHECK (activity_type IN ('daily_test', 'activity_pack', 'test', 'both'));

-- ── 3. Optional: drop daily_tests tables if you want to clean up ───────────────
-- WARNING: This permanently deletes all daily test data.
-- Only run after confirming no data needs to be preserved.

-- DROP TABLE IF EXISTS public.daily_test_attempts CASCADE;
-- DROP TABLE IF EXISTS public.daily_tests CASCADE;

-- ── 4. Optional: drop teacher_premium_access.can_create_daily_tests column ─────
-- ALTER TABLE public.teacher_premium_access
--   DROP COLUMN IF EXISTS can_create_daily_tests;

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Verify with:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'tests'
-- ORDER BY ordinal_position;
