'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 'upload' | 'preview' | 'success';
type TabFilter = 'all' | 'valid' | 'invalid' | 'duplicate';

interface PreviewRow {
  row_number: number;
  data: {
    name: string;
    roll_number: string | null;
    class: string;
    division: string;
    parent_name: string;
    parent_phone: string;
    student_phone?: string | null;
    login_phone?: string;
    parent_email: string;
  };
  status: 'valid' | 'invalid' | 'duplicate';
  warning: string | null;
  errors: string[];
}

interface PreviewResult {
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  warned_rows: number;
  rows: PreviewRow[];
  import_session_id: string;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors?: string[];
}

// ── Column guide data ─────────────────────────────────────────────────────────

const COLUMNS = [
  { name: 'Student Name',              required: true,  note: 'Full name of the student' },
  { name: 'Roll No (Optional)',         required: false, note: 'Unique roll number within the class — leave blank if not used' },
  { name: 'Class',                      required: true,  note: 'e.g. Grade 5, Class 10' },
  { name: 'Division',                   required: true,  note: 'Section/Division e.g. A, B' },
  { name: 'Parent Name',                required: false, note: 'Full name of parent/guardian' },
  { name: 'Parent Phone',               required: true,  note: '10-digit parent phone — used for WhatsApp notifications; also login if no student phone' },
  { name: 'Student Phone (Optional)',   required: false, note: '10-digit student phone — if entered, student logs in with this number instead of parent phone' },
  { name: 'Parent Email (Optional)',    required: false, note: 'Used to send parent invite' },
];

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({
  status,
  warning,
  errors,
}: {
  status: PreviewRow['status'];
  warning: string | null;
  errors: string[];
}) {
  // If valid but has a phone warning → show orange warning badge
  if (status === 'valid' && warning) {
    return (
      <div className="relative group inline-block">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700 cursor-help">
          <span className="w-1.5 h-1.5 rounded-full inline-block bg-orange-500" />
          ⚠ Duplicate phone
        </span>
        <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block w-72 bg-gray-900 text-white text-xs rounded-lg p-2 shadow-lg">
          {warning}
        </div>
      </div>
    );
  }

  const map = {
    valid:     'bg-green-100 text-green-700',
    invalid:   'bg-red-100 text-red-700',
    duplicate: 'bg-orange-100 text-orange-700',
  };
  const label = { valid: 'Valid', invalid: 'Invalid', duplicate: 'Duplicate' };

  return (
    <div className="relative group inline-block">
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${map[status]}`}>
        <span className={`w-1.5 h-1.5 rounded-full inline-block ${
          status === 'valid' ? 'bg-green-500' : status === 'invalid' ? 'bg-red-500' : 'bg-orange-500'
        }`} />
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

// ── Drag-and-drop upload zone ─────────────────────────────────────────────────

function DropZone({
  file,
  onFile,
}: {
  file: File | null;
  onFile: (f: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && isValidFile(f)) onFile(f);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && isValidFile(f)) onFile(f);
  }

  function isValidFile(f: File) {
    return f.name.endsWith('.xlsx') || f.name.endsWith('.xls');
  }

  function formatSize(bytes: number) {
    return bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
            <p className="text-sm font-medium text-gray-700">Drag & drop your file here</p>
            <p className="text-xs text-gray-500 mt-1">or click to browse</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span className="px-2 py-0.5 bg-gray-100 rounded">.xlsx</span>
            <span className="px-2 py-0.5 bg-gray-100 rounded">.xls</span>
            <span>· Max 5 MB</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page component ───────────────────────────────────────────────────────

export default function ImportStudentsPage() {
  const router = useRouter();

  // ── State ───────────────────────────────────────────────────────────────
  const [step, setStep]                     = useState<Step>('upload');
  const [file, setFile]                     = useState<File | null>(null);
  const [previewing, setPreviewing]         = useState(false);
  const [previewProgress, setPreviewProgress] = useState('');
  const [preview, setPreview]               = useState<PreviewResult | null>(null);
  const [tab, setTab]                       = useState<TabFilter>('all');
  const [showPhoneConfirm, setShowPhoneConfirm] = useState(false);
  const [importing, setImporting]           = useState(false);
  const [importResult, setImportResult]     = useState<ImportResult | null>(null);
  const [error, setError]                   = useState('');

  // ── Download template ───────────────────────────────────────────────────

  async function handleDownloadTemplate() {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${BASE_URL}/api/import/students/template`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to download template');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'student_import_template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Download failed');
    }
  }

  // ── Preview import ──────────────────────────────────────────────────────

  const handlePreview = useCallback(async () => {
    if (!file) return;
    const token = getToken();
    if (!token) return;
    setError('');
    setPreviewing(true);
    setPreviewProgress('Uploading file…');

    try {
      const formData = new FormData();
      formData.append('file', file);

      setPreviewProgress('Validating rows…');
      const res = await fetch(`${BASE_URL}/api/import/students/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Preview failed');

      setPreview(json.data as PreviewResult);
      setTab('all');
      setStep('preview');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
      setPreviewProgress('');
    }
  }, [file]);


  // ── Run the actual import ───────────────────────────────────────────────

  async function handleImport(skipWarned = false) {
    if (!preview?.import_session_id) return;
    const token = getToken();
    if (!token) return;
    setShowPhoneConfirm(false);
    setImporting(true);
    setError('');

    try {
      const res = await fetch(`${BASE_URL}/api/import/students/confirm`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          import_session_id: preview.import_session_id,
          skip_warned: skipWarned,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Import failed');

      setImportResult(json.data as ImportResult);
      setStep('success');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  // ── Reset ───────────────────────────────────────────────────────────────

  function handleReset() {
    setStep('upload');
    setFile(null);
    setPreview(null);
    setImportResult(null);
    setError('');
    setTab('all');
  }

  // ── Filtered rows ───────────────────────────────────────────────────────

  const filteredRows = preview?.rows.filter((r) =>
    tab === 'all' ? true : r.status === tab
  ) ?? [];

  // Count warned rows directly from row data (more reliable than API field)
  const warnedCount = preview?.rows.filter((r) => r.status === 'valid' && r.warning).length ?? 0;

  // ── Trigger confirm flow (check for phone warnings first) ──────────────

  function handleConfirmClick() {
    if (!preview) return;
    if (warnedCount > 0) {
      setShowPhoneConfirm(true);
    } else {
      handleImport();
    }
  }

  return (
    <>
      <PageHeader
        title="Import Students"
        description="Bulk import students from an Excel spreadsheet"
      />

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center gap-2">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
        </div>
      )}

      {/* ── Step 1 + 2: Upload ─────────────────────────────────────────── */}
      {step === 'upload' && (
        <div className="space-y-6">
          {/* Download template card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-gray-900">Step 1 — Download Student Import Template</h2>
                <p className="mt-1 text-sm text-gray-500">Fill this Excel template with your student data, then upload it below.</p>

                {/* Column guide */}
                <div className="mt-4 overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-1.5 pr-4 font-semibold text-gray-600">Column</th>
                        <th className="text-left py-1.5 pr-4 font-semibold text-gray-600">Required</th>
                        <th className="text-left py-1.5 font-semibold text-gray-600">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {COLUMNS.map((col) => (
                        <tr key={col.name}>
                          <td className="py-1.5 pr-4 font-medium text-gray-800">{col.name}</td>
                          <td className="py-1.5 pr-4">
                            {col.required
                              ? <span className="text-red-600 font-medium">Required</span>
                              : <span className="text-gray-400">Optional</span>}
                          </td>
                          <td className="py-1.5 text-gray-500">{col.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <button
                  onClick={handleDownloadTemplate}
                  className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download Template
                </button>
              </div>
            </div>
          </div>

          {/* Upload card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Step 2 — Upload Filled Template</h2>
            <p className="text-sm text-gray-500 mb-4">Select your completed Excel file to validate and preview before importing.</p>

            <DropZone file={file} onFile={setFile} />

            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-gray-400">Accepted: .xlsx, .xls · Max size: 5 MB</p>
              <button
                onClick={handlePreview}
                disabled={!file || previewing}
                className="inline-flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {previewing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {previewProgress || 'Validating…'}
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

      {/* ── Step 3: Preview ────────────────────────────────────────────── */}
      {step === 'preview' && preview && (
        <div className="space-y-4">

          {/* ── Phone warning inline confirmation (shown instead of table when triggered) ── */}
          {showPhoneConfirm && (
            <div className="bg-amber-50 border-2 border-amber-400 rounded-xl px-6 py-6">
              <div className="flex items-start gap-4 mb-5">
                <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div>
                  <p className="text-base font-semibold text-amber-900">
                    {warnedCount} student{warnedCount !== 1 ? 's have' : ' has'} a phone number already linked to another student.
                  </p>
                  <p className="text-sm text-amber-800 mt-1">
                    This is okay if they are siblings sharing a parent&apos;s phone. Do you want to import them anyway?
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowPhoneConfirm(false)}
                  className="px-5 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  No, Go Back
                </button>
                <button
                  onClick={() => handleImport(true)}
                  disabled={importing}
                  className="px-5 py-2.5 text-sm font-medium text-gray-700 bg-white border border-amber-400 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  Skip them, import rest
                </button>
                <button
                  onClick={() => handleImport(false)}
                  disabled={importing}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {importing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Importing…
                    </>
                  ) : (
                    'Yes, Import All'
                  )}
                </button>
              </div>
            </div>
          )}
          {/* Summary bar */}
          <div className={`grid gap-3 ${warnedCount > 0 ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-xl font-bold text-green-700">{preview.valid_rows}</p>
                <p className="text-xs text-green-600">Valid — ready to import</p>
              </div>
            </div>

            {warnedCount > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center gap-3">
                <div className="w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div>
                  <p className="text-xl font-bold text-amber-700">{warnedCount}</p>
                  <p className="text-xs text-amber-600">Phone warnings (will still import)</p>
                </div>
              </div>
            )}

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

            <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 bg-orange-100 rounded-full flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <p className="text-xl font-bold text-orange-700">{preview.duplicate_rows}</p>
                <p className="text-xs text-orange-600">Duplicates (will be skipped)</p>
              </div>
            </div>
          </div>

          {/* Tab switcher + table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-gray-100 px-4 pt-4 gap-1">
              {(['all', 'valid', 'invalid', 'duplicate'] as TabFilter[]).map((t) => {
                const count =
                  t === 'all'       ? preview.total_rows
                  : t === 'valid'   ? preview.valid_rows
                  : t === 'invalid' ? preview.invalid_rows
                  : preview.duplicate_rows;
                const active = tab === t;
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors capitalize ${
                      active
                        ? 'border-blue-600 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1)}
                    <span className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${
                      active ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'
                    }`}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Row #', 'Student Name', 'Roll No', 'Class', 'Division', 'Parent Name', 'Parent Phone', 'Student Phone', 'Status', 'Warning', 'Errors'].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="text-center py-10 text-sm text-gray-400">No rows in this category</td>
                    </tr>
                  ) : filteredRows.map((row) => (
                    <tr
                      key={row.row_number}
                      className={`hover:bg-gray-50 transition-colors ${
                        row.status !== 'valid'    ? 'bg-red-50/30'
                        : row.warning             ? 'bg-amber-50/40'
                        : ''
                      }`}
                    >
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{row.row_number}</td>
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{row.data.name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.data.roll_number || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.data.class || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.data.division || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.data.parent_name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.data.parent_phone || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.data.student_phone || '—'}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={row.status} warning={row.warning} errors={row.errors} />
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        {row.warning ? (
                          <div className="relative group inline-block">
                            <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded cursor-help truncate max-w-[180px] block">
                              ⚠ Phone already in use
                            </span>
                            <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block w-72 bg-gray-900 text-white text-xs rounded-lg p-2 shadow-lg">
                              {row.warning}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        {row.errors.length > 0 ? (
                          <p className="text-xs text-red-600 truncate" title={row.errors.join('; ')}>
                            {row.errors[0]}{row.errors.length > 1 ? ` (+${row.errors.length - 1} more)` : ''}
                          </p>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bottom action bar */}
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-4 flex items-center justify-between gap-4">
            <div className="text-xs text-gray-500">
              <span className="text-green-700 font-semibold">{preview.valid_rows} valid</span>
              {warnedCount > 0 && (
                <span className="text-amber-700 font-semibold">, {warnedCount} with warnings (will still be imported)</span>
              )}
              {preview.duplicate_rows > 0 && (
                <span className="text-orange-600">, {preview.duplicate_rows} duplicate{preview.duplicate_rows !== 1 ? 's' : ''} (will be skipped)</span>
              )}
              {preview.invalid_rows > 0 && (
                <span className="text-red-600">, {preview.invalid_rows} invalid (will be skipped)</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleReset}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmClick}
                disabled={preview.valid_rows === 0 || importing}
                className="inline-flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {importing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Importing…
                  </>
                ) : (
                  `Import ${preview.valid_rows} Valid Student${preview.valid_rows !== 1 ? 's' : ''}`
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 4: Success ────────────────────────────────────────────── */}
      {step === 'success' && importResult && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className={`w-20 h-20 ${importResult.imported > 0 ? 'bg-green-100' : 'bg-red-100'} rounded-full flex items-center justify-center mb-6`}>
            <svg className={`w-10 h-10 ${importResult.imported > 0 ? 'text-green-600' : 'text-red-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {importResult.imported > 0
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />}
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {importResult.imported} student{importResult.imported !== 1 ? 's' : ''} imported successfully
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            {importResult.skipped > 0
              ? `${importResult.skipped} row${importResult.skipped !== 1 ? 's' : ''} skipped`
              : 'All rows were imported successfully'}
          </p>
          {/* Show insert errors so admin can diagnose failures */}
          {importResult.errors && importResult.errors.length > 0 && (
            <div className="w-full max-w-2xl mb-8 text-left bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm font-semibold text-red-700 mb-2">Insert errors ({importResult.errors.length}):</p>
              <ul className="space-y-1">
                {importResult.errors.map((e, i) => (
                  <li key={i} className="text-xs text-red-600 font-mono">{e}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap justify-center">
            <button
              onClick={handleReset}
              className="px-5 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Import More
            </button>
            <button
              onClick={() => router.push('/admin/students')}
              className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              View Students
            </button>
          </div>
        </div>
      )}

      {/* modals removed — confirmation is now inline */}
    </>
  );
}
