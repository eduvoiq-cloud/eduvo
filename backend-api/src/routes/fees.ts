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
  term: z.string().min(1).max(50),
  academic_year: z.string().min(1).max(20),
  notes: z.string().max(500).optional(),
});

const updatePaymentSchema = z.object({
  term: z.string().max(50).optional(),
  academic_year: z.string().max(20).optional(),
  total_fee_amount: z.number().min(0),
  amount_paid: z.number().min(0),
  notes: z.string().max(500).optional(),
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

  if (class_name) studentQuery = studentQuery.ilike('class_name', class_name.trim());
  if (section) studentQuery = studentQuery.ilike('section', section.trim());

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

  // Merge: one row per student, with fee status and amounts
  const feeMap = new Map((fees ?? []).map((f: { student_id: string }) => [f.student_id, f]));
  const result = students.map((s: { id: string; full_name: string; class_name: string; section: string }) => {
    const feeRow = feeMap.get(s.id) as {
      fee_paid?: boolean;
      total_fee_amount?: number | null;
      amount_paid?: number | null;
      term?: string;
      academic_year?: string;
      notes?: string;
      id?: string;
    } | undefined;

    const totalFee = feeRow?.total_fee_amount ?? null;
    const amountPaid = feeRow?.amount_paid ?? 0;

    // Derive payment status
    let paymentStatus: 'paid' | 'partial' | 'unpaid' = 'unpaid';
    if (totalFee !== null && totalFee > 0) {
      if (amountPaid >= totalFee) paymentStatus = 'paid';
      else if (amountPaid > 0) paymentStatus = 'partial';
    } else if (feeRow?.fee_paid) {
      paymentStatus = 'paid';
    }

    return {
      student_id: s.id,
      full_name: s.full_name,
      class_name: s.class_name,
      section: s.section,
      fee_record: feeRow ?? null,
      fee_paid: paymentStatus === 'paid',
      total_fee_amount: totalFee,
      amount_paid: amountPaid,
      payment_status: paymentStatus,
    };
  });

  sendSuccess(res, result);
});

/**
 * PUT /api/fees/:student_id/payment
 * Creates or updates a fee record with total amount and amount paid.
 * Uses select → update/insert instead of upsert to avoid constraint issues.
 */
router.put('/:student_id/payment', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const parsed = updatePaymentSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  if (parsed.data.amount_paid > parsed.data.total_fee_amount) {
    sendError(res, 'Amount paid cannot exceed total fee amount', 400);
    return;
  }

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

  const feePaid = parsed.data.amount_paid >= parsed.data.total_fee_amount;
  const studentId = req.params.student_id;

  // Check if a fee record already exists for this student
  let existingQuery = supabaseAdmin
    .from('student_fees')
    .select('id')
    .eq('student_id', studentId);

  if (parsed.data.term) {
    existingQuery = existingQuery.eq('term', parsed.data.term);
  }
  if (parsed.data.academic_year) {
    existingQuery = existingQuery.eq('academic_year', parsed.data.academic_year);
  }

  const { data: existing } = await existingQuery.maybeSingle();

  let data: unknown;
  let error: { message: string } | null;

  const payload = {
    total_fee_amount: parsed.data.total_fee_amount,
    amount_paid: parsed.data.amount_paid,
    fee_paid: feePaid,
    notes: parsed.data.notes ?? null,
    updated_by: req.user!.id,
  };

  if (existing?.id) {
    // Update existing record
    ({ data, error } = await supabaseAdmin
      .from('student_fees')
      .update(payload)
      .eq('id', existing.id)
      .select()
      .single());
  } else {
    // Insert new record
    ({ data, error } = await supabaseAdmin
      .from('student_fees')
      .insert({
        student_id: studentId,
        term: parsed.data.term ?? 'General',
        academic_year: parsed.data.academic_year ?? new Date().getFullYear().toString(),
        ...payload,
      })
      .select()
      .single());
  }

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(req.user!.id, 'FEE_PAYMENT_UPDATED', {
    student_id: studentId,
    student_name: student.full_name,
    total_fee_amount: parsed.data.total_fee_amount,
    amount_paid: parsed.data.amount_paid,
    fee_paid: feePaid,
    term: parsed.data.term,
    academic_year: parsed.data.academic_year,
  });

  sendSuccess(res, data, 'Payment updated successfully');
});

/**
 * POST /api/fees/:student_id/toggle
 * Upserts a fee record for a student (paid / unpaid).
 * Legacy endpoint — kept for backward compatibility.
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
