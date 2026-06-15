/**
 * /api/subject-resources — Subject-wise Notes & Assignments repository
 *
 * Teacher routes (staff JWT required):
 *   POST   /api/subject-resources/upload   — upload file(s) to Supabase Storage
 *   POST   /api/subject-resources          — create a resource entry + notify students
 *   GET    /api/subject-resources/mine     — list teacher's own uploads
 *   PATCH  /api/subject-resources/:id      — edit title / description (no file changes)
 *   DELETE /api/subject-resources/:id      — delete record + files from Storage
 *
 * Student/Parent routes (student JWT or any JWT):
 *   GET    /api/subject-resources          — list resources for student's class/section
 *
 * Admin routes:
 *   GET    /api/subject-resources/admin/weekly-stats — resources uploaded this week by teacher
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateAny, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import rateLimit from 'express-rate-limit';
import { getTokensForStudents, sendPushMulticast } from '../services/fcmService';

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const STORAGE_BUCKET = 'subject-resources';
const MAX_FILES_PER_RESOURCE = 10;
const FCM_BATCH_SIZE = 100;

// ── Multer: memory storage, 20 MB per file, PDF + images ─────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]);
    if (allowed.has(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files (JPEG, PNG, WebP, GIF) are allowed.'));
    }
  },
});

// ── Rate limit: max 30 resource creations per teacher per day ─────────────────
const createRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `sr_create:${req.user?.id ?? req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { success: false, message: 'Resource creation limit reached (30 per day).' },
  skip: (req) => {
    const role = req.user?.role;
    return role === 'superadmin' || role === 'schooladmin';
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Validate that a URL belongs to this Supabase project. */
function isValidStorageUrl(url: string): boolean {
  if (!SUPABASE_URL) return true;
  try {
    const parsed = new URL(url);
    const host = new URL(SUPABASE_URL).host;
    return parsed.host === host && parsed.pathname.startsWith('/storage/v1/object/');
  } catch {
    return false;
  }
}

/** Extract storage path from a Supabase public URL. */
function storagePathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // e.g. /storage/v1/object/public/subject-resources/school_id/...
    const prefix = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
    const signedPrefix = `/storage/v1/object/sign/${STORAGE_BUCKET}/`;
    if (parsed.pathname.startsWith(prefix)) {
      return parsed.pathname.slice(prefix.length);
    }
    if (parsed.pathname.startsWith(signedPrefix)) {
      return parsed.pathname.slice(signedPrefix.length).split('?')[0];
    }
    return null;
  } catch {
    return null;
  }
}

/** Sleep helper for throttling FCM batches. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Format a YYYY-MM-DD date as "DD MMM YYYY". */
function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(day).padStart(2,'0')} ${months[month - 1]} ${year}`;
}

/**
 * Fire-and-forget: notify all students in class/section about a new resource.
 */
async function notifyStudents(
  schoolId: string,
  className: string,
  section: string,
  subject: string,
  title: string,
  resourceType: 'note' | 'assignment',
  dueDate: string | null,
  senderId: string,
  resourceId: string
): Promise<void> {
  try {
    // Fetch all active (non-deleted) students in this class/section
    const { data: students, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id, fcm_token')
      .eq('school_id', schoolId)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .eq('is_deleted', false);

    if (stuErr || !students || students.length === 0) {
      console.warn('[subject-resources] No students found for notification:', { className, section });
      return;
    }

    // Build notification content
    const notifTitle = resourceType === 'note' ? '📚 New Notes Added' : '📝 New Assignment';
    const notifBody =
      resourceType === 'note'
        ? `${subject}: ${title} has been uploaded by your teacher`
        : `${subject}: ${title}${dueDate ? ` - Due ${formatDate(dueDate)}` : ''}`;

    // FCM deep-link data
    const fcmData: Record<string, string> = {
      type: 'subject_resource',
      resource_id: resourceId,
      subject,
      resource_type: resourceType,
    };

    const studentIds = (students as Array<{ id: string; fcm_token: string | null }>).map((s) => s.id);

    // Insert in-app notifications in batches
    for (let i = 0; i < studentIds.length; i += FCM_BATCH_SIZE) {
      const batch = studentIds.slice(i, i + FCM_BATCH_SIZE);

      // In-app notifications
      const notifRows = batch.map((studentId) => ({
        title: notifTitle,
        message: notifBody,
        type: 'announcement',
        recipient_id: studentId,
        sender_id: senderId,
        is_read: false,
        created_at: new Date().toISOString(),
      }));

      try {
        await supabaseAdmin.from('notifications').insert(notifRows);
      } catch (err) {
        console.error('[subject-resources] Failed to insert notifications batch:', err);
      }

      // FCM push
      const tokens = await getTokensForStudents(batch);
      if (tokens.length > 0) {
        await sendPushMulticast(tokens, notifTitle, notifBody, fcmData);
      }

      if (i + FCM_BATCH_SIZE < studentIds.length) {
        await sleep(100);
      }
    }

    console.log(`[subject-resources] Notified ${students.length} students for resource ${resourceId}`);
  } catch (err) {
    console.error('[subject-resources] Error in notifyStudents:', err);
  }
}

// ── POST /api/subject-resources/upload ───────────────────────────────────────
/**
 * Upload one or more files to Supabase Storage.
 * Returns array of public URLs.
 * Called before creating the resource record.
 */
router.post(
  '/upload',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  upload.array('files', MAX_FILES_PER_RESOURCE),
  async (req: Request, res: Response) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      sendError(res, 'No files provided', 400);
      return;
    }

    const teacherId = req.user!.id;
    const schoolId = req.user!.school_id ?? 'global';

    // Use a temp folder keyed by teacher + timestamp (resource_id not available yet)
    const tempPrefix = `${schoolId}/${teacherId}/temp/${Date.now()}`;

    const uploadedUrls: string[] = [];

    for (const file of files) {
      const ext = file.originalname.split('.').pop()?.toLowerCase() ?? 'bin';
      const safeName = file.originalname
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 100);
      const storagePath = `${tempPrefix}/${Date.now()}_${safeName}`;

      const { error: uploadErr } = await supabaseAdmin
        .storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadErr) {
        sendError(res, `Failed to upload file "${file.originalname}": ${uploadErr.message}`, 500);
        return;
      }

      const { data: publicUrlData } = supabaseAdmin
        .storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(storagePath);

      uploadedUrls.push(publicUrlData.publicUrl);
    }

    sendSuccess(res, { urls: uploadedUrls }, 'Files uploaded successfully');
  }
);

// ── POST /api/subject-resources ───────────────────────────────────────────────
/**
 * Create a new subject resource record.
 * Files must already be uploaded via /upload.
 */
const createSchema = z.object({
  class: z.string().min(1).max(20),
  section: z.string().min(1).max(10),
  subject: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional().nullable(),
  resource_type: z.enum(['note', 'assignment']),
  file_urls: z.array(z.string().url()).min(1).max(MAX_FILES_PER_RESOURCE),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

router.post(
  '/',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  createRateLimit,
  async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const teacherId = req.user!.id;
    const schoolId = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    const { class: cls, section, subject, title, description, resource_type, file_urls, due_date } = parsed.data;

    // Validate all URLs belong to this project
    for (const url of file_urls) {
      if (!isValidStorageUrl(url)) {
        sendError(res, `Invalid file URL: ${url}`, 400);
        return;
      }
    }

    // Teachers must be assigned to the class
    if (req.user!.role === 'teacher') {
      const { data: assignment } = await supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', teacherId)
        .ilike('class_name', cls.trim())
        .ilike('section', section.trim())
        .limit(1)
        .maybeSingle();

      if (!assignment) {
        // Try legacy 'class' column
        const { data: legacyAssignment } = await supabaseAdmin
          .from('teacher_assignments')
          .select('id')
          .eq('teacher_id', teacherId)
          .ilike('class', cls.trim())
          .ilike('section', section.trim())
          .limit(1)
          .maybeSingle();

        if (!legacyAssignment) {
          sendError(res, 'You are not assigned to this class/section', 403);
          return;
        }
      }
    }

    const { data: resource, error: insertErr } = await supabaseAdmin
      .from('subject_resources')
      .insert({
        school_id: schoolId,
        teacher_id: teacherId,
        class: cls,
        section,
        subject,
        title,
        description: description ?? null,
        resource_type,
        file_urls,
        due_date: due_date ?? null,
      })
      .select()
      .single();

    if (insertErr || !resource) {
      sendError(res, insertErr?.message ?? 'Failed to create resource', 500);
      return;
    }

    await logAudit(teacherId, 'SUBJECT_RESOURCE_CREATED', {
      resource_id: (resource as Record<string, unknown>).id,
      title,
      resource_type,
      class: cls,
      section,
      subject,
    });

    // Fire-and-forget FCM to all students in that class/section
    setImmediate(() => {
      void notifyStudents(
        schoolId,
        cls,
        section,
        subject,
        title,
        resource_type,
        due_date ?? null,
        teacherId,
        String((resource as Record<string, unknown>).id)
      );
    });

    sendSuccess(res, resource, 'Resource created successfully', 201);
  }
);

// ── GET /api/subject-resources/mine ──────────────────────────────────────────
/**
 * List the authenticated teacher's own uploaded resources.
 * Supports pagination: ?page=1&limit=20
 */
router.get(
  '/mine',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const teacherId = req.user!.id;
    const schoolId = req.user!.school_id;

    if (!schoolId && req.user!.role !== 'superadmin') {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    const page  = Math.max(1, parseInt((req.query.page as string) ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10)));
    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('subject_resources')
      .select('*')
      .eq('teacher_id', teacherId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (schoolId) {
      query = query.eq('school_id', schoolId);
    }

    const { data, error } = await query;

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data ?? []);
  }
);

// ── GET /api/subject-resources/admin/weekly-stats ────────────────────────────
/**
 * Admin: count resources uploaded this week, grouped by teacher.
 * Available to schooladmin and superadmin.
 */
router.get(
  '/admin/weekly-stats',
  authenticate,
  requireRole('superadmin', 'schooladmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id;

    if (!schoolId && req.user!.role !== 'superadmin') {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // Start of current week (Monday 00:00 UTC)
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=Sun
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - daysToMonday);
    monday.setUTCHours(0, 0, 0, 0);
    const weekStart = monday.toISOString();

    let query = supabaseAdmin
      .from('subject_resources')
      .select('id, teacher_id, resource_type, created_at')
      .gte('created_at', weekStart);

    if (schoolId) {
      query = query.eq('school_id', schoolId);
    }

    const { data: rows, error } = await query;

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    // Group by teacher_id
    const teacherMap = new Map<string, { notes: number; assignments: number }>();
    for (const row of rows ?? []) {
      const r = row as Record<string, unknown>;
      const tid = r.teacher_id as string;
      const rt = r.resource_type as string;
      if (!teacherMap.has(tid)) {
        teacherMap.set(tid, { notes: 0, assignments: 0 });
      }
      const entry = teacherMap.get(tid)!;
      if (rt === 'note') entry.notes++;
      else if (rt === 'assignment') entry.assignments++;
    }

    // Fetch teacher names
    const teacherIds = Array.from(teacherMap.keys());
    let teacherNames: Record<string, string> = {};

    if (teacherIds.length > 0) {
      const { data: teachers } = await supabaseAdmin
        .from('users')
        .select('id, name')
        .in('id', teacherIds);

      for (const t of teachers ?? []) {
        const tr = t as Record<string, unknown>;
        teacherNames[tr.id as string] = tr.name as string;
      }
    }

    const stats = teacherIds.map((tid) => {
      const counts = teacherMap.get(tid)!;
      return {
        teacher_id: tid,
        teacher_name: teacherNames[tid] ?? 'Unknown',
        notes_count: counts.notes,
        assignments_count: counts.assignments,
        total: counts.notes + counts.assignments,
      };
    }).sort((a, b) => b.total - a.total);

    sendSuccess(res, {
      week_start: weekStart,
      total_this_week: (rows ?? []).length,
      by_teacher: stats,
    });
  }
);

// ── GET /api/subject-resources ────────────────────────────────────────────────
/**
 * Student/parent: list resources for their class/section.
 * Optionally filter by ?subject=Math
 * Staff can also call this with ?class=&section=&school_id= query params.
 */
router.get(
  '/',
  authenticateAny,
  async (req: Request, res: Response) => {
    let schoolId: string;
    let className: string;
    let section: string;

    if (req.tokenType === 'student') {
      // Student token: use their own class/section
      const student = req.student!;
      schoolId  = student.school_id;
      className = student.class_name ?? '';
      section   = student.section ?? '';

      if (!className || !section) {
        sendError(res, 'Student is not assigned to a class/section', 400);
        return;
      }
    } else {
      // Staff token
      const user = req.user!;
      const qClass   = req.query.class   as string | undefined;
      const qSection = req.query.section as string | undefined;
      const qSchool  = req.query.school_id as string | undefined;

      if (user.role === 'superadmin') {
        schoolId  = qSchool  ?? user.school_id ?? '';
        className = qClass   ?? '';
        section   = qSection ?? '';
      } else {
        schoolId  = user.school_id ?? '';
        className = qClass   ?? '';
        section   = qSection ?? '';
      }

      if (!schoolId || !className || !section) {
        sendError(res, 'class, section, and school_id are required', 400);
        return;
      }
    }

    const subject  = req.query.subject  as string | undefined;
    const page     = Math.max(1, parseInt((req.query.page as string) ?? '1', 10));
    const limit    = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? '50', 10)));
    const from     = (page - 1) * limit;

    let query = supabaseAdmin
      .from('subject_resources')
      .select('id, school_id, teacher_id, class, section, subject, title, description, resource_type, file_urls, due_date, created_at')
      .eq('school_id', schoolId)
      .ilike('class', className.trim())
      .ilike('section', section.trim())
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (subject) {
      query = query.ilike('subject', subject.trim());
    }

    const { data, error } = await query;

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data ?? []);
  }
);

// ── GET /api/subject-resources/subjects ──────────────────────────────────────
/**
 * Return distinct subjects that have resources for a given class/section.
 */
router.get(
  '/subjects',
  authenticateAny,
  async (req: Request, res: Response) => {
    let schoolId: string;
    let className: string;
    let section: string;

    if (req.tokenType === 'student') {
      const student = req.student!;
      schoolId  = student.school_id;
      className = student.class_name ?? '';
      section   = student.section   ?? '';
    } else {
      const user = req.user!;
      schoolId  = (req.query.school_id as string | undefined) ?? user.school_id ?? '';
      className = (req.query.class    as string | undefined) ?? '';
      section   = (req.query.section  as string | undefined) ?? '';
    }

    if (!schoolId || !className || !section) {
      sendError(res, 'class, section, and school_id are required', 400);
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('subject_resources')
      .select('subject')
      .eq('school_id', schoolId)
      .ilike('class', className.trim())
      .ilike('section', section.trim());

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    const subjects = [...new Set((data ?? []).map((r: Record<string, unknown>) => r.subject as string))].sort();
    sendSuccess(res, subjects);
  }
);

// ── PATCH /api/subject-resources/:id ─────────────────────────────────────────
/**
 * Edit title / description / due_date of a resource.
 * File changes require delete + re-upload.
 */
const patchSchema = z.object({
  title:       z.string().min(1).max(300).optional(),
  description: z.string().max(2000).nullable().optional(),
  due_date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

router.patch(
  '/:id',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    // Fetch the existing resource to verify ownership
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('subject_resources')
      .select('id, teacher_id, school_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      sendError(res, 'Resource not found', 404);
      return;
    }

    const ex = existing as Record<string, unknown>;
    const userRole = req.user!.role;

    // Ownership check: teachers can only edit their own resources
    if (userRole === 'teacher' && ex.teacher_id !== req.user!.id) {
      sendError(res, 'You can only edit your own resources', 403);
      return;
    }

    // schooladmin can only edit within their school
    if (userRole === 'schooladmin' && ex.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }

    const updatePayload: Record<string, unknown> = {};
    if (parsed.data.title       !== undefined) updatePayload.title       = parsed.data.title;
    if (parsed.data.description !== undefined) updatePayload.description = parsed.data.description;
    if (parsed.data.due_date    !== undefined) updatePayload.due_date    = parsed.data.due_date;

    if (Object.keys(updatePayload).length === 0) {
      sendError(res, 'No fields to update', 400);
      return;
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('subject_resources')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      sendError(res, updateErr.message, 500);
      return;
    }

    sendSuccess(res, updated, 'Resource updated');
  }
);

// ── DELETE /api/subject-resources/:id ────────────────────────────────────────
/**
 * Delete a resource record AND remove its files from Supabase Storage.
 */
router.delete(
  '/:id',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('subject_resources')
      .select('id, teacher_id, school_id, file_urls, title')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !existing) {
      sendError(res, 'Resource not found', 404);
      return;
    }

    const ex = existing as Record<string, unknown>;
    const userRole = req.user!.role;

    if (userRole === 'teacher' && ex.teacher_id !== req.user!.id) {
      sendError(res, 'You can only delete your own resources', 403);
      return;
    }

    if (userRole === 'schooladmin' && ex.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }

    // Delete files from Supabase Storage (best-effort)
    const fileUrls = (ex.file_urls as string[]) ?? [];
    if (fileUrls.length > 0) {
      const paths = fileUrls
        .map(storagePathFromUrl)
        .filter((p): p is string => p !== null);

      if (paths.length > 0) {
        const { error: storageErr } = await supabaseAdmin
          .storage
          .from(STORAGE_BUCKET)
          .remove(paths);

        if (storageErr) {
          console.warn(`[subject-resources] Storage removal partial failure for resource ${id}:`, storageErr.message);
        }
      }
    }

    // Delete the database record
    const { error: deleteErr } = await supabaseAdmin
      .from('subject_resources')
      .delete()
      .eq('id', id);

    if (deleteErr) {
      sendError(res, deleteErr.message, 500);
      return;
    }

    await logAudit(req.user!.id, 'SUBJECT_RESOURCE_DELETED', {
      resource_id: id,
      title: ex.title,
    });

    sendSuccess(res, { id }, 'Resource deleted successfully');
  }
);

export default router;
