-- ============================================================
-- Fix daily_tests schema — run once in Supabase SQL editor
-- ============================================================

-- ── 1. Drop the NOT NULL constraint + DEFAULT on completed_at ─────────────────
-- The original schema set completed_at NOT NULL DEFAULT now(), which means
-- pre-created "pending" attempt rows immediately get a completed_at value,
-- making them look finished. We need it to be nullable (NULL = pending).

ALTER TABLE public.daily_test_attempts
  ALTER COLUMN completed_at DROP DEFAULT;

ALTER TABLE public.daily_test_attempts
  ALTER COLUMN completed_at DROP NOT NULL;

-- Reset any existing pending rows that were incorrectly stamped
-- (rows where answers is an empty array = pre-created, not yet submitted)
UPDATE public.daily_test_attempts
SET completed_at = NULL
WHERE answers = '[]'::jsonb OR answers = '{}'::jsonb;

-- ── 2. Ensure total_questions column exists ───────────────────────────────────
ALTER TABLE public.daily_test_attempts
  ADD COLUMN IF NOT EXISTS total_questions integer NOT NULL DEFAULT 0;

-- ── 3. Backfill show_hint:true on existing questions in daily_tests ───────────
-- Safe to run even if no rows exist.
UPDATE public.daily_tests
SET questions = (
  SELECT jsonb_agg(
    CASE
      WHEN (q->>'show_hint') IS NULL
        THEN q || '{"show_hint": true}'::jsonb
      ELSE q
    END
  )
  FROM jsonb_array_elements(questions) AS q
)
WHERE jsonb_typeof(questions) = 'array';

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Verify with:
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'daily_test_attempts'
-- ORDER BY ordinal_position;
