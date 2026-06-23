/**
 * grading.ts
 *
 * Pure grading helpers extracted from the /api/tests/attempt/submit route.
 * Exported so they can be unit-tested without a real database.
 *
 * Rule: duplicate question_id submissions — the LAST answer wins.
 * This is enforced by the reduce() loop below: later entries overwrite
 * earlier ones in the map before scoring.
 */

export interface GradingQuestion {
  id: string;
  question_type: 'mcq' | 'theory' | string;
  correct_option: string | null;
  marks: number;
}

export interface GradingAnswer {
  question_id: string;
  selected_option?: string;
}

export interface GradingResult {
  score: number;
  percentage: number;
  totalMcqMarks: number;
}

/**
 * calculateScore
 *
 * Scores a student's MCQ submission against the question bank.
 *
 * @param questions  Array of questions with correct_option and marks (from DB).
 * @param answers    Array of student answers (question_id → selected_option).
 * @returns          { score, percentage, totalMcqMarks }
 *
 * Behaviour:
 *   - Answers for unknown question_ids are silently ignored.
 *   - Theory questions are not scored here (marks_awarded remains null until teacher marks).
 *   - Duplicate question_id: the LAST answer in the array is used.
 *   - If no MCQ questions exist, percentage = 0 (not NaN).
 */
export function calculateScore(
  questions: GradingQuestion[],
  answers: GradingAnswer[]
): GradingResult {
  // Build a lookup map from question_id → question
  const questionMap = new Map<string, GradingQuestion>(
    questions.map((q) => [q.id, q])
  );

  // Deduplicate answers: keep the LAST answer per question_id (same as Array.reduce in route)
  const deduped = new Map<string, GradingAnswer>();
  for (const ans of answers) {
    deduped.set(ans.question_id, ans);
  }

  let score = 0;
  let totalMcqMarks = 0;

  for (const ans of deduped.values()) {
    const question = questionMap.get(ans.question_id);
    if (!question) continue; // unknown question_id — skip silently
    if (question.question_type !== 'mcq') continue; // theory — skip

    totalMcqMarks += question.marks;
    if (ans.selected_option === question.correct_option) {
      score += question.marks;
    }
  }

  const percentage = totalMcqMarks === 0 ? 0 : Math.round((score / totalMcqMarks) * 100);

  return { score, percentage, totalMcqMarks };
}
