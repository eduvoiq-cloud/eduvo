-- ============================================================
-- Eduvo — Weekly Reports Migration
-- Stores AI-generated weekly performance summaries per student.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Safe to re-run (all statements are idempotent).
-- ============================================================

-- ── weekly_reports ────────────────────────────────────────────────────────────
-- One row per student per week. week_start_date is always a Sunday (ISO 8601).
CREATE TABLE IF NOT EXISTS public.weekly_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  week_start_date date NOT NULL,
  report_text     text NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One report per student per week
  UNIQUE (student_id, week_start_date)
);

ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Student: own rows only
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'weekly_reports'
      AND policyname = 'student_own_weekly_reports'
  ) THEN
    CREATE POLICY "student_own_weekly_reports"
      ON public.weekly_reports
      FOR SELECT
      USING (
        student_id IN (
          SELECT s.id FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student' AND s.school_id = u.school_id
        )
        OR
        student_id IN (
          SELECT s.id FROM public.students s WHERE s.parent_id = auth.uid()
        )
      );
  END IF;

  -- Parent: read children's reports (via parent_students junction)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'weekly_reports'
      AND policyname = 'parent_read_weekly_reports'
  ) THEN
    CREATE POLICY "parent_read_weekly_reports"
      ON public.weekly_reports
      FOR SELECT
      USING (
        student_id IN (
          SELECT ps.student_id FROM public.parent_students ps
          WHERE ps.parent_id = auth.uid()
        )
      );
  END IF;

  -- school_admin / superadmin: read all
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'weekly_reports'
      AND policyname = 'admin_read_weekly_reports'
  ) THEN
    CREATE POLICY "admin_read_weekly_reports"
      ON public.weekly_reports
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.students s ON s.id = weekly_reports.student_id
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = s.school_id)
        )
      );
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_weekly_reports_student_week
  ON public.weekly_reports(student_id, week_start_date DESC);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_week
  ON public.weekly_reports(week_start_date);

NOTIFY pgrst, 'reload schema';
