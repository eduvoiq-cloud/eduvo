import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

router.use(authenticate);
router.use(requireRole('superadmin', 'schooladmin', 'teacher'));

// ── GET /api/marks-view/class?class_name=&section=&term=&exam_type=
// Returns all marks for every student in a class, joined with student info.
// Supports optional term and exam_type filters.
router.get('/class', async (req: Request, res: Response) => {
  const { class_name, section, term, exam_type } = req.query as Record<string, string>;

  if (!class_name) {
    sendError(res, 'class_name is required', 400);
    return;
  }

  // For teachers: verify they are assigned to this class
  if (req.user!.role === 'teacher') {
    let assignQuery = supabaseAdmin
      .from('teacher_assignments')
      .select('id')
      .eq('teacher_id', req.user!.id)
      .eq('school_id', req.user!.school_id ?? '')
      .eq('class_name', class_name);

    if (section) assignQuery = assignQuery.eq('section', section);

    const { data: assignment } = await assignQuery.limit(1);
    if (!assignment || assignment.length === 0) {
      // Fallback: try legacy `class` column
      let fallbackQuery = supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', req.user!.id)
        .eq('school_id', req.user!.school_id ?? '')
        .eq('class', class_name);
      if (section) fallbackQuery = fallbackQuery.eq('section', section);
      const { data: fallback } = await fallbackQuery.limit(1);
      if (!fallback || fallback.length === 0) {
        sendError(res, 'You are not assigned to this class', 403);
        return;
      }
    }
  }

  // Fetch students in this class belonging to the user's school
  let studentQuery = supabaseAdmin
    .from('students')
    .select('id, full_name, roll_number, class_name, section')
    .eq('school_id', req.user!.school_id ?? '')
    .eq('class_name', class_name)
    .neq('is_deleted', true)
    .order('roll_number', { ascending: true });

  if (section) studentQuery = studentQuery.eq('section', section);

  const { data: students, error: studentsError } = await studentQuery;

  if (studentsError) {
    sendError(res, studentsError.message, 500);
    return;
  }

  if (!students || students.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const studentIds = students.map((s: { id: string }) => s.id);

  // Fetch marks for all students in one query (no N+1)
  let marksQuery = supabaseAdmin
    .from('marks')
    .select('id, student_id, subject, score, max_score, term, exam_type, notes, created_at')
    .in('student_id', studentIds)
    .order('created_at', { ascending: false });

  if (term) marksQuery = marksQuery.eq('term', term);
  if (exam_type) marksQuery = marksQuery.eq('exam_type', exam_type);

  const { data: marks, error: marksError } = await marksQuery;

  if (marksError) {
    sendError(res, marksError.message, 500);
    return;
  }

  // Build a map: student_id -> marks[]
  const marksByStudent: Record<string, typeof marks> = {};
  for (const m of marks ?? []) {
    const sid = (m as { student_id: string }).student_id;
    if (!marksByStudent[sid]) marksByStudent[sid] = [];
    marksByStudent[sid].push(m);
  }

  // Combine students with their marks
  const result = (students as Array<{
    id: string;
    full_name: string;
    roll_number: string | null;
    class_name: string;
    section: string | null;
  }>).map((s) => {
    const studentMarks = marksByStudent[s.id] ?? [];
    const totalObtained = studentMarks.reduce(
      (sum: number, m: { score: number }) => sum + Number(m.score), 0
    );
    const totalMax = studentMarks.reduce(
      (sum: number, m: { max_score: number }) => sum + Number(m.max_score), 0
    );
    const percentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 100) : null;
    return {
      student_id: s.id,
      full_name: s.full_name,
      roll_number: s.roll_number,
      class_name: s.class_name,
      section: s.section,
      marks: studentMarks,
      total_obtained: totalObtained,
      total_max: totalMax,
      percentage,
    };
  });

  sendSuccess(res, result);
});

// ── GET /api/marks-view/student/:id
// Returns all marks for a single student along with student profile info.
router.get('/student/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { term, exam_type } = req.query as Record<string, string>;

  // Fetch student — scoped to the user's school
  const { data: student, error: studentError } = await supabaseAdmin
    .from('students')
    .select('id, full_name, roll_number, class_name, section, school_id')
    .eq('id', id)
    .neq('is_deleted', true)
    .single();

  if (studentError || !student) {
    sendError(res, 'Student not found', 404);
    return;
  }

  if (student.school_id !== req.user!.school_id) {
    sendError(res, 'Access denied', 403);
    return;
  }

  // For teachers: verify they are assigned to the student's class
  if (req.user!.role === 'teacher') {
    let assignQuery = supabaseAdmin
      .from('teacher_assignments')
      .select('id')
      .eq('teacher_id', req.user!.id)
      .eq('school_id', req.user!.school_id ?? '')
      .eq('class_name', student.class_name)
      .eq('section', student.section ?? '');

    const { data: assignment } = await assignQuery.limit(1);

    if (!assignment || assignment.length === 0) {
      // Fallback: legacy `class` column
      const { data: fallback } = await supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', req.user!.id)
        .eq('school_id', req.user!.school_id ?? '')
        .eq('class', student.class_name)
        .eq('section', student.section ?? '')
        .limit(1);

      if (!fallback || fallback.length === 0) {
        sendError(res, 'You are not assigned to this student\'s class', 403);
        return;
      }
    }
  }

  // Fetch marks
  let marksQuery = supabaseAdmin
    .from('marks')
    .select('id, subject, score, max_score, term, exam_type, notes, created_at')
    .eq('student_id', id)
    .order('subject', { ascending: true });

  if (term) marksQuery = marksQuery.eq('term', term);
  if (exam_type) marksQuery = marksQuery.eq('exam_type', exam_type);

  const { data: marks, error: marksError } = await marksQuery;

  if (marksError) {
    sendError(res, marksError.message, 500);
    return;
  }

  const studentMarks = marks ?? [];
  const totalObtained = studentMarks.reduce(
    (sum: number, m: { score: number }) => sum + Number(m.score), 0
  );
  const totalMax = studentMarks.reduce(
    (sum: number, m: { max_score: number }) => sum + Number(m.max_score), 0
  );
  const percentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 100) : null;

  sendSuccess(res, {
    student: {
      id: student.id,
      full_name: student.full_name,
      roll_number: student.roll_number,
      class_name: student.class_name,
      section: student.section,
    },
    marks: studentMarks,
    total_obtained: totalObtained,
    total_max: totalMax,
    percentage,
  });
});

export default router;
