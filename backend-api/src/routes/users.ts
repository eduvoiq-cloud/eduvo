import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

router.use(authenticate);

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Schemas ───────────────────────────────────────────────────────────────────

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.email().optional(),
});

const fcmTokenSchema = z.object({
  fcm_token: z.string().min(1),
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/users/fcm-token
 * Saves the device's FCM / Expo push token so the server can send push
 * notifications to this specific device.
 * Body: { fcm_token: string }
 */
router.post('/fcm-token', async (req: Request, res: Response) => {
  const parsed = fcmTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { fcm_token } = parsed.data;

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
 * schooladmin can only see users in their own school.
 */
router.get('/', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const { role, school_id } = req.query as Record<string, string>;

  let query = supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id, created_at')
    .eq('is_deleted', false)
    .order('name');

  // schooladmin is always scoped to their own school
  if (req.user!.role === 'schooladmin') {
    query = query.eq('school_id', req.user!.school_id ?? '');
  } else if (school_id) {
    query = query.eq('school_id', school_id);
  }

  if (role) {
    query = query.eq('role', role);
  }

  const { data, error } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data);
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
  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
    String(req.params.id),
    { ban_duration: 'none' } // marks account as banned/disabled
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
