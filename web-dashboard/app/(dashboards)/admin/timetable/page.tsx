'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { usersApi, assignmentsApi, type Teacher, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type Day = typeof DAYS[number];

const DAY_LABELS: Record<Day, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
};

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Subject {
  id: string;
  name: string;
}

interface TimetableEntry {
  id: string;
  period: number;
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

interface PeriodSlot {
  key: string;
  period_number: number;
  label: string;
  start_time: string;
  end_time: string;
}

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

// ── API helper ────────────────────────────────────────────────────────────────

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

// ── Skeleton ──────────────────────────────────────────────────────────────────

function GridSkeleton() {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white animate-pulse">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            <th className="px-4 py-3 w-32" />
            {DAYS.map((d) => <th key={d} className="px-3 py-3"><div className="h-3 bg-gray-200 rounded w-8 mx-auto" /></th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {Array.from({ length: 5 }).map((_, i) => (
            <tr key={i}>
              <td className="px-4 py-3"><div className="h-3 bg-gray-200 rounded w-24" /></td>
              {DAYS.map((d) => <td key={d} className="px-3 py-3"><div className="h-14 bg-gray-100 rounded-lg" /></td>)}
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

  function reset() { setLabel(''); setStartTime(''); setEndTime(''); setError(''); }
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

// ── Cell Modal (Add / Edit) ───────────────────────────────────────────────────

interface CellModalProps {
  open: boolean;
  onClose: () => void;
  mode: 'add' | 'edit';
  day: Day;
  slot: PeriodSlot | null;
  subjects: Subject[];
  teachers: Teacher[];
  existing: TimetableEntry | null;
  selectedClass: string;
  selectedSection: string;
  token: string;
  onSaved: (entry: TimetableEntry) => void;
}

function CellModal({
  open, onClose, mode, day, slot, subjects, teachers, existing,
  selectedClass, selectedSection, token, onSaved,
}: CellModalProps) {
  const [subjectId, setSubjectId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setSubjectId(existing?.subject_id ?? '');
      setTeacherId(existing?.teacher_id ?? '');
      setError('');
    }
  }, [open, existing]);

  async function handleSave() {
    if (!subjectId) { setError('Please select a subject.'); return; }
    if (!teacherId) { setError('Please select a teacher.'); return; }
    if (!slot) return;
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
              teacher_id: teacherId,
            }),
          },
          token
        );
        const subject = subjects.find((s) => s.id === subjectId);
        const teacher = teachers.find((t) => t.id === teacherId);
        onSaved({
          ...entry,
          period: slot.period_number,
          day_of_week: day,
          subject_name: subject?.name ?? null,
          teacher_name: teacher?.name ?? null,
          class_name: selectedClass,
          section: selectedSection,
        });
      } else if (existing) {
        const entry = await apiFetch<TimetableEntry>(
          `/api/timetable/period/${existing.id}`,
          { method: 'PUT', body: JSON.stringify({ subject_id: subjectId }) },
          token
        );
        const subject = subjects.find((s) => s.id === subjectId);
        const teacher = teachers.find((t) => t.id === teacherId);
        onSaved({
          ...existing,
          ...entry,
          subject_name: subject?.name ?? null,
          teacher_name: teacher?.name ?? existing.teacher_name,
        });
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
        <div className="flex flex-wrap gap-2 text-xs text-gray-500">
          <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded font-medium">{DAY_LABELS[day]}</span>
          <span className="px-2 py-1 bg-gray-100 rounded">{slot?.start_time} – {slot?.end_time}</span>
          <span className="px-2 py-1 bg-gray-100 rounded">{selectedClass} · {selectedSection}</span>
        </div>
        <FormField label="Subject" htmlFor="cell-subject" required>
          <select id="cell-subject" className={inputClass}
            value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">Select subject…</option>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </FormField>
        <FormField label="Teacher" htmlFor="cell-teacher" required>
          <select id="cell-teacher" className={inputClass}
            value={teacherId} onChange={(e) => setTeacherId(e.target.value)}
            disabled={mode === 'edit'}>
            <option value="">Select teacher…</option>
            {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {mode === 'edit' && (
            <p className="text-xs text-gray-400 mt-1">Teacher cannot be changed after creation. Delete and re-add the period to change the teacher.</p>
          )}
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

// ── Empty / Filled Cells ──────────────────────────────────────────────────────

function EmptyCell({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="w-full h-14 rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-300 hover:border-blue-400 hover:text-blue-400 hover:bg-blue-50/50 transition-all group"
      aria-label="Add subject">
      <svg className="w-5 h-5 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    </button>
  );
}

interface FilledCellProps {
  entry: TimetableEntry;
  isDeleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function FilledCell({ entry, isDeleting, onEdit, onDelete }: FilledCellProps) {
  const color = colorForSubject(entry.subject_id);
  return (
    <div className={`relative group rounded-lg border-l-4 ${color.border} ${color.bg} border border-gray-100 px-3 py-2 h-14 flex flex-col justify-center shadow-sm hover:shadow-md transition-shadow`}>
      <p className={`text-xs font-semibold ${color.text} truncate leading-tight`}>
        {entry.subject_name ?? 'Unknown Subject'}
      </p>
      {entry.teacher_name && (
        <p className="text-xs text-gray-500 truncate mt-0.5">{entry.teacher_name}</p>
      )}
      <div className="absolute top-1 right-1 hidden group-hover:flex items-center gap-0.5">
        <button type="button" onClick={onEdit}
          className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" aria-label="Edit">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button type="button" onClick={onDelete} disabled={isDeleting}
          className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50" aria-label="Delete">
          {isDeleting ? (
            <span className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin inline-block" />
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Timetable Grid ────────────────────────────────────────────────────────────

interface TimetableGridProps {
  slots: PeriodSlot[];
  timetable: TimetableByDay;
  subjects: Subject[];
  teachers: Teacher[];
  selectedClass: string;
  selectedSection: string;
  token: string;
  onCellSaved: (entry: TimetableEntry) => void;
  onCellDeleted: (id: string, day: Day, periodNumber: number) => void;
}

function TimetableGrid({
  slots, timetable, subjects, teachers, selectedClass, selectedSection,
  token, onCellSaved, onCellDeleted,
}: TimetableGridProps) {
  const [cellModal, setCellModal] = useState<{
    open: boolean; mode: 'add' | 'edit'; day: Day; slot: PeriodSlot; existing: TimetableEntry | null;
  } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function getEntry(day: Day, periodNumber: number): TimetableEntry | undefined {
    return timetable[day]?.find((e) => e.period === periodNumber);
  }

  async function handleDelete(entry: TimetableEntry) {
    setDeletingId(entry.id);
    try {
      await apiFetch(`/api/timetable/period/${entry.id}`, { method: 'DELETE' }, token);
      onCellDeleted(entry.id, entry.day_of_week as Day, entry.period);
    } catch { /* ignore */ } finally {
      setDeletingId(null);
    }
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
              <th className="px-4 py-3 text-left text-xs font-semibold text-blue-700 uppercase tracking-wide w-36">Period</th>
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
                <td className="px-4 py-3 align-top">
                  <div className="font-medium text-gray-800 text-xs">{slot.label}</div>
                  <div className="text-gray-400 text-xs mt-0.5">{slot.start_time} – {slot.end_time}</div>
                </td>
                {DAYS.map((day) => {
                  const entry = getEntry(day, slot.period_number);
                  return (
                    <td key={day} className="px-2 py-2 align-top">
                      {entry ? (
                        <FilledCell
                          entry={entry}
                          isDeleting={deletingId === entry.id}
                          onEdit={() => setCellModal({ open: true, mode: 'edit', day, slot, existing: entry })}
                          onDelete={() => handleDelete(entry)}
                        />
                      ) : (
                        <EmptyCell onClick={() => setCellModal({ open: true, mode: 'add', day, slot, existing: null })} />
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
          teachers={teachers}
          existing={cellModal.existing}
          selectedClass={selectedClass}
          selectedSection={selectedSection}
          token={token}
          onSaved={(entry) => { onCellSaved(entry); setCellModal(null); }}
        />
      )}
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminTimetablePage() {
  const { user } = useAuth();

  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);

  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSection, setSelectedSection] = useState('');

  const [slots, setSlots] = useState<PeriodSlot[]>([]);
  const [timetable, setTimetable] = useState<TimetableByDay>({
    monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [],
  });
  const [loadingTimetable, setLoadingTimetable] = useState(false);
  const [timetableLoaded, setTimetableLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [addSlotOpen, setAddSlotOpen] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const token = getToken() ?? '';

  // ── Load meta data ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user?.school_id || !token) return;
    const schoolId = user.school_id;

    Promise.all([
      assignmentsApi.list(token, schoolId),
      usersApi.list(token, { role: 'teacher', school_id: schoolId }),
      fetch(`${BASE_URL}/api/admin/subjects`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
    ])
      .then(([aRes, tRes, sRes]) => {
        setAssignments(aRes.data);
        setTeachers(tRes.data as Teacher[]);
        setSubjects((sRes.data ?? []) as Subject[]);
      })
      .catch(() => {})
      .finally(() => setLoadingMeta(false));
  }, [user, token]);

  // ── Derived class/section lists ─────────────────────────────────────────────
  const allClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === selectedClass).map((a) => a.section)
  )].sort();

  // ── Load timetable ──────────────────────────────────────────────────────────
  const loadTimetable = useCallback(async () => {
    if (!selectedClass || !selectedSection || !token) return;
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

      // Derive period slots
      const slotMap = new Map<number, PeriodSlot>();
      for (const day of DAYS) {
        for (const entry of (data[day] ?? [])) {
          if (!slotMap.has(entry.period)) {
            slotMap.set(entry.period, {
              key: `p-${entry.period}`,
              period_number: entry.period,
              label: `Period ${entry.period}`,
              start_time: entry.start_time,
              end_time: entry.end_time,
            });
          }
        }
      }
      setSlots(Array.from(slotMap.values()).sort((a, b) => a.period_number - b.period_number));
      setTimetableLoaded(true);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load timetable.');
    } finally {
      setLoadingTimetable(false);
    }
  }, [selectedClass, selectedSection, token]);

  function handleCellSaved(entry: TimetableEntry) {
    const day = entry.day_of_week as Day;
    setTimetable((prev) => ({
      ...prev,
      [day]: [...prev[day].filter((e) => e.period !== entry.period), entry],
    }));
  }

  function handleCellDeleted(id: string, day: Day, periodNumber: number) {
    setTimetable((prev) => ({
      ...prev,
      [day]: prev[day].filter((e) => !(e.id === id && e.period === periodNumber)),
    }));
  }

  function handleAddSlot(slot: Omit<PeriodSlot, 'key'>) {
    setSlots((prev) => [...prev, { ...slot, key: `local-${Date.now()}` }]);
  }

  return (
    <>
      <PageHeader
        title="Timetable"
        description="Create and manage class timetables"
      />

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 mb-5 print:hidden">
        <div className="w-40">
          <label className="block text-xs font-medium text-gray-600 mb-1">Class</label>
          <select className={inputClass} disabled={loadingMeta} value={selectedClass}
            onChange={(e) => {
              setSelectedClass(e.target.value);
              setSelectedSection('');
              setTimetableLoaded(false);
              setSlots([]);
              setTimetable({ monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [] });
            }}>
            <option value="">{loadingMeta ? 'Loading…' : 'Select class…'}</option>
            {allClasses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="w-36">
          <label className="block text-xs font-medium text-gray-600 mb-1">Section</label>
          <select className={inputClass} disabled={!selectedClass} value={selectedSection}
            onChange={(e) => {
              setSelectedSection(e.target.value);
              setTimetableLoaded(false);
              setSlots([]);
              setTimetable({ monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [] });
            }}>
            <option value="">Select section…</option>
            {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <button
          type="button"
          onClick={loadTimetable}
          disabled={!selectedClass || !selectedSection || loadingTimetable}
          className="px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors">
          {loadingTimetable ? 'Loading…' : 'Load Timetable'}
        </button>

        <div className="flex-1" />

        {timetableLoaded && (
          <button type="button" onClick={() => setAddSlotOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Period Slot
          </button>
        )}

        {timetableLoaded && (
          <button type="button" onClick={() => window.print()}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-600 bg-white hover:bg-gray-50 border border-gray-300 rounded-lg transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Print
          </button>
        )}
      </div>

      {loadError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 print:hidden">
          {loadError}
        </div>
      )}

      <div ref={printRef}>
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
            subjects={subjects}
            teachers={teachers}
            selectedClass={selectedClass}
            selectedSection={selectedSection}
            token={token}
            onCellSaved={handleCellSaved}
            onCellDeleted={handleCellDeleted}
          />
        )}
      </div>

      <AddSlotModal
        open={addSlotOpen}
        onClose={() => setAddSlotOpen(false)}
        onAdd={handleAddSlot}
        existingNumbers={slots.map((s) => s.period_number)}
      />

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
