-- Add batch_job_id to recovery_cycles so we can track the Gemini Batch API job
-- for both pack and test generation phases.
ALTER TABLE recovery_cycles
  ADD COLUMN IF NOT EXISTS pack_batch_job_id  text,
  ADD COLUMN IF NOT EXISTS test_batch_job_id  text;

-- Also allow pack_failed and test_failed statuses (were missing from original CHECK constraint)
ALTER TABLE recovery_cycles
  DROP CONSTRAINT IF EXISTS recovery_cycles_status_check;

ALTER TABLE recovery_cycles
  ADD CONSTRAINT recovery_cycles_status_check
  CHECK (status IN (
    'generating_pack',
    'pack_ready',
    'pack_failed',
    'generating_tests',
    'tests_ready',
    'test_failed',
    'completed'
  ));
