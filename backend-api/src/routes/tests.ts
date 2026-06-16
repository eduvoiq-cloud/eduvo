import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import { normaliseTerm } from '../utils/term';
import { getTokensForStudents, getTokensForUsers, sendPushMulticast } from '../services/fcmService';
import { testSubmitRateLimit } from '../middleware/rateLimit';
import { updateStreakWithMilestone } from '../services/streakService';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

const EXAM_TYPE_VALUES = ['quiz', 'midterm', 'final', 'assignment', 'project', 'unit_test', 'mid_term', 'class_test'] as const;

const createTestSchema = z.object({
  title: z.string().min(1),
  subject_id: z.string().uuid(),
  class: z.string().min(1),
  section: z.string().min(1),
  term: z.string().min(1),
  date: z.string().date(),
  exam_type: z.enum(EXAM_TYPE_VALUES).default('class_test'),
  available_from: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  available_until: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  time_limit_minutes: z.number().int().min(1),
  shuffle_questions: z.boolean().default(false),
  shuffle_options: z.boolean().default(false),
  // New fields (from daily test migration)
  board: z.string().optional().nullable(),
  chapter: z.string().optional().nullable(),
  language: z.enum(['English','Gujarati','Hindi','Sanskrit','Marathi','Tamil','Telugu','Kannada','Bengali','Punjabi']).optional().nullable(),
  contributes_to_streak: z.boolean().default(false),
  questions: z.array(questionSchema).min(1),
});

const submitAttemptSchema = z.object({
  attempt_id: z.string().uuid(),
  answers: z.array(z.object({
    question_id: z.string().uuid(),
    selected_option: z.enum(['a', 'b', 'c', 'd']).optional(),
    // Sanitize theory answers: strip HTML tags, limit length to 5000 chars
    theory_answer: z.string().max(5000).transform((s) =>
      s.replace(/<[^>]*>/g, '').trim()
    ).optional(),
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

// ── POST /api/tests/generate ──────────────────────────────────────────────────
/**
 * AI-generate MCQ questions using Gemini.
 * Identical capability to the old /api/daily-tests/generate endpoint.
 * Supports text-based generation and image/PDF upload via base64.
 */
router.post('/generate', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const schema = z.object({
    class: z.string().min(1),
    subject: z.string().min(1),
    topic: z.string().min(1),
    board: z.string().optional().default('GSEB'),
    chapter: z.string().optional().default(''),
    language: z.enum(['English','Gujarati','Hindi','Sanskrit','Marathi','Tamil','Telugu','Kannada','Bengali','Punjabi']).optional().default('English'),
    count: z.number().int().min(1).max(30).optional().default(10),
    difficulty_mode: z.enum(['mixed','easy','medium','hard','custom']).optional().default('mixed'),
    easy_count: z.number().int().min(0).optional().default(0),
    medium_count: z.number().int().min(0).optional().default(0),
    hard_count: z.number().int().min(0).optional().default(0),
    file_data: z.string().optional(),
    file_mime: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { class: cls, subject, topic, board, chapter, language, count,
          difficulty_mode, easy_count, medium_count, hard_count,
          file_data, file_mime } = parsed.data;

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '';
  if (!apiKey) { sendError(res, 'AI generation is not configured', 503); return; }

  // Build difficulty line
  let difficultyLine: string;
  if (difficulty_mode === 'easy') {
    difficultyLine = `All ${count} questions must be easy level.`;
  } else if (difficulty_mode === 'medium') {
    difficultyLine = `All ${count} questions must be medium level.`;
  } else if (difficulty_mode === 'hard') {
    difficultyLine = `All ${count} questions must be hard level.`;
  } else if (difficulty_mode === 'custom') {
    const total = easy_count + medium_count + hard_count;
    if (total !== count) {
      sendError(res, `Custom difficulty counts (${easy_count}+${medium_count}+${hard_count}=${total}) must add up to ${count}`, 400);
      return;
    }
    difficultyLine = `Exactly ${easy_count} easy, ${medium_count} medium, and ${hard_count} hard questions.`;
  } else {
    const hard = Math.max(1, Math.round(count * 0.2));
    const easy = Math.max(1, Math.round(count * 0.4));
    const medium = count - easy - hard;
    difficultyLine = `Approximately ${easy} easy, ${medium} medium, and ${hard} hard questions.`;
  }

  const chapterLine = chapter ? ` Chapter/Unit: '${chapter}'.` : '';

  const LANG_INSTRUCTIONS: Record<string, string> = {
    English:  'Write all questions and options in English.',
    Gujarati: 'Write all questions and options in Gujarati language using Gujarati script (e.g. ગુજરાતી). Do NOT write in English or transliteration.',
    Hindi:    'Write all questions and options in Hindi language using Devanagari script (e.g. हिंदी). Do NOT write in English or transliteration.',
    Sanskrit: 'Write all questions and options in Sanskrit language using Devanagari script. Do NOT write in English or transliteration.',
    Marathi:  'Write all questions and options in Marathi language using Devanagari script (e.g. मराठी). Do NOT write in English or transliteration.',
    Tamil:    'Write all questions and options in Tamil language using Tamil script (e.g. தமிழ்). Do NOT write in English or transliteration.',
    Telugu:   'Write all questions and options in Telugu language using Telugu script (e.g. తెలుగు). Do NOT write in English or transliteration.',
    Kannada:  'Write all questions and options in Kannada language using Kannada script (e.g. ಕನ್ನಡ). Do NOT write in English or transliteration.',
    Bengali:  'Write all questions and options in Bengali language using Bengali script (e.g. বাংলা). Do NOT write in English or transliteration.',
    Punjabi:  'Write all questions and options in Punjabi language using Gurmukhi script (e.g. ਪੰਜਾਬੀ). Do NOT write in English or transliteration.',
  };
  const languageInstruction = LANG_INSTRUCTIONS[language] ?? LANG_INSTRUCTIONS.English;
  const fileContext = file_data ? ' Use the provided image/document as the primary source for generating questions.' : '';

  const prompt = `You are an experienced ${subject} teacher for Class ${cls} following ${board} curriculum in India.${chapterLine}
Generate exactly ${count} multiple choice questions based on the topic: '${topic}'.${fileContext}
Requirements:
- ${difficultyLine}
- Each question has exactly 4 options
- Mark correct answer index (0-3)
- One-line explanation per question
- Test understanding, not just recall
IMPORTANT LANGUAGE REQUIREMENT: ${languageInstruction}`;

  const responseSchema = {
    type: 'object' as const,
    properties: {
      questions: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            question:      { type: 'string' as const },
            options:       { type: 'array' as const, items: { type: 'string' as const }, minItems: 4, maxItems: 4 },
            correct_index: { type: 'integer' as const, minimum: 0, maximum: 3 },
            explanation:   { type: 'string' as const },
            difficulty:    { type: 'string' as const, enum: ['easy', 'medium', 'hard'] },
          },
          required: ['question', 'options', 'correct_index', 'explanation', 'difficulty'],
        },
      },
    },
    required: ['questions'],
  };

  const contentParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt }];
  if (file_data && file_mime) {
    contentParts.push({ inlineData: { mimeType: file_mime, data: file_data } });
  }

  // Try primary model, fall back to gemini-2.0-flash on 503 (overloaded)
  const primaryModel  = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const fallbackModel = 'gemini-2.0-flash';
  const modelsToTry   = primaryModel === fallbackModel ? [primaryModel] : [primaryModel, fallbackModel];

  const genAI = new GoogleGenerativeAI(apiKey);

  let raw = '';
  let lastErr: unknown;

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: 'application/json', responseSchema } as Record<string, unknown>,
      });
      const result = await model.generateContent(contentParts);
      raw = result.response.text().trim();
      lastErr = null;
      break; // success — stop trying
    } catch (err) {
      lastErr = err;
      const status = (err as Record<string, unknown>)?.status as number | undefined;
      if (status === 503 || status === 429) {
        console.warn(`[tests/generate] ${modelName} returned ${status}, trying fallback…`);
        continue; // try next model
      }
      // Any other error (auth, bad request, etc.) — fail immediately
      console.error('[tests/generate] Gemini error:', err);
      const msg = (err instanceof Error ? err.message : '') || 'Failed to generate questions. Please try again.';
      sendError(res, msg, 500);
      return;
    }
  }

  if (lastErr) {
    console.error('[tests/generate] All models failed:', lastErr);
    const status = (lastErr as Record<string, unknown>)?.status as number | undefined;
    if (status === 503 || status === 429) {
      sendError(res, 'AI is currently overloaded. Please try again in a moment.', 503);
    } else {
      sendError(res, 'Failed to generate questions. Please try again.', 500);
    }
    return;
  }

  try {
    let parsed2: { questions: Array<{ question: string; options: string[]; correct_index: number; explanation: string; difficulty: string }> };
    try { parsed2 = JSON.parse(raw); }
    catch { sendError(res, 'AI returned invalid format. Please try again.', 500); return; }

    if (!Array.isArray(parsed2.questions) || parsed2.questions.length === 0) {
      sendError(res, 'AI did not return valid questions. Please try again.', 500); return;
    }

    // Map to the format expected by the test create endpoint:
    // question_type: 'mcq', option_a/b/c/d, correct_option: 'a'|'b'|'c'|'d'
    const OPTION_LETTERS = ['a', 'b', 'c', 'd'] as const;
    const questions = parsed2.questions.map((q) => ({
      question_text: q.question,
      question_type: 'mcq' as const,
      option_a: q.options[0] ?? '',
      option_b: q.options[1] ?? '',
      option_c: q.options[2] ?? '',
      option_d: q.options[3] ?? '',
      correct_option: OPTION_LETTERS[q.correct_index] ?? 'a',
      explanation: q.explanation ?? '',
      difficulty: q.difficulty ?? 'medium',
      marks: 1,
    }));

    sendSuccess(res, { questions }, 'Questions generated');
  } catch (err) {
    console.error('[tests/generate] post-parse error:', err);
    sendError(res, 'Failed to generate questions. Please try again.', 500);
  }
});

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

  // Reject past dates
  const todayStr = new Date().toISOString().slice(0, 10);
  if (testFields.date < todayStr) {
    sendError(res, 'Test date cannot be in the past', 400);
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
      term:    normaliseTerm(testFields.term) ?? testFields.term,
      date:    testFields.date,
      exam_type: testFields.exam_type ?? 'class_test',
      available_from:  testFields.available_from ?? null,
      available_until: testFields.available_until ?? null,
      time_limit_minutes: testFields.time_limit_minutes,
      shuffle_questions:  testFields.shuffle_questions,
      shuffle_options:    testFields.shuffle_options,
      board:   testFields.board ?? null,
      chapter: testFields.chapter ?? null,
      language: testFields.language ?? null,
      contributes_to_streak: testFields.contributes_to_streak ?? false,
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

  // Fire-and-forget: notify all students in the class that a new test is available
  setImmediate(() => {
    (async () => {
      try {
        // Fetch all students in this class/section
        const { data: classStudents } = await supabaseAdmin
          .from('students')
          .select('id')
          .eq('school_id', req.user!.school_id ?? '')
          .ilike('class_name', testFields.class.trim())
          .ilike('section', testFields.section.trim())
          .eq('is_deleted', false);

        if (!classStudents || classStudents.length === 0) return;

        const studentIds = classStudents.map((s: { id: string }) => s.id);

        // Insert in-app notifications
        const senderId = req.user!.id;
        const notifRows = studentIds.map((recipient_id: string) => ({
          title: 'New Test Available',
          message: `A new test "${testFields.title}" has been assigned to your class.`,
          // Use a dedicated type so the mobile app can show a test icon and group it clearly.
          type: 'test',
          recipient_id,
          sender_id: senderId,
          is_read: false,
          created_at: new Date().toISOString(),
        }));

        await supabaseAdmin.from('notifications').insert(notifRows);

        // Send FCM push to students
        const tokens = await getTokensForStudents(studentIds);
        if (tokens.length > 0) {
          const { successCount, failureCount } = await sendPushMulticast(
            tokens,
            'New Test Available',
            `A new test "${testFields.title}" has been assigned. Good luck!`
          );
          console.log(
            `[FCM] Test notification — sent: ${successCount}, failed: ${failureCount}, test: ${test.id}`
          );
        }
      } catch (err) {
        console.error('[FCM] Failed to send test assignment notifications:', err);
      }
    })();
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
 * Student gets all tests for their class/section.
 * Tests are visible to ALL students by default.
 * Blocked students (via test_restrictions) see the test with is_restricted=true.
 * correct_option is NEVER included.
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

  // Fetch tests — no correct_option, no shuffle config exposed
  const { data: tests, error: tErr } = await supabaseAdmin
    .from('tests')
    .select(`
      id, title, subject_id, date, term, time_limit_minutes,
      available_from, available_until,
      subject:subjects(name),
      questions:test_questions(count)
    `)
    .eq('school_id', studentRecord.school_id)
    .ilike('class', studentRecord.class_name)
    .ilike('section', studentRecord.section)
    .order('date', { ascending: false });

  if (tErr) { sendError(res, tErr.message, 500); return; }

  const result = (tests ?? []).map((t: Record<string, unknown>) => {
    const subjectData = t.subject as { name: string } | Array<{ name: string }> | null;
    const subjectName = Array.isArray(subjectData)
      ? (subjectData[0]?.name ?? null)
      : (subjectData?.name ?? null);
    return {
      id: t.id as string,
      title: t.title,
      subject_id: t.subject_id,
      subject: subjectName,
      date: t.date,
      term: t.term ?? null,
      time_limit_minutes: t.time_limit_minutes,
      available_from: t.available_from ?? null,
      available_until: t.available_until ?? null,
      question_count: Array.isArray(t.questions)
        ? (t.questions as Array<{ count: number }>)[0]?.count ?? 0
        : 0,
    };
  });

  if (result.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const studentId = studentRecord.id;
  const testIds = result.map((t) => t.id);

  // Fetch attempt status, scores, and restrictions in parallel
  const [attemptsResult, restrictionsResult, marksResult] = await Promise.all([
    supabaseAdmin
      .from('test_attempts')
      .select('id, test_id, is_submitted, mcq_score, total_score')
      .eq('student_id', studentId)
      .in('test_id', testIds),
    supabaseAdmin
      .from('test_restrictions')
      .select('test_id')
      .eq('student_id', studentId)
      .in('test_id', testIds),
    supabaseAdmin
      .from('marks')
      .select('notes, max_score')
      .eq('student_id', studentId)
      .like('notes', 'auto:attempt:%'),
  ]);

  type AttemptRow = { id: string; test_id: string; is_submitted: boolean; mcq_score: number | null; total_score: number | null };

  const attemptMap = new Map<string, AttemptRow>();
  for (const a of ((attemptsResult.data ?? []) as AttemptRow[])) {
    attemptMap.set(a.test_id, a);
  }

  // Build map: attempt_id -> max_score from the auto-written marks record
  const maxScoreByAttempt = new Map<string, number>();
  for (const m of ((marksResult.data ?? []) as Array<{ notes: string; max_score: number }>)) {
    const match = m.notes?.match(/^auto:attempt:(.+)$/);
    if (match) maxScoreByAttempt.set(match[1], m.max_score);
  }

  const restrictedTestIds = new Set<string>(
    (restrictionsResult.data ?? []).map((r: { test_id: string }) => r.test_id)
  );

  const enriched = result.map((t) => {
    const attempt = attemptMap.get(t.id);
    const attemptStatus = attempt
      ? (attempt.is_submitted ? 'completed' : 'in_progress')
      : 'not_started';

    // For a completed attempt: prefer total_score (MCQ + theory), fall back to mcq_score.
    // If both are null after submission, theory marking is still pending.
    const mcqScore = attempt?.mcq_score ?? null;
    const totalScore = attempt?.total_score ?? null;
    const maxScore = attempt ? (maxScoreByAttempt.get(attempt.id) ?? null) : null;
    const totalScorePending = attemptStatus === 'completed' && totalScore === null && mcqScore === null;

    return {
      ...t,
      attempt_status: attemptStatus,
      is_restricted: restrictedTestIds.has(t.id),
      mcq_score: mcqScore,
      total_score: totalScore,
      max_score: maxScore,
      total_score_pending: totalScorePending,
    };
  });

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

  // Check if this student is restricted from this test
  const { data: restriction } = await supabaseAdmin
    .from('test_restrictions')
    .select('id')
    .eq('test_id', test_id)
    .eq('student_id', studentRecord.id)
    .maybeSingle();

  if (restriction) {
    sendError(res, 'You are not allowed to take this test. Please pay your fees to unlock it.', 403);
    return;
  }

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
  // NOTE: available_from / available_until are stored as HH:MM in the school's
  // local time. The server cannot reliably know the school's timezone, so
  // window enforcement is done client-side. We skip it here to avoid
  // incorrect UTC-vs-local mismatches on the server.

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

    // Existing in-progress attempt: always reset to a fresh start.
    // Resuming a stale attempt causes the client to compute near-zero remaining
    // time (based on the original started_at), which triggers an instant auto-submit.
    // We reset started_at to now and wipe any saved answers so the student
    // always gets a clean full-duration attempt every time they press Start.
    const { data: resetAttempt, error: resetErr } = await supabaseAdmin
      .from('test_attempts')
      .update({
        started_at: new Date().toISOString(),
        is_submitted: false,
      })
      .eq('id', existingAttempt.id)
      .select('id, started_at')
      .single();

    if (resetErr || !resetAttempt) {
      sendError(res, 'Failed to reset attempt', 500);
      return;
    }

    // Clear any previously saved answers so the student starts blank
    await supabaseAdmin
      .from('student_answers')
      .delete()
      .eq('attempt_id', existingAttempt.id);

    // Return early with the reset attempt — no need to fall through.
    // Fetch questions for this test.
    let resetRawQuestions = null;
    const { data: tqResetData, error: tqResetErr } = await supabaseAdmin
      .from('test_questions')
      .select('id, order_index, question_text, question_type, option_a, option_b, option_c, option_d, marks')
      .eq('test_id', test_id)
      .order('order_index', { ascending: true });

    if (!tqResetErr && tqResetData && tqResetData.length > 0) {
      resetRawQuestions = tqResetData;
    } else {
      const { data: qResetData } = await supabaseAdmin
        .from('questions')
        .select('id, order_index, question_text, question_type, option_a, option_b, option_c, option_d, marks')
        .eq('test_id', test_id)
        .order('order_index', { ascending: true });
      resetRawQuestions = qResetData;
    }

    if (!resetRawQuestions || resetRawQuestions.length === 0) {
      sendError(res, 'This test has no questions yet. Contact your teacher.', 404);
      return;
    }

    // Compute remaining seconds server-side so the client never has to do
    // clock arithmetic with its own (potentially skewed) clock.
    // This is a fresh reset — always give the full time limit.
    const resetSecondsRemaining = test.time_limit_minutes * 60;

    sendSuccess(res, {
      attempt_id: resetAttempt.id,
      time_limit_minutes: test.time_limit_minutes,
      started_at: resetAttempt.started_at,
      seconds_remaining: test.time_limit_minutes > 0 ? resetSecondsRemaining : null,
      resumed: false,
      questions: resetRawQuestions,
    }, 'Test started');
    return;
  }

  // No existing attempt — fetch questions then create a fresh one
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

  // Create a fresh attempt record
  let attempt: { id: string; started_at: string } | null = null;
  {
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

  // Compute remaining seconds server-side so the client never has to do
  // clock arithmetic with its own (potentially skewed) clock.
  const freshElapsedSec = Math.floor(
    (Date.now() - new Date(attempt.started_at).getTime()) / 1000
  );
  const freshSecondsRemaining = Math.max(test.time_limit_minutes * 60 - freshElapsedSec, 0);

  sendSuccess(res, {
    attempt_id: attempt.id,
    time_limit_minutes: test.time_limit_minutes,
    started_at: attempt.started_at,
    seconds_remaining: test.time_limit_minutes > 0 ? freshSecondsRemaining : null,
    resumed: false, // always a fresh start — never resume a stale attempt
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
router.post('/attempt/submit', authenticateStudent, requireRole('student'), testSubmitRateLimit, async (req: Request, res: Response) => {
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
  // Fetch test metadata + join subjects to get the subject name (tests store subject_id, not name)
  const { data: testMeta } = await supabaseAdmin
    .from('tests')
    .select('subject_id, term, school_id, class, title, exam_type, subjects(name)')
    .eq('id', attempt.test_id)
    .single();

  // Resolve subject name from the join
  const subjectName: string | null = (() => {
    if (!testMeta) return null;
    const subj = (testMeta as Record<string, unknown>).subjects;
    if (Array.isArray(subj)) return (subj[0] as { name?: string })?.name ?? null;
    if (subj && typeof subj === 'object') return (subj as { name?: string }).name ?? null;
    return null;
  })();

  if (testMeta && subjectName && totalMcqMarks > 0) {
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
          subject:     subjectName,
          score:       mcqScore,
          max_score:   totalMcqMarks,
          term:        normaliseTerm(testMeta.term) ?? testMeta.term,
          exam_type:   testMeta.exam_type ?? 'class_test',
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

  // ── Streak update (fire-and-forget) ─────────────────────────────────────────
  // Count a submitted test as a streak activity day.
  // This matches the app UI legend ("Test" contributes to streak) and prevents
  // streaks from not updating when teachers forget to toggle a flag.
  setImmediate(() => {
    (async () => {
      try {
        const { data: studentRow } = await supabaseAdmin
          .from('students')
          .select('full_name, parent_id')
          .eq('id', req.student!.id)
          .single();

        const studentName = (studentRow?.full_name as string) ?? '';
        const parentId = (studentRow?.parent_id as string | null) ?? null;

        const streakResult = await updateStreakWithMilestone(
          req.student!.id,
          'test',
          studentName,
          parentId
        );

        // Notify parent
        if (parentId && streakResult.current_streak > 0) {
          const parentTokens = await getTokensForUsers([parentId]);
          if (parentTokens.length > 0) {
            const streakMsg = ` 🔥 Streak: ${streakResult.current_streak} day${streakResult.current_streak !== 1 ? 's' : ''}!`;
            await sendPushMulticast(
              parentTokens,
              'Test Completed! 🎉',
              `${studentName} scored ${mcqScore}/${totalMcqMarks} on a test!${streakMsg}`,
              { type: 'test_result', test_id: String(attempt.test_id) }
            );
          }
        }
      } catch (err) {
        console.error('[tests] Post-submit streak/FCM failed:', err);
      }
    })();
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

  // Update each theory answer's marks_awarded — validate against question max marks
  for (const { question_id, marks_awarded } of theory_marks) {
    // Fetch question to verify marks_awarded doesn't exceed question max
    const { data: question } = await supabaseAdmin
      .from('test_questions')
      .select('marks')
      .eq('id', question_id)
      .maybeSingle()
      .then(async (res) => {
        if (res.data) return res;
        // Fallback to legacy questions table
        return supabaseAdmin.from('questions').select('marks').eq('id', question_id).maybeSingle();
      });

    if (question && marks_awarded > (question as { marks: number }).marks) {
      sendError(
        res,
        `Marks awarded (${marks_awarded}) cannot exceed question max marks (${(question as { marks: number }).marks}) for question ${question_id}`,
        400
      );
      return;
    }

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
        .select('subject, term, exam_type')
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
            term:        normaliseTerm(testMeta.term) ?? testMeta.term,
            exam_type:   testMeta.exam_type ?? 'class_test',
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

// ── GET /api/tests/results/by-test/:test_id ──────────────────────────────────
// IMPORTANT: this route MUST be defined before /results/:attempt_id so that
// Express doesn't greedily match "by-test" as an attempt_id parameter.
/**
 * Student fetches results for their most recent completed attempt on a test,
 * without needing to know the attempt_id upfront.
 * Used by the mobile app when navigating to a completed test from the list.
 */
router.get('/results/by-test/:test_id', authenticateStudent, requireRole('student'), async (req: Request, res: Response) => {
  const { test_id } = req.params;
  const studentId = req.student!.id;

  // Find the student's submitted attempt for this test
  const { data: attempt, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, test_id, mcq_score, total_score, is_submitted, submitted_at, started_at')
    .eq('test_id', test_id)
    .eq('student_id', studentId)
    .eq('is_submitted', true)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .single();

  if (aErr || !attempt) { sendError(res, 'No completed attempt found for this test', 404); return; }

  const attempt_id = attempt.id;

  // Fetch answers
  const { data: answers, error: ansErr } = await supabaseAdmin
    .from('student_answers')
    .select('question_id, selected_option, theory_answer, is_correct, marks_awarded')
    .eq('attempt_id', attempt_id);

  if (ansErr) { sendError(res, ansErr.message, 500); return; }

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
    const { data: tqData } = await supabaseAdmin
      .from('test_questions')
      .select('id, question_text, question_type, option_a, option_b, option_c, option_d, correct_option, marks')
      .in('id', questionIds);

    for (const q of (tqData ?? []) as QuestionDetail[]) {
      questionMap.set(q.id, q);
    }

    const missing = questionIds.filter((id: string) => !questionMap.has(id));
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
    exam_type:       z.enum(EXAM_TYPE_VALUES).default('class_test'),
    available_from:  z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
    available_until: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
    time_limit_minutes: z.number().int().min(1).optional().nullable(),
    shuffle_questions:  z.boolean().optional(),
    shuffle_options:    z.boolean().optional(),
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

  // Reject past dates
  const todayStr2 = new Date().toISOString().slice(0, 10);
  if (rest.date < todayStr2) {
    sendError(res, 'Test date cannot be in the past', 400);
    return;
  }

  // Normalise term to canonical underscore format (e.g. "Term 1" → "term_1", "term1" → "term_1")
  const normalisedTerm = normaliseTerm(rest.term) ?? rest.term;

  const { data: test, error: testErr } = await supabaseAdmin
    .from('tests')
    .insert({
      title:              rest.title,
      subject:            rest.subject,
      class:              class_name,
      section:            rest.section,
      term:               normalisedTerm,
      date:               rest.date,
      exam_type:          rest.exam_type ?? 'class_test',
      available_from:     rest.available_from ?? null,
      available_until:    rest.available_until ?? null,
      time_limit_minutes: rest.time_limit_minutes ?? null,
      shuffle_questions:  rest.shuffle_questions ?? false,
      shuffle_options:    rest.shuffle_options ?? false,
      school_id:          req.user!.school_id,
      created_by:         req.user!.id,
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
router.delete('/:id', authenticate, requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const testId = req.params.id;

  // Verify the test belongs to this school before deleting
  const { data: testCheck, error: checkErr } = await supabaseAdmin
    .from('tests')
    .select('id')
    .eq('id', testId)
    .eq('school_id', req.user!.school_id ?? '')
    .maybeSingle();

  if (checkErr) { sendError(res, checkErr.message, 500); return; }
  if (!testCheck) { sendError(res, 'Test not found', 404); return; }

  // Delete child records in dependency order to avoid FK constraint violations:
  // 1. student_answers (references test_attempts)
  const { data: attempts } = await supabaseAdmin
    .from('test_attempts')
    .select('id')
    .eq('test_id', testId);

  if (attempts && attempts.length > 0) {
    const attemptIds = attempts.map((a: { id: string }) => a.id);
    await supabaseAdmin.from('student_answers').delete().in('attempt_id', attemptIds);
  }

  // 2. test_attempts (references tests)
  await supabaseAdmin.from('test_attempts').delete().eq('test_id', testId);

  // 3. test_restrictions (references tests)
  await supabaseAdmin.from('test_restrictions').delete().eq('test_id', testId);

  // 4. questions / test_questions (references tests)
  await supabaseAdmin.from('test_questions').delete().eq('test_id', testId);
  await supabaseAdmin.from('questions').delete().eq('test_id', testId);

  // 5. Finally delete the test itself
  const { error } = await supabaseAdmin
    .from('tests')
    .delete()
    .eq('id', testId);

  if (error) { sendError(res, error.message, 500); return; }

  await supabaseAdmin.from('audit_logs').insert({
    user_id:    req.user!.id,
    action:     'TEST_DELETED',
    table_name: 'tests',
    details:    { test_id: testId },
    created_at: new Date().toISOString(),
  });

  sendSuccess(res, null, 'Test deleted');
});

// ── GET /api/tests/:test_id/restrictions ─────────────────────────────────────
/**
 * Teacher gets the list of students blocked from a specific test.
 * Returns: all students in the class with a flag indicating if they are restricted.
 */
router.get('/:test_id/restrictions', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const { test_id } = req.params;

  // Verify test exists and teacher has access
  const { data: test, error: tErr } = await supabaseAdmin
    .from('tests')
    .select('id, class, section, school_id')
    .eq('id', test_id)
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
    if (!allowed) { sendError(res, 'You are not assigned to this class/section', 403); return; }
  }

  // Fetch all students in this class/section
  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name, roll_number')
    .eq('school_id', req.user!.school_id ?? '')
    .ilike('class_name', (test as Record<string, unknown>)['class'] as string)
    .ilike('section', test.section)
    .eq('is_deleted', false)
    .order('roll_number', { ascending: true });

  if (sErr) { sendError(res, sErr.message, 500); return; }

  // Fetch current restrictions for this test
  const { data: restrictions } = await supabaseAdmin
    .from('test_restrictions')
    .select('student_id')
    .eq('test_id', test_id);

  const restrictedIds = new Set((restrictions ?? []).map((r: { student_id: string }) => r.student_id));

  const result = (students ?? []).map((s: { id: string; full_name: string; roll_number: string }) => ({
    student_id: s.id,
    full_name: s.full_name,
    roll_number: s.roll_number,
    is_restricted: restrictedIds.has(s.id),
  }));

  sendSuccess(res, result);
});

// ── PUT /api/tests/:test_id/restrictions ──────────────────────────────────────
/**
 * Teacher sets the complete list of restricted students for a test.
 * Body: { blocked_student_ids: string[] }
 * This replaces the entire restriction list atomically.
 * Pass an empty array to remove all restrictions.
 */
router.put('/:test_id/restrictions', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const { test_id } = req.params;
  const { blocked_student_ids } = req.body as { blocked_student_ids?: string[] };

  if (!Array.isArray(blocked_student_ids)) {
    sendError(res, 'blocked_student_ids must be an array', 400);
    return;
  }

  // Verify test exists and teacher has access
  const { data: test, error: tErr } = await supabaseAdmin
    .from('tests')
    .select('id, class, section, school_id')
    .eq('id', test_id)
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
    if (!allowed) { sendError(res, 'You are not assigned to this class/section', 403); return; }
  }

  // Delete all existing restrictions for this test
  await supabaseAdmin
    .from('test_restrictions')
    .delete()
    .eq('test_id', test_id);

  // Insert new restrictions (if any)
  if (blocked_student_ids.length > 0) {
    const rows = blocked_student_ids.map((student_id) => ({
      test_id,
      student_id,
      created_by: req.user!.id,
    }));

    const { error: insErr } = await supabaseAdmin
      .from('test_restrictions')
      .insert(rows);

    if (insErr) {
      sendError(res, `Failed to save restrictions: ${insErr.message}`, 500);
      return;
    }
  }

  await logAudit(req.user!.id, 'TEST_RESTRICTIONS_UPDATED', {
    test_id,
    blocked_count: blocked_student_ids.length,
  });

  sendSuccess(res, { blocked_count: blocked_student_ids.length }, 'Test restrictions updated');
});
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
    .select('id, roll_number, full_name')
    .in('id', studentIds);

  if (sErr) { sendError(res, sErr.message, 500); return; }

  const studentMap = new Map(
    (students ?? []).map((s: { id: string; roll_number: string; full_name: string }) => {
      return [s.id, { roll_no: s.roll_number, name: s.full_name ?? 'Unknown' }];
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
    .select('id, roll_number, full_name')
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
    student_name: student?.full_name ?? 'Unknown',
    roll_no: student?.roll_number ?? '',
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
      tests!inner(subject, term, school_id, class, exam_type)
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
          term:        normaliseTerm(test.term as string | null) ?? (test.term as string),
          exam_type:   (test.exam_type as string) ?? 'class_test',
          notes:       noteTag,
          recorded_by: null,
        });
      inserted++;
    }
  }

  sendSuccess(res, { inserted, updated }, `Backfilled ${inserted} new and updated ${updated} existing marks records`);
});

// ── GET /api/tests/:test_id/results-summary ───────────────────────────────────
/**
 * Teacher views a full summary for a test:
 * - All students in the class/section with their attempt status & score
 * - Stats: total students, attempted, not attempted, highest score, lowest score, avg score
 */
router.get('/:test_id/results-summary', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const { test_id } = req.params;

  // Verify test exists and teacher has access
  const { data: test, error: tErr } = await supabaseAdmin
    .from('tests')
    .select('id, class, section, school_id, title, date, available_from, available_until')
    .eq('id', test_id)
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
    if (!allowed) { sendError(res, 'You are not assigned to this class/section', 403); return; }
  }

  // Fetch all students in the class/section
  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name, roll_number')
    .eq('school_id', req.user!.school_id ?? '')
    .ilike('class_name', (test as Record<string, unknown>)['class'] as string)
    .ilike('section', test.section)
    .eq('is_deleted', false)
    .order('roll_number', { ascending: true });

  if (sErr) { sendError(res, sErr.message, 500); return; }

  // Fetch all submitted attempts for this test
  const { data: attempts, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, student_id, mcq_score, total_score, submitted_at, is_submitted')
    .eq('test_id', test_id)
    .eq('is_submitted', true);

  if (aErr) { sendError(res, aErr.message, 500); return; }

  // Get max possible marks
  const { data: testQuestions } = await supabaseAdmin
    .from('test_questions')
    .select('marks')
    .eq('test_id', test_id);
  const maxScore = (testQuestions ?? []).reduce((sum: number, q: { marks: number }) => sum + Number(q.marks), 0);

  // Check pending theory for each attempt
  const { data: theoryAnswers } = await supabaseAdmin
    .from('student_answers')
    .select('attempt_id, marks_awarded')
    .in('attempt_id', (attempts ?? []).map((a) => a.id))
    .not('theory_answer', 'is', null);

  const theoryPendingMap = new Map<string, boolean>();
  for (const ans of (theoryAnswers ?? [])) {
    if (ans.marks_awarded === null) theoryPendingMap.set(ans.attempt_id, true);
  }

  const attemptMap = new Map<string, { score: number | null; submitted_at: string; theory_pending: boolean }>();
  for (const a of (attempts ?? [])) {
    const score = a.total_score ?? a.mcq_score;
    attemptMap.set(a.student_id, {
      score,
      submitted_at: a.submitted_at,
      theory_pending: theoryPendingMap.get(a.id) ?? false,
    });
  }

  // Build per-student rows
  const rows = (students ?? []).map((s: { id: string; full_name: string; roll_number: string }) => {
    const attempt = attemptMap.get(s.id);
    return {
      student_id: s.id,
      student_name: s.full_name,
      roll_no: s.roll_number,
      attempted: !!attempt,
      score: attempt?.score ?? null,
      max_score: maxScore,
      submitted_at: attempt?.submitted_at ?? null,
      theory_pending: attempt?.theory_pending ?? false,
    };
  });

  // Compute stats
  const attemptedRows = rows.filter((r) => r.attempted && r.score !== null);
  const scores = attemptedRows.map((r) => r.score as number);
  const highestScore = scores.length > 0 ? Math.max(...scores) : null;
  const lowestScore = scores.length > 0 ? Math.min(...scores) : null;
  const avgScore = scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;

  sendSuccess(res, {
    test_id,
    test_title: test.title,
    max_score: maxScore,
    total_students: rows.length,
    attempted_count: attemptedRows.length,
    not_attempted_count: rows.length - attemptedRows.length,
    highest_score: highestScore,
    lowest_score: lowestScore,
    avg_score: avgScore,
    students: rows,
  });
});

// ── GET /api/tests/:test_id/leaderboard ──────────────────────────────────────
/**
 * Student views the top 3 scorers for a test after the window has closed.
 * Only available after available_until has passed (or test date is past).
 * Returns anonymised rank, score, and first name only.
 */
router.get('/:test_id/leaderboard', authenticateStudent, requireRole('student'), async (req: Request, res: Response) => {
  const { test_id } = req.params;

  const studentRecord = {
    id: req.student!.id,
    class_name: req.student!.class_name,
    section: req.student!.section,
    school_id: req.student!.school_id,
  };

  // Fetch test
  const { data: test, error: tErr } = await supabaseAdmin
    .from('tests')
    .select('id, title, date, available_from, available_until, class, section, school_id')
    .eq('id', test_id)
    .eq('school_id', studentRecord.school_id)
    .single();

  if (tErr || !test) { sendError(res, 'Test not found', 404); return; }

  // Only expose leaderboard when window has closed or test date has passed
  // We compare server UTC date against the test date to decide
  const now = new Date();
  const testDate = new Date(test.date);
  // Strip time from both for date-only comparison
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const testDateOnly = new Date(testDate.getFullYear(), testDate.getMonth(), testDate.getDate());

  const isTestDatePast = todayDate > testDateOnly;
  const windowClosed = test.available_until
    ? (() => {
        // Only check window on same date
        if (todayDate.getTime() !== testDateOnly.getTime()) return isTestDatePast;
        const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        return nowHHMM > test.available_until;
      })()
    : isTestDatePast;

  if (!windowClosed) {
    sendError(res, 'Leaderboard is only available after the test window closes', 403);
    return;
  }

  // Fetch top 3 submitted attempts by score (total_score first, fallback to mcq_score)
  const { data: attempts, error: aErr } = await supabaseAdmin
    .from('test_attempts')
    .select('student_id, mcq_score, total_score')
    .eq('test_id', test_id)
    .eq('is_submitted', true);

  if (aErr) { sendError(res, aErr.message, 500); return; }

  if (!attempts || attempts.length === 0) {
    sendSuccess(res, { leaderboard: [], max_score: 0 });
    return;
  }

  // Get max possible marks
  const { data: testQuestions } = await supabaseAdmin
    .from('test_questions')
    .select('marks')
    .eq('test_id', test_id);
  const maxScore = (testQuestions ?? []).reduce((sum: number, q: { marks: number }) => sum + Number(q.marks), 0);

  // Sort by best score descending, take top 3
  const sorted = [...attempts]
    .map((a) => ({ student_id: a.student_id, score: (a.total_score ?? a.mcq_score ?? 0) as number }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // Fetch first names only (privacy)
  const studentIds = sorted.map((s) => s.student_id);
  const { data: students } = await supabaseAdmin
    .from('students')
    .select('id, full_name')
    .in('id', studentIds);

  const studentMap = new Map((students ?? []).map((s: { id: string; full_name: string }) => [s.id, s.full_name]));

  const leaderboard = sorted.map((entry, idx) => {
    const fullName = studentMap.get(entry.student_id) ?? 'Student';
    // Only expose first name for privacy
    const firstName = fullName.split(' ')[0];
    return {
      rank: idx + 1,
      first_name: firstName,
      score: entry.score,
      max_score: maxScore,
      is_self: entry.student_id === studentRecord.id,
    };
  });

  sendSuccess(res, { leaderboard, max_score: maxScore });
});

export default router;
