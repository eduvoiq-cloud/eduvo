-- Migration: add parent_phone column to students table
-- parent_phone stores the parent's WhatsApp/contact number separately from
-- the login phone (phone_number). WhatsApp notifications always go to parent_phone.
-- Run this in Supabase SQL editor.

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS parent_phone text;

-- Backfill: for existing students, set parent_phone = phone_number
-- (they were the same before this migration)
UPDATE public.students
  SET parent_phone = phone_number
  WHERE parent_phone IS NULL AND phone_number IS NOT NULL;

-- Index for lookups
CREATE INDEX IF NOT EXISTS idx_students_parent_phone
  ON public.students (parent_phone)
  WHERE parent_phone IS NOT NULL;

COMMENT ON COLUMN public.students.parent_phone IS
  'Parent WhatsApp/contact phone number. WhatsApp notifications always go here. '
  'Separate from phone_number which is the student login credential.';
