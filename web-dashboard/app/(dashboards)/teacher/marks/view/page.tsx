'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, marksViewApi, type TeacherAssignment, type StudentMarksRow } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { inputClass } from '@/components/FormField';
import { useEffect } from 'react';

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

function GradeBadge({ percentage }: { percentage: number | null }) {
  if (percentage === null) return <span className="text-gray-400 text-xs">—</span>;
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

export default function TeacherClassMarksPage() {
  const { user } = useAuth();

  // Assignments
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterTerm, setFilterTerm] = useState('');
  const [filterExamType, setFilterExamType] = useState('');

  // Results
  const [rows, setRows] = useState<StudentMarksRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Expanded row to show per-subject marks
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    assignmentsApi.list(token, user.school_id)
      .then((res) => setAssignments(res.data.filter((a) => a.teacher_id === user.id)))
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === filterClass).map((a) => a.section)
  )].sort();

  const handleLoad = useCallback(async () => {
    if (!filterClass) { setError('Please select a class.'); return; }
    setError('');
    setLoaded(false);
    const token = getToken();
    if (!token) return;
    setLoading(true);
    try {
      const res = await marksViewApi.listClass(token, {
        class_name: filterClass,
        section: filterSection || undefined,
        term: filterTerm || undefined,
        exam_type: filterExamType || undefined,
      });
      setRows(res.data ?? []);
      setLoaded(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load marks');
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterSection, filterTerm, filterExamType]);

  return (
    <>
      <PageHeader title="View Class Marks" description="Browse recorded marks for your assigned classes" />

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6 max-w-4xl">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Class <span className="text-red-500">*</span></label>
            <select
              className={inputClass}
              disabled={loadingAssignments}
              value={filterClass}
              onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setLoaded(false); setRows([]); }}
            >
              <option value="">{loadingAssignments ? 'Loading…' : 'Select class…'}</option>
              {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Section</label>
            <select
              className={inputClass}
              disabled={!filterClass}
              value={filterSection}
              onChange={(e) => { setFilterSection(e.target.value); setLoaded(false); setRows([]); }}
            >
              <option value="">All sections</option>
              {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Term</label>
            <select className={inputClass} value={filterTerm} onChange={(e) => setFilterTerm(e.target.value)}>
              <option value="">All terms</option>
              {Object.entries(TERM_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Exam Type</label>
            <select className={inputClass} value={filterExamType} onChange={(e) => setFilterExamType(e.target.value)}>
              <option value="">All types</option>
              {Object.entries(EXAM_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        {error && (
          <div className="mt-3 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}
        <div className="mt-4 flex justify-end">
          <button
            onClick={handleLoad}
            disabled={loading || !filterClass}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading ? 'Loading…' : 'Load Marks'}
          </button>
        </div>
      </div>

      {/* Results table */}
      {loaded && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden max-w-4xl">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">
              {filterClass}{filterSection ? ` · ${filterSection}` : ''} — {rows.length} student{rows.length !== 1 ? 's' : ''}
            </h2>
            {(filterTerm || filterExamType) && (
              <span className="text-xs text-gray-500">
                {filterTerm ? TERM_LABELS[filterTerm] : ''}{filterTerm && filterExamType ? ' · ' : ''}{filterExamType ? EXAM_TYPE_LABELS[filterExamType] : ''}
              </span>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="text-center py-12 text-sm text-gray-400">No marks found for this selection.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Roll No</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Student Name</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tests</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Percentage</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((row) => (
                    <>
                      <tr key={row.student_id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 text-gray-500">{row.roll_number ?? '—'}</td>
                        <td className="px-4 py-3 font-medium text-gray-900">{row.full_name}</td>
                        <td className="px-4 py-3 text-center text-gray-600">{row.marks.length}</td>
                        <td className="px-4 py-3 text-center text-gray-700 font-medium">
                          {row.marks.length > 0 ? `${row.total_obtained}/${row.total_max}` : '—'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <GradeBadge percentage={row.marks.length > 0 ? row.percentage : null} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => setExpandedStudent((p) => p === row.student_id ? null : row.student_id)}
                              className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                            >
                              {expandedStudent === row.student_id ? 'Hide' : 'Show Marks'}
                            </button>
                            <Link
                              href={`/teacher/marks/student/${row.student_id}`}
                              className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
                            >
                              View Details
                            </Link>
                          </div>
                        </td>
                      </tr>
                      {expandedStudent === row.student_id && row.marks.length > 0 && (
                        <tr key={`${row.student_id}-expanded`}>
                          <td colSpan={6} className="bg-blue-50 px-8 py-3">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-gray-500 border-b border-blue-100">
                                  <th className="text-left py-1.5 font-semibold">Subject</th>
                                  <th className="text-left py-1.5 font-semibold">Exam Type</th>
                                  <th className="text-left py-1.5 font-semibold">Term</th>
                                  <th className="text-center py-1.5 font-semibold">Score</th>
                                  <th className="text-center py-1.5 font-semibold">%</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-blue-100">
                                {row.marks.map((m) => (
                                  <tr key={m.id}>
                                    <td className="py-1.5 font-medium text-gray-800">{m.subject}</td>
                                    <td className="py-1.5 text-gray-600">{EXAM_TYPE_LABELS[m.exam_type] ?? m.exam_type}</td>
                                    <td className="py-1.5 text-gray-600">{TERM_LABELS[m.term] ?? m.term}</td>
                                    <td className="py-1.5 text-center font-semibold text-gray-800">{m.score}/{m.max_score}</td>
                                    <td className="py-1.5 text-center">
                                      <GradeBadge percentage={pct(m.score, m.max_score)} />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
