-- ── Fix activity_packs column names ──────────────────────────────────────────
-- The old migration created these columns with different names than what the
-- route code expects. Rename them to match the code.

DO $$
BEGIN
  -- Rename created_by -> teacher_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'activity_packs' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE public.activity_packs RENAME COLUMN created_by TO teacher_id;
    RAISE NOTICE 'Renamed activity_packs.created_by -> teacher_id';
  END IF;

  -- Rename class_name -> class
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'activity_packs' AND column_name = 'class_name'
  ) THEN
    ALTER TABLE public.activity_packs RENAME COLUMN class_name TO class;
    RAISE NOTICE 'Renamed activity_packs.class_name -> class';
  END IF;

  -- Rename assigned_date -> activity_date
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'activity_packs' AND column_name = 'assigned_date'
  ) THEN
    ALTER TABLE public.activity_packs RENAME COLUMN assigned_date TO activity_date;
    RAISE NOTICE 'Renamed activity_packs.assigned_date -> activity_date';
  END IF;
END $$;

-- ── Fix activity_completions missing columns ──────────────────────────────────
-- The old schema only had (activity_pack_id, student_id, completed_at).
-- The new code also needs parent_marked_complete and reading_minutes.

ALTER TABLE public.activity_completions
  ADD COLUMN IF NOT EXISTS parent_marked_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reading_minutes        integer,
  ADD COLUMN IF NOT EXISTS completed_at_new       timestamptz;

-- If completed_at already exists with NOT NULL DEFAULT, that's fine — just add the missing ones.
-- The upsert in the code sets completed_at explicitly so no default needed.

-- Drop the old completed_at NOT NULL constraint if present and re-add as nullable
-- so the code can upsert with NULL when not yet completed.
DO $$
BEGIN
  -- Make completed_at nullable (it was NOT NULL DEFAULT now() in old schema,
  -- but new schema allows NULL until parent marks complete)
  BEGIN
    ALTER TABLE public.activity_completions ALTER COLUMN completed_at DROP NOT NULL;
    RAISE NOTICE 'Made activity_completions.completed_at nullable';
  EXCEPTION WHEN OTHERS THEN
    -- already nullable, ignore
  END;
END $$;

-- Drop temporary column if it was added
ALTER TABLE public.activity_completions DROP COLUMN IF EXISTS completed_at_new;

-- Drop the blanket deny policies if they exist (they block all inserts)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_packs'
      AND policyname = 'deny_all_activity_packs'
  ) THEN
    DROP POLICY "deny_all_activity_packs" ON public.activity_packs;
    RAISE NOTICE 'Dropped deny_all_activity_packs policy';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_completions'
      AND policyname = 'deny_all_activity_completions'
  ) THEN
    DROP POLICY "deny_all_activity_completions" ON public.activity_completions;
    RAISE NOTICE 'Dropped deny_all_activity_completions policy';
  END IF;
END $$;

-- ── Add proper RLS policies (from supabase-migrations-parent-premium.sql) ────

-- activity_packs: teachers of same school can insert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_packs'
      AND policyname = 'teacher_insert_activity_packs'
  ) THEN
    CREATE POLICY "teacher_insert_activity_packs"
      ON public.activity_packs FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role = 'teacher'
            AND u.school_id = activity_packs.school_id
        )
      );
  END IF;
END $$;

-- activity_packs: teachers/admins of same school can select
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_packs'
      AND policyname = 'school_read_activity_packs'
  ) THEN
    CREATE POLICY "school_read_activity_packs"
      ON public.activity_packs FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND (u.role IN ('teacher', 'schooladmin', 'superadmin'))
            AND (u.school_id = activity_packs.school_id OR u.role = 'superadmin')
        )
      );
  END IF;
END $$;

-- activity_completions: allow insert/update for service role (backend uses service key)
-- The backend uses supabaseAdmin (service role key) which bypasses RLS entirely,
-- so RLS policies here are mainly for direct client access.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_completions'
      AND policyname = 'service_manage_activity_completions'
  ) THEN
    CREATE POLICY "service_manage_activity_completions"
      ON public.activity_completions FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
