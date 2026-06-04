'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import {
  assignmentsApi, testsApi,
  type TeacherAssignment, type MCQQuestion, type TheoryQuestion, type TestQuestion,
} from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestDetails {
  title: string;
  subject: string;
  class_name: string;
  section: string;
  term: string;
  date: string;
  start_time: string;
  end_time: string;
  time_limit_minutes: string;
  shuffle_questions: boolean;
  shuffle_options: boolean;
}

interface MCQDraft {
  type: 'mcq';
  text: string;
  marks: string;
  options: [string, string, string, string];
  correct_option: number; // 0-3
}

interface TheoryDraft {
  type: 'theory';
  text: string;
  marks: string;
}

type QuestionDraft = MCQDraft | TheoryDraft;

// ── Constants ─────────────────────────────────────────────────────────────────

const TERMS = ['term_1', 'term_2', 'term_3'] as const;
const TERM_LABELS: Record<string, string> = { term_1: 'Term 1', term_2: 'Term 2', term_3: 'Term 3' };

const EMPTY_DETAILS: TestDetails = {
  title: '', subject: '', class_name: '', section: '', term: '',
  date: '', start_time: '', end_time: '', time_limit_minutes: '', shuffle_questions: true, shuffle_options: true,
};

const EMPTY_MCQ: MCQDraft = {
  type: 'mcq', text: '', marks: '1', options: ['', '', '', ''], correct_option: 0,
};

const EMPTY_THEORY: TheoryDraft = { type: 'theory', text: '', marks: '5' };

// ── Step indicator ────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: 'Test Details' },
    { n: 2, label: 'Add Questions' },
    { n: 3, label: 'Review & Publish' },
  ];
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center">
          <div className="flex flex-col items-center">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
              current === s.n
                ? 'bg-blue-600 text-white'
                : current > s.n
                ? 'bg-green-500 text-white'
                : 'bg-gray-200 text-gray-500'
            }`}>
              {current > s.n ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              ) : s.n}
            </div>
            <span className={`mt-1.5 text-xs font-medium whitespace-nowrap ${
              current === s.n ? 'text-blue-600' : current > s.n ? 'text-green-600' : 'text-gray-400'
            }`}>{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-0.5 w-16 sm:w-24 mx-2 mb-4 transition-colors ${current > s.n ? 'bg-green-400' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
        checked ? 'bg-blue-600' : 'bg-gray-300'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-6' : 'translate-x-1'
      }`} />
    </button>
  );
}

// ── Question badge ────────────────────────────────────────────────────────────

function QTypeBadge({ type }: { type: 'mcq' | 'theory' }) {
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
      type === 'mcq' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
    }`}>
      {type === 'mcq' ? 'MCQ' : 'Theory'}
    </span>
  );
}

// ── MCQ Question form ─────────────────────────────────────────────────────────

interface MCQFormProps {
  draft: MCQDraft;
  onChange: (d: MCQDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string;
}

function MCQForm({ draft, onChange, onSave, onCancel, error }: MCQFormProps) {
  return (
    <div className="border border-blue-200 bg-blue-50/40 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          <QTypeBadge type="mcq" /> MCQ Question
        </h3>
        <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      <FormField label="Question Text" htmlFor="mcq-text" required>
        <textarea
          id="mcq-text" rows={3}
          className={`${inputClass} resize-none`}
          placeholder="Enter your question here…"
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
      </FormField>

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">Options <span className="text-red-500">*</span></p>
        <p className="text-xs text-gray-500">Click the letter button to mark the correct answer.</p>
        {(['A', 'B', 'C', 'D'] as const).map((letter, idx) => (
          <div key={letter} className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onChange({ ...draft, correct_option: idx })}
              aria-label={`Mark option ${letter} as correct`}
              className={`w-8 h-8 rounded-full text-xs font-bold shrink-0 transition-colors border-2 ${
                draft.correct_option === idx
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'
              }`}
            >
              {letter}
            </button>
            <input
              type="text"
              className={inputClass}
              placeholder={`Option ${letter}`}
              value={draft.options[idx]}
              onChange={(e) => {
                const opts = [...draft.options] as [string, string, string, string];
                opts[idx] = e.target.value;
                onChange({ ...draft, options: opts });
              }}
            />
          </div>
        ))}
      </div>

      <div className="flex items-end gap-4">
        <div className="w-32">
          <FormField label="Marks" htmlFor="mcq-marks" required>
            <input
              id="mcq-marks" type="number" min={1} step={0.5}
              className={inputClass}
              value={draft.marks}
              onChange={(e) => onChange({ ...draft, marks: e.target.value })}
            />
          </FormField>
        </div>
        <div className="flex gap-2 pb-0.5">
          <button type="button" onClick={onCancel}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={onSave}
            className="px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
            Save Question
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Theory Question form ──────────────────────────────────────────────────────

interface TheoryFormProps {
  draft: TheoryDraft;
  onChange: (d: TheoryDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string;
}

function TheoryForm({ draft, onChange, onSave, onCancel, error }: TheoryFormProps) {
  return (
    <div className="border border-purple-200 bg-purple-50/40 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          <QTypeBadge type="theory" /> Theory Question
        </h3>
        <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      <FormField label="Question Text" htmlFor="theory-text" required>
        <textarea
          id="theory-text" rows={3}
          className={`${inputClass} resize-none`}
          placeholder="Enter your question here…"
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
      </FormField>

      <div className="flex items-end gap-4">
        <div className="w-32">
          <FormField label="Max Marks" htmlFor="theory-marks" required>
            <input
              id="theory-marks" type="number" min={1} step={1}
              className={inputClass}
              value={draft.marks}
              onChange={(e) => onChange({ ...draft, marks: e.target.value })}
            />
          </FormField>
        </div>
        <div className="flex gap-2 pb-0.5">
          <button type="button" onClick={onCancel}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={onSave}
            className="px-4 py-2.5 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors">
            Save Question
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Saved question row ────────────────────────────────────────────────────────

interface QuestionRowProps {
  q: QuestionDraft;
  index: number;
  onEdit: () => void;
  onDelete: () => void;
}

function QuestionRow({ q, index, onEdit, onDelete }: QuestionRowProps) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-gray-300 transition-colors">
      <span className="text-xs font-bold text-gray-400 mt-0.5 w-5 shrink-0">Q{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <QTypeBadge type={q.type} />
          <span className="text-xs text-gray-500">{q.marks} mark{parseFloat(q.marks) !== 1 ? 's' : ''}</span>
          {q.type === 'mcq' && (
            <span className="text-xs text-green-600 font-medium">
              Correct: {String.fromCharCode(65 + (q as MCQDraft).correct_option)}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-800 line-clamp-2">{q.text}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={onEdit}
          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          aria-label="Edit question">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button type="button" onClick={onDelete}
          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          aria-label="Delete question">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CreateTestPage() {
  const { user } = useAuth();
  const router = useRouter();

  // Step state
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 — test details
  const [details, setDetails] = useState<TestDetails>({ ...EMPTY_DETAILS });
  const [detailsError, setDetailsError] = useState('');

  // Step 2 — questions
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [activeForm, setActiveForm] = useState<'mcq' | 'theory' | null>(null);
  const [mcqDraft, setMcqDraft] = useState<MCQDraft>({ ...EMPTY_MCQ });
  const [theoryDraft, setTheoryDraft] = useState<TheoryDraft>({ ...EMPTY_THEORY });
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [questionError, setQuestionError] = useState('');
  const [questionsError, setQuestionsError] = useState('');

  // Step 3 — publish
  const [submitting, setSubmitting] = useState(false);
  const [publishError, setPublishError] = useState('');

  // Assignments for dropdowns
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // ── Fetch teacher assignments ───────────────────────────────────────────────

  const fetchAssignments = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoadingAssignments(true);
    try {
      const res = await assignmentsApi.list(token, user.school_id);
      setAssignments(res.data.filter((a) => a.teacher_id === user.id));
    } catch { /* silent — dropdowns will be empty */ }
    finally { setLoadingAssignments(false); }
  }, [user]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  // ── Derived dropdown options ────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();

  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === details.class_name).map((a) => a.section)
  )].sort();

  const subjectsForClassSection = [...new Set(
    assignments
      .filter((a) => a.class_name === details.class_name && a.section === details.section)
      .map((a) => a.subject)
  )].sort();

  // ── Derived totals ──────────────────────────────────────────────────────────

  const totalMarks = questions.reduce((sum, q) => sum + parseFloat(q.marks || '0'), 0);
  const mcqCount = questions.filter((q) => q.type === 'mcq').length;
  const theoryCount = questions.filter((q) => q.type === 'theory').length;

  // ── Step 1 validation ───────────────────────────────────────────────────────

  function handleNextFromStep1() {
    setDetailsError('');
    const { title, subject, class_name, section, term, date } = details;
    if (!title.trim()) { setDetailsError('Test title is required.'); return; }
    if (!class_name) { setDetailsError('Please select a class.'); return; }
    if (!section) { setDetailsError('Please select a section.'); return; }
    if (!subject) { setDetailsError('Please select a subject.'); return; }
    if (!term) { setDetailsError('Please select a term.'); return; }
    if (!date) { setDetailsError('Please select a test date.'); return; }
    setStep(2);
  }

  // ── Question save logic ─────────────────────────────────────────────────────

  function validateAndSaveMCQ() {
    setQuestionError('');
    if (!mcqDraft.text.trim()) { setQuestionError('Question text is required.'); return; }
    if (mcqDraft.options.some((o) => !o.trim())) { setQuestionError('All 4 options are required.'); return; }
    if (!mcqDraft.marks || parseFloat(mcqDraft.marks) <= 0) { setQuestionError('Marks must be greater than 0.'); return; }

    if (editingIndex !== null) {
      setQuestions((prev) => prev.map((q, i) => i === editingIndex ? { ...mcqDraft } : q));
      setEditingIndex(null);
    } else {
      setQuestions((prev) => [...prev, { ...mcqDraft }]);
    }
    setMcqDraft({ ...EMPTY_MCQ });
    setActiveForm(null);
  }

  function validateAndSaveTheory() {
    setQuestionError('');
    if (!theoryDraft.text.trim()) { setQuestionError('Question text is required.'); return; }
    if (!theoryDraft.marks || parseFloat(theoryDraft.marks) <= 0) { setQuestionError('Max marks must be greater than 0.'); return; }

    if (editingIndex !== null) {
      setQuestions((prev) => prev.map((q, i) => i === editingIndex ? { ...theoryDraft } : q));
      setEditingIndex(null);
    } else {
      setQuestions((prev) => [...prev, { ...theoryDraft }]);
    }
    setTheoryDraft({ ...EMPTY_THEORY });
    setActiveForm(null);
  }

  function handleEditQuestion(idx: number) {
    const q = questions[idx];
    setEditingIndex(idx);
    setQuestionError('');
    if (q.type === 'mcq') {
      setMcqDraft({ ...(q as MCQDraft) });
      setActiveForm('mcq');
    } else {
      setTheoryDraft({ ...(q as TheoryDraft) });
      setActiveForm('theory');
    }
  }

  function handleDeleteQuestion(idx: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== idx));
    if (editingIndex === idx) { setActiveForm(null); setEditingIndex(null); }
  }

  function handleCancelForm() {
    setActiveForm(null);
    setEditingIndex(null);
    setQuestionError('');
    setMcqDraft({ ...EMPTY_MCQ });
    setTheoryDraft({ ...EMPTY_THEORY });
  }

  function handleNextFromStep2() {
    setQuestionsError('');
    if (questions.length === 0) { setQuestionsError('Add at least one question before continuing.'); return; }
    if (activeForm !== null) { setQuestionsError('Please save or cancel the current question form first.'); return; }
    setStep(3);
  }

  // ── Publish ─────────────────────────────────────────────────────────────────

  async function handlePublish() {
    setPublishError('');
    const token = getToken();
    if (!token) { setPublishError('Session expired. Please log in again.'); return; }

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
        title: details.title.trim(),
        subject: details.subject,
        class_name: details.class_name,
        section: details.section,
        term: details.term,
        date: details.date,
        available_from: details.start_time || null,
        available_until: details.end_time || null,
        time_limit_minutes: details.time_limit_minutes ? parseInt(details.time_limit_minutes) : undefined,
        shuffle_questions: details.shuffle_questions,
        shuffle_options: details.shuffle_options,
        questions: builtQuestions,
      });

      router.push('/teacher/tests');
    } catch (e: unknown) {
      setPublishError(e instanceof Error ? e.message : 'Failed to publish test. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Create Test"
        description="Build a new test with MCQ and theory questions"
        action={
          <button
            onClick={() => router.push('/teacher/tests')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Tests
          </button>
        }
      />

      <StepIndicator current={step} />

      {/* ── Step 1: Test Details ─────────────────────────────────────────── */}
      {step === 1 && (
        <div className="max-w-2xl">
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
            <h2 className="text-sm font-semibold text-gray-900">Test Details</h2>

            {detailsError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {detailsError}
              </div>
            )}

            <FormField label="Test Title" htmlFor="d-title" required>
              <input
                id="d-title" type="text" className={inputClass}
                placeholder="e.g. Mid-Term Mathematics Test"
                value={details.title}
                onChange={(e) => setDetails((d) => ({ ...d, title: e.target.value }))}
              />
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Class" htmlFor="d-class" required>
                <select
                  id="d-class" className={inputClass}
                  disabled={loadingAssignments}
                  value={details.class_name}
                  onChange={(e) => setDetails((d) => ({ ...d, class_name: e.target.value, section: '', subject: '' }))}
                >
                  <option value="">{loadingAssignments ? 'Loading…' : 'Select class…'}</option>
                  {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FormField>

              <FormField label="Section" htmlFor="d-section" required>
                <select
                  id="d-section" className={inputClass}
                  disabled={!details.class_name}
                  value={details.section}
                  onChange={(e) => setDetails((d) => ({ ...d, section: e.target.value, subject: '' }))}
                >
                  <option value="">Select section…</option>
                  {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Subject" htmlFor="d-subject" required>
                <select
                  id="d-subject" className={inputClass}
                  disabled={!details.section}
                  value={details.subject}
                  onChange={(e) => setDetails((d) => ({ ...d, subject: e.target.value }))}
                >
                  <option value="">Select subject…</option>
                  {subjectsForClassSection.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </FormField>

              <FormField label="Term" htmlFor="d-term" required>
                <select
                  id="d-term" className={inputClass}
                  value={details.term}
                  onChange={(e) => setDetails((d) => ({ ...d, term: e.target.value }))}
                >
                  <option value="">Select term…</option>
                  {TERMS.map((t) => <option key={t} value={t}>{TERM_LABELS[t]}</option>)}
                </select>
              </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Test Date" htmlFor="d-date" required>
                <input
                  id="d-date" type="date" className={inputClass}
                  value={details.date}
                  onChange={(e) => setDetails((d) => ({ ...d, date: e.target.value }))}
                />
              </FormField>

              <FormField label="Time Limit (minutes)" htmlFor="d-time">
                <input
                  id="d-time" type="number" min={1} step={1} className={inputClass}
                  placeholder="Optional"
                  value={details.time_limit_minutes}
                  onChange={(e) => setDetails((d) => ({ ...d, time_limit_minutes: e.target.value }))}
                />
              </FormField>
            </div>

            <div>
              <p className="text-sm font-medium text-gray-700 mb-1.5">Test Window <span className="text-xs font-normal text-gray-400">(optional — restrict when students can start)</span></p>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Opens at" htmlFor="d-start-time">
                  <input
                    id="d-start-time" type="time" className={inputClass}
                    value={details.start_time}
                    onChange={(e) => setDetails((d) => ({ ...d, start_time: e.target.value }))}
                  />
                </FormField>
                <FormField label="Closes at" htmlFor="d-end-time">
                  <input
                    id="d-end-time" type="time" className={inputClass}
                    value={details.end_time}
                    onChange={(e) => setDetails((d) => ({ ...d, end_time: e.target.value }))}
                  />
                </FormField>
              </div>
              <p className="text-xs text-gray-400 mt-1">e.g. 9:00 PM – 10:00 PM. Students who enter at 9:58 PM still get the full time limit.</p>
            </div>

            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="toggle-shuffle-q" className="text-sm font-medium text-gray-700">Shuffle Questions</label>
                  <p className="text-xs text-gray-500 mt-0.5">Randomise question order for each student</p>
                </div>
                <Toggle id="toggle-shuffle-q" checked={details.shuffle_questions} onChange={(v) => setDetails((d) => ({ ...d, shuffle_questions: v }))} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="toggle-shuffle-o" className="text-sm font-medium text-gray-700">Shuffle Options</label>
                  <p className="text-xs text-gray-500 mt-0.5">Randomise MCQ option order for each student</p>
                </div>
                <Toggle id="toggle-shuffle-o" checked={details.shuffle_options} onChange={(v) => setDetails((d) => ({ ...d, shuffle_options: v }))} />
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleNextFromStep1}
                className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Next: Add Questions
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 2: Add Questions ────────────────────────────────────────── */}
      {step === 2 && (
        <div className="max-w-2xl space-y-5">
          {/* Running total */}
          <div className="flex items-center justify-between px-4 py-3 bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center gap-4 text-sm">
              <span className="font-semibold text-gray-900">
                {questions.length} question{questions.length !== 1 ? 's' : ''}
              </span>
              <span className="text-gray-400">·</span>
              <span className="font-semibold text-blue-600">{totalMarks} total marks</span>
              {mcqCount > 0 && <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{mcqCount} MCQ</span>}
              {theoryCount > 0 && <span className="text-xs text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">{theoryCount} Theory</span>}
            </div>
          </div>

          {questionsError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {questionsError}
            </div>
          )}

          {/* Add question buttons — only show when no form is open */}
          {activeForm === null && (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setMcqDraft({ ...EMPTY_MCQ }); setEditingIndex(null); setQuestionError(''); setActiveForm('mcq'); }}
                className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add MCQ Question
              </button>
              <button
                type="button"
                onClick={() => { setTheoryDraft({ ...EMPTY_THEORY }); setEditingIndex(null); setQuestionError(''); setActiveForm('theory'); }}
                className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Theory Question
              </button>
            </div>
          )}

          {/* Active question form */}
          {activeForm === 'mcq' && (
            <MCQForm
              draft={mcqDraft}
              onChange={setMcqDraft}
              onSave={validateAndSaveMCQ}
              onCancel={handleCancelForm}
              error={questionError}
            />
          )}
          {activeForm === 'theory' && (
            <TheoryForm
              draft={theoryDraft}
              onChange={setTheoryDraft}
              onSave={validateAndSaveTheory}
              onCancel={handleCancelForm}
              error={questionError}
            />
          )}

          {/* Saved questions list */}
          {questions.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Saved Questions</p>
              {questions.map((q, idx) => (
                <QuestionRow
                  key={idx}
                  q={q}
                  index={idx}
                  onEdit={() => handleEditQuestion(idx)}
                  onDelete={() => handleDeleteQuestion(idx)}
                />
              ))}
            </div>
          )}

          {questions.length === 0 && activeForm === null && (
            <div className="text-center py-10 border-2 border-dashed border-gray-200 rounded-xl">
              <p className="text-sm text-gray-400">No questions yet. Add your first question above.</p>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => { setStep(1); setQuestionsError(''); }}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <button
              type="button"
              onClick={handleNextFromStep2}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Next: Review & Publish
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Review & Publish ─────────────────────────────────────── */}
      {step === 3 && (
        <div className="max-w-2xl space-y-5">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {/* Header */}
            <div className="px-6 py-5 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">{details.title}</h2>
              <div className="flex flex-wrap gap-2 mt-3">
                {[
                  { label: 'Class', value: `${details.class_name} · ${details.section}` },
                  { label: 'Subject', value: details.subject },
                  { label: 'Term', value: TERM_LABELS[details.term] ?? details.term },
                  { label: 'Date', value: new Date(details.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) },
                  ...(details.time_limit_minutes ? [{ label: 'Time Limit', value: `${details.time_limit_minutes} min` }] : []),
                ].map((item) => (
                  <span key={item.label} className="text-xs px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full">
                    <span className="font-medium">{item.label}:</span> {item.value}
                  </span>
                ))}
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 divide-x divide-gray-100 border-b border-gray-100">
              {[
                { label: 'Total Marks', value: totalMarks, color: 'text-blue-600' },
                { label: 'MCQ Questions', value: mcqCount, color: 'text-blue-500' },
                { label: 'Theory Questions', value: theoryCount, color: 'text-purple-600' },
              ].map((stat) => (
                <div key={stat.label} className="px-6 py-4 text-center">
                  <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
                </div>
              ))}
            </div>

            {/* Settings summary */}
            <div className="px-6 py-3 border-b border-gray-100 flex gap-4 text-xs text-gray-500">
              <span className={`flex items-center gap-1 ${details.shuffle_questions ? 'text-green-600' : 'text-gray-400'}`}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {details.shuffle_questions
                    ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />}
                </svg>
                Shuffle Questions
              </span>
              <span className={`flex items-center gap-1 ${details.shuffle_options ? 'text-green-600' : 'text-gray-400'}`}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {details.shuffle_options
                    ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />}
                </svg>
                Shuffle Options
              </span>
            </div>

            {/* Questions preview */}
            <div className="divide-y divide-gray-50">
              {questions.map((q, idx) => (
                <div key={idx} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <p className="text-sm font-medium text-gray-900">
                      <span className="text-gray-400 mr-2">Q{idx + 1}.</span>{q.text}
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                      <QTypeBadge type={q.type} />
                      <span className="text-xs text-gray-500 font-medium">{q.marks}m</span>
                    </div>
                  </div>
                  {q.type === 'mcq' && (
                    <div className="grid grid-cols-2 gap-1.5 mt-2 ml-5">
                      {(q as MCQDraft).options.map((opt, oi) => (
                        <div key={oi} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${
                          (q as MCQDraft).correct_option === oi
                            ? 'bg-green-50 border border-green-200 text-green-700 font-medium'
                            : 'bg-gray-50 text-gray-600'
                        }`}>
                          <span className="font-bold">{String.fromCharCode(65 + oi)}.</span>
                          {opt}
                          {(q as MCQDraft).correct_option === oi && (
                            <svg className="w-3 h-3 ml-auto shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {publishError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {publishError}
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => { setStep(2); setPublishError(''); }}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Questions
            </button>
            <button
              type="button"
              onClick={handlePublish}
              disabled={submitting}
              className="flex items-center gap-2 px-6 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Publishing…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Publish Test
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
