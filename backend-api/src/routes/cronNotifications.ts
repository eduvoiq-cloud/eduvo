/**
 * /api/cron/notifications — Railway cron-triggered notification jobs
 *
 * All endpoints are protected by x-cron-secret header (CRON_SECRET env var).
 *
 * POST /api/cron/notifications/daily-reminder
 *   — 9 PM daily: remind all premium students who haven't completed today's
 *     daily_test OR activity_pack. "⏰ Don't break the streak!"
 *     Configure in Railway: 0 15 * * *  (9 PM IST = 15:30 UTC, adjust to your TZ)
 *
 * POST /api/cron/notifications/streak-reminder
 *   — 8 PM daily: warn students whose streak will break tonight (no activity today,
 *     current_streak > 0). "⚠️ {student}'s {X}-day streak ends in 4 hours!"
 *     Configure in Railway: 30 14 * * *  (8 PM IST = 14:30 UTC, adjust to your TZ)
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { sendPushNotification } from '../services/fcmService';

const router = Router();

// ── Auth helper ───────────────────────────────────────────────────────────────

function verifyCronSecret(req: Request, res: Response): boolean {
  const cronSecret = (process.env.CRON_SECRET ?? '').trim();
  const rawHeader = req.headers['x-cron-secret'];
  const provided = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader ?? '').trim();

  if (!cronSecret || provided !== cronSecret) {
    sendError(res, 'Unauthorized', 401);
    return false;
  }
  return true;
}

// ── POST /api/cron/notifications/daily-reminder ───────────────────────────────
/**
 * 9 PM daily cron: check all premium students who haven't completed today's
 * daily_test_attempt (for senior) or activity_completion (for junior).
 * Send "⏰ Don't break the streak! Complete today's {test/activity} before midnight."
 */
router.post('/daily-reminder', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  const today = new Date().toISOString().slice(0, 10);
  let notified = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Respond immediately — Railway cron timeout is short
  sendSuccess(res, { message: 'Daily reminder job started', date: today }, 'Job started');

  // Run async after response is sent
  setImmediate(async () => {
    try {
      // ── Students with incomplete streak-eligible tests today ─────────────────
      // Find all students who have an unsubmitted attempt on a streak-eligible test today
      const { data: streakTests } = await supabaseAdmin
        .from('tests')
        .select('id, subject')
        .eq('contributes_to_streak', true)
        .gte('date', today)
        .lte('date', today);

      const seniorMap = new Map<string, string>();

      if (streakTests && streakTests.length > 0) {
        const testIds = (streakTests as Array<{ id: string; subject: string }>).map((t) => t.id);
        const subjectByTest = new Map(
          (streakTests as Array<{ id: string; subject: string }>).map((t) => [t.id, t.subject])
        );

        const { data: incompleteAttempts } = await supabaseAdmin
          .from('test_attempts')
          .select('student_id, test_id')
          .in('test_id', testIds)
          .eq('is_submitted', false);

        for (const row of incompleteAttempts ?? []) {
          const r = row as Record<string, unknown>;
          const sid = r.student_id as string;
          const testId = r.test_id as string;
          if (sid && !seniorMap.has(sid)) {
            seniorMap.set(sid, subjectByTest.get(testId) ?? 'today\'s');
          }
        }
      }

      // Notify all students with incomplete streak tests today
      if (seniorMap.size > 0) {
        for (const [studentId, subject] of seniorMap.entries()) {
          const { data: student } = await supabaseAdmin
            .from('students')
            .select('full_name, parent_id')
            .eq('id', studentId)
            .maybeSingle();

          if (!student) { skipped++; continue; }
          const sr = student as Record<string, unknown>;

          await sendPushNotification(
            studentId,
            '⏰ Don\'t break the streak!',
            `Complete today's ${subject} test before midnight!`,
            { type: 'daily_reminder', activity: 'test' },
            'student'
          );

          const parentId = sr.parent_id as string | null;
          if (parentId) {
            await sendPushNotification(
              parentId,
              '⏰ Remind your child!',
              `${sr.full_name as string} hasn't completed today's ${subject} test yet. Help them keep their streak!`,
              { type: 'daily_reminder', activity: 'test', student_id: studentId },
              'user'
            );
          }

          notified++;
        }
      }

      // ── Students with pending activity packs ─────────────────────────────────
      // Find all students with a pending (not completed) activity pack today
      const { data: juniorPending } = await supabaseAdmin
        .from('activity_completions')
        .select(`
          student_id,
          activity_packs ( subject )
        `)
        .eq('parent_marked_complete', false)
        .gte('created_at', `${today}T00:00:00.000Z`);

      const juniorMap = new Map<string, string>();
      for (const row of juniorPending ?? []) {
        const r = row as Record<string, unknown>;
        const sid = r.student_id as string;
        const ap = r.activity_packs as Record<string, unknown> | null;
        if (sid && !juniorMap.has(sid)) {
          juniorMap.set(sid, (ap?.subject as string) ?? 'today\'s');
        }
      }

      if (juniorMap.size > 0) {
        for (const [studentId, subject] of juniorMap.entries()) {
          const { data: student } = await supabaseAdmin
            .from('students')
            .select('full_name, parent_id')
            .eq('id', studentId)
            .maybeSingle();

          if (!student) { skipped++; continue; }
          const sr = student as Record<string, unknown>;
          const parentId = sr.parent_id as string | null;

          // Notify parent
          if (parentId) {
            await sendPushNotification(
              parentId,
              '⏰ Don\'t break the streak!',
              `Complete today's ${subject} home activity with ${sr.full_name as string} before midnight!`,
              { type: 'daily_reminder', activity: 'activity_pack', student_id: studentId },
              'user'
            );
          }

          notified++;
        }
      }

      console.log(`[cron/daily-reminder] Done — notified: ${notified}, skipped: ${skipped}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      console.error('[cron/daily-reminder] Error:', msg);
    }
  });
});

// ── POST /api/cron/notifications/streak-reminder ─────────────────────────────
/**
 * 8 PM daily cron: warn students with an active streak who haven't logged any
 * activity today. "⚠️ {student}'s {X}-day streak ends in 4 hours!"
 */
router.post('/streak-reminder', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  const today = new Date().toISOString().slice(0, 10);
  let notified = 0;
  let skipped = 0;

  // Respond immediately
  sendSuccess(res, { message: 'Streak reminder job started', date: today }, 'Job started');

  setImmediate(async () => {
    try {
      // Find all students with current_streak > 0 and last_activity_date != today
      const { data: streaks } = await supabaseAdmin
        .from('student_streaks')
        .select('student_id, current_streak')
        .gt('current_streak', 0)
        .neq('last_activity_date', today);

      if (!streaks || streaks.length === 0) {
        console.log('[cron/streak-reminder] No at-risk streaks found.');
        return;
      }

      const studentIds = (streaks as Array<{ student_id: string; current_streak: number }>)
        .map((s) => s.student_id);

      // Only notify premium students
      const { data: premiumSubs } = await supabaseAdmin
        .from('parent_subscriptions')
        .select('student_id')
        .in('student_id', studentIds)
        .eq('status', 'active');

      const premiumSet = new Set<string>(
        (premiumSubs ?? []).map((s: Record<string, unknown>) => s.student_id as string)
      );

      for (const streak of streaks as Array<{ student_id: string; current_streak: number }>) {
        if (!premiumSet.has(streak.student_id)) { skipped++; continue; }

        const { data: student } = await supabaseAdmin
          .from('students')
          .select('full_name, parent_id')
          .eq('id', streak.student_id)
          .maybeSingle();

        if (!student) { skipped++; continue; }
        const sr = student as Record<string, unknown>;
        const studentName = sr.full_name as string;
        const parentId = sr.parent_id as string | null;
        const streakDays = streak.current_streak;

        // Notify the student
        await sendPushNotification(
          streak.student_id,
          '⚠️ Your streak is at risk!',
          `Your ${streakDays}-day streak ends in 4 hours! Complete today's activity now to keep it going.`,
          { type: 'streak_reminder', current_streak: String(streakDays) },
          'student'
        );

        // Notify the parent
        if (parentId) {
          await sendPushNotification(
            parentId,
            `⚠️ ${studentName}'s streak is at risk!`,
            `${studentName}'s ${streakDays}-day streak ends in 4 hours! Help them complete today's activity.`,
            { type: 'streak_reminder', current_streak: String(streakDays), student_id: streak.student_id },
            'user'
          );
        }

        notified++;
      }

      console.log(`[cron/streak-reminder] Done — notified: ${notified}, skipped: ${skipped}`);
    } catch (err) {
      console.error('[cron/streak-reminder] Error:', err);
    }
  });
});

export default router;
