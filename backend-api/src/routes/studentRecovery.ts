/**
 * /api/student-recovery — Student-facing recovery pack and test endpoints
 *
 * GET  /api/student-recovery/packs
 *   List all recovery_packs for this student where generation_status = 'completed'
 *   sorted by created_at desc.
 *
 * GET  /api/student-recovery/packs/:id
 *   Full pack_content for one pack. Also checks if a monthly_recovery_test
 *   exists with is_available = true for the same subject + month.
 *
 * GET  /api/student-recovery/tests
 *   Available monthly_recovery_tests that have NOT been completed.
 *   Also returns completed tests with their scores.
 *
 * GET  /api/student-recovery/tests/:id
 *   Full test row (including questions) for the test-taking screen.
 *
 * POST /api/student-recovery/tests/:id/submit
 *   Submits a monthly recovery test attempt.
 *   Calculates score, topic_scores, improvement vs previous month.
 *   Inserts a monthly_recovery_attempts row.
 *
 * POST /api/student-recovery/tests/:id/integrity
 *   Lightweight integrity log for monthly recovery tests.
 *   Reuses the same calculateIntegrityScore() logic as daily tests.
 *   Stores the result in test_integrity_logs.test_attempt_id
 *   (column was renamed from daily_test_attempt_id via fix-integrity-logs-fk.sql).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

// All routes require student authentication
router.use(authenticateStudent);
router.use(requireRole('student'));

// ── Shared: calculateIntegrityScore (identical to tests.ts) ──────────────────

interface IntegrityData {
  exit_count: number;
  return_count: number;
  total_exit_duration_seconds: number;
  longest_single_exit_seconds: number;
}

interface IntegrityConfig {
  base_score: number;
  exit_deduction_per_exit: number;
  long_exit_threshold_seconds: number;
  long_exit_extra_deduction: number;
  suspicious_exit_count_threshold: number;
  suspicious_duration_threshold_seconds: number;
  suspicious_rapid_exit_count: number;
  minimum_score: number;
}

function calculateIntegrityScore(
  data: IntegrityData,
  config: IntegrityConfig
): { integrity_score: number; is_suspicious: boolean; suspicious_reasons: string[] } {
  let score = config.base_score;

  for (let i = 0; i < data.exit_count; i++) {
    score -= config.exit_deduction_per_exit;
  }

  if (data.longest_single_exit_seconds > config.long_exit_threshold_seconds) {
    score -= config.long_exit_extra_deduction;
  }

  if (data.total_exit_duration_seconds > config.suspicious_duration_threshold_seconds) {
    score -= 15;
  }

  score = Math.max(score, config.minimum_score);
  score = Math.round(score);

  let is_suspicious = false;
  const suspicious_reasons: string[] = [];

  if (data.exit_count >= config.suspicious_exit_count_threshold) {
    is_suspicious = true;
    suspicious_reasons.push(`High number of exits (${data.exit_count} times)`);
  }
  if (data.total_exit_duration_seconds >= config.suspicious_duration_threshold_seconds) {
    is_suspicious = true;
    suspicious_reasons.push(`Extended time outside test (${data.total_exit_duration_seconds} seconds)`);
  }
  if (
    data.exit_count >= config.suspicious_rapid_exit_count &&
    data.exit_count > 0 &&
    data.total_exit_duration_seconds / data.exit_count < 30
  ) {
    is_suspicious = true;
    suspicious_reasons.push('Rapid repeated exits detected');
  }

  return { integrity_score: score, is_suspicious, suspicious_reasons };
}

// ── GET /api/student-recovery/packs ──────────────────────────────────────────
/**
 * Returns all completed recovery packs for this student, newest first.
 * Groups by cycle_id so multi-subject cycles appear as one logical entry.
 * Returns the subjects array per cycle for the badge display.
 */
router.get('/packs', async (req: Request, res: Response) => {
  const studentId = req.student!.id;

  const { data, error } = await supabaseAdmin
    .from('recovery_packs')
    .select('id, subject, scheduled_month, weak_topics, created_at, cycle_id, student_profile_type')
    .eq('student_id', studentId)
    .eq('generation_status', 'completed')
    .order('created_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Group by cycle_id so the student sees one card per cycle
  type PackRow = {
    id: string; subject: string; scheduled_month: string;
    weak_topics: string[] | null; created_at: string;
    cycle_id: string | null; student_profile_type: string | null;
  };

  const rows = (data ?? []) as PackRow[];

  // Build grouped map: cycle_id → { subjects[], representative row }
  const cycleMap = new Map<string, { subjects: string[]; pack: PackRow }>();
  const noCycleList: PackRow[] = [];

  for (const row of rows) {
    if (!row.cycle_id) {
      noCycleList.push(row);
      continue;
    }
    if (!cycleMap.has(row.cycle_id)) {
      cycleMap.set(row.cycle_id, { subjects: [], pack: row });
    }
    cycleMap.get(row.cycle_id)!.subjects.push(row.subject);
  }

  // For cycle-based packs return one card per cycle with subject count
  const cycleCards = Array.from(cycleMap.values()).map(({ subjects, pack }) => ({
    id: pack.cycle_id!,
    type: 'cycle' as const,
    subjects,
    subject_count: subjects.length,
    scheduled_month: pack.scheduled_month,
    created_at: pack.created_at,
  }));

  // Legacy (no cycle_id) packs returned individually
  const legacyCards = noCycleList.map((p) => ({
    id: p.id,
    type: 'legacy' as const,
    subject: p.subject,
    subjects: [p.subject],
    subject_count: 1,
    scheduled_month: p.scheduled_month,
    weak_topics: p.weak_topics,
    created_at: p.created_at,
  }));

  sendSuccess(res, [...cycleCards, ...legacyCards]);
});

// ── GET /api/student-recovery/packs/by-cycle/:cycleId ────────────────────────
/**
 * Returns all completed recovery packs for a cycle, for the detail view.
 * Each element has the full pack_content for rendering in subject tabs.
 */
router.get('/packs/by-cycle/:cycleId', async (req: Request, res: Response) => {
  const studentId = req.student!.id;
  const cycleId   = req.params.cycleId;

  const { data, error } = await supabaseAdmin
    .from('recovery_packs')
    .select('id, subject, scheduled_month, weak_topics, pack_content, student_profile_type, created_at')
    .eq('student_id', studentId)
    .eq('cycle_id', cycleId)
    .eq('generation_status', 'completed')
    .order('subject', { ascending: true });

  if (error) { sendError(res, error.message, 500); return; }
  if (!data || (data as unknown[]).length === 0) {
    sendError(res, 'No packs found for this cycle', 404);
    return;
  }

  sendSuccess(res, data);
});

// ── GET /api/student-recovery/packs/:id ──────────────────────────────────────
/**
 * Returns full pack_content for one pack + whether a recovery test is available.
 */
router.get('/packs/:id', async (req: Request, res: Response) => {
  const studentId = req.student!.id;
  const packId    = req.params.id;

  const { data: pack, error: packErr } = await supabaseAdmin
    .from('recovery_packs')
    .select('id, subject, scheduled_month, weak_topics, pack_content, created_at')
    .eq('id', packId)
    .eq('student_id', studentId)
    .eq('generation_status', 'completed')
    .maybeSingle();

  if (packErr) {
    sendError(res, packErr.message, 500);
    return;
  }

  if (!pack) {
    sendError(res, 'Recovery pack not found', 404);
    return;
  }

  const p = pack as {
    id: string;
    subject: string;
    scheduled_month: string;
    weak_topics: string[] | null;
    pack_content: unknown;
    created_at: string;
  };

  // Check if a monthly_recovery_test is available for same subject + month
  const { data: testRow } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('id, total_questions, cycle_id')
    .eq('student_id', studentId)
    .eq('subject', p.subject)
    .eq('scheduled_month', p.scheduled_month)
    .eq('is_available', true)
    .maybeSingle();

  // Also check if this test has already been completed
  let testAvailable = false;
  let testId: string | null = null;
  let testTotalQuestions: number | null = null;

  if (testRow) {
    const tr = testRow as { id: string; total_questions: number | null; cycle_id: string | null };
    testId = tr.id;
    testTotalQuestions = tr.total_questions;

    // Cycle-based tests use recovery_test_attempts; legacy tests use monthly_recovery_attempts
    const isCycleBased = Boolean(tr.cycle_id);

    let completed = false;
    if (isCycleBased) {
      const { data: rta } = await supabaseAdmin
        .from('recovery_test_attempts')
        .select('id')
        .eq('recovery_test_id', tr.id)
        .eq('student_id', studentId)
        .eq('status', 'submitted')
        .maybeSingle();
      completed = Boolean(rta);
    } else {
      const { data: attemptRow } = await supabaseAdmin
        .from('monthly_recovery_attempts')
        .select('id, status')
        .eq('monthly_recovery_test_id', tr.id)
        .eq('student_id', studentId)
        .eq('status', 'completed')
        .maybeSingle();
      completed = Boolean(attemptRow);
    }

    testAvailable = !completed;
  }

  sendSuccess(res, {
    ...p,
    test_available: testAvailable,
    test_id: testId,
    test_total_questions: testTotalQuestions,
  });
});

// ── GET /api/student-recovery/tests/by-cycle/:cycleId ────────────────────────
/**
 * Returns available recovery tests for a cycle (one per subject).
 */
router.get('/tests/by-cycle/:cycleId', async (req: Request, res: Response) => {
  const studentId = req.student!.id;
  const cycleId   = req.params.cycleId;

  const { data, error } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('id, subject, total_questions, time_limit_minutes, available_from, available_until, is_available, generation_status, cycle_id')
    .eq('student_id', studentId)
    .eq('cycle_id', cycleId)
    .eq('generation_status', 'completed');

  if (error) { sendError(res, error.message, 500); return; }

  const tests = (data ?? []) as Array<{
    id: string; subject: string; total_questions: number | null;
    time_limit_minutes: number | null; available_from: string | null;
    available_until: string | null; is_available: boolean;
    generation_status: string; cycle_id: string | null;
  }>;

  // Fetch attempt statuses
  const testIds = tests.map((t) => t.id);
  const { data: attempts } = await supabaseAdmin
    .from('recovery_test_attempts')
    .select('recovery_test_id, status, percentage')
    .eq('student_id', studentId)
    .in('recovery_test_id', testIds);

  const attemptMap = new Map<string, { status: string; percentage: number | null }>(
    ((attempts ?? []) as Array<{ recovery_test_id: string; status: string; percentage: number | null }>)
      .map((a) => [a.recovery_test_id, a])
  );

  const result = tests.map((t) => {
    const att = attemptMap.get(t.id);
    return {
      id: t.id,
      subject: t.subject,
      total_questions: t.total_questions,
      time_limit_minutes: t.time_limit_minutes,
      available_from: t.available_from,
      available_until: t.available_until,
      is_available: t.is_available,
      attempt_status: att?.status ?? 'not_started',
      percentage: att?.percentage ?? null,
    };
  });

  sendSuccess(res, result);
});

// ── GET /api/student-recovery/tests ──────────────────────────────────────────
/**
 * Returns available tests (not yet completed) + already completed tests.
 */
router.get('/tests', async (req: Request, res: Response) => {
  const studentId = req.student!.id;

  // Fetch all available tests for this student
  const { data: tests, error: testsErr } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('id, subject, scheduled_month, total_questions, is_available')
    .eq('student_id', studentId)
    .eq('is_available', true)
    .order('scheduled_month', { ascending: false });

  if (testsErr) {
    sendError(res, testsErr.message, 500);
    return;
  }

  if (!tests || tests.length === 0) {
    sendSuccess(res, { available: [], completed: [] });
    return;
  }

  type TestRow = { id: string; subject: string; scheduled_month: string; total_questions: number | null; is_available: boolean };
  const testIds = (tests as TestRow[]).map((t) => t.id);

  // Fetch all attempts for these tests
  const { data: attempts } = await supabaseAdmin
    .from('monthly_recovery_attempts')
    .select('id, monthly_recovery_test_id, status, score, score_percentage, total_questions, topic_scores, improvement_percentage, completed_at')
    .eq('student_id', studentId)
    .in('monthly_recovery_test_id', testIds);

  type AttemptRow = {
    id: string;
    monthly_recovery_test_id: string;
    status: string;
    score: number | null;
    score_percentage: number | null;
    total_questions: number | null;
    topic_scores: unknown;
    improvement_percentage: number | null;
    completed_at: string | null;
  };

  const attemptMap = new Map<string, AttemptRow>();
  for (const a of ((attempts ?? []) as AttemptRow[])) {
    attemptMap.set(a.monthly_recovery_test_id, a);
  }

  const available: unknown[] = [];
  const completed: unknown[] = [];

  for (const t of tests as TestRow[]) {
    const attempt = attemptMap.get(t.id);

    if (attempt && attempt.status === 'completed') {
      completed.push({
        id: t.id,
        subject: t.subject,
        scheduled_month: t.scheduled_month,
        total_questions: t.total_questions,
        attempt_id: attempt.id,
        score: attempt.score,
        score_percentage: attempt.score_percentage,
        improvement_percentage: attempt.improvement_percentage,
        completed_at: attempt.completed_at,
      });
    } else {
      available.push({
        id: t.id,
        subject: t.subject,
        scheduled_month: t.scheduled_month,
        total_questions: t.total_questions,
        attempt_status: attempt?.status ?? 'not_started',
      });
    }
  }

  sendSuccess(res, { available, completed });
});

// ── GET /api/student-recovery/tests/:id ──────────────────────────────────────
/**
 * Returns the full test row including questions for the test-taking screen.
 * Questions do NOT include correct_index (security: never expose to client).
 * The client will receive correct_index only after submission.
 */
router.get('/tests/:id', async (req: Request, res: Response) => {
  const studentId = req.student!.id;
  const testId    = req.params.id;

  const { data: test, error: testErr } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('id, subject, scheduled_month, total_questions, questions, is_available, generation_status')
    .eq('id', testId)
    .eq('student_id', studentId)
    .eq('is_available', true)
    .maybeSingle();

  if (testErr) {
    sendError(res, testErr.message, 500);
    return;
  }

  if (!test) {
    sendError(res, 'Test not found or not available', 404);
    return;
  }

  const t = test as {
    id: string;
    subject: string;
    scheduled_month: string;
    total_questions: number | null;
    questions: Array<{
      question: string;
      options: string[];
      correct_index: number;
      explanation: string;
      difficulty: string;
      topic: string;
    }> | null;
    is_available: boolean;
    generation_status: string;
  };

  // Check for an existing completed attempt (block re-taking)
  const { data: completedAttempt } = await supabaseAdmin
    .from('monthly_recovery_attempts')
    .select('id, status, score, score_percentage, topic_scores, improvement_percentage')
    .eq('monthly_recovery_test_id', testId)
    .eq('student_id', studentId)
    .eq('status', 'completed')
    .maybeSingle();

  if (completedAttempt) {
    sendError(res, 'You have already completed this test', 409);
    return;
  }

  // Strip correct_index from questions before sending to client
  const safeQuestions = (t.questions ?? []).map(({ correct_index: _ci, ...q }) => q);

  sendSuccess(res, {
    id: t.id,
    subject: t.subject,
    scheduled_month: t.scheduled_month,
    total_questions: t.total_questions ?? safeQuestions.length,
    questions: safeQuestions,
  });
});

// ── POST /api/student-recovery/tests/:id/submit ───────────────────────────────
/**
 * Submit a monthly recovery test attempt.
 * Body: { answers: number[] }  — array of selected option indexes (0-3)
 */
const submitSchema = z.object({
  answers: z.array(z.number().int().min(0).max(3)),
});

router.post('/tests/:id/submit', async (req: Request, res: Response) => {
  const studentId = req.student!.id;
  const schoolId  = req.student!.school_id;
  const testId    = req.params.id;

  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { answers } = parsed.data;

  // Fetch the full test row (with correct answers)
  const { data: test, error: testErr } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('id, subject, scheduled_month, questions, total_questions')
    .eq('id', testId)
    .eq('student_id', studentId)
    .eq('is_available', true)
    .maybeSingle();

  if (testErr || !test) {
    sendError(res, 'Test not found or not available', 404);
    return;
  }

  // Prevent re-submission
  const { data: existing } = await supabaseAdmin
    .from('monthly_recovery_attempts')
    .select('id, status')
    .eq('monthly_recovery_test_id', testId)
    .eq('student_id', studentId)
    .eq('status', 'completed')
    .maybeSingle();

  if (existing) {
    sendError(res, 'You have already submitted this test', 409);
    return;
  }

  const t = test as {
    id: string;
    subject: string;
    scheduled_month: string;
    total_questions: number | null;
    questions: Array<{
      question: string;
      options: string[];
      correct_index: number;
      explanation: string;
      difficulty: string;
      topic: string;
    }> | null;
  };

  const questions = t.questions ?? [];

  // ── Calculate score ─────────────────────────────────────────────────────────
  let score = 0;
  const topicMap: Record<string, { correct: number; total: number }> = {};

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const isCorrect = answers[i] === q.correct_index;
    if (isCorrect) score++;

    const topic = q.topic ?? 'General';
    if (!topicMap[topic]) topicMap[topic] = { correct: 0, total: 0 };
    topicMap[topic].total++;
    if (isCorrect) topicMap[topic].correct++;
  }

  const totalQuestions = questions.length;
  const scorePercentage = totalQuestions > 0 ? Math.round((score / totalQuestions) * 100) : 0;

  // Build topic_scores: { "topic": { correct, total, percentage } }
  const topicScores: Record<string, { correct: number; total: number; percentage: number }> = {};
  for (const [topic, counts] of Object.entries(topicMap)) {
    topicScores[topic] = {
      correct: counts.correct,
      total: counts.total,
      percentage: counts.total > 0 ? Math.round((counts.correct / counts.total) * 100) : 0,
    };
  }

  // ── Previous month score ────────────────────────────────────────────────────
  // Find the most recent completed attempt for same student+subject in a prior month
  const { data: prevAttempt } = await supabaseAdmin
    .from('monthly_recovery_attempts')
    .select('score_percentage, scheduled_month')
    .eq('student_id', studentId)
    .eq('subject', t.subject)
    .eq('status', 'completed')
    .lt('scheduled_month', t.scheduled_month)
    .order('scheduled_month', { ascending: false })
    .limit(1)
    .maybeSingle();

  const previousMonthScorePercentage: number | null =
    (prevAttempt as { score_percentage: number | null } | null)?.score_percentage ?? null;

  const improvementPercentage: number | null =
    previousMonthScorePercentage !== null
      ? scorePercentage - previousMonthScorePercentage
      : null;

  // ── Insert attempt ──────────────────────────────────────────────────────────
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('monthly_recovery_attempts')
    .insert({
      monthly_recovery_test_id: testId,
      student_id: studentId,
      school_id: schoolId,
      subject: t.subject,
      scheduled_month: t.scheduled_month,
      answers: answers,
      score,
      total_questions: totalQuestions,
      score_percentage: scorePercentage,
      topic_scores: topicScores,
      previous_month_score_percentage: previousMonthScorePercentage,
      improvement_percentage: improvementPercentage,
      completed_at: new Date().toISOString(),
      status: 'completed',
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    sendError(res, insertErr?.message ?? 'Failed to save attempt', 500);
    return;
  }

  const attemptId = (inserted as { id: string }).id;

  // Return results including correct_index for results screen display
  const questionsWithAnswers = questions.map((q, i) => ({
    question: q.question,
    options: q.options,
    correct_index: q.correct_index,
    explanation: q.explanation,
    topic: q.topic,
    difficulty: q.difficulty,
    selected_index: answers[i] ?? null,
    is_correct: answers[i] === q.correct_index,
  }));

  sendSuccess(res, {
    attempt_id: attemptId,
    score,
    total_questions: totalQuestions,
    score_percentage: scorePercentage,
    topic_scores: topicScores,
    previous_month_score_percentage: previousMonthScorePercentage,
    improvement_percentage: improvementPercentage,
    questions: questionsWithAnswers,
  });
});

// ── POST /api/student-recovery/tests/:id/integrity ───────────────────────────
/**
 * Logs integrity data for a monthly recovery test attempt.
 * Reuses the same calculateIntegrityScore() logic as daily tests.
 * Stores the row in test_integrity_logs.test_attempt_id = monthly_recovery_attempt_id.
 * (Column was renamed from daily_test_attempt_id by fix-integrity-logs-fk.sql)
 */
const integritySchema = z.object({
  monthly_recovery_attempt_id: z.string().uuid(),
  exit_count:                  z.number().int().min(0),
  return_count:                z.number().int().min(0),
  total_exit_duration_seconds: z.number().int().min(0),
  longest_single_exit_seconds: z.number().int().min(0),
});

router.post('/tests/:id/integrity', async (req: Request, res: Response) => {
  const studentId = req.student!.id;
  const schoolId  = req.student!.school_id;

  const parsed = integritySchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const {
    monthly_recovery_attempt_id,
    exit_count,
    return_count,
    total_exit_duration_seconds,
    longest_single_exit_seconds,
  } = parsed.data;

  // Verify the attempt belongs to this student and is completed
  const { data: attempt, error: attemptErr } = await supabaseAdmin
    .from('monthly_recovery_attempts')
    .select('id, student_id, status')
    .eq('id', monthly_recovery_attempt_id)
    .eq('student_id', studentId)
    .maybeSingle();

  if (attemptErr || !attempt) {
    sendError(res, 'Attempt not found or does not belong to you', 404);
    return;
  }

  if ((attempt as { status: string }).status !== 'completed') {
    sendError(res, 'Cannot log integrity for an incomplete attempt', 400);
    return;
  }

  // Load integrity config
  const { data: configRows, error: configErr } = await supabaseAdmin
    .from('integrity_score_config')
    .select('config_key, config_value');

  if (configErr || !configRows) {
    sendError(res, 'Failed to load integrity config', 500);
    return;
  }

  const rawConfig = (
    configRows as Array<{ config_key: string; config_value: number }>
  ).reduce<Record<string, number>>(
    (acc, row) => { acc[row.config_key] = Number(row.config_value); return acc; },
    {}
  );

  const config: IntegrityConfig = {
    base_score:                           rawConfig['base_score']                            ?? 100,
    exit_deduction_per_exit:               rawConfig['exit_deduction_per_exit']                ?? 5,
    long_exit_threshold_seconds:           rawConfig['long_exit_threshold_seconds']            ?? 120,
    long_exit_extra_deduction:             rawConfig['long_exit_extra_deduction']              ?? 10,
    suspicious_exit_count_threshold:       rawConfig['suspicious_exit_count_threshold']        ?? 5,
    suspicious_duration_threshold_seconds: rawConfig['suspicious_duration_threshold_seconds']  ?? 300,
    suspicious_rapid_exit_count:           rawConfig['suspicious_rapid_exit_count']            ?? 3,
    minimum_score:                         rawConfig['minimum_score']                         ?? 0,
  };

  const { integrity_score, is_suspicious, suspicious_reasons } = calculateIntegrityScore(
    { exit_count, return_count, total_exit_duration_seconds, longest_single_exit_seconds },
    config
  );

  // Upsert into test_integrity_logs (idempotent)
  const { data: existing } = await supabaseAdmin
    .from('test_integrity_logs')
    .select('id')
    .eq('test_attempt_id', monthly_recovery_attempt_id)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('test_integrity_logs')
      .update({
        exit_count,
        return_count,
        total_exit_duration_seconds,
        longest_single_exit_seconds,
        integrity_score,
        is_suspicious,
        suspicious_reasons,
        updated_at: new Date().toISOString(),
      })
      .eq('id', (existing as { id: string }).id);
  } else {
    const { error: insertErr } = await supabaseAdmin
      .from('test_integrity_logs')
      .insert({
        test_attempt_id: monthly_recovery_attempt_id,
        student_id: studentId,
        school_id: schoolId,
        exit_count,
        return_count,
        total_exit_duration_seconds,
        longest_single_exit_seconds,
        integrity_score,
        is_suspicious,
        suspicious_reasons,
      });

    if (insertErr) {
      console.error('[recovery-integrity] insert error:', insertErr);
      sendError(res, 'Failed to save integrity data', 500);
      return;
    }
  }

  // NOTE: is_suspicious and suspicious_reasons are teacher-only fields.
  // Never return them to the student-facing endpoint.
  sendSuccess(res, {
    integrity_score,
    exit_count,
    total_exit_duration_seconds,
  });
});

export default router;
