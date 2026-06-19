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
 *
 * POST /api/cron/homework/cleanup-old-files
 *   — 1 AM daily: delete Supabase Storage files for homework > 7 days old.
 *     Clears teacher attachments (homework-uploads/<school_id>/...) and
 *     student submission images (homework-uploads/student-submissions/...).
 *     DB records are kept; only file_url / submission_image_urls are nulled.
 *     Railway cron schedule: 0 1 * * *  (1:00 AM UTC)
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import * as Sentry from '@sentry/node';
import { supabaseAdmin } from '../config/supabase';
import redis from '../config/redis';
import { sendSuccess, sendError } from '../utils/response';
import { runHomeworkBatchEval } from '../services/homeworkEvalService';

// ── Distributed job lock ──────────────────────────────────────────────────────
// Prevents duplicate batch runs when cron fires while a previous run is still
// in progress (e.g. a 15-min schedule but the job takes 15+ minutes).
//
// Strategy:
//   • Redis available  → SET NX PX <ttl>  (atomic, works across instances)
//   • Redis absent     → in-process boolean flag (single-instance fallback)
//
// TTL is set to 25 minutes — slightly longer than the cron interval (15 min)
// so a stuck/crashed job eventually releases the lock automatically.

const LOCK_KEY = 'cron:homework:evaluate-batch:lock';
const LOCK_TTL_MS = 25 * 60 * 1000; // 25 minutes

let _inProcessLock = false;

async function acquireLock(): Promise<boolean> {
  if (redis) {
    // SET key value PX ttl NX — returns 'OK' if acquired, null if already held
    const result = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    return result === 'OK';
  }
  if (_inProcessLock) return false;
  _inProcessLock = true;
  return true;
}

async function releaseLock(): Promise<void> {
  if (redis) {
    await redis.del(LOCK_KEY);
  } else {
    _inProcessLock = false;
  }
}

const router = Router();

// ── Storage path helper ───────────────────────────────────────────────────────

/**
 * Extract the storage object path from a Supabase public URL.
 *
 * Supabase public URLs look like:
 *   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
 *
 * Returns the path portion after the bucket name, or null if the URL doesn't
 * match the expected format for this project/bucket.
 */
function extractStoragePath(url: string, bucket: string, supabaseHost: string): string | null {
  try {
    const parsed = new URL(url);
    if (supabaseHost) {
      const expectedHost = new URL(supabaseHost).host;
      if (parsed.host !== expectedHost) return null;
    }
    // Pathname: /storage/v1/object/public/<bucket>/<path...>
    const prefix = `/storage/v1/object/public/${bucket}/`;
    if (!parsed.pathname.startsWith(prefix)) return null;
    return decodeURIComponent(parsed.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

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

  const locked = await acquireLock();
  if (!locked) {
    // A previous run is still in progress — skip gracefully so the server
    // doesn't get hammered with overlapping heavy jobs.
    console.warn('[cron/homework] evaluate-batch (GET) skipped — previous run still in progress');
    sendSuccess(
      res,
      { message: 'Skipped — previous batch still running', skipped: true },
      'Job skipped'
    );
    return;
  }

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
    } finally {
      await releaseLock();
    }
  });
});

router.post('/evaluate-batch', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  const locked = await acquireLock();
  if (!locked) {
    // A previous run is still in progress — skip gracefully.
    console.warn('[cron/homework] evaluate-batch skipped — previous run still in progress');
    sendSuccess(
      res,
      { message: 'Skipped — previous batch still running', skipped: true },
      'Job skipped'
    );
    return;
  }

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
    } finally {
      await releaseLock();
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

// ── POST /api/cron/homework/cleanup-old-files ─────────────────────────────────
/**
 * Daily cron: delete Supabase Storage files for homework created more than
 * 7 days ago. This keeps the 'homework-uploads' bucket lean and prevents
 * unbounded storage growth.
 *
 * What it does:
 *   1. Finds all homework rows where created_at < NOW() - 7 days
 *      AND file_url IS NOT NULL (teacher attachments).
 *   2. Finds all homework_submissions rows linked to those homework IDs
 *      that have submission_image_urls set (student photo uploads).
 *   3. Deletes the actual files from Supabase Storage in batches of 100.
 *   4. Nulls out file_url / submission_image_urls in the DB so the records
 *      remain intact for reporting but no longer reference deleted files.
 *
 * Storage paths:
 *   Teacher files  → homework-uploads/<school_id>/<ts>_<name>
 *   Student images → homework-uploads/student-submissions/<school_id>/<student_id>/...
 *
 * Railway cron config example:
 *   Schedule: 0 1 * * *   (1:00 AM UTC daily — low-traffic window)
 *   Command:  curl -X POST https://your-api.railway.app/api/cron/homework/cleanup-old-files
 *             -H "x-cron-secret: $CRON_SECRET"
 *
 * Auth: CRON_SECRET required.
 */
router.post('/cleanup-old-files', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  const startedAt = new Date().toISOString();

  // Respond immediately so the cron caller isn't blocked while we work
  sendSuccess(
    res,
    { message: 'Homework file cleanup started', started_at: startedAt },
    'Job started'
  );

  setImmediate(async () => {
    const BUCKET = 'homework-uploads';
    const STORAGE_DELETE_BATCH = 100; // Supabase Storage delete limit per call
    const DAYS_TO_KEEP = 7;

    // Cutoff: anything created before this timestamp is eligible for cleanup
    const cutoff = new Date(Date.now() - DAYS_TO_KEEP * 24 * 60 * 60 * 1000).toISOString();

    let teacherFilesDeleted = 0;
    let studentFilesDeleted = 0;
    let homeworkUrlsCleared = 0;
    let submissionUrlsCleared = 0;
    const errors: string[] = [];

    console.log(`[cron/cleanup] Starting homework file cleanup. Cutoff: ${cutoff}`);

    try {
      // ── Step 1: Fetch old homework that still has a teacher file attached ──
      const { data: oldHomework, error: hwFetchErr } = await supabaseAdmin
        .from('homework')
        .select('id, file_url, reference_file_url')
        .lt('created_at', cutoff)
        .or('file_url.not.is.null,reference_file_url.not.is.null');

      if (hwFetchErr) {
        console.error('[cron/cleanup] Failed to fetch old homework:', hwFetchErr.message);
        if (process.env.SENTRY_DSN) Sentry.captureException(hwFetchErr);
        return;
      }

      type HwRow = { id: string; file_url: string | null; reference_file_url: string | null };
      const hwRows = (oldHomework ?? []) as HwRow[];

      // ── Step 2: Extract storage paths for teacher files ──────────────────
      const supabaseHost = process.env.SUPABASE_URL ?? '';
      const teacherPaths: string[] = [];
      const hwIdsToNull: string[] = [];

      for (const hw of hwRows) {
        let hasFile = false;

        for (const urlField of [hw.file_url, hw.reference_file_url]) {
          if (!urlField) continue;
          const path = extractStoragePath(urlField, BUCKET, supabaseHost);
          if (path) {
            teacherPaths.push(path);
            hasFile = true;
          }
        }

        if (hasFile) hwIdsToNull.push(hw.id);
      }

      // ── Step 3: Fetch student submission images for old homework ──────────
      const allOldHwIds = hwRows.map((h) => h.id);
      const studentPaths: string[] = [];
      const submissionIdsToNull: string[] = [];

      if (allOldHwIds.length > 0) {
        // Process in chunks to avoid hitting Supabase's .in() limit
        const CHUNK_SIZE = 200;
        for (let i = 0; i < allOldHwIds.length; i += CHUNK_SIZE) {
          const chunk = allOldHwIds.slice(i, i + CHUNK_SIZE);

          const { data: subs, error: subFetchErr } = await supabaseAdmin
            .from('homework_submissions')
            .select('id, submission_image_urls')
            .in('homework_id', chunk)
            .not('submission_image_urls', 'is', null);

          if (subFetchErr) {
            console.error('[cron/cleanup] Failed to fetch submissions chunk:', subFetchErr.message);
            errors.push(subFetchErr.message);
            continue;
          }

          type SubRow = { id: string; submission_image_urls: string[] | null };
          for (const sub of (subs ?? []) as SubRow[]) {
            if (!sub.submission_image_urls?.length) continue;

            let hasPath = false;
            for (const url of sub.submission_image_urls) {
              const path = extractStoragePath(url, BUCKET, supabaseHost);
              if (path) {
                studentPaths.push(path);
                hasPath = true;
              }
            }
            if (hasPath) submissionIdsToNull.push(sub.id);
          }
        }
      }

      // ── Step 4: Delete teacher files from Storage ─────────────────────────
      if (teacherPaths.length > 0) {
        for (let i = 0; i < teacherPaths.length; i += STORAGE_DELETE_BATCH) {
          const batch = teacherPaths.slice(i, i + STORAGE_DELETE_BATCH);
          const { error: delErr } = await supabaseAdmin.storage.from(BUCKET).remove(batch);
          if (delErr) {
            console.error('[cron/cleanup] Storage delete error (teacher):', delErr.message);
            errors.push(`teacher storage: ${delErr.message}`);
          } else {
            teacherFilesDeleted += batch.length;
          }
        }
      }

      // ── Step 5: Delete student submission images from Storage ─────────────
      if (studentPaths.length > 0) {
        for (let i = 0; i < studentPaths.length; i += STORAGE_DELETE_BATCH) {
          const batch = studentPaths.slice(i, i + STORAGE_DELETE_BATCH);
          const { error: delErr } = await supabaseAdmin.storage.from(BUCKET).remove(batch);
          if (delErr) {
            console.error('[cron/cleanup] Storage delete error (student):', delErr.message);
            errors.push(`student storage: ${delErr.message}`);
          } else {
            studentFilesDeleted += batch.length;
          }
        }
      }

      // ── Step 6: Null out file URLs in homework rows ───────────────────────
      if (hwIdsToNull.length > 0) {
        const CHUNK_SIZE = 200;
        for (let i = 0; i < hwIdsToNull.length; i += CHUNK_SIZE) {
          const chunk = hwIdsToNull.slice(i, i + CHUNK_SIZE);
          const { error: updateErr } = await supabaseAdmin
            .from('homework')
            .update({ file_url: null, reference_file_url: null })
            .in('id', chunk);
          if (updateErr) {
            console.error('[cron/cleanup] Failed to null homework file_url:', updateErr.message);
            errors.push(`db homework update: ${updateErr.message}`);
          } else {
            homeworkUrlsCleared += chunk.length;
          }
        }
      }

      // ── Step 7: Null out submission_image_urls in submissions ─────────────
      if (submissionIdsToNull.length > 0) {
        const CHUNK_SIZE = 200;
        for (let i = 0; i < submissionIdsToNull.length; i += CHUNK_SIZE) {
          const chunk = submissionIdsToNull.slice(i, i + CHUNK_SIZE);
          const { error: updateErr } = await supabaseAdmin
            .from('homework_submissions')
            .update({ submission_image_urls: null })
            .in('id', chunk);
          if (updateErr) {
            console.error('[cron/cleanup] Failed to null submission_image_urls:', updateErr.message);
            errors.push(`db submission update: ${updateErr.message}`);
          } else {
            submissionUrlsCleared += chunk.length;
          }
        }
      }

      console.log(
        `[cron/cleanup] Done — teacher_files_deleted: ${teacherFilesDeleted}, ` +
        `student_files_deleted: ${studentFilesDeleted}, ` +
        `homework_urls_cleared: ${homeworkUrlsCleared}, ` +
        `submission_urls_cleared: ${submissionUrlsCleared}, ` +
        `errors: ${errors.length}`
      );

      if (errors.length > 0 && process.env.SENTRY_DSN) {
        Sentry.captureMessage(
          `[cron/cleanup] Completed with ${errors.length} error(s): ${errors.slice(0, 5).join('; ')}`,
          'warning'
        );
      }
    } catch (err) {
      console.error('[cron/cleanup] Unexpected error:', err instanceof Error ? err.message : err);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
});

// ── GET /api/cron/homework/cleanup-old-files ──────────────────────────────────
// Accept GET as well for cron services that only support GET requests.
router.get('/cleanup-old-files', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  // Re-use POST handler logic by delegating — just re-invoke same body
  // Actually, simply trigger directly (duplicating the job kick-off is fine for GET alias):
  const startedAt = new Date().toISOString();
  sendSuccess(
    res,
    { message: 'Homework file cleanup started', started_at: startedAt },
    'Job started'
  );

  setImmediate(async () => {
    const BUCKET = 'homework-uploads';
    const STORAGE_DELETE_BATCH = 100;
    const DAYS_TO_KEEP = 7;
    const cutoff = new Date(Date.now() - DAYS_TO_KEEP * 24 * 60 * 60 * 1000).toISOString();
    const supabaseHost = process.env.SUPABASE_URL ?? '';

    let teacherFilesDeleted = 0;
    let studentFilesDeleted = 0;

    console.log(`[cron/cleanup] (GET) Starting homework file cleanup. Cutoff: ${cutoff}`);

    try {
      const { data: oldHomework } = await supabaseAdmin
        .from('homework')
        .select('id, file_url, reference_file_url')
        .lt('created_at', cutoff)
        .or('file_url.not.is.null,reference_file_url.not.is.null');

      type HwRow = { id: string; file_url: string | null; reference_file_url: string | null };
      const hwRows = (oldHomework ?? []) as HwRow[];
      const teacherPaths: string[] = [];
      const hwIdsToNull: string[] = [];

      for (const hw of hwRows) {
        let hasFile = false;
        for (const urlField of [hw.file_url, hw.reference_file_url]) {
          if (!urlField) continue;
          const path = extractStoragePath(urlField, BUCKET, supabaseHost);
          if (path) { teacherPaths.push(path); hasFile = true; }
        }
        if (hasFile) hwIdsToNull.push(hw.id);
      }

      const allOldHwIds = hwRows.map((h) => h.id);
      const studentPaths: string[] = [];
      const submissionIdsToNull: string[] = [];

      if (allOldHwIds.length > 0) {
        const { data: subs } = await supabaseAdmin
          .from('homework_submissions')
          .select('id, submission_image_urls')
          .in('homework_id', allOldHwIds)
          .not('submission_image_urls', 'is', null);

        type SubRow = { id: string; submission_image_urls: string[] | null };
        for (const sub of (subs ?? []) as SubRow[]) {
          if (!sub.submission_image_urls?.length) continue;
          let hasPath = false;
          for (const url of sub.submission_image_urls) {
            const path = extractStoragePath(url, BUCKET, supabaseHost);
            if (path) { studentPaths.push(path); hasPath = true; }
          }
          if (hasPath) submissionIdsToNull.push(sub.id);
        }
      }

      for (let i = 0; i < teacherPaths.length; i += STORAGE_DELETE_BATCH) {
        const batch = teacherPaths.slice(i, i + STORAGE_DELETE_BATCH);
        const { error } = await supabaseAdmin.storage.from(BUCKET).remove(batch);
        if (!error) teacherFilesDeleted += batch.length;
      }

      for (let i = 0; i < studentPaths.length; i += STORAGE_DELETE_BATCH) {
        const batch = studentPaths.slice(i, i + STORAGE_DELETE_BATCH);
        const { error } = await supabaseAdmin.storage.from(BUCKET).remove(batch);
        if (!error) studentFilesDeleted += batch.length;
      }

      if (hwIdsToNull.length > 0) {
        await supabaseAdmin.from('homework').update({ file_url: null, reference_file_url: null }).in('id', hwIdsToNull);
      }
      if (submissionIdsToNull.length > 0) {
        await supabaseAdmin.from('homework_submissions').update({ submission_image_urls: null }).in('id', submissionIdsToNull);
      }

      console.log(`[cron/cleanup] (GET) Done — teacher_files: ${teacherFilesDeleted}, student_files: ${studentFilesDeleted}`);
    } catch (err) {
      console.error('[cron/cleanup] (GET) Unexpected error:', err instanceof Error ? err.message : err);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
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
