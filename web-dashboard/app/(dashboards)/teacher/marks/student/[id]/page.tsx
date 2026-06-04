'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { marksViewApi, testsApi, type StudentMarksDetail, type TestSubmissionRecord, type TestAttemptDetail, type TestAnswerDetail } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';

const EXAM_TYPE_LABELS: Record<string, string> = {
  unit_test: 'Unit Test',
  mid_term: 'Mid Term',
  final: 'Final',
  class_test: 'Class Test',
  quiz: 'Quiz',
  midterm: 'Midterm',
  assignment: 'Assignment',
  project: 'Project',
};

const TERM_LABELS: Record<string, string> = {
  term_1: 'Term 1',
  term_2: 'Term 2',
  term_3: 'Term 3',
};

function pct(score: number, max: number): number {
  if (max === 0) return 0;
  return Math.round((score / max) * 100);
}

function GradeBadge({ percentage }: { percentage: number }) {
  const color =
    percentage >= 75 ? 'bg-green-100 text-green-700' :
    percentage >= 50 ? 'bg-yellow-100 text-yellow-700' :
    'bg-red-100 text-red-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>
      {percentage}%
    </span>
  );
}

export default function TeacherStudentMarksPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<StudentMarksDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Theory marking modal
  const [viewAttempt, setViewAttempt] = useState<TestAttemptDetail | null>(null);
  const [attemptLoading, setAttemptLoading] = useState(false);
  const [theoryMarks, setTheoryMarks] = useState<Record<string, string>>({});
  const [markingSubmitting, setMarkingSubmitting] = useState(false);
  const [markingError, setMarkingError] = useState('');
  const [markingSuccess, setMarkingSuccess] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token || !params?.id) return;
    marksViewApi.getStudent(token, params.id)
      .then((res) => setDetail(res.data))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load marks'))
      .finally(() => setLoading(false));
  }, [params?.id]);

  async function openAttemptDetail(attemptId: string) {
    setAttemptLoading(true);
    setMarkingError('');
    setMarkingSuccess(false);
    setViewAttempt(null);
    try {
      const token = getToken();
      if (!token) return;
      const res = await testsApi.getAttemptDetail(token, attemptId);
      setViewAttempt(res.data);
      const prefilled: Record<string, string> = {};
      for (const ans of res.data.answers) {
        if (ans.question_type === 'theory' && ans.marks_awarded !== null) {
          prefilled[ans.question_id] = String(ans.marks_awarded);
        }
      }
      setTheoryMarks(prefilled);
    } catch (e: unknown) {
      setMarkingError(e instanceof Error ? e.message : 'Failed to load attempt');
    } finally {
      setAttemptLoading(false);
    }
  }

  async function submitTheoryMarks() {
    if (!viewAttempt) return;
    setMarkingError('');
    setMarkingSuccess(false);
    const token = getToken();
    if (!token) return;

    const theoryQuestions = viewAttempt.answers.filter((a) => a.question_type === 'theory');
    for (const q of theoryQuestions) {
      const val = theoryMarks[q.question_id];
      if (val === undefined || val === '') {
        setMarkingError(`Enter marks for all theory questions.`);
        return;
      }
      const n = parseFloat(val);
      if (isNaN(n) || n < 0 || n > q.marks) {
        setMarkingError(`Marks for Q must be between 0 and ${q.marks}.`);
        return;
      }
    }

    setMarkingSubmitting(true);
    try {
      const payload = theoryQuestions.map((q) => ({
        question_id: q.question_id,
        marks_awarded: parseFloat(theoryMarks[q.question_id]),
      }));
      await testsApi.markTheory(token, { attempt_id: viewAttempt.attempt_id, theory_marks: payload });
      // Refresh the attempt to show updated scores
      await openAttemptDetail(viewAttempt.attempt_id);
      setMarkingSuccess(true);
      // Refresh the student detail page data so the table updates
      marksViewApi.getStudent(token, params.id)
        .then((res) => setDetail(res.data))
        .catch(() => {});
    } catch (e: unknown) {
      setMarkingError(e instanceof Error ? e.message : 'Failed to save marks');
    } finally {
      setMarkingSubmitting(false);
    }
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="max-w-2xl">
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error || 'Student not found.'}
        </div>
        <Link href="/teacher/marks/view" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
          ← Back to Class Marks
        </Link>
      </div>
    );
  }

  const { student, marks, total_obtained, total_max, percentage } = detail;

  // Group marks by subject for the summary
  const subjectMap = new Map<string, typeof marks>();
  for (const m of marks) {
    if (!subjectMap.has(m.subject)) subjectMap.set(m.subject, []);
    subjectMap.get(m.subject)!.push(m);
  }

  const testSubmissions: TestSubmissionRecord[] = detail.test_submissions ?? [];

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/teacher/marks/view"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Class Marks
        </Link>
      </div>

      <PageHeader
        title={`Marks — ${student.full_name}`}
        description={`${student.class_name}${student.section ? ` · Section ${student.section}` : ''}${student.roll_number ? ` · Roll No. ${student.roll_number}` : ''}`}
      />

      {/* Student summary card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6 max-w-2xl">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Student</p>
            <p className="mt-1 text-sm font-semibold text-gray-900">{student.full_name}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Class</p>
            <p className="mt-1 text-sm font-semibold text-gray-900">{student.class_name}{student.section ? ` - ${student.section}` : ''}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Roll No</p>
            <p className="mt-1 text-sm font-semibold text-gray-900">{student.roll_number ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Overall</p>
            {marks.length > 0 ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">{total_obtained}/{total_max}</span>
                {percentage !== null && <GradeBadge percentage={percentage} />}
              </div>
            ) : (
              <p className="mt-1 text-sm text-gray-400">No marks yet</p>
            )}
          </div>
        </div>
      </div>

      {marks.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center max-w-2xl">
          <p className="text-gray-400 text-sm">No marks recorded for this student yet.</p>
        </div>
      ) : (
        <>
          {/* Per-subject summary */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6 max-w-2xl">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Subject-wise Summary</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Subject</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Tests</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Total Marks</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Percentage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {Array.from(subjectMap.entries()).map(([subject, subjectMarks]) => {
                    const subTotal = subjectMarks.reduce((s, m) => s + Number(m.score), 0);
                    const subMax = subjectMarks.reduce((s, m) => s + Number(m.max_score), 0);
                    const subPct = pct(subTotal, subMax);
                    return (
                      <tr key={subject} className="hover:bg-gray-50">
                        <td className="px-6 py-3 font-medium text-gray-900">{subject}</td>
                        <td className="px-4 py-3 text-center text-gray-600">{subjectMarks.length}</td>
                        <td className="px-4 py-3 text-center font-semibold text-gray-800">{subTotal}/{subMax}</td>
                        <td className="px-4 py-3 text-center"><GradeBadge percentage={subPct} /></td>
                      </tr>
                    );
                  })}
                  {/* Totals row */}
                  <tr className="bg-gray-50 border-t-2 border-gray-200">
                    <td className="px-6 py-3 font-semibold text-gray-900">Total</td>
                    <td className="px-4 py-3 text-center font-semibold text-gray-800">{marks.length}</td>
                    <td className="px-4 py-3 text-center font-semibold text-gray-900">{total_obtained}/{total_max}</td>
                    <td className="px-4 py-3 text-center">
                      {percentage !== null && <GradeBadge percentage={percentage} />}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* All marks detail */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden max-w-2xl">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">All Test Records</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Subject</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Exam</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Term</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Score</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {marks.map((m) => {
                    const p = pct(m.score, m.max_score);
                    return (
                      <tr key={m.id} className="hover:bg-gray-50">
                        <td className="px-6 py-3 font-medium text-gray-900">{m.subject}</td>
                        <td className="px-4 py-3 text-gray-600">{EXAM_TYPE_LABELS[m.exam_type] ?? m.exam_type}</td>
                        <td className="px-4 py-3 text-gray-600">{TERM_LABELS[m.term] ?? m.term}</td>
                        <td className="px-4 py-3 text-center font-semibold text-gray-800">{m.score}/{m.max_score}</td>
                        <td className="px-4 py-3 text-center"><GradeBadge percentage={p} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Online test submissions */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden max-w-2xl mt-6">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Online Test Submissions</h2>
          <span className="text-xs text-gray-400">{testSubmissions.length} submission{testSubmissions.length !== 1 ? 's' : ''}</span>
        </div>
        {testSubmissions.length === 0 ? (
          <p className="text-center py-8 text-sm text-gray-400">No online tests submitted yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Test</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Subject</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Term</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">MCQ Score</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Total</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Submitted</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {testSubmissions.map((t) => (
                  <tr key={t.attempt_id} className="hover:bg-gray-50">
                    <td className="px-6 py-3 font-medium text-gray-900">{t.test_title ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{t.subject ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{TERM_LABELS[t.term ?? ''] ?? t.term ?? '—'}</td>
                    <td className="px-4 py-3 text-center font-semibold text-gray-800">
                      {t.mcq_score !== null ? t.mcq_score : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {t.total_score !== null
                        ? <span className="font-semibold text-gray-900">{t.total_score}</span>
                        : <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Pending</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {t.submitted_at ? new Date(t.submitted_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openAttemptDetail(t.attempt_id)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                          t.total_score === null
                            ? 'text-blue-700 bg-blue-50 hover:bg-blue-100'
                            : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                        }`}
                      >
                        {t.total_score === null ? 'Mark' : 'Review'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Theory Marking Modal ─────────────────────────────────────────────── */}
      <Modal
        open={!!viewAttempt || attemptLoading}
        onClose={() => { setViewAttempt(null); setMarkingError(''); setMarkingSuccess(false); setTheoryMarks({}); }}
        title={viewAttempt ? `${viewAttempt.test_title} — ${viewAttempt.student_name}` : 'Loading…'}
        size="lg"
      >
        {attemptLoading ? (
          <div className="flex justify-center py-10">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : viewAttempt ? (
          <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
            {/* Summary bar */}
            <div className="flex flex-wrap gap-2 text-xs">
              {[
                { label: 'Roll No', value: viewAttempt.roll_no },
                { label: 'MCQ Score', value: viewAttempt.mcq_score ?? '—' },
                { label: 'Total', value: viewAttempt.total_score ?? 'Pending' },
                { label: 'Submitted', value: new Date(viewAttempt.submitted_at).toLocaleString() },
              ].map((item) => (
                <span key={item.label} className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full">
                  <span className="font-medium">{item.label}:</span> {item.value}
                </span>
              ))}
            </div>

            {markingSuccess && (
              <div className="px-3 py-2.5 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
                ✓ Marks saved successfully.
              </div>
            )}
            {markingError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{markingError}</div>
            )}

            {/* Answers */}
            <div className="space-y-3">
              {viewAttempt.answers.map((ans: TestAnswerDetail, idx: number) => (
                <div key={ans.question_id} className="border border-gray-200 rounded-lg p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-gray-900">
                      <span className="text-gray-400 mr-2">Q{idx + 1}.</span>{ans.question_text}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ans.question_type === 'mcq' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                        {ans.question_type.toUpperCase()}
                      </span>
                      <span className="text-xs text-gray-500">{ans.marks}m</span>
                    </div>
                  </div>

                  {ans.question_type === 'mcq' ? (
                    <div className="grid grid-cols-2 gap-1.5">
                      {(['a', 'b', 'c', 'd'] as const).map((letter) => {
                        const optKey = `option_${letter}` as keyof TestAnswerDetail;
                        const optText = ans[optKey] as string | null;
                        if (!optText) return null;
                        const isCorrect = ans.correct_option === letter;
                        const isSelected = ans.selected_option === letter;
                        return (
                          <div key={letter} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${
                            isCorrect ? 'bg-green-50 border border-green-200 text-green-700 font-medium'
                            : isSelected && !isCorrect ? 'bg-red-50 border border-red-200 text-red-600'
                            : 'bg-gray-50 text-gray-600'
                          }`}>
                            <span className="font-bold">{letter.toUpperCase()}.</span>
                            {optText}
                            {isSelected && <span className="ml-auto">{isCorrect ? '✓' : '✗'}</span>}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="px-3 py-2.5 bg-gray-50 rounded-lg text-sm text-gray-700 min-h-[3rem]">
                        {ans.theory_answer || <span className="text-gray-400 italic">No answer provided</span>}
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="text-xs font-medium text-gray-600">
                          Marks awarded (max {ans.marks}):
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={ans.marks}
                          step={0.5}
                          className="w-20 px-2 py-1 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                          value={theoryMarks[ans.question_id] ?? (ans.marks_awarded !== null ? String(ans.marks_awarded) : '')}
                          onChange={(e) => setTheoryMarks((prev) => ({ ...prev, [ans.question_id]: e.target.value }))}
                        />
                        {ans.marks_awarded !== null && (
                          <span className="text-xs text-green-600 font-medium">Currently: {ans.marks_awarded}/{ans.marks}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {viewAttempt.answers.some((a) => a.question_type === 'theory') && (
              <div className="flex justify-end pt-1">
                <button
                  onClick={submitTheoryMarks}
                  disabled={markingSubmitting}
                  className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
                >
                  {markingSubmitting ? 'Saving…' : 'Save Theory Marks'}
                </button>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
