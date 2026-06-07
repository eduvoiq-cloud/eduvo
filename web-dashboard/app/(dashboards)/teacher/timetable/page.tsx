'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';

// ── Upload Timetable Modal ────────────────────────────────────────────────────

interface UploadTimetableModalProps {
  open: boolean;
  onClose: () => void;
  selectedClass: string;
  selectedSection: string;
}

function UploadTimetableModal({ open, onClose, selectedClass, selectedSection }: UploadTimetableModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setDragOver(false);
    setUploading(false);
    setUploadStatus('idle');
    setErrorMsg('');
  }

  function handleClose() { reset(); onClose(); }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    if (picked) validateAndSet(picked);
  }

  function validateAndSet(f: File) {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    if (!allowed.includes(f.type) && !f.name.match(/\.(pdf|jpg|jpeg|png|webp|heic)$/i)) {
      setErrorMsg('Only PDF or image files (JPG, PNG, WEBP, HEIC) are accepted.');
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setErrorMsg('File must be under 10 MB.');
      return;
    }
    setErrorMsg('');
    setFile(f);
    setUploadStatus('idle');
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) validateAndSet(dropped);
  }

  async function handleUpload() {
    if (!file) return;
    const token = getToken();
    if (!token) return;
    setUploading(true);
    setErrorMsg('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (selectedClass) formData.append('class', selectedClass);
      if (selectedSection) formData.append('section', selectedSection);

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/timetable/upload`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        }
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.message ?? `Upload failed (${res.status})`);
      }
      setUploadStatus('success');
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Upload failed.');
      setUploadStatus('error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Share Timetable" size="md">
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          Upload a PDF or photo of your timetable to share with students in this class.
          Accepted formats: PDF, JPG, PNG, WEBP, HEIC · Max 10 MB.
        </p>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed cursor-pointer transition-colors py-10 px-4
            ${dragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/40'}`}
        >
          {file ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                {file.type === 'application/pdf' ? (
                  <svg className="w-6 h-6 text-red-500" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM8 17v-1h8v1H8zm0-3v-1h8v1H8zm0-3V10h5v1H8z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                )}
                <span className="truncate max-w-[220px]">{file.name}</span>
              </div>
              <p className="text-xs text-gray-400">{(file.size / 1024).toFixed(0)} KB · Click to change</p>
            </>
          ) : (
            <>
              <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-sm text-gray-500 font-medium">Drop file here or click to browse</p>
              <p className="text-xs text-gray-400">PDF, JPG, PNG, WEBP, HEIC</p>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Class / section context */}
        {(selectedClass || selectedSection) && (
          <div className="flex gap-2 text-xs">
            {selectedClass && (
              <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded font-medium">
                Class: {selectedClass}
              </span>
            )}
            {selectedSection && (
              <span className="px-2 py-1 bg-gray-100 text-gray-600 rounded">
                Section: {selectedSection}
              </span>
            )}
          </div>
        )}

        {/* Status messages */}
        {errorMsg && (
          <p className="text-xs text-red-600 flex items-center gap-1">
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {errorMsg}
          </p>
        )}
        {uploadStatus === 'success' && (
          <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-xs text-green-700">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Timetable shared successfully. Students in this class will be notified.
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            {uploadStatus === 'success' ? 'Close' : 'Cancel'}
          </button>
          {uploadStatus !== 'success' && (
            <button
              type="button"
              onClick={handleUpload}
              disabled={!file || uploading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors"
            >
              {uploading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Share
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type Day = typeof DAYS[number];

const DAY_LABELS: Record<Day, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
};

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TimetableEntry {
  id: string;
  period: number;
  start_time: string;
  end_time: string;
  subject_name: string | null;
  teacher_name: string | null;
  class_name: string;
  section: string;
  subject_id: string;
  teacher_id: string;
}

type TimetableByDay = Record<Day, TimetableEntry[]>;

// ── Colour palette ────────────────────────────────────────────────────────────

const CELL_COLORS = [
  { bg: 'bg-blue-50', border: 'border-blue-400', text: 'text-blue-800' },
  { bg: 'bg-purple-50', border: 'border-purple-400', text: 'text-purple-800' },
  { bg: 'bg-green-50', border: 'border-green-400', text: 'text-green-800' },
  { bg: 'bg-orange-50', border: 'border-orange-400', text: 'text-orange-800' },
  { bg: 'bg-pink-50', border: 'border-pink-400', text: 'text-pink-800' },
  { bg: 'bg-teal-50', border: 'border-teal-400', text: 'text-teal-800' },
  { bg: 'bg-indigo-50', border: 'border-indigo-400', text: 'text-indigo-800' },
  { bg: 'bg-yellow-50', border: 'border-yellow-400', text: 'text-yellow-800' },
];

function colorForSubject(subjectId: string) {
  let hash = 0;
  for (let i = 0; i < subjectId.length; i++) hash = subjectId.charCodeAt(i) + ((hash << 5) - hash);
  return CELL_COLORS[Math.abs(hash) % CELL_COLORS.length];
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function GridSkeleton() {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white animate-pulse">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            <th className="px-4 py-3 w-32" />
            {DAYS.map((d) => (
              <th key={d} className="px-3 py-3">
                <div className="h-3 bg-gray-200 rounded w-8 mx-auto" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {Array.from({ length: 5 }).map((_, i) => (
            <tr key={i}>
              <td className="px-4 py-3"><div className="h-3 bg-gray-200 rounded w-24" /></td>
              {DAYS.map((d) => (
                <td key={d} className="px-3 py-3">
                  <div className="h-14 bg-gray-100 rounded-lg" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Read-only Timetable Grid ──────────────────────────────────────────────────

interface ReadOnlyGridProps {
  timetable: TimetableByDay;
  periodNumbers: number[];
  periodMeta: Record<number, { start_time: string; end_time: string }>;
}

function ReadOnlyGrid({ timetable, periodNumbers, periodMeta }: ReadOnlyGridProps) {
  if (periodNumbers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 py-16 text-center">
        <svg className="w-10 h-10 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <p className="text-sm text-gray-400">No timetable has been set up for this class yet.</p>
        <p className="text-xs text-gray-400 mt-1">Contact your school admin to create the timetable.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-blue-50 border-b border-blue-100">
            <th className="px-4 py-3 text-left text-xs font-semibold text-blue-700 uppercase tracking-wide w-36">
              Period
            </th>
            {DAYS.map((d) => (
              <th key={d} className="px-3 py-3 text-center text-xs font-semibold text-blue-700 uppercase tracking-wide min-w-[130px]">
                {DAY_LABELS[d]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {periodNumbers.map((periodNum) => {
            const meta = periodMeta[periodNum];
            return (
              <tr key={periodNum} className="hover:bg-gray-50/50 transition-colors">
                {/* Period label */}
                <td className="px-4 py-3 align-top">
                  <div className="font-medium text-gray-800 text-xs">Period {periodNum}</div>
                  {meta && (
                    <div className="text-gray-400 text-xs mt-0.5">
                      {meta.start_time} – {meta.end_time}
                    </div>
                  )}
                </td>
                {/* Day cells */}
                {DAYS.map((day) => {
                  const entry = timetable[day]?.find((e) => e.period === periodNum);
                  if (!entry) {
                    return (
                      <td key={day} className="px-2 py-2 align-top">
                        <div className="w-full h-14 rounded-lg bg-gray-50 border border-gray-100" />
                      </td>
                    );
                  }
                  const color = colorForSubject(entry.subject_id);
                  return (
                    <td key={day} className="px-2 py-2 align-top">
                      <div className={`rounded-lg border-l-4 ${color.border} ${color.bg} border border-gray-100 px-3 py-2 h-14 flex flex-col justify-center shadow-sm`}>
                        <p className={`text-xs font-semibold ${color.text} truncate leading-tight`}>
                          {entry.subject_name ?? 'Unknown Subject'}
                        </p>
                        {entry.teacher_name && (
                          <p className="text-xs text-gray-500 truncate mt-0.5">{entry.teacher_name}</p>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `Request failed: ${res.status}`);
  return json.data as T;
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TimetablePage() {
  const { user } = useAuth();

  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSection, setSelectedSection] = useState('');

  const [timetable, setTimetable] = useState<TimetableByDay>({
    monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [],
  });
  const [periodNumbers, setPeriodNumbers] = useState<number[]>([]);
  const [periodMeta, setPeriodMeta] = useState<Record<number, { start_time: string; end_time: string }>>({});
  const [loadingTimetable, setLoadingTimetable] = useState(false);
  const [timetableLoaded, setTimetableLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);

  // ── Load teacher assignments ────────────────────────────────────────────────
  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    assignmentsApi.list(token, user.school_id)
      .then((res) => setAssignments(res.data.filter((a) => a.teacher_id === user.id)))
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === selectedClass).map((a) => a.section)
  )].sort();

  // ── Load timetable ──────────────────────────────────────────────────────────
  const loadTimetable = useCallback(async () => {
    if (!selectedClass || !selectedSection) return;
    const token = getToken();
    if (!token) return;
    setLoadingTimetable(true);
    setLoadError('');
    setTimetableLoaded(false);
    try {
      const data = await apiFetch<TimetableByDay>(
        `/api/timetable/class?class=${encodeURIComponent(selectedClass)}&section=${encodeURIComponent(selectedSection)}`,
        token
      );
      setTimetable(data);

      // Derive period numbers and their times from loaded data
      const metaMap = new Map<number, { start_time: string; end_time: string }>();
      for (const day of DAYS) {
        for (const entry of (data[day] ?? [])) {
          if (!metaMap.has(entry.period)) {
            metaMap.set(entry.period, { start_time: entry.start_time, end_time: entry.end_time });
          }
        }
      }
      const nums = Array.from(metaMap.keys()).sort((a, b) => a - b);
      setPeriodNumbers(nums);
      setPeriodMeta(Object.fromEntries(metaMap));
      setTimetableLoaded(true);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load timetable.');
    } finally {
      setLoadingTimetable(false);
    }
  }, [selectedClass, selectedSection]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Timetable"
        description="View your class schedule for the week"
      />

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 mb-5 print:hidden">
        {/* Class */}
        <div className="w-40">
          <label className="block text-xs font-medium text-gray-600 mb-1">Class</label>
          <select
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loadingAssignments}
            value={selectedClass}
            onChange={(e) => {
              setSelectedClass(e.target.value);
              setSelectedSection('');
              setTimetableLoaded(false);
              setPeriodNumbers([]);
              setTimetable({ monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [] });
            }}
          >
            <option value="">{loadingAssignments ? 'Loading…' : 'Select class…'}</option>
            {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Section */}
        <div className="w-36">
          <label className="block text-xs font-medium text-gray-600 mb-1">Section</label>
          <select
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={!selectedClass}
            value={selectedSection}
            onChange={(e) => {
              setSelectedSection(e.target.value);
              setTimetableLoaded(false);
              setPeriodNumbers([]);
              setTimetable({ monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [] });
            }}
          >
            <option value="">Select section…</option>
            {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Load button */}
        <button
          type="button"
          onClick={loadTimetable}
          disabled={!selectedClass || !selectedSection || loadingTimetable}
          className="px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors"
        >
          {loadingTimetable ? 'Loading…' : 'Load Timetable'}
        </button>

        <div className="flex-1" />

        {/* Print */}
        {timetableLoaded && (
          <button
            type="button"
            onClick={() => window.print()}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-600 bg-white hover:bg-gray-50 border border-gray-300 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Print
          </button>
        )}

        {/* Share Timetable (PDF/image upload) */}
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-600 bg-white hover:bg-gray-50 border border-gray-300 rounded-lg transition-colors print:hidden"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Share Timetable
        </button>
      </div>

      {/* ── Info notice ─────────────────────────────────────────────────────── */}
      <div className="mb-4 px-4 py-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700 flex items-start gap-2 print:hidden">
        <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>
          Timetables are managed by school administrators. Use <strong>Share Timetable</strong> to send a PDF or photo of the schedule to your students.
        </span>
      </div>

      {/* ── Error ───────────────────────────────────────────────────────────── */}
      {loadError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 print:hidden">
          {loadError}
        </div>
      )}

      {/* ── Grid area ───────────────────────────────────────────────────────── */}
      <div>
        {/* Print header */}
        <div className="hidden print:block mb-4">
          <h1 className="text-lg font-bold text-gray-900">
            Timetable — {selectedClass} · {selectedSection}
          </h1>
        </div>

        {loadingTimetable && <GridSkeleton />}

        {!loadingTimetable && !timetableLoaded && !loadError && (
          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-20 text-center">
            <svg className="w-10 h-10 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-sm text-gray-400">Select a class and section, then click "Load Timetable".</p>
          </div>
        )}

        {timetableLoaded && (
          <ReadOnlyGrid
            timetable={timetable}
            periodNumbers={periodNumbers}
            periodMeta={periodMeta}
          />
        )}
      </div>

      {/* ── Upload Modal ─────────────────────────────────────────────────────── */}
      <UploadTimetableModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        selectedClass={selectedClass}
        selectedSection={selectedSection}
      />

      {/* ── Print styles ─────────────────────────────────────────────────────── */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          [data-print-area], [data-print-area] * { visibility: visible; }
          .print\\:hidden { display: none !important; }
          .print\\:block { display: block !important; }
          @page { margin: 1cm; }
        }
      `}</style>
    </>
  );
}
