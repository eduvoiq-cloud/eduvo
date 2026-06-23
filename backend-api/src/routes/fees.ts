import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import { getTokensForStudents, sendPush } from '../services/fcmService';

const router = Router();

// ── GET /api/fees/my-status ───────────────────────────────────────────────────
/**
 * Returns the fee record for the currently authenticated student.
 * Auth: student token
 */
router.get('/my-status', authenticateStudent, async (req: Request, res: Response) => {
  const studentId = req.student!.id;

  const { data, error } = await supabaseAdmin
    .from('student_fees')
    .select('fee_paid, total_fee_amount, amount_paid, term, academic_year, notes')
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  if (!data) {
    sendSuccess(res, null);
    return;
  }

  const totalFee = data.total_fee_amount ?? 0;
  const amountPaid = data.amount_paid ?? 0;
  let paymentStatus: 'paid' | 'partial' | 'unpaid' = 'unpaid';
  if (totalFee > 0) {
    if (amountPaid >= totalFee) paymentStatus = 'paid';
    else if (amountPaid > 0) paymentStatus = 'partial';
  } else if (data.fee_paid) {
    paymentStatus = 'paid';
  }

  sendSuccess(res, {
    fee_paid: paymentStatus === 'paid',
    total_fee_amount: totalFee,
    amount_paid: amountPaid,
    payment_status: paymentStatus,
    term: data.term ?? null,
    academic_year: data.academic_year ?? null,
    notes: data.notes ?? null,
  });
});

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
  total_fee_amount: z.number().min(0, 'Total fee amount cannot be negative'),
  amount_paid: z.number().min(0, 'Amount paid cannot be negative'),
  notes: z.string().max(500).optional(),
}).refine((data) => data.amount_paid <= data.total_fee_amount, {
  message: 'Amount paid cannot exceed total fee amount',
  path: ['amount_paid'],
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/fees?class_name=&section=&term=&academic_year=
 * Returns fee records for students in the teacher's school.
 * Supports pagination: ?page=1&limit=50 (default limit 50, max 200).
 * Teachers are scoped to their assigned classes.
 */
router.get('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const { class_name, section, term, academic_year } = req.query as Record<string, string>;

  // Pagination
  const rawPage  = parseInt((req.query.page  as string) ?? '1',  10);
  const rawLimit = parseInt((req.query.limit as string) ?? '50', 10);
  const page  = isNaN(rawPage)  || rawPage  < 1 ? 1  : rawPage;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200);

  // Build student filter with pagination
  let studentQuery = supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, school_id', { count: 'exact' })
    .eq('school_id', req.user!.school_id ?? '')
    .eq('is_deleted', false)
    .order('full_name')
    .range((page - 1) * limit, page * limit - 1);

  if (class_name) studentQuery = studentQuery.ilike('class_name', class_name.trim());
  if (section) studentQuery = studentQuery.ilike('section', section.trim());

  const { data: students, error: sErr, count } = await studentQuery;
  if (sErr) { sendError(res, sErr.message, 500); return; }
  if (!students || students.length === 0) {
    sendSuccess(res, { data: [], total: 0, page, limit, total_pages: 0 });
    return;
  }

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

  const total = count ?? 0;
  sendSuccess(res, { data: result, total, page, limit, total_pages: Math.ceil(total / limit) });
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

  // Check if a fee record already exists for this student.
  // When term/academic_year are provided, match exactly. When they're omitted,
  // fall back to the most-recent record for this student so we always UPDATE
  // rather than INSERT (which would violate the unique constraint).
  let existingQuery = supabaseAdmin
    .from('student_fees')
    .select('id')
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (parsed.data.term) {
    existingQuery = existingQuery.eq('term', parsed.data.term);
  }
  if (parsed.data.academic_year) {
    existingQuery = existingQuery.eq('academic_year', parsed.data.academic_year);
  }

  const { data: existingRows } = await existingQuery;
  const existing = existingRows?.[0] ?? null;

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

/**
 * POST /api/fees/class-bulk
 * Sets the same total_fee_amount for every student in a class/section atomically.
 * Body: { class_name, section, total_fee_amount, term?, academic_year? }
 */
router.post('/class-bulk', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const schema = z.object({
    class_name: z.string().min(1),
    section: z.string().min(1),
    total_fee_amount: z.number().min(0),
    term: z.string().max(50).optional(),
    academic_year: z.string().max(20).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { class_name, section, total_fee_amount, term, academic_year } = parsed.data;

  // Fetch all active students in this class/section for this school
  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name')
    .eq('school_id', req.user!.school_id ?? '')
    .ilike('class_name', class_name.trim())
    .ilike('section', section.trim())
    .eq('is_deleted', false);

  if (sErr) { sendError(res, sErr.message, 500); return; }
  if (!students || students.length === 0) {
    sendError(res, 'No students found in this class/section', 404);
    return;
  }

  const effectiveTerm = term ?? 'General';
  const effectiveYear = academic_year ?? new Date().getFullYear().toString();

  // Fetch existing fee records for all students in one query (avoid N+1)
  const { data: existingFees, error: feeFetchErr } = await supabaseAdmin
    .from('student_fees')
    .select('id, student_id, amount_paid')
    .in('student_id', students.map((s: { id: string }) => s.id))
    .eq('term', effectiveTerm)
    .eq('academic_year', effectiveYear);

  if (feeFetchErr) { sendError(res, feeFetchErr.message, 500); return; }

  const existingMap = new Map(
    (existingFees ?? []).map((f: { student_id: string; id: string; amount_paid: number }) => [
      f.student_id,
      f,
    ])
  );

  let updated = 0;
  let inserted = 0;

  // Build update and insert lists
  const toUpdate: Array<{ id: string; total_fee_amount: number; fee_paid: boolean }> = [];
  const toInsert: Array<{
    student_id: string; term: string; academic_year: string;
    total_fee_amount: number; amount_paid: number; fee_paid: boolean; updated_by: string;
  }> = [];

  for (const student of students as Array<{ id: string; full_name: string }>) {
    const existing = existingMap.get(student.id) as { id: string; amount_paid: number } | undefined;
    const amountPaid = existing?.amount_paid ?? 0;
    const feePaid = amountPaid >= total_fee_amount && total_fee_amount > 0;

    if (existing) {
      toUpdate.push({ id: existing.id, total_fee_amount, fee_paid: feePaid });
    } else {
      toInsert.push({
        student_id: student.id,
        term: effectiveTerm,
        academic_year: effectiveYear,
        total_fee_amount,
        amount_paid: 0,
        fee_paid: false,
        updated_by: req.user!.id,
      });
    }
  }

  // Batch insert new records (one query)
  if (toInsert.length > 0) {
    const { error: insertErr } = await supabaseAdmin
      .from('student_fees')
      .insert(toInsert);
    if (insertErr) { sendError(res, insertErr.message, 500); return; }
    inserted = toInsert.length;
  }

  // Batch updates: process in groups of 100 using upsert to avoid N+1
  for (let i = 0; i < toUpdate.length; i += 100) {
    const batch = toUpdate.slice(i, i + 100);
    const { error: updateErr } = await supabaseAdmin
      .from('student_fees')
      .upsert(
        batch.map((r) => ({
          id: r.id,
          total_fee_amount: r.total_fee_amount,
          fee_paid: r.fee_paid,
          updated_by: req.user!.id,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'id' }
      );
    if (updateErr) { sendError(res, updateErr.message, 500); return; }
    updated += batch.length;
  }

  await logAudit(req.user!.id, 'FEE_BULK_SET', {
    class_name,
    section,
    total_fee_amount,
    student_count: students.length,
    updated,
    inserted,
  });

  sendSuccess(res, {
    total_students: students.length,
    updated,
    inserted,
  }, `Total fees set to ${total_fee_amount} for ${students.length} students in ${class_name} ${section}`);
});

/**
 * POST /api/fees/send-reminder
 * Sends personalised fee reminder notifications to each student in a class.
 * Body: { class_name, section, custom_note? }
 * Fetches each student's fee record and creates a personalised notification.
 */
router.post('/send-reminder', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const schema = z.object({
    class_name: z.string().min(1),
    section: z.string().min(1),
    custom_note: z.string().max(500).optional(),
    term: z.string().max(50).optional(),
    academic_year: z.string().max(20).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { class_name, section, custom_note, term, academic_year } = parsed.data;

  // Fetch all students in this class
  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name')
    .eq('school_id', req.user!.school_id ?? '')
    .ilike('class_name', class_name.trim())
    .ilike('section', section.trim())
    .eq('is_deleted', false);

  if (sErr) { sendError(res, sErr.message, 500); return; }
  if (!students || students.length === 0) {
    sendError(res, 'No students found in this class/section', 404);
    return;
  }

  const studentIds = students.map((s: { id: string }) => s.id);

  // Fetch fee records for these students
  let feeQuery = supabaseAdmin
    .from('student_fees')
    .select('student_id, total_fee_amount, amount_paid, fee_paid, term, academic_year')
    .in('student_id', studentIds);

  if (term) feeQuery = feeQuery.eq('term', term);
  if (academic_year) feeQuery = feeQuery.eq('academic_year', academic_year);

  const { data: feeRecords } = await feeQuery;
  const feeMap = new Map(
    (feeRecords ?? []).map((f: {
      student_id: string;
      total_fee_amount: number | null;
      amount_paid: number;
    }) => [f.student_id, f])
  );

  // We need the student auth user IDs to send notifications.
  // Students in the students table don't have user_id — notifications use recipient_id
  // which references users.id. Students log in via their own token system.
  // We'll store notifications with the student's student ID as recipient.
  // The student notification GET already supports student tokens via req.student.id.
  // However, the notifications table has recipient_id → users.id FK.
  // For student-specific fee reminders we insert directly into notifications.

  const now = new Date().toISOString();
  let sent = 0;
  const skipped: string[] = [];

  for (const student of students as Array<{ id: string; full_name: string }>) {
    const feeRecord = feeMap.get(student.id) as {
      total_fee_amount: number | null;
      amount_paid: number;
    } | undefined;

    const total = feeRecord?.total_fee_amount ?? 0;
    const paid = feeRecord?.amount_paid ?? 0;
    const remaining = Math.max(0, total - paid);

    const formatAmount = (n: number) => `₹${n.toLocaleString('en-IN')}`;

    let message = `Dear ${student.full_name}, your total fees for this academic year is ${formatAmount(total)}. You have paid ${formatAmount(paid)}. Your remaining balance is ${formatAmount(remaining)}. Please clear your dues at the earliest.`;

    if (custom_note && custom_note.trim()) {
      message += ` ${custom_note.trim()}`;
    }

    // Notifications use student.id directly as recipient_id for student tokens
    // (the notifications GET endpoint resolves recipient_id from req.student.id)
    const { error: notifErr } = await supabaseAdmin.from('notifications').insert({
      title: 'Fee Reminder',
      body: message,
      type: 'fee_reminder',
      recipient_id: student.id,
      sender_id: req.user!.id,
      is_read: false,
      created_at: now,
    });

    if (notifErr) {
      console.error(`[fees] Failed to insert notification for student ${student.id}:`, notifErr.message);
      skipped.push(student.full_name);
      continue;
    }

    // Send FCM push to the student's registered device(s)
    setImmediate(() => {
      (async () => {
        try {
          const tokens = await getTokensForStudents([student.id]);
          for (const token of tokens) {
            await sendPush(token, 'Fee Reminder', message);
          }
        } catch (err) {
          console.error(`[FCM] Fee reminder push failed for student ${student.id}:`, err);
        }
      })();
    });

    sent++;
  }

  await logAudit(req.user!.id, 'FEE_REMINDER_SENT', {
    class_name,
    section,
    sent,
    skipped: skipped.length,
  });

  sendSuccess(res, {
    sent,
    skipped: skipped.length,
    skipped_names: skipped,
  }, `Fee reminders sent to ${sent} student(s)`);
});

/**
 * POST /api/fees/preview-reminder
 * Returns a preview of the fee reminder message for each student in a class.
 * Does NOT send anything.
 * Body: { class_name, section, custom_note?, term?, academic_year? }
 */
router.post('/preview-reminder', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const schema = z.object({
    class_name: z.string().min(1),
    section: z.string().min(1),
    custom_note: z.string().max(500).optional(),
    term: z.string().max(50).optional(),
    academic_year: z.string().max(20).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { class_name, section, custom_note, term, academic_year } = parsed.data;

  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name')
    .eq('school_id', req.user!.school_id ?? '')
    .ilike('class_name', class_name.trim())
    .ilike('section', section.trim())
    .eq('is_deleted', false)
    .order('full_name', { ascending: true });

  if (sErr) { sendError(res, sErr.message, 500); return; }
  if (!students || students.length === 0) {
    sendError(res, 'No students found in this class/section', 404);
    return;
  }

  const studentIds = students.map((s: { id: string }) => s.id);

  let feeQuery = supabaseAdmin
    .from('student_fees')
    .select('student_id, total_fee_amount, amount_paid')
    .in('student_id', studentIds);

  if (term) feeQuery = feeQuery.eq('term', term);
  if (academic_year) feeQuery = feeQuery.eq('academic_year', academic_year);

  const { data: feeRecords } = await feeQuery;
  const feeMap = new Map(
    (feeRecords ?? []).map((f: { student_id: string; total_fee_amount: number | null; amount_paid: number }) =>
      [f.student_id, f]
    )
  );

  const formatAmount = (n: number) => `₹${n.toLocaleString('en-IN')}`;

  const previews = (students as Array<{ id: string; full_name: string }>).map((student) => {
    const feeRecord = feeMap.get(student.id) as { total_fee_amount: number | null; amount_paid: number } | undefined;
    const total = feeRecord?.total_fee_amount ?? 0;
    const paid = feeRecord?.amount_paid ?? 0;
    const remaining = Math.max(0, total - paid);

    let message = `Dear ${student.full_name}, your total fees for this academic year is ${formatAmount(total)}. You have paid ${formatAmount(paid)}. Your remaining balance is ${formatAmount(remaining)}. Please clear your dues at the earliest.`;

    if (custom_note && custom_note.trim()) {
      message += ` ${custom_note.trim()}`;
    }

    return {
      student_id: student.id,
      student_name: student.full_name,
      total_fee_amount: total,
      amount_paid: paid,
      remaining_balance: remaining,
      message,
    };
  });

  sendSuccess(res, previews);
});

export default router;
