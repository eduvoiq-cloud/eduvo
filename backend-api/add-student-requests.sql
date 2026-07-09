-- ============================================================
-- Student Requests Migration
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================

-- Create the student_requests table (separate from complaints to avoid breaking anything)
CREATE TABLE IF NOT EXISTS public.student_requests (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject          text,
  message          text NOT NULL,
  recipient_type   text NOT NULL CHECK (recipient_type IN ('subject_teacher', 'school_admin')),
  teacher_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  student_id       uuid REFERENCES public.students(id) ON DELETE SET NULL,
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  resolution_note  text,
  reviewed_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Indexes for efficient lookup
CREATE INDEX IF NOT EXISTS idx_student_requests_student_id  ON public.student_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_student_requests_teacher_id  ON public.student_requests(teacher_id);
CREATE INDEX IF NOT EXISTS idx_student_requests_school_id   ON public.student_requests(school_id);
CREATE INDEX IF NOT EXISTS idx_student_requests_status      ON public.student_requests(school_id, recipient_type, status);

NOTIFY pgrst, 'reload schema';
