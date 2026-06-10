-- ============================================================
-- Eduvo — Dual Medium Support Migration
-- Run this in: https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
-- ============================================================

-- ── 1. Add medium field to schools ───────────────────────────────────────────
ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS medium text DEFAULT 'english'
  CHECK (medium IN ('english', 'gujarati'));

-- ── 2. Link sister schools (Gujarati school points back to English parent) ───
ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS parent_school_id uuid
  REFERENCES public.schools(id) ON DELETE SET NULL;

-- ── 3. Admin multi-school access table ───────────────────────────────────────
-- One row per (admin, school) pair. An admin can manage multiple schools
-- (i.e. both mediums) under a single login.
CREATE TABLE IF NOT EXISTS public.school_admin_access (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_id, school_id)
);

-- Block direct client access — backend uses service-role key only
ALTER TABLE public.school_admin_access ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'school_admin_access'
      AND policyname = 'deny_all_school_admin_access'
  ) THEN
    CREATE POLICY "deny_all_school_admin_access"
      ON public.school_admin_access FOR ALL USING (false);
  END IF;
END $$;

-- Index for fast admin → schools lookups
CREATE INDEX IF NOT EXISTS idx_school_admin_access_admin_id
  ON public.school_admin_access(admin_id);

CREATE INDEX IF NOT EXISTS idx_school_admin_access_school_id
  ON public.school_admin_access(school_id);

-- ── 4. Back-fill existing admins into school_admin_access ────────────────────
-- Every existing schooladmin gets an access row for their current school
-- so no admin loses access after this migration.
INSERT INTO public.school_admin_access (admin_id, school_id, created_at)
SELECT u.id, u.school_id, now()
FROM   public.users u
WHERE  u.role = 'schooladmin'
  AND  u.school_id IS NOT NULL
  AND  (u.is_deleted IS NULL OR u.is_deleted = false)
ON CONFLICT (admin_id, school_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
