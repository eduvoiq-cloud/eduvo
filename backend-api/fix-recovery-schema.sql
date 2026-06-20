-- ============================================================
-- Fix: Recovery system schema issues
--
-- 1. Make recovery_packs.recovery_schedule_id nullable so that
--    cycle-based packs (which don't belong to a monthly_recovery_schedule)
--    can be inserted without error.
--
-- 2. Add 'pack_failed' and 'test_failed' to recovery_cycles status CHECK
--    so the background job can mark failures properly and teachers can retry.
--
-- Run in: Supabase SQL editor
-- Safe to re-run (each step is guarded).
-- ============================================================

-- Step 1: Drop NOT NULL on recovery_packs.recovery_schedule_id
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'recovery_packs'
      AND column_name  = 'recovery_schedule_id'
      AND is_nullable  = 'NO'
  ) THEN
    ALTER TABLE public.recovery_packs
      ALTER COLUMN recovery_schedule_id DROP NOT NULL;
    RAISE NOTICE 'recovery_packs.recovery_schedule_id is now nullable';
  ELSE
    RAISE NOTICE 'recovery_packs.recovery_schedule_id is already nullable — skipping';
  END IF;
END $$;

-- Step 2: Widen the recovery_cycles.status CHECK constraint to allow failure states
-- We must drop the old constraint and recreate it (ALTER TABLE ... CHECK has no
-- IF NOT EXISTS equivalent).
DO $$ BEGIN
  -- Drop existing CHECK on status (the name varies, so look it up dynamically)
  DECLARE
    v_constraint text;
  BEGIN
    SELECT constraint_name INTO v_constraint
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name        = 'recovery_cycles'
      AND constraint_type   = 'CHECK'
      AND constraint_name   LIKE '%status%'
    LIMIT 1;

    IF v_constraint IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.recovery_cycles DROP CONSTRAINT %I', v_constraint);
      RAISE NOTICE 'Dropped old CHECK constraint: %', v_constraint;
    END IF;
  END;
END $$;

ALTER TABLE public.recovery_cycles
  DROP CONSTRAINT IF EXISTS recovery_cycles_status_check;

ALTER TABLE public.recovery_cycles
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

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- After running this SQL:
--   1. Pack-only inserts from /api/recovery/start-pack no longer fail
--      with NOT NULL violation on recovery_schedule_id.
--   2. A failed pack gen sets status='pack_failed' without hitting
--      the CHECK constraint, so teachers see the retry button.
-- ============================================================
