-- ============================================================
-- Add web attempt support
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================

-- 1. Add allow_web_attempt to tests table (default false = phone only)
ALTER TABLE public.tests
  ADD COLUMN IF NOT EXISTS allow_web_attempt boolean NOT NULL DEFAULT false;

-- 2. Add attempt_platform to test_attempts table
ALTER TABLE public.test_attempts
  ADD COLUMN IF NOT EXISTS attempt_platform text
    CHECK (attempt_platform IN ('mobile', 'web'));
