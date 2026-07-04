import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError, sendDbError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// ── All routes require staff authentication ───────────────────────────────────
router.use(authenticate);

// ── Helper: getClassAdmin ─────────────────────────────────────────────────────
/**
 * Returns the class_admin row for a given school/class/section, or null.
 * Exported so other route files can use it (e.g. to gate class-admin actions).
 */
export async function getClassAdmin(
  schoolId: string,
  className: string,
  section: string
): Promise<{
  teacher_id: string;
  school_id: string;
  class_name: string;
  section: string;
  appointed_by: string | null;
  appointed_at: string | null;
} | null> {
  const { data, error } = await supabaseAdmin
    .from('class_admins')
    .select('teacher_id, school_id, class_name, section, appointed_by, appointed_at')
    .eq('school_id', schoolId)
    .ilike('class_name', className.trim())
    .ilike('section', section.trim())
    .maybeSingle();

  if (error) {
    console.error('[classAdmin] getClassAdmin error:', error.message);
    return null;
  }
  return data ?? null;
}

// ── Helper: isClassAdmin ──────────────────────────────────────────────────────
/**
 * Returns true if the given teacher is the class admin for school/class/section.
 * Exported for use in other route files.
 */
export async function isClassAdmin(
  teacherId: string,
  schoolId: string,
  className: string,
  section: string
): Promise<boolean> {
  const row = await getClassAdmin(schoolId, className, section);
  return row?.teacher_id === teacherId;
}

// ── GET /api/class-admin/my-classes ──────────────────────────────────────────
/**
 * Returns all classes where the logged-in teacher is class admin.
 * Auth: teacher only.
 */
router.get(
  '/my-classes',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    try {
    const teacherId = req.user!.id;
    const schoolId  = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('class_admins')
      .select('class_name, section, appointed_at')
      .eq('teacher_id', teacherId)
      .eq('school_id', schoolId)
      .order('class_name', { ascending: true });

    if (error) {
      sendDbError(res, error, 'classAdmin GET /my-classes');
      return;
    }

    sendSuccess(res, data ?? []);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── GET /api/class-admin/check ────────────────────────────────────────────────
/**
 * Check who (if anyone) is the class admin for a given class+section.
 * Query params: class_name, section
 * Auth: teacher only.
 * Returns: { is_class_admin: boolean, class_admin: { teacher_id, teacher_name } | null }
 */
router.get(
  '/check',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    try {
    const { class_name, section } = req.query as Record<string, string>;

    if (!class_name || !section) {
      sendError(res, 'class_name and section are required', 400);
      return;
    }

    const schoolId = req.user!.school_id;
    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // Join class_admins → users to get teacher_name in one query
    const { data, error } = await supabaseAdmin
      .from('class_admins')
      .select('teacher_id, users!class_admins_teacher_id_fkey(name)')
      .eq('school_id', schoolId)
      .ilike('class_name', class_name.trim())
      .ilike('section', section.trim())
      .maybeSingle();

    if (error) {
      sendDbError(res, error, 'classAdmin GET /check');
      return;
    }

    if (!data) {
      sendSuccess(res, { is_class_admin: false, class_admin: null });
      return;
    }

    const teacherName = ((data as unknown as { users: { name: string } | null }).users)?.name ?? null;

    sendSuccess(res, {
      is_class_admin: true,
      class_admin: {
        teacher_id: data.teacher_id,
        teacher_name: teacherName,
      },
    });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── GET /api/class-admin/list ─────────────────────────────────────────────────
router.get(
  '/list',
  requireRole('schooladmin'),
  async (req: Request, res: Response) => {
    try {
    const schoolId = req.user!.school_id;
    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('class_admins')
      .select('id, teacher_id, class_name, section, appointed_at, users!class_admins_teacher_id_fkey(name)')
      .eq('school_id', schoolId)
      .order('class_name', { ascending: true });

    if (error) {
      sendDbError(res, error, 'classAdmin GET /list');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (data ?? []).map((row: any) => ({
      id: row.id as string,
      teacher_id: row.teacher_id as string,
      teacher_name: (row.users as { name: string } | null)?.name ?? null,
      class_name: row.class_name as string,
      section: row.section as string,
      appointed_at: (row.appointed_at as string | null) ?? null,
    }));

    sendSuccess(res, result);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── POST /api/class-admin/appoint ─────────────────────────────────────────────
router.post(
  '/appoint',
  requireRole('schooladmin'),
  async (req: Request, res: Response) => {
    try {
    const schema = z.object({
      teacher_id: z.string().uuid('teacher_id must be a valid UUID'),
      class_name: z.string().min(1).max(50),
      section:    z.string().min(1).max(20),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { teacher_id, class_name, section } = parsed.data;
    const adminId  = req.user!.id;
    const schoolId = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // Verify teacher belongs to the same school
    const { data: teacher, error: teacherErr } = await supabaseAdmin
      .from('users')
      .select('id, school_id, role')
      .eq('id', teacher_id)
      .eq('school_id', schoolId)
      .eq('role', 'teacher')
      .maybeSingle();

    if (teacherErr) {
      sendDbError(res, teacherErr, 'classAdmin POST /appoint teacher lookup');
      return;
    }

    if (!teacher) {
      sendError(res, 'Teacher not found in your school', 404);
      return;
    }

    // Upsert — replaces existing class admin for this class+section
    const { error: upsertErr } = await supabaseAdmin
      .from('class_admins')
      .upsert(
        {
          teacher_id,
          school_id: schoolId,
          class_name: class_name.trim(),
          section: section.trim(),
          appointed_by: adminId,
          appointed_at: new Date().toISOString(),
        },
        { onConflict: 'school_id,class_name,section' }
      );

    if (upsertErr) {
      sendDbError(res, upsertErr, 'classAdmin POST /appoint upsert');
      return;
    }

    await logAudit(adminId, 'CLASS_ADMIN_APPOINTED', 'class_admins', {
      teacher_id,
      school_id: schoolId,
      class_name: class_name.trim(),
      section: section.trim(),
    });

    sendSuccess(res, { success: true }, 'Class admin appointed successfully', 201);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── DELETE /api/class-admin/remove ────────────────────────────────────────────
router.delete(
  '/remove',
  requireRole('schooladmin'),
  async (req: Request, res: Response) => {
    try {
    const schema = z.object({
      class_name: z.string().min(1).max(50),
      section:    z.string().min(1).max(20),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { class_name, section } = parsed.data;
    const adminId  = req.user!.id;
    const schoolId = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // Check the row exists before deleting so we can return a useful 404
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('class_admins')
      .select('teacher_id')
      .eq('school_id', schoolId)
      .ilike('class_name', class_name.trim())
      .ilike('section', section.trim())
      .maybeSingle();

    if (fetchErr) {
      sendDbError(res, fetchErr, 'classAdmin DELETE /remove fetch');
      return;
    }

    if (!existing) {
      sendError(res, 'No class admin found for this class and section', 404);
      return;
    }

    const { error: deleteErr } = await supabaseAdmin
      .from('class_admins')
      .delete()
      .eq('school_id', schoolId)
      .ilike('class_name', class_name.trim())
      .ilike('section', section.trim());

    if (deleteErr) {
      sendDbError(res, deleteErr, 'classAdmin DELETE /remove');
      return;
    }

    await logAudit(adminId, 'CLASS_ADMIN_REMOVED', 'class_admins', {
      school_id: schoolId,
      class_name: class_name.trim(),
      section: section.trim(),
      removed_teacher_id: existing.teacher_id,
    });

    sendSuccess(res, { success: true }, 'Class admin removed successfully');
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

export default router;
