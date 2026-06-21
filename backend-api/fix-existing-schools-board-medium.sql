-- ============================================================
-- Eduvo — Existing Schools Fix Migration
-- Safe to run multiple times (all operations are idempotent).
--
-- Run this once in:
-- https://supabase.com/dashboard/project/gkbqltztadukfbknnqqd/sql/new
--
-- What this does:
--   1. Ensures board, medium, parent_school_id columns exist on schools
--   2. Ensures result_template, display_name, display_address exist
--   3. Ensures school_admin_access table exists with correct indexes + RLS
--   4. Back-fills board = 'GSEB' for any schools where it is NULL
--   5. Back-fills medium = 'english' for any schools where it is NULL
--   6. Back-fills result_template = 'gseb' for GSEB schools that still have
--      the generic 'percentage' default (more accurate for GSEB)
--   7. Back-fills school_admin_access for every existing schooladmin so
--      they don't lose access or break the medium switcher
--   8. Prints a diagnostic summary so you can see exactly what was fixed
-- ============================================================


-- ── 1. Columns on schools ─────────────────────────────────────────────────────

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS board text DEFAULT 'GSEB'
  CHECK (board IN ('GSEB', 'CBSE', 'ICSE', 'MSBSHSE', 'RBSE', 'BSEB', 'MPBSE', 'IB', 'IGCSE'));

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS medium text DEFAULT 'english'
  CHECK (medium IN ('english', 'gujarati'));

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS parent_school_id uuid
  REFERENCES public.schools(id) ON DELETE SET NULL;

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS result_template text DEFAULT 'percentage'
  CHECK (result_template IN ('percentage', 'grade', 'gseb', 'cbse'));


-- ── 2. Columns on school_settings ────────────────────────────────────────────

ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS display_address text;


-- ── 3. school_admin_access table ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.school_admin_access (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id   uuid NOT NULL REFERENCES public.users(id)   ON DELETE CASCADE,
  school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_id, school_id)
);

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

CREATE INDEX IF NOT EXISTS idx_school_admin_access_admin_id
  ON public.school_admin_access(admin_id);

CREATE INDEX IF NOT EXISTS idx_school_admin_access_school_id
  ON public.school_admin_access(school_id);


-- ── 4. Back-fill NULL board → 'GSEB' ─────────────────────────────────────────
-- Any school created before add-school-profile.sql was run will have NULL here.
-- DEFAULT 'GSEB' handles new rows; this fixes existing NULLs.

UPDATE public.schools
SET    board = 'GSEB'
WHERE  board IS NULL;


-- ── 5. Back-fill NULL medium → 'english' ─────────────────────────────────────

UPDATE public.schools
SET    medium = 'english'
WHERE  medium IS NULL;


-- ── 6. Fix result_template for GSEB schools ───────────────────────────────────
-- Schools that were created before the profile migration landed got
-- result_template = 'percentage' (the generic default).
-- GSEB schools should use 'gseb' template for correct report card format.
-- We only update schools where result_template is still the generic 'percentage'
-- default AND board is GSEB — this is safe because 'percentage' is never the
-- correct choice for GSEB; gseb includes percentage + grade in the right format.

UPDATE public.schools
SET    result_template = 'gseb'
WHERE  board            = 'GSEB'
  AND  result_template  = 'percentage'
  AND  parent_school_id IS NULL; -- only update root schools, siblings inherit


-- ── 7. Back-fill school_admin_access ─────────────────────────────────────────
-- Every existing schooladmin gets an access row for their primary school.
-- ON CONFLICT DO NOTHING makes this safe to run repeatedly.

INSERT INTO public.school_admin_access (admin_id, school_id, created_at)
SELECT u.id, u.school_id, now()
FROM   public.users u
WHERE  u.role      = 'schooladmin'
  AND  u.school_id IS NOT NULL
  AND  (u.is_deleted IS NULL OR u.is_deleted = false)
ON CONFLICT (admin_id, school_id) DO NOTHING;


-- ── 8. Diagnostic summary ─────────────────────────────────────────────────────
-- After running, this shows you the state of every school so you can
-- spot-check that everything looks correct.

SELECT
  s.id,
  s.name,
  s.board,
  s.medium,
  s.result_template,
  s.parent_school_id,
  CASE
    WHEN s.parent_school_id IS NOT NULL THEN 'sibling'
    WHEN EXISTS (
      SELECT 1 FROM public.schools s2
      WHERE s2.parent_school_id = s.id
    ) THEN 'root (has sibling)'
    ELSE 'standalone'
  END AS school_type,
  COUNT(saa.admin_id) AS admin_access_rows,
  s.subscription_status
FROM       public.schools             s
LEFT JOIN  public.school_admin_access saa ON saa.school_id = s.id
GROUP BY   s.id, s.name, s.board, s.medium, s.result_template,
           s.parent_school_id, s.subscription_status
ORDER BY   s.name;


NOTIFY pgrst, 'reload schema';
