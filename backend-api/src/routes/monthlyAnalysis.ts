/**
 * /api/monthly-analysis
 *
 * Parent/admin read routes for monthly AI reports.
 *
 * GET  /api/monthly-analysis/insights/:studentId
 *   — Combined insights: latest report, past 4 reports, weak topics, streak, marks summary.
 *     Auth: parent (own child), teacher, schooladmin, or superadmin.
 *
 * GET  /api/monthly-analysis/report/:studentId
 *   — Returns the latest monthly_reports row only.
 *     Auth: same as insights.
 *
 * POST /api/monthly-analysis/recalculate/:studentId
 *   — Admin-triggered recalculation (no WhatsApp sent).
 *     Auth: schooladmin or superadmin only.
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateAny } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';
import { recalculateStudentReport } from './cronMonthly';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Shared access check used by GET endpoints.
 * Returns true if the request is authorised for the given studentId.
 * Sends a 403 error and returns false if not.
 */
async function checkAccess(
  req: Request,
  res: Response,
  studentId: string
): Promise<boolean> {
  if (req.tokenType === 'student') {
    if (req.student!.id !== studentId) {
      sendError(res, 'Access denied', 403);
      return false;
    }
    return true;
  }

  const role = req.user?.role;

  if (role === 'schooladmin' || role === 'superadmin' || role === 'teacher') {
    return true;
  }

  sendError(res, 'Access denied', 403);
  return false;
}

// ── GET /api/monthly-analysis/insights/:studentId ─────────────────────────────
/**
 * Combined insights for the premium monthly insights screen.
 * Returns latest report, past 4 reports, weak topics, streak, and marks summary.
 */
router.get(
  '/insights/:studentId',
  authenticateAny,
  async (req: Request, res: Response) => {
    try {
    const studentId = req.params.studentId as string;

    if (!(await checkAccess(req, res, studentId))) return;

    // Fetch all data in parallel
    const [latestRes, pastRes, weakTopicsRes, streakRes, marksRes] = await Promise.all([
      // Latest monthly report
      supabaseAdmin
        .from('monthly_reports')
        .select('*')
        .eq('student_id', studentId)
        .order('month_start_date', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Past 4 reports (will exclude latest below)
      supabaseAdmin
        .from('monthly_reports')
        .select('*')
        .eq('student_id', studentId)
        .order('month_start_date', { ascending: false })
        .limit(5), // fetch 5, drop the first (latest) after

      // Weak topics
      supabaseAdmin
        .from('weak_topics')
        .select('subject, topic, weakness_score, last_calculated_at')
        .eq('student_id', studentId)
        .order('weakness_score', { ascending: false }),

      // Streak
      supabaseAdmin
        .from('student_streaks')
        .select('current_streak, longest_streak, last_activity_date, total_active_days')
        .eq('student_id', studentId)
        .maybeSingle(),

      // Marks summary — last 50 entries for subject averages
      supabaseAdmin
        .from('marks')
        .select('subject, score, max_score, created_at')
        .eq('student_id', studentId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    // Past reports = all results except the first (which is the latest)
    const allReports = (pastRes.data ?? []) as Array<Record<string, unknown>>;
    const pastReports = allReports.slice(1).slice(0, 4);

    // Weak topics as string[]
    const weakTopics = (weakTopicsRes.data ?? []).map(
      (r: Record<string, unknown>) => r.topic as string
    );

    // Streak
    const streakRow = streakRes.data as Record<string, unknown> | null;
    const streak = {
      current:  Number(streakRow?.current_streak  ?? 0),
      longest:  Number(streakRow?.longest_streak  ?? 0),
    };

    // Marks summary: subject -> average percentage
    const subjectMap = new Map<string, number[]>();
    for (const row of (marksRes.data ?? []) as Array<Record<string, unknown>>) {
      const subject  = row.subject as string;
      const score    = Number(row.score);
      const maxScore = Number(row.max_score) || 100;
      if (!subjectMap.has(subject)) subjectMap.set(subject, []);
      subjectMap.get(subject)!.push(Math.round((score / maxScore) * 100));
    }

    const marksSummary: Record<string, number> = {};
    for (const [subject, pcts] of subjectMap.entries()) {
      marksSummary[subject] = Math.round(
        pcts.reduce((a, b) => a + b, 0) / pcts.length
      );
    }

    sendSuccess(res, {
      latest_report: latestRes.data ?? null,
      past_reports:  pastReports,
      weak_topics:   weakTopics,
      streak,
      marks_summary: marksSummary,
    });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── GET /api/monthly-analysis/report/:studentId ───────────────────────────────
/** Returns the latest monthly_reports row only. */
router.get(
  '/report/:studentId',
  authenticateAny,
  async (req: Request, res: Response) => {
    try {
    const studentId = req.params.studentId as string;

    if (!(await checkAccess(req, res, studentId))) return;

    const { data, error } = await supabaseAdmin
      .from('monthly_reports')
      .select('*')
      .eq('student_id', studentId)
      .order('month_start_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, { report: data ?? null });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── POST /api/monthly-analysis/recalculate/:studentId ────────────────────────
/**
 * Admin-triggered recalculation — delegates to shared function in cronMonthly.
 * Does NOT send WhatsApp.
 * Auth: schooladmin or superadmin only.
 */
router.post(
  '/recalculate/:studentId',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    try {
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
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

export default router;
