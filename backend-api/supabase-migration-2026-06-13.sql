-- ============================================================
-- Eduvo — Schema Migration 2026-06-13
-- Changes:
--   1. NEW TABLE  : parent_subscription_events (audit log)
--   2. SKIP       : weekly_reports — already exists (see note below)
--   3. ALTER TABLE: parent_subscriptions — add subscription date columns
--   4. ALTER TABLE: student_streaks — drop streak_freeze_available
--
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Safe to re-run (all statements are idempotent).
-- ============================================================

-- ──────────────────────────────────────────────────────────────────────────────
-- NOTE: weekly_reports ALREADY EXISTS
-- The table was created in supabase-migrations-weekly-reports.sql with:
--   id              uuid PK
--   student_id      uuid FK -> students
--   week_start_date date NOT NULL
--   report_text     text NOT NULL
--   generated_at    timestamptz (extra column, not in your spec — safe to keep)
--   created_at      timestamptz
--   UNIQUE (student_id, week_start_date)
-- RLS policies already cover: student/parent SELECT own, school_admin/superadmin SELECT all.
-- school_id column is NOT present (the table joins through students to get school_id).
-- If you need a direct school_id column, run the optional ALTER at the bottom of this file.
-- ──────────────────────────────────────────────────────────────────────────────


-- ══════════════════════════════════════════════════════════════════════════════
-- 1. NEW TABLE: parent_subscription_events
-- Immutable audit log. Only the backend service role inserts rows.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.parent_subscription_events (
  id                uuid    PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id   uuid    NOT NULL REFERENCES public.parent_subscriptions(id) ON DELETE CASCADE,
  student_id        uuid    NOT NULL REFERENCES public.students(id),
  school_id         uuid    NOT NULL REFERENCES public.schools(id),
  action            text    NOT NULL CHECK (action IN ('activated', 'renewed', 'deactivated', 'expired')),
  old_expires_at    date,
  new_expires_at    date,
  done_by_admin_id  uuid    REFERENCES public.users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- RLS: school_admin of that school and superadmin can SELECT.
-- No INSERT/UPDATE/DELETE policy for end-users — service role only.
ALTER TABLE public.parent_subscription_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'parent_subscription_events'
      AND policyname = 'admin_select_parent_subscription_events'
  ) THEN
    CREATE POLICY "admin_select_parent_subscription_events"
      ON public.parent_subscription_events
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = parent_subscription_events.school_id)
        )
      );
  END IF;
END $$;

-- Index for fast per-student audit history queries
CREATE INDEX IF NOT EXISTS idx_parent_sub_events_student_created
  ON public.parent_subscription_events(student_id, created_at DESC);


-- ══════════════════════════════════════════════════════════════════════════════
-- 2. ALTER TABLE: parent_subscriptions — add subscription date & admin columns
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.parent_subscriptions
  ADD COLUMN IF NOT EXISTS starts_at           date,
  ADD COLUMN IF NOT EXISTS expires_at          date,
  ADD COLUMN IF NOT EXISTS last_renewed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS renewed_by_admin_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes               text;


-- ══════════════════════════════════════════════════════════════════════════════
-- 3. ALTER TABLE: student_streaks — drop streak_freeze_available
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.student_streaks
  DROP COLUMN IF EXISTS streak_freeze_available;

-- Confirm retained columns (no-op ALTERs just document intent; safe to leave):
-- current_streak, longest_streak, last_activity_date, total_active_days
-- (These columns are untouched above — listed here for documentation only.)


-- ══════════════════════════════════════════════════════════════════════════════
-- OPTIONAL: Add school_id to weekly_reports if you want a direct FK column.
-- The existing table resolves school via students.school_id JOIN.
-- Uncomment only if your queries need a direct column on weekly_reports.
-- ══════════════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.weekly_reports
--   ADD COLUMN IF NOT EXISTS school_id uuid REFERENCES public.schools(id) ON DELETE CASCADE;
--
-- CREATE INDEX IF NOT EXISTS idx_weekly_reports_school_id
--   ON public.weekly_reports(school_id);


NOTIFY pgrst, 'reload schema';
