import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();
router.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────

const createComplaintSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  student_id: z.string().uuid().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['pending', 'reviewed', 'resolved']),
  resolution_note: z.string().max(2000).optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function logAudit(userId: string, action: string, details: Record<string, unknown> = {}) {
  await supabaseAdmin.from('audit_logs').insert({
    user_id: userId, action, details, created_at: new Date().toISOString(),
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/complaints
 * - Parents see their own complaints
 * - Teachers see complaints for their school
 * - schooladmin / superadmin see all in their school
 */
router.get('/', requireRole('superadmin', 'schooladmin', 'teacher', 'parent'), async (req: Request, res: Response) => {
  const { status } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('complaints')
    .select('id, subject, status, school_id, submitted_by, student_id, created_at, resolution_note, reviewed_by, reviewed_at')
    .order('created_at', { ascending: false });

  // Scope to school
  query = query.eq('school_id', req.user!.school_id ?? '');

  // Parents only see their own
  if (req.user!.role === 'parent') {
    query = query.eq('submitted_by', req.user!.id);
  }

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) { sendError(res, error.message, 500); return; }

  sendSuccess(res, data);
});

/**
 * POST /api/complaints — parents submit complaints
 */
router.post('/', requireRole('parent', 'schooladmin', 'superadmin'), async (req: Request, res: Response) => {
  const parsed = createComplaintSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { data, error } = await supabaseAdmin
    .from('complaints')
    .insert({
      ...parsed.data,
      school_id: req.user!.school_id,
      submitted_by: req.user!.id,
      status: 'pending',
    })
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(req.user!.id, 'COMPLAINT_SUBMITTED', { complaint_id: data.id });

  sendSuccess(res, data, 'Complaint submitted', 201);
});

/**
 * PATCH /api/complaints/:id/status
 * Teachers and admins can update status.
 */
router.patch('/:id/status', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  // Verify complaint belongs to teacher's school
  const { data: existing } = await supabaseAdmin
    .from('complaints')
    .select('id, school_id, status')
    .eq('id', req.params.id)
    .single();

  if (!existing) { sendError(res, 'Complaint not found', 404); return; }
  if (existing.school_id !== req.user!.school_id) { sendError(res, 'Access denied', 403); return; }

  const { data, error } = await supabaseAdmin
    .from('complaints')
    .update({
      status: parsed.data.status,
      resolution_note: parsed.data.resolution_note ?? null,
      reviewed_by: req.user!.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(req.user!.id, 'COMPLAINT_STATUS_UPDATED', {
    complaint_id: req.params.id,
    old_status: existing.status,
    new_status: parsed.data.status,
  });

  sendSuccess(res, data, 'Status updated');
});

export default router;
