import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

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
  const cn  = className.trim();
  const sec = section.trim();

  // Try class_name column first
  const { data: byClassName } = await supabaseAdmin
    .from('teacher_assignments')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .ilike('class_name', cn)
    .ilike('section', sec)
    .limit(1);
  if ((byClassName ?? []).length > 0) return true;

  // Fallback: legacy `class` column
  const { data: byClass } = await supabaseAdmin
    .from('teacher_assignments')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .ilike('class', cn)
    .ilike('section', sec)
    .limit(1);
  return (byClass ?? []).length > 0;
}

// ── POST /api/tests/create ────────────────────────────────────────────────────
/**
 * Teacher creates a test with questions.
 * Only a teacher assigned to that class/section can create.
 */
router.post('/create', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const parsed = createTestSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { questions, ...testFields } = parsed.data;

  // Enforce single question type per test — a test must be all-MCQ or all-theory, never mixed
  const qTypes = new Set(questions.map((q) => q.question_type));
  if (qTypes.size > 1) {
    sendError(res, 'A test must contain only MCQ questions or only Theory questions, not both. Please create separate tests for each type.', 400);
    return;
  }

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
      class:   testFields.class,       // DB column is "class"
      section: testFields.section,
      term:    testFields.term,
      date:    testFields.date,
      time_limit_minutes: testFields.time_limit_minutes,
      shuffle_questions:  testFields.shuffle_questions,
      shuffle_options:    testFields.shuffle_options,
      school_id:  req.user!.school_id,
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
router.get('/my-tests', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
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

  if (className) query = query.ilike('class', className.trim());   // DB column is "class"
  if (section) query = query.ilike('section', section.trim());
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
router.get('/student', authenticateStudent, requireRole('student'), async (req: Request, res: Response) => {
  // authenticateStudent already resolved and verified the student — use it directly
  const studentRecord = {
    id: req.student!.id,
    class_name: req.student!.class_name,
    section: req.student!.section,
    school_id: req.student!.school_id,
  };

  if (!studentRecord.class_name || !studentRecord.section) {
    sendError(res, 'Student class/section not set. Contact your administrator.', 403);
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
      available_from, available_until,
      questions:test_questions(count)
    `)
    .eq('school_id', studentRecord.school_id)
    .ilike('class', studentRecord.class_name)
    .ilike('section', studentRecord.section)
    .order('date', { ascending: false });

  if (tErr) { sendError(res, tErr.message, 500); return; }

  const result = (tests ?? []).map((t: Record<string, unknown>) => ({
    id: t.id,
    title: t.title,
    subject_id: t.subject_id,
    date: t.date,
    time_limit_minutes: t.time_limit_minutes,
    available_from: t.available_from ?? null,
    available_until: t.available_until ?? null,
    question_count: Array.isArray(t.questions)
      ? (t.questions as Array<{ count: number }>)[0]?.count ?? 0
      : 0,
  }));

  // Enrich with attempt status for each test
  const studentId = studentRecord.id;
  const { data: attempts } = await supabaseAdmin
    .from('test_attempts')
    .select('test_id, is_submitted')
    .eq('student_id', studentId)
    .in('test_id', result.map((t) => t.id));

  const attemptMap = new Map<string, 'in_progress' | 'completed'>();
  for (const a of (attempts ?? [])) {
    attemptMap.set(a.test_id, a.is_submitted ? 'completed' : 'in_progress');
  }

  const enriched = result.map((t) => ({
    ...t,
    attempt_status: attemptMap.get(t.id as string) ?? 'not_started',
  }));

  sendSuccess(res, enriched);
});

// ── POST /api/tests/attempt/start ────────────────────────────────────────────
/**
 * Student starts a test attempt.
 * Returns all questions WITHOUT correct_option.
 * Applies shuffle if configured.
 */
router.post('/attempt/start', authenticateStudent, requireRole('student'), async (req: Request, res: Response) => {
  const { test_id } = req.body as { test_id?: string };
  if (!test_id) { sendError(res, 'test_id is required', 400); return; }

  // authenticateStudent already resolved and verified the student — use it directly
  const studentRecord = {
    id: req.student!.id,
    class_name: req.student!.class_name,
    section: req.student!.section,
    school_id: req.student!.school_id,
  };

  if (!studentRecord.class_name || !studentRecord.section) {
    sendError(res, 'Student class/section not set. Contact your administrator.', 403);
    return;
  }

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
    .select('id, class, section, school_id, time_limit_minutes, shuffle_questions, shuffle_options, available_from, available_until, date')
    .eq('id', test_id)
    .eq('school_id', studentRecord.school_id)
    .ilike('class', studentRecord.class_name)
    .ilike('section', studentRecord.section)
    .single();

  if (tErr || !test) { sendError(res, 'Test not found or not available for your class', 404); return; }

  // Enforce scheduled time window if set
  if ((test.available_from || test.available_until) && test.date) {
    const now = new Date();
    const testDate = new Date(test.date);
    const todayStr = now.toISOString().split('T')[0];
    const testDateStr = testDate.toISOString().split('T')[0];

    if (todayStr === testDateStr) {
      const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (test.available_from && nowHHMM < test.available_from) {
        sendError(res, `This test is not available yet. It opens at ${test.available_from}.`, 403);
        return;
      }
      if (test.available_until && nowHHMM > test.available_until) {
        sendError(res, `This test window has closed. It was available until ${test.available_until}.`, 403);
        return;
      }
    }
  }

  // Prevent duplicate active attempts
  const { data: existingAttempt } = await supabaseAdmin
    .from('test_attempts')
    .select('id, is_submitted')
    .eq('test_id', test_id)
    .eq('student_id', studentRecord.id)
    .maybeSingle();

  if (existingAttempt) {
    if (existingAttempt.is_submitted) {
      res.status(409).json({ success: false, message: 'You have already submitted this test', attempt_id: existingAttempt.id });
      return;
    }
    // Resume existing active attempt — fall through with the existing attempt_id
    // (questions are fetched below and returned so the student can continue)
  }

  // Fetch questions BEFORE creating the attempt — so we never create orphan attempts
  // Try test_questions first (compatibility shim), fallback to questions
  let rawQuestionsData = null;
  let qErr = null;

  const { data: tqData, error: tqErr } = await supabaseAdmin
    .from('test_questions')
    .select('id, order_index, question_text, question_type, option_a, option_b, option_c, option_d, marks')
    .eq('test_id', test_id)
    .order('order_index', { ascending: true });

  if (!tqErr && tqData && tqData.length > 0) {
    rawQuestionsData = tqData;
  } else {
    const { data: qData, error: qError } = await supabaseAdmin
      .from('questions')
      .select('id, order_index, question_text, question_type, option_a, option_b, option_c, option_d, marks')
      .eq('test_id', test_id)
      .order('order_index', { ascending: true });
    rawQuestionsData = qData;
    qErr = qError;
  }

  if (qErr || !rawQuestionsData || rawQuestionsData.length === 0) {
    sendError(res, 'This test has no questions yet. Contact your teacher.', 404);
    return;
  }

  // Create or reuse the attempt record
  let attempt: { id: string; started_at: string } | null = null;
  if (existingAttempt) {
    // Resume — fetch the full attempt row
    const { data: existingFull } = await supabaseAdmin
      .from('test_attempts')
      .select('id, started_at')
      .eq('id', existingAttempt.id)
      .single();
    attempt = existingFull;
  } else {
    const { data: newAttempt, error: aErr } = await supabaseAdmin
      .from('test_attempts')
      .insert({
        test_id,
        student_id: studentRecord.id,
        started_at: new Date().toISOString(),
        is_submitted: false,
      })
      .select()
      .single();
    if (aErr || !newAttempt) { sendError(res, 'Failed to start attempt', 500); return; }
    attempt = newAttempt;
  }

  if (!attempt) { sendError(res, 'Failed to start attempt', 500); return; }

  const rawQuestions = rawQuestionsData;

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
    resumed: !!existingAttempt,
    questions,
  }, existingAttempt ? 'Test resumed' : 'Test started');
});

// ── POST /api/tests/attempt/submit ───────────────────────────────────────────
/**
 * Student submits answers.
 * MCQ graded server-side by fetching correct_option from DB.
 * Theory answers stored for teacher marking later.
 * Auto-submits if time limit exceeded.
 */
router.post('/attempt/submit', authenticateStudent, requireRole('student'), async (req: Request, res: Response) => {
  const parsed = submitAttemptSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { attempt_id, answers } = parsed.data;

  // authenticateStudent already resolved and verified the student — use directly
  const studentId = req.student!.id;

  // Fetch attempt — must belong to this student and not yet submitted
  const { data: attempt, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, test_id, started_at, is_submitted')
    .eq('id', attempt_id)
    .eq('student_id', studentId)
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
  // Try test_questions first (compatibility shim), fallback to questions
  let gradingQuestions = null;
  const { data: tqGrading, error: tqGradingErr } = await supabaseAdmin
    .from('test_questions')
    .select('id, question_type, correct_option, marks')
    .eq('test_id', attempt.test_id);

  if (!tqGradingErr && tqGrading && tqGrading.length > 0) {
    gradingQuestions = tqGrading;
  } else {
    const { data: qGrading } = await supabaseAdmin
      .from('questions')
      .select('id, question_type, correct_option, marks')
      .eq('test_id', attempt.test_id);
    gradingQuestions = qGrading;
  }

  const questions = gradingQuestions;

  if (!questions) { sendError(res, 'Failed to load questions for grading', 500); return; }

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

  // Delete any previously saved answers for this attempt (handles retry safely)
  // then re-insert fresh — avoids needing a unique constraint for upsert
  if (answerRows.length > 0) {
    await supabaseAdmin
      .from('student_answers')
      .delete()
      .eq('attempt_id', attempt_id);

    const { error: insertErr } = await supabaseAdmin
      .from('student_answers')
      .insert(answerRows);

    if (insertErr) {
      console.error('[SUBMIT] student_answers insert error:', JSON.stringify(insertErr, null, 2));
      sendError(res, `Failed to save answers: ${insertErr.message}`, 500);
      return;
    }
  }

  // Update attempt as submitted
  const { error: updateErr } = await supabaseAdmin
    .from('test_attempts')
    .update({
      mcq_score: mcqScore,
      is_submitted: true,
      submitted_at: now.toISOString(),
    })
    .eq('id', attempt_id);

  if (updateErr) { sendError(res, `Failed to finalise submission: ${updateErr.message}`, 500); return; }

  // ── Auto-write MCQ score into marks table so it appears in View Marks ──────
  // Fetch test metadata needed for the marks record (subject, term, school_id, class)
  const { data: testMeta } = await supabaseAdmin
    .from('tests')
    .select('subject, term, school_id, class, title')
    .eq('id', attempt.test_id)
    .single();

  if (testMeta && totalMcqMarks > 0) {
    // Upsert: if a marks record for this attempt already exists, update it;
    // otherwise insert. We use a unique note tag to identify auto-generated records.
    const noteTag = `auto:attempt:${attempt_id}`;

    // Check if a record already exists for this attempt
    const { data: existingMark } = await supabaseAdmin
      .from('marks')
      .select('id')
      .eq('student_id', req.student!.id)
      .eq('notes', noteTag)
      .maybeSingle();

    if (existingMark) {
      // Update existing record
      await supabaseAdmin
        .from('marks')
        .update({
          score:    mcqScore,
          max_score: totalMcqMarks,
        })
        .eq('id', existingMark.id);
    } else {
      // Insert new marks record
      await supabaseAdmin
        .from('marks')
        .insert({
          student_id:  req.student!.id,
          subject:     testMeta.subject,
          score:       mcqScore,
          max_score:   totalMcqMarks,
          term:        testMeta.term,
          exam_type:   'class_test',
          notes:       noteTag,
          recorded_by: null,
        });
    }
  }

  await logAudit(req.student!.id, 'TEST_SUBMITTED', {
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
router.post('/theory/mark', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
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
    .select('class, section, school_id, created_by')
    .eq('id', attempt.test_id)
    .single();

  if (tErr || !test) { sendError(res, 'Test not found', 404); return; }

  // Teachers can only mark tests from their assigned classes
  if (req.user!.role === 'teacher') {
    const allowed = await teacherOwnsClass(
      req.user!.id,
      req.user!.school_id ?? '',
      (test as Record<string, unknown>)['class'] as string,
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

  // ── Sync total_score into marks table too ─────────────────────────────────
  // For mixed MCQ+theory tests, update the marks record with the final score
  const { data: attemptDetail } = await supabaseAdmin
    .from('test_attempts')
    .select('student_id, test_id')
    .eq('id', attempt_id)
    .single();

  if (attemptDetail) {
    const noteTag = `auto:attempt:${attempt_id}`;
    const { data: existingMark } = await supabaseAdmin
      .from('marks')
      .select('id')
      .eq('student_id', attemptDetail.student_id)
      .eq('notes', noteTag)
      .maybeSingle();

    // Calculate total possible marks by summing question marks from the test
    const { data: testQuestions } = await supabaseAdmin
      .from('test_questions')
      .select('marks')
      .eq('test_id', attemptDetail.test_id);

    const maxScore = (testQuestions ?? []).reduce(
      (sum: number, row: { marks: number }) => sum + Number(row.marks), 0
    );

    if (existingMark) {
      await supabaseAdmin
        .from('marks')
        .update({ score: totalScore, max_score: maxScore })
        .eq('id', existingMark.id);
    } else {
      // Fetch test metadata for subject/term
      const { data: testMeta } = await supabaseAdmin
        .from('tests')
        .select('subject, term')
        .eq('id', attemptDetail.test_id)
        .single();

      if (testMeta) {
        await supabaseAdmin
          .from('marks')
          .insert({
            student_id:  attemptDetail.student_id,
            subject:     testMeta.subject,
            score:       totalScore,
            max_score:   maxScore,
            term:        testMeta.term,
            exam_type:   'class_test',
            notes:       noteTag,
            recorded_by: req.user!.id,
          });
      }
    }
  }

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
router.get('/results/:attempt_id', authenticateStudent, requireRole('student'), async (req: Request, res: Response) => {
  const { attempt_id } = req.params;

  // authenticateStudent already resolved and verified the student — use directly
  const studentId = req.student!.id;

  // Fetch attempt — must belong to this student
  const { data: attempt, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, test_id, mcq_score, total_score, is_submitted, submitted_at, started_at')
    .eq('id', attempt_id)
    .eq('student_id', studentId)
    .single();

  if (aErr || !attempt) { sendError(res, 'Attempt not found', 404); return; }
  if (!attempt.is_submitted) { sendError(res, 'This attempt has not been submitted yet', 400); return; }

  // Fetch answers (no join — no FK exists between student_answers and questions)
  const { data: answers, error: ansErr } = await supabaseAdmin
    .from('student_answers')
    .select('question_id, selected_option, theory_answer, is_correct, marks_awarded')
    .eq('attempt_id', attempt_id);

  if (ansErr) { sendError(res, ansErr.message, 500); return; }

  // Fetch question details separately from both possible tables
  const questionIds = (answers ?? []).map((a: { question_id: string }) => a.question_id);

  type QuestionDetail = {
    id: string;
    question_text: string;
    question_type: string;
    option_a: string | null;
    option_b: string | null;
    option_c: string | null;
    option_d: string | null;
    correct_option: string | null;
    marks: number;
  };

  const questionMap = new Map<string, QuestionDetail>();

  if (questionIds.length > 0) {
    // Try test_questions first
    const { data: tqData } = await supabaseAdmin
      .from('test_questions')
      .select('id, question_text, question_type, option_a, option_b, option_c, option_d, correct_option, marks')
      .in('id', questionIds);

    for (const q of (tqData ?? []) as QuestionDetail[]) {
      questionMap.set(q.id, q);
    }

    // Fill any missing from questions table
    const missing = questionIds.filter((id) => !questionMap.has(id));
    if (missing.length > 0) {
      const { data: qData } = await supabaseAdmin
        .from('questions')
        .select('id, question_text, question_type, option_a, option_b, option_c, option_d, correct_option, marks')
        .in('id', missing);

      for (const q of (qData ?? []) as QuestionDetail[]) {
        questionMap.set(q.id, q);
      }
    }
  }

  type AnswerRow = {
    question_id: string;
    selected_option: string | null;
    theory_answer: string | null;
    is_correct: boolean | null;
    marks_awarded: number | null;
  };

  const formattedAnswers = (answers as AnswerRow[] ?? []).map((ans) => {
    const q = questionMap.get(ans.question_id);
    if (q?.question_type === 'mcq') {
      const isCorrect = ans.is_correct === true;
      return {
        question_id: ans.question_id,
        question_text: q.question_text,
        question_type: 'mcq',
        option_a: q.option_a,
        option_b: q.option_b,
        option_c: q.option_c,
        option_d: q.option_d,
        selected_option: ans.selected_option,
        // Only reveal correct answer if the student got it wrong or skipped — for learning
        correct_option: !isCorrect ? q.correct_option : null,
        is_correct: ans.is_correct,
        marks: q.marks,
        marks_awarded: ans.marks_awarded,
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

// ── Compatibility routes for frontend testsApi ────────────────────────────────
// The frontend calls GET /api/tests and POST /api/tests with a different
// schema than the student-facing routes above. These shim routes bridge the gap.

/**
 * GET /api/tests?class_name=&section=&subject=&term=
 * Returns tests for the teacher's school with their questions embedded.
 * Live DB uses "class" column, not "class_name".
 */
router.get('/', authenticate, requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const { class_name, section, subject, term } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('tests')
    .select('*, test_questions(*)')
    .eq('school_id', req.user!.school_id ?? '')
    .order('created_at', { ascending: false });

  if (req.user!.role === 'teacher') query = query.eq('created_by', req.user!.id);
  if (class_name) query = query.ilike('class', class_name.trim());   // DB column is "class"
  if (section)    query = query.ilike('section', section.trim());
  if (subject)    query = query.eq('subject', subject);
  if (term)       query = query.eq('term', term);

  const { data, error } = await query;
  if (error) { sendError(res, error.message, 500); return; }

  // Normalise: expose class_name so the frontend doesn't need to know the DB column name
  const normalised = (data ?? []).map((t: Record<string, unknown>) => ({
    ...t,
    class_name: t['class'] ?? t['class_name'],
  }));

  sendSuccess(res, normalised);
});

/**
 * POST /api/tests
 * Creates a test with embedded questions using the frontend schema.
 * Body: { title, subject, class_name, section, term, date, questions[] }
 *
 * Live DB schema:
 *   tests          → class (text), subject (text), subject_id (uuid nullable)
 *   test_questions → question_text, question_type, option_a-d, correct_option (text 'a'-'d')
 */
router.post('/', authenticate, requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const schema = z.object({
    title:           z.string().min(1),
    subject:         z.string().min(1),
    class_name:      z.string().min(1),
    section:         z.string().min(1),
    term:            z.string().min(1),
    date:            z.string().min(1),
    available_from:  z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
    available_until: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
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

  const { questions, class_name, ...rest } = parsed.data;

  // Enforce single question type per test — a test must be all-MCQ or all-theory, never mixed
  const questionTypes = new Set(questions.map((q) => q.type));
  if (questionTypes.size > 1) {
    sendError(res, 'A test must contain only MCQ questions or only Theory questions, not both. Please create separate tests for each type.', 400);
    return;
  }

  // Normalise term to title-case to satisfy the DB check constraint (e.g. "term 1" → "Term 1")
  const normalisedTerm = rest.term.replace(/\bterm\b/i, 'Term').replace(/\bT(\d)/i, 'T$1');

  const { data: test, error: testErr } = await supabaseAdmin
    .from('tests')
    .insert({
      title:           rest.title,
      subject:         rest.subject,
      class:           class_name,
      section:         rest.section,
      term:            normalisedTerm,
      date:            rest.date,
      available_from:  rest.available_from ?? null,
      available_until: rest.available_until ?? null,
      school_id:       req.user!.school_id,
      created_by:      req.user!.id,
    })
    .select()
    .single();

  if (testErr || !test) {
    console.error('[tests] insert error:', testErr);
    sendError(res, testErr?.message ?? 'Failed to create test', 500);
    return;
  }

  // Map options array to option_a/b/c/d columns; correct_option index → letter
  const optionLetters = ['a', 'b', 'c', 'd'] as const;

  const questionRows = questions.map((q, idx) => {
    const opts = q.options ?? [];
    return {
      test_id:        test.id,
      order_index:    idx,
      question_text:  q.text,
      question_type:  q.type,
      option_a:       opts[0]?.text ?? null,
      option_b:       opts[1]?.text ?? null,
      option_c:       opts[2]?.text ?? null,
      option_d:       opts[3]?.text ?? null,
      correct_option: q.correct_option !== undefined ? optionLetters[q.correct_option] : null,
      marks:          q.marks,
    };
  });

  const { error: qErr } = await supabaseAdmin.from('test_questions').insert(questionRows);
  if (qErr) {
    console.error('[tests] questions insert error:', qErr);
    await supabaseAdmin.from('tests').delete().eq('id', test.id);
    sendError(res, `Failed to save questions: ${qErr.message}`, 500);
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

  // Normalise class_name for frontend
  const result = full ? { ...full, class_name: (full as Record<string, unknown>)['class'] } : full;

  sendSuccess(res, result, 'Test created', 201);
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

// ── GET /api/tests/:test_id/attempts ──────────────────────────────────────────
/**
 * Teacher lists all student attempts (submissions) for a test.
 * Returns: student name, mcq_score, total_score, submitted_at, whether theory marking is pending.
 */
router.get('/:test_id/attempts', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const { test_id } = req.params;

  // Verify test exists and teacher has access
  const { data: test, error: tErr } = await supabaseAdmin
    .from('tests')
    .select('id, class, section, school_id')
    .eq('id', test_id)
    .eq('school_id', req.user!.school_id ?? '')
    .single();

  if (tErr || !test) { sendError(res, 'Test not found', 404); return; }

  // Verify teacher owns this class/section
  if (req.user!.role === 'teacher') {
    const allowed = await teacherOwnsClass(
      req.user!.id,
      req.user!.school_id ?? '',
      (test as Record<string, unknown>)['class'] as string,
      test.section
    );
    if (!allowed) {
      sendError(res, 'You are not assigned to this class/section', 403);
      return;
    }
  }

  // Fetch all submitted attempts
  const { data: attempts, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, student_id, started_at, submitted_at, is_submitted, mcq_score, total_score')
    .eq('test_id', test_id)
    .eq('is_submitted', true)
    .order('submitted_at', { ascending: false });

  if (aErr) { sendError(res, aErr.message, 500); return; }

  if (!attempts || attempts.length === 0) {
    sendSuccess(res, []);
    return;
  }

  // Fetch student details
  const studentIds = attempts.map((a) => a.student_id);
  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, roll_no, users!inner(id, name)')
    .in('id', studentIds);

  if (sErr) { sendError(res, sErr.message, 500); return; }

  const studentMap = new Map(
    (students ?? []).map((s: { id: string; roll_no: string; users: { id: string; name: string } | { id: string; name: string }[] }) => {
      const userObj = Array.isArray(s.users) ? s.users[0] : s.users;
      return [s.id, { roll_no: s.roll_no, name: userObj?.name ?? 'Unknown' }];
    })
  );

  // Check for pending theory marks per attempt
  const { data: allAnswers } = await supabaseAdmin
    .from('student_answers')
    .select('attempt_id, theory_answer, marks_awarded')
    .in('attempt_id', attempts.map((a) => a.id))
    .not('theory_answer', 'is', null);

  const theoryPendingMap = new Map<string, boolean>();
  for (const ans of (allAnswers ?? [])) {
    if (ans.marks_awarded === null) {
      theoryPendingMap.set(ans.attempt_id, true);
    }
  }

  // Build response
  const result = attempts.map((a) => {
    const student = studentMap.get(a.student_id);
    return {
      attempt_id: a.id,
      student_id: a.student_id,
      student_name: student?.name ?? 'Unknown',
      roll_no: student?.roll_no ?? '',
      submitted_at: a.submitted_at,
      mcq_score: a.mcq_score,
      total_score: a.total_score,
      theory_pending: theoryPendingMap.get(a.id) ?? false,
    };
  });

  sendSuccess(res, result);
});

// ── GET /api/tests/attempts/:attempt_id/details ──────────────────────────────
/**
 * Teacher views full attempt details with all answers and questions for marking.
 * Returns questions with student answers, marks awarded, and for theory shows the student's text answer.
 */
router.get('/attempts/:attempt_id/details', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const { attempt_id } = req.params;

  // Fetch attempt
  const { data: attempt, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, test_id, student_id, started_at, submitted_at, is_submitted, mcq_score, total_score')
    .eq('id', attempt_id)
    .single();

  if (aErr || !attempt) { sendError(res, 'Attempt not found', 404); return; }
  if (!attempt.is_submitted) { sendError(res, 'This attempt has not been submitted yet', 400); return; }

  // Verify test access
  const { data: test, error: tErr } = await supabaseAdmin
    .from('tests')
    .select('id, title, class, section, school_id')
    .eq('id', attempt.test_id)
    .eq('school_id', req.user!.school_id ?? '')
    .single();

  if (tErr || !test) { sendError(res, 'Test not found', 404); return; }

  if (req.user!.role === 'teacher') {
    const allowed = await teacherOwnsClass(
      req.user!.id,
      req.user!.school_id ?? '',
      (test as Record<string, unknown>)['class'] as string,
      test.section
    );
    if (!allowed) {
      sendError(res, 'You are not assigned to this class/section', 403);
      return;
    }
  }

  // Fetch student details
  const { data: student } = await supabaseAdmin
    .from('students')
    .select('id, roll_no, users!inner(name)')
    .eq('id', attempt.student_id)
    .single();

  // Fetch answers
  const { data: answers, error: ansErr } = await supabaseAdmin
    .from('student_answers')
    .select('question_id, selected_option, theory_answer, is_correct, marks_awarded')
    .eq('attempt_id', attempt_id);

  if (ansErr) { sendError(res, ansErr.message, 500); return; }

  // Fetch questions
  const questionIds = (answers ?? []).map((a: { question_id: string }) => a.question_id);
  const questionMap = new Map<string, {
    id: string;
    question_text: string;
    question_type: string;
    option_a: string | null;
    option_b: string | null;
    option_c: string | null;
    option_d: string | null;
    correct_option: string | null;
    marks: number;
    order_index: number;
  }>();

  if (questionIds.length > 0) {
    const { data: tqData } = await supabaseAdmin
      .from('test_questions')
      .select('id, order_index, question_text, question_type, option_a, option_b, option_c, option_d, correct_option, marks')
      .in('id', questionIds);

    for (const q of (tqData ?? [])) {
      questionMap.set(q.id, q);
    }

    const missing = questionIds.filter((id) => !questionMap.has(id));
    if (missing.length > 0) {
      const { data: qData } = await supabaseAdmin
        .from('questions')
        .select('id, order_index, question_text, question_type, option_a, option_b, option_c, option_d, correct_option, marks')
        .in('id', missing);

      for (const q of (qData ?? [])) {
        questionMap.set(q.id, q);
      }
    }
  }

  // Build formatted response
  const formattedAnswers = (answers ?? []).map((ans: {
    question_id: string;
    selected_option: string | null;
    theory_answer: string | null;
    is_correct: boolean | null;
    marks_awarded: number | null;
  }) => {
    const q = questionMap.get(ans.question_id);
    if (!q) return null;

    if (q.question_type === 'mcq') {
      return {
        question_id: q.id,
        order_index: q.order_index,
        question_text: q.question_text,
        question_type: 'mcq',
        marks: q.marks,
        option_a: q.option_a,
        option_b: q.option_b,
        option_c: q.option_c,
        option_d: q.option_d,
        correct_option: q.correct_option,
        selected_option: ans.selected_option,
        is_correct: ans.is_correct,
        marks_awarded: ans.marks_awarded,
      };
    } else {
      return {
        question_id: q.id,
        order_index: q.order_index,
        question_text: q.question_text,
        question_type: 'theory',
        marks: q.marks,
        theory_answer: ans.theory_answer,
        marks_awarded: ans.marks_awarded,
      };
    }
  }).filter((a) => a !== null)
    .sort((a, b) => (a?.order_index ?? 0) - (b?.order_index ?? 0));

  sendSuccess(res, {
    attempt_id: attempt.id,
    test_id: test.id,
    test_title: test.title,
    student_id: attempt.student_id,
    student_name: student ? (Array.isArray(student.users) ? student.users[0]?.name : (student.users as { name: string })?.name) ?? 'Unknown' : 'Unknown',
    roll_no: student?.roll_no ?? '',
    started_at: attempt.started_at,
    submitted_at: attempt.submitted_at,
    mcq_score: attempt.mcq_score,
    total_score: attempt.total_score,
    answers: formattedAnswers,
  });
});

// ── POST /api/tests/backfill-marks ───────────────────────────────────────────
/**
 * Backfills marks table from all existing submitted test_attempts for a school.
 * Safe to run multiple times — uses upsert by notes tag.
 * Teacher/admin only.
 */
router.post('/backfill-marks', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id ?? '';

  // Get all submitted attempts for tests in this school
  const { data: attempts, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select(`
      id, student_id, test_id, mcq_score, total_score,
      tests!inner(subject, term, school_id, class)
    `)
    .eq('is_submitted', true)
    .eq('tests.school_id', schoolId);

  if (aErr) { sendError(res, aErr.message, 500); return; }

  let inserted = 0;
  let updated = 0;

  for (const attempt of (attempts ?? [])) {
    const a = attempt as Record<string, unknown>;
    const test = a.tests as Record<string, unknown> | null;
    if (!test) continue;

    const score = (a.total_score ?? a.mcq_score) as number | null;
    if (score === null) continue;

    // Get total max marks for this test
    const { data: questions } = await supabaseAdmin
      .from('test_questions')
      .select('marks')
      .eq('test_id', a.test_id as string);

    const maxScore = (questions ?? []).reduce(
      (sum: number, q: { marks: number }) => sum + Number(q.marks), 0
    );
    if (maxScore === 0) continue;

    const noteTag = `auto:attempt:${a.id}`;

    const { data: existing } = await supabaseAdmin
      .from('marks')
      .select('id')
      .eq('student_id', a.student_id as string)
      .eq('notes', noteTag)
      .maybeSingle();

    if (existing) {
      await supabaseAdmin
        .from('marks')
        .update({ score, max_score: maxScore })
        .eq('id', existing.id);
      updated++;
    } else {
      await supabaseAdmin
        .from('marks')
        .insert({
          student_id:  a.student_id,
          subject:     test.subject,
          score,
          max_score:   maxScore,
          term:        test.term,
          exam_type:   'class_test',
          notes:       noteTag,
          recorded_by: null,
        });
      inserted++;
    }
  }

  sendSuccess(res, { inserted, updated }, `Backfilled ${inserted} new and updated ${updated} existing marks records`);
});

export default router;
