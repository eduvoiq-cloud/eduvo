-- Fix: pure-MCQ test attempts that have mcq_score set but total_score = null
-- These show "Pending grading" incorrectly in the student Marks screen.
--
-- A test attempt is "pure MCQ" if every answer in student_answers has
-- marks_awarded IS NOT NULL (i.e. no ungraded theory answers exist).
-- For those attempts, total_score should equal mcq_score.
--
-- Run this once to backfill existing data.

UPDATE test_attempts ta
SET    total_score = ta.mcq_score
WHERE  ta.is_submitted = true
  AND  ta.total_score IS NULL
  AND  ta.mcq_score   IS NOT NULL
  AND  NOT EXISTS (
         SELECT 1
         FROM   student_answers sa
         WHERE  sa.attempt_id    = ta.id
           AND  sa.marks_awarded IS NULL   -- ungraded theory answer
       );
