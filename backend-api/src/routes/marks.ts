import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../config/supabase';
import { authenticateAny } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import { normaliseTerm, termFilterValues } from '../utils/term';

const router = Router();

router.use(authenticateAny);

// ── Rate limiter: max 30 mark deletions per hour per admin account ────────────
// Prevents a compromised schooladmin from bulk-wiping all marks in seconds.
// Superadmin is exempt — they have a different threat model and are individually
// audited. Keyed by user ID so it can't be bypassed by rotating IPs.
const markDeleteRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  keyGenerator: (req: Request) => `mark_delete:${req.user?.id ?? req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  // validate:false is intentional — see middleware/rateLimit.ts for explanation.
  // app.set('trust proxy', 1) in index.ts ensures req.ip is the real client IP.
  validate: false,
  skip: (req: Request) => req.user?.role === 'superadmin',
  message: {
    success: false,
    message: 'Mark deletion limit reached (30 per hour). Please try again later.',
  },
});

// ── Schemas ───────────────────────────────────────────────────────────────────

const createMarkSchema = z.object({
  student_id: z.string().uuid(),
  subject: z.string().min(1).max(100),
  score: z.number().min(0),
  max_score: z.number().min(1).default(100),
  term: z.string().min(1).max(50),
  exam_type: z.enum(['quiz', 'midterm', 'final', 'assignment', 'project', 'unit_test', 'mid_term', 'class_test']),
  notes: z.string().max(1000).optional(),
});

const updateMarkSchema = createMarkSchema.partial();

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /api/marks?student_id=&subject=&term= */
router.get('/', async (req: Request, res: Response) => {
  const { student_id, subject, term } = req.query as Record<string, string>;

  // Pagination support: ?page=1&limit=100 (default 100, max 500 for marks)
  const rawPage  = parseInt((req.query.page  as string) ?? '1',   10);
  const rawLimit = parseInt((req.query.limit as string) ?? '100', 10);
  const page  = isNaN(rawPage)  || rawPage  < 1 ? 1   : rawPage;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 100 : Math.min(rawLimit, 500);

  // ── Student token: simple select, no join needed — we already have their ID ──
  if (req.tokenType === 'student') {
    let studentQuery = supabaseAdmin
      .from('marks')
      .select('*', { count: 'exact' })
      .eq('student_id', req.student!.id)
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (subject) studentQuery = studentQuery.eq('subject', subject);

    if (term) {
      const termValues = termFilterValues(term);
      studentQuery = termValues.length === 1
        ? studentQuery.eq('term', termValues[0])
        : studentQuery.in('term', termValues);
    }

    const { data: studentData, error: studentError, count: studentCount } = await studentQuery;

    if (studentError) {
      console.error('[marks] GET student query error:', studentError.message);
      sendError(res, 'Failed to fetch marks', 500);
      return;
    }

    const total = studentCount ?? 0;
    sendSuccess(res, {
      data: studentData ?? [],
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    });
    return;
  }

  // ── Staff token: use inner join to enable school-scoped filtering ──────────
  let query = supabaseAdmin
    .from('marks')
    .select('*, students!inner(full_name, school_id)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (subject) query = query.eq('subject', subject);

  // Accept both term formats (term_1 or Term 1) by matching all equivalents
  if (term) {
    const termValues = termFilterValues(term);
    query = termValues.length === 1
      ? query.eq('term', termValues[0])
      : query.in('term', termValues);
  }

  const role = req.user!.role;

  // Teachers and school admins: use a server-side join to scope by school_id.
  // This avoids fetching all student IDs first (N+1 pattern).
  if (role === 'teacher' || role === 'schooladmin') {
    const schoolId = req.user!.school_id;
    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }
    query = query.eq('students.school_id', schoolId);
    if (student_id) query = query.eq('student_id', student_id);
  } else if (role === 'superadmin') {
    if (student_id) query = query.eq('student_id', student_id);
  } else if (role === 'student') {
    // Legacy: staff token with student role — look up via user_id
    const { data: studentRecord } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('user_id', req.user!.id)
      .eq('is_deleted', false)
      .single();

    if (studentRecord) {
      query = query.eq('student_id', studentRecord.id);
    } else {
      sendSuccess(res, { data: [], total: 0, page, limit, total_pages: 0 });
      return;
    }
  } else if (role === 'parent') {
    // Parents can only see their children's marks
    const { data: children } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('parent_id', req.user!.id);

    const childIds = (children ?? []).map((c: { id: string }) => c.id);
    if (childIds.length === 0) {
      sendSuccess(res, { data: [], total: 0, page, limit, total_pages: 0 });
      return;
    }
    query = query.in('student_id', childIds);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('[marks] GET staff query error:', error.message);
    sendError(res, 'Failed to fetch marks', 500);
    return;
  }

  const total = count ?? 0;
  sendSuccess(res, { data: data ?? [], total, page, limit, total_pages: Math.ceil(total / limit) });
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

  // Verify the student belongs to the requesting user's school (non-superadmin)
  if (req.user!.role !== 'superadmin') {
    const { data: student } = await supabaseAdmin
      .from('students')
      .select('school_id')
      .eq('id', parsed.data.student_id)
      .maybeSingle();

    if (!student || student.school_id !== req.user!.school_id) {
      sendError(res, 'Student not found in your school', 403);
      return;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('marks')
    .insert({
      ...parsed.data,
      term: normaliseTerm(parsed.data.term) ?? parsed.data.term,
      recorded_by: req.user!.id,
    })
    .select()
    .single();

  if (error) {
    console.error('[marks] POST insert error:', error.message);
    sendError(res, 'Failed to record mark', 500);
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

  // Fetch the existing mark and verify the student belongs to the requesting user's school
  const { data: existing } = await supabaseAdmin
    .from('marks')
    .select('id, max_score, updated_at, student_id, students!inner(school_id)')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!existing) {
    sendError(res, 'Mark not found', 404);
    return;
  }

  // Non-superadmin users can only update marks for students in their school
  if (req.user!.role !== 'superadmin') {
    const studentSchool = (existing as Record<string, unknown>).students as { school_id: string } | null;
    if (!studentSchool || studentSchool.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }
  }

  // If only score is provided, validate against existing max_score
  if (parsed.data.score !== undefined && parsed.data.max_score === undefined) {
    if (parsed.data.score > (existing as { max_score: number }).max_score) {
      sendError(
        res,
        `Score (${parsed.data.score}) cannot exceed existing max score (${(existing as { max_score: number }).max_score})`,
        400
      );
      return;
    }
  }

  // ── Optimistic locking: if client sends updated_at, check it hasn't changed ──
  // This prevents two admins overwriting each other's changes simultaneously.
  const clientUpdatedAt = req.body.updated_at as string | undefined;
  if (clientUpdatedAt && (existing as { updated_at?: string }).updated_at) {
    const existingTs = new Date((existing as { updated_at: string }).updated_at).getTime();
    const clientTs   = new Date(clientUpdatedAt).getTime();
    if (existingTs !== clientTs) {
      sendError(res, 'This record was modified by someone else. Please refresh and try again.', 409);
      return;
    }
  }

  // Strip updated_at from the user-supplied payload — the DB trigger manages it
  const { updated_at: _strip, ...safeUpdate } = parsed.data as typeof parsed.data & { updated_at?: string };

  const { data, error } = await supabaseAdmin
    .from('marks')
    .update(safeUpdate)
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
router.delete('/:id', requireRole('superadmin', 'schooladmin'), markDeleteRateLimit, async (req: Request, res: Response) => {
  // Verify the mark belongs to the requesting user's school before deleting
  if (req.user!.role !== 'superadmin') {
    const { data: existing } = await supabaseAdmin
      .from('marks')
      .select('id, students!inner(school_id)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!existing) {
      sendError(res, 'Mark not found', 404);
      return;
    }

    const studentSchool = (existing as Record<string, unknown>).students as { school_id: string } | null;
    if (!studentSchool || studentSchool.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }
  }

  const { error } = await supabaseAdmin
    .from('marks')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    console.error('[marks] DELETE error:', error.message);
    sendError(res, 'Failed to delete mark', 500);
    return;
  }

  await logAudit(req.user!.id, 'MARK_DELETED', { mark_id: req.params.id });

  sendSuccess(res, null, 'Mark deleted');
});

export default router;
