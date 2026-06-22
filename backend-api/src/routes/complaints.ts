import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// ── Rate limiter: max 3 complaints per student per day ────────────────────────
const complaintRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 3,
  keyGenerator: (req) => req.student?.id ?? req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    success: false,
    message: 'Complaint limit reached (3 per day). Please try again tomorrow.',
  },
});

// ── Schemas ───────────────────────────────────────────────────────────────────

const createComplaintSchema = z.object({
  message: z.string().min(1, 'Message is required').max(1000, 'Message must be 1000 characters or less'),
  recipient_type: z.enum(['school_admin', 'subject_teacher'] as const, {
    message: 'recipient_type must be "subject_teacher" or "school_admin"',
  }),
  subject: z.string().max(200, 'Subject must be 200 characters or less').nullable().optional(),
  // Required when recipient_type is 'subject_teacher' — the teacher_id to send the complaint to
  subject_teacher_id: z.string().uuid('subject_teacher_id must be a valid UUID').optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['pending', 'reviewed', 'resolved']),
  resolution_note: z.string().max(2000).optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create an in-app notification for a staff user (teacher or school_admin).
 * Uses the 'body' column (renamed from 'message' via migration).
 */
async function createNotification(
  recipientId: string,
  senderId: string,
  title: string,
  body: string
): Promise<void> {
  try {
    await supabaseAdmin.from('notifications').insert({
      title,
      message: body,
      type: 'alert',
      recipient_id: recipientId,
      sender_id: senderId,
      is_read: false,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[complaints] Failed to create notification:', err);
  }
}

/**
 * Create an in-app notification for a student.
 * Students don't have a users row, so we use a system sender_id (school_admin).
 * Falls back gracefully if no admin is found.
 */
async function createStudentNotification(
  schoolId: string,
  studentId: string,
  title: string,
  body: string
): Promise<void> {
  try {
    // Find a school_admin to use as sender_id (required FK)
    const { data: admin } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('school_id', schoolId)
      .eq('role', 'schooladmin')
      .maybeSingle();

    if (!admin) return; // No admin found — skip notification silently

    // Students don't have a notifications row (they use the students table),
    // so we store the notification against the student's parent_id if available,
    // or skip. For now we log it — full student notification is a Phase 2 feature.
    // TODO: extend notifications table to support student recipients.
    console.log(`[complaints] Student notification (Phase 2): ${title} → student ${studentId}`);
  } catch (err) {
    console.error('[complaints] Failed to create student notification:', err);
  }
}

// ── POST /api/complaints ──────────────────────────────────────────────────────
/**
 * Student submits a complaint to their class teacher or school admin.
 * Auth: student token
 * Rate limit: 3 per student per day
 * Privacy: message content is NOT logged to audit_logs
 */
router.post(
  '/',
  authenticateStudent,
  complaintRateLimit,
  async (req: Request, res: Response) => {
    const parsed = createComplaintSchema.safeParse(req.body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      console.error('[complaints] Validation failed. Body:', JSON.stringify(req.body), 'Errors:', JSON.stringify(flat));
      // Return full field errors so the client can show what went wrong
      const firstFieldError = Object.entries(flat.fieldErrors ?? {}).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`).join('; ');
      const firstFormError = (flat.formErrors ?? []).join('; ');
      const humanMessage = firstFieldError || firstFormError || 'Validation failed';
      res.status(422).json({ success: false, message: humanMessage, errors: flat });
      return;
    }

    const { message, recipient_type, subject, subject_teacher_id } = parsed.data;
    const student = req.student!;

    if (!student.class_name || !student.section) {
      sendError(res, 'Your student profile is missing class or section information', 400);
      return;
    }

    // Validate subject_teacher_id is provided when recipient_type is 'subject_teacher'
    if (recipient_type === 'subject_teacher' && !subject_teacher_id) {
      sendError(res, 'subject_teacher_id is required when recipient_type is "subject_teacher"', 400);
      return;
    }

    let teacherId: string | null = null;
    let notifyUserId: string | null = null;

    if (recipient_type === 'subject_teacher') {
      // Verify the teacher exists and belongs to the same school.
      // We use the users table (always reliable) rather than teacher_assignments
      // which may have schema differences across environments.
      const { data: teacherUser, error: teacherErr } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('id', subject_teacher_id!)
        .eq('school_id', student.school_id)
        .eq('role', 'teacher')
        .maybeSingle();

      if (teacherErr) {
        console.error('[complaints] teacher lookup error:', teacherErr);
        sendError(res, 'Failed to verify teacher', 500);
        return;
      }

      if (!teacherUser) {
        sendError(res, 'The selected teacher was not found in your school', 404);
        return;
      }

      teacherId = subject_teacher_id!;
      notifyUserId = subject_teacher_id!;
    } else {
      // recipient_type === 'school_admin'
      // Find the school admin for this school
      const { data: admin, error: adminErr } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('school_id', student.school_id)
        .eq('role', 'schooladmin')
        .maybeSingle();

      if (adminErr) {
        sendError(res, 'Failed to look up school admin', 500);
        return;
      }

      if (!admin) {
        sendError(res, 'No school admin found for your school', 404);
        return;
      }

      teacherId = null;
      notifyUserId = admin.id;
    }

    // Insert the complaint
    const { data: complaint, error: insertErr } = await supabaseAdmin
      .from('complaints')
      .insert({
        student_id: student.id,
        message,
        subject: subject ?? null,
        recipient_type,
        teacher_id: teacherId,
        school_id: student.school_id,
        status: 'pending',
      })
      .select('id')
      .single();

    if (insertErr) {
      sendError(res, insertErr.message, 500);
      return;
    }

    // Send in-app notification to recipient
    if (notifyUserId) {
      const notifTitle =
        recipient_type === 'school_admin'
          ? 'New student complaint submitted to school admin'
          : `New complaint from a student in class ${student.class_name} ${student.section}`;

      const notifBody = subject
        ? `Subject: ${subject}`
        : 'A student has submitted a complaint. Please review it.';

      // Use recipient as sender for system-generated notifications.
      await createNotification(notifyUserId, notifyUserId, notifTitle, notifBody);
    }

    // Audit log — intentionally omits message content for student privacy
    await logAudit(null, 'COMPLAINT_SUBMITTED', {
      complaint_id: complaint.id,
      recipient_type,
      school_id: student.school_id,
      class_name: student.class_name,
      section: student.section,
      // student_id is logged so admins can investigate if needed, but message is not
      student_id: student.id,
      ...(recipient_type === 'subject_teacher' && { subject_teacher_id }),
    });

    sendSuccess(res, { success: true, complaint_id: complaint.id }, 'Complaint submitted', 201);
  }
);

// ── GET /api/complaints/teacher ───────────────────────────────────────────────
/**
 * Returns complaints sent to this specific teacher.
 * Auth: teacher token
 * Filter: WHERE teacher_id = logged-in teacher AND recipient_type = 'class_teacher'
 */
router.get(
  '/teacher',
  authenticate,
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    const { status } = req.query as Record<string, string>;

    let query = supabaseAdmin
      .from('complaints')
      .select(`
        id,
        subject,
        message,
        status,
        resolution_note,
        recipient_type,
        teacher_id,
        reviewed_at,
        created_at,
        students!complaints_student_id_fkey (
          id,
          full_name,
          class_name,
          section
        )
      `)
      .eq('school_id', req.user!.school_id ?? '')
      .eq('teacher_id', req.user!.id)
      .eq('recipient_type', 'subject_teacher')
      .order('created_at', { ascending: false });

    if (status && ['pending', 'reviewed', 'resolved', 'all'].includes(status)) {
      if (status !== 'all') {
        query = query.eq('status', status);
      }
    }

    const { data, error } = await query;
    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    // Flatten the joined student data for a cleaner response shape
    const result = (data ?? []).map((row: Record<string, unknown>) => {
      const student = row.students as Record<string, unknown> | null;
      return {
        id: row.id,
        subject: row.subject,
        message: row.message,
        status: row.status,
        resolution_note: row.resolution_note,
        reviewed_at: row.reviewed_at,
        created_at: row.created_at,
        student_name: student?.full_name ?? null,
        class_name: student?.class_name ?? null,
        section: student?.section ?? null,
      };
    });

    sendSuccess(res, result);
  }
);

// ── GET /api/complaints/admin ─────────────────────────────────────────────────
/**
 * Returns complaints sent to school admin for this school.
 * Auth: school_admin token
 * Filter: WHERE recipient_type = 'school_admin' AND school_id matches
 */
router.get(
  '/admin',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const { status } = req.query as Record<string, string>;

    if (!req.user!.school_id && req.user!.role !== 'superadmin') {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    let query = supabaseAdmin
      .from('complaints')
      .select(`
        id,
        subject,
        message,
        status,
        resolution_note,
        recipient_type,
        teacher_id,
        reviewed_at,
        created_at,
        students!complaints_student_id_fkey (
          id,
          full_name,
          class_name,
          section
        )
      `)
      .order('created_at', { ascending: false });

    // Scope to school (superadmin can see all if no school_id)
    if (req.user!.school_id) {
      query = query.eq('school_id', req.user!.school_id);
    }

    if (status && ['pending', 'reviewed', 'resolved', 'all'].includes(status)) {
      if (status !== 'all') {
        query = query.eq('status', status);
      }
    }

    const { data, error } = await query;
    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    const result = (data ?? []).map((row: Record<string, unknown>) => {
      const student = row.students as Record<string, unknown> | null;
      return {
        id: row.id,
        subject: row.subject,
        message: row.message,
        status: row.status,
        resolution_note: row.resolution_note,
        reviewed_at: row.reviewed_at,
        created_at: row.created_at,
        student_name: student?.full_name ?? null,
        class_name: student?.class_name ?? null,
        section: student?.section ?? null,
      };
    });

    sendSuccess(res, result);
  }
);

// ── GET /api/complaints/my-teachers ──────────────────────────────────────────
/**
 * Returns the distinct subject teachers assigned to the student's class/section.
 * Used by the mobile app to populate the "Complain to Subject Teacher" picker.
 * Auth: student token
 */
router.get(
  '/my-teachers',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const student = req.student!;

    if (!student.class_name || !student.section) {
      sendError(res, 'Your student profile is missing class or section information', 400);
      return;
    }

    // Fetch teacher assignments for this class/section.
    // Select teacher_id + subject only (no FK join hint — avoids PostgREST FK name issues).
    const { data: assignments, error: assignErr } = await supabaseAdmin
      .from('teacher_assignments')
      .select('teacher_id, subject')
      .eq('school_id', student.school_id)
      .eq('class_name', student.class_name)
      .eq('section', student.section);

    if (assignErr) {
      console.error('[complaints] my-teachers assignments query error:', assignErr);
      sendError(res, assignErr.message, 500);
      return;
    }

    if (!assignments || assignments.length === 0) {
      sendSuccess(res, []);
      return;
    }

    // Collect unique teacher IDs then fetch their names from users table
    const teacherIds = [...new Set((assignments as { teacher_id: string; subject: string | null }[]).map(a => a.teacher_id))];

    const { data: teachers, error: teacherErr } = await supabaseAdmin
      .from('users')
      .select('id, name')
      .in('id', teacherIds);

    if (teacherErr) {
      console.error('[complaints] my-teachers users query error:', teacherErr);
      sendError(res, teacherErr.message, 500);
      return;
    }

    const teacherMap = new Map((teachers ?? []).map((t: { id: string; name: string }) => [t.id, t.name]));

    // One entry per assignment row (teacher + subject pair)
    const result = (assignments as { teacher_id: string; subject: string | null }[]).map(a => ({
      teacher_id: a.teacher_id,
      subject: a.subject ?? null,
      teacher_name: teacherMap.get(a.teacher_id) ?? 'Unknown Teacher',
    }));

    sendSuccess(res, result);
  }
);

// ── GET /api/complaints/student ───────────────────────────────────────────────
/**
 * Returns this student's own complaints with status updates.
 * Auth: student token
 */
router.get(
  '/student',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const { data, error } = await supabaseAdmin
      .from('complaints')
      .select('id, subject, message, recipient_type, status, resolution_note, reviewed_at, created_at')
      .eq('student_id', req.student!.id)
      .order('created_at', { ascending: false });

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    sendSuccess(res, data ?? []);
  }
);

// ── PUT /api/complaints/:id/status ────────────────────────────────────────────
/**
 * Update complaint status: pending → reviewed → resolved.
 * Auth: teacher (for class_teacher complaints) or school_admin (for school_admin complaints)
 * Creates a notification for the student when status changes.
 */
router.put(
  '/:id/status',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { status, resolution_note } = parsed.data;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    // Fetch the complaint to verify ownership and get current state
    const { data: complaint, error: fetchErr } = await supabaseAdmin
      .from('complaints')
      .select('id, school_id, status, submitted_by, teacher_id, student_id')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !complaint) {
      sendError(res, 'Complaint not found', 404);
      return;
    }

    // School scope check
    if (req.user!.school_id && complaint.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }

    const oldStatus = complaint.status;

    // Update the complaint
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('complaints')
      .update({
        status,
        resolution_note: resolution_note ?? null,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('id, status, resolution_note, reviewed_at')
      .single();

    if (updateErr) {
      sendError(res, updateErr.message, 500);
      return;
    }

    // Notify the student that their complaint status changed
    if (complaint.student_id) {
      await createStudentNotification(
        complaint.school_id,
        complaint.student_id,
        `Your complaint has been ${status}`,
        resolution_note
          ? `Your complaint has been ${status}. Response: ${resolution_note}`
          : `Your complaint has been ${status}.`
      );
    }

    // Audit log
    await logAudit(userId, 'COMPLAINT_STATUS_UPDATED', {
      complaint_id: req.params.id,
      old_status: oldStatus,
      new_status: status,
      updated_by_role: userRole,
    });

    sendSuccess(res, updated, 'Complaint status updated');
  }
);

export default router;
