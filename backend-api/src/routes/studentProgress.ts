/**
 * /api/student-progress — weak topics, streaks
 *
 * All routes require a student token.
 *
 * Weak Topics:
 *   GET    /api/student-progress/weak-topics          — student's weak topics
 *   GET    /api/student-progress/weak-topics/:subject — filtered by subject
 *
 * Streaks:
 *   GET    /api/student-progress/streak               — current streak data
 *   GET    /api/student-progress/streak/log           — activity log (last 30 days)
 *
 * Admin read-only:
 *   GET    /api/student-progress/admin/:studentId/weak-topics
 *   GET    /api/student-progress/admin/:studentId/streak
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Weak Topics ───────────────────────────────────────────────────────────────

// GET /api/student-progress/weak-topics
router.get(
  '/weak-topics',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;

    const { data, error } = await supabaseAdmin
      .from('weak_topics')
      .select('id, subject, topic, weakness_score, last_calculated_at')
      .eq('student_id', studentId)
      .order('weakness_score', { ascending: false });

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// GET /api/student-progress/weak-topics/:subject
router.get(
  '/weak-topics/:subject',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;

    const { data, error } = await supabaseAdmin
      .from('weak_topics')
      .select('id, subject, topic, weakness_score, last_calculated_at')
      .eq('student_id', studentId)
      .ilike('subject', String(req.params.subject))
      .order('weakness_score', { ascending: false });

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// ── Streaks ───────────────────────────────────────────────────────────────────

// GET /api/student-progress/streak
router.get(
  '/streak',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;

    const { data, error } = await supabaseAdmin
      .from('student_streaks')
      .select('*')
      .eq('student_id', studentId)
      .maybeSingle();

    if (error) { sendError(res, error.message, 500); return; }

    // Return zeroed defaults if no row yet
    if (!data) {
      sendSuccess(res, {
        student_id: studentId,
        current_streak: 0,
        longest_streak: 0,
        last_activity_date: null,
        total_active_days: 0,
      });
      return;
    }

    // ── Lazy streak staleness check ───────────────────────────────────────────
    // If the student's last_activity_date is older than yesterday (IST), their
    // streak has been broken — they missed at least one day.
    // We reset current_streak to 0 here (lazily) so the UI always shows the
    // correct value without needing a nightly cron job.
    const row = data as Record<string, unknown>;
    const lastActivityDate = row.last_activity_date as string | null;

    if (lastActivityDate) {
      // Compute yesterday in IST (UTC+5:30)
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const nowIST = new Date(Date.now() + IST_OFFSET_MS);
      const yesterdayIST = new Date(nowIST.getTime() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const todayISTStr = nowIST.toISOString().slice(0, 10);

      const isStale =
        lastActivityDate !== todayISTStr && lastActivityDate < yesterdayIST;

      if (isStale && (row.current_streak as number) > 0) {
        // Persist the reset so subsequent reads are fast.
        // Reset to 0 (not 1) because the student has not yet done any activity today.
        // The next time they complete an activity, updateStreak will set it to 1.
        // This keeps the UI (showing 0) consistent with what updateStreak would compute
        // when called for a gap ≥ 2 days and then immediately incremented to 1.
        await supabaseAdmin
          .from('student_streaks')
          .update({ current_streak: 0, updated_at: new Date().toISOString() })
          .eq('student_id', studentId);

        sendSuccess(res, {
          ...row,
          current_streak: 0,
        });
        return;
      }
    }

    sendSuccess(res, data);
  }
);

// GET /api/student-progress/streak/log?days=30
router.get(
  '/streak/log',
  authenticateStudent,
  async (req: Request, res: Response) => {
    const studentId = req.student!.id;

    const rawDays = parseInt((req.query.days as string) ?? '30', 10);
    const days = isNaN(rawDays) || rawDays < 1 ? 30 : Math.min(rawDays, 90);

    // Use IST (UTC+5:30) so the since-date matches how streak_log entries are written
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(Date.now() + IST_OFFSET_MS);
    nowIST.setDate(nowIST.getDate() - days);
    const sinceStr = nowIST.toISOString().slice(0, 10);

    const { data, error } = await supabaseAdmin
      .from('streak_log')
      .select('activity_date, activity_type, created_at')
      .eq('student_id', studentId)
      .gte('activity_date', sinceStr)
      .order('activity_date', { ascending: false });

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// ── Admin read-only endpoints ─────────────────────────────────────────────────

// GET /api/student-progress/admin/:studentId/weak-topics
router.get(
  '/admin/:studentId/weak-topics',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;
    const { studentId } = req.params;

    // Verify student belongs to school
    const { data: student } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('id', studentId)
      .eq('school_id', schoolId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (!student) { sendError(res, 'Student not found', 404); return; }

    const { data, error } = await supabaseAdmin
      .from('weak_topics')
      .select('id, subject, topic, weakness_score, last_calculated_at')
      .eq('student_id', studentId)
      .order('weakness_score', { ascending: false });

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? []);
  }
);

// GET /api/student-progress/admin/:studentId/streak
router.get(
  '/admin/:studentId/streak',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;
    const { studentId } = req.params;

    const { data: student } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('id', studentId)
      .eq('school_id', schoolId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (!student) { sendError(res, 'Student not found', 404); return; }

    const { data, error } = await supabaseAdmin
      .from('student_streaks')
      .select('*')
      .eq('student_id', studentId)
      .maybeSingle();

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, data ?? { student_id: studentId, current_streak: 0, total_active_days: 0 });
  }
);

// ── Leaderboard — class-wise top 5 by current_streak ─────────────────────────

/**
 * GET /api/student-progress/leaderboard?class=7&section=A
 *
 * Returns the top 5 students by current_streak in a given class+section.
 * Accessible by: schooladmin, superadmin, teacher.
 *
 * Query params:
 *   class    (required) — e.g. "7", "10"
 *   section  (required) — e.g. "A", "B"
 *
 * Used for the class notice-board / TV screen in school admin view.
 */
router.get(
  '/leaderboard',
  authenticate,
  requireRole('schooladmin', 'superadmin', 'teacher'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;
    const className = (req.query.class as string | undefined)?.trim();
    const section = (req.query.section as string | undefined)?.trim();

    if (!className || !section) {
      sendError(res, 'Query params "class" and "section" are required', 400);
      return;
    }

    // Fetch all students in this class/section for the school
    const { data: students, error: studErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, class_name, section')
      .eq('school_id', schoolId)
      .ilike('class_name', className)
      .ilike('section', section)
      .eq('is_deleted', false);

    if (studErr) { sendError(res, studErr.message, 500); return; }
    if (!students || students.length === 0) {
      sendSuccess(res, []);
      return;
    }

    const studentIds = (students as Array<{ id: string; full_name: string; class_name: string; section: string }>)
      .map((s) => s.id);

    // Fetch streak rows for these students
    const { data: streaks, error: streakErr } = await supabaseAdmin
      .from('student_streaks')
      .select('student_id, current_streak, longest_streak, total_active_days')
      .in('student_id', studentIds)
      .gt('current_streak', 0)
      .order('current_streak', { ascending: false })
      .limit(5);

    if (streakErr) { sendError(res, streakErr.message, 500); return; }

    // Join student name data
    const studentMap = new Map<string, { full_name: string; class_name: string; section: string }>();
    for (const s of students as Array<{ id: string; full_name: string; class_name: string; section: string }>) {
      studentMap.set(s.id, { full_name: s.full_name, class_name: s.class_name, section: s.section });
    }

    const leaderboard = (streaks ?? []).map((row: Record<string, unknown>, idx) => {
      const sid = row.student_id as string;
      const student = studentMap.get(sid);
      return {
        rank: idx + 1,
        student_id: sid,
        student_name: student?.full_name ?? 'Unknown',
        class_name: student?.class_name ?? className,
        section: student?.section ?? section,
        current_streak: row.current_streak as number,
        longest_streak: row.longest_streak as number,
        total_active_days: row.total_active_days as number,
      };
    });

    sendSuccess(res, leaderboard);
  }
);

/**
 * GET /api/student-progress/leaderboard/school
 *
 * Returns top-5 leaderboard for EVERY class-section in the school.
 * Accessible by: schooladmin, superadmin.
 * Used for a school-wide notice-board / TV display.
 */
router.get(
  '/leaderboard/school',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const schoolId = req.user!.school_id!;

    // Get all distinct class+section combos for this school
    const { data: students, error: studErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, class_name, section')
      .eq('school_id', schoolId)
      .eq('is_deleted', false)
      .not('class_name', 'is', null)
      .not('section', 'is', null);

    if (studErr) { sendError(res, studErr.message, 500); return; }
    if (!students || students.length === 0) {
      sendSuccess(res, {});
      return;
    }

    // Build a map: "class section" → student[]
    type StudentRow = { id: string; full_name: string; class_name: string; section: string };
    const classMap = new Map<string, StudentRow[]>();
    for (const s of students as StudentRow[]) {
      const key = `${s.class_name} ${s.section}`;
      const arr = classMap.get(key) ?? [];
      arr.push(s);
      classMap.set(key, arr);
    }

    const allStudentIds = (students as StudentRow[]).map((s) => s.id);

    // Fetch all streak rows for the school's students in one query
    const { data: streaks, error: streakErr } = await supabaseAdmin
      .from('student_streaks')
      .select('student_id, current_streak, longest_streak, total_active_days')
      .in('student_id', allStudentIds)
      .gt('current_streak', 0);

    if (streakErr) { sendError(res, streakErr.message, 500); return; }

    // Build a studentId → streakRow map
    const streakMap = new Map<string, Record<string, unknown>>();
    for (const row of streaks ?? []) {
      streakMap.set((row as Record<string, unknown>).student_id as string, row as Record<string, unknown>);
    }

    // Build leaderboard per class-section
    const result: Record<string, Array<Record<string, unknown>>> = {};

    for (const [classKey, classStudents] of classMap.entries()) {
      const ranked = classStudents
        .map((s) => {
          const streak = streakMap.get(s.id);
          return {
            student_id: s.id,
            student_name: s.full_name,
            current_streak: (streak?.current_streak as number) ?? 0,
            longest_streak: (streak?.longest_streak as number) ?? 0,
            total_active_days: (streak?.total_active_days as number) ?? 0,
          };
        })
        .filter((r) => r.current_streak > 0)
        .sort((a, b) => b.current_streak - a.current_streak)
        .slice(0, 5)
        .map((r, idx) => ({ rank: idx + 1, ...r }));

      if (ranked.length > 0) {
        result[classKey] = ranked;
      }
    }

    sendSuccess(res, result);
  }
);

export default router;
