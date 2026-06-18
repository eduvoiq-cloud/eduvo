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

-- Add explanation + reasoning columns to questions (used by AI generation)
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS explanation text;
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS reasoning   text;

-- Add explanation + reasoning to test_questions as well (legacy table)
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS explanation text;
ALTER TABLE public.test_questions ADD COLUMN IF NOT EXISTS reasoning   text;

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

-- ── password_reset_tokens ─────────────────────────────────────────────────────
-- Stores hashed one-time tokens for the custom Resend-based forgot-password flow.
-- Raw tokens are never stored — only SHA-256 hashes.
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_prt_token_hash ON public.password_reset_tokens(token_hash);
-- Index for cleanup queries (purge old/used tokens)
CREATE INDEX IF NOT EXISTS idx_prt_user_id ON public.password_reset_tokens(user_id);

-- RLS: only the service role should access this table
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
-- No public policies — only the backend (service role key) can read/write

NOTIFY pgrst, 'reload schema';

-- ── Streak system ─────────────────────────────────────────────────────────────
-- student_streaks: one row per student tracking their current/longest streak.
CREATE TABLE IF NOT EXISTS public.student_streaks (
  student_id             uuid PRIMARY KEY REFERENCES public.students(id) ON DELETE CASCADE,
  current_streak         integer NOT NULL DEFAULT 0,
  longest_streak         integer NOT NULL DEFAULT 0,
  last_activity_date     date,
  streak_freeze_available boolean NOT NULL DEFAULT true,
  total_active_days      integer NOT NULL DEFAULT 0,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- streak_log: one row per (student, activity_date) — records which activity type
-- contributed to the streak on that day.
CREATE TABLE IF NOT EXISTS public.streak_log (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id    uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  activity_date date NOT NULL,
  activity_type text NOT NULL CHECK (activity_type IN ('daily_test', 'activity_pack', 'both')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, activity_date)
);

-- Enable RLS (backend uses service-role key which bypasses RLS)
ALTER TABLE public.student_streaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.streak_log      ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'student_streaks'
      AND policyname = 'deny_all_student_streaks'
  ) THEN
    CREATE POLICY "deny_all_student_streaks" ON public.student_streaks FOR ALL USING (false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'streak_log'
      AND policyname = 'deny_all_streak_log'
  ) THEN
    CREATE POLICY "deny_all_streak_log" ON public.streak_log FOR ALL USING (false);
  END IF;
END $$;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_streak_log_student_date
  ON public.streak_log(student_id, activity_date DESC);

CREATE INDEX IF NOT EXISTS idx_student_streaks_current
  ON public.student_streaks(current_streak DESC);

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Missing tables — added to complete full schema coverage
-- Run after the initial migration above.
-- ============================================================

-- ── fcm_tokens: multi-device push token store ─────────────────────────────────
-- Stores one row per (user/student, device) so users on multiple devices all
-- receive push notifications. The legacy single-token columns (users.fcm_token,
-- students.fcm_token) are still supported as a fallback.
CREATE TABLE IF NOT EXISTS public.fcm_tokens (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid REFERENCES public.users(id) ON DELETE CASCADE,
  student_id  uuid REFERENCES public.students(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  device_type text,    -- 'android' | 'ios' | 'web'
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fcm_tokens_owner_check CHECK (
    (user_id IS NOT NULL AND student_id IS NULL) OR
    (user_id IS NULL AND student_id IS NOT NULL)
  )
);

ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fcm_tokens' AND policyname = 'deny_all_fcm_tokens'
  ) THEN
    CREATE POLICY "deny_all_fcm_tokens" ON public.fcm_tokens FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_id    ON public.fcm_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_student_id ON public.fcm_tokens(student_id);

NOTIFY pgrst, 'reload schema';

-- ── parent_students: many-to-many parent ↔ student link ──────────────────────
CREATE TABLE IF NOT EXISTS public.parent_students (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, student_id)
);

ALTER TABLE public.parent_students ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'parent_students' AND policyname = 'deny_all_parent_students'
  ) THEN
    CREATE POLICY "deny_all_parent_students" ON public.parent_students FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_parent_students_parent  ON public.parent_students(parent_id);
CREATE INDEX IF NOT EXISTS idx_parent_students_student ON public.parent_students(student_id);

NOTIFY pgrst, 'reload schema';

-- ── school_admin_access: multi-school admin access ────────────────────────────
-- Allows a single school_admin to manage multiple schools (e.g. sibling mediums).
CREATE TABLE IF NOT EXISTS public.school_admin_access (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_id, school_id)
);

ALTER TABLE public.school_admin_access ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'school_admin_access' AND policyname = 'deny_all_school_admin_access'
  ) THEN
    CREATE POLICY "deny_all_school_admin_access" ON public.school_admin_access FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_school_admin_access_admin  ON public.school_admin_access(admin_id);
CREATE INDEX IF NOT EXISTS idx_school_admin_access_school ON public.school_admin_access(school_id);

NOTIFY pgrst, 'reload schema';

-- ── announcements: school/class announcements ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.announcements (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id       uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  title           text NOT NULL,
  message         text NOT NULL,
  audience        text NOT NULL DEFAULT 'everyone'
                  CHECK (audience IN ('everyone', 'teachers', 'students')),
  target_classes  text[],     -- null = all classes; populated for teacher announcements
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'announcements' AND policyname = 'deny_all_announcements'
  ) THEN
    CREATE POLICY "deny_all_announcements" ON public.announcements FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_announcements_school ON public.announcements(school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_creator ON public.announcements(created_by);

NOTIFY pgrst, 'reload schema';

-- ── onboarding_progress: per-school onboarding checklist ─────────────────────
CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id           uuid NOT NULL UNIQUE REFERENCES public.schools(id) ON DELETE CASCADE,
  school_created      boolean NOT NULL DEFAULT true,
  admin_created       boolean NOT NULL DEFAULT false,
  teachers_added      boolean NOT NULL DEFAULT false,
  students_added      boolean NOT NULL DEFAULT false,
  classes_configured  boolean NOT NULL DEFAULT false,
  timetable_set       boolean NOT NULL DEFAULT false,
  first_attendance    boolean NOT NULL DEFAULT false,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'onboarding_progress' AND policyname = 'deny_all_onboarding_progress'
  ) THEN
    CREATE POLICY "deny_all_onboarding_progress" ON public.onboarding_progress FOR ALL USING (false);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ── test_restrictions: block specific students from a test ────────────────────
CREATE TABLE IF NOT EXISTS public.test_restrictions (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  test_id    uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, student_id)
);

ALTER TABLE public.test_restrictions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'test_restrictions' AND policyname = 'deny_all_test_restrictions'
  ) THEN
    CREATE POLICY "deny_all_test_restrictions" ON public.test_restrictions FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_test_restrictions_test ON public.test_restrictions(test_id);

NOTIFY pgrst, 'reload schema';

-- ── ai_usage: per-teacher AI generation quota tracking ───────────────────────
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  action      text NOT NULL,          -- 'generate_questions' | 'upload_extract' etc.
  prompt_hash text,                    -- SHA-256 of the prompt for cache lookup
  result      jsonb,                   -- cached result (null if not cached)
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_usage' AND policyname = 'deny_all_ai_usage'
  ) THEN
    CREATE POLICY "deny_all_ai_usage" ON public.ai_usage FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON public.ai_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_prompt_hash ON public.ai_usage(prompt_hash) WHERE prompt_hash IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ── daily_tests: AI-generated short daily tests ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_tests (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  class_name  text NOT NULL,
  section     text NOT NULL,
  subject     text NOT NULL,
  topic       text NOT NULL,
  questions   jsonb NOT NULL,    -- array of { question, options[4], correct_index, explanation }
  assigned_date date NOT NULL,   -- the date students should attempt this test
  time_limit_minutes integer NOT NULL DEFAULT 10,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_tests ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'daily_tests' AND policyname = 'deny_all_daily_tests'
  ) THEN
    CREATE POLICY "deny_all_daily_tests" ON public.daily_tests FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_daily_tests_school     ON public.daily_tests(school_id, assigned_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_tests_creator    ON public.daily_tests(created_by);
CREATE INDEX IF NOT EXISTS idx_daily_tests_class_date ON public.daily_tests(class_name, section, assigned_date);

NOTIFY pgrst, 'reload schema';

-- ── daily_test_attempts: student attempt on a daily test ─────────────────────
CREATE TABLE IF NOT EXISTS public.daily_test_attempts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  daily_test_id   uuid NOT NULL REFERENCES public.daily_tests(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  answers         jsonb NOT NULL,    -- array of selected option indices
  score           integer NOT NULL DEFAULT 0,
  total_questions integer NOT NULL DEFAULT 0,
  completed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (daily_test_id, student_id)
);

ALTER TABLE public.daily_test_attempts ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'daily_test_attempts' AND policyname = 'deny_all_daily_test_attempts'
  ) THEN
    CREATE POLICY "deny_all_daily_test_attempts" ON public.daily_test_attempts FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_daily_test_attempts_student ON public.daily_test_attempts(student_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_test_attempts_test    ON public.daily_test_attempts(daily_test_id);

NOTIFY pgrst, 'reload schema';

-- ── activity_packs: AI-generated home activity packs ─────────────────────────
CREATE TABLE IF NOT EXISTS public.activity_packs (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id    uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by   uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  class_name   text NOT NULL,
  section      text NOT NULL,
  subject      text NOT NULL,
  topic        text NOT NULL,
  activities   jsonb NOT NULL,    -- array of { title, description, type, duration_minutes }
  assigned_date date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.activity_packs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_packs' AND policyname = 'deny_all_activity_packs'
  ) THEN
    CREATE POLICY "deny_all_activity_packs" ON public.activity_packs FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_activity_packs_school     ON public.activity_packs(school_id, assigned_date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_packs_creator    ON public.activity_packs(created_by);
CREATE INDEX IF NOT EXISTS idx_activity_packs_class_date ON public.activity_packs(class_name, section, assigned_date);

NOTIFY pgrst, 'reload schema';

-- ── activity_completions: student marks an activity pack as done ──────────────
CREATE TABLE IF NOT EXISTS public.activity_completions (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  activity_pack_id uuid NOT NULL REFERENCES public.activity_packs(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  completed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_pack_id, student_id)
);

ALTER TABLE public.activity_completions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_completions' AND policyname = 'deny_all_activity_completions'
  ) THEN
    CREATE POLICY "deny_all_activity_completions" ON public.activity_completions FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_activity_completions_student ON public.activity_completions(student_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_completions_pack    ON public.activity_completions(activity_pack_id);

NOTIFY pgrst, 'reload schema';

-- ── weak_topics: computed weak areas per student per subject ──────────────────
CREATE TABLE IF NOT EXISTS public.weak_topics (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id      uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  subject         text NOT NULL,
  topic           text NOT NULL,
  weakness_score  numeric(5,2) NOT NULL DEFAULT 0,  -- 0–100, higher = weaker
  last_updated    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, subject, topic)
);

ALTER TABLE public.weak_topics ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'weak_topics' AND policyname = 'deny_all_weak_topics'
  ) THEN
    CREATE POLICY "deny_all_weak_topics" ON public.weak_topics FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_weak_topics_student ON public.weak_topics(student_id, weakness_score DESC);

NOTIFY pgrst, 'reload schema';

-- ── weekly_reports: AI-generated weekly performance report per student ────────
CREATE TABLE IF NOT EXISTS public.weekly_reports (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id      uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  week_start_date date NOT NULL,
  report_text     text NOT NULL,
  metrics         jsonb,    -- { attendance_pct, avg_score, streak, tests_completed, ... }
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, week_start_date)
);

ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'weekly_reports' AND policyname = 'deny_all_weekly_reports'
  ) THEN
    CREATE POLICY "deny_all_weekly_reports" ON public.weekly_reports FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_weekly_reports_student ON public.weekly_reports(student_id, week_start_date DESC);

NOTIFY pgrst, 'reload schema';

-- ── parent_subscriptions: premium subscription per student ────────────────────
CREATE TABLE IF NOT EXISTS public.parent_subscriptions (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id     uuid NOT NULL UNIQUE REFERENCES public.students(id) ON DELETE CASCADE,
  school_id      uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  plan_type      text NOT NULL CHECK (plan_type IN ('premium_junior', 'premium_senior')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'expired')),
  activated_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  renewed_at     timestamptz,
  activated_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.parent_subscriptions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'parent_subscriptions' AND policyname = 'deny_all_parent_subscriptions'
  ) THEN
    CREATE POLICY "deny_all_parent_subscriptions" ON public.parent_subscriptions FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_parent_subscriptions_school  ON public.parent_subscriptions(school_id, status);
CREATE INDEX IF NOT EXISTS idx_parent_subscriptions_student ON public.parent_subscriptions(student_id);

NOTIFY pgrst, 'reload schema';

-- ── parent_subscription_events: audit trail for subscription changes ──────────
CREATE TABLE IF NOT EXISTS public.parent_subscription_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id uuid NOT NULL REFERENCES public.parent_subscriptions(id) ON DELETE CASCADE,
  event_type    text NOT NULL,   -- 'activated' | 'deactivated' | 'renewed' | 'expired'
  performed_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.parent_subscription_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'parent_subscription_events' AND policyname = 'deny_all_parent_subscription_events'
  ) THEN
    CREATE POLICY "deny_all_parent_subscription_events" ON public.parent_subscription_events FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pse_subscription ON public.parent_subscription_events(subscription_id, created_at DESC);

NOTIFY pgrst, 'reload schema';

-- ── teacher_premium_access: per-teacher feature flags ────────────────────────
CREATE TABLE IF NOT EXISTS public.teacher_premium_access (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  daily_tests      boolean NOT NULL DEFAULT false,
  activity_packs   boolean NOT NULL DEFAULT false,
  ai_assistant     boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, school_id)
);

ALTER TABLE public.teacher_premium_access ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'teacher_premium_access' AND policyname = 'deny_all_teacher_premium_access'
  ) THEN
    CREATE POLICY "deny_all_teacher_premium_access" ON public.teacher_premium_access FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tpa_school   ON public.teacher_premium_access(school_id);
CREATE INDEX IF NOT EXISTS idx_tpa_teacher  ON public.teacher_premium_access(teacher_id);

NOTIFY pgrst, 'reload schema';

-- ── revenue_shares: monthly revenue ledger per school ────────────────────────
CREATE TABLE IF NOT EXISTS public.revenue_shares (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id      uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  month          text NOT NULL,          -- 'YYYY-MM'
  active_subs    integer NOT NULL DEFAULT 0,
  junior_count   integer NOT NULL DEFAULT 0,
  senior_count   integer NOT NULL DEFAULT 0,
  gross_revenue  numeric(12,2) NOT NULL DEFAULT 0,
  platform_fee   numeric(12,2) NOT NULL DEFAULT 0,
  school_payout  numeric(12,2) NOT NULL DEFAULT 0,
  payout_status  text NOT NULL DEFAULT 'pending'
                 CHECK (payout_status IN ('pending', 'paid', 'disputed')),
  calculated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, month)
);

ALTER TABLE public.revenue_shares ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'revenue_shares' AND policyname = 'deny_all_revenue_shares'
  ) THEN
    CREATE POLICY "deny_all_revenue_shares" ON public.revenue_shares FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_revenue_shares_school ON public.revenue_shares(school_id, month DESC);

NOTIFY pgrst, 'reload schema';

-- ── homework-uploads Supabase Storage bucket ──────────────────────────────────
-- Note: Storage buckets cannot be created via SQL. Run this in the Supabase
-- dashboard under Storage → New bucket:
--   Bucket name: homework-uploads
--   Public: true (so file_url links work directly without signed URLs)
-- Or via the management API / supabase CLI:
--   supabase storage buckets create homework-uploads --public
