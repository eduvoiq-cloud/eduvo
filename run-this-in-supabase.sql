-- ============================================================
-- STEP 1: Drop broken partial tables (no data in them yet)
-- ============================================================
DROP TABLE IF EXISTS public.activity_completions CASCADE;
DROP TABLE IF EXISTS public.daily_test_attempts CASCADE;
DROP TABLE IF EXISTS public.activity_packs CASCADE;
DROP TABLE IF EXISTS public.daily_tests CASCADE;

-- ============================================================
-- STEP 2: Recreate all missing tables cleanly
-- ============================================================

-- ── daily_tests ───────────────────────────────────────────────────────────────
CREATE TABLE public.daily_tests (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id          uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by         uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  class_name         text NOT NULL,
  section            text NOT NULL,
  subject            text NOT NULL,
  topic              text NOT NULL,
  questions          jsonb NOT NULL,
  assigned_date      date NOT NULL,
  time_limit_minutes integer NOT NULL DEFAULT 10,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.daily_tests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='daily_tests' AND policyname='deny_all_daily_tests') THEN
    CREATE POLICY "deny_all_daily_tests" ON public.daily_tests FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX idx_daily_tests_school     ON public.daily_tests(school_id, assigned_date DESC);
CREATE INDEX idx_daily_tests_creator    ON public.daily_tests(created_by);
CREATE INDEX idx_daily_tests_class_date ON public.daily_tests(class_name, section, assigned_date);

-- ── daily_test_attempts ───────────────────────────────────────────────────────
CREATE TABLE public.daily_test_attempts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  daily_test_id   uuid NOT NULL REFERENCES public.daily_tests(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  answers         jsonb NOT NULL,
  score           integer NOT NULL DEFAULT 0,
  total_questions integer NOT NULL DEFAULT 0,
  completed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (daily_test_id, student_id)
);
ALTER TABLE public.daily_test_attempts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='daily_test_attempts' AND policyname='deny_all_daily_test_attempts') THEN
    CREATE POLICY "deny_all_daily_test_attempts" ON public.daily_test_attempts FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX idx_daily_test_attempts_student ON public.daily_test_attempts(student_id, completed_at DESC);
CREATE INDEX idx_daily_test_attempts_test    ON public.daily_test_attempts(daily_test_id);

-- ── activity_packs ────────────────────────────────────────────────────────────
CREATE TABLE public.activity_packs (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  class_name    text NOT NULL,
  section       text NOT NULL,
  subject       text NOT NULL,
  topic         text NOT NULL,
  activities    jsonb NOT NULL,
  assigned_date date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.activity_packs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='activity_packs' AND policyname='deny_all_activity_packs') THEN
    CREATE POLICY "deny_all_activity_packs" ON public.activity_packs FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX idx_activity_packs_school     ON public.activity_packs(school_id, assigned_date DESC);
CREATE INDEX idx_activity_packs_creator    ON public.activity_packs(created_by);
CREATE INDEX idx_activity_packs_class_date ON public.activity_packs(class_name, section, assigned_date);

-- ── activity_completions ──────────────────────────────────────────────────────
CREATE TABLE public.activity_completions (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  activity_pack_id uuid NOT NULL REFERENCES public.activity_packs(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  completed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_pack_id, student_id)
);
ALTER TABLE public.activity_completions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='activity_completions' AND policyname='deny_all_activity_completions') THEN
    CREATE POLICY "deny_all_activity_completions" ON public.activity_completions FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX idx_activity_completions_student ON public.activity_completions(student_id, completed_at DESC);
CREATE INDEX idx_activity_completions_pack    ON public.activity_completions(activity_pack_id);

-- ── weak_topics ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.weak_topics (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id     uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  subject        text NOT NULL,
  topic          text NOT NULL,
  weakness_score numeric(5,2) NOT NULL DEFAULT 0,
  last_updated   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, subject, topic)
);
ALTER TABLE public.weak_topics ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='weak_topics' AND policyname='deny_all_weak_topics') THEN
    CREATE POLICY "deny_all_weak_topics" ON public.weak_topics FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_weak_topics_student ON public.weak_topics(student_id, weakness_score DESC);

-- ── weekly_reports ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.weekly_reports (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id      uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  week_start_date date NOT NULL,
  report_text     text NOT NULL,
  metrics         jsonb,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, week_start_date)
);
ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='weekly_reports' AND policyname='deny_all_weekly_reports') THEN
    CREATE POLICY "deny_all_weekly_reports" ON public.weekly_reports FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_weekly_reports_student ON public.weekly_reports(student_id, week_start_date DESC);

-- ── parent_subscriptions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.parent_subscriptions (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id   uuid NOT NULL UNIQUE REFERENCES public.students(id) ON DELETE CASCADE,
  school_id    uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  plan_type    text NOT NULL CHECK (plan_type IN ('premium_junior','premium_senior')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','expired')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  renewed_at   timestamptz,
  activated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.parent_subscriptions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='parent_subscriptions' AND policyname='deny_all_parent_subscriptions') THEN
    CREATE POLICY "deny_all_parent_subscriptions" ON public.parent_subscriptions FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_parent_subscriptions_school  ON public.parent_subscriptions(school_id, status);
CREATE INDEX IF NOT EXISTS idx_parent_subscriptions_student ON public.parent_subscriptions(student_id);

-- ── parent_subscription_events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.parent_subscription_events (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id uuid NOT NULL REFERENCES public.parent_subscriptions(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  performed_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.parent_subscription_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='parent_subscription_events' AND policyname='deny_all_parent_subscription_events') THEN
    CREATE POLICY "deny_all_parent_subscription_events" ON public.parent_subscription_events FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_pse_subscription ON public.parent_subscription_events(subscription_id, created_at DESC);

-- ── teacher_premium_access ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.teacher_premium_access (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id      uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  daily_tests    boolean NOT NULL DEFAULT false,
  activity_packs boolean NOT NULL DEFAULT false,
  ai_assistant   boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, school_id)
);
ALTER TABLE public.teacher_premium_access ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='teacher_premium_access' AND policyname='deny_all_teacher_premium_access') THEN
    CREATE POLICY "deny_all_teacher_premium_access" ON public.teacher_premium_access FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_tpa_school  ON public.teacher_premium_access(school_id);
CREATE INDEX IF NOT EXISTS idx_tpa_teacher ON public.teacher_premium_access(teacher_id);

-- ── revenue_shares ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.revenue_shares (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  month         text NOT NULL,
  active_subs   integer NOT NULL DEFAULT 0,
  junior_count  integer NOT NULL DEFAULT 0,
  senior_count  integer NOT NULL DEFAULT 0,
  gross_revenue numeric(12,2) NOT NULL DEFAULT 0,
  platform_fee  numeric(12,2) NOT NULL DEFAULT 0,
  school_payout numeric(12,2) NOT NULL DEFAULT 0,
  payout_status text NOT NULL DEFAULT 'pending' CHECK (payout_status IN ('pending','paid','disputed')),
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, month)
);
ALTER TABLE public.revenue_shares ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='revenue_shares' AND policyname='deny_all_revenue_shares') THEN
    CREATE POLICY "deny_all_revenue_shares" ON public.revenue_shares FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_revenue_shares_school ON public.revenue_shares(school_id, month DESC);

-- ── fcm_tokens ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fcm_tokens (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid REFERENCES public.users(id) ON DELETE CASCADE,
  student_id  uuid REFERENCES public.students(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  device_type text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fcm_tokens_owner_check CHECK (
    (user_id IS NOT NULL AND student_id IS NULL) OR
    (user_id IS NULL AND student_id IS NOT NULL)
  )
);
ALTER TABLE public.fcm_tokens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fcm_tokens' AND policyname='deny_all_fcm_tokens') THEN
    CREATE POLICY "deny_all_fcm_tokens" ON public.fcm_tokens FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_id    ON public.fcm_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_student_id ON public.fcm_tokens(student_id);

-- ── parent_students ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.parent_students (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, student_id)
);
ALTER TABLE public.parent_students ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='parent_students' AND policyname='deny_all_parent_students') THEN
    CREATE POLICY "deny_all_parent_students" ON public.parent_students FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_parent_students_parent  ON public.parent_students(parent_id);
CREATE INDEX IF NOT EXISTS idx_parent_students_student ON public.parent_students(student_id);

-- ── school_admin_access ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.school_admin_access (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_id, school_id)
);
ALTER TABLE public.school_admin_access ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='school_admin_access' AND policyname='deny_all_school_admin_access') THEN
    CREATE POLICY "deny_all_school_admin_access" ON public.school_admin_access FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_school_admin_access_admin  ON public.school_admin_access(admin_id);
CREATE INDEX IF NOT EXISTS idx_school_admin_access_school ON public.school_admin_access(school_id);

-- ── announcements ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.announcements (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id      uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_by     uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  title          text NOT NULL,
  message        text NOT NULL,
  audience       text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone','teachers','students')),
  target_classes text[],
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='announcements' AND policyname='deny_all_announcements') THEN
    CREATE POLICY "deny_all_announcements" ON public.announcements FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_announcements_school  ON public.announcements(school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_creator ON public.announcements(created_by);

-- ── onboarding_progress ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id          uuid NOT NULL UNIQUE REFERENCES public.schools(id) ON DELETE CASCADE,
  school_created     boolean NOT NULL DEFAULT true,
  admin_created      boolean NOT NULL DEFAULT false,
  teachers_added     boolean NOT NULL DEFAULT false,
  students_added     boolean NOT NULL DEFAULT false,
  classes_configured boolean NOT NULL DEFAULT false,
  timetable_set      boolean NOT NULL DEFAULT false,
  first_attendance   boolean NOT NULL DEFAULT false,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='onboarding_progress' AND policyname='deny_all_onboarding_progress') THEN
    CREATE POLICY "deny_all_onboarding_progress" ON public.onboarding_progress FOR ALL USING (false);
  END IF;
END $$;

-- ── test_restrictions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.test_restrictions (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  test_id    uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, student_id)
);
ALTER TABLE public.test_restrictions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='test_restrictions' AND policyname='deny_all_test_restrictions') THEN
    CREATE POLICY "deny_all_test_restrictions" ON public.test_restrictions FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_test_restrictions_test ON public.test_restrictions(test_id);

-- ── ai_usage ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  action      text NOT NULL,
  prompt_hash text,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ai_usage' AND policyname='deny_all_ai_usage') THEN
    CREATE POLICY "deny_all_ai_usage" ON public.ai_usage FOR ALL USING (false);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date   ON public.ai_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_prompt_hash ON public.ai_usage(prompt_hash) WHERE prompt_hash IS NOT NULL;

NOTIFY pgrst, 'reload schema';
