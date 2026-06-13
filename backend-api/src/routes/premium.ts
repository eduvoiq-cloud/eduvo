/**
 * /api/premium — Parent Premium system
 *
 * B2B2C model: school admin activates/deactivates/renews premium per student.
 * No payment gateway. Routes are grouped by actor:
 *
 *   Admin endpoints  (schooladmin / superadmin)
 *     POST   /api/premium/subscriptions/:studentId/activate
 *     POST   /api/premium/subscriptions/:studentId/deactivate
 *     POST   /api/premium/subscriptions/:studentId/renew
 *     GET    /api/premium/subscriptions          — list all for school
 *     GET    /api/premium/revenue                — revenue share ledger
 *     GET    /api/premium/teacher-access         — list teacher flags
 *     POST   /api/premium/teacher-access         — grant/update teacher flags
 *
 *   Student / parent endpoints
 *     GET    /api/premium/my-subscription        — active subscription for calling student
 *
 *   Superadmin only
 *     GET    /api/premium/revenue/all            — all schools
 *     GET    /api/premium/schools/summary        — schools with live premium counts
 *     POST   /api/premium/revenue/calculate      — recalculate a month's ledger
 *     PATCH  /api/premium/revenue/:id/status     — update payout_status
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive plan type from class string. junior = 1-6, senior = 7-12. */
function derivePlanType(className: string): 'premium_junior' | 'premium_senior' {
  const num = parseInt(className.replace(/\D/g, ''), 10);
  return num >= 7 ? 'premium_senior' : 'premium_junior';
}

// ── Admin: activate premium for a student ─────────────────────────────────────
// POST /api/premium/subscriptions/:studentId/activate
router.post(
  '/subscriptions/:studentId/activate',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const { studentId } = req.params;
    const adminId = req.user!.id;
    const schoolId = req.user!.school_id!;

    // Verify student belongs to this school
    const { data: student, error: studentErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, class_name, class, school_id')
      .eq('id', studentId)
      .eq('school_id', schoolId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (studentErr || !student) {
      sendError(res, 'Student not found in your school', 404);
      return;
    }

    const className = (student as Record<string, unknown>).class_name as string
      ?? (student as Record<string, unknown>).class as string
      ?? '1';
    const planType = derivePlanType(className);
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    // expires_at = today + 1 month
    const expiresDate = new Date(today);
    expiresDate.setMonth(expiresDate.getMonth() + 1);
    const expiresAt = expiresDate.toISOString().slice(0, 10);

    // Fetch old expires_at for event log
    const { data: existingSub } = await supabaseAdmin
      .from('parent_subscriptions')
      .select('id, expires_at')
      .eq('student_id', studentId)
      .eq('school_id', schoolId)
      .maybeSingle();

    // Upsert — if row exists update it, else insert
    const { data: sub, error: upsertErr } = await supabaseAdmin
      .from('parent_subscriptions')
      .upsert(
        {
          student_id: studentId,
          school_id: schoolId,
          plan_type: planType,
          status: 'active',
          starts_at: today,
          expires_at: expiresAt,
          activated_by_admin_id: adminId,
          activated_at: now,
          deactivated_at: null,
          updated_at: now,
        },
        { onConflict: 'student_id' }
      )
      .select()
      .single();

    if (upsertErr) {
      sendError(res, upsertErr.message, 500);
      return;
    }

    // Insert subscription event
    await supabaseAdmin.from('parent_subscription_events').insert({
      student_id: studentId,
      school_id: schoolId,
      action: 'activated',
      old_expires_at: (existingSub as Record<string, unknown> | null)?.expires_at ?? null,
      new_expires_at: expiresAt,
      done_by_admin_id: adminId,
      created_at: now,
    });

    await logAudit(adminId, 'PREMIUM_ACTIVATED', 'parent_subscriptions', {
      student_id: studentId,
      student_name: (student as Record<string, unknown>).full_name,
      plan_type: planType,
      school_id: schoolId,
      expires_at: expiresAt,
    });

    sendSuccess(res, sub, 'Premium activated successfully');
  }
);

// ── Admin: deactivate premium for a student ───────────────────────────────────
// POST /api/premium/subscriptions/:studentId/deactivate
router.post(
  '/subscriptions/:studentId/deactivate',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const { studentId } = req.params;
    const adminId = req.user!.id;
    const schoolId = req.user!.school_id!;

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

    if (updateErr) {
      sendError(res, updateErr.message, 500);
      return;
    }

    // Insert subscription event
    await supabaseAdmin.from('parent_subscription_events').insert({
      student_id: studentId,
      school_id: schoolId,
      action: 'deactivated',
      old_expires_at: oldExpiresAt,
      new_expires_at: null,
      done_by_admin_id: adminId,
      created_at: now,
    });

    await logAudit(adminId, 'PREMIUM_DEACTIVATED', 'parent_subscriptions', {
      student_id: studentId,
      school_id: schoolId,
    });

    sendSuccess(res, updated, 'Premium deactivated');
  }
);

// ── Admin: renew premium for a student ───────────────────────────────────────
// POST /api/premium/subscriptions/:studentId/renew
router.post(
  '/subscriptions/:studentId/renew',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const { studentId } = req.params;
    const adminId = req.user!.id;
    const schoolId = req.user!.school_id!;

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

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const oldExpiresAt = (sub as Record<string, unknown>).expires_at as string | null;
    const currentStatus = (sub as Record<string, unknown>).status as string;

    // Determine new_expires_at:
    // If active AND expires_at >= today → extend from expires_at
    // Otherwise → extend from today
    let baseDate: string;
    if (
      currentStatus === 'active' &&
      oldExpiresAt !== null &&
      oldExpiresAt >= today
    ) {
      baseDate = oldExpiresAt;
    } else {
      baseDate = today;
    }

    const expiresDate = new Date(baseDate);
    expiresDate.setMonth(expiresDate.getMonth() + 1);
    const newExpiresAt = expiresDate.toISOString().slice(0, 10);

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('parent_subscriptions')
      .update({
        status: 'active',
        expires_at: newExpiresAt,
        last_renewed_at: now,
        renewed_by_admin_id: adminId,
        updated_at: now,
      })
      .eq('student_id', studentId)
      .eq('school_id', schoolId)
      .select()
      .single();

    if (updateErr) {
      sendError(res, updateErr.message, 500);
      return;
    }

    // Insert subscription event
    await supabaseAdmin.from('parent_subscription_events').insert({
      student_id: studentId,
      school_id: schoolId,
      action: 'renewed',
      old_expires_at: oldExpiresAt,
      new_expires_at: newExpiresAt,
      done_by_admin_id: adminId,
      created_at: now,
    });

    await logAudit(adminId, 'PREMIUM_RENEWED', 'parent_subscriptions', {
      student_id: studentId,
      school_id: schoolId,
      old_expires_at: oldExpiresAt,
      new_expires_at: newExpiresAt,
    });

    sendSuccess(res, updated, 'Premium renewed successfully');
  }
);

// ── Admin: student activation summary (read-only overview) ───────────────────
// GET /api/premium/student-summary
// Returns all students with their activation status (for admin read-only view).
router.get(
  '/student-summary',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;

    // Fetch all non-deleted students
    const { data: students, error: studErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, class_name, section')
      .eq('school_id', schoolId)
      .eq('is_deleted', false)
      .order('class_name')
      .order('full_name');

    if (studErr) { sendError(res, studErr.message, 500); return; }

    const allStudents = (students ?? []) as Record<string, unknown>[];
    if (allStudents.length === 0) {
      sendSuccess(res, { total: 0, activated: 0, not_activated: 0, students: [] });
      return;
    }

    // Fetch active subscriptions for this school
    const studentIds = allStudents.map((s) => s.id as string);
    const { data: subs } = await supabaseAdmin
      .from('parent_subscriptions')
      .select('student_id, status, expires_at, activated_at')
      .eq('school_id', schoolId)
      .in('student_id', studentIds);

    const subMap: Record<string, Record<string, unknown>> = {};
    for (const sub of (subs ?? []) as Record<string, unknown>[]) {
      subMap[sub.student_id as string] = sub;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = allStudents.map((s) => {
      const sub = subMap[s.id as string] ?? null;
      const isActive = sub && sub.status === 'active';
      let daysLeft: number | null = null;
      if (isActive && sub.expires_at) {
        const expiry = new Date(sub.expires_at as string);
        expiry.setHours(0, 0, 0, 0);
        daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (daysLeft < 0) daysLeft = 0;
      }
      return {
        id:           s.id,
        full_name:    s.full_name,
        class_name:   s.class_name,
        section:      s.section,
        is_activated: !!isActive,
        activated_at: sub?.activated_at ?? null,
        expires_at:   sub?.expires_at ?? null,
        days_left:    daysLeft,
      };
    });

    const activated     = result.filter((r) => r.is_activated).length;
    const not_activated = result.length - activated;

    sendSuccess(res, {
      total:         result.length,
      activated,
      not_activated,
      students:      result,
    });
  }
);

// ── Admin: list all subscriptions for school ──────────────────────────────────
// GET /api/premium/subscriptions?status=active&class_name=5&page=1&limit=50
// Superadmin can pass school_id query param to view any school.
router.get(
  '/subscriptions',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    // Superadmin may pass ?school_id=<uuid> to inspect any school
    const isSuperadmin = req.user!.role === 'superadmin';
    const querySchoolId = req.query.school_id as string | undefined;
    const schoolId = (isSuperadmin && querySchoolId) ? querySchoolId : req.user!.school_id!;

    if (!schoolId) {
      sendError(res, 'school_id is required', 400);
      return;
    }

    const status = req.query.status as string | undefined;
    const className = req.query.class_name as string | undefined;

    const rawPage = parseInt((req.query.page as string) ?? '1', 10);
    const rawLimit = parseInt((req.query.limit as string) ?? '50', 10);
    const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200);
    const from = (page - 1) * limit;

    let query = supabaseAdmin
      .from('parent_subscriptions')
      .select(
        `id, student_id, plan_type, status, activated_at, deactivated_at, created_at,
         students ( id, full_name, class_name, section )`,
        { count: 'exact' }
      )
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    // Filter by class_name if provided (after join)
    let rows = (data ?? []) as Record<string, unknown>[];
    if (className) {
      rows = rows.filter((r) => {
        const s = r.students as Record<string, unknown> | null;
        return s?.class_name === className;
      });
    }

    sendSuccess(res, {
      data: rows,
      total: count ?? 0,
      page,
      limit,
      total_pages: Math.ceil((count ?? 0) / limit),
    });
  }
);

// ── Student / parent: get own subscription ────────────────────────────────────
// GET /api/premium/my-subscription   (student token)
router.get(
  '/my-subscription',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;
    const schoolId = req.student!.school_id;

    const { data, error } = await supabaseAdmin
      .from('parent_subscriptions')
      .select('id, plan_type, status, activated_at, deactivated_at, created_at')
      .eq('student_id', studentId)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (error) { sendError(res, error.message, 500); return; }
    if (!data) { sendSuccess(res, null); return; }

    sendSuccess(res, data);
  }
);

// ── Admin: grant / update teacher premium access ──────────────────────────────
// POST /api/premium/teacher-access
router.post(
  '/teacher-access',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      teacher_id: z.string().uuid(),
      can_create_daily_tests: z.boolean().default(false),
      can_create_activity_packs: z.boolean().default(false),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const { teacher_id, can_create_daily_tests, can_create_activity_packs } = parsed.data;
    const adminId = req.user!.id;
    const schoolId = req.user!.school_id!;

    // Verify teacher belongs to this school
    const { data: teacher } = await supabaseAdmin
      .from('users')
      .select('id, name')
      .eq('id', teacher_id)
      .eq('school_id', schoolId)
      .eq('role', 'teacher')
      .maybeSingle();

    if (!teacher) {
      sendError(res, 'Teacher not found in your school', 404);
      return;
    }

    const { data: access, error: upsertErr } = await supabaseAdmin
      .from('teacher_premium_access')
      .upsert(
        {
          teacher_id,
          school_id: schoolId,
          can_create_daily_tests,
          can_create_activity_packs,
          granted_by: adminId,
          granted_at: new Date().toISOString(),
        },
        { onConflict: 'teacher_id,school_id' }
      )
      .select()
      .single();

    if (upsertErr) { sendError(res, upsertErr.message, 500); return; }

    await logAudit(adminId, 'TEACHER_PREMIUM_ACCESS_UPDATED', 'teacher_premium_access', {
      teacher_id,
      teacher_name: (teacher as Record<string, unknown>).name,
      can_create_daily_tests,
      can_create_activity_packs,
      school_id: schoolId,
    });

    sendSuccess(res, access, 'Teacher premium access updated');
  }
);

// ── Admin: list teacher premium access for school ─────────────────────────────
// GET /api/premium/teacher-access
router.get(
  '/teacher-access',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;

    const { data, error } = await supabaseAdmin
      .from('teacher_premium_access')
      .select(
        `id, teacher_id, can_create_daily_tests, can_create_activity_packs, granted_at,
         users ( id, name, email )`
      )
      .eq('school_id', schoolId)
      .order('granted_at', { ascending: false });

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// ── Admin: revenue share ledger for own school ────────────────────────────────
// GET /api/premium/revenue?year=2025
router.get(
  '/revenue',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;
    const year = req.query.year as string | undefined;

    let query = supabaseAdmin
      .from('revenue_shares')
      .select('*')
      .eq('school_id', schoolId)
      .order('month', { ascending: false });

    if (year) {
      query = query
        .gte('month', `${year}-01-01`)
        .lte('month', `${year}-12-31`);
    }

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// ── Superadmin: all schools revenue ──────────────────────────────────────────
// GET /api/premium/revenue/all
router.get(
  '/revenue/all',
  authenticate,
  requireRole('superadmin'),
  async (req: Request, res: Response) => {
    const year = req.query.year as string | undefined;
    const status = req.query.status as string | undefined;

    let query = supabaseAdmin
      .from('revenue_shares')
      .select(`*, schools ( id, name )`)
      .order('month', { ascending: false });

    if (year) {
      query = query
        .gte('month', `${year}-01-01`)
        .lte('month', `${year}-12-31`);
    }
    if (status) query = query.eq('payout_status', status);

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// ── Superadmin: calculate / upsert a month's revenue row ─────────────────────
// POST /api/premium/revenue/calculate
// Body: { school_id?, month: 'YYYY-MM-DD', rate_per_student? }
// Counts active subscriptions on the first day of the month and upserts row.
router.post(
  '/revenue/calculate',
  authenticate,
  requireRole('superadmin'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      school_id: z.string().uuid().optional(),
      month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'month must be YYYY-MM-DD (first of month)'),
      rate_per_student: z.number().positive().optional().default(75),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const { school_id, month, rate_per_student } = parsed.data;

    // Get all schools or a single one
    let schoolIds: string[];
    if (school_id) {
      schoolIds = [school_id];
    } else {
      const { data: schools, error: schoolsErr } = await supabaseAdmin
        .from('schools')
        .select('id');
      if (schoolsErr) { sendError(res, schoolsErr.message, 500); return; }
      schoolIds = (schools ?? []).map((s: { id: string }) => s.id);
    }

    const results: Record<string, unknown>[] = [];

    const today = new Date().toISOString().slice(0, 10);

    for (const sid of schoolIds) {
      // Only count subscriptions that are active AND not yet expired
      const { count } = await supabaseAdmin
        .from('parent_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', sid)
        .eq('status', 'active')
        .gte('expires_at', today);

      // Count expired-but-not-deactivated students (informational only, not billed)
      const { count: expiredCount } = await supabaseAdmin
        .from('parent_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', sid)
        .eq('status', 'active')
        .lt('expires_at', today);

      const activeCount = count ?? 0;
      const expiredNotDeactivated = expiredCount ?? 0;
      const amountOwed = activeCount * rate_per_student;
      const now = new Date().toISOString();

      const { data: row, error: upsertErr } = await supabaseAdmin
        .from('revenue_shares')
        .upsert(
          {
            school_id: sid,
            month,
            total_active_premium_count: activeCount,
            expired_not_deactivated_count: expiredNotDeactivated,
            rate_per_student,
            amount_owed: amountOwed,
            payout_status: 'pending',
            created_at: now,
          },
          { onConflict: 'school_id,month' }
        )
        .select()
        .single();

      if (!upsertErr && row) results.push(row as Record<string, unknown>);
    }

    sendSuccess(res, results, `Revenue calculated for ${results.length} school(s)`);
  }
);

// ── Superadmin: school-level premium summary ──────────────────────────────────
// GET /api/premium/schools/summary
// Returns every school with live active/junior/senior counts + current rate.
router.get(
  '/schools/summary',
  authenticate,
  requireRole('superadmin'),
  async (req: Request, res: Response) => {
    // Fetch all schools
    const { data: schools, error: schoolsErr } = await supabaseAdmin
      .from('schools')
      .select('id, name, subscription_status')
      .order('name');

    if (schoolsErr) { sendError(res, schoolsErr.message, 500); return; }
    if (!schools || schools.length === 0) { sendSuccess(res, []); return; }

    const schoolIds = schools.map((s: { id: string }) => s.id);
    const today = new Date().toISOString().slice(0, 10);

    // Fetch active subscriptions that are NOT expired (billable)
    const { data: subs, error: subsErr } = await supabaseAdmin
      .from('parent_subscriptions')
      .select('school_id, plan_type, status')
      .in('school_id', schoolIds)
      .eq('status', 'active')
      .gte('expires_at', today);

    if (subsErr) { sendError(res, subsErr.message, 500); return; }

    // Fetch expired-but-not-deactivated counts (informational badge)
    const { data: expiredSubs } = await supabaseAdmin
      .from('parent_subscriptions')
      .select('school_id')
      .in('school_id', schoolIds)
      .eq('status', 'active')
      .lt('expires_at', today);

    // Fetch total student counts per school
    const { data: students } = await supabaseAdmin
      .from('students')
      .select('school_id')
      .in('school_id', schoolIds)
      .eq('is_deleted', false);

    // Fetch latest revenue_share rows for each school (current month)
    const currentMonth = new Date().toISOString().slice(0, 7) + '-01';
    const { data: revenueRows } = await supabaseAdmin
      .from('revenue_shares')
      .select('school_id, rate_per_student, payout_status, month')
      .in('school_id', schoolIds)
      .eq('month', currentMonth);

    // Build maps
    const activeMap: Record<string, number> = {};
    const juniorMap: Record<string, number> = {};
    const seniorMap: Record<string, number> = {};
    for (const sub of subs ?? []) {
      const s = sub as { school_id: string; plan_type: string; status: string };
      activeMap[s.school_id] = (activeMap[s.school_id] ?? 0) + 1;
      if (s.plan_type === 'premium_junior') {
        juniorMap[s.school_id] = (juniorMap[s.school_id] ?? 0) + 1;
      } else {
        seniorMap[s.school_id] = (seniorMap[s.school_id] ?? 0) + 1;
      }
    }

    const studentCountMap: Record<string, number> = {};
    for (const st of students ?? []) {
      const s = st as { school_id: string };
      studentCountMap[s.school_id] = (studentCountMap[s.school_id] ?? 0) + 1;
    }

    const rateMap: Record<string, number> = {};
    const statusMap: Record<string, string> = {};
    for (const r of revenueRows ?? []) {
      const rv = r as { school_id: string; rate_per_student: number; payout_status: string };
      rateMap[rv.school_id] = rv.rate_per_student;
      statusMap[rv.school_id] = rv.payout_status;
    }

    // Build expired-but-not-deactivated map
    const expiredMap: Record<string, number> = {};
    for (const e of expiredSubs ?? []) {
      const es = e as { school_id: string };
      expiredMap[es.school_id] = (expiredMap[es.school_id] ?? 0) + 1;
    }

    const DEFAULT_RATE = 75;

    const result = (schools as { id: string; name: string; subscription_status: boolean }[]).map((school) => {
      const active = activeMap[school.id] ?? 0;
      const rate = rateMap[school.id] ?? DEFAULT_RATE;
      return {
        school_id: school.id,
        school_name: school.name,
        subscription_status: school.subscription_status,
        total_students: studentCountMap[school.id] ?? 0,
        active_premium_count: active,
        junior_count: juniorMap[school.id] ?? 0,
        senior_count: seniorMap[school.id] ?? 0,
        expired_not_deactivated: expiredMap[school.id] ?? 0,
        rate_per_student: rate,
        amount_owed: active * rate,
        this_month_status: statusMap[school.id] ?? null,
      };
    });

    sendSuccess(res, result);
  }
);

// ── Superadmin: update payout status ─────────────────────────────────────────
// PATCH /api/premium/revenue/:id/status
router.patch(
  '/revenue/:id/status',
  authenticate,
  requireRole('superadmin'),
  async (req: Request, res: Response) => {
    const schema = z.object({
      payout_status: z.enum(['pending', 'invoiced', 'paid']),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

    const updates: Record<string, unknown> = { payout_status: parsed.data.payout_status };
    if (parsed.data.payout_status === 'invoiced') {
      updates.invoiced_at = new Date().toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from('revenue_shares')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data, 'Payout status updated');
  }
);

export default router;
