import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import * as firebaseAdmin from 'firebase-admin';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { sendSMS } from '../services/smsService';

const router = Router();

// ── All routes require authentication + school_admin role ─────────────────────
router.use(authenticate);
router.use(requireRole('schooladmin'));

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

/** Guard: ensure the target student belongs to the admin's school. */
async function getStudentInSchool(
  studentId: string,
  schoolId: string
): Promise<Record<string, unknown> | null> {
  const { data } = await supabaseAdmin
    .from('students')
    .select('*')
    .eq('id', studentId)
    .eq('school_id', schoolId)
    .maybeSingle();
  return data ?? null;
}

/** Generate a random 10-char alphanumeric temp password. */
function generateTempPassword(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase() +
    Math.random().toString(36).slice(2, 7);
}

/** Get Firebase app (lazy, idempotent). Returns null if not configured. */
function getFirebaseApp(): firebaseAdmin.app.App | null {
  try {
    return firebaseAdmin.app();
  } catch {
    const projectId   = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey  = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (projectId && clientEmail && privateKey) {
      return firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert({ projectId, clientEmail, privateKey }),
      });
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      return firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.applicationDefault(),
      });
    }
    console.warn('[fcm] Firebase credentials not configured — push notifications disabled');
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/students ───────────────────────────────────────────────────
/**
 * List all students for this school.
 * Supports pagination: ?page=1&limit=50 (default limit 50, max 200).
 * Pass limit=0 to fetch all (no pagination envelope — returns plain array).
 * Pass ?include_deleted=true to also return soft-deleted students.
 */
router.get('/students', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;
  const includeDeleted = req.query.include_deleted === 'true';
  const search = req.query.search as string | undefined;
  const class_name = req.query.class_name as string | undefined;
  const section = req.query.section as string | undefined;

  // Pagination
  const rawPage  = parseInt(req.query.page  as string ?? '1',  10);
  const rawLimit = parseInt(req.query.limit as string ?? '50', 10);
  const page  = isNaN(rawPage)  || rawPage  < 1 ? 1  : rawPage;
  const limit = rawLimit === 0  ? 0
              : isNaN(rawLimit) || rawLimit < 1 ? 50
              : Math.min(rawLimit, 200);

  let query = supabaseAdmin
    .from('students')
    .select('*', { count: 'exact' })
    .eq('school_id', schoolId)
    .order('full_name');

  if (!includeDeleted) {
    query = query.eq('is_deleted', false);
  }

  if (search) {
    query = query.or(`full_name.ilike.%${search}%,roll_number.ilike.%${search}%`);
  }
  if (class_name) query = query.ilike('class_name', class_name.trim());
  if (section)    query = query.ilike('section', section.trim());

  if (limit > 0) {
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
  }

  const { data, error, count } = await query;
  if (error) { sendError(res, error.message, 500); return; }

  if (limit > 0) {
    const total       = count ?? 0;
    const total_pages = Math.ceil(total / limit);
    sendSuccess(res, { data: data ?? [], total, page, limit, total_pages });
  } else {
    sendSuccess(res, data ?? []);
  }
});

// ── POST /api/admin/students ──────────────────────────────────────────────────
/**
 * Add a new student.
 * - phone_number is required — it is the login phone for the student/parent account.
 * - Default password = last 5 digits of phone_number (bcrypt hashed, rounds 10).
 * - is_first_login = true so the app prompts a password change on first login.
 * - Sends a welcome SMS to the parent phone via MSG91 (best-effort).
 * - Inserts into students table with school_id from the logged-in admin.
 * - Auto-generates qr_code = student UUID.
 * - Logs to audit_logs.
 */
router.post('/students', async (req: Request, res: Response) => {
  const schema = z.object({
    name:         z.string().min(1),
    class:        z.string().min(1),
    section:      z.string().min(1),
    roll_number:  z.string().optional(),
    parent_phone: z.string().regex(/^\d{10}$/, 'parent_phone must be exactly 10 digits').optional(),
    parent_email: z.string().email().optional(),
    photo_url:    z.string().optional(),
    date_of_birth: z.string().optional(), // YYYY-MM-DD or DD/MM/YYYY accepted
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { name, class: className, section, roll_number, parent_phone, parent_email, photo_url, date_of_birth } =
    parsed.data;
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  // Normalize class and section — trim whitespace so "10 " and "10" are the same
  const normalizedClass   = className.trim();
  const normalizedSection = section.trim();

  // phone_number is now optional — use parent_phone if provided, otherwise generate a temp one
  const phone_number = parent_phone || `98${Math.random().toString().slice(2, 10)}`;

  // Check phone not already registered to another student in this school
  const { data: phoneConflict } = await supabaseAdmin
    .from('students')
    .select('id')
    .eq('school_id', schoolId)
    .eq('phone_number', phone_number)
    .eq('is_deleted', false)
    .maybeSingle();

  if (phoneConflict) {
    sendError(res, 'A student with this phone number already exists in your school', 409);
    return;
  }

  // Default password = last 5 digits of phone
  const defaultPassword = phone_number.slice(-5);
  let passwordHash: string;
  try {
    passwordHash = await bcrypt.hash(defaultPassword, 10);
  } catch (hashErr) {
    sendError(res, 'Failed to hash password', 500);
    return;
  }

  // Normalise date_of_birth: accept DD/MM/YYYY → convert to YYYY-MM-DD
  let dobIso: string | null = null;
  if (date_of_birth) {
    const ddmmyyyy = date_of_birth.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (ddmmyyyy) {
      dobIso = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
      dobIso = date_of_birth;
    }
    // If neither format matches, ignore silently (not required for manual add)
  }

  // Insert student
  const { data: student, error: insertErr } = await supabaseAdmin
    .from('students')
    .insert({
      full_name:      name,
      class_name:     normalizedClass,
      section:        normalizedSection,
      roll_number:    roll_number ?? null,
      phone_number,
      phone:          phone_number, // keep legacy column in sync
      date_of_birth:  dobIso,
      password_hash:  passwordHash,
      is_first_login: true,
      photo_url:      photo_url ?? null,
      school_id:      schoolId,
      is_deleted:     false,
      created_at:     new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr || !student) {
    sendError(res, insertErr?.message ?? 'Failed to create student', 500);
    return;
  }

  // Set qr_code = student UUID
  await supabaseAdmin
    .from('students')
    .update({ qr_code: student.id })
    .eq('id', student.id);

  // ── Parent linking (optional, by email) ──────────────────────────────────
  if (parent_email) {
    const { data: existingParent } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', parent_email.toLowerCase())
      .eq('role', 'parent')
      .maybeSingle();

    if (existingParent) {
      await supabaseAdmin
        .from('parent_students')
        .insert({ parent_id: existingParent.id, student_id: student.id })
        .select();

      await supabaseAdmin
        .from('students')
        .update({ parent_id: existingParent.id })
        .eq('id', student.id);
    } else {
      const tempPassword = generateTempPassword();
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email:         parent_email,
        password:      tempPassword,
        email_confirm: true,
      });

      if (!authErr && authData?.user) {
        const parentUserId = authData.user.id;

        await supabaseAdmin.from('users').insert({
          id:         parentUserId,
          name:       `Parent of ${name}`,
          email:      parent_email,
          role:       'parent',
          school_id:  schoolId,
          created_by: adminId,
          created_at: new Date().toISOString(),
        });

        await supabaseAdmin
          .from('parent_students')
          .insert({ parent_id: parentUserId, student_id: student.id });

        await supabaseAdmin
          .from('students')
          .update({ parent_id: parentUserId })
          .eq('id', student.id);

        const inviteToken = `${parentUserId}-${Date.now()}`;
        await supabaseAdmin.from('invites').insert({
          token:      inviteToken,
          email:      parent_email,
          role:       'parent',
          school_id:  schoolId,
          created_at: new Date().toISOString(),
        });

        await supabaseAdmin.auth.admin.generateLink({
          type:  'magiclink',
          email: parent_email,
        });
      }
    }
  }

  // ── Fetch school name for SMS ─────────────────────────────────────────────
  const { data: school } = await supabaseAdmin
    .from('schools')
    .select('name')
    .eq('id', schoolId)
    .maybeSingle();
  const schoolName = (school as Record<string, unknown> | null)?.name as string ?? 'your school';

  // ── Send welcome SMS (best-effort) ────────────────────────────────────────
  const smsMessage =
    `Welcome to Eduvo! Your child ${name} has been added to ${schoolName}. ` +
    `Download Eduvo app and login with: Phone: ${phone_number} Password: ${defaultPassword} ` +
    `Please change your password after first login.`;

  try {
    await sendSMS(phone_number, smsMessage);
  } catch (smsErr) {
    console.error('[admin] Welcome SMS failed for student:', name, smsErr);
  }

  await logAudit(adminId, 'STUDENT_CREATED', 'students', {
    student_id:   student.id,
    student_name: name,
    school_id:    schoolId,
    class:        normalizedClass,
    section:      normalizedSection,
    roll_number:  roll_number ?? null,
    parent_email: parent_email ?? null,
  });

  // Return student with qr_code populated
  const { data: finalStudent } = await supabaseAdmin
    .from('students')
    .select('*')
    .eq('id', student.id)
    .single();

  sendSuccess(res, finalStudent, 'Student created successfully', 201);
});

// ── PUT /api/admin/students/:id ───────────────────────────────────────────────
/**
 * Update student details.
 * Logs old and new values to audit_logs.
 */
router.put('/students/:id', async (req: Request, res: Response) => {
  const schema = z.object({
    name:         z.string().min(1).optional(),
    class:        z.string().min(1).optional(),
    section:      z.string().min(1).optional(),
    roll_number:  z.string().min(1).optional(),
    parent_phone: z.string().optional(),
    parent_email: z.string().email().optional(),
    photo_url:    z.string().url().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  const existing = await getStudentInSchool(req.params.id as string, schoolId);
  if (!existing) { sendError(res, 'Student not found', 404); return; }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name)         updates.full_name  = parsed.data.name;
  if (parsed.data.class)        updates.class_name = parsed.data.class;
  if (parsed.data.section)      updates.section    = parsed.data.section;
  if (parsed.data.roll_number)  updates.roll_number = parsed.data.roll_number;
  if (parsed.data.parent_phone) updates.phone      = parsed.data.parent_phone;
  if (parsed.data.photo_url)    updates.photo_url  = parsed.data.photo_url;

  if (Object.keys(updates).length === 0) {
    sendError(res, 'No updatable fields provided', 400);
    return;
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('students')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (updateErr) { sendError(res, updateErr.message, 500); return; }

  await logAudit(adminId, 'STUDENT_UPDATED', 'students', {
    student_id: req.params.id,
    old_value:  existing,
    new_value:  updates,
  });

  sendSuccess(res, updated, 'Student updated');
});

// ── DELETE /api/admin/students/:id ────────────────────────────────────────────
/**
 * Soft-delete a student (is_deleted = true). Never hard-deletes.
 */
router.delete('/students/:id', async (req: Request, res: Response) => {
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  const existing = await getStudentInSchool(req.params.id as string, schoolId);
  if (!existing) { sendError(res, 'Student not found', 404); return; }

  if (existing.is_deleted) {
    sendError(res, 'Student is already deleted', 400);
    return;
  }

  const { error } = await supabaseAdmin
    .from('students')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', req.params.id);

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(adminId, 'STUDENT_DELETED', 'students', {
    student_id:   req.params.id,
    student_name: existing.full_name,
    school_id:    schoolId,
  });

  sendSuccess(res, { id: req.params.id }, 'Student deleted (soft)');
});

// ── POST /api/admin/students/restore/:id ─────────────────────────────────────
/**
 * Restore a soft-deleted student (is_deleted = false).
 */
router.post('/students/restore/:id', async (req: Request, res: Response) => {
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  const existing = await getStudentInSchool(req.params.id as string, schoolId);
  if (!existing) { sendError(res, 'Student not found', 404); return; }

  if (!existing.is_deleted) {
    sendError(res, 'Student is not deleted', 400);
    return;
  }

  const { data: restored, error } = await supabaseAdmin
    .from('students')
    .update({ is_deleted: false, deleted_at: null })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  await logAudit(adminId, 'STUDENT_RESTORED', 'students', {
    student_id:   req.params.id,
    student_name: existing.full_name,
    school_id:    schoolId,
  });

  sendSuccess(res, restored, 'Student restored');
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/admin/teachers ──────────────────────────────────────────────────
/**
 * Create a teacher account.
 * - Creates Supabase auth user.
 * - Inserts users row with role=teacher and school_id from admin.
 * - Sends welcome email via Supabase magic link (best-effort).
 * - Logs to audit_logs.
 */
router.post('/teachers', async (req: Request, res: Response) => {
  const schema = z.object({
    name:     z.string().min(1),
    email:    z.string().email(),
    password: z.string().min(8).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { name, email, password } = parsed.data;
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

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

  const teacherUserId = authData.user.id;

  // Insert users profile row
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('users')
    .insert({
      id:         teacherUserId,
      name,
      email,
      role:       'teacher',
      school_id:  schoolId,
      created_by: adminId,
      created_at: new Date().toISOString(),
    })
    .select('id, name, email, role, school_id')
    .single();

  if (profileErr) {
    // Roll back auth user
    await supabaseAdmin.auth.admin.deleteUser(teacherUserId);
    sendError(res, 'Failed to create teacher profile. Auth account rolled back.', 500);
    return;
  }

  // Send welcome email via Supabase magic link (best-effort — don't fail if this errors)
  try {
    await supabaseAdmin.auth.admin.generateLink({
      type:  'magiclink',
      email,
    });
  } catch (emailErr) {
    console.warn('[admin] Welcome email failed for teacher:', email, emailErr);
  }

  await logAudit(adminId, 'TEACHER_CREATED', 'users', {
    teacher_id:   teacherUserId,
    teacher_name: name,
    email,
    school_id:    schoolId,
  });

  sendSuccess(res, profile, 'Teacher account created', 201);
});

// ── POST /api/admin/teachers/assign ──────────────────────────────────────────
/**
 * Assign a teacher to a class/section/subject.
 * Inserts into teacher_assignments table.
 */
router.post('/teachers/assign', async (req: Request, res: Response) => {
  const schema = z.object({
    teacher_id: z.string().uuid(),
    class:      z.string().min(1),
    section:    z.string().min(1),
    subject_id: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { teacher_id, class: className, section, subject_id } = parsed.data;
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  // Normalize class and section to avoid mismatch with student records
  const normalizedClass   = className.trim();
  const normalizedSection = section.trim();

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

  // Resolve subject name from subjects table (or use subject_id as name if not found)
  const { data: subject } = await supabaseAdmin
    .from('subjects')
    .select('name')
    .eq('id', subject_id)
    .eq('school_id', schoolId)
    .maybeSingle();

  const subjectName = (subject as Record<string, unknown> | null)?.name as string ?? subject_id;

  const { data: assignment, error: assignErr } = await supabaseAdmin
    .from('teacher_assignments')
    .insert({
      teacher_id,
      school_id:  schoolId,
      class_name: normalizedClass,
      class:      normalizedClass,
      section:    normalizedSection,
      subject:    subjectName,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (assignErr) {
    // Unique constraint violation = already assigned
    if (assignErr.code === '23505') {
      sendError(res, 'Teacher is already assigned to this class/section/subject', 409);
      return;
    }
    sendError(res, assignErr.message, 500);
    return;
  }

  await logAudit(adminId, 'TEACHER_ASSIGNED', 'teacher_assignments', {
    teacher_id,
    teacher_name: (teacher as Record<string, unknown>).name,
    class:        className,
    section,
    subject:      subjectName,
    school_id:    schoolId,
  });

  sendSuccess(res, assignment, 'Teacher assigned', 201);
});

// ── DELETE /api/admin/teachers/:id ────────────────────────────────────────────
/**
 * Soft-delete a teacher (is_deleted = true) and remove their assignments.
 */
router.delete('/teachers/:id', async (req: Request, res: Response) => {
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  const { data: teacher } = await supabaseAdmin
    .from('users')
    .select('id, name, role, school_id')
    .eq('id', req.params.id)
    .eq('school_id', schoolId)
    .eq('role', 'teacher')
    .maybeSingle();

  if (!teacher) { sendError(res, 'Teacher not found in your school', 404); return; }

  // Hard-delete from Supabase Auth so the email can be re-used on re-import.
  // The users row is cascade-deleted automatically (FK references auth.users ON DELETE CASCADE).
  // We also clean up teacher_assignments explicitly before the auth delete fires.

  // Remove all teacher_assignments first
  await supabaseAdmin
    .from('teacher_assignments')
    .delete()
    .eq('teacher_id', req.params.id)
    .eq('school_id', schoolId);

  // Hard-delete from auth.users (cascades to public.users via FK)
  const teacherId = String(req.params.id);
  const { error: authDeleteErr } = await supabaseAdmin.auth.admin.deleteUser(teacherId);

  if (authDeleteErr) {
    // Fall back to soft-delete if auth delete fails (e.g. user not in auth.users)
    const { error: softDeleteErr } = await supabaseAdmin
      .from('users')
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .eq('id', req.params.id);

    if (softDeleteErr) { sendError(res, softDeleteErr.message, 500); return; }
  }

  await logAudit(adminId, 'TEACHER_DELETED', 'users', {
    teacher_id:   req.params.id,
    teacher_name: (teacher as Record<string, unknown>).name,
    school_id:    schoolId,
  });

  sendSuccess(res, { id: req.params.id }, 'Teacher deleted and assignments removed');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUBJECT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/admin/subjects ──────────────────────────────────────────────────
/**
 * Add a subject to the school. Name must be unique per school.
 */
router.post('/subjects', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { name } = parsed.data;
  const schoolId = req.user!.school_id!;

  // Check uniqueness per school
  const { data: existing } = await supabaseAdmin
    .from('subjects')
    .select('id')
    .eq('school_id', schoolId)
    .ilike('name', name)
    .maybeSingle();

  if (existing) {
    sendError(res, 'A subject with this name already exists in your school', 409);
    return;
  }

  const { data: subject, error } = await supabaseAdmin
    .from('subjects')
    .insert({
      name,
      school_id:  schoolId,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) { sendError(res, error.message, 500); return; }

  sendSuccess(res, subject, 'Subject added', 201);
});

// ── GET /api/admin/subjects ───────────────────────────────────────────────────
/**
 * Get all subjects for this school.
 */
router.get('/subjects', async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('subjects')
    .select('*')
    .eq('school_id', req.user!.school_id!)
    .order('name');

  if (error) { sendError(res, error.message, 500); return; }
  sendSuccess(res, data ?? []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/classes ────────────────────────────────────────────────────
/**
 * Returns distinct classes and sections from the students table.
 * Used for dropdowns in the UI.
 */
router.get('/classes', async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('students')
    .select('class_name, section')
    .eq('school_id', req.user!.school_id!)
    .eq('is_deleted', false)
    .order('class_name')
    .order('section');

  if (error) { sendError(res, error.message, 500); return; }

  // Deduplicate class+section combinations
  const seen = new Set<string>();
  const classes = (data ?? []).reduce(
    (acc: { class_name: string; section: string }[], row: { class_name: string; section: string }) => {
      const key = `${row.class_name}||${row.section}`;
      if (!seen.has(key)) {
        seen.add(key);
        acc.push({ class_name: row.class_name, section: row.section });
      }
      return acc;
    },
    []
  );

  sendSuccess(res, classes);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/admin/announcements ─────────────────────────────────────────────
/**
 * Create an announcement.
 * - Inserts into announcements table.
 * - Creates in-app notifications for all parents in the school.
 * - Sends FCM push to all parents in batches of 100.
 * - Logs to audit_logs.
 */
router.post('/announcements', async (req: Request, res: Response) => {
  const schema = z.object({
    title:        z.string().min(1),
    message:      z.string().min(1),
    target_class: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const { title, message, target_class } = parsed.data;
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;
  const now      = new Date().toISOString();

  // Insert announcement
  const { data: announcement, error: annErr } = await supabaseAdmin
    .from('announcements')
    .insert({
      title,
      message,
      target_class: target_class ?? null,
      school_id:    schoolId,
      created_by:   adminId,
      created_at:   now,
    })
    .select()
    .single();

  if (annErr) { sendError(res, annErr.message, 500); return; }

  // Fetch all parents in this school
  let parentQuery = supabaseAdmin
    .from('users')
    .select('id, fcm_token')
    .eq('school_id', schoolId)
    .eq('role', 'parent');

  // If target_class is set, only notify parents of students in that class
  if (target_class) {
    const { data: classStudents } = await supabaseAdmin
      .from('students')
      .select('parent_id')
      .eq('school_id', schoolId)
      .eq('class_name', target_class)
      .eq('is_deleted', false)
      .not('parent_id', 'is', null);

    const parentIds = [...new Set(
      (classStudents ?? [])
        .map((s: { parent_id: string | null }) => s.parent_id)
        .filter(Boolean) as string[]
    )];

    if (parentIds.length === 0) {
      sendSuccess(res, announcement, 'Announcement created (no parents to notify)', 201);
      return;
    }

    parentQuery = parentQuery.in('id', parentIds);
  }

  const { data: parents } = await parentQuery;
  const allParents = parents ?? [];

  // Create in-app notifications for all parents
  if (allParents.length > 0) {
    const notifications = allParents.map((p: { id: string }) => ({
      title,
      body:         message,
      type:         'announcement',
      recipient_id: p.id,
      sender_id:    adminId,
      is_read:      false,
      created_at:   now,
    }));

    // Insert in chunks of 500 to avoid payload limits
    for (let i = 0; i < notifications.length; i += 500) {
      await supabaseAdmin.from('notifications').insert(notifications.slice(i, i + 500));
    }
  }

  // Send FCM push in batches of 100
  const firebaseApp = getFirebaseApp();
  if (firebaseApp) {
    const fcmParents = allParents.filter(
      (p: { id: string; fcm_token?: string | null }) => p.fcm_token
    );

    for (let i = 0; i < fcmParents.length; i += 100) {
      const batch = fcmParents.slice(i, i + 100);
      const tokens = batch.map((p: { fcm_token: string }) => p.fcm_token);

      try {
        await firebaseAdmin.messaging(firebaseApp).sendEachForMulticast({
          tokens,
          notification: { title, body: message },
          android: { priority: 'high' },
          apns:    { payload: { aps: { sound: 'default' } } },
        });
      } catch (fcmErr) {
        console.error('[fcm] Batch send failed:', fcmErr);
      }
    }
  }

  await logAudit(adminId, 'ANNOUNCEMENT_CREATED', 'announcements', {
    announcement_id: (announcement as Record<string, unknown>).id,
    title,
    target_class:    target_class ?? null,
    notified_count:  allParents.length,
    school_id:       schoolId,
  });

  sendSuccess(res, announcement, 'Announcement created and parents notified', 201);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

// ── PUT /api/admin/settings ───────────────────────────────────────────────────
/**
 * Update school settings (schools table + school_settings table).
 */
router.put('/settings', async (req: Request, res: Response) => {
  const schema = z.object({
    attendance_cutoff_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    school_name:            z.string().min(1).optional(),
    address:                z.string().min(1).optional(),
    phone:                  z.string().optional(),
    email:                  z.string().email().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }

  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;
  const now      = new Date().toISOString();

  // Fetch current school for old_value audit
  const { data: currentSchool } = await supabaseAdmin
    .from('schools')
    .select('*')
    .eq('id', schoolId)
    .single();

  // Update schools table if any school fields provided
  const schoolUpdates: Record<string, unknown> = {};
  if (parsed.data.school_name) schoolUpdates.name    = parsed.data.school_name;
  if (parsed.data.address)     schoolUpdates.address = parsed.data.address;
  if (parsed.data.phone)       schoolUpdates.phone   = parsed.data.phone;
  if (parsed.data.email)       schoolUpdates.email   = parsed.data.email;

  if (Object.keys(schoolUpdates).length > 0) {
    const { error: schoolErr } = await supabaseAdmin
      .from('schools')
      .update(schoolUpdates)
      .eq('id', schoolId);

    if (schoolErr) { sendError(res, schoolErr.message, 500); return; }
  }

  // Upsert school_settings if attendance_cutoff_time provided
  if (parsed.data.attendance_cutoff_time) {
    const { error: settingsErr } = await supabaseAdmin
      .from('school_settings')
      .upsert(
        {
          school_id:              schoolId,
          attendance_cutoff_time: parsed.data.attendance_cutoff_time,
          updated_at:             now,
        },
        { onConflict: 'school_id' }
      );

    if (settingsErr) { sendError(res, settingsErr.message, 500); return; }
  }

  await logAudit(adminId, 'SCHOOL_SETTINGS_UPDATED', 'schools', {
    school_id: schoolId,
    old_value: currentSchool,
    new_value: { ...schoolUpdates, attendance_cutoff_time: parsed.data.attendance_cutoff_time },
  });

  // Return merged updated data
  const { data: updatedSchool } = await supabaseAdmin
    .from('schools')
    .select('*')
    .eq('id', schoolId)
    .single();

  const { data: updatedSettings } = await supabaseAdmin
    .from('school_settings')
    .select('*')
    .eq('school_id', schoolId)
    .maybeSingle();

  sendSuccess(res, { school: updatedSchool, settings: updatedSettings }, 'Settings updated');
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATA EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/export ─────────────────────────────────────────────────────
/**
 * Export all school data as a ZIP containing:
 *   students.csv, attendance.csv, marks.csv, test_results.csv
 *
 * Uses only Node.js built-ins (zlib + Buffer) — no extra dependencies.
 * The ZIP is assembled manually using the DEFLATE-stored (method=0) format
 * so it works without installing archiver or jszip.
 */
router.get('/export', async (req: Request, res: Response) => {
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  // ── Fetch all data ──────────────────────────────────────────────────────────
  const [studentsRes, attendanceRes, marksRes, testsRes] = await Promise.all([
    supabaseAdmin
      .from('students')
      .select('id, full_name, class_name, section, roll_number, phone, photo_url, is_deleted, created_at')
      .eq('school_id', schoolId),
    supabaseAdmin
      .from('attendance')
      .select('id, student_id, date, status, source, created_at')
      .in(
        'student_id',
        (await supabaseAdmin.from('students').select('id').eq('school_id', schoolId))
          .data?.map((s: { id: string }) => s.id) ?? []
      ),
    supabaseAdmin
      .from('marks')
      .select('id, student_id, subject, score, max_score, term, exam_type, created_at')
      .in(
        'student_id',
        (await supabaseAdmin.from('students').select('id').eq('school_id', schoolId))
          .data?.map((s: { id: string }) => s.id) ?? []
      ),
    supabaseAdmin
      .from('tests')
      .select('id, title, subject, class_name, section, term, date, created_at')
      .eq('school_id', schoolId),
  ]);

  /** Convert an array of objects to a CSV string. */
  function toCsv(rows: Record<string, unknown>[]): string {
    if (!rows || rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const escape  = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    return [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
    ].join('\n');
  }

  const files: { name: string; content: Buffer }[] = [
    { name: 'students.csv',     content: Buffer.from(toCsv(studentsRes.data  ?? []), 'utf8') },
    { name: 'attendance.csv',   content: Buffer.from(toCsv(attendanceRes.data ?? []), 'utf8') },
    { name: 'marks.csv',        content: Buffer.from(toCsv(marksRes.data      ?? []), 'utf8') },
    { name: 'test_results.csv', content: Buffer.from(toCsv(testsRes.data      ?? []), 'utf8') },
  ];

  // ── Build a minimal ZIP (store method, no compression) ─────────────────────
  // ZIP spec: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
  const localHeaders: Buffer[] = [];
  const centralDirs:  Buffer[] = [];
  let   offset = 0;

  const crc32Table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();

  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  const dosDate = (() => {
    const d = new Date();
    return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  })();
  const dosTime = (() => {
    const d = new Date();
    return (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  })();

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const crc       = crc32(file.content);
    const size      = file.content.length;

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // compression (stored)
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);        // compressed size
    local.writeUInt32LE(size, 22);        // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    nameBytes.copy(local, 30);

    localHeaders.push(local);

    // Central directory entry (46 bytes + name)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);           // flags
    central.writeUInt16LE(0, 10);          // compression
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk start
    central.writeUInt16LE(0, 36);          // internal attr
    central.writeUInt32LE(0, 38);          // external attr
    central.writeUInt32LE(offset, 42);     // local header offset
    nameBytes.copy(central, 46);

    centralDirs.push(central);
    offset += local.length + size;
  }

  const centralDirBuf = Buffer.concat(centralDirs);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const parts: Buffer[] = [];
  for (let i = 0; i < files.length; i++) {
    parts.push(localHeaders[i], files[i].content);
  }
  parts.push(centralDirBuf, eocd);

  const zipBuffer = Buffer.concat(parts);

  await logAudit(adminId, 'DATA_EXPORTED', 'schools', { school_id: schoolId });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="school-export-${schoolId}.zip"`);
  res.setHeader('Content-Length', zipBuffer.length);
  res.end(zipBuffer);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ID CARD GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a minimal PDF for a single student ID card.
 * Uses raw PDF syntax — no external library required.
 *
 * Card contains: school name, student name, class, section, roll number, photo URL (as text).
 */
async function buildIdCardPdf(
  student: Record<string, unknown>,
  schoolName: string
): Promise<Buffer> {
  // Escape special PDF string characters
  const esc = (s: unknown) =>
    String(s ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const lines = [
    `School: ${esc(schoolName)}`,
    `Name:   ${esc(student.full_name)}`,
    `Class:  ${esc(student.class_name)}  Section: ${esc(student.section)}`,
    `Roll:   ${esc(student.roll_number)}`,
    `ID:     ${esc(student.id)}`,
    student.photo_url ? `Photo:  ${esc(student.photo_url)}` : '',
  ].filter(Boolean);

  // Build content stream
  let stream = 'BT\n/F1 12 Tf\n';
  stream += '50 750 Td\n';
  lines.forEach((line, i) => {
    if (i > 0) stream += `0 -20 Td\n`;
    stream += `(${line}) Tj\n`;
  });
  stream += 'ET\n';

  const streamBytes = Buffer.from(stream, 'latin1');
  const streamLen   = streamBytes.length;

  const objects: string[] = [];

  // obj 1: catalog
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  // obj 2: pages
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  // obj 3: page
  objects.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R ' +
    '/MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  );
  // obj 4: content stream
  objects.push(
    `4 0 obj\n<< /Length ${streamLen} >>\nstream\n${stream}endstream\nendobj\n`
  );
  // obj 5: font
  objects.push(
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  );

  const header  = '%PDF-1.4\n';
  const offsets: number[] = [];
  let   body    = '';

  for (let i = 0; i < objects.length; i++) {
    offsets.push(header.length + body.length);
    body += objects[i];
  }

  const xrefOffset = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(header + body + xref + trailer, 'latin1');
}

// ── GET /api/admin/students/:id/id-card ──────────────────────────────────────
/**
 * Generate a PDF ID card for a single student.
 * Returns the PDF buffer directly.
 */
router.get('/students/:id/id-card', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;

  const student = await getStudentInSchool(req.params.id as string, schoolId);
  if (!student) { sendError(res, 'Student not found', 404); return; }

  const { data: school } = await supabaseAdmin
    .from('schools')
    .select('name')
    .eq('id', schoolId)
    .single();

  const pdf = await buildIdCardPdf(student, (school as Record<string, unknown> | null)?.name as string ?? '');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="id-card-${req.params.id}.pdf"`
  );
  res.setHeader('Content-Length', pdf.length);
  res.end(pdf);
});

// ── GET /api/admin/students/id-cards/bulk ─────────────────────────────────────
/**
 * Generate all student ID cards as a ZIP of PDFs (one PDF per student).
 * Only includes non-deleted students.
 */
router.get('/students/id-cards/bulk', async (req: Request, res: Response) => {
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  const { data: school } = await supabaseAdmin
    .from('schools')
    .select('name')
    .eq('id', schoolId)
    .single();

  const schoolName = (school as Record<string, unknown> | null)?.name as string ?? '';

  const { data: students, error } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, roll_number, photo_url')
    .eq('school_id', schoolId)
    .eq('is_deleted', false)
    .order('class_name')
    .order('full_name');

  if (error) { sendError(res, error.message, 500); return; }
  if (!students || students.length === 0) {
    sendError(res, 'No students found', 404);
    return;
  }

  // Build PDF for each student
  const pdfFiles: { name: string; content: Buffer }[] = [];
  for (const student of students) {
    const pdf = await buildIdCardPdf(student as Record<string, unknown>, schoolName);
    pdfFiles.push({
      name:    `id-card-${(student as Record<string, unknown>).id}.pdf`,
      content: pdf,
    });
  }

  // ── Assemble ZIP (same store-method approach as /export) ───────────────────
  const crc32Table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();

  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  const dosDate = (() => {
    const d = new Date();
    return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  })();
  const dosTime = (() => {
    const d = new Date();
    return (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  })();

  const localHeaders: Buffer[] = [];
  const centralDirs:  Buffer[] = [];
  let   offset = 0;

  for (const file of pdfFiles) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const crc       = crc32(file.content);
    const size      = file.content.length;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    localHeaders.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralDirs.push(central);

    offset += local.length + size;
  }

  const centralDirBuf = Buffer.concat(centralDirs);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(pdfFiles.length, 8);
  eocd.writeUInt16LE(pdfFiles.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const parts: Buffer[] = [];
  for (let i = 0; i < pdfFiles.length; i++) {
    parts.push(localHeaders[i], pdfFiles[i].content);
  }
  parts.push(centralDirBuf, eocd);

  const zipBuffer = Buffer.concat(parts);

  await logAudit(adminId, 'ID_CARDS_BULK_GENERATED', 'students', {
    school_id: schoolId,
    count:     pdfFiles.length,
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="id-cards-${schoolId}.zip"`);
  res.setHeader('Content-Length', zipBuffer.length);
  res.end(zipBuffer);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/audit-logs ─────────────────────────────────────────────────
/**
 * Returns the last N audit log entries for this school.
 * Query params: limit (default 10, max 50)
 * Joins with users table to get actor name.
 */
router.get('/audit-logs', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '10', 10) || 10, 50);

  // Get all user IDs in this school first
  const { data: schoolUsers } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('school_id', schoolId);

  const userIds = (schoolUsers ?? []).map((u: { id: string }) => u.id);

  if (userIds.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('audit_logs')
    .select('id, user_id, action, table_name, details, created_at, users(name, role)')
    .in('user_id', userIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLAINTS (admin view)
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/complaints ─────────────────────────────────────────────────
/**
 * List all complaints for this school.
 * Optional ?status=pending|reviewed|resolved filter.
 * Joins submitter name/email for display.
 */
router.get('/complaints', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;
  const { status } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('complaints')
    .select('*, users!complaints_submitted_by_fkey(name, email)')
    .eq('school_id', schoolId)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) { sendError(res, error.message, 500); return; }

  sendSuccess(res, data ?? []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FEES (admin view)
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/fees ───────────────────────────────────────────────────────
/**
 * List fee records for all students in this school.
 * Optional filters: ?class_name=&section=&term=&academic_year=
 * Returns one row per student merged with their fee record (if any).
 */
router.get('/fees', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;
  const { class_name, section, term, academic_year } = req.query as Record<string, string>;

  // Fetch students scoped to this school
  let studentQuery = supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section')
    .eq('school_id', schoolId)
    .eq('is_deleted', false)
    .order('class_name')
    .order('full_name');

  if (class_name) studentQuery = studentQuery.ilike('class_name', class_name.trim());
  if (section)    studentQuery = studentQuery.ilike('section', section.trim());

  const { data: students, error: sErr } = await studentQuery;
  if (sErr) { sendError(res, sErr.message, 500); return; }
  if (!students || students.length === 0) { sendSuccess(res, []); return; }

  const studentIds = students.map((s: { id: string }) => s.id);

  // Fetch fee records for those students
  let feeQuery = supabaseAdmin
    .from('student_fees')
    .select('*')
    .in('student_id', studentIds);

  if (term)          feeQuery = feeQuery.eq('term', term);
  if (academic_year) feeQuery = feeQuery.eq('academic_year', academic_year);

  const { data: fees, error: fErr } = await feeQuery;
  if (fErr) { sendError(res, fErr.message, 500); return; }

  // Merge: one row per student with their fee status
  const feeMap = new Map((fees ?? []).map((f: { student_id: string }) => [f.student_id, f]));
  const result = students.map((s: { id: string; full_name: string; class_name: string; section: string }) => ({
    student_id: s.id,
    full_name:  s.full_name,
    class_name: s.class_name,
    section:    s.section,
    fee_record: feeMap.get(s.id) ?? null,
    fee_paid:   (feeMap.get(s.id) as { fee_paid?: boolean } | undefined)?.fee_paid ?? false,
  }));

  sendSuccess(res, result);
});

// ── POST /api/admin/request-deletion ─────────────────────────────────────────
/**
 * School admin requests deletion of their school account.
 * Sends a notification to all superadmins and logs the request.
 * The actual deletion is performed manually by a superadmin.
 */
router.post('/request-deletion', async (req: Request, res: Response) => {
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  // Fetch school info for the notification
  const { data: school } = await supabaseAdmin
    .from('schools')
    .select('name')
    .eq('id', schoolId)
    .single();

  const schoolName = (school as Record<string, unknown> | null)?.name as string ?? schoolId;

  // Fetch all superadmins to notify
  const { data: superAdmins } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('role', 'superadmin');

  const now = new Date().toISOString();

  // Create in-app notifications for all superadmins
  if (superAdmins && superAdmins.length > 0) {
    const notifications = superAdmins.map((sa: { id: string }) => ({
      title:        'School Deletion Request',
      body:         `School "${schoolName}" has requested account deletion. Please review and process.`,
      type:         'deletion_request',
      recipient_id: sa.id,
      sender_id:    adminId,
      is_read:      false,
      created_at:   now,
    }));

    await supabaseAdmin.from('notifications').insert(notifications);
  }

  await logAudit(adminId, 'SCHOOL_DELETION_REQUESTED', 'schools', {
    school_id:   schoolId,
    school_name: schoolName,
    requested_by: adminId,
    requested_at: now,
  });

  sendSuccess(res, null, 'Deletion request submitted. A super admin will contact you within 7 business days.');
});

export default router;
