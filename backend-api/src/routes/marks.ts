import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateAny } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { normaliseTerm, termFilterValues } from '../utils/term';

const router = Router();

router.use(authenticateAny);

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

  // Accept both term formats (term_1 or Term 1) by matching all equivalents
  if (term) {
    const termValues = termFilterValues(term);
    query = termValues.length === 1
      ? query.eq('term', termValues[0])
      : query.in('term', termValues);
  }

  // ── Student token: filter strictly to their own records ─────────────────
  if (req.tokenType === 'student') {
    // Ignore any student_id in the query string — always use the token owner's ID
    query = query.eq('student_id', req.student!.id);
  } else {
    // ── Staff token ─────────────────────────────────────────────────────────
    const role = req.user!.role;

    if (!['superadmin', 'schooladmin', 'teacher', 'parent', 'student'].includes(role)) {
      sendError(res, 'Access denied', 403);
      return;
    }

    // Teachers and school admins are scoped to their own school
    if (role === 'teacher' || role === 'schooladmin') {
      const schoolId = req.user!.school_id;
      if (!schoolId) {
        sendError(res, 'Your account is not linked to a school', 403);
        return;
      }
      // Only fetch marks for students in the teacher's school
      const { data: schoolStudents } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('school_id', schoolId)
        .eq('is_deleted', false);
      const schoolStudentIds = (schoolStudents ?? []).map((s: { id: string }) => s.id);
      if (schoolStudentIds.length === 0) {
        sendSuccess(res, []);
        return;
      }
      query = query.in('student_id', schoolStudentIds);
      if (student_id) query = query.eq('student_id', student_id);
    } else if (role !== 'superadmin') {
      if (student_id) query = query.eq('student_id', student_id);
    }

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
    .insert({ ...parsed.data, term: normaliseTerm(parsed.data.term) ?? parsed.data.term, recorded_by: req.user!.id })
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

  // Fetch the existing mark and verify the student belongs to the requesting user's school
  const { data: existing } = await supabaseAdmin
    .from('marks')
    .select('id, max_score, student_id, students!inner(school_id)')
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
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'MARK_DELETED', { mark_id: req.params.id });

  sendSuccess(res, null, 'Mark deleted');
});

export default router;
