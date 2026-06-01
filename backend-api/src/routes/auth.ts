/**
 * auth.ts — Authentication routes for Eduvo
 *
 * Staff  (superadmin / schooladmin / teacher): email + password → Supabase Auth JWT
 * Student (and parents using child's account): phone_number + password → custom JWT
 *
 * Token shape:
 *   Staff   → Supabase session token  (type: "staff"   in our custom JWT wrapper is NOT used here;
 *              the Supabase token itself is returned and verified via supabase.auth.getUser())
 *   Student → custom JWT signed with JWT_SECRET  { type: "student", sub: student.id, school_id }
 *
 * Routes:
 *   POST /api/auth/login/staff            — staff login
 *   POST /api/auth/login/student          — student (+ parent) login
 *   POST /api/auth/student/change-password — student changes own password
 *   POST /api/auth/student/reset-password  — school_admin resets a student's password
 *   GET  /api/auth/me                     — restore any session
 *   POST /api/auth/logout                 — sign out
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { supabase, supabaseAdmin } from '../config/supabase';
import { loginRateLimit, studentLoginRateLimit } from '../middleware/rateLimit';
import {
  authenticate,
  authenticateStudent,
  authenticateAny,
} from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

const BCRYPT_ROUNDS = 10;
const STUDENT_TOKEN_TTL = '7d'; // students stay logged in for 7 days

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a row to audit_logs. Failures are swallowed so they never break a request. */
async function logAudit(
  userId: string | null,
  action: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      action,
      details,
      created_at: new Date().toISOString(),
    });
  } catch {
    // audit failure must never crash the request
  }
}

/** Sign a student JWT. Requires JWT_SECRET in env. */
function signStudentToken(studentId: string, schoolId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { type: 'student', sub: studentId, school_id: schoolId },
    secret,
    { expiresIn: STUDENT_TOKEN_TTL }
  );
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const staffLoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const studentLoginSchema = z.object({
  phone_number: z.string().min(5).max(20),
  password: z.string().min(1).max(128),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: z.string().min(6).max(128),
});

const resetPasswordSchema = z.object({
  student_id: z.string().uuid(),
});

// ── POST /api/auth/login/staff ────────────────────────────────────────────────

/**
 * Staff login: superadmin, schooladmin, teacher.
 * Uses Supabase Auth (email + password).
 * Returns a Supabase session token — verified on subsequent requests via
 * supabase.auth.getUser() inside the `authenticate` middleware.
 *
 * Rate limit: 10 attempts / hour per email.
 * Account lock: handled by the rate limiter (no DB-level lock needed since
 * Supabase Auth already throttles repeated failures server-side).
 */
router.post('/login/staff', loginRateLimit, async (req: Request, res: Response) => {
  const parsed = staffLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { email, password } = parsed.data;

  // 1. Authenticate with Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError || !authData.session) {
    // Log failed attempt (user_id unknown at this point — log by email in details)
    await logAudit(null, 'STAFF_LOGIN_FAILED', { email, reason: authError?.message ?? 'no session' });
    sendError(res, 'Invalid email or password', 401);
    return;
  }

  const { user: authUser, session } = authData;

  // 2. Fetch profile — role lives here, never in the JWT
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id')
    .eq('id', authUser.id)
    .single();

  if (profileError || !profile) {
    await logAudit(authUser.id, 'STAFF_LOGIN_FAILED', { email, reason: 'profile_not_found' });
    sendError(res, 'Account not set up. Contact your administrator.', 403);
    return;
  }

  if ((profile as Record<string, unknown>).is_deleted === true) {
    await logAudit(authUser.id, 'STAFF_LOGIN_FAILED', { email, reason: 'account_deleted' });
    sendError(res, 'This account has been deactivated.', 403);
    return;
  }

  await logAudit(authUser.id, 'STAFF_LOGIN_SUCCESS', { email, role: profile.role });

  sendSuccess(res, {
    token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    token_type: 'staff',
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
      school_id: profile.school_id ?? null,
    },
  });
});

// ── POST /api/auth/login/student ──────────────────────────────────────────────

/**
 * Student login (parents use the same endpoint with their child's credentials).
 * Uses bcrypt to verify the password stored in students.password_hash.
 * Returns a custom JWT signed with JWT_SECRET.
 *
 * Rate limit: 10 attempts / hour per phone_number.
 */
router.post('/login/student', studentLoginRateLimit, async (req: Request, res: Response) => {
  const parsed = studentLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { phone_number, password } = parsed.data;

  // 1. Look up student by phone_number
  const { data: student, error: studentError } = await supabaseAdmin
    .from('students')
    .select('id, name, phone_number, class_name, section, school_id, password_hash, is_first_login')
    .eq('phone_number', phone_number)
    .single();

  if (studentError || !student) {
    await logAudit(null, 'STUDENT_LOGIN_FAILED', {
      reason: 'student_not_found',
    });
    // Generic message — don't reveal whether the phone exists
    sendError(res, 'Invalid phone number or password', 401);
    return;
  }

  // 2. Verify password
  if (!student.password_hash) {
    await logAudit(student.id, 'STUDENT_LOGIN_FAILED', {
      reason: 'no_password_set',
    });
    sendError(res, 'Password not set. Contact your school administrator.', 403);
    return;
  }

  const passwordMatch = await bcrypt.compare(password, student.password_hash);
  if (!passwordMatch) {
    await logAudit(student.id, 'STUDENT_LOGIN_FAILED', {
      reason: 'wrong_password',
    });
    sendError(res, 'Invalid phone number or password', 401);
    return;
  }

  // 3. Sign custom JWT
  let token: string;
  try {
    token = signStudentToken(student.id, student.school_id);
  } catch {
    sendError(res, 'Server misconfiguration: JWT_SECRET not set', 500);
    return;
  }

  await logAudit(student.id, 'STUDENT_LOGIN_SUCCESS', {});

  sendSuccess(res, {
    token,
    token_type: 'student',
    must_change_password: student.is_first_login === true,
    student: {
      id: student.id,
      name: student.name,
      class: student.class_name,
      section: student.section,
      school_id: student.school_id,
    },
  });
});

// ── POST /api/auth/student/change-password ────────────────────────────────────

/**
 * Student changes their own password.
 * Requires a valid student token.
 *
 * Rules:
 *  - New password must be ≥ 6 characters (enforced by Zod)
 *  - Cannot be the same as the current password
 *  - Cannot be the last 5 digits of the student's phone number
 *    (prevents students from keeping the default password without changing it)
 */
router.post(
  '/student/change-password',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { current_password, new_password } = parsed.data;
    const studentId = req.student!.id;

    // 1. Fetch current password_hash and phone_number
    const { data: student, error } = await supabaseAdmin
      .from('students')
      .select('id, phone_number, password_hash')
      .eq('id', studentId)
      .single();

    if (error || !student) {
      sendError(res, 'Student not found', 404);
      return;
    }

    if (!student.password_hash) {
      sendError(res, 'No password set. Contact your school administrator.', 400);
      return;
    }

    // 2. Verify current password
    const currentMatch = await bcrypt.compare(current_password, student.password_hash);
    if (!currentMatch) {
      sendError(res, 'Current password is incorrect', 401);
      return;
    }

    // 3. New password cannot be the same as current
    const sameAsCurrent = await bcrypt.compare(new_password, student.password_hash);
    if (sameAsCurrent) {
      sendError(res, 'New password cannot be the same as your current password', 400);
      return;
    }

    // 4. New password cannot be the last 5 digits of the phone number
    const phone = (student.phone_number ?? '').replace(/\D/g, ''); // digits only
    const last5 = phone.slice(-5);
    if (last5.length === 5 && new_password === last5) {
      sendError(
        res,
        'Password cannot be the last 5 digits of your phone number. Please choose a different password.',
        400
      );
      return;
    }

    // 5. Hash and save
    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

    const { error: updateError } = await supabaseAdmin
      .from('students')
      .update({ password_hash: newHash, is_first_login: false })
      .eq('id', studentId);

    if (updateError) {
      sendError(res, 'Failed to update password. Please try again.', 500);
      return;
    }

    await logAudit(studentId, 'STUDENT_PASSWORD_CHANGED', { student_id: studentId });

    sendSuccess(res, null, 'Password changed successfully');
  }
);

// ── POST /api/auth/student/reset-password ─────────────────────────────────────

/**
 * School admin resets a student's password back to the default
 * (last 5 digits of their phone number) and sets is_first_login = true.
 *
 * Requires: school_admin token.
 * The student must belong to the admin's school.
 */
router.post(
  '/student/reset-password',
  authenticate,
  requireRole('schooladmin'),
  async (req: Request, res: Response) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { student_id } = parsed.data;
    const admin = req.user!;

    // 1. Fetch student — verify they belong to this admin's school
    const { data: student, error } = await supabaseAdmin
      .from('students')
      .select('id, phone_number, school_id')
      .eq('id', student_id)
      .single();

    if (error || !student) {
      sendError(res, 'Student not found', 404);
      return;
    }

    if (student.school_id !== admin.school_id) {
      sendError(res, 'You can only reset passwords for students in your school', 403);
      return;
    }

    // 2. Derive default password: last 5 digits of phone
    const phone = (student.phone_number ?? '').replace(/\D/g, '');
    const defaultPassword = phone.slice(-5);

    if (defaultPassword.length < 5) {
      sendError(
        res,
        'Cannot reset password: student phone number is missing or too short',
        400
      );
      return;
    }

    // 3. Hash and save
    const newHash = await bcrypt.hash(defaultPassword, BCRYPT_ROUNDS);

    const { error: updateError } = await supabaseAdmin
      .from('students')
      .update({ password_hash: newHash, is_first_login: true })
      .eq('id', student_id);

    if (updateError) {
      sendError(res, 'Failed to reset password. Please try again.', 500);
      return;
    }

    await logAudit(admin.id, 'STUDENT_PASSWORD_RESET', {
      admin_id: admin.id,
      student_id,
      school_id: admin.school_id,
    });

    sendSuccess(res, null, 'Password reset to default successfully');
  }
);

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

/**
 * Returns the authenticated user's profile.
 * Accepts both staff tokens and student tokens.
 * Used by the frontend to restore a session after page reload.
 */
router.get('/me', authenticateAny, (req: Request, res: Response) => {
  if (req.tokenType === 'student') {
    const s = req.student!;
    sendSuccess(res, {
      token_type: 'student',
      student: {
        id: s.id,
        name: s.name,
        class_name: s.class_name,
        section: s.section,
        school_id: s.school_id,
        is_first_login: s.is_first_login,
        // phone_number intentionally omitted — only shown on own profile endpoint
      },
    });
  } else {
    sendSuccess(res, {
      token_type: 'staff',
      user: req.user,
    });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

/**
 * Logout.
 *
 * For staff: invalidates the Supabase session server-side.
 * For students: custom JWTs are stateless — the client must discard the token.
 *   (Redis token blacklisting can be added here when needed.)
 *
 * Accepts both token types.
 */
router.post('/logout', authenticateAny, async (req: Request, res: Response) => {
  if (req.tokenType === 'staff') {
    const token = req.headers.authorization!.split(' ')[1];
    // Sign out the specific session using the admin client
    try {
      await supabaseAdmin.auth.admin.signOut(token);
    } catch {
      // Best-effort — don't fail the logout if Supabase errors
    }
    await logAudit(req.user!.id, 'STAFF_LOGOUT', { email: req.user!.email });
  } else {
    // Student JWT is stateless — client discards it
    await logAudit(req.student!.id, 'STUDENT_LOGOUT', {
      student_id: req.student!.id,
    });
  }

  sendSuccess(res, null, 'Logged out successfully');
});

// ── POST /api/auth/delete-account-request ────────────────────────────────────

/**
 * Public endpoint — no auth required.
 * Accepts an account deletion request and notifies all superadmins.
 */
router.post('/delete-account-request', async (req: Request, res: Response) => {
  const schema = z.object({
    email: z.string().email().max(254),
    reason: z.enum(['no_longer_using', 'privacy_concerns', 'other']),
    message: z.string().max(1000).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { email, reason, message } = parsed.data;
  const now = new Date().toISOString();

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, name, role, school_id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  const { data: superAdmins } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('role', 'superadmin');

  if (superAdmins && superAdmins.length > 0) {
    const notifications = superAdmins.map((sa: { id: string }) => ({
      title: 'Account Deletion Request',
      body: `User ${email} has requested account deletion. Reason: ${reason}.${message ? ` Message: ${message}` : ''}`,
      type: 'deletion_request',
      recipient_id: sa.id,
      sender_id: user?.id ?? null,
      is_read: false,
      created_at: now,
    }));
    await supabaseAdmin.from('notifications').insert(notifications);
  }

  await supabaseAdmin.from('audit_logs').insert({
    user_id: user?.id ?? null,
    action: 'ACCOUNT_DELETION_REQUESTED',
    table_name: 'users',
    details: {
      email,
      reason,
      message: message ?? null,
      user_id: user?.id ?? null,
      role: user?.role ?? null,
    },
    created_at: now,
  });

  sendSuccess(res, null, 'Your request has been received. We will process it within 7 days.');
});

export default router;
