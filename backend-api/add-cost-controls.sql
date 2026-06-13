-- ============================================================
-- Eduvo — AI Cost Controls Migration
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================
-- 1. Add queued_overflow boolean to homework_submissions
-- 2. Create ai_cost_log table for monthly cost tracking
-- ============================================================

-- 1. Add queued_overflow to homework_submissions
--    When a student exceeds 5 AI-checked submissions in a day,
--    the submission is stored with status='submitted' and this
--    flag set to true, so the nightly batch skips it and re-queues
--    it for the following day.
ALTER TABLE public.homework_submissions
  ADD COLUMN IF NOT EXISTS queued_overflow boolean NOT NULL DEFAULT false;

-- Index for the batch job to quickly find non-overflow submissions
CREATE INDEX IF NOT EXISTS idx_hw_submissions_overflow
  ON public.homework_submissions(status, queued_overflow)
  WHERE status = 'submitted' AND queued_overflow = false;

-- ============================================================
-- 2. ai_cost_log — daily per-school AI usage tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ai_cost_log (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id            uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  date                 date NOT NULL,
  gemini_calls_text    integer NOT NULL DEFAULT 0,
  gemini_calls_vision  integer NOT NULL DEFAULT 0,
  cache_hits           integer NOT NULL DEFAULT 0,
  estimated_cost_inr   numeric(10, 4) NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, date)
);

-- Service-role-only access (backend increments counters directly)
ALTER TABLE public.ai_cost_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'ai_cost_log'
      AND policyname = 'ai_cost_log_superadmin_read'
  ) THEN
    CREATE POLICY "ai_cost_log_superadmin_read"
      ON public.ai_cost_log FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid() AND u.role = 'superadmin'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_cost_log_school_date
  ON public.ai_cost_log(school_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_ai_cost_log_date
  ON public.ai_cost_log(date DESC);

NOTIFY pgrst, 'reload schema';
