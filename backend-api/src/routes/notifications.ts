import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

router.use(authenticate);

// -- Schemas ------------------------------------------------------------------

const createNotificationSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  recipient_ids: z.array(z.string().uuid()).min(1).max(500),
  type: z.enum(['announcement', 'alert', 'reminder', 'grade', 'attendance']),
});

// -- Helpers ------------------------------------------------------------------

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

// -- Routes -------------------------------------------------------------------

/**
 * GET /api/notifications
 * Returns notifications for the authenticated user, sorted newest first.
 * Query param: unread_only=true  -> only return unread notifications.
 * Returns: id, title, body, is_read, created_at, type
 */
router.get('/', async (req: Request, res: Response) => {
  const unreadOnly = req.query.unread_only === 'true';

  let query = supabaseAdmin
    .from('notifications')
    .select('id, title, body, is_read, created_at, type')
    .eq('recipient_id', req.user!.id)
    .order('created_at', { ascending: false });

  if (unreadOnly) {
    query = query.eq('is_read', false);
  }

  const { data, error } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
});

/**
 * POST /api/notifications
 * schooladmin and teacher can send notifications to recipients.
 */
router.post('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const parsed = createNotificationSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { title, body, recipient_ids, type } = parsed.data;

  // Fan out: one row per recipient
  const rows = recipient_ids.map((recipient_id) => ({
    title,
    body,
    type,
    recipient_id,
    sender_id: req.user!.id,
    is_read: false,
    created_at: new Date().toISOString(),
  }));

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .insert(rows)
    .select();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'NOTIFICATION_SENT', {
    type,
    recipient_count: recipient_ids.length,
  });

  sendSuccess(res, data, `Notification sent to ${recipient_ids.length} recipient(s)`, 201);
});

/**
 * PUT /api/notifications/read-all
 * Mark ALL unread notifications as read for the logged-in user.
 * NOTE: registered before /:id/read to avoid route shadowing.
 * Returns: { updated: number }
 */
router.put('/read-all', async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('recipient_id', req.user!.id)
    .eq('is_read', false)
    .select('id');

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { updated: data?.length ?? 0 }, 'All notifications marked as read');
});

/**
 * PUT /api/notifications/:id/read
 * Mark a single notification as read (is_read = true).
 * Returns the updated notification.
 */
router.put('/:id/read', async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('recipient_id', req.user!.id)
    .select('id, title, body, is_read, created_at, type')
    .single();

  if (error || !data) {
    sendError(res, 'Notification not found', 404);
    return;
  }

  sendSuccess(res, data, 'Notification marked as read');
});

/**
 * PATCH /api/notifications/:id/read
 * Kept for backwards compatibility with existing mobile/web clients.
 */
router.patch('/:id/read', async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('recipient_id', req.user!.id)
    .select('id, title, body, is_read, created_at, type')
    .single();

  if (error || !data) {
    sendError(res, 'Notification not found', 404);
    return;
  }

  sendSuccess(res, data, 'Notification marked as read');
});

/**
 * DELETE /api/notifications/:id
 * Hard-delete a notification. superadmin and schooladmin only.
 */
router.delete('/:id', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const { error } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await logAudit(req.user!.id, 'NOTIFICATION_DELETED', { notification_id: req.params.id });

  sendSuccess(res, null, 'Notification deleted');
});

export default router;
