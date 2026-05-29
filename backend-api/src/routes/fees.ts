import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();
router.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────

const toggleFeeSchema = z.object({
  fee_paid: z.boolean(),
  term: z.string().min(1),
  academic_year: z.string().min(1),
  notes: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function logAudit(userId: string, action: string, details: Record<string, unknown> = {}) {
  await supabaseAdmin.from('audit_logs').insert({
    user_id: userId, action, details, created_at: new Date().toISOString(),
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/fees?class_name=&section=&term=&academic_year=
 * Returns fee records for students in the teacher's school.
 * Teachers are scoped to their assigned classes.
 */
router.get('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const { class_name, section, term, academic_year } = req.query as Record<string, string>;

  // Build student filter
  let studentQuery = supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, school_id')
    .eq('school_id', req.user!.school_id ?? '');

  if (class_name) studentQuery = studentQuery.eq('class_name', class_name);
  if (section) studentQuery = studentQuery.eq('section', section);

  const { data: students, error: sErr } = await studentQuery;
  if (sErr) { sendError(res, sErr.message, 500); return; }
  if (!students || students.length === 0) { sendSuccess(res, []); return; }

  const studentIds = students.map((s: { id: string }) => s.id);

  // Fetch fee records for those students
  let feeQuery = supabaseAdmin
    .from('student_fees')
    .select('*')
    .in('student_id', studentIds);

  if (term) feeQuery = feeQuery.eq('term', term);
  if (academic_year) feeQuery = feeQuery.eq('academic_year', academic_year);

  const { data: fees, error: fErr } = await feeQuery;
  if (fErr) { sendError(res, fErr.message, 500); return; }

  // Merge: one row per student, with fee status
  const feeMap = new Map((fees ?? []).map((f: { student_id: string }) => [f.student_id, f]));
  const result = students.map((s: { id: string; full_name: string; class_name: string; section: string }) => ({
    student_id: s.id,
    full_name: s.full_name,
    class_name: s.class_name,
    section: s.section,
    fee_record: feeMap.get(s.id) ?? null,
    fee_paid: (feeMap.get(s.id) as { fee_paid?: boolean } | undefined)?.fee_paid ?? false,
  }));

  sendSuccess(res, result);
});

/**
 * POST /api/fees/:student_id/toggle
 * Upserts a fee record for a student (paid / unpaid).
 */
router.post('/:student_id/toggle', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const parsed = toggleFeeSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  // Verify student belongs to teacher's school
  const { data: student } = await supabaseAdmin
    .from('students')
    .select('id, full_name, school_id, class_name, section')
    .eq('id', req.params.student_id)
    .single();

  if (!student || student.school_id !== req.user!.school_id) {
    sendError(res, 'Student not found in your school', 404);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('student_fees')
    .upsert({
      student_id: req.params.student_id,
      term: parsed.data.term,
      academic_year: parsed.data.academic_year,
      fee_paid: parsed.data.fee_paid,
      notes: parsed.data.notes ?? null,
      updated_by: req.user!.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'student_id,term,academic_year' })
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(req.user!.id, 'FEE_TOGGLED', {
    student_id: req.params.student_id,
    student_name: student.full_name,
    fee_paid: parsed.data.fee_paid,
    term: parsed.data.term,
  });

  sendSuccess(res, data, `Fee marked as ${parsed.data.fee_paid ? 'paid' : 'unpaid'}`);
});

export default router;
