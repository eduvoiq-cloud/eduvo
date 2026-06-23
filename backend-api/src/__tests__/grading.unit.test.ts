/**
 * grading.unit.test.ts
 *
 * Unit tests for the MCQ grading logic (calculateScore).
 * These are pure function tests — no database, no HTTP requests.
 *
 * Plain language: When a student submits answers, the score must be
 * calculated correctly. A bug here means students get wrong marks —
 * the most visible failure possible.
 */

import { calculateScore, GradingQuestion, GradingAnswer } from '../utils/grading';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** 5 MCQ questions, each worth 1 mark. */
function makeMcqQuestions(count = 5): GradingQuestion[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `q${i + 1}`,
    question_type: 'mcq',
    correct_option: 'a',
    marks: 1,
  }));
}

/** Answer every question with the CORRECT option ('a'). */
function correctAnswers(questions: GradingQuestion[]): GradingAnswer[] {
  return questions.map((q) => ({ question_id: q.id, selected_option: 'a' }));
}

/** Answer every question with a WRONG option ('b' — correct is 'a'). */
function wrongAnswers(questions: GradingQuestion[]): GradingAnswer[] {
  return questions.map((q) => ({ question_id: q.id, selected_option: 'b' }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Grading Logic', () => {

  // ── TEST 1.1 ──────────────────────────────────────────────────────────────
  it('returns score=5 and percentage=100 when all 5 answers are correct', () => {
    const questions = makeMcqQuestions(5);
    const answers = correctAnswers(questions);

    const result = calculateScore(questions, answers);

    expect(result.score).toBe(5);
    expect(result.percentage).toBe(100);
  });

  // ── TEST 1.2 ──────────────────────────────────────────────────────────────
  it('returns score=0 and percentage=0 when all 5 answers are wrong', () => {
    const questions = makeMcqQuestions(5);
    const answers = wrongAnswers(questions);

    const result = calculateScore(questions, answers);

    expect(result.score).toBe(0);
    expect(result.percentage).toBe(0);
  });

  // ── TEST 1.3 ──────────────────────────────────────────────────────────────
  it('returns score=3 and percentage=60 when 3 out of 5 answers are correct', () => {
    const questions = makeMcqQuestions(5);
    const answers: GradingAnswer[] = [
      { question_id: 'q1', selected_option: 'a' }, // correct
      { question_id: 'q2', selected_option: 'a' }, // correct
      { question_id: 'q3', selected_option: 'a' }, // correct
      { question_id: 'q4', selected_option: 'b' }, // wrong
      { question_id: 'q5', selected_option: 'c' }, // wrong
    ];

    const result = calculateScore(questions, answers);

    expect(result.score).toBe(3);
    expect(result.percentage).toBe(60);
  });

  // ── TEST 1.4 ──────────────────────────────────────────────────────────────
  it('returns score=0 and percentage=0 when an empty answer array is provided', () => {
    const questions = makeMcqQuestions(5);

    const result = calculateScore(questions, []);

    // Empty submission — nothing scored, totals start at 0
    expect(result.score).toBe(0);
    expect(result.percentage).toBe(0);
  });

  // ── TEST 1.5 ──────────────────────────────────────────────────────────────
  it('ignores answers with non-existent question_ids and only scores valid answers', () => {
    const questions = makeMcqQuestions(5);
    const answers: GradingAnswer[] = [
      { question_id: 'q1', selected_option: 'a' },             // valid + correct
      { question_id: 'q2', selected_option: 'a' },             // valid + correct
      { question_id: 'DOES_NOT_EXIST', selected_option: 'a' }, // invalid — ignored
    ];

    const result = calculateScore(questions, answers);

    // Only q1 and q2 are scored. The invalid ID does not cause a crash.
    expect(result.score).toBe(2);

    // BUG REPORT: percentage = score / totalMcqMarks. totalMcqMarks is built
    // from the answered valid questions only (2 marks), not all 5 questions.
    // So 2/2 = 100% — not the "40%" a human would expect from 2-out-of-5.
    // This is a known limitation of the current grading algorithm: it cannot
    // penalise unanswered questions because it only iterates over submitted answers.
    // The test documents the ACTUAL behaviour. Fix in a separate issue.
    expect(result.percentage).toBe(100); // 2/2 answered-MCQ marks
    expect(result.totalMcqMarks).toBe(2); // only counts marks from answered questions
  });

  // ── TEST 1.6 ──────────────────────────────────────────────────────────────
  it('uses the LAST answer when the same question_id is submitted twice (no double-counting)', () => {
    const questions = makeMcqQuestions(5);

    // q1 submitted twice: first WRONG ('b'), then CORRECT ('a')
    // Per the route handler reduce() behaviour, the last entry wins.
    const answers: GradingAnswer[] = [
      { question_id: 'q1', selected_option: 'b' }, // first submission — wrong
      { question_id: 'q2', selected_option: 'a' }, // correct
      { question_id: 'q3', selected_option: 'a' }, // correct
      { question_id: 'q4', selected_option: 'a' }, // correct
      { question_id: 'q5', selected_option: 'a' }, // correct
      { question_id: 'q1', selected_option: 'a' }, // second submission — correct (wins)
    ];

    const result = calculateScore(questions, answers);

    // All 5 correct after dedup — score must be 5, not 6 (no double-counting)
    expect(result.score).toBe(5);
    expect(result.percentage).toBe(100);
    expect(result.totalMcqMarks).toBe(5); // exactly 5 marks total, not 6
  });

  // ── Extra: theory questions are excluded from MCQ scoring ────────────────
  it('does not score theory questions (they await teacher marking)', () => {
    const questions: GradingQuestion[] = [
      { id: 'q1', question_type: 'mcq',    correct_option: 'a', marks: 2 },
      { id: 'q2', question_type: 'theory', correct_option: null, marks: 5 },
    ];
    const answers: GradingAnswer[] = [
      { question_id: 'q1', selected_option: 'a' }, // correct MCQ
      { question_id: 'q2', selected_option: 'a' }, // theory — should be ignored by scorer
    ];

    const result = calculateScore(questions, answers);

    expect(result.score).toBe(2);          // only q1 scored
    expect(result.totalMcqMarks).toBe(2);  // only MCQ marks counted
    expect(result.percentage).toBe(100);   // 2/2 = 100%
  });
});
