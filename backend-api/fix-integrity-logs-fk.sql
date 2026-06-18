-- ============================================================
-- Fix: test_integrity_logs was referencing the wrong table.
--
-- The mobile app test flow uses `test_attempts` (not `daily_test_attempts`).
-- The original migration pointed the FK at daily_test_attempts, causing every
-- integrity INSERT to fail with a foreign-key violation.
--
-- This migration:
--   1. Drops the wrong FK constraint
--   2. Renames the column from daily_test_attempt_id → test_attempt_id
--   3. Adds the correct FK to test_attempts(id)
--
-- Run in: Supabase SQL editor
-- Safe to re-run (each step is guarded).
-- ============================================================

-- Step 1: Drop the wrong FK constraint (name may vary; catch both possibilities)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'test_integrity_logs'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'test_integrity_logs_daily_test_attempt_id_fkey'
  ) THEN
    ALTER TABLE public.test_integrity_logs
      DROP CONSTRAINT test_integrity_logs_daily_test_attempt_id_fkey;
  END IF;
END $$;

-- Step 2: Rename the column (only if it still has the old name)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'test_integrity_logs'
      AND column_name  = 'daily_test_attempt_id'
  ) THEN
    ALTER TABLE public.test_integrity_logs
      RENAME COLUMN daily_test_attempt_id TO test_attempt_id;
  END IF;
END $$;

-- Step 3: Add the correct FK to test_attempts (only if not already present)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'test_integrity_logs'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'test_integrity_logs_test_attempt_id_fkey'
  ) THEN
    ALTER TABLE public.test_integrity_logs
      ADD CONSTRAINT test_integrity_logs_test_attempt_id_fkey
      FOREIGN KEY (test_attempt_id)
      REFERENCES public.test_attempts(id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Step 4: Recreate index with new column name
DROP INDEX IF EXISTS public.idx_integrity_logs_attempt;
CREATE INDEX IF NOT EXISTS idx_integrity_logs_attempt
  ON public.test_integrity_logs(test_attempt_id);

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- After running this, also deploy the backend fix so the
-- route uses 'test_attempt_id' instead of 'daily_test_attempt_id'.
-- ============================================================
