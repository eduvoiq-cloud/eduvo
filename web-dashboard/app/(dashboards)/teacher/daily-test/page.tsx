'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// -- Types ---------------------------------------------------------------------

interface GeneratedQuestion {
  question_text: string;
  options: [string, string, string, string];
  correct_index: number;
  explanation: string;
  difficulty: 'easy' | 'medium' | 'hard';
  marks: number;
}

type Phase = 'setup' | 'preview' | 'success';
type CreationMode = 'ai' | 'manual';

const DIFFICULTY_BADGE: Record<string, { label: string; cls: string }> = {
  easy:   { label: 'Easy',   cls: 'bg-green-100 text-green-700' },
  medium: { label: 'Medium', cls: 'bg-yellow-100 text-yellow-700' },
  hard:   { label: 'Hard',   cls: 'bg-red-100 text-red-700' },
};

// -- Empty manual question factory ---------------------------------------------

function emptyQuestion(): GeneratedQuestion {
  return {
    question_text: '',
    options: ['', '', '', ''],
    correct_index: 0,
    explanation: '',
    difficulty: 'medium',
    marks: 1,
  };
}

// -- Manual question editor ----------------------------------------------------

function ManualQuestionEditor({
  q,
  index,
  onChange,
  onRemove,
  canRemove,
}: {
  q: GeneratedQuestion;
  index: number;
  onChange: (updated: GeneratedQuestion) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800">Question {index + 1}</span>
        {canRemove && (
          <button onClick={onRemove} className="text-xs text-red-500 hover:underline">
            Remove
          </button>
        )}
      </div>

      <FormField label="Question text" htmlFor={`mq-text-${index}`} required>
        <textarea
          id={`mq-text-${index}`}
          rows={2}
          className={`${inputClass} resize-none`}
          placeholder="Enter the question?"
          value={q.question_text}
          onChange={(e) => onChange({ ...q, question_text: e.target.value })}
        />
      </FormField>

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">Options <span className="text-gray-400 font-normal">(click a letter to mark it correct)</span></p>
        {(['A', 'B', 'C', 'D'] as const).map((letter, oi) => (
          <div key={letter} className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onChange({ ...q, correct_index: oi })}
              className={`w-8 h-8 rounded-full text-xs font-bold shrink-0 border-2 transition-colors ${
                q.correct_index === oi
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'
              }`}
              aria-label={`Mark option ${letter} as correct`}
            >
              {letter}
            </button>
            <input
              type="text"
              className={inputClass}
              placeholder={`Option ${letter}`}
              value={q.options[oi]}
              onChange={(e) => {
                const opts = [...q.options] as [string, string, string, string];
                opts[oi] = e.target.value;
                onChange({ ...q, options: opts });
              }}
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Difficulty" htmlFor={`mq-diff-${index}`}>
          <select
            id={`mq-diff-${index}`}
            className={inputClass}
            value={q.difficulty}
            onChange={(e) => onChange({ ...q, difficulty: e.target.value as GeneratedQuestion['difficulty'] })}
          >
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </FormField>

        <FormField label="Explanation (optional)" htmlFor={`mq-exp-${index}`}>
          <input
            id={`mq-exp-${index}`}
            type="text"
            className={inputClass}
            placeholder="Brief explanation of the answer?"
            value={q.explanation}
            onChange={(e) => onChange({ ...q, explanation: e.target.value })}
          />
        </FormField>
      </div>
    </div>
  );
}

// -- Question card (preview mode) ----------------------------------------------

function QuestionCard({
  q,
  index,
  onEdit,
  onRemove,
}: {
  q: GeneratedQuestion;
  index: number;
  onEdit: (updated: GeneratedQuestion) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GeneratedQuestion>({ ...q });
  const badge = DIFFICULTY_BADGE[q.difficulty] ?? DIFFICULTY_BADGE.medium;

  function save() {
    onEdit(draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="border border-blue-200 bg-blue-50/40 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-800">Q{index + 1} ? Editing</span>
          <button
            onClick={() => { setDraft({ ...q }); setEditing(false); }}
            className="text-xs text-gray-500 hover:text-red-500"
          >
            Cancel
          </button>
        </div>

        <FormField label="Question" htmlFor={`q-text-${index}`} required>
          <textarea
            id={`q-text-${index}`}
            rows={3}
            className={`${inputClass} resize-none`}
            value={draft.question_text}
            onChange={(e) => setDraft((d) => ({ ...d, question_text: e.target.value }))}
          />
        </FormField>

        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">Options</p>
          {(['A', 'B', 'C', 'D'] as const).map((letter, oi) => (
            <div key={letter} className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, correct_index: oi }))}
                className={`w-8 h-8 rounded-full text-xs font-bold shrink-0 border-2 transition-colors ${
                  draft.correct_index === oi
                    ? 'bg-green-600 text-white border-green-600'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'
                }`}
                aria-label={`Mark option ${letter} as correct`}
              >
                {letter}
              </button>
              <input
                type="text"
                className={inputClass}
                value={draft.options[oi]}
                onChange={(e) => {
                  const opts = [...draft.options] as [string, string, string, string];
                  opts[oi] = e.target.value;
                  setDraft((d) => ({ ...d, options: opts }));
                }}
              />
            </div>
          ))}
        </div>

        <FormField label="Explanation" htmlFor={`q-exp-${index}`}>
          <input
            id={`q-exp-${index}`}
            type="text"
            className={inputClass}
            value={draft.explanation}
            onChange={(e) => setDraft((d) => ({ ...d, explanation: e.target.value }))}
          />
        </FormField>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => { setDraft({ ...q }); setEditing(false); }}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-gray-400">Q{index + 1}</span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => { setDraft({ ...q }); setEditing(true); }}
            className="text-xs text-blue-600 hover:underline"
          >
            Edit
          </button>
          <button
            onClick={onRemove}
            className="text-xs text-red-500 hover:underline"
          >
            Remove
          </button>
        </div>
      </div>

      <p className="text-sm font-medium text-gray-900">{q.question_text}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {q.options.map((opt, oi) => (
          <div
            key={oi}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border ${
              q.correct_index === oi
                ? 'border-green-300 bg-green-50 text-green-800 font-medium'
                : 'border-gray-200 bg-gray-50 text-gray-700'
            }`}
          >
            <span className="font-bold text-gray-400">{String.fromCharCode(65 + oi)}.</span>
            {opt}
            {q.correct_index === oi && (
              <svg className="w-3 h-3 ml-auto shrink-0 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
        ))}
      </div>

      {q.explanation && (
        <p className="text-xs text-gray-500 italic border-t border-gray-100 pt-2">
          ?? {q.explanation}
        </p>
      )}
    </div>
  );
}

// -- Main page -----------------------------------------------------------------

export default function DailyTestPage() {
  const { user } = useAuth();
  const router = useRouter();

  // Permission check
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  // Assignments for dropdowns
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // Form state
  const [className, setClassName] = useState('');
  const [section, setSection] = useState('');
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [board, setBoard] = useState('GSEB');
  const [language, setLanguage] = useState('English');

  // Creation mode
  const [creationMode, setCreationMode] = useState<CreationMode>('ai');

  // AI generation state
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  // Manual questions state
  const [manualQuestions, setManualQuestions] = useState<GeneratedQuestion[]>([emptyQuestion()]);
  const [manualError, setManualError] = useState('');

  // Preview state
  const [questions, setQuestions] = useState<GeneratedQuestion[]>([]);
  const [phase, setPhase] = useState<Phase>('setup');

  // Assign state
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState('');
  const [assignedResult, setAssignedResult] = useState<{ students_assigned: number } | null>(null);

  // -- Check permission ------------------------------------------------------

  useEffect(() => {
    const token = getToken();
    if (!token || !user) return;
    if (user.role !== 'teacher') { setHasPermission(false); return; }

    fetch(`${BASE_URL}/api/daily-tests/permission`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((j) => setHasPermission(j.data?.can_create_daily_tests === true))
      .catch(() => setHasPermission(false));
  }, [user]);

  // -- Fetch assignments -----------------------------------------------------

  const fetchAssignments = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoadingAssignments(true);
    try {
      const res = await assignmentsApi.list(token, user.school_id);
      setAssignments(res.data.filter((a) => a.teacher_id === user.id));
    } catch { /* silent */ }
    finally { setLoadingAssignments(false); }
  }, [user]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  // -- Derived dropdowns -----------------------------------------------------

  // Only show classes 7?12 (daily test is for senior premium)
  const seniorClasses = ['7', '8', '9', '10', '11', '12'];
  const myClasses = [...new Set(assignments.map((a) => a.class_name))]
    .filter((c) => seniorClasses.some((s) => c === s || c === `Class ${s}` || c.endsWith(` ${s}`)))
    .sort();

  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === className).map((a) => a.section)
  )].sort();

  const subjectsForClassSection = [...new Set(
    assignments
      .filter((a) => a.class_name === className && a.section === section)
      .map((a) => a.subject)
  )].sort();

  // -- Validate setup fields -------------------------------------------------

  function validateSetup(): string | null {
    if (!className) return 'Please select a class.';
    if (!section) return 'Please select a section.';
    if (!subject) return 'Please select a subject.';
    if (!topic.trim()) return 'Please enter the topic.';
    return null;
  }

  // -- Generate questions (AI) -----------------------------------------------

  async function handleGenerate() {
    const err = validateSetup();
    if (err) { setGenerateError(err); return; }
    setGenerateError('');
    setGenerating(true);
    try {
      const token = getToken();
      const res = await fetch(`${BASE_URL}/api/daily-tests/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ class: className, subject, topic: topic.trim(), board, language }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Generation failed');
      setQuestions(json.data.questions as GeneratedQuestion[]);
      setPhase('preview');
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : 'AI generation failed. Try again or create manually.');
    } finally {
      setGenerating(false);
    }
  }

  // -- Submit manual questions -----------------------------------------------

  function handleManualSubmit() {
    const err = validateSetup();
    if (err) { setManualError(err); return; }

    // Validate each question
    for (let i = 0; i < manualQuestions.length; i++) {
      const q = manualQuestions[i];
      if (!q.question_text.trim()) {
        setManualError(`Question ${i + 1}: question text is required.`);
        return;
      }
      if (q.options.some((o) => !o.trim())) {
        setManualError(`Question ${i + 1}: all 4 options are required.`);
        return;
      }
    }

    setManualError('');
    setQuestions(manualQuestions);
    setPhase('preview');
  }

  // -- Assign test -----------------------------------------------------------

  async function handleAssign() {
    setAssignError('');
    setAssigning(true);
    try {
      const token = getToken();
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`${BASE_URL}/api/daily-tests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          class: className,
          section,
          subject,
          topic: topic.trim(),
          test_date: today,
          questions,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to assign test');
      setAssignedResult({ students_assigned: json.data ? 1 : 0 });
      setPhase('success');
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : 'Failed to assign. Please try again.');
    } finally {
      setAssigning(false);
    }
  }

  // -- Loading / permission gate ---------------------------------------------

  if (hasPermission === null) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (hasPermission === false) {
    return (
      <>
        <PageHeader
          title="Daily AI Test"
          description="Generate and assign AI-powered daily tests"
        />
        <div className="max-w-lg mx-auto mt-8 text-center py-16 px-6 bg-white rounded-xl border border-gray-200">
          <div className="text-5xl mb-4">??</div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Access Required</h2>
          <p className="text-sm text-gray-500">
            Your school admin needs to grant you Daily Test access. Contact your administrator.
          </p>
        </div>
      </>
    );
  }

  // -- Success screen --------------------------------------------------------

  if (phase === 'success') {
    return (
      <>
        <PageHeader title="Daily AI Test" description="Test assigned successfully" />
        <div className="max-w-lg mx-auto mt-8 text-center py-16 px-6 bg-white rounded-xl border border-gray-200">
          <div className="text-5xl mb-4">??</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Test Assigned!</h2>
          <p className="text-sm text-gray-600 mb-6">
            Today&apos;s <strong>{subject}</strong> test on &quot;<strong>{topic}</strong>&quot; has been assigned to{' '}
            Class {className} {section}. Premium students have been notified.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={() => {
                setPhase('setup');
                setQuestions([]);
                setTopic('');
                setAssignedResult(null);
                setManualQuestions([emptyQuestion()]);
                setCreationMode('ai');
                setLanguage('English');
              }}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
            >
              Create Another Test
            </button>
            <button
              onClick={() => router.push('/teacher/dashboard')}
              className="px-5 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      </>
    );
  }

  // -- Preview screen --------------------------------------------------------

  if (phase === 'preview') {
    return (
      <>
        <PageHeader
          title="Daily AI Test"
          description={`Preview ? ${subject} ? ${topic}`}
          action={
            <button
              onClick={() => setPhase('setup')}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
          }
        />

        {/* Summary bar */}
        <div className="flex items-center gap-4 px-4 py-3 bg-white border border-gray-200 rounded-xl mb-5 text-sm">
          <span className="font-semibold text-gray-900">{questions.length} questions</span>
          <span className="text-gray-300">?</span>
          <span className="text-green-600 font-medium">
            {questions.filter((q) => q.difficulty === 'easy').length} easy
          </span>
          <span className="text-yellow-600 font-medium">
            {questions.filter((q) => q.difficulty === 'medium').length} medium
          </span>
          <span className="text-red-600 font-medium">
            {questions.filter((q) => q.difficulty === 'hard').length} hard
          </span>
          <span className="text-gray-300">?</span>
          <span className="text-gray-500">Class {className} {section}</span>
        </div>

        {/* Questions list */}
        <div className="space-y-4 mb-6">
          {questions.map((q, idx) => (
            <QuestionCard
              key={idx}
              q={q}
              index={idx}
              onEdit={(updated) =>
                setQuestions((prev) => prev.map((x, i) => i === idx ? updated : x))
              }
              onRemove={() =>
                setQuestions((prev) => prev.filter((_, i) => i !== idx))
              }
            />
          ))}
        </div>

        {questions.length === 0 && (
          <div className="text-center py-10 border-2 border-dashed border-gray-200 rounded-xl mb-6">
            <p className="text-sm text-gray-400">All questions removed. Go back and regenerate.</p>
          </div>
        )}

        {assignError && (
          <div className="mb-4 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {assignError}
          </div>
        )}

        <div className="flex items-center justify-between">
          <button
            onClick={() => setPhase('setup')}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            ? Back
          </button>
          <button
            onClick={handleAssign}
            disabled={assigning || questions.length === 0}
            className="flex items-center gap-2 px-6 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white text-sm font-semibold rounded-lg"
          >
            {assigning ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Assigning?
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Assign to Class
              </>
            )}
          </button>
        </div>
      </>
    );
  }

  // -- Setup screen ----------------------------------------------------------

  return (
    <>
      <PageHeader
        title="Daily AI Test"
        description="Generate an AI-powered daily test for your class"
      />

      <div className="max-w-2xl space-y-6">
        {/* -- Common setup fields ------------------------------------------- */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-sm font-semibold text-gray-900">Test Setup</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Class" htmlFor="dt-class" required>
              <select
                id="dt-class"
                className={inputClass}
                disabled={loadingAssignments}
                value={className}
                onChange={(e) => { setClassName(e.target.value); setSection(''); setSubject(''); }}
              >
                <option value="">{loadingAssignments ? 'Loading?' : 'Select class?'}</option>
                {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>

            <FormField label="Section" htmlFor="dt-section" required>
              <select
                id="dt-section"
                className={inputClass}
                disabled={!className}
                value={section}
                onChange={(e) => { setSection(e.target.value); setSubject(''); }}
              >
                <option value="">Select section?</option>
                {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Subject" htmlFor="dt-subject" required>
              <select
                id="dt-subject"
                className={inputClass}
                disabled={!section}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                <option value="">Select subject?</option>
                {subjectsForClassSection.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>

            <FormField label="Board" htmlFor="dt-board">
              <select
                id="dt-board"
                className={inputClass}
                value={board}
                onChange={(e) => setBoard(e.target.value)}
              >
                <option value="GSEB">GSEB (Gujarat)</option>
                <option value="CBSE">CBSE</option>
                <option value="ICSE">ICSE</option>
                <option value="MSBSHSE">MSBSHSE (Maharashtra)</option>
                <option value="RBSE">RBSE (Rajasthan)</option>
                <option value="BSEB">BSEB (Bihar)</option>
                <option value="MPBSE">MPBSE (Madhya Pradesh)</option>
                <option value="IB">IB</option>
                <option value="IGCSE">IGCSE</option>
              </select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Question Language" htmlFor="dt-language">
              <select
                id="dt-language"
                className={inputClass}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="English">English</option>
                <option value="Gujarati">ગુજરાતી (Gujarati)</option>
                <option value="Hindi">हिंदी (Hindi)</option>
                <option value="Marathi">मराठी (Marathi)</option>
                <option value="Bengali">বাংলা (Bengali)</option>
                <option value="Tamil">தமிழ் (Tamil)</option>
                <option value="Telugu">తెలుగు (Telugu)</option>
                <option value="Kannada">ಕನ್ನಡ (Kannada)</option>
                <option value="Punjabi">ਪੰਜਾਬੀ (Punjabi)</option>
                <option value="Sanskrit">Sanskrit</option>
              </select>
            </FormField>
          </div>

          <FormField label="What topic did you teach today?" htmlFor="dt-topic" required>
            <input
              id="dt-topic"
              type="text"
              className={inputClass}
              placeholder="e.g. Laws of Motion, Photosynthesis, Linear Equations?"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && creationMode === 'ai') handleGenerate(); }}
            />
          </FormField>

          <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-xs text-blue-700">
            <strong>Note:</strong> This test will be assigned to all students in Class {className || '?'} {section || '?'} with an active <strong>Premium Senior</strong> subscription. They will be notified via the app.
          </div>
        </div>

        {/* -- Mode toggle -------------------------------------------------- */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setCreationMode('ai'); setGenerateError(''); }}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-lg border transition-colors ${
              creationMode === 'ai'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            ? Generate with AI
          </button>
          <button
            onClick={() => { setCreationMode('manual'); setGenerateError(''); }}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-lg border transition-colors ${
              creationMode === 'manual'
                ? 'bg-gray-800 text-white border-gray-800'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            ?? Create Manually
          </button>
        </div>

        {/* -- AI mode ----------------------------------------------------- */}
        {creationMode === 'ai' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <p className="text-xs text-gray-500">AI will generate 10 MCQ questions (4 easy, 4 medium, 2 hard) based on your topic and board.</p>

            {generateError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 space-y-2">
                <p>{generateError}</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-red-300"
                  >
                    {generating ? 'Retrying?' : 'Retry'}
                  </button>
                  <button
                    onClick={() => { setCreationMode('manual'); setGenerateError(''); }}
                    className="px-3 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded hover:bg-gray-50"
                  >
                    Create Manually Instead
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={handleGenerate}
                disabled={generating || !className || !section || !subject || !topic.trim()}
                className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                {generating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Generating?
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Generate Test
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* -- Manual mode ------------------------------------------------- */}
        {creationMode === 'manual' && (
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 text-xs text-amber-700">
              Add at least 1 question. Each question needs text, 4 options, and a correct answer marked.
            </div>

            {manualError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {manualError}
              </div>
            )}

            {manualQuestions.map((q, idx) => (
              <ManualQuestionEditor
                key={idx}
                q={q}
                index={idx}
                onChange={(updated) =>
                  setManualQuestions((prev) => prev.map((x, i) => i === idx ? updated : x))
                }
                onRemove={() =>
                  setManualQuestions((prev) => prev.filter((_, i) => i !== idx))
                }
                canRemove={manualQuestions.length > 1}
              />
            ))}

            <div className="flex items-center justify-between">
              <button
                onClick={() => setManualQuestions((prev) => [...prev, emptyQuestion()])}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Another Question
              </button>

              <button
                onClick={handleManualSubmit}
                disabled={!className || !section || !subject || !topic.trim()}
                className="flex items-center gap-2 px-6 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white text-sm font-semibold rounded-lg"
              >
                Preview & Assign ?
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
