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
-- NOTE: column is named "class" (not "class_name") to match backend queries.
CREATE TABLE IF NOT EXISTS public.tests (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  title       text NOT NULL,
  subject     text NOT NULL,
  class       text NOT NULL,
  section     text NOT NULL,
  term        text NOT NULL,
  date        date NOT NULL,
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- If the table was created with class_name instead of class, rename it
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tests' AND column_name = 'class_name'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tests' AND column_name = 'class'
  ) THEN
    ALTER TABLE public.tests RENAME COLUMN class_name TO class;
  END IF;
END $$;

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
CREATE INDEX IF NOT EXISTS idx_tests_school_class    ON public.tests(school_id, class, section);
CREATE INDEX IF NOT EXISTS idx_tests_created_by      ON public.tests(created_by);
CREATE INDEX IF NOT EXISTS idx_test_questions_test_id ON public.test_questions(test_id);

-- Drop the term check constraint on tests — term is free text, any value should be valid
ALTER TABLE public.tests DROP CONSTRAINT IF EXISTS tests_term_check;

NOTIFY pgrst, 'reload schema';

-- ── timetable: create table ───────────────────────────────────────────────────
-- One row per period slot (class + section + day + period_number).
-- subject_id references subjects; teacher_id references users.
CREATE TABLE IF NOT EXISTS public.timetable (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id      uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  class_name     text NOT NULL,
  section        text NOT NULL,
  day_of_week    text NOT NULL CHECK (day_of_week IN ('monday','tuesday','wednesday','thursday','friday','saturday')),
  period_number  integer NOT NULL CHECK (period_number > 0),
  start_time     text NOT NULL,   -- HH:MM
  end_time       text NOT NULL,   -- HH:MM
  subject_id     uuid NOT NULL REFERENCES public.subjects(id) ON DELETE RESTRICT,
  teacher_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- No two periods can occupy the same slot for the same class
  UNIQUE (school_id, class_name, section, day_of_week, period_number)
);

-- Enable RLS (backend uses service-role key which bypasses RLS)
ALTER TABLE public.timetable ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'timetable' AND policyname = 'deny_all_timetable'
  ) THEN
    CREATE POLICY "deny_all_timetable" ON public.timetable FOR ALL USING (false);
  END IF;
END $$;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_timetable_class_section
  ON public.timetable(school_id, class_name, section);

CREATE INDEX IF NOT EXISTS idx_timetable_teacher
  ON public.timetable(teacher_id);

NOTIFY pgrst, 'reload schema';

-- ── homework: create table ────────────────────────────────────────────────────
-- One row per homework assignment. Submissions are Phase 2.
CREATE TABLE IF NOT EXISTS public.homework (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  subject_id  uuid NOT NULL REFERENCES public.subjects(id) ON DELETE RESTRICT,
  class_name  text NOT NULL,
  section     text NOT NULL,
  title       text NOT NULL,
  description text,
  due_date    date NOT NULL,
  file_url    text,                          -- Supabase Storage URL (optional)
  created_by  uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- students table needs an fcm_token column for direct student push notifications
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS fcm_token text;

-- Enable RLS (backend uses service-role key which bypasses RLS)
ALTER TABLE public.homework ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'homework' AND policyname = 'deny_all_homework'
  ) THEN
    CREATE POLICY "deny_all_homework" ON public.homework FOR ALL USING (false);
  END IF;
END $$;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_homework_school_class
  ON public.homework(school_id, class_name, section);

CREATE INDEX IF NOT EXISTS idx_homework_due_date
  ON public.homework(due_date);

CREATE INDEX IF NOT EXISTS idx_homework_created_by
  ON public.homework(created_by);

-- ── homework_acknowledgements: create table ───────────────────────────────────
-- Student marks homework as "seen". One row per (homework, student) pair.
CREATE TABLE IF NOT EXISTS public.homework_acknowledgements (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  homework_id     uuid NOT NULL REFERENCES public.homework(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (homework_id, student_id)
);

ALTER TABLE public.homework_acknowledgements ENABLE ROW LEVEL SECURITY;

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

-- Index for fast pending-count lookups
CREATE INDEX IF NOT EXISTS idx_hw_ack_student
  ON public.homework_acknowledgements(student_id, homework_id);

NOTIFY pgrst, 'reload schema';

-- ── student_fees: add payment amount columns ──────────────────────────────────
-- Adds total_fee_amount and amount_paid so teachers can track partial payments.
-- fee_paid is now derived: amount_paid >= total_fee_amount (when both are set).
ALTER TABLE public.student_fees
  ADD COLUMN IF NOT EXISTS total_fee_amount numeric(12,2);

ALTER TABLE public.student_fees
  ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2) NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';

-- ── complaints: add student-facing complaint fields ───────────────────────────
-- Adds recipient_type, teacher_id, message, and response_message columns
-- to support the two-recipient complaint system (class_teacher | school_admin).

-- recipient_type: who the complaint is directed to
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS recipient_type text
  CHECK (recipient_type IN ('class_teacher', 'school_admin'));

-- teacher_id: set when recipient_type = 'class_teacher', null for school_admin
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS teacher_id uuid
  REFERENCES public.users(id) ON DELETE SET NULL;

-- message: the complaint body from the student (max 1000 chars enforced in API)
-- Kept separate from the existing 'body' column (used by old parent complaints)
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS message text;

-- response_message: optional reply from teacher/admin when updating status
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS response_message text;

-- Indexes for the new query patterns
CREATE INDEX IF NOT EXISTS idx_complaints_teacher_id
  ON public.complaints(teacher_id)
  WHERE teacher_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_complaints_student_id
  ON public.complaints(student_id)
  WHERE student_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_complaints_recipient_type
  ON public.complaints(school_id, recipient_type, status);

NOTIFY pgrst, 'reload schema';

-- ── student_fees: make term/academic_year optional, add updated_at ────────────
-- term and academic_year are no longer required — fees can be recorded without
-- specifying a term. updated_at is added so the backend can track last update.
ALTER TABLE public.student_fees
  ALTER COLUMN term DROP NOT NULL;

ALTER TABLE public.student_fees
  ALTER COLUMN academic_year DROP NOT NULL;

ALTER TABLE public.student_fees
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Drop the old unique constraint that required term+academic_year, replace with
-- a partial unique index that handles nulls correctly.
ALTER TABLE public.student_fees
  DROP CONSTRAINT IF EXISTS student_fees_student_id_term_academic_year_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fees_unique_student_term_year
  ON public.student_fees(student_id, COALESCE(term, ''), COALESCE(academic_year, ''));

NOTIFY pgrst, 'reload schema';

-- ── questions: flat question table used by the advanced /api/tests/create route ──
-- The compatibility route writes to test_questions (jsonb options).
-- The advanced route writes to questions (flat option_a/b/c/d columns).
CREATE TABLE IF NOT EXISTS public.questions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  test_id         uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  order_index     integer NOT NULL DEFAULT 0,
  question_text   text NOT NULL,
  question_type   text NOT NULL CHECK (question_type IN ('mcq', 'theory')),
  option_a        text,
  option_b        text,
  option_c        text,
  option_d        text,
  correct_option  text CHECK (correct_option IN ('a', 'b', 'c', 'd')),
  marks           numeric(5,2) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'questions' AND policyname = 'deny_all_questions'
  ) THEN
    CREATE POLICY "deny_all_questions" ON public.questions FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_questions_test_id ON public.questions(test_id);

-- Also add flat columns to test_questions so the student attempt route works
-- with both tables (it queries question_text, option_a/b/c/d, correct_option).
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS question_text   text;
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS question_type   text CHECK (question_type IN ('mcq', 'theory'));
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS option_a        text;
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS option_b        text;
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS option_c        text;
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS option_d        text;
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS correct_option  text CHECK (correct_option IN ('a', 'b', 'c', 'd'));

-- Back-fill question_text / question_type from the existing jsonb columns
UPDATE public.test_questions
SET
  question_text = COALESCE(question_text, text),
  question_type = COALESCE(question_type, type)
WHERE question_text IS NULL OR question_type IS NULL;

NOTIFY pgrst, 'reload schema';

-- ── test_attempts: one row per student-attempt on a test ─────────────────────
CREATE TABLE IF NOT EXISTS public.test_attempts (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  test_id             uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  started_at          timestamptz NOT NULL DEFAULT now(),
  submitted_at        timestamptz,
  is_submitted        boolean NOT NULL DEFAULT false,
  mcq_score           numeric(8,2),
  total_score         numeric(8,2),
  time_limit_exceeded boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, student_id)   -- one attempt per student per test
);

ALTER TABLE public.test_attempts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'test_attempts' AND policyname = 'deny_all_test_attempts'
  ) THEN
    CREATE POLICY "deny_all_test_attempts" ON public.test_attempts FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_test_attempts_student   ON public.test_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_test_attempts_test      ON public.test_attempts(test_id);

-- ── student_answers: one row per question per attempt ────────────────────────
CREATE TABLE IF NOT EXISTS public.student_answers (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  attempt_id       uuid NOT NULL REFERENCES public.test_attempts(id) ON DELETE CASCADE,
  question_id      uuid NOT NULL,   -- references questions or test_questions
  selected_option  text CHECK (selected_option IN ('a', 'b', 'c', 'd')),
  theory_answer    text,
  is_correct       boolean,
  marks_awarded    numeric(5,2),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, question_id)  -- prevents duplicate inserts on retry
);

ALTER TABLE public.student_answers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'student_answers' AND policyname = 'deny_all_student_answers'
  ) THEN
    CREATE POLICY "deny_all_student_answers" ON public.student_answers FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_student_answers_attempt ON public.student_answers(attempt_id);

NOTIFY pgrst, 'reload schema';

-- ── student_answers: drop question_id foreign key ────────────────────────────
-- question_id references either test_questions OR questions table depending on
-- how the test was created. A FK to one table breaks the other. Drop it.
ALTER TABLE public.student_answers DROP CONSTRAINT IF EXISTS student_answers_question_id_fkey;

-- ── tests: add scheduling window columns ─────────────────────────────────────
-- available_from / available_until store HH:MM times (24-hour) so the teacher
-- can restrict when students can open a test on the test date.
-- Both are optional — if NULL, no time restriction is applied.
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS available_from  text;  -- e.g. '09:00'
ALTER TABLE public.tests ADD COLUMN IF NOT EXISTS available_until text;  -- e.g. '10:30'

NOTIFY pgrst, 'reload schema';

-- ── tests: add exam_type column ───────────────────────────────────────────────
-- Allows the teacher to categorise a test (Class Test, Unit Test, Mid Term, etc.)
-- The value is copied into the marks table when test scores are auto-written.
ALTER TABLE public.tests
  ADD COLUMN IF NOT EXISTS exam_type text NOT NULL DEFAULT 'class_test'
  CHECK (exam_type IN ('quiz', 'midterm', 'final', 'assignment', 'project', 'unit_test', 'mid_term', 'class_test'));

NOTIFY pgrst, 'reload schema';

-- ── users: add must_reset_password and phone columns ─────────────────────────
-- must_reset_password: true for bulk-imported teachers who haven't changed their
--   default phone-number password yet. Forces a password-reset screen on login.
-- phone: store phone number for teachers (needed for phone-as-default-password).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS must_reset_password boolean NOT NULL DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone text;

NOTIFY pgrst, 'reload schema';
