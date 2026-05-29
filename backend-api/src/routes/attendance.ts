import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import * as admin from 'firebase-admin';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

// ── Firebase Admin initialisation (lazy, idempotent) ─────────────────────────
// Credentials are read from GOOGLE_APPLICATION_CREDENTIALS env var (path to
// service-account JSON) or from individual FIREBASE_* env vars.
// If neither is set the app boots without FCM — push notifications are skipped
// gracefully rather than crashing the server.

function getFirebaseApp(): admin.app.App | null {
  try {
    // Return existing app if already initialised
    return admin.app();
  } catch {
    // Not yet initialised — try to set up now
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (projectId && clientEmail && privateKey) {
      return admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
    }

    // Fall back to Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS)
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      return admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    }

    console.warn('[fcm] Firebase credentials not configured — push notifications disabled');
    return null;
  }
}

// ── RFID-specific rate limiter: 200 req/min ───────────────────────────────────
const rfidRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'RFID rate limit exceeded. Try again shortly.' },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Insert a row into audit_logs. Errors are swallowed so they never break the main flow. */
async function logAudit(
  userId: string | null,
  action: string,
  tableName: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      action,
      table_name: tableName,
      details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err);
  }
}

/** Returns today's date as YYYY-MM-DD in the server's local timezone. */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Format a Date as HH:MM (24-hour). */
function formatTime(d: Date): string {
  return d.toTimeString().slice(0, 5);
}

/**
 * Send an FCM push notification to a single device token.
 * Returns true on success, false if FCM is not configured or the send fails.
 */
async function sendFcmNotification(
  fcmToken: string,
  title: string,
  body: string
): Promise<boolean> {
  const app = getFirebaseApp();
  if (!app) return false;

  try {
    await admin.messaging(app).send({
      token: fcmToken,
      notification: { title, body },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    return true;
  } catch (err) {
    console.error('[fcm] Send failed:', err);
    return false;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// All routes below require a valid JWT except /rfid which uses its own
// auth-free path (RFID readers call it directly with school_id).
// Authenticated routes apply authenticate middleware individually.

// ── POST /api/attendance/rfid ─────────────────────────────────────────────────
/**
 * Called by RFID gate readers. No JWT required — the reader authenticates
 * via school_id + rfid_uid. Rate-limited to 200 req/min.
 *
 * Flow:
 *  1. Find student by rfid_uid (not deleted)
 *  2. Check for duplicate attendance today
 *  3. Insert attendance (status = present)
 *  4. Queue parent notification (send_after = now + 30 min)
 *  5. Insert notification record for parent
 *  6. Audit log
 */
router.post('/rfid', rfidRateLimit, async (req: Request, res: Response) => {
  const schema = z.object({
    rfid_uid: z.string().min(1),
    school_id: z.string().uuid(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { rfid_uid, school_id } = parsed.data;
  const today = todayDate();
  const now = new Date();

  // 1. Find student by rfid_uid
  const { data: student, error: studentErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, parent_id')
    .eq('rfid_uid', rfid_uid)
    .eq('school_id', school_id)
    .eq('is_deleted', false)
    .single();

  if (studentErr || !student) {
    res.status(404).json({ success: false, error: 'Card not registered' });
    return;
  }

  // 2. Check for duplicate attendance today
  const { data: existing } = await supabaseAdmin
    .from('attendance')
    .select('id, created_at')
    .eq('student_id', student.id)
    .eq('date', today)
    .maybeSingle();

  if (existing) {
    res.status(200).json({
      success: false,
      error: 'Already marked',
      student_name: student.full_name,
      marked_at: formatTime(new Date(existing.created_at)),
    });
    return;
  }

  // 3. Insert attendance record
  const { error: insertErr } = await supabaseAdmin
    .from('attendance')
    .insert({
      student_id: student.id,
      date: today,
      status: 'present',
      marked_by: null,
      source: 'rfid',
      created_at: now.toISOString(),
    });

  if (insertErr) {
    sendError(res, 'Failed to record attendance', 500);
    return;
  }

  // 4 & 5. Queue notification + insert into notifications table for parent
  if (student.parent_id) {
    const arrivalTime = formatTime(now);
    const notifTitle = 'Student Arrival';
    const notifBody = `Your child ${student.full_name} arrived at school at ${arrivalTime}`;
    const sendAfter = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

    // Insert into notifications table (in-app)
    await supabaseAdmin.from('notifications').insert({
      title: notifTitle,
      body: notifBody,
      type: 'attendance',
      recipient_id: student.parent_id,
      sender_id: student.parent_id, // system-generated; use parent_id as placeholder
      is_read: false,
      created_at: now.toISOString(),
    });

    // Queue FCM push (delayed 30 min)
    await supabaseAdmin.from('notification_queue').insert({
      user_id: student.parent_id,
      student_id: student.id,
      message: notifBody,
      send_after: sendAfter,
      sent: false,
      cancelled: false,
      created_at: now.toISOString(),
    });
  }

  // 6. Audit log
  await logAudit(null, 'rfid_attendance', 'attendance', {
    student_id: student.id,
    student_name: student.full_name,
    school_id,
    date: today,
  });

  res.status(200).json({
    success: true,
    student_name: student.full_name,
    class: student.class_name,
    section: student.section,
  });
});

// All routes below this point require authentication
router.use(authenticate);

// ── POST /api/attendance/manual ───────────────────────────────────────────────
/**
 * Bulk manual attendance entry by a teacher or school admin.
 *
 * Body: { attendances: [{ student_id, status }], class, section, date }
 */
router.post(
  '/manual',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      attendances: z
        .array(
          z.object({
            student_id: z.string().uuid(),
            status: z.enum(['present', 'absent', 'late', 'excused']),
          })
        )
        .min(1),
      class: z.string().min(1),
      section: z.string().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { attendances, class: className, section, date } = parsed.data;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    // Verify teacher is assigned to this class (skip check for superadmin/schooladmin)
    if (userRole === 'teacher') {
      const { data: assignment } = await supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', userId)
        .eq('class_name', className)
        .eq('section', section)
        .maybeSingle();

      if (!assignment) {
        sendError(res, 'You are not assigned to this class', 403);
        return;
      }
    }

    const saved: string[] = [];
    const skipped: { student_name: string; reason: string }[] = [];

    for (const entry of attendances) {
      // Check if attendance already exists for this student on this date
      const { data: existing } = await supabaseAdmin
        .from('attendance')
        .select('id')
        .eq('student_id', entry.student_id)
        .eq('date', date)
        .maybeSingle();

      if (existing) {
        // Fetch student name for the skipped report
        const { data: stu } = await supabaseAdmin
          .from('students')
          .select('full_name')
          .eq('id', entry.student_id)
          .maybeSingle();

        skipped.push({
          student_name: stu?.full_name ?? entry.student_id,
          reason: 'already_marked',
        });
        continue;
      }

      const { error: insertErr } = await supabaseAdmin.from('attendance').insert({
        student_id: entry.student_id,
        date,
        status: entry.status,
        marked_by: userId,
        source: 'manual',
        created_at: new Date().toISOString(),
      });

      if (!insertErr) {
        saved.push(entry.student_id);
      }
    }

    // Audit log for the entire batch
    await logAudit(userId, 'manual_attendance_batch', 'attendance', {
      class: className,
      section,
      date,
      saved_count: saved.length,
      skipped_count: skipped.length,
    });

    sendSuccess(res, { saved: saved.length, skipped }, 'Attendance batch processed', 201);
  }
);

// ── PUT /api/attendance/correct ───────────────────────────────────────────────
/**
 * Correct an existing attendance record.
 *
 * Body: { attendance_id, new_status, reason }
 *
 * Side-effects:
 *  - If a queued notification hasn't been sent yet → cancel it
 *  - If it was already sent → send a correction notification to parent
 */
router.put(
  '/correct',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      attendance_id: z.string().uuid(),
      new_status: z.enum(['present', 'absent', 'late', 'excused']),
      reason: z.string().min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { attendance_id, new_status, reason } = parsed.data;
    const userId = req.user!.id;

    // Fetch original record
    const { data: original, error: fetchErr } = await supabaseAdmin
      .from('attendance')
      .select('id, student_id, date, status')
      .eq('id', attendance_id)
      .single();

    if (fetchErr || !original) {
      sendError(res, 'Attendance record not found', 404);
      return;
    }

    const originalStatus = original.status;

    // Update the attendance record
    const { error: updateErr } = await supabaseAdmin
      .from('attendance')
      .update({ status: new_status, updated_at: new Date().toISOString() })
      .eq('id', attendance_id);

    if (updateErr) {
      sendError(res, 'Failed to update attendance', 500);
      return;
    }

    // Audit log with old/new values
    await logAudit(userId, 'attendance_corrected', 'attendance', {
      attendance_id,
      old_value: { status: originalStatus },
      new_value: { status: new_status, reason, corrected_by: userId },
    });

    // Handle notification queue for this student on this date
    const { data: queueEntry } = await supabaseAdmin
      .from('notification_queue')
      .select('id, sent, user_id')
      .eq('student_id', original.student_id)
      .eq('sent', false)
      .eq('cancelled', false)
      // Only entries created today (same date as the attendance record)
      .gte('created_at', `${original.date}T00:00:00.000Z`)
      .lte('created_at', `${original.date}T23:59:59.999Z`)
      .maybeSingle();

    if (queueEntry) {
      if (!queueEntry.sent) {
        // Not sent yet — cancel it
        await supabaseAdmin
          .from('notification_queue')
          .update({ cancelled: true })
          .eq('id', queueEntry.id);
      }
    } else {
      // Notification was already sent — inform parent of the correction
      const { data: student } = await supabaseAdmin
        .from('students')
        .select('full_name, parent_id')
        .eq('id', original.student_id)
        .maybeSingle();

      if (student?.parent_id) {
        const correctionMsg = `Your child ${student.full_name} attendance for ${original.date} was corrected to ${new_status}`;

        // In-app notification
        await supabaseAdmin.from('notifications').insert({
          title: 'Attendance Correction',
          body: correctionMsg,
          type: 'attendance',
          recipient_id: student.parent_id,
          sender_id: userId,
          is_read: false,
          created_at: new Date().toISOString(),
        });

        // FCM push (immediate — correction is time-sensitive)
        const { data: parentUser } = await supabaseAdmin
          .from('users')
          .select('fcm_token')
          .eq('id', student.parent_id)
          .maybeSingle();

        if (parentUser?.fcm_token) {
          await sendFcmNotification(
            parentUser.fcm_token,
            'Attendance Correction',
            correctionMsg
          );
        }
      }
    }

    sendSuccess(res, { attendance_id, new_status }, 'Attendance corrected');
  }
);

// ── GET /api/attendance/today-count ──────────────────────────────────────────
/**
 * Live counter for the gate screen.
 * Query param: school_id
 * Returns: { present, absent, not_marked }
 */
router.get(
  '/today-count',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const { school_id } = req.query as Record<string, string>;

    if (!school_id) {
      sendError(res, 'school_id is required', 400);
      return;
    }

    const today = todayDate();

    // Total active students in the school
    const { count: totalStudents } = await supabaseAdmin
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', school_id)
      .eq('is_deleted', false);

    // Present today
    const { count: presentCount } = await supabaseAdmin
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('date', today)
      .eq('status', 'present')
      .in(
        'student_id',
        (
          await supabaseAdmin
            .from('students')
            .select('id')
            .eq('school_id', school_id)
            .eq('is_deleted', false)
        ).data?.map((s: { id: string }) => s.id) ?? []
      );

    // Absent today
    const { count: absentCount } = await supabaseAdmin
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('date', today)
      .eq('status', 'absent')
      .in(
        'student_id',
        (
          await supabaseAdmin
            .from('students')
            .select('id')
            .eq('school_id', school_id)
            .eq('is_deleted', false)
        ).data?.map((s: { id: string }) => s.id) ?? []
      );

    const total = totalStudents ?? 0;
    const present = presentCount ?? 0;
    const absent = absentCount ?? 0;
    const notMarked = Math.max(0, total - present - absent);

    sendSuccess(res, { present, absent, not_marked: notMarked });
  }
);

// ── GET /api/attendance/history ───────────────────────────────────────────────
/**
 * Attendance history for a student over a date range.
 * Query params: student_id, start_date, end_date
 * Returns records + attendance percentage.
 */
router.get(
  '/history',
  requireRole('superadmin', 'schooladmin', 'teacher', 'parent', 'student'),
  async (req: Request, res: Response) => {
    const { student_id, start_date, end_date } = req.query as Record<string, string>;

    if (!student_id || !start_date || !end_date) {
      sendError(res, 'student_id, start_date, and end_date are required', 400);
      return;
    }

    // Parents can only query their own children
    if (req.user!.role === 'parent') {
      const { data: child } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('id', student_id)
        .eq('parent_id', req.user!.id)
        .maybeSingle();

      if (!child) {
        sendError(res, 'Access denied', 403);
        return;
      }
    }

    const { data: records, error } = await supabaseAdmin
      .from('attendance')
      .select('id, date, status, source, marked_by, created_at')
      .eq('student_id', student_id)
      .gte('date', start_date)
      .lte('date', end_date)
      .order('date', { ascending: false });

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    const total = records?.length ?? 0;
    const presentDays = records?.filter((r: { status: string }) => r.status === 'present').length ?? 0;
    const percentage = total > 0 ? Math.round((presentDays / total) * 100) : 0;

    sendSuccess(res, {
      records: records ?? [],
      summary: {
        total,
        present: presentDays,
        absent: records?.filter((r: { status: string }) => r.status === 'absent').length ?? 0,
        late: records?.filter((r: { status: string }) => r.status === 'late').length ?? 0,
        excused: records?.filter((r: { status: string }) => r.status === 'excused').length ?? 0,
        percentage,
      },
    });
  }
);

// ── GET /api/attendance — existing route (preserved) ─────────────────────────
/** GET /api/attendance?student_id=&date=&from=&to= */
router.get(
  '/',
  requireRole('superadmin', 'schooladmin', 'teacher', 'parent'),
  async (req: Request, res: Response) => {
    const { student_id, date, from, to } = req.query as Record<string, string>;

    let query = supabaseAdmin
      .from('attendance')
      .select('*, students(full_name)')
      .order('date', { ascending: false });

    if (student_id) query = query.eq('student_id', student_id);
    if (date) query = query.eq('date', date);
    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);

    // Parents can only see their own children's attendance
    if (req.user!.role === 'parent') {
      const { data: children } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('parent_id', req.user!.id);

      const childIds = (children ?? []).map((c: { id: string }) => c.id);
      query = query.in('student_id', childIds);
    }

    const { data, error } = await query;

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data);
  }
);

// ── POST /api/attendance — existing single-record route (preserved) ───────────
router.post(
  '/',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const recordAttendanceSchema = z.object({
      student_id: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.enum(['present', 'absent', 'late', 'excused']),
      notes: z.string().optional(),
    });

    const parsed = recordAttendanceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('attendance')
      .upsert(
        { ...parsed.data, recorded_by: req.user!.id },
        { onConflict: 'student_id,date' }
      )
      .select()
      .single();

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    await logAudit(req.user!.id, 'ATTENDANCE_RECORDED', 'attendance', {
      student_id: parsed.data.student_id,
      date: parsed.data.date,
      status: parsed.data.status,
    });

    sendSuccess(res, data, 'Attendance recorded', 201);
  }
);

// ── POST /api/attendance/bulk — existing bulk route (preserved) ───────────────
router.post(
  '/bulk',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const recordAttendanceSchema = z.object({
      student_id: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.enum(['present', 'absent', 'late', 'excused']),
      notes: z.string().optional(),
    });

    const bulkAttendanceSchema = z.object({
      records: z.array(recordAttendanceSchema).min(1),
    });

    const parsed = bulkAttendanceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const records = parsed.data.records.map((r) => ({
      ...r,
      recorded_by: req.user!.id,
      source: 'manual',
    }));

    const { data, error } = await supabaseAdmin
      .from('attendance')
      .upsert(records, { onConflict: 'student_id,date' })
      .select();

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    await logAudit(req.user!.id, 'ATTENDANCE_BULK_RECORDED', 'attendance', {
      count: records.length,
      source: 'manual',
    });

    sendSuccess(res, data, `${records.length} attendance records saved`, 201);
  }
);

// ── GET /api/attendance/check — existing route (preserved) ───────────────────
router.get(
  '/check',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const { class_name, section, date } = req.query as Record<string, string>;

    if (!class_name || !date) {
      sendError(res, 'class_name and date are required', 400);
      return;
    }

    let studentQuery = supabaseAdmin
      .from('students')
      .select('id, full_name, class_name, section')
      .eq('school_id', req.user!.school_id ?? '')
      .eq('class_name', class_name);

    if (section) studentQuery = studentQuery.eq('section', section);

    const { data: students, error: sErr } = await studentQuery;
    if (sErr) { sendError(res, sErr.message, 500); return; }
    if (!students || students.length === 0) {
      sendSuccess(res, { students: [], existing: [] });
      return;
    }

    const studentIds = students.map((s: { id: string }) => s.id);

    const { data: existing, error: aErr } = await supabaseAdmin
      .from('attendance')
      .select('student_id, status, source, recorded_by')
      .in('student_id', studentIds)
      .eq('date', date);

    if (aErr) { sendError(res, aErr.message, 500); return; }

    sendSuccess(res, { students, existing: existing ?? [] });
  }
);

export default router;

// ── Notification queue processor (exported for use in index.ts) ───────────────
/**
 * Processes the notification_queue table every 5 minutes.
 * Sends FCM push notifications for entries where:
 *   send_after <= now AND sent = false AND cancelled = false
 *
 * Call startNotificationQueueProcessor() once from index.ts.
 */
export function startNotificationQueueProcessor(): void {
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  const process = async () => {
    try {
      const now = new Date().toISOString();

      const { data: pending, error } = await supabaseAdmin
        .from('notification_queue')
        .select('id, user_id, message')
        .lte('send_after', now)
        .eq('sent', false)
        .eq('cancelled', false);

      if (error) {
        console.error('[notification-queue] Query error:', error.message);
        return;
      }

      if (!pending || pending.length === 0) return;

      for (const entry of pending) {
        // Fetch parent's FCM token
        const { data: user } = await supabaseAdmin
          .from('users')
          .select('fcm_token')
          .eq('id', entry.user_id)
          .maybeSingle();

        if (user?.fcm_token) {
          await sendFcmNotification(user.fcm_token, 'School Attendance', entry.message);
        }

        // Mark as sent regardless of FCM result (avoid infinite retries)
        await supabaseAdmin
          .from('notification_queue')
          .update({ sent: true, sent_at: new Date().toISOString() })
          .eq('id', entry.id);
      }

      console.log(`[notification-queue] Processed ${pending.length} notification(s)`);
    } catch (err) {
      console.error('[notification-queue] Processor error:', err);
    }
  };

  // Run immediately on startup, then every 5 minutes
  void process();
  setInterval(() => void process(), INTERVAL_MS);

  console.log('[notification-queue] Processor started (interval: 5 min)');
}
