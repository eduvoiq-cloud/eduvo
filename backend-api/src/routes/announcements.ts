import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { getTokensForUsers, sendPushMulticast } from '../services/fcmService';

// ── Two routers: one for student-token routes (no `authenticate`),
//    one for staff-token routes (protected by `authenticate`).
//    Both are exported as a single combined router.
const studentRouter = Router();
const router = Router();

// Staff-only routes use the authenticate middleware globally
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

// audience: 'everyone' | 'teachers' | 'students'
const adminAnnouncementSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  audience: z.enum(['everyone', 'teachers', 'students']).default('everyone'),
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

// ── POST /api/announcements/admin ────────────────────────────────────────────
/**
 * School admin sends a school-wide announcement.
 * Stored in the announcements table with sender_role='schooladmin'.
 * audience field controls who can see it:
 *   'everyone'  → all students, parents, teachers of this school
 *   'teachers'  → only teachers
 *   'parents'   → only parents
 *   'students'  → only students
 * Uses sender_role + target_audience columns for filtering on the read path.
 * Also sends FCM push notifications to the relevant users.
 */
router.post('/admin', requireRole('schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const parsed = adminAnnouncementSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { title, message, audience } = parsed.data;
  const adminId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'Your account is not linked to a school', 403);
    return;
  }

  // Insert announcement record
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('announcements')
    .insert({
      title,
      message,
      school_id: schoolId,
      created_by: adminId,
      sender_role: 'schooladmin',
      target_audience: audience,
      target_classes: null, // admin announcements are not class-specific
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    sendError(res, insertErr.message, 500);
    return;
  }

  // Collect recipient IDs for FCM push
  const recipientIdSet = new Set<string>();

  // Fetch teachers in this school
  if (audience === 'everyone' || audience === 'teachers') {
    const { data: teachers } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('school_id', schoolId)
      .eq('role', 'teacher');
    for (const t of teachers ?? []) recipientIdSet.add(t.id);
  }

  // Count students for display (students use student tokens, not FCM via users table)
  const { count: studentCount } = await supabaseAdmin
    .from('students')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', schoolId)
    .neq('is_deleted', true);

  const { count: teacherCount } = await supabaseAdmin
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', schoolId)
    .eq('role', 'teacher');

  await logAudit(adminId, 'ADMIN_ANNOUNCEMENT_SENT', {
    announcement_id: inserted?.id,
    title,
    audience,
    school_id: schoolId,
  });

  // Fire-and-forget FCM push to teacher recipients
  const recipientIds = Array.from(recipientIdSet);
  if (recipientIds.length > 0) {
    setImmediate(() => {
      (async () => {
        try {
          const tokens = await getTokensForUsers(recipientIds);
          if (tokens.length > 0) {
            const { successCount, failureCount } = await sendPushMulticast(
              tokens,
              `Announcement: ${title}`,
              message
            );
            console.log(
              `[FCM] Admin announcement push — sent: ${successCount}, failed: ${failureCount}`
            );
          }
        } catch (err) {
          console.error('[FCM] Failed to send admin announcement push:', err);
        }
      })();
    });
  }

  const totalReachable =
    audience === 'everyone'  ? (studentCount ?? 0) + (teacherCount ?? 0)
    : audience === 'teachers' ? (teacherCount ?? 0)
    : audience === 'students' ? (studentCount ?? 0)
    : 0;

  sendSuccess(
    res,
    { announcement: inserted, audience, recipient_count: totalReachable },
    `Announcement sent to ${totalReachable} recipient${totalReachable !== 1 ? 's' : ''}`,
    201
  );
});

// ── GET /api/announcements/school ────────────────────────────────────────────
/**
 * Returns admin (school-wide) announcements for the authenticated staff member's school.
 * Used by teachers to see announcements from their school admin.
 * Returns only announcements with sender_role='schooladmin'.
 */
router.get('/school', requireRole('teacher', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'Your account is not linked to a school', 403);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('announcements')
    .select('id, title, message, target_audience, created_by, created_at, sender_role')
    .eq('school_id', schoolId)
    .eq('sender_role', 'schooladmin')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
});

// ── GET /api/announcements/student ───────────────────────────────────────────
/**
 * Returns announcements visible to the logged-in student.
 * Includes:
 *   1. Teacher announcements where target_classes matches the student's class+section.
 *   2. Admin school-wide announcements (sender_role='schooladmin') targeted at
 *      'everyone' or 'students'.
 *
 * NOTE: this route lives on studentRouter (no global `authenticate` guard)
 * so that student JWTs are accepted. `authenticateStudent` handles auth.
 */
studentRouter.get(
  '/student',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const student = req.student;
    if (!student) {
      sendError(res, 'Student not authenticated', 401);
      return;
    }

    const { class_name, section, school_id } = student;

    // Fetch all announcements for this school
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .select('id, title, message, target_classes, sender_role, target_audience, created_by, created_at')
      .eq('school_id', school_id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      sendError(res, error.message, 500);
      return;
    }

    const studentClass   = (class_name ?? '').trim().toLowerCase();
    const studentSection = (section ?? '').trim().toLowerCase();

    const relevant = (data ?? []).filter((ann: {
      sender_role?: string;
      target_audience?: string;
      target_classes?: Array<{ class: string; section: string }>;
    }) => {
      // Admin announcements: visible if audience targets everyone or students
      if (ann.sender_role === 'schooladmin') {
        const aud = ann.target_audience ?? 'everyone';
        return aud === 'everyone' || aud === 'students';
      }      // Teacher announcements: match by class+section (skip if student has no class)
      if (!studentClass || !studentSection) return false;
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

// ── Combined export ───────────────────────────────────────────────────────────
// studentRouter handles routes that use student JWTs (no global `authenticate`).
// These must be mounted BEFORE the staff `router` so Express matches them first.
// In index.ts: app.use('/api/announcements', announcementsRouter)
// Both routers share the same base path — Express merges them here.
const combinedRouter = Router();
combinedRouter.use(studentRouter); // student-token routes first (no authenticate guard)
combinedRouter.use(router);        // staff-token routes second

export default combinedRouter;
