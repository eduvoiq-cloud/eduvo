import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import rateLimit from 'express-rate-limit';
import { sendSMS } from '../services/smsService';
import { sendPushMulticast, getTokensForUsers } from '../services/fcmService';

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

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER PREMIUM MANAGEMENT
// Teachers can activate/deactivate/renew premium for students in their assigned
// classes only. They cannot touch students outside their assigned class+sections.
// ─────────────────────────────────────────────────────────────────────────────

/** Derive plan type from class string. Junior = 1–6, Senior = 7–12. */
function derivePlanType(className: string): 'premium_junior' | 'premium_senior' {
  const num = parseInt(className.replace(/\D/g, ''), 10);
  return num >= 7 ? 'premium_senior' : 'premium_junior';
}

/**
 * Check that a student belongs to one of the teacher's assigned class+sections.
 * Returns the student row if allowed, null otherwise.
 */
async function getStudentIfTeacherOwns(
  teacherId: string,
  schoolId: string,
  studentId: string
): Promise<Record<string, unknown> | null> {
  // Fetch the student
  const { data: student } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, school_id, phone_number, parent_id')
    .eq('id', studentId)
    .eq('school_id', schoolId)
    .eq('is_deleted', false)
    .maybeSingle();

  if (!student) return null;

  const s = student as Record<string, unknown>;
  const className = (s.class_name as string) ?? '';
  const section   = (s.section   as string) ?? '';

  // Verify teacher is assigned to this class+section
  const assigned = await verifyAssignment(teacherId, schoolId, className, section);
  if (!assigned) return null;

  return s;
}

// ── GET /api/teacher/premium/students ─────────────────────────────────────────
/**
 * List all students in this teacher's assigned classes along with their
 * premium subscription status (days remaining, expires_at, etc.).
 */
router.get('/premium/students', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId  = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'Your account is not linked to a school', 403);
    return;
  }

  // Get all unique class+section pairs this teacher is assigned to
  const { data: assignments, error: assignErr } = await supabaseAdmin
    .from('teacher_assignments')
    .select('class_name, class, section')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId);

  if (assignErr) { sendError(res, assignErr.message, 500); return; }
  if (!assignments || assignments.length === 0) {
    sendSuccess(res, []);
    return;
  }

  // Deduplicate class+section pairs
  const classSectionPairs = [
    ...new Map(
      (assignments as Record<string, string>[]).map((a) => {
        const cn = (a.class_name || a.class || '').trim();
        const sec = (a.section || '').trim();
        return [`${cn}||${sec}`, { class_name: cn, section: sec }];
      })
    ).values(),
  ];

  // Fetch students for each class+section in parallel
  const studentArrays = await Promise.all(
    classSectionPairs.map(({ class_name, section }) =>
      supabaseAdmin
        .from('students')
        .select('id, full_name, class_name, section, phone_number, parent_id')
        .eq('school_id', schoolId)
        .ilike('class_name', class_name)
        .ilike('section', section)
        .neq('is_deleted', true)
        .order('full_name')
        .then(({ data }) => data ?? [])
    )
  );

  // Deduplicate students by id
  const studentMap = new Map<string, Record<string, unknown>>();
  for (const arr of studentArrays) {
    for (const s of arr as Record<string, unknown>[]) {
      studentMap.set(s.id as string, s);
    }
  }
  const students = Array.from(studentMap.values());

  if (students.length === 0) {
    sendSuccess(res, []);
    return;
  }

  // Fetch subscriptions for all these students
  const studentIds = students.map((s) => s.id as string);
  const { data: subs } = await supabaseAdmin
    .from('parent_subscriptions')
    .select('student_id, id, status, plan_type, activated_at, expires_at, activated_by_admin_id')
    .eq('school_id', schoolId)
    .in('student_id', studentIds);

  const subMap: Record<string, Record<string, unknown>> = {};
  for (const sub of (subs ?? []) as Record<string, unknown>[]) {
    subMap[sub.student_id as string] = sub;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = students.map((s) => {
    const sub = subMap[s.id as string] ?? null;
    let daysLeft: number | null = null;

    if (sub && sub.status === 'active' && sub.expires_at) {
      const expiry = new Date(sub.expires_at as string);
      expiry.setHours(0, 0, 0, 0);
      daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysLeft < 0) daysLeft = 0;
    }

    return {
      id:               s.id,
      full_name:        s.full_name,
      class_name:       s.class_name,
      section:          s.section,
      phone_number:     s.phone_number,
      parent_id:        s.parent_id,
      premium_status:   sub ? (sub.status as string) : 'none',
      subscription_id:  sub ? (sub.id as string) : null,
      activated_at:     sub ? (sub.activated_at as string | null) : null,
      expires_at:       sub ? (sub.expires_at as string | null) : null,
      days_left:        daysLeft,
      plan_type:        sub ? (sub.plan_type as string) : null,
      activated_by_admin_id: sub ? (sub.activated_by_admin_id as string | null) : null,
    };
  });

  sendSuccess(res, result);
});

// ── POST /api/teacher/premium/students/:studentId/activate ────────────────────
router.post('/premium/students/:studentId/activate', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId  = req.user!.school_id;
  const studentId = req.params.studentId as string;

  if (!schoolId) { sendError(res, 'Your account is not linked to a school', 403); return; }

  const student = await getStudentIfTeacherOwns(teacherId, schoolId, studentId);
  if (!student) {
    sendError(res, 'Student not found in your assigned classes', 404);
    return;
  }

  const planType = derivePlanType((student.class_name as string) ?? '1');
  const now  = new Date().toISOString();
  const today = now.slice(0, 10);
  const expiresDate = new Date(today);
  expiresDate.setMonth(expiresDate.getMonth() + 1);
  const expiresAt = expiresDate.toISOString().slice(0, 10);

  const { data: existingSub } = await supabaseAdmin
    .from('parent_subscriptions')
    .select('id, expires_at')
    .eq('student_id', studentId)
    .eq('school_id', schoolId)
    .maybeSingle();

  const { data: sub, error: upsertErr } = await supabaseAdmin
    .from('parent_subscriptions')
    .upsert(
      {
        student_id:            studentId,
        school_id:             schoolId,
        plan_type:             planType,
        status:                'active',
        starts_at:             today,
        expires_at:            expiresAt,
        activated_by_admin_id: teacherId,
        activated_at:          now,
        deactivated_at:        null,
        updated_at:            now,
      },
      { onConflict: 'student_id' }
    )
    .select()
    .single();

  if (upsertErr) { sendError(res, upsertErr.message, 500); return; }

  await supabaseAdmin.from('parent_subscription_events').insert({
    student_id:       studentId,
    school_id:        schoolId,
    action:           'activated',
    old_expires_at:   (existingSub as Record<string, unknown> | null)?.expires_at ?? null,
    new_expires_at:   expiresAt,
    done_by_admin_id: teacherId,
    created_at:       now,
  });

  await logAudit(teacherId, 'PREMIUM_ACTIVATED', 'parent_subscriptions', {
    student_id:   studentId,
    student_name: student.full_name,
    plan_type:    planType,
    school_id:    schoolId,
    expires_at:   expiresAt,
    activated_by: 'teacher',
  });

  sendSuccess(res, sub, 'Premium activated successfully');
});

// ── POST /api/teacher/premium/students/:studentId/deactivate ──────────────────
router.post('/premium/students/:studentId/deactivate', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId  = req.user!.school_id;
  const studentId = req.params.studentId as string;

  if (!schoolId) { sendError(res, 'Your account is not linked to a school', 403); return; }

  const student = await getStudentIfTeacherOwns(teacherId, schoolId, studentId);
  if (!student) {
    sendError(res, 'Student not found in your assigned classes', 404);
    return;
  }

  const { data: sub, error: fetchErr } = await supabaseAdmin
    .from('parent_subscriptions')
    .select('id, status, expires_at')
    .eq('student_id', studentId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (fetchErr || !sub) {
    sendError(res, 'No subscription found for this student', 404);
    return;
  }

  if ((sub as Record<string, unknown>).status === 'inactive') {
    sendError(res, 'Subscription is already inactive', 400);
    return;
  }

  const now = new Date().toISOString();
  const oldExpiresAt = (sub as Record<string, unknown>).expires_at as string | null;

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('parent_subscriptions')
    .update({ status: 'inactive', deactivated_at: now, updated_at: now })
    .eq('student_id', studentId)
    .eq('school_id', schoolId)
    .select()
    .single();

  if (updateErr) { sendError(res, updateErr.message, 500); return; }

  await supabaseAdmin.from('parent_subscription_events').insert({
    student_id:       studentId,
    school_id:        schoolId,
    action:           'deactivated',
    old_expires_at:   oldExpiresAt,
    new_expires_at:   null,
    done_by_admin_id: teacherId,
    created_at:       now,
  });

  await logAudit(teacherId, 'PREMIUM_DEACTIVATED', 'parent_subscriptions', {
    student_id:   studentId,
    school_id:    schoolId,
    deactivated_by: 'teacher',
  });

  sendSuccess(res, updated, 'Premium deactivated');
});

// ── POST /api/teacher/premium/students/:studentId/renew ───────────────────────
router.post('/premium/students/:studentId/renew', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId  = req.user!.school_id;
  const studentId = req.params.studentId as string;

  if (!schoolId) { sendError(res, 'Your account is not linked to a school', 403); return; }

  const student = await getStudentIfTeacherOwns(teacherId, schoolId, studentId);
  if (!student) {
    sendError(res, 'Student not found in your assigned classes', 404);
    return;
  }

  const { data: sub, error: fetchErr } = await supabaseAdmin
    .from('parent_subscriptions')
    .select('id, status, expires_at')
    .eq('student_id', studentId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (fetchErr || !sub) {
    sendError(res, 'No subscription found for this student. Activate first.', 404);
    return;
  }

  const now         = new Date().toISOString();
  const today       = now.slice(0, 10);
  const oldExpiresAt = (sub as Record<string, unknown>).expires_at as string | null;
  const currentStatus = (sub as Record<string, unknown>).status as string;

  const baseDate =
    currentStatus === 'active' && oldExpiresAt !== null && oldExpiresAt >= today
      ? oldExpiresAt
      : today;

  const expiresDate = new Date(baseDate);
  expiresDate.setMonth(expiresDate.getMonth() + 1);
  const newExpiresAt = expiresDate.toISOString().slice(0, 10);

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('parent_subscriptions')
    .update({
      status:               'active',
      expires_at:           newExpiresAt,
      last_renewed_at:      now,
      renewed_by_admin_id:  teacherId,
      updated_at:           now,
    })
    .eq('student_id', studentId)
    .eq('school_id', schoolId)
    .select()
    .single();

  if (updateErr) { sendError(res, updateErr.message, 500); return; }

  await supabaseAdmin.from('parent_subscription_events').insert({
    student_id:       studentId,
    school_id:        schoolId,
    action:           'renewed',
    old_expires_at:   oldExpiresAt,
    new_expires_at:   newExpiresAt,
    done_by_admin_id: teacherId,
    created_at:       now,
  });

  await logAudit(teacherId, 'PREMIUM_RENEWED', 'parent_subscriptions', {
    student_id:    studentId,
    school_id:     schoolId,
    old_expires_at: oldExpiresAt,
    new_expires_at: newExpiresAt,
    renewed_by:    'teacher',
  });

  sendSuccess(res, updated, 'Premium renewed successfully');
});

// ── POST /api/teacher/premium/notify-renewal ─────────────────────────────────
/**
 * Send renewal reminder (FCM push + SMS) to parents of students whose
 * subscriptions expire within the next `days_threshold` days (default 5).
 * Can also send to a specific list of student IDs.
 *
 * Body: { student_ids?: string[], days_threshold?: number }
 */
router.post('/premium/notify-renewal', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId  = req.user!.school_id;

  if (!schoolId) { sendError(res, 'Your account is not linked to a school', 403); return; }

  const schema = z.object({
    student_ids:     z.array(z.string().uuid()).optional(),
    days_threshold:  z.number().int().min(1).max(30).optional().default(5),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { student_ids, days_threshold } = parsed.data;

  // Get teacher's assigned class+section pairs
  const { data: assignments } = await supabaseAdmin
    .from('teacher_assignments')
    .select('class_name, class, section')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId);

  if (!assignments || assignments.length === 0) {
    sendError(res, 'No classes assigned to you', 403);
    return;
  }

  const classSectionPairs = [
    ...new Map(
      (assignments as Record<string, string>[]).map((a) => {
        const cn  = (a.class_name || a.class || '').trim();
        const sec = (a.section || '').trim();
        return [`${cn}||${sec}`, { class_name: cn, section: sec }];
      })
    ).values(),
  ];

  // Fetch students in teacher's classes
  const studentArrays = await Promise.all(
    classSectionPairs.map(({ class_name, section }) =>
      supabaseAdmin
        .from('students')
        .select('id, full_name, class_name, section, phone_number, parent_id')
        .eq('school_id', schoolId)
        .ilike('class_name', class_name)
        .ilike('section', section)
        .neq('is_deleted', true)
        .then(({ data }) => data ?? [])
    )
  );

  const studentMap = new Map<string, Record<string, unknown>>();
  for (const arr of studentArrays) {
    for (const s of arr as Record<string, unknown>[]) {
      studentMap.set(s.id as string, s);
    }
  }

  // Filter to specific students if provided, otherwise all in teacher's classes
  let targetStudents = Array.from(studentMap.values());
  if (student_ids && student_ids.length > 0) {
    targetStudents = targetStudents.filter((s) => student_ids.includes(s.id as string));
  }

  if (targetStudents.length === 0) {
    sendError(res, 'No matching students found in your classes', 400);
    return;
  }

  const targetIds = targetStudents.map((s) => s.id as string);

  // Fetch subscriptions expiring within threshold (or all active if specific student_ids given)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thresholdDate = new Date(today);
  thresholdDate.setDate(thresholdDate.getDate() + (days_threshold ?? 5));
  const thresholdStr = thresholdDate.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);

  let subsQuery = supabaseAdmin
    .from('parent_subscriptions')
    .select('student_id, expires_at, status')
    .eq('school_id', schoolId)
    .eq('status', 'active')
    .in('student_id', targetIds);

  // If not given specific IDs, filter to expiring soon
  if (!student_ids || student_ids.length === 0) {
    subsQuery = subsQuery
      .gte('expires_at', todayStr)
      .lte('expires_at', thresholdStr);
  }

  const { data: subs } = await subsQuery;
  const expiringStudentIds = new Set(
    (subs ?? []).map((s: Record<string, unknown>) => s.student_id as string)
  );

  const studentsToNotify = targetStudents.filter((s) =>
    expiringStudentIds.has(s.id as string)
  );

  if (studentsToNotify.length === 0) {
    sendSuccess(res, { notified: 0, sms_sent: 0, push_sent: 0 },
      student_ids
        ? 'These students do not have an active subscription to notify about'
        : `No active subscriptions expiring within ${days_threshold} days`
    );
    return;
  }

  // Fetch school name for SMS message
  const { data: school } = await supabaseAdmin
    .from('schools')
    .select('name')
    .eq('id', schoolId)
    .maybeSingle();
  const schoolName = (school as Record<string, unknown> | null)?.name as string ?? 'your school';

  let smsCount = 0;
  let pushTokens: string[] = [];
  const parentIds: string[] = [];

  for (const s of studentsToNotify) {
    const sub = (subs ?? []).find(
      (sb: Record<string, unknown>) => sb.student_id === s.id
    ) as Record<string, unknown> | undefined;

    const expiresAt = sub?.expires_at as string | null;
    const daysLeft  = expiresAt
      ? Math.ceil(
          (new Date(expiresAt).setHours(0, 0, 0, 0) - today.getTime()) / (1000 * 60 * 60 * 24)
        )
      : null;

    const daysMsg = daysLeft !== null && daysLeft >= 0
      ? `expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`
      : 'has expired';

    // SMS
    const phone = s.phone_number as string | null;
    if (phone && /^\d{10}$/.test(phone)) {
      const msg = `${schoolName}: Dear Parent, your child ${s.full_name}'s Eduvo premium subscription ${daysMsg}. Please renew it to continue accessing premium features. Contact your school for renewal.`;
      const ok  = await sendSMS(phone, msg);
      if (ok) smsCount++;
    }

    // FCM — collect parent IDs
    if (s.parent_id) parentIds.push(s.parent_id as string);
  }

  // Push notifications to all collected parent IDs
  if (parentIds.length > 0) {
    const tokens = await getTokensForUsers(parentIds);
    if (tokens.length > 0) {
      const { successCount } = await sendPushMulticast(
        tokens,
        '⚠️ Premium Subscription Expiring Soon',
        `Your child's Eduvo premium subscription is expiring soon. Please contact ${schoolName} to renew.`,
        { type: 'premium_expiry_reminder', school_name: schoolName }
      );
      pushTokens = tokens;
      void pushTokens; // used for count only
      smsCount = smsCount; // already counted
      void successCount;
    }
  }

  await logAudit(teacherId, 'PREMIUM_RENEWAL_NOTIFICATION_SENT', 'parent_subscriptions', {
    school_id:         schoolId,
    students_notified: studentsToNotify.map((s) => s.id),
    sms_sent:          smsCount,
    push_tokens_count: pushTokens.length,
  });

  sendSuccess(
    res,
    {
      notified:   studentsToNotify.length,
      sms_sent:   smsCount,
      push_sent:  pushTokens.length,
    },
    `Renewal reminder sent to ${studentsToNotify.length} parent(s)`
  );
});

export default router;
