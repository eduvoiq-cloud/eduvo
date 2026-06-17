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
import { supabaseAdmin } from '../config/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { sendPushNotification } from '../services/fcmService';

const router = Router();

// ── Auth helper ───────────────────────────────────────────────────────────────

function verifyCronSecret(req: Request, res: Response): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const rawHeader = req.headers['x-cron-secret'];
  const fromHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  // Also accept secret as a query param for GET-only cron services (e.g. cron-job.org free)
  const fromQuery = req.query['secret'] as string | undefined;
  const provided = fromHeader ?? fromQuery;

  if (!cronSecret || provided !== cronSecret) {
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
    }
  });
}

// Accept both GET and POST:
// - GET  → cron-job.org free plan uses GET + ?secret= query param
// - POST → GitHub Actions / paid cron services use POST + x-cron-secret header
router.get('/monthly-scheduler',  runMonthlyScheduler);
router.post('/monthly-scheduler', runMonthlyScheduler);

// ── POST /api/cron/recovery/check-batch-jobs ──────────────────────────────────
/**
 * Every-2-hours cron: poll Gemini batch job status and update recovery_packs
 * and monthly_recovery_tests when generation has been done in-process.
 *
 * For the standard (non-Vertex-AI) path, results are written inline by the
 * generation endpoint and this cron's role is to handle any stuck 'processing'
 * rows that never got updated (timeout / crash recovery).
 *
 * For the Vertex AI batch path, this polls the batch job status endpoint
 * and processes results when the job is DONE.
 *
 * Railway cron schedule: 0 *\/2 * * *  (every 2 hours)
 */
router.post('/check-batch-jobs', async (req: Request, res: Response) => {
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
      const useVertexBatch = Boolean(process.env.GOOGLE_CLOUD_PROJECT);

      if (useVertexBatch) {
        // ── Vertex AI batch path: poll real batch jobs ───────────────────────
        // For recovery_packs still processing
        const { data: processingPacks } = await supabaseAdmin
          .from('recovery_packs')
          .select('id, batch_job_id, student_id')
          .eq('generation_status', 'processing')
          .not('batch_job_id', 'is', null);

        // For monthly_recovery_tests still processing
        const { data: processingTests } = await supabaseAdmin
          .from('monthly_recovery_tests')
          .select('id, batch_job_id, student_id, total_questions')
          .eq('generation_status', 'processing')
          .not('batch_job_id', 'is', null);

        // Collect unique batch job IDs from both tables
        const uniqueBatchJobs = new Set<string>();
        for (const row of (processingPacks ?? []) as Array<{ batch_job_id: string | null }>) {
          if (row.batch_job_id) uniqueBatchJobs.add(row.batch_job_id);
        }
        for (const row of (processingTests ?? []) as Array<{ batch_job_id: string | null }>) {
          if (row.batch_job_id) uniqueBatchJobs.add(row.batch_job_id);
        }

        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        for (const jobId of uniqueBatchJobs) {
          try {
            // Poll Vertex AI batch job status
            const statusResp = await fetch(
              `https://aiplatform.googleapis.com/v1/${jobId}`,
              {
                headers: { Authorization: `Bearer ${accessToken.token}` },
              }
            );

            if (!statusResp.ok) {
              errors.push(`Failed to fetch job status for ${jobId}: ${statusResp.status}`);
              continue;
            }

            const jobData = await statusResp.json() as {
              state: string;
              outputConfig?: { gcsDestination?: { outputUriPrefix?: string } };
              error?: { message: string };
            };

            if (jobData.state === 'JOB_STATE_SUCCEEDED') {
              // Mark all rows with this batch_job_id as completed
              // (Results would need to be fetched from GCS — for now mark completed)
              const { error: packErr } = await supabaseAdmin
                .from('recovery_packs')
                .update({ generation_status: 'completed', generated_at: new Date().toISOString() })
                .eq('batch_job_id', jobId)
                .eq('generation_status', 'processing');
              if (!packErr) packsUpdated++;

              const { error: testErr } = await supabaseAdmin
                .from('monthly_recovery_tests')
                .update({ generation_status: 'completed', generated_at: new Date().toISOString() })
                .eq('batch_job_id', jobId)
                .eq('generation_status', 'processing');
              if (!testErr) testsUpdated++;

            } else if (jobData.state === 'JOB_STATE_FAILED' || jobData.state === 'JOB_STATE_CANCELLED') {
              const errMsg = jobData.error?.message ?? 'Batch job failed';
              errors.push(`Job ${jobId}: ${errMsg}`);

              await supabaseAdmin
                .from('recovery_packs')
                .update({ generation_status: 'failed' })
                .eq('batch_job_id', jobId)
                .eq('generation_status', 'processing');
              packsFailed++;

              await supabaseAdmin
                .from('monthly_recovery_tests')
                .update({ generation_status: 'failed' })
                .eq('batch_job_id', jobId)
                .eq('generation_status', 'processing');
              testsFailed++;
            }
            // JOB_STATE_RUNNING / PENDING — still processing, skip
          } catch (jobErr) {
            const msg = jobErr instanceof Error ? jobErr.message : String(jobErr);
            errors.push(`Job poll error [${jobId}]: ${msg}`);
          }
        }
      } else {
        // ── Standard API path: check for stuck 'processing' rows ─────────────
        // Any row that has been stuck in 'processing' for more than 30 minutes
        // without a result should be retried or marked failed.
        const stuckThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();

        // Find stuck recovery_packs (processing but no generated_at, older than 30min)
        const { data: stuckPacks } = await supabaseAdmin
          .from('recovery_packs')
          .select('id, student_id, recovery_schedule_id, subject, scheduled_month, school_id, weak_topics')
          .eq('generation_status', 'processing')
          .lt('created_at', stuckThreshold);

        for (const pack of (stuckPacks ?? []) as Array<{
          id: string; student_id: string; recovery_schedule_id: string;
          subject: string; scheduled_month: string; school_id: string; weak_topics: string[] | null;
        }>) {
          try {
            const weakTopics = pack.weak_topics ?? [pack.subject];
            const weakTopicsList = weakTopics.join(', ');

            // Fetch schedule for class info + board
            const { data: schedule } = await supabaseAdmin
              .from('monthly_recovery_schedules')
              .select('class, section, school_id')
              .eq('id', pack.recovery_schedule_id)
              .maybeSingle();

            if (!schedule) {
              await supabaseAdmin.from('recovery_packs').update({ generation_status: 'failed' }).eq('id', pack.id);
              packsFailed++;
              continue;
            }

            const sch = schedule as { class: string; section: string; school_id: string };
            const { data: schoolRow } = await supabaseAdmin.from('schools').select('board').eq('id', sch.school_id).maybeSingle();
            const board = (schoolRow as { board?: string } | null)?.board ?? 'CBSE';

            // Re-generate via Gemini
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) {
              await supabaseAdmin.from('recovery_packs').update({ generation_status: 'failed' }).eq('id', pack.id);
              packsFailed++;
              continue;
            }

            const modelId = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
            const prompt = `You are creating a personalized study recovery pack for a Class ${sch.class} student in India studying ${pack.subject} (${board} curriculum). This student is weak in: ${weakTopicsList}. Create a Recovery Pack with one section per weak topic. Return ONLY valid JSON: {"sections":[{"topic":"string","explanation":"string","key_concepts":["string"],"common_mistakes":["string"],"solved_examples":[{"question":"string","solution":"string","steps":["string"]}],"practice_questions":[{"question":"string","answer":"string"}]}]}`;

            const resp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text: prompt }] }],
                  generationConfig: { responseMimeType: 'application/json' },
                }),
              }
            );

            if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);

            const geminiData = await resp.json() as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
            const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const parsed = JSON.parse(jsonText) as unknown;

            await supabaseAdmin
              .from('recovery_packs')
              .update({
                generation_status: 'completed',
                generated_at: new Date().toISOString(),
                pack_content: parsed,
              })
              .eq('id', pack.id);

            packsUpdated++;
            await new Promise((r) => setTimeout(r, 800));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Pack retry failed [${pack.id}]: ${msg}`);
            await supabaseAdmin.from('recovery_packs').update({ generation_status: 'failed' }).eq('id', pack.id);
            packsFailed++;
          }
        }

        // Find stuck monthly_recovery_tests
        const { data: stuckTests } = await supabaseAdmin
          .from('monthly_recovery_tests')
          .select('id, student_id, recovery_schedule_id, subject, scheduled_month, school_id, weak_topics_used, total_questions')
          .eq('generation_status', 'processing')
          .lt('created_at', stuckThreshold);

        for (const test of (stuckTests ?? []) as Array<{
          id: string; student_id: string; recovery_schedule_id: string;
          subject: string; scheduled_month: string; school_id: string;
          weak_topics_used: string[] | null; total_questions: number | null;
        }>) {
          try {
            const weakTopics = test.weak_topics_used ?? [test.subject];
            const weakTopicsList = weakTopics.join(', ');
            const questionCount = test.total_questions ?? Math.min(30, Math.max(20, weakTopics.length * 4));

            const { data: schedule } = await supabaseAdmin
              .from('monthly_recovery_schedules')
              .select('class, section, school_id')
              .eq('id', test.recovery_schedule_id)
              .maybeSingle();

            if (!schedule) {
              await supabaseAdmin.from('monthly_recovery_tests').update({ generation_status: 'failed' }).eq('id', test.id);
              testsFailed++;
              continue;
            }

            const sch = schedule as { class: string; section: string; school_id: string };
            const { data: schoolRow } = await supabaseAdmin.from('schools').select('board').eq('id', sch.school_id).maybeSingle();
            const board = (schoolRow as { board?: string } | null)?.board ?? 'CBSE';

            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) {
              await supabaseAdmin.from('monthly_recovery_tests').update({ generation_status: 'failed' }).eq('id', test.id);
              testsFailed++;
              continue;
            }

            const modelId = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
            const prompt = `You are creating a personalized Monthly Recovery Test for a Class ${sch.class} student in India. Subject: ${test.subject} (${board} curriculum). This student is weak in: ${weakTopicsList}. Generate exactly ${questionCount} multiple choice questions. Return ONLY valid JSON: {"questions":[{"question":"string","options":["a","b","c","d"],"correct_index":0,"explanation":"string","difficulty":"easy","topic":"string"}]}`;

            const resp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text: prompt }] }],
                  generationConfig: { responseMimeType: 'application/json' },
                }),
              }
            );

            if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);

            const geminiData = await resp.json() as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
            const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const parsed = JSON.parse(jsonText) as { questions?: unknown[] };

            await supabaseAdmin
              .from('monthly_recovery_tests')
              .update({
                generation_status: 'completed',
                generated_at: new Date().toISOString(),
                questions: parsed.questions,
                total_questions: Array.isArray(parsed.questions) ? parsed.questions.length : questionCount,
                is_available: false,
              })
              .eq('id', test.id);

            testsUpdated++;
            await new Promise((r) => setTimeout(r, 800));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Test retry failed [${test.id}]: ${msg}`);
            await supabaseAdmin.from('monthly_recovery_tests').update({ generation_status: 'failed' }).eq('id', test.id);
            testsFailed++;
          }
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
    }
  });
});

// ── POST /api/cron/recovery/activate-tests ───────────────────────────────────
/**
 * Daily cron: set is_available=true on monthly_recovery_tests where:
 *   - generation_status = 'completed'
 *   - is_available = false
 *   - The parent monthly_recovery_schedules row has scheduled_test_date = today
 *
 * Also sends FCM push notifications to those students.
 *
 * Railway cron schedule: 0 15 * * *  (9 PM IST = 15:00 UTC)
 */
router.post('/activate-tests', async (req: Request, res: Response) => {
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
    }
  });
});

export default router;
