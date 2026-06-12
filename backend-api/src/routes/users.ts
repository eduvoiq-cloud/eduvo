import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const updateUserSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  email: z.string().email().max(254).optional(),
});

const fcmTokenSchema = z.object({
  fcm_token: z.string().min(1).max(512),
});

const studentFcmTokenSchema = z.object({
  student_id: z.string().uuid(),
  fcm_token:  z.string().min(1).max(512),
  platform:   z.enum(['android', 'ios', 'web']).optional(),
});

// ── Student FCM token endpoint (before authenticate middleware) ────────────────
// Uses authenticateStudent so it works with student JWTs.

/**
 * POST /api/users/fcm-token-student
 * Registers the device's FCM / Expo push token for a student.
 * Called by the mobile app after login.
 * Body: { student_id: string, fcm_token: string, platform?: 'android'|'ios'|'web' }
 */
router.post('/fcm-token-student', authenticateStudent, async (req: Request, res: Response) => {
  const parsed = studentFcmTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { student_id, fcm_token, platform } = parsed.data;

  // Students can only register their own token
  if (req.student!.id !== student_id) {
    sendError(res, 'You can only register your own device token', 403);
    return;
  }

  // Upsert into fcm_tokens table (token is unique — update on conflict)
  const { error: tableErr } = await supabaseAdmin
    .from('fcm_tokens')
    .upsert(
      { student_id, token: fcm_token, platform: platform ?? null, updated_at: new Date().toISOString() },
      { onConflict: 'token' }
    );

  if (tableErr) {
    // Non-fatal: log and continue — still update the legacy column
    console.warn('[users] fcm_tokens upsert failed:', tableErr.message);
  }

  // Also keep the legacy students.fcm_token column in sync
  await supabaseAdmin
    .from('students')
    .update({ fcm_token })
    .eq('id', student_id);

  sendSuccess(res, null, 'FCM token registered');
});

// ── All routes below require staff authentication ─────────────────────────────
router.use(authenticate);

// ── Helpers ───────────────────────────────────────────────────────────────────


// ── Staff FCM token ────────────────────────────────────────────────────────────

/**
 * POST /api/users/fcm-token
 * Saves the device's FCM / Expo push token for the authenticated staff user
 * (schooladmin, teacher, parent) so the server can send push notifications
 * to this specific device.
 * Body: { fcm_token: string }
 */
router.post('/fcm-token', async (req: Request, res: Response) => {
  const parsed = fcmTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { fcm_token } = parsed.data;

  // Upsert into fcm_tokens table
  await supabaseAdmin
    .from('fcm_tokens')
    .upsert(
      { user_id: req.user!.id, token: fcm_token, updated_at: new Date().toISOString() },
      { onConflict: 'token' }
    );

  // Also keep legacy users.fcm_token column in sync
  const { error } = await supabaseAdmin
    .from('users')
    .update({ fcm_token })
    .eq('id', req.user!.id);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'FCM_TOKEN_REGISTERED', {});

  sendSuccess(res, null, 'FCM token registered');
});

/**
 * GET /api/users
 * List users, optionally filtered by role and/or school_id.
 * Supports pagination: ?page=1&limit=50 (default 50, max 200).
 * schooladmin can only see users in their own school.
 */
router.get('/', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const { role, school_id } = req.query as Record<string, string>;

  // Pagination
  const rawPage  = parseInt((req.query.page  as string) ?? '1',  10);
  const rawLimit = parseInt((req.query.limit as string) ?? '50', 10);
  const page  = isNaN(rawPage)  || rawPage  < 1 ? 1  : rawPage;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200);

  let query = supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id, created_at', { count: 'exact' })
    .or('is_deleted.eq.false,is_deleted.is.null')
    .order('name')
    .range((page - 1) * limit, page * limit - 1);

  // schooladmin is always scoped to their own school
  if (req.user!.role === 'schooladmin') {
    query = query.eq('school_id', req.user!.school_id ?? '');
  } else if (school_id) {
    query = query.eq('school_id', school_id);
  }

  if (role) {
    query = query.eq('role', role);
  }

  const { data, error, count } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  const total = count ?? 0;
  sendSuccess(res, { data: data ?? [], total, page, limit, total_pages: Math.ceil(total / limit) });
});

/**
 * GET /api/users/:id
 */
router.get('/:id', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id, created_at')
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    sendError(res, 'User not found', 404);
    return;
  }

  // schooladmin can only view users in their school
  if (req.user!.role === 'schooladmin' && data.school_id !== req.user!.school_id) {
    sendError(res, 'Access denied', 403);
    return;
  }

  sendSuccess(res, data);
});

/**
 * PATCH /api/users/:id
 * Update a user's name or email.
 */
router.patch('/:id', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  // Verify the target user belongs to the schooladmin's school
  if (req.user!.role === 'schooladmin') {
    const { data: target } = await supabaseAdmin
      .from('users')
      .select('school_id')
      .eq('id', req.params.id)
      .single();

    if (!target || target.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select('id, name, email, role, school_id')
    .single();

  if (error || !data) {
    sendError(res, 'User not found or update failed', 404);
    return;
  }

  await logAudit(req.user!.id, 'USER_UPDATED', { target_user_id: req.params.id });

  sendSuccess(res, data, 'User updated');
});

/**
 * DELETE /api/users/:id
 * Soft-deletes the user profile row (is_deleted = true) and disables the auth account.
 * schooladmin can only delete users in their school (and not other admins).
 */
router.delete('/:id', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const { data: target, error: fetchError } = await supabaseAdmin
    .from('users')
    .select('id, role, school_id')
    .eq('id', req.params.id)
    .single();

  if (fetchError || !target) {
    sendError(res, 'User not found', 404);
    return;
  }

  // schooladmin scope checks
  if (req.user!.role === 'schooladmin') {
    if (target.school_id !== req.user!.school_id) {
      sendError(res, 'Access denied', 403);
      return;
    }
    // schooladmin cannot delete other admins
    if (target.role === 'schooladmin' || target.role === 'superadmin') {
      sendError(res, 'You cannot delete admin accounts', 403);
      return;
    }
  }

  // Soft-delete the profile row (preserves audit log FK references)
  const { error: softDeleteErr } = await supabaseAdmin
    .from('users')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', req.params.id);

  if (softDeleteErr) {
    sendError(res, softDeleteErr.message, 500);
    return;
  }

  // Disable the auth account so they can no longer log in
  // '876000h' ≈ 100 years — effectively permanent ban
  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
    String(req.params.id),
    { ban_duration: '876000h' }
  );

  if (authError) {
    console.warn('[users] Failed to disable auth account:', authError.message);
    // Non-fatal — profile is already soft-deleted
  }

  await logAudit(req.user!.id, 'USER_DELETED', {
    target_user_id: req.params.id,
    role: target.role,
  });

  sendSuccess(res, null, 'User deleted');
});

export default router;
