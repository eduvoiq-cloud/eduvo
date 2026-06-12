import { Router, Request, Response } from 'express';
import { z } from 'zod';
import archiver from 'archiver';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import { generateTempPassword } from '../utils/password';

const router = Router();

// ── All routes require authentication + superadmin role ───────────────────────
router.use(authenticate);
router.use(requireRole('superadmin'));

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Supports pagination: ?page=1&limit=50 (default 50, max 200).
 */
router.get('/schools', async (req: Request, res: Response) => {
  const rawPage  = parseInt((req.query.page  as string) ?? '1',  10);
  const rawLimit = parseInt((req.query.limit as string) ?? '50', 10);
  const page  = isNaN(rawPage)  || rawPage  < 1 ? 1  : rawPage;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200);

  // Fetch schools with pagination
  const { data: schools, error: schoolsErr, count } = await supabaseAdmin
    .from('schools')
    .select('id, name, address, phone, email, subscription_status, created_at, updated_at', { count: 'exact' })
    .order('name')
    .range((page - 1) * limit, page * limit - 1);

  if (schoolsErr) {
    sendError(res, schoolsErr.message, 500);
    return;
  }

  if (!schools || schools.length === 0) {
    sendSuccess(res, { data: [], total: count ?? 0, page, limit, total_pages: 0 });
    return;
  }

  const schoolIds = schools.map((s: { id: string }) => s.id);

  // Fetch all counts in parallel — one query each (no N+1)
  const [
    { data: studentCounts },
    { data: teacherCounts },
    { data: lastActivity },
  ] = await Promise.all([
    supabaseAdmin
      .from('students')
      .select('school_id')
      .in('school_id', schoolIds)
      .eq('is_deleted', false),
    supabaseAdmin
      .from('users')
      .select('school_id')
      .in('school_id', schoolIds)
      .eq('role', 'teacher')
      .or('is_deleted.eq.false,is_deleted.is.null'),
    // Last attendance date: get the max date per school using a single aggregated query
    // by fetching one recent record per school (ordered desc, deduplicated client-side)
    supabaseAdmin
      .from('attendance')
      .select('date, students!inner(school_id)')
      .filter('students.school_id', 'in', `(${schoolIds.map((id) => `"${id}"`).join(',')})`)
      .order('date', { ascending: false })
      .limit(schoolIds.length * 2), // enough to get at least one per school
  ]);

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
    const r = row as unknown as { date: string; students: { school_id: string } | { school_id: string }[] };
    const studentData = Array.isArray(r.students) ? r.students[0] : r.students;
    const sid = studentData?.school_id;
    if (sid && !lastActiveMap[sid]) {
      lastActiveMap[sid] = r.date;
    }
  }

  const result = schools.map((school: Record<string, unknown>) => ({
    ...school,
    student_count:    studentCountMap[school.id as string] ?? 0,
    teacher_count:    teacherCountMap[school.id as string] ?? 0,
    last_active_date: lastActiveMap[school.id as string] ?? null,
  }));

  const total = count ?? 0;
  sendSuccess(res, { data: result, total, page, limit, total_pages: Math.ceil(total / limit) });
});

// ── GET /api/superadmin/schools/:id ──────────────────────────────────────────
/**
 * Get detailed info for a single school:
 * - Basic info (name, address, phone, email, subscription_status)
 * - student_count, teacher_count, today's attendance count
 * - list of school admins (name, email, phone)
 */
router.get('/schools/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data: school, error: schoolErr } = await supabaseAdmin
    .from('schools')
    .select('id, name, address, phone, email, subscription_status, created_at, updated_at')
    .eq('id', id)
    .single();

  if (schoolErr || !school) {
    sendError(res, 'School not found', 404);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  // Fetch counts and admins in parallel
  const [
    { count: studentCount },
    { count: teacherCount },
    { data: admins },
    { data: studentIds },
  ] = await Promise.all([
    supabaseAdmin
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', id)
      .eq('is_deleted', false),
    supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', id)
      .eq('role', 'teacher')
      .or('is_deleted.eq.false,is_deleted.is.null'),
    supabaseAdmin
      .from('users')
      .select('id, name, email, phone, created_at')
      .eq('school_id', id)
      .eq('role', 'schooladmin'),
    supabaseAdmin
      .from('students')
      .select('id')
      .eq('school_id', id)
      .eq('is_deleted', false),
  ]);

  // Today's attendance count for this school
  let attendanceToday = 0;
  if (studentIds && studentIds.length > 0) {
    const sids = studentIds.map((s: { id: string }) => s.id);
    const { count } = await supabaseAdmin
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .in('student_id', sids)
      .eq('date', today)
      .eq('status', 'present');
    attendanceToday = count ?? 0;
  }

  sendSuccess(res, {
    ...school,
    student_count: studentCount ?? 0,
    teacher_count: teacherCount ?? 0,
    attendance_today: attendanceToday,
    admins: admins ?? [],
  });
});

// ── DELETE /api/superadmin/schools/:id ────────────────────────────────────────
/**
 * Completely delete a school and ALL related data:
 * - Deletes all auth users (students + staff) linked to this school
 * - Deletes the school row (cascades to students, users, attendance, etc.)
 */
router.delete('/schools/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const adminId = req.user!.id;

  // Verify school exists
  const { data: school, error: schoolErr } = await supabaseAdmin
    .from('schools')
    .select('id, name')
    .eq('id', id)
    .single();

  if (schoolErr || !school) {
    sendError(res, 'School not found', 404);
    return;
  }

  const schoolName = (school as { id: string; name: string }).name;

  // Fetch all staff user IDs for this school
  const { data: staffUsers } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('school_id', id);

  // Fetch all student auth IDs (students who have a parent_id / auth account)
  // Students use the same auth system — their auth.uid is stored in students.id
  const { data: studentAuthRows } = await supabaseAdmin
    .from('students')
    .select('id')
    .eq('school_id', id);

  // Delete all auth users for staff
  const staffIds = (staffUsers ?? []).map((u: { id: string }) => u.id);
  const studentIds = (studentAuthRows ?? []).map((s: { id: string }) => s.id);
  const allAuthIds = [...new Set([...staffIds, ...studentIds])];

  const deleteErrors: string[] = [];
  for (const uid of allAuthIds) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(uid);
    if (error) {
      // Log but don't stop — user may already be deleted
      deleteErrors.push(`${uid}: ${error.message}`);
    }
  }

  if (deleteErrors.length > 0) {
    console.warn('[superadmin delete school] Some auth users could not be deleted:', deleteErrors);
  }

  // Delete the school row — DB cascades handle students, users, attendance, etc.
  const { error: deleteErr } = await supabaseAdmin
    .from('schools')
    .delete()
    .eq('id', id);

  if (deleteErr) {
    sendError(res, deleteErr.message, 500);
    return;
  }

  await logAudit(adminId, 'SCHOOL_DELETED', 'schools', {
    school_id: id,
    school_name: schoolName,
    auth_users_deleted: allAuthIds.length - deleteErrors.length,
    auth_deletion_errors: deleteErrors.length,
  });

  sendSuccess(res, { deleted: true, school_id: id }, 'School deleted successfully');
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
    name:  z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { name, email, phone } = parsed.data;
  const schoolId     = req.params.id;
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

  // If the user already exists as a schooladmin for THIS school, return their info
  // (idempotent — calling "Create Admin" twice is harmless)
  const { data: existingUser } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id, phone')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (existingUser) {
    const u = existingUser as { id: string; role: string; school_id: string; name: string; email: string; phone: string | null };
    if (u.role === 'schooladmin' && u.school_id === schoolId) {
      sendSuccess(res, { ...u, already_existed: true }, 'School admin already exists for this school', 200);
      return;
    }
    sendError(res, 'A user with this email already exists for a different school or role', 409);
    return;
  }

  // Default password = phone number (digits only).
  // If no phone provided, generate a random temp password.
  // Either way, must_reset_password = true forces a change on first login —
  // same behaviour as teachers created via bulk import.
  const rawPhone = (phone ?? '').replace(/\D/g, '');
  const defaultPassword = rawPhone.length >= 6 ? rawPhone : generateTempPassword();
  const passwordIsPhone = rawPhone.length >= 6;

  // Create Supabase auth user.
  // Clean up any orphaned stale auth account before re-creating.
  let { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password:      defaultPassword,
    email_confirm: true,
  });

  if (authErr && authErr.message?.toLowerCase().includes('already been registered')) {
    const { data: page1 } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000, page: 1 });
    const staleAuth = page1?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (staleAuth) await supabaseAdmin.auth.admin.deleteUser(staleAuth.id);
    const retry = await supabaseAdmin.auth.admin.createUser({
      email,
      password:      defaultPassword,
      email_confirm: true,
    });
    authData = retry.data;
    authErr  = retry.error;
  }

  if (authErr || !authData?.user) {
    sendError(res, authErr?.message ?? 'Failed to create auth account', 500);
    return;
  }

  const newUserId = authData.user.id;

  // Insert users profile — must_reset_password = true forces a password change on first login
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('users')
    .insert({
      id:                  newUserId,
      name,
      email:               email.toLowerCase(),
      role:                'schooladmin',
      school_id:           schoolId,
      phone:               phone ?? null,
      must_reset_password: true,
      created_by:          superAdminId,
      created_at:          new Date().toISOString(),
    })
    .select('id, name, email, role, school_id, phone')
    .single();

  if (profileErr) {
    await supabaseAdmin.auth.admin.deleteUser(newUserId);
    sendError(res, 'Failed to create admin profile. Auth account rolled back.', 500);
    return;
  }

  // Send welcome email via magic link (best-effort)
  try {
    await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
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

  // Return the default password so the super admin can share it with the school admin.
  // They will be forced to change it on first login.
  sendSuccess(res, {
    ...profile,
    default_password: defaultPassword,
    password_is_phone: passwordIsPhone,
  }, 'School admin account created successfully', 201);
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
