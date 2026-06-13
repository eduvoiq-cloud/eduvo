-- ============================================================
-- Eduvo — Homework Batch AI Evaluation Migration
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================
-- Adds check_suspicious flag to homework and templates tables
-- so teachers can opt in to AI-generated-text detection.
-- By default: FALSE (no suspicious check).
-- ============================================================

-- 1. Add check_suspicious to homework
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS check_suspicious boolean NOT NULL DEFAULT false;

-- 2. Add check_suspicious to teacher_homework_templates
ALTER TABLE public.teacher_homework_templates
  ADD COLUMN IF NOT EXISTS check_suspicious boolean NOT NULL DEFAULT false;

-- 3. Add subject_type to teacher_homework_templates (if missing)
ALTER TABLE public.teacher_homework_templates
  ADD COLUMN IF NOT EXISTS subject_type text
  CHECK (subject_type IN ('theory', 'numerical', 'mixed'));

-- 4. Add index on (status, homework_id) for fast batch eval queries
--    The nightly cron fetches all submissions where status = 'submitted'
CREATE INDEX IF NOT EXISTS idx_hw_submissions_status_hw
  ON public.homework_submissions(status, homework_id)
  WHERE status = 'submitted';

-- 5. Add evaluated_at timestamp so we can track when the cron ran
ALTER TABLE public.homework_submissions
  ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;

-- 6. Ensure flagged_reason allows 'suspiciously_perfect'
--    (already in the original migration; this is a no-op re-run guard)
DO $$
BEGIN
  -- Drop old constraint if it lacks the new value, then recreate
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name = 'homework_submissions_flagged_reason_check'
  ) THEN
    -- Check if 'suspiciously_perfect' is already covered
    -- The original migration already includes it, so this is just documentation
    NULL;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
