import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateAny } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import rateLimit from 'express-rate-limit';
import { sendAttendanceNotifications } from '../services/attendanceNotifications';

const router = Router();

// ── Rate limiter: max 10 attendance submissions per teacher per day ────────────
// Uses a 24-hour window keyed by user ID (via Authorization header).
const submitRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    success: false,
    message: 'Attendance submission limit reached (10 per day). Try again tomorrow.',
  },
  skip: (req) => {
    // Only rate-limit teachers; admins are exempt
    const role = req.user?.role;
    return role === 'superadmin' || role === 'schooladmin';
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns today's date as YYYY-MM-DD (UTC). */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check if a teacher is assigned to a class+section.
 * Tries `class_name` first (used by all insert paths), then falls back to
 * the legacy `class` column in case the migration hasn't been run yet.
 */
async function isTeacherAssigned(
  teacherId: string,
  className: string,
  section: string
): Promise<boolean> {
  const cn  = className.trim();
  const sec = section.trim();

  const { data: byClassName } = await supabaseAdmin
    .from('teacher_assignments')
    .select('id')
    .eq('teacher_id', teacherId)
    .ilike('class_name', cn)
    .ilike('section', sec)
    .limit(1);
  if ((byClassName ?? []).length > 0) return true;

  // Fallback for DBs where only the legacy `class` column is populated
  const { data: byClass } = await supabaseAdmin
    .from('teacher_assignments')
    .select('id')
    .eq('teacher_id', teacherId)
    .ilike('class', cn)
    .ilike('section', sec)
    .limit(1);
  return (byClass ?? []).length > 0;
}

// ── All routes require authentication ─────────────────────────────────────────
router.use(authenticateAny);

// ── GET /api/attendance ───────────────────────────────────────────────────────
/**
 * Fetch attendance records for a student on a specific date.
 * Intended for the student mobile dashboard.
 * Query params: student_id, date
 * Students can only query their own records; staff can query any student.
 */
router.get(
  '/',
  requireRole('superadmin', 'schooladmin', 'teacher', 'parent', 'student'),
  async (req: Request, res: Response) => {
    const { student_id, date } = req.query as Record<string, string>;

    if (!student_id || !date) {
      sendError(res, 'student_id and date are required', 400);
      return;
    }

    // Student token: can only query own records
    if (req.tokenType === 'student') {
      if (req.student!.id !== student_id) {
        sendError(res, 'Access denied', 403);
        return;
      }
    }

    const { data, error } = await supabaseAdmin
      .from('attendance')
      .select('id, student_id, date, status, source, created_at')
      .eq('student_id', student_id)
      .eq('date', date)
      .order('created_at', { ascending: false });

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data ?? []);
  }
);

// ── GET /api/attendance/check ─────────────────────────────────────────────────
/**
 * Check existing attendance for a class on a date.
 * Used by the dashboard for today's attendance % and by the attendance page.
 * Returns { students: [...], existing: [...] }
 *
 * Query params: class_name, section (optional), date
 * If class_name is empty, returns school-wide today summary instead.
 */
router.get(
  '/check',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const className = (req.query.class_name as string) ?? '';
    const section   = (req.query.section as string) ?? '';
    const date      = (req.query.date as string) || todayDate();

    const school_id = req.user!.school_id;
    if (!school_id) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // If no class_name provided, return school-wide summary for the dashboard stat card
    if (!className) {
      const { data: students, error: stuErr } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('school_id', school_id)
        .eq('is_deleted', false);

      if (stuErr) { sendError(res, stuErr.message, 500); return; }

      const allIds = (students ?? []).map((s: { id: string }) => s.id);
      if (allIds.length === 0) {
        sendSuccess(res, { students: [], existing: [] });
        return;
      }

      const { data: existing, error: attErr } = await supabaseAdmin
        .from('attendance')
        .select('student_id, status, source')
        .in('student_id', allIds)
        .eq('date', date);

      if (attErr) { sendError(res, attErr.message, 500); return; }

      sendSuccess(res, {
        students: students ?? [],
        existing: existing ?? [],
      });
      return;
    }

    // Specific class requested
    let studentQuery = supabaseAdmin
      .from('students')
      .select('id, full_name, class_name, section')
      .eq('school_id', school_id)
      .ilike('class_name', className.trim())
      .eq('is_deleted', false);

    if (section) studentQuery = studentQuery.ilike('section', section.trim());

    const { data: students, error: stuErr } = await studentQuery;
    if (stuErr) { sendError(res, stuErr.message, 500); return; }

    const allIds = (students ?? []).map((s: { id: string }) => s.id);
    if (allIds.length === 0) {
      sendSuccess(res, { students: [], existing: [] });
      return;
    }

    const { data: existing, error: attErr } = await supabaseAdmin
      .from('attendance')
      .select('student_id, status, source')
      .in('student_id', allIds)
      .eq('date', date);

    if (attErr) { sendError(res, attErr.message, 500); return; }

    sendSuccess(res, {
      students: students ?? [],
      existing: existing ?? [],
    });
  }
);

// ── GET /api/attendance/bulk ──────────────────────────────────────────────────
// Alias kept for frontend compatibility — same as /check but POST for bulk ops
router.post(
  '/bulk',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      records: z.array(z.object({
        student_id: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        status: z.enum(['present', 'absent', 'late', 'excused']),
        notes: z.string().optional(),
      })),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const userId = req.user!.id;
    const rows = parsed.data.records.map((r) => ({
      ...r,
      recorded_by: userId,
      source: 'manual',
    }));

    const { data, error } = await supabaseAdmin
      .from('attendance')
      .upsert(rows, { onConflict: 'student_id,date', ignoreDuplicates: false })
      .select();

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? [], 'Attendance saved');
  }
);



// ── GET /api/attendance/class ─────────────────────────────────────────────────
/**
 * Fetch all students for a class/section with their attendance status for a date.
 * Default-present system: students without a record are shown as "not_marked".
 *
 * Query params: class, section, date (default today)
 * school_id is taken from the auth token for non-superadmin users.
 */
router.get(
  '/class',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const { class: className, section } = req.query as Record<string, string>;
    const date = (req.query.date as string) || todayDate();

    if (!className || !section) {
      sendError(res, 'class and section are required', 400);
      return;
    }

    // school_id always comes from the auth token for non-superadmin users
    // to prevent cross-school data access by manipulating the query param
    let school_id: string;
    if (req.user!.role === 'superadmin') {
      const qSchoolId = req.query.school_id as string | undefined;
      if (!qSchoolId) {
        sendError(res, 'school_id is required for superadmin', 400);
        return;
      }
      school_id = qSchoolId;
    } else {
      if (!req.user!.school_id) {
        sendError(res, 'Your account is not linked to a school', 403);
        return;
      }
      school_id = req.user!.school_id;
    }

    // Teachers can only view their assigned classes
    if (req.user!.role === 'teacher') {
      const assigned = await isTeacherAssigned(req.user!.id, className, section);
      if (!assigned) {
        sendError(res, 'You are not assigned to this class', 403);
        return;
      }
    }

    // Fetch all active students for this class/section (case-insensitive match)
    const { data: students, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, roll_number, photo_url')
      .eq('school_id', school_id)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .eq('is_deleted', false)
      .order('roll_number', { ascending: true });

    if (stuErr) {
      sendError(res, stuErr.message, 500);
      return;
    }

    if (!students || students.length === 0) {
      sendSuccess(res, []);
      return;
    }

    const studentIds = students.map((s: { id: string }) => s.id);

    // Fetch existing attendance records for this date
    const { data: records, error: attErr } = await supabaseAdmin
      .from('attendance')
      .select('id, student_id, status')
      .in('student_id', studentIds)
      .eq('date', date);

    if (attErr) {
      sendError(res, attErr.message, 500);
      return;
    }

    // Build a lookup map: student_id → { status, id }
    const statusMap = new Map<string, { status: string; id: string }>();
    for (const r of records ?? []) {
      statusMap.set(r.student_id, { status: r.status, id: r.id });
    }

    // Merge: default to "not_marked" if no record exists
    const result = students.map((s: { id: string; full_name: string; roll_number: string | null; photo_url: string | null }) => {
      const record = statusMap.get(s.id);
      return {
        student_id: s.id,
        name: s.full_name,
        roll_number: s.roll_number,
        photo_url: s.photo_url,
        status: (record?.status as 'present' | 'absent' | 'not_marked') ?? 'not_marked',
        id: record?.id ?? null,
      };
    });

    sendSuccess(res, result);
  }
);

// ── POST /api/attendance/submit ───────────────────────────────────────────────
/**
 * Default-present bulk submission: teacher sends only absent student IDs.
 * All other students in the class are automatically marked present.
 *
 * Body: { class, section, date, school_id, absent_student_ids: uuid[] }
 */
router.post(
  '/submit',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  submitRateLimit,
  async (req: Request, res: Response) => {
    const schema = z.object({
      class: z.string().min(1).max(20),
      section: z.string().min(1).max(10),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
      school_id: z.string().uuid().optional(), // only used by superadmin; others use token
      absent_student_ids: z.array(z.string().uuid()).default([]),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { class: className, section, date, absent_student_ids } = parsed.data;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    // school_id always comes from the auth token for non-superadmin users
    // to prevent cross-school data access by manipulating the request body
    let school_id: string;
    if (userRole === 'superadmin') {
      if (!parsed.data.school_id) {
        sendError(res, 'school_id is required for superadmin', 400);
        return;
      }
      school_id = parsed.data.school_id;
    } else {
      if (!req.user!.school_id) {
        sendError(res, 'Your account is not linked to a school', 403);
        return;
      }
      school_id = req.user!.school_id;
    }

    // Teachers must be assigned to this class
    if (userRole === 'teacher') {
      const assigned = await isTeacherAssigned(userId, className, section);
      if (!assigned) {
        sendError(res, 'You are not assigned to this class', 403);
        return;
      }
    }

    // Check if attendance already submitted for this class+section+date
    const { data: students, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('school_id', school_id)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .eq('is_deleted', false);

    if (stuErr) {
      sendError(res, stuErr.message, 500);
      return;
    }

    if (!students || students.length === 0) {
      sendError(res, 'No students found for this class and section', 404);
      return;
    }

    const allStudentIds = students.map((s: { id: string }) => s.id);

    // Duplicate submission guard: check if any record already exists for this class/section/date
    const { count: existingCount } = await supabaseAdmin
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .in('student_id', allStudentIds)
      .eq('date', date);

    if ((existingCount ?? 0) > 0) {
      sendError(res, 'Attendance already submitted for today', 409);
      return;
    }

    // Build records: absent for IDs in absent_student_ids, present for the rest
    const absentSet = new Set(absent_student_ids);
    const rows = allStudentIds.map((id: string) => ({
      student_id: id,
      date,
      status: absentSet.has(id) ? 'absent' : 'present',
      recorded_by: userId,
      source: 'manual',
      // notification_sent defaults to false in the DB — omit here to avoid
      // schema-cache errors if the column was recently added
    }));

    const { error: insertErr } = await supabaseAdmin.from('attendance').insert(rows);

    if (insertErr) {
      sendError(res, insertErr.message, 500);
      return;
    }

    const presentCount = rows.filter((r) => r.status === 'present').length;
    const absentCount = rows.filter((r) => r.status === 'absent').length;

    // Audit log
    await logAudit(userId, 'attendance_submitted', 'attendance', {
      class: className,
      section,
      date,
      school_id,
      present_count: presentCount,
      absent_count: absentCount,
    });

    // Fire-and-forget: run notification job after response is sent
    setImmediate(() => {
      sendAttendanceNotifications(school_id, className, section, date).catch((err) => {
        console.error('[attendance] Background notification job failed:', err);
      });
    });

    sendSuccess(res, { success: true, present_count: presentCount, absent_count: absentCount }, 'Attendance submitted', 201);
  }
);

// ── PUT /api/attendance/correct ───────────────────────────────────────────────
/**
 * Correct an existing attendance record, or create one if it doesn't exist yet
 * (i.e. student was "not_marked").
 * Teacher must be assigned to the student's class.
 *
 * Body: { attendance_id, new_status, reason }
 *   OR: { student_id, date, new_status, reason }  — when no record exists yet
 */
router.put(
  '/correct',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const schema = z.union([
      z.object({
        attendance_id: z.string().uuid(),
        student_id: z.string().uuid().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        new_status: z.enum(['present', 'absent', 'late', 'excused']),
        reason: z.string().min(1, 'reason is required'),
      }),
      z.object({
        attendance_id: z.undefined().optional(),
        student_id: z.string().uuid(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
        new_status: z.enum(['present', 'absent', 'late', 'excused']),
        reason: z.string().min(1, 'reason is required'),
      }),
    ]);

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { new_status, reason } = parsed.data;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    let original: { id: string; student_id: string; date: string; status: string } | null = null;

    if (parsed.data.attendance_id) {
      // Update path: fetch the existing record by attendance_id
      const { data, error: fetchErr } = await supabaseAdmin
        .from('attendance')
        .select('id, student_id, date, status')
        .eq('id', parsed.data.attendance_id)
        .single();

      if (fetchErr || !data) {
        sendError(res, 'Attendance record not found', 404);
        return;
      }
      original = data;
    } else {
      // Create path: no record exists yet (student was not_marked)
      const { student_id, date } = parsed.data as { student_id: string; date: string };

      // Check the student exists
      const { data: student, error: stuErr } = await supabaseAdmin
        .from('students')
        .select('id, class_name, section')
        .eq('id', student_id)
        .maybeSingle();

      if (stuErr || !student) {
        sendError(res, 'Student not found', 404);
        return;
      }

      // Teachers must be assigned to the student's class
      if (userRole === 'teacher') {
        const assigned = await isTeacherAssigned(userId, student.class_name, student.section);
        if (!assigned) {
          sendError(res, 'You are not assigned to this student\'s class', 403);
          return;
        }
      }

      // Insert the new attendance record
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('attendance')
        .insert({
          student_id,
          date,
          status: new_status,
          recorded_by: userId,
          source: 'manual',
        })
        .select('id, student_id, date, status')
        .single();

      if (insertErr || !inserted) {
        sendError(res, insertErr?.message ?? 'Failed to create attendance record', 500);
        return;
      }

      await logAudit(userId, 'attendance_corrected', 'attendance', {
        attendance_id: inserted.id,
        old_value: { status: 'not_marked' },
        new_value: { status: new_status },
        reason,
        corrected_by: userId,
      });

      sendSuccess(res, { attendance_id: inserted.id, old_status: 'not_marked', new_status }, 'Attendance corrected');
      return;
    }

    // Teachers must be assigned to the student's class (update path)
    if (userRole === 'teacher') {
      const { data: student } = await supabaseAdmin
        .from('students')
        .select('class_name, section')
        .eq('id', original.student_id)
        .maybeSingle();

      if (!student) {
        sendError(res, 'Student not found', 404);
        return;
      }

      const assigned = await isTeacherAssigned(userId, student.class_name, student.section);
      if (!assigned) {
        sendError(res, 'You are not assigned to this student\'s class', 403);
        return;
      }
    }

    const oldStatus = original.status;

    // Update the record
    const { error: updateErr } = await supabaseAdmin
      .from('attendance')
      .update({ status: new_status, updated_at: new Date().toISOString() })
      .eq('id', original.id);

    if (updateErr) {
      sendError(res, 'Failed to update attendance record', 500);
      return;
    }

    // Audit log with old/new values and reason
    await logAudit(userId, 'attendance_corrected', 'attendance', {
      attendance_id: original.id,
      old_value: { status: oldStatus },
      new_value: { status: new_status },
      reason,
      corrected_by: userId,
    });

    // Notify parent about the correction
    const { data: student } = await supabaseAdmin
      .from('students')
      .select('full_name, parent_id')
      .eq('id', original.student_id)
      .maybeSingle();

    if (student?.parent_id) {
      await supabaseAdmin.from('notifications').insert({
        title: 'Attendance Correction',
        body: `${student.full_name}'s attendance for ${original.date} was corrected from ${oldStatus} to ${new_status}. Reason: ${reason}`,
        type: 'attendance',
        recipient_id: student.parent_id,
        sender_id: userId,
        is_read: false,
        created_at: new Date().toISOString(),
      });
    }

    sendSuccess(res, { attendance_id: original.id, old_status: oldStatus, new_status }, 'Attendance corrected');
  }
);

// ── GET /api/attendance/history ───────────────────────────────────────────────
/**
 * Attendance history for a single student over a date range.
 * Query params: student_id, start_date, end_date
 * Returns records sorted by date descending + summary stats.
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
    if (req.user?.role === 'parent') {
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

    // Student token: can only query their own record
    if (req.tokenType === 'student') {
      if (req.student!.id !== student_id) {
        sendError(res, 'Access denied', 403);
        return;
      }
    } else if (req.user!.role === 'student') {
      // Legacy: staff token with student role — look up via user_id
      const { data: self } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('id', student_id)
        .eq('user_id', req.user!.id)
        .maybeSingle();

      if (!self) {
        sendError(res, 'Access denied', 403);
        return;
      }
    }

    const { data: records, error } = await supabaseAdmin
      .from('attendance')
      .select('id, date, status, source, recorded_by, created_at')
      .eq('student_id', student_id)
      .gte('date', start_date)
      .lte('date', end_date)
      .order('date', { ascending: false });

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    const list = records ?? [];
    const total_days = list.length;
    const present_count = list.filter((r: { status: string }) => r.status === 'present').length;
    const absent_count = list.filter((r: { status: string }) => r.status === 'absent').length;
    const percentage = total_days > 0 ? Math.round((present_count / total_days) * 100) : 0;

    sendSuccess(res, {
      records: list,
      summary: {
        total_days,
        present_count,
        absent_count,
        percentage,
      },
    });
  }
);

// ── GET /api/attendance/class-history ────────────────────────────────────────
/**
 * Attendance summary for an entire class over a date range.
 * Query params: class, section, start_date, end_date
 * school_id is taken from the auth token for non-superadmin users.
 * Returns per-student: name, present_count, absent_count, percentage.
 */
router.get(
  '/class-history',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    const { class: className, section, start_date, end_date } = req.query as Record<string, string>;

    if (!className || !section || !start_date || !end_date) {
      sendError(res, 'class, section, start_date, and end_date are required', 400);
      return;
    }

    // school_id always comes from the auth token for non-superadmin users
    let school_id: string;
    if (req.user!.role === 'superadmin') {
      const qSchoolId = req.query.school_id as string | undefined;
      if (!qSchoolId) {
        sendError(res, 'school_id is required for superadmin', 400);
        return;
      }
      school_id = qSchoolId;
    } else {
      if (!req.user!.school_id) {
        sendError(res, 'Your account is not linked to a school', 403);
        return;
      }
      school_id = req.user!.school_id;
    }

    // Teachers can only view their assigned classes
    if (req.user!.role === 'teacher') {
      const assigned = await isTeacherAssigned(req.user!.id, className, section);
      if (!assigned) {
        sendError(res, 'You are not assigned to this class', 403);
        return;
      }
    }

    // Fetch all active students for this class
    const { data: students, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, roll_number')
      .eq('school_id', school_id)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .eq('is_deleted', false)
      .order('roll_number', { ascending: true });

    if (stuErr) {
      sendError(res, stuErr.message, 500);
      return;
    }

    if (!students || students.length === 0) {
      sendSuccess(res, []);
      return;
    }

    const studentIds = students.map((s: { id: string }) => s.id);

    // Fetch all attendance records for the date range
    const { data: records, error: attErr } = await supabaseAdmin
      .from('attendance')
      .select('student_id, status')
      .in('student_id', studentIds)
      .gte('date', start_date)
      .lte('date', end_date);

    if (attErr) {
      sendError(res, attErr.message, 500);
      return;
    }

    // Group records by student_id
    const recordsByStudent = new Map<string, { present: number; absent: number; total: number }>();
    for (const id of studentIds) {
      recordsByStudent.set(id, { present: 0, absent: 0, total: 0 });
    }
    for (const r of records ?? []) {
      const entry = recordsByStudent.get(r.student_id);
      if (entry) {
        entry.total += 1;
        if (r.status === 'present') entry.present += 1;
        else if (r.status === 'absent') entry.absent += 1;
      }
    }

    const result = students.map((s: { id: string; full_name: string; roll_number: string | null }) => {
      const stats = recordsByStudent.get(s.id) ?? { present: 0, absent: 0, total: 0 };
      return {
        student_id: s.id,
        name: s.full_name,
        roll_number: s.roll_number,
        present_count: stats.present,
        absent_count: stats.absent,
        total_days: stats.total,
        percentage: stats.total > 0 ? Math.round((stats.present / stats.total) * 100) : 0,
      };
    });

    sendSuccess(res, result);
  }
);

// ── GET /api/attendance/today-summary ────────────────────────────────────────
/**
 * School-wide attendance summary for today.
 * school_id is taken from the auth token for non-superadmin users.
 * Returns: total_students, present, absent, not_submitted_classes[]
 */
router.get(
  '/today-summary',
  requireRole('superadmin', 'schooladmin', 'teacher'),
  async (req: Request, res: Response) => {
    // school_id always comes from the auth token for non-superadmin users
    let school_id: string;
    if (req.user!.role === 'superadmin') {
      const qSchoolId = req.query.school_id as string | undefined;
      if (!qSchoolId) {
        sendError(res, 'school_id is required for superadmin', 400);
        return;
      }
      school_id = qSchoolId;
    } else {
      if (!req.user!.school_id) {
        sendError(res, 'Your account is not linked to a school', 403);
        return;
      }
      school_id = req.user!.school_id;
    }

    const today = todayDate();

    // Fetch all active students for this school
    const { data: students, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id, class_name, section')
      .eq('school_id', school_id)
      .eq('is_deleted', false);

    if (stuErr) {
      sendError(res, stuErr.message, 500);
      return;
    }

    const allStudents = students ?? [];
    const totalStudents = allStudents.length;

    if (totalStudents === 0) {
      sendSuccess(res, {
        total_students: 0,
        present: 0,
        absent: 0,
        not_submitted_classes: [],
      });
      return;
    }

    const allStudentIds = allStudents.map((s: { id: string }) => s.id);

    // Fetch today's attendance records
    const { data: records, error: attErr } = await supabaseAdmin
      .from('attendance')
      .select('student_id, status')
      .in('student_id', allStudentIds)
      .eq('date', today);

    if (attErr) {
      sendError(res, attErr.message, 500);
      return;
    }

    const markedSet = new Set((records ?? []).map((r: { student_id: string }) => r.student_id));
    const presentCount = (records ?? []).filter((r: { status: string }) => r.status === 'present').length;
    const absentCount = (records ?? []).filter((r: { status: string }) => r.status === 'absent').length;

    // Determine which class+section combos have NOT been submitted yet
    // A class is "submitted" if at least one student in it has an attendance record today
    const classMap = new Map<string, { class_name: string; section: string; hasRecord: boolean }>();

    for (const s of allStudents as Array<{ id: string; class_name: string; section: string }>) {
      const key = `${s.class_name}||${s.section}`;
      if (!classMap.has(key)) {
        classMap.set(key, { class_name: s.class_name, section: s.section, hasRecord: false });
      }
      if (markedSet.has(s.id)) {
        classMap.get(key)!.hasRecord = true;
      }
    }

    const notSubmittedClasses = Array.from(classMap.values())
      .filter((c) => !c.hasRecord)
      .map((c) => ({ class_name: c.class_name, section: c.section }));

    sendSuccess(res, {
      total_students: totalStudents,
      present: presentCount,
      absent: absentCount,
      not_submitted_classes: notSubmittedClasses,
    });
  }
);

export default router;
