import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

router.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────

const upsertSettingsSchema = z.object({
  attendance_cutoff_time: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
  timezone: z.string().max(100).optional(),
  term_name: z.string().max(100).optional(),
  academic_year: z.string().max(20).optional(),
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/settings
 * Returns settings for the authenticated user's school.
 */
router.get('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const school_id = req.user!.school_id;

  if (!school_id) {
    sendError(res, 'No school associated with this account', 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('school_settings')
    .select('*')
    .eq('school_id', school_id)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    sendError(res, error.message, 500);
    return;
  }

  // Return defaults if no settings row exists yet
  sendSuccess(res, data ?? {
    school_id,
    attendance_cutoff_time: '09:00',
    timezone: 'UTC',
    term_name: '',
    academic_year: '',
  });
});

/**
 * PUT /api/settings
 * Upserts settings for the authenticated schooladmin's school.
 */
router.put('/', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const parsed = upsertSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const school_id = req.user!.school_id;
  if (!school_id) {
    sendError(res, 'No school associated with this account', 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('school_settings')
    .upsert({ ...parsed.data, school_id }, { onConflict: 'school_id' })
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  await supabaseAdmin.from('audit_logs').insert({
    user_id: req.user!.id,
    action: 'SETTINGS_UPDATED',
    details: { school_id, changes: parsed.data },
    created_at: new Date().toISOString(),
  });

  sendSuccess(res, data, 'Settings saved');
});

export default router;
