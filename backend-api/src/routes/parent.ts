import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// All routes in this file require a valid JWT + parent role
router.use(authenticate);
router.use(requireRole('parent'));

// -- Helpers ------------------------------------------------------------------

/** Returns today as YYYY-MM-DD. */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// -- GET /api/parent/children -------------------------------------------------
/**
 * Returns all children linked to the authenticated parent via the
 * parent_students junction table.
 *
 * Each child includes:
 *   id, name, class, section, fee_paid, photo_url, today_attendance
 */
router.get('/children', async (req: Request, res: Response) => {
  const parentId = req.user!.id;
  const today = todayDate();

  // 1. Fetch linked student IDs from junction table
  const { data: links, error: linksErr } = await supabaseAdmin
    .from('parent_students')
    .select('student_id')
    .eq('parent_id', parentId);

  if (linksErr) {
    sendError(res, linksErr.message, 500);
    return;
  }

  if (!links || links.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const studentIds = links.map((l: { student_id: string }) => l.student_id);

  // 2. Fetch student details
  const { data: students, error: studentsErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, fee_paid, photo_url')
    .in('id', studentIds)
    .eq('is_deleted', false);

  if (studentsErr) {
    sendError(res, studentsErr.message, 500);
    return;
  }

  if (!students || students.length === 0) {
    sendSuccess(res, []);
    return;
  }

  // 3. Fetch today's attendance for all children in one query
  const { data: attendanceRecords } = await supabaseAdmin
    .from('attendance')
    .select('student_id, status')
    .in('student_id', studentIds)
    .eq('date', today);

  // Build a lookup map: student_id -> attendance status
  const attendanceMap = new Map<string, string>();
  for (const record of attendanceRecords ?? []) {
    attendanceMap.set(record.student_id, record.status);
  }

  // 4. Merge attendance into student records
  const children = students.map((s: {
    id: string;
    full_name: string;
    class_name: string;
    section: string;
    fee_paid: boolean;
    photo_url: string | null;
  }) => ({
    id: s.id,
    name: s.full_name,
    class: s.class_name,
    section: s.section,
    fee_paid: s.fee_paid ?? false,
    photo_url: s.photo_url ?? null,
    today_attendance: attendanceMap.get(s.id) ?? null,
  }));

  sendSuccess(res, children);
});

// -- GET /api/parent/announcements --------------------------------------------
/**
 * Returns announcements for the parent's school, newest first.
 * Query param: limit (default 10, max 50)
 */
router.get('/announcements', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'Parent is not associated with a school', 400);
    return;
  }

  const rawLimit = parseInt((req.query.limit as string) ?? '10', 10);
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 10 : Math.min(rawLimit, 50);

  const { data, error } = await supabaseAdmin
    .from('announcements')
    .select('id, title, message, created_at, created_by')
    .eq('school_id', schoolId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
});

// -- GET /api/parent/complaints -----------------------------------------------
/**
 * Returns complaints submitted by this parent, including status updates.
 */
router.get('/complaints', async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('complaints')
    .select('id, subject, body, status, resolution_note, student_id, created_at, reviewed_at')
    .eq('submitted_by', req.user!.id)
    .order('created_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
});

// -- POST /api/parent/complaints ----------------------------------------------
/**
 * Submit a new complaint.
 * Body: { student_id, message }
 * Rate limit: max 5 complaints per parent per calendar day (DB-enforced).
 */
router.post('/complaints', async (req: Request, res: Response) => {
  const schema = z.object({
    student_id: z.string().uuid(),
    message: z.string().min(1).max(2000),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { student_id, message } = parsed.data;
  const parentId = req.user!.id;
  const schoolId = req.user!.school_id;
  const today = todayDate();

  // 1. Verify the student is linked to this parent
  const { data: link } = await supabaseAdmin
    .from('parent_students')
    .select('student_id')
    .eq('parent_id', parentId)
    .eq('student_id', student_id)
    .maybeSingle();

  if (!link) {
    sendError(res, 'Student not linked to your account', 403);
    return;
  }

  // 2. Rate limit: max 5 complaints per parent per calendar day
  const { count: todayCount, error: countErr } = await supabaseAdmin
    .from('complaints')
    .select('id', { count: 'exact', head: true })
    .eq('submitted_by', parentId)
    .gte('created_at', `${today}T00:00:00.000Z`)
    .lte('created_at', `${today}T23:59:59.999Z`);

  if (countErr) {
    sendError(res, 'Failed to check complaint limit', 500);
    return;
  }

  if ((todayCount ?? 0) >= 5) {
    sendError(res, 'Daily complaint limit reached (max 5 per day)', 429);
    return;
  }

  // 3. Insert complaint
  const { data: complaint, error: insertErr } = await supabaseAdmin
    .from('complaints')
    .insert({
      body: message,
      subject: 'Parent Complaint',
      student_id,
      school_id: schoolId,
      submitted_by: parentId,
      status: 'pending',
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    sendError(res, insertErr.message, 500);
    return;
  }

  // 4. Notify school admin(s) in this school
  if (schoolId) {
    const { data: admins } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('school_id', schoolId)
      .eq('role', 'schooladmin');

    if (admins && admins.length > 0) {
      const notifications = admins.map((admin: { id: string }) => ({
        title: 'New Parent Complaint',
        message: `New complaint submitted by a parent (student ID: ${student_id})`,
        type: 'alert',
        recipient_id: admin.id,
        sender_id: parentId,
        is_read: false,
        created_at: new Date().toISOString(),
      }));

      await supabaseAdmin.from('notifications').insert(notifications);
    }
  }

  // 5. Audit log
  await logAudit(parentId, 'COMPLAINT_SUBMITTED', 'complaints', {
    complaint_id: complaint.id,
    student_id,
    school_id: schoolId,
  });

  sendSuccess(res, complaint, 'Complaint submitted', 201);
});

export default router;
