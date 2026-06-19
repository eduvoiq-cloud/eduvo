import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import rateLimit from 'express-rate-limit';

const router = Router();

// ── Rate limit: 100 req/min per IP ────────────────────────────────────────────
const teacherRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

router.use(teacherRateLimit);
router.use(authenticate);
router.use(requireRole('teacher'));

// ── Schemas ───────────────────────────────────────────────────────────────────

const createMarkSchema = z.object({
  student_id: z.string().uuid(),
  subject: z.string().min(1).max(100),
  test_name: z.string().min(1).max(200),
  exam_type: z.enum(['unit_test', 'mid_term', 'final', 'class_test', 'quiz', 'midterm', 'assignment', 'project']),
  term: z.enum(['term_1', 'term_2', 'term_3']),
  score: z.number().min(0),
  max_score: z.number().min(1),
});

const updateMarkSchema = createMarkSchema.partial();

const toggleFeeSchema = z.object({
  student_id: z.string().uuid(),
  fee_paid: z.boolean(),
});

const updatePaymentSchema = z.object({
  term: z.string().min(1).max(50),
  academic_year: z.string().min(1).max(20),
  total_fee_amount: z.number().min(0),
  amount_paid: z.number().min(0),
  notes: z.string().max(500).optional(),
});

const manualAttendanceSchema = z.object({
  attendances: z.array(z.object({
    student_id: z.string().uuid(),
    status: z.enum(['present', 'absent', 'late', 'excused']),
  })).min(1).max(200),
  class: z.string().min(1).max(20),
  section: z.string().min(1).max(10),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

const correctAttendanceSchema = z.object({
  attendance_id: z.string().uuid(),
  new_status: z.enum(['present', 'absent', 'late', 'excused']),
  reason: z.string().min(1).max(500),
});

const updateComplaintSchema = z.object({
  status: z.enum(['pending', 'reviewed', 'resolved']),
  resolution_note: z.string().max(2000).optional(),
});

// ── GET /api/teacher/subjects ─────────────────────────────────────────────────
/**
 * Returns all subjects for the teacher's school.
 * Optionally filtered to only subjects assigned to this teacher
 * (via teacher_assignments) when ?assigned=true is passed.
 */
router.get('/subjects', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'Your account is not linked to a school', 403);
    return;
  }

  const assignedOnly = req.query.assigned === 'true';

  if (assignedOnly) {
    // Fetch subject IDs from this teacher's assignments
    const { data: assignments, error: assignErr } = await supabaseAdmin
      .from('teacher_assignments')
      .select('subject_id')
      .eq('teacher_id', teacherId)
      .eq('school_id', schoolId)
      .not('subject_id', 'is', null);

    if (assignErr) {
      sendError(res, assignErr.message, 500);
      return;
    }

    const subjectIds = [...new Set(
      (assignments ?? [])
        .map((a: { subject_id: string | null }) => a.subject_id)
        .filter(Boolean) as string[]
    )];

    if (subjectIds.length === 0) {
      // No subject_ids on assignments — fall back to all school subjects
      const { data, error } = await supabaseAdmin
        .from('subjects')
        .select('id, name')
        .eq('school_id', schoolId)
        .order('name');
      if (error) { sendError(res, error.message, 500); return; }
      sendSuccess(res, data ?? []);
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('subjects')
      .select('id, name')
      .eq('school_id', schoolId)
      .in('id', subjectIds)
      .order('name');

    if (error) { sendError(res, error.message, 500); return; }
    sendSuccess(res, data ?? []);
    return;
  }

  // Default: all subjects for this school
  const { data, error } = await supabaseAdmin
    .from('subjects')
    .select('id, name')
    .eq('school_id', schoolId)
    .order('name');

  if (error) { sendError(res, error.message, 500); return; }
  sendSuccess(res, data ?? []);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Verify teacher is assigned to a given class+section (optionally subject).
 *  Normalises class name and section (trim + lowercase) before querying so
 *  "10" matches "10 " and "10A" matches "10a".
 *  Queries both `class_name` and `class` columns to handle DBs where either
 *  column may be populated (migration may or may not have been run).
 */
async function verifyAssignment(
  teacherId: string,
  schoolId: string,
  className: string,
  section: string,
  subject?: string
): Promise<boolean> {
  const cn = className.trim();
  const sec = section.trim();

  // Try class_name first (new column, used by all insert paths)
  let query = supabaseAdmin
    .from('teacher_assignments')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .ilike('class_name', cn)
    .ilike('section', sec);

  if (subject) query = query.ilike('subject', subject.trim());

  const { data: byClassName } = await query.limit(1);
  if ((byClassName ?? []).length > 0) return true;

  // Fallback: try legacy `class` column in case migration hasn't run
  let fallbackQuery = supabaseAdmin
    .from('teacher_assignments')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .ilike('class', cn)
    .ilike('section', sec);

  if (subject) fallbackQuery = fallbackQuery.ilike('subject', subject.trim());

  const { data: byClass } = await fallbackQuery.limit(1);
  return (byClass ?? []).length > 0;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/teacher/my-classes
 * Returns all class+section+subject assignments for the logged-in teacher.
 * Normalises the response so `class_name` is always present (the DB column
 * is named `class` but the frontend expects `class_name`).
 */
router.get('/my-classes', async (req: Request, res: Response) => {
  // Note: teacher_assignments does not have a created_at column — order by class_name instead
  const { data, error } = await supabaseAdmin
    .from('teacher_assignments')
    .select('*')
    .eq('teacher_id', req.user!.id)
    .eq('school_id', req.user!.school_id ?? '');

  if (error) { sendError(res, error.message, 500); return; }

  // Normalise: expose both `class` and `class_name` so any consumer works
  const normalised = (data ?? []).map((row: Record<string, unknown>) => ({
    ...row,
    class_name: (row.class_name ?? row.class) as string,
  }));

  // Sort by class_name client-side after normalisation
  normalised.sort((a, b) => String(a.class_name ?? '').localeCompare(String(b.class_name ?? '')));

  sendSuccess(res, normalised);
});

/**
 * GET /api/teacher/students?class=x&section=y
 * Returns non-deleted students for a class/section the teacher is assigned to.
 */
router.get('/students', async (req: Request, res: Response) => {
  const { class: className, section } = req.query as Record<string, string>;

  if (!className || !section) {
    sendError(res, 'class and section query params are required', 400);
    return;
  }

  // Verify teacher is assigned to this class
  const assigned = await verifyAssignment(
    req.user!.id,
    req.user!.school_id ?? '',
    className,
    section
  );
  if (!assigned) {
    sendError(res, 'You are not assigned to this class', 403);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, date_of_birth, phone_number, photo_url')
    .eq('school_id', req.user!.school_id ?? '')
    .ilike('class_name', className.trim())
    .ilike('section', section.trim())
    .neq('is_deleted', true)
    .order('full_name');

  if (error) { sendError(res, error.message, 500); return; }
  sendSuccess(res, data ?? []);
});

/**
 * POST /api/teacher/marks
 * Insert a mark. Verifies teacher is assigned to the subject+class.
 */
router.post('/marks', async (req: Request, res: Response) => {
  const parsed = createMarkSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { student_id, subject, score, max_score } = parsed.data;

  if (score > max_score) {
    sendError(res, 'Score cannot exceed max_score', 400);
    return;
  }

  // Fetch student to get class/section for assignment check
  const { data: student } = await supabaseAdmin
    .from('students')
    .select('id, class_name, section, school_id')
    .eq('id', student_id)
    .single();

  if (!student || student.school_id !== req.user!.school_id) {
    sendError(res, 'Student not found in your school', 404);
    return;
  }

  const assigned = await verifyAssignment(
    req.user!.id,
    req.user!.school_id ?? '',
    student.class_name,
    student.section,
    subject
  );
  if (!assigned) {
    sendError(res, 'You are not assigned to teach this subject for this class', 403);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('marks')
    .insert({ ...parsed.data, recorded_by: req.user!.id })
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(req.user!.id, 'marks_entered', {
    old_value: null,
    new_value: data,
  });

  sendSuccess(res, data, 'Mark recorded', 201);
});

/**
 * PUT /api/teacher/marks/:id
 * Update an existing mark. Logs old and new values.
 */
router.put('/marks/:id', async (req: Request, res: Response) => {
  const parsed = updateMarkSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  if (
    parsed.data.score !== undefined &&
    parsed.data.max_score !== undefined &&
    parsed.data.score > parsed.data.max_score
  ) {
    sendError(res, 'Score cannot exceed max_score', 400);
    return;
  }

  // Fetch existing mark for old_value audit
  const { data: existing } = await supabaseAdmin
    .from('marks')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (!existing) { sendError(res, 'Mark not found', 404); return; }

  const { data, error } = await supabaseAdmin
    .from('marks')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(req.user!.id, 'marks_updated', {
    mark_id: req.params.id,
    old_value: existing,
    new_value: data,
  });

  sendSuccess(res, data, 'Mark updated');
});

/**
 * POST /api/teacher/fee
 * Toggle fee paid/unpaid for a student.
 */
router.post('/fee', async (req: Request, res: Response) => {
  const parsed = toggleFeeSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { student_id, fee_paid } = parsed.data;

  // Verify student belongs to teacher's school
  const { data: student } = await supabaseAdmin
    .from('students')
    .select('id, full_name, school_id')
    .eq('id', student_id)
    .single();

  if (!student || student.school_id !== req.user!.school_id) {
    sendError(res, 'Student not found in your school', 404);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('student_fees')
    .upsert(
      { student_id, fee_paid, updated_by: req.user!.id, updated_at: new Date().toISOString() },
      { onConflict: 'student_id' }
    )
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(req.user!.id, 'fee_toggled', {
    student_id,
    student_name: student.full_name,
    fee_paid,
  });

  sendSuccess(res, data, `Fee marked as ${fee_paid ? 'paid' : 'unpaid'}`);
});

/**
 * PUT /api/teacher/fees/:student_id/payment
 * Upsert a fee record with total amount and amount paid.
 * Automatically derives fee_paid from the amounts.
 */
router.put('/fees/:student_id/payment', async (req: Request, res: Response) => {
  const parsed = updatePaymentSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  if (parsed.data.amount_paid > parsed.data.total_fee_amount) {
    sendError(res, 'Amount paid cannot exceed total fee amount', 400);
    return;
  }

  const { data: student } = await supabaseAdmin
    .from('students')
    .select('id, full_name, school_id')
    .eq('id', req.params.student_id)
    .single();

  if (!student || student.school_id !== req.user!.school_id) {
    sendError(res, 'Student not found in your school', 404);
    return;
  }

  const feePaid = parsed.data.amount_paid >= parsed.data.total_fee_amount;

  const { data, error } = await supabaseAdmin
    .from('student_fees')
    .upsert({
      student_id: req.params.student_id,
      term: parsed.data.term,
      academic_year: parsed.data.academic_year,
      total_fee_amount: parsed.data.total_fee_amount,
      amount_paid: parsed.data.amount_paid,
      fee_paid: feePaid,
      notes: parsed.data.notes ?? null,
      updated_by: req.user!.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'student_id,term,academic_year' })
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(req.user!.id, 'FEE_PAYMENT_UPDATED', {
    student_id: req.params.student_id,
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
 * GET /api/teacher/complaints
 * Returns all complaints from the teacher's school, newest first.
 */
router.get('/complaints', async (req: Request, res: Response) => {
  const { status } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('complaints')
    .select('*, users!submitted_by(name, email)')
    .eq('school_id', req.user!.school_id ?? '')
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) { sendError(res, error.message, 500); return; }
  sendSuccess(res, data ?? []);
});

/**
 * PUT /api/teacher/complaints/:id
 * Update complaint status. Logs the change.
 */
router.put('/complaints/:id', async (req: Request, res: Response) => {
  const parsed = updateComplaintSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

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

  await logAudit(req.user!.id, 'complaint_status_updated', {
    complaint_id: req.params.id,
    old_status: existing.status,
    new_status: parsed.data.status,
  });

  sendSuccess(res, data, 'Complaint status updated');
});

/**
 * POST /api/teacher/attendance/manual
 * Bulk manual attendance. Skips students already marked today.
 * Returns { saved: number, skipped: string[] }
 */
router.post('/attendance/manual', async (req: Request, res: Response) => {
  const parsed = manualAttendanceSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { attendances, class: className, section, date } = parsed.data;

  // Verify teacher is assigned to this class
  const assigned = await verifyAssignment(
    req.user!.id,
    req.user!.school_id ?? '',
    className,
    section
  );
  if (!assigned) {
    sendError(res, 'You are not assigned to this class', 403);
    return;
  }

  // Fetch already-marked attendance for this date
  const studentIds = attendances.map((a) => a.student_id);
  const { data: existing } = await supabaseAdmin
    .from('attendance')
    .select('student_id, status, source')
    .in('student_id', studentIds)
    .eq('date', date);

  const alreadyMarked = new Set((existing ?? []).map((e: { student_id: string }) => e.student_id));
  const skipped: string[] = [];
  const toInsert: { student_id: string; status: string; date: string; recorded_by: string; source: string }[] = [];

  for (const a of attendances) {
    if (alreadyMarked.has(a.student_id)) {
      skipped.push(a.student_id);
    } else {
      toInsert.push({
        student_id: a.student_id,
        status: a.status,
        date,
        recorded_by: req.user!.id,
        source: 'manual',
      });
    }
  }

  if (toInsert.length > 0) {
    const { error } = await supabaseAdmin.from('attendance').insert(toInsert);
    if (error) { sendError(res, error.message, 500); return; }
  }

  await logAudit(req.user!.id, 'attendance_manual_bulk', {
    class: className,
    section,
    date,
    saved: toInsert.length,
    skipped_count: skipped.length,
  });

  sendSuccess(res, { saved: toInsert.length, skipped });
});

/**
 * PUT /api/teacher/attendance/correct
 * Correct an existing attendance record.
 * Logs original_status, new_status, reason, corrected_by, corrected_at.
 * Sends a notification to the student's parent.
 */
router.put('/attendance/correct', async (req: Request, res: Response) => {
  const parsed = correctAttendanceSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { attendance_id, new_status, reason } = parsed.data;

  // Fetch existing record
  const { data: existing } = await supabaseAdmin
    .from('attendance')
    .select('id, student_id, date, status, source')
    .eq('id', attendance_id)
    .single();

  if (!existing) { sendError(res, 'Attendance record not found', 404); return; }

  // Verify the student belongs to teacher's school — always check school_id
  // regardless of role to prevent cross-school attendance manipulation.
  const { data: student } = await supabaseAdmin
    .from('students')
    .select('id, full_name, school_id, parent_id, class_name, section')
    .eq('id', existing.student_id)
    .eq('school_id', req.user!.school_id ?? '')
    .single();

  if (!student) {
    sendError(res, 'Access denied', 403);
    return;
  }

  const correctedAt = new Date().toISOString();

  // Update the attendance record
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('attendance')
    .update({ status: new_status, source: 'manual', recorded_by: req.user!.id })
    .eq('id', attendance_id)
    .select()
    .single();

  if (updateErr) { sendError(res, updateErr.message, 500); return; }

  // Audit log with full correction details
  await logAudit(req.user!.id, 'attendance_corrected', {
    attendance_id,
    student_id: existing.student_id,
    student_name: student.full_name,
    date: existing.date,
    original_status: existing.status,
    new_status,
    reason,
    corrected_by: req.user!.id,
    corrected_at: correctedAt,
  });

  // Notify parent if one is linked
  if (student.parent_id) {
    await supabaseAdmin.from('notifications').insert({
      title: 'Attendance Correction',
      body: `Your child ${student.full_name}'s attendance for ${existing.date} has been corrected to ${new_status}.`,
      type: 'attendance',
      recipient_id: student.parent_id,
      sender_id: req.user!.id,
      is_read: false,
      created_at: correctedAt,
    });
  }

  sendSuccess(res, updated, 'Attendance corrected');
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/teacher/test-analytics/:testId
 *
 * Returns detailed analytics for a specific test:
 *   - Overall stats: attempted_count, avg_score, highest_score, lowest_score
 *   - Score distribution in 5 buckets (0-20%, 21-40%, 41-60%, 61-80%, 81-100% of max_score)
 *   - Question analytics for MCQ questions: correct/wrong/skip counts + correct_pct
 *
 * Sorted by correct_pct asc so hardest questions appear first.
 */
router.get('/test-analytics/:testId', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;
  const { testId } = req.params;

  // 1. Fetch the test and verify it belongs to this school
  const { data: test, error: testErr } = await supabaseAdmin
    .from('tests')
    .select('id, title, subject, class_name, section, max_score, school_id')
    .eq('id', testId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (testErr) { sendError(res, testErr.message, 500); return; }
  if (!test) { sendError(res, 'Test not found', 404); return; }

  const testRow = test as {
    id: string;
    title: string;
    subject: string;
    class_name: string;
    section: string;
    max_score: number | null;
    school_id: string;
  };

  // 2. Count total students in the class/section
  const { count: totalStudents } = await supabaseAdmin
    .from('students')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', schoolId)
    .eq('class_name', testRow.class_name)
    .eq('section', testRow.section)
    .eq('is_deleted', false);

  // 3. Fetch all attempts for this test
  const { data: attempts, error: attErr } = await supabaseAdmin
    .from('test_attempts')
    .select('id, student_id, total_score, mcq_score')
    .eq('test_id', testId);

  if (attErr) { sendError(res, attErr.message, 500); return; }

  const attemptRows = (attempts ?? []) as Array<{
    id: string;
    student_id: string;
    total_score: number | null;
    mcq_score: number | null;
  }>;

  const attemptedCount = attemptRows.length;
  const notAttemptedCount = Math.max(0, (totalStudents ?? 0) - attemptedCount);

  // 4. Compute score stats
  const scores = attemptRows
    .map((a) => a.total_score ?? a.mcq_score ?? 0)
    .filter((s) => s !== null) as number[];

  const avgScore = scores.length > 0
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : 0;
  const highestScore = scores.length > 0 ? Math.max(...scores) : 0;
  const lowestScore = scores.length > 0 ? Math.min(...scores) : 0;

  // 5. Score distribution (as % of max_score)
  const maxScore = testRow.max_score ?? (scores.length > 0 ? Math.max(...scores) : 100);
  const buckets = [
    { range: '0-20', min: 0, max: 20, count: 0 },
    { range: '21-40', min: 21, max: 40, count: 0 },
    { range: '41-60', min: 41, max: 60, count: 0 },
    { range: '61-80', min: 61, max: 80, count: 0 },
    { range: '81-100', min: 81, max: 100, count: 0 },
  ];

  for (const score of scores) {
    const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
    for (const bucket of buckets) {
      if (pct >= bucket.min && pct <= bucket.max) {
        bucket.count++;
        break;
      }
    }
  }

  const scoreDistribution = buckets.map(({ range, count }) => ({ range, count }));

  // 6. Question analytics — MCQ only
  // Fetch questions for this test
  const { data: questions, error: qErr } = await supabaseAdmin
    .from('test_questions')
    .select('id, question_text, question_type, order_index')
    .eq('test_id', testId)
    .eq('question_type', 'mcq')
    .order('order_index');

  if (qErr) { sendError(res, qErr.message, 500); return; }

  const mcqQuestions = (questions ?? []) as Array<{
    id: string;
    question_text: string;
    question_type: string;
    order_index: number;
  }>;

  let questionAnalytics: Array<{
    question_id: string;
    question_text: string;
    order_index: number;
    correct_count: number;
    wrong_count: number;
    skip_count: number;
    correct_pct: number;
  }> = [];

  if (mcqQuestions.length > 0 && attemptRows.length > 0) {
    const attemptIds = attemptRows.map((a) => a.id);
    const CHUNK = 900;
    let allAnswers: Array<{
      attempt_id: string;
      question_id: string;
      is_correct: boolean | null;
      selected_option: string | null;
    }> = [];

    for (let i = 0; i < attemptIds.length; i += CHUNK) {
      const { data: answerChunk } = await supabaseAdmin
        .from('test_answers')
        .select('attempt_id, question_id, is_correct, selected_option')
        .in('attempt_id', attemptIds.slice(i, i + CHUNK))
        .in('question_id', mcqQuestions.map((q) => q.id));
      if (answerChunk) allAnswers = allAnswers.concat(answerChunk);
    }

    // Count per question
    const questionCountMap = new Map<string, { correct: number; wrong: number; skip: number }>();
    for (const q of mcqQuestions) {
      questionCountMap.set(q.id, { correct: 0, wrong: 0, skip: 0 });
    }

    for (const ans of allAnswers) {
      const counts = questionCountMap.get(ans.question_id);
      if (!counts) continue;
      if (!ans.selected_option) {
        counts.skip++;
      } else if (ans.is_correct) {
        counts.correct++;
      } else {
        counts.wrong++;
      }
    }

    // Build analytics rows
    questionAnalytics = mcqQuestions.map((q) => {
      const counts = questionCountMap.get(q.id) ?? { correct: 0, wrong: 0, skip: 0 };
      const total = counts.correct + counts.wrong + counts.skip;
      const correctPct = total > 0 ? Math.round((counts.correct / total) * 1000) / 10 : 0;
      return {
        question_id:   q.id,
        question_text: q.question_text,
        order_index:   q.order_index,
        correct_count: counts.correct,
        wrong_count:   counts.wrong,
        skip_count:    counts.skip,
        correct_pct:   correctPct,
      };
    });

    // Sort by correct_pct asc (hardest first)
    questionAnalytics.sort((a, b) => a.correct_pct - b.correct_pct);
  }

  sendSuccess(res, {
    test_id:              testRow.id,
    test_title:           testRow.title,
    subject:              testRow.subject,
    class_name:           testRow.class_name,
    section:              testRow.section,
    max_score:            maxScore,
    total_students:       totalStudents ?? 0,
    attempted_count:      attemptedCount,
    not_attempted_count:  notAttemptedCount,
    avg_score:            avgScore,
    highest_score:        highestScore,
    lowest_score:         lowestScore,
    score_distribution:   scoreDistribution,
    question_analytics:   questionAnalytics,
  });
});

export default router;
