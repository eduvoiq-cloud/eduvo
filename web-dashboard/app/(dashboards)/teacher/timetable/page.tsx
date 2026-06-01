'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

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

  const fileIcon = (
    <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );

  return (
    <Modal open={open} onClose={handleClose} title="Upload Timetable" size="md">
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          Upload a PDF or photo of your timetable. Accepted formats: PDF, JPG, PNG, WEBP, HEIC · Max 10 MB.
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
              {fileIcon}
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
            Timetable uploaded successfully. Your admin will review it.
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
                  Upload
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

interface PeriodSlot {
  /** Unique key for this row — either a DB id or a local temp id */
  key: string;
  period_number: number;
  label: string;
  start_time: string;
  end_time: string;
}

interface TimetableEntry {
  id: string;
  period_number: number;
  start_time: string;
  end_time: string;
  day_of_week: Day;
  subject_id: string;
  subject_name: string | null;
  teacher_id: string;
  teacher_name: string | null;
  class_name: string;
  section: string;
}

type TimetableByDay = Record<Day, TimetableEntry[]>;

// ── Subject type (from assignments) ──────────────────────────────────────────

interface SubjectOption {
  id: string;
  name: string;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit,
  token: string
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string>),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `Request failed: ${res.status}`);
  return json.data as T;
}

// ── Colour palette for filled cells ──────────────────────────────────────────

const CELL_COLORS = [
  'border-blue-500', 'border-purple-500', 'border-green-500',
  'border-orange-500', 'border-pink-500', 'border-teal-500',
  'border-indigo-500', 'border-yellow-500',
];

function colorForSubject(subjectId: string): string {
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
          {Array.from({ length: 4 }).map((_, i) => (
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

// ── Add Period Slot Modal ─────────────────────────────────────────────────────

interface AddSlotModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (slot: Omit<PeriodSlot, 'key'>) => void;
  existingNumbers: number[];
}

function AddSlotModal({ open, onClose, onAdd, existingNumbers }: AddSlotModalProps) {
  const [label, setLabel] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [error, setError] = useState('');

  function reset() {
    setLabel(''); setStartTime(''); setEndTime(''); setError('');
  }

  function handleClose() { reset(); onClose(); }

  function handleSubmit() {
    if (!label.trim()) { setError('Period name is required.'); return; }
    if (!startTime) { setError('Start time is required.'); return; }
    if (!endTime) { setError('End time is required.'); return; }
    if (startTime >= endTime) { setError('Start time must be before end time.'); return; }
    const nextNum = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    onAdd({ period_number: nextNum, label: label.trim(), start_time: startTime, end_time: endTime });
    reset();
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add Period Slot" size="sm">
      <div className="space-y-4">
        <FormField label="Period Name" htmlFor="slot-label" required>
          <input id="slot-label" type="text" className={inputClass}
            placeholder="e.g. Period 1, Assembly, Lunch"
            value={label} onChange={(e) => setLabel(e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Start Time" htmlFor="slot-start" required>
            <input id="slot-start" type="time" className={inputClass}
              value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </FormField>
          <FormField label="End Time" htmlFor="slot-end" required>
            <input id="slot-end" type="time" className={inputClass}
              value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </FormField>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSubmit}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
            Add Slot
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Add / Edit Cell Modal ─────────────────────────────────────────────────────

interface CellModalProps {
  open: boolean;
  onClose: () => void;
  mode: 'add' | 'edit';
  day: Day;
  slot: PeriodSlot | null;
  subjects: SubjectOption[];
  existing: TimetableEntry | null;
  selectedClass: string;
  selectedSection: string;
  onSaved: (entry: TimetableEntry) => void;
}

function CellModal({
  open, onClose, mode, day, slot, subjects, existing,
  selectedClass, selectedSection, onSaved,
}: CellModalProps) {
  const [subjectId, setSubjectId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setSubjectId(existing?.subject_id ?? '');
      setError('');
    }
  }, [open, existing]);

  async function handleSave() {
    if (!subjectId) { setError('Please select a subject.'); return; }
    if (!slot) return;
    const token = getToken();
    if (!token) return;
    setSaving(true);
    setError('');
    try {
      if (mode === 'add') {
        const entry = await apiFetch<TimetableEntry>(
          '/api/timetable/period',
          {
            method: 'POST',
            body: JSON.stringify({
              class: selectedClass,
              section: selectedSection,
              day_of_week: day,
              period_number: slot.period_number,
              start_time: slot.start_time,
              end_time: slot.end_time,
              subject_id: subjectId,
            }),
          },
          token
        );
        const subject = subjects.find((s) => s.id === subjectId);
        onSaved({ ...entry, subject_name: subject?.name ?? null, teacher_name: null });
      } else if (existing) {
        const entry = await apiFetch<TimetableEntry>(
          `/api/timetable/period/${existing.id}`,
          { method: 'PUT', body: JSON.stringify({ subject_id: subjectId }) },
          token
        );
        const subject = subjects.find((s) => s.id === subjectId);
        onSaved({ ...existing, ...entry, subject_name: subject?.name ?? null });
      }
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  const title = mode === 'add'
    ? `Add Subject — ${DAY_LABELS[day]}, ${slot?.label ?? ''}`
    : `Edit Subject — ${DAY_LABELS[day]}, ${slot?.label ?? ''}`;

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="space-y-4">
        <div className="flex gap-3 text-xs text-gray-500">
          <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded font-medium">
            {DAY_LABELS[day]}
          </span>
          <span className="px-2 py-1 bg-gray-100 rounded">
            {slot?.start_time} – {slot?.end_time}
          </span>
          <span className="px-2 py-1 bg-gray-100 rounded">
            {selectedClass} · {selectedSection}
          </span>
        </div>
        <FormField label="Subject" htmlFor="cell-subject" required>
          <select id="cell-subject" className={inputClass}
            value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">Select subject…</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </FormField>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Timetable Grid ────────────────────────────────────────────────────────────

interface TimetableGridProps {
  slots: PeriodSlot[];
  timetable: TimetableByDay;
  subjects: SubjectOption[];
  selectedClass: string;
  selectedSection: string;
  onCellSaved: (entry: TimetableEntry) => void;
  onCellDeleted: (id: string, day: Day, periodNumber: number) => void;
}

function TimetableGrid({
  slots, timetable, subjects, selectedClass, selectedSection,
  onCellSaved, onCellDeleted,
}: TimetableGridProps) {
  const [cellModal, setCellModal] = useState<{
    open: boolean; mode: 'add' | 'edit'; day: Day; slot: PeriodSlot; existing: TimetableEntry | null;
  } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function openAdd(day: Day, slot: PeriodSlot) {
    setCellModal({ open: true, mode: 'add', day, slot, existing: null });
  }

  function openEdit(day: Day, slot: PeriodSlot, entry: TimetableEntry) {
    setCellModal({ open: true, mode: 'edit', day, slot, existing: entry });
  }

  async function handleDelete(entry: TimetableEntry) {
    const token = getToken();
    if (!token) return;
    setDeletingId(entry.id);
    try {
      await apiFetch(`/api/timetable/period/${entry.id}`, { method: 'DELETE' }, token);
      onCellDeleted(entry.id, entry.day_of_week as Day, entry.period_number);
    } catch {
      // silently ignore — could show a toast here
    } finally {
      setDeletingId(null);
    }
  }

  function getEntry(day: Day, periodNumber: number): TimetableEntry | undefined {
    return timetable[day]?.find((e) => e.period_number === periodNumber);
  }

  if (slots.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 py-16 text-center">
        <p className="text-sm text-gray-400">No period slots defined yet.</p>
        <p className="text-xs text-gray-400 mt-1">Click "Add Period Slot" to create the first row.</p>
      </div>
    );
  }

  return (
    <>
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
            {slots.map((slot) => (
              <tr key={slot.key} className="hover:bg-gray-50/50 transition-colors">
                {/* Time label */}
                <td className="px-4 py-3 align-top">
                  <div className="font-medium text-gray-800 text-xs">{slot.label}</div>
                  <div className="text-gray-400 text-xs mt-0.5">{slot.start_time} – {slot.end_time}</div>
                </td>
                {/* Day cells */}
                {DAYS.map((day) => {
                  const entry = getEntry(day, slot.period_number);
                  return (
                    <td key={day} className="px-2 py-2 align-top">
                      {entry ? (
                        <FilledCell
                          entry={entry}
                          slot={slot}
                          day={day}
                          isDeleting={deletingId === entry.id}
                          onEdit={() => openEdit(day, slot, entry)}
                          onDelete={() => handleDelete(entry)}
                        />
                      ) : (
                        <EmptyCell onClick={() => openAdd(day, slot)} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cellModal && (
        <CellModal
          open={cellModal.open}
          onClose={() => setCellModal(null)}
          mode={cellModal.mode}
          day={cellModal.day}
          slot={cellModal.slot}
          subjects={subjects}
          existing={cellModal.existing}
          selectedClass={selectedClass}
          selectedSection={selectedSection}
          onSaved={(entry) => { onCellSaved(entry); setCellModal(null); }}
        />
      )}
    </>
  );
}

// ── Empty Cell ────────────────────────────────────────────────────────────────

function EmptyCell({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full h-14 rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-300 hover:border-blue-400 hover:text-blue-400 hover:bg-blue-50/50 transition-all group"
      aria-label="Add subject"
    >
      <svg className="w-5 h-5 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    </button>
  );
}

// ── Filled Cell ───────────────────────────────────────────────────────────────

interface FilledCellProps {
  entry: TimetableEntry;
  slot: PeriodSlot;
  day: Day;
  isDeleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function FilledCell({ entry, isDeleting, onEdit, onDelete }: FilledCellProps) {
  const color = colorForSubject(entry.subject_id);
  return (
    <div className={`relative group rounded-lg border-l-4 ${color} bg-white border border-gray-100 px-3 py-2 h-14 flex flex-col justify-center shadow-sm hover:shadow-md transition-shadow`}>
      <p className="text-xs font-semibold text-gray-800 truncate leading-tight">
        {entry.subject_name ?? 'Unknown Subject'}
      </p>
      {entry.teacher_name && (
        <p className="text-xs text-gray-400 truncate mt-0.5">{entry.teacher_name}</p>
      )}
      {/* Hover actions */}
      <div className="absolute top-1 right-1 hidden group-hover:flex items-center gap-0.5">
        <button
          type="button"
          onClick={onEdit}
          className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
          aria-label="Edit"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
          aria-label="Delete"
        >
          {isDeleting ? (
            <span className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin inline-block" />
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TimetablePage() {
  const { user } = useAuth();

  // ── Assignments / class-section-subject data ────────────────────────────────
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // ── Filter state ────────────────────────────────────────────────────────────
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSection, setSelectedSection] = useState('');

  // ── Timetable state ─────────────────────────────────────────────────────────
  const [slots, setSlots] = useState<PeriodSlot[]>([]);
  const [timetable, setTimetable] = useState<TimetableByDay>({
    monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [],
  });
  const [loadingTimetable, setLoadingTimetable] = useState(false);
  const [timetableLoaded, setTimetableLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');

  // ── Modals ──────────────────────────────────────────────────────────────────
  const [addSlotOpen, setAddSlotOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // ── Print ref ───────────────────────────────────────────────────────────────
  const printRef = useRef<HTMLDivElement>(null);

  // ── Load assignments ────────────────────────────────────────────────────────
  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    assignmentsApi.list(token, user.school_id)
      .then((res) => setAssignments(res.data.filter((a) => a.teacher_id === user.id)))
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  // ── Derived dropdowns ───────────────────────────────────────────────────────
  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === selectedClass).map((a) => a.section)
  )].sort();

  // Subjects for the selected class+section (used in cell modal)
  const subjectsForSelection: SubjectOption[] = [...new Map(
    assignments
      .filter((a) => a.class_name === selectedClass && a.section === selectedSection)
      .map((a) => [a.subject, { id: a.subject, name: a.subject }])
  ).values()];

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
        { method: 'GET' },
        token
      );
      setTimetable(data);

      // Derive period slots from the loaded data (unique period_number + times)
      const slotMap = new Map<number, PeriodSlot>();
      for (const day of DAYS) {
        for (const entry of (data[day] ?? [])) {
          if (!slotMap.has(entry.period_number)) {
            slotMap.set(entry.period_number, {
              key: `p-${entry.period_number}`,
              period_number: entry.period_number,
              label: `Period ${entry.period_number}`,
              start_time: entry.start_time,
              end_time: entry.end_time,
            });
          }
        }
      }
      const derivedSlots = Array.from(slotMap.values()).sort((a, b) => a.period_number - b.period_number);
      setSlots(derivedSlots);
      setTimetableLoaded(true);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load timetable.');
    } finally {
      setLoadingTimetable(false);
    }
  }, [selectedClass, selectedSection]);

  // ── Handle cell saved ───────────────────────────────────────────────────────
  function handleCellSaved(entry: TimetableEntry) {
    const day = entry.day_of_week as Day;
    setTimetable((prev) => {
      const dayEntries = prev[day].filter((e) => e.period_number !== entry.period_number);
      return { ...prev, [day]: [...dayEntries, entry] };
    });
  }

  // ── Handle cell deleted ─────────────────────────────────────────────────────
  function handleCellDeleted(id: string, day: Day, periodNumber: number) {
    setTimetable((prev) => ({
      ...prev,
      [day]: prev[day].filter((e) => !(e.id === id && e.period_number === periodNumber)),
    }));
  }

  // ── Handle add slot ─────────────────────────────────────────────────────────
  function handleAddSlot(slot: Omit<PeriodSlot, 'key'>) {
    const key = `local-${Date.now()}`;
    setSlots((prev) => [...prev, { ...slot, key }]);
  }

  // ── Print ───────────────────────────────────────────────────────────────────
  function handlePrint() {
    window.print();
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Timetable"
        description="View and manage your class timetable"
      />

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 mb-5 print:hidden">
        {/* Class */}
        <div className="w-40">
          <label className="block text-xs font-medium text-gray-600 mb-1">Class</label>
          <select
            className={inputClass}
            disabled={loadingAssignments}
            value={selectedClass}
            onChange={(e) => {
              setSelectedClass(e.target.value);
              setSelectedSection('');
              setTimetableLoaded(false);
              setSlots([]);
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
            className={inputClass}
            disabled={!selectedClass}
            value={selectedSection}
            onChange={(e) => {
              setSelectedSection(e.target.value);
              setTimetableLoaded(false);
              setSlots([]);
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

        {/* Spacer */}
        <div className="flex-1" />

        {/* Add Period Slot */}
        {timetableLoaded && (
          <button
            type="button"
            onClick={() => setAddSlotOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Period Slot
          </button>
        )}

        {/* Print */}
        {timetableLoaded && (
          <button
            type="button"
            onClick={handlePrint}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-600 bg-white hover:bg-gray-50 border border-gray-300 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Print
          </button>
        )}

        {/* Upload Timetable */}
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-600 bg-white hover:bg-gray-50 border border-gray-300 rounded-lg transition-colors print:hidden"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Upload Timetable
        </button>
      </div>

      {/* ── Error ───────────────────────────────────────────────────────────── */}
      {loadError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 print:hidden">
          {loadError}
        </div>
      )}

      {/* ── Grid area ───────────────────────────────────────────────────────── */}
      <div ref={printRef}>
        {/* Print header (only visible when printing) */}
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
          <TimetableGrid
            slots={slots}
            timetable={timetable}
            subjects={subjectsForSelection}
            selectedClass={selectedClass}
            selectedSection={selectedSection}
            onCellSaved={handleCellSaved}
            onCellDeleted={handleCellDeleted}
          />
        )}
      </div>

      {/* ── Modals ──────────────────────────────────────────────────────────── */}
      <AddSlotModal
        open={addSlotOpen}
        onClose={() => setAddSlotOpen(false)}
        onAdd={handleAddSlot}
        existingNumbers={slots.map((s) => s.period_number)}
      />

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
