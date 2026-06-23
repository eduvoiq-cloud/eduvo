-- Migration: add per-batch processing lock columns for deliver idempotency
-- Run manually in Supabase SQL Editor.
-- DO NOT apply via automated migration runner.

ALTER TABLE public.monthly_report_batches
  ADD COLUMN IF NOT EXISTS deliver_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS deliver_lock_id   text;

-- FIX 17: Store the set of expected student IDs at batch submission time.
-- Used to validate Gemini batch result keys against the students that were
-- actually submitted, preventing a malformed AI response from writing a
-- report to the wrong student's record.
ALTER TABLE public.monthly_report_batches
  ADD COLUMN IF NOT EXISTS expected_student_ids jsonb;

NOTIFY pgrst, 'reload schema';
