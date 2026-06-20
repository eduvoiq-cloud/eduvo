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
  const studentId = req.tokenType === 'student' ? req.student!.id : null;

  if (!studentId) {
    sendError(res, 'Only students can access this endpoint', 403);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('student_report_cards')
    .select('*')
    .eq('student_id', studentId)
    .order('generated_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
});

// ── GET /api/report-cards/student/:studentId ──────────────────────────────────
// Parent-facing: returns report cards for a specific student.
// The parent must have the student linked (parent_id on students table).
router.get('/student/:studentId', authenticateAny, async (req: Request, res: Response) => {
  const { studentId } = req.params;

  // Require a user token (parent)
  if (req.tokenType !== 'user') {
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

  const { data, error } = await supabaseAdmin
    .from('student_report_cards')
    .select('*')
    .eq('student_id', studentId)
    .order('generated_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, data ?? []);
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
}

// ── GET /api/report-cards/readiness ──────────────────────────────────────────

router.get(
  '/readiness',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
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
  }
);

// ── POST /api/report-cards/generate ──────────────────────────────────────────

router.post(
  '/generate',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
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
      sendError(res, 'Only the class admin can generate report cards', 403);
      return;
    }

    // ── Fetch school info ─────────────────────────────────────────────────────
    const { data: schoolData, error: schoolErr } = await supabaseAdmin
      .from('schools')
      .select('name, address')
      .eq('id', schoolId)
      .single();

    if (schoolErr || !schoolData) {
      sendDbError(res, schoolErr ?? new Error('School not found'), 'reportCards POST /generate school');
      return;
    }
    const school = schoolData as SchoolRow;

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

    const students = (studentsData ?? []) as StudentRow[];

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
    const marksByStudent = new Map<string, MarkRow[]>();
    for (const mark of (allMarks ?? []) as (MarkRow & { student_id: string })[]) {
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

  // ── Fire-and-forget: store report cards + notify students & parents ─────────
  setImmediate(() => {
    (async () => {
      try {
        const sessionYearStr2 = sessionYear();
        const senderId = teacherId;

        for (const student of students) {
          const marks = marksByStudent.get(student.id) ?? [];

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
                school_id:    schoolId,
                class_name,
                section,
                term,
                exam_type,
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
            message:      `Your ${term} ${exam_type.replace('_', ' ')} report card is ready. Overall: ${overallPct.toFixed(1)}% — Grade ${grade}`,
            type:         'grade',
            recipient_id: student.id,
            sender_id:    senderId,
            is_read:      false,
            created_at:   new Date().toISOString(),
          });
        }

        // ── Push notifications: batch all student IDs ──────────────────────
        const allStudentIds = students.map((s) => s.id);

        // Get parent IDs for all students
        const { data: parentRows } = await supabaseAdmin
          .from('students')
          .select('id, full_name, parent_id')
          .in('id', allStudentIds);

        const parentIds: string[] = [];
        if (parentRows) {
          for (const row of parentRows as Array<{ id: string; full_name: string; parent_id: string | null }>) {
            // In-app notification for the parent
            if (row.parent_id) {
              parentIds.push(row.parent_id);
              await supabaseAdmin.from('notifications').insert({
                title:        '📄 Report Card Available',
                message:      `${row.full_name}'s ${term} ${exam_type.replace('_', ' ')} report card is ready.`,
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
            `Your ${term} ${exam_type.replace('_', ' ')} report card is ready. Check your marks now!`,
            { type: 'report_card', term, exam_type }
          );
        }

        // FCM push to parents
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

        console.log(`[reportCards] Stored ${students.length} report cards and sent notifications.`);
      } catch (err) {
        console.error('[reportCards] Error storing/notifying report cards:', err);
      }
    })();
  });
  }
);

// ── PDF builder ───────────────────────────────────────────────────────────────

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

function buildStudentPdf(opts: PdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const {
      school,
      student,
      marks,
      className,
      section,
      term,
      classAdminName,
      generatedOn,
      sessionYear,
    } = opts;

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 100; // account for margins

    // ── Header ─────────────────────────────────────────────────────────────
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(school.name, { align: 'center' });

    doc
      .fontSize(10)
      .font('Helvetica')
      .text(school.address, { align: 'center' });

    doc.moveDown(0.5);

    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .text(`Student Marks Card — ${term}  |  ${sessionYear}`, { align: 'center' });

    doc
      .moveTo(50, doc.y + 4)
      .lineTo(50 + pageWidth, doc.y + 4)
      .stroke();

    doc.moveDown(1);

    // ── Student info ────────────────────────────────────────────────────────
    doc.fontSize(11).font('Helvetica-Bold');

    const infoY = doc.y;
    doc.text(`Name: `, { continued: true }).font('Helvetica').text(student.full_name);
    doc.font('Helvetica-Bold').text(`Roll No: `, { continued: true }).font('Helvetica').text(student.roll_number ?? 'N/A');
    doc.font('Helvetica-Bold').text(`Class: `, { continued: true }).font('Helvetica').text(`${className}-${section}`);

    doc.moveDown(1);

    // ── Marks table header ──────────────────────────────────────────────────
    const colSubject = 50;
    const colScore   = 300;
    const colMax     = 380;
    const colPct     = 460;
    const rowHeight  = 22;

    doc.fontSize(11).font('Helvetica-Bold');
    const tableHeaderY = doc.y;

    // Header background
    doc.rect(50, tableHeaderY, pageWidth, rowHeight).fill('#4A90D9');

    doc
      .fillColor('white')
      .text('Subject',    colSubject, tableHeaderY + 5, { width: 220 })
      .text('Score',      colScore,   tableHeaderY + 5, { width: 70 })
      .text('Max Score',  colMax,     tableHeaderY + 5, { width: 70 })
      .text('Percentage', colPct,     tableHeaderY + 5, { width: 90 });

    doc.fillColor('black');

    let currentY = tableHeaderY + rowHeight;
    let grandTotal = 0;
    let grandMax   = 0;

    doc.font('Helvetica').fontSize(10);

    marks.forEach((mark, idx) => {
      const pct = mark.max_score > 0 ? (mark.score / mark.max_score) * 100 : 0;

      // Alternating row background
      if (idx % 2 === 0) {
        doc.rect(50, currentY, pageWidth, rowHeight).fill('#F0F4FF');
        doc.fillColor('black');
      }

      doc
        .fillColor('black')
        .text(mark.subject, colSubject, currentY + 5, { width: 220 })
        .text(String(mark.score), colScore, currentY + 5, { width: 70 })
        .text(String(mark.max_score), colMax, currentY + 5, { width: 70 })
        .text(`${pct.toFixed(1)}%`, colPct, currentY + 5, { width: 90 });

      grandTotal += mark.score;
      grandMax   += mark.max_score;
      currentY   += rowHeight;
    });

    if (marks.length === 0) {
      doc
        .fillColor('#888888')
        .text('No marks recorded for this term / exam type.', colSubject, currentY + 5);
      currentY += rowHeight;
      doc.fillColor('black');
    }

    // ── Table bottom border ─────────────────────────────────────────────────
    doc
      .moveTo(50, currentY)
      .lineTo(50 + pageWidth, currentY)
      .stroke();

    doc.moveDown(1);

    // ── Totals & grade ──────────────────────────────────────────────────────
    const overallPct  = grandMax > 0 ? (grandTotal / grandMax) * 100 : 0;
    const grade       = calcGrade(overallPct);

    doc.font('Helvetica-Bold').fontSize(11);

    doc.text(`Grand Total: ${grandTotal} / ${grandMax}`);
    doc.text(`Overall Percentage: ${overallPct.toFixed(2)}%`);
    doc.text(`Grade: ${grade}`);

    doc.moveDown(1);

    // ── Footer ──────────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(10).fillColor('#555555');
    doc.text(`Class Admin: ${classAdminName}`);
    doc.text(`Generated on: ${generatedOn}`);

    doc.end();
  });
}

export default router;
