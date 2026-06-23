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

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { supabaseAdmin } from '../config/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { sendPushNotification } from '../services/fcmService';
import { getTodayIST } from '../utils/dateUtils';
import { sleep } from '../services/whatsappService';

const router = Router();

// ── Auth helper ───────────────────────────────────────────────────────────────

function verifyCronSecret(req: Request, res: Response): boolean {
  const cronSecret = (process.env.CRON_SECRET ?? '').trim();
  const rawHeader = req.headers['x-cron-secret'];
  const provided = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader ?? '').trim();

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

// ── POST /api/cron/notifications/daily-reminder ───────────────────────────────
/**
 * 9 PM daily cron: notify all premium students who haven't completed today's
 * daily test (senior, class 7-12) or activity_pack (junior, class 1-6).
 *
 * FIX 4: For senior tests, we now query from the test-assignment side:
 *   1. Get all daily_tests assigned today (streak-eligible).
 *   2. Get all student IDs in each test's class/section.
 *   3. Get all student IDs who already have a 'completed' attempt today.
 *   4. Notify everyone in group 2 who is NOT in group 3.
 * This correctly catches both students who never started AND those who
 * started but didn't finish — previously, students with no attempt row
 * at all were silently skipped.
 */
router.post('/daily-reminder', async (req: Request, res: Response) => {
  if (!verifyCronSecret(req, res)) return;

  // FIX 1: use IST date to avoid UTC vs IST midnight mismatch
  const today = getTodayIST();
  let notified = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Respond immediately — Railway cron timeout is short
  sendSuccess(res, { message: 'Daily reminder job started', date: today }, 'Job started');

  // Run async after response is sent
  setImmediate(async () => {
    try {
      // ── Senior students: test-assignment side query (FIX 4) ──────────────────
      //
      // Step 1: fetch all streak-eligible daily_tests for today
      const { data: streakTests } = await supabaseAdmin
        .from('tests')
        .select('id, subject, class_name, section, school_id')
        .eq('contributes_to_streak', true)
        .gte('date', today)
        .lte('date', today);

      if (streakTests && streakTests.length > 0) {
        type TestRow = {
          id: string;
          subject: string;
          class_name: string | null;
          section: string | null;
          school_id: string;
        };
        const tests = streakTests as TestRow[];
        const testIds = tests.map((t) => t.id);
        const subjectByTest = new Map(tests.map((t) => [t.id, t.subject]));

        // Step 2: fetch all students in the classes that have tests today
        // Group tests by school+class+section to batch student lookups
        type ClassKey = { school_id: string; class_name: string; section: string };
        const classKeys = new Map<string, ClassKey>();
        for (const t of tests) {
          if (!t.class_name || !t.section) continue;
          const key = `${t.school_id}||${t.class_name}||${t.section}`;
          if (!classKeys.has(key)) {
            classKeys.set(key, {
              school_id: t.school_id,
              class_name: t.class_name,
              section: t.section,
            });
          }
        }

        // Map testId → Set of student IDs for students in that test's class
        const testStudentMap = new Map<string, Set<string>>();

        for (const ck of classKeys.values()) {
          const { data: classStudents } = await supabaseAdmin
            .from('students')
            .select('id')
            .eq('school_id', ck.school_id)
            .eq('class_name', ck.class_name)
            .eq('section', ck.section)
            .eq('is_deleted', false);

          if (!classStudents || classStudents.length === 0) continue;

          const studentIds = (classStudents as Array<{ id: string }>).map((s) => s.id);

          // Associate these students with all tests from this class+section
          for (const t of tests) {
            if (t.school_id === ck.school_id && t.class_name === ck.class_name && t.section === ck.section) {
              const existing = testStudentMap.get(t.id) ?? new Set<string>();
              for (const sid of studentIds) existing.add(sid);
              testStudentMap.set(t.id, existing);
            }
          }
        }

        // Step 3: fetch all students who have a 'completed' attempt for today's tests
        const { data: completedAttempts } = await supabaseAdmin
          .from('test_attempts')
          .select('student_id, test_id')
          .in('test_id', testIds)
          .eq('is_submitted', true);

        const completedByTest = new Map<string, Set<string>>();
        for (const row of completedAttempts ?? []) {
          const r = row as { student_id: string; test_id: string };
          const existing = completedByTest.get(r.test_id) ?? new Set<string>();
          existing.add(r.student_id);
          completedByTest.set(r.test_id, existing);
        }

        // Step 4: notify students assigned to a test who have NOT completed it
        // Use a deduplicated map so each student gets at most one notification
        const seniorToNotify = new Map<string, string>(); // studentId → subject

        for (const [testId, assignedStudents] of testStudentMap.entries()) {
          const completed = completedByTest.get(testId) ?? new Set<string>();
          const subject = subjectByTest.get(testId) ?? 'today\'s';

          for (const studentId of assignedStudents) {
            if (!completed.has(studentId) && !seniorToNotify.has(studentId)) {
              seniorToNotify.set(studentId, subject);
            }
          }
        }

        // Fetch all senior student details in one query instead of N individual queries
        const seniorStudentIds = [...seniorToNotify.keys()];
        const seniorStudentMap = new Map<string, { full_name: string; parent_id: string | null }>();

        if (seniorStudentIds.length > 0) {
          const { data: seniorStudents } = await supabaseAdmin
            .from('students')
            .select('id, full_name, parent_id')
            .in('id', seniorStudentIds)
            .eq('is_deleted', false);

          for (const s of seniorStudents ?? []) {
            const sr = s as { id: string; full_name: string; parent_id: string | null };
            seniorStudentMap.set(sr.id, { full_name: sr.full_name, parent_id: sr.parent_id });
          }
        }

        // FIX 1: Batch FCM sends in groups of 50
        const seniorEntries = [...seniorToNotify.entries()];
        const SENIOR_BATCH = 50;

        for (let i = 0; i < seniorEntries.length; i += SENIOR_BATCH) {
          const batch = seniorEntries.slice(i, i + SENIOR_BATCH);

          await Promise.allSettled(
            batch.flatMap(([studentId, subject]) => {
              const student = seniorStudentMap.get(studentId);
              if (!student) { skipped++; return []; }

              const sends = [
                sendPushNotification(
                  studentId,
                  '⏰ Don\'t break the streak!',
                  `Complete today's ${subject} test before midnight!`,
                  { type: 'daily_reminder', activity: 'test' },
                  'student'
                ),
              ];

              if (student.parent_id) {
                sends.push(
                  sendPushNotification(
                    student.parent_id,
                    '⏰ Remind your child!',
                    `${student.full_name} hasn't completed today's ${subject} test yet. Help them keep their streak!`,
                    { type: 'daily_reminder', activity: 'test', student_id: studentId },
                    'user'
                  )
                );
              }

              notified++;
              return sends;
            })
          );

          // Small delay between batches to avoid FCM rate limits
          if (i + SENIOR_BATCH < seniorEntries.length) {
            await sleep(200);
          }
        }
      }

      // ── Junior students: pending activity packs ──────────────────────────────
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
        // Fetch all junior student details in one query
        const juniorStudentIds = [...juniorMap.keys()];
        const juniorStudentMap = new Map<string, { full_name: string; parent_id: string | null }>();

        const { data: juniorStudents } = await supabaseAdmin
          .from('students')
          .select('id, full_name, parent_id')
          .in('id', juniorStudentIds)
          .eq('is_deleted', false);

        for (const s of juniorStudents ?? []) {
          const sr = s as { id: string; full_name: string; parent_id: string | null };
          juniorStudentMap.set(sr.id, { full_name: sr.full_name, parent_id: sr.parent_id });
        }

        // FIX 1: Batch FCM sends in groups of 50
        const juniorEntries = [...juniorMap.entries()];
        const JUNIOR_BATCH = 50;

        for (let i = 0; i < juniorEntries.length; i += JUNIOR_BATCH) {
          const batch = juniorEntries.slice(i, i + JUNIOR_BATCH);

          await Promise.allSettled(
            batch.flatMap(([studentId, subject]) => {
              const student = juniorStudentMap.get(studentId);
              if (!student || !student.parent_id) { skipped++; return []; }

              notified++;
              return [
                sendPushNotification(
                  student.parent_id,
                  '⏰ Don\'t break the streak!',
                  `Complete today's ${subject} home activity with ${student.full_name} before midnight!`,
                  { type: 'daily_reminder', activity: 'activity_pack', student_id: studentId },
                  'user'
                ),
              ];
            })
          );

          // Small delay between batches to avoid FCM rate limits
          if (i + JUNIOR_BATCH < juniorEntries.length) {
            await sleep(200);
          }
        }
      }

      console.log(`[cron/daily-reminder] Done — notified: ${notified}, skipped: ${skipped}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      console.error('[cron/daily-reminder] Error:', msg);
      // Report to Sentry so background job failures are tracked even though
      // the HTTP response (200 OK) has already been sent to the cron caller.
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
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

  // FIX 1: use IST date to avoid UTC vs IST midnight mismatch
  const today = getTodayIST();
  let notified = 0;
  let skipped = 0;

  // Respond immediately
  sendSuccess(res, { message: 'Streak reminder job started', date: today }, 'Job started');

  setImmediate(async () => {
    try {
      // FIX 5: Single JOIN query — fetch streak + student data in one round-trip
      // instead of N individual queries for N students.
      const { data: streaks } = await supabaseAdmin
        .from('student_streaks')
        .select(`
          student_id,
          current_streak,
          students!inner(full_name, parent_id, school_id)
        `)
        .gt('current_streak', 0)
        .neq('last_activity_date', today);

      if (!streaks || streaks.length === 0) {
        console.log('[cron/streak-reminder] No at-risk streaks found.');
        return;
      }

      type StreakRow = {
        student_id: string;
        current_streak: number;
        students: { full_name: string; parent_id: string | null; school_id: string } | Array<{ full_name: string; parent_id: string | null; school_id: string }>;
      };
      const streakRows = streaks as unknown as StreakRow[];

      // Normalise: Supabase may return students as array or object depending on join type
      type NormalisedStreakRow = {
        student_id: string;
        current_streak: number;
        studentInfo: { full_name: string; parent_id: string | null; school_id: string };
      };

      const normalisedStreaks: NormalisedStreakRow[] = streakRows
        .map((s) => {
          const info = Array.isArray(s.students) ? s.students[0] : s.students;
          if (!info) return null;
          return { student_id: s.student_id, current_streak: s.current_streak, studentInfo: info };
        })
        .filter((s): s is NormalisedStreakRow => s !== null);
      const studentIds = normalisedStreaks.map((s) => s.student_id);
      void studentIds; // previously used for premium filter — kept to avoid lint unused-var

      // All students with at-risk streaks are eligible — premium filter removed.
      const eligibleStreaks = normalisedStreaks;

      // FIX 1: Batch FCM sends in groups of 50 instead of sequential individual calls.
      // Prevents Railway cron timeout at scale (1000 students = 1000 sequential calls → timeout).
      const BATCH_SIZE = 50;

      for (let i = 0; i < eligibleStreaks.length; i += BATCH_SIZE) {
        const batch = eligibleStreaks.slice(i, i + BATCH_SIZE);

        await Promise.allSettled(
          batch.flatMap((streak) => {
            const studentName = streak.studentInfo.full_name;
            const parentId    = streak.studentInfo.parent_id;
            const streakDays  = streak.current_streak;

            const sends = [
              sendPushNotification(
                streak.student_id,
                '⚠️ Your streak is at risk!',
                `Your ${streakDays}-day streak ends in 4 hours! Complete today's activity now to keep it going.`,
                { type: 'streak_reminder', current_streak: String(streakDays) },
                'student'
              ),
            ];

            if (parentId) {
              sends.push(
                sendPushNotification(
                  parentId,
                  `⚠️ ${studentName}'s streak is at risk!`,
                  `${studentName}'s ${streakDays}-day streak ends in 4 hours! Help them complete today's activity.`,
                  { type: 'streak_reminder', current_streak: String(streakDays), student_id: streak.student_id },
                  'user'
                )
              );
            }

            return sends;
          })
        );

        notified += batch.length;

        // Small delay between batches to avoid FCM rate limits
        if (i + BATCH_SIZE < eligibleStreaks.length) {
          await sleep(200);
        }
      }

      console.log(`[cron/streak-reminder] Done — notified: ${notified}, skipped: ${skipped}`);
    } catch (err) {
      console.error('[cron/streak-reminder] Error:', err);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  });
});

export default router;
