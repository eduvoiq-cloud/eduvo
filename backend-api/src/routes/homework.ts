import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import * as admin from 'firebase-admin';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import rateLimit from 'express-rate-limit';

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPABASE_STORAGE_HOST = process.env.SUPABASE_URL ?? '';
const FCM_BATCH_SIZE = 100;
const FCM_BATCH_DELAY_MS = 100;

// ── Multer (memory storage — file streamed to Supabase Storage) ──────────────
const homeworkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype.toLowerCase();
    const allowedMimes = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]);
    if (allowedMimes.has(mime)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files (JPEG, PNG, WebP, GIF) are allowed.'));
    }
  },
});

// ── Rate limiter: max 20 homework posts per teacher per day ───────────────────
const createHomeworkRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20,
  keyGenerator: (req) => `hw_create:${req.user?.id ?? req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    success: false,
    message: 'Homework creation limit reached (20 per day). Try again tomorrow.',
  },
  skip: (req) => {
    const role = req.user?.role;
    return role === 'superadmin' || role === 'schooladmin';
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns today's date as YYYY-MM-DD (UTC). */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Format a YYYY-MM-DD date string as "DD MMM YYYY" (e.g. "29 May 2026"). */
function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(day).padStart(2, '0')} ${months[month - 1]} ${year}`;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate that a file_url is a Supabase Storage URL belonging to this project.
 * Accepts any URL that starts with the project's SUPABASE_URL + /storage/v1/object/
 * or is a signed URL from the same host.
 */
function isValidSupabaseStorageUrl(url: string): boolean {
  if (!SUPABASE_STORAGE_HOST) return true; // env not set — skip validation
  try {
    const parsed = new URL(url);
    const host = new URL(SUPABASE_STORAGE_HOST).host;
    return parsed.host === host && parsed.pathname.startsWith('/storage/v1/object/');
  } catch {
    return false;
  }
}

/**
 * Send FCM push notification to a single token.
 * Returns true on success, false on any error.
 */
async function sendFcmMessage(token: string, title: string, body: string): Promise<boolean> {
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    return true;
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code: string }).code
        : 'unknown';
    console.error(`[FCM] Failed to send to token (${code}):`, err);
    return false;
  }
}

/**
 * Send homework notifications to all students in a class in batches of 100.
 * Fire-and-forget — called via setImmediate() after homework is created.
 */
async function sendHomeworkNotifications(
  schoolId: string,
  className: string,
  section: string,
  homeworkId: string,
  homeworkTitle: string,
  subjectName: string,
  dueDate: string,
  senderId: string
): Promise<void> {
  const fcmEnabled = admin.apps.length > 0;
  const formattedDue = formatDate(dueDate);
  const notifTitle = 'New Homework';
  const notifBody = `New homework: ${homeworkTitle} for ${subjectName} due ${formattedDue}`;

  try {
    // Fetch all active students in this class/section
    const { data: students, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id, fcm_token')
      .eq('school_id', schoolId)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .eq('is_deleted', false);

    if (stuErr || !students || students.length === 0) {
      console.warn('[homework] No students found for notifications:', { className, section });
      return;
    }

    // Process in batches of 100
    for (let i = 0; i < students.length; i += FCM_BATCH_SIZE) {
      const batch = students.slice(i, i + FCM_BATCH_SIZE) as Array<{
        id: string;
        fcm_token: string | null;
      }>;

      await Promise.all(
        batch.map(async (student) => {
          // Insert in-app notification for each student
          try {
            await supabaseAdmin.from('notifications').insert({
              title: notifTitle,
              message: notifBody,
              type: 'announcement',
              recipient_id: student.id,
              sender_id: senderId,
              is_read: false,
              created_at: new Date().toISOString(),
            });
          } catch (err) {
            console.error(`[homework] Failed to insert notification for student ${student.id}:`, err);
          }

          // Send FCM push if token available
          if (fcmEnabled && student.fcm_token) {
            await sendFcmMessage(student.fcm_token, notifTitle, notifBody);
          }
        })
      );

      // Throttle between batches
      if (i + FCM_BATCH_SIZE < students.length) {
        await sleep(FCM_BATCH_DELAY_MS);
      }
    }

    console.log(`[homework] Notifications sent for homework ${homeworkId} to ${students.length} students`);
  } catch (err) {
    console.error('[homework] Unexpected error in sendHomeworkNotifications:', err);
  }
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const createHomeworkSchema = z.object({
  subject_id: z.string().uuid('subject_id must be a valid UUID'),
  class: z.string().min(1).max(20),
  section: z.string().min(1).max(10),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD')
    .refine((d) => d >= todayDate(), { message: 'due_date must be today or a future date' }),
  file_url: z.string().url('file_url must be a valid URL').optional(),
  // AI checking fields
  ai_check_enabled: z.boolean().optional().default(false),
  reference_answer: z.string().max(5000).optional(),
  submission_type: z.enum(['typed', 'photo', 'either']).optional().default('either'),
  subject_type: z.enum(['theory', 'numerical', 'mixed']).optional().nullable(),
  min_word_count: z.number().int().min(1).max(5000).optional().nullable(),
  requires_diagram: z.boolean().optional().default(false),
  // Suspicious-text AI detection (opt-in, default false)
  // When true, the nightly batch job uses a heuristic to detect AI-generated
  // answers and flags them for teacher review. Teacher sees a soft flag —
  // they decide whether to penalise. Default: false (no suspicious check).
  check_suspicious: z.boolean().optional().default(false),
  // Teacher reference solution file (URL after upload)
  reference_file_url: z.string().url('reference_file_url must be a valid URL').optional(),
  // Template saving
  save_as_template: z.boolean().optional().default(false),
  template_name: z.string().max(100).optional(),
});

const updateHomeworkSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD')
    .refine((d) => d >= todayDate(), { message: 'due_date must be today or a future date' })
    .optional(),
  file_url: z.string().url('file_url must be a valid URL').optional(),
});

// ── GET /api/homework/class ───────────────────────────────────────────────────
/**
 * Fetch all homework for a class/section.
 * Auth: student token OR teacher/admin token.
 * - Filters to homework where due_date >= today - 7 days.
 * - For student tokens: adds acknowledged: true/false per item.
 * - Sorted by due_date ascending.
 */
router.get(
  '/class',
  async (req: Request, res: Response) => {
    // Accept either a staff token or a student token
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      sendError(res, 'Missing or malformed Authorization header', 401);
      return;
    }

    const token = authHeader.split(' ')[1];
    let isStudent = false;
    let studentId: string | null = null;
    let schoolId: string | null = null;

    // Try student JWT first
    const jwt = await import('jsonwebtoken');
    const secret = process.env.JWT_SECRET;
    if (secret) {
      try {
        const payload = jwt.default.verify(token, secret) as { type?: string; sub?: string; school_id?: string };
        if (payload?.type === 'student') {
          const { data: student } = await supabaseAdmin
            .from('students')
            .select('id, school_id, class_name, section')
            .eq('id', payload.sub)
            .single();
          if (student) {
            isStudent = true;
            studentId = student.id;
            schoolId = student.school_id;
            // Enforce student can only see their own class
            const qClass = req.query.class as string;
            const qSection = req.query.section as string;
            if (qClass && qClass !== student.class_name) {
              sendError(res, 'Access denied: you can only view your own class homework', 403);
              return;
            }
            if (qSection && qSection !== student.section) {
              sendError(res, 'Access denied: you can only view your own section homework', 403);
              return;
            }
          }
        }
      } catch {
        // Not a student JWT — fall through to staff auth
      }
    }

    // If not a student, verify as staff
    if (!isStudent) {
      const { supabase } = await import('../config/supabase');
      const { data: authData, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authData.user) {
        sendError(res, 'Invalid or expired token', 401);
        return;
      }
      const { data: profile } = await supabaseAdmin
        .from('users')
        .select('id, role, school_id')
        .eq('id', authData.user.id)
        .single();
      if (!profile || (profile as Record<string, unknown>).is_deleted === true) {
        sendError(res, 'User profile not found or account deactivated', 403);
        return;
      }
      const allowedRoles = ['superadmin', 'schooladmin', 'teacher'];
      if (!allowedRoles.includes(profile.role)) {
        sendError(res, 'Access denied', 403);
        return;
      }
      schoolId = profile.school_id ?? null;
    }

    const { class: className, section, school_id: qSchoolId } = req.query as Record<string, string>;

    if (!className || !section) {
      sendError(res, 'class and section are required', 400);
      return;
    }

    // For superadmin, school_id must come from query; others use token
    if (!isStudent && !schoolId) {
      if (!qSchoolId) {
        sendError(res, 'school_id is required', 400);
        return;
      }
      schoolId = qSchoolId;
    }

    // Cutoff: only show homework from the last 7 days onward
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);
    const cutoff = cutoffDate.toISOString().slice(0, 10);

    // Fetch homework with subject, teacher info, and acknowledgement status in one query
    // Uses LEFT JOIN on homework_acknowledgements filtered by student_id to avoid N+1 queries
    const selectFields = isStudent && studentId
      ? `id, title, description, due_date, file_url, created_at,
         subjects ( name ),
         users ( name ),
         homework_acknowledgements!left ( student_id )`
      : `id, title, description, due_date, file_url, created_at,
         subjects ( name ),
         users ( name )`;

    const { data: homeworkList, error: hwErr } = await supabaseAdmin
      .from('homework')
      .select(selectFields)
      .eq('school_id', schoolId)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .gte('due_date', cutoff)
      .order('due_date', { ascending: true });

    if (hwErr) {
      sendError(res, hwErr.message, 500);
      return;
    }

    const list = homeworkList ?? [];

    // Supabase infers joined relations as arrays; cast through unknown to our shape
    type AckRow = { student_id: string } | null;
    type HwRow = {
      id: string;
      title: string;
      description: string | null;
      due_date: string;
      file_url: string | null;
      created_at: string;
      subjects: { name: string } | null;
      users: { name: string } | null;
      homework_acknowledgements?: AckRow[] | null;
    };

    const result = (list as unknown as HwRow[]).map((h) => {
      // When joined, homework_acknowledgements is an array filtered by student_id
      // (Supabase returns all acks for the homework unless we filter — we filter below)
      const acknowledged = isStudent && studentId
        ? (h.homework_acknowledgements ?? []).some(
            (a) => a !== null && a.student_id === studentId
          )
        : undefined;

      return {
        id: h.id,
        title: h.title,
        description: h.description ?? null,
        subject_name: h.subjects?.name ?? null,
        teacher_name: h.users?.name ?? null,
        due_date: h.due_date,
        file_url: h.file_url ?? null,
        acknowledged,
        created_at: h.created_at,
      };
    });

    sendSuccess(res, result);
  }
);

// ── POST /api/homework/create ─────────────────────────────────────────────────
/**
 * Create new homework.
 * Auth: teacher token only.
 * - Verifies teacher is assigned to this class and subject.
 * - Validates due_date is today or future.
 * - Inserts homework row.
 * - Sends in-app + FCM notifications to all students in the class (fire-and-forget).
 * - Logs to audit_logs.
 */
router.post(
  '/create',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  createHomeworkRateLimit,
  async (req: Request, res: Response) => {
    const parsed = createHomeworkSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const {
      subject_id, class: className, section, title, description, due_date, file_url,
      ai_check_enabled, reference_answer, reference_file_url, submission_type, subject_type, min_word_count, requires_diagram,
      check_suspicious,
      save_as_template, template_name,
    } = parsed.data;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    const schoolId = req.user!.school_id;
    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // Validate file_url is a Supabase Storage URL if provided
    if (file_url && !isValidSupabaseStorageUrl(file_url)) {
      sendError(res, 'file_url must be a valid Supabase Storage URL', 400);
      return;
    }

    // Validate reference_file_url is a Supabase Storage URL if provided
    if (reference_file_url && !isValidSupabaseStorageUrl(reference_file_url)) {
      sendError(res, 'reference_file_url must be a valid Supabase Storage URL', 400);
      return;
    }

    // Teachers must be assigned to this class AND subject.
    // teacher_assignments stores subject as a name (text), not a UUID.
    // Resolve the subject name first, then check the assignment.
    if (userRole === 'teacher') {
      const { data: subjectForCheck } = await supabaseAdmin
        .from('subjects')
        .select('name')
        .eq('id', subject_id)
        .eq('school_id', schoolId)
        .maybeSingle();

      let assigned = false;

      if (subjectForCheck) {
        // Try class_name column first (current schema)
        const { data: byClassName } = await supabaseAdmin
          .from('teacher_assignments')
          .select('id')
          .eq('teacher_id', userId)
          .eq('school_id', schoolId)
          .ilike('class_name', className.trim())
          .ilike('section', section.trim())
          .ilike('subject', subjectForCheck.name.trim())
          .maybeSingle();

        if (byClassName) {
          assigned = true;
        } else {
          // Fallback: legacy `class` column
          const { data: byClass } = await supabaseAdmin
            .from('teacher_assignments')
            .select('id')
            .eq('teacher_id', userId)
            .eq('school_id', schoolId)
            .ilike('class', className.trim())
            .ilike('section', section.trim())
            .ilike('subject', subjectForCheck.name.trim())
            .maybeSingle();

          if (byClass) assigned = true;
        }
      }

      if (!assigned) {
        sendError(res, 'You are not assigned to this class and subject', 403);
        return;
      }
    }

    // Verify subject exists and belongs to this school
    const { data: subject, error: subErr } = await supabaseAdmin
      .from('subjects')
      .select('id, name')
      .eq('id', subject_id)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (subErr || !subject) {
      sendError(res, 'Subject not found', 404);
      return;
    }

    // Insert homework with AI checking fields
    const { data: homework, error: insertErr } = await supabaseAdmin
      .from('homework')
      .insert({
        subject_id,
        class_name: className,
        section,
        title,
        description: description ?? null,
        due_date,
        file_url: file_url ?? null,
        school_id: schoolId,
        created_by: userId,
        created_at: new Date().toISOString(),
        // AI checking fields
        ai_check_enabled: ai_check_enabled ?? false,
        reference_answer: reference_answer ?? null,
        reference_file_url: reference_file_url ?? null,
        submission_type: submission_type ?? 'either',
        subject_type: subject_type ?? null,
        min_word_count: min_word_count ?? null,
        requires_diagram: requires_diagram ?? false,
        check_suspicious: check_suspicious ?? false,
      })
      .select(`
        id, title, description, due_date, file_url, created_at,
        ai_check_enabled, reference_answer, reference_file_url, submission_type, subject_type, min_word_count, requires_diagram, check_suspicious,
        subjects ( name ),
        users ( name )
      `)
      .single();

    if (insertErr || !homework) {
      sendError(res, insertErr?.message ?? 'Failed to create homework', 500);
      return;
    }

    // If AI checking enabled, insert not_submitted rows for all students in this class/section
    if (ai_check_enabled) {
      setImmediate(async () => {
        try {
          const { data: students } = await supabaseAdmin
            .from('students')
            .select('id')
            .eq('school_id', schoolId)
            .ilike('class_name', className.trim())
            .ilike('section', section.trim())
            .eq('is_deleted', false);

          if (students && students.length > 0) {
            const submissionRows = (students as { id: string }[]).map((s) => ({
              homework_id: (homework as unknown as { id: string }).id,
              student_id: s.id,
              status: 'not_submitted',
            }));
            await supabaseAdmin
              .from('homework_submissions')
              .insert(submissionRows)
              .select('id');
          }
        } catch (err) {
          console.error('[homework] Failed to seed homework_submissions:', err);
        }
      });
    }

    // Save as template if requested
    if (save_as_template && template_name?.trim()) {
      setImmediate(async () => {
        try {
          await supabaseAdmin.from('teacher_homework_templates').insert({
            teacher_id: userId,
            school_id: schoolId,
            subject: subject.name,
            template_name: template_name.trim(),
            reference_answer: reference_answer ?? null,
            min_word_count: min_word_count ?? null,
            requires_diagram: requires_diagram ?? false,
            submission_type: submission_type ?? 'either',
            check_suspicious: check_suspicious ?? false,
          });
        } catch (err) {
          console.error('[homework] Failed to save template:', err);
        }
      });
    }

    await logAudit(userId, 'homework_created', 'homework', {
      homework_id: (homework as unknown as { id: string }).id,
      title,
      class_name: className,
      section,
      subject_id,
      due_date,
      school_id: schoolId,
      ai_check_enabled,
    });

    // Fire-and-forget: send notifications after response
    setImmediate(() => {
      sendHomeworkNotifications(
        schoolId,
        className,
        section,
        (homework as unknown as { id: string }).id,
        title,
        subject.name,
        due_date,
        userId
      ).catch((err) => {
        console.error('[homework] Background notification job failed:', err);
      });
    });

    type HwJoined = {
      id: string; title: string; description: string | null; due_date: string; file_url: string | null; created_at: string;
      ai_check_enabled: boolean; reference_answer: string | null; submission_type: string; subject_type: string | null; min_word_count: number | null; requires_diagram: boolean; check_suspicious: boolean;
      subjects: { name: string } | null; users: { name: string } | null;
    };
    const hw = homework as unknown as HwJoined;

    const result = {
      id: hw.id,
      title: hw.title,
      description: hw.description ?? null,
      subject_name: hw.subjects?.name ?? null,
      teacher_name: hw.users?.name ?? null,
      due_date: hw.due_date,
      file_url: hw.file_url ?? null,
      created_at: hw.created_at,
      ai_check_enabled: hw.ai_check_enabled,
      submission_type: hw.submission_type,
      subject_type: hw.subject_type,
      min_word_count: hw.min_word_count,
      requires_diagram: hw.requires_diagram,
      check_suspicious: hw.check_suspicious,
    };

    sendSuccess(res, result, 'Homework created', 201);
  }
);

// ── PUT /api/homework/:id ─────────────────────────────────────────────────────
/**
 * Update homework.
 * Auth: teacher token (must be the creator).
 * - Can update: title, description, due_date, file_url.
 * - Cannot change class/section/subject.
 * - Logs to audit_logs.
 */
router.put(
  '/:id',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const parsed = updateHomeworkSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { title, description, due_date, file_url } = parsed.data;
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const homeworkId = req.params.id;

    // Validate file_url if provided
    if (file_url && !isValidSupabaseStorageUrl(file_url)) {
      sendError(res, 'file_url must be a valid Supabase Storage URL', 400);
      return;
    }

    // Fetch existing homework
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('homework')
      .select('id, title, description, due_date, file_url, created_by, class_name, section, subject_id, school_id')
      .eq('id', homeworkId)
      .single();

    if (fetchErr || !existing) {
      sendError(res, 'Homework not found', 404);
      return;
    }

    // Teachers can only update their own homework
    if (userRole === 'teacher' && existing.created_by !== userId) {
      sendError(res, 'You can only update homework you created', 403);
      return;
    }

    // schooladmin can only update homework in their school
    if (userRole === 'schooladmin' && existing.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }

    // Build update payload — only include fields that were provided
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (due_date !== undefined) updates.due_date = due_date;
    if (file_url !== undefined) updates.file_url = file_url;

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('homework')
      .update(updates)
      .eq('id', homeworkId)
      .select(`
        id, title, description, due_date, file_url, created_at,
        subjects ( name ),
        users ( name )
      `)
      .single();

    if (updateErr || !updated) {
      sendError(res, updateErr?.message ?? 'Failed to update homework', 500);
      return;
    }

    await logAudit(userId, 'homework_updated', 'homework', {
      homework_id: homeworkId,
      old_values: {
        title: existing.title,
        description: existing.description,
        due_date: existing.due_date,
        file_url: existing.file_url,
      },
      new_values: updates,
    });

    // Supabase infers joined relations as arrays; cast through unknown
    type HwJoined = { id: string; title: string; description: string | null; due_date: string; file_url: string | null; created_at: string; subjects: { name: string } | null; users: { name: string } | null };
    const upd = updated as unknown as HwJoined;

    const result = {
      id: upd.id,
      title: upd.title,
      description: upd.description ?? null,
      subject_name: upd.subjects?.name ?? null,
      teacher_name: upd.users?.name ?? null,
      due_date: upd.due_date,
      file_url: upd.file_url ?? null,
      created_at: upd.created_at,
    };

    sendSuccess(res, result, 'Homework updated');
  }
);

// ── DELETE /api/homework/:id ──────────────────────────────────────────────────
/**
 * Delete homework and all its acknowledgements.
 * Auth: teacher (must be creator) or school_admin.
 * Logs to audit_logs.
 */
router.delete(
  '/:id',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const homeworkId = req.params.id;

    // Fetch existing homework to verify ownership
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('homework')
      .select('id, title, created_by, school_id, class_name, section')
      .eq('id', homeworkId)
      .single();

    if (fetchErr || !existing) {
      sendError(res, 'Homework not found', 404);
      return;
    }

    // Teachers can only delete their own homework
    if (userRole === 'teacher' && existing.created_by !== userId) {
      sendError(res, 'You can only delete homework you created', 403);
      return;
    }

    // schooladmin can only delete homework in their school
    if (userRole === 'schooladmin' && existing.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }

    // Delete acknowledgements first (FK constraint)
    const { error: ackDelErr } = await supabaseAdmin
      .from('homework_acknowledgements')
      .delete()
      .eq('homework_id', homeworkId);

    if (ackDelErr) {
      sendError(res, 'Failed to delete homework acknowledgements', 500);
      return;
    }

    // Delete homework
    const { error: delErr } = await supabaseAdmin
      .from('homework')
      .delete()
      .eq('id', homeworkId);

    if (delErr) {
      sendError(res, delErr.message, 500);
      return;
    }

    await logAudit(userId, 'homework_deleted', 'homework', {
      homework_id: homeworkId,
      title: existing.title,
      class_name: existing.class_name,
      section: existing.section,
      school_id: existing.school_id,
    });

    sendSuccess(res, { success: true }, 'Homework deleted');
  }
);

// ── POST /api/homework/:id/acknowledge ────────────────────────────────────────
/**
 * Student acknowledges they have seen the homework.
 * Auth: student token only.
 * Idempotent — duplicate acknowledgements return success.
 */
router.post(
  '/:id/acknowledge',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;
    const homeworkId = req.params.id;

    // Verify homework exists and belongs to the student's class/section
    const { data: homework, error: hwErr } = await supabaseAdmin
      .from('homework')
      .select('id, class_name, section, school_id')
      .eq('id', homeworkId)
      .single();

    if (hwErr || !homework) {
      sendError(res, 'Homework not found', 404);
      return;
    }

    // Student can only acknowledge homework for their own class
    if (
      homework.school_id !== schoolId ||
      homework.class_name !== req.student!.class_name ||
      homework.section !== req.student!.section
    ) {
      sendError(res, 'Access denied: this homework is not for your class', 403);
      return;
    }

    // Upsert — idempotent on (homework_id, student_id)
    const { error: upsertErr } = await supabaseAdmin
      .from('homework_acknowledgements')
      .upsert(
        {
          homework_id: homeworkId,
          student_id: studentId,
          acknowledged_at: new Date().toISOString(),
        },
        { onConflict: 'homework_id,student_id', ignoreDuplicates: true }
      );

    if (upsertErr) {
      sendError(res, upsertErr.message, 500);
      return;
    }

    sendSuccess(res, { success: true }, 'Homework acknowledged');
  }
);

// ── GET /api/homework/acknowledgements/:homework_id ───────────────────────────
/**
 * Get acknowledgement count for a specific homework item.
 * Auth: teacher/schooladmin/superadmin token.
 * Returns: { acknowledged_count, total_students }
 */
router.get(
  '/acknowledgements/:homework_id',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const homeworkId = req.params.homework_id;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    // Fetch homework to get class/section/school
    const { data: homework, error: hwErr } = await supabaseAdmin
      .from('homework')
      .select('id, class_name, section, school_id, created_by')
      .eq('id', homeworkId)
      .single();

    if (hwErr || !homework) {
      sendError(res, 'Homework not found', 404);
      return;
    }

    // Teachers can only view acknowledgements for their own homework
    if (userRole === 'teacher' && homework.created_by !== userId) {
      sendError(res, 'Access denied', 403);
      return;
    }

    // schooladmin can only view homework in their school
    if (userRole === 'schooladmin' && homework.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }

    // Count total students in this class/section
    const { count: totalStudents, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', homework.school_id)
      .eq('class_name', homework.class_name)
      .eq('section', homework.section)
      .eq('is_deleted', false);

    if (stuErr) {
      sendError(res, stuErr.message, 500);
      return;
    }

    // Count acknowledgements for this homework
    const { count: ackCount, error: ackErr } = await supabaseAdmin
      .from('homework_acknowledgements')
      .select('id', { count: 'exact', head: true })
      .eq('homework_id', homeworkId);

    if (ackErr) {
      sendError(res, ackErr.message, 500);
      return;
    }

    sendSuccess(res, {
      acknowledged_count: ackCount ?? 0,
      total_students: totalStudents ?? 0,
    });
  }
);

// ── GET /api/homework/pending-count ──────────────────────────────────────────
/**
 * Count of unacknowledged homework due today or later for the student.
 * Auth: student token only.
 * Used for the badge count on the mobile app.
 */
router.get(
  '/pending-count',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;
    const className = req.student!.class_name;
    const section = req.student!.section;
    const today = todayDate();

    if (!className || !section) {
      sendError(res, 'Student class/section not set', 400);
      return;
    }

    // Fetch all homework due today or later for this class
    const { data: homeworkList, error: hwErr } = await supabaseAdmin
      .from('homework')
      .select('id')
      .eq('school_id', schoolId)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .gte('due_date', today);

    if (hwErr) {
      sendError(res, hwErr.message, 500);
      return;
    }

    const allIds = (homeworkList ?? []).map((h: { id: string }) => h.id);

    if (allIds.length === 0) {
      sendSuccess(res, { count: 0 });
      return;
    }

    // Fetch acknowledgements for this student
    const { data: acks, error: ackErr } = await supabaseAdmin
      .from('homework_acknowledgements')
      .select('homework_id')
      .eq('student_id', studentId)
      .in('homework_id', allIds);

    if (ackErr) {
      sendError(res, ackErr.message, 500);
      return;
    }

    const ackedIds = new Set((acks ?? []).map((a: { homework_id: string }) => a.homework_id));
    const pendingCount = allIds.filter((id) => !ackedIds.has(id)).length;

    sendSuccess(res, { count: pendingCount });
  }
);

// ── POST /api/homework/upload ─────────────────────────────────────────────────
/**
 * Upload a homework attachment (PDF or image) to Supabase Storage.
 * Auth: teacher, schooladmin, superadmin.
 *
 * - Accepts multipart/form-data with a single 'file' field.
 * - Stores in the 'homework-uploads' bucket under <school_id>/<timestamp>_<filename>.
 * - Returns { url } — a public URL to store in homework.file_url.
 *
 * Max file size: 5 MB. Allowed types: PDF, JPEG, PNG, WebP, GIF.
 */
router.post(
  '/upload',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  (req: Request, res: Response, next) => {
    homeworkUpload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          sendError(res, 'File must be under 5 MB.', 400);
          return;
        }
        sendError(res, err.message, 400);
        return;
      }
      if (err) {
        sendError(res, err instanceof Error ? err.message : 'File upload error', 400);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    if (!req.file) {
      sendError(res, 'No file provided. Send a multipart/form-data request with a "file" field.', 400);
      return;
    }

    const schoolId = req.user!.school_id;
    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    const BUCKET = 'homework-uploads';
    const ts = Date.now();
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${schoolId}/${ts}_${safeName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error('[homework/upload] Storage error:', uploadError.message);
      sendError(res, `Failed to store file: ${uploadError.message}`, 500);
      return;
    }

    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    sendSuccess(
      res,
      {
        url: urlData?.publicUrl ?? null,
        storage_path: storagePath,
        file_name: req.file.originalname,
        file_size: req.file.size,
      },
      'File uploaded successfully.',
      201
    );
  }
);

// ── GET /api/homework/templates ──────────────────────────────────────────────
/**
 * Fetch all saved AI check templates for the teacher, optionally filtered by subject name.
 * Auth: teacher/schooladmin/superadmin
 */
router.get(
  '/templates',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const schoolId = req.user!.school_id;
    if (!schoolId) { sendError(res, 'Account not linked to a school', 403); return; }

    const { subject } = req.query as { subject?: string };

    let query = supabaseAdmin
      .from('teacher_homework_templates')
      .select('id, template_name, subject, reference_answer, submission_type, subject_type, min_word_count, requires_diagram, created_at')
      .eq('teacher_id', userId)
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false });

    if (subject) {
      query = query.ilike('subject', subject.trim());
    }

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }
    sendSuccess(res, data ?? []);
  }
);

// ── POST /api/homework/templates ─────────────────────────────────────────────
/**
 * Save a new AI check template for the teacher.
 * Auth: teacher only.
 */
router.post(
  '/templates',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const schoolId = req.user!.school_id;
    if (!schoolId) { sendError(res, 'Account not linked to a school', 403); return; }

    const schema = z.object({
      subject: z.string().min(1).max(100),
      template_name: z.string().min(1).max(100),
      reference_answer: z.string().max(5000).optional().nullable(),
      submission_type: z.enum(['typed', 'photo', 'either']).default('either'),
      subject_type: z.enum(['theory', 'numerical', 'mixed']).optional().nullable(),
      min_word_count: z.number().int().min(1).max(5000).optional().nullable(),
      requires_diagram: z.boolean().default(false),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const { data, error } = await supabaseAdmin
      .from('teacher_homework_templates')
      .insert({ ...parsed.data, teacher_id: userId, school_id: schoolId })
      .select()
      .single();

    if (error) { sendError(res, error.message, 500); return; }
    sendSuccess(res, data, 'Template saved', 201);
  }
);

// ── DELETE /api/homework/templates/:id ────────────────────────────────────────
/**
 * Delete a teacher's own homework template.
 */
router.delete(
  '/templates/:id',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { id } = req.params;

    const { data: tmpl, error: fetchErr } = await supabaseAdmin
      .from('teacher_homework_templates')
      .select('id, teacher_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !tmpl) { sendError(res, 'Template not found', 404); return; }
    if (tmpl.teacher_id !== userId) { sendError(res, 'Access denied', 403); return; }

    const { error } = await supabaseAdmin.from('teacher_homework_templates').delete().eq('id', id);
    if (error) { sendError(res, error.message, 500); return; }
    sendSuccess(res, { success: true }, 'Template deleted');
  }
);

// ── GET /api/homework/last-ai-settings ───────────────────────────────────────
/**
 * Fetch AI settings from the most recent homework created by this teacher
 * for a given subject + class + section. Used by "Same as Yesterday" button.
 * Auth: teacher/schooladmin/superadmin
 * Query params: subject_id, class, section
 */
router.get(
  '/last-ai-settings',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const schoolId = req.user!.school_id;
    if (!schoolId) { sendError(res, 'Account not linked to a school', 403); return; }

    const { subject_id, class: className, section } = req.query as Record<string, string>;
    if (!subject_id || !className || !section) {
      sendError(res, 'subject_id, class, and section are required', 400);
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('homework')
      .select('id, reference_answer, submission_type, subject_type, min_word_count, requires_diagram, check_suspicious')
      .eq('school_id', schoolId)
      .eq('created_by', userId)
      .eq('subject_id', subject_id)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .eq('ai_check_enabled', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) { sendError(res, error.message, 500); return; }
    if (!data) { sendSuccess(res, null, 'No previous AI settings found'); return; }

    sendSuccess(res, data);
  }
);

// ── GET /api/homework/:id ────────────────────────────────────────────────────
/**
 * Fetch a single homework item by ID.
 * Auth: student token OR teacher/admin token.
 * Students can only fetch homework assigned to their class.
 */
router.get(
  '/:id',
  async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      sendError(res, 'Missing or malformed Authorization header', 401);
      return;
    }

    const token = authHeader.split(' ')[1];
    let isStudent = false;
    let studentId: string | null = null;
    let schoolId: string | null = null;
    let studentClassname: string | null = null;
    let studentSection: string | null = null;

    const jwt = await import('jsonwebtoken');
    const secret = process.env.JWT_SECRET;
    if (secret) {
      try {
        const payload = jwt.default.verify(token, secret) as { type?: string; sub?: string; school_id?: string };
        if (payload?.type === 'student') {
          const { data: student } = await supabaseAdmin
            .from('students')
            .select('id, school_id, class_name, section')
            .eq('id', payload.sub)
            .single();
          if (student) {
            isStudent = true;
            studentId = student.id;
            schoolId = student.school_id;
            studentClassname = student.class_name;
            studentSection = student.section;
          }
        }
      } catch { /* fall through */ }
    }

    if (!isStudent) {
      const { supabase: supabaseClient } = await import('../config/supabase');
      const { data: authData, error: authError } = await supabaseClient.auth.getUser(token);
      if (authError || !authData.user) { sendError(res, 'Invalid or expired token', 401); return; }
      const { data: profile } = await supabaseAdmin
        .from('users').select('id, role, school_id').eq('id', authData.user.id).single();
      if (!profile) { sendError(res, 'User profile not found', 403); return; }
      const allowedRoles = ['superadmin', 'schooladmin', 'teacher'];
      if (!allowedRoles.includes(profile.role)) { sendError(res, 'Access denied', 403); return; }
      schoolId = profile.school_id ?? null;
    }

    const homeworkId = req.params.id;

    const { data: hw, error: hwErr } = await supabaseAdmin
      .from('homework')
      .select(`
        id, title, description, due_date, file_url, created_at,
        ai_check_enabled, submission_type, subject_type, min_word_count, requires_diagram, check_suspicious,
        class_name, section, school_id,
        subjects ( name ),
        users ( name )
      `)
      .eq('id', homeworkId)
      .single();

    if (hwErr || !hw) { sendError(res, 'Homework not found', 404); return; }

    // Students can only view their own class's homework
    if (isStudent) {
      const hwRow = hw as unknown as { class_name: string; section: string; school_id: string };
      if (
        hwRow.school_id !== schoolId ||
        hwRow.class_name !== studentClassname ||
        hwRow.section !== studentSection
      ) {
        sendError(res, 'Access denied: this homework is not for your class', 403);
        return;
      }
    }

    type HwRow = {
      id: string; title: string; description: string | null; due_date: string;
      file_url: string | null; created_at: string; ai_check_enabled: boolean;
      submission_type: string; subject_type: string | null; min_word_count: number | null;
      requires_diagram: boolean; check_suspicious: boolean;
      class_name: string; section: string; school_id: string;
      subjects: { name: string } | null; users: { name: string } | null;
    };
    const hwRow = hw as unknown as HwRow;

    // If student, also fetch their existing submission
    let existingSubmission: {
      status: string; submission_text: string | null; submission_image_urls: string[] | null;
      submitted_at: string | null; ai_result: string | null; ai_feedback: string | null;
    } | null = null;

    if (isStudent && studentId) {
      const { data: sub } = await supabaseAdmin
        .from('homework_submissions')
        .select('status, submission_text, submission_image_urls, submitted_at, ai_result, ai_feedback')
        .eq('homework_id', homeworkId)
        .eq('student_id', studentId)
        .maybeSingle();
      if (sub) existingSubmission = sub as unknown as typeof existingSubmission;
    }

    sendSuccess(res, {
      id: hwRow.id,
      title: hwRow.title,
      description: hwRow.description ?? null,
      subject_name: hwRow.subjects?.name ?? null,
      teacher_name: hwRow.users?.name ?? null,
      due_date: hwRow.due_date,
      file_url: hwRow.file_url ?? null,
      created_at: hwRow.created_at,
      ai_check_enabled: hwRow.ai_check_enabled,
      submission_type: hwRow.submission_type,
      subject_type: hwRow.subject_type ?? null,
      min_word_count: hwRow.min_word_count ?? null,
      requires_diagram: hwRow.requires_diagram,
      check_suspicious: hwRow.check_suspicious,
      existing_submission: existingSubmission,
    });
  }
);

// ── POST /api/homework/:id/submit ─────────────────────────────────────────────
/**
 * Student submits homework (typed text and/or photo URLs).
 * Auth: student token only.
 *
 * Body:
 *   submission_text?:        string
 *   submission_image_urls?:  string[]
 *   image_hashes?:           string[]   — one perceptual hash per image (computed client-side)
 *   exif_timestamps?:        string[]   — ISO timestamps from EXIF, if available
 *
 * Logic:
 *   1. Upsert homework_submissions row with status='submitted'.
 *   2. Duplicate image check: if any image_hash matches another student's submission
 *      for the same homework → flag as 'duplicate_image', status='flagged_for_review'.
 *   3. Old photo check: if exif_timestamp is > 24 h before submitted_at → flag as 'old_photo'.
 *   4. Flagged submissions skip AI checking. Non-flagged submitted rows will be
 *      picked up by the nightly AI batch job.
 */
router.post(
  '/:id/submit',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;
    const className = req.student!.class_name;
    const section = req.student!.section;
    const homeworkId = req.params.id;

    const {
      submission_text,
      submission_image_urls,
      image_hashes,
      exif_timestamps,
    } = req.body as {
      submission_text?: string;
      submission_image_urls?: string[];
      image_hashes?: string[];
      exif_timestamps?: (string | null)[];
    };

    // Basic validation — need at least text or images
    if (!submission_text?.trim() && (!submission_image_urls || submission_image_urls.length === 0)) {
      sendError(res, 'Provide either submission_text or at least one image URL', 400);
      return;
    }

    // Verify homework exists and belongs to student's class
    const { data: hw, error: hwErr } = await supabaseAdmin
      .from('homework')
      .select('id, class_name, section, school_id, ai_check_enabled, submission_type')
      .eq('id', homeworkId)
      .single();

    if (hwErr || !hw) { sendError(res, 'Homework not found', 404); return; }

    const hwRow = hw as { id: string; class_name: string; section: string; school_id: string; ai_check_enabled: boolean; submission_type: string };
    if (
      hwRow.school_id !== schoolId ||
      hwRow.class_name !== className ||
      hwRow.section !== section
    ) {
      sendError(res, 'Access denied: this homework is not for your class', 403);
      return;
    }

    const submittedAt = new Date().toISOString();

    // ── Daily AI-check rate limit ─────────────────────────────────────────────
    // Max 5 AI-checked submissions per student per day across all subjects.
    // If exceeded, store the submission with queued_overflow=true so the
    // nightly batch picks it up tomorrow instead.
    let queuedOverflow = false;
    if (hwRow.ai_check_enabled) {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);

      const { count: checksToday } = await supabaseAdmin
        .from('homework_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('student_id', studentId)
        .gte('evaluated_at', startOfDay.toISOString())
        .not('evaluated_at', 'is', null);

      const MAX_DAILY_AI_CHECKS = 5;
      if ((checksToday ?? 0) >= MAX_DAILY_AI_CHECKS) {
        queuedOverflow = true;
      }
    }

    // ── Store the first image hash for duplicate checking ────────────────────
    // We only store one hash per submission (the primary image). If multiple
    // images are submitted, we store the first hash for dedup purposes.
    const primaryHash = image_hashes && image_hashes.length > 0 ? image_hashes[0] : null;

    // ── Determine EXIF timestamp ──────────────────────────────────────────────
    // Use the earliest EXIF timestamp across all images, if any.
    let exifTimestamp: string | null = null;
    if (exif_timestamps && exif_timestamps.length > 0) {
      const validTimestamps = exif_timestamps.filter(Boolean) as string[];
      if (validTimestamps.length > 0) {
        // Use earliest timestamp
        const sorted = validTimestamps.sort();
        exifTimestamp = sorted[0];
      }
    }

    // ── Determine status and flagged_reason ───────────────────────────────────
    let status: 'submitted' | 'flagged_for_review' = 'submitted';
    let flaggedReason: string | null = null;

    // 1. Duplicate image check
    if (primaryHash) {
      const { data: dupMatch } = await supabaseAdmin
        .from('homework_submissions')
        .select('student_id')
        .eq('homework_id', homeworkId)
        .eq('image_hash', primaryHash)
        .neq('student_id', studentId)
        .maybeSingle();

      if (dupMatch) {
        status = 'flagged_for_review';
        flaggedReason = 'duplicate_image';
      }
    }

    // 2. Old photo check (only if not already flagged)
    if (!flaggedReason && exifTimestamp) {
      const exifDate = new Date(exifTimestamp);
      const submitDate = new Date(submittedAt);
      const diffMs = submitDate.getTime() - exifDate.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      if (diffHours > 24) {
        status = 'flagged_for_review';
        flaggedReason = 'old_photo';
      }
    }

    // ── Upsert the submission row ─────────────────────────────────────────────
    const { data: submission, error: upsertErr } = await supabaseAdmin
      .from('homework_submissions')
      .upsert(
        {
          homework_id: homeworkId,
          student_id: studentId,
          submission_text: submission_text?.trim() ?? null,
          submission_image_urls: submission_image_urls ?? null,
          submitted_at: submittedAt,
          status,
          flagged_reason: flaggedReason,
          image_hash: primaryHash ?? null,
          exif_timestamp: exifTimestamp ?? null,
          queued_overflow: queuedOverflow,
          // Clear AI fields on re-submission
          ai_result: null,
          ai_feedback: null,
          ai_confidence: null,
        },
        { onConflict: 'homework_id,student_id' }
      )
      .select('id, status, flagged_reason, submitted_at, queued_overflow')
      .single();

    if (upsertErr || !submission) {
      sendError(res, upsertErr?.message ?? 'Failed to save submission', 500);
      return;
    }

    type SubRow = { id: string; status: string; flagged_reason: string | null; submitted_at: string; queued_overflow: boolean };
    const sub = submission as unknown as SubRow;

    sendSuccess(res, {
      id: sub.id,
      status: sub.status,
      flagged_reason: sub.flagged_reason,
      submitted_at: sub.submitted_at,
      queued_overflow: sub.queued_overflow,
      message: sub.queued_overflow
        ? 'Submitted! You\'ve reached today\'s AI-check limit — your submission will be checked tomorrow morning.'
        : sub.status === 'flagged_for_review'
        ? 'Submitted! Your submission has been flagged for teacher review.'
        : 'Submitted! AI will check this tonight, results available tomorrow morning.',
    }, 'Homework submitted', 201);
  }
);

// ── POST /api/homework/submit-upload ─────────────────────────────────────────
/**
 * Student uploads a homework photo to Supabase Storage.
 * Auth: student token only.
 * Max 5 images, max 10 MB each.
 * Returns { url, storage_path } for each uploaded image.
 */
router.post(
  '/submit-upload',
  authenticateStudent,
  (req: Request, res: Response, next) => {
    const studentUpload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10 MB per file, max 5
      fileFilter: (_req, file, cb) => {
        const mime = file.mimetype.toLowerCase();
        const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
        if (allowedMimes.has(mime)) {
          cb(null, true);
        } else {
          cb(new Error('Only image files (JPEG, PNG, WebP, HEIC) are allowed.'));
        }
      },
    });

    studentUpload.array('images', 5)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') { sendError(res, 'Each image must be under 10 MB.', 400); return; }
        if (err.code === 'LIMIT_FILE_COUNT') { sendError(res, 'Maximum 5 images per submission.', 400); return; }
        sendError(res, err.message, 400);
        return;
      }
      if (err) {
        sendError(res, err instanceof Error ? err.message : 'File upload error', 400);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      sendError(res, 'No images provided. Send a multipart/form-data request with "images" field.', 400);
      return;
    }

    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;

    const BUCKET = 'homework-uploads';
    const results: Array<{ url: string; storage_path: string; file_name: string; file_size: number }> = [];

    for (const file of files) {
      const ts = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `student-submissions/${schoolId}/${studentId}/${ts}_${safeName}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error('[homework/submit-upload] Storage error:', uploadError.message);
        sendError(res, `Failed to store image: ${uploadError.message}`, 500);
        return;
      }

      const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);

      results.push({
        url: urlData?.publicUrl ?? '',
        storage_path: storagePath,
        file_name: file.originalname,
        file_size: file.size,
      });
    }

    sendSuccess(res, { images: results }, 'Images uploaded successfully.', 201);
  }
);

// ── GET /api/homework/:id/submissions ─────────────────────────────────────────
/**
 * Get the submission status for all students for a given homework item.
 * Returns one row per student — including students with no submission (not_submitted).
 * Auth: teacher (must be creator) / schooladmin / superadmin
 */
router.get(
  '/:id/submissions',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const homeworkId = req.params.id;

    // Fetch homework to verify access
    const { data: hw, error: hwErr } = await supabaseAdmin
      .from('homework')
      .select('id, class_name, section, school_id, created_by, title, subjects(name)')
      .eq('id', homeworkId)
      .single();

    if (hwErr || !hw) { sendError(res, 'Homework not found', 404); return; }

    if (userRole === 'teacher' && hw.created_by !== userId) { sendError(res, 'Access denied', 403); return; }
    if (userRole === 'schooladmin' && hw.school_id !== req.user!.school_id) { sendError(res, 'Access denied', 403); return; }

    type HwRow = { id: string; class_name: string; section: string; school_id: string; created_by: string; title: string; subjects: { name: string } | null };
    const hwRow = hw as unknown as HwRow;

    // Fetch all active students for this class/section
    const { data: students, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, roll_number')
      .eq('school_id', hwRow.school_id)
      .ilike('class_name', hwRow.class_name.trim())
      .ilike('section', hwRow.section.trim())
      .eq('is_deleted', false)
      .order('roll_number', { ascending: true });

    if (stuErr) { sendError(res, stuErr.message, 500); return; }

    // Fetch existing submission rows for this homework
    const { data: submissions, error: subErr } = await supabaseAdmin
      .from('homework_submissions')
      .select('student_id, status, ai_result, ai_feedback, ai_confidence, submitted_at, flagged_reason')
      .eq('homework_id', homeworkId);

    if (subErr) { sendError(res, subErr.message, 500); return; }

    const submissionMap = new Map<string, typeof submissions[0]>(
      (submissions ?? []).map((s) => [s.student_id, s])
    );

    const rows = (students ?? []).map((stu) => {
      const sub = submissionMap.get(stu.id);
      return {
        student_id: stu.id,
        student_name: stu.full_name ?? stu.id,
        roll_number: stu.roll_number ?? null,
        status: sub?.status ?? 'not_submitted',
        ai_result: sub?.ai_result ?? null,
        ai_feedback: sub?.ai_feedback ?? null,
        ai_confidence: sub?.ai_confidence ?? null,
        submitted_at: sub?.submitted_at ?? null,
        flagged_reason: sub?.flagged_reason ?? null,
      };
    });

    sendSuccess(res, {
      homework_id: homeworkId,
      title: hwRow.title,
      subject_name: hwRow.subjects?.name ?? null,
      class_name: hwRow.class_name,
      section: hwRow.section,
      students: rows,
    });
  }
);

// ── GET /api/homework/:id/flagged-submissions ─────────────────────────────────
/**
 * Fetch all homework_submissions for a homework where status='flagged_for_review'.
 * Includes full submission content (text, image URLs), AI result, confidence,
 * feedback, flagged_reason, and student info.
 *
 * For duplicate_image flags, also returns the OTHER student's submission details
 * so the teacher can view them side-by-side.
 *
 * Auth: teacher (must be creator) / schooladmin / superadmin
 */
router.get(
  '/:id/flagged-submissions',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const homeworkId = req.params.id;

    // Fetch homework to verify access
    const { data: hw, error: hwErr } = await supabaseAdmin
      .from('homework')
      .select('id, class_name, section, school_id, created_by, title, subjects(name)')
      .eq('id', homeworkId)
      .single();

    if (hwErr || !hw) { sendError(res, 'Homework not found', 404); return; }

    type HwRow = { id: string; class_name: string; section: string; school_id: string; created_by: string; title: string; subjects: { name: string } | null };
    const hwRow = hw as unknown as HwRow;

    if (userRole === 'teacher' && hwRow.created_by !== userId) { sendError(res, 'Access denied', 403); return; }
    if (userRole === 'schooladmin' && hwRow.school_id !== req.user!.school_id) { sendError(res, 'Access denied', 403); return; }

    // Fetch all flagged submissions with student name
    const { data: submissions, error: subErr } = await supabaseAdmin
      .from('homework_submissions')
      .select(`
        id,
        student_id,
        submission_text,
        submission_image_urls,
        submitted_at,
        status,
        ai_result,
        ai_confidence,
        ai_feedback,
        teacher_reviewed,
        teacher_override_result,
        flagged_reason,
        image_hash,
        students ( full_name, roll_number )
      `)
      .eq('homework_id', homeworkId)
      .eq('status', 'flagged_for_review')
      .order('submitted_at', { ascending: true });

    if (subErr) { sendError(res, subErr.message, 500); return; }

    type SubRow = {
      id: string;
      student_id: string;
      submission_text: string | null;
      submission_image_urls: string[] | null;
      submitted_at: string | null;
      status: string;
      ai_result: string | null;
      ai_confidence: number | null;
      ai_feedback: string | null;
      teacher_reviewed: boolean;
      teacher_override_result: string | null;
      flagged_reason: string | null;
      image_hash: string | null;
      students: { full_name: string; roll_number: string | null } | null;
    };

    const rows = (submissions ?? []) as unknown as SubRow[];

    // For duplicate_image rows, find the sibling (other student's matching submission)
    // Group by image_hash to resolve duplicate pairs
    const hashToSubmissions = new Map<string, SubRow[]>();
    for (const row of rows) {
      if (row.flagged_reason === 'duplicate_image' && row.image_hash) {
        const existing = hashToSubmissions.get(row.image_hash) ?? [];
        existing.push(row);
        hashToSubmissions.set(row.image_hash, existing);
      }
    }

    // For hashes that have only ONE flagged row, find the other student's submission
    // (the original that wasn't flagged, since only the duplicate gets flagged)
    const siblingMap = new Map<string, {
      student_name: string;
      roll_number: string | null;
      submission_text: string | null;
      submission_image_urls: string[] | null;
      submitted_at: string | null;
    }>();

    for (const [hash, rowsForHash] of hashToSubmissions.entries()) {
      const studentIdsInFlagged = rowsForHash.map((r) => r.student_id);
      // Find the other student who submitted this same hash (the original)
      const { data: otherSub } = await supabaseAdmin
        .from('homework_submissions')
        .select(`
          student_id,
          submission_text,
          submission_image_urls,
          submitted_at,
          students ( full_name, roll_number )
        `)
        .eq('homework_id', homeworkId)
        .eq('image_hash', hash)
        .not('student_id', 'in', `(${studentIdsInFlagged.join(',')})`)
        .maybeSingle();

      if (otherSub) {
        type OtherSubRow = {
          student_id: string;
          submission_text: string | null;
          submission_image_urls: string[] | null;
          submitted_at: string | null;
          students: { full_name: string; roll_number: string | null } | null;
        };
        const other = otherSub as unknown as OtherSubRow;
        // Key: all flagged row IDs that share this hash
        for (const r of rowsForHash) {
          siblingMap.set(r.id, {
            student_name: other.students?.full_name ?? 'Unknown',
            roll_number: other.students?.roll_number ?? null,
            submission_text: other.submission_text,
            submission_image_urls: other.submission_image_urls,
            submitted_at: other.submitted_at,
          });
        }
      }
    }

    const result = rows.map((row) => ({
      id: row.id,
      student_id: row.student_id,
      student_name: row.students?.full_name ?? 'Unknown',
      roll_number: row.students?.roll_number ?? null,
      submission_text: row.submission_text,
      submission_image_urls: row.submission_image_urls ?? [],
      submitted_at: row.submitted_at,
      ai_result: row.ai_result,
      ai_confidence: row.ai_confidence,
      ai_feedback: row.ai_feedback,
      teacher_reviewed: row.teacher_reviewed,
      teacher_override_result: row.teacher_override_result,
      flagged_reason: row.flagged_reason,
      // Duplicate sibling (only for duplicate_image)
      duplicate_sibling: row.flagged_reason === 'duplicate_image'
        ? (siblingMap.get(row.id) ?? null)
        : null,
    }));

    sendSuccess(res, {
      homework_id: homeworkId,
      title: hwRow.title,
      subject_name: hwRow.subjects?.name ?? null,
      class_name: hwRow.class_name,
      section: hwRow.section,
      flagged_count: result.length,
      submissions: result,
    });
  }
);

// ── POST /api/homework/submissions/:submissionId/review ───────────────────────
/**
 * Teacher reviews and overrides an AI result for a flagged (or any) submission.
 * Sets:
 *   - teacher_override_result: 'correct' | 'incorrect' | 'partial'
 *   - teacher_reviewed: true
 *   - status: 'checked'
 *   - optional: ai_feedback (teacher can add/edit feedback)
 *
 * After saving, sends FCM notification to the student (and their parent)
 * same as a normal checked status notification.
 *
 * Auth: teacher (must own the homework) / schooladmin / superadmin
 * Body: { result: 'correct' | 'incorrect' | 'partial', feedback?: string }
 */
router.post(
  '/submissions/:submissionId/review',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const { submissionId } = req.params;

    const reviewSchema = z.object({
      result: z.enum(['correct', 'incorrect', 'partial']),
      feedback: z.string().max(1000).optional(),
    });

    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const { result, feedback } = parsed.data;

    // Fetch submission + its homework for auth check
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('homework_submissions')
      .select(`
        id,
        student_id,
        homework_id,
        homework:homework_id ( id, created_by, school_id, title, subjects ( name ) )
      `)
      .eq('id', submissionId)
      .single();

    if (subErr || !sub) { sendError(res, 'Submission not found', 404); return; }

    type SubWithHw = {
      id: string;
      student_id: string;
      homework_id: string;
      homework: {
        id: string;
        created_by: string;
        school_id: string;
        title: string;
        subjects: { name: string } | null;
      };
    };
    const submission = sub as unknown as SubWithHw;

    // Auth: teacher must own the homework
    if (userRole === 'teacher' && submission.homework.created_by !== userId) {
      sendError(res, 'Access denied', 403); return;
    }
    if (userRole === 'schooladmin' && submission.homework.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403); return;
    }

    // Update submission
    const { error: updateErr } = await supabaseAdmin
      .from('homework_submissions')
      .update({
        teacher_override_result: result,
        teacher_reviewed: true,
        status: 'checked',
        ...(feedback !== undefined ? { ai_feedback: feedback } : {}),
      })
      .eq('id', submissionId);

    if (updateErr) { sendError(res, updateErr.message, 500); return; }

    // Fire-and-forget: send FCM notification to student + parent
    setImmediate(async () => {
      try {
        const { sendPushMulticast, getTokensForStudents, getTokensForUsers } = await import('../services/fcmService');
        const { supabaseAdmin: db } = await import('../config/supabase');

        const studentId = submission.student_id;
        const homeworkTitle = submission.homework.title;
        const subjectName = (submission.homework.subjects as unknown as { name: string } | null)?.name ?? 'Homework';

        const resultLabel: Record<string, string> = {
          correct: '✅ Correct',
          incorrect: '❌ Needs Improvement',
          partial: '🔶 Partially Correct',
        };
        const label = resultLabel[result] ?? result;

        // Student push
        const studentTokens = await getTokensForStudents([studentId]);
        if (studentTokens.length > 0) {
          await sendPushMulticast(
            studentTokens,
            `${label} — ${subjectName}`,
            `Your homework "${homeworkTitle}" has been reviewed by your teacher.`,
            { type: 'homework_checked', homework_id: submission.homework_id }
          );
        }

        // In-app notification for student
        try {
          await db.from('notifications').insert({
            title: `${label} — ${subjectName}`,
            message: `Your homework "${homeworkTitle}" has been reviewed by your teacher.`,
            type: 'announcement',
            recipient_id: studentId,
            sender_id: userId,
            is_read: false,
            created_at: new Date().toISOString(),
          });
        } catch { /* best-effort */ }

        // Parent push
        const { data: student } = await db
          .from('students')
          .select('full_name, parent_id')
          .eq('id', studentId)
          .single();

        if (student?.parent_id) {
          const parentRow = student as unknown as { full_name: string; parent_id: string };
          const parentTokens = await getTokensForUsers([parentRow.parent_id]);
          if (parentTokens.length > 0) {
            await sendPushMulticast(
              parentTokens,
              `Homework Reviewed — ${subjectName}`,
              `${parentRow.full_name}'s homework "${homeworkTitle}" has been checked.`,
              { type: 'homework_checked', homework_id: submission.homework_id }
            );
          }
        }
      } catch (err) {
        console.error('[homework/review] FCM error:', err instanceof Error ? err.message : err);
      }
    });

    sendSuccess(res, {
      submission_id: submissionId,
      result,
      status: 'checked',
      teacher_reviewed: true,
    }, 'Submission reviewed');
  }
);

// ── GET /api/homework/ai-stats ────────────────────────────────────────────────
/**
 * Admin/Principal dashboard widget: Homework AI Stats.
 * Returns for the current school (from auth token):
 *   - total_submissions_this_week
 *   - auto_checked_count  (status='checked' AND teacher_reviewed=false)
 *   - flagged_count       (status='flagged_for_review')
 *   - checked_count       (status='checked')
 *   - cache_hit_count     (estimated from homework_evaluation_cache hit_count)
 *   - teachers_with_pending_reviews: [ { teacher_id, name, pending_count } ]
 *
 * Auth: schooladmin / superadmin / teacher (own stats only for teacher)
 */
router.get(
  '/ai-stats',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const userRole = req.user!.role;
    const schoolId = req.user!.school_id;
    if (!schoolId) { sendError(res, 'Account not linked to a school', 403); return; }

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoIso = weekAgo.toISOString();

    // Fetch all submissions this week for the school, joined with homework
    const { data: weekSubs, error: weekErr } = await supabaseAdmin
      .from('homework_submissions')
      .select(`
        id,
        status,
        teacher_reviewed,
        homework:homework_id (
          id,
          school_id,
          created_by,
          ai_check_enabled
        )
      `)
      .gte('submitted_at', weekAgoIso)
      .not('submitted_at', 'is', null);

    if (weekErr) { sendError(res, weekErr.message, 500); return; }

    type SubStatRow = {
      id: string;
      status: string;
      teacher_reviewed: boolean;
      homework: { id: string; school_id: string; created_by: string; ai_check_enabled: boolean } | null;
    };

    // Filter to this school's AI-enabled homework
    const allSubs = ((weekSubs ?? []) as unknown as SubStatRow[]).filter(
      (s) => s.homework?.school_id === schoolId && s.homework?.ai_check_enabled === true
    );

    const totalSubmissions = allSubs.length;
    const autoChecked = allSubs.filter((s) => s.status === 'checked' && !s.teacher_reviewed).length;
    const flagged = allSubs.filter((s) => s.status === 'flagged_for_review').length;
    const totalChecked = allSubs.filter((s) => s.status === 'checked').length;

    // Auto-check percentage
    const autoCheckedPct = totalSubmissions > 0
      ? Math.round((autoChecked / totalSubmissions) * 100)
      : 0;
    const flaggedPct = totalSubmissions > 0
      ? Math.round((flagged / totalSubmissions) * 100)
      : 0;

    // Cache hit count from homework_evaluation_cache (school-wide is approximate,
    // since cache is keyed by question+answer hash not school)
    const { data: cacheData } = await supabaseAdmin
      .from('homework_evaluation_cache')
      .select('hit_count')
      .order('created_at', { ascending: false })
      .limit(500);

    const totalCacheHits = (cacheData ?? []).reduce(
      (sum: number, row: { hit_count: number }) => sum + (row.hit_count ?? 1),
      0
    );

    // Teachers with pending reviews (flagged submissions that haven't been reviewed)
    // Group by homework.created_by
    const pendingByTeacher = new Map<string, number>();

    const { data: pendingSubs } = await supabaseAdmin
      .from('homework_submissions')
      .select(`
        homework:homework_id ( created_by, school_id, ai_check_enabled )
      `)
      .eq('status', 'flagged_for_review')
      .eq('teacher_reviewed', false);

    for (const s of (pendingSubs ?? []) as unknown as SubStatRow[]) {
      const hw = s.homework;
      if (!hw || hw.school_id !== schoolId || !hw.ai_check_enabled) continue;
      const teacherId = hw.created_by;
      pendingByTeacher.set(teacherId, (pendingByTeacher.get(teacherId) ?? 0) + 1);
    }

    // Fetch teacher names
    const teacherIds = Array.from(pendingByTeacher.keys());
    const teacherRows: Array<{ id: string; name: string }> = [];

    if (teacherIds.length > 0) {
      const { data: teachers } = await supabaseAdmin
        .from('users')
        .select('id, name')
        .in('id', teacherIds);

      for (const t of (teachers ?? []) as { id: string; name: string }[]) {
        teacherRows.push({
          id: t.id,
          name: t.name,
        });
      }
    }

    const teachersWithPending = teacherRows.map((t) => ({
      teacher_id: t.id,
      name: t.name,
      pending_count: pendingByTeacher.get(t.id) ?? 0,
    })).sort((a, b) => b.pending_count - a.pending_count);

    sendSuccess(res, {
      total_submissions_this_week: totalSubmissions,
      auto_checked_count: autoChecked,
      auto_checked_pct: autoCheckedPct,
      flagged_count: flagged,
      flagged_pct: flaggedPct,
      total_checked: totalChecked,
      cache_hit_count: totalCacheHits,
      teachers_with_pending: teachersWithPending,
      week_start: weekAgoIso,
    });
  }
);

export default router;
