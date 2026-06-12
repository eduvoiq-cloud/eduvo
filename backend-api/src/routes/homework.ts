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

    const { subject_id, class: className, section, title, description, due_date, file_url } = parsed.data;
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

    // Insert homework
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
      })
      .select(`
        id, title, description, due_date, file_url, created_at,
        subjects ( name ),
        users ( name )
      `)
      .single();

    if (insertErr || !homework) {
      sendError(res, insertErr?.message ?? 'Failed to create homework', 500);
      return;
    }

    await logAudit(userId, 'homework_created', 'homework', {
      homework_id: homework.id,
      title,
      class_name: className,
      section,
      subject_id,
      due_date,
      school_id: schoolId,
    });

    // Fire-and-forget: send notifications after response
    setImmediate(() => {
      sendHomeworkNotifications(
        schoolId,
        className,
        section,
        homework.id,
        title,
        subject.name,
        due_date,
        userId
      ).catch((err) => {
        console.error('[homework] Background notification job failed:', err);
      });
    });

    // Supabase infers joined relations as arrays; cast through unknown
    type HwJoined = { id: string; title: string; description: string | null; due_date: string; file_url: string | null; created_at: string; subjects: { name: string } | null; users: { name: string } | null };
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

export default router;
