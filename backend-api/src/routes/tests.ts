import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();
router.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────

const questionSchema = z.object({
  question_text: z.string().min(1),
  question_type: z.enum(['mcq', 'theory']),
  option_a: z.string().optional(),
  option_b: z.string().optional(),
  option_c: z.string().optional(),
  option_d: z.string().optional(),
  correct_option: z.enum(['a', 'b', 'c', 'd']).optional(),
  marks: z.number().min(1),
});

const createTestSchema = z.object({
  title: z.string().min(1),
  subject_id: z.string().uuid(),
  class: z.string().min(1),
  section: z.string().min(1),
  term: z.string().min(1),
  date: z.string().date(),
  time_limit_minutes: z.number().int().min(1),
  shuffle_questions: z.boolean().default(false),
  shuffle_options: z.boolean().default(false),
  questions: z.array(questionSchema).min(1),
});

const submitAttemptSchema = z.object({
  attempt_id: z.string().uuid(),
  answers: z.array(z.object({
    question_id: z.string().uuid(),
    selected_option: z.enum(['a', 'b', 'c', 'd']).optional(),
    theory_answer: z.string().optional(),
  })).min(1),
});

const theoryMarkSchema = z.object({
  attempt_id: z.string().uuid(),
  theory_marks: z.array(z.object({
    question_id: z.string().uuid(),
    marks_awarded: z.number().min(0),
  })).min(1),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function logAudit(
  userId: string,
  action: string,
  details: Record<string, unknown> = {}
) {
  await supabaseAdmin.from('audit_logs').insert({
    user_id: userId,
    action,
    details,
    created_at: new Date().toISOString(),
  });
}

/** Shuffle an array in-place using Fisher-Yates and return it. */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Verify that the requesting teacher is assigned to the given class/section
 * within their school. Returns true if allowed.
 */
async function teacherOwnsClass(
  teacherId: string,
  schoolId: string,
  className: string,
  section: string
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('teacher_assignments')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .eq('class_name', className)
    .eq('section', section)
    .limit(1)
    .single();
  return !!data;
}

// ── POST /api/tests/create ────────────────────────────────────────────────────
/**
 * Teacher creates a test with questions.
 * Only a teacher assigned to that class/section can create.
 */
router.post('/create', requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const parsed = createTestSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { questions, ...testFields } = parsed.data;

  // Teachers must be assigned to the class they're creating a test for
  if (req.user!.role === 'teacher') {
    const allowed = await teacherOwnsClass(
      req.user!.id,
      req.user!.school_id ?? '',
      testFields.class,
      testFields.section
    );
    if (!allowed) {
      sendError(res, 'You are not assigned to this class/section', 403);
      return;
    }
  }

  // Insert test record
  const { data: test, error: testErr } = await supabaseAdmin
    .from('tests')
    .insert({
      title: testFields.title,
      subject_id: testFields.subject_id,
      class_name: testFields.class,
      section: testFields.section,
      term: testFields.term,
      date: testFields.date,
      time_limit_minutes: testFields.time_limit_minutes,
      shuffle_questions: testFields.shuffle_questions,
      shuffle_options: testFields.shuffle_options,
      school_id: req.user!.school_id,
      created_by: req.user!.id,
    })
    .select()
    .single();

  if (testErr || !test) { sendError(res, testErr?.message ?? 'Failed to create test', 500); return; }

  // Insert all questions
  const questionRows = questions.map((q, idx) => ({
    test_id: test.id,
    order_index: idx,
    question_text: q.question_text,
    question_type: q.question_type,
    option_a: q.option_a ?? null,
    option_b: q.option_b ?? null,
    option_c: q.option_c ?? null,
    option_d: q.option_d ?? null,
    correct_option: q.question_type === 'mcq' ? (q.correct_option ?? null) : null,
    marks: q.marks,
  }));

  const { error: qErr } = await supabaseAdmin.from('questions').insert(questionRows);

  if (qErr) {
    // Roll back the test header if questions fail
    await supabaseAdmin.from('tests').delete().eq('id', test.id);
    sendError(res, 'Failed to save questions', 500);
    return;
  }

  await logAudit(req.user!.id, 'TEST_CREATED', {
    test_id: test.id,
    title: test.title,
    class_name: testFields.class,
    section: testFields.section,
    question_count: questions.length,
  });

  sendSuccess(res, { test_id: test.id, success: true }, 'Test created', 201);
});

// ── GET /api/tests/my-tests ───────────────────────────────────────────────────
/**
 * Teacher sees all tests they created, with question count.
 * Filterable by class, section, term.
 */
router.get('/my-tests', requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const { class: className, section, term } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('tests')
    .select(`
      id, title, subject_id, class_name, section, term, date,
      time_limit_minutes, shuffle_questions, shuffle_options,
      created_at,
      questions(count)
    `)
    .order('created_at', { ascending: false });

  // Teachers only see their own tests; admins see all within school
  if (req.user!.role === 'teacher') {
    query = query.eq('created_by', req.user!.id);
  } else {
    query = query.eq('school_id', req.user!.school_id ?? '');
  }

  if (className) query = query.eq('class_name', className);
  if (section) query = query.eq('section', section);
  if (term) query = query.eq('term', term);

  const { data, error } = await query;
  if (error) { sendError(res, error.message, 500); return; }

  // Flatten question count from the nested aggregate
  const result = (data ?? []).map((t: Record<string, unknown>) => ({
    ...t,
    question_count: Array.isArray(t.questions)
      ? (t.questions as Array<{ count: number }>)[0]?.count ?? 0
      : 0,
    questions: undefined,
  }));

  sendSuccess(res, result);
});

// ── GET /api/tests/student ────────────────────────────────────────────────────
/**
 * Student gets available tests for their class/section.
 * Only if fee_paid = true. correct_option is NEVER included.
 */
router.get('/student', requireRole('student'), async (req: Request, res: Response) => {
  // Resolve the student record linked to this user
  const { data: studentRecord, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, class_name, section, school_id')
    .eq('user_id', req.user!.id)
    .single();

  if (sErr || !studentRecord) {
    sendError(res, 'Student record not found', 404);
    return;
  }

  // Gate on fee payment
  const { data: feeRecord } = await supabaseAdmin
    .from('student_fees')
    .select('fee_paid')
    .eq('student_id', studentRecord.id)
    .eq('fee_paid', true)
    .limit(1)
    .single();

  if (!feeRecord) {
    sendSuccess(res, [], 'Tests are only available to students with paid fees');
    return;
  }

  // Fetch tests — no correct_option, no shuffle config exposed
  const { data: tests, error: tErr } = await supabaseAdmin
    .from('tests')
    .select(`
      id, title, subject_id, date, time_limit_minutes,
      questions(count)
    `)
    .eq('school_id', studentRecord.school_id)
    .eq('class_name', studentRecord.class_name)
    .eq('section', studentRecord.section)
    .order('date', { ascending: false });

  if (tErr) { sendError(res, tErr.message, 500); return; }

  const result = (tests ?? []).map((t: Record<string, unknown>) => ({
    id: t.id,
    title: t.title,
    subject_id: t.subject_id,
    date: t.date,
    time_limit_minutes: t.time_limit_minutes,
    question_count: Array.isArray(t.questions)
      ? (t.questions as Array<{ count: number }>)[0]?.count ?? 0
      : 0,
  }));

  sendSuccess(res, result);
});

// ── POST /api/tests/attempt/start ────────────────────────────────────────────
/**
 * Student starts a test attempt.
 * Returns all questions WITHOUT correct_option.
 * Applies shuffle if configured.
 */
router.post('/attempt/start', requireRole('student'), async (req: Request, res: Response) => {
  const { test_id } = req.body as { test_id?: string };
  if (!test_id) { sendError(res, 'test_id is required', 400); return; }

  // Resolve student
  const { data: studentRecord, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, class_name, section, school_id')
    .eq('user_id', req.user!.id)
    .single();

  if (sErr || !studentRecord) { sendError(res, 'Student record not found', 404); return; }

  // Verify fee paid
  const { data: feeRecord } = await supabaseAdmin
    .from('student_fees')
    .select('fee_paid')
    .eq('student_id', studentRecord.id)
    .eq('fee_paid', true)
    .limit(1)
    .single();

  if (!feeRecord) { sendError(res, 'Fee not paid. Cannot start test.', 403); return; }

  // Fetch test config
  const { data: test, error: tErr } = await supabaseAdmin
    .from('tests')
    .select('id, class_name, section, school_id, time_limit_minutes, shuffle_questions, shuffle_options')
    .eq('id', test_id)
    .eq('school_id', studentRecord.school_id)
    .eq('class_name', studentRecord.class_name)
    .eq('section', studentRecord.section)
    .single();

  if (tErr || !test) { sendError(res, 'Test not found or not available for your class', 404); return; }

  // Prevent duplicate active attempts
  const { data: existingAttempt } = await supabaseAdmin
    .from('test_attempts')
    .select('id, is_submitted')
    .eq('test_id', test_id)
    .eq('student_id', studentRecord.id)
    .single();

  if (existingAttempt) {
    if (existingAttempt.is_submitted) {
      sendError(res, 'You have already submitted this test', 409);
    } else {
      sendError(res, 'You already have an active attempt for this test', 409);
    }
    return;
  }

  // Create attempt record
  const { data: attempt, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .insert({
      test_id,
      student_id: studentRecord.id,
      started_at: new Date().toISOString(),
      is_submitted: false,
    })
    .select()
    .single();

  if (aErr || !attempt) { sendError(res, 'Failed to start attempt', 500); return; }

  // Fetch questions — NEVER include correct_option
  const { data: rawQuestions, error: qErr } = await supabaseAdmin
    .from('questions')
    .select('id, order_index, question_text, question_type, option_a, option_b, option_c, option_d, marks')
    .eq('test_id', test_id)
    .order('order_index', { ascending: true });

  if (qErr || !rawQuestions) { sendError(res, 'Failed to load questions', 500); return; }

  type QuestionRow = {
    id: string;
    order_index: number;
    question_text: string;
    question_type: string;
    option_a: string | null;
    option_b: string | null;
    option_c: string | null;
    option_d: string | null;
    marks: number;
    options?: Record<string, string | null>;
  };

  let questions: QuestionRow[] = rawQuestions as QuestionRow[];

  // Shuffle questions if configured
  if (test.shuffle_questions) {
    questions = shuffle([...questions]);
  }

  // Shuffle options per question if configured
  if (test.shuffle_options) {
    questions = questions.map((q) => {
      if (q.question_type !== 'mcq') return q;
      const opts: Array<[string, string | null]> = [
        ['a', q.option_a], ['b', q.option_b],
        ['c', q.option_c], ['d', q.option_d],
      ];
      const shuffled = shuffle([...opts]);
      return {
        ...q,
        option_a: shuffled[0][1],
        option_b: shuffled[1][1],
        option_c: shuffled[2][1],
        option_d: shuffled[3][1],
      };
    });
  }

  sendSuccess(res, {
    attempt_id: attempt.id,
    time_limit_minutes: test.time_limit_minutes,
    started_at: attempt.started_at,
    questions,
  }, 'Test started');
});

// ── POST /api/tests/attempt/submit ───────────────────────────────────────────
/**
 * Student submits answers.
 * MCQ graded server-side by fetching correct_option from DB.
 * Theory answers stored for teacher marking later.
 * Auto-submits if time limit exceeded.
 */
router.post('/attempt/submit', requireRole('student'), async (req: Request, res: Response) => {
  const parsed = submitAttemptSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { attempt_id, answers } = parsed.data;

  // Resolve student
  const { data: studentRecord } = await supabaseAdmin
    .from('students')
    .select('id')
    .eq('user_id', req.user!.id)
    .single();

  if (!studentRecord) { sendError(res, 'Student record not found', 404); return; }

  // Fetch attempt — must belong to this student and not yet submitted
  const { data: attempt, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, test_id, started_at, is_submitted')
    .eq('id', attempt_id)
    .eq('student_id', studentRecord.id)
    .single();

  if (aErr || !attempt) { sendError(res, 'Attempt not found', 404); return; }
  if (attempt.is_submitted) { sendError(res, 'This attempt has already been submitted', 409); return; }

  // Fetch test for time limit check
  const { data: test } = await supabaseAdmin
    .from('tests')
    .select('time_limit_minutes')
    .eq('id', attempt.test_id)
    .single();

  // Check if time limit exceeded (auto-submit is still allowed, just flag it)
  const now = new Date();
  const startedAt = new Date(attempt.started_at);
  const elapsedMinutes = (now.getTime() - startedAt.getTime()) / 60000;
  const timeLimitExceeded = test ? elapsedMinutes > test.time_limit_minutes : false;

  // Fetch all questions for this test (with correct_option — server-side only)
  const { data: questions, error: qErr } = await supabaseAdmin
    .from('questions')
    .select('id, question_type, correct_option, marks')
    .eq('test_id', attempt.test_id);

  if (qErr || !questions) { sendError(res, 'Failed to load questions for grading', 500); return; }

  type QuestionRecord = { id: string; question_type: string; correct_option: string | null; marks: number };
  const questionMap = new Map<string, QuestionRecord>(
    (questions as QuestionRecord[]).map((q) => [q.id, q])
  );

  // Grade each answer
  let mcqScore = 0;
  let totalMcqMarks = 0;

  type AnswerInsertRow = {
    attempt_id: string;
    question_id: string;
    selected_option: string | null;
    theory_answer: string | null;
    is_correct: boolean | null;
    marks_awarded: number | null;
  };

  const answerRows: AnswerInsertRow[] = answers.reduce<AnswerInsertRow[]>((acc, ans) => {
    const question = questionMap.get(ans.question_id);
    if (!question) return acc;

    if (question.question_type === 'mcq') {
      totalMcqMarks += question.marks;
      const isCorrect = ans.selected_option === question.correct_option;
      const marksAwarded = isCorrect ? question.marks : 0;
      mcqScore += marksAwarded;
      acc.push({
        attempt_id,
        question_id: ans.question_id,
        selected_option: ans.selected_option ?? null,
        theory_answer: null,
        is_correct: isCorrect,
        marks_awarded: marksAwarded,
      });
    } else {
      // Theory — marks_awarded is null until teacher marks
      acc.push({
        attempt_id,
        question_id: ans.question_id,
        selected_option: null,
        theory_answer: ans.theory_answer ?? null,
        is_correct: null,
        marks_awarded: null,
      });
    }
    return acc;
  }, []);

  // Save answers
  const { error: insertErr } = await supabaseAdmin
    .from('student_answers')
    .insert(answerRows);

  if (insertErr) { sendError(res, 'Failed to save answers', 500); return; }

  // Update attempt as submitted
  const { error: updateErr } = await supabaseAdmin
    .from('test_attempts')
    .update({
      mcq_score: mcqScore,
      is_submitted: true,
      submitted_at: now.toISOString(),
      time_limit_exceeded: timeLimitExceeded,
    })
    .eq('id', attempt_id);

  if (updateErr) { sendError(res, 'Failed to finalise submission', 500); return; }

  await logAudit(req.user!.id, 'TEST_SUBMITTED', {
    attempt_id,
    test_id: attempt.test_id,
    mcq_score: mcqScore,
    time_limit_exceeded: timeLimitExceeded,
  });

  sendSuccess(res, { mcq_score: mcqScore, total_mcq_marks: totalMcqMarks }, 'Test submitted');
});

// ── POST /api/tests/theory/mark ───────────────────────────────────────────────
/**
 * Teacher marks theory answers for a submitted attempt.
 * Only the teacher assigned to that class can do this.
 * Recalculates total_score after marking.
 */
router.post('/theory/mark', requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const parsed = theoryMarkSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { attempt_id, theory_marks } = parsed.data;

  // Fetch attempt with test info
  const { data: attempt, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, test_id, is_submitted, mcq_score')
    .eq('id', attempt_id)
    .single();

  if (aErr || !attempt) { sendError(res, 'Attempt not found', 404); return; }
  if (!attempt.is_submitted) { sendError(res, 'Cannot mark an attempt that has not been submitted', 400); return; }

  // Fetch test to verify teacher assignment
  const { data: test, error: tErr } = await supabaseAdmin
    .from('tests')
    .select('class_name, section, school_id, created_by')
    .eq('id', attempt.test_id)
    .single();

  if (tErr || !test) { sendError(res, 'Test not found', 404); return; }

  // Teachers can only mark tests from their assigned classes
  if (req.user!.role === 'teacher') {
    const allowed = await teacherOwnsClass(
      req.user!.id,
      req.user!.school_id ?? '',
      test.class_name,
      test.section
    );
    if (!allowed) {
      sendError(res, 'You are not assigned to this class/section', 403);
      return;
    }
  }

  // Update each theory answer's marks_awarded
  for (const { question_id, marks_awarded } of theory_marks) {
    const { error: uErr } = await supabaseAdmin
      .from('student_answers')
      .update({ marks_awarded })
      .eq('attempt_id', attempt_id)
      .eq('question_id', question_id);

    if (uErr) { sendError(res, `Failed to update marks for question ${question_id}`, 500); return; }
  }

  // Recalculate total_score = mcq_score + sum of all theory marks_awarded
  const { data: allAnswers, error: allErr } = await supabaseAdmin
    .from('student_answers')
    .select('marks_awarded')
    .eq('attempt_id', attempt_id);

  if (allErr) { sendError(res, 'Failed to recalculate score', 500); return; }

  const totalScore = (allAnswers ?? []).reduce(
    (sum: number, row: { marks_awarded: number | null }) =>
      sum + (row.marks_awarded ?? 0),
    0
  );

  await supabaseAdmin
    .from('test_attempts')
    .update({ total_score: totalScore })
    .eq('id', attempt_id);

  await logAudit(req.user!.id, 'THEORY_MARKED', {
    attempt_id,
    test_id: attempt.test_id,
    marked_by: req.user!.id,
    total_score: totalScore,
  });

  sendSuccess(res, { attempt_id, total_score: totalScore }, 'Theory answers marked');
});

// ── GET /api/tests/results/:attempt_id ───────────────────────────────────────
/**
 * Student views their results for a submitted attempt.
 * MCQ: shows correct/wrong per question.
 * Theory: shows marks if marked, 'pending' if not.
 * Total score only shown after ALL theory questions are marked.
 * correct_option is NEVER included in the response.
 */
router.get('/results/:attempt_id', requireRole('student'), async (req: Request, res: Response) => {
  const { attempt_id } = req.params;

  // Resolve student
  const { data: studentRecord } = await supabaseAdmin
    .from('students')
    .select('id')
    .eq('user_id', req.user!.id)
    .single();

  if (!studentRecord) { sendError(res, 'Student record not found', 404); return; }

  // Fetch attempt — must belong to this student
  const { data: attempt, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, test_id, mcq_score, total_score, is_submitted, submitted_at, started_at')
    .eq('id', attempt_id)
    .eq('student_id', studentRecord.id)
    .single();

  if (aErr || !attempt) { sendError(res, 'Attempt not found', 404); return; }
  if (!attempt.is_submitted) { sendError(res, 'This attempt has not been submitted yet', 400); return; }

  // Fetch answers with question details — NEVER select correct_option
  const { data: answers, error: ansErr } = await supabaseAdmin
    .from('student_answers')
    .select(`
      question_id,
      selected_option,
      theory_answer,
      is_correct,
      marks_awarded,
      questions (
        question_text,
        question_type,
        option_a,
        option_b,
        option_c,
        option_d,
        marks
      )
    `)
    .eq('attempt_id', attempt_id);

  if (ansErr) { sendError(res, ansErr.message, 500); return; }

  type AnswerRow = {
    question_id: string;
    selected_option: string | null;
    theory_answer: string | null;
    is_correct: boolean | null;
    marks_awarded: number | null;
    questions: {
      question_text: string;
      question_type: string;
      option_a: string | null;
      option_b: string | null;
      option_c: string | null;
      option_d: string | null;
      marks: number;
    } | null;
  };

  const formattedAnswers = (answers as unknown as AnswerRow[] ?? []).map((ans) => {
    const q = ans.questions;
    if (q?.question_type === 'mcq') {
      return {
        question_id: ans.question_id,
        question_text: q.question_text,
        question_type: 'mcq',
        option_a: q.option_a,
        option_b: q.option_b,
        option_c: q.option_c,
        option_d: q.option_d,
        selected_option: ans.selected_option,
        is_correct: ans.is_correct,
        marks: q.marks,
        marks_awarded: ans.marks_awarded,
        // correct_option intentionally omitted
      };
    }
    return {
      question_id: ans.question_id,
      question_text: q?.question_text ?? '',
      question_type: 'theory',
      theory_answer: ans.theory_answer,
      marks: q?.marks ?? 0,
      marks_awarded: ans.marks_awarded !== null ? ans.marks_awarded : 'pending',
    };
  });

  // Total score only shown when all theory questions are marked
  const hasUnmarkedTheory = formattedAnswers.some(
    (a) => a.question_type === 'theory' && a.marks_awarded === 'pending'
  );

  sendSuccess(res, {
    attempt_id,
    test_id: attempt.test_id,
    started_at: attempt.started_at,
    submitted_at: attempt.submitted_at,
    mcq_score: attempt.mcq_score,
    total_score: hasUnmarkedTheory ? null : attempt.total_score,
    total_score_pending: hasUnmarkedTheory,
    answers: formattedAnswers,
  });
});

export default router;

// ── Compatibility routes for frontend testsApi ────────────────────────────────
// The frontend calls GET /api/tests and POST /api/tests with a different
// schema than the student-facing routes above. These shim routes bridge the gap.

/**
 * GET /api/tests?class_name=&section=&subject=&term=
 * Returns tests for the teacher's school with their questions embedded.
 */
router.get('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const { class_name, section, subject, term } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('tests')
    .select('*, test_questions(*)')
    .eq('school_id', req.user!.school_id ?? '')
    .order('created_at', { ascending: false });

  if (req.user!.role === 'teacher') query = query.eq('created_by', req.user!.id);
  if (class_name) query = query.eq('class_name', class_name);
  if (section) query = query.eq('section', section);
  if (subject) query = query.eq('subject', subject);
  if (term) query = query.eq('term', term);

  const { data, error } = await query;
  if (error) { sendError(res, error.message, 500); return; }
  sendSuccess(res, data ?? []);
});

/**
 * POST /api/tests
 * Creates a test with embedded questions using the frontend schema.
 * Body: { title, subject, class_name, section, term, date, questions[] }
 */
router.post('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const schema = z.object({
    title:      z.string().min(1),
    subject:    z.string().min(1),
    class_name: z.string().min(1),
    section:    z.string().min(1),
    term:       z.string().min(1),
    date:       z.string().min(1),
    questions:  z.array(z.object({
      type:           z.enum(['mcq', 'theory']),
      text:           z.string().min(1),
      marks:          z.number().min(0.5),
      options:        z.array(z.object({ text: z.string() })).optional(),
      correct_option: z.number().int().min(0).max(3).optional(),
    })).min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { questions, ...testFields } = parsed.data;

  const { data: test, error: testErr } = await supabaseAdmin
    .from('tests')
    .insert({
      ...testFields,
      school_id:  req.user!.school_id,
      created_by: req.user!.id,
    })
    .select()
    .single();

  if (testErr || !test) { sendError(res, testErr?.message ?? 'Failed to create test', 500); return; }

  const questionRows = questions.map((q, idx) => ({
    test_id:        test.id,
    order_index:    idx,
    type:           q.type,
    text:           q.text,
    marks:          q.marks,
    options:        q.options ?? null,
    correct_option: q.correct_option ?? null,
  }));

  const { error: qErr } = await supabaseAdmin.from('test_questions').insert(questionRows);
  if (qErr) {
    await supabaseAdmin.from('tests').delete().eq('id', test.id);
    sendError(res, 'Failed to save questions', 500);
    return;
  }

  await supabaseAdmin.from('audit_logs').insert({
    user_id:    req.user!.id,
    action:     'TEST_CREATED',
    table_name: 'tests',
    details:    { test_id: test.id, title: test.title, question_count: questions.length },
    created_at: new Date().toISOString(),
  });

  const { data: full } = await supabaseAdmin
    .from('tests')
    .select('*, test_questions(*)')
    .eq('id', test.id)
    .single();

  sendSuccess(res, full, 'Test created', 201);
});

/**
 * DELETE /api/tests/:id
 */
router.delete('/:id', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const { error } = await supabaseAdmin
    .from('tests')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.user!.school_id ?? '');

  if (error) { sendError(res, error.message, 500); return; }

  await supabaseAdmin.from('audit_logs').insert({
    user_id:    req.user!.id,
    action:     'TEST_DELETED',
    table_name: 'tests',
    details:    { test_id: req.params.id },
    created_at: new Date().toISOString(),
  });

  sendSuccess(res, null, 'Test deleted');
});
