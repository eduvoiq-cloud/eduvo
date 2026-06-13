-- ============================================================
-- Migration: add reference_file_url to homework table
-- Run in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================

ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS reference_file_url text;

COMMENT ON COLUMN public.homework.reference_file_url IS
  'Optional teacher-uploaded reference solution/method (PDF or image). '
  'Gemini uses this image alongside reference_answer text when evaluating student submissions.';
