-- ============================================================
-- Recovery Cycles Migration
-- Teacher-initiated recovery system (replaces cron scheduling)
-- ============================================================

-- 1. New table: recovery_cycles
-- Tracks one teacher-triggered recovery cycle per class+section.
-- 30-day lockout enforced via lockout_until.
CREATE TABLE IF NOT EXISTS recovery_cycles (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class            text        NOT NULL,
  section          text        NOT NULL,
  created_by       uuid        NOT NULL REFERENCES users(id),
  status           text        NOT NULL DEFAULT 'generating_pack'
    CHECK (status IN ('generating_pack','pack_ready','generating_tests','tests_ready','completed')),
  pack_generated_at  timestamptz,
  test_generated_at  timestamptz,
  lockout_until      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_cycles_school_class_section
  ON recovery_cycles(school_id, class, section);

CREATE INDEX IF NOT EXISTS idx_recovery_cycles_created_by
  ON recovery_cycles(created_by);

-- 2. Extend recovery_packs
ALTER TABLE recovery_packs
  ADD COLUMN IF NOT EXISTS cycle_id            uuid REFERENCES recovery_cycles(id),
  ADD COLUMN IF NOT EXISTS student_profile_type text
    CHECK (student_profile_type IN ('weak','no_data','enrichment'));

CREATE INDEX IF NOT EXISTS idx_recovery_packs_cycle_id
  ON recovery_packs(cycle_id);

-- 3. Extend monthly_recovery_tests
ALTER TABLE monthly_recovery_tests
  ADD COLUMN IF NOT EXISTS cycle_id              uuid REFERENCES recovery_cycles(id),
  ADD COLUMN IF NOT EXISTS time_limit_minutes    int,
  ADD COLUMN IF NOT EXISTS shuffle_questions     boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS shuffle_options       boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS available_from        time,
  ADD COLUMN IF NOT EXISTS available_until       time,
  ADD COLUMN IF NOT EXISTS require_camera        boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_monthly_recovery_tests_cycle_id
  ON monthly_recovery_tests(cycle_id);

-- 4. New table: recovery_test_attempts
-- Tracks per-student attempts for cycle-based recovery tests.
CREATE TABLE IF NOT EXISTS recovery_test_attempts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_test_id    uuid        NOT NULL REFERENCES monthly_recovery_tests(id) ON DELETE CASCADE,
  student_id          uuid        NOT NULL,
  cycle_id            uuid        REFERENCES recovery_cycles(id),
  subject             text        NOT NULL,
  score               int,
  total_questions     int,
  percentage          numeric(5,2),
  answers             jsonb,
  status              text        NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','submitted')),
  started_at          timestamptz DEFAULT now(),
  submitted_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_test_attempts_student
  ON recovery_test_attempts(student_id);

CREATE INDEX IF NOT EXISTS idx_recovery_test_attempts_test
  ON recovery_test_attempts(recovery_test_id);

CREATE INDEX IF NOT EXISTS idx_recovery_test_attempts_cycle
  ON recovery_test_attempts(cycle_id);
