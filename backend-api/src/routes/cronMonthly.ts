/**
 * /api/cron/monthly — Railway cron-triggered monthly report jobs
 *
 * All endpoints accept:
 *   - x-cron-secret header (Railway / GitHub Actions)
 *   - ?secret= query param  (cron-job.org free plan, GET requests)
 *
 * ── Setup: cron-job.org ───────────────────────────────────────────────────────
 *   Job 1 — Submit Batch (1st of every month at midnight UTC):
 *     URL:      https://your-api.railway.app/api/cron/monthly/submit-batch?secret=YOUR_CRON_SECRET
 *     Method:   GET
 *     Schedule: 0 0 1 * *
 *
 *   Job 2 — Deliver (every 30 minutes, handles batch polling + 9 AM IST window):
 *     URL:      https://your-api.railway.app/api/cron/monthly/deliver?secret=YOUR_CRON_SECRET
 *     Method:   GET
 *     Schedule: *\/30 * * * *
 *
 * POST /api/cron/monthly/recalculate/:studentId
 *   — Admin-triggered recalculation for a single student (no WhatsApp sent).
 *     Auth: schooladmin or superadmin JWT.
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';
import { sleep } from '../services/whatsappService';
import {
  getStudentMonthlyData,
  generateMonthlyReport,
  assembleWhatsAppMessage,
  saveAndSendReport,
  submitGeminiBatch,
  checkGeminiBatch,
  StudentMonthlyData,
} from '../services/monthlyReportService';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Timing-safe cron secret verification.
 * Accepts secret via x-cron-secret header (Railway/GitHub Actions)
 * OR ?secret= query param (cron-job.org free plan GET requests).
 */
function verifyCronSecret(req: Request, res: Response): boolean {
  const cronSecret = (process.env.CRON_SECRET ?? '').trim();
  const rawHeader  = req.headers['x-cron-secret'];
  const fromHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  // Also accept secret as a query param for GET-only cron services (e.g. cron-job.org free)
  const fromQuery  = req.query['secret'] as string | undefined;
  const provided   = (fromHeader ?? fromQuery ?? '').trim();

  // Use timing-safe comparison to prevent timing-attack secret enumeration
  if (
    !cronSecret ||
    provided.length !== cronSecret.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(cronSecret))
  ) {
    sendError(res, 'Unauthorized', 401);
    return false;
  }
  return true;
}

/** Returns the 1st of the current UTC month at 00:00:00. */
function getCurrentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** Returns a human-readable month label e.g. "June 2026". */
function getMonthLabel(date: Date): string {
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Shared logic for recalculating one student's monthly report without sending WhatsApp.
 * Used by both the cron recalculate endpoint and the monthly-analysis route.
 */
export async function recalculateStudentReport(
  studentId: string,
  schoolId: string | null
): Promise<{
  reportText: string;
  whatsappMessage: string;
} | { error: string; status: number }> {
  // Verify student exists and belongs to the caller's school
  let query = supabaseAdmin
    .from('students')
    .select('id, full_name, school_id')
    .eq('id', studentId)
    .eq('is_deleted', false);

  // schooladmins are scoped to their school; superadmins can act on any
  if (schoolId) {
    query = query.eq('school_id', schoolId);
  }

  const { data: student } = await query.maybeSingle();

  if (!student) {
    return { error: 'Student not found', status: 404 };
  }

  const monthStartDate = getCurrentMonthStart();
  const monthLabel     = getMonthLabel(monthStartDate);

  const data    = await getStudentMonthlyData(studentId, monthStartDate);
  const content = await generateMonthlyReport(data, monthLabel);
  const msg     = assembleWhatsAppMessage(data.studentName, monthLabel, content);

  await saveAndSendReport(
    studentId,
    monthStartDate,
    JSON.stringify(content),
    msg,
    data.parentPhone,
    false // no WhatsApp for admin-triggered recalculation
  );

  return {
    reportText:      JSON.stringify(content),
    whatsappMessage: msg,
  };
}

// ── Submit-batch handler (shared between GET and POST) ────────────────────────

async function handleSubmitBatch(req: Request, res: Response): Promise<void> {
  if (!verifyCronSecret(req, res)) return;

  const monthStartDate = getCurrentMonthStart();
  const monthLabel     = getMonthLabel(monthStartDate);

  console.log(`[cron/monthly/submit-batch] Triggered for ${monthLabel}`);

  // Respond immediately so the cron service doesn't time out
  res.status(202).json({
    success: true,
    message: 'Monthly report batch job started',
    month:   monthLabel,
  });

  // ── Background processing ─────────────────────────────────────────────────
  setImmediate(async () => {
    try {
      // FIX 4: Process schools one at a time instead of fetching all students
      // across all schools in one unbounded query (can be 100k+ rows at scale).

      // 1. Fetch all active school IDs
      const { data: schools, error: schoolErr } = await supabaseAdmin
        .from('schools')
        .select('id')
        .eq('is_active', true);

      if (schoolErr) {
        console.error('[cron/monthly/submit-batch] Failed to fetch schools:', schoolErr.message);
        return;
      }

      const schoolRows = (schools ?? []) as Array<{ id: string }>;
      console.log(`[cron/monthly/submit-batch] Processing ${schoolRows.length} schools for ${monthLabel}`);

      for (const school of schoolRows) {
        const schoolId = school.id;

        // 2. Fetch only this school's students with a parent_phone
        const { data: students, error: stuErr } = await supabaseAdmin
          .from('students')
          .select('id, full_name, parent_phone, school_id')
          .eq('school_id', schoolId)
          .eq('is_deleted', false)
          .not('parent_phone', 'is', null);

        if (stuErr) {
          console.error(`[cron/monthly/submit-batch] Failed to fetch students for school ${schoolId}:`, stuErr.message);
          continue;
        }

        const studentRows = (students ?? []) as Array<{
          id: string; full_name: string; parent_phone: string; school_id: string;
        }>;

        if (studentRows.length === 0) continue;

        console.log(`[cron/monthly/submit-batch] School ${schoolId}: ${studentRows.length} students`);

        // 3. Gather monthly data for each student in this school
        const allStudentData: StudentMonthlyData[] = [];
        for (const s of studentRows) {
          try {
            const data = await getStudentMonthlyData(s.id, monthStartDate);
            allStudentData.push(data);
          } catch (err) {
            console.warn(
              `[cron/monthly/submit-batch] getStudentMonthlyData failed for ${s.id}:`,
              err instanceof Error ? err.message : err
            );
          }
        }

        // 4. Try Gemini Batch submission for this school
        const batchJobId = await submitGeminiBatch(allStudentData, monthLabel, monthStartDate);

        if (batchJobId) {
          // 4a. Record batch job scoped to this school
          const { error: insertErr } = await supabaseAdmin
            .from('monthly_report_batches')
            .insert({
              batch_job_id:     batchJobId,
              month_start_date: monthStartDate.toISOString().slice(0, 10),
              status:           'submitted',
              total_students:   studentRows.length,
              school_id:        schoolId,
            });

          if (insertErr) {
            console.error(
              `[cron/monthly/submit-batch] Failed to insert batch row for school ${schoolId}:`,
              insertErr.message
            );
          }

          console.log(
            `[cron/monthly/submit-batch] School ${schoolId}: batch submitted — jobId: ${batchJobId}, students: ${studentRows.length}`
          );
          continue;
        }

        // 4b. Batch disabled or failed — process sequentially (max 50 at a time)
        console.log(`[cron/monthly/submit-batch] School ${schoolId}: batch disabled/failed — processing sequentially`);

        const CHUNK_SIZE = 50;
        let processed = 0;

        for (let i = 0; i < allStudentData.length; i += CHUNK_SIZE) {
          const chunk = allStudentData.slice(i, i + CHUNK_SIZE);

          for (const data of chunk) {
            try {
              const content = await generateMonthlyReport(data, monthLabel);
              const msg     = assembleWhatsAppMessage(data.studentName, monthLabel, content);

              await saveAndSendReport(
                data.studentId,
                monthStartDate,
                JSON.stringify(content),
                msg,
                data.parentPhone,
                true // send WhatsApp
              );

              processed++;
            } catch (err) {
              console.warn(
                `[cron/monthly/submit-batch] Sequential error for student ${data.studentId}:`,
                err instanceof Error ? err.message : err
              );
            }

            // Throttle between sends to respect Meta rate limits
            await sleep(100);
          }
        }

        console.log(
          `[cron/monthly/submit-batch] School ${schoolId}: sequential complete — processed: ${processed}/${studentRows.length}`
        );
      }

      console.log(`[cron/monthly/submit-batch] All schools processed for ${monthLabel}`);
    } catch (err) {
      console.error('[cron/monthly/submit-batch] Fatal background error:', err);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
}

// ── Deliver handler (shared between GET and POST) ─────────────────────────────

async function handleDeliver(req: Request, res: Response): Promise<void> {
  if (!verifyCronSecret(req, res)) return;

  console.log('[cron/monthly/deliver] Triggered');

  // Respond immediately
  res.status(202).json({
    success: true,
    message: 'Monthly deliver job started',
  });

  setImmediate(async () => {
    try {
      const nowUtcHour = new Date().getUTCHours();
      // 9 AM IST = 03:30 UTC
      const isAfter9AmIST = nowUtcHour >= 3;

      let checkedBatches = 0;
      let processedTotal = 0;

      // ── FIX 2: Idempotency guard — skip if already delivered this month ───
      // If any monthly_reports row for the current month already has
      // whatsapp_sent_at set, the deliver job already ran. Skip to prevent
      // duplicate WhatsApp messages when the cron fires multiple times.
      const monthStartDate = getCurrentMonthStart();
      const monthStartIso  = monthStartDate.toISOString().slice(0, 10);

      const { count: alreadyDeliveredCount, error: idempotencyErr } = await supabaseAdmin
        .from('monthly_reports')
        .select('id', { count: 'exact', head: true })
        .eq('month_start_date', monthStartIso)
        .not('whatsapp_sent_at', 'is', null);

      if (!idempotencyErr && (alreadyDeliveredCount ?? 0) > 0) {
        console.log(
          `[cron/monthly/deliver] Already delivered ${alreadyDeliveredCount} reports for ${monthStartIso} — skipping to prevent duplicates`
        );
        return;
      }

      // ── Step 3: Stale lock cleanup — release locks older than 30 minutes ──
      // A crashed previous run may have left deliver_locked_at set.
      // Releasing it here allows the current run to claim those batches.
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await supabaseAdmin
        .from('monthly_report_batches')
        .update({ deliver_locked_at: null, deliver_lock_id: null })
        .eq('status', 'submitted')
        .lt('deliver_locked_at', thirtyMinsAgo);

      console.log('[cron/monthly/deliver] Stale lock cleanup complete');

      // ── 1. Poll pending/processing batch jobs ─────────────────────────────
      const { data: pendingBatches, error: batchErr } = await supabaseAdmin
        .from('monthly_report_batches')
        .select('id, batch_job_id, month_start_date, total_students')
        .in('status', ['submitted', 'processing']);

      if (batchErr) {
        console.error('[cron/monthly/deliver] Failed to fetch batches:', batchErr.message);
      }

      for (const batch of pendingBatches ?? []) {
        const b = batch as {
          id: string; batch_job_id: string;
          month_start_date: string; total_students: number;
        };

        checkedBatches++;

        // ── Step 2: Optimistic lock — atomic claim via WHERE deliver_locked_at IS NULL ──
        const lockId = crypto.randomUUID();
        const now    = new Date().toISOString();

        const { data: locked, error: lockError } = await supabaseAdmin
          .from('monthly_report_batches')
          .update({ deliver_locked_at: now, deliver_lock_id: lockId })
          .eq('id', b.id)
          .eq('status', 'submitted')
          .is('deliver_locked_at', null) // only claim if not already locked
          .select('id')
          .single();

        if (lockError || !locked) {
          console.log(`[cron/monthly/deliver] Batch ${b.id} already locked by another process — skipping`);
          continue;
        }

        try {
          const result = await checkGeminiBatch(b.batch_job_id);

          if (result.status === 'running') {
            // Still processing — mark as 'processing' so we know it was polled
            await supabaseAdmin
              .from('monthly_report_batches')
              .update({ status: 'processing' })
              .eq('id', b.id);

            console.log(`[cron/monthly/deliver] Batch ${b.batch_job_id} still running — skip`);
            continue;
          }

          if (result.status === 'failed') {
            await supabaseAdmin
              .from('monthly_report_batches')
              .update({ status: 'failed' })
              .eq('id', b.id);

            console.error(`[cron/monthly/deliver] Batch ${b.batch_job_id} failed`);
            continue;
          }

          // Completed — process each result
          const monthStartDate = new Date(`${b.month_start_date}T00:00:00.000Z`);
          const monthLabel     = getMonthLabel(monthStartDate);
          let   processed      = 0;

          // ── Step 2 (verify): confirm we still hold the lock before sending ──
          const { data: verify } = await supabaseAdmin
            .from('monthly_report_batches')
            .select('deliver_lock_id')
            .eq('id', b.id)
            .single();

          if ((verify as { deliver_lock_id: string | null } | null)?.deliver_lock_id !== lockId) {
            console.log(`[cron/monthly/deliver] Batch ${b.id} lock stolen — skipping`);
            continue;
          }

          for (const item of result.results ?? []) {
            try {
              // Fetch student data for phone number
              const { data: studentRow } = await supabaseAdmin
                .from('students')
                .select('full_name, parent_phone')
                .eq('id', item.studentId)
                .maybeSingle();

              if (!studentRow) {
                console.warn(`[cron/monthly/deliver] Student ${item.studentId} not found`);
                continue;
              }

              const sr      = studentRow as { full_name: string; parent_phone: string | null };
              const msg     = assembleWhatsAppMessage(sr.full_name, monthLabel, item.content);
              const sendNow = isAfter9AmIST;

              // ── Step 4: WhatsApp dedup guard — skip if already sent this month ──
              const { data: existing } = await supabaseAdmin
                .from('monthly_reports')
                .select('whatsapp_sent_at')
                .eq('student_id', item.studentId)
                .eq('month_start_date', b.month_start_date)
                .single();

              if ((existing as { whatsapp_sent_at: string | null } | null)?.whatsapp_sent_at) {
                console.log(`[cron/monthly/deliver] WhatsApp already sent for student ${item.studentId} — skipping duplicate`);
                continue;
              }

              await saveAndSendReport(
                item.studentId,
                monthStartDate,
                JSON.stringify(item.content),
                msg,
                sr.parent_phone,
                sendNow
              );

              processed++;
              processedTotal++;
            } catch (err) {
              console.warn(
                `[cron/monthly/deliver] Error processing student ${item.studentId}:`,
                err instanceof Error ? err.message : err
              );
            }
          }

          // Update batch record as completed
          await supabaseAdmin
            .from('monthly_report_batches')
            .update({
              status:             'completed',
              completed_at:       new Date().toISOString(),
              processed_students: processed,
            })
            .eq('id', b.id);

          console.log(
            `[cron/monthly/deliver] Batch ${b.batch_job_id} completed — processed ${processed} reports`
          );
        } catch (err) {
          console.error(
            `[cron/monthly/deliver] Error checking batch ${b.batch_job_id}:`,
            err instanceof Error ? err.message : err
          );
          if (process.env.SENTRY_DSN) Sentry.captureException(err);
        }
      }

      // ── 2. Handle 9 AM IST delivery for saved-but-unsent reports ─────────
      if (isAfter9AmIST) {
        const todayIso = new Date().toISOString().slice(0, 10);

        const { data: unsentReports, error: unsentErr } = await supabaseAdmin
          .from('monthly_reports')
          .select('student_id, month_start_date, report_text, whatsapp_message')
          .is('whatsapp_sent_at', null)
          .lt('generated_at', `${todayIso}T00:00:00.000Z`);

        if (unsentErr) {
          console.error('[cron/monthly/deliver] Failed to fetch unsent reports:', unsentErr.message);
        }

        for (const row of unsentReports ?? []) {
          const r = row as {
            student_id: string; month_start_date: string;
            report_text: string; whatsapp_message: string;
          };

          try {
            const { data: studentRow } = await supabaseAdmin
              .from('students')
              .select('parent_phone')
              .eq('id', r.student_id)
              .maybeSingle();

            const parentPhone =
              (studentRow as { parent_phone: string | null } | null)?.parent_phone ?? null;

            if (!parentPhone) continue;

            const monthStartDate = new Date(`${r.month_start_date}T00:00:00.000Z`);

            // ── Step 4: WhatsApp dedup guard (delayed-send path) ──────────────
            const { data: existingDelayed } = await supabaseAdmin
              .from('monthly_reports')
              .select('whatsapp_sent_at')
              .eq('student_id', r.student_id)
              .eq('month_start_date', r.month_start_date)
              .single();

            if ((existingDelayed as { whatsapp_sent_at: string | null } | null)?.whatsapp_sent_at) {
              console.log(`[cron/monthly/deliver] WhatsApp already sent for student ${r.student_id} — skipping duplicate`);
              continue;
            }

            await saveAndSendReport(
              r.student_id,
              monthStartDate,
              r.report_text,
              r.whatsapp_message,
              parentPhone,
              true // now send it
            );

            processedTotal++;
          } catch (err) {
            console.warn(
              `[cron/monthly/deliver] Error sending delayed WhatsApp for student ${r.student_id}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      }

      console.log(
        `[cron/monthly/deliver] Done — checked: ${checkedBatches} batches, processed: ${processedTotal} reports`
      );
    } catch (err) {
      console.error('[cron/monthly/deliver] Fatal background error:', err);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
}

// ── Route registrations ───────────────────────────────────────────────────────

// Accept both GET (cron-job.org free plan, ?secret= in URL) and POST
router.get('/submit-batch', handleSubmitBatch);
router.post('/submit-batch', handleSubmitBatch);

router.get('/deliver', handleDeliver);
router.post('/deliver', handleDeliver);

// ── POST /api/cron/monthly/recalculate/:studentId ─────────────────────────────
/**
 * Admin-triggered recalculation for a single student.
 * Auth: schooladmin or superadmin JWT (not cron secret).
 * Does NOT send WhatsApp — admin trigger only.
 */
router.post(
  '/recalculate/:studentId',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const studentId = req.params.studentId as string;
    const schoolId  = req.user!.school_id;

    const result = await recalculateStudentReport(studentId, schoolId);

    if ('error' in result) {
      sendError(res, result.error, result.status);
      return;
    }

    sendSuccess(
      res,
      {
        success:         true,
        reportText:      result.reportText,
        whatsappMessage: result.whatsappMessage,
      },
      'Recalculation complete'
    );
  }
);

export default router;
