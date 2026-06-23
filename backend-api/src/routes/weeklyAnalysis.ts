/**
 * /api/weekly-analysis
 *
 * Cron-triggered and parent-read routes for weekly AI analysis.
 *
 * POST /api/weekly-analysis/run
 *   — Secret-guarded endpoint for Railway cron (Sunday schedule).
 *     Header: x-cron-secret: <CRON_SECRET env var>
 *
 * GET  /api/weekly-analysis/report/:studentId
 *   — Returns the latest weekly report for a student (parent-accessible).
 *     Auth: parent JWT + child ownership check
 *
 * GET  /api/weekly-analysis/reports/:studentId
 *   — Returns last N weekly reports for a student (parent-accessible).
 *
 * GET  /api/weekly-analysis/insights/:studentId
 *   — Returns combined insights: latest report + weak topics + streak + marks summary
 *     Auth: parent JWT
 *
 * POST /api/weekly-analysis/recalculate/:studentId
 *   — Manually triggers weak topic recalculation for a single student (admin only).
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateAny } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';
import {
  runWeeklyAnalysis,
  calculateWeakTopics,
  generateWeeklyReport,
  getLastSunday,
} from '../services/weeklyAnalysisService';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseClassLevel(className: string): number {
  const match = className.replace(/[^0-9]/g, '');
  return parseInt(match, 10) || 0;
}

// ── POST /api/weekly-analysis/run ─────────────────────────────────────────────
/**
 * Railway cron endpoint (Sunday).
 * Protected by CRON_SECRET header — not authenticated via JWT.
 */
router.post('/run', async (req: Request, res: Response) => {
  const cronSecret = (process.env.CRON_SECRET ?? '').trim();
  const rawHeader = req.headers['x-cron-secret'];
  const providedSecret = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader ?? '').trim();

  if (!cronSecret || providedSecret !== cronSecret) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  // Run async — respond immediately so Railway cron doesn't time out
  console.log('[weeklyAnalysis] Cron triggered weekly analysis job');

  // Run in background
  runWeeklyAnalysis()
    .then((result) => {
      console.log('[weeklyAnalysis] Job complete:', JSON.stringify(result));
    })
    .catch((err) => {
      console.error('[weeklyAnalysis] Job failed:', err);
    });

  sendSuccess(res, { message: 'Weekly analysis job started', week: getLastSunday() }, 'Job started');
});

// ── GET /api/weekly-analysis/report/:studentId ────────────────────────────────
/**
 * Returns the latest weekly report for a student.
 * Access: parent (own children), schooladmin/superadmin, or the student themselves.
 */
router.get(
  '/report/:studentId',
  authenticateAny,
  async (req: Request, res: Response) => {
    const studentId = req.params.studentId as string;

    // Access check
    if (req.tokenType !== 'student') {
      const userRole = req.user?.role;
      if (userRole !== 'schooladmin' && userRole !== 'superadmin' && userRole !== 'teacher') {
        sendError(res, 'Access denied', 403);
        return;
      }
    } else {
      // Student token: can only view own report
      if (req.student!.id !== studentId) { sendError(res, 'Access denied', 403); return; }
    }

    // Fetch the latest weekly report
    const { data, error } = await supabaseAdmin
      .from('weekly_reports')
      .select('id, student_id, week_start_date, report_text, generated_at, created_at')
      .eq('student_id', studentId)
      .order('week_start_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, { report: data ?? null });
  }
);

// ── GET /api/weekly-analysis/reports/:studentId ───────────────────────────────
/** Returns last N weekly reports. Query param: limit (default 4, max 12). */
router.get(
  '/reports/:studentId',
  authenticateAny,
  async (req: Request, res: Response) => {
    const studentId = req.params.studentId as string;

    // Access check
    if (req.tokenType !== 'student') {
      const userRole = req.user?.role;
      if (userRole !== 'schooladmin' && userRole !== 'superadmin') {
        sendError(res, 'Access denied', 403);
        return;
      }
    } else {
      if (req.student!.id !== studentId) { sendError(res, 'Access denied', 403); return; }
    }

    const rawLimit = parseInt((req.query.limit as string) ?? '4', 10);
    const limit = isNaN(rawLimit) ? 4 : Math.min(rawLimit, 12);

    const { data, error } = await supabaseAdmin
      .from('weekly_reports')
      .select('id, student_id, week_start_date, report_text, generated_at, created_at')
      .eq('student_id', studentId)
      .order('week_start_date', { ascending: false })
      .limit(limit);

    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, { reports: data ?? [] });
  }
);

// ── GET /api/weekly-analysis/insights/:studentId ──────────────────────────────
/**
 * Combined premium insights endpoint.
 * Returns: latest_report, weak_topics, streak, marks_summary, is_premium
 *
 * This is the single endpoint the parent PremiumInsightsScreen calls.
 */
router.get(
  '/insights/:studentId',
  authenticateAny,
  async (req: Request, res: Response) => {
    const studentId = req.params.studentId as string;

    // Access check
    if (req.tokenType !== 'student') {
      const userRole = req.user?.role;
      if (
        userRole !== 'schooladmin' &&
        userRole !== 'superadmin' &&
        userRole !== 'teacher'
      ) {
        sendError(res, 'Access denied', 403);
        return;
      }
    } else {
      if (req.student!.id !== studentId) { sendError(res, 'Access denied', 403); return; }
    }

    // Fetch all data in parallel
    const [reportRes, weakTopicsRes, streakRes, marksRes] = await Promise.all([
      // Latest weekly report
      supabaseAdmin
        .from('weekly_reports')
        .select('id, week_start_date, report_text, generated_at')
        .eq('student_id', studentId)
        .order('week_start_date', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Weak topics (all, ordered by weakness_score desc)
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

      // Marks summary — subject averages
      supabaseAdmin
        .from('marks')
        .select('subject, score, max_score, exam_type, created_at')
        .eq('student_id', studentId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    // Process marks into subject summaries
    const marksRows = (marksRes.data ?? []) as Array<{
      subject: string; score: number; max_score: number; created_at: string;
    }>;
    const subjectMap = new Map<string, number[]>();
    for (const m of marksRows) {
      if (!subjectMap.has(m.subject)) subjectMap.set(m.subject, []);
      subjectMap.get(m.subject)!.push(
        Math.round((m.score / (m.max_score || 100)) * 100)
      );
    }

    const marksSummary = Array.from(subjectMap.entries()).map(([subject, pcts]) => ({
      subject,
      average: Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length),
      count: pcts.length,
      latest: pcts[0] ?? null,
    }));

    sendSuccess(res, {
      latest_report: reportRes.data ?? null,
      weak_topics: weakTopicsRes.data ?? [],
      streak: streakRes.data ?? {
        current_streak: 0,
        longest_streak: 0,
        last_activity_date: null,
        total_active_days: 0,
      },
      marks_summary: marksSummary,
    });
  }
);

// ── POST /api/weekly-analysis/recalculate/:studentId ─────────────────────────
/** Admin: manually recalculate weak topics + generate a fresh report for one student. */
router.post(
  '/recalculate/:studentId',
  authenticate,
  requireRole('schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const studentId = req.params.studentId as string;
    const schoolId = req.user!.school_id;

    // Verify student belongs to school
    const { data: student, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, class_name, class, school_id, parent_id')
      .eq('id', studentId)
      .eq('school_id', schoolId ?? '')
      .eq('is_deleted', false)
      .maybeSingle();

    if (stuErr || !student) {
      sendError(res, 'Student not found', 404);
      return;
    }

    const s = student as {
      id: string; full_name: string; class_name: string; class: string;
      school_id: string; parent_id: string | null;
    };
    const classLevel = parseClassLevel(s.class_name || s.class || '1');

    // Recalculate weak topics
    const weakTopics = await calculateWeakTopics(studentId, classLevel);

    // Generate fresh report
    const weekStartDate = getLastSunday();
    const reportText = await generateWeeklyReport(
      {
        id: s.id,
        full_name: s.full_name,
        class_name: s.class_name,
        class: s.class,
        school_id: s.school_id,
        parent_id: s.parent_id,
      },
      weekStartDate
    );

    // Store report
    await supabaseAdmin
      .from('weekly_reports')
      .upsert(
        {
          student_id: studentId,
          week_start_date: weekStartDate,
          report_text: reportText,
          generated_at: new Date().toISOString(),
        },
        { onConflict: 'student_id,week_start_date' }
      );

    sendSuccess(res, {
      student_id: studentId,
      week_start_date: weekStartDate,
      weak_topics_calculated: weakTopics.length,
      report_text: reportText,
    }, 'Recalculation complete');
  }
);

export default router;
