import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateAny } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

router.use(authenticateAny);

// ── Schemas ───────────────────────────────────────────────────────────────────

const createMarkSchema = z.object({
  student_id: z.string().uuid(),
  subject: z.string().min(1).max(100),
  score: z.number().min(0).max(100),
  max_score: z.number().min(1).default(100),
  term: z.string().min(1).max(50),
  exam_type: z.enum(['quiz', 'midterm', 'final', 'assignment', 'project', 'unit_test', 'mid_term', 'class_test']),
  notes: z.string().max(1000).optional(),
});

const updateMarkSchema = createMarkSchema.partial();

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

/** GET /api/marks?student_id=&subject=&term= */
router.get('/', async (req: Request, res: Response) => {
  const { student_id, subject, term } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('marks')
    .select('*, students(full_name)')
    .order('created_at', { ascending: false });

  if (subject) query = query.eq('subject', subject);
  if (term) query = query.eq('term', term);

  // ── Student token: filter to their own records ──────────────────────────
  if (req.tokenType === 'student') {
    query = query.eq('student_id', req.student!.id);
  } else {
    // ── Staff token ─────────────────────────────────────────────────────────
    const role = req.user!.role;

    if (!['superadmin', 'schooladmin', 'teacher', 'parent', 'student'].includes(role)) {
      sendError(res, 'Access denied', 403);
      return;
    }

    if (student_id) query = query.eq('student_id', student_id);

    // Logged-in as student role via staff token (legacy) — filter to own marks
    if (role === 'student') {
      const { data: studentRecord } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('user_id', req.user!.id)
        .eq('is_deleted', false)
        .single();

      if (studentRecord) {
        query = query.eq('student_id', studentRecord.id);
      } else {
        sendSuccess(res, []);
        return;
      }
    }

    // Parents can only see their children's marks
    if (role === 'parent') {
      const { data: children } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('parent_id', req.user!.id);

      const childIds = (children ?? []).map((c: { id: string }) => c.id);
      query = query.in('student_id', childIds);
    }
  }

  const { data, error } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
});

/** POST /api/marks — schooladmin, teacher */
router.post('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const parsed = createMarkSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  // Score cannot exceed max_score
  if (parsed.data.score > parsed.data.max_score) {
    sendError(res, `Score (${parsed.data.score}) cannot exceed max score (${parsed.data.max_score})`, 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('marks')
    .insert({ ...parsed.data, recorded_by: req.user!.id })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'MARK_CREATED', {
    student_id: parsed.data.student_id,
    subject: parsed.data.subject,
    score: parsed.data.score,
  });

  sendSuccess(res, data, 'Mark recorded', 201);
});

/** PATCH /api/marks/:id — schooladmin, teacher */
router.patch('/:id', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const parsed = updateMarkSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  // If both score and max_score are provided, validate score <= max_score
  if (
    parsed.data.score !== undefined &&
    parsed.data.max_score !== undefined &&
    parsed.data.score > parsed.data.max_score
  ) {
    sendError(res, `Score (${parsed.data.score}) cannot exceed max score (${parsed.data.max_score})`, 400);
    return;
  }

  // If only score is provided, fetch existing max_score to validate
  if (parsed.data.score !== undefined && parsed.data.max_score === undefined) {
    const { data: existing } = await supabaseAdmin
      .from('marks')
      .select('max_score')
      .eq('id', req.params.id)
      .maybeSingle();
    if (existing && parsed.data.score > (existing as { max_score: number }).max_score) {
      sendError(res, `Score (${parsed.data.score}) cannot exceed existing max score (${(existing as { max_score: number }).max_score})`, 400);
      return;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('marks')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) {
    sendError(res, 'Mark not found or update failed', 404);
    return;
  }

  await logAudit(req.user!.id, 'MARK_UPDATED', { mark_id: req.params.id });

  sendSuccess(res, data, 'Mark updated');
});

/** DELETE /api/marks/:id — superadmin, schooladmin only */
router.delete('/:id', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const { error } = await supabaseAdmin
    .from('marks')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'MARK_DELETED', { mark_id: req.params.id });

  sendSuccess(res, null, 'Mark deleted');
});

export default router;
