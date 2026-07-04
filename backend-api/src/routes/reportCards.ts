import { Router, Request, Response } from 'express';
import { z } from 'zod';
import archiver from 'archiver';
import PDFDocument from 'pdfkit';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateAny } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { isClassAdmin } from './classAdmin';
import { sendSuccess, sendError, sendValidationError, sendDbError } from '../utils/response';
import { termFilterValues, normaliseTerm } from '../utils/term';
import { getTokensForStudents, getTokensForUsers, sendPushMulticast } from '../services/fcmService';

const router = Router();

// ── GET /api/report-cards/my ──────────────────────────────────────────────────
// Student-facing: returns all report cards for the authenticated student.
// Uses authenticateAny so it works with the student token.
router.get('/my', authenticateAny, async (req: Request, res: Response) => {
  try {
  const studentId = req.tokenType === 'student' ? req.student!.id : null;

  if (!studentId) {
    sendError(res, 'Only students can access this endpoint', 403);
    return;
  }

  // Fetch report cards and join school board via students table
  const { data: cards, error: cardsErr } = await supabaseAdmin
    .from('student_report_cards')
    .select('*')
    .eq('student_id', studentId)
    .order('generated_at', { ascending: false });

  if (cardsErr) {
    sendError(res, cardsErr.message, 500);
    return;
  }

  // Fetch the school's board for this student (single query, no N+1)
  let board: string | null = null;
  const { data: studentRow } = await supabaseAdmin
    .from('students')
    .select('school_id')
    .eq('id', studentId)
    .maybeSingle();

  if (studentRow?.school_id) {
    const { data: schoolRow } = await supabaseAdmin
      .from('schools')
      .select('board')
      .eq('id', studentRow.school_id)
      .maybeSingle();
    board = (schoolRow as { board?: string | null } | null)?.board ?? null;
  }

  // Inject board into every card
  const enriched = (cards ?? []).map((c) => ({ ...c, board }));

  sendSuccess(res, enriched);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// ── GET /api/report-cards/student/:studentId ──────────────────────────────────
// Parent-facing: returns report cards for a specific student.
// The parent must have the student linked (parent_id on students table).
router.get('/student/:studentId', authenticateAny, async (req: Request, res: Response) => {
  try {
  const { studentId } = req.params;

  // Require a staff/user token (parent) — not a student token
  if (req.tokenType !== 'staff') {
    sendError(res, 'Access denied', 403);
    return;
  }

  const parentId = req.user!.id;

  // Verify the student belongs to this parent
  const { data: studentRow } = await supabaseAdmin
    .from('students')
    .select('id')
    .eq('id', studentId)
    .eq('parent_id', parentId)
    .maybeSingle();

  if (!studentRow) {
    sendError(res, 'Student not found or not linked to your account', 403);
    return;
  }

  const { data: cards2, error: cards2Err } = await supabaseAdmin
    .from('student_report_cards')
    .select('*')
    .eq('student_id', studentId)
    .order('generated_at', { ascending: false });

  if (cards2Err) {
    sendError(res, cards2Err.message, 500);
    return;
  }

  // Fetch board for this student's school
  let board2: string | null = null;
  const { data: sRow } = await supabaseAdmin
    .from('students')
    .select('school_id')
    .eq('id', studentId)
    .maybeSingle();

  if (sRow?.school_id) {
    const { data: schRow } = await supabaseAdmin
      .from('schools')
      .select('board')
      .eq('id', sRow.school_id)
      .maybeSingle();
    board2 = (schRow as { board?: string | null } | null)?.board ?? null;
  }

  sendSuccess(res, (cards2 ?? []).map((c) => ({ ...c, board: board2 })));
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// ── All teacher routes below require a staff JWT ──────────────────────────────
router.use(authenticate);

// ── Grade helper ──────────────────────────────────────────────────────────────

function calcGrade(pct: number): string {
  if (pct >= 90) return 'A+';
  if (pct >= 75) return 'A';
  if (pct >= 60) return 'B';
  if (pct >= 45) return 'C';
  if (pct >= 33) return 'D';
  return 'F';
}

// ── Derive session year from current date ─────────────────────────────────────
// Academic year: Apr–Mar, e.g. April 2025 → "2025-26"

function sessionYear(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

// ── Shared query param / body schema ─────────────────────────────────────────

const reportCardSchema = z.object({
  class_name: z.string().min(1).max(50),
  section:    z.string().min(1).max(20),
  term:       z.string().min(1).max(50),
  exam_type:  z.string().min(1).max(50),
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface TeacherRow {
  teacher_id: string;
  subject: string;
  users: { name: string } | null;
}

interface MarkRow {
  subject: string;
  score: number;
  max_score: number;
}

interface StudentRow {
  id: string;
  full_name: string;
  roll_number: string | null;
}

interface SchoolRow {
  name: string;
  address: string;
  board?: string | null;
}

// ── GET /api/report-cards/readiness ──────────────────────────────────────────

router.get(
  '/readiness',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    try {
    const parsed = reportCardSchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { class_name, section, term, exam_type } = parsed.data;
    const teacherId = req.user!.id;
    const schoolId  = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // ── Class admin gate ──────────────────────────────────────────────────────
    const admin = await isClassAdmin(teacherId, schoolId, class_name, section);
    if (!admin) {
      sendError(res, 'Only the class admin can check report card readiness', 403);
      return;
    }

    // ── All teachers assigned to this class ───────────────────────────────────
    const { data: assignedTeachers, error: taErr } = await supabaseAdmin
      .from('teacher_assignments')
      .select('teacher_id, subject, users!teacher_assignments_teacher_id_fkey(name)')
      .eq('school_id', schoolId)
      .ilike('class_name', class_name.trim())
      .ilike('section', section.trim());

    if (taErr) {
      sendDbError(res, taErr, 'reportCards GET /readiness teacher_assignments');
      return;
    }

    const teachers = (assignedTeachers ?? []) as unknown as TeacherRow[];

    // ── Subjects with marks entered for this class+term+exam_type ────────────
    // We join marks → students to filter by school and class/section.
    // Use termFilterValues to handle "Term 1" / "term_1" / "term1" variants.
    const termValues = termFilterValues(term.trim());
    const normalisedExamType = exam_type.trim().toLowerCase();

    let marksQuery = supabaseAdmin
      .from('marks')
      .select('subject, students!inner(school_id, class_name, section)')
      .eq('students.school_id', schoolId)
      .ilike('students.class_name', class_name.trim())
      .ilike('students.section', section.trim())
      .ilike('exam_type', normalisedExamType);

    marksQuery = termValues.length === 1
      ? marksQuery.eq('term', termValues[0])
      : marksQuery.in('term', termValues);

    const { data: marksData, error: marksErr } = await marksQuery;

    if (marksErr) {
      sendDbError(res, marksErr, 'reportCards GET /readiness marks');
      return;
    }

    // Unique set of subjects that have at least one mark
    const uploadedSubjects = new Set(
      (marksData ?? []).map((m: { subject: string }) => m.subject.toLowerCase())
    );

    // Find missing teacher+subject combos
    const missing: { teacher_name: string; subject: string }[] = [];
    for (const t of teachers) {
      if (!uploadedSubjects.has(t.subject.toLowerCase())) {
        missing.push({
          teacher_name: t.users?.name ?? 'Unknown',
          subject: t.subject,
        });
      }
    }

    const totalTeachers = teachers.length;
    const uploaded = totalTeachers - missing.length;

    sendSuccess(res, {
      total_teachers: totalTeachers,
      uploaded,
      missing,
      all_uploaded: missing.length === 0,
    });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── GET /api/report-cards/class ──────────────────────────────────────────────
router.get(
  '/class',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    try {
    const parsed = reportCardSchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { class_name, section, term, exam_type } = parsed.data;
    const teacherId = req.user!.id;
    const schoolId  = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // ── Class admin gate ──────────────────────────────────────────────────────
    const admin = await isClassAdmin(teacherId, schoolId, class_name, section);
    if (!admin) {
      sendError(res, 'Only the class admin can view class report cards', 403);
      return;
    }

    // Fetch existing report cards for this class+section+term+exam_type
    // Join with students to filter by school_id and class/section
    const { data, error } = await supabaseAdmin
      .from('student_report_cards')
      .select(`
        id,
        student_id,
        class_name,
        section,
        term,
        exam_type,
        grand_total,
        grand_max,
        percentage,
        grade,
        session_year,
        generated_at,
        generated_by,
        students!inner(full_name, roll_number, school_id, class_name, section)
      `)
      .eq('school_id', schoolId)
      .ilike('class_name', class_name.trim())
      .ilike('section', section.trim())
      .eq('term', term.trim())
      .ilike('exam_type', exam_type.trim())
      .order('generated_at', { ascending: false });

    if (error) {
      sendDbError(res, error, 'reportCards GET /class');
      return;
    }

    const cards = data ?? [];

    // Get the generator's name if cards exist
    let generatedByName: string | null = null;
    if (cards.length > 0) {
      const firstCard = cards[0] as unknown as { generated_by: string | null };
      if (firstCard.generated_by) {
        const { data: userRow } = await supabaseAdmin
          .from('users')
          .select('name')
          .eq('id', firstCard.generated_by)
          .single();
        generatedByName = (userRow as { name: string } | null)?.name ?? null;
      }
    }

    sendSuccess(res, {
      exists: cards.length > 0,
      count: cards.length,
      generated_at: cards.length > 0 ? (cards[0] as unknown as { generated_at: string }).generated_at : null,
      generated_by_name: generatedByName,
      cards: cards.map((c) => {
        const card = c as unknown as {
          id: string;
          student_id: string;
          grand_total: number;
          grand_max: number;
          percentage: number;
          grade: string;
          generated_at: string;
          students: { full_name: string; roll_number: string | null; school_id: string; class_name: string; section: string };
        };
        return {
          id: card.id,
          student_id: card.student_id,
          student_name: card.students?.full_name ?? 'Unknown',
          roll_number: card.students?.roll_number ?? null,
          grand_total: card.grand_total,
          grand_max: card.grand_max,
          percentage: card.percentage,
          grade: card.grade,
          generated_at: card.generated_at,
        };
      }),
    });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── POST /api/report-cards/notify ────────────────────────────────────────────
router.post(
  '/notify',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    try {
    const parsed = reportCardSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const { class_name, section, term, exam_type } = parsed.data;
    const teacherId = req.user!.id;
    const schoolId  = req.user!.school_id;

    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // ── Class admin gate ──────────────────────────────────────────────────────
    const admin = await isClassAdmin(teacherId, schoolId, class_name, section);
    if (!admin) {
      sendError(res, 'Only the class admin can send report card notifications', 403);
      return;
    }

    // ── Fetch existing stored report cards ────────────────────────────────────
    const { data: cards, error: cardsErr } = await supabaseAdmin
      .from('student_report_cards')
      .select('student_id, percentage, grade')
      .eq('school_id', schoolId)
      .ilike('class_name', class_name.trim())
      .ilike('section', section.trim())
      .eq('term', term.trim())
      .ilike('exam_type', exam_type.trim());

    if (cardsErr) {
      sendDbError(res, cardsErr, 'reportCards POST /notify');
      return;
    }

    if (!cards || cards.length === 0) {
      sendError(res, 'No report cards found for this selection. Generate them first.', 404);
      return;
    }

    const studentIds = (cards as unknown as Array<{ student_id: string; percentage: number; grade: string }>).map((c) => c.student_id);
    const cardByStudent = new Map(
      (cards as unknown as Array<{ student_id: string; percentage: number; grade: string }>).map((c) => [c.student_id, c])
    );

    // ── In-app notifications + collect parent IDs ─────────────────────────────
    const { data: parentRows } = await supabaseAdmin
      .from('students')
      .select('id, full_name, parent_id')
      .in('id', studentIds);

    const parentIds: string[] = [];

    for (const row of (parentRows ?? []) as unknown as Array<{ id: string; full_name: string; parent_id: string | null }>) {
      const card = cardByStudent.get(row.id);
      const pctStr = card ? `${card.percentage.toFixed(1)}% — Grade ${card.grade}` : '';

      // Student notification
      await supabaseAdmin.from('notifications').insert({
        title:        '📄 Report Card Available',
        body:         `Your ${term} ${exam_type.replace('_', ' ')} report card is ready.${pctStr ? ` Overall: ${pctStr}` : ''}`,
        type:         'grade',
        recipient_id: row.id,
        sender_id:    teacherId,
        is_read:      false,
        created_at:   new Date().toISOString(),
      });

      // Parent notification
      if (row.parent_id) {
        parentIds.push(row.parent_id);
        await supabaseAdmin.from('notifications').insert({
          title:        '📄 Report Card Available',
          body:         `${row.full_name}'s ${term} ${exam_type.replace('_', ' ')} report card is ready.`,
          type:         'grade',
          recipient_id: row.parent_id,
          sender_id:    teacherId,
          is_read:      false,
          created_at:   new Date().toISOString(),
        });
      }
    }

    // ── FCM push: students ────────────────────────────────────────────────────
    const studentTokens = await getTokensForStudents(studentIds);
    if (studentTokens.length > 0) {
      await sendPushMulticast(
        studentTokens,
        '📄 Report Card Available',
        `Your ${term} ${exam_type.replace('_', ' ')} report card is ready. Check your marks now!`,
        { type: 'report_card', term, exam_type }
      );
    }

    // ── FCM push: parents ─────────────────────────────────────────────────────
    if (parentIds.length > 0) {
      const parentTokens = await getTokensForUsers(parentIds);
      if (parentTokens.length > 0) {
        await sendPushMulticast(
          parentTokens,
          '📄 Report Card Available',
          `Your child's ${term} ${exam_type.replace('_', ' ')} report card is now available.`,
          { type: 'report_card', term, exam_type }
        );
      }
    }

    sendSuccess(res, { notified: studentIds.length });
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }
  }
);

// ── POST /api/report-cards/generate ──────────────────────────────────────────
router.post(
  '/generate',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    let teacherId = '';
    let schoolId: string | undefined;
    let class_name = '';
    let section = '';
    let term = '';
    let exam_type = '';
    let students: StudentRow[] = [];
    let marksByStudent = new Map<string, MarkRow[]>();
    try {
    const parsed = reportCardSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const parsedData = parsed.data;
    class_name = parsedData.class_name;
    section    = parsedData.section;
    term       = parsedData.term;
    exam_type  = parsedData.exam_type;
    teacherId  = req.user!.id;
    schoolId   = req.user!.school_id ?? undefined;

    if (!schoolId) {
      sendError(res, 'Your account is not linked to a school', 403);
      return;
    }

    // ── Class admin gate ──────────────────────────────────────────────────────
    const admin = await isClassAdmin(teacherId, schoolId, class_name, section);
    if (!admin) {
      sendError(res, 'Only the class admin can generate report cards', 403);
      return;
    }

    // ── Fetch school info ─────────────────────────────────────────────────────
    const { data: schoolData, error: schoolErr } = await supabaseAdmin
      .from('schools')
      .select('name, address, board')
      .eq('id', schoolId)
      .single();

    if (schoolErr || !schoolData) {
      sendDbError(res, schoolErr ?? new Error('School not found'), 'reportCards POST /generate school');
      return;
    }
    const school = schoolData as unknown as SchoolRow;

    // ── Fetch class admin teacher name ────────────────────────────────────────
    const { data: teacherData } = await supabaseAdmin
      .from('users')
      .select('name')
      .eq('id', teacherId)
      .single();

    const classAdminName: string = (teacherData as { name: string } | null)?.name ?? 'Unknown';

    // ── Fetch all students in this class+section ──────────────────────────────
    const { data: studentsData, error: studentsErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, roll_number')
      .eq('school_id', schoolId)
      .ilike('class_name', class_name.trim())
      .ilike('section', section.trim())
      .eq('is_deleted', false)
      .order('full_name');

    if (studentsErr) {
      sendDbError(res, studentsErr, 'reportCards POST /generate students');
      return;
    }

    students = (studentsData ?? []) as unknown as StudentRow[];

    if (students.length === 0) {
      sendError(res, 'No students found for this class and section', 404);
      return;
    }

    // ── Fetch all marks for this class+section+term+exam_type in one query ────
    const studentIds = students.map((s) => s.id);
    const genTermValues = termFilterValues(term.trim());
    const genNormalisedExamType = exam_type.trim().toLowerCase();

    let marksQueryGen = supabaseAdmin
      .from('marks')
      .select('student_id, subject, score, max_score')
      .in('student_id', studentIds)
      .ilike('exam_type', genNormalisedExamType);

    marksQueryGen = genTermValues.length === 1
      ? marksQueryGen.eq('term', genTermValues[0])
      : marksQueryGen.in('term', genTermValues);

    const { data: allMarks, error: marksErr } = await marksQueryGen;

    if (marksErr) {
      sendDbError(res, marksErr, 'reportCards POST /generate marks');
      return;
    }

    // Group marks by student_id
    marksByStudent = new Map<string, MarkRow[]>();
    for (const mark of (allMarks ?? []) as unknown as (MarkRow & { student_id: string })[]) {
      const existing = marksByStudent.get(mark.student_id) ?? [];
      existing.push({ subject: mark.subject, score: mark.score, max_score: mark.max_score });
      marksByStudent.set(mark.student_id, existing);
    }

    // ── Stream a zip back to the client ───────────────────────────────────────
    const safeClass   = class_name.replace(/[^a-zA-Z0-9]/g, '');
    const safeSection = section.replace(/[^a-zA-Z0-9]/g, '');
    const safeTerm    = term.replace(/[^a-zA-Z0-9]/g, '');
    const filename    = `report-cards-${safeClass}${safeSection}-${safeTerm}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    archive.on('error', (err) => {
      console.error('[reportCards] archiver error:', err.message);
      // Can't change headers now — just destroy the stream
      res.destroy();
    });

    const generatedOn = new Date().toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
    const sessionYearStr = sessionYear();

    // ── Generate one PDF per student ─────────────────────────────────────────
    for (const student of students) {
      const marks = marksByStudent.get(student.id) ?? [];

      // Build PDF in memory using a Buffer collector
      const pdfBuffer = await buildStudentPdf({
        school,
        student,
        marks,
        className: class_name,
        section,
        term,
        classAdminName,
        generatedOn,
        sessionYear: sessionYearStr,
      });

      const safeName = student.full_name.replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/ +/g, '_');
      archive.append(pdfBuffer, { name: `${safeName}.pdf` });
    }

    await archive.finalize();
    } catch (err: unknown) {
      return sendError(res, 'An unexpected error occurred', 500);
    }

    // ── Fire-and-forget: store report cards + notify students & parents ───────
    // Capture values for async closure (TS 6 control flow)
    const capturedTerm = term;
    const capturedExamType = exam_type;
    const capturedClassName = class_name;
    const capturedSection = section;
    const capturedSchoolId = schoolId;
    const capturedTeacherId = teacherId;
    const capturedStudents = students;
    const capturedMarksByStudent = marksByStudent;

    setImmediate(() => {
    (async () => {
      try {
        const sessionYearStr2 = sessionYear();
        const senderId = capturedTeacherId;

        for (const student of capturedStudents) {
          const marks = capturedMarksByStudent.get(student.id) ?? [];

          // Build per-subject summary
          let grandTotal = 0;
          let grandMax   = 0;
          const marksJson = marks.map((m) => {
            const pct = m.max_score > 0 ? (m.score / m.max_score) * 100 : 0;
            grandTotal += m.score;
            grandMax   += m.max_score;
            return {
              subject: m.subject,
              score: m.score,
              max_score: m.max_score,
              percentage: parseFloat(pct.toFixed(2)),
            };
          });

          const overallPct = grandMax > 0 ? (grandTotal / grandMax) * 100 : 0;
          const grade      = calcGrade(overallPct);

          // Upsert: one record per student per term+exam_type
          await supabaseAdmin
            .from('student_report_cards')
            .upsert(
              {
                student_id:   student.id,
                school_id:    capturedSchoolId,
                class_name:   capturedClassName,
                section:      capturedSection,
                term:         capturedTerm,
                exam_type:    capturedExamType,
                marks:        marksJson,
                grand_total:  grandTotal,
                grand_max:    grandMax,
                percentage:   parseFloat(overallPct.toFixed(2)),
                grade,
                session_year: sessionYearStr2,
                generated_by: senderId,
                generated_at: new Date().toISOString(),
              },
              { onConflict: 'student_id,term,exam_type' }
            );

          // In-app notification for the student
          await supabaseAdmin.from('notifications').insert({
            title:        '📄 Report Card Available',
            body:         `Your ${capturedTerm} ${capturedExamType.replace('_', ' ')} report card is ready. Overall: ${overallPct.toFixed(1)}% — Grade ${grade}`,
            type:         'grade',
            recipient_id: student.id,
            sender_id:    senderId,
            is_read:      false,
            created_at:   new Date().toISOString(),
          });
        }

        // ── Push notifications: batch all student IDs ──────────────────────
        const allStudentIds = capturedStudents.map((s) => s.id);

        // Get parent IDs for all students
        const { data: parentRows } = await supabaseAdmin
          .from('students')
          .select('id, full_name, parent_id')
          .in('id', allStudentIds);

        const parentIds: string[] = [];
        if (parentRows) {
          for (const row of parentRows as unknown as Array<{ id: string; full_name: string; parent_id: string | null }>) {
            // In-app notification for the parent
            if (row.parent_id) {
              parentIds.push(row.parent_id);
              await supabaseAdmin.from('notifications').insert({
                title:        '📄 Report Card Available',
                body:         `${row.full_name}'s ${capturedTerm} ${capturedExamType.replace('_', ' ')} report card is ready.`,
                type:         'grade',
                recipient_id: row.parent_id,
                sender_id:    senderId,
                is_read:      false,
                created_at:   new Date().toISOString(),
              });
            }
          }
        }

        // FCM push to students
        const studentTokens = await getTokensForStudents(allStudentIds);
        if (studentTokens.length > 0) {
          await sendPushMulticast(
            studentTokens,
            '📄 Report Card Available',
            `Your ${capturedTerm} ${capturedExamType.replace('_', ' ')} report card is ready. Check your marks now!`,
            { type: 'report_card', term: capturedTerm, exam_type: capturedExamType }
          );
        }

        // FCM push to parents
        if (parentIds.length > 0) {
          const parentTokens = await getTokensForUsers(parentIds);
          if (parentTokens.length > 0) {
            await sendPushMulticast(
              parentTokens,
              '📄 Report Card Available',
              `Your child's ${capturedTerm} ${capturedExamType.replace('_', ' ')} report card is now available.`,
              { type: 'report_card', term: capturedTerm, exam_type: capturedExamType }
            );
          }
        }

      } catch (err) {
        console.error('[reportCards] Error storing/notifying report cards:', err);
      }
    })();
  });
  }
);

interface PdfOptions {
  school: SchoolRow;
  student: StudentRow;
  marks: MarkRow[];
  className: string;
  section: string;
  term: string;
  classAdminName: string;
  generatedOn: string;
  sessionYear: string;
}

// ── Board-specific grade helpers ──────────────────────────────────────────────

/** CBSE letter grade + grade point (10-point scale) */
function cbseGrade(pct: number): { letter: string; gp: number } {
  if (pct >= 91) return { letter: 'A1', gp: 10 };
  if (pct >= 81) return { letter: 'A2', gp: 9 };
  if (pct >= 71) return { letter: 'B1', gp: 8 };
  if (pct >= 61) return { letter: 'B2', gp: 7 };
  if (pct >= 51) return { letter: 'C1', gp: 6 };
  if (pct >= 41) return { letter: 'C2', gp: 5 };
  if (pct >= 33) return { letter: 'D',  gp: 4 };
  return { letter: 'E', gp: 0 };
}

/** GSEB letter grade */
function gsebGrade(pct: number): string {
  if (pct >= 80) return 'AA';
  if (pct >= 70) return 'A';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 35) return 'D';
  return 'E';
}

// ── Shared PDF helpers ────────────────────────────────────────────────────────

function drawPageBorder(doc: InstanceType<typeof PDFDocument>): void {
  doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(1.5).stroke('#333333');
  doc.rect(24, 24, doc.page.width - 48, doc.page.height - 48).lineWidth(0.5).stroke('#999999');
}

function drawSchoolHeader(
  doc: InstanceType<typeof PDFDocument>,
  school: SchoolRow,
  boardLabel: string,
  term: string,
  sessionYear: string,
  accentColor: string,
): void {
  const pw = doc.page.width - 100;

  // School name
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#1a1a1a')
    .text(school.name, 50, 45, { align: 'center', width: pw });

  // Address + board badge on same line
  doc.fontSize(9).font('Helvetica').fillColor('#555555')
    .text(school.address, 50, doc.y + 2, { align: 'center', width: pw });

  // Board badge
  const badgeText = boardLabel;
  const badgeW = 52;
  const badgeH = 16;
  const badgeX = doc.page.width / 2 - badgeW / 2;
  const badgeY = doc.y + 4;
  doc.rect(badgeX, badgeY, badgeW, badgeH).fill(accentColor);
  doc.fontSize(8).font('Helvetica-Bold').fillColor('white')
    .text(badgeText, badgeX, badgeY + 3, { width: badgeW, align: 'center' });

  // Horizontal rule
  const ruleY = badgeY + badgeH + 6;
  doc.moveTo(50, ruleY).lineTo(50 + pw, ruleY).lineWidth(2).stroke(accentColor);
  doc.moveTo(50, ruleY + 3).lineTo(50 + pw, ruleY + 3).lineWidth(0.5).stroke('#cccccc');

  // Report card title
  doc.fillColor('#1a1a1a');
  doc.fontSize(12).font('Helvetica-Bold')
    .text(`REPORT CARD  —  ${term.toUpperCase()}  |  SESSION ${sessionYear}`,
      50, ruleY + 10, { align: 'center', width: pw });
}

function drawStudentInfoBox(
  doc: InstanceType<typeof PDFDocument>,
  student: StudentRow,
  className: string,
  section: string,
  accentColor: string,
  extraRight?: string,
): void {
  const pw = doc.page.width - 100;
  const boxY = doc.y + 10;
  const boxH = 52;

  doc.rect(50, boxY, pw, boxH).fill('#F7F9FC').stroke('#D1D5DB');

  doc.fontSize(9).font('Helvetica-Bold').fillColor('#374151');
  const col1 = 60;
  const col2 = 260;
  const col3 = 430;
  const lineY1 = boxY + 10;
  const lineY2 = boxY + 28;

  // Row 1
  doc.text('Name:', col1, lineY1, { continued: true })
    .font('Helvetica').text(`  ${student.full_name}`);
  doc.font('Helvetica-Bold').text('Roll No:', col2, lineY1, { continued: true })
    .font('Helvetica').text(`  ${student.roll_number ?? 'N/A'}`);
  doc.font('Helvetica-Bold').text('Class:', col3, lineY1, { continued: true })
    .font('Helvetica').text(`  ${className}-${section}`);

  // Row 2
  if (extraRight) {
    doc.font('Helvetica-Bold').fillColor(accentColor)
      .text(extraRight, col3, lineY2);
  }
}

// ── CBSE PDF builder ──────────────────────────────────────────────────────────

function buildCbsePdf(opts: PdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { school, student, marks, className, section, term, classAdminName, generatedOn, sessionYear } = opts;
    const ACCENT = '#1A56DB'; // CBSE blue

    const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Report Card — ${student.full_name}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawPageBorder(doc);
    drawSchoolHeader(doc, school, 'CBSE', term, sessionYear, ACCENT);
    drawStudentInfoBox(doc, student, className, section, ACCENT);

    const pw   = doc.page.width - 100;
    let y = doc.y + 16;

    // ── Section title ───────────────────────────────────────────────────────
    doc.fontSize(9).font('Helvetica-Bold').fillColor(ACCENT)
      .text('SCHOLASTIC AREAS', 50, y, { underline: false });
    y += 14;

    // ── Table columns ───────────────────────────────────────────────────────
    const C = { sub: 50, mm: 250, max: 310, pct: 370, grade: 430, gp: 490 };
    const RH = 20;

    // Header row
    doc.rect(50, y, pw, RH).fill(ACCENT);
    doc.fontSize(8).font('Helvetica-Bold').fillColor('white');
    doc.text('Subject',       C.sub + 4,  y + 5, { width: 190 });
    doc.text('Marks Obt.',    C.mm,        y + 5, { width: 55, align: 'center' });
    doc.text('Max Marks',     C.max,       y + 5, { width: 55, align: 'center' });
    doc.text('Percentage',    C.pct,       y + 5, { width: 55, align: 'center' });
    doc.text('Grade',         C.grade,     y + 5, { width: 55, align: 'center' });
    doc.text('Grade Pt.',     C.gp,        y + 5, { width: 55, align: 'center' });
    doc.fillColor('black');

    y += RH;

    let grandTotal = 0;
    let grandMax   = 0;

    marks.forEach((mark, idx) => {
      const pct = mark.max_score > 0 ? (mark.score / mark.max_score) * 100 : 0;
      const { letter, gp } = cbseGrade(pct);
      grandTotal += mark.score;
      grandMax   += mark.max_score;

      if (idx % 2 === 0) doc.rect(50, y, pw, RH).fill('#EBF2FF');
      doc.rect(50, y, pw, RH).stroke('#D1D5DB');

      const passColor = pct >= 33 ? '#111827' : '#DC2626';
      doc.fontSize(9).font('Helvetica').fillColor(passColor);
      doc.text(mark.subject,          C.sub + 4,  y + 5, { width: 190 });
      doc.text(String(mark.score),    C.mm,        y + 5, { width: 55, align: 'center' });
      doc.text(String(mark.max_score),C.max,       y + 5, { width: 55, align: 'center' });
      doc.text(`${pct.toFixed(1)}%`,  C.pct,       y + 5, { width: 55, align: 'center' });

      // Grade badge
      const gradeColor = pct >= 60 ? '#15803D' : pct >= 33 ? '#B45309' : '#DC2626';
      doc.fontSize(9).font('Helvetica-Bold').fillColor(gradeColor)
        .text(letter, C.grade, y + 5, { width: 55, align: 'center' });
      doc.font('Helvetica').fillColor('#374151')
        .text(String(gp),   C.gp, y + 5, { width: 55, align: 'center' });

      y += RH;
    });

    if (marks.length === 0) {
      doc.rect(50, y, pw, RH).fill('#FEF9C3');
      doc.fontSize(9).font('Helvetica').fillColor('#92400E')
        .text('No marks recorded for this term / exam type.', C.sub + 4, y + 5);
      y += RH;
    }

    // ── Grand total row ─────────────────────────────────────────────────────
    const overallPct   = grandMax > 0 ? (grandTotal / grandMax) * 100 : 0;
    const { letter: overallGrade, gp: overallGP } = cbseGrade(overallPct);

    doc.rect(50, y, pw, RH + 2).fill('#DBEAFE').stroke(ACCENT);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1E3A8A');
    doc.text('GRAND TOTAL',          C.sub + 4,  y + 6, { width: 190 });
    doc.text(`${grandTotal}`,         C.mm,        y + 6, { width: 55, align: 'center' });
    doc.text(`${grandMax}`,           C.max,       y + 6, { width: 55, align: 'center' });
    doc.text(`${overallPct.toFixed(1)}%`, C.pct,   y + 6, { width: 55, align: 'center' });
    doc.text(overallGrade,            C.grade,     y + 6, { width: 55, align: 'center' });
    doc.text(String(overallGP),       C.gp,        y + 6, { width: 55, align: 'center' });
    y += RH + 2 + 12;

    // ── Grading scale legend ────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor(ACCENT).text('CBSE GRADING SCALE', 50, y);
    y += 12;

    const scaleData = [
      ['91–100%', 'A1', '10'], ['81–90%', 'A2', '9'], ['71–80%', 'B1', '8'],
      ['61–70%', 'B2', '7'], ['51–60%', 'C1', '6'], ['41–50%', 'C2', '5'],
      ['33–40%', 'D', '4'], ['< 33%', 'E (FAIL)', '0'],
    ];
    const colW = pw / 8;
    scaleData.forEach(([range, grade, gp], i) => {
      const sx = 50 + i * colW;
      const bgColor = i < 2 ? '#D1FAE5' : i < 4 ? '#DBEAFE' : i < 6 ? '#FEF3C7' : i < 7 ? '#FED7AA' : '#FEE2E2';
      doc.rect(sx, y, colW - 1, 30).fill(bgColor).stroke('#E5E7EB');
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#374151')
        .text(grade, sx + 1, y + 3, { width: colW - 3, align: 'center' });
      doc.fontSize(6).font('Helvetica').fillColor('#6B7280')
        .text(`GP: ${gp}`, sx + 1, y + 13, { width: colW - 3, align: 'center' });
      doc.fontSize(6).font('Helvetica').fillColor('#9CA3AF')
        .text(range, sx + 1, y + 21, { width: colW - 3, align: 'center' });
    });
    y += 40;

    // ── Signature zone ──────────────────────────────────────────────────────
    const sigY = Math.max(y + 10, doc.page.height - 120);
    const sigW = 140;

    [
      { x: 50,                      label: "Class Teacher's Signature" },
      { x: doc.page.width / 2 - sigW / 2, label: "Parent's Signature" },
      { x: doc.page.width - 50 - sigW, label: "Principal's Signature" },
    ].forEach(({ x, label }) => {
      doc.moveTo(x, sigY).lineTo(x + sigW, sigY).lineWidth(0.8).stroke('#9CA3AF');
      doc.fontSize(7.5).font('Helvetica').fillColor('#6B7280')
        .text(label, x, sigY + 3, { width: sigW, align: 'center' });
    });

    // ── Footer ──────────────────────────────────────────────────────────────
    doc.fontSize(7.5).font('Helvetica').fillColor('#9CA3AF')
      .text(`Class Admin: ${classAdminName}   |   Generated: ${generatedOn}   |   Eduvo School Management`,
        50, doc.page.height - 40, { align: 'center', width: pw });

    doc.end();
  });
}

// ── GSEB PDF builder ──────────────────────────────────────────────────────────

function buildGsebPdf(opts: PdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { school, student, marks, className, section, term, classAdminName, generatedOn, sessionYear } = opts;
    const ACCENT = '#047857'; // GSEB green

    const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Report Card — ${student.full_name}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawPageBorder(doc);
    drawSchoolHeader(doc, school, 'GSEB', term, sessionYear, ACCENT);

    const pw = doc.page.width - 100;

    // Overall result for the student info box
    let gt = 0; let gm = 0;
    for (const m of marks) { gt += m.score; gm += m.max_score; }
    const overallPct  = gm > 0 ? (gt / gm) * 100 : 0;
    const overallPass = marks.every(m => m.max_score > 0 && (m.score / m.max_score) * 100 >= 35);
    const resultStr   = overallPass ? 'PASS' : 'FAIL';
    drawStudentInfoBox(doc, student, className, section, ACCENT, resultStr);

    let y = doc.y + 16;

    doc.fontSize(9).font('Helvetica-Bold').fillColor(ACCENT).text('SUBJECT-WISE MARKS', 50, y);
    y += 14;

    // GSEB columns: Subject | Written | Practical | Total | Max | % | Grade | Result
    const C = { sub: 50, writ: 215, prac: 270, tot: 325, max: 375, pct: 425, grade: 475, res: 515 };
    const RH = 20;

    doc.rect(50, y, pw, RH).fill(ACCENT);
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('white');
    doc.text('Subject',    C.sub + 3,  y + 5, { width: 158 });
    doc.text('Written',    C.writ,      y + 5, { width: 50, align: 'center' });
    doc.text('Practical',  C.prac,      y + 5, { width: 50, align: 'center' });
    doc.text('Total',      C.tot,       y + 5, { width: 45, align: 'center' });
    doc.text('Max',        C.max,       y + 5, { width: 45, align: 'center' });
    doc.text('%',          C.pct,       y + 5, { width: 40, align: 'center' });
    doc.text('Grade',      C.grade,     y + 5, { width: 40, align: 'center' });
    doc.text('Result',     C.res,       y + 5, { width: 40, align: 'center' });
    doc.fillColor('black');
    y += RH;

    marks.forEach((mark, idx) => {
      const pct   = mark.max_score > 0 ? (mark.score / mark.max_score) * 100 : 0;
      const grade = gsebGrade(pct);
      const pass  = pct >= 35;

      if (idx % 2 === 0) doc.rect(50, y, pw, RH).fill('#ECFDF5');
      doc.rect(50, y, pw, RH).stroke('#D1D5DB');

      const resultColor = pass ? '#065F46' : '#991B1B';
      doc.fontSize(8.5).font('Helvetica').fillColor('#111827');
      doc.text(mark.subject,           C.sub + 3,  y + 5, { width: 158 });
      // Written = full score (GSEB schools usually enter combined), Practical = '-'
      doc.text(String(mark.score),     C.writ,      y + 5, { width: 50, align: 'center' });
      doc.text('—',                    C.prac,      y + 5, { width: 50, align: 'center' });
      doc.text(String(mark.score),     C.tot,       y + 5, { width: 45, align: 'center' });
      doc.text(String(mark.max_score), C.max,       y + 5, { width: 45, align: 'center' });
      doc.text(`${pct.toFixed(1)}%`,   C.pct,       y + 5, { width: 40, align: 'center' });

      const gradeColor = pct >= 70 ? '#065F46' : pct >= 50 ? '#92400E' : '#991B1B';
      doc.font('Helvetica-Bold').fillColor(gradeColor)
        .text(grade, C.grade, y + 5, { width: 40, align: 'center' });
      doc.fillColor(resultColor)
        .text(pass ? 'PASS' : 'FAIL', C.res, y + 5, { width: 40, align: 'center' });

      y += RH;
    });

    if (marks.length === 0) {
      doc.rect(50, y, pw, RH).fill('#FEF9C3');
      doc.fontSize(8.5).font('Helvetica').fillColor('#92400E')
        .text('No marks recorded for this term / exam type.', C.sub + 3, y + 5);
      y += RH;
    }

    // Grand total
    doc.rect(50, y, pw, RH + 2).fill('#D1FAE5').stroke(ACCENT);
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#065F46');
    doc.text('GRAND TOTAL', C.sub + 3, y + 6, { width: 158 });
    doc.text(String(gt),              C.tot,   y + 6, { width: 45, align: 'center' });
    doc.text(String(gm),              C.max,   y + 6, { width: 45, align: 'center' });
    doc.text(`${overallPct.toFixed(1)}%`, C.pct, y + 6, { width: 40, align: 'center' });
    doc.text(gsebGrade(overallPct),   C.grade, y + 6, { width: 40, align: 'center' });
    const rfColor = overallPass ? '#065F46' : '#991B1B';
    doc.fillColor(rfColor).text(resultStr, C.res, y + 6, { width: 40, align: 'center' });
    y += RH + 2 + 12;

    // ── GSEB Grading Scale ──────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor(ACCENT).text('GSEB GRADING SCALE', 50, y);
    y += 12;

    const gsebScale = [
      ['80–100%', 'AA', 'Distinction'], ['70–79%', 'A', 'First Class'],
      ['60–69%', 'B', 'Second Class'], ['50–59%', 'C', 'Pass Class'],
      ['35–49%', 'D', 'Pass'], ['Below 35%', 'E', 'FAIL'],
    ];
    const colW2 = pw / 6;
    gsebScale.forEach(([range, grade, label], i) => {
      const sx = 50 + i * colW2;
      const bg = i === 0 ? '#D1FAE5' : i === 1 ? '#A7F3D0' : i === 2 ? '#DBEAFE' : i === 3 ? '#FEF3C7' : i === 4 ? '#FED7AA' : '#FEE2E2';
      doc.rect(sx, y, colW2 - 1, 34).fill(bg).stroke('#E5E7EB');
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#374151')
        .text(grade, sx + 1, y + 3, { width: colW2 - 3, align: 'center' });
      doc.fontSize(6.5).font('Helvetica').fillColor('#6B7280')
        .text(label, sx + 1, y + 14, { width: colW2 - 3, align: 'center' });
      doc.fontSize(6).font('Helvetica').fillColor('#9CA3AF')
        .text(range, sx + 1, y + 24, { width: colW2 - 3, align: 'center' });
    });
    y += 44;

    // ── Signatures ──────────────────────────────────────────────────────────
    const sigY = Math.max(y + 10, doc.page.height - 120);
    const sigW = 140;
    [
      { x: 50,                           label: "Class Teacher's Signature" },
      { x: doc.page.width / 2 - sigW/2,  label: "Parent's / Guardian's Signature" },
      { x: doc.page.width - 50 - sigW,   label: "Principal's Signature" },
    ].forEach(({ x, label }) => {
      doc.moveTo(x, sigY).lineTo(x + sigW, sigY).lineWidth(0.8).stroke('#9CA3AF');
      doc.fontSize(7.5).font('Helvetica').fillColor('#6B7280')
        .text(label, x, sigY + 3, { width: sigW, align: 'center' });
    });

    doc.fontSize(7.5).font('Helvetica').fillColor('#9CA3AF')
      .text(`Class Admin: ${classAdminName}   |   Generated: ${generatedOn}   |   Eduvo School Management`,
        50, doc.page.height - 40, { align: 'center', width: pw });

    doc.end();
  });
}

// ── Generic / fallback PDF builder ───────────────────────────────────────────

function buildGenericPdf(opts: PdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { school, student, marks, className, section, term, classAdminName, generatedOn, sessionYear } = opts;
    const ACCENT = '#4F46E5';

    const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Report Card — ${student.full_name}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const boardLabel = (school.board ?? 'SCHOOL').toUpperCase();
    drawPageBorder(doc);
    drawSchoolHeader(doc, school, boardLabel, term, sessionYear, ACCENT);
    drawStudentInfoBox(doc, student, className, section, ACCENT);

    const pw  = doc.page.width - 100;
    let y = doc.y + 16;

    doc.fontSize(9).font('Helvetica-Bold').fillColor(ACCENT).text('SUBJECT-WISE MARKS', 50, y);
    y += 14;

    const C   = { sub: 50, score: 280, max: 360, pct: 430, grade: 490 };
    const RH  = 20;

    doc.rect(50, y, pw, RH).fill(ACCENT);
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('white');
    doc.text('Subject',     C.sub + 4, y + 5, { width: 224 });
    doc.text('Score',       C.score,   y + 5, { width: 74, align: 'center' });
    doc.text('Max',         C.max,     y + 5, { width: 64, align: 'center' });
    doc.text('Percentage',  C.pct,     y + 5, { width: 54, align: 'center' });
    doc.text('Grade',       C.grade,   y + 5, { width: 54, align: 'center' });
    doc.fillColor('black');
    y += RH;

    let grandTotal = 0; let grandMax = 0;

    marks.forEach((mark, idx) => {
      const pct = mark.max_score > 0 ? (mark.score / mark.max_score) * 100 : 0;
      const grade = calcGrade(pct);
      grandTotal += mark.score; grandMax += mark.max_score;

      if (idx % 2 === 0) doc.rect(50, y, pw, RH).fill('#F5F3FF');
      doc.rect(50, y, pw, RH).stroke('#E5E7EB');

      const tc = pct >= 33 ? '#111827' : '#DC2626';
      doc.fontSize(9).font('Helvetica').fillColor(tc);
      doc.text(mark.subject,           C.sub + 4, y + 5, { width: 224 });
      doc.text(String(mark.score),     C.score,   y + 5, { width: 74, align: 'center' });
      doc.text(String(mark.max_score), C.max,     y + 5, { width: 64, align: 'center' });
      doc.text(`${pct.toFixed(1)}%`,   C.pct,     y + 5, { width: 54, align: 'center' });

      const gc = pct >= 60 ? '#15803D' : pct >= 33 ? '#B45309' : '#DC2626';
      doc.font('Helvetica-Bold').fillColor(gc)
        .text(grade, C.grade, y + 5, { width: 54, align: 'center' });
      y += RH;
    });

    if (marks.length === 0) {
      doc.rect(50, y, pw, RH).fill('#FEF9C3');
      doc.fontSize(9).font('Helvetica').fillColor('#92400E')
        .text('No marks recorded for this term / exam type.', C.sub + 4, y + 5);
      y += RH;
    }

    const op = grandMax > 0 ? (grandTotal / grandMax) * 100 : 0;
    doc.rect(50, y, pw, RH + 2).fill('#EDE9FE').stroke(ACCENT);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#3730A3');
    doc.text('GRAND TOTAL',          C.sub + 4, y + 6, { width: 224 });
    doc.text(String(grandTotal),     C.score,   y + 6, { width: 74, align: 'center' });
    doc.text(String(grandMax),       C.max,     y + 6, { width: 64, align: 'center' });
    doc.text(`${op.toFixed(1)}%`,    C.pct,     y + 6, { width: 54, align: 'center' });
    doc.text(calcGrade(op),          C.grade,   y + 6, { width: 54, align: 'center' });
    y += RH + 2 + 20;

    const sigY = Math.max(y + 10, doc.page.height - 120);
    const sigW = 140;
    [
      { x: 50,                           label: "Class Teacher's Signature" },
      { x: doc.page.width / 2 - sigW/2,  label: "Parent's Signature" },
      { x: doc.page.width - 50 - sigW,   label: "Principal's Signature" },
    ].forEach(({ x, label }) => {
      doc.moveTo(x, sigY).lineTo(x + sigW, sigY).lineWidth(0.8).stroke('#9CA3AF');
      doc.fontSize(7.5).font('Helvetica').fillColor('#6B7280')
        .text(label, x, sigY + 3, { width: sigW, align: 'center' });
    });

    doc.fontSize(7.5).font('Helvetica').fillColor('#9CA3AF')
      .text(`Class Admin: ${classAdminName}   |   Generated: ${generatedOn}   |   Eduvo School Management`,
        50, doc.page.height - 40, { align: 'center', width: pw });

    doc.end();
  });
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function buildStudentPdf(opts: PdfOptions): Promise<Buffer> {
  const board = (opts.school.board ?? '').toUpperCase();
  if (board === 'CBSE' || board === 'ICSE') return buildCbsePdf(opts);
  if (board === 'GSEB') return buildGsebPdf(opts);
  return buildGenericPdf(opts);
}

export default router;
