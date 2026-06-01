'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 'configure' | 'upload' | 'preview' | 'success';

const EXAM_TYPES = ['unit_test', 'mid_term', 'final', 'class_test'] as const;
const EXAM_LABELS: Record<string, string> = {
  unit_test: 'Unit Test', mid_term: 'Mid Term', final: 'Final', class_test: 'Class Test',
};
const TERMS = ['term_1', 'term_2', 'term_3'] as const;
const TERM_LABELS: Record<string, string> = { term_1: 'Term 1', term_2: 'Term 2', term_3: 'Term 3' };

// Subject names come from teacher_assignments — no separate subjects table needed

interface MarksPreviewRow {
  roll_number: string;
  student_name: string;
  score: number | null;
  max_score: number;
  percentage: number | null;
  status: 'valid' | 'invalid' | 'will_update';
  errors: string[];
}

interface PreviewResult {
  session_id: string;
  test_name: string;
  class: string;
  section: string;
  subject_name: string;
  exam_type: string;
  term: string;
  total_students: number;
  valid_rows: number;
  invalid_rows: number;
  will_update_rows: number;
  rows: MarksPreviewRow[];
}

interface ImportResult {
  imported: number;
  updated: number;
  errors: string[];
}

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS: { key: Step; label: string }[] = [
  { key: 'configure', label: 'Configure' },
  { key: 'upload', label: 'Upload' },
  { key: 'preview', label: 'Preview' },
  { key: 'success', label: 'Done' },
];

function StepIndicator({ current }: { current: Step }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="flex items-center gap-0 mb-6">
      {STEPS.map((step, idx) => {
        const done = idx < currentIdx;
        const active = idx === currentIdx;
        return (
          <div key={step.key} className="flex items-center">
            <div className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                done ? 'bg-green-500 text-white' : active ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'
              }`}>
                {done ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                ) : idx + 1}
              </div>
              <span className={`mt-1 text-xs font-medium ${active ? 'text-blue-600' : done ? 'text-green-600' : 'text-gray-400'}`}>
                {step.label}
              </span>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={`h-0.5 w-12 sm:w-20 mx-1 mb-4 transition-colors ${idx < currentIdx ? 'bg-green-400' : 'bg-gray-200'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status, errors }: { status: MarksPreviewRow['status']; errors: string[] }) {
  const map = {
    valid: 'bg-green-100 text-green-700',
    will_update: 'bg-blue-100 text-blue-700',
    invalid: 'bg-red-100 text-red-700',
  };
  const label = { valid: 'New', will_update: 'Update', invalid: 'Invalid' };
  const dot = { valid: 'bg-green-500', will_update: 'bg-blue-500', invalid: 'bg-red-500' };

  return (
    <div className="relative group inline-block">
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${map[status]}`}>
        <span className={`w-1.5 h-1.5 rounded-full inline-block ${dot[status]}`} />
        {label[status]}
      </span>
      {errors.length > 0 && (
        <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block w-56 bg-gray-900 text-white text-xs rounded-lg p-2 shadow-lg">
          {errors.map((e, i) => <p key={i}>{e}</p>)}
        </div>
      )}
    </div>
  );
}

// ── Drop zone ─────────────────────────────────────────────────────────────────

function DropZone({ file, onFile }: { file: File | null; onFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) onFile(f);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) onFile(f);
  }

  function formatSize(bytes: number) {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
        dragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
      }`}
    >
      <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleChange} />
      {file ? (
        <div className="flex flex-col items-center gap-2">
          <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-900">{file.name}</p>
          <p className="text-xs text-gray-500">{formatSize(file.size)} · Click to change</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-700">Drag & drop your filled template here</p>
            <p className="text-xs text-gray-500 mt-1">or click to browse</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span className="px-2 py-0.5 bg-gray-100 rounded">.xlsx</span>
            <span className="px-2 py-0.5 bg-gray-100 rounded">.xls</span>
            <span>· Max 2 MB</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function MarksImportPage() {
  const router = useRouter();
  const { user } = useAuth();

  // ── Assignments ─────────────────────────────────────────────────────────────
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // ── Step 1 — Configure ──────────────────────────────────────────────────────
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [subject, setSubject] = useState('');
  const [customSubject, setCustomSubject] = useState('');
  const [useCustomSubject, setUseCustomSubject] = useState(false);
  const [examType, setExamType] = useState<typeof EXAM_TYPES[number]>('unit_test');
  const [term, setTerm] = useState<typeof TERMS[number]>('term_1');
  const [testName, setTestName] = useState('');
  const [testDate, setTestDate] = useState('');
  const [configError, setConfigError] = useState('');
  const [downloading, setDownloading] = useState(false);

  // ── Step 2 — Upload ─────────────────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // ── Step 3 — Preview ────────────────────────────────────────────────────────
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');

  // ── Step 4 — Success ────────────────────────────────────────────────────────
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const [step, setStep] = useState<Step>('configure');

  // ── Load assignments only ───────────────────────────────────────────────────

  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    assignmentsApi.list(token, user.school_id)
      .then((res) => {
        setAssignments(res.data.filter((a) => a.teacher_id === user.id));
      })
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  // ── Derived dropdowns ───────────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === filterClass).map((a) => a.section)
  )].sort();
  const subjectsForClassSection = [...new Set(
    assignments
      .filter((a) => a.class_name === filterClass && a.section === filterSection)
      .map((a) => a.subject)
  )].sort();

  // The effective subject name (from dropdown or custom text input)
  const effectiveSubject = useCustomSubject ? customSubject.trim() : subject;

  // ── Download template ───────────────────────────────────────────────────────

  const handleDownloadTemplate = useCallback(async () => {
    if (!filterClass || !filterSection || !effectiveSubject || !examType || !term) {
      setConfigError('Please fill in all fields before downloading the template.');
      return;
    }
    setConfigError('');
    const token = getToken();
    if (!token) return;
    setDownloading(true);
    try {
      const qs = new URLSearchParams({
        class: filterClass,
        section: filterSection,
        subject: effectiveSubject,
        exam_type: examType,
        term,
      });
      const res = await fetch(`${BASE_URL}/api/import/marks/template?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message ?? 'Download failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `marks_template_${filterClass}${filterSection}_${effectiveSubject}_${examType}_${term}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setConfigError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }, [filterClass, filterSection, effectiveSubject, examType, term]);

  function handleProceedToUpload() {
    if (!filterClass || !filterSection || !effectiveSubject || !examType || !term || !testName.trim() || !testDate) {
      setConfigError('Please fill in all required fields.');
      return;
    }
    setConfigError('');
    setStep('upload');
  }

  // ── Preview import ──────────────────────────────────────────────────────────

  const handlePreview = useCallback(async () => {
    if (!file) return;
    const token = getToken();
    if (!token) return;
    setUploadError('');
    setPreviewing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('class', filterClass);
      fd.append('section', filterSection);
      fd.append('subject', effectiveSubject);
      fd.append('exam_type', examType);
      fd.append('term', term);
      fd.append('test_name', testName.trim());
      fd.append('date', testDate);

      const res = await fetch(`${BASE_URL}/api/import/marks/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Preview failed');
      setPreview(json.data as PreviewResult);
      setStep('preview');
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }, [file, filterClass, filterSection, effectiveSubject, examType, term, testName, testDate]);

  // ── Confirm import ──────────────────────────────────────────────────────────

  async function handleImport() {
    if (!preview?.session_id) return;
    const token = getToken();
    if (!token) return;
    setImporting(true);
    setImportError('');
    try {
      const res = await fetch(`${BASE_URL}/api/import/marks/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: preview.session_id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Import failed');
      setImportResult(json.data as ImportResult);
      setStep('success');
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  // ── Reset ───────────────────────────────────────────────────────────────────

  function handleReset() {
    setStep('configure');
    setFile(null);
    setPreview(null);
    setImportResult(null);
    setConfigError('');
    setUploadError('');
    setImportError('');
    setSubject('');
    setCustomSubject('');
    setUseCustomSubject(false);
  }

  // ── Row color ───────────────────────────────────────────────────────────────

  function rowBg(status: MarksPreviewRow['status']) {
    if (status === 'valid') return 'bg-green-50/40';
    if (status === 'will_update') return 'bg-blue-50/40';
    return 'bg-red-50/40';
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Import Marks"
        description="Bulk import student marks from an Excel template"
      />

      <StepIndicator current={step} />

      {/* ── STEP 1: Configure ─────────────────────────────────────────────── */}
      {step === 'configure' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 max-w-2xl space-y-5">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Step 1 — Configure Test Details</h2>
            <p className="mt-1 text-sm text-gray-500">Select the class, subject, and test details, then download the pre-filled template.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Class" htmlFor="mi-class" required>
              <select id="mi-class" className={inputClass} disabled={loadingAssignments}
                value={filterClass}
                onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setSubject(''); }}>
                <option value="">{loadingAssignments ? 'Loading…' : 'Select class…'}</option>
                {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>

            <FormField label="Section" htmlFor="mi-section" required>
              <select id="mi-section" className={inputClass} disabled={!filterClass}
                value={filterSection}
                onChange={(e) => { setFilterSection(e.target.value); setSubject(''); }}>
                <option value="">Select section…</option>
                {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>

            <FormField label="Subject" htmlFor="mi-subject" required>
              {!useCustomSubject ? (
                <div className="space-y-1.5">
                  <select id="mi-subject" className={inputClass} disabled={!filterSection}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}>
                    <option value="">{!filterSection ? 'Select section first…' : 'Select subject…'}</option>
                    {subjectsForClassSection.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button type="button" onClick={() => { setUseCustomSubject(true); setSubject(''); }}
                    className="text-xs text-blue-600 hover:underline">
                    + Type a different subject
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <input id="mi-subject" type="text" className={inputClass}
                    placeholder="e.g. Mathematics"
                    value={customSubject}
                    onChange={(e) => setCustomSubject(e.target.value)} />
                  <button type="button" onClick={() => { setUseCustomSubject(false); setCustomSubject(''); }}
                    className="text-xs text-gray-500 hover:underline">
                    ← Pick from assigned subjects
                  </button>
                </div>
              )}
            </FormField>

            <FormField label="Exam Type" htmlFor="mi-examtype" required>
              <select id="mi-examtype" className={inputClass}
                value={examType}
                onChange={(e) => setExamType(e.target.value as typeof EXAM_TYPES[number])}>
                {EXAM_TYPES.map((t) => <option key={t} value={t}>{EXAM_LABELS[t]}</option>)}
              </select>
            </FormField>

            <FormField label="Term" htmlFor="mi-term" required>
              <select id="mi-term" className={inputClass}
                value={term}
                onChange={(e) => setTerm(e.target.value as typeof TERMS[number])}>
                {TERMS.map((t) => <option key={t} value={t}>{TERM_LABELS[t]}</option>)}
              </select>
            </FormField>

            <FormField label="Test Name" htmlFor="mi-testname" required>
              <input id="mi-testname" type="text" className={inputClass}
                placeholder="e.g. Chapter 3 Test"
                value={testName}
                onChange={(e) => setTestName(e.target.value)} />
            </FormField>

            <FormField label="Test Date" htmlFor="mi-date" required>
              <input id="mi-date" type="date" className={inputClass}
                value={testDate}
                onChange={(e) => setTestDate(e.target.value)} />
            </FormField>
          </div>

          {configError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{configError}</div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button onClick={handleDownloadTemplate} disabled={downloading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors">
              {downloading ? (
                <span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              )}
              Download Template
            </button>
            <button onClick={handleProceedToUpload}
              className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
              Next: Upload
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 2: Upload ─────────────────────────────────────────────────── */}
      {step === 'upload' && (
        <div className="max-w-2xl space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Step 2 — Upload Filled Template</h2>
            <p className="text-sm text-gray-500 mb-4">
              Upload the completed Excel file for{' '}
              <span className="font-medium text-gray-700">{filterClass} · {filterSection} · {testName}</span>
            </p>

            <DropZone file={file} onFile={setFile} />

            {uploadError && (
              <div className="mt-3 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{uploadError}</div>
            )}

            <div className="mt-4 flex items-center justify-between">
              <button onClick={() => setStep('configure')}
                className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                ← Back
              </button>
              <button onClick={handlePreview} disabled={!file || previewing}
                className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors">
                {previewing ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Validating marks…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    Preview Import
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 3: Preview ────────────────────────────────────────────────── */}
      {step === 'preview' && preview && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-xl font-bold text-green-700">{preview.valid_rows}</p>
                <p className="text-xs text-green-600">Valid new entries</p>
              </div>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
              <div>
                <p className="text-xl font-bold text-blue-700">{preview.will_update_rows}</p>
                <p className="text-xs text-blue-600">Will update existing</p>
              </div>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <div>
                <p className="text-xl font-bold text-red-700">{preview.invalid_rows}</p>
                <p className="text-xs text-red-600">Invalid (will be skipped)</p>
              </div>
            </div>
          </div>

          {/* Preview table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">
                {preview.class} · {preview.section} — {preview.subject_name} · {EXAM_LABELS[preview.exam_type]} · {TERM_LABELS[preview.term]}
              </h3>
              <span className="text-xs text-gray-500">{preview.total_students} students</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Roll No', 'Name', 'Score', 'Max Score', '%', 'Status'].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {preview.rows.map((row, idx) => (
                    <tr key={idx} className={`transition-colors hover:brightness-95 ${rowBg(row.status)}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-600">{row.roll_number}</td>
                      <td className="px-4 py-2.5 font-medium text-gray-900 whitespace-nowrap">{row.student_name}</td>
                      <td className="px-4 py-2.5 text-gray-700">{row.score ?? '—'}</td>
                      <td className="px-4 py-2.5 text-gray-700">{row.max_score}</td>
                      <td className="px-4 py-2.5 text-gray-700">
                        {row.percentage !== null ? `${row.percentage}%` : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={row.status} errors={row.errors} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {importError && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{importError}</div>
          )}

          {/* Action bar */}
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-4 flex items-center justify-between gap-4">
            <button onClick={() => setStep('upload')}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              ← Back
            </button>
            <button
              onClick={handleImport}
              disabled={(preview.valid_rows + preview.will_update_rows) === 0 || importing}
              className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors">
              {importing ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Importing…
                </>
              ) : (
                `Import Marks (${preview.valid_rows + preview.will_update_rows} rows)`
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 4: Success ────────────────────────────────────────────────── */}
      {step === 'success' && importResult && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-6">
            <svg className="w-10 h-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {importResult.imported + importResult.updated} marks imported successfully
          </h2>
          <p className="text-sm text-gray-500 mb-2">
            {importResult.imported} new{importResult.updated > 0 ? `, ${importResult.updated} updated` : ''}
          </p>
          {importResult.errors.length > 0 && (
            <p className="text-xs text-orange-600 mb-4">
              {importResult.errors.length} row{importResult.errors.length !== 1 ? 's' : ''} had errors and were skipped
            </p>
          )}
          <div className="flex items-center gap-3 mt-4 flex-wrap justify-center">
            <button onClick={handleReset}
              className="px-5 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Import More
            </button>
            <button onClick={() => router.push('/teacher/marks')}
              className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
              View Class Marks
            </button>
          </div>
        </div>
      )}
    </>
  );
}
