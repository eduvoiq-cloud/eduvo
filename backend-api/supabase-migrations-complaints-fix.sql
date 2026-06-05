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
-- The legacy 'body' column (used by the old parent complaint flow) is NOT NULL
-- in the schema, but the new student complaint flow does not populate it.
ALTER TABLE public.complaints ALTER COLUMN body DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
