-- ============================================================
-- Subject Resources (Notes) Migration
-- Run in: Supabase SQL Editor
-- ============================================================

-- Enable uuid-ossp if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── subject_resources: create table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subject_resources (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  teacher_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  class         text NOT NULL,
  section       text NOT NULL,
  subject       text NOT NULL,
  title         text NOT NULL,
  description   text,
  resource_type text NOT NULL CHECK (resource_type IN ('note', 'assignment')),
  file_urls     text[] NOT NULL DEFAULT '{}',
  due_date      date,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.subject_resources ENABLE ROW LEVEL SECURITY;

-- Deny-all baseline (backend uses service-role key which bypasses RLS)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'subject_resources'
      AND policyname = 'deny_all_subject_resources'
  ) THEN
    CREATE POLICY "deny_all_subject_resources"
      ON public.subject_resources FOR ALL USING (false);
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_subject_resources_school_class
  ON public.subject_resources(school_id, class, section, subject);

CREATE INDEX IF NOT EXISTS idx_subject_resources_created_at
  ON public.subject_resources(created_at);

CREATE INDEX IF NOT EXISTS idx_subject_resources_teacher
  ON public.subject_resources(teacher_id);

NOTIFY pgrst, 'reload schema';
