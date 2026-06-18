/**
 * /api/cron/homework — Railway cron-triggered homework AI evaluation jobs
 *
 * All endpoints are protected by x-cron-secret header (CRON_SECRET env var).
 *
 * POST /api/cron/homework/evaluate-batch
 *   — 9 PM daily: evaluate all pending homework submissions with AI.
 *   — Railway cron schedule: 30 15 * * *  (9 PM IST = 15:30 UTC)
 *     Adjust to your timezone as needed.
 *
 * POST /api/cron/homework/evaluate-batch/test
 *   — Same logic but scoped to a single submission_id for manual testing.
 *     Body: { submission_id: "uuid" }
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import * as Sentry from '@sentry/node';
import { supabaseAdmin } from '../config/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { runHomeworkBatchEval } from '../services/homeworkEvalService';

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

// ── POST /api/cron/homework/evaluate-batch ────────────────────────────────────
/**
 * Nightly cron: evaluate all homework_submissions where status='submitted'
 * for any homework where ai_check_enabled=true.
 *
 * Pipeline:
 *   1. Cache check (question_hash + answer_hash)
 *   2. Numerical shortcut (zero AI cost)
 *   3. Typed theory → Gemini Flash text eval
 *   4. Photo → Gemini Flash vision eval
 *   5. Confidence routing: ≥0.9 → checked, <0.9 → flagged_for_review
 *   6. Suspicious-text detection (if teacher opted in)
 *   7. FCM notifications to students/parents (checked) and teachers (flagged)
 *
 * Railway cron config example:
 *   Schedule: 30 15 * * *   (9:00 PM IST)
 *   Command:  curl -X POST https://your-api.railway.app/api/cron/homework/evaluate-batch
 *             -H "x-cron-secret: $CRON_SECRET"
 */
// Accept both POST and GET — cron-job.org free plan only sends GET
router.get('/evaluate-batch', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  const startedAt = new Date().toISOString();
  sendSuccess(res, { message: 'Homework batch evaluation started', started_at: startedAt }, 'Job started');

  setImmediate(async () => {
    try {
      console.log('[cron/homework] evaluate-batch (GET) starting at', startedAt);
      const stats = await runHomeworkBatchEval();
      console.log('[cron/homework] evaluate-batch complete:', JSON.stringify(stats));
    } catch (err) {
      console.error('[cron/homework] evaluate-batch crashed:', err instanceof Error ? err.message : err);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
});

router.post('/evaluate-batch', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  const startedAt = new Date().toISOString();

  // Respond immediately — Railway cron has a short HTTP timeout.
  // The actual work runs in setImmediate (fire-and-forget).
  sendSuccess(
    res,
    { message: 'Homework batch evaluation started', started_at: startedAt },
    'Job started'
  );

  setImmediate(async () => {
    try {
      console.log('[cron/homework] evaluate-batch starting at', startedAt);
      const stats = await runHomeworkBatchEval();
      console.log('[cron/homework] evaluate-batch complete:', JSON.stringify(stats));
    } catch (err) {
      console.error(
        '[cron/homework] evaluate-batch crashed:',
        err instanceof Error ? err.message : err
      );
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
});

// ── POST /api/cron/homework/reset-stuck ──────────────────────────────────────
/**
 * Manually reset submissions stuck in 'processing' back to 'submitted'.
 * Useful when a batch job crashed mid-run and left submissions stranded.
 * Optionally accepts { older_than_minutes: number } to control the threshold
 * (defaults to 30 minutes).
 * Auth: CRON_SECRET required.
 */
router.post('/reset-stuck', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  const olderThanMinutes = Math.max(1, Number(req.body?.older_than_minutes ?? 30));
  const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

  try {
    const { error, count } = await supabaseAdmin
      .from('homework_submissions')
      .update({ status: 'submitted' })
      .eq('status', 'processing')
      .lt('updated_at', threshold);

    if (error) {
      sendError(res, `Failed to reset stuck submissions: ${error.message}`, 500);
      return;
    }

    sendSuccess(res, {
      reset_count: count ?? 0,
      older_than_minutes: olderThanMinutes,
      threshold,
    }, `${count ?? 0} stuck submissions reset to 'submitted'`);
  } catch (err) {
    console.error('[cron/homework] reset-stuck error:', err instanceof Error ? err.message : err);
    sendError(res, 'Unexpected error', 500);
  }
});

// ── POST /api/cron/homework/evaluate-batch/status ────────────────────────────
/**
 * Returns a summary of recent batch evaluation activity.
 * Useful for monitoring dashboards.
 * Auth: CRON_SECRET required.
 */
router.post('/evaluate-batch/status', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  try {
    // Count submissions by status
    const statuses = ['submitted', 'processing', 'checked', 'flagged_for_review', 'not_submitted'];
    const counts: Record<string, number> = {};

    for (const status of statuses) {
      const { count, error } = await supabaseAdmin
        .from('homework_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('status', status);

      if (!error) counts[status] = count ?? 0;
    }

    // Recent evaluations (last 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: recentChecked } = await supabaseAdmin
      .from('homework_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'checked')
      .gte('evaluated_at', since);

    const { count: cacheSize } = await supabaseAdmin
      .from('homework_evaluation_cache')
      .select('id', { count: 'exact', head: true });

    sendSuccess(res, {
      submission_counts: counts,
      recently_evaluated_24h: recentChecked ?? 0,
      cache_size: cacheSize ?? 0,
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[cron/homework] status error:', err instanceof Error ? err.message : err);
    sendError(res, 'Failed to fetch status', 500);
  }
});

export default router;
