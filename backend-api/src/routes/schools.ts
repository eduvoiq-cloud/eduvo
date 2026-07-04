import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { schoolListRateLimit } from '../middleware/rateLimit';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const BOARD_VALUES = ['GSEB', 'CBSE', 'ICSE', 'MSBSHSE', 'RBSE', 'BSEB', 'MPBSE', 'IB', 'IGCSE'] as const;
const RESULT_TEMPLATE_VALUES = ['percentage', 'grade', 'gseb', 'cbse'] as const;

const createSchoolSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
  phone: z.string().regex(/^\+?[\d\s\-()]{7,20}$/, 'Invalid phone number format').optional(),
  email: z.string().email().max(254).optional(),
  board: z.enum(BOARD_VALUES).optional().default('GSEB'),
  result_template: z.enum(RESULT_TEMPLATE_VALUES).optional().default('percentage'),
});

const updateSchoolSchema = createSchoolSchema.partial().extend({
  is_active: z.boolean().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Public routes (no auth) ───────────────────────────────────────────────────

/**
 * GET /api/schools/list — public, no auth required.
 * Used by the school selector on the login page.
 * Returns only id and name. Rate-limited to 30 req/min per IP to prevent scraping.
 */
router.get('/list', schoolListRateLimit, async (_req: Request, res: Response) => {
  try {
  const { data, error } = await supabaseAdmin
    .from('schools')
    .select('id, name')
    .order('name');

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// All routes below require authentication
router.use(authenticate);

// ── Authenticated routes ──────────────────────────────────────────────────────

/** GET /api/schools — superadmin only */
router.get('/', requireRole('superadmin'), async (_req: Request, res: Response) => {
  try {
  const { data, error } = await supabaseAdmin
    .from('schools')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

/** GET /api/schools/:id */
router.get('/:id', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  try {
  // Teachers and schooladmins can only fetch their own school — prevents
  // cross-school data leakage (e.g. a teacher enumerating competitor schools).
  if (req.user!.role === 'teacher' || req.user!.role === 'schooladmin') {
    if (req.params.id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('schools')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    sendError(res, 'School not found', 404);
    return;
  }

  sendSuccess(res, data);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

/** POST /api/schools — superadmin only */
router.post('/', requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
  const parsed = createSchoolSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('schools')
    .insert(parsed.data)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'SCHOOL_CREATED', { school_id: data.id, name: data.name });

  sendSuccess(res, data, 'School created', 201);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

/** PATCH /api/schools/:id — superadmin only */
router.patch('/:id', requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
  const parsed = updateSchoolSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('schools')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    sendError(res, 'School not found or update failed', 404);
    return;
  }

  await logAudit(req.user!.id, 'SCHOOL_UPDATED', { school_id: req.params.id });

  sendSuccess(res, data, 'School updated');
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

/** DELETE /api/schools/:id — superadmin only */
router.delete('/:id', requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
  const { error } = await supabaseAdmin
    .from('schools')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'SCHOOL_DELETED', { school_id: req.params.id });

  sendSuccess(res, null, 'School deleted');
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

export default router;
