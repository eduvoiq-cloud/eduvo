-- ── Fix: add order_index to questions table and reload PostgREST schema cache ──
-- Run this in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/<your-project>/sql/new

-- Ensure order_index column exists on the questions table
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS order_index integer NOT NULL DEFAULT 0;

-- Ensure it also exists on test_questions (legacy table) for consistency
ALTER TABLE public.test_questions
  ADD COLUMN IF NOT EXISTS order_index integer NOT NULL DEFAULT 0;

-- Reload PostgREST schema cache so the new column is immediately visible
NOTIFY pgrst, 'reload schema';
