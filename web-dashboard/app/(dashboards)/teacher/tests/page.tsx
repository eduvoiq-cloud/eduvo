'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  assignmentsApi, testsApi,
  type TeacherAssignment, type Test, type TestQuestion, type MCQQuestion, type TheoryQuestion,
  type TestResultsSummary, type TestResultsSummaryRow, type TestAttemptDetail, type TestAnswerDetail,
} from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestForm {
  title: string;
  subject: string;
  class_name: string;
  section: string;
  term: string;
  exam_type: string;
  date: string;
  available_from: string;
  available_until: string;
  time_limit_minutes: string;
}

interface MCQDraft {
  type: 'mcq';
  text: string;
  marks: string;
  options: [string, string, string, string];
  correct_option: number;
}

interface TheoryDraft {
  type: 'theory';
  text: string;
  marks: string;
}

type QuestionDraft = MCQDraft | TheoryDraft;

const EMPTY_TEST: TestForm = { title: '', subject: '', class_name: '', section: '', term: '', exam_type: 'class_test', date: '', available_from: '', available_until: '', time_limit_minutes: '' };
const EMPTY_MCQ: MCQDraft = { type: 'mcq', text: '', marks: '1', options: ['', '', '', ''], correct_option: 0 };
const EMPTY_THEORY: TheoryDraft = { type: 'theory', text: '', marks: '5' };

const EXAM_TYPES_LIST = [
  { value: 'class_test', label: 'Class Test' },
  { value: 'unit_test', label: 'Unit Test' },
  { value: 'mid_term', label: 'Mid Term' },
  { value: 'final', label: 'Final' },
  { value: 'quiz', label: 'Quiz' },
  { value: 'midterm', label: 'Midterm' },
  { value: 'assignment', label: 'Assignment' },
  { value: 'project', label: 'Project' },
] as const;

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TestsPage() {
  const { user } = useAuth();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [tests, setTests] = useState<Test[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterSubject, setFilterSubject] = useState('');

  // Create test modal
  const [showCreate, setShowCreate] = useState(false);
  const [testForm, setTestForm] = useState<TestForm>(EMPTY_TEST);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [currentQ, setCurrentQ] = useState<QuestionDraft>({ ...EMPTY_MCQ });
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // View test modal
  const [viewTest, setViewTest] = useState<Test | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<Test | null>(null);

  // Submissions
  const [submissionsTest, setSubmissionsTest] = useState<Test | null>(null);
  const [resultsSummary, setResultsSummary] = useState<TestResultsSummary | null>(null);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [attemptsError, setAttemptsError] = useState('');

  // Attempt detail / theory marking
  const [viewAttempt, setViewAttempt] = useState<TestAttemptDetail | null>(null);
  const [attemptLoading, setAttemptLoading] = useState(false);
  const [theoryMarks, setTheoryMarks] = useState<Record<string, string>>({});
  const [markingSubmitting, setMarkingSubmitting] = useState(false);
  const [markingError, setMarkingError] = useState('');

  // Restrictions management
  const [restrictionsTest, setRestrictionsTest] = useState<Test | null>(null);
  const [restrictionsData, setRestrictionsData] = useState<Array<{
    student_id: string; full_name: string; roll_number: string; is_restricted: boolean;
  }>>([]);
  const [restrictionsLoading, setRestrictionsLoading] = useState(false);
  const [restrictionsError, setRestrictionsError] = useState('');
  const [restrictionsSaving, setRestrictionsSaving] = useState(false);
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const [restrictionsSuccess, setRestrictionsSuccess] = useState('');

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoading(true);
    setError('');
    try {
      const [aRes, tRes] = await Promise.all([
        assignmentsApi.list(token, user.school_id),
        testsApi.list(token, {
          class_name: filterClass || undefined,
          section: filterSection || undefined,
          subject: filterSubject || undefined,
        }),
      ]);
      setAssignments(aRes.data.filter((a) => a.teacher_id === user.id));

      // Normalise test_questions: backend returns question_type/question_text/option_a-d,
      // but the frontend types and View modal expect type/text/options[].
      const normalised: Test[] = tRes.data.map((t) => {
        const raw_t = t as unknown as Record<string, unknown>;
        const rawQuestions = (raw_t['test_questions'] ?? []) as Record<string, unknown>[];
        return {
          ...t,
          test_questions: rawQuestions.map((raw) => {
            const qType = (raw['type'] ?? raw['question_type'] ?? 'theory') as 'mcq' | 'theory';
            const qText = (raw['text'] ?? raw['question_text'] ?? '') as string;
            const rawCo = raw['correct_option'];
            const correctOption: number = typeof rawCo === 'number'
              ? rawCo
              : typeof rawCo === 'string'
              ? ['a', 'b', 'c', 'd'].indexOf(rawCo)
              : 0;
            const options: { text: string }[] = qType === 'mcq'
              ? (raw['options'] as { text: string }[] | undefined) ?? [
                  { text: (raw['option_a'] as string) ?? '' },
                  { text: (raw['option_b'] as string) ?? '' },
                  { text: (raw['option_c'] as string) ?? '' },
                  { text: (raw['option_d'] as string) ?? '' },
                ]
              : [];
            return {
              id: raw['id'] as string,
              test_id: raw['test_id'] as string,
              order_index: raw['order_index'] as number,
              type: qType,
              text: qText,
              marks: raw['marks'] as number,
              options,
              correct_option: correctOption,
            } as unknown as TestQuestion & { id: string; order_index: number; test_id: string };
          }),
        };
      });
      setTests(normalised);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tests');
    } finally {
      setLoading(false);
    }
  }, [user, filterClass, filterSection, filterSubject]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Question builder ──────────────────────────────────────────────────────

  function addQuestion() {
    setFormError('');
    if (!currentQ.text.trim()) { setFormError('Question text is required.'); return; }
    if (!currentQ.marks || parseFloat(currentQ.marks) <= 0) { setFormError('Marks must be greater than 0.'); return; }
    if (currentQ.type === 'mcq') {
      const q = currentQ as MCQDraft;
      if (q.options.some((o) => !o.trim())) { setFormError('All 4 MCQ options are required.'); return; }
    }
    setQuestions((prev) => [...prev, { ...currentQ }]);
    setCurrentQ(currentQ.type === 'mcq' ? { ...EMPTY_MCQ } : { ...EMPTY_THEORY });
  }

  function removeQuestion(idx: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== idx));
  }

  // ── Submit test ───────────────────────────────────────────────────────────

  async function handleCreateTest(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!testForm.title.trim() || !testForm.subject || !testForm.class_name || !testForm.section || !testForm.term || !testForm.date) {
      setFormError('All test fields are required.'); return;
    }
    if (questions.length === 0) { setFormError('Add at least one question.'); return; }
    if (testForm.available_from && testForm.available_until && testForm.available_from === testForm.available_until) {
      setFormError('"Closes at" and "Opens at" cannot be the same time. Overnight windows (e.g. 11 PM – 12 AM) are supported.'); return;
    }

    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      const builtQuestions: TestQuestion[] = questions.map((q) => {
        if (q.type === 'mcq') {
          const mq = q as MCQDraft;
          return {
            type: 'mcq' as const,
            text: mq.text,
            marks: parseFloat(mq.marks),
            options: mq.options.map((o) => ({ text: o })),
            correct_option: mq.correct_option,
          } satisfies MCQQuestion;
        } else {
          const tq = q as TheoryDraft;
          return {
            type: 'theory' as const,
            text: tq.text,
            marks: parseFloat(tq.marks),
          } satisfies TheoryQuestion;
        }
      });

      await testsApi.create(token, {
        ...testForm,
        available_from:  testForm.available_from  || null,
        available_until: testForm.available_until || null,
        time_limit_minutes: testForm.time_limit_minutes ? parseInt(testForm.time_limit_minutes) : undefined,
        questions: builtQuestions,
      });      setShowCreate(false);
      setTestForm(EMPTY_TEST);
      setQuestions([]);
      setCurrentQ({ ...EMPTY_MCQ });
      await fetchAll();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to create test');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Delete test ───────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteTarget) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await testsApi.remove(token, deleteTarget.id);
      setDeleteTarget(null);
      await fetchAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to delete test');
      setDeleteTarget(null);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Submissions handlers ─────────────────────────────────────────────────

  async function openSubmissions(test: Test) {
    setSubmissionsTest(test);
    setResultsSummary(null);
    setAttemptsError('');
    setAttemptsLoading(true);
    try {
      const token = getToken();
      if (!token) return;
      const res = await testsApi.getResultsSummary(token, test.id);
      setResultsSummary(res.data);
    } catch (e: unknown) {
      setAttemptsError(e instanceof Error ? e.message : 'Failed to load results');
    } finally {
      setAttemptsLoading(false);
    }
  }

  async function openAttemptDetail(attemptId: string) {
    setAttemptLoading(true);
    setMarkingError('');
    setViewAttempt(null);
    try {
      const token = getToken();
      if (!token) return;
      const res = await testsApi.getAttemptDetail(token, attemptId);
      setViewAttempt(res.data);
      // Pre-fill any already-awarded theory marks
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
    const token = getToken();
    if (!token) return;

    const theoryQuestions = viewAttempt.answers.filter((a) => a.question_type === 'theory');
    // Validate all theory questions have marks entered
    for (const q of theoryQuestions) {
      const val = theoryMarks[q.question_id];
      if (val === undefined || val === '') {
        setMarkingError(`Please enter marks for all theory questions (missing Q: ${q.question_text.slice(0, 40)}…)`);
        return;
      }
      const n = parseFloat(val);
      if (isNaN(n) || n < 0 || n > q.marks) {
        setMarkingError(`Marks for "${q.question_text.slice(0, 40)}…" must be between 0 and ${q.marks}.`);
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
      // Refresh attempt detail to show updated scores
      await openAttemptDetail(viewAttempt.attempt_id);
      // Refresh the results summary
      if (submissionsTest) {
        const res = await testsApi.getResultsSummary(token, submissionsTest.id);
        setResultsSummary(res.data);
      }
    } catch (e: unknown) {
      setMarkingError(e instanceof Error ? e.message : 'Failed to save marks');
    } finally {
      setMarkingSubmitting(false);
    }
  }

  // ── Restrictions handlers ─────────────────────────────────────────────────

  async function openRestrictions(test: Test) {
    setRestrictionsTest(test);
    setRestrictionsData([]);
    setRestrictionsError('');
    setRestrictionsSuccess('');
    setRestrictionsLoading(true);
    try {
      const token = getToken();
      if (!token) return;
      const res = await testsApi.getRestrictions(token, test.id);
      setRestrictionsData(res.data);
      setBlockedIds(new Set(res.data.filter((s) => s.is_restricted).map((s) => s.student_id)));
    } catch (e: unknown) {
      setRestrictionsError(e instanceof Error ? e.message : 'Failed to load students');
    } finally {
      setRestrictionsLoading(false);
    }
  }

  async function saveRestrictions() {
    if (!restrictionsTest) return;
    const token = getToken();
    if (!token) return;
    setRestrictionsSaving(true);
    setRestrictionsError('');
    setRestrictionsSuccess('');
    try {
      await testsApi.setRestrictions(token, restrictionsTest.id, Array.from(blockedIds));
      setRestrictionsSuccess(`Restrictions saved. ${blockedIds.size} student${blockedIds.size !== 1 ? 's' : ''} blocked.`);
    } catch (e: unknown) {
      setRestrictionsError(e instanceof Error ? e.message : 'Failed to save restrictions');
    } finally {
      setRestrictionsSaving(false);
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))];
  const mySections = [...new Set(assignments.filter((a) => a.class_name === filterClass).map((a) => a.section))];
  const mySubjects = [...new Set(assignments.filter((a) => a.class_name === filterClass && (!filterSection || a.section === filterSection)).map((a) => a.subject))];
  const totalMarks = questions.reduce((sum, q) => sum + parseFloat(q.marks || '0'), 0);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Tests"
        description="Create and manage MCQ + theory tests for your classes"
        action={
          <button
            onClick={() => { setTestForm(EMPTY_TEST); setQuestions([]); setCurrentQ({ ...EMPTY_MCQ }); setFormError(''); setShowCreate(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create Test
          </button>
        }
      />

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterClass} onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setFilterSubject(''); }}>
          <option value="">All classes</option>
          {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterSection} onChange={(e) => { setFilterSection(e.target.value); setFilterSubject(''); }} disabled={!filterClass}>
          <option value="">All sections</option>
          {mySections.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterSubject} onChange={(e) => setFilterSubject(e.target.value)} disabled={!filterClass}>
          <option value="">All subjects</option>
          {mySubjects.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {error && <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {/* ── Tests list ───────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : tests.length === 0 ? (
          <div className="text-center py-16 text-sm text-gray-400">No tests yet. Create your first test.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Title</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Class</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Subject</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Type</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Date</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Term</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {tests.map((t) => {
                  const examLabel = EXAM_TYPES_LIST.find((e) => e.value === t.exam_type)?.label ?? t.exam_type ?? 'Class Test';
                  return (
                    <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3 font-medium text-gray-900">{t.title}</td>
                      <td className="px-6 py-3 text-gray-600">{t.class_name} · {t.section}</td>
                      <td className="px-6 py-3 text-gray-600">{t.subject}</td>
                      <td className="px-6 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700">
                          {examLabel}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-600">{new Date(t.date).toLocaleDateString()}</td>
                      <td className="px-6 py-3 text-gray-600">{t.term}</td>
                      <td className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => setViewTest(t)}
                            className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors">
                            View
                          </button>
                          <button onClick={() => openSubmissions(t)}
                            className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded-md transition-colors">
                            Submissions
                          </button>
                          <button onClick={() => openRestrictions(t)}
                            className="px-3 py-1.5 text-xs font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-md transition-colors"
                            title="Block specific students from this test">
                            🔒 Restrict
                          </button>
                          <button onClick={() => setDeleteTarget(t)}
                            className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors">
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create Test Modal ──────────────────────────────────────────────── */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Test" size="lg">
        <form onSubmit={handleCreateTest} className="space-y-5 max-h-[75vh] overflow-y-auto pr-1">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
          )}

          {/* Test metadata */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Test Details</p>
            <FormField label="Title" htmlFor="t-title" required>
              <input id="t-title" type="text" className={inputClass} placeholder="e.g. Mid-Term Mathematics"
                value={testForm.title} onChange={(e) => setTestForm((f) => ({ ...f, title: e.target.value }))} required />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Class" htmlFor="t-class" required>
                <select id="t-class" className={inputClass}
                  value={testForm.class_name} onChange={(e) => setTestForm((f) => ({ ...f, class_name: e.target.value, section: '', subject: '' }))}>
                  <option value="">Select…</option>
                  {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FormField>
              <FormField label="Section" htmlFor="t-section" required>
                <select id="t-section" className={inputClass} disabled={!testForm.class_name}
                  value={testForm.section} onChange={(e) => setTestForm((f) => ({ ...f, section: e.target.value, subject: '' }))}>
                  <option value="">Select…</option>
                  {[...new Set(assignments.filter((a) => a.class_name === testForm.class_name).map((a) => a.section))].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Subject" htmlFor="t-subject" required>
                <select id="t-subject" className={inputClass} disabled={!testForm.section}
                  value={testForm.subject} onChange={(e) => setTestForm((f) => ({ ...f, subject: e.target.value }))}>
                  <option value="">Select…</option>
                  {assignments.filter((a) => a.class_name === testForm.class_name && a.section === testForm.section).map((a) => (
                    <option key={a.id} value={a.subject}>{a.subject}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Term" htmlFor="t-term" required>
                <input id="t-term" type="text" className={inputClass} placeholder="e.g. Term 1"
                  value={testForm.term} onChange={(e) => setTestForm((f) => ({ ...f, term: e.target.value }))} required />
              </FormField>
            </div>
            <FormField label="Test Type" htmlFor="t-exam-type" required>
              <select id="t-exam-type" className={inputClass}
                value={testForm.exam_type}
                onChange={(e) => setTestForm((f) => ({ ...f, exam_type: e.target.value }))}>
                {EXAM_TYPES_LIST.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </FormField>
            <FormField label="Test Date" htmlFor="t-date" required>
              <input id="t-date" type="date" className={inputClass}
                value={testForm.date} onChange={(e) => setTestForm((f) => ({ ...f, date: e.target.value }))} required />
            </FormField>

            <FormField label="Time Limit (minutes)" htmlFor="t-time-limit">
              <input id="t-time-limit" type="number" min={1} step={1} className={inputClass}
                placeholder="e.g. 60 (optional)"
                value={testForm.time_limit_minutes}
                onChange={(e) => setTestForm((f) => ({ ...f, time_limit_minutes: e.target.value }))} />
            </FormField>

            {/* Scheduling window — optional */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Schedule Window</p>
                <span className="text-xs text-gray-400 font-normal normal-case">(optional — restricts when students can open the test)</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Opens at" htmlFor="t-from">
                  <input
                    id="t-from"
                    type="time"
                    className={inputClass}
                    value={testForm.available_from}
                    onChange={(e) => setTestForm((f) => ({ ...f, available_from: e.target.value }))}
                  />
                </FormField>
                <FormField label="Closes at" htmlFor="t-until">
                  <input
                    id="t-until"
                    type="time"
                    className={inputClass}
                    value={testForm.available_until}
                    onChange={(e) => setTestForm((f) => ({ ...f, available_until: e.target.value }))}
                  />
                </FormField>
              </div>
              {testForm.available_from && testForm.available_until && testForm.available_from === testForm.available_until && (
                <p className="text-xs text-red-500">⚠️ &quot;Closes at&quot; cannot equal &quot;Opens at&quot;. Overnight windows (e.g. 11 PM – 12 AM) are supported.</p>
              )}
              {(testForm.available_from || testForm.available_until) && (
                <p className="text-xs text-blue-600 bg-blue-50 rounded-lg px-3 py-2">
                  🕐 Students can only start this test on {testForm.date || 'the test date'} between{' '}
                  <strong>{testForm.available_from || '—'}</strong> and <strong>{testForm.available_until || '—'}</strong>.
                </p>
              )}
            </div>
          </div>

          {/* Questions list */}
          {questions.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Questions ({questions.length}) · {totalMarks} total marks
              </p>
              {questions.map((q, idx) => (
                <div key={idx} className="flex items-start justify-between gap-3 px-3 py-2.5 bg-gray-50 rounded-lg border border-gray-200">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${q.type === 'mcq' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                        {(q.type ?? 'theory').toUpperCase()}
                      </span>
                      <span className="text-xs text-gray-500">{q.marks} mark{parseFloat(q.marks) !== 1 ? 's' : ''}</span>
                    </div>
                    <p className="text-sm text-gray-800 truncate">{q.text}</p>
                    {q.type === 'mcq' && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Correct: {String.fromCharCode(65 + (q as MCQDraft).correct_option)}
                      </p>
                    )}
                  </div>
                  <button type="button" onClick={() => removeQuestion(idx)}
                    className="text-gray-400 hover:text-red-500 transition-colors shrink-0 mt-0.5">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add question */}
          <div className="border border-dashed border-gray-300 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add Question</p>
              <div className="flex gap-2">
                {(['mcq', 'theory'] as const).map((t) => (
                  <button key={t} type="button"
                    onClick={() => setCurrentQ(t === 'mcq' ? { ...EMPTY_MCQ } : { ...EMPTY_THEORY })}
                    className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors uppercase ${
                      currentQ.type === t ? 'bg-blue-600 text-white border-blue-600' : 'text-gray-600 border-gray-300 hover:border-blue-400'
                    }`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <FormField label="Question Text" htmlFor="q-text">
              <textarea id="q-text" rows={2} className={`${inputClass} resize-none`} placeholder="Enter question…"
                value={currentQ.text} onChange={(e) => setCurrentQ((q) => ({ ...q, text: e.target.value }))} />
            </FormField>

            {currentQ.type === 'mcq' && (
              <div className="grid grid-cols-2 gap-2">
                {(['A', 'B', 'C', 'D'] as const).map((letter, idx) => (
                  <div key={letter} className="flex items-center gap-2">
                    <button type="button"
                      onClick={() => setCurrentQ((q) => ({ ...q, correct_option: idx } as MCQDraft))}
                      className={`w-6 h-6 rounded-full text-xs font-bold shrink-0 transition-colors ${
                        (currentQ as MCQDraft).correct_option === idx
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                      }`}>
                      {letter}
                    </button>
                    <input type="text" className={`${inputClass} py-1.5`} placeholder={`Option ${letter}`}
                      value={(currentQ as MCQDraft).options[idx]}
                      onChange={(e) => {
                        const opts = [...(currentQ as MCQDraft).options] as [string, string, string, string];
                        opts[idx] = e.target.value;
                        setCurrentQ((q) => ({ ...q, options: opts } as MCQDraft));
                      }} />
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-end gap-3">
              <FormField label="Marks" htmlFor="q-marks">
                <input id="q-marks" type="number" className={`${inputClass} w-24`} min={1} step={0.5}
                  value={currentQ.marks} onChange={(e) => setCurrentQ((q) => ({ ...q, marks: e.target.value }))} />
              </FormField>
              <button type="button" onClick={addQuestion}
                className="mb-0.5 px-4 py-2.5 bg-gray-800 hover:bg-gray-900 text-white text-sm font-medium rounded-lg transition-colors">
                Add Question
              </button>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setShowCreate(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {submitting ? 'Saving…' : `Save Test (${questions.length} question${questions.length !== 1 ? 's' : ''})`}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── View Test Modal ────────────────────────────────────────────────── */}
      <Modal open={!!viewTest} onClose={() => setViewTest(null)} title={viewTest?.title ?? ''} size="lg">
        {viewTest && (
          <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
            <div className="flex flex-wrap gap-2 text-xs">
              {[
                { label: 'Class', value: `${viewTest.class_name} · ${viewTest.section}` },
                { label: 'Subject', value: viewTest.subject },
                { label: 'Type', value: EXAM_TYPES_LIST.find((e) => e.value === viewTest.exam_type)?.label ?? viewTest.exam_type ?? 'Class Test' },
                { label: 'Term', value: viewTest.term },
                { label: 'Date', value: new Date(viewTest.date).toLocaleDateString() },
                ...(viewTest.available_from
                  ? [{ label: 'Window', value: `${viewTest.available_from} – ${viewTest.available_until || 'no close'}` }]
                  : []),
              ].map((item) => (
                <span key={item.label} className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full">
                  <span className="font-medium">{item.label}:</span> {item.value}
                </span>
              ))}
            </div>
            {viewTest.test_questions && viewTest.test_questions.length > 0 ? (
              <div className="space-y-3">
                {viewTest.test_questions
                  .sort((a, b) => a.order_index - b.order_index)
                  .map((q, idx) => (
                    <div key={q.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <p className="text-sm font-medium text-gray-900">
                          <span className="text-gray-400 mr-2">Q{idx + 1}.</span>{q.text}
                        </p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${q.type === 'mcq' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                            {(q.type ?? 'theory').toUpperCase()}
                          </span>
                          <span className="text-xs text-gray-500">{q.marks}m</span>
                        </div>
                      </div>
                      {q.type === 'mcq' && q.options && (
                        <div className="grid grid-cols-2 gap-1.5 mt-2">
                          {(q.options as { text: string }[]).map((opt, oi) => (
                            <div key={oi} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${
                              q.correct_option === oi ? 'bg-green-50 border border-green-200 text-green-700 font-medium' : 'bg-gray-50 text-gray-600'
                            }`}>
                              <span className="font-bold">{String.fromCharCode(65 + oi)}.</span>
                              {opt.text}
                              {q.correct_option === oi && (
                                <svg className="w-3 h-3 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400 text-center py-4">No questions loaded. Refresh to view.</p>
            )}
          </div>
        )}
      </Modal>

      {/* ── Delete Confirm ─────────────────────────────────────────────────── */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Test" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Are you sure you want to delete <strong>{deleteTarget?.title}</strong>? All questions will be removed. This cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setDeleteTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button onClick={handleDelete} disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors">
              {submitting ? 'Deleting…' : 'Yes, Delete'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Submissions List Modal ──────────────────────────────────────── */}
      <Modal open={!!submissionsTest} onClose={() => setSubmissionsTest(null)} title={`Results — ${submissionsTest?.title ?? ''}`} size="lg">
        <div className="space-y-4">
          {attemptsError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{attemptsError}</div>
          )}
          {attemptsLoading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : resultsSummary ? (
            <div className="space-y-4">
              {/* Stats bar */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {[
                  { label: 'Total Students', value: resultsSummary.total_students, color: 'text-gray-700', bg: 'bg-gray-50' },
                  { label: 'Attempted', value: resultsSummary.attempted_count, color: 'text-blue-700', bg: 'bg-blue-50' },
                  { label: 'Not Attempted', value: resultsSummary.not_attempted_count, color: 'text-red-600', bg: 'bg-red-50' },
                  { label: 'Highest', value: resultsSummary.highest_score !== null ? `${resultsSummary.highest_score} / ${resultsSummary.max_score}` : '—', color: 'text-green-700', bg: 'bg-green-50' },
                  { label: 'Lowest', value: resultsSummary.lowest_score !== null ? `${resultsSummary.lowest_score} / ${resultsSummary.max_score}` : '—', color: 'text-amber-700', bg: 'bg-amber-50' },
                ].map((stat) => (
                  <div key={stat.label} className={`${stat.bg} rounded-lg p-3 text-center`}>
                    <div className={`text-lg font-bold ${stat.color}`}>{stat.value}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* Average */}
              {resultsSummary.avg_score !== null && (
                <p className="text-xs text-gray-500 text-right">
                  Class average: <span className="font-semibold text-gray-700">{resultsSummary.avg_score} / {resultsSummary.max_score}</span>
                </p>
              )}

              {/* Student table */}
              <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-gray-200">
                      <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Roll No</th>
                      <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Student</th>
                      <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Status</th>
                      <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Score</th>
                      <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Submitted</th>
                      <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {resultsSummary.students.map((row: TestResultsSummaryRow) => (
                      <tr key={row.student_id} className={`hover:bg-gray-50 transition-colors ${!row.attempted ? 'opacity-60' : ''}`}>
                        <td className="px-3 py-3 text-gray-500 font-mono text-xs">{row.roll_no || '—'}</td>
                        <td className="px-3 py-3 font-medium text-gray-900">{row.student_name}</td>
                        <td className="px-3 py-3">
                          {!row.attempted ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                              Not Attempted
                            </span>
                          ) : row.theory_pending ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                              Needs Marking
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                              Marked
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-gray-700 font-semibold">
                          {row.attempted
                            ? row.theory_pending
                              ? <span className="text-amber-600 text-xs">Pending</span>
                              : `${row.score ?? 0} / ${row.max_score}`
                            : <span className="text-gray-400">—</span>
                          }
                        </td>
                        <td className="px-3 py-3 text-gray-500 text-xs">
                          {row.submitted_at ? new Date(row.submitted_at).toLocaleString() : '—'}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {row.attempted && (
                            <button
                              onClick={async () => {
                                // We need the attempt_id to open the detail view.
                                // Fetch it from the old attempts endpoint.
                                const token = getToken();
                                if (!token || !submissionsTest) return;
                                try {
                                  const res = await testsApi.listAttempts(token, submissionsTest.id);
                                  const match = res.data.find((a) => a.student_id === row.student_id);
                                  if (match) await openAttemptDetail(match.attempt_id);
                                } catch { /* silent */ }
                              }}
                              className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                            >
                              {row.theory_pending ? 'Mark' : 'Review'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-400 text-center py-10">No data available.</p>
          )}
        </div>
      </Modal>

      {/* ── Attempt Detail / Theory Marking Modal ──────────────────────────── */}
      <Modal
        open={!!viewAttempt || attemptLoading}
        onClose={() => { setViewAttempt(null); setMarkingError(''); setTheoryMarks({}); }}
        title={viewAttempt ? `${viewAttempt.student_name} — ${viewAttempt.test_title}` : 'Loading…'}
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
                      {(['a', 'b', 'c', 'd'] as const).map((letter, oi) => {
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
                            {isSelected && <span className="ml-auto text-xs">{isCorrect ? '✓' : '✗'}</span>}
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

            {/* Save marks button — only show if there are theory questions */}
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
      {/* ── Restrictions Modal ──────────────────────────────────────────── */}
      <Modal
        open={!!restrictionsTest}
        onClose={() => { setRestrictionsTest(null); setRestrictionsSuccess(''); }}
        title={`Restrict Access — ${restrictionsTest?.title ?? ''}`}
        size="md"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Select students to <strong>block</strong> from this test. Blocked students will see the test
            with a 🔒 lock icon and the message{' '}
            <span className="italic">"Pay your fees to unlock this test"</span>.
          </p>

          {restrictionsError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {restrictionsError}
            </div>
          )}
          {restrictionsSuccess && (
            <div className="px-3 py-2.5 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
              ✓ {restrictionsSuccess}
            </div>
          )}

          {restrictionsLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : restrictionsData.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No students found in this class.</p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">{restrictionsData.length} students in class</span>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setBlockedIds(new Set(restrictionsData.map((s) => s.student_id)))}
                    className="text-xs text-red-600 hover:text-red-700 font-medium"
                  >
                    Block all
                  </button>
                  <span className="text-gray-300">·</span>
                  <button
                    type="button"
                    onClick={() => setBlockedIds(new Set())}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    Clear all
                  </button>
                </div>
              </div>

              {blockedIds.size > 0 && (
                <div className="px-3 py-2 bg-red-50 border border-red-100 rounded-lg text-xs text-red-700">
                  🔒 {blockedIds.size} student{blockedIds.size !== 1 ? 's' : ''} will be blocked
                </div>
              )}

              <div className="max-h-72 overflow-y-auto space-y-1 border border-gray-100 rounded-lg p-2">
                {restrictionsData.map((student) => {
                  const blocked = blockedIds.has(student.student_id);
                  return (
                    <label
                      key={student.student_id}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                        blocked ? 'bg-red-50 border border-red-100' : 'hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={blocked}
                        onChange={(e) => {
                          const next = new Set(blockedIds);
                          if (e.target.checked) next.add(student.student_id);
                          else next.delete(student.student_id);
                          setBlockedIds(next);
                        }}
                        className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                      />
                      <span className="flex-1 text-sm text-gray-800">{student.full_name}</span>
                      {student.roll_number && (
                        <span className="text-xs text-gray-400">#{student.roll_number}</span>
                      )}
                      {blocked && <span className="text-xs text-red-500 font-medium">🔒</span>}
                    </label>
                  );
                })}
              </div>

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setRestrictionsTest(null); setRestrictionsSuccess(''); }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={saveRestrictions}
                  disabled={restrictionsSaving}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
                >
                  {restrictionsSaving ? 'Saving…' : 'Save Restrictions'}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
