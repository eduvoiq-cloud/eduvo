-- ── Add started_at to daily_test_attempts ─────────────────────────────────────
-- Enables server-side timer: the client computes remaining time as
--   time_limit_minutes * 60 - elapsed_seconds_since(started_at)
-- This means the timer keeps running even when the student leaves the app.

ALTER TABLE public.daily_test_attempts
  ADD COLUMN IF NOT EXISTS started_at timestamptz NULL;

-- Back-fill existing completed rows so they have a valid started_at
-- (use completed_at as a proxy — accurate enough for historical data)
UPDATE public.daily_test_attempts
SET started_at = completed_at
WHERE started_at IS NULL AND completed_at IS NOT NULL;

-- Index for fast lookup on resume
CREATE INDEX IF NOT EXISTS idx_daily_test_attempts_started
  ON public.daily_test_attempts(student_id, started_at);

NOTIFY pgrst, 'reload schema';
