-- ── add max_score to tests table ──────────────────────────────────────────────
-- The test-analytics route was selecting max_score from the tests table but
-- that column never existed, causing a 500 on every analytics click.
-- Back-fill from test_questions so existing tests have the right value.

ALTER TABLE public.tests
  ADD COLUMN IF NOT EXISTS max_score numeric(8,2);

-- Back-fill: sum of marks across all questions for each test
UPDATE public.tests t
SET    max_score = (
  SELECT COALESCE(SUM(tq.marks), 0)
  FROM   public.test_questions tq
  WHERE  tq.test_id = t.id
)
WHERE  max_score IS NULL;

NOTIFY pgrst, 'reload schema';
