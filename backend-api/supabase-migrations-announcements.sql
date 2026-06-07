-- ============================================================
-- Eduvo — Announcements table migration
-- Run this in Supabase SQL editor before deploying the
-- teacher announcements feature.
-- ============================================================

-- Add target_classes (JSON array of {class, section} objects)
-- to support teacher sending to multiple classes at once.
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS target_classes jsonb;

-- Add sender_role so we can distinguish teacher vs admin announcements.
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS sender_role text;

-- Backfill: convert legacy single target_class -> target_classes array
UPDATE public.announcements
SET target_classes = jsonb_build_array(
  jsonb_build_object('class', target_class, 'section', '')
)
WHERE target_classes IS NULL
  AND target_class IS NOT NULL
  AND target_class <> '';

-- Index for fast lookup by creator (GET /api/announcements/my)
CREATE INDEX IF NOT EXISTS idx_announcements_created_by
  ON public.announcements(created_by, created_at DESC);
