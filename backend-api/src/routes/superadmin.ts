import { Router, Request, Response } from 'express';
import { z } from 'zod';
import archiver from 'archiver';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

// ── All routes require authentication + superadmin role ───────────────────────
router.use(authenticate);
router.use(requireRole('superadmin'));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write to audit_logs. Errors are swallowed so they never break the main flow. */
async function logAudit(
  userId: string,
  action: string,
  tableName: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      action,
      table_name: tableName,
      details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err);
  }
}

/** Generate a random 10-char alphanumeric temp password. */
function generateTempPassword(): string {
  return (
    Math.random().toString(36).slice(2, 7).toUpperCase() +
    Math.random().toString(36).slice(2, 7)
  );
}

/**
 * Convert an array of objects to a CSV string.
 * The first row is the header derived from the keys of the first object.
 */
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    // Wrap in quotes if the value contains a comma, quote, or newline
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ];
  return lines.join('\n');
}

// ── Subscription price (read from env, default $50) ───────────────────────────
const SUBSCRIPTION_PRICE = parseFloat(process.env.SUBSCRIPTION_PRICE ?? '50');

// ═══════════════════════════════════════════════════════════════════════════════
// SCHOOL MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/superadmin/schools ───────────────────────────────────────────────
/**
 * List all schools with student count, teacher count, subscription status,
 * and last active date.
 */
router.get('/schools', async (req: Request, res: Response) => {
  // Fetch all schools
  const { data: schools, error: schoolsErr } = await supabaseAdmin
    .from('schools')
    .select('id, name, address, phone, email, subscription_status, created_at, updated_at')
    .order('name');

  if (schoolsErr) {
    sendError(res, schoolsErr.message, 500);
    return;
  }

  if (!schools || schools.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const schoolIds = schools.map((s: { id: string }) => s.id);

  // Student counts per school
  const { data: studentCounts } = await supabaseAdmin
    .from('students')
    .select('school_id')
    .in('school_id', schoolIds)
    .eq('is_deleted', false);

  // Teacher counts per school (users with role=teacher)
  const { data: teacherCounts } = await supabaseAdmin
    .from('users')
    .select('school_id')
    .in('school_id', schoolIds)
    .eq('role', 'teacher');

  // Last attendance date per school (proxy for "last active")
  const { data: lastActivity } = await supabaseAdmin
    .from('attendance')
    .select('date, students!inner(school_id)')
    .in('students.school_id', schoolIds)
    .order('date', { ascending: false });

  // Build lookup maps
  const studentCountMap: Record<string, number> = {};
  for (const row of studentCounts ?? []) {
    const sid = (row as { school_id: string }).school_id;
    studentCountMap[sid] = (studentCountMap[sid] ?? 0) + 1;
  }

  const teacherCountMap: Record<string, number> = {};
  for (const row of teacherCounts ?? []) {
    const sid = (row as { school_id: string }).school_id;
    teacherCountMap[sid] = (teacherCountMap[sid] ?? 0) + 1;
  }

  // Last active: first occurrence per school_id (already ordered desc)
  const lastActiveMap: Record<string, string> = {};
  for (const row of lastActivity ?? []) {
    const r = row as unknown as { date: string; students: { school_id: string } };
    const sid = r.students?.school_id;
    if (sid && !lastActiveMap[sid]) {
      lastActiveMap[sid] = r.date;
    }
  }

  const result = schools.map((school: Record<string, unknown>) => ({
    ...school,
    student_count: studentCountMap[school.id as string] ?? 0,
    teacher_count: teacherCountMap[school.id as string] ?? 0,
    last_active_date: lastActiveMap[school.id as string] ?? null,
  }));

  sendSuccess(res, result);
});

// ── POST /api/superadmin/schools ──────────────────────────────────────────────
/**
 * Create a new school.
 * subscription_status defaults to false (inactive) on creation.
 */
router.post('/schools', async (req: Request, res: Response) => {
  const schema = z.object({
    name:    z.string().min(1),
    address: z.string().min(1),
    phone:   z.string().min(1),
    email:   z.string().email(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { name, address, phone, email } = parsed.data;
  const adminId = req.user!.id;

  // Check for duplicate school email
  const { data: existing } = await supabaseAdmin
    .from('schools')
    .select('id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (existing) {
    sendError(res, 'A school with this email already exists', 409);
    return;
  }

  const { data: school, error: insertErr } = await supabaseAdmin
    .from('schools')
    .insert({
      name,
      address,
      phone,
      email: email.toLowerCase(),
      subscription_status: false,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr || !school) {
    sendError(res, insertErr?.message ?? 'Failed to create school', 500);
    return;
  }

  await logAudit(adminId, 'SCHOOL_CREATED', 'schools', {
    school_id: (school as Record<string, unknown>).id,
    name,
    email,
  });

  sendSuccess(res, school, 'School created successfully', 201);
});

// ── PUT /api/superadmin/schools/:id/subscription ──────────────────────────────
/**
 * Toggle a school's subscription active/inactive.
 * On deactivation: sends warning email to school admin and logs a warning.
 */
router.put('/schools/:id/subscription', async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.boolean(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { status } = parsed.data;
  const schoolId = req.params.id;
  const adminId  = req.user!.id;

  // Fetch school
  const { data: school, error: schoolErr } = await supabaseAdmin
    .from('schools')
    .select('id, name, email, subscription_status')
    .eq('id', schoolId)
    .single();

  if (schoolErr || !school) {
    sendError(res, 'School not found', 404);
    return;
  }

  const s = school as { id: string; name: string; email: string; subscription_status: boolean };

  // If deactivating: warn school admin and log
  if (!status) {
    // Find the school admin user for this school
    const { data: schoolAdmin } = await supabaseAdmin
      .from('users')
      .select('id, email, name')
      .eq('school_id', schoolId)
      .eq('role', 'schooladmin')
      .maybeSingle();

    const adminEmail = (schoolAdmin as { email: string } | null)?.email ?? s.email;

    // Send warning email via Supabase Auth magic link (best-effort)
    try {
      await supabaseAdmin.auth.admin.generateLink({
        type:  'magiclink',
        email: adminEmail,
      });
    } catch (emailErr) {
      console.warn('[superadmin] Warning email failed for school admin:', adminEmail, emailErr);
    }

    // Log deactivation warning
    await logAudit(adminId, 'SCHOOL_SUBSCRIPTION_DEACTIVATION_WARNING', 'schools', {
      school_id:   schoolId,
      school_name: s.name,
      admin_email: adminEmail,
      warning:     'Download school data before deactivating',
    });
  }

  // Update subscription_status
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('schools')
    .update({
      subscription_status: status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', schoolId)
    .select()
    .single();

  if (updateErr) {
    sendError(res, updateErr.message, 500);
    return;
  }

  await logAudit(adminId, status ? 'SCHOOL_SUBSCRIPTION_ACTIVATED' : 'SCHOOL_SUBSCRIPTION_DEACTIVATED', 'schools', {
    school_id:   schoolId,
    school_name: s.name,
    new_status:  status,
  });

  const response: Record<string, unknown> = { school: updated };
  if (!status) {
    response.warning = 'Download school data before deactivating';
  }

  sendSuccess(res, response, `Subscription ${status ? 'activated' : 'deactivated'} successfully`);
});

// ── POST /api/superadmin/schools/:id/admin ────────────────────────────────────
/**
 * Create a school admin account for a school.
 * - Creates Supabase auth user
 * - Creates users record with role=school_admin and school_id
 * - Sends welcome email via Supabase magic link
 * - Logs to audit_logs
 */
router.post('/schools/:id/admin', async (req: Request, res: Response) => {
  const schema = z.object({
    name:     z.string().min(1),
    email:    z.string().email(),
    phone:    z.string().optional(),
    password: z.string().min(8).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { name, email, phone, password } = parsed.data;
  const schoolId    = req.params.id;
  const superAdminId = req.user!.id;

  // Verify school exists
  const { data: school, error: schoolErr } = await supabaseAdmin
    .from('schools')
    .select('id, name')
    .eq('id', schoolId)
    .single();

  if (schoolErr || !school) {
    sendError(res, 'School not found', 404);
    return;
  }

  // Check email not already in use
  const { data: emailConflict } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (emailConflict) {
    sendError(res, 'A user with this email already exists', 409);
    return;
  }

  const tempPassword = password ?? generateTempPassword();

  // Create Supabase auth user
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password:      tempPassword,
    email_confirm: true,
  });

  if (authErr || !authData?.user) {
    sendError(res, authErr?.message ?? 'Failed to create auth account', 500);
    return;
  }

  const newUserId = authData.user.id;

  // Insert users profile row
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('users')
    .insert({
      id:         newUserId,
      name,
      email:      email.toLowerCase(),
      role:       'schooladmin',
      school_id:  schoolId,
      phone:      phone ?? null,
      created_by: superAdminId,
      created_at: new Date().toISOString(),
    })
    .select('id, name, email, role, school_id, phone')
    .single();

  if (profileErr) {
    // Roll back auth user to avoid orphaned accounts
    await supabaseAdmin.auth.admin.deleteUser(newUserId);
    sendError(res, 'Failed to create admin profile. Auth account rolled back.', 500);
    return;
  }

  // Send welcome email via Supabase magic link (best-effort)
  try {
    await supabaseAdmin.auth.admin.generateLink({
      type:  'magiclink',
      email,
    });
  } catch (emailErr) {
    console.warn('[superadmin] Welcome email failed for school admin:', email, emailErr);
  }

  await logAudit(superAdminId, 'SCHOOL_ADMIN_CREATED', 'users', {
    new_user_id:  newUserId,
    name,
    email,
    school_id:    schoolId,
    school_name:  (school as { name: string }).name,
  });

  sendSuccess(res, profile, 'School admin account created successfully', 201);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLATFORM STATS
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/superadmin/stats ─────────────────────────────────────────────────
/**
 * Platform-wide stats:
 *   - Total schools
 *   - Total active schools (subscription_status = true)
 *   - Total students across all schools
 *   - Total teachers
 *   - Total attendance records today
 *   - Revenue estimate (active schools × subscription price)
 */
router.get('/stats', async (req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);

  const [
    { count: totalSchools },
    { count: activeSchools },
    { count: totalStudents },
    { count: totalTeachers },
    { count: attendanceToday },
  ] = await Promise.all([
    supabaseAdmin.from('schools').select('id', { count: 'exact', head: true }),
    supabaseAdmin
      .from('schools')
      .select('id', { count: 'exact', head: true })
      .eq('subscription_status', true),
    supabaseAdmin
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('is_deleted', false),
    supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'teacher'),
    supabaseAdmin
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('date', today),
  ]);

  const active = activeSchools ?? 0;
  const revenueEstimate = active * SUBSCRIPTION_PRICE;

  sendSuccess(res, {
    total_schools:       totalSchools ?? 0,
    active_schools:      active,
    inactive_schools:    (totalSchools ?? 0) - active,
    total_students:      totalStudents ?? 0,
    total_teachers:      totalTeachers ?? 0,
    attendance_today:    attendanceToday ?? 0,
    revenue_estimate:    revenueEstimate,
    subscription_price:  SUBSCRIPTION_PRICE,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/superadmin/audit-logs ────────────────────────────────────────────
/**
 * All audit logs across all schools.
 * Query params:
 *   school_id   — filter by school
 *   action      — filter by action type (partial match)
 *   from        — start date (YYYY-MM-DD)
 *   to          — end date (YYYY-MM-DD)
 *   page        — page number (default 1)
 * Page size: 50 records.
 */
router.get('/audit-logs', async (req: Request, res: Response) => {
  const { school_id, action, from, to, page } = req.query as Record<string, string>;

  const PAGE_SIZE = 50;
  const pageNum   = Math.max(1, parseInt(page ?? '1', 10));
  const offset    = (pageNum - 1) * PAGE_SIZE;

  let query = supabaseAdmin
    .from('audit_logs')
    .select(
      'id, user_id, action, table_name, details, created_at, users(name, email, role, school_id)',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  // Filter by school: match logs whose user belongs to the school
  if (school_id) {
    // Get user IDs belonging to this school
    const { data: schoolUsers } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('school_id', school_id);

    const userIds = (schoolUsers ?? []).map((u: { id: string }) => u.id);

    if (userIds.length === 0) {
      sendSuccess(res, { logs: [], total: 0, page: pageNum, page_size: PAGE_SIZE, total_pages: 0 });
      return;
    }

    query = query.in('user_id', userIds);
  }

  if (action) {
    query = query.ilike('action', `%${action}%`);
  }

  if (from) {
    query = query.gte('created_at', `${from}T00:00:00.000Z`);
  }

  if (to) {
    query = query.lte('created_at', `${to}T23:59:59.999Z`);
  }

  const { data: logs, error, count } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  const total      = count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  sendSuccess(res, {
    logs:        logs ?? [],
    total,
    page:        pageNum,
    page_size:   PAGE_SIZE,
    total_pages: totalPages,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHOOL DATA EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/superadmin/export/:school_id ─────────────────────────────────────
/**
 * Export all data for a specific school as a ZIP archive containing CSVs.
 * Tables exported: students, users (teachers/admins), attendance, marks,
 *                  fees, assignments, complaints, notifications, audit_logs.
 * Intended for use before deactivating a school.
 */
router.get('/export/:school_id', async (req: Request, res: Response) => {
  const { school_id } = req.params;
  const adminId = req.user!.id;

  // Verify school exists
  const { data: school, error: schoolErr } = await supabaseAdmin
    .from('schools')
    .select('id, name')
    .eq('id', school_id)
    .single();

  if (schoolErr || !school) {
    sendError(res, 'School not found', 404);
    return;
  }

  const schoolName = (school as { name: string }).name
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase();

  // Fetch all school data in parallel
  const [
    { data: students },
    { data: schoolUsers },
    { data: attendanceRecords },
    { data: marksRecords },
    { data: feesRecords },
    { data: assignmentsRecords },
    { data: complaintsRecords },
    { data: notificationsRecords },
    { data: auditRecords },
  ] = await Promise.all([
    supabaseAdmin.from('students').select('*').eq('school_id', school_id),
    supabaseAdmin.from('users').select('id, name, email, role, phone, created_at').eq('school_id', school_id),
    supabaseAdmin
      .from('attendance')
      .select('*')
      .in(
        'student_id',
        ((await supabaseAdmin.from('students').select('id').eq('school_id', school_id)).data ?? []).map(
          (s: { id: string }) => s.id
        )
      ),
    supabaseAdmin
      .from('marks')
      .select('*')
      .eq('school_id', school_id),
    supabaseAdmin
      .from('fees')
      .select('*')
      .eq('school_id', school_id),
    supabaseAdmin
      .from('assignments')
      .select('*')
      .eq('school_id', school_id),
    supabaseAdmin
      .from('complaints')
      .select('*')
      .eq('school_id', school_id),
    supabaseAdmin
      .from('notifications')
      .select('*')
      .in(
        'user_id',
        ((await supabaseAdmin.from('users').select('id').eq('school_id', school_id)).data ?? []).map(
          (u: { id: string }) => u.id
        )
      ),
    supabaseAdmin
      .from('audit_logs')
      .select('*')
      .in(
        'user_id',
        ((await supabaseAdmin.from('users').select('id').eq('school_id', school_id)).data ?? []).map(
          (u: { id: string }) => u.id
        )
      ),
  ]);

  // Set response headers for ZIP download
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${schoolName}_export_${new Date().toISOString().slice(0, 10)}.zip"`
  );

  // Stream ZIP directly to response
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', (err: Error) => {
    console.error('[export] Archive error:', err);
    // Headers already sent — can't send a proper error response
    res.end();
  });

  archive.pipe(res);

  // Helper to append a CSV file to the archive
  const appendCsv = (filename: string, rows: Record<string, unknown>[] | null) => {
    const csv = toCsv(rows ?? []);
    archive.append(csv || '', { name: filename });
  };

  appendCsv('students.csv',       students       as Record<string, unknown>[] | null);
  appendCsv('users.csv',          schoolUsers    as Record<string, unknown>[] | null);
  appendCsv('attendance.csv',     attendanceRecords as Record<string, unknown>[] | null);
  appendCsv('marks.csv',          marksRecords   as Record<string, unknown>[] | null);
  appendCsv('fees.csv',           feesRecords    as Record<string, unknown>[] | null);
  appendCsv('assignments.csv',    assignmentsRecords as Record<string, unknown>[] | null);
  appendCsv('complaints.csv',     complaintsRecords  as Record<string, unknown>[] | null);
  appendCsv('notifications.csv',  notificationsRecords as Record<string, unknown>[] | null);
  appendCsv('audit_logs.csv',     auditRecords   as Record<string, unknown>[] | null);

  await archive.finalize();

  // Audit log the export action
  await logAudit(adminId, 'SCHOOL_DATA_EXPORTED', 'schools', {
    school_id,
    school_name: (school as { name: string }).name,
    exported_at: new Date().toISOString(),
  });
});

export default router;
