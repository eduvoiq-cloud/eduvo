/**
 * /api/recovery-schedules — Teacher endpoints for monthly recovery schedule management.
 *
 * GET  /api/recovery-schedules              — pending/postponed schedules for teacher
 * GET  /api/recovery-schedules/all          — all schedules for teacher (any status)
 * GET  /api/recovery-schedules/pending-count — count pending_teacher_approval rows
 * PUT  /api/recovery-schedules/:id/approve  — approve (generate_now)
 * PUT  /api/recovery-schedules/:id/postpone — postpone with new date + reason
 * PUT  /api/recovery-schedules/:id/cancel   — cancel this month's schedule
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

router.use(authenticate);
router.use(requireRole('teacher'));

// ── Schemas ───────────────────────────────────────────────────────────────────

const postponeSchema = z.object({
  new_test_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  postpone_reason: z.enum([
    'unit_test',
    'final_exam',
    'school_event',
    'teacher_choice',
    'other',
  ]),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Subtract N days from a YYYY-MM-DD string, return new YYYY-MM-DD string.
 */
function subtractDaysFromDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Return the class+section pairs assigned to the authenticated teacher.
 */
async function getTeacherClassSections(
  teacherId: string,
  schoolId: string
): Promise<Array<{ class_name: string; section: string }>> {
  const { data } = await supabaseAdmin
    .from('teacher_assignments')
    .select('class_name, section')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId);

  return (
    (data as Array<{ class_name: string; section: string }> | null)?.filter(
      (r) => r.class_name && r.section
    ) ?? []
  );
}

/**
 * Verify that a schedule row belongs to this teacher's class+section.
 * Returns the row on success, null if not found / not authorised.
 */
async function getOwnedSchedule(
  scheduleId: string,
  teacherId: string,
  schoolId: string
): Promise<Record<string, unknown> | null> {
  const classSections = await getTeacherClassSections(teacherId, schoolId);
  if (classSections.length === 0) return null;

  const { data } = await supabaseAdmin
    .from('monthly_recovery_schedules')
    .select('*')
    .eq('id', scheduleId)
    .eq('school_id', schoolId)
    .in(
      'class',
      classSections.map((cs) => cs.class_name)
    )
    .maybeSingle();

  if (!data) return null;

  // Double-check section matches (the `in` above only checks class)
  const row = data as Record<string, unknown>;
  const matchesSection = classSections.some(
    (cs) =>
      cs.class_name === (row.class as string) && cs.section === (row.section as string)
  );

  return matchesSection ? row : null;
}

// ── GET /api/recovery-schedules/pending-count ─────────────────────────────────
/**
 * Returns count of schedules with status 'pending_teacher_approval' for the teacher.
 * Used by the dashboard widget.
 */
router.get('/pending-count', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendSuccess(res, { count: 0 });
    return;
  }

  const classSections = await getTeacherClassSections(teacherId, schoolId);
  if (classSections.length === 0) {
    sendSuccess(res, { count: 0 });
    return;
  }

  const classNames = classSections.map((cs) => cs.class_name);
  const sectionNames = classSections.map((cs) => cs.section);

  const { count, error } = await supabaseAdmin
    .from('monthly_recovery_schedules')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', schoolId)
    .eq('status', 'pending_teacher_approval')
    .in('class', classNames)
    .in('section', sectionNames);

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { count: count ?? 0 });
});

// ── GET /api/recovery-schedules ───────────────────────────────────────────────
/**
 * Returns all schedules where status IN ('pending_teacher_approval', 'postponed').
 */
router.get('/', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendSuccess(res, []);
    return;
  }

  const classSections = await getTeacherClassSections(teacherId, schoolId);
  if (classSections.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const classNames = classSections.map((cs) => cs.class_name);
  const sectionNames = classSections.map((cs) => cs.section);

  const { data, error } = await supabaseAdmin
    .from('monthly_recovery_schedules')
    .select('*')
    .eq('school_id', schoolId)
    .in('status', ['pending_teacher_approval', 'postponed'])
    .in('class', classNames)
    .in('section', sectionNames)
    .order('scheduled_month', { ascending: false })
    .order('class', { ascending: true });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Filter to only rows whose section also matches (in() above covers class only)
  const filtered = (data ?? []).filter((row: Record<string, unknown>) =>
    classSections.some(
      (cs) =>
        cs.class_name === (row.class as string) && cs.section === (row.section as string)
    )
  );

  sendSuccess(res, filtered);
});

// ── GET /api/recovery-schedules/all ──────────────────────────────────────────
/**
 * Returns ALL schedules for the teacher's classes regardless of status.
 * Used for the "This Month's Recovery Tests" read-only table.
 */
router.get('/all', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendSuccess(res, []);
    return;
  }

  const classSections = await getTeacherClassSections(teacherId, schoolId);
  if (classSections.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const classNames = classSections.map((cs) => cs.class_name);
  const sectionNames = classSections.map((cs) => cs.section);

  // Default: current month; allow ?month=YYYY-MM-DD override
  const monthParam = req.query.month as string | undefined;
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const scheduledMonth = monthParam ?? defaultMonth;

  const { data, error } = await supabaseAdmin
    .from('monthly_recovery_schedules')
    .select('*')
    .eq('school_id', schoolId)
    .eq('scheduled_month', scheduledMonth)
    .in('class', classNames)
    .in('section', sectionNames)
    .order('class', { ascending: true })
    .order('subject', { ascending: true });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  const filtered = (data ?? []).filter((row: Record<string, unknown>) =>
    classSections.some(
      (cs) =>
        cs.class_name === (row.class as string) && cs.section === (row.section as string)
    )
  );

  sendSuccess(res, filtered);
});

// ── PUT /api/recovery-schedules/:id/approve ──────────────────────────────────
/**
 * Teacher approves the schedule (generate_now decision).
 * Sets status = 'approved', teacher_decision = 'generate_now', teacher_decision_at = now.
 * Then automatically triggers pack generation and test generation in the background.
 */
router.put('/:id/approve', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'No school associated with your account', 403);
    return;
  }

  const schedule = await getOwnedSchedule(req.params.id, teacherId, schoolId);
  if (!schedule) {
    sendError(res, 'Schedule not found or not accessible', 404);
    return;
  }

  if (!['pending_teacher_approval', 'postponed'].includes(schedule.status as string)) {
    sendError(res, `Cannot approve a schedule with status '${schedule.status as string}'`, 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('monthly_recovery_schedules')
    .update({
      status: 'approved',
      teacher_decision: 'generate_now',
      teacher_decision_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Respond immediately — generation runs in the background
  sendSuccess(
    res,
    data,
    `Recovery test approved for ${schedule.subject as string} — Generation started`
  );

  // Auto-trigger pack + test generation in background
  setImmediate(async () => {
    const scheduleId = req.params.id;
    const apiBase = process.env.INTERNAL_API_BASE ?? `http://localhost:${process.env.PORT ?? 3001}`;
    const cronSecret = process.env.CRON_SECRET ?? '';
    try {
      // Trigger pack generation
      await fetch(`${apiBase}/api/recovery/generate-pack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
        },
        body: JSON.stringify({ schedule_id: scheduleId }),
      });
      // Small delay, then trigger test generation
      await new Promise((r) => setTimeout(r, 1000));
      await fetch(`${apiBase}/api/recovery/generate-test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
        },
        body: JSON.stringify({ schedule_id: scheduleId }),
      });
    } catch (genErr) {
      console.error('[recovery-schedules/approve] Auto-generation trigger failed:', genErr instanceof Error ? genErr.message : genErr);
    }
  });
});

// ── PUT /api/recovery-schedules/:id/postpone ─────────────────────────────────
/**
 * Teacher postpones: new date + reason.
 * Updates scheduled_test_date, recovery_pack_date, status='postponed' then 'approved',
 * teacher_decision='postpone', postpone_reason, teacher_decision_at.
 *
 * Per spec: status transitions to 'postponed' first, then 'approved'.
 * We store 'approved' as the final status so the row disappears from the pending list.
 */
router.put('/:id/postpone', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'No school associated with your account', 403);
    return;
  }

  const parsed = postponeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const schedule = await getOwnedSchedule(req.params.id, teacherId, schoolId);
  if (!schedule) {
    sendError(res, 'Schedule not found or not accessible', 404);
    return;
  }

  if (!['pending_teacher_approval', 'postponed'].includes(schedule.status as string)) {
    sendError(res, `Cannot postpone a schedule with status '${schedule.status as string}'`, 400);
    return;
  }

  const { new_test_date, postpone_reason } = parsed.data;
  const newRecoveryPackDate = subtractDaysFromDateStr(new_test_date, 7);

  const { data, error } = await supabaseAdmin
    .from('monthly_recovery_schedules')
    .update({
      scheduled_test_date: new_test_date,
      recovery_pack_date: newRecoveryPackDate,
      status: 'approved',
      teacher_decision: 'postpone',
      postpone_reason,
      teacher_decision_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(
    res,
    data,
    `Recovery test postponed to ${new_test_date} for ${schedule.subject as string}`
  );
});

// ── PUT /api/recovery-schedules/:id/cancel ────────────────────────────────────
/**
 * Teacher cancels this month's recovery test.
 * Updates status='cancelled', teacher_decision='cancel', teacher_decision_at.
 * Also cancels any recovery_packs rows for this schedule.
 */
router.put('/:id/cancel', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id;

  if (!schoolId) {
    sendError(res, 'No school associated with your account', 403);
    return;
  }

  const schedule = await getOwnedSchedule(req.params.id, teacherId, schoolId);
  if (!schedule) {
    sendError(res, 'Schedule not found or not accessible', 404);
    return;
  }

  if (schedule.status === 'cancelled') {
    sendError(res, 'Schedule is already cancelled', 400);
    return;
  }

  // Cancel the schedule
  const { data, error } = await supabaseAdmin
    .from('monthly_recovery_schedules')
    .update({
      status: 'cancelled',
      teacher_decision: 'cancel',
      teacher_decision_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Cancel associated recovery_packs that haven't been generated yet
  await supabaseAdmin
    .from('recovery_packs')
    .update({ generation_status: 'failed' })
    .eq('recovery_schedule_id', req.params.id)
    .in('generation_status', ['pending', 'processing']);

  // Also ensure no monthly_recovery_tests for this schedule remain visible.
  // Force is_available = false regardless of current state so cancelled
  // schedules never surface to students.
  await supabaseAdmin
    .from('monthly_recovery_tests')
    .update({ is_available: false })
    .eq('recovery_schedule_id', req.params.id);

  sendSuccess(
    res,
    data,
    `Recovery test cancelled for ${schedule.subject as string}`
  );
});

// ── GET /api/recovery-schedules/:id/generation-status ─────────────────────────
/**
 * Returns the pack and test generation status summary for a specific schedule.
 * Used by the teacher dashboard status column and retry buttons.
 *
 * Response:
 * {
 *   schedule_id,
 *   pack: { status: 'pending'|'processing'|'completed'|'failed', total, completed, failed },
 *   test: { status: 'pending'|'processing'|'completed'|'failed', total, completed, failed,
 *           available_date }
 * }
 */
router.get('/:id/generation-status', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolIdRaw = req.user!.school_id;

  if (!schoolIdRaw) {
    sendError(res, 'No school associated with your account', 403);
    return;
  }
  const schoolId = schoolIdRaw as string;

  const schedule = await getOwnedSchedule(req.params.id, teacherId, schoolId);
  if (!schedule) {
    sendError(res, 'Schedule not found or not accessible', 404);
    return;
  }

  // Fetch recovery_packs summary
  const { data: packs } = await supabaseAdmin
    .from('recovery_packs')
    .select('id, generation_status')
    .eq('recovery_schedule_id', req.params.id);

  // Fetch monthly_recovery_tests summary
  const { data: tests } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('id, generation_status, is_available')
    .eq('recovery_schedule_id', req.params.id);

  type GenRow = { id: string; generation_status: string };

  function summarise(rows: GenRow[] | null): {
    status: 'none' | 'pending' | 'processing' | 'completed' | 'failed';
    total: number;
    completed: number;
    processing: number;
    failed: number;
  } {
    if (!rows || rows.length === 0) {
      return { status: 'none', total: 0, completed: 0, processing: 0, failed: 0 };
    }
    const total      = rows.length;
    const completed  = rows.filter((r) => r.generation_status === 'completed').length;
    const processing = rows.filter((r) => r.generation_status === 'processing').length;
    const failed     = rows.filter((r) => r.generation_status === 'failed').length;

    let status: 'pending' | 'processing' | 'completed' | 'failed' = 'pending';
    if (failed > 0 && completed + processing === 0) status = 'failed';
    else if (processing > 0)                          status = 'processing';
    else if (completed === total)                     status = 'completed';
    else if (failed > 0)                              status = 'failed';
    else                                              status = 'processing';

    return { status, total, completed, processing, failed };
  }

  const packSummary = summarise((packs ?? []) as GenRow[]);
  const testSummary = summarise((tests ?? []) as GenRow[]);

  sendSuccess(res, {
    schedule_id: req.params.id,
    scheduled_test_date: schedule.scheduled_test_date,
    pack: packSummary,
    test: {
      ...testSummary,
      available_date: schedule.scheduled_test_date as string | null,
    },
  });
});

export default router;
