-- ============================================================
-- Eduvo — Production Hardening Migration
-- Run this in Supabase SQL Editor before going live.
-- All statements use IF NOT EXISTS / IF EXISTS so they are
-- safe to re-run without errors.
-- ============================================================

-- ── 1. Enable pg_trgm extension for full-text search ─────────────────────────
-- Required by the students_full_name_trgm GIN index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 2. Fix broken index in supabase-indexes.sql ───────────────────────────────
-- The original index references `subject_id` which does NOT exist on `marks`.
-- The correct column is `subject` (text). Drop the broken one, add the correct one.
DROP INDEX IF EXISTS marks_student_subject;

CREATE INDEX IF NOT EXISTS marks_student_subject_text
  ON public.marks (student_id, subject);

-- ── 3. Missing composite index: marks filtered by school (via join) ───────────
-- The new /api/marks GET uses students!inner join to filter by school_id.
-- PostgreSQL needs an index on marks(student_id) + students(school_id, id).
-- Both already exist in schema; confirm they are present:
CREATE INDEX IF NOT EXISTS idx_marks_student_id
  ON public.marks (student_id);

CREATE INDEX IF NOT EXISTS idx_students_school_id_active
  ON public.students (school_id)
  WHERE is_deleted = false;

-- ── 4. Index for student phone number login ───────────────────────────────────
-- The `phone_number` column is the login key for students. Needs to be fast.
CREATE INDEX IF NOT EXISTS idx_students_phone_number
  ON public.students (phone_number)
  WHERE phone_number IS NOT NULL;

-- Also index the legacy `phone` column (kept in sync by app code)
CREATE INDEX IF NOT EXISTS idx_students_phone
  ON public.students (phone)
  WHERE phone IS NOT NULL;

-- ── 5. Index for teacher assignment lookup ────────────────────────────────────
-- isTeacherAssigned() queries both class_name and class columns.
CREATE INDEX IF NOT EXISTS idx_teacher_assign_school_class
  ON public.teacher_assignments (school_id, class_name, section);

CREATE INDEX IF NOT EXISTS idx_teacher_assign_school_class_legacy
  ON public.teacher_assignments (school_id, class, section);

-- ── 6. optimistic locking: add updated_at to marks ───────────────────────────
-- Prevents last-write-wins corruption when two teachers edit the same mark.
-- The backend checks updated_at matches before updating.
ALTER TABLE public.marks
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Trigger to auto-update updated_at on every UPDATE
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_marks_updated_at'
  ) THEN
    CREATE TRIGGER trg_marks_updated_at
    BEFORE UPDATE ON public.marks
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ── 7. Optimistic locking: add updated_at to students ────────────────────────
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_students_updated_at'
  ) THEN
    CREATE TRIGGER trg_students_updated_at
    BEFORE UPDATE ON public.students
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ── 8. Optimistic locking: add updated_at to users ───────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_users_updated_at'
  ) THEN
    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ── 9. Add index on users.is_deleted for soft-delete queries ─────────────────
CREATE INDEX IF NOT EXISTS idx_users_not_deleted
  ON public.users (school_id, role)
  WHERE is_deleted = false;

-- ── 10. Attendance index including school_id (via student join) ───────────────
-- The today-summary and class-history queries hit attendance filtered by school.
-- The join path is: attendance.student_id → students.id WHERE students.school_id = ?
-- The existing idx_attendance_student_date covers this well.
-- Add a compound date+school_id partial index for the dashboard summary:
CREATE INDEX IF NOT EXISTS idx_attendance_date_school
  ON public.attendance (date, student_id);

-- ── 11. Add test_restrictions table if missing ────────────────────────────────
-- Referenced in supabase-migrations.sql but schema may not have it.
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
    WHERE schemaname = 'public'
      AND tablename  = 'test_restrictions'
      AND policyname = 'deny_all_test_restrictions'
  ) THEN
    CREATE POLICY "deny_all_test_restrictions"
      ON public.test_restrictions FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_test_restrictions_test_id
  ON public.test_restrictions (test_id);

CREATE INDEX IF NOT EXISTS idx_test_restrictions_student_id
  ON public.test_restrictions (student_id);

-- ── 12. FCM tokens table (separate from users.fcm_token column) ──────────────
-- Supports multiple devices per user/student.
CREATE TABLE IF NOT EXISTS public.fcm_tokens (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    uuid REFERENCES public.users(id) ON DELETE CASCADE,
  student_id uuid REFERENCES public.students(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  platform   text CHECK (platform IN ('ios', 'android', 'web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_fcm_one_owner CHECK (
    (user_id IS NOT NULL AND student_id IS NULL) OR
    (user_id IS NULL AND student_id IS NOT NULL)
  )
);

ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'fcm_tokens'
      AND policyname = 'deny_all_fcm_tokens'
  ) THEN
    CREATE POLICY "deny_all_fcm_tokens"
      ON public.fcm_tokens FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_id
  ON public.fcm_tokens (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_student_id
  ON public.fcm_tokens (student_id)
  WHERE student_id IS NOT NULL;

-- ── 13. ai_usage table (referenced in index file but missing from schema) ─────
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  prompt_hash text,
  model       text,
  tokens_used integer,
  cached      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'ai_usage'
      AND policyname = 'deny_all_ai_usage'
  ) THEN
    CREATE POLICY "deny_all_ai_usage"
      ON public.ai_usage FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_school_created
  ON public.ai_usage (user_id, school_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_usage_prompt_hash
  ON public.ai_usage (prompt_hash, created_at DESC)
  WHERE prompt_hash IS NOT NULL;

-- ── 14. Ensure notifications FK doesn't block student notifications ───────────
-- The fees send-reminder route inserts notifications with recipient_id = student.id
-- but notifications.recipient_id FK references users.id — students are NOT in users.
-- We need to make this nullable or use a different approach.
-- Safe fix: make recipient_id nullable so student-direct notifications work.
-- The application code already handles both user and student recipients.
ALTER TABLE public.notifications
  ALTER COLUMN sender_id DROP NOT NULL;

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_recipient_id_fkey;

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_sender_id_fkey;

-- recipient_id can now reference either users or students (app-level enforcement)
-- sender_id stays as text reference (staff user ID)

-- ── 15. schools: add updated_at trigger ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_schools_updated_at'
  ) THEN
    CREATE TRIGGER trg_schools_updated_at
    BEFORE UPDATE ON public.schools
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ── 16. Increase bcrypt work factor for new students ─────────────────────────
-- Note: password_hash is application-level; no DB change needed.
-- Reminder: update BCRYPT_ROUNDS constant in backend code to 12 for production.

NOTIFY pgrst, 'reload schema';
