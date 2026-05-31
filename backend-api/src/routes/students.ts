import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

router.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────

const createStudentSchema = z.object({
  full_name: z.string().min(1).max(150),
  date_of_birth: z.string().date(),
  school_id: z.string().uuid(),
  class_name: z.string().min(1).max(20),
  parent_id: z.string().uuid().optional(),
  email: z.string().email().max(254).optional(),
  phone: z.string().regex(/^\+?[\d\s\-()]{7,20}$/, 'Invalid phone number format').optional(),
});

const updateStudentSchema = createStudentSchema.partial();

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

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /api/students
 *  Supports pagination via ?page=1&limit=50 (default limit 50, max 200).
 *  Returns { data, total, page, limit, total_pages } when paginated.
 *  Pass limit=0 to fetch all (use sparingly — only for internal tooling).
 */
router.get('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const school_id = req.query.school_id as string | undefined;
  const search = req.query.search as string | undefined;
  const class_name = req.query.class_name as string | undefined;
  const section = req.query.section as string | undefined;

  // Pagination params
  const rawPage = parseInt(req.query.page as string ?? '1', 10);
  const rawLimit = parseInt(req.query.limit as string ?? '50', 10);
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  // limit=0 means fetch all (no pagination); otherwise clamp to 1–200
  const limit = rawLimit === 0 ? 0 : (isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200));

  let query = supabaseAdmin
    .from('students')
    .select('id, full_name, roll_number, class_name, section, school_id, date_of_birth, parent_id, is_first_login, is_deleted, created_at', { count: 'exact' })
    .eq('is_deleted', false)
    .order('full_name');

  // schooladmin and teacher are always scoped to their own school
  if (req.user!.role === 'schooladmin' || req.user!.role === 'teacher') {
    query = query.eq('school_id', req.user!.school_id ?? '');
  } else if (school_id) {
    query = query.eq('school_id', school_id);
  }

  // Optional filters
  if (search) {
    query = query.or(`full_name.ilike.%${search}%,roll_number.ilike.%${search}%`);
  }
  if (class_name) query = query.eq('class_name', class_name);
  if (section) query = query.eq('section', section);

  // Apply pagination (skip when limit=0)
  if (limit > 0) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.range(from, to);
  }

  const { data, error, count } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Return paginated envelope when limit > 0, plain array when limit=0
  if (limit > 0) {
    const total = count ?? 0;
    const total_pages = Math.ceil(total / limit);
    sendSuccess(res, { data: data ?? [], total, page, limit, total_pages });
  } else {
    sendSuccess(res, data ?? []);
  }
});

/** GET /api/students/:id */
router.get('/:id', requireRole('superadmin', 'schooladmin', 'teacher', 'parent'), async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('students')
    .select('id, full_name, roll_number, class_name, section, school_id, date_of_birth, phone_number, parent_id, is_first_login, is_deleted, created_at')
    .eq('id', req.params.id)
    .eq('is_deleted', false)
    .single();

  if (error || !data) {
    sendError(res, 'Student not found', 404);
    return;
  }

  // Parents can only view their own children
  if (req.user!.role === 'parent' && data.parent_id !== req.user!.id) {
    sendError(res, 'Access denied', 403);
    return;
  }

  // Teachers and schooladmins can only view students in their school
  if ((req.user!.role === 'teacher' || req.user!.role === 'schooladmin') &&
      data.school_id !== req.user!.school_id) {
    sendError(res, 'Access denied', 403);
    return;
  }

  sendSuccess(res, data);
});

/** POST /api/students — schooladmin, teacher */
router.post('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const parsed = createStudentSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('students')
    .insert(parsed.data)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'STUDENT_CREATED', { student_id: data.id });

  sendSuccess(res, data, 'Student created', 201);
});

/** PATCH /api/students/:id — schooladmin, teacher */
router.patch('/:id', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const parsed = updateStudentSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('students')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    sendError(res, 'Student not found or update failed', 404);
    return;
  }

  await logAudit(req.user!.id, 'STUDENT_UPDATED', { student_id: req.params.id });

  sendSuccess(res, data, 'Student updated');
});

/** DELETE /api/students/:id — superadmin, schooladmin only (soft delete) */
router.delete('/:id', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  // Verify student exists and belongs to the admin's school
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('students')
    .select('id, school_id, is_deleted')
    .eq('id', req.params.id)
    .single();

  if (fetchErr || !existing) {
    sendError(res, 'Student not found', 404);
    return;
  }

  // schooladmin can only delete students in their own school
  if (req.user!.role === 'schooladmin' && existing.school_id !== req.user!.school_id) {
    sendError(res, 'Access denied', 403);
    return;
  }

  if (existing.is_deleted) {
    sendError(res, 'Student is already deleted', 400);
    return;
  }

  const { error } = await supabaseAdmin
    .from('students')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', req.params.id);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'STUDENT_DELETED', { student_id: req.params.id });

  sendSuccess(res, null, 'Student deleted');
});

export default router;
