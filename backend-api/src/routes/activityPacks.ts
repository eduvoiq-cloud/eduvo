/**
 * /api/activity-packs â€” teacher-created daily learning activities
 *
 * Teacher endpoints:
 *   GET    /api/activity-packs/permission        â€” check if teacher has access
 *   POST   /api/activity-packs/generate          â€” Gemini: generate 5 home activities
 *   POST   /api/activity-packs                   â€” create a pack + send FCM to parents
 *   GET    /api/activity-packs                   â€” list own packs
 *   DELETE /api/activity-packs/:id               â€” delete own pack
 *   GET    /api/activity-packs/:id/completions   â€” view completion status
 *
 * Student / parent endpoints (student token):
 *   GET    /api/activity-packs/student/today     â€” today's packs for student's class
 *   POST   /api/activity-packs/:id/complete      â€” parent marks activities done
 *   GET    /api/activity-packs/student/history   â€” completion history
 *
 * Admin:
 *   GET    /api/activity-packs/school            â€” all packs for school
 *   GET    /api/activity-packs/admin/stats       â€” creation rate + completion rate by class
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { geminiRawWithFallback } from '../utils/geminiRaw';
import { getTokensForStudents, getTokensForUsers, sendPushMulticast } from '../services/fcmService';
import { updateStreakWithMilestone } from '../services/streakService';

const router = Router();

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Check teacher has activity pack creation permission.
 *  All teachers can create activity packs by default.
 *  A row with can_create_activity_packs = false is the only way to block a teacher.
 */
async function hasActivityPermission(teacherId: string, schoolId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('teacher_premium_access')
    .select('can_create_activity_packs')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .maybeSingle();
  // No row means unrestricted â€” only an explicit false blocks access
  if (data === null) return true;
  return (data as Record<string, unknown>).can_create_activity_packs !== false;
}

/**
 * Get all student IDs in a class/section.
 */
async function getAllStudentsInClass(
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
  return students.map((s: { id: string }) => s.id);
}

/** Age range for a class 1-6 student in India. */
function classToAge(cls: string): string {
  const num = parseInt(cls.replace(/\D/g, ''), 10);
  if (isNaN(num)) return '6-12';
  const age = 5 + num; // Class 1 â‰ˆ 6 yrs, Class 6 â‰ˆ 11 yrs
  return `${age}-${age + 1}`;
}

// Streak updates are handled by the shared streakService (see services/streakService.ts)

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TEACHER ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// GET /api/activity-packs/permission
router.get(
  '/permission',
  authenticate,
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    try {
    const teacherId = req.user!.id;
    const schoolId = req.user!.school_id!;
    const allowed = await hasActivityPermission(teacherId, schoolId);
    sendSuccess(res, { can_create_activity_packs: allowed });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// POST /api/activity-packs/generate â€” Gemini generates home activities
// Supports image/PDF upload via base64 for content-based activity generation
router.post(
  '/generate',
  authenticate,
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      class: z.string().min(1),
      subject: z.string().min(1),
      topic: z.string().min(1),
      board: z.enum(['GSEB', 'CBSE', 'ICSE', 'Other']).optional().default('CBSE'),
      chapter: z.string().optional().default(''),
      count: z.number().int().min(1).max(10).optional().default(5),
      language: z.enum(['English', 'Gujarati', 'Hindi', 'Sanskrit', 'Marathi', 'Tamil', 'Telugu', 'Kannada', 'Bengali', 'Punjabi']).optional().default('English'),
      // Image/PDF upload â€” base64 encoded content + mime type
      file_data: z.string().optional(),   // base64 encoded file
      file_mime: z.string().optional(),   // e.g. 'image/jpeg', 'image/png', 'application/pdf'
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const teacherId = req.user!.id;
    const schoolId = req.user!.school_id!;

    const allowed = await hasActivityPermission(teacherId, schoolId);
    if (!allowed) {
      sendError(res, 'You do not have permission to create activity packs', 403);
      return;
    }

    const { class: cls, subject, topic, board, chapter, count, language, file_data, file_mime } = parsed.data;

    // Reject files that are too large (base64 string > ~7.5MB â‰ˆ ~5.6MB raw file)
    if (file_data && file_data.length > 7_500_000) {
      sendError(res, 'File is too large. Please upload an image or PDF smaller than 5 MB.', 413);
      return;
    }

    const age = classToAge(cls);

    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '';
    if (!apiKey) {
      sendError(res, 'AI generation is not configured', 503);
      return;
    }

    const chapterLine = chapter ? `Chapter/Unit: '${chapter}'` : '';
    const boardContext = board === 'GSEB'
      ? 'Gujarat State Education Board (GSEB) curriculum'
      : board === 'ICSE'
      ? 'ICSE curriculum'
      : board === 'CBSE'
      ? 'CBSE (Central Board of Secondary Education) curriculum'
      : 'Indian school curriculum';

    // Language instruction â€” be explicit so non-English outputs are actually in that script/language
    const languageInstruction = language === 'English'
      ? 'Write all activity instructions in English.'
      : language === 'Gujarati'
      ? 'Write all activity instructions in Gujarati language using Gujarati script (e.g. àª—à«àªœàª°àª¾àª¤à«€). Do NOT write in English or transliteration.'
      : language === 'Hindi'
      ? 'Write all activity instructions in Hindi language using Devanagari script (e.g. à¤¹à¤¿à¤‚à¤¦à¥€). Do NOT write in English or transliteration.'
      : language === 'Sanskrit'
      ? 'Write all activity instructions in Sanskrit language using Devanagari script. Do NOT write in English or transliteration.'
      : language === 'Marathi'
      ? 'Write all activity instructions in Marathi language using Devanagari script (e.g. à¤®à¤°à¤¾à¤ à¥€). Do NOT write in English or transliteration.'
      : language === 'Tamil'
      ? 'Write all activity instructions in Tamil language using Tamil script (e.g. à®¤à®®à®¿à®´à¯). Do NOT write in English or transliteration.'
      : language === 'Telugu'
      ? 'Write all activity instructions in Telugu language using Telugu script (e.g. à°¤à±†à°²à±à°—à±). Do NOT write in English or transliteration.'
      : language === 'Kannada'
      ? 'Write all activity instructions in Kannada language using Kannada script (e.g. à²•à²¨à³à²¨à²¡). Do NOT write in English or transliteration.'
      : language === 'Bengali'
      ? 'Write all activity instructions in Bengali language using Bengali script (e.g. à¦¬à¦¾à¦‚à¦²à¦¾). Do NOT write in English or transliteration.'
      : language === 'Punjabi'
      ? 'Write all activity instructions in Punjabi language using Gurmukhi script (e.g. à¨ªà©°à¨œà¨¾à¨¬à©€). Do NOT write in English or transliteration.'
      : 'Write all activity instructions in English.';

    const fileContext = file_data
      ? ' Use the provided image/document as the primary source for the activities.'
      : '';

    const prompt = `You are an expert Indian school teacher creating home activities for parents.
Create exactly ${count} home activities for a Class ${cls} student (age ~${age}) following the ${boardContext}.
Topic taught today: '${topic}' (Subject: ${subject})${chapterLine ? `. ${chapterLine}` : ''}.${fileContext}

IMPORTANT LANGUAGE REQUIREMENT: ${languageInstruction}

Each activity must:
- Take 3-5 minutes (total ~${count * 3}-${count * 5} minutes)
- Be done WITH the parent at home
- Use common household items or verbal interaction only
- Be framed as fun, not a test
- Directly reinforce the specific topic '${topic}'${chapter ? ` from ${chapter}` : ''}
- Be age-appropriate for a ${age} year old
- Align with the ${board} curriculum approach for ${subject}

type must be one of: "verbal", "written", "physical"`;

    const modelName = process.env.GEMINI_MODEL_QUESTIONS ?? 'gemini-2.5-flash-lite';
    // Flash Lite is fast and cheap for activity generation.
    // Falls back to full Flash (GEMINI_MODEL) if Lite is overloaded.
    // Override via GEMINI_MODEL_QUESTIONS if needed.

    // Structured output schema â€” keep simple (no nested enum) for compatibility
    // with gemini-2.0-flash. Type values are validated/normalised below anyway.
    const responseSchema = {
      type: 'object' as const,
      properties: {
        activities: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              instruction: { type: 'string' as const },
              type:        { type: 'string' as const },
            },
            required: ['instruction', 'type'],
          },
        },
      },
      required: ['activities'],
    };

    try {
      const fallbackModelName = modelName; // never escalate to flash � flash-lite has thinking OFF, flash has thinking ON by default

      const contentParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
        { text: prompt },
      ];
      if (file_data && file_mime) {
        contentParts.push({ inlineData: { mimeType: file_mime, data: file_data } });
      }

      // Uses raw REST API â€” thinkingBudget:0 is guaranteed to reach the API
      const rawResult = await geminiRawWithFallback(modelName, fallbackModelName, {
        apiKey,
        parts: contentParts,
        responseSchema: responseSchema as Record<string, unknown>,
        disableThinking: true,
      });

      let parsed2: { activities: Array<{ instruction: string; type: string }> } | null = null;
      try {
        parsed2 = JSON.parse(rawResult.text.trim());
      } catch {
        sendError(res, 'AI returned invalid format. Please try again.', 500);
        return;
      }

      if (!parsed2 || !Array.isArray(parsed2.activities) || parsed2.activities.length === 0) {
        sendError(res, 'AI did not return valid activities. Please try again.', 500);
        return;
      }

      // Normalise: cap at requested count, ensure valid type
      const validTypes = new Set(['verbal', 'written', 'physical']);
      const activities = parsed2.activities.slice(0, count).map((a) => ({
        instruction: a.instruction,
        type: validTypes.has(a.type) ? a.type : 'verbal',
      }));

      sendSuccess(res, { activities }, 'Activities generated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log full error so Railway logs show the actual Gemini failure reason
      console.error('[activity-packs/generate] Gemini error:', err);

      // Quota exhausted
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')) {
        sendError(res, 'AI quota limit reached. Please try again later or contact support.', 429);
        return;
      }

      // Invalid / missing API key â€” be specific, don't match '400' broadly
      if (
        msg.includes('API_KEY_INVALID') ||
        msg.includes('API key not valid') ||
        msg.includes('invalid api key') ||
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('401') ||
        msg.includes('403')
      ) {
        console.error('[activity-packs/generate] Gemini API key rejected â€” check GEMINI_API_KEY in Railway env vars');
        sendError(res, 'AI service is misconfigured. Please contact support.', 503);
        return;
      }

      sendError(res, 'Failed to generate activities. Please try again.', 500);
    }
  }
);

// POST /api/activity-packs â€” create pack + insert completions + FCM
router.post('/', authenticate, requireRole('teacher'), async (req: Request, res: Response) => {
  try {
  const activitySchema = z.object({
    instruction: z.string().min(1),
    type: z.enum(['verbal', 'written', 'physical']),
  });

  const schema = z.object({
    class: z.string().min(1),
    section: z.string().min(1),
    subject: z.string().min(1),
    topic: z.string().min(1),
    activity_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    activities: z.array(activitySchema).min(1).max(10),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id!;

  const allowed = await hasActivityPermission(teacherId, schoolId);
  if (!allowed) {
    sendError(res, 'You do not have permission to create activity packs', 403);
    return;
  }

  const { class: cls, section, subject, topic, activity_date, activities } = parsed.data;

  const { data, error } = await supabaseAdmin
    .from('activity_packs')
    .insert({
      school_id: schoolId,
      teacher_id: teacherId,
      class: cls,
      section,
      subject,
      topic,
      activities,
      activity_date,
    })
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  const pack = data as Record<string, unknown>;

  // Fire-and-forget: insert activity_completions for all students in class + FCM
  setImmediate(() => {
    (async () => {
      try {
        const allStudentIds = await getAllStudentsInClass(schoolId, cls, section);

        if (allStudentIds.length > 0) {
          // Insert a pending completion row for each student
          const completionRows = allStudentIds.map((studentId: string) => ({
            activity_pack_id: pack.id,
            student_id: studentId,
            parent_marked_complete: false,
            reading_minutes: null,
            completed_at: null,
          }));

          await supabaseAdmin.from('activity_completions').insert(completionRows);

          // Notify parents of those students
          const { data: parentRows } = await supabaseAdmin
            .from('students')
            .select('parent_id')
            .in('id', allStudentIds)
            .not('parent_id', 'is', null);

          const parentIds = (parentRows ?? [])
            .map((s: { parent_id: string | null }) => s.parent_id)
            .filter((id): id is string => !!id);

          if (parentIds.length > 0) {
            const parentTokens = await getTokensForUsers(parentIds);
            if (parentTokens.length > 0) {
              await sendPushMulticast(
                parentTokens,
                "Today's home activity is ready! ðŸŽ¯",
                `${subject} activity on "${topic}" for Class ${cls} is now available.`,
                { type: 'activity_pack', pack_id: String(pack.id) }
              );
            }
          }

          console.log(`[activity-packs] Pack ${pack.id} sent to ${allStudentIds.length} students, notified ${parentIds.length} parents`);
        }
      } catch (err) {
        console.error('[activity-packs] Failed to create completions or send FCM:', err);
      }
    })();
  });

  sendSuccess(res, data, 'Activity pack created', 201);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// GET /api/activity-packs â€” teacher's own packs
router.get('/', authenticate, requireRole('teacher'), async (req: Request, res: Response) => {
  try {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id!;
  const date = req.query.date as string | undefined;

  let query = supabaseAdmin
    .from('activity_packs')
    .select('id, class, section, subject, topic, activity_date, created_at')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .order('activity_date', { ascending: false });

  if (date) query = query.eq('activity_date', date);

  const { data, error } = await query;
  if (error) { sendError(res, error.message, 500); return; }

  sendSuccess(res, data ?? []);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// GET /api/activity-packs/school â€” admin view
router.get(
  '/school',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    try {
    const schoolId = req.user!.school_id!;
    const cls = req.query.class as string | undefined;
    const section = req.query.section as string | undefined;
    const date = req.query.date as string | undefined;

    let query = supabaseAdmin
      .from('activity_packs')
      .select(
        `id, class, section, subject, topic, activity_date, created_at,
         users ( id, name )`
      )
      .eq('school_id', schoolId)
      .order('activity_date', { ascending: false });

    if (cls) query = query.eq('class', cls);
    if (section) query = query.eq('section', section);
    if (date) query = query.eq('activity_date', date);

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// GET /api/activity-packs/admin/stats â€” creation rate by teacher, completion rate by class
router.get(
  '/admin/stats',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    try {
    const schoolId = req.user!.school_id!;
    const today = new Date().toISOString().slice(0, 10);

    // Packs created today
    const { count: todayCount } = await supabaseAdmin
      .from('activity_packs')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('activity_date', today);

    // Class-wise completion rate for today
    const { data: todayPacks } = await supabaseAdmin
      .from('activity_packs')
      .select('id, class, section')
      .eq('school_id', schoolId)
      .eq('activity_date', today);

    const classStats: Record<string, { total: number; completed: number }> = {};

    if (todayPacks && todayPacks.length > 0) {
      const packIds = (todayPacks as Array<{ id: string; class: string; section: string }>).map((p) => p.id);

      const { data: completions } = await supabaseAdmin
        .from('activity_completions')
        .select('activity_pack_id, parent_marked_complete')
        .in('activity_pack_id', packIds);

      for (const pack of (todayPacks as Array<{ id: string; class: string; section: string }>)) {
        const key = `${pack.class} ${pack.section}`;
        if (!classStats[key]) classStats[key] = { total: 0, completed: 0 };

        const packCompletions = (completions ?? []).filter(
          (c: { activity_pack_id: string; parent_marked_complete: boolean }) =>
            c.activity_pack_id === pack.id
        );
        classStats[key].total += packCompletions.length;
        classStats[key].completed += packCompletions.filter(
          (c: { parent_marked_complete: boolean }) => c.parent_marked_complete
        ).length;
      }
    }

    // Teachers inactive 3+ days (no activity pack in last 3 days)
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);

    const { data: activeTeachers } = await supabaseAdmin
      .from('activity_packs')
      .select('teacher_id')
      .eq('school_id', schoolId)
      .gte('activity_date', threeDaysAgoStr);

    const activeTeacherIds = new Set(
      (activeTeachers ?? []).map((t: { teacher_id: string }) => t.teacher_id)
    );

    // List all teachers in the school to find inactive ones
    const { data: allTeacherRows } = await supabaseAdmin
      .from('users')
      .select('id, name')
      .eq('school_id', schoolId)
      .eq('role', 'teacher');

    type TeacherRow = { id: string; name: string };
    const rawTeachers = (allTeacherRows ?? []) as TeacherRow[];
    const inactiveTeachers = rawTeachers
      .filter((row) => !activeTeacherIds.has(row.id))
      .map((row) => ({
        teacher_id: row.id,
        teacher_name: row.name ?? 'Unknown',
      }));

    sendSuccess(res, {
      packs_created_today: todayCount ?? 0,
      class_completion: classStats,
      inactive_teachers: inactiveTeachers,
    });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// DELETE /api/activity-packs/:id
router.delete('/:id', authenticate, requireRole('teacher'), async (req: Request, res: Response) => {
  try {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id!;

  const { data: pack } = await supabaseAdmin
    .from('activity_packs')
    .select('id, teacher_id')
    .eq('id', req.params.id)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!pack) { sendError(res, 'Activity pack not found', 404); return; }
  if ((pack as Record<string, unknown>).teacher_id !== teacherId) {
    sendError(res, 'You can only delete your own activity packs', 403);
    return;
  }

  const { error } = await supabaseAdmin
    .from('activity_packs')
    .delete()
    .eq('id', req.params.id);

  if (error) { sendError(res, error.message, 500); return; }

  sendSuccess(res, { id: req.params.id }, 'Activity pack deleted');
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// GET /api/activity-packs/:id/completions â€” teacher views completion status
router.get(
  '/:id/completions',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    try {
    const schoolId = req.user!.school_id!;

    const { data: pack } = await supabaseAdmin
      .from('activity_packs')
      .select('id')
      .eq('id', req.params.id)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!pack) { sendError(res, 'Activity pack not found', 404); return; }

    const { data, error } = await supabaseAdmin
      .from('activity_completions')
      .select(
        `id, parent_marked_complete, reading_minutes, completed_at, created_at,
         students ( id, full_name, class_name, section )`
      )
      .eq('activity_pack_id', req.params.id)
      .order('completed_at', { ascending: false });

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STUDENT / PARENT ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// GET /api/activity-packs/student/today â€” today's packs (student token)
router.get(
  '/student/today',
  authenticateStudent,
  async (req: Request, res: Response) => {
    try {
    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;
    const className = req.student!.class_name ?? '';
    const section = req.student!.section ?? '';

    const today = new Date().toISOString().slice(0, 10);

    const { data: packs, error: packsErr } = await supabaseAdmin
      .from('activity_packs')
      .select('id, subject, topic, activity_date, activities, class, section')
      .eq('school_id', schoolId)
      .eq('class', className)
      .eq('section', section)
      .eq('activity_date', today);

    if (packsErr) { sendError(res, packsErr.message, 500); return; }

    if (!packs || packs.length === 0) {
      sendSuccess(res, []);
      return;
    }

    const packIds = packs.map((p: Record<string, unknown>) => p.id);

    const { data: completions } = await supabaseAdmin
      .from('activity_completions')
      .select('activity_pack_id, parent_marked_complete, reading_minutes, completed_at')
      .eq('student_id', studentId)
      .in('activity_pack_id', packIds);

    const completionMap = new Map<string, Record<string, unknown>>();
    for (const c of completions ?? []) {
      completionMap.set(
        (c as Record<string, unknown>).activity_pack_id as string,
        c as Record<string, unknown>
      );
    }

    const result = (packs as Record<string, unknown>[]).map((p) => ({
      ...p,
      completion: completionMap.get(p.id as string) ?? null,
    }));

    sendSuccess(res, result);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// POST /api/activity-packs/:id/complete â€” parent marks done (student token)
router.post(
  '/:id/complete',
  authenticateStudent,
  async (req: Request, res: Response) => {
    try {
    const schema = z.object({
      reading_minutes: z.number().min(0).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;

    // Verify pack exists for this student's school
    const { data: pack } = await supabaseAdmin
      .from('activity_packs')
      .select('id, class, section, subject, topic')
      .eq('id', req.params.id)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!pack) { sendError(res, 'Activity pack not found', 404); return; }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    const { data: completion, error: upsertErr } = await supabaseAdmin
      .from('activity_completions')
      .upsert(
        {
          activity_pack_id: req.params.id,
          student_id: studentId,
          parent_marked_complete: true,
          reading_minutes: parsed.data.reading_minutes ?? null,
          completed_at: now,
        },
        { onConflict: 'activity_pack_id,student_id' }
      )
      .select()
      .single();

    if (upsertErr) { sendError(res, upsertErr.message, 500); return; }

    // Update streak using the shared service
    // We need studentName + parentId for milestone notifications â€” fetch them
    const { data: studentRow } = await supabaseAdmin
      .from('students')
      .select('full_name, parent_id')
      .eq('id', studentId)
      .maybeSingle();

    const studentName = (studentRow as Record<string, unknown> | null)?.full_name as string ?? '';
    const parentId = (studentRow as Record<string, unknown> | null)?.parent_id as string | null ?? null;

    const streakResult = await updateStreakWithMilestone(
      studentId,
      'activity_pack',
      studentName,
      parentId
    );
    const newStreak = streakResult.current_streak;

    // Fire-and-forget: notify the parent
    setImmediate(() => {
      (async () => {
        try {
          if (!studentRow) return;

          if (parentId) {
            const parentTokens = await getTokensForUsers([parentId]);
            if (parentTokens.length > 0) {
              await sendPushMulticast(
                parentTokens,
                `Great job! ðŸŒŸ`,
                `${studentName}'s streak is now ${newStreak} day${newStreak !== 1 ? 's' : ''}! Keep it up!`,
                { type: 'activity_complete', pack_id: String(req.params.id), streak: String(newStreak) }
              );
            }
          }
        } catch (err) {
          console.error('[activity-packs] Failed to send completion FCM to parent:', err);
        }
      })();
    });

    sendSuccess(res, { ...completion, streak: newStreak }, 'Activity marked as complete');
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// GET /api/activity-packs/student/history â€” student's completion history
router.get(
  '/student/history',
  authenticateStudent,
  async (req: Request, res: Response) => {
    try {
    const studentId = req.student!.id;

    const rawLimit = parseInt((req.query.limit as string) ?? '20', 10);
    const limit = isNaN(rawLimit) ? 20 : Math.min(rawLimit, 100);

    const { data, error } = await supabaseAdmin
      .from('activity_completions')
      .select(
        `id, parent_marked_complete, reading_minutes, completed_at, created_at,
         activity_packs ( id, subject, topic, activity_date, class, section )`
      )
      .eq('student_id', studentId)
      .order('completed_at', { ascending: false })
      .limit(limit);

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

export default router;
