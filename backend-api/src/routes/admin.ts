import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import * as firebaseAdmin from 'firebase-admin';
import type ExcelJS from 'exceljs';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import { generateTempPassword } from '../utils/password';
import { sendSMS } from '../services/smsService';

const router = Router();

// ── All routes require authentication + school_admin role ─────────────────────
router.use(authenticate);
router.use(requireRole('schooladmin'));

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    passwordHash = await bcrypt.hash(defaultPassword, 12);
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
      class:          normalizedClass,  // legacy NOT NULL column — keep in sync
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

  // ── Optimistic locking: detect concurrent edits ───────────────────────────
  const clientUpdatedAt = req.body.updated_at as string | undefined;
  if (clientUpdatedAt && existing.updated_at) {
    const existingTs = new Date(existing.updated_at as string).getTime();
    const clientTs   = new Date(clientUpdatedAt).getTime();
    if (existingTs !== clientTs) {
      sendError(
        res,
        'This record was modified by someone else. Please refresh and try again.',
        409
      );
      return;
    }
  }

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

  // Check email not already in use (exclude soft-deleted users)
  const { data: emailConflict } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', email.toLowerCase())
    .or('is_deleted.eq.false,is_deleted.is.null')
    .maybeSingle();

  if (emailConflict) {
    sendError(res, 'A user with this email already exists', 409);
    return;
  }

  const tempPassword = password ?? generateTempPassword();

  // Create Supabase auth user.
  // If a stale auth account exists (e.g. from a previously soft-deleted teacher),
  // hard-delete it first so we can re-create cleanly.
  let { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password:      tempPassword,
    email_confirm: true,
  });

  if (authErr && authErr.message?.toLowerCase().includes('already been registered')) {
    // Hard-delete the stale auth user. Query the users table first (soft-deleted rows
    // retain their auth UUID), then fall back to scanning listUsers if the row is gone.
    const { data: staleProfile } = await supabaseAdmin
      .from('users')
      .select('id')
      .ilike('email', email)
      .limit(1)
      .maybeSingle();

    if (staleProfile) {
      await supabaseAdmin.auth.admin.deleteUser(staleProfile.id);
      await supabaseAdmin.from('users').delete().eq('id', staleProfile.id);
    } else {
      const { data: page1 } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000, page: 1 });
      const staleAuth = page1?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (staleAuth) {
        await supabaseAdmin.auth.admin.deleteUser(staleAuth.id);
      }
    }

    const retry = await supabaseAdmin.auth.admin.createUser({
      email,
      password:      tempPassword,
      email_confirm: true,
    });
    authData = retry.data;
    authErr  = retry.error;
  }

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
      // NOTE: no created_at — that column does not exist in teacher_assignments
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
 * Export all school data as a clean, human-readable Excel (.xlsx) file.
 *
 * Sheets:
 *   1. Students Directory   — Roll No, Name, Class, Section, Parent Phone
 *   2. Marks Summary        — per-student marks with percentage, clean exam type labels
 *   3. Attendance Summary   — per-student totals + %, red highlight below 75%
 *   4. Class Performance    — one row per class with avg/high/low/below-40% stats
 *
 * Uses exceljs (already in dependencies).
 */
router.get('/export', async (req: Request, res: Response) => {
  const ExcelJS = await import('exceljs');
  const adminId  = req.user!.id;
  const schoolId = req.user!.school_id!;

  // ── Fetch school name ───────────────────────────────────────────────────────
  const { data: schoolRow } = await supabaseAdmin
    .from('schools')
    .select('name')
    .eq('id', schoolId)
    .maybeSingle();
  const schoolName = (schoolRow as Record<string, unknown> | null)?.name as string ?? 'School';

  // ── Fetch all students (active only) ───────────────────────────────────────
  const { data: students } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, roll_number, phone, phone_number')
    .eq('school_id', schoolId)
    .eq('is_deleted', false)
    .order('class_name')
    .order('section')
    .order('roll_number');

  const studentList = (students ?? []) as {
    id: string;
    full_name: string;
    class_name: string;
    section: string;
    roll_number: string | null;
    phone: string | null;
    phone_number: string | null;
  }[];

  const studentIds = studentList.map((s) => s.id);

  // Build a lookup map: student_id → student row
  const studentMap = new Map(studentList.map((s) => [s.id, s]));

  // ── Fetch marks & attendance in parallel ────────────────────────────────────
  const [marksRes, attendanceRes] = await Promise.all([
    studentIds.length > 0
      ? supabaseAdmin
          .from('marks')
          .select('student_id, subject, score, max_score, exam_type, term')
          .in('student_id', studentIds)
      : Promise.resolve({ data: [] }),
    studentIds.length > 0
      ? supabaseAdmin
          .from('attendance')
          .select('student_id, date, status')
          .in('student_id', studentIds)
      : Promise.resolve({ data: [] }),
  ]);

  const marksList = (marksRes.data ?? []) as {
    student_id: string;
    subject: string;
    score: number;
    max_score: number;
    exam_type: string;
    term: string;
  }[];

  const attendanceList = (attendanceRes.data ?? []) as {
    student_id: string;
    date: string;
    status: string;
  }[];

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const exportDate = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

  /** Capitalise exam_type codes into readable labels. */
  function examTypeLabel(raw: string): string {
    const map: Record<string, string> = {
      final:        'Final Exam',
      final_exam:   'Final Exam',
      mid_term:     'Mid Term',
      midterm:      'Mid Term',
      class_test:   'Class Test',
      classtest:    'Class Test',
      unit_test:    'Unit Test',
      unittest:     'Unit Test',
      quarterly:    'Quarterly',
      half_yearly:  'Half Yearly',
      halfyearly:   'Half Yearly',
      annual:       'Annual Exam',
    };
    return map[raw?.toLowerCase?.()] ?? raw?.replace(/_/g, ' ')?.replace(/\b\w/g, (c) => c.toUpperCase()) ?? '';
  }

  /** Shared header style — bold, white text, dark blue background. */
  const headerFill: ExcelJS.Fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' },
  };
  const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  const headerAlignment: Partial<ExcelJS.Alignment> = { vertical: 'middle', horizontal: 'center' };

  /** Apply header style to a row. */
  function styleHeaderRow(row: ExcelJS.Row, colCount: number): void {
    row.height = 22;
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      cell.fill      = headerFill;
      cell.font      = headerFont;
      cell.alignment = headerAlignment;
      cell.border    = {
        bottom: { style: 'thin', color: { argb: 'FFB0C4DE' } },
      };
    }
  }

  /** Write school name + export date banner into rows 1–2, return next row index. */
  function writeBanner(ws: ExcelJS.Worksheet, colCount: number): number {
    ws.mergeCells(1, 1, 1, Math.max(colCount, 4));
    const titleCell = ws.getCell('A1');
    titleCell.value     = schoolName;
    titleCell.font      = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle' };

    const dateCell = ws.getCell(1, colCount);
    dateCell.value     = `Exported: ${exportDate}`;
    dateCell.font      = { italic: true, size: 10, color: { argb: 'FF666666' } };
    dateCell.alignment = { horizontal: 'right', vertical: 'middle' };

    ws.getRow(1).height = 24;
    ws.getRow(2).height = 6; // spacer
    return 3; // data starts at row 3
  }

  // ── Build Workbook ──────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Eduvo';
  wb.created  = new Date();
  wb.modified = new Date();

  // ════════════════════════════════════════════════════════════════════════════
  // SHEET 1 — Students Directory
  // ════════════════════════════════════════════════════════════════════════════
  {
    const ws = wb.addWorksheet('Students Directory');
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    const cols = [
      { header: 'Roll Number',   key: 'roll',    width: 14 },
      { header: 'Student Name',  key: 'name',    width: 28 },
      { header: 'Class',         key: 'class',   width: 10 },
      { header: 'Section',       key: 'section', width: 10 },
      { header: 'Parent Phone',  key: 'phone',   width: 18 },
    ];
    ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));

    const startRow = writeBanner(ws, cols.length);
    const hRow = ws.getRow(startRow);
    hRow.values = ['', ...cols.map((c) => c.header)]; // offset by 1 for row number
    hRow.values = cols.map((c) => c.header);
    styleHeaderRow(hRow, cols.length);

    // Group by class+section, insert blank row between groups
    let lastGroup = '';
    let dataRowIdx = startRow + 1;

    for (const s of studentList) {
      const group = `${s.class_name}||${s.section}`;
      if (lastGroup && group !== lastGroup) {
        // blank separator row
        ws.getRow(dataRowIdx).height = 8;
        dataRowIdx++;
      }
      lastGroup = group;

      const row = ws.getRow(dataRowIdx);
      row.values = [
        s.roll_number ?? '',
        s.full_name,
        s.class_name,
        s.section,
        s.phone_number ?? s.phone ?? '',
      ];
      row.height = 18;

      // Zebra striping within each group
      const fillColor = dataRowIdx % 2 === 0 ? 'FFF0F4FA' : 'FFFFFFFF';
      for (let c = 1; c <= cols.length; c++) {
        const cell = row.getCell(c);
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
        cell.font      = { size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: c === 2 ? 'left' : 'center' };
      }
      dataRowIdx++;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SHEET 2 — Marks Summary
  // ════════════════════════════════════════════════════════════════════════════
  {
    const ws = wb.addWorksheet('Marks Summary');
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    const cols = [
      { header: 'Roll Number',     width: 14 },
      { header: 'Student Name',    width: 28 },
      { header: 'Class',           width: 10 },
      { header: 'Section',         width: 10 },
      { header: 'Subject',         width: 18 },
      { header: 'Exam Type',       width: 18 },
      { header: 'Marks Obtained',  width: 16 },
      { header: 'Maximum Marks',   width: 16 },
      { header: 'Percentage',      width: 14 },
      { header: 'Term',            width: 14 },
    ];
    ws.columns = cols.map((c, i) => ({ key: `c${i}`, width: c.width }));

    const startRow = writeBanner(ws, cols.length);
    const hRow = ws.getRow(startRow);
    hRow.values = cols.map((c) => c.header);
    styleHeaderRow(hRow, cols.length);

    // Sort marks by class → section → student name → subject
    const sortedMarks = [...marksList].sort((a, b) => {
      const sa = studentMap.get(a.student_id);
      const sb = studentMap.get(b.student_id);
      if (!sa || !sb) return 0;
      return (
        sa.class_name.localeCompare(sb.class_name) ||
        sa.section.localeCompare(sb.section) ||
        sa.full_name.localeCompare(sb.full_name) ||
        a.subject.localeCompare(b.subject)
      );
    });

    let dataRowIdx = startRow + 1;
    for (const m of sortedMarks) {
      const s = studentMap.get(m.student_id);
      if (!s) continue;

      const pct = m.max_score > 0
        ? Math.round((m.score / m.max_score) * 1000) / 10
        : 0;

      const row = ws.getRow(dataRowIdx);
      row.values = [
        s.roll_number ?? '',
        s.full_name,
        s.class_name,
        s.section,
        m.subject,
        examTypeLabel(m.exam_type),
        m.score,
        m.max_score,
        pct,
        m.term ?? '',
      ];
      row.height = 18;

      const fillColor = dataRowIdx % 2 === 0 ? 'FFF0F4FA' : 'FFFFFFFF';
      for (let c = 1; c <= cols.length; c++) {
        const cell = row.getCell(c);
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
        cell.font      = { size: 10 };
        cell.alignment = {
          vertical: 'middle',
          horizontal: (c === 2 || c === 5 || c === 6) ? 'left' : 'center',
        };
      }

      // Colour percentage cell: red if < 40, orange if < 75
      const pctCell = row.getCell(9);
      pctCell.numFmt = '0.0"%"';
      if (pct < 40) {
        pctCell.font = { size: 10, bold: true, color: { argb: 'FFCC0000' } };
      } else if (pct < 75) {
        pctCell.font = { size: 10, color: { argb: 'FFE06C00' } };
      } else {
        pctCell.font = { size: 10, color: { argb: 'FF1A7A1A' } };
      }

      dataRowIdx++;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SHEET 3 — Attendance Summary
  // ════════════════════════════════════════════════════════════════════════════
  {
    const ws = wb.addWorksheet('Attendance Summary');
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    const cols = [
      { header: 'Roll Number',    width: 14 },
      { header: 'Student Name',   width: 28 },
      { header: 'Class',          width: 10 },
      { header: 'Section',        width: 10 },
      { header: 'Total Days',     width: 12 },
      { header: 'Days Present',   width: 14 },
      { header: 'Days Absent',    width: 13 },
      { header: 'Attendance %',   width: 14 },
    ];
    ws.columns = cols.map((c, i) => ({ key: `c${i}`, width: c.width }));

    const startRow = writeBanner(ws, cols.length);
    const hRow = ws.getRow(startRow);
    hRow.values = cols.map((c) => c.header);
    styleHeaderRow(hRow, cols.length);

    // Aggregate attendance per student
    const attMap = new Map<string, { total: number; present: number }>();
    for (const a of attendanceList) {
      const existing = attMap.get(a.student_id) ?? { total: 0, present: 0 };
      existing.total++;
      if (a.status === 'present' || a.status === 'late') existing.present++;
      attMap.set(a.student_id, existing);
    }

    let dataRowIdx = startRow + 1;
    for (const s of studentList) {
      const att     = attMap.get(s.id) ?? { total: 0, present: 0 };
      const absent  = att.total - att.present;
      const pct     = att.total > 0 ? Math.round((att.present / att.total) * 1000) / 10 : 0;
      const lowAtt  = att.total > 0 && pct < 75;

      const row = ws.getRow(dataRowIdx);
      row.values = [
        s.roll_number ?? '',
        s.full_name,
        s.class_name,
        s.section,
        att.total,
        att.present,
        absent,
        pct,
      ];
      row.height = 18;

      const fillColor = lowAtt ? 'FFFFF0F0' : (dataRowIdx % 2 === 0 ? 'FFF0F4FA' : 'FFFFFFFF');
      for (let c = 1; c <= cols.length; c++) {
        const cell = row.getCell(c);
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
        cell.font      = { size: 10, color: { argb: lowAtt ? 'FF990000' : 'FF000000' } };
        cell.alignment = { vertical: 'middle', horizontal: c === 2 ? 'left' : 'center' };
      }

      // Percentage cell formatting
      const pctCell = row.getCell(8);
      pctCell.numFmt = '0.0"%"';
      if (lowAtt) {
        pctCell.font = { size: 10, bold: true, color: { argb: 'FFCC0000' } };
      }

      dataRowIdx++;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SHEET 4 — Class Performance Summary
  // ════════════════════════════════════════════════════════════════════════════
  {
    const ws = wb.addWorksheet('Class Performance');
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    const cols = [
      { header: 'Class',               width: 12 },
      { header: 'Section',             width: 10 },
      { header: 'Total Students',      width: 16 },
      { header: 'Avg Marks %',         width: 14 },
      { header: 'Highest Score %',     width: 16 },
      { header: 'Lowest Score %',      width: 15 },
      { header: 'Students Below 40%',  width: 18 },
    ];
    ws.columns = cols.map((c, i) => ({ key: `c${i}`, width: c.width }));

    const startRow = writeBanner(ws, cols.length);
    const hRow = ws.getRow(startRow);
    hRow.values = cols.map((c) => c.header);
    styleHeaderRow(hRow, cols.length);

    // Build per-class stats from marks
    type ClassStats = {
      classKey: string;
      class_name: string;
      section: string;
      studentSet: Set<string>;
      scores: number[];   // percentages per mark row
    };

    const classMap = new Map<string, ClassStats>();

    // Initialise every class from students list (so classes with no marks still appear)
    for (const s of studentList) {
      const key = `${s.class_name}||${s.section}`;
      if (!classMap.has(key)) {
        classMap.set(key, {
          classKey:   key,
          class_name: s.class_name,
          section:    s.section,
          studentSet: new Set(),
          scores:     [],
        });
      }
      classMap.get(key)!.studentSet.add(s.id);
    }

    for (const m of marksList) {
      const s = studentMap.get(m.student_id);
      if (!s) continue;
      const key = `${s.class_name}||${s.section}`;
      const entry = classMap.get(key);
      if (!entry) continue;
      if (m.max_score > 0) {
        entry.scores.push((m.score / m.max_score) * 100);
      }
    }

    // Sort by avg marks descending
    const classRows = [...classMap.values()].sort((a, b) => {
      const avgA = a.scores.length ? a.scores.reduce((x, y) => x + y, 0) / a.scores.length : 0;
      const avgB = b.scores.length ? b.scores.reduce((x, y) => x + y, 0) / b.scores.length : 0;
      return avgB - avgA;
    });

    let dataRowIdx = startRow + 1;
    for (const cl of classRows) {
      const avg     = cl.scores.length ? cl.scores.reduce((a, b) => a + b, 0) / cl.scores.length : 0;
      const highest = cl.scores.length ? Math.max(...cl.scores) : 0;
      const lowest  = cl.scores.length ? Math.min(...cl.scores) : 0;
      const below40 = cl.scores.filter((p) => p < 40).length;

      const row = ws.getRow(dataRowIdx);
      row.values = [
        cl.class_name,
        cl.section,
        cl.studentSet.size,
        Math.round(avg * 10) / 10,
        Math.round(highest * 10) / 10,
        Math.round(lowest * 10) / 10,
        below40,
      ];
      row.height = 20;

      const fillColor = dataRowIdx % 2 === 0 ? 'FFF0F4FA' : 'FFFFFFFF';
      for (let c = 1; c <= cols.length; c++) {
        const cell = row.getCell(c);
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
        cell.font      = { size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      // Format percentage columns
      for (const colIdx of [4, 5, 6]) {
        row.getCell(colIdx).numFmt = '0.0"%"';
      }

      // Highlight below-40 count in red if non-zero
      if (below40 > 0) {
        row.getCell(7).font = { size: 10, bold: true, color: { argb: 'FFCC0000' } };
      }

      dataRowIdx++;
    }
  }

  // ── Stream the workbook back ────────────────────────────────────────────────
  await logAudit(adminId, 'SCHOOL_DATA_EXPORTED', 'schools', { school_id: schoolId });

  // Sanitise school name for filename
  const safeName = schoolName.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
  const dateStr  = new Date().toISOString().slice(0, 10);
  const filename = `${safeName}_DataExport_${dateStr}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
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

// ═══════════════════════════════════════════════════════════════════════════════
// MONTHLY PERFORMANCE SNAPSHOT  (schooladmin only — never exposed to teachers,
// students, or parents; the entire /api/admin prefix already requires schooladmin)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/performance/monthly-snapshot?year=2026&month=6
 *
 * Returns three data sets for the selected calendar month:
 *   1. classRankings   — all classes ranked by average % (marks from that month)
 *   2. topStudents     — top 10 students school-wide by average %
 *   3. bottomStudents  — bottom 10 students school-wide by average %
 *
 * Only students / classes that have at least one mark entry in the selected
 * month are included.  Students with no marks that month are excluded entirely.
 *
 * Both the `marks` table (manual entries) and `test_attempts` scores are used
 * to compute a student's marks for the month.  Test attempt scores are already
 * mirrored into the `marks` table with notes = 'auto:attempt:...', so a single
 * pass over `marks` is sufficient — no double-counting.
 *
 * Ties: students / classes with the same average receive the same rank.
 */
router.get('/performance/monthly-snapshot', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;

  // ── Parse year / month ────────────────────────────────────────────────────
  const now = new Date();
  const rawYear  = parseInt((req.query.year  as string) ?? String(now.getFullYear()),  10);
  const rawMonth = parseInt((req.query.month as string) ?? String(now.getMonth() + 1), 10);

  if (
    isNaN(rawYear) || rawYear < 2000 || rawYear > 2100 ||
    isNaN(rawMonth) || rawMonth < 1 || rawMonth > 12
  ) {
    sendError(res, 'Invalid year or month parameter', 400);
    return;
  }

  // Build inclusive date range for the selected month
  const monthStart = new Date(rawYear, rawMonth - 1, 1);
  const monthEnd   = new Date(rawYear, rawMonth, 1); // exclusive upper bound

  const startIso = monthStart.toISOString();
  const endIso   = monthEnd.toISOString();

  // ── Fetch all non-deleted students for this school ────────────────────────
  const { data: students, error: studErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section')
    .eq('school_id', schoolId)
    .eq('is_deleted', false);

  if (studErr) { sendError(res, studErr.message, 500); return; }
  if (!students || students.length === 0) {
    sendSuccess(res, { classRankings: [], topStudents: [], bottomStudents: [], year: rawYear, month: rawMonth });
    return;
  }

  const studentIds = students.map((s: { id: string }) => s.id);

  // ── Fetch all marks for this school in the selected month ─────────────────
  // Supabase .in() supports up to ~1000 IDs directly; for very large schools
  // we chunk, but most schools stay well under that.
  const CHUNK = 900;
  let allMarks: Array<{ student_id: string; score: number; max_score: number }> = [];

  for (let i = 0; i < studentIds.length; i += CHUNK) {
    const chunk = studentIds.slice(i, i + CHUNK);
    const { data: chunkMarks, error: marksErr } = await supabaseAdmin
      .from('marks')
      .select('student_id, score, max_score')
      .in('student_id', chunk)
      .gte('created_at', startIso)
      .lt('created_at', endIso);

    if (marksErr) { sendError(res, marksErr.message, 500); return; }
    if (chunkMarks) allMarks = allMarks.concat(chunkMarks);
  }

  // ── Aggregate per-student totals ──────────────────────────────────────────
  type StudentAgg = {
    totalScore: number;
    totalMax:   number;
    markCount:  number;
  };

  const studentAgg = new Map<string, StudentAgg>();

  for (const m of allMarks) {
    const existing = studentAgg.get(m.student_id);
    if (existing) {
      existing.totalScore += Number(m.score);
      existing.totalMax   += Number(m.max_score);
      existing.markCount  += 1;
    } else {
      studentAgg.set(m.student_id, {
        totalScore: Number(m.score),
        totalMax:   Number(m.max_score),
        markCount:  1,
      });
    }
  }

  // ── Build student result rows (exclude students with no marks) ─────────────
  type StudentResultRow = {
    student_id:  string;
    full_name:   string;
    class_name:  string;
    section:     string | null;
    avg_pct:     number;
    mark_count:  number;
    rank:        number;
  };

  const studentResults: StudentResultRow[] = [];

  const studentMap = new Map(
    (students as Array<{ id: string; full_name: string; class_name: string; section: string | null }>)
      .map((s) => [s.id, s])
  );

  for (const [sid, agg] of studentAgg.entries()) {
    if (agg.totalMax === 0) continue; // safety guard against div-by-zero
    const s = studentMap.get(sid);
    if (!s) continue;

    studentResults.push({
      student_id: sid,
      full_name:  s.full_name,
      class_name: s.class_name,
      section:    s.section ?? null,
      avg_pct:    Math.round((agg.totalScore / agg.totalMax) * 1000) / 10, // 1dp
      mark_count: agg.markCount,
      rank:       0, // filled below
    });
  }

  // Sort descending by average percentage
  studentResults.sort((a, b) => b.avg_pct - a.avg_pct);

  // Assign ranks (ties share the same rank)
  let currentRank = 1;
  for (let i = 0; i < studentResults.length; i++) {
    if (i > 0 && studentResults[i].avg_pct < studentResults[i - 1].avg_pct) {
      currentRank = i + 1;
    }
    studentResults[i].rank = currentRank;
  }

  const topStudents    = studentResults.slice(0, 10);
  const bottomStudents = studentResults.slice(-10).reverse(); // worst → slightly better

  // Re-rank bottom students from the bottom (rank 1 = worst)
  const bottomRanked = [...bottomStudents];
  let bRank = 1;
  for (let i = 0; i < bottomRanked.length; i++) {
    if (i > 0 && bottomRanked[i].avg_pct > bottomRanked[i - 1].avg_pct) {
      bRank = i + 1;
    }
    bottomRanked[i] = { ...bottomRanked[i], rank: bRank };
  }

  // ── Aggregate per-class totals ────────────────────────────────────────────
  type ClassAgg = {
    totalScore: number;
    totalMax:   number;
    examCount:  number;   // unique (student, mark) tuples = total mark entries
    studentSet: Set<string>;
  };

  const classAgg = new Map<string, ClassAgg>();

  for (const m of allMarks) {
    const s = studentMap.get(m.student_id);
    if (!s) continue;
    const key = `${s.class_name}||${s.section ?? ''}`;
    const existing = classAgg.get(key);
    if (existing) {
      existing.totalScore += Number(m.score);
      existing.totalMax   += Number(m.max_score);
      existing.examCount  += 1;
      existing.studentSet.add(m.student_id);
    } else {
      classAgg.set(key, {
        totalScore: Number(m.score),
        totalMax:   Number(m.max_score),
        examCount:  1,
        studentSet: new Set([m.student_id]),
      });
    }
  }

  type ClassResultRow = {
    class_name:    string;
    section:       string | null;
    avg_pct:       number;
    exam_count:    number;
    student_count: number;
    rank:          number;
  };

  const classResults: ClassResultRow[] = [];

  for (const [key, agg] of classAgg.entries()) {
    if (agg.totalMax === 0) continue;
    const [class_name, section] = key.split('||');
    classResults.push({
      class_name,
      section:       section || null,
      avg_pct:       Math.round((agg.totalScore / agg.totalMax) * 1000) / 10,
      exam_count:    agg.examCount,
      student_count: agg.studentSet.size,
      rank:          0,
    });
  }

  classResults.sort((a, b) => b.avg_pct - a.avg_pct);

  let cRank = 1;
  for (let i = 0; i < classResults.length; i++) {
    if (i > 0 && classResults[i].avg_pct < classResults[i - 1].avg_pct) {
      cRank = i + 1;
    }
    classResults[i].rank = cRank;
  }

  sendSuccess(res, {
    year:          rawYear,
    month:         rawMonth,
    classRankings: classResults,
    topStudents,
    bottomStudents: bottomRanked,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER ACTIVITY REPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/teacher-activity?days=30
 *
 * Returns an activity summary for every teacher in this school over the last N
 * days (default 30, max 90).  Metrics per teacher:
 *   - tests_created     — tests created in the window
 *   - marks_entered     — mark rows recorded in the window
 *   - homework_assigned — homework assignments in the window
 *   - last_active_at    — most recent audit log timestamp for this teacher
 *
 * Response is sorted by last_active_at descending (most-active first).
 */
router.get('/teacher-activity', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;

  const rawDays = parseInt((req.query.days as string) ?? '30', 10);
  const days = isNaN(rawDays) || rawDays < 1 ? 30 : Math.min(rawDays, 90);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Fetch all teachers for this school
  const { data: teachers, error: tErr } = await supabaseAdmin
    .from('users')
    .select('id, name, email')
    .eq('school_id', schoolId)
    .eq('role', 'teacher')
    .or('is_deleted.is.null,is_deleted.eq.false');

  if (tErr) { sendError(res, tErr.message, 500); return; }
  if (!teachers || teachers.length === 0) { sendSuccess(res, []); return; }

  const teacherIds = teachers.map((t: { id: string }) => t.id);

  // Fetch tests created by teachers in this school within the window
  const { data: tests } = await supabaseAdmin
    .from('tests')
    .select('created_by, created_at')
    .eq('school_id', schoolId)
    .in('created_by', teacherIds)
    .gte('created_at', since);

  // Fetch marks recorded by teachers in the window
  const { data: marks } = await supabaseAdmin
    .from('marks')
    .select('recorded_by, created_at')
    .eq('school_id', schoolId)
    .in('recorded_by', teacherIds)
    .gte('created_at', since);

  // Fetch homework created by teachers in the window
  const { data: homework } = await supabaseAdmin
    .from('homework')
    .select('created_by, created_at')
    .eq('school_id', schoolId)
    .in('created_by', teacherIds)
    .gte('created_at', since);

  // Fetch most-recent audit log per teacher
  const { data: auditLogs } = await supabaseAdmin
    .from('audit_logs')
    .select('user_id, created_at')
    .in('user_id', teacherIds)
    .order('created_at', { ascending: false });

  // Build lookup maps
  const testsMap = new Map<string, number>();
  const marksMap = new Map<string, number>();
  const hwMap = new Map<string, number>();
  const lastActiveMap = new Map<string, string>();

  for (const t of (tests ?? []) as Array<{ created_by: string }>) {
    testsMap.set(t.created_by, (testsMap.get(t.created_by) ?? 0) + 1);
  }
  for (const m of (marks ?? []) as Array<{ recorded_by: string }>) {
    marksMap.set(m.recorded_by, (marksMap.get(m.recorded_by) ?? 0) + 1);
  }
  for (const h of (homework ?? []) as Array<{ created_by: string }>) {
    hwMap.set(h.created_by, (hwMap.get(h.created_by) ?? 0) + 1);
  }
  // Only keep first occurrence per teacher (already sorted desc)
  for (const log of (auditLogs ?? []) as Array<{ user_id: string; created_at: string }>) {
    if (!lastActiveMap.has(log.user_id)) lastActiveMap.set(log.user_id, log.created_at);
  }

  type TeacherActivityRow = {
    teacher_id:       string;
    name:             string;
    email:            string;
    tests_created:    number;
    marks_entered:    number;
    homework_assigned: number;
    last_active_at:   string | null;
  };

  const rows: TeacherActivityRow[] = (teachers as Array<{ id: string; name: string; email: string }>)
    .map((t) => ({
      teacher_id:        t.id,
      name:              t.name,
      email:             t.email,
      tests_created:     testsMap.get(t.id) ?? 0,
      marks_entered:     marksMap.get(t.id) ?? 0,
      homework_assigned: hwMap.get(t.id) ?? 0,
      last_active_at:    lastActiveMap.get(t.id) ?? null,
    }))
    .sort((a, b) => {
      if (!a.last_active_at && !b.last_active_at) return 0;
      if (!a.last_active_at) return 1;
      if (!b.last_active_at) return -1;
      return new Date(b.last_active_at).getTime() - new Date(a.last_active_at).getTime();
    });

  sendSuccess(res, { days, teachers: rows });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLASS-WISE COMPARATIVE REPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/class-comparison?year=2026&month=6
 *
 * Returns a side-by-side summary for every class/section with:
 *   - avg_marks_pct        — average marks % for the month
 *   - attendance_pct       — attendance % for the month
 *   - homework_completion  — % of students who submitted at least one homework
 *   - tests_conducted      — number of tests scheduled for that class
 *   - student_count        — total students enrolled
 *
 * Sorted by avg_marks_pct descending.
 */
router.get('/class-comparison', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;

  const now = new Date();
  const rawYear  = parseInt((req.query.year  as string) ?? String(now.getFullYear()),  10);
  const rawMonth = parseInt((req.query.month as string) ?? String(now.getMonth() + 1), 10);

  if (
    isNaN(rawYear) || rawYear < 2000 || rawYear > 2100 ||
    isNaN(rawMonth) || rawMonth < 1 || rawMonth > 12
  ) {
    sendError(res, 'Invalid year or month', 400);
    return;
  }

  const monthStart = new Date(rawYear, rawMonth - 1, 1).toISOString();
  const monthEnd   = new Date(rawYear, rawMonth, 1).toISOString();

  // Fetch students grouped by class/section
  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, class_name, section')
    .eq('school_id', schoolId)
    .eq('is_deleted', false);

  if (sErr) { sendError(res, sErr.message, 500); return; }
  if (!students || students.length === 0) {
    sendSuccess(res, { year: rawYear, month: rawMonth, classes: [] });
    return;
  }

  const studentIds = students.map((s: { id: string }) => s.id);
  const CHUNK = 900;

  // Parallel fetch: marks, attendance, homework submissions, tests
  const [marksRes, attendanceRes, hwRes, testsRes] = await Promise.all([
    // marks for the month
    (async () => {
      let all: Array<{ student_id: string; score: number; max_score: number }> = [];
      for (let i = 0; i < studentIds.length; i += CHUNK) {
        const { data } = await supabaseAdmin
          .from('marks')
          .select('student_id, score, max_score')
          .in('student_id', studentIds.slice(i, i + CHUNK))
          .gte('created_at', monthStart)
          .lt('created_at', monthEnd);
        if (data) all = all.concat(data);
      }
      return all;
    })(),
    // attendance for the month
    (async () => {
      let all: Array<{ student_id: string; status: string }> = [];
      for (let i = 0; i < studentIds.length; i += CHUNK) {
        const { data } = await supabaseAdmin
          .from('attendance')
          .select('student_id, status')
          .in('student_id', studentIds.slice(i, i + CHUNK))
          .gte('date', monthStart.slice(0, 10))
          .lt('date', monthEnd.slice(0, 10));
        if (data) all = all.concat(data);
      }
      return all;
    })(),
    // homework submissions (student submitted at least one in the month)
    (async () => {
      let all: Array<{ student_id: string }> = [];
      for (let i = 0; i < studentIds.length; i += CHUNK) {
        const { data } = await supabaseAdmin
          .from('homework_submissions')
          .select('student_id')
          .in('student_id', studentIds.slice(i, i + CHUNK))
          .gte('submitted_at', monthStart)
          .lt('submitted_at', monthEnd);
        if (data) all = all.concat(data);
      }
      return all;
    })(),
    // tests conducted
    supabaseAdmin
      .from('tests')
      .select('class_name, section')
      .eq('school_id', schoolId)
      .gte('date', monthStart.slice(0, 10))
      .lt('date', monthEnd.slice(0, 10)),
  ]);

  // Build student lookup map
  const studentMap = new Map(
    (students as Array<{ id: string; class_name: string; section: string }>)
      .map((s) => [s.id, s])
  );

  // Aggregate by class key
  type ClassAgg = {
    class_name:     string;
    section:        string;
    studentSet:     Set<string>;
    markScores:     number[];
    attTotal:       number;
    attPresent:     number;
    hwStudents:     Set<string>;
    testsCount:     number;
  };

  const classMap = new Map<string, ClassAgg>();

  // Initialise from students
  for (const s of students as Array<{ id: string; class_name: string; section: string }>) {
    const key = `${s.class_name}||${s.section}`;
    if (!classMap.has(key)) {
      classMap.set(key, {
        class_name: s.class_name,
        section: s.section,
        studentSet: new Set(),
        markScores: [],
        attTotal: 0,
        attPresent: 0,
        hwStudents: new Set(),
        testsCount: 0,
      });
    }
    classMap.get(key)!.studentSet.add(s.id);
  }

  // Marks
  for (const m of (marksRes ?? []) as Array<{ student_id: string; score: number; max_score: number }>) {
    const s = studentMap.get(m.student_id);
    if (!s || m.max_score <= 0) continue;
    const key = `${s.class_name}||${s.section}`;
    classMap.get(key)?.markScores.push((Number(m.score) / Number(m.max_score)) * 100);
  }

  // Attendance
  for (const a of (attendanceRes ?? []) as Array<{ student_id: string; status: string }>) {
    const s = studentMap.get(a.student_id);
    if (!s) continue;
    const key = `${s.class_name}||${s.section}`;
    const agg = classMap.get(key);
    if (!agg) continue;
    agg.attTotal++;
    if (a.status === 'present' || a.status === 'late') agg.attPresent++;
  }

  // Homework submissions
  for (const h of (hwRes ?? []) as Array<{ student_id: string }>) {
    const s = studentMap.get(h.student_id);
    if (!s) continue;
    const key = `${s.class_name}||${s.section}`;
    classMap.get(key)?.hwStudents.add(h.student_id);
  }

  // Tests
  for (const t of ((testsRes.data ?? []) as Array<{ class_name: string; section: string }>)) {
    const key = `${t.class_name}||${t.section}`;
    const agg = classMap.get(key);
    if (agg) agg.testsCount++;
  }

  // Build result
  const classes = [...classMap.values()]
    .map((agg) => {
      const avgMarksPct = agg.markScores.length
        ? Math.round((agg.markScores.reduce((a, b) => a + b, 0) / agg.markScores.length) * 10) / 10
        : null;
      const attendancePct = agg.attTotal > 0
        ? Math.round((agg.attPresent / agg.attTotal) * 1000) / 10
        : null;
      const hwCompletion = agg.studentSet.size > 0
        ? Math.round((agg.hwStudents.size / agg.studentSet.size) * 1000) / 10
        : null;
      return {
        class_name:          agg.class_name,
        section:             agg.section,
        student_count:       agg.studentSet.size,
        avg_marks_pct:       avgMarksPct,
        attendance_pct:      attendancePct,
        homework_completion: hwCompletion,
        tests_conducted:     agg.testsCount,
      };
    })
    .sort((a, b) => {
      // Sort by avg marks desc; null values go to bottom
      if (a.avg_marks_pct === null && b.avg_marks_pct === null) return 0;
      if (a.avg_marks_pct === null) return 1;
      if (b.avg_marks_pct === null) return -1;
      return b.avg_marks_pct - a.avg_marks_pct;
    });

  sendSuccess(res, { year: rawYear, month: rawMonth, classes });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AT-RISK STUDENTS DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/at-risk
 *
 * Returns students flagged as "at-risk" based on academic flags only:
 *   - low_attendance  : attendance % < 75%
 *   - low_marks       : average marks % < 40%
 *
 * A student is at-risk when either flag is triggered (score >= 1).
 * High risk = both flags (score 2), Medium risk = one flag (score 1).
 * Sorted by risk_score desc, then avg_marks_pct asc (worst first).
 */
router.get('/at-risk', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;
  const CHUNK = 900;

  // 1. Fetch all non-deleted students for this school
  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section')
    .eq('school_id', schoolId)
    .eq('is_deleted', false);

  if (sErr) { sendError(res, sErr.message, 500); return; }
  if (!students || students.length === 0) {
    sendSuccess(res, { total_at_risk: 0, students: [] });
    return;
  }

  const studentIds = students.map((s: { id: string }) => s.id);

  // 2. Fetch attendance and marks in parallel (chunked for large schools)
  const [attendanceRows, marksRows] = await Promise.all([
    // Attendance
    (async () => {
      let all: Array<{ student_id: string; status: string }> = [];
      for (let i = 0; i < studentIds.length; i += CHUNK) {
        const { data } = await supabaseAdmin
          .from('attendance')
          .select('student_id, status')
          .in('student_id', studentIds.slice(i, i + CHUNK));
        if (data) all = all.concat(data);
      }
      return all;
    })(),
    // Marks
    (async () => {
      let all: Array<{ student_id: string; score: number; max_score: number }> = [];
      for (let i = 0; i < studentIds.length; i += CHUNK) {
        const { data } = await supabaseAdmin
          .from('marks')
          .select('student_id, score, max_score')
          .in('student_id', studentIds.slice(i, i + CHUNK));
        if (data) all = all.concat(data);
      }
      return all;
    })(),
  ]);

  // 3. Build per-student aggregates
  type AttAgg = { total: number; present: number };
  type MarksAgg = { totalScore: number; totalMax: number };

  const attMap = new Map<string, AttAgg>();
  const marksMap = new Map<string, MarksAgg>();

  for (const a of attendanceRows) {
    const existing = attMap.get(a.student_id) ?? { total: 0, present: 0 };
    existing.total++;
    if (a.status === 'present' || a.status === 'late') existing.present++;
    attMap.set(a.student_id, existing);
  }

  for (const m of marksRows) {
    if (Number(m.max_score) <= 0) continue;
    const existing = marksMap.get(m.student_id) ?? { totalScore: 0, totalMax: 0 };
    existing.totalScore += Number(m.score);
    existing.totalMax   += Number(m.max_score);
    marksMap.set(m.student_id, existing);
  }

  // 4. Compute risk flags per student (academic only)
  type AtRiskRow = {
    student_id:     string;
    full_name:      string;
    class_name:     string;
    section:        string;
    risk_score:     number;
    low_attendance: boolean;
    low_marks:      boolean;
    attendance_pct: number;
    avg_marks_pct:  number;
  };

  const atRiskList: AtRiskRow[] = [];

  for (const s of students as Array<{ id: string; full_name: string; class_name: string; section: string }>) {
    // Attendance flag
    const att = attMap.get(s.id);
    let attendancePct = 100; // no records = assume fine
    let low_attendance = false;
    if (att && att.total > 0) {
      attendancePct = Math.round((att.present / att.total) * 1000) / 10;
      low_attendance = attendancePct < 75;
    }

    // Marks flag
    const marks = marksMap.get(s.id);
    let avgMarksPct = 100; // no records = assume fine
    let low_marks = false;
    if (marks && marks.totalMax > 0) {
      avgMarksPct = Math.round((marks.totalScore / marks.totalMax) * 1000) / 10;
      low_marks = avgMarksPct < 40;
    }

    const riskScore = (low_attendance ? 1 : 0) + (low_marks ? 1 : 0);

    if (riskScore >= 1) {
      atRiskList.push({
        student_id:     s.id,
        full_name:      s.full_name,
        class_name:     s.class_name,
        section:        s.section,
        risk_score:     riskScore,
        low_attendance,
        low_marks,
        attendance_pct: attendancePct,
        avg_marks_pct:  avgMarksPct,
      });
    }
  }

  // Sort: risk_score desc, then avg_marks_pct asc
  atRiskList.sort((a, b) => {
    if (b.risk_score !== a.risk_score) return b.risk_score - a.risk_score;
    return a.avg_marks_pct - b.avg_marks_pct;
  });

  sendSuccess(res, { total_at_risk: atRiskList.length, students: atRiskList });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHOOL HEALTH SCORE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/health-score
 *
 * Computes a composite 0–100 school health score from 4 components (25 pts each):
 *   1. Attendance       — avg attendance % across all students this calendar month
 *   2. Marks            — avg marks % across all marks entered this calendar month
 *   3. Test Participation — % of eligible students who attempted tests assigned this month
 *                          (if no tests assigned → full 25 pts)
 *   4. Engagement       — % of teachers who have ≥1 audit log entry in the last 14 days
 *
 * Grade: 90–100=A+, 80–89=A, 70–79=B, 60–69=C, below 60=D
 */
router.get('/health-score', async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id!;
  const CHUNK = 900;
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const monthStart = new Date(year, month - 1, 1).toISOString();
  const monthEnd   = new Date(year, month, 1).toISOString();
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // 1. All active students
  const { data: students, error: sErr } = await supabaseAdmin
    .from('students')
    .select('id, class_name, section')
    .eq('school_id', schoolId)
    .eq('is_deleted', false);

  if (sErr) { sendError(res, sErr.message, 500); return; }

  const studentIds = (students ?? []).map((s: { id: string; class_name?: string; section?: string }) => s.id);
  const totalStudents = studentIds.length;

  // 2. All teachers
  const { data: teachers, error: tErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('school_id', schoolId)
    .eq('role', 'teacher')
    .or('is_deleted.is.null,is_deleted.eq.false');

  if (tErr) { sendError(res, tErr.message, 500); return; }

  const teacherIds = (teachers ?? []).map((t: { id: string }) => t.id);
  const totalTeachers = teacherIds.length;

  // 3. Parallel fetch: attendance this month, marks this month, fees, teacher audit logs
  const [attendanceRows, marksRows, testRows, auditRows] = await Promise.all([
    // Attendance this month
    (async () => {
      let all: Array<{ student_id: string; status: string }> = [];
      for (let i = 0; i < studentIds.length; i += CHUNK) {
        const { data } = await supabaseAdmin
          .from('attendance')
          .select('student_id, status')
          .in('student_id', studentIds.slice(i, i + CHUNK))
          .gte('date', monthStart.slice(0, 10))
          .lt('date', monthEnd.slice(0, 10));
        if (data) all = all.concat(data);
      }
      return all;
    })(),
    // Marks this month
    (async () => {
      let all: Array<{ score: number; max_score: number }> = [];
      for (let i = 0; i < studentIds.length; i += CHUNK) {
        const { data } = await supabaseAdmin
          .from('marks')
          .select('score, max_score')
          .in('student_id', studentIds.slice(i, i + CHUNK))
          .gte('created_at', monthStart)
          .lt('created_at', monthEnd);
        if (data) all = all.concat(data);
      }
      return all;
    })(),
    // Tests this month for this school (for participation rate)
    (async () => {
      const { data } = await supabaseAdmin
        .from('tests')
        .select('id, class, section')
        .eq('school_id', schoolId)
        .gte('date', monthStart.slice(0, 10))
        .lt('date', monthEnd.slice(0, 10));
      return (data ?? []) as Array<{ id: string; class: string; section: string }>;
    })(),
    // Teacher audit logs in last 14 days
    (async () => {
      if (teacherIds.length === 0) return [];
      let all: Array<{ user_id: string }> = [];
      for (let i = 0; i < teacherIds.length; i += CHUNK) {
        const { data } = await supabaseAdmin
          .from('audit_logs')
          .select('user_id')
          .in('user_id', teacherIds.slice(i, i + CHUNK))
          .gte('created_at', twoWeeksAgo);
        if (data) all = all.concat(data);
      }
      return all;
    })(),
  ]);

  // ── Compute each component ────────────────────────────────────────────────

  // Attendance: per-student average then school average
  const attByStudent = new Map<string, { total: number; present: number }>();
  for (const a of attendanceRows) {
    const existing = attByStudent.get(a.student_id) ?? { total: 0, present: 0 };
    existing.total++;
    if (a.status === 'present' || a.status === 'late') existing.present++;
    attByStudent.set(a.student_id, existing);
  }
  let attPct = 0;
  if (attByStudent.size > 0) {
    const perStudentPcts = [...attByStudent.values()].map((a) =>
      a.total > 0 ? (a.present / a.total) * 100 : 0
    );
    attPct = perStudentPcts.reduce((s, p) => s + p, 0) / perStudentPcts.length;
  }
  const attScore = Math.round((attPct / 100) * 25);

  // Marks: average across all entries
  let marksPct = 0;
  const validMarks = marksRows.filter((m) => Number(m.max_score) > 0);
  if (validMarks.length > 0) {
    const totalObtained = validMarks.reduce((s, m) => s + Number(m.score), 0);
    const totalMax = validMarks.reduce((s, m) => s + Number(m.max_score), 0);
    marksPct = totalMax > 0 ? (totalObtained / totalMax) * 100 : 0;
  }
  const marksScore = Math.round((marksPct / 100) * 25);

  // Test participation: % of eligible students who attempted tests this month
  // If no tests were assigned this month → full score (not penalized)
  let testPct = 100;
  const monthTests = testRows as Array<{ id: string; class: string; section: string }>;
  if (monthTests.length > 0) {
    let totalEligible = 0;
    let totalAttempted = 0;

    for (const test of monthTests) {
      // Count students in this test's class+section
      const eligible = (students ?? []).filter(
        (s: { id: string; class_name?: string; section?: string }) =>
          s.class_name === test.class && s.section === test.section
      );
      const eligibleIds = eligible.map((s: { id: string }) => s.id);
      if (eligibleIds.length === 0) continue;

      // Count how many of those students have a test_attempt row for this test
      let attempted = 0;
      for (let i = 0; i < eligibleIds.length; i += CHUNK) {
        const { count } = await supabaseAdmin
          .from('test_attempts')
          .select('id', { count: 'exact', head: true })
          .eq('test_id', test.id)
          .in('student_id', eligibleIds.slice(i, i + CHUNK));
        attempted += count ?? 0;
      }

      totalEligible += eligibleIds.length;
      totalAttempted += attempted;
    }

    testPct = totalEligible > 0 ? (totalAttempted / totalEligible) * 100 : 100;
  }
  const testScore = Math.round((testPct / 100) * 25);

  // Engagement: % of teachers with ≥1 audit log in last 14 days
  let engPct = 0;
  if (totalTeachers > 0) {
    const activeTeachers = new Set((auditRows as Array<{ user_id: string }>).map((r) => r.user_id));
    engPct = (activeTeachers.size / totalTeachers) * 100;
  }
  const engScore = Math.round((engPct / 100) * 25);

  const healthScore = attScore + marksScore + testScore + engScore;

  // Grade
  let grade: string;
  if (healthScore >= 90) grade = 'A+';
  else if (healthScore >= 80) grade = 'A';
  else if (healthScore >= 70) grade = 'B';
  else if (healthScore >= 60) grade = 'C';
  else grade = 'D';

  sendSuccess(res, {
    health_score: healthScore,
    grade,
    components: {
      attendance: {
        score: attScore,
        max: 25,
        pct: Math.round(attPct * 10) / 10,
        label: 'Attendance',
      },
      marks: {
        score: marksScore,
        max: 25,
        pct: Math.round(marksPct * 10) / 10,
        label: 'Academic Performance',
      },
      tests: {
        score: testScore,
        max: 25,
        pct: Math.round(testPct * 10) / 10,
        label: 'Test Participation',
      },
      engagement: {
        score: engScore,
        max: 25,
        pct: Math.round(engPct * 10) / 10,
        label: 'Teacher Engagement',
      },
    },
    month,
    year,
  });
});

export default router;
