'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  assignmentsApi, testsApi,
  type TeacherAssignment, type Test, type TestQuestion, type MCQQuestion, type TheoryQuestion,
  type TestAttemptSummary, type TestAttemptDetail, type TestAnswerDetail,
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
  date: string;
  available_from: string;
  available_until: string;
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

const EMPTY_TEST: TestForm = { title: '', subject: '', class_name: '', section: '', term: '', date: '', available_from: '', available_until: '' };
const EMPTY_MCQ: MCQDraft = { type: 'mcq', text: '', marks: '1', options: ['', '', '', ''], correct_option: 0 };
const EMPTY_THEORY: TheoryDraft = { type: 'theory', text: '', marks: '5' };

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
  const [attempts, setAttempts] = useState<TestAttemptSummary[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [attemptsError, setAttemptsError] = useState('');

  // Attempt detail / theory marking
  const [viewAttempt, setViewAttempt] = useState<TestAttemptDetail | null>(null);
  const [attemptLoading, setAttemptLoading] = useState(false);
  const [theoryMarks, setTheoryMarks] = useState<Record<string, string>>({});
  const [markingSubmitting, setMarkingSubmitting] = useState(false);
  const [markingError, setMarkingError] = useState('');

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
    if (testForm.available_from && testForm.available_until && testForm.available_from >= testForm.available_until) {
      setFormError('"Closes at" time must be after "Opens at" time.'); return;
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
        questions: builtQuestions,
      });
      setShowCreate(false);
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
    setAttempts([]);
    setAttemptsError('');
    setAttemptsLoading(true);
    try {
      const token = getToken();
      if (!token) return;
      const res = await testsApi.listAttempts(token, test.id);
      setAttempts(res.data);
    } catch (e: unknown) {
      setAttemptsError(e instanceof Error ? e.message : 'Failed to load submissions');
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
      // Refresh the submissions list
      if (submissionsTest) {
        const res = await testsApi.listAttempts(token, submissionsTest.id);
        setAttempts(res.data);
      }
    } catch (e: unknown) {
      setMarkingError(e instanceof Error ? e.message : 'Failed to save marks');
    } finally {
      setMarkingSubmitting(false);
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────  const myClasses = [...new Set(assignments.map((a) => a.class_name))];
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

      {/* Filters */}
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

      {/* Tests list */}
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
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Date</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Window</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Term</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {tests.map((t) => (
                  <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3 font-medium text-gray-900">{t.title}</td>
                    <td className="px-6 py-3 text-gray-600">{t.class_name} · {t.section}</td>
                    <td className="px-6 py-3 text-gray-600">{t.subject}</td>
                    <td className="px-6 py-3 text-gray-600">{new Date(t.date).toLocaleDateString()}</td>
                    <td className="px-6 py-3 text-gray-600 text-xs">
                      {(t as unknown as Record<string,unknown>).available_from
                        ? `${(t as unknown as Record<string,unknown>).available_from} – ${(t as unknown as Record<string,unknown>).available_until || '—'}`
                        : <span className="text-gray-400">Any time</span>}
                    </td>
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
                        <button onClick={() => setDeleteTarget(t)}
                          className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors">
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
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
            <FormField label="Test Date" htmlFor="t-date" required>
              <input id="t-date" type="date" className={inputClass}
                value={testForm.date} onChange={(e) => setTestForm((f) => ({ ...f, date: e.target.value }))} required />
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
              {testForm.available_from && testForm.available_until && testForm.available_from >= testForm.available_until && (
                <p className="text-xs text-red-500">⚠️ &quot;Closes at&quot; must be after &quot;Opens at&quot;.</p>
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
                { label: 'Term', value: viewTest.term },
                { label: 'Date', value: new Date(viewTest.date).toLocaleDateString() },
                ...((viewTest as unknown as Record<string,unknown>).available_from
                  ? [{ label: 'Window', value: `${(viewTest as unknown as Record<string,unknown>).available_from} – ${(viewTest as unknown as Record<string,unknown>).available_until || 'no close'}` }]
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

      {/* ── Submissions List Modal ──────────────────────────────────────────── */}
      <Modal open={!!submissionsTest} onClose={() => setSubmissionsTest(null)} title={`Submissions — ${submissionsTest?.title ?? ''}`} size="lg">
        <div className="space-y-4">
          {attemptsError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{attemptsError}</div>
          )}
          {attemptsLoading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : attempts.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">No submissions yet for this test.</p>
          ) : (
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-gray-200">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Roll No</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Student</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">MCQ Score</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Total</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Status</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Submitted</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {attempts.map((a) => (
                    <tr key={a.attempt_id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{a.roll_no}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{a.student_name}</td>
                      <td className="px-4 py-3 text-gray-600">{a.mcq_score ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{a.total_score ?? (a.theory_pending ? <span className="text-amber-600 text-xs">Pending</span> : '—')}</td>
                      <td className="px-4 py-3">
                        {a.theory_pending ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                            Needs marking
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                            Marked
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {a.submitted_at ? new Date(a.submitted_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openAttemptDetail(a.attempt_id)}
                          className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                        >
                          {a.theory_pending ? 'Mark' : 'Review'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
    </>
  );
}
