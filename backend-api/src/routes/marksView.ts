import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';
import { termFilterValues } from '../utils/term';

const router = Router();

router.use(authenticate);
router.use(requireRole('superadmin', 'schooladmin', 'teacher'));

// ── GET /api/marks-view/classes
// Returns distinct class_name + section combinations for the school.
// Used to populate dropdowns in the admin marks page.
router.get('/classes', async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('students')
    .select('class_name, section')
    .eq('school_id', req.user!.school_id ?? '')
    .eq('is_deleted', false)
    .order('class_name')
    .order('section');

  if (error) { sendError(res, error.message, 500); return; }

  // Deduplicate
  const seen = new Set<string>();
  const classes = (data ?? []).reduce(
    (acc: { class_name: string; section: string }[], row: { class_name: string; section: string }) => {
      const key = `${row.class_name}||${row.section ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        acc.push({ class_name: row.class_name, section: row.section ?? '' });
      }
      return acc;
    },
    []
  );

  sendSuccess(res, classes);
});

// ── GET /api/marks-view/class?class_name=&section=&term=&exam_type=
// Returns all marks for every student in a class, joined with student info.
// Supports optional term and exam_type filters.
router.get('/class', async (req: Request, res: Response) => {
  const { class_name, section, term, exam_type, subject } = req.query as Record<string, string>;

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
      .ilike('class_name', class_name);

    if (section) assignQuery = assignQuery.ilike('section', section);

    const { data: assignment } = await assignQuery.limit(1);
    if (!assignment || assignment.length === 0) {
      // Fallback: try legacy `class` column
      let fallbackQuery = supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', req.user!.id)
        .eq('school_id', req.user!.school_id ?? '')
        .ilike('class', class_name);
      if (section) fallbackQuery = fallbackQuery.ilike('section', section);
      const { data: fallback } = await fallbackQuery.limit(1);
      if (!fallback || fallback.length === 0) {
        sendError(res, 'You are not assigned to this class', 403);
        return;
      }
    }
  }

  // Fetch students in this class belonging to the user's school
  // Use ilike for case-insensitive matching so "10 A" == "10 a", "Grade 5" == "grade 5"
  let studentQuery = supabaseAdmin
    .from('students')
    .select('id, full_name, roll_number, class_name, section')
    .eq('school_id', req.user!.school_id ?? '')
    .ilike('class_name', class_name)
    .neq('is_deleted', true)
    .order('roll_number', { ascending: true });

  if (section) studentQuery = studentQuery.ilike('section', section);

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

  if (term) {
    const termValues = termFilterValues(term);
    marksQuery = termValues.length === 1
      ? marksQuery.eq('term', termValues[0])
      : marksQuery.in('term', termValues);
  }
  if (exam_type) marksQuery = marksQuery.eq('exam_type', exam_type);
  if (subject) marksQuery = marksQuery.ilike('subject', subject);

  const { data: marks, error: marksError } = await marksQuery;

  if (marksError) {
    sendError(res, marksError.message, 500);
    return;
  }

  // Fetch submitted test attempts for all students.
  // When term or exam_type filters are active, join with the tests table so
  // the submission count reflects only tests matching those filters.
  let attemptsQuery = supabaseAdmin
    .from('test_attempts')
    .select('student_id, test_id, mcq_score, total_score, is_submitted, tests!test_attempts_test_id_fkey(term, exam_type, subject)')
    .in('student_id', studentIds)
    .eq('is_submitted', true);

  const { data: rawAttempts } = await attemptsQuery;

  type AttemptWithTest = {
    student_id: string;
    tests: { term: string | null; exam_type: string | null; subject: string | null } | null;
  };

  // supabase-js returns the FK join as an object (not array) when using the fkey hint
  const typedAttempts = (rawAttempts ?? []) as unknown as AttemptWithTest[];

  // Filter attempts by term/exam_type/subject if filters are active
  const termValues = term ? termFilterValues(term) : null;
  const filteredAttempts = typedAttempts.filter((a) => {
    // supabase-js may return tests as object or array depending on join cardinality
    const testData = Array.isArray(a.tests) ? (a.tests as Array<{ term: string | null; exam_type: string | null; subject: string | null }>)[0] ?? null : a.tests;
    const testTerm = testData?.term ?? null;
    const testExamType = testData?.exam_type ?? null;
    const testSubject = testData?.subject ?? null;
    if (termValues && testTerm && !termValues.includes(testTerm)) return false;
    if (exam_type && testExamType !== exam_type) return false;
    if (subject && testSubject && testSubject.toLowerCase() !== subject.toLowerCase()) return false;
    return true;
  });

  // Build attempt count map: student_id -> number of submitted attempts (respecting filters)
  const attemptCountByStudent: Record<string, number> = {};
  for (const a of (filteredAttempts as Array<{ student_id: string }>) ?? []) {
    attemptCountByStudent[a.student_id] = (attemptCountByStudent[a.student_id] ?? 0) + 1;
  }

  // Build a map: student_id -> marks[]
  const marksByStudent: Record<string, typeof marks> = {};
  for (const m of marks ?? []) {
    const sid = (m as { student_id: string }).student_id;
    if (!marksByStudent[sid]) marksByStudent[sid] = [];
    marksByStudent[sid].push(m);
  }

  // Combine students with their marks.
  // marks (manual entries) and test_submissions (MCQ attempt count) are
  // independent — both are always shown as-is. Neither gates the other.
  const result = (students as Array<{
    id: string;
    full_name: string;
    roll_number: string | null;
    class_name: string;
    section: string | null;
  }>).map((s) => {
    const studentMarks = marksByStudent[s.id] ?? [];
    const submissionCount = attemptCountByStudent[s.id] ?? 0;

    const totalObtained = studentMarks.reduce(
      (sum: number, m: { score: number }) => sum + Number(m.score), 0
    );
    const totalMax = studentMarks.reduce(
      (sum: number, m: { max_score: number }) => sum + Number(m.max_score), 0
    );
    const percentage = totalMax > 0
      ? Math.round((totalObtained / totalMax) * 100)
      : null;

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
      test_submissions: submissionCount,
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
    const cn  = (student.class_name ?? '').trim();
    const sec = (student.section ?? '').trim();

    // Use ilike (case-insensitive) to match — consistent with the /class route
    let assignQuery = supabaseAdmin
      .from('teacher_assignments')
      .select('id')
      .eq('teacher_id', req.user!.id)
      .eq('school_id', req.user!.school_id ?? '')
      .ilike('class_name', cn);

    if (sec) assignQuery = assignQuery.ilike('section', sec);

    const { data: assignment } = await assignQuery.limit(1);

    if (!assignment || assignment.length === 0) {
      // Fallback: legacy `class` column
      let fallbackQuery = supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', req.user!.id)
        .eq('school_id', req.user!.school_id ?? '')
        .ilike('class', cn);

      if (sec) fallbackQuery = fallbackQuery.ilike('section', sec);

      const { data: fallback } = await fallbackQuery.limit(1);

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

  if (term) {
    const termValues = termFilterValues(term);
    marksQuery = termValues.length === 1
      ? marksQuery.eq('term', termValues[0])
      : marksQuery.in('term', termValues);
  }
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

  // Fetch submitted test attempts for this student
  const { data: testAttempts } = await supabaseAdmin
    .from('test_attempts')
    .select(`
      id, test_id, mcq_score, total_score, is_submitted, submitted_at,
      tests!test_attempts_test_id_fkey(title, subject, class, section, term, date)
    `)
    .eq('student_id', id)
    .eq('is_submitted', true)
    .order('submitted_at', { ascending: false });

  const attemptIds = (testAttempts ?? []).map((a: Record<string, unknown>) => a.id as string);

  // Determine which attempts have ungraded theory answers — used for theory_pending flag
  const theoryPendingSet = new Set<string>();
  if (attemptIds.length > 0) {
    const { data: ungraded } = await supabaseAdmin
      .from('student_answers')
      .select('attempt_id')
      .in('attempt_id', attemptIds)
      .not('theory_answer', 'is', null)
      .is('marks_awarded', null);
    for (const row of (ungraded ?? [])) {
      theoryPendingSet.add((row as { attempt_id: string }).attempt_id);
    }
  }

  const formattedAttempts = (testAttempts ?? []).map((a: Record<string, unknown>) => {
    const test = a.tests as Record<string, unknown> | null;
    return {
      attempt_id: a.id as string,
      test_id: a.test_id as string,
      test_title: test?.title as string ?? null,
      subject: test?.subject as string ?? null,
      term: test?.term as string ?? null,
      date: test?.date as string ?? null,
      mcq_score: a.mcq_score as number | null,
      total_score: a.total_score as number | null,
      submitted_at: a.submitted_at as string | null,
      theory_pending: theoryPendingSet.has(a.id as string),
    };
  });

  // Fetch integrity logs for all submitted attempts of this student
  const attemptIdsForIntegrity = attemptIds;
  type IntegrityRow = {
    daily_test_attempt_id: string;
    integrity_score: number | null;
    exit_count: number;
    total_exit_duration_seconds: number;
    is_suspicious: boolean;
    suspicious_reasons: string[] | null;
  };
  const integrityByAttemptId = new Map<string, IntegrityRow>();
  if (attemptIdsForIntegrity.length > 0) {
    const { data: integrityRows } = await supabaseAdmin
      .from('test_integrity_logs')
      .select('daily_test_attempt_id, integrity_score, exit_count, total_exit_duration_seconds, is_suspicious, suspicious_reasons')
      .eq('student_id', id)
      .in('daily_test_attempt_id', attemptIdsForIntegrity);
    for (const row of ((integrityRows ?? []) as IntegrityRow[])) {
      integrityByAttemptId.set(row.daily_test_attempt_id, row);
    }
  }

  const enrichedAttempts = formattedAttempts.map((a) => {
    const integrity = integrityByAttemptId.get(a.attempt_id);
    return {
      ...a,
      integrity_score: integrity?.integrity_score ?? null,
      exit_count: integrity?.exit_count ?? null,
      total_exit_duration_seconds: integrity?.total_exit_duration_seconds ?? null,
      is_suspicious: integrity?.is_suspicious ?? null,
      suspicious_reasons: integrity?.suspicious_reasons ?? null,
    };
  });

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
    test_submissions: enrichedAttempts,
    test_submissions_count: enrichedAttempts.length,
  });
});

export default router;
