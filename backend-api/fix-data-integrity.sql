-- ============================================================
-- Eduvo — Data Integrity Migration
-- File: fix-data-integrity.sql
--
-- HOW TO RUN: Paste into Supabase SQL Editor and click Run.
-- DO NOT run automatically — review each section first.
-- ============================================================


-- ── FIX 1: Restore FK on student_answers ─────────────────────────────────────
-- Background: the FK was intentionally dropped because student_answers.question_id
-- references EITHER test_questions OR questions depending on how the test was
-- created. However, without ANY FK, rows with invalid question_ids accumulate
-- (orphaned answers) and silently corrupt results.
--
-- Resolution: restore the FK pointing to test_questions with ON DELETE CASCADE.
-- The questions table is the "advanced" table; its rows are always mirrored into
-- test_questions by the create route, so one FK is sufficient and correct.

ALTER TABLE public.student_answers
  DROP CONSTRAINT IF EXISTS student_answers_question_id_fkey;

ALTER TABLE public.student_answers
  ADD CONSTRAINT student_answers_question_id_fkey
  FOREIGN KEY (question_id)
  REFERENCES public.test_questions(id)
  ON DELETE CASCADE;


-- ── FIX 2: Add fcm_tokens table if missing ────────────────────────────────────
-- The table is already defined in the main migration but may be absent on older
-- deployments. CREATE TABLE IF NOT EXISTS is safe to re-run.
--
-- This version adds a `platform` column matching the mobile app's token
-- registration payload ('ios' | 'android' | 'web') and aligns the owner
-- constraint name with the rest of the schema.

CREATE TABLE IF NOT EXISTS public.fcm_tokens (
  id         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    uuid        REFERENCES public.users(id)    ON DELETE CASCADE,
  student_id uuid        REFERENCES public.students(id) ON DELETE CASCADE,
  token      text        NOT NULL UNIQUE,
  platform   text        CHECK (platform IN ('ios', 'android', 'web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_fcm_one_owner CHECK (
    (user_id IS NOT NULL AND student_id IS NULL) OR
    (user_id IS NULL    AND student_id IS NOT NULL)
  )
);

ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;

-- Deny all direct client access — backend uses service-role key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'fcm_tokens'
      AND policyname = 'deny_all_fcm_tokens'
  ) THEN
    CREATE POLICY "deny_all_fcm_tokens" ON public.fcm_tokens FOR ALL USING (false);
  END IF;
END $$;

-- Partial indexes — only index rows that actually have the relevant FK set.
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_id
  ON public.fcm_tokens(user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_student_id
  ON public.fcm_tokens(student_id)
  WHERE student_id IS NOT NULL;


-- ── FIX 3: Add missing indexes for high-frequency queries ─────────────────────
-- These queries run on every student dashboard load and on every scheduled job.
-- Without indexes they do full-table scans which will degrade as the dataset grows.

-- Parent subscription status checks (parent dashboard, push notification gate)
CREATE INDEX IF NOT EXISTS idx_parent_subscriptions_active
  ON public.parent_subscriptions(student_id, status, expires_at);

-- Daily test attempt lookups (streak engine, test-gate, analytics)
CREATE INDEX IF NOT EXISTS idx_daily_test_attempts_student_status
  ON public.daily_test_attempts(student_id, status);

-- Streak log lookups (streak display, streak recovery eligibility)
-- Already created by the streak migration above but guarded with IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_streak_log_student_date
  ON public.streak_log(student_id, activity_date DESC);

-- Marks queries (student report card, teacher analytics)
CREATE INDEX IF NOT EXISTS idx_marks_student_subject
  ON public.marks(student_id, subject);

-- Homework submission lookups (student homework list, pending-count badge)
CREATE INDEX IF NOT EXISTS idx_homework_submissions_student
  ON public.homework_submissions(student_id, status);

-- Monthly report lookups (parent report card screen)
CREATE INDEX IF NOT EXISTS idx_monthly_reports_student_month
  ON public.monthly_reports(student_id, month_start_date DESC);


-- ── Reload PostgREST schema cache ─────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
