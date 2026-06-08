import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { getTokensForUsers, sendPushMulticast } from '../services/fcmService';

const router = Router();

router.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────

const teacherAnnouncementSchema = z.object({
  title: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
  target_classes: z
    .array(
      z.object({
        class: z.string().min(1).max(20),
        section: z.string().min(1).max(10),
      })
    )
    .min(1, 'At least one class must be selected'),
  school_id: z.string().uuid().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function logAudit(
  userId: string,
  action: string,
  details: Record<string, unknown> = {}
) {
  await supabaseAdmin.from('audit_logs').insert({
    user_id: userId,
    action,
    details,
    created_at: new Date().toISOString(),
  });
}

// ── POST /api/announcements/teacher ──────────────────────────────────────────
/**
 * Teacher sends an announcement to one or more of their assigned classes.
 * - Validates teacher is assigned to each selected class.
 * - Creates one announcement record per school (with target_classes array).
 * - Sends FCM push notification to all parents of students in selected classes.
 * - Logs to audit_logs.
 */
router.post('/teacher', requireRole('teacher'), async (req: Request, res: Response) => {
  const parsed = teacherAnnouncementSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { title, message, target_classes } = parsed.data;
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'Your account is not linked to a school', 403);
    return;
  }

  // Verify teacher is assigned to every selected class+section
  const { data: assignments } = await supabaseAdmin
    .from('teacher_assignments')
    .select('class_name, section')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId);

  const assignedPairs = new Set(
    (assignments ?? []).map(
      (a: { class_name: string; section: string }) =>
        `${a.class_name.trim().toLowerCase()}__${a.section.trim().toLowerCase()}`
    )
  );

  const unauthorized = target_classes.filter(
    (tc) =>
      !assignedPairs.has(
        `${tc.class.trim().toLowerCase()}__${tc.section.trim().toLowerCase()}`
      )
  );

  if (unauthorized.length > 0) {
    const labels = unauthorized.map((tc) => `${tc.class} ${tc.section}`).join(', ');
    sendError(res, `You are not assigned to: ${labels}`, 403);
    return;
  }

  // Insert one announcement record (stores all target classes in a JSON column)
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('announcements')
    .insert({
      title,
      message,
      school_id: schoolId,
      created_by: teacherId,
      target_classes,
      sender_role: 'teacher',
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    sendError(res, insertErr.message, 500);
    return;
  }

  // Collect parent IDs for students in selected classes — for push notifications
  const parentIdSet = new Set<string>();
  let totalStudents = 0;

  for (const tc of target_classes) {
    const { data: students } = await supabaseAdmin
      .from('students')
      .select('id, parent_id')
      .eq('school_id', schoolId)
      .ilike('class_name', tc.class.trim())
      .ilike('section', tc.section.trim())
      .neq('is_deleted', true);

    for (const s of students ?? []) {
      totalStudents++;
      if (s.parent_id) parentIdSet.add(s.parent_id);
    }
  }

  await logAudit(teacherId, 'TEACHER_ANNOUNCEMENT_SENT', {
    announcement_id: inserted?.id,
    title,
    target_classes,
    school_id: schoolId,
    parent_count: parentIdSet.size,
  });

  // Fire-and-forget FCM push to parents
  const parentIds = Array.from(parentIdSet);
  if (parentIds.length > 0) {
    setImmediate(() => {
      (async () => {
        try {
          const tokens = await getTokensForUsers(parentIds);
          if (tokens.length > 0) {
            const { successCount, failureCount } = await sendPushMulticast(
              tokens,
              `Announcement: ${title}`,
              message
            );
            console.log(
              `[FCM] Teacher announcement push — sent: ${successCount}, failed: ${failureCount}`
            );
          }
        } catch (err) {
          console.error('[FCM] Failed to send teacher announcement push:', err);
        }
      })();
    });
  }

  sendSuccess(
    res,
    {
      announcement: inserted,
      sent_to_count: target_classes.length,
      student_count: totalStudents,
      parents_notified: parentIdSet.size,
    },
    `Announcement sent to ${target_classes.length} class${target_classes.length !== 1 ? 'es' : ''}`,
    201
  );
});

// ── GET /api/announcements/student ───────────────────────────────────────────
/**
 * Returns announcements targeted at the logged-in student's class + section.
 * Uses the authenticateStudent middleware so req.student is available.
 * Filters by school_id and checks whether target_classes JSON array contains
 * an entry matching the student's class_name and section (case-insensitive).
 */
router.get(
  '/student',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const student = req.student;
    if (!student) {
      sendError(res, 'Student not authenticated', 401);
      return;
    }

    const { class_name, section, school_id } = student;

    if (!class_name || !section) {
      // Student has no class assigned — return empty list gracefully
      sendSuccess(res, []);
      return;
    }

    // Fetch all announcements for this school, then filter in JS for
    // target_classes containment (avoids complex JSONB GIN index requirement).
    // For schools with large announcement volumes this could be paginated,
    // but a LIMIT of 50 keeps it snappy for now.
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .select('id, title, message, target_classes, created_by, created_at')
      .eq('school_id', school_id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    // Filter to only those announcements that target this student's class+section
    const studentClass   = class_name.trim().toLowerCase();
    const studentSection = section.trim().toLowerCase();

    const relevant = (data ?? []).filter((ann: { target_classes?: Array<{ class: string; section: string }> }) => {
      const targets: Array<{ class: string; section: string }> = ann.target_classes ?? [];
      return targets.some(
        (t) =>
          t.class?.trim().toLowerCase()   === studentClass &&
          t.section?.trim().toLowerCase() === studentSection
      );
    });

    sendSuccess(res, relevant);
  }
);

// ── GET /api/announcements/my ─────────────────────────────────────────────────
/**
 * Returns all announcements created by the logged-in teacher.
 * Sorted newest first.
 */
router.get('/my', requireRole('teacher'), async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'Your account is not linked to a school', 403);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('announcements')
    .select('id, title, message, target_classes, created_at')
    .eq('created_by', teacherId)
    .eq('school_id', schoolId)
    .order('created_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
});

// ── DELETE /api/announcements/:id ─────────────────────────────────────────────
/**
 * Hard-delete an announcement.
 * Only the teacher who created it can delete it.
 */
router.delete('/:id', requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const userRole = req.user!.role;

  // Fetch the announcement first
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('announcements')
    .select('id, title, created_by, school_id')
    .eq('id', req.params.id)
    .single();

  if (fetchErr || !existing) {
    sendError(res, 'Announcement not found', 404);
    return;
  }

  // Teachers can only delete their own announcements
  if (userRole === 'teacher' && existing.created_by !== userId) {
    sendError(res, 'You can only delete your own announcements', 403);
    return;
  }

  // School admins/superadmins can only delete announcements from their school
  if (userRole === 'schooladmin' && existing.school_id !== req.user!.school_id) {
    sendError(res, 'Access denied', 403);
    return;
  }

  const { error: deleteErr } = await supabaseAdmin
    .from('announcements')
    .delete()
    .eq('id', req.params.id);

  if (deleteErr) {
    sendError(res, deleteErr.message, 500);
    return;
  }

  await logAudit(userId, 'ANNOUNCEMENT_DELETED', {
    announcement_id: req.params.id,
    title: existing.title,
    deleted_by_role: userRole,
  });

  sendSuccess(res, null, 'Announcement deleted');
});

export default router;
