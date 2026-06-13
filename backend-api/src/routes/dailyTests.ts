/**
 * /api/daily-tests — Premium feature: teacher-created daily tests for students
 *
 * Teacher endpoints (require teacher_premium_access.can_create_daily_tests):
 *   GET    /api/daily-tests/permission   — check if teacher has daily test access
 *   POST   /api/daily-tests/generate     — AI-generate 10 MCQ questions from a topic
 *   POST   /api/daily-tests              — create & assign a daily test (inserts attempts + sends FCM)
 *   GET    /api/daily-tests              — list tests created by this teacher
 *   GET    /api/daily-tests/:id          — get test with questions
 *   DELETE /api/daily-tests/:id          — delete own test
 *   GET    /api/daily-tests/:id/results  — view all attempt results
 *
 * Student endpoints (student token, must be active premium_senior):
 *   GET    /api/daily-tests/student/today    — today's tests for student's class
 *   POST   /api/daily-tests/:id/attempt      — submit answers + streak + FCM to parent
 *   GET    /api/daily-tests/student/history  — student's attempt history
 *
 * Admin read-only:
 *   GET    /api/daily-tests/school       — all tests for school (schooladmin/superadmin)
 *   GET    /api/daily-tests/admin/stats  — daily test stats for dashboard widget
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getTokensForStudents, getTokensForUsers, sendPushMulticast } from '../services/fcmService';
import { updateStreakWithMilestone } from '../services/streakService';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Check that student has an active, non-expired premium subscription (any plan). */
async function requirePremium(studentId: string, schoolId: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabaseAdmin
    .from('parent_subscriptions')
    .select('id')
    .eq('student_id', studentId)
    .eq('school_id', schoolId)
    .eq('status', 'active')
    .or(`expires_at.is.null,expires_at.gte.${today}`)
    .maybeSingle();
  return data !== null;
}

/** Check teacher has daily test creation permission.
 *  If no explicit row exists, access is granted by default.
 *  A row with can_create_daily_tests = false is the only way to block a teacher.
 */
async function hasTestPermission(teacherId: string, schoolId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('teacher_premium_access')
    .select('can_create_daily_tests')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .maybeSingle();
  // No row means unrestricted — only an explicit false blocks access
  if (data === null) return true;
  return (data as Record<string, unknown>).can_create_daily_tests !== false;
}

/**
 * Get all student IDs in a class/section that have an active, non-expired premium_senior subscription.
 * Classes 7–12 → plan_type = 'premium_senior'.
 */
async function getPremiumSeniorStudents(
  schoolId: string,
  className: string,
  section: string
): Promise<string[]> {
  const { data: students } = await supabaseAdmin
    .from('students')
    .select('id')
    .eq('school_id', schoolId)
    .ilike('class_name', className)
    .ilike('section', section)
    .eq('is_deleted', false);

  if (!students || students.length === 0) return [];

  const studentIds = students.map((s: { id: string }) => s.id);
  const today = new Date().toISOString().slice(0, 10);

  const { data: subs } = await supabaseAdmin
    .from('parent_subscriptions')
    .select('student_id')
    .eq('school_id', schoolId)
    .eq('status', 'active')
    .eq('plan_type', 'premium_senior')
    .or(`expires_at.is.null,expires_at.gte.${today}`)
    .in('student_id', studentIds);

  return (subs ?? []).map((s: { student_id: string }) => s.student_id);
}

// Streak updates are handled by the shared streakService (see services/streakService.ts)

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/daily-tests/permission  — check if this teacher can create daily tests
router.get(
  '/permission',
  authenticate,
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    const teacherId = req.user!.id;
    const schoolId = req.user!.school_id!;
    const allowed = await hasTestPermission(teacherId, schoolId);
    sendSuccess(res, { can_create_daily_tests: allowed });
  }
);

// POST /api/daily-tests/generate  — call Gemini to generate 10 MCQ questions
router.post(
  '/generate',
  authenticate,
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      class: z.string().min(1),
      subject: z.string().min(1),
      topic: z.string().min(1),
      board: z.string().optional().default('GSEB'),
      language: z.enum(['English', 'Gujarati', 'Hindi', 'Sanskrit', 'Marathi', 'Tamil', 'Telugu', 'Kannada', 'Bengali', 'Punjabi']).optional().default('English'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const teacherId = req.user!.id;
    const schoolId = req.user!.school_id!;

    const allowed = await hasTestPermission(teacherId, schoolId);
    if (!allowed) {
      sendError(res, 'You do not have permission to create daily tests', 403);
      return;
    }

    const { class: cls, subject, topic, board, language } = parsed.data;

    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '';
    if (!apiKey) {
      sendError(res, 'AI generation is not configured', 503);
      return;
    }

    // Language instruction — be explicit so non-English outputs are actually in that script/language
    const languageInstruction = language === 'English'
      ? 'Write all questions and options in English.'
      : language === 'Gujarati'
      ? 'Write all questions and options in Gujarati language using Gujarati script (e.g. ગુજરાતી). Do NOT write in English or transliteration.'
      : language === 'Hindi'
      ? 'Write all questions and options in Hindi language using Devanagari script (e.g. हिंदी). Do NOT write in English or transliteration.'
      : language === 'Sanskrit'
      ? 'Write all questions and options in Sanskrit language using Devanagari script. Do NOT write in English or transliteration.'
      : language === 'Marathi'
      ? 'Write all questions and options in Marathi language using Devanagari script (e.g. मराठी). Do NOT write in English or transliteration.'
      : language === 'Tamil'
      ? 'Write all questions and options in Tamil language using Tamil script (e.g. தமிழ்). Do NOT write in English or transliteration.'
      : language === 'Telugu'
      ? 'Write all questions and options in Telugu language using Telugu script (e.g. తెలుగు). Do NOT write in English or transliteration.'
      : language === 'Kannada'
      ? 'Write all questions and options in Kannada language using Kannada script (e.g. ಕನ್ನಡ). Do NOT write in English or transliteration.'
      : language === 'Bengali'
      ? 'Write all questions and options in Bengali language using Bengali script (e.g. বাংলা). Do NOT write in English or transliteration.'
      : language === 'Punjabi'
      ? 'Write all questions and options in Punjabi language using Gurmukhi script (e.g. ਪੰਜਾਬੀ). Do NOT write in English or transliteration.'
      : 'Write all questions and options in English.';

    const prompt = `You are an experienced ${subject} teacher for Class ${cls} following ${board} curriculum in India. Generate exactly 10 multiple choice questions for this topic taught today: '${topic}'.
Requirements:
- 4 easy, 4 medium, 2 hard questions
- Each question has exactly 4 options
- Mark correct answer index (0-3)
- One-line explanation per question
- Test understanding, not just recall
IMPORTANT LANGUAGE REQUIREMENT: ${languageInstruction}`;

    const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

    // Structured output schema — guarantees well-formed JSON from the model
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

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
        } as Record<string, unknown>,
      });

      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim();

      let parsed2: { questions: Array<{
        question: string;
        options: string[];
        correct_index: number;
        explanation: string;
        difficulty: string;
      }> };

      try {
        parsed2 = JSON.parse(raw);
      } catch {
        sendError(res, 'AI returned invalid format. Please try again.', 500);
        return;
      }

      if (!Array.isArray(parsed2.questions) || parsed2.questions.length === 0) {
        sendError(res, 'AI did not return valid questions. Please try again.', 500);
        return;
      }

      // Normalise to the daily_tests JSONB format
      const questions = parsed2.questions.map((q) => ({
        question_text: q.question,
        options: q.options,
        correct_index: q.correct_index,
        explanation: q.explanation ?? '',
        difficulty: q.difficulty ?? 'medium',
        marks: 1,
      }));

      sendSuccess(res, { questions }, 'Questions generated');
    } catch (err) {
      console.error('[daily-tests/generate] Gemini error:', err);
      sendError(res, 'Failed to generate questions. Please try again.', 500);
    }
  }
);

// POST /api/daily-tests  — create & assign a daily test
router.post('/', authenticate, requireRole('teacher'), async (req: Request, res: Response) => {
  const schema = z.object({
    class: z.string().min(1),
    section: z.string().min(1),
    subject: z.string().min(1),
    topic: z.string().min(1),
    test_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    questions: z
      .array(
        z.object({
          question_text: z.string().min(1),
          options: z.array(z.string()).length(4),
          correct_index: z.number().min(0).max(3),
          explanation: z.string().optional().default(''),
          difficulty: z.string().optional().default('medium'),
          marks: z.number().positive().optional().default(1),
        })
      )
      .min(1)
      .max(30),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id!;

  const allowed = await hasTestPermission(teacherId, schoolId);
  if (!allowed) {
    sendError(res, 'You do not have permission to create daily tests', 403);
    return;
  }

  const { class: cls, section, subject, topic, test_date, questions } = parsed.data;

  // Insert the daily test
  const { data: test, error: testErr } = await supabaseAdmin
    .from('daily_tests')
    .insert({
      school_id: schoolId,
      teacher_id: teacherId,
      class: cls,
      section,
      subject,
      topic,
      questions,
      test_date,
    })
    .select()
    .single();

  if (testErr || !test) { sendError(res, testErr?.message ?? 'Failed to create test', 500); return; }

  // Fire-and-forget: insert pending attempts + send FCM
  setImmediate(() => {
    (async () => {
      try {
        // Get all premium_senior students in this class/section
        const premiumStudentIds = await getPremiumSeniorStudents(schoolId, cls, section);

        if (premiumStudentIds.length > 0) {
          // Insert a pending attempt row for each eligible student
          const attemptRows = premiumStudentIds.map((studentId: string) => ({
            daily_test_id: (test as Record<string, unknown>).id,
            student_id: studentId,
            answers: {},
            score: null,
            total_questions: questions.length,
            status: 'pending',
          }));

          await supabaseAdmin.from('daily_test_attempts').insert(attemptRows);

          // Send FCM push to those students
          const tokens = await getTokensForStudents(premiumStudentIds);
          if (tokens.length > 0) {
            await sendPushMulticast(
              tokens,
              `Today's ${subject} Test is Ready! 📝`,
              `Your ${subject} daily test on "${topic}" is ready. Tap to start!`,
              { type: 'daily_test', test_id: String((test as Record<string, unknown>).id) }
            );
          }

          // Also notify parents of those students
          const { data: parentRows } = await supabaseAdmin
            .from('students')
            .select('parent_id')
            .in('id', premiumStudentIds)
            .not('parent_id', 'is', null);

          const parentIds = (parentRows ?? [])
            .map((s: { parent_id: string | null }) => s.parent_id)
            .filter((id): id is string => !!id);

          if (parentIds.length > 0) {
            const parentTokens = await getTokensForUsers(parentIds);
            if (parentTokens.length > 0) {
              await sendPushMulticast(
                parentTokens,
                `Daily ${subject} Test Assigned`,
                `Your child's ${subject} daily test on "${topic}" is now available.`,
                { type: 'daily_test', test_id: String((test as Record<string, unknown>).id) }
              );
            }
          }

          console.log(`[daily-tests] Assigned test ${(test as Record<string, unknown>).id} to ${premiumStudentIds.length} students, FCM sent to ${tokens.length} devices`);
        }
      } catch (err) {
        console.error('[daily-tests] Failed to assign attempts or send FCM:', err);
      }
    })();
  });

  sendSuccess(res, test, 'Daily test created', 201);
});

// GET /api/daily-tests  — teacher's own tests
router.get('/', authenticate, requireRole('teacher'), async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id!;
  const date = req.query.date as string | undefined;

  let query = supabaseAdmin
    .from('daily_tests')
    .select('id, class, section, subject, topic, test_date, created_at')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .order('test_date', { ascending: false });

  if (date) query = query.eq('test_date', date);

  const { data, error } = await query;
  if (error) { sendError(res, error.message, 500); return; }

  sendSuccess(res, data ?? []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES  (must be before /:id to avoid param capture)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/daily-tests/school  — admin view
router.get(
  '/school',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;
    const cls = req.query.class as string | undefined;
    const section = req.query.section as string | undefined;
    const date = req.query.date as string | undefined;

    let query = supabaseAdmin
      .from('daily_tests')
      .select(`id, class, section, subject, topic, test_date, created_at, users ( id, name )`)
      .eq('school_id', schoolId)
      .order('test_date', { ascending: false });

    if (cls) query = query.eq('class', cls);
    if (section) query = query.eq('section', section);
    if (date) query = query.eq('test_date', date);

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// GET /api/daily-tests/admin/stats  — dashboard widget data
router.get(
  '/admin/stats',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;
    const today = new Date().toISOString().slice(0, 10);

    // Tests created today
    const { count: todayCount } = await supabaseAdmin
      .from('daily_tests')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('test_date', today);

    // Class-wise completion rate for today
    const { data: todayTests } = await supabaseAdmin
      .from('daily_tests')
      .select('id, class, section')
      .eq('school_id', schoolId)
      .eq('test_date', today);

    const classStats: Record<string, { total: number; completed: number }> = {};

    if (todayTests && todayTests.length > 0) {
      const testIds = (todayTests as Array<{ id: string; class: string; section: string }>).map((t) => t.id);

      const { data: attempts } = await supabaseAdmin
        .from('daily_test_attempts')
        .select('daily_test_id, status')
        .in('daily_test_id', testIds);

      for (const test of (todayTests as Array<{ id: string; class: string; section: string }>)) {
        const key = `${test.class} ${test.section}`;
        if (!classStats[key]) classStats[key] = { total: 0, completed: 0 };

        const testAttempts = (attempts ?? []).filter(
          (a: { daily_test_id: string; status: string }) => a.daily_test_id === test.id
        );
        classStats[key].total += testAttempts.length;
        classStats[key].completed += testAttempts.filter(
          (a: { status: string }) => a.status === 'completed'
        ).length;
      }
    }

    // Teachers inactive 3+ days (no daily test created in 3 days)
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);

    const { data: activeTeachers } = await supabaseAdmin
      .from('daily_tests')
      .select('teacher_id')
      .eq('school_id', schoolId)
      .gte('test_date', threeDaysAgoStr);

    const activeTeacherIds = new Set(
      (activeTeachers ?? []).map((t: { teacher_id: string }) => t.teacher_id)
    );

    // Get all teachers with permission
    const { data: permissionRows } = await supabaseAdmin
      .from('teacher_premium_access')
      .select('teacher_id, users ( id, name )')
      .eq('school_id', schoolId)
      .eq('can_create_daily_tests', true);

    type PermRow = { teacher_id: string; users: { id: string; name: string } | null };
    const rawPerms = (permissionRows ?? []) as unknown as PermRow[];
    const inactiveTeachers = rawPerms
      .filter((row) => !activeTeacherIds.has(row.teacher_id))
      .map((row) => ({
        teacher_id: row.teacher_id,
        teacher_name: row.users?.name ?? 'Unknown',
      }));

    sendSuccess(res, {
      tests_created_today: todayCount ?? 0,
      class_completion: classStats,
      inactive_teachers: inactiveTeachers,
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED TEACHER ROUTES (must be after named routes above)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/daily-tests/:id  — get test with questions (teacher/admin)
router.get('/:id', authenticate, requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;

  const { data, error } = await supabaseAdmin
    .from('daily_tests')
    .select('*')
    .eq('id', req.params.id)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (error) { sendError(res, error.message, 500); return; }
  if (!data) { sendError(res, 'Test not found', 404); return; }

  sendSuccess(res, data);
});

// DELETE /api/daily-tests/:id
router.delete('/:id', authenticate, requireRole('teacher'), async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id!;

  const { data: test } = await supabaseAdmin
    .from('daily_tests')
    .select('id, teacher_id')
    .eq('id', req.params.id)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!test) { sendError(res, 'Test not found', 404); return; }
  if ((test as Record<string, unknown>).teacher_id !== teacherId) {
    sendError(res, 'You can only delete your own tests', 403);
    return;
  }

  const { error } = await supabaseAdmin
    .from('daily_tests')
    .delete()
    .eq('id', req.params.id);

  if (error) { sendError(res, error.message, 500); return; }

  sendSuccess(res, { id: req.params.id }, 'Test deleted');
});

// GET /api/daily-tests/:id/results  — teacher sees all attempts
router.get(
  '/:id/results',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;

    const { data: test } = await supabaseAdmin
      .from('daily_tests')
      .select('id')
      .eq('id', req.params.id)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!test) { sendError(res, 'Test not found', 404); return; }

    const { data, error } = await supabaseAdmin
      .from('daily_test_attempts')
      .select(`id, score, total_questions, status, completed_at, created_at,
               students ( id, full_name, class_name, section )`)
      .eq('daily_test_id', req.params.id)
      .order('score', { ascending: false });

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/daily-tests/student/today
router.get(
  '/student/today',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;
    const className = req.student!.class_name ?? '';
    const section = req.student!.section ?? '';

    const isPremium = await requirePremium(studentId, schoolId);
    if (!isPremium) {
      sendError(res, 'Premium subscription required', 403);
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    const { data: tests, error: testsErr } = await supabaseAdmin
      .from('daily_tests')
      .select('id, subject, topic, test_date, questions')
      .eq('school_id', schoolId)
      .ilike('class', className)
      .ilike('section', section)
      .eq('test_date', today);

    if (testsErr) { sendError(res, testsErr.message, 500); return; }

    if (!tests || tests.length === 0) {
      sendSuccess(res, []);
      return;
    }

    const testIds = (tests as Array<{ id: string }>).map((t) => t.id);

    const { data: attempts } = await supabaseAdmin
      .from('daily_test_attempts')
      .select('daily_test_id, status, score')
      .eq('student_id', studentId)
      .in('daily_test_id', testIds);

    const attemptMap = new Map<string, Record<string, unknown>>();
    for (const a of attempts ?? []) {
      attemptMap.set((a as Record<string, unknown>).daily_test_id as string, a as Record<string, unknown>);
    }

    // Strip correct_index + explanation from questions sent to student
    const sanitized = (tests as Record<string, unknown>[]).map((t) => {
      const questions = (t.questions as Record<string, unknown>[]).map((q) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { correct_index, explanation, ...rest } = q;
        return rest;
      });
      const attempt = attemptMap.get(t.id as string);
      return {
        ...t,
        questions,
        attempt_status: attempt ? (attempt.status as string) : 'pending',
        attempt_score: attempt ? (attempt.score as number | null) : null,
      };
    });

    sendSuccess(res, sanitized);
  }
);

// POST /api/daily-tests/:id/attempt  — submit answers (student token)
router.post(
  '/:id/attempt',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const schema = z.object({
      answers: z.array(
        z.object({
          question_index: z.number().min(0),
          selected_index: z.number().min(0).max(3),
        })
      ),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;

    const isPremium = await requirePremium(studentId, schoolId);
    if (!isPremium) {
      sendError(res, 'Premium subscription required', 403);
      return;
    }

    const { data: test, error: testErr } = await supabaseAdmin
      .from('daily_tests')
      .select('id, questions, school_id, class, section, subject, topic')
      .eq('id', req.params.id)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (testErr || !test) { sendError(res, 'Test not found', 404); return; }

    const testRecord = test as Record<string, unknown>;

    // Verify student belongs to this class/section
    const studentClass = req.student!.class_name ?? '';
    const studentSection = req.student!.section ?? '';
    if (
      (testRecord.class as string).toLowerCase() !== studentClass.toLowerCase() ||
      (testRecord.section as string).toLowerCase() !== studentSection.toLowerCase()
    ) {
      sendError(res, 'This test is not assigned to your class', 403);
      return;
    }

    const { data: existingAttempt } = await supabaseAdmin
      .from('daily_test_attempts')
      .select('id, status')
      .eq('daily_test_id', req.params.id)
      .eq('student_id', studentId)
      .maybeSingle();

    if (existingAttempt && (existingAttempt as Record<string, unknown>).status === 'completed') {
      sendError(res, 'You have already submitted this test', 409);
      return;
    }

    // Grade answers
    const questions = testRecord.questions as Record<string, unknown>[];
    const { answers } = parsed.data;

    let correctCount = 0;
    const gradedAnswers = answers.map((a) => {
      const q = questions[a.question_index];
      const isCorrect = q !== undefined && a.selected_index === (q.correct_index as number);
      if (isCorrect) correctCount++;
      return { ...a, is_correct: isCorrect };
    });

    const totalQuestions = questions.length;
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    let attempt: Record<string, unknown>;

    if (existingAttempt) {
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('daily_test_attempts')
        .update({
          answers: gradedAnswers,
          score: correctCount,
          total_questions: totalQuestions,
          status: 'completed',
          completed_at: now,
        })
        .eq('id', (existingAttempt as Record<string, unknown>).id)
        .select()
        .single();

      if (updateErr) { sendError(res, updateErr.message, 500); return; }
      attempt = updated as Record<string, unknown>;
    } else {
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('daily_test_attempts')
        .insert({
          daily_test_id: req.params.id,
          student_id: studentId,
          answers: gradedAnswers,
          score: correctCount,
          total_questions: totalQuestions,
          status: 'completed',
          completed_at: now,
        })
        .select()
        .single();

      if (insertErr) { sendError(res, insertErr.message, 500); return; }
      attempt = inserted as Record<string, unknown>;
    }

    // Build per-question results with explanations revealed
    const questionResults = questions.map((q, idx) => {
      const studentAnswer = answers.find((a) => a.question_index === idx);
      return {
        question_text: q.question_text as string,
        options: q.options as string[],
        selected_index: studentAnswer?.selected_index ?? null,
        correct_index: q.correct_index as number,
        is_correct: studentAnswer !== undefined && studentAnswer.selected_index === (q.correct_index as number),
        explanation: (q.explanation as string) ?? '',
        difficulty: (q.difficulty as string) ?? 'medium',
      };
    });

    // Fire-and-forget: update streak + notify parent + check milestones
    setImmediate(() => {
      (async () => {
        try {
          const { data: studentRow } = await supabaseAdmin
            .from('students')
            .select('full_name, parent_id')
            .eq('id', studentId)
            .single();

          const studentName = (studentRow?.full_name as string) ?? '';
          const parentId = (studentRow?.parent_id as string | null) ?? null;

          // Update streak using the shared service (includes freeze logic + milestone FCM)
          const streakResult = await updateStreakWithMilestone(
            studentId,
            'daily_test',
            studentName,
            parentId
          );

          // Notify parent of test completion + new streak
          if (parentId) {
            const parentTokens = await getTokensForUsers([parentId]);
            if (parentTokens.length > 0) {
              const streakMsg = streakResult.current_streak > 0
                ? ` 🔥 Streak: ${streakResult.current_streak} day${streakResult.current_streak !== 1 ? 's' : ''}!`
                : '';
              await sendPushMulticast(
                parentTokens,
                `Daily Test Completed! 🎉`,
                `${studentName} completed today's ${testRecord.subject} test — scored ${correctCount}/${totalQuestions}!${streakMsg}`,
                { type: 'daily_test_result', test_id: String(req.params.id) }
              );
            }
          }
        } catch (err) {
          console.error('[daily-tests] Post-submit FCM/streak failed:', err);
        }
      })();
    });

    sendSuccess(res, {
      attempt_id: attempt.id,
      score: correctCount,
      total_questions: totalQuestions,
      percentage: totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0,
      question_results: questionResults,
    }, 'Test submitted');
  }
);

// GET /api/daily-tests/student/history  — student's attempt history
router.get(
  '/student/history',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;

    const isPremium = await requirePremium(studentId, schoolId);
    if (!isPremium) {
      sendError(res, 'Premium subscription required', 403);
      return;
    }

    const rawLimit = parseInt((req.query.limit as string) ?? '20', 10);
    const limit = isNaN(rawLimit) ? 20 : Math.min(rawLimit, 100);

    const { data, error } = await supabaseAdmin
      .from('daily_test_attempts')
      .select(`id, score, total_questions, status, completed_at, created_at,
               daily_tests ( id, subject, topic, test_date, class, section )`)
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

export default router;
