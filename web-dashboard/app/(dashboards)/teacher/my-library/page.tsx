'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ──────────────────────────────────────────────────────────────────────

interface LibraryFile {
  id: string;
  file_name: string;
  file_url: string;
  unit_number: number;
  uploaded_at: string;
}

interface UnitFiles {
  [unitNumber: number]: LibraryFile[];
}

type UploadState = 'idle' | 'uploading' | 'done' | 'error';

interface UnitUploadStatus {
  state: UploadState;
  progress: number;
  error: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const TOTAL_UNITS = 25;
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ── Upload icon ────────────────────────────────────────────────────────────────

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

// ── Delete confirm modal ───────────────────────────────────────────────────────

interface DeleteModalProps {
  fileName: string;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
}

function DeleteModal({ fileName, onConfirm, onCancel, deleting }: DeleteModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <TrashIcon className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Delete File?</h3>
            <p className="text-xs text-gray-500 mt-0.5">This action cannot be undone.</p>
          </div>
        </div>
        <p className="text-sm text-gray-700">
          Delete <span className="font-medium text-gray-900">{fileName}</span>?
        </p>
        <div className="flex gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {deleting ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Deleting…
              </>
            ) : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Unit card ──────────────────────────────────────────────────────────────────

interface UnitCardProps {
  unitNumber: number;
  files: LibraryFile[];
  uploadStatus: UnitUploadStatus;
  onUpload: (unitNumber: number, file: File) => void;
  onDelete: (file: LibraryFile) => void;
}

function UnitCard({ unitNumber, files, uploadStatus, onUpload, onDelete }: UnitCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState('');

  const hasFiles = files.length > 0;

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError('');

    if (!ALLOWED_TYPES.includes(file.type)) {
      setFileError('Only PDF, JPG, or PNG files are allowed.');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setFileError('File must be under 10 MB.');
      e.target.value = '';
      return;
    }

    onUpload(unitNumber, file);
    e.target.value = '';
  }

  const isUploading = uploadStatus.state === 'uploading';

  return (
    <div className={`bg-white rounded-xl border transition-colors ${
      isUploading ? 'border-blue-300' : 'border-gray-200 hover:border-blue-200'
    } p-4 flex flex-col gap-3`}>
      {/* Unit label */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Unit {unitNumber}
        </span>
        {hasFiles && (
          <span className="text-xs text-blue-600 font-medium bg-blue-50 px-2 py-0.5 rounded-full">
            {files.length} file{files.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* File list */}
      {hasFiles && (
        <ul className="space-y-1.5">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 group">
              <FileIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <a
                href={f.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-xs text-gray-700 hover:text-blue-600 truncate transition-colors"
                title={f.file_name}
              >
                {f.file_name}
              </a>
              <button
                onClick={() => onDelete(f)}
                className="p-1 text-gray-300 hover:text-red-500 transition-colors rounded opacity-0 group-hover:opacity-100 focus:opacity-100"
                aria-label={`Delete ${f.file_name}`}
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Upload progress */}
      {isUploading && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-blue-600">
            <span>Uploading…</span>
            <span>{uploadStatus.progress}%</span>
          </div>
          <div className="w-full h-1.5 bg-blue-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${uploadStatus.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Upload error */}
      {(uploadStatus.state === 'error' || fileError) && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-2.5 py-1.5">
          {uploadStatus.error || fileError}
        </p>
      )}

      {/* Action button */}
      <div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          className="sr-only"
          onChange={handleFileSelect}
          aria-label={`Upload file for Unit ${unitNumber}`}
        />
        {hasFiles ? (
          <button
            type="button"
            onClick={() => { setFileError(''); inputRef.current?.click(); }}
            disabled={isUploading}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-50"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Add more
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { setFileError(''); inputRef.current?.click(); }}
            disabled={isUploading}
            className="w-full flex items-center justify-center gap-2 px-3 py-3 text-sm font-medium text-gray-500 border-2 border-dashed border-gray-200 rounded-lg hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50/50 transition-colors disabled:opacity-50"
          >
            <UploadIcon className="w-4 h-4" />
            Upload
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function MyLibraryPage() {
  const { user } = useAuth();

  // Assignments & selectors
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('');

  // Unit files — keyed by unit number
  const [unitFiles, setUnitFiles] = useState<UnitFiles>({});
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [unitsError, setUnitsError] = useState('');

  // Per-unit upload status
  const [uploadStatuses, setUploadStatuses] = useState<Record<number, UnitUploadStatus>>({});

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<LibraryFile | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Load assignments ──────────────────────────────────────────────────────

  const fetchAssignments = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoadingAssignments(true);
    try {
      const res = await assignmentsApi.list(token, user.school_id);
      const mine = res.data.filter((a) => a.teacher_id === user.id);
      setAssignments(mine);
    } catch {
      // silent
    } finally {
      setLoadingAssignments(false);
    }
  }, [user]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  // ── Derived dropdown options ──────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();

  const subjectsForClass = [...new Set(
    assignments
      .filter((a) => a.class_name === selectedClass)
      .map((a) => a.subject)
  )].sort();

  // Reset subject when class changes
  useEffect(() => {
    setSelectedSubject('');
    setUnitFiles({});
    setUnitsError('');
  }, [selectedClass]);

  // ── Fetch units when class + subject selected ─────────────────────────────

  const fetchUnits = useCallback(async (className: string, subject: string) => {
    const token = getToken();
    if (!token) return;
    setLoadingUnits(true);
    setUnitsError('');
    setUnitFiles({});
    try {
      const qs = new URLSearchParams({ class_name: className, subject });
      const res = await fetch(`${BASE_URL}/api/teacher-library/units?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load units');

      // Build map: { [unit_number]: LibraryFile[] }
      const map: UnitFiles = {};
      const units: Array<{ unit_number: number; files: LibraryFile[] }> = json.data ?? json.units ?? [];
      for (const unit of units) {
        map[unit.unit_number] = unit.files ?? [];
      }
      setUnitFiles(map);
    } catch (err) {
      setUnitsError(err instanceof Error ? err.message : 'Failed to load library.');
    } finally {
      setLoadingUnits(false);
    }
  }, []);

  useEffect(() => {
    if (selectedClass && selectedSubject) {
      fetchUnits(selectedClass, selectedSubject);
    }
  }, [selectedClass, selectedSubject, fetchUnits]);

  // ── Upload a file for a unit ──────────────────────────────────────────────

  const handleUpload = useCallback(async (unitNumber: number, file: File) => {
    const token = getToken();
    if (!token || !selectedClass || !selectedSubject) return;

    // Find section from the assignment
    const assignment = assignments.find(
      (a) => a.class_name === selectedClass && a.subject === selectedSubject
    );
    const section = assignment?.section ?? '';

    setUploadStatuses((prev) => ({
      ...prev,
      [unitNumber]: { state: 'uploading', progress: 0, error: '' },
    }));

    try {
      const formData = new FormData();
      formData.append('class_name', selectedClass);
      formData.append('section', section);
      formData.append('subject', selectedSubject);
      formData.append('unit_number', String(unitNumber));
      formData.append('file', file);

      // Use XMLHttpRequest for upload progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BASE_URL}/api/teacher-library/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setUploadStatuses((prev) => ({
              ...prev,
              [unitNumber]: { state: 'uploading', progress: pct, error: '' },
            }));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            let msg = 'Upload failed.';
            try {
              const body = JSON.parse(xhr.responseText);
              msg = body.message ?? msg;
            } catch { /* ignore */ }
            reject(new Error(msg));
          }
        };

        xhr.onerror = () => reject(new Error('Network error during upload.'));
        xhr.send(formData);
      });

      setUploadStatuses((prev) => ({
        ...prev,
        [unitNumber]: { state: 'done', progress: 100, error: '' },
      }));

      // Refresh this unit's file list
      await fetchUnits(selectedClass, selectedSubject);

      // Clear success state after a moment
      setTimeout(() => {
        setUploadStatuses((prev) => ({
          ...prev,
          [unitNumber]: { state: 'idle', progress: 0, error: '' },
        }));
      }, 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      setUploadStatuses((prev) => ({
        ...prev,
        [unitNumber]: { state: 'error', progress: 0, error: msg },
      }));
    }
  }, [assignments, selectedClass, selectedSubject, fetchUnits]);

  // ── Delete a file ─────────────────────────────────────────────────────────

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const token = getToken();
    if (!token) return;
    setDeleting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/teacher-library/files/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.message ?? 'Delete failed.');
      }
      // Remove from local state
      setUnitFiles((prev) => {
        const updated = { ...prev };
        const unitNum = deleteTarget.unit_number;
        if (updated[unitNum]) {
          updated[unitNum] = updated[unitNum].filter((f) => f.id !== deleteTarget.id);
        }
        return updated;
      });
      setDeleteTarget(null);
    } catch (err) {
      // Optionally show error — for now just close modal and let user retry
      console.error('Delete failed:', err);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget]);

  // ── Render ────────────────────────────────────────────────────────────────

  const showGrid = selectedClass && selectedSubject;

  return (
    <>
      {deleteTarget && (
        <DeleteModal
          fileName={deleteTarget.file_name}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          deleting={deleting}
        />
      )}

      <div className="space-y-6">
        <PageHeader
          title="My Library"
          description="Upload and manage textbook files for your classes, organised by unit."
        />

        {/* Selector card */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Select Class &amp; Subject</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
            {/* Class selector */}
            <div>
              <label htmlFor="lib-class" className="block text-sm font-medium text-gray-700 mb-1.5">
                Class
              </label>
              <select
                id="lib-class"
                value={selectedClass}
                onChange={(e) => setSelectedClass(e.target.value)}
                disabled={loadingAssignments}
                className={inputClass}
              >
                <option value="">
                  {loadingAssignments ? 'Loading…' : '— Select class —'}
                </option>
                {myClasses.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Subject selector */}
            <div>
              <label htmlFor="lib-subject" className="block text-sm font-medium text-gray-700 mb-1.5">
                Subject
              </label>
              <select
                id="lib-subject"
                value={selectedSubject}
                onChange={(e) => setSelectedSubject(e.target.value)}
                disabled={!selectedClass}
                className={inputClass}
              >
                <option value="">
                  {!selectedClass ? '— Select class first —' : '— Select subject —'}
                </option>
                {subjectsForClass.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Unit grid */}
        {showGrid && (
          <div className="space-y-4">
            {/* Header row */}
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">
                Units — <span className="text-blue-600">{selectedClass}</span> · <span className="text-blue-600">{selectedSubject}</span>
              </h2>
              {loadingUnits && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <span className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  Loading…
                </div>
              )}
            </div>

            {unitsError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
                {unitsError}
              </div>
            )}

            {!loadingUnits && !unitsError && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {Array.from({ length: TOTAL_UNITS }, (_, i) => i + 1).map((unitNum) => (
                  <UnitCard
                    key={unitNum}
                    unitNumber={unitNum}
                    files={unitFiles[unitNum] ?? []}
                    uploadStatus={uploadStatuses[unitNum] ?? { state: 'idle', progress: 0, error: '' }}
                    onUpload={handleUpload}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </div>
            )}

            {loadingUnits && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {Array.from({ length: TOTAL_UNITS }).map((_, i) => (
                  <div key={i} className="bg-white rounded-xl border border-gray-200 p-4 h-28 animate-pulse">
                    <div className="h-3 bg-gray-100 rounded w-1/2 mb-3" />
                    <div className="h-8 bg-gray-100 rounded" />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Empty prompt */}
        {!showGrid && !loadingAssignments && (
          <div className="bg-white rounded-2xl border border-gray-200 p-12 flex flex-col items-center justify-center text-center gap-3">
            <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
              <FileIcon className="w-6 h-6 text-blue-400" />
            </div>
            <p className="text-sm font-medium text-gray-700">Select a class and subject to view your library</p>
            <p className="text-xs text-gray-400">Upload PDF, JPG, or PNG files per unit — max 10 MB each.</p>
          </div>
        )}
      </div>
    </>
  );
}
