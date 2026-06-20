/**
 * weaknessAnalysisService.ts
 *
 * Analyses a student's academic weak topics for a given subject.
 * Used by the monthly recovery pack and test generation pipeline.
 *
 * Data sources (weighted):
 *   Source 1 — Regular Tests (test_attempts + test_questions):  40%
 *   Source 2 — Homework (homework_submissions):                 20%
 *   Source 3 — School Exam Marks:                              25%
 *   Source 4 — Previous Monthly Recovery Attempts:             15%
 *
 * Returns up to 6 weak topics sorted by weakness_score ascending
 * (lower score = weaker area = needs more help).
 */

import { supabaseAdmin } from '../config/supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Student profile type for recovery pack generation:
 * - 'enrichment': subject_marks_pct >= 85 across all data — extension pack
 * - 'no_data':    no test history at all — curiosity/overview pack
 * - 'weak':       has identifiable weak topics — remediation pack
 */
export type StudentProfileType = 'weak' | 'no_data' | 'enrichment';

export interface WeakTopic {
  topic: string;
  weakness_score: number; // 0–100, lower = weaker
  source_breakdown: {
    tests: number | null;
    homework: number | null;
    marks: number | null;
    previous_recovery: number | null;
  };
}

export interface WeaknessAnalysisResult {
  student_id: string;
  subject: string;
  scheduled_month: string;
  weak_topics: WeakTopic[];
  subject_marks_pct: number | null; // overall marks % for this subject
  /** Profile type used to select Gemini prompt variant */
  profile_type: StudentProfileType;
  /** True when no test/homework/marks data exists at all */
  has_no_data: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp a value between 0 and 100. */
function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** Weighted average of up to 4 optional scores. Returns null if no data. */
function weightedScore(
  tests:    { pct: number | null; weight: number },
  homework: { pct: number | null; weight: number },
  marks:    { pct: number | null; weight: number },
  prevRec:  { pct: number | null; weight: number }
): number | null {
  let sum = 0;
  let totalWeight = 0;

  for (const src of [tests, homework, marks, prevRec]) {
    if (src.pct !== null) {
      sum += src.pct * src.weight;
      totalWeight += src.weight;
    }
  }

  if (totalWeight === 0) return null;
  return clamp(sum / totalWeight);
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Calculates weak topics for a student in a given subject.
 *
 * @param studentId       UUID of the student
 * @param subject         Subject name (text, e.g. "Mathematics")
 * @param schoolId        UUID of the school
 * @param scheduledMonth  YYYY-MM-DD of first day of the recovery month (e.g. "2026-07-01")
 * @returns               WeaknessAnalysisResult with up to 6 sorted weak topics
 */
export async function analyzeStudentWeakness(
  studentId: string,
  subject: string,
  schoolId: string,
  scheduledMonth: string
): Promise<WeaknessAnalysisResult> {

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // ── SOURCE 1 — Regular Tests ──────────────────────────────────────────────
  // Query test_attempts joined with tests where subject matches.
  // For per-topic breakdown, join test_questions and student_answers.
  // The `chapter` field on `tests` is used as the topic fallback
  // (tests have a chapter/topic field from the creation flow).
  // We accumulate per-topic (chapter) correct/incorrect counts.

  const topicCorrectMap = new Map<string, { correct: number; total: number }>();

  {
    // Fetch submitted test_attempts for tests in this subject
    const { data: attempts } = await supabaseAdmin
      .from('test_attempts')
      .select(`
        id,
        test_id,
        tests!test_attempts_test_id_fkey (
          id, subject, school_id, date, chapter, class, section
        )
      `)
      .eq('student_id', studentId)
      .eq('is_submitted', true)
      .gte('submitted_at', ninetyDaysAgo);

    const subjectAttempts = (
      (attempts ?? []) as unknown as Array<{
        id: string;
        test_id: string;
        tests: {
          id: string;
          subject: string;
          school_id: string;
          date: string;
          chapter: string | null;
        } | null;
      }>
    ).filter(
      (a) =>
        a.tests?.school_id === schoolId &&
        a.tests?.subject?.toLowerCase() === subject.toLowerCase()
    );

    if (subjectAttempts.length > 0) {
      // For each attempt, fetch student_answers + correct_option from test_questions
      for (const attempt of subjectAttempts) {
        const topic = attempt.tests?.chapter?.trim() || subject;

        // Fetch answers the student gave for this attempt
        const { data: answers } = await supabaseAdmin
          .from('student_answers')
          .select('question_id, selected_option')
          .eq('attempt_id', attempt.id);

        if (!answers || answers.length === 0) continue;

        // Fetch the correct options for those questions
        const qIds = (answers as Array<{ question_id: string; selected_option: string | null }>)
          .map((a) => a.question_id);

        const { data: questions } = await supabaseAdmin
          .from('test_questions')
          .select('id, correct_option, question_type')
          .in('id', qIds);

        if (!questions) continue;

        const correctMap = new Map<string, string | null>(
          (questions as Array<{ id: string; correct_option: string | null; question_type: string }>)
            .filter((q) => q.question_type === 'mcq')
            .map((q) => [q.id, q.correct_option])
        );

        for (const ans of answers as Array<{ question_id: string; selected_option: string | null }>) {
          const correctOption = correctMap.get(ans.question_id);
          if (correctOption === undefined) continue; // theory question — skip

          const current = topicCorrectMap.get(topic) ?? { correct: 0, total: 0 };
          current.total += 1;
          if (ans.selected_option === correctOption) {
            current.correct += 1;
          }
          topicCorrectMap.set(topic, current);
        }
      }
    }
  }

  // ── SOURCE 2 — Homework ────────────────────────────────────────────────────
  // homework_submissions joined with homework where subject matches (via subjects table).
  // Use subjects join — homework has subject_id FK → subjects(name).
  // Count ai_result = 'incorrect' or 'partial' as weak signals.

  const homeworkTopicMap = new Map<string, { weak: number; total: number }>();

  {
    const { data: submissions } = await supabaseAdmin
      .from('homework_submissions')
      .select(`
        id,
        ai_result,
        submitted_at,
        homework:homework_id (
          id,
          school_id,
          title,
          subjects ( name )
        )
      `)
      .eq('student_id', studentId)
      .not('ai_result', 'is', null)
      .gte('submitted_at', ninetyDaysAgo);

    type SubRow = {
      id: string;
      ai_result: string | null;
      homework: {
        id: string;
        school_id: string;
        title: string;
        subjects: { name: string } | null;
      } | null;
    };

    const filtered = ((submissions ?? []) as unknown as SubRow[]).filter(
      (s) =>
        s.homework?.school_id === schoolId &&
        s.homework?.subjects?.name?.toLowerCase() === subject.toLowerCase()
    );

    for (const sub of filtered) {
      // Use homework title as topic proxy (best available without a topic field on homework)
      const topic = sub.homework?.title?.trim() || subject;
      const current = homeworkTopicMap.get(topic) ?? { weak: 0, total: 0 };
      current.total += 1;
      if (sub.ai_result === 'incorrect' || sub.ai_result === 'partial') {
        current.weak += 1;
      }
      homeworkTopicMap.set(topic, current);
    }
  }

  // ── SOURCE 3 — School Exam Marks ──────────────────────────────────────────
  // marks table: subject text column, direct match.
  // Calculate average % — if < 60%, whole subject flagged.

  let marksAvgPct: number | null = null;
  let marksBelowThreshold = false;

  {
    const { data: marksData } = await supabaseAdmin
      .from('marks')
      .select('score, max_score')
      .eq('student_id', studentId)
      .ilike('subject', subject.trim());

    // Also filter by school via student — the marks table doesn't have school_id directly
    // but we can trust studentId is scoped to the schoolId context from the caller.

    if (marksData && marksData.length > 0) {
      const rows = marksData as Array<{ score: number; max_score: number }>;
      const pcts = rows.map((r) => (r.score / (r.max_score || 100)) * 100);
      marksAvgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      marksBelowThreshold = marksAvgPct < 60;
    }
  }

  // ── SOURCE 4 — Previous Monthly Recovery Attempts ─────────────────────────
  // monthly_recovery_attempts where completed in past months.
  // topic_scores jsonb: { "topic_name": { "correct": 0, "total": 0, "percentage": 0 } }

  const prevRecoveryTopicMap = new Map<string, number[]>(); // topic → [percentage values]

  {
    const currentMonthDate = new Date(scheduledMonth);
    const currentMonthStr = currentMonthDate.toISOString().slice(0, 10);

    const { data: prevAttempts } = await supabaseAdmin
      .from('monthly_recovery_attempts')
      .select('topic_scores, subject, scheduled_month')
      .eq('student_id', studentId)
      .eq('status', 'completed')
      .lt('scheduled_month', currentMonthStr);

    for (const attempt of (prevAttempts ?? []) as Array<{
      topic_scores: Record<string, { percentage: number }> | null;
      subject: string;
      scheduled_month: string;
    }>) {
      if (attempt.subject.toLowerCase() !== subject.toLowerCase()) continue;
      if (!attempt.topic_scores) continue;

      for (const [topicName, scores] of Object.entries(attempt.topic_scores)) {
        if (typeof scores?.percentage === 'number') {
          const current = prevRecoveryTopicMap.get(topicName) ?? [];
          current.push(scores.percentage);
          prevRecoveryTopicMap.set(topicName, current);
        }
      }
    }
  }

  // ── COMBINE SOURCES ────────────────────────────────────────────────────────
  // Merge all topic signals into a unified weakness_score map.

  const allTopics = new Set<string>([
    ...topicCorrectMap.keys(),
    ...homeworkTopicMap.keys(),
    ...prevRecoveryTopicMap.keys(),
  ]);

  // If subject-level marks are below threshold, ensure subject itself is included
  if (marksBelowThreshold) {
    allTopics.add(subject);
  }

  const topicScores: WeakTopic[] = [];

  for (const topic of allTopics) {
    // Source 1: test correct % (higher = better performed = less weak)
    const testData = topicCorrectMap.get(topic);
    const testPct = testData && testData.total > 0
      ? (testData.correct / testData.total) * 100
      : null;

    // Source 2: homework weakness rate (higher weak rate = more weak)
    // Convert to "performance %" (inverted): 100 - (weak/total * 100)
    const hwData = homeworkTopicMap.get(topic);
    const hwPerformancePct = hwData && hwData.total > 0
      ? 100 - (hwData.weak / hwData.total) * 100
      : null;

    // Source 3: marks (subject-level applies to all topics from this subject)
    const marksPct = marksAvgPct;

    // Source 4: previous recovery % (how well they did in this topic before)
    const prevData = prevRecoveryTopicMap.get(topic);
    const prevAvgPct = prevData && prevData.length > 0
      ? prevData.reduce((a, b) => a + b, 0) / prevData.length
      : null;

    // Weighted combined performance (higher = better)
    const combinedPerformancePct = weightedScore(
      { pct: testPct,          weight: 40 },
      { pct: hwPerformancePct, weight: 20 },
      { pct: marksPct,         weight: 25 },
      { pct: prevAvgPct,       weight: 15 }
    );

    // weakness_score = 100 - performance (lower score = weaker = needs recovery)
    const weaknessScore = combinedPerformancePct !== null
      ? clamp(Math.round(100 - combinedPerformancePct))
      : 50; // neutral if no data

    topicScores.push({
      topic,
      weakness_score: weaknessScore,
      source_breakdown: {
        tests: testPct !== null ? Math.round(testPct) : null,
        homework: hwPerformancePct !== null ? Math.round(hwPerformancePct) : null,
        marks: marksPct !== null ? Math.round(marksPct) : null,
        previous_recovery: prevAvgPct !== null ? Math.round(prevAvgPct) : null,
      },
    });
  }

  // Sort ascending by weakness_score (weakest first)
  topicScores.sort((a, b) => a.weakness_score - b.weakness_score);

  // Cap to top 6 weak topics
  let weakTopics = topicScores.slice(0, 6);

  // Guarantee minimum 2 topics — if we have fewer, add subject-level fallbacks
  if (weakTopics.length < 2) {
    const subjectFallback: WeakTopic = {
      topic: subject,
      weakness_score: marksBelowThreshold ? Math.round(100 - (marksAvgPct ?? 50)) : 50,
      source_breakdown: {
        tests: null,
        homework: null,
        marks: marksAvgPct !== null ? Math.round(marksAvgPct) : null,
        previous_recovery: null,
      },
    };

    if (!weakTopics.find((t) => t.topic === subject)) {
      weakTopics = [subjectFallback, ...weakTopics];
    }

    // If still only 1, add a generic "Fundamentals" fallback
    if (weakTopics.length < 2) {
      weakTopics.push({
        topic: `${subject} — Core Concepts`,
        weakness_score: 50,
        source_breakdown: { tests: null, homework: null, marks: null, previous_recovery: null },
      });
    }
  }

  return {
    student_id: studentId,
    subject,
    scheduled_month: scheduledMonth,
    weak_topics: weakTopics,
    subject_marks_pct: marksAvgPct !== null ? Math.round(marksAvgPct) : null,
    profile_type: determineProfileType(
      marksAvgPct,
      topicCorrectMap.size,
      homeworkTopicMap.size,
      prevRecoveryTopicMap.size
    ),
    has_no_data:
      topicCorrectMap.size === 0 &&
      homeworkTopicMap.size === 0 &&
      marksAvgPct === null &&
      prevRecoveryTopicMap.size === 0,
  };
}

// ── Profile type determination ────────────────────────────────────────────────

/**
 * Determines the profile type for recovery pack generation.
 *
 * Rules (evaluated in order):
 *   1. enrichment — subject_marks_pct >= 85 (strong performer)
 *   2. no_data    — zero data points across all sources
 *   3. weak       — default (has identifiable weak topics)
 */
function determineProfileType(
  marksAvgPct: number | null,
  testTopicCount: number,
  hwTopicCount: number,
  prevRecoveryTopicCount: number
): StudentProfileType {
  const hasNoData =
    testTopicCount === 0 &&
    hwTopicCount === 0 &&
    marksAvgPct === null &&
    prevRecoveryTopicCount === 0;

  if (hasNoData) return 'no_data';

  // Enrichment: marks >= 85% and enough data to make that determination
  if (marksAvgPct !== null && marksAvgPct >= 85) return 'enrichment';

  return 'weak';
}
