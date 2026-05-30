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

-- marks: add all missing columns
ALTER TABLE public.marks ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.marks ADD COLUMN IF NOT EXISTS recorded_by uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.marks ADD COLUMN IF NOT EXISTS max_score numeric(6,2) NOT NULL DEFAULT 100;

-- marks: update exam_type constraint to match frontend values
ALTER TABLE public.marks DROP CONSTRAINT IF EXISTS marks_exam_type_check;
ALTER TABLE public.marks ADD CONSTRAINT marks_exam_type_check
  CHECK (exam_type IN ('quiz', 'midterm', 'final', 'assignment', 'project', 'unit_test', 'mid_term', 'class_test'));

-- attendance: add notification_sent column (used by attendanceNotifications service)
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS notification_sent boolean NOT NULL DEFAULT false;

-- attendance: add updated_at column (used by the /correct route)
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- users: add fcm_token column (used by push notification service)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS fcm_token text;

-- marks: ensure created_at exists (belt-and-suspenders for older DBs)
ALTER TABLE public.marks ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Index for fast unsent-notification lookups
CREATE INDEX IF NOT EXISTS idx_attendance_notification_sent
  ON public.attendance(notification_sent) WHERE notification_sent = false;

-- notifications: rename 'message' -> 'body' to match application code
-- (live DB was created with 'message'; schema and code both expect 'body')
DO $$
BEGIN
  -- rename message -> body if message exists and body does not
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'message'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'body'
  ) THEN
    ALTER TABLE public.notifications RENAME COLUMN message TO body;
  END IF;

  -- if body still doesn't exist for any reason, add it
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'body'
  ) THEN
    ALTER TABLE public.notifications ADD COLUMN body text NOT NULL DEFAULT '';
  END IF;
END $$;

-- notifications: add read_at column if missing
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- ── tests: create table if it was never created ───────────────────────────────
-- The original DB may have been set up before the tests feature was added.
CREATE TABLE IF NOT EXISTS public.tests (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  title       text NOT NULL,
  subject     text NOT NULL,
  class_name  text NOT NULL,
  section     text NOT NULL,
  term        text NOT NULL,
  date        date NOT NULL,
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- tests: add optional columns used by the advanced /create route
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS time_limit_minutes integer;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS shuffle_questions boolean NOT NULL DEFAULT false;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS shuffle_options  boolean NOT NULL DEFAULT false;
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES public.subjects(id) ON DELETE SET NULL;

-- ── test_questions: create table if it was never created ─────────────────────
-- This is the table the compatibility POST /api/tests route writes to.
-- Without it every create/list call returns 500.
CREATE TABLE IF NOT EXISTS public.test_questions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  test_id         uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  order_index     integer NOT NULL DEFAULT 0,
  type            text NOT NULL CHECK (type IN ('mcq', 'theory')),
  text            text NOT NULL,
  marks           numeric(5,2) NOT NULL,
  options         jsonb,           -- [{text: string}] × 4 for MCQ, null for theory
  correct_option  integer,         -- 0-3 index for MCQ, null for theory
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS (deny direct client access — backend uses service-role key)
ALTER TABLE public.tests          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_questions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'tests' AND policyname = 'deny_all_tests'
  ) THEN
    CREATE POLICY "deny_all_tests" ON public.tests FOR ALL USING (false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'test_questions' AND policyname = 'deny_all_test_questions'
  ) THEN
    CREATE POLICY "deny_all_test_questions" ON public.test_questions FOR ALL USING (false);
  END IF;
END $$;

-- Indexes for tests
CREATE INDEX IF NOT EXISTS idx_tests_school_class    ON public.tests(school_id, class_name, section);
CREATE INDEX IF NOT EXISTS idx_tests_created_by      ON public.tests(created_by);
CREATE INDEX IF NOT EXISTS idx_test_questions_test_id ON public.test_questions(test_id);

-- Drop the term check constraint on tests — term is free text, any value should be valid
ALTER TABLE public.tests DROP CONSTRAINT IF EXISTS tests_term_check;

NOTIFY pgrst, 'reload schema';
