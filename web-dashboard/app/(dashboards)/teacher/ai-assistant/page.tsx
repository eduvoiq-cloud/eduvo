'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MCQDraft {
  id: string;
  question: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: 'a' | 'b' | 'c' | 'd';
  marks: number;
}

interface TheoryDraft {
  id: string;
  question: string;
  expected_answer: string;
  marks: number;
}

interface UsageInfo {
  used: number;
  limit: number;
  remaining: number;
}

interface SaveTestForm {
  title: string;
  subject_id: string;
  class: string;
  section: string;
  term: string;
  date: string;
  start_time: string;
  end_time: string;
  time_limit_minutes: string;
  shuffle_questions: boolean;
  shuffle_options: boolean;
}

const TERM_SUGGESTIONS = ['Term 1', 'Term 2', 'Term 3', 'Term 4'];
const DIFFICULTY_OPTIONS = ['easy', 'medium', 'hard'] as const;
type Difficulty = typeof DIFFICULTY_OPTIONS[number];

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Small reusable UI pieces ──────────────────────────────────────────────────

function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <button
      type="button" id={id} role="switch" aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${checked ? 'bg-blue-600' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

function Spinner({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'w-4 h-4' : 'w-6 h-6';
  return <div className={`${cls} border-2 border-blue-600 border-t-transparent rounded-full animate-spin`} />;
}

function StepBadge({ n, active, done }: { n: number; active: boolean; done: boolean }) {
  return (
    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${done ? 'bg-green-500 text-white' : active ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
      {done ? '✓' : n}
    </div>
  );
}

// ── Empty state illustration ──────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center px-8">
      <div className="text-7xl mb-6 select-none" aria-hidden>🤖</div>
      <h3 className="text-lg font-semibold text-gray-700 mb-2">AI Question Generator</h3>
      <p className="text-sm text-gray-400 max-w-xs leading-relaxed">
        Upload a document and configure settings to generate questions.
        Questions will appear here after generation.
      </p>
      <div className="mt-8 flex flex-col gap-3 w-full max-w-xs">
        {['📄 Upload study material', '⚙️ Configure question types', '✨ Generate with AI', '✏️ Edit and save as test'].map((step, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5 bg-gray-50 rounded-lg text-sm text-gray-500">
            <span className="w-5 h-5 rounded-full bg-gray-200 text-gray-500 text-xs flex items-center justify-center font-bold shrink-0">{i + 1}</span>
            {step}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MCQ Question Card ─────────────────────────────────────────────────────────

function MCQCard({ q, index, onChange, onDelete }: {
  q: MCQDraft; index: number;
  onChange: (updated: MCQDraft) => void;
  onDelete: () => void;
}) {
  const opts: Array<{ key: 'option_a' | 'option_b' | 'option_c' | 'option_d'; label: string; val: 'a' | 'b' | 'c' | 'd' }> = [
    { key: 'option_a', label: 'A', val: 'a' },
    { key: 'option_b', label: 'B', val: 'b' },
    { key: 'option_c', label: 'C', val: 'c' },
    { key: 'option_d', label: 'D', val: 'd' },
  ];
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white space-y-3 hover:border-blue-200 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-gray-400 w-6">Q{index + 1}</span>
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">MCQ</span>
        </div>
        <button onClick={onDelete} aria-label="Delete question"
          className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
      <textarea rows={2} value={q.question} onChange={(e) => onChange({ ...q, question: e.target.value })}
        placeholder="Question text…"
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {opts.map(({ key, label, val }) => (
          <div key={key} className="flex items-center gap-2">
            <button type="button" onClick={() => onChange({ ...q, correct_option: val })}
              aria-label={`Mark option ${label} as correct`}
              className={`w-7 h-7 rounded-full text-xs font-bold shrink-0 border-2 transition-colors ${q.correct_option === val ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-500 border-gray-300 hover:border-green-400'}`}>
              {label}
            </button>
            <input type="text" value={q[key]} onChange={(e) => onChange({ ...q, [key]: e.target.value })}
              placeholder={`Option ${label}`}
              className="flex-1 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-600">Marks</label>
        <input type="number" min={0.5} step={0.5} value={q.marks}
          onChange={(e) => onChange({ ...q, marks: parseFloat(e.target.value) || 1 })}
          className="w-20 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
      </div>
    </div>
  );
}

// ── Theory Question Card ──────────────────────────────────────────────────────

function TheoryCard({ q, index, onChange, onDelete }: {
  q: TheoryDraft; index: number;
  onChange: (updated: TheoryDraft) => void;
  onDelete: () => void;
}) {
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white space-y-3 hover:border-purple-200 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-gray-400 w-6">Q{index + 1}</span>
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Theory</span>
        </div>
        <button onClick={onDelete} aria-label="Delete question"
          className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
      <textarea rows={2} value={q.question} onChange={(e) => onChange({ ...q, question: e.target.value })}
        placeholder="Question text…"
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent" />
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Expected answer hint <span className="text-gray-400">(only visible to you, not students)</span>
        </label>
        <textarea rows={2} value={q.expected_answer} onChange={(e) => onChange({ ...q, expected_answer: e.target.value })}
          placeholder="Brief answer guide for marking…"
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent bg-purple-50/30" />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-600">Marks</label>
        <input type="number" min={1} step={1} value={q.marks}
          onChange={(e) => onChange({ ...q, marks: parseInt(e.target.value) || 1 })}
          className="w-20 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent" />
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AIAssistantPage() {
  const { user } = useAuth();
  const router = useRouter();

  // ── Assignments ─────────────────────────────────────────────────────────────
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);

  // ── Step 1: Upload ──────────────────────────────────────────────────────────
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [extractionId, setExtractionId] = useState('');
  const [totalChars, setTotalChars] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // ── Step 2: Configure ───────────────────────────────────────────────────────
  const [subject, setSubject] = useState('');
  const [selectedClass, setSelectedClass] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [testType, setTestType] = useState<'mcq' | 'theory'>('mcq');
  const [mcqCount, setMcqCount] = useState(10);
  const [theoryCount, setTheoryCount] = useState(5);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  // ── Step 3: Review ──────────────────────────────────────────────────────────
  const [mcqQuestions, setMcqQuestions] = useState<MCQDraft[]>([]);
  const [theoryQuestions, setTheoryQuestions] = useState<TheoryDraft[]>([]);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [hasUnsaved, setHasUnsaved] = useState(false);

  // ── Save as Test Modal ──────────────────────────────────────────────────────
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveForm, setSaveForm] = useState<SaveTestForm>({
    title: '', subject_id: '', class: '', section: '', term: '',
    date: '', start_time: '', end_time: '', time_limit_minutes: '', shuffle_questions: true, shuffle_options: false,
  });
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  // ── Toast ───────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState('');

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  }

  // ── Fetch assignments + usage on mount ──────────────────────────────────────
  const fetchInitial = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    try {
      const [aRes] = await Promise.all([
        assignmentsApi.list(token, user.school_id),
      ]);
      const mine = aRes.data.filter((a) => a.teacher_id === user.id);
      setAssignments(mine);
      if (mine.length > 0) setSubject(mine[0].subject);
    } catch { /* silent */ }
  }, [user]);

  const fetchUsage = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${BASE_URL}/api/ai/usage`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setUsage(json.data as UsageInfo);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchInitial();
    fetchUsage();
  }, [fetchInitial, fetchUsage]);

  // ── Warn before leaving with unsaved changes ────────────────────────────────
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsaved) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsaved]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const mySubjects = [...new Set(assignments.map((a) => a.subject))].sort();
  const sectionsForClass = [...new Set(assignments.filter((a) => a.class_name === saveForm.class).map((a) => a.section))].sort();
  const uploadDone = uploadState === 'done';
  const limitReached = usage ? usage.remaining <= 0 : false;

  // ── File validation ─────────────────────────────────────────────────────────
  function validateFile(file: File): string | null {
    const allowed = ['.pdf', '.docx', '.txt'];
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!allowed.includes(ext)) return `Invalid file type. Only ${allowed.join(', ')} are allowed.`;
    if (file.size > 5 * 1024 * 1024) return 'File too large. Maximum size is 5 MB.';
    return null;
  }

  // ── Upload handler ──────────────────────────────────────────────────────────
  async function handleUpload(file: File) {
    const err = validateFile(file);
    if (err) { setUploadError(err); return; }

    setUploadFile(file);
    setUploadError('');
    setUploadState('uploading');
    setUploadProgress(0);

    // Simulate progress while the real upload runs
    const progressInterval = setInterval(() => {
      setUploadProgress((p) => (p < 85 ? p + 10 : p));
    }, 300);

    const token = getToken();
    if (!token) { clearInterval(progressInterval); setUploadState('error'); setUploadError('Session expired.'); return; }

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${BASE_URL}/api/ai/upload-and-extract`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      clearInterval(progressInterval);
      setUploadProgress(100);

      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Upload failed');

      setExtractionId(json.data.extraction_id);
      setTotalChars(json.data.total_chars);
      setUploadState('done');
    } catch (e: unknown) {
      clearInterval(progressInterval);
      setUploadState('error');
      setUploadError(e instanceof Error ? e.message : 'Upload failed. Please try again.');
    }
  }

  // ── Drag and drop ───────────────────────────────────────────────────────────
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dropRef.current?.classList.remove('border-blue-400', 'bg-blue-50');
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    dropRef.current?.classList.add('border-blue-400', 'bg-blue-50');
  }

  function handleDragLeave() {
    dropRef.current?.classList.remove('border-blue-400', 'bg-blue-50');
  }

  // ── Generate questions ──────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!extractionId) return;
    setGenerateError('');
    setGenerating(true);

    const token = getToken();
    if (!token) { setGenerating(false); setGenerateError('Session expired.'); return; }

    try {
      const res = await fetch(`${BASE_URL}/api/ai/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extraction_id: extractionId,
          subject: subject.slice(0, 50),
          class_level: selectedClass.slice(0, 20) || 'General',
          difficulty,
          mcq_count: testType === 'mcq' ? mcqCount : 0,
          theory_count: testType === 'theory' ? theoryCount : 0,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Generation failed');

      const data = json.data;

      // Map API response to draft format with local IDs
      const newMcqs: MCQDraft[] = (data.mcq_questions ?? []).map((q: Record<string, unknown>, i: number) => ({
        id: `mcq-${Date.now()}-${i}`,
        question: String(q.question ?? ''),
        option_a: String(q.option_a ?? ''),
        option_b: String(q.option_b ?? ''),
        option_c: String(q.option_c ?? ''),
        option_d: String(q.option_d ?? ''),
        correct_option: (q.correct_option as 'a' | 'b' | 'c' | 'd') ?? 'a',
        marks: Number(q.marks) || 1,
      }));

      const newTheory: TheoryDraft[] = (data.theory_questions ?? []).map((q: Record<string, unknown>, i: number) => ({
        id: `theory-${Date.now()}-${i}`,
        question: String(q.question ?? ''),
        expected_answer: String(q.expected_answer ?? ''),
        marks: Number(q.marks) || 5,
      }));

      setMcqQuestions(newMcqs);
      setTheoryQuestions(newTheory);
      setHasGenerated(true);
      setHasUnsaved(true);
      await fetchUsage();
    } catch (e: unknown) {
      setGenerateError(e instanceof Error ? e.message : 'Generation failed. Please try again.');
    } finally {
      setGenerating(false);
    }
  }

  // ── Question mutations ──────────────────────────────────────────────────────
  function addBlankMCQ() {
    setMcqQuestions((prev) => [...prev, {
      id: `mcq-new-${Date.now()}`,
      question: '', option_a: '', option_b: '', option_c: '', option_d: '',
      correct_option: 'a', marks: 1,
    }]);
    setHasUnsaved(true);
  }

  function addBlankTheory() {
    setTheoryQuestions((prev) => [...prev, {
      id: `theory-new-${Date.now()}`,
      question: '', expected_answer: '', marks: 5,
    }]);
    setHasUnsaved(true);
  }

  function updateMCQ(id: string, updated: MCQDraft) {
    setMcqQuestions((prev) => prev.map((q) => q.id === id ? updated : q));
    setHasUnsaved(true);
  }

  function deleteMCQ(id: string) {
    setMcqQuestions((prev) => prev.filter((q) => q.id !== id));
    setHasUnsaved(true);
  }

  function updateTheory(id: string, updated: TheoryDraft) {
    setTheoryQuestions((prev) => prev.map((q) => q.id === id ? updated : q));
    setHasUnsaved(true);
  }

  function deleteTheory(id: string) {
    setTheoryQuestions((prev) => prev.filter((q) => q.id !== id));
    setHasUnsaved(true);
  }

  // ── Open save modal ─────────────────────────────────────────────────────────
  function openSaveModal() {
    setSaveError('');
    setSaveForm({
      title: '',
      subject_id: '',
      class: selectedClass,
      section: '',
      term: '',
      date: '',
      start_time: '',
      end_time: '',
      time_limit_minutes: '',
      shuffle_questions: true,
      shuffle_options: false,
    });
    setShowSaveModal(true);
  }

  // ── Save as test ────────────────────────────────────────────────────────────
  async function handleSaveTest() {
    setSaveError('');
    if (!saveForm.title.trim()) { setSaveError('Test title is required.'); return; }
    if (!saveForm.class) { setSaveError('Please select a class.'); return; }
    if (!saveForm.section) { setSaveError('Please select a section.'); return; }
    if (!saveForm.term.trim()) { setSaveError('Please enter a term.'); return; }
    if (mcqQuestions.length === 0 && theoryQuestions.length === 0) {
      setSaveError('Add at least one question before saving.'); return;
    }

    const token = getToken();
    if (!token) { setSaveError('Session expired.'); return; }

    setSaving(true);
    try {
      const res = await fetch(`${BASE_URL}/api/ai/save-test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: saveForm.title.trim(),
          subject_id: subject || saveForm.subject_id || 'General',
          class: saveForm.class,
          section: saveForm.section,
          term: saveForm.term.trim(),
          date: saveForm.date || null,
          available_from: saveForm.start_time || null,
          available_until: saveForm.end_time || null,
          time_limit_minutes: saveForm.time_limit_minutes ? parseInt(saveForm.time_limit_minutes) : 60,
          shuffle_questions: saveForm.shuffle_questions,
          shuffle_options: saveForm.shuffle_options,
          mcq_questions: mcqQuestions.map(({ id: _id, ...q }) => q),
          theory_questions: theoryQuestions.map(({ id: _id, ...q }) => q),
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to save test');

      setHasUnsaved(false);
      setShowSaveModal(false);
      showToast('Test created successfully');
      setTimeout(() => router.push('/teacher/tests'), 1200);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save test. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-3 bg-green-600 text-white text-sm font-medium rounded-xl shadow-lg flex items-center gap-2 animate-in slide-in-from-top-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {toast}
        </div>
      )}

      <PageHeader
        title="AI Teacher Assistant"
        description="Upload study material and generate exam questions instantly"
        action={
          <a href="/teacher/tests"
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            My Tests
          </a>
        }
      />

      {/* Two-panel layout */}
      <div className="flex flex-col lg:flex-row gap-6 items-start">

        {/* ── LEFT PANEL (40%) ─────────────────────────────────────────────── */}
        <div className="w-full lg:w-2/5 space-y-4">

          {/* STEP 1 — Upload */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-3 mb-4">
              <StepBadge n={1} active={uploadState !== 'done'} done={uploadState === 'done'} />
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Upload Study Material</h2>
                <p className="text-xs text-gray-400 mt-0.5">PDF, Word doc, or text file. AI generates from this content only.</p>
              </div>
            </div>

            {/* Drop zone */}
            {uploadState !== 'done' && (
              <div
                ref={dropRef}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center cursor-pointer transition-colors hover:border-blue-400 hover:bg-blue-50/30"
                role="button" aria-label="Upload file"
              >
                <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
                {uploadState === 'uploading' ? (
                  <div className="space-y-3">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                    <p className="text-sm text-gray-500">Extracting text…</p>
                    <div className="w-full bg-gray-200 rounded-full h-1.5">
                      <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="text-3xl mb-2">📄</div>
                    <p className="text-sm font-medium text-gray-700">Drop file here or click to browse</p>
                    <p className="text-xs text-gray-400 mt-1">.pdf, .docx, .txt · max 5 MB</p>
                  </>
                )}
              </div>
            )}

            {/* Upload error */}
            {uploadError && (
              <div className="mt-3 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-2">
                <span className="shrink-0 mt-0.5">⚠️</span> {uploadError}
                <button onClick={() => { setUploadError(''); setUploadState('idle'); }} className="ml-auto text-red-400 hover:text-red-600 shrink-0">✕</button>
              </div>
            )}

            {/* Upload success */}
            {uploadState === 'done' && uploadFile && (
              <div className="flex items-center justify-between px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-green-600 shrink-0">✓</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-green-800 truncate">{uploadFile.name}</p>
                    <p className="text-xs text-green-600">Content extracted · {totalChars.toLocaleString()} characters</p>
                  </div>
                </div>
                <button onClick={() => { setUploadState('idle'); setUploadFile(null); setExtractionId(''); setUploadError(''); }}
                  className="text-green-400 hover:text-green-600 shrink-0 ml-2 text-xs">Change</button>
              </div>
            )}
          </div>

          {/* STEP 2 — Configure (only shown after upload) */}
          {uploadDone && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
              <div className="flex items-center gap-3 mb-1">
                <StepBadge n={2} active={!hasGenerated} done={hasGenerated} />
                <h2 className="text-sm font-semibold text-gray-900">Configure Questions</h2>
              </div>

              {/* Subject — free-text with suggestions from assignments */}
              <FormField label="Subject" htmlFor="cfg-subject">
                <input
                  id="cfg-subject"
                  type="text"
                  list="cfg-subject-list"
                  className={inputClass}
                  placeholder="Type or select a subject…"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  autoComplete="off"
                />
                <datalist id="cfg-subject-list">
                  {mySubjects.map((s) => <option key={s} value={s} />)}
                </datalist>
              </FormField>

              {/* Class */}
              <FormField label="Class" htmlFor="cfg-class">
                <select id="cfg-class" className={inputClass} value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
                  <option value="">Select class…</option>
                  {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FormField>

              {/* Difficulty */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Difficulty</label>
                <div className="flex gap-2">
                  {DIFFICULTY_OPTIONS.map((d) => (
                    <button key={d} type="button" onClick={() => setDifficulty(d)}
                      className={`flex-1 py-2 text-sm font-medium rounded-lg border-2 capitalize transition-colors ${difficulty === d
                        ? d === 'easy' ? 'bg-green-600 text-white border-green-600'
                          : d === 'medium' ? 'bg-yellow-500 text-white border-yellow-500'
                          : 'bg-red-600 text-white border-red-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Test Type — MCQ or Theory (must choose one, no mixing) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Test Type <span className="text-red-500">*</span>
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setTestType('mcq')}
                    className={`flex-1 py-2.5 text-sm font-semibold rounded-lg border-2 transition-colors flex items-center justify-center gap-2 ${
                      testType === 'mcq'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                    }`}
                  >
                    <span>🔵</span> MCQ Only
                  </button>
                  <button
                    type="button"
                    onClick={() => setTestType('theory')}
                    className={`flex-1 py-2.5 text-sm font-semibold rounded-lg border-2 transition-colors flex items-center justify-center gap-2 ${
                      testType === 'theory'
                        ? 'bg-purple-600 text-white border-purple-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-purple-300'
                    }`}
                  >
                    <span>✍️</span> Theory Only
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1.5">Each test must be one type only — MCQ or Theory, not both.</p>
              </div>

              {/* MCQ count — only shown for MCQ test type */}
              {testType === 'mcq' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  MCQ Questions <span className="text-gray-400 font-normal">(1–30)</span>
                </label>
                <div className="flex items-center gap-3">
                  <input type="range" min={1} max={30} value={mcqCount} onChange={(e) => setMcqCount(parseInt(e.target.value))}
                    className="flex-1 accent-blue-600" />
                  <input type="number" min={1} max={30} value={mcqCount} onChange={(e) => setMcqCount(Math.min(30, Math.max(1, parseInt(e.target.value) || 1)))}
                    className="w-16 px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg text-center focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              )}

              {/* Theory count — only shown for Theory test type */}
              {testType === 'theory' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Theory Questions <span className="text-gray-400 font-normal">(1–10)</span>
                </label>
                <div className="flex items-center gap-3">
                  <input type="range" min={1} max={10} value={theoryCount} onChange={(e) => setTheoryCount(parseInt(e.target.value))}
                    className="flex-1 accent-purple-600" />
                  <input type="number" min={1} max={10} value={theoryCount} onChange={(e) => setTheoryCount(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
                    className="w-16 px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg text-center focus:outline-none focus:ring-2 focus:ring-purple-500" />
                </div>
              </div>
              )}

              {/* Usage indicator */}
              {usage && (
                <div className={`px-3 py-2.5 rounded-lg text-xs ${limitReached ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-gray-50 border border-gray-200 text-gray-600'}`}>
                  {limitReached
                    ? '⚠️ Daily limit reached. Resets at midnight.'
                    : `AI Generations today: ${usage.used} / ${usage.limit} · ${usage.remaining} remaining`}
                </div>
              )}

              {/* Generate error */}
              {generateError && (
                <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  {generateError}
                </div>
              )}

              {/* Generate button */}
              <button
                onClick={handleGenerate}
                disabled={generating || limitReached || !extractionId}
                className={`w-full py-3 disabled:bg-blue-300 text-white text-sm font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 ${
                  testType === 'theory'
                    ? 'bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300'
                    : 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300'
                }`}
              >
                {generating ? (
                  <><Spinner /> Generating… This takes 10–15 seconds</>
                ) : (
                  <><span>✨</span> Generate {testType === 'theory' ? 'Theory' : 'MCQ'} Questions</>
                )}
              </button>
            </div>
          )}
        </div>
        {/* END LEFT PANEL */}

        {/* ── RIGHT PANEL (60%) ────────────────────────────────────────────── */}
        <div className="w-full lg:w-3/5">
          {!hasGenerated ? (
            <div className="bg-white rounded-xl border border-gray-200">
              <EmptyState />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Header bar */}
              <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Generated Questions</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    MCQ: {mcqQuestions.length} · Theory: {theoryQuestions.length}
                    {hasUnsaved && <span className="ml-2 text-amber-600 font-medium">· Unsaved changes</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleGenerate}
                    disabled={generating || limitReached}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    {generating ? <Spinner /> : <span>🔄</span>}
                    Regenerate
                  </button>
                  <button
                    onClick={openSaveModal}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                    </svg>
                    Save as Test
                  </button>
                </div>
              </div>

              {/* MCQ Section */}
              {mcqQuestions.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
                      Multiple Choice Questions
                      <span className="text-xs font-normal text-gray-400">({mcqQuestions.length})</span>
                    </h3>
                  </div>
                  <div className="space-y-3">
                    {mcqQuestions.map((q, i) => (
                      <MCQCard key={q.id} q={q} index={i}
                        onChange={(updated) => updateMCQ(q.id, updated)}
                        onDelete={() => deleteMCQ(q.id)} />
                    ))}
                  </div>
                  <button onClick={addBlankMCQ}
                    className="w-full py-2.5 border-2 border-dashed border-blue-200 text-blue-600 text-sm font-medium rounded-xl hover:border-blue-400 hover:bg-blue-50/30 transition-colors flex items-center justify-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add MCQ Question
                  </button>
                </div>
              )}

              {/* Theory Section */}
              {theoryQuestions.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
                      Theory / Subjective Questions
                      <span className="text-xs font-normal text-gray-400">({theoryQuestions.length})</span>
                    </h3>
                  </div>
                  <div className="space-y-3">
                    {theoryQuestions.map((q, i) => (
                      <TheoryCard key={q.id} q={q} index={i}
                        onChange={(updated) => updateTheory(q.id, updated)}
                        onDelete={() => deleteTheory(q.id)} />
                    ))}
                  </div>
                  <button onClick={addBlankTheory}
                    className="w-full py-2.5 border-2 border-dashed border-purple-200 text-purple-600 text-sm font-medium rounded-xl hover:border-purple-400 hover:bg-purple-50/30 transition-colors flex items-center justify-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add Theory Question
                  </button>
                </div>
              )}

              {/* If both sections are empty after deleting all */}
              {mcqQuestions.length === 0 && theoryQuestions.length === 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
                  <p className="text-sm text-gray-400 text-center py-4">All questions deleted. Add new ones below.</p>
                  <div className="flex gap-3">
                    <button onClick={addBlankMCQ}
                      className="flex-1 py-2.5 border-2 border-dashed border-blue-200 text-blue-600 text-sm font-medium rounded-xl hover:border-blue-400 transition-colors">
                      + Add MCQ
                    </button>
                    <button onClick={addBlankTheory}
                      className="flex-1 py-2.5 border-2 border-dashed border-purple-200 text-purple-600 text-sm font-medium rounded-xl hover:border-purple-400 transition-colors">
                      + Add Theory
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {/* END RIGHT PANEL */}
      </div>

      {/* ── Save as Test Modal ──────────────────────────────────────────────── */}
      <Modal open={showSaveModal} onClose={() => { if (!saving) setShowSaveModal(false); }} title="Save as Test" size="lg">
        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          {saveError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{saveError}</div>
          )}

          <FormField label="Test Title" htmlFor="save-title" required>
            <input id="save-title" type="text" className={inputClass} placeholder="e.g. Chapter 5 — Mid-Term Test"
              value={saveForm.title} onChange={(e) => setSaveForm((f) => ({ ...f, title: e.target.value }))} />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Class" htmlFor="save-class" required>
              <select id="save-class" className={inputClass} value={saveForm.class}
                onChange={(e) => setSaveForm((f) => ({ ...f, class: e.target.value, section: '' }))}>
                <option value="">Select…</option>
                {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>
            <FormField label="Section" htmlFor="save-section" required>
              <select id="save-section" className={inputClass} disabled={!saveForm.class} value={saveForm.section}
                onChange={(e) => setSaveForm((f) => ({ ...f, section: e.target.value }))}>
                <option value="">Select…</option>
                {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Term" htmlFor="save-term" required>
              <input
                id="save-term"
                type="text"
                list="term-suggestions"
                className={inputClass}
                placeholder="e.g. Term 1, Semester 2, Annual…"
                value={saveForm.term}
                onChange={(e) => setSaveForm((f) => ({ ...f, term: e.target.value }))}
                autoComplete="off"
              />
              <datalist id="term-suggestions">
                {TERM_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
              </datalist>
            </FormField>
            <FormField label="Date" htmlFor="save-date">
              <input id="save-date" type="date" className={inputClass} value={saveForm.date}
                onChange={(e) => setSaveForm((f) => ({ ...f, date: e.target.value }))} />
            </FormField>
          </div>

          <FormField label="Time Limit (minutes)" htmlFor="save-time">
            <input id="save-time" type="number" min={1} step={1} className={inputClass} placeholder="e.g. 60"
              value={saveForm.time_limit_minutes}
              onChange={(e) => setSaveForm((f) => ({ ...f, time_limit_minutes: e.target.value }))} />
          </FormField>

          <div>
            <p className="text-sm font-medium text-gray-700 mb-1.5">Test Window <span className="text-xs font-normal text-gray-400">(optional)</span></p>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Opens at" htmlFor="save-start-time">
                <input id="save-start-time" type="time" className={inputClass} value={saveForm.start_time}
                  onChange={(e) => setSaveForm((f) => ({ ...f, start_time: e.target.value }))} />
              </FormField>
              <FormField label="Closes at" htmlFor="save-end-time">
                <input id="save-end-time" type="time" className={inputClass} value={saveForm.end_time}
                  onChange={(e) => setSaveForm((f) => ({ ...f, end_time: e.target.value }))} />
              </FormField>
            </div>
            <p className="text-xs text-gray-400 mt-1">e.g. 9:00 PM – 10:00 PM. Students who enter at 9:58 PM still get the full time limit.</p>
          </div>

          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between">
              <div>
                <label htmlFor="save-shuffle-q" className="text-sm font-medium text-gray-700">Shuffle Questions</label>
                <p className="text-xs text-gray-400">Randomise order for each student</p>
              </div>
              <Toggle id="save-shuffle-q" checked={saveForm.shuffle_questions}
                onChange={(v) => setSaveForm((f) => ({ ...f, shuffle_questions: v }))} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <label htmlFor="save-shuffle-o" className="text-sm font-medium text-gray-700">Shuffle Options</label>
                <p className="text-xs text-gray-400">Randomise MCQ option order</p>
              </div>
              <Toggle id="save-shuffle-o" checked={saveForm.shuffle_options}
                onChange={(v) => setSaveForm((f) => ({ ...f, shuffle_options: v }))} />
            </div>
          </div>

          <div className="pt-1 border-t border-gray-100">
            <p className="text-xs text-gray-400 mb-3">
              {mcqQuestions.length} MCQ · {theoryQuestions.length} Theory · {mcqQuestions.length + theoryQuestions.length} total questions
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowSaveModal(false)} disabled={saving}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors">
                Cancel
              </button>
              <button onClick={handleSaveTest} disabled={saving}
                className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
                {saving ? <><Spinner /> Saving…</> : 'Confirm Save'}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
