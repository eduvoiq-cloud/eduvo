-- ============================================================
-- Security Patch Migration
-- Adds RLS to tables created in later migrations that were
-- missing Row Level Security. All tables use deny-all policies
-- because the backend exclusively uses the service-role key
-- which bypasses RLS — direct client access should be denied.
--
-- Run in: Supabase Dashboard → SQL Editor
-- Safe to run multiple times (idempotent).
-- ============================================================

-- ── fcm_tokens ────────────────────────────────────────────────────────────────
ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fcm_tokens'
      AND policyname = 'deny_all_fcm_tokens'
  ) THEN
    CREATE POLICY "deny_all_fcm_tokens"
      ON public.fcm_tokens FOR ALL USING (false);
  END IF;
END $$;

-- ── audit_logs: ensure RLS is enabled (added in schema but double-check) ─────
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_logs'
      AND policyname = 'deny_all_audit_logs'
  ) THEN
    CREATE POLICY "deny_all_audit_logs"
      ON public.audit_logs FOR ALL USING (false);
  END IF;
END $$;

-- ── password_reset_tokens: ensure deny-all policy exists ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'password_reset_tokens'
      AND policyname = 'deny_all_password_reset_tokens'
  ) THEN
    CREATE POLICY "deny_all_password_reset_tokens"
      ON public.password_reset_tokens FOR ALL USING (false);
  END IF;
END $$;

-- ── student_answers: ensure deny-all policy exists ────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'student_answers'
      AND policyname = 'deny_all_student_answers'
  ) THEN
    CREATE POLICY "deny_all_student_answers"
      ON public.student_answers FOR ALL USING (false);
  END IF;
END $$;

-- ── test_attempts: ensure deny-all policy exists ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'test_attempts'
      AND policyname = 'deny_all_test_attempts'
  ) THEN
    CREATE POLICY "deny_all_test_attempts"
      ON public.test_attempts FOR ALL USING (false);
  END IF;
END $$;

-- ── timetable: ensure deny-all policy exists ──────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'timetable'
      AND policyname = 'deny_all_timetable'
  ) THEN
    CREATE POLICY "deny_all_timetable"
      ON public.timetable FOR ALL USING (false);
  END IF;
END $$;

-- ── homework: ensure deny-all policy exists ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'homework'
      AND policyname = 'deny_all_homework'
  ) THEN
    CREATE POLICY "deny_all_homework"
      ON public.homework FOR ALL USING (false);
  END IF;
END $$;

-- ── homework_acknowledgements: ensure deny-all policy exists ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'homework_acknowledgements'
      AND policyname = 'deny_all_homework_acknowledgements'
  ) THEN
    CREATE POLICY "deny_all_homework_acknowledgements"
      ON public.homework_acknowledgements FOR ALL USING (false);
  END IF;
END $$;

-- ── questions: ensure deny-all policy exists ──────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'questions'
      AND policyname = 'deny_all_questions'
  ) THEN
    CREATE POLICY "deny_all_questions"
      ON public.questions FOR ALL USING (false);
  END IF;
END $$;

-- Verification query (run this after to confirm all tables have RLS enabled):
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY tablename;
