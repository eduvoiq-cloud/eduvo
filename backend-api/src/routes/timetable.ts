import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

// ── Multer (memory storage — file held in RAM, then streamed to Supabase) ─────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    if (allowed.includes(file.mimetype) || /\.(pdf|jpe?g|png|webp|heic)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF or image files (JPG, PNG, WEBP, HEIC) are accepted.'));
    }
  },
});

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type DayOfWeek = (typeof VALID_DAYS)[number];

// ── Zod schemas ───────────────────────────────────────────────────────────────

/** HH:MM time string */
const timeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format')
  .refine((t) => {
    const [h, m] = t.split(':').map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }, 'Invalid time value');

const daySchema = z.enum(VALID_DAYS, {
  error: `day_of_week must be one of: ${VALID_DAYS.join(', ')}`,
});

const createPeriodSchema = z.object({
  class: z.string().min(1).max(20),
  section: z.string().min(1).max(10),
  day_of_week: daySchema,
  period_number: z.number().int().positive('period_number must be a positive integer'),
  start_time: timeSchema,
  end_time: timeSchema,
  subject_id: z.string().uuid(),
});

const updatePeriodSchema = z.object({
  start_time: timeSchema.optional(),
  end_time: timeSchema.optional(),
  subject_id: z.string().uuid().optional(),
});

const copyWeekSchema = z.object({
  from_class: z.string().min(1).max(20),
  from_section: z.string().min(1).max(10),
  to_class: z.string().min(1).max(20),
  to_section: z.string().min(1).max(10),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Insert a row into audit_logs. Errors are swallowed so they never break the main flow. */
async function logAudit(
  userId: string | null,
  action: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      action,
      table_name: 'timetable',
      details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err);
  }
}

/**
 * Convert a flat array of timetable rows into a day-keyed object.
 * Each day contains periods sorted by period_number.
 */
function groupByDay(
  rows: Array<{
    id: string;
    period_number: number;
    start_time: string;
    end_time: string;
    day_of_week: string;
    subject_name: string | null;
    teacher_name: string | null;
    subject_id: string;
    teacher_id: string;
    class_name: string;
    section: string;
  }>
): Record<DayOfWeek, unknown[]> {
  const result: Record<DayOfWeek, unknown[]> = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
  };

  for (const row of rows) {
    const day = row.day_of_week as DayOfWeek;
    if (result[day] !== undefined) {
      result[day].push({
        id: row.id,
        period: row.period_number,
        start_time: row.start_time,
        end_time: row.end_time,
        subject_id: row.subject_id,
        subject_name: row.subject_name,
        teacher_id: row.teacher_id,
        teacher_name: row.teacher_name,
        class_name: row.class_name,
        section: row.section,
      });
    }
  }

  // Sort each day's periods by period_number
  for (const day of VALID_DAYS) {
    result[day].sort(
      (a: unknown, b: unknown) =>
        (a as { period: number }).period - (b as { period: number }).period
    );
  }

  return result;
}

/** Compare two HH:MM strings. Returns true if a < b. */
function timeBefore(a: string, b: string): boolean {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return ah * 60 + am < bh * 60 + bm;
}

// ── GET /api/timetable/class ──────────────────────────────────────────────────
/**
 * Fetch the full week timetable for a class/section.
 * Accessible by any authenticated user (staff or student) of the same school.
 * Students can only view their own class timetable.
 *
 * Query params: class, section, school_id
 */
router.get(
  '/class',
  async (req: Request, res: Response, next) => {
    // Accept either a staff token or a student token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      sendError(res, 'Missing or malformed Authorization header', 401);
      return;
    }

    // Try student auth first, then staff auth
    authenticateStudent(req, res, (studentErr) => {
      if (!studentErr && req.student) return next();
      authenticate(req, res, (staffErr) => {
        if (!staffErr && req.user) return next();
        sendError(res, 'Invalid or expired token', 401);
      });
    });
  },
  async (req: Request, res: Response) => {
    const { class: className, section } = req.query as Record<string, string>;
    let school_id = req.query.school_id as string | undefined;

    if (!className || !section) {
      sendError(res, 'class and section are required', 400);
      return;
    }

    // Determine school_id from token if not provided
    if (!school_id) {
      if (req.student) {
        school_id = req.student.school_id;
      } else if (req.user) {
        school_id = req.user.school_id ?? undefined;
      }
    }

    if (!school_id) {
      sendError(res, 'school_id is required', 400);
      return;
    }

    // Students can only view their own class timetable
    if (req.student) {
      if (
        req.student.class_name !== className ||
        req.student.section !== section
      ) {
        sendError(res, 'You can only view your own class timetable', 403);
        return;
      }
    }

    const { data, error } = await supabaseAdmin
      .from('timetable')
      .select(
        `id, period_number, start_time, end_time, day_of_week,
         class_name, section, subject_id, teacher_id,
         subjects!timetable_subject_id_fkey(name),
         users!timetable_teacher_id_fkey(name)`
      )
      .eq('school_id', school_id)
      .eq('class_name', className)
      .eq('section', section)
      .order('day_of_week')
      .order('period_number');

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    // Flatten joined fields
    const rows = (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      period_number: r.period_number as number,
      start_time: r.start_time as string,
      end_time: r.end_time as string,
      day_of_week: r.day_of_week as string,
      class_name: r.class_name as string,
      section: r.section as string,
      subject_id: r.subject_id as string,
      teacher_id: r.teacher_id as string,
      subject_name: (r.subjects as { name: string } | null)?.name ?? null,
      teacher_name: (r.users as { name: string } | null)?.name ?? null,
    }));

    // Timetable rarely changes — cache for 1 hour to reduce server load
    res.setHeader('Cache-Control', 'public, max-age=3600');

    sendSuccess(res, groupByDay(rows));
  }
);

// ── GET /api/timetable/teacher ────────────────────────────────────────────────
/**
 * Returns the authenticated teacher's full week schedule across all classes.
 * Auth: teacher token (or schooladmin/superadmin to view any teacher via ?teacher_id=)
 */
router.get(
  '/teacher',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    let teacherId: string;

    if (req.user!.role === 'teacher') {
      teacherId = req.user!.id;
    } else {
      // schooladmin / superadmin can pass ?teacher_id= to view any teacher
      const qTeacherId = req.query.teacher_id as string | undefined;
      if (!qTeacherId) {
        sendError(res, 'teacher_id query param is required for admin access', 400);
        return;
      }
      teacherId = qTeacherId;
    }

    const { data, error } = await supabaseAdmin
      .from('timetable')
      .select(
        `id, period_number, start_time, end_time, day_of_week,
         class_name, section, subject_id, teacher_id,
         subjects!timetable_subject_id_fkey(name),
         users!timetable_teacher_id_fkey(name)`
      )
      .eq('teacher_id', teacherId)
      .order('day_of_week')
      .order('period_number');

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    const rows = (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      period_number: r.period_number as number,
      start_time: r.start_time as string,
      end_time: r.end_time as string,
      day_of_week: r.day_of_week as string,
      class_name: r.class_name as string,
      section: r.section as string,
      subject_id: r.subject_id as string,
      teacher_id: r.teacher_id as string,
      subject_name: (r.subjects as { name: string } | null)?.name ?? null,
      teacher_name: (r.users as { name: string } | null)?.name ?? null,
    }));

    sendSuccess(res, groupByDay(rows));
  }
);

// ── POST /api/timetable/period ────────────────────────────────────────────────
/**
 * Add a new period slot to the timetable.
 * Auth: teacher (must be assigned to the class+subject), schooladmin, superadmin.
 */
router.post(
  '/period',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const parsed = createPeriodSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const {
      class: className,
      section,
      day_of_week,
      period_number,
      start_time,
      end_time,
      subject_id,
    } = parsed.data;

    const userId = req.user!.id;
    const userRole = req.user!.role;
    const school_id = req.user!.school_id;

    if (!school_id) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // Validate start_time < end_time
    if (!timeBefore(start_time, end_time)) {
      sendError(res, 'start_time must be before end_time', 400);
      return;
    }

    // Teachers must be assigned to this class + subject
    if (userRole === 'teacher') {
      // Resolve subject name from subject_id
      const { data: subject, error: subErr } = await supabaseAdmin
        .from('subjects')
        .select('name')
        .eq('id', subject_id)
        .eq('school_id', school_id)
        .maybeSingle();

      if (subErr || !subject) {
        sendError(res, 'Subject not found', 404);
        return;
      }

      const { data: assignment } = await supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', userId)
        .eq('class_name', className)
        .eq('section', section)
        .eq('subject', subject.name)
        .maybeSingle();

      if (!assignment) {
        sendError(res, 'You are not assigned to this class and subject', 403);
        return;
      }
    }

    // Check for slot conflict: same class+section+day+period
    const { data: existing } = await supabaseAdmin
      .from('timetable')
      .select('id')
      .eq('school_id', school_id)
      .eq('class_name', className)
      .eq('section', section)
      .eq('day_of_week', day_of_week)
      .eq('period_number', period_number)
      .maybeSingle();

    if (existing) {
      sendError(res, 'Period slot already taken', 409);
      return;
    }

    // Insert the period
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('timetable')
      .insert({
        school_id,
        class_name: className,
        section,
        day_of_week,
        period_number,
        start_time,
        end_time,
        subject_id,
        teacher_id: userId,
        created_by: userId,
        created_at: new Date().toISOString(),
      })
      .select(
        `id, period_number, start_time, end_time, day_of_week,
         class_name, section, subject_id, teacher_id, created_at`
      )
      .single();

    if (insertErr) {
      sendError(res, insertErr.message, 500);
      return;
    }

    await logAudit(userId, 'TIMETABLE_PERIOD_CREATED', {
      period_id: inserted.id,
      class_name: className,
      section,
      day_of_week,
      period_number,
      school_id,
    });

    sendSuccess(res, inserted, 'Period created', 201);
  }
);

// ── PUT /api/timetable/period/:id ─────────────────────────────────────────────
/**
 * Update an existing period (start_time, end_time, subject_id).
 * Auth: teacher who created it, or schooladmin/superadmin.
 */
router.put(
  '/period/:id',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const parsed = updatePeriodSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { start_time, end_time, subject_id } = parsed.data;

    if (!start_time && !end_time && !subject_id) {
      sendError(res, 'At least one field (start_time, end_time, subject_id) must be provided', 400);
      return;
    }

    const userId = req.user!.id;
    const userRole = req.user!.role;

    // Fetch the existing period
    const { data: period, error: fetchErr } = await supabaseAdmin
      .from('timetable')
      .select('id, created_by, teacher_id, start_time, end_time, school_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !period) {
      sendError(res, 'Period not found', 404);
      return;
    }

    // Teachers can only update periods they created
    if (userRole === 'teacher' && period.created_by !== userId) {
      sendError(res, 'You can only update periods you created', 403);
      return;
    }

    // Validate time range if both are being updated (or one against the existing value)
    const resolvedStart = start_time ?? period.start_time;
    const resolvedEnd = end_time ?? period.end_time;
    if (!timeBefore(resolvedStart, resolvedEnd)) {
      sendError(res, 'start_time must be before end_time', 400);
      return;
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (start_time) updates.start_time = start_time;
    if (end_time) updates.end_time = end_time;
    if (subject_id) updates.subject_id = subject_id;

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('timetable')
      .update(updates)
      .eq('id', id)
      .select(
        `id, period_number, start_time, end_time, day_of_week,
         class_name, section, subject_id, teacher_id, updated_at`
      )
      .single();

    if (updateErr) {
      sendError(res, updateErr.message, 500);
      return;
    }

    await logAudit(userId, 'TIMETABLE_PERIOD_UPDATED', {
      period_id: id,
      changes: updates,
    });

    sendSuccess(res, updated, 'Period updated');
  }
);

// ── DELETE /api/timetable/period/:id ─────────────────────────────────────────
/**
 * Delete a period from the timetable.
 * Auth: teacher who created it, or schooladmin/superadmin.
 */
router.delete(
  '/period/:id',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    // Fetch the period to verify ownership
    const { data: period, error: fetchErr } = await supabaseAdmin
      .from('timetable')
      .select('id, created_by, class_name, section, day_of_week, period_number')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !period) {
      sendError(res, 'Period not found', 404);
      return;
    }

    // Teachers can only delete periods they created
    if (userRole === 'teacher' && period.created_by !== userId) {
      sendError(res, 'You can only delete periods you created', 403);
      return;
    }

    const { error: deleteErr } = await supabaseAdmin
      .from('timetable')
      .delete()
      .eq('id', id);

    if (deleteErr) {
      sendError(res, deleteErr.message, 500);
      return;
    }

    await logAudit(userId, 'TIMETABLE_PERIOD_DELETED', {
      period_id: id,
      class_name: period.class_name,
      section: period.section,
      day_of_week: period.day_of_week,
      period_number: period.period_number,
    });

    sendSuccess(res, { id }, 'Period deleted');
  }
);

// ── POST /api/timetable/copy-week ─────────────────────────────────────────────
/**
 * Copy an entire week's timetable from one class/section to another.
 * Auth: schooladmin or superadmin only.
 * Fails if the destination class already has any timetable entries.
 */
router.post(
  '/copy-week',
  authenticate,
  requireRole('superadmin', 'schooladmin'),
  async (req: Request, res: Response) => {
    const parsed = copyWeekSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { from_class, from_section, to_class, to_section } = parsed.data;
    const userId = req.user!.id;
    const school_id = req.user!.school_id;

    if (!school_id) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // Prevent copying to the same class+section
    if (from_class === to_class && from_section === to_section) {
      sendError(res, 'Source and destination class/section cannot be the same', 400);
      return;
    }

    // Check destination has no existing timetable
    const { count: destCount } = await supabaseAdmin
      .from('timetable')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', school_id)
      .eq('class_name', to_class)
      .eq('section', to_section);

    if ((destCount ?? 0) > 0) {
      sendError(
        res,
        `Destination class ${to_class}-${to_section} already has a timetable. Clear it first.`,
        409
      );
      return;
    }

    // Fetch source timetable
    const { data: sourcePeriods, error: fetchErr } = await supabaseAdmin
      .from('timetable')
      .select(
        'period_number, start_time, end_time, day_of_week, subject_id, teacher_id'
      )
      .eq('school_id', school_id)
      .eq('class_name', from_class)
      .eq('section', from_section);

    if (fetchErr) {
      sendError(res, fetchErr.message, 500);
      return;
    }

    if (!sourcePeriods || sourcePeriods.length === 0) {
      sendError(res, `No timetable found for ${from_class}-${from_section}`, 404);
      return;
    }

    // Build destination rows
    const now = new Date().toISOString();
    const newRows = sourcePeriods.map((p: {
      period_number: number;
      start_time: string;
      end_time: string;
      day_of_week: string;
      subject_id: string;
      teacher_id: string;
    }) => ({
      school_id,
      class_name: to_class,
      section: to_section,
      period_number: p.period_number,
      start_time: p.start_time,
      end_time: p.end_time,
      day_of_week: p.day_of_week,
      subject_id: p.subject_id,
      teacher_id: p.teacher_id,
      created_by: userId,
      created_at: now,
    }));

    const { error: insertErr } = await supabaseAdmin
      .from('timetable')
      .insert(newRows);

    if (insertErr) {
      sendError(res, insertErr.message, 500);
      return;
    }

    await logAudit(userId, 'TIMETABLE_WEEK_COPIED', {
      from_class,
      from_section,
      to_class,
      to_section,
      periods_copied: newRows.length,
      school_id,
    });

    sendSuccess(
      res,
      { periods_copied: newRows.length },
      `Copied ${newRows.length} period(s) from ${from_class}-${from_section} to ${to_class}-${to_section}`,
      201
    );
  }
);

// ── POST /api/timetable/upload ────────────────────────────────────────────────
/**
 * Upload a timetable file (PDF / image) for a class/section.
 * The file is stored in the Supabase Storage bucket "timetable-uploads".
 * An audit log entry is created so admins can review it.
 * Auth: teacher, schooladmin, superadmin.
 */
router.post(
  '/upload',
  authenticate,
  requireRole('superadmin', 'schooladmin', 'teacher'),
  (req: Request, res: Response, next) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          sendError(res, 'File must be under 10 MB.', 400);
        } else {
          sendError(res, err.message, 400);
        }
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
      sendError(res, 'No file provided.', 400);
      return;
    }

    const userId = req.user!.id;
    const school_id = req.user!.school_id;
    const className = req.body.class as string | undefined;
    const section = req.body.section as string | undefined;

    if (!school_id) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // Build a unique storage path: timetable-uploads/<school_id>/<class>-<section>/<timestamp>_<filename>
    const ts = Date.now();
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const folder = className && section ? `${className}-${section}` : 'misc';
    const storagePath = `${school_id}/${folder}/${ts}_${safeName}`;

    const BUCKET = 'timetable-uploads';

    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error('[timetable/upload] Storage error:', uploadError.message);
      sendError(res, `Failed to store file: ${uploadError.message}`, 500);
      return;
    }

    // Get a public or signed URL for reference
    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    await logAudit(userId, 'TIMETABLE_FILE_UPLOADED', {
      school_id,
      class_name: className ?? null,
      section: section ?? null,
      file_name: req.file.originalname,
      file_size: req.file.size,
      storage_path: storagePath,
      public_url: urlData?.publicUrl ?? null,
    });

    // ── Notify students in the class/section ──────────────────────────────────
    let notifiedCount = 0;
    if (className && section) {
      try {
        // Fetch all active students in this class+section
        const { data: students } = await supabaseAdmin
          .from('students')
          .select('id')
          .eq('school_id', school_id)
          .eq('class_name', className)
          .eq('section', section)
          .eq('is_deleted', false);

        if (students && students.length > 0) {
          const publicUrl = urlData?.publicUrl ?? null;
          const notifTitle = 'Timetable Updated';
          const notifBody = publicUrl
            ? `Your class timetable for ${className}-${section} has been updated. View: ${publicUrl}`
            : `Your class timetable for ${className}-${section} has been updated.`;

          const notifRows = students.map((s: { id: string }) => ({
            title: notifTitle,
            message: notifBody,
            type: 'announcement',
            recipient_id: s.id,
            sender_id: userId,
            is_read: false,
            created_at: new Date().toISOString(),
          }));

          const { error: notifError } = await supabaseAdmin
            .from('notifications')
            .insert(notifRows);

          if (!notifError) {
            notifiedCount = students.length;
          } else {
            console.error('[timetable/upload] Failed to send notifications:', notifError.message);
          }
        }
      } catch (notifErr) {
        console.error('[timetable/upload] Notification error:', notifErr);
      }
    }

    sendSuccess(
      res,
      {
        storage_path: storagePath,
        public_url: urlData?.publicUrl ?? null,
        file_name: req.file.originalname,
        file_size: req.file.size,
        students_notified: notifiedCount,
      },
      'Timetable uploaded successfully.',
      201
    );
  }
);

export default router;
