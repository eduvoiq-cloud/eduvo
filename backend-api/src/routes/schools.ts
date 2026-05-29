import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const createSchoolSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
  phone: z.string().regex(/^\+?[\d\s\-()]{7,20}$/, 'Invalid phone number format').optional(),
  email: z.string().email().max(254).optional(),
});

const updateSchoolSchema = createSchoolSchema.partial();

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

// ── Public routes (no auth) ───────────────────────────────────────────────────

/**
 * GET /api/schools/list — public, no auth required.
 * Used by the RFID gate page to populate the school selector.
 * Returns only id and name.
 */
router.get('/list', async (_req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('schools')
    .select('id, name')
    .order('name');

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
});

// All routes below require authentication
router.use(authenticate);

// ── Authenticated routes ──────────────────────────────────────────────────────

/** GET /api/schools — superadmin only */
router.get('/', requireRole('superadmin'), async (_req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('schools')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

/** GET /api/schools/:id */
router.get('/:id', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
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
});

/** POST /api/schools — superadmin only */
router.post('/', requireRole('superadmin'), async (req: Request, res: Response) => {
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
});

/** PATCH /api/schools/:id — superadmin only */
router.patch('/:id', requireRole('superadmin'), async (req: Request, res: Response) => {
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
});

/** DELETE /api/schools/:id — superadmin only */
router.delete('/:id', requireRole('superadmin'), async (req: Request, res: Response) => {
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
});

export default router;
