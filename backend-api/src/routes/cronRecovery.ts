/**
 * /api/cron/recovery — Monthly recovery schedule cron jobs
 *
 * All endpoints are protected by x-cron-secret header (CRON_SECRET env var).
 * Also accepts ?secret= query param for cron-job.org free plan (GET requests).
 *
 * POST|GET /api/cron/recovery/monthly-scheduler
 *   — 1 AM on 1st of every month: generate monthly_recovery_schedules rows
 *     for each school / class+section / subject combination and notify teachers.
 *
 * POST /api/cron/recovery/check-batch-jobs
 *   — Every 2 hours: poll Gemini batch job status and update recovery_packs
 *     and monthly_recovery_tests rows when generation completes.
 *   Railway cron schedule: 0 *\/2 * * *
 *
 * POST /api/cron/recovery/activate-tests
 *   — Daily (add to existing 9 PM cron or run independently): set is_available=true
 *     on monthly_recovery_tests where scheduled_test_date = today.
 *     Also sends FCM push notifications to those students.
 *   Railway cron schedule: 0 15 * * *  (9 PM IST = 15:00 UTC)
 *
 * ── Setup: cron-job.org ───────────────────────────────────────────────────────
 *   URL:      https://your-api.railway.app/api/cron/recovery/monthly-scheduler?secret=YOUR_CRON_SECRET
 *   Method:   GET  (free plan) or POST (pro plan with header x-cron-secret)
 *   Schedule: 0 1 1 * *  (1 AM UTC on the 1st of every month)
 *
 * ── Setup: GitHub Actions (alternative) ──────────────────────────────────────
 *   Add to .github/workflows/recovery-scheduler.yml:
 *     on:
 *       schedule:
 *         - cron: '0 1 1 * *'
 *   Then curl: POST /api/cron/recovery/monthly-scheduler
 *              -H "x-cron-secret: ${{ secrets.CRON_SECRET }}"
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import * as Sentry from '@sentry/node';
import { supabaseAdmin } from '../config/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { sendPushNotification } from '../services/fcmService';

const router = Router();

// ── Auth helper ───────────────────────────────────────────────────────────────

function verifyCronSecret(req: Request, res: Response): boolean {
  const cronSecret = (process.env.CRON_SECRET ?? '').trim();
  const rawHeader = req.headers['x-cron-secret'];
  const fromHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  // Also accept secret as a query param for GET-only cron services (e.g. cron-job.org free)
  const fromQuery = req.query['secret'] as string | undefined;
  const provided = (fromHeader ?? fromQuery ?? '').trim();

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

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the date of the last Monday in the given year/month.
 * month is 1-based (1 = January).
 */
function getLastMondayOfMonth(year: number, month: number): Date {
  // Start from the last day of the month and walk backwards to Monday
  const lastDay = new Date(year, month, 0); // day 0 = last day of previous month (i.e. this month)
  const dayOfWeek = lastDay.getDay(); // 0=Sun 1=Mon ... 6=Sat
  // Days to subtract to reach last Monday
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const lastMonday = new Date(lastDay);
  lastMonday.setDate(lastDay.getDate() - daysToSubtract);
  return lastMonday;
}

/**
 * Format a Date as YYYY-MM-DD (local date, no timezone shift).
 */
function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Subtract N days from a Date, return new Date.
 */
function subtractDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() - days);
  return result;
}

// ── POST|GET /api/cron/recovery/monthly-scheduler ────────────────────────────
/**
 * 1st of month cron: for every school, every active class+section, every
 * subject seen in the last 60 days of daily_tests, create a
 * monthly_recovery_schedules row (idempotent) and notify the class teacher.
 *
 * Accepts GET for cron-job.org free plan (?secret=...) and
 * POST with x-cron-secret header for GitHub Actions / paid plans.
 */
async function runMonthlyScheduler(req: Request, res: Response): Promise<void> {
  if (!verifyCronSecret(req, res)) return;

  const startedAt = new Date().toISOString();

  // Respond immediately — Railway cron timeout is short
  sendSuccess(
    res,
    { message: 'Monthly recovery scheduler started', started_at: startedAt },
    'Job started'
  );

  setImmediate(async () => {
    let schedulesCreated = 0;
    let schedulesSkipped = 0;
    const errors: string[] = [];

    try {
      // ── 1. Determine scheduled_month (first day of current month) ────────────
      const now = new Date();
      const scheduledMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const scheduledMonthStr = toDateString(scheduledMonth); // e.g. 2026-08-01

      // ── 2. Calculate default test date (last Monday of current month) ────────
      let testDate = getLastMondayOfMonth(now.getFullYear(), now.getMonth() + 1);

      // If we're already past that last Monday, use next month's last Monday
      const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (todayMidnight >= testDate) {
        const nextMonth = now.getMonth() + 1; // 0-based; wraps automatically via Date()
        const nextMonthYear = nextMonth === 12 ? now.getFullYear() + 1 : now.getFullYear();
        const nextMonthNum = (nextMonth % 12) + 1; // 1-based
        testDate = getLastMondayOfMonth(nextMonthYear, nextMonthNum);
      }

      const scheduledTestDateStr = toDateString(testDate);
      const recoveryPackDateStr = toDateString(subtractDays(testDate, 7));

      // ── 3. Fetch all schools ──────────────────────────────────────────────────
      const { data: schools, error: schoolsErr } = await supabaseAdmin
        .from('schools')
        .select('id')
        .eq('subscription_status', true);

      if (schoolsErr || !schools) {
        console.error('[cron/recovery] Failed to fetch schools:', schoolsErr?.message);
        return;
      }

      const sixtyDaysAgo = toDateString(subtractDays(now, 60));

      for (const school of schools as Array<{ id: string }>) {
        const schoolId = school.id;

        try {
          // ── 4. Get distinct active class+section combos for this school ───────
          const { data: classSections } = await supabaseAdmin
            .from('students')
            .select('class_name, section')
            .eq('school_id', schoolId)
            .not('class_name', 'is', null)
            .not('section', 'is', null);

          if (!classSections || classSections.length === 0) continue;

          // Deduplicate class+section pairs
          const uniqueClassSections = [
            ...new Map(
              (classSections as Array<{ class_name: string; section: string }>)
                .filter((r) => r.class_name && r.section)
                .map((r) => [`${r.class_name}||${r.section}`, r])
            ).values(),
          ];

          for (const { class_name, section } of uniqueClassSections) {
            try {
              // ── 5. Get subjects taught in this class in last 60 days ──────────
              // Pull from daily_tests (which has the subject field and class/section).
              // Try class_name column first; the table may use 'class' (legacy).
              const { data: subjectRows } = await supabaseAdmin
                .from('daily_tests')
                .select('subject')
                .eq('school_id', schoolId)
                .or(`class_name.eq.${class_name},class.eq.${class_name}`)
                .eq('section', section)
                .gte('created_at', `${sixtyDaysAgo}T00:00:00.000Z`);

              const subjects = [
                ...new Set(
                  (subjectRows ?? [])
                    .map((r: Record<string, unknown>) => r.subject as string)
                    .filter(Boolean)
                ),
              ];

              if (subjects.length === 0) continue;

              // ── 6. Find class teacher for this class+section ──────────────────
              // Look in teacher_assignments — take the first match.
              const { data: teacherRows } = await supabaseAdmin
                .from('teacher_assignments')
                .select('teacher_id')
                .eq('school_id', schoolId)
                .or(`class_name.eq.${class_name},class.eq.${class_name}`)
                .eq('section', section)
                .limit(1);

              const teacherId =
                (teacherRows as Array<{ teacher_id: string }> | null)?.[0]?.teacher_id ?? null;

              for (const subject of subjects) {
                try {
                  // ── 7. Idempotency check ────────────────────────────────────
                  const { data: existing } = await supabaseAdmin
                    .from('monthly_recovery_schedules')
                    .select('id')
                    .eq('school_id', schoolId)
                    .eq('class', class_name)
                    .eq('section', section)
                    .eq('subject', subject)
                    .eq('scheduled_month', scheduledMonthStr)
                    .maybeSingle();

                  if (existing) {
                    schedulesSkipped++;
                    continue;
                  }

                  // ── 8. Insert schedule row ────────────────────────────────────
                  const { data: inserted, error: insertErr } = await supabaseAdmin
                    .from('monthly_recovery_schedules')
                    .insert({
                      school_id: schoolId,
                      class: class_name,
                      section,
                      subject,
                      scheduled_month: scheduledMonthStr,
                      scheduled_test_date: scheduledTestDateStr,
                      recovery_pack_date: recoveryPackDateStr,
                      teacher_id: teacherId,
                      status: 'pending_teacher_approval',
                    })
                    .select('id')
                    .single();

                  if (insertErr || !inserted) {
                    errors.push(`Insert failed [${schoolId}/${class_name}/${section}/${subject}]: ${insertErr?.message}`);
                    continue;
                  }

                  schedulesCreated++;

                  // ── 9. Notify teacher ─────────────────────────────────────────
                  if (teacherId) {
                    const notifTitle = 'Action Required: Monthly Recovery Test';
                    const notifBody = `Class ${class_name}${section} ${subject} — Review and confirm this month's recovery test schedule.`;

                    // Insert in-app notification
                    await supabaseAdmin.from('notifications').insert({
                      title: notifTitle,
                      message: notifBody,
                      type: 'reminder',
                      recipient_id: teacherId,
                      sender_id: teacherId, // system-generated; reuse teacher id as sender
                      is_read: false,
                      created_at: new Date().toISOString(),
                    });

                    // FCM push (fire-and-forget; errors are non-fatal)
                    try {
                      await sendPushNotification(
                        teacherId,
                        notifTitle,
                        notifBody,
                        {
                          type: 'monthly_recovery_schedule',
                          schedule_id: (inserted as Record<string, unknown>).id as string,
                          class_name,
                          section,
                          subject,
                        },
                        'user'
                      );
                    } catch (fcmErr) {
                      console.warn('[cron/recovery] FCM push failed (non-fatal):', fcmErr);
                    }
                  }
                } catch (subjectErr) {
                  const msg = subjectErr instanceof Error ? subjectErr.message : String(subjectErr);
                  errors.push(`Subject loop error [${class_name}/${section}/${subject}]: ${msg}`);
                }
              }
            } catch (classErr) {
              const msg = classErr instanceof Error ? classErr.message : String(classErr);
              errors.push(`Class loop error [${class_name}/${section}]: ${msg}`);
            }
          }
        } catch (schoolErr) {
          const msg = schoolErr instanceof Error ? schoolErr.message : String(schoolErr);
          errors.push(`School error [${schoolId}]: ${msg}`);
        }
      }

      console.log(
        `[cron/recovery] monthly-scheduler complete — created: ${schedulesCreated}, skipped: ${schedulesSkipped}, errors: ${errors.length}`
      );
      if (errors.length > 0) {
        console.error('[cron/recovery] Errors:', errors);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cron/recovery] monthly-scheduler crashed:', msg);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
}

// Accept both GET and POST:
// - GET  → cron-job.org free plan uses GET + ?secret= query param
// - POST → GitHub Actions / paid cron services use POST + x-cron-secret header
router.get('/monthly-scheduler',  runMonthlyScheduler);
router.post('/monthly-scheduler', runMonthlyScheduler);

// ── Gemini Batch API poller ───────────────────────────────────────────────────

interface BatchJobResult {
  state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  results: Array<{ key: string; content: string }>;
}

/**
 * Poll a Gemini Batch API job by name.
 * Returns the job state and, if SUCCEEDED, the inline response results.
 */
async function pollGeminiBatchJob(jobName: string, apiKey: string): Promise<BatchJobResult> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${jobName}?key=${apiKey}`,
    { method: 'GET' }
  );

  if (!response.ok) {
    throw new Error(`Batch API poll failed ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as {
    state?: string;
    dest?: {
      inlinedResponses?: Array<{
        key?: string;
        response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      }>;
    };
  };

  const rawState = data.state ?? 'PENDING';
  // Gemini Batch API states: JOB_STATE_PENDING, JOB_STATE_RUNNING, JOB_STATE_SUCCEEDED, etc.
  let state: BatchJobResult['state'] = 'PENDING';
  if (rawState.includes('SUCCEEDED')) state = 'SUCCEEDED';
  else if (rawState.includes('FAILED')) state = 'FAILED';
  else if (rawState.includes('CANCELLED')) state = 'CANCELLED';
  else if (rawState.includes('RUNNING')) state = 'RUNNING';

  const results: Array<{ key: string; content: string }> = [];
  if (state === 'SUCCEEDED' && data.dest?.inlinedResponses) {
    for (const r of data.dest.inlinedResponses) {
      if (!r.key) continue;
      const text = r.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      results.push({ key: r.key, content: text });
    }
  }

  return { state, results };
}

// ── Teacher notification helper ───────────────────────────────────────────────

async function notifyTeacher(teacherId: string, title: string, message: string): Promise<void> {
  try {
    await supabaseAdmin.from('notifications').insert({
      title,
      message,
      type: 'reminder',
      recipient_id: teacherId,
      sender_id: teacherId,
      is_read: false,
      created_at: new Date().toISOString(),
    });

    const { sendPushNotification } = await import('../services/fcmService');
    await sendPushNotification(teacherId, title, message, { type: 'recovery_pack_ready' }, 'user');
  } catch { /* non-fatal */ }
}

// ── POST /api/cron/recovery/check-batch-jobs ──────────────────────────────────
/**
 * Every-2-hours cron: poll Gemini Batch API for recovery_cycles that are still
 * in 'generating_pack' or 'generating_tests' state.
 *
 * When a pack batch job is done:
 *   - saves each student's pack_content into recovery_packs
 *   - sets cycle status → pack_ready
 *   - sends teacher notification
 *
 * When a test batch job is done:
 *   - saves each student's questions into monthly_recovery_tests
 *   - sets cycle status → tests_ready
 *   - sends teacher notification
 *
 * Railway cron schedule: 0 *\/2 * * *  (every 2 hours)
 */
router.all('/check-batch-jobs', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  const startedAt = new Date().toISOString();
  sendSuccess(res, { message: 'Batch job checker started', started_at: startedAt }, 'Job started');

  setImmediate(async () => {
    let packsUpdated  = 0;
    let testsUpdated  = 0;
    let packsFailed   = 0;
    let testsFailed   = 0;
    const errors: string[] = [];

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error('[cron/recovery] GEMINI_API_KEY not set — skipping batch job check');
        return;
      }

      // ── 1. Find all cycles with pending pack batch jobs ──────────────────────
      const { data: packCycles } = await supabaseAdmin
        .from('recovery_cycles')
        .select('id, pack_batch_job_id, class, section, school_id, created_by')
        .eq('status', 'generating_pack')
        .not('pack_batch_job_id', 'is', null);

      for (const cycle of (packCycles ?? []) as Array<{
        id: string; pack_batch_job_id: string; class: string;
        section: string; school_id: string; created_by: string;
      }>) {
        try {
          const jobResult = await pollGeminiBatchJob(cycle.pack_batch_job_id, apiKey);

          if (jobResult.state === 'PENDING' || jobResult.state === 'RUNNING') continue; // still processing

          if (jobResult.state === 'FAILED' || jobResult.state === 'CANCELLED') {
            await supabaseAdmin.from('recovery_cycles').update({
              status: 'pack_failed',
              lockout_until: null,
              updated_at: new Date().toISOString(),
            }).eq('id', cycle.id);
            packsFailed++;
            continue;
          }

          if (jobResult.state === 'SUCCEEDED') {
            // Save each student's pack content into recovery_packs
            for (const { key, content } of jobResult.results) {
              try {
                const [studentId, subject] = key.split('|');
                const parsed = JSON.parse(content) as unknown;

                await supabaseAdmin
                  .from('recovery_packs')
                  .update({
                    pack_content: parsed,
                    generation_status: 'completed',
                    generated_at: new Date().toISOString(),
                  })
                  .eq('cycle_id', cycle.id)
                  .eq('student_id', studentId)
                  .eq('subject', subject);

                packsUpdated++;
              } catch (parseErr) {
                errors.push(`Pack parse error [cycle=${cycle.id} key=${key}]: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
              }
            }

            await supabaseAdmin.from('recovery_cycles').update({
              status: 'pack_ready',
              pack_generated_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('id', cycle.id);

            // Notify teacher
            await notifyTeacher(
              cycle.created_by,
              '✅ Recovery Packs Ready',
              `Recovery study packs for Class ${cycle.class}-${cycle.section} have been generated. You can now create recovery tests.`
            );
          }
        } catch (cycleErr) {
          errors.push(`Pack cycle [${cycle.id}]: ${cycleErr instanceof Error ? cycleErr.message : String(cycleErr)}`);
        }
      }

      // ── 2. Find all cycles with pending test batch jobs ──────────────────────
      const { data: testCycles } = await supabaseAdmin
        .from('recovery_cycles')
        .select('id, test_batch_job_id, class, section, school_id, created_by')
        .eq('status', 'generating_tests')
        .not('test_batch_job_id', 'is', null);

      for (const cycle of (testCycles ?? []) as Array<{
        id: string; test_batch_job_id: string; class: string;
        section: string; school_id: string; created_by: string;
      }>) {
        try {
          const jobResult = await pollGeminiBatchJob(cycle.test_batch_job_id, apiKey);

          if (jobResult.state === 'PENDING' || jobResult.state === 'RUNNING') continue;

          if (jobResult.state === 'FAILED' || jobResult.state === 'CANCELLED') {
            await supabaseAdmin.from('recovery_cycles').update({
              status: 'test_failed',
              updated_at: new Date().toISOString(),
            }).eq('id', cycle.id);
            testsFailed++;
            continue;
          }

          if (jobResult.state === 'SUCCEEDED') {
            // Save each student's test questions into monthly_recovery_tests
            for (const { key, content } of jobResult.results) {
              try {
                const [studentId, subject] = key.split('|');
                const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
                const parsed = JSON.parse(cleaned) as { questions?: unknown[] };
                const questions = parsed.questions ?? [];

                await supabaseAdmin
                  .from('monthly_recovery_tests')
                  .update({
                    questions,
                    total_questions: questions.length,
                    generation_status: 'completed',
                    generated_at: new Date().toISOString(),
                    is_available: true,
                  })
                  .eq('cycle_id', cycle.id)
                  .eq('student_id', studentId)
                  .eq('subject', subject);

                testsUpdated++;
              } catch (parseErr) {
                errors.push(`Test parse error [cycle=${cycle.id} key=${key}]: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
              }
            }

            await supabaseAdmin.from('recovery_cycles').update({
              status: 'tests_ready',
              test_generated_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('id', cycle.id);

            // Notify teacher
            await notifyTeacher(
              cycle.created_by,
              '⚡ Recovery Tests Ready',
              `Recovery tests for Class ${cycle.class}-${cycle.section} are live. Students can now attempt them.`
            );
          }
        } catch (cycleErr) {
          errors.push(`Test cycle [${cycle.id}]: ${cycleErr instanceof Error ? cycleErr.message : String(cycleErr)}`);
        }
      }

      console.log(
        `[cron/recovery] check-batch-jobs complete — packs: +${packsUpdated} completed, ${packsFailed} failed; tests: +${testsUpdated} completed, ${testsFailed} failed`
      );
      if (errors.length > 0) {
        console.error('[cron/recovery] check-batch-jobs errors:', errors);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cron/recovery] check-batch-jobs crashed:', msg);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
});

// ── GET|POST /api/cron/recovery/activate-tests ───────────────────────────────
/**
 * Daily cron: set is_available=true on monthly_recovery_tests where:
 *   - generation_status = 'completed'
 *   - is_available = false
 *   - The parent monthly_recovery_schedules row has scheduled_test_date = today
 *
 * Also sends FCM push notifications to those students.
 *
 * Accepts GET for cron-job.org free plan (?secret=...) and
 * POST with x-cron-secret header for GitHub Actions / paid plans.
 *
 * Railway cron schedule: 0 15 * * *  (9 PM IST = 15:00 UTC)
 */
async function runActivateTests(req: Request, res: Response): Promise<void> {
  if (!verifyCronSecret(req, res)) return;

  const today = new Date().toISOString().slice(0, 10);
  sendSuccess(res, { message: 'Test activation job started', date: today }, 'Job started');

  setImmediate(async () => {
    let activated = 0;
    let notified  = 0;
    const errors: string[] = [];

    try {
      // Find all recovery schedules whose test date is today
      const { data: schedules } = await supabaseAdmin
        .from('monthly_recovery_schedules')
        .select('id, subject, class, section')
        .eq('scheduled_test_date', today)
        .in('status', ['test_generated', 'pack_generated', 'approved', 'completed']);

      if (!schedules || schedules.length === 0) {
        console.log('[cron/recovery] activate-tests: no schedules with test date today');
        return;
      }

      const scheduleIds = (schedules as Array<{ id: string; subject: string; class: string; section: string }>)
        .map((s) => s.id);

      // Find all completed, not-yet-available tests for these schedules
      const { data: tests } = await supabaseAdmin
        .from('monthly_recovery_tests')
        .select('id, student_id, subject, recovery_schedule_id')
        .in('recovery_schedule_id', scheduleIds)
        .eq('generation_status', 'completed')
        .eq('is_available', false);

      if (!tests || tests.length === 0) {
        console.log('[cron/recovery] activate-tests: no tests to activate for today');
        return;
      }

      const testIds = (tests as Array<{ id: string; student_id: string; subject: string; recovery_schedule_id: string }>)
        .map((t) => t.id);

      // Activate all in one update
      const { error: activateErr } = await supabaseAdmin
        .from('monthly_recovery_tests')
        .update({ is_available: true })
        .in('id', testIds);

      if (activateErr) {
        console.error('[cron/recovery] activate-tests update error:', activateErr.message);
        return;
      }

      activated = tests.length;

      // Send FCM push notifications to each student
      const { getTokensForStudents, sendPushMulticast: pushMulticast } = await import('../services/fcmService');

      for (const test of tests as Array<{ id: string; student_id: string; subject: string; recovery_schedule_id: string }>) {
        try {
          const studentTokens = await getTokensForStudents([test.student_id]);
          if (studentTokens.length > 0) {
            await pushMulticast(
              studentTokens,
              '📝 Your Monthly Recovery Test is Ready',
              `${test.subject} recovery test is now available. Good luck!`,
              { type: 'recovery_test_available', test_id: test.id }
            );
            notified++;
          }

          // Insert in-app notification
          await supabaseAdmin.from('notifications').insert({
            title: '📝 Your Monthly Recovery Test is Ready',
            message: `${test.subject} recovery test is now available. Good luck!`,
            type: 'reminder',
            recipient_id: test.student_id,
            sender_id: test.student_id, // system notification
            is_read: false,
            created_at: new Date().toISOString(),
          }).then(() => { /* non-fatal */ }, () => { /* non-fatal */ });

        } catch (notifErr) {
          const msg = notifErr instanceof Error ? notifErr.message : String(notifErr);
          errors.push(`Notify failed for student ${test.student_id}: ${msg}`);
        }
      }

      console.log(`[cron/recovery] activate-tests complete — activated: ${activated}, notified: ${notified}`);
      if (errors.length > 0) {
        console.error('[cron/recovery] activate-tests notification errors:', errors);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cron/recovery] activate-tests crashed:', msg);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
}

// Accept both GET and POST:
// - GET  → cron-job.org free plan uses GET + ?secret= query param
// - POST → GitHub Actions / paid cron services use POST + x-cron-secret header
router.get('/activate-tests',  runActivateTests);
router.post('/activate-tests', runActivateTests);

export default router;
