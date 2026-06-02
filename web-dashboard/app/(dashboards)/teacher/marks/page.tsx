'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, studentsApi, marksApi, type TeacherAssignment, type Student } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

const EXAM_TYPES = ['unit_test', 'mid_term', 'final', 'class_test'] as const;
const EXAM_LABELS: Record<string, string> = {
  unit_test: 'Unit Test', mid_term: 'Mid Term', final: 'Final', class_test: 'Class Test',
};
const TERMS = ['term_1', 'term_2', 'term_3'] as const;
const TERM_LABELS: Record<string, string> = { term_1: 'Term 1', term_2: 'Term 2', term_3: 'Term 3' };

interface RowState {
  student: Student;
  score: string;
  max_score: string;
  status: 'idle' | 'saving' | 'saved' | 'error';
  message: string;
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

function MarksTableSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-48" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['#', 'Student Name', 'Score', 'Max Score', 'Status'].map((h) => (
                <th key={h} className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                <td className="px-6 py-3"><div className="h-3 bg-gray-200 rounded w-4" /></td>
                <td className="px-6 py-3"><div className="h-4 bg-gray-200 rounded w-36" /></td>
                <td className="px-4 py-3"><div className="h-8 bg-gray-200 rounded w-24" /></td>
                <td className="px-4 py-3"><div className="h-8 bg-gray-200 rounded w-24" /></td>
                <td className="px-4 py-3"><div className="h-3 bg-gray-200 rounded w-12 mx-auto" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RowState {
  student: Student;
  score: string;
  max_score: string;
  status: 'idle' | 'saving' | 'saved' | 'error';
  message: string;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MarksPage() {
  const { user } = useAuth();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // Step 1-6 selections
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [subject, setSubject] = useState('');
  const [testName, setTestName] = useState('');
  const [examType, setExamType] = useState<typeof EXAM_TYPES[number]>('unit_test');
  const [term, setTerm] = useState<typeof TERMS[number]>('term_1');

  // Step 7 — student table
  const [rows, setRows] = useState<RowState[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [studentsLoaded, setStudentsLoaded] = useState(false);

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitSummary, setSubmitSummary] = useState('');
  const [formError, setFormError] = useState('');

  // ── Fetch assignments ───────────────────────────────────────────────────────

  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    assignmentsApi.list(token, user.school_id)
      .then((res) => setAssignments(res.data.filter((a) => a.teacher_id === user.id)))
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  // ── Derived dropdowns ───────────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === filterClass).map((a) => a.section)
  )].sort();
  const subjectsForClassSection = [...new Set(
    assignments.filter((a) => a.class_name === filterClass && a.section === filterSection).map((a) => a.subject)
  )].sort();

  // ── Load students ───────────────────────────────────────────────────────────

  const loadStudents = useCallback(async () => {
    if (!filterClass || !filterSection || !subject || !testName.trim() || !examType || !term) {
      setFormError('Please fill in all fields above before loading students.');
      return;
    }
    setFormError('');
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoadingStudents(true);
    setStudentsLoaded(false);
    setSubmitSummary('');
    try {
      // limit=0 fetches all students without pagination (needed for marks entry)
      const res = await studentsApi.list(token, {
        school_id: user.school_id,
        class_name: filterClass,
        section: filterSection,
        limit: 0,
      });
      const allStudents = (res.data as Student[]) ?? [];
      setRows((allStudents ?? []).map((s) => ({
        student: s,
        score: '',
        max_score: '100',
        status: 'idle',
        message: '',
      })));
      setStudentsLoaded(true);
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to load students');
    } finally {
      setLoadingStudents(false);
    }
  }, [filterClass, filterSection, subject, testName, examType, term, user]);

  function updateRow(idx: number, field: 'score' | 'max_score', value: string) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: value, status: 'idle', message: '' } : r));
  }

  // ── Bulk submit ─────────────────────────────────────────────────────────────

  async function handleSubmitAll() {
    setFormError('');
    setSubmitSummary('');

    // Validate all rows
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const score = parseFloat(r.score);
      const max = parseFloat(r.max_score);
      if (r.score === '') continue; // skip blank rows
      if (isNaN(score) || score < 0) {
        setFormError(`Row ${i + 1} (${r.student.full_name}): score must be a non-negative number.`);
        return;
      }
      if (isNaN(max) || max < 1) {
        setFormError(`Row ${i + 1} (${r.student.full_name}): max score must be at least 1.`);
        return;
      }
      if (score > max) {
        setFormError(`Row ${i + 1} (${r.student.full_name}): score (${score}) cannot exceed max score (${max}).`);
        return;
      }
    }

    const toSubmit = rows.filter((r) => r.score !== '');
    if (toSubmit.length === 0) {
      setFormError('Enter at least one score before submitting.');
      return;
    }

    const token = getToken();
    if (!token) return;
    setSubmitting(true);

    let saved = 0;
    let failed = 0;

    const updatedRows = [...rows];

    await Promise.all(
      rows.map(async (r, idx) => {
        if (r.score === '') return;
        updatedRows[idx] = { ...r, status: 'saving', message: '' };
        setRows([...updatedRows]);
        try {
          await marksApi.create(token, {
            student_id: r.student.id,
            subject,
            exam_type: examType as 'quiz' | 'midterm' | 'final' | 'assignment' | 'project' | 'unit_test' | 'mid_term' | 'class_test',
            term,
            score: parseFloat(r.score),
            max_score: parseFloat(r.max_score),
            notes: testName,
          });
          updatedRows[idx] = { ...updatedRows[idx], status: 'saved', message: 'Saved' };
          saved++;
        } catch (e: unknown) {
          updatedRows[idx] = {
            ...updatedRows[idx],
            status: 'error',
            message: e instanceof Error ? e.message : 'Failed',
          };
          failed++;
        }
        setRows([...updatedRows]);
      })
    );

    setSubmitting(false);
    setSubmitSummary(
      failed === 0
        ? `${saved} mark${saved !== 1 ? 's' : ''} saved successfully.`
        : `${saved} saved, ${failed} failed. Check rows highlighted in red.`
    );
  }

  function resetForm() {
    setFilterClass(''); setFilterSection(''); setSubject('');
    setTestName(''); setExamType('unit_test'); setTerm('term_1');
    setRows([]); setStudentsLoaded(false); setSubmitSummary(''); setFormError('');
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-6">
        <PageHeader title="Enter Marks" description="Record student scores for your assigned classes" />
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href="/teacher/marks/view"
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-300 hover:border-purple-400 hover:bg-purple-50 text-gray-700 hover:text-purple-700 text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            View Class Marks
          </Link>
          <Link
            href="/teacher/marks/import"
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-300 hover:border-blue-400 hover:bg-blue-50 text-gray-700 hover:text-blue-700 text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Import from Excel
          </Link>
        </div>
      </div>

      <div className="max-w-4xl space-y-5">
        {/* ── Step 1-6: Selections ─────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Test Details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <FormField label="Class" htmlFor="m-class" required>
              <select id="m-class" className={inputClass} disabled={loadingAssignments}
                value={filterClass}
                onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setSubject(''); setStudentsLoaded(false); setRows([]); }}>
                <option value="">{loadingAssignments ? 'Loading…' : 'Select class…'}</option>
                {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>

            <FormField label="Section" htmlFor="m-section" required>
              <select id="m-section" className={inputClass} disabled={!filterClass}
                value={filterSection}
                onChange={(e) => { setFilterSection(e.target.value); setSubject(''); setStudentsLoaded(false); setRows([]); }}>
                <option value="">Select section…</option>
                {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>

            <FormField label="Subject" htmlFor="m-subject" required>
              <select id="m-subject" className={inputClass} disabled={!filterSection}
                value={subject}
                onChange={(e) => { setSubject(e.target.value); setStudentsLoaded(false); setRows([]); }}>
                <option value="">Select subject…</option>
                {subjectsForClassSection.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>

            <FormField label="Test Name" htmlFor="m-testname" required>
              <input id="m-testname" type="text" className={inputClass}
                placeholder="e.g. Chapter 3 Quiz"
                value={testName}
                onChange={(e) => { setTestName(e.target.value); setStudentsLoaded(false); setRows([]); }} />
            </FormField>

            <FormField label="Exam Type" htmlFor="m-examtype" required>
              <select id="m-examtype" className={inputClass}
                value={examType}
                onChange={(e) => setExamType(e.target.value as typeof EXAM_TYPES[number])}>
                {EXAM_TYPES.map((t) => <option key={t} value={t}>{EXAM_LABELS[t]}</option>)}
              </select>
            </FormField>

            <FormField label="Term" htmlFor="m-term" required>
              <select id="m-term" className={inputClass}
                value={term}
                onChange={(e) => setTerm(e.target.value as typeof TERMS[number])}>
                {TERMS.map((t) => <option key={t} value={t}>{TERM_LABELS[t]}</option>)}
              </select>
            </FormField>
          </div>

          {formError && !studentsLoaded && (
            <div className="mt-3 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
          )}

          <div className="mt-4 flex justify-end">
            <button type="button" onClick={loadStudents} disabled={loadingStudents}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors">
              {loadingStudents ? 'Loading…' : 'Load Students'}
            </button>
          </div>
        </div>

        {/* ── Step 7: Student table ─────────────────────────────────────────── */}
        {loadingStudents && <MarksTableSkeleton />}

        {studentsLoaded && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {filterClass} · {filterSection} — {rows.length} student{rows.length !== 1 ? 's' : ''}
              </h2>
              <span className="text-xs text-gray-500">{subject} · {EXAM_LABELS[examType]} · {TERM_LABELS[term]}</span>
            </div>

            {rows.length === 0 ? (
              <p className="text-center py-12 text-sm text-gray-400">No students found for this class and section.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">#</th>
                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Student Name</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Score</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Max Score</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {rows.map((r, idx) => (
                        <tr key={r.student.id} className={`transition-colors ${
                          r.status === 'saved' ? 'bg-green-50' : r.status === 'error' ? 'bg-red-50' : 'hover:bg-gray-50'
                        }`}>
                          <td className="px-6 py-2.5 text-gray-400 text-xs">{idx + 1}</td>
                          <td className="px-6 py-2.5 font-medium text-gray-900">{r.student.full_name}</td>
                          <td className="px-4 py-2.5">
                            <input
                              type="number" min={0} step={0.5}
                              className={`w-24 px-2.5 py-1.5 text-sm text-center border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                                r.status === 'error' ? 'border-red-300 bg-red-50' : 'border-gray-300'
                              }`}
                              placeholder="—"
                              value={r.score}
                              onChange={(e) => updateRow(idx, 'score', e.target.value)}
                              disabled={r.status === 'saving' || r.status === 'saved'}
                            />
                          </td>
                          <td className="px-4 py-2.5">
                            <input
                              type="number" min={1} step={1}
                              className="w-24 px-2.5 py-1.5 text-sm text-center border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                              value={r.max_score}
                              onChange={(e) => updateRow(idx, 'max_score', e.target.value)}
                              disabled={r.status === 'saving' || r.status === 'saved'}
                            />
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            {r.status === 'saving' && (
                              <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin inline-block" />
                            )}
                            {r.status === 'saved' && (
                              <span className="text-xs text-green-600 font-medium flex items-center justify-center gap-1">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                </svg>
                                Saved
                              </span>
                            )}
                            {r.status === 'error' && (
                              <span className="text-xs text-red-600 font-medium">{r.message}</span>
                            )}
                            {r.status === 'idle' && r.score !== '' && (
                              <span className="text-xs text-gray-400">Ready</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {formError && (
                  <div className="mx-6 my-3 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
                )}

                {submitSummary && (
                  <div className={`mx-6 my-3 px-3 py-2.5 rounded-lg text-sm border ${
                    submitSummary.includes('failed')
                      ? 'bg-yellow-50 border-yellow-200 text-yellow-700'
                      : 'bg-green-50 border-green-200 text-green-700'
                  }`}>
                    {submitSummary}
                  </div>
                )}

                <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
                  <button type="button" onClick={resetForm}
                    className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                    Clear & Start Over
                  </button>
                  <button type="button" onClick={handleSubmitAll} disabled={submitting}
                    className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors">
                    {submitting ? (
                      <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving…</>
                    ) : `Submit All Marks`}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
