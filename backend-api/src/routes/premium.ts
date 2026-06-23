/**
 * /api/premium — Premium management routes
 *
 * NOTE: The B2C parent_subscriptions feature has been removed.
 * Routes that previously managed per-student subscriptions now return 410 Gone.
 * Teacher premium access and revenue ledger routes are unchanged.
 *
 *   Removed (return 410):
 *     POST   /api/premium/subscriptions/:studentId/activate
 *     POST   /api/premium/subscriptions/:studentId/deactivate
 *     POST   /api/premium/subscriptions/:studentId/renew
 *     GET    /api/premium/subscriptions
 *     GET    /api/premium/my-subscription
 *     GET    /api/premium/student-summary
 *     GET    /api/premium/schools/summary
 *     POST   /api/premium/revenue/calculate
 *
 *   Still active:
 *     GET    /api/premium/revenue                — revenue share ledger (own school)
 *     GET    /api/premium/revenue/all            — all schools (superadmin)
 *     PATCH  /api/premium/revenue/:id/status     — update payout_status
 *     GET    /api/premium/teacher-access         — list teacher flags
 *     POST   /api/premium/teacher-access         — grant/update teacher flags
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// ── Removed routes — return 410 Gone ─────────────────────────────────────────

const gone = (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    message: 'This feature has been removed.',
  });
};

router.post('/subscriptions/:studentId/activate',   authenticate, gone);
router.post('/subscriptions/:studentId/deactivate', authenticate, gone);
router.post('/subscriptions/:studentId/renew',      authenticate, gone);
router.get('/subscriptions',                        authenticate, gone);
router.get('/my-subscription',                      gone);
router.get('/student-summary',                      authenticate, gone);
router.get('/schools/summary',                      authenticate, gone);
router.post('/revenue/calculate',                   authenticate, gone);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive plan type from class string. junior = 1-6, senior = 7-12. */
function derivePlanType(className: string): 'premium_junior' | 'premium_senior' {
  const num = parseInt(className.replace(/\D/g, ''), 10);
  return num >= 7 ? 'premium_senior' : 'premium_junior';
}

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
    const year   = req.query.year   as string | undefined;
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
