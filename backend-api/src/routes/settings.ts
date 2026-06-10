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

// ── POST /api/settings/add-medium ─────────────────────────────────────────────
/**
 * Creates a sibling medium school for the calling admin's school.
 * - Checks no sibling already exists
 * - Determines the new medium (opposite of current)
 * - Creates a new school record with parent_school_id pointing to current school
 * - Inserts school_admin_access rows for both schools
 * - Returns the new school record
 */
router.post('/add-medium', requireRole('schooladmin'), async (req: Request, res: Response) => {
  const adminId  = req.user!.id;
  const schoolId = req.user!.primary_school_id ?? req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'No school associated with this account', 400);
    return;
  }

  // Fetch current school (use primary school, not the active medium)
  const { data: currentSchool, error: schoolErr } = await supabaseAdmin
    .from('schools')
    .select('id, name, medium, parent_school_id, subscription_status')
    .eq('id', schoolId)
    .single();

  if (schoolErr || !currentSchool) {
    sendError(res, 'School not found', 404);
    return;
  }

  const cs = currentSchool as {
    id: string;
    name: string;
    medium: string | null;
    parent_school_id: string | null;
    subscription_status: boolean;
  };

  // If this school already has a parent, use the parent as the root
  const rootSchoolId = cs.parent_school_id ?? cs.id;

  // Check if a sibling already exists — query for schools with same root
  const { data: siblings } = await supabaseAdmin
    .from('schools')
    .select('id, medium')
    .or(`id.eq.${rootSchoolId},parent_school_id.eq.${rootSchoolId}`)
    .neq('id', schoolId);

  if (siblings && siblings.length > 0) {
    sendError(res, 'A medium account already exists for this school', 409);
    return;
  }

  // Determine new medium — opposite of current
  const currentMedium = cs.medium ?? 'english';
  const newMedium = currentMedium === 'english' ? 'gujarati' : 'english';

  // Create new school record — empty, same name, linked to root
  const { data: newSchool, error: createErr } = await supabaseAdmin
    .from('schools')
    .insert({
      name:                cs.name,
      medium:              newMedium,
      parent_school_id:    rootSchoolId,
      subscription_status: cs.subscription_status,
      created_at:          new Date().toISOString(),
    })
    .select()
    .single();

  if (createErr || !newSchool) {
    sendError(res, createErr?.message ?? 'Failed to create medium account', 500);
    return;
  }

  const ns = newSchool as Record<string, unknown>;

  // Ensure access rows exist for both schools
  await supabaseAdmin
    .from('school_admin_access')
    .upsert([
      { admin_id: adminId, school_id: rootSchoolId,          created_at: new Date().toISOString() },
      { admin_id: adminId, school_id: ns.id as string,       created_at: new Date().toISOString() },
    ], { onConflict: 'admin_id,school_id', ignoreDuplicates: true });

  // Also ensure the root school has a medium label
  await supabaseAdmin
    .from('schools')
    .update({ medium: currentMedium })
    .eq('id', rootSchoolId)
    .is('medium', null);

  await supabaseAdmin.from('audit_logs').insert({
    user_id: adminId,
    action:  'MEDIUM_ACCOUNT_CREATED',
    details: {
      original_school_id: rootSchoolId,
      new_school_id:      ns.id,
      new_medium:         newMedium,
    },
    created_at: new Date().toISOString(),
  });

  sendSuccess(res, newSchool, `${newMedium.charAt(0).toUpperCase() + newMedium.slice(1)} medium account created successfully`, 201);
});

export default router;
