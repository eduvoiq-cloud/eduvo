-- ── Add explanation and reasoning columns to questions table ─────────────────
-- explanation: one-line factual answer explanation (max 20 words)
-- reasoning:   2-4 sentence teaching explanation (new field, nullable for backward compat)

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS explanation text,
  ADD COLUMN IF NOT EXISTS reasoning   text;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
