'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 'upload' | 'preview' | 'success';
type TabFilter = 'all' | 'valid' | 'invalid' | 'duplicate';

// Shape returned by the backend preview endpoint
interface PreviewRow {
  row_number: number;
  data: {
    name: string;
    email: string;
    phone: string;
    subject: string;
    assigned_classes: string;
  };
  status: 'valid' | 'invalid' | 'duplicate';
  errors: string[];
}

interface PreviewResult {
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  rows: PreviewRow[];
  import_session_id: string;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors?: string[];
}

// ── Column guide — matches new template format ────────────────────────────────

const COLUMNS = [
  { name: 'name',     required: true,  note: 'Full name of the teacher' },
  { name: 'email',    required: true,  note: 'Email address — used as login username' },
  { name: 'phone',    required: true,  note: 'Phone number — auto-set as default password' },
  { name: 'class',    required: false, note: 'Class number e.g. 10' },
  { name: 'division', required: false, note: 'Division / section e.g. A' },
  { name: 'subject',  required: false, note: 'Subject they teach e.g. Maths' },
];

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status, errors }: { status: PreviewRow['status']; errors: string[] }) {
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
        <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block w-64 bg-gray-900 text-white text-xs rounded-lg p-2 shadow-lg">
          {errors.map((e, i) => <p key={i}>{e}</p>)}
        </div>
      )}
    </div>
  );
}

// ── Drag-and-drop upload zone ─────────────────────────────────────────────────

function DropZone({ file, onFile }: { file: File | null; onFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && isValid(f)) onFile(f);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && isValid(f)) onFile(f);
  }

  function isValid(f: File) { return f.name.endsWith('.xlsx') || f.name.endsWith('.xls'); }

  function fmtSize(b: number) {
    return b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;
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
          <p className="text-xs text-gray-500">{fmtSize(file.size)} · Click to change</p>
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

export default function ImportTeachersPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewProgress, setPreviewProgress] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [tab, setTab] = useState<TabFilter>('all');
  const [showConfirm, setShowConfirm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');

  // ── Download template ───────────────────────────────────────────────────

  async function handleDownloadTemplate() {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${BASE_URL}/api/import/teachers/template`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to download template');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'teacher_import_template.xlsx';
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
      const res = await fetch(`${BASE_URL}/api/import/teachers/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Preview failed');

      const data = json.data as PreviewResult;
      setPreview(data);
      setSessionId(data.import_session_id);
      setTab('all');
      setStep('preview');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
      setPreviewProgress('');
    }
  }, [file]);

  // ── Confirm import — sends session_id, not the file again ──────────────

  async function handleImport() {
    const token = getToken();
    if (!token || !sessionId) return;
    setShowConfirm(false);
    setImporting(true);
    setError('');

    try {
      const res = await fetch(`${BASE_URL}/api/import/teachers/confirm`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ import_session_id: sessionId }),
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
    setSessionId('');
    setImportResult(null);
    setError('');
    setTab('all');
  }

  // ── Filtered rows ───────────────────────────────────────────────────────

  const filteredRows = preview?.rows.filter((r) =>
    tab === 'all' ? true : r.status === tab
  ) ?? [];

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Import Teachers"
        description="Bulk import teachers from an Excel spreadsheet"
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
                <h2 className="text-base font-semibold text-gray-900">Step 1 — Download Teacher Import Template</h2>
                <p className="mt-1 text-sm text-gray-500">
                  Fill this Excel template with your teacher data, then upload it below.
                  A teacher can span multiple rows (same email) for multiple class/division/subject assignments.
                </p>

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
                          <td className="py-1.5 pr-4 font-mono font-medium text-gray-800">{col.name}</td>
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

                {/* Multi-row tip */}
                <div className="mt-3 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                  <strong>Multiple assignments per teacher:</strong> Use multiple rows with the same email — the system merges them into one account with multiple class assignments.
                </div>

                {/* Password info */}
                <div className="mt-2 px-3 py-2 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-700">
                  <strong>Default password:</strong> Each teacher's phone number is set as their initial password. They will be required to change it on first login.
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
          {/* Summary bar */}
          <div className="grid grid-cols-3 gap-3">
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
                <p className="text-xs text-orange-600">Duplicate (will be skipped)</p>
              </div>
            </div>
          </div>

          {/* Tab switcher + table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex border-b border-gray-100 px-4 pt-4 gap-1">
              {(['all', 'valid', 'invalid', 'duplicate'] as TabFilter[]).map((t) => {
                const count = t === 'all'
                  ? preview.total_rows
                  : t === 'valid' ? preview.valid_rows
                  : t === 'invalid' ? preview.invalid_rows
                  : preview.duplicate_rows;
                const active = tab === t;
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors capitalize ${
                      active ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
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

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Row #', 'Name', 'Email', 'Phone', 'Subjects', 'Class Assignments', 'Status', 'Issues'].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-center py-10 text-sm text-gray-400">No rows in this category</td>
                    </tr>
                  ) : filteredRows.map((row) => (
                    <tr key={row.row_number} className={`hover:bg-gray-50 transition-colors ${row.status !== 'valid' ? 'bg-red-50/30' : ''}`}>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{row.row_number}</td>
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{row.data.name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs">{row.data.email || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.data.phone || '—'}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs">{row.data.subject || '—'}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs max-w-[180px] truncate" title={row.data.assigned_classes}>
                        {row.data.assigned_classes || <span className="text-gray-400 italic">None</span>}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={row.status} errors={row.errors} />
                      </td>
                      <td className="px-4 py-3 max-w-[200px]">
                        {row.errors.length > 0 ? (
                          <p className="text-xs text-red-600 truncate" title={row.errors.join('; ')}>
                            {row.errors[0]}{row.errors.length > 1 ? ` (+${row.errors.length - 1})` : ''}
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

          {/* Action bar */}
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-4 flex items-center justify-between gap-4">
            <p className="text-xs text-orange-600 flex items-center gap-1.5">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Invalid and duplicate rows are skipped automatically
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleReset}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={preview.valid_rows === 0 || importing}
                className="inline-flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {importing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Importing…
                  </>
                ) : (
                  `Import ${preview.valid_rows} Teacher${preview.valid_rows !== 1 ? 's' : ''}`
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 4: Success ────────────────────────────────────────────── */}
      {step === 'success' && importResult && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-6">
            <svg className="w-10 h-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {importResult.imported} teacher{importResult.imported !== 1 ? 's' : ''} imported successfully
          </h2>
          <p className="text-sm text-gray-500 mb-2">
            Each teacher&apos;s phone number has been set as their default password.
            They will be prompted to change it on first login.
          </p>
          {importResult.skipped > 0 && (
            <p className="text-sm text-orange-600 mb-8">
              {importResult.skipped} row{importResult.skipped !== 1 ? 's' : ''} skipped (invalid or duplicate)
            </p>
          )}
          {(!importResult.skipped || importResult.skipped === 0) && <div className="mb-8" />}
          <div className="flex items-center gap-3 flex-wrap justify-center">
            <button
              onClick={handleReset}
              className="px-5 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Import More
            </button>
            <button
              onClick={() => router.push('/admin/teachers')}
              className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              View Teachers
            </button>
          </div>
        </div>
      )}

      {/* ── Confirmation modal ─────────────────────────────────────────── */}
      <Modal open={showConfirm} onClose={() => setShowConfirm(false)} title="Confirm Import" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Import <span className="font-semibold text-gray-900">{preview?.valid_rows} teacher{preview?.valid_rows !== 1 ? 's' : ''}</span>?
            Their phone number will be set as the default password and they&apos;ll be required to change it on first login. This cannot be undone.
          </p>
          {(preview?.invalid_rows ?? 0) + (preview?.duplicate_rows ?? 0) > 0 && (
            <p className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
              {(preview?.invalid_rows ?? 0) + (preview?.duplicate_rows ?? 0)} invalid/duplicate rows will be skipped.
            </p>
          )}
          <div className="flex justify-end gap-3 pt-1">
            <button
              onClick={() => setShowConfirm(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              Confirm Import
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
