CREATE TABLE IF NOT EXISTS public.test_integrity_logs (
  id                          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  test_attempt_id             uuid        NOT NULL REFERENCES public.test_attempts(id) ON DELETE CASCADE,
  student_id                  uuid        NOT NULL REFERENCES public.students(id),
  school_id                   uuid        NOT NULL REFERENCES public.schools(id),
  exit_count                  integer     NOT NULL DEFAULT 0,
  return_count                integer     NOT NULL DEFAULT 0,
  total_exit_duration_seconds integer     NOT NULL DEFAULT 0,
  longest_single_exit_seconds integer     NOT NULL DEFAULT 0,
  integrity_score             numeric,
  is_suspicious               boolean     NOT NULL DEFAULT false,
  suspicious_reasons          text[],
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.test_integrity_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='test_integrity_logs' AND policyname='til_student_select_own') THEN
    CREATE POLICY "til_student_select_own" ON public.test_integrity_logs FOR SELECT TO authenticated
      USING (student_id IN (SELECT id FROM public.students WHERE id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='test_integrity_logs' AND policyname='til_teacher_select_school_class') THEN
    CREATE POLICY "til_teacher_select_school_class" ON public.test_integrity_logs FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.teacher_assignments ta ON ta.teacher_id = u.id
          JOIN public.students s ON s.id = test_integrity_logs.student_id
            AND (s.class_name = ta.class_name OR s.class = ta.class_name)
            AND s.section = ta.section
          WHERE u.id = auth.uid() AND u.role = 'teacher'
            AND u.school_id = test_integrity_logs.school_id
            AND ta.school_id = test_integrity_logs.school_id
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_integrity_logs_attempt ON public.test_integrity_logs(daily_test_attempt_id);
CREATE INDEX IF NOT EXISTS idx_integrity_logs_student ON public.test_integrity_logs(student_id);

NOTIFY pgrst, 'reload schema';

CREATE TABLE IF NOT EXISTS public.integrity_score_config (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  config_key   text        NOT NULL UNIQUE,
  config_value numeric     NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.integrity_score_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='integrity_score_config' AND policyname='isc_superadmin_all') THEN
    CREATE POLICY "isc_superadmin_all" ON public.integrity_score_config FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='integrity_score_config' AND policyname='isc_all_read') THEN
    CREATE POLICY "isc_all_read" ON public.integrity_score_config FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

INSERT INTO public.integrity_score_config (config_key, config_value, description) VALUES
  ('base_score',                           100, 'Starting score before deductions'),
  ('exit_deduction_per_exit',                5, 'Points deducted per exit event'),
  ('long_exit_threshold_seconds',          120, 'Exit longer than this is penalised more'),
  ('long_exit_extra_deduction',             10, 'Extra deduction for long exits'),
  ('suspicious_exit_count_threshold',        5, 'Exit count at or above this = suspicious'),
  ('suspicious_duration_threshold_seconds', 300, 'Total exit duration above this = suspicious'),
  ('suspicious_rapid_exit_count',            3, 'Exits within 60 seconds = suspicious pattern'),
  ('minimum_score',                          0, 'Score cannot go below this')
ON CONFLICT (config_key) DO NOTHING;

NOTIFY pgrst, 'reload schema';

CREATE TABLE IF NOT EXISTS public.monthly_recovery_schedules (
  id                      uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id               uuid        NOT NULL REFERENCES public.schools(id),
  class                   text        NOT NULL,
  section                 text        NOT NULL,
  subject                 text        NOT NULL,
  scheduled_month         date        NOT NULL,
  scheduled_test_date     date,
  recovery_pack_date      date,
  teacher_id              uuid        REFERENCES public.users(id),
  status                  text        NOT NULL DEFAULT 'pending_teacher_approval'
                          CHECK (status IN ('pending_teacher_approval','approved','postponed','cancelled','pack_generated','test_generated','completed')),
  teacher_decision        text        CHECK (teacher_decision IN ('generate_now','postpone','cancel',null)),
  teacher_decision_at     timestamptz,
  teacher_decision_reason text,
  postpone_reason         text        CHECK (postpone_reason IN ('unit_test','final_exam','school_event','teacher_choice','other',null)),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.monthly_recovery_schedules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_schedules' AND policyname='mrs_teacher_select') THEN
    CREATE POLICY "mrs_teacher_select" ON public.monthly_recovery_schedules FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.teacher_assignments ta ON ta.teacher_id = u.id
          WHERE u.id = auth.uid() AND u.role = 'teacher'
            AND u.school_id = monthly_recovery_schedules.school_id
            AND ta.school_id = monthly_recovery_schedules.school_id
            AND ta.class_name = monthly_recovery_schedules.class
            AND ta.section    = monthly_recovery_schedules.section
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_schedules' AND policyname='mrs_teacher_update') THEN
    CREATE POLICY "mrs_teacher_update" ON public.monthly_recovery_schedules FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.teacher_assignments ta ON ta.teacher_id = u.id
          WHERE u.id = auth.uid() AND u.role = 'teacher'
            AND u.school_id = monthly_recovery_schedules.school_id
            AND ta.school_id = monthly_recovery_schedules.school_id
            AND ta.class_name = monthly_recovery_schedules.class
            AND ta.section    = monthly_recovery_schedules.section
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.teacher_assignments ta ON ta.teacher_id = u.id
          WHERE u.id = auth.uid() AND u.role = 'teacher'
            AND u.school_id = monthly_recovery_schedules.school_id
            AND ta.school_id = monthly_recovery_schedules.school_id
            AND ta.class_name = monthly_recovery_schedules.class
            AND ta.section    = monthly_recovery_schedules.section
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_schedules' AND policyname='mrs_school_admin_all') THEN
    CREATE POLICY "mrs_school_admin_all" ON public.monthly_recovery_schedules FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'school_admin' AND u.school_id = monthly_recovery_schedules.school_id))
      WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'school_admin' AND u.school_id = monthly_recovery_schedules.school_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_schedules' AND policyname='mrs_superadmin_all') THEN
    CREATE POLICY "mrs_superadmin_all" ON public.monthly_recovery_schedules FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_recovery_schedules_school_month ON public.monthly_recovery_schedules(school_id, scheduled_month, class, section);
CREATE INDEX IF NOT EXISTS idx_recovery_schedules_status ON public.monthly_recovery_schedules(status);

NOTIFY pgrst, 'reload schema';

CREATE TABLE IF NOT EXISTS public.recovery_packs (
  id                   uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  recovery_schedule_id uuid        NOT NULL REFERENCES public.monthly_recovery_schedules(id) ON DELETE CASCADE,
  student_id           uuid        NOT NULL REFERENCES public.students(id),
  school_id            uuid        NOT NULL REFERENCES public.schools(id),
  subject              text        NOT NULL,
  scheduled_month      date        NOT NULL,
  weak_topics          text[],
  pack_content         jsonb,
  generation_status    text        NOT NULL DEFAULT 'pending'
                       CHECK (generation_status IN ('pending','processing','completed','failed')),
  generated_at         timestamptz,
  batch_job_id         text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.recovery_packs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='recovery_packs' AND policyname='rp_student_select_own') THEN
    CREATE POLICY "rp_student_select_own" ON public.recovery_packs FOR SELECT TO authenticated
      USING (student_id IN (SELECT id FROM public.students WHERE id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='recovery_packs' AND policyname='rp_school_admin_select') THEN
    CREATE POLICY "rp_school_admin_select" ON public.recovery_packs FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'school_admin' AND u.school_id = recovery_packs.school_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='recovery_packs' AND policyname='rp_superadmin_all') THEN
    CREATE POLICY "rp_superadmin_all" ON public.recovery_packs FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_recovery_packs_student_month ON public.recovery_packs(student_id, scheduled_month);

NOTIFY pgrst, 'reload schema';

CREATE TABLE IF NOT EXISTS public.monthly_recovery_tests (
  id                   uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  recovery_schedule_id uuid        NOT NULL REFERENCES public.monthly_recovery_schedules(id) ON DELETE CASCADE,
  student_id           uuid        NOT NULL REFERENCES public.students(id),
  school_id            uuid        NOT NULL REFERENCES public.schools(id),
  subject              text        NOT NULL,
  scheduled_month      date        NOT NULL,
  weak_topics_used     text[],
  questions            jsonb,
  total_questions      integer,
  generation_status    text        NOT NULL DEFAULT 'pending'
                       CHECK (generation_status IN ('pending','processing','completed','failed')),
  generated_at         timestamptz,
  batch_job_id         text,
  is_available         boolean     NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.monthly_recovery_tests ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_tests' AND policyname='mrt_student_select_available') THEN
    CREATE POLICY "mrt_student_select_available" ON public.monthly_recovery_tests FOR SELECT TO authenticated
      USING (is_available = true AND student_id IN (SELECT id FROM public.students WHERE id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_tests' AND policyname='mrt_teacher_select') THEN
    CREATE POLICY "mrt_teacher_select" ON public.monthly_recovery_tests FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.teacher_assignments ta ON ta.teacher_id = u.id
          JOIN public.students s ON s.id = monthly_recovery_tests.student_id
            AND (s.class_name = ta.class_name OR s.class = ta.class_name)
            AND s.section = ta.section
          WHERE u.id = auth.uid() AND u.role = 'teacher'
            AND u.school_id = monthly_recovery_tests.school_id
            AND ta.school_id = monthly_recovery_tests.school_id
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_tests' AND policyname='mrt_teacher_update_availability') THEN
    CREATE POLICY "mrt_teacher_update_availability" ON public.monthly_recovery_tests FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.teacher_assignments ta ON ta.teacher_id = u.id
          JOIN public.students s ON s.id = monthly_recovery_tests.student_id
            AND (s.class_name = ta.class_name OR s.class = ta.class_name)
            AND s.section = ta.section
          WHERE u.id = auth.uid() AND u.role = 'teacher'
            AND u.school_id = monthly_recovery_tests.school_id
            AND ta.school_id = monthly_recovery_tests.school_id
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.teacher_assignments ta ON ta.teacher_id = u.id
          JOIN public.students s ON s.id = monthly_recovery_tests.student_id
            AND (s.class_name = ta.class_name OR s.class = ta.class_name)
            AND s.section = ta.section
          WHERE u.id = auth.uid() AND u.role = 'teacher'
            AND u.school_id = monthly_recovery_tests.school_id
            AND ta.school_id = monthly_recovery_tests.school_id
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_tests' AND policyname='mrt_school_admin_all') THEN
    CREATE POLICY "mrt_school_admin_all" ON public.monthly_recovery_tests FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'school_admin' AND u.school_id = monthly_recovery_tests.school_id))
      WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'school_admin' AND u.school_id = monthly_recovery_tests.school_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_tests' AND policyname='mrt_superadmin_all') THEN
    CREATE POLICY "mrt_superadmin_all" ON public.monthly_recovery_tests FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_recovery_tests_student_month ON public.monthly_recovery_tests(student_id, scheduled_month, subject);

NOTIFY pgrst, 'reload schema';

CREATE TABLE IF NOT EXISTS public.monthly_recovery_attempts (
  id                               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  monthly_recovery_test_id         uuid        NOT NULL REFERENCES public.monthly_recovery_tests(id),
  student_id                       uuid        NOT NULL REFERENCES public.students(id),
  school_id                        uuid        NOT NULL REFERENCES public.schools(id),
  subject                          text        NOT NULL,
  scheduled_month                  date        NOT NULL,
  answers                          jsonb,
  score                            numeric,
  total_questions                  integer,
  score_percentage                 numeric,
  topic_scores                     jsonb,
  previous_month_score_percentage  numeric,
  improvement_percentage           numeric,
  completed_at                     timestamptz,
  status                           text        NOT NULL DEFAULT 'not_started'
                                   CHECK (status IN ('not_started','in_progress','completed')),
  created_at                       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.monthly_recovery_attempts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_attempts' AND policyname='mra_student_select_own') THEN
    CREATE POLICY "mra_student_select_own" ON public.monthly_recovery_attempts FOR SELECT TO authenticated
      USING (student_id IN (SELECT id FROM public.students WHERE id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_attempts' AND policyname='mra_student_update_own') THEN
    CREATE POLICY "mra_student_update_own" ON public.monthly_recovery_attempts FOR UPDATE TO authenticated
      USING (student_id IN (SELECT id FROM public.students WHERE id = auth.uid()))
      WITH CHECK (student_id IN (SELECT id FROM public.students WHERE id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_attempts' AND policyname='mra_teacher_select') THEN
    CREATE POLICY "mra_teacher_select" ON public.monthly_recovery_attempts FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.users u
          JOIN public.teacher_assignments ta ON ta.teacher_id = u.id
          JOIN public.students s ON s.id = monthly_recovery_attempts.student_id
            AND (s.class_name = ta.class_name OR s.class = ta.class_name)
            AND s.section = ta.section
          WHERE u.id = auth.uid() AND u.role = 'teacher'
            AND u.school_id = monthly_recovery_attempts.school_id
            AND ta.school_id = monthly_recovery_attempts.school_id
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_attempts' AND policyname='mra_school_admin_all') THEN
    CREATE POLICY "mra_school_admin_all" ON public.monthly_recovery_attempts FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'school_admin' AND u.school_id = monthly_recovery_attempts.school_id))
      WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'school_admin' AND u.school_id = monthly_recovery_attempts.school_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_recovery_attempts' AND policyname='mra_superadmin_all') THEN
    CREATE POLICY "mra_superadmin_all" ON public.monthly_recovery_attempts FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'superadmin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_recovery_attempts_student_month ON public.monthly_recovery_attempts(student_id, scheduled_month, subject);

NOTIFY pgrst, 'reload schema';
