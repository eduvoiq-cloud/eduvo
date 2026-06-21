-- Add board to schools table
ALTER TABLE public.schools
ADD COLUMN IF NOT EXISTS board text DEFAULT 'GSEB'
CHECK (board IN ('GSEB', 'CBSE', 'ICSE', 'MSBSHSE', 'RBSE', 'BSEB', 'MPBSE', 'IB', 'IGCSE'));

-- Add result_template to schools table
ALTER TABLE public.schools
ADD COLUMN IF NOT EXISTS result_template text DEFAULT 'percentage'
CHECK (result_template IN ('percentage', 'grade', 'gseb', 'cbse'));

-- Add editable profile fields to school_settings
ALTER TABLE public.school_settings
ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE public.school_settings
ADD COLUMN IF NOT EXISTS display_address text;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
