-- ============================================================
-- Eduvo — Parent Premium System Migration
-- B2B2C model: Schools manually activate premium for students.
-- NO payment gateway integration.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Safe to re-run (all statements are idempotent).
-- ============================================================

-- ── 1. parent_subscriptions ───────────────────────────────────────────────────
-- School admin manually activates/deactivates premium per student.
-- plan_type is derived from class: junior = 1-6, senior = 7-12.
CREATE TABLE IF NOT EXISTS public.parent_subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id            uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  school_id             uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  plan_type             text NOT NULL CHECK (plan_type IN ('premium_junior', 'premium_senior')),
  status                text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive')),
  activated_by_admin_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  activated_at          timestamptz,
  deactivated_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- One active subscription per student at a time
  UNIQUE (student_id)
);

ALTER TABLE public.parent_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- school_admin / superadmin: full access scoped to their school
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'parent_subscriptions'
      AND policyname = 'admin_full_access_parent_subscriptions'
  ) THEN
    CREATE POLICY "admin_full_access_parent_subscriptions"
      ON public.parent_subscriptions
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = parent_subscriptions.school_id)
        )
      );
  END IF;

  -- student / parent: read their own row only
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'parent_subscriptions'
      AND policyname = 'student_read_own_parent_subscriptions'
  ) THEN
    CREATE POLICY "student_read_own_parent_subscriptions"
      ON public.parent_subscriptions
      FOR SELECT
      USING (
        -- Student reading their own subscription
        student_id IN (
          SELECT s.id FROM public.students s
          WHERE s.id = student_id
            AND EXISTS (
              SELECT 1 FROM public.users u
              WHERE u.id = auth.uid()
                AND u.role = 'student'
                AND u.school_id = s.school_id
            )
        )
        OR
        -- Parent reading their child's subscription
        student_id IN (
          SELECT s.id FROM public.students s
          WHERE s.parent_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ── 2. daily_tests ────────────────────────────────────────────────────────────
-- Teacher-created short daily assessments for premium students.
-- Uses "class" (not class_name) to match the pattern in tests/timetable tables.
CREATE TABLE IF NOT EXISTS public.daily_tests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  teacher_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  class       text NOT NULL,
  section     text NOT NULL,
  subject     text NOT NULL,
  topic       text NOT NULL,
  questions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  test_date   date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_tests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Teachers of that school: create (INSERT)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'daily_tests'
      AND policyname = 'teacher_insert_daily_tests'
  ) THEN
    CREATE POLICY "teacher_insert_daily_tests"
      ON public.daily_tests
      FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role = 'teacher'
            AND u.school_id = daily_tests.school_id
        )
      );
  END IF;

  -- Students of that class: read
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'daily_tests'
      AND policyname = 'student_read_daily_tests'
  ) THEN
    CREATE POLICY "student_read_daily_tests"
      ON public.daily_tests
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student'
            AND s.school_id = daily_tests.school_id
            AND (s.class = daily_tests.class OR s.class_name = daily_tests.class)
            AND s.section = daily_tests.section
        )
      );
  END IF;

  -- school_admin / superadmin: full access
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'daily_tests'
      AND policyname = 'admin_full_access_daily_tests'
  ) THEN
    CREATE POLICY "admin_full_access_daily_tests"
      ON public.daily_tests
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = daily_tests.school_id)
        )
      );
  END IF;
END $$;

-- ── 3. daily_test_attempts ────────────────────────────────────────────────────
-- One row per student per daily_test. Status tracks completion lifecycle.
CREATE TABLE IF NOT EXISTS public.daily_test_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_test_id    uuid NOT NULL REFERENCES public.daily_tests(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  answers          jsonb NOT NULL DEFAULT '{}'::jsonb,
  score            numeric(6,2),
  total_questions  integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'missed')),
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (daily_test_id, student_id)  -- one attempt per student per test
);

ALTER TABLE public.daily_test_attempts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Student: own rows only (all operations)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'daily_test_attempts'
      AND policyname = 'student_own_daily_test_attempts'
  ) THEN
    CREATE POLICY "student_own_daily_test_attempts"
      ON public.daily_test_attempts
      FOR ALL
      USING (
        student_id IN (
          SELECT s.id FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student' AND s.school_id = u.school_id
        )
      );
  END IF;

  -- school_admin / superadmin: read
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'daily_test_attempts'
      AND policyname = 'admin_read_daily_test_attempts'
  ) THEN
    CREATE POLICY "admin_read_daily_test_attempts"
      ON public.daily_test_attempts
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.daily_tests dt ON dt.id = daily_test_attempts.daily_test_id
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = dt.school_id)
        )
      );
  END IF;
END $$;

-- ── 4. activity_packs ─────────────────────────────────────────────────────────
-- Teacher-created bundles of learning activities (reading, exercises, etc.)
CREATE TABLE IF NOT EXISTS public.activity_packs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  teacher_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  class         text NOT NULL,
  section       text NOT NULL,
  subject       text NOT NULL,
  topic         text NOT NULL,
  activities    jsonb NOT NULL DEFAULT '[]'::jsonb,
  activity_date date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.activity_packs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Teachers of that school: insert
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_packs'
      AND policyname = 'teacher_insert_activity_packs'
  ) THEN
    CREATE POLICY "teacher_insert_activity_packs"
      ON public.activity_packs
      FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role = 'teacher'
            AND u.school_id = activity_packs.school_id
        )
      );
  END IF;

  -- Students of that class: read
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_packs'
      AND policyname = 'student_read_activity_packs'
  ) THEN
    CREATE POLICY "student_read_activity_packs"
      ON public.activity_packs
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student'
            AND s.school_id = activity_packs.school_id
            AND (s.class = activity_packs.class OR s.class_name = activity_packs.class)
            AND s.section = activity_packs.section
        )
      );
  END IF;

  -- school_admin / superadmin: full access
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_packs'
      AND policyname = 'admin_full_access_activity_packs'
  ) THEN
    CREATE POLICY "admin_full_access_activity_packs"
      ON public.activity_packs
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = activity_packs.school_id)
        )
      );
  END IF;
END $$;

-- ── 5. activity_completions ───────────────────────────────────────────────────
-- Parent marks activities as done; optionally logs reading minutes.
CREATE TABLE IF NOT EXISTS public.activity_completions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_pack_id      uuid NOT NULL REFERENCES public.activity_packs(id) ON DELETE CASCADE,
  student_id            uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  parent_marked_complete boolean NOT NULL DEFAULT false,
  reading_minutes       integer,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_pack_id, student_id)
);

ALTER TABLE public.activity_completions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Student / parent: own rows only
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_completions'
      AND policyname = 'student_own_activity_completions'
  ) THEN
    CREATE POLICY "student_own_activity_completions"
      ON public.activity_completions
      FOR ALL
      USING (
        student_id IN (
          SELECT s.id FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student' AND s.school_id = u.school_id
        )
        OR
        student_id IN (
          SELECT s.id FROM public.students s WHERE s.parent_id = auth.uid()
        )
      );
  END IF;

  -- school_admin / superadmin: read
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activity_completions'
      AND policyname = 'admin_read_activity_completions'
  ) THEN
    CREATE POLICY "admin_read_activity_completions"
      ON public.activity_completions
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.activity_packs ap ON ap.id = activity_completions.activity_pack_id
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = ap.school_id)
        )
      );
  END IF;
END $$;

-- ── 6. weak_topics ────────────────────────────────────────────────────────────
-- AI-calculated weakness scores per student per subject/topic.
-- Recalculated after each daily test attempt.
CREATE TABLE IF NOT EXISTS public.weak_topics (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  subject           text NOT NULL,
  topic             text NOT NULL,
  weakness_score    numeric(5,2) NOT NULL DEFAULT 0 CHECK (weakness_score >= 0 AND weakness_score <= 100),
  last_calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, subject, topic)
);

ALTER TABLE public.weak_topics ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Student: own rows only
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'weak_topics'
      AND policyname = 'student_own_weak_topics'
  ) THEN
    CREATE POLICY "student_own_weak_topics"
      ON public.weak_topics
      FOR ALL
      USING (
        student_id IN (
          SELECT s.id FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student' AND s.school_id = u.school_id
        )
        OR
        student_id IN (
          SELECT s.id FROM public.students s WHERE s.parent_id = auth.uid()
        )
      );
  END IF;

  -- Superadmin: read all
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'weak_topics'
      AND policyname = 'superadmin_read_weak_topics'
  ) THEN
    CREATE POLICY "superadmin_read_weak_topics"
      ON public.weak_topics
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid() AND u.role = 'superadmin'
        )
      );
  END IF;
END $$;

-- ── 7. doubt_queries (REMOVED) ───────────────────────────────────────────────
-- Table dropped via separate migration: drop_doubt_queries.sql
-- DROP TABLE IF EXISTS public.doubt_queries;

-- ── 8. revenue_shares ─────────────────────────────────────────────────────────
-- Monthly revenue share ledger: how much Eduvo owes each school.
-- amount_owed = total_active_premium_count * rate_per_student.
-- Populated by a scheduled job or manually by superadmin.
CREATE TABLE IF NOT EXISTS public.revenue_shares (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  month                       date NOT NULL,          -- First day of month (e.g. 2025-06-01)
  total_active_premium_count  integer NOT NULL DEFAULT 0,
  rate_per_student            numeric(8,2) NOT NULL DEFAULT 75,
  amount_owed                 numeric(10,2) NOT NULL DEFAULT 0,  -- count * rate
  payout_status               text NOT NULL DEFAULT 'pending'
                                CHECK (payout_status IN ('pending', 'invoiced', 'paid')),
  invoiced_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, month)   -- one ledger row per school per month
);

ALTER TABLE public.revenue_shares ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- school_admin: read only for their school
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'revenue_shares'
      AND policyname = 'school_admin_read_revenue_shares'
  ) THEN
    CREATE POLICY "school_admin_read_revenue_shares"
      ON public.revenue_shares
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role = 'school_admin'
            AND u.school_id = revenue_shares.school_id
        )
      );
  END IF;

  -- Superadmin: full access
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'revenue_shares'
      AND policyname = 'superadmin_full_access_revenue_shares'
  ) THEN
    CREATE POLICY "superadmin_full_access_revenue_shares"
      ON public.revenue_shares
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid() AND u.role = 'superadmin'
        )
      );
  END IF;
END $$;

-- ── 9. teacher_premium_access ─────────────────────────────────────────────────
-- Fine-grained per-teacher permission flags for premium features.
-- Granted by school_admin or superadmin.
CREATE TABLE IF NOT EXISTS public.teacher_premium_access (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id               uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  can_create_daily_tests  boolean NOT NULL DEFAULT false,
  can_create_activity_packs boolean NOT NULL DEFAULT false,
  granted_by              uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  granted_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, school_id)
);

ALTER TABLE public.teacher_premium_access ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- school_admin / superadmin: write (full access)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'teacher_premium_access'
      AND policyname = 'admin_full_access_teacher_premium_access'
  ) THEN
    CREATE POLICY "admin_full_access_teacher_premium_access"
      ON public.teacher_premium_access
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = teacher_premium_access.school_id)
        )
      );
  END IF;

  -- Teacher: read own row
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'teacher_premium_access'
      AND policyname = 'teacher_read_own_premium_access'
  ) THEN
    CREATE POLICY "teacher_read_own_premium_access"
      ON public.teacher_premium_access
      FOR SELECT
      USING (
        teacher_id = auth.uid()
      );
  END IF;
END $$;

-- ── 10. student_streaks ───────────────────────────────────────────────────────
-- One row per student, tracks gamification streak state.
-- UNIQUE on student_id enforced by the PK design (one row per student).
CREATE TABLE IF NOT EXISTS public.student_streaks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id            uuid NOT NULL UNIQUE REFERENCES public.students(id) ON DELETE CASCADE,
  current_streak        integer NOT NULL DEFAULT 0,
  longest_streak        integer NOT NULL DEFAULT 0,
  last_activity_date    date,
  streak_freeze_available boolean NOT NULL DEFAULT true,
  total_active_days     integer NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.student_streaks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Student: own row only
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'student_streaks'
      AND policyname = 'student_own_streaks'
  ) THEN
    CREATE POLICY "student_own_streaks"
      ON public.student_streaks
      FOR ALL
      USING (
        student_id IN (
          SELECT s.id FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student' AND s.school_id = u.school_id
        )
        OR
        student_id IN (
          SELECT s.id FROM public.students s WHERE s.parent_id = auth.uid()
        )
      );
  END IF;

  -- school_admin / superadmin: read
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'student_streaks'
      AND policyname = 'admin_read_student_streaks'
  ) THEN
    CREATE POLICY "admin_read_student_streaks"
      ON public.student_streaks
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.students s ON s.id = student_streaks.student_id
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = s.school_id)
        )
      );
  END IF;
END $$;

-- ── 11. streak_log ────────────────────────────────────────────────────────────
-- Immutable daily activity log. One row per student per day.
-- Used to rebuild streaks if needed and for analytics.
CREATE TABLE IF NOT EXISTS public.streak_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  activity_date  date NOT NULL,
  activity_type  text NOT NULL CHECK (activity_type IN ('daily_test', 'activity_pack', 'both')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, activity_date)  -- exactly one log entry per student per day
);

ALTER TABLE public.streak_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Student: own rows only
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'streak_log'
      AND policyname = 'student_own_streak_log'
  ) THEN
    CREATE POLICY "student_own_streak_log"
      ON public.streak_log
      FOR ALL
      USING (
        student_id IN (
          SELECT s.id FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student' AND s.school_id = u.school_id
        )
        OR
        student_id IN (
          SELECT s.id FROM public.students s WHERE s.parent_id = auth.uid()
        )
      );
  END IF;

  -- school_admin / superadmin: read
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'streak_log'
      AND policyname = 'admin_read_streak_log'
  ) THEN
    CREATE POLICY "admin_read_streak_log"
      ON public.streak_log
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.students s ON s.id = streak_log.student_id
          WHERE u.id = auth.uid()
            AND u.role IN ('school_admin', 'superadmin')
            AND (u.role = 'superadmin' OR u.school_id = s.school_id)
        )
      );
  END IF;
END $$;

-- ── 12. fcm_tokens — already exists, extend only if needed ───────────────────
-- The fcm_tokens table was created in supabase-migrations-fcm-tokens.sql.
-- It already has: id, user_id, student_id, token (unique), platform, created_at, updated_at.
-- The spec asks for user_id (nullable) + token (unique) + platform — already covered.
-- We just add RLS policies if they are missing.

DO $$
BEGIN
  -- User: own rows only (insert + read + delete)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fcm_tokens'
      AND policyname = 'user_own_fcm_tokens'
  ) THEN
    -- Enable RLS (safe if already enabled)
    ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;

    CREATE POLICY "user_own_fcm_tokens"
      ON public.fcm_tokens
      FOR ALL
      USING (
        user_id = auth.uid()
        OR
        student_id IN (
          SELECT s.id FROM public.students s
          JOIN public.users u ON u.id = auth.uid()
          WHERE u.role = 'student' AND s.school_id = u.school_id
        )
      );
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- parent_subscriptions
CREATE INDEX IF NOT EXISTS idx_parent_subs_school_status
  ON public.parent_subscriptions(school_id, status);

CREATE INDEX IF NOT EXISTS idx_parent_subs_student
  ON public.parent_subscriptions(student_id);

-- daily_tests
CREATE INDEX IF NOT EXISTS idx_daily_tests_school_class_date
  ON public.daily_tests(school_id, class, section, test_date);

-- daily_test_attempts
CREATE INDEX IF NOT EXISTS idx_daily_test_attempts_student_status
  ON public.daily_test_attempts(student_id, status);

-- activity_packs
CREATE INDEX IF NOT EXISTS idx_activity_packs_school_class_date
  ON public.activity_packs(school_id, class, section, activity_date);

-- weak_topics
CREATE INDEX IF NOT EXISTS idx_weak_topics_student_subject
  ON public.weak_topics(student_id, subject);

-- revenue_shares
CREATE INDEX IF NOT EXISTS idx_revenue_shares_school_month
  ON public.revenue_shares(school_id, month);

-- student_streaks
CREATE INDEX IF NOT EXISTS idx_student_streaks_student
  ON public.student_streaks(student_id);

-- streak_log
CREATE INDEX IF NOT EXISTS idx_streak_log_student_date
  ON public.streak_log(student_id, activity_date);

-- fcm_tokens (user_id index already exists from previous migration;
-- this is a safety net in case someone runs this on a fresh DB)
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_id
  ON public.fcm_tokens(user_id) WHERE user_id IS NOT NULL;

-- ── Trigger: auto-update updated_at on parent_subscriptions ──────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_parent_subscriptions_updated_at'
  ) THEN
    CREATE TRIGGER trg_parent_subscriptions_updated_at
      BEFORE UPDATE ON public.parent_subscriptions
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_student_streaks_updated_at'
  ) THEN
    CREATE TRIGGER trg_student_streaks_updated_at
      BEFORE UPDATE ON public.student_streaks
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
