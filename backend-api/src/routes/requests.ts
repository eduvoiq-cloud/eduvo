import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// ── Rate limiter: max 5 requests per student per day ──────────────────────────
const requestRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.student?.id ?? req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    success: false,
    message: 'Request limit reached (5 per day). Please try again tomorrow.',
  },
});

// ── Schemas ───────────────────────────────────────────────────────────────────

const createRequestSchema = z.object({
  message: z.string().min(1, 'Message is required').max(1000, 'Message must be 1000 characters or less'),
  recipient_type: z.enum(['school_admin', 'subject_teacher'] as const, {
    message: 'recipient_type must be "subject_teacher" or "school_admin"',
  }),
  subject: z.string().max(200, 'Subject must be 200 characters or less').nullable().optional(),
  subject_teacher_id: z.string().uuid('subject_teacher_id must be a valid UUID').optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  resolution_note: z.string().max(2000).optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createNotification(
  recipientId: string,
  senderId: string,
  title: string,
  body: string
): Promise<void> {
  try {
    await supabaseAdmin.from('notifications').insert({
      title,
      body,
      type: 'alert',
      recipient_id: recipientId,
      sender_id: senderId,
      is_read: false,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[requests] Failed to create notification:', err);
  }
}

async function createStudentNotification(
  schoolId: string,
  studentId: string,
  title: string,
  body: string
): Promise<void> {
  try {
    const { data: admin } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('school_id', schoolId)
      .eq('role', 'schooladmin')
      .maybeSingle();

    const senderId = admin?.id ?? null;

    await supabaseAdmin.from('notifications').insert({
      title,
      body,
      type: 'alert',
      recipient_id: studentId,
      sender_id: senderId,
      is_read: false,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[requests] Failed to create student notification:', err);
  }
}

// ── POST /api/requests ────────────────────────────────────────────────────────
router.post(
  '/',
  authenticateStudent,
  requestRateLimit,
  async (req: Request, res: Response) => {
    try {
      const parsed = createRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const flat = parsed.error.flatten();
        const firstFieldError = Object.entries(flat.fieldErrors ?? {})
          .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`)
          .join('; ');
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

      if (recipient_type === 'subject_teacher' && !subject_teacher_id) {
        sendError(res, 'subject_teacher_id is required when recipient_type is "subject_teacher"', 400);
        return;
      }

      let teacherId: string | null = null;
      let notifyUserId: string | null = null;

      if (recipient_type === 'subject_teacher') {
        const { data: teacherUser, error: teacherErr } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('id', subject_teacher_id!)
          .eq('school_id', student.school_id)
          .eq('role', 'teacher')
          .maybeSingle();

        if (teacherErr) {
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

      const { data: request, error: insertErr } = await supabaseAdmin
        .from('student_requests')
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

      if (notifyUserId) {
        const notifTitle =
          recipient_type === 'school_admin'
            ? 'New student request submitted to school admin'
            : `New request from a student in class ${student.class_name} ${student.section}`;

        const notifBody = subject
          ? `Subject: ${subject}`
          : 'A student has submitted a request. Please review it.';

        await createNotification(notifyUserId, notifyUserId, notifTitle, notifBody);
      }

      await logAudit(null, 'REQUEST_SUBMITTED', {
        request_id: request.id,
        recipient_type,
        school_id: student.school_id,
        class_name: student.class_name,
        section: student.section,
        student_id: student.id,
        ...(recipient_type === 'subject_teacher' && { subject_teacher_id }),
      });

      sendSuccess(res, { success: true, request_id: request.id }, 'Request submitted', 201);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── GET /api/requests/my-teachers ─────────────────────────────────────────────
// Reuse the same teacher list logic as complaints
router.get(
  '/my-teachers',
  authenticateStudent,
  async (req: Request, res: Response) => {
    try {
      const student = req.student!;

      if (!student.class_name || !student.section) {
        sendError(res, 'Your student profile is missing class or section information', 400);
        return;
      }

      const { data: assignments, error: assignErr } = await supabaseAdmin
        .from('teacher_assignments')
        .select('teacher_id, subject')
        .eq('school_id', student.school_id)
        .eq('class_name', student.class_name)
        .eq('section', student.section);

      if (assignErr) {
        sendError(res, assignErr.message, 500);
        return;
      }

      if (!assignments || assignments.length === 0) {
        sendSuccess(res, []);
        return;
      }

      const teacherIds = [
        ...new Set(
          (assignments as { teacher_id: string; subject: string | null }[]).map(
            (a) => a.teacher_id
          )
        ),
      ];

      const { data: teachers, error: teacherErr } = await supabaseAdmin
        .from('users')
        .select('id, name')
        .in('id', teacherIds);

      if (teacherErr) {
        sendError(res, teacherErr.message, 500);
        return;
      }

      const teacherMap = new Map(
        (teachers ?? []).map((t: { id: string; name: string }) => [t.id, t.name])
      );

      const result = (
        assignments as { teacher_id: string; subject: string | null }[]
      ).map((a) => ({
        teacher_id: a.teacher_id,
        subject: a.subject ?? null,
        teacher_name: teacherMap.get(a.teacher_id) ?? 'Unknown Teacher',
      }));

      sendSuccess(res, result);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── GET /api/requests/student ─────────────────────────────────────────────────
router.get(
  '/student',
  authenticateStudent,
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabaseAdmin
        .from('student_requests')
        .select(
          'id, subject, message, recipient_type, status, resolution_note, reviewed_at, created_at'
        )
        .eq('student_id', req.student!.id)
        .order('created_at', { ascending: false });

      if (error) {
        sendError(res, error.message, 500);
        return;
      }

      sendSuccess(res, data ?? []);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── GET /api/requests/teacher ─────────────────────────────────────────────────
router.get(
  '/teacher',
  authenticate,
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    try {
      const { status } = req.query as Record<string, string>;

      let query = supabaseAdmin
        .from('student_requests')
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
          students!student_requests_student_id_fkey (
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

      if (status && ['pending', 'approved', 'rejected', 'all'].includes(status)) {
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
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── PUT /api/requests/:id/status ──────────────────────────────────────────────
router.put(
  '/:id/status',
  authenticate,
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    try {
      const parsed = updateStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.flatten());
        return;
      }

      const { status, resolution_note } = parsed.data;
      const userId = req.user!.id;
      const userRole = req.user!.role;

      const { data: existingRequest, error: fetchErr } = await supabaseAdmin
        .from('student_requests')
        .select('id, school_id, status, teacher_id, student_id')
        .eq('id', req.params.id)
        .single();

      if (fetchErr || !existingRequest) {
        sendError(res, 'Request not found', 404);
        return;
      }

      if (req.user!.school_id && existingRequest.school_id !== req.user!.school_id) {
        sendError(res, 'Access denied', 403);
        return;
      }

      // Teachers can only update requests assigned to them
      if (userRole === 'teacher' && existingRequest.teacher_id !== userId) {
        sendError(res, 'Access denied', 403);
        return;
      }

      const oldStatus = existingRequest.status;

      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('student_requests')
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

      if (existingRequest.student_id) {
        await createStudentNotification(
          existingRequest.school_id,
          existingRequest.student_id,
          `Your request has been ${status}`,
          resolution_note
            ? `Your request has been ${status}. Note: ${resolution_note}`
            : `Your request has been ${status}.`
        );
      }

      await logAudit(userId, 'REQUEST_STATUS_UPDATED', {
        request_id: req.params.id,
        old_status: oldStatus,
        new_status: status,
        updated_by_role: userRole,
      });

      sendSuccess(res, updated, 'Request status updated');
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

export default router;
