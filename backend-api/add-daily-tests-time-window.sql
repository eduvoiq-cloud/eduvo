-- ============================================================
-- Add time_limit + test window to daily_tests — run once in Supabase SQL editor
-- ============================================================

-- 1. Add time_limit_minutes (optional; NULL = no limit)
ALTER TABLE public.daily_tests
  ADD COLUMN IF NOT EXISTS time_limit_minutes integer;

-- 2. Add test window: available_from / available_until (HH:MM strings, e.g. '09:00')
ALTER TABLE public.daily_tests
  ADD COLUMN IF NOT EXISTS available_from text;

ALTER TABLE public.daily_tests
  ADD COLUMN IF NOT EXISTS available_until text;

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Verify with:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'daily_tests'
-- ORDER BY ordinal_position;
