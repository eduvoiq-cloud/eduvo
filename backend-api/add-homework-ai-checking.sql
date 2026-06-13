-- ============================================================
-- Eduvo — Homework AI Checking Migration
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================
-- Extends the existing `homework` table with AI-checking columns,
-- and adds three new tables:
--   - homework_submissions       (one row per student per homework)
--   - homework_evaluation_cache  (deduplicate identical AI evaluations)
--   - teacher_homework_templates (reusable homework templates)
-- ============================================================

-- =========================================================
-- 1. ALTER homework: add AI-checking columns
--    All columns use IF NOT EXISTS — safe to re-run.
-- =========================================================

-- What the teacher taught / expects as the correct answer
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS reference_answer text;

-- Minimum word count the student must write
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS min_word_count integer;

-- Whether the submission must include a diagram
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS requires_diagram boolean NOT NULL DEFAULT false;

-- How students may submit: typed text, photo, or either
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS submission_type text NOT NULL DEFAULT 'either'
  CHECK (submission_type IN ('typed', 'photo', 'either'));

-- Master switch: should Gemini evaluate submissions for this homework?
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS ai_check_enabled boolean NOT NULL DEFAULT false;

-- Subject classification used to tune AI evaluation behaviour
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS subject_type text
  CHECK (subject_type IN ('theory', 'numerical', 'mixed'));

-- =========================================================
-- 2. CREATE homework_submissions
-- =========================================================

CREATE TABLE IF NOT EXISTS public.homework_submissions (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  homework_id             uuid NOT NULL REFERENCES public.homework(id) ON DELETE CASCADE,
  student_id              uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  submission_text         text,
  submission_image_urls   text[],
  submitted_at            timestamptz,
  status                  text NOT NULL DEFAULT 'not_submitted'
                            CHECK (status IN ('not_submitted','submitted','processing','checked','flagged_for_review')),
  ai_result               text CHECK (ai_result IN ('correct','incorrect','partial','needs_review')),
  ai_confidence           numeric,
  ai_feedback             text,
  teacher_reviewed        boolean NOT NULL DEFAULT false,
  teacher_override_result text,
  image_hash              text,
  exif_timestamp          timestamptz,
  flagged_reason          text CHECK (flagged_reason IN ('low_confidence','duplicate_image','suspicious_perfect','old_photo')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (homework_id, student_id)
);

ALTER TABLE public.homework_submissions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='homework_submissions' AND policyname='hw_sub_student_insert') THEN
    CREATE POLICY "hw_sub_student_insert" ON public.homework_submissions FOR INSERT TO authenticated
      WITH CHECK (student_id IN (SELECT id FROM public.students WHERE id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='homework_submissions' AND policyname='hw_sub_student_select') THEN
    CREATE POLICY "hw_sub_student_select" ON public.homework_submissions FOR SELECT TO authenticated
      USING (student_id IN (SELECT id FROM public.students WHERE id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='homework_submissions' AND policyname='hw_sub_teacher_read_update') THEN
    CREATE POLICY "hw_sub_teacher_read_update" ON public.homework_submissions FOR ALL TO authenticated
      USING (homework_id IN (SELECT id FROM public.homework WHERE created_by = auth.uid()))
      WITH CHECK (homework_id IN (SELECT id FROM public.homework WHERE created_by = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='homework_submissions' AND policyname='hw_sub_admin_read') THEN
    CREATE POLICY "hw_sub_admin_read" ON public.homework_submissions FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('superadmin','schooladmin')));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_hw_submissions_homework_student ON public.homework_submissions(homework_id, student_id);
CREATE INDEX IF NOT EXISTS idx_hw_submissions_status ON public.homework_submissions(status);

-- =========================================================
-- 3. CREATE homework_evaluation_cache
-- =========================================================

CREATE TABLE IF NOT EXISTS public.homework_evaluation_cache (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_hash   text NOT NULL,
  answer_hash     text NOT NULL,
  cached_result   text NOT NULL,
  cached_feedback text NOT NULL,
  hit_count       integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_hash, answer_hash)
);

-- Backend service role only. Enabling RLS with no user policies = default deny.
ALTER TABLE public.homework_evaluation_cache ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_hw_eval_cache_hashes ON public.homework_evaluation_cache(question_hash, answer_hash);

-- =========================================================
-- 4. CREATE teacher_homework_templates
-- =========================================================

CREATE TABLE IF NOT EXISTS public.teacher_homework_templates (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  subject          text NOT NULL,
  template_name    text NOT NULL,
  reference_answer text,
  min_word_count   integer,
  requires_diagram boolean NOT NULL DEFAULT false,
  submission_type  text NOT NULL DEFAULT 'either'
                     CHECK (submission_type IN ('typed','photo','either')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.teacher_homework_templates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='teacher_homework_templates' AND policyname='hw_tmpl_teacher_own') THEN
    CREATE POLICY "hw_tmpl_teacher_own" ON public.teacher_homework_templates FOR ALL TO authenticated
      USING (teacher_id = auth.uid())
      WITH CHECK (teacher_id = auth.uid());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='teacher_homework_templates' AND policyname='hw_tmpl_admin_read') THEN
    CREATE POLICY "hw_tmpl_admin_read" ON public.teacher_homework_templates FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('superadmin','schooladmin')));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_hw_templates_teacher_subject ON public.teacher_homework_templates(teacher_id, subject);

NOTIFY pgrst, 'reload schema';
