-- ============================================================
-- Eduvo — Homework Submission Indexes
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================
-- Student submission photos are stored in the existing
-- 'homework-uploads' bucket under the path:
--   student-submissions/<school_id>/<student_id>/<timestamp>_<filename>
--
-- This migration only adds indexes on homework_submissions for
-- fast duplicate-image detection and old-photo checks.
-- ============================================================

-- Fast duplicate detection: find if another student submitted the same image hash
CREATE INDEX IF NOT EXISTS idx_hw_submissions_image_hash
  ON public.homework_submissions(homework_id, image_hash)
  WHERE image_hash IS NOT NULL;

-- Fast old-photo detection: query submissions with EXIF timestamps
CREATE INDEX IF NOT EXISTS idx_hw_submissions_exif_ts
  ON public.homework_submissions(exif_timestamp)
  WHERE exif_timestamp IS NOT NULL;

NOTIFY pgrst, 'reload schema';
