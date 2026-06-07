-- ============================================================
-- Complaints Fix Migration
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================

-- Fix 1: Expand recipient_type check constraint to include 'subject_teacher'.
-- The original constraint only allowed 'class_teacher' and 'school_admin',
-- which caused every subject_teacher complaint to fail with a DB constraint violation.
ALTER TABLE public.complaints DROP CONSTRAINT IF EXISTS complaints_recipient_type_check;
ALTER TABLE public.complaints
  ADD CONSTRAINT complaints_recipient_type_check
  CHECK (recipient_type IN ('subject_teacher', 'school_admin'));

-- Fix 2: Make the subject column nullable.
-- The schema defined it NOT NULL but the API sends it as null when the student
-- leaves the optional subject field blank.
ALTER TABLE public.complaints ALTER COLUMN subject DROP NOT NULL;

-- Fix 3: Make the body column nullable.
-- The original schema had body NOT NULL (used by the old parent complaint system).
-- Student complaints use the 'message' column instead, so 'body' will be null
-- for all student-submitted complaints. Without this fix the insert fails with
-- a NOT NULL constraint violation on 'body'.
ALTER TABLE public.complaints ALTER COLUMN body DROP NOT NULL;

-- Fix 4: Make submitted_by nullable.
-- The original schema had submitted_by NOT NULL references users(id).
-- Student complaints are submitted by students, who do NOT have a row in the
-- users table. Without this fix the insert fails with a NOT NULL constraint
-- violation on 'submitted_by'.
ALTER TABLE public.complaints ALTER COLUMN submitted_by DROP NOT NULL;

-- Fix 5: Ensure message column exists (added by the main migrations file, but
-- included here as a safety net in case it was missed).
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS message text;

-- Fix 6: Ensure teacher_id FK is in place (added by the main migrations file,
-- but included here as a safety net).
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS teacher_id uuid
  REFERENCES public.users(id) ON DELETE SET NULL;

-- Fix 7: Ensure recipient_type column exists.
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS recipient_type text;

NOTIFY pgrst, 'reload schema';
