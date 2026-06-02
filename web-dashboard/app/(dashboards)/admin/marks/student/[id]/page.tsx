'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { marksViewApi, type StudentMarksDetail } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

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

export default function AdminStudentMarksPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<StudentMarksDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = getToken();
    if (!token || !params?.id) return;
    marksViewApi.getStudent(token, params.id)
      .then((res) => setDetail(res.data))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load marks'))
      .finally(() => setLoading(false));
  }, [params?.id]);

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
        <Link href="/admin/students" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
          ← Back to Students
        </Link>
      </div>
    );
  }

  const { student, marks, total_obtained, total_max, percentage } = detail;

  // Group marks by subject
  const subjectMap = new Map<string, typeof marks>();
  for (const m of marks) {
    if (!subjectMap.has(m.subject)) subjectMap.set(m.subject, []);
    subjectMap.get(m.subject)!.push(m);
  }

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/admin/students"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Students
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
    </>
  );
}
