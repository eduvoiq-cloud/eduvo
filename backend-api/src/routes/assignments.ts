import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

router.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────

const createAssignmentSchema = z.object({
  teacher_id: z.string().uuid(),
  school_id: z.string().uuid(),
  class_name: z.string().min(1).max(20),
  section: z.string().min(1).max(10),
  subject: z.string().min(1).max(100),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /api/assignments?school_id= */
router.get('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  try {
  const { school_id, teacher_id } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('teacher_assignments')
    .select('*');

  // schooladmin scoped to their school
  if (req.user!.role === 'schooladmin') {
    query = query.eq('school_id', req.user!.school_id ?? '');
  } else if (school_id) {
    query = query.eq('school_id', school_id);
  }

  // teacher can only see their own assignments
  if (req.user!.role === 'teacher') {
    query = query.eq('teacher_id', req.user!.id);
  } else if (teacher_id) {
    query = query.eq('teacher_id', teacher_id);
  }

  const { data, error } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

/** POST /api/assignments */
router.post('/', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  try {
  const parsed = createAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  // schooladmin can only assign within their school
  if (req.user!.role === 'schooladmin' && parsed.data.school_id !== req.user!.school_id) {
    sendError(res, 'You can only assign teachers within your school', 403);
    return;
  }

  // Verify teacher belongs to the school
  const { data: teacher } = await supabaseAdmin
    .from('users')
    .select('id, school_id, role')
    .eq('id', parsed.data.teacher_id)
    .single();

  if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== parsed.data.school_id) {
    sendError(res, 'Teacher not found in this school', 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('teacher_assignments')
    .insert({ ...parsed.data, class: parsed.data.class_name })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'ASSIGNMENT_CREATED', {
    assignment_id: data.id,
    teacher_id: parsed.data.teacher_id,
  });

  sendSuccess(res, data, 'Assignment created', 201);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

/** DELETE /api/assignments/:id */
router.delete('/:id', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  try {
  // Verify ownership before deleting
  const { data: existing } = await supabaseAdmin
    .from('teacher_assignments')
    .select('id, school_id')
    .eq('id', req.params.id)
    .single();

  if (!existing) {
    sendError(res, 'Assignment not found', 404);
    return;
  }

  if (req.user!.role === 'schooladmin' && existing.school_id !== req.user!.school_id) {
    sendError(res, 'Access denied', 403);
    return;
  }

  const { error } = await supabaseAdmin
    .from('teacher_assignments')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'ASSIGNMENT_DELETED', { assignment_id: req.params.id });

  sendSuccess(res, null, 'Assignment removed');
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

export default router;
