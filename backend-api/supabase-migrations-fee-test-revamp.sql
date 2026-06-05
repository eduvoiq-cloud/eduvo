-- ============================================================
-- Fee & Test Access Revamp Migration
-- Run this in: https://supabase.com/dashboard/project/.../sql/new
-- ============================================================

-- ── test_restrictions: stores students blocked from a specific test ───────────
-- teacher selects which students cannot attempt a specific test
CREATE TABLE IF NOT EXISTS public.test_restrictions (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  test_id     uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, student_id)
);

ALTER TABLE public.test_restrictions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'test_restrictions'
      AND policyname = 'deny_all_test_restrictions'
  ) THEN
    CREATE POLICY "deny_all_test_restrictions"
      ON public.test_restrictions FOR ALL USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_test_restrictions_test_id    ON public.test_restrictions(test_id);
CREATE INDEX IF NOT EXISTS idx_test_restrictions_student_id ON public.test_restrictions(student_id);

-- ── notifications: allow 'fee_reminder' type ──────────────────────────────────
-- fee reminders are student-specific notifications stored in the notifications table
-- Extend the type check constraint to include 'fee_reminder'
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('announcement', 'alert', 'reminder', 'grade', 'attendance', 'fee_reminder'));

NOTIFY pgrst, 'reload schema';
