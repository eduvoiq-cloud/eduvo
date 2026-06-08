-- ============================================================
-- Eduvo — Admin Announcements migration
-- Adds target_audience column to announcements table so school
-- admins can send school-wide announcements visible to all
-- students, teachers, and parents without needing target_classes.
-- Run this in the Supabase SQL editor before deploying.
-- ============================================================

-- Add target_audience column: 'everyone' | 'teachers' | 'parents' | 'students'
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS target_audience text DEFAULT 'everyone';

-- Backfill: existing teacher announcements should not match admin audience filter
-- (they use target_classes for filtering, so target_audience can stay NULL for them)
UPDATE public.announcements
SET target_audience = NULL
WHERE sender_role = 'teacher' OR sender_role IS NULL;

-- Index for fast lookup of admin announcements by school
CREATE INDEX IF NOT EXISTS idx_announcements_school_sender_role
  ON public.announcements(school_id, sender_role, created_at DESC);
