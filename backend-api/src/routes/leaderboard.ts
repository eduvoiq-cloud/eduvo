/**
 * /api/leaderboard
 *
 * Class-level leaderboard scored from real data filtered to the current
 * calendar month. No cron/reset job needed — the month filter naturally
 * means scores start at 0 on the 1st of every month.
 *
 * Score breakdown (max 100 pts):
 *   • Marks          — 40 pts  (teacher-uploaded marks, avg % × 0.4)
 *   • In-app tests   — 20 pts  (avg % of submitted test_attempts × 0.2)
 *   • Streak         — 20 pts  (current_streak, capped at 30 days → 20 pts)
 *   • Homework       — 10 pts  (submitted homework this month, capped at 10)
 *   • Attendance     — 10 pts  (attendance % this month × 0.1)
 *
 * GET /api/leaderboard/class
 *   Auth : student token  (sees their own class only)
 *   Query: class_name (required), section (required)
 *   Returns: ranked list + the requesting student's own entry
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticateStudent } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

// ── Score weights ─────────────────────────────────────────────────────────────
const WEIGHT_MARKS     = 40;
const WEIGHT_TESTS     = 20;
const WEIGHT_STREAK    = 20;
const WEIGHT_HOMEWORK  = 10;
const WEIGHT_ATTEND    = 10;
const STREAK_CAP_DAYS  = 30; // 30 days → full 20 pts

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the first day of the current month as YYYY-MM-DD (UTC). */
function monthStart(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Returns the last day of the current month as YYYY-MM-DD (UTC). */
function monthEnd(): string {
  const d = new Date();
  const lastDay = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  return `${lastDay.getUTCFullYear()}-${String(lastDay.getUTCMonth() + 1).padStart(2, '0')}-${String(lastDay.getUTCDate()).padStart(2, '0')}`;
}

/** Days remaining until the end of this month. */
function daysUntilMonthEnd(): number {
  const now = new Date();
  const end = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);
  const diffMs = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/leaderboard/class?class_name=7&section=A
 *
 * Accessible by student token. The student can only view their own class.
 */
router.get('/class', authenticateStudent, async (req: Request, res: Response) => {
  const requestingStudentId = req.student!.id;
  const className = (req.query.class_name as string | undefined)?.trim();
  const section   = (req.query.section   as string | undefined)?.trim();

  if (!className || !section) {
    sendError(res, 'Query params "class_name" and "section" are required', 400);
    return;
  }

  // ── 1. Fetch all active students in this class ────────────────────────────
  const { data: students, error: studErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name, school_id')
    .ilike('class_name', className)
    .ilike('section', section)
    .eq('is_deleted', false);

  if (studErr) {
    console.error('[leaderboard] students fetch error:', studErr.message);
    sendError(res, 'Failed to fetch class students', 500);
    return;
  }

  if (!students || students.length === 0) {
    sendSuccess(res, { leaderboard: [], days_until_reset: daysUntilMonthEnd(), month_start: monthStart() });
    return;
  }

  // Verify the requesting student is actually in this class (security gate)
  const studentIds = (students as Array<{ id: string; full_name: string; school_id: string }>).map((s) => s.id);
  if (!studentIds.includes(requestingStudentId)) {
    sendError(res, 'You can only view the leaderboard for your own class', 403);
    return;
  }

  const start = monthStart();
  const end   = monthEnd();

  // ── 2. Fetch all scoring data in parallel ─────────────────────────────────
  const BATCH = 500; // PostgREST IN-clause safety batch size

  // Split large IN clauses into batches and flatten results
  async function fetchBatched<T>(
    fn: (batch: string[]) => Promise<T[]>
  ): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < studentIds.length; i += BATCH) {
      const batch = studentIds.slice(i, i + BATCH);
      const rows = await fn(batch);
      results.push(...rows);
    }
    return results;
  }

  const [marksResult, testAttemptsResult, streaksResult, homeworkResult, attendanceResult] =
    await Promise.allSettled([
      // Teacher-uploaded marks this month
      fetchBatched(async (batch) => {
        const { data, error } = await supabaseAdmin
          .from('marks')
          .select('student_id, score, max_score')
          .in('student_id', batch)
          .gte('created_at', `${start}T00:00:00.000Z`)
          .lte('created_at', `${end}T23:59:59.999Z`);
        if (error) throw error;
        return (data ?? []) as Array<{ student_id: string; score: number; max_score: number }>;
      }),

      // In-app test attempts submitted this month
      fetchBatched(async (batch) => {
        const { data, error } = await supabaseAdmin
          .from('test_attempts')
          .select('student_id, percentage_score')
          .in('student_id', batch)
          .eq('is_submitted', true)
          .gte('submitted_at', `${start}T00:00:00.000Z`)
          .lte('submitted_at', `${end}T23:59:59.999Z`);
        if (error) throw error;
        return (data ?? []) as Array<{ student_id: string; percentage_score: number }>;
      }),

      // Current streaks (carries over month-to-month intentionally)
      (async () => {
        const { data, error } = await supabaseAdmin
          .from('student_streaks')
          .select('student_id, current_streak')
          .in('student_id', studentIds);
        if (error) throw error;
        return (data ?? []) as Array<{ student_id: string; current_streak: number }>;
      })(),

      // Homework submissions this month
      fetchBatched(async (batch) => {
        const { data, error } = await supabaseAdmin
          .from('homework_submissions')
          .select('student_id')
          .in('student_id', batch)
          .eq('status', 'submitted')
          .gte('submitted_at', `${start}T00:00:00.000Z`)
          .lte('submitted_at', `${end}T23:59:59.999Z`);
        if (error) throw error;
        return (data ?? []) as Array<{ student_id: string }>;
      }),

      // Attendance this month
      fetchBatched(async (batch) => {
        const { data, error } = await supabaseAdmin
          .from('attendance')
          .select('student_id, status')
          .in('student_id', batch)
          .gte('date', start)
          .lte('date', end);
        if (error) throw error;
        return (data ?? []) as Array<{ student_id: string; status: string }>;
      }),
    ]);

  // ── 3. Build per-student score maps ──────────────────────────────────────

  // Marks: avg percentage → 0–40 pts
  const marksMap = new Map<string, { totalPct: number; count: number }>();
  if (marksResult.status === 'fulfilled') {
    for (const row of marksResult.value) {
      const pct = row.max_score > 0 ? (row.score / row.max_score) * 100 : 0;
      const cur = marksMap.get(row.student_id) ?? { totalPct: 0, count: 0 };
      marksMap.set(row.student_id, { totalPct: cur.totalPct + pct, count: cur.count + 1 });
    }
  }

  // Test attempts: avg percentage → 0–20 pts
  const testMap = new Map<string, { totalPct: number; count: number }>();
  if (testAttemptsResult.status === 'fulfilled') {
    for (const row of testAttemptsResult.value) {
      const pct = row.percentage_score ?? 0;
      const cur = testMap.get(row.student_id) ?? { totalPct: 0, count: 0 };
      testMap.set(row.student_id, { totalPct: cur.totalPct + pct, count: cur.count + 1 });
    }
  }

  // Streaks: current_streak days, capped at STREAK_CAP_DAYS → 0–20 pts
  const streakMap = new Map<string, number>();
  if (streaksResult.status === 'fulfilled') {
    for (const row of streaksResult.value) {
      streakMap.set(row.student_id, row.current_streak ?? 0);
    }
  }

  // Homework: count of submissions, capped at 10 → 0–10 pts
  const hwMap = new Map<string, number>();
  if (homeworkResult.status === 'fulfilled') {
    for (const row of homeworkResult.value) {
      hwMap.set(row.student_id, (hwMap.get(row.student_id) ?? 0) + 1);
    }
  }

  // Attendance: present% this month → 0–10 pts
  const attMap = new Map<string, { present: number; total: number }>();
  if (attendanceResult.status === 'fulfilled') {
    for (const row of attendanceResult.value) {
      const cur = attMap.get(row.student_id) ?? { present: 0, total: 0 };
      const isPresent = row.status === 'present' || row.status === 'late' || row.status === 'excused';
      attMap.set(row.student_id, {
        present: cur.present + (isPresent ? 1 : 0),
        total: cur.total + 1,
      });
    }
  }

  // ── 4. Compute final scores ───────────────────────────────────────────────

  const ranked = (students as Array<{ id: string; full_name: string }>).map((s) => {
    const sid = s.id;

    // Marks: 0–40
    const marksEntry = marksMap.get(sid);
    const marksAvgPct = marksEntry && marksEntry.count > 0
      ? marksEntry.totalPct / marksEntry.count
      : 0;
    const marksScore = Math.round((marksAvgPct / 100) * WEIGHT_MARKS);

    // Tests: 0–20
    const testEntry = testMap.get(sid);
    const testAvgPct = testEntry && testEntry.count > 0
      ? testEntry.totalPct / testEntry.count
      : 0;
    const testScore = Math.round((testAvgPct / 100) * WEIGHT_TESTS);

    // Streak: 0–20 (1 pt per streak day, capped at 30 days)
    const streakDays = Math.min(streakMap.get(sid) ?? 0, STREAK_CAP_DAYS);
    const streakScore = Math.round((streakDays / STREAK_CAP_DAYS) * WEIGHT_STREAK);

    // Homework: 1 pt per submission, max 10
    const hwCount = hwMap.get(sid) ?? 0;
    const hwScore = Math.min(hwCount, WEIGHT_HOMEWORK);

    // Attendance: present% → 0–10
    const attEntry = attMap.get(sid);
    const attPct = attEntry && attEntry.total > 0
      ? (attEntry.present / attEntry.total) * 100
      : 0;
    const attScore = Math.round((attPct / 100) * WEIGHT_ATTEND);

    const totalScore = marksScore + testScore + streakScore + hwScore + attScore;

    return {
      student_id: sid,
      student_name: s.full_name,
      total_score: totalScore,
      breakdown: {
        marks:      marksScore,
        tests:      testScore,
        streak:     streakScore,
        homework:   hwScore,
        attendance: attScore,
      },
      // Raw values for display
      raw: {
        marks_avg_pct:    Math.round(marksAvgPct),
        test_avg_pct:     Math.round(testAvgPct),
        streak_days:      streakMap.get(sid) ?? 0,
        homework_count:   hwCount,
        attendance_pct:   Math.round(attPct),
      },
    };
  });

  // Sort by total score descending, break ties by name
  ranked.sort((a, b) =>
    b.total_score !== a.total_score
      ? b.total_score - a.total_score
      : a.student_name.localeCompare(b.student_name)
  );

  // Assign ranks (shared rank on tie)
  const leaderboard: Array<typeof ranked[0] & { rank: number; is_current_student: boolean }> = [];
  let currentRank = 1;
  for (let i = 0; i < ranked.length; i++) {
    if (i > 0 && ranked[i].total_score < ranked[i - 1].total_score) {
      currentRank = i + 1;
    }
    leaderboard.push({
      rank: currentRank,
      ...ranked[i],
      is_current_student: ranked[i].student_id === requestingStudentId,
    });
  }

  sendSuccess(res, {
    leaderboard,
    days_until_reset: daysUntilMonthEnd(),
    month_start: start,
    total_students: students.length,
  });
});

export default router;
