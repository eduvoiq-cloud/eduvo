import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

router.use(authenticate);

// ── Schemas ───────────────────────────────────────────────────────────────────

const upsertSettingsSchema = z.object({
  attendance_cutoff_time: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
  timezone: z.string().max(100).optional(),
  term_name: z.string().max(100).optional(),
  academic_year: z.string().max(20).optional(),
});

const profileSchema = z.object({
  board: z.enum(['GSEB', 'CBSE', 'ICSE', 'MSBSHSE', 'RBSE', 'BSEB', 'MPBSE', 'IB', 'IGCSE']).optional(),
  result_template: z.enum(['percentage', 'grade', 'gseb', 'cbse']).optional(),
  display_name: z.string().min(1).max(200).optional(),
  display_address: z.string().max(500).optional(),
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/settings
 * Returns settings for the authenticated user's school,
 * including board, result_template, name, and address from the schools table.
 */
router.get('/', requireRole('superadmin', 'schooladmin', 'teacher'), async (req: Request, res: Response) => {
  const school_id = req.user!.school_id;

  if (!school_id) {
    sendError(res, 'No school associated with this account', 400);
    return;
  }

  // Fetch school_settings row (may not exist yet)
  const { data: settingsData, error: settingsError } = await supabaseAdmin
    .from('school_settings')
    .select('*')
    .eq('school_id', school_id)
    .single();

  if (settingsError && settingsError.code !== 'PGRST116') { // PGRST116 = no rows found
    sendError(res, settingsError.message, 500);
    return;
  }

  // Fetch board, result_template, name, address from schools table
  const { data: schoolData, error: schoolError } = await supabaseAdmin
    .from('schools')
    .select('board, result_template, name, address')
    .eq('id', school_id)
    .single();

  if (schoolError) {
    sendError(res, schoolError.message, 500);
    return;
  }

  // Return defaults if no settings row exists yet, merged with school profile fields
  const baseSettings = settingsData ?? {
    school_id,
    attendance_cutoff_time: '09:00',
    timezone: 'UTC',
    term_name: '',
    academic_year: '',
  };

  // display_name / display_address (in school_settings) take precedence over
  // schools.name / schools.address, so a school admin's edits are always
  // reflected back in the GET response.
  const resolvedName    = (settingsData as Record<string, unknown> | null)?.display_name    as string | null
                          ?? schoolData?.name    ?? null;
  const resolvedAddress = (settingsData as Record<string, unknown> | null)?.display_address as string | null
                          ?? schoolData?.address ?? null;

  sendSuccess(res, {
    ...baseSettings,
    board:           schoolData?.board           ?? null,
    result_template: schoolData?.result_template ?? null,
    name:            resolvedName,
    address:         resolvedAddress,
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

// ── PUT /api/settings/profile ─────────────────────────────────────────────────
/**
 * Updates the school profile fields (board, result_template, display_name, display_address).
 * - board and result_template are stored on the schools table
 * - display_name and display_address are stored on the school_settings table
 */
router.put('/profile', requireRole('schooladmin'), async (req: Request, res: Response) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const activeSchoolId = req.user!.school_id;
  if (!activeSchoolId) {
    sendError(res, 'No school associated with this account', 400);
    return;
  }

  const { board, result_template, display_name, display_address } = parsed.data;
  const changedFields: Record<string, unknown> = {};

  // ── Update schools table if board or result_template provided ──────────────
  if (board !== undefined || result_template !== undefined) {
    const schoolUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (board !== undefined)            { schoolUpdate.board = board;                       changedFields.board = board; }
    if (result_template !== undefined)  { schoolUpdate.result_template = result_template;   changedFields.result_template = result_template; }

    const { error: schoolErr } = await supabaseAdmin
      .from('schools')
      .update(schoolUpdate)
      .eq('id', activeSchoolId);

    if (schoolErr) {
      sendError(res, schoolErr.message, 500);
      return;
    }
  }

  // ── Upsert school_settings if display_name or display_address provided ─────
  if (display_name !== undefined || display_address !== undefined) {
    const settingsUpsert: Record<string, unknown> = { school_id: activeSchoolId };
    if (display_name !== undefined)    { settingsUpsert.display_name = display_name;       changedFields.display_name = display_name; }
    if (display_address !== undefined) { settingsUpsert.display_address = display_address; changedFields.display_address = display_address; }

    const { error: settingsErr } = await supabaseAdmin
      .from('school_settings')
      .upsert(settingsUpsert, { onConflict: 'school_id' });

    if (settingsErr) {
      sendError(res, settingsErr.message, 500);
      return;
    }
  }

  await logAudit(req.user!.id, 'SCHOOL_PROFILE_UPDATED', {
    school_id:      activeSchoolId,
    changed_fields: changedFields,
  });

  sendSuccess(res, changedFields, 'School profile updated');
});

export default router;
