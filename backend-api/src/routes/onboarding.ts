import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

// ── All routes require authentication ─────────────────────────────────────────
router.use(authenticate);

// ── Types ─────────────────────────────────────────────────────────────────────

const VALID_STEPS = [
  'school_created',
  'teachers_imported',
  'students_imported',
  'classes_created',
  'teachers_assigned',
] as const;

type OnboardingStep = (typeof VALID_STEPS)[number];

interface OnboardingProgress {
  school_id: string;
  school_created: boolean;
  teachers_imported: boolean;
  students_imported: boolean;
  classes_created: boolean;
  teachers_assigned: boolean;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Check if all onboarding steps are complete. */
function allStepsComplete(progress: Partial<OnboardingProgress>): boolean {
  return VALID_STEPS.every((step) => progress[step] === true);
}

// ── GET /api/onboarding/status ────────────────────────────────────────────────
/**
 * Returns the onboarding_progress record for the logged-in school admin.
 * If no record exists, creates one with all steps set to false,
 * except school_created which is auto-marked true (school exists).
 */
router.get(
  '/status',
  requireRole('schooladmin'),
  async (req: Request, res: Response) => {
    try {
    const schoolId = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'No school associated with this account', 400);
      return;
    }

    // Try to fetch existing progress record
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('onboarding_progress')
      .select('*')
      .eq('school_id', schoolId)
      .maybeSingle();

    if (fetchErr) {
      sendError(res, fetchErr.message, 500);
      return;
    }

    if (existing) {
      sendSuccess(res, existing);
      return;
    }

    // No record — create one with school_created = true (school exists to show this page)
    const now = new Date().toISOString();
    const newProgress: Omit<OnboardingProgress, 'id'> = {
      school_id: schoolId,
      school_created: true,
      teachers_imported: false,
      students_imported: false,
      classes_created: false,
      teachers_assigned: false,
      completed: false,
      created_at: now,
      updated_at: now,
    };

    const { data: created, error: insertErr } = await supabaseAdmin
      .from('onboarding_progress')
      .insert(newProgress)
      .select()
      .single();

    if (insertErr) {
      sendError(res, insertErr.message, 500);
      return;
    }

    await logAudit(req.user!.id, 'ONBOARDING_PROGRESS_CREATED', { school_id: schoolId });

    sendSuccess(res, created, 'Onboarding progress initialised', 201);
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── PUT /api/onboarding/step ──────────────────────────────────────────────────
/**
 * Update a single onboarding step.
 * Body: { step: string, completed: boolean }
 * If all steps become true, sets completed = true on the record.
 */
router.put(
  '/step',
  requireRole('schooladmin'),
  async (req: Request, res: Response) => {
    try {
    const schema = z.object({
      step: z.enum(VALID_STEPS, {
        error: () => ({
          message: `step must be one of: ${VALID_STEPS.join(', ')}`,
        }),
      }),
      completed: z.boolean(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { step, completed } = parsed.data;
    const schoolId = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'No school associated with this account', 400);
      return;
    }

    // Fetch current progress (upsert-style: create if missing)
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('onboarding_progress')
      .select('*')
      .eq('school_id', schoolId)
      .maybeSingle();

    if (fetchErr) {
      sendError(res, fetchErr.message, 500);
      return;
    }

    const now = new Date().toISOString();

    if (!existing) {
      // Create the record first, then apply the step
      const base = {
        school_id: schoolId,
        school_created: true,
        teachers_imported: false,
        students_imported: false,
        classes_created: false,
        teachers_assigned: false,
        completed: false,
        created_at: now,
        updated_at: now,
      };

      const { error: insertErr } = await supabaseAdmin
        .from('onboarding_progress')
        .insert(base);

      if (insertErr) {
        sendError(res, insertErr.message, 500);
        return;
      }
    }

    // Build the update payload
    const updatedFields: Record<string, boolean | string> = {
      [step]: completed,
      updated_at: now,
    };

    // Determine if all steps will be complete after this update
    const merged = {
      ...(existing ?? {}),
      [step]: completed,
    };

    if (allStepsComplete(merged)) {
      updatedFields.completed = true;
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('onboarding_progress')
      .update(updatedFields)
      .eq('school_id', schoolId)
      .select()
      .single();

    if (updateErr) {
      sendError(res, updateErr.message, 500);
      return;
    }

    await logAudit(req.user!.id, 'ONBOARDING_STEP_UPDATED', {
      school_id: schoolId,
      step,
      completed,
      all_complete: !!updatedFields.completed,
    });

    sendSuccess(res, updated, 'Onboarding step updated');
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

export default router;
