-- ============================================================
-- Migration: student_report_cards table
-- Stores per-student report card metadata so students can view
-- their report cards in the mobile app.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.student_report_cards (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id    uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  class_name    text NOT NULL,
  section       text NOT NULL,
  term          text NOT NULL,
  exam_type     text NOT NULL,
  -- Aggregated data (stored as JSON for flexibility)
  marks         jsonb NOT NULL DEFAULT '[]',   -- [{subject, score, max_score, percentage}]
  grand_total   numeric(8,2) NOT NULL DEFAULT 0,
  grand_max     numeric(8,2) NOT NULL DEFAULT 0,
  percentage    numeric(5,2) NOT NULL DEFAULT 0,
  grade         text NOT NULL DEFAULT '',
  session_year  text NOT NULL DEFAULT '',
  generated_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for fast student lookups
CREATE INDEX IF NOT EXISTS idx_student_report_cards_student_id
  ON public.student_report_cards(student_id);

CREATE INDEX IF NOT EXISTS idx_student_report_cards_school_id
  ON public.student_report_cards(school_id);

-- Unique constraint: one report card per student per term+exam_type
-- (upsert on conflict)
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_report_cards_unique
  ON public.student_report_cards(student_id, term, exam_type);

-- RLS: enable row-level security
ALTER TABLE public.student_report_cards ENABLE ROW LEVEL SECURITY;

-- Allow service role (backend) full access
CREATE POLICY "service_role_all" ON public.student_report_cards
  FOR ALL
  USING (true)
  WITH CHECK (true);
