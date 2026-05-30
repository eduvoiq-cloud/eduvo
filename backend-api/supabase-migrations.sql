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

-- Reload PostgREST schema cache so new columns are recognised immediately
NOTIFY pgrst, 'reload schema';
