-- ============================================================
-- recovery_subject_chapters Migration
-- Allows teachers to select specific chapters for subjects that
-- have no student test data in the app. These chapters are used
-- by the AI to generate targeted recovery packs instead of
-- generic subject overviews.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.recovery_subject_chapters (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  class            text        NOT NULL,
  section          text        NOT NULL,
  subject          text        NOT NULL,
  scheduled_month  date        NOT NULL,
  chapter_names    text[]      NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_recovery_subject_chapters
    UNIQUE (school_id, class, section, subject, scheduled_month)
);

CREATE INDEX IF NOT EXISTS idx_recovery_subject_chapters_lookup
  ON public.recovery_subject_chapters(school_id, class, section, scheduled_month);

ALTER TABLE public.recovery_subject_chapters ENABLE ROW LEVEL SECURITY;

-- Backend uses service role, which bypasses RLS.
-- Teachers can read/write their own school's rows via the API (authenticated via JWT).
-- Direct RLS is deny-all since all access is via backend service role.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename   = 'recovery_subject_chapters'
      AND policyname  = 'rsc_deny_all'
  ) THEN
    CREATE POLICY "rsc_deny_all"
      ON public.recovery_subject_chapters
      FOR ALL USING (false);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
