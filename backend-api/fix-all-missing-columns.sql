-- ============================================================
-- Eduvo — Fix All Missing Columns
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
--
-- This migration adds all missing columns that cause runtime errors.
-- All statements use IF NOT EXISTS / safe patterns — safe to run multiple times.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. homework_submissions — missing updated_at
--    Fixes: "column homework_submissions.updated_at does not exist"
--    Caused by: homeworkEvalService.ts marking submissions as 'processing'
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.homework_submissions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill updated_at from submitted_at for existing rows
UPDATE public.homework_submissions
SET updated_at = submitted_at
WHERE updated_at IS NULL AND submitted_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. announcements — missing sender_role and target_audience
--    Fixes: all announcement create/read endpoints returning 500
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS sender_role TEXT,
  ADD COLUMN IF NOT EXISTS target_audience TEXT;

-- Backfill existing rows: assume they're teacher announcements
UPDATE public.announcements
SET sender_role = 'teacher'
WHERE sender_role IS NULL AND target_classes IS NOT NULL;

UPDATE public.announcements
SET sender_role = 'schooladmin', target_audience = 'everyone'
WHERE sender_role IS NULL AND target_classes IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. student_fees — missing updated_by
--    Fixes: "column student_fees.updated_by does not exist"
--    Caused by: fees.ts and teacher.ts payment update routes
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.student_fees
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. parent_subscriptions — multiple missing columns
--    Fixes: premium activate/deactivate/renew routes crashing
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.parent_subscriptions
  ADD COLUMN IF NOT EXISTS starts_at DATE,
  ADD COLUMN IF NOT EXISTS activated_by_admin_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_renewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewed_by_admin_id UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. parent_subscription_events — missing columns (code uses wrong names)
--    Fixes: subscription event logging always failing
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.parent_subscription_events
  ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS action TEXT,
  ADD COLUMN IF NOT EXISTS old_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS new_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS done_by_admin_id UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. teacher_premium_access — missing can_create_activity_packs / daily_tests
--    Fixes: GET /api/activity-packs/permission always failing or wrong result
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.teacher_premium_access
  ADD COLUMN IF NOT EXISTS can_create_activity_packs BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS can_create_daily_tests BOOLEAN NOT NULL DEFAULT TRUE;

-- Note: DEFAULT TRUE on ADD COLUMN already backfills all existing rows correctly.
-- No manual UPDATE needed — the old 'activity_packs' column does not exist.

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. notifications — ensure both body and message columns exist
--    The code uses 'message' for writes in some places, 'body' in others.
--    Keep both columns so neither path errors.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS body TEXT,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

-- Backfill: if body is null but message exists, copy message → body
UPDATE public.notifications
SET body = message
WHERE body IS NULL AND message IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tell PostgREST to reload its schema cache so new columns are visible
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
