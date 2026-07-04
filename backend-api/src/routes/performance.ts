import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../utils/audit';

const router = Router();

router.use(authenticate);

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarkRow {
  subject: string;
  score: number;
  max_score: number;
  created_at: string;
}

interface SubjectSummary {
  name: string;
  average: number;
  latest_score: number | null;
  previous_score: number | null;
  change: number | null;
  trend: 'improved' | 'dropped' | 'unchanged' | 'first';
  message: string;
}

// ── GET /api/performance/:student_id ─────────────────────────────────────────

/**
 * Returns a complete performance summary for a student.
 *
 * Access:
 *  - superadmin / schooladmin / teacher: any student
 *  - parent: only their own children
 *  - student: only themselves (matched via students.user_id or parent_id fallback)
 */
router.get(
  '/:student_id',
  requireRole('superadmin', 'schooladmin', 'teacher', 'student'),
  async (req: Request, res: Response) => {
    try {
    const { student_id } = req.params;
    const requestingUser = req.user!;

    // ── Access control ──────────────────────────────────────────────────────

    if (requestingUser.role === 'student') {
      // Students are linked via a user_id column on the students table
      const { data: studentRecord } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('id', student_id)
        .eq('user_id', requestingUser.id)
        .maybeSingle();

      if (!studentRecord) {
        sendError(res, 'Access denied', 403);
        return;
      }
    }

    // ── Fetch student name ──────────────────────────────────────────────────

    const { data: studentData, error: studentErr } = await supabaseAdmin
      .from('students')
      .select('full_name')
      .eq('id', student_id)
      .maybeSingle();

    if (studentErr || !studentData) {
      sendError(res, 'Student not found', 404);
      return;
    }

    // ── Fetch all marks ─────────────────────────────────────────────────────

    const { data: marks, error: marksErr } = await supabaseAdmin
      .from('marks')
      .select('subject, score, max_score, created_at')
      .eq('student_id', student_id)
      .order('created_at', { ascending: true });

    if (marksErr) {
      sendError(res, marksErr.message, 500);
      return;
    }

    const allMarks: MarkRow[] = marks ?? [];

    // ── Fetch attendance (last 180 days only for performance) ──────────────

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 180);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    const { data: attendanceRows, error: attErr } = await supabaseAdmin
      .from('attendance')
      .select('status')
      .eq('student_id', student_id)
      .gte('date', cutoffStr);

    if (attErr) {
      sendError(res, attErr.message, 500);
      return;
    }

    const totalDays = attendanceRows?.length ?? 0;
    const presentDays =
      attendanceRows?.filter(
        (r: { status: string }) => r.status === 'present' || r.status === 'late'
      ).length ?? 0;

    const attendance_percentage =
      totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

    // ── Group marks by subject ──────────────────────────────────────────────

    const subjectMap = new Map<string, MarkRow[]>();

    for (const mark of allMarks) {
      const key = mark.subject;
      if (!subjectMap.has(key)) subjectMap.set(key, []);
      subjectMap.get(key)!.push(mark);
    }

    // ── Build per-subject summary ───────────────────────────────────────────

    const subjects: SubjectSummary[] = [];

    for (const [subjectName, subjectMarks] of subjectMap.entries()) {
      // Marks are already sorted ascending by created_at
      const percentages = subjectMarks.map(
        (m) => (m.score / m.max_score) * 100
      );

      // Average: sum of (score/max_score*100) / count
      const average =
        Math.round(
          (percentages.reduce((acc, p) => acc + p, 0) / percentages.length) * 10
        ) / 10;

      const latestPct =
        percentages.length >= 1
          ? Math.round(percentages[percentages.length - 1] * 10) / 10
          : null;

      const previousPct =
        percentages.length >= 2
          ? Math.round(percentages[percentages.length - 2] * 10) / 10
          : null;

      let change: number | null = null;
      let trend: SubjectSummary['trend'] = 'first';
      let message: string;

      if (previousPct === null) {
        // Only one test recorded
        trend = 'first';
        message = 'First test recorded';
      } else {
        change = Math.round((latestPct! - previousPct) * 10) / 10;

        if (change > 0) {
          trend = 'improved';
          message = `${subjectName} improved by ${change}%`;
        } else if (change < 0) {
          trend = 'dropped';
          message = `${subjectName} dropped by ${Math.abs(change)}%`;
        } else {
          trend = 'unchanged';
          message = `${subjectName} score unchanged`;
        }
      }

      subjects.push({
        name: subjectName,
        average,
        latest_score: latestPct,
        previous_score: previousPct,
        change,
        trend,
        message,
      });
    }

    // ── Strongest & weakest subjects ────────────────────────────────────────

    let strongest_subject: { name: string; average: number } | null = null;
    let weakest_subject: { name: string; average: number } | null = null;

    if (subjects.length > 0) {
      const sorted = [...subjects].sort((a, b) => b.average - a.average);
      strongest_subject = { name: sorted[0].name, average: sorted[0].average };
      weakest_subject = {
        name: sorted[sorted.length - 1].name,
        average: sorted[sorted.length - 1].average,
      };
    }

    // ── Audit log ───────────────────────────────────────────────────────────

    await logAudit(requestingUser.id, 'PERFORMANCE_VIEWED', {
      student_id,
      viewed_by_role: requestingUser.role,
    });

    // ── Response ────────────────────────────────────────────────────────────

    sendSuccess(res, {
      student_id,
      student_name: studentData.full_name,
      strongest_subject,
      weakest_subject,
      attendance_percentage,
      subjects,
    });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

export default router;
