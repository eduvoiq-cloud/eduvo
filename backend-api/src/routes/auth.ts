import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase, supabaseAdmin } from '../config/supabase';
import { loginRateLimit, registerRateLimit } from '../middleware/rateLimit';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import type { AppRole } from '../middleware/auth';

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

/**
 * Schema for admin-created accounts.
 * Public self-registration is disabled — only admins create accounts.
 * Parents are the exception: they register via invite token (see /register-parent).
 */
const createUserSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  name: z.string().min(1).max(150),
  role: z.enum(['schooladmin', 'teacher', 'parent', 'student']),
  school_id: z.string().uuid().optional(),
});

const parentInviteSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(150),
  invite_token: z.string().min(1).max(512),
});

// ── Audit helper ──────────────────────────────────────────────────────────────

async function logAudit(
  userId: string,
  action: string,
  details: Record<string, unknown> = {}
) {
  await supabaseAdmin.from('audit_logs').insert({
    user_id: userId,
    action,
    details,
    created_at: new Date().toISOString(),
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 *
 * Authenticates via Supabase Auth, then fetches the user's full profile
 * (name, role, school_id) from the `users` table.
 * Role is NEVER read from the JWT — always from the DB.
 */
router.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { email, password } = parsed.data;

  // Step 1: Authenticate with Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError || !authData.session) {
    sendError(res, 'Invalid email or password', 401);
    return;
  }

  const { user: authUser, session } = authData;

  // Step 2: Fetch profile from users table — this is the source of truth for role
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id')
    .eq('id', authUser.id)
    .single();

  if (profileError || !profile) {
    // Auth succeeded but no profile row — account not fully provisioned
    sendError(res, 'Account not set up. Contact your administrator.', 403);
    return;
  }

  await logAudit(authUser.id, 'USER_LOGIN', { email, role: profile.role });

  sendSuccess(res, {
    token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
      school_id: profile.school_id ?? null,
    },
  });
});

/**
 * POST /api/auth/logout
 *
 * Invalidates the current session on Supabase Auth.
 * Uses the user's own token (passed in Authorization header) to sign out.
 */
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  // Sign out using the user's own token so only their session is invalidated
  const token = req.headers.authorization!.split(' ')[1];

  // Create a temporary client scoped to this user's token
  const { error } = await supabase.auth.admin
    ? await supabaseAdmin.auth.admin.signOut(token)
    : await supabase.auth.signOut();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'USER_LOGOUT', { email: req.user!.email });

  sendSuccess(res, null, 'Logged out successfully');
});

/**
 * GET /api/auth/me
 *
 * Returns the authenticated user's full profile.
 * The `authenticate` middleware already fetched everything from the DB.
 */
router.get('/me', authenticate, (req: Request, res: Response) => {
  sendSuccess(res, req.user);
});

/**
 * POST /api/auth/users
 *
 * Admin-only: create a new user account (schooladmin, teacher, parent, student).
 * - superadmin can create any role
 * - schooladmin can create teacher, parent, student within their school
 *
 * No public self-registration. All accounts are provisioned top-down.
 */
router.post(
  '/users',
  authenticate,
  requireRole('superadmin', 'schooladmin'),
  async (req: Request, res: Response) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { email, password, name, role, school_id } = parsed.data;
    const creator = req.user!;

    // schooladmin can only create roles below them, within their own school
    if (creator.role === 'schooladmin') {
      const allowedBySchoolAdmin: AppRole[] = ['teacher', 'parent', 'student'];
      if (!allowedBySchoolAdmin.includes(role as AppRole)) {
        sendError(res, 'School admins can only create teacher, parent, or student accounts', 403);
        return;
      }
      // Force school_id to the schooladmin's own school
      if (school_id && school_id !== creator.school_id) {
        sendError(res, 'You can only create users within your own school', 403);
        return;
      }
    }

    const resolvedSchoolId = creator.role === 'schooladmin'
      ? creator.school_id
      : (school_id ?? null);

    // Step 1: Create the auth account
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      sendError(res, authError.message, 400);
      return;
    }

    const newUserId = authData.user.id;

    // Step 2: Insert the profile row into the users table
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('users')
      .insert({
        id: newUserId,
        name,
        email,
        role,
        school_id: resolvedSchoolId,
        created_by: creator.id,
      })
      .select('id, name, email, role, school_id')
      .single();

    if (profileError) {
      // Roll back the auth user if profile insert fails
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      sendError(res, 'Failed to create user profile. Auth account rolled back.', 500);
      return;
    }

    await logAudit(creator.id, 'USER_CREATED', {
      new_user_id: newUserId,
      email,
      role,
      school_id: resolvedSchoolId,
    });

    sendSuccess(res, profileData, 'User created successfully', 201);
  }
);

/**
 * POST /api/auth/register-parent
 *
 * The ONLY public registration endpoint.
 * Parents can self-register only if they have a valid invite token.
 * Invite tokens are pre-generated by schooladmin and stored in the `invites` table.
 */
router.post('/register-parent', registerRateLimit, async (req: Request, res: Response) => {
  const parsed = parentInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { email, password, name, invite_token } = parsed.data;

  // Step 1: Validate the invite token
  const { data: invite, error: inviteError } = await supabaseAdmin
    .from('invites')
    .select('id, email, school_id, used_at')
    .eq('token', invite_token)
    .eq('role', 'parent')
    .single();

  if (inviteError || !invite) {
    sendError(res, 'Invalid or expired invite token', 400);
    return;
  }

  if (invite.used_at) {
    sendError(res, 'This invite has already been used', 400);
    return;
  }

  // Invite email must match registration email
  if (invite.email.toLowerCase() !== email.toLowerCase()) {
    sendError(res, 'Email does not match the invite', 400);
    return;
  }

  // Step 2: Create auth account
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError) {
    sendError(res, authError.message, 400);
    return;
  }

  const newUserId = authData.user.id;

  // Step 3: Insert profile
  const { data: profileData, error: profileError } = await supabaseAdmin
    .from('users')
    .insert({
      id: newUserId,
      name,
      email,
      role: 'parent',
      school_id: invite.school_id,
    })
    .select('id, name, email, role, school_id')
    .single();

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(newUserId);
    sendError(res, 'Failed to create profile. Please try again.', 500);
    return;
  }

  // Step 4: Mark invite as used
  await supabaseAdmin
    .from('invites')
    .update({ used_at: new Date().toISOString(), used_by: newUserId })
    .eq('id', invite.id);

  await logAudit(newUserId, 'PARENT_REGISTERED_VIA_INVITE', {
    email,
    invite_id: invite.id,
    school_id: invite.school_id,
  });

  sendSuccess(res, profileData, 'Account created. You can now log in.', 201);
});

/**
 * POST /api/auth/delete-account-request
 *
 * Public endpoint — no auth required.
 * Accepts a deletion request from the mobile app or delete-account page.
 * Sends a notification to all superadmins and logs the request.
 */
router.post('/delete-account-request', async (req: Request, res: Response) => {
  const schema = z.object({
    email:   z.string().email().max(254),
    reason:  z.enum(['no_longer_using', 'privacy_concerns', 'other']),
    message: z.string().max(1000).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { email, reason, message } = parsed.data;
  const now = new Date().toISOString();

  // Look up the user (best-effort — may not exist if already deleted)
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, name, role, school_id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  // Notify all superadmins
  const { data: superAdmins } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('role', 'superadmin');

  if (superAdmins && superAdmins.length > 0) {
    const notifications = superAdmins.map((sa: { id: string }) => ({
      title:        'Account Deletion Request',
      body:         `User ${email} has requested account deletion. Reason: ${reason}.${message ? ` Message: ${message}` : ''}`,
      type:         'deletion_request',
      recipient_id: sa.id,
      sender_id:    user?.id ?? null,
      is_read:      false,
      created_at:   now,
    }));

    await supabaseAdmin.from('notifications').insert(notifications);
  }

  // Log to audit_logs
  await supabaseAdmin.from('audit_logs').insert({
    user_id:    user?.id ?? null,
    action:     'ACCOUNT_DELETION_REQUESTED',
    table_name: 'users',
    details: {
      email,
      reason,
      message: message ?? null,
      user_id: user?.id ?? null,
      role:    user?.role ?? null,
    },
    created_at: now,
  });

  sendSuccess(res, null, 'Your request has been received. We will process it within 7 days.');
});

export default router;
