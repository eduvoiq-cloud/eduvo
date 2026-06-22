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
 *   POST /api/auth/login/staff              — staff login (returns must_reset_password flag)
 *   POST /api/auth/login/student            — student (+ parent) login
 *   POST /api/auth/staff/change-password    — staff sets new password (clears must_reset_password)
 *   POST /api/auth/staff/forgot-password    — send password-reset email via Resend
 *   POST /api/auth/staff/reset-password     — verify token and set new password
 *   POST /api/auth/student/change-password        — student changes own password
 *   POST /api/auth/student/reset-password          — school_admin resets a student's password
 *   POST /api/auth/student/forgot-password         — send OTP via WhatsApp for self-service reset
 *   POST /api/auth/student/verify-otp              — verify OTP, receive short-lived reset token
 *   POST /api/auth/student/reset-password-otp      — set new password using reset token
 *   GET  /api/auth/me                              — restore any session
 *   POST /api/auth/logout                          — sign out
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Resend } from 'resend';
import { supabase, supabaseAdmin } from '../config/supabase';
import redis from '../config/redis';
import { loginRateLimit, studentLoginRateLimit, forgotPasswordRateLimit, deleteAccountRequestRateLimit, studentOtpRateLimit } from '../middleware/rateLimit';
import {
  authenticate,
  authenticateStudent,
  authenticateAny,
  invalidateAuthCache,
  blockStudentToken,
} from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import { sendWhatsAppMessage } from '../services/whatsappService';

const router = Router();

const BCRYPT_ROUNDS = 12;
// Students should never be logged out — use a very long-lived token.
// Revocation (logout / password change) is handled via the Redis blocklist,
// so the long TTL does not create a security hole.
const STUDENT_TOKEN_TTL = '3650d'; // 10 years — effectively permanent

// ── Resend email client ───────────────────────────────────────────────────────
// Lazy-initialised so the server still starts even if RESEND_API_KEY is missing
// (it will just fail gracefully at send time with a clear error).
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key || key.startsWith('re_xxx')) {
      throw new Error('RESEND_API_KEY is not configured. Add it to .env');
    }
    _resend = new Resend(key);
  }
  return _resend;
}

// Token TTL: 1 hour
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  new_password: z.string().min(8).max(128),
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
    .select('id, name, email, role, school_id, must_reset_password, phone')
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

  // 3. Check school subscription (non-superadmin only)
  const role = profile.role as string;
  if (role !== 'superadmin' && profile.school_id) {
    const { data: school } = await supabaseAdmin
      .from('schools')
      .select('subscription_status')
      .eq('id', profile.school_id)
      .single();

    const isActive = (school as { subscription_status: boolean } | null)?.subscription_status;
    if (isActive === false) {
      await logAudit(authUser.id, 'STAFF_LOGIN_FAILED', { email, reason: 'subscription_expired' });
      sendError(res, 'Your subscription has expired. Please renew your subscription to continue using the service.', 402);
      return;
    }
  }

  await logAudit(authUser.id, 'STAFF_LOGIN_SUCCESS', { email, role: profile.role });

  const p = profile as Record<string, unknown>;

  sendSuccess(res, {
    token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    token_type: 'staff',
    must_reset_password: p.must_reset_password === true,
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
      school_id: profile.school_id ?? null,
      must_reset_password: p.must_reset_password === true,
      phone: (p.phone as string | null) ?? null,
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

  // 1. Look up student by phone_number (also check legacy phone column)
  const { data: student, error: studentError } = await supabaseAdmin
    .from('students')
    .select('id, full_name, phone_number, class_name, section, school_id, password_hash, is_first_login')
    .or(`phone_number.eq.${phone_number},phone.eq.${phone_number}`)
    .eq('is_deleted', false)
    .maybeSingle();

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

  // 3. Check school subscription
  const { data: school } = await supabaseAdmin
    .from('schools')
    .select('subscription_status')
    .eq('id', student.school_id)
    .single();

  const isSchoolActive = (school as { subscription_status: boolean } | null)?.subscription_status;
  if (isSchoolActive === false) {
    await logAudit(student.id, 'STUDENT_LOGIN_FAILED', { reason: 'subscription_expired' });
    sendError(res, 'Your subscription has expired. Please renew your subscription to continue using the service.', 402);
    return;
  }

  // 4. Sign custom JWT
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
      name: student.full_name,
      phone: student.phone_number,
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

    // Evict cached auth entry so the first_login gate lifts immediately,
    // and revoke the old token so it cannot be reused after the password change.
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      await invalidateAuthCache(token);
      await blockStudentToken(token);
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

// ── POST /api/auth/staff/change-password ──────────────────────────────────────

/**
 * Authenticated staff member (teacher / admin) sets a new password.
 * Called after first login when must_reset_password = true, or from settings.
 * On success, clears the must_reset_password flag in the users table.
 *
 * Requires a valid staff session token.
 */
const staffChangePasswordSchema = z.object({
  new_password: z.string().min(8).max(128),
});

router.post('/staff/change-password', authenticate, async (req: Request, res: Response) => {
  const parsed = staffChangePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { new_password } = parsed.data;
  const staffUser = req.user!;

  // Update password in Supabase Auth (service-role key bypasses email confirmation).
  // NOTE: Supabase invalidates all existing sessions when a password is changed via
  // admin.updateUserById — so we re-sign-in immediately to get a fresh session that
  // the frontend can swap in without forcing a manual re-login.
  const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(
    staffUser.id,
    { password: new_password }
  );

  if (authErr) {
    sendError(res, 'Failed to update password. Please try again.', 500);
    return;
  }

  // Clear the must_reset_password flag
  const { error: dbErr } = await supabaseAdmin
    .from('users')
    .update({ must_reset_password: false })
    .eq('id', staffUser.id);

  if (dbErr) {
    // Non-fatal — password was changed successfully; flag will clear on next attempt
    console.error('[auth] Failed to clear must_reset_password for user', staffUser.id, dbErr.message);
  }

  await logAudit(staffUser.id, 'STAFF_PASSWORD_CHANGED', { user_id: staffUser.id });

  // Evict cached auth entry so must_reset_password gate lifts immediately
  const oldToken = req.headers.authorization?.split(' ')[1];
  if (oldToken) await invalidateAuthCache(oldToken);

  // Re-authenticate with the new password so we can return a fresh session token.
  // The old token is now dead (Supabase revokes all sessions on password change).
  // If this sign-in fails for any reason, the client will just be redirected to /login.
  const { data: newSession, error: signInErr } = await supabase.auth.signInWithPassword({
    email: staffUser.email,
    password: new_password,
  });

  if (signInErr || !newSession.session) {
    // Password was changed but we couldn't get a fresh token — client must re-login
    sendSuccess(res, { requires_relogin: true }, 'Password changed successfully. Please sign in again.');
    return;
  }

  sendSuccess(res, {
    requires_relogin: false,
    token: newSession.session.access_token,
    refresh_token: newSession.session.refresh_token,
    expires_at: newSession.session.expires_at,
  }, 'Password changed successfully');
});

// ── POST /api/auth/staff/forgot-password ──────────────────────────────────────

/**
 * Sends a password-reset email via Resend.
 *
 * - Generates a cryptographically-secure token, hashes it, and stores it in
 *   the `password_reset_tokens` table with a 1-hour expiry.
 * - Sends an email with a link to /reset-password?token=<raw_token>
 * - Always returns 200 regardless of whether the email exists (prevents
 *   user-enumeration attacks).
 *
 * Public route — no auth required. Rate-limited to prevent email spam.
 */
const forgotPasswordSchema = z.object({
  email: z.string().email().max(254),
});

router.post('/staff/forgot-password', forgotPasswordRateLimit, async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { email } = parsed.data;

  console.log(`[auth] forgot-password request for: ${email}`);

  // Always return the same response regardless of whether email exists
  const genericOk = () =>
    sendSuccess(res, null, 'If an account with that email exists, a reset link has been sent.');

  try {
    // 1. Check if the email belongs to a staff account
    const { data: userRecord, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, name, email')
      .ilike('email', email.trim())   // case-insensitive match
      .eq('is_deleted', false)
      .maybeSingle();

    if (userError) {
      console.error('[auth] DB error looking up user:', userError.message);
      genericOk();
      return;
    }

    if (!userRecord) {
      console.log(`[auth] forgot-password: no user found for email=${email}`);
      await logAudit(null, 'STAFF_FORGOT_PASSWORD_REQUESTED', { email, found: false });
      genericOk();
      return;
    }

    console.log(`[auth] forgot-password: found user id=${userRecord.id}`);

    // 2. Generate a secure random token (32 bytes = 64 hex chars)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

    // 3. Invalidate any existing unused tokens for this user
    await supabaseAdmin
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('user_id', userRecord.id)
      .eq('used', false);

    // 4. Store the hashed token
    const { error: insertError } = await supabaseAdmin
      .from('password_reset_tokens')
      .insert({
        user_id: userRecord.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used: false,
      });

    if (insertError) {
      console.error('[auth] Failed to store reset token:', insertError.message, insertError.code);
      // If we can't persist the token the reset link would be dead on arrival —
      // don't send the email and instead silently return OK (prevents leaking info).
      await logAudit(userRecord.id, 'STAFF_FORGOT_PASSWORD_REQUESTED', { email, found: true, token_stored: false });
      genericOk();
      return;
    } else {
      console.log(`[auth] forgot-password: token stored OK`);
    }

    // 5. Build the reset URL
    const siteUrl = (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    const resetUrl = `${siteUrl}/reset-password?token=${rawToken}`;
    const fromEmail = process.env.FROM_EMAIL ?? 'onboarding@resend.dev';

    console.log(`[auth] forgot-password: SITE_URL=${siteUrl}, FROM_EMAIL=${fromEmail}, to=${email}`);

    // 6. Send the email via Resend
    let resend: Resend;
    try {
      resend = getResend();
    } catch (keyErr) {
      console.error('[auth] Resend init failed:', (keyErr as Error).message);
      genericOk();
      return;
    }

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: `Eduvo <${fromEmail}>`,
      to: email.toLowerCase(),
      subject: 'Reset your Eduvo password',
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111;">
          <div style="margin-bottom:32px;">
            <div style="display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;background:#2563eb;border-radius:10px;vertical-align:middle;margin-right:10px;">
              <span style="color:#fff;font-weight:700;font-size:16px;line-height:1;">E</span>
            </div>
            <span style="font-size:20px;font-weight:600;vertical-align:middle;">eduvo</span>
          </div>

          <h2 style="font-size:20px;font-weight:600;margin:0 0 8px;">Reset your password</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px;">
            Hi ${userRecord.name ?? 'there'},<br/>
            We received a request to reset your Eduvo password. Click the button below to choose a new one.
          </p>

          <a href="${resetUrl}"
             style="display:inline-block;background:#2563eb;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">
            Reset password
          </a>

          <p style="color:#888;font-size:12px;margin:24px 0 0;line-height:1.6;">
            This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you can safely ignore this email — your password won't change.
          </p>

          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
          <p style="color:#aaa;font-size:11px;margin:0;">
            If the button doesn't work, copy and paste this link into your browser:<br/>
            <a href="${resetUrl}" style="color:#2563eb;word-break:break-all;">${resetUrl}</a>
          </p>
        </div>
      `,
    });

    if (emailError) {
      console.error('[auth] Resend error:', JSON.stringify(emailError));
    } else {
      console.log(`[auth] Reset email sent OK — Resend id=${emailData?.id}, to=${email}`);
    }

    await logAudit(userRecord.id, 'STAFF_FORGOT_PASSWORD_REQUESTED', { email, found: true });
  } catch (err) {
    console.error('[auth] forgot-password unexpected error:', err);
  }

  genericOk();
});

// ── POST /api/auth/staff/reset-password ───────────────────────────────────────

/**
 * Verifies the password-reset token and sets the new password.
 *
 * - Looks up the hashed token in `password_reset_tokens`
 * - Checks it isn't expired or already used
 * - Updates the Supabase Auth password via the admin API
 * - Marks the token as used
 *
 * Public route — no auth required.
 */
const staffResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});

router.post('/staff/reset-password', async (req: Request, res: Response) => {
  const parsed = staffResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { token, password } = parsed.data;

  // 1. Hash the incoming token to compare against the stored hash
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const { data: tokenRecord, error: tokenError } = await supabaseAdmin
    .from('password_reset_tokens')
    .select('id, user_id, expires_at, used')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (tokenError || !tokenRecord) {
    sendError(res, 'Invalid or expired reset link. Please request a new one.', 400);
    return;
  }

  if (tokenRecord.used) {
    sendError(res, 'This reset link has already been used. Please request a new one.', 400);
    return;
  }

  if (new Date(tokenRecord.expires_at) < new Date()) {
    sendError(res, 'This reset link has expired. Please request a new one.', 400);
    return;
  }

  // 2. Update the Supabase Auth password via admin API (no session required)
  const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(
    tokenRecord.user_id,
    { password }
  );

  if (authErr) {
    console.error('[auth] Failed to update password via Supabase admin:', authErr.message);
    sendError(res, 'Failed to reset password. Please try again.', 500);
    return;
  }

  // 3. Clear must_reset_password flag if set
  await supabaseAdmin
    .from('users')
    .update({ must_reset_password: false })
    .eq('id', tokenRecord.user_id);

  // 4. Mark the token as used
  await supabaseAdmin
    .from('password_reset_tokens')
    .update({ used: true })
    .eq('id', tokenRecord.id);

  await logAudit(tokenRecord.user_id, 'STAFF_PASSWORD_RESET_COMPLETED', {
    user_id: tokenRecord.user_id,
  });

  sendSuccess(res, null, 'Password reset successfully. You can now sign in.');
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

/**
 * Exchanges a Supabase refresh_token for a new access_token + refresh_token.
 * Public route — no auth middleware needed (the old access token may be expired).
 */
const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

router.post('/refresh', async (req: Request, res: Response) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { refresh_token } = parsed.data;

  const { data, error } = await supabase.auth.refreshSession({ refresh_token });

  if (error || !data.session) {
    sendError(res, 'Session expired. Please log in again.', 401);
    return;
  }

  sendSuccess(res, {
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

/**
 * Returns the authenticated user's profile.
 * Accepts both staff tokens and student tokens.
 * Used by the frontend to restore a session after page reload.
 *
 * For staff, fetches a fresh profile including must_reset_password so the
 * frontend always has up-to-date flag state (even after session rehydration).
 */
router.get('/me', authenticateAny, async (req: Request, res: Response) => {
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
    return;
  }

  // Re-fetch profile to include must_reset_password (not in req.user by default)
  const { data: profile } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id, must_reset_password, phone')
    .eq('id', req.user!.id)
    .single();

  const p = (profile ?? req.user) as Record<string, unknown>;

  // ── Fetch accessible schools (for medium switcher) ────────────────────────
  // schooladmin: look up all schools they can access via school_admin_access.
  // Other roles: return single-item array with their own school (or empty if none).
  let schools: { id: string; name: string; medium: string; board?: string | null }[] = [];

  if (p.role === 'schooladmin' && p.school_id) {
    const { data: accessRows } = await supabaseAdmin
      .from('school_admin_access')
      .select('school_id, schools(id, name, medium, board)')
      .eq('admin_id', p.id as string);

    if (accessRows && accessRows.length > 0) {
      schools = (accessRows as unknown as Array<{
        school_id: string;
        schools: { id: string; name: string; medium: string; board?: string | null } | null;
      }>)
        .filter((r) => r.schools)
        .map((r) => ({
          id: r.schools!.id,
          name: r.schools!.name,
          medium: r.schools!.medium ?? 'english',
          board: (r.schools! as { board?: string | null }).board ?? null,
        }));
    }

    // Fallback: if no access rows yet (e.g. migration not run), use primary school
    if (schools.length === 0) {
      const { data: primarySchool } = await supabaseAdmin
        .from('schools')
        .select('id, name, medium, board')
        .eq('id', p.school_id as string)
        .maybeSingle();
      if (primarySchool) {
        schools = [{
          id: primarySchool.id,
          name: primarySchool.name,
          medium: (primarySchool as Record<string, unknown>).medium as string ?? 'english',
          board: (primarySchool as Record<string, unknown>).board as string | null ?? null,
        }];
      }
    }
  }

  sendSuccess(res, {
    token_type: 'staff',
    user: {
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      school_id: p.school_id ?? null,
      must_reset_password: p.must_reset_password === true,
      phone: (p.phone as string | null) ?? null,
    },
    schools,
  });
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
    // Revoke the student JWT server-side so it cannot be reused even if stolen
    const token = req.headers.authorization!.split(' ')[1];
    await blockStudentToken(token);
    // Also evict the cached profile so any cached state is cleared immediately
    await invalidateAuthCache(token);
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
router.post('/delete-account-request', deleteAccountRequestRateLimit, async (req: Request, res: Response) => {
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

// ── OTP helpers ───────────────────────────────────────────────────────────────

const OTP_TTL_SECONDS   = 5 * 60;        // OTP expires in 5 minutes
const RESET_TTL_SECONDS = 10 * 60;       // reset token expires in 10 minutes

/** Redis key for the OTP bound to a phone number */
const otpKey   = (phone: string) => `otp:student:${phone}`;
/** Redis key for the password-reset token issued after OTP verification */
const resetKey = (token: string) => `otp:reset:${token}`;

// ── POST /api/auth/student/forgot-password ────────────────────────────────────

/**
 * Self-service password reset — step 1.
 * Accepts the student's phone number, looks them up, generates a 6-digit OTP,
 * stores a bcrypt hash of it in Redis (5-minute TTL), and sends it via WhatsApp
 * to the student's parent_phone (preferred) or their own phone_number.
 *
 * Always returns 200 to prevent phone-number enumeration.
 * Public route. Rate-limited to 3 requests per hour per IP.
 */
const studentForgotPasswordSchema = z.object({
  phone_number: z.string().min(5).max(20),
});

router.post(
  '/student/forgot-password',
  studentOtpRateLimit,
  async (req: Request, res: Response) => {
    const parsed = studentForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { phone_number } = parsed.data;
    const genericOk = () =>
      sendSuccess(
        res,
        null,
        'If an account with that number exists, an OTP has been sent via WhatsApp.'
      );

    try {
      // 1. Look up student
      const { data: student, error } = await supabaseAdmin
        .from('students')
        .select('id, full_name, phone_number, parent_phone')
        .or(`phone_number.eq.${phone_number},phone.eq.${phone_number}`)
        .eq('is_deleted', false)
        .maybeSingle();

      if (error || !student) {
        await logAudit(null, 'STUDENT_OTP_REQUESTED', {
          phone_number,
          found: false,
        });
        genericOk();
        return;
      }

      // 2. Generate 6-digit OTP
      const otp = String(Math.floor(100000 + Math.random() * 900000));

      // 3. Hash and store in Redis
      const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

      if (redis) {
        await redis.setex(otpKey(phone_number), OTP_TTL_SECONDS, otpHash);
      } else {
        // Redis unavailable — cannot safely proceed
        console.error('[auth] Redis unavailable — cannot store OTP');
        genericOk();
        return;
      }

      // 4. Determine delivery number (parent phone preferred)
      const deliveryPhone = (student.parent_phone as string | null) ?? student.phone_number;

      // 5. Send via WhatsApp
      const message =
        `Your Eduvo password reset OTP is: *${otp}*\n\nThis code is valid for 5 minutes. Do not share it with anyone.`;

      const result = await sendWhatsAppMessage(deliveryPhone, message);

      if (!result.sent) {
        console.warn(
          `[auth] OTP WhatsApp send failed for student ${student.id}: ${result.reason}`
        );
      }

      await logAudit(student.id, 'STUDENT_OTP_REQUESTED', {
        phone_number,
        found: true,
        whatsapp_sent: result.sent,
      });
    } catch (err) {
      console.error('[auth] student/forgot-password error:', err);
    }

    genericOk();
  }
);

// ── POST /api/auth/student/verify-otp ────────────────────────────────────────

/**
 * Self-service password reset — step 2.
 * Verifies the 6-digit OTP and, if valid, issues a short-lived reset token
 * (stored in Redis, 10-minute TTL) that step 3 will consume.
 *
 * Public route.
 */
const studentVerifyOtpSchema = z.object({
  phone_number: z.string().min(5).max(20),
  otp: z.string().length(6).regex(/^\d{6}$/),
});

router.post('/student/verify-otp', async (req: Request, res: Response) => {
  const parsed = studentVerifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { phone_number, otp } = parsed.data;

  if (!redis) {
    sendError(res, 'Service temporarily unavailable. Please try again later.', 503);
    return;
  }

  // 1. Fetch stored OTP hash
  const storedHash = await redis.get(otpKey(phone_number));
  if (!storedHash) {
    sendError(res, 'OTP expired or not found. Please request a new one.', 400);
    return;
  }

  // 2. Verify
  const incomingHash = crypto.createHash('sha256').update(otp).digest('hex');
  const isValid = crypto.timingSafeEqual(
    Buffer.from(storedHash, 'hex'),
    Buffer.from(incomingHash, 'hex')
  );

  if (!isValid) {
    sendError(res, 'Incorrect OTP. Please check and try again.', 400);
    return;
  }

  // 3. Consume OTP — delete it so it can only be used once
  await redis.del(otpKey(phone_number));

  // 4. Issue a short-lived reset token (32 random bytes)
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

  // Store: hash → phone_number so step 3 can look up the student
  await redis.setex(resetKey(resetTokenHash), RESET_TTL_SECONDS, phone_number);

  await logAudit(null, 'STUDENT_OTP_VERIFIED', { phone_number });

  sendSuccess(res, { reset_token: resetToken }, 'OTP verified successfully.');
});

// ── POST /api/auth/student/reset-password-otp ────────────────────────────────

/**
 * Self-service password reset — step 3.
 * Consumes the reset token issued by verify-otp, hashes the new password,
 * and updates the student's record.
 *
 * Public route.
 */
const studentResetPasswordOtpSchema = z.object({
  reset_token: z.string().min(1),
  new_password: z.string().min(6).max(128),
});

router.post('/student/reset-password-otp', async (req: Request, res: Response) => {
  const parsed = studentResetPasswordOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { reset_token, new_password } = parsed.data;

  if (!redis) {
    sendError(res, 'Service temporarily unavailable. Please try again later.', 503);
    return;
  }

  // 1. Look up the phone number bound to this reset token
  const tokenHash = crypto.createHash('sha256').update(reset_token).digest('hex');
  const phone_number = await redis.get(resetKey(tokenHash));

  if (!phone_number) {
    sendError(res, 'Reset link expired or already used. Please request a new OTP.', 400);
    return;
  }

  // 2. Fetch student
  const { data: student, error } = await supabaseAdmin
    .from('students')
    .select('id, phone_number, password_hash')
    .or(`phone_number.eq.${phone_number},phone.eq.${phone_number}`)
    .eq('is_deleted', false)
    .maybeSingle();

  if (error || !student) {
    sendError(res, 'Student not found.', 404);
    return;
  }

  // 3. New password cannot be the last 5 digits of phone (the default password)
  const digits = phone_number.replace(/\D/g, '');
  const last5 = digits.slice(-5);
  if (last5.length === 5 && new_password === last5) {
    sendError(
      res,
      'Password cannot be the last 5 digits of your phone number. Please choose a different password.',
      400
    );
    return;
  }

  // 4. Hash and save
  const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

  const { error: updateError } = await supabaseAdmin
    .from('students')
    .update({ password_hash: newHash, is_first_login: false })
    .eq('id', student.id);

  if (updateError) {
    sendError(res, 'Failed to reset password. Please try again.', 500);
    return;
  }

  // 5. Consume the reset token — one-time use
  await redis.del(resetKey(tokenHash));

  await logAudit(student.id, 'STUDENT_PASSWORD_RESET_OTP', { student_id: student.id });

  sendSuccess(res, null, 'Password reset successfully. You can now log in.');
});

export default router;
