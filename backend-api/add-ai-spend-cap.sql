-- ============================================================
-- Eduvo — AI Spend Cap Migration
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================
-- 1. ai_homework_enabled (bool) — per-school feature toggle.
--    When false, the batch job skips all AI evals for that school.
--    Default: true (no change to existing behaviour).
--
-- 2. daily_ai_spend_cap_inr (numeric) — per-school daily spend cap in INR.
--    When a school's estimated spend for the current UTC day reaches this
--    value, the batch job stops making AI calls for that school for the rest
--    of the day. Cache hits and numerical evals (zero cost) still run.
--    NULL = no cap (unlimited). Default: NULL.
-- ============================================================

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS ai_homework_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS daily_ai_spend_cap_inr numeric(10, 2) DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
