import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateAny } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';
import { getTokensForStudents, getTokensForUsers, sendPushMulticast } from '../services/fcmService';

const router = Router();

router.use(authenticateAny);

// -- Schemas ------------------------------------------------------------------

const createNotificationSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  recipient_ids: z.array(z.string().uuid()).min(1).max(500),
  type: z.enum(['announcement', 'alert', 'reminder', 'grade', 'attendance', 'fee_reminder', 'test', 'marks', 'homework', 'daily_reminder', 'recovery']),
});

// -- Helpers ------------------------------------------------------------------

/**
 * The live DB has a 'message' column (NOT NULL) instead of 'body'.
 * We normalise rows coming back from the DB so the API always returns 'body'.
 * Returns a new object — never mutates the original Supabase response object.
 * Both 'body' and 'message' are returned so legacy clients reading .message still work.
 */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  if ('message' in row && !('body' in row)) {
    return { ...row, body: row.message };
  }
  return { ...row };
}

// -- Routes -------------------------------------------------------------------

/**
 * GET /api/notifications
 * Returns notifications for the authenticated user, sorted newest first.
 * Supports pagination: ?page=1&limit=50 (default limit 50, max 200).
 * Query param: unread_only=true  -> only return unread notifications.
 */
router.get('/', async (req: Request, res: Response) => {
  const unreadOnly = req.query.unread_only === 'true';

  // Pagination
  const rawPage  = parseInt((req.query.page  as string) ?? '1',  10);
  const rawLimit = parseInt((req.query.limit as string) ?? '50', 10);
  const page  = isNaN(rawPage)  || rawPage  < 1 ? 1  : rawPage;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200);

  // Support both student tokens (req.student) and staff tokens (req.user)
  const recipientId = req.tokenType === 'student' ? req.student!.id : req.user!.id;

  let query = supabaseAdmin
    .from('notifications')
    .select('id, title, message, is_read, created_at, type', { count: 'exact' })
    .eq('recipient_id', recipientId)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (unreadOnly) {
    query = query.eq('is_read', false);
  }

  const { data, error, count } = await query;

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  const total = count ?? 0;

  // Fetch the true unread count separately so it's accurate regardless of
  // whether the caller is using unread_only=true or paginating all notifications.
  const { count: unreadCount } = await supabaseAdmin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', recipientId)
    .eq('is_read', false);

  sendSuccess(res, {
    data: (data ?? []).map(normaliseRow),
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
    unread_count: unreadCount ?? 0,
  });
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

  // Fan out: one row per recipient.
  // DB column is 'message' (NOT NULL) — write there; 'body' column is nullable extra.
  const rows = recipient_ids.map((recipient_id) => ({
    title,
    message: body,
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

  // Fire-and-forget: send FCM push to all recipients' registered devices.
  // We split recipient_ids into students (uuid may map to students table)
  // and users (staff/parents), fetching tokens from both storage paths.
  setImmediate(() => {
    (async () => {
      try {
        // Try fetching tokens treating recipient_ids as student IDs
        const studentTokens = await getTokensForStudents(recipient_ids);
        // Also try treating them as user IDs (staff/parents)
        const userTokens = await getTokensForUsers(recipient_ids);

        // Deduplicate across both sets
        const allTokens = Array.from(new Set([...studentTokens, ...userTokens]));

        if (allTokens.length > 0) {
          const { successCount, failureCount } = await sendPushMulticast(
            allTokens,
            title,
            body
          );
          if (failureCount > 0) {
            console.error(
              `[FCM] Announcement push failures — sent: ${successCount}, failed: ${failureCount}, type: ${type}`
            );
          }
        }
      } catch (err) {
        console.error('[FCM] Failed to send announcement push notifications:', err);
      }
    })();
  });

  sendSuccess(
    res,
    (data ?? []).map(normaliseRow),
    `Notification sent to ${recipient_ids.length} recipient(s)`,
    201
  );
});

/**
 * PUT /api/notifications/read-all
 * Mark ALL unread notifications as read for the logged-in user.
 * NOTE: registered before /:id/read to avoid route shadowing.
 */
router.put('/read-all', async (req: Request, res: Response) => {
  const recipientId = req.tokenType === 'student' ? req.student!.id : req.user!.id;

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('recipient_id', recipientId)
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
 */
router.put('/:id/read', async (req: Request, res: Response) => {
  const recipientId = req.tokenType === 'student' ? req.student!.id : req.user!.id;

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('recipient_id', recipientId)
    .select('id, title, message, is_read, created_at, type')
    .single();

  if (error || !data) {
    sendError(res, 'Notification not found', 404);
    return;
  }

  sendSuccess(res, normaliseRow(data as Record<string, unknown>), 'Notification marked as read');
});

/**
 * PATCH /api/notifications/:id/read
 * Kept for backwards compatibility with existing mobile/web clients.
 */
router.patch('/:id/read', async (req: Request, res: Response) => {
  const recipientId = req.tokenType === 'student' ? req.student!.id : req.user!.id;

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('recipient_id', recipientId)
    .select('id, title, message, is_read, created_at, type')
    .single();

  if (error || !data) {
    sendError(res, 'Notification not found', 404);
    return;
  }

  sendSuccess(res, normaliseRow(data as Record<string, unknown>), 'Notification marked as read');
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
