-- ============================================================
-- Eduvo — Schema Migration
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================

-- students: add missing columns (actual DB uses "class" but code expects "class_name")
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS class_name text;
UPDATE public.students SET class_name = "class" WHERE class_name IS NULL;

ALTER TABLE public.students ADD COLUMN IF NOT EXISTS rfid_uid text;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS date_of_birth date;

-- teacher_assignments: add class_name (actual DB uses "class")
ALTER TABLE public.teacher_assignments ADD COLUMN IF NOT EXISTS class_name text;
UPDATE public.teacher_assignments SET class_name = "class" WHERE class_name IS NULL;

-- users: add missing columns
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- complaints: add missing columns
ALTER TABLE public.complaints ADD COLUMN IF NOT EXISTS resolution_note text;
ALTER TABLE public.complaints ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.complaints ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- marks: add missing notes column
ALTER TABLE public.marks ADD COLUMN IF NOT EXISTS notes text;

-- marks: update exam_type constraint to match frontend values
-- Drop old constraint and add new one that includes unit_test, mid_term, class_test
ALTER TABLE public.marks DROP CONSTRAINT IF EXISTS marks_exam_type_check;
ALTER TABLE public.marks ADD CONSTRAINT marks_exam_type_check
  CHECK (exam_type IN ('quiz', 'midterm', 'final', 'assignment', 'project', 'unit_test', 'mid_term', 'class_test'));
