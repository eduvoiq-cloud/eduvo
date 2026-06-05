'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Subject {
  id: string;
  name: string;
}

interface HomeworkItem {
  id: string;
  title: string;
  description: string | null;
  subject_name: string | null;
  subject_id?: string;
  teacher_name: string | null;
  due_date: string;
  file_url: string | null;
  created_at: string;
}

interface AckCount {
  acknowledged_count: number;
  total_students: number;
}

interface HomeworkForm {
  subject_id: string;
  custom_subject: string;
  class_name: string;
  section: string;
  title: string;
  description: string;
  due_date: string;
  file: File | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SUBJECT_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-purple-100 text-purple-700',
  'bg-green-100 text-green-700',
  'bg-orange-100 text-orange-700',
  'bg-pink-100 text-pink-700',
  'bg-teal-100 text-teal-700',
  'bg-yellow-100 text-yellow-700',
  'bg-red-100 text-red-700',
];

function subjectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return SUBJECT_COLORS[Math.abs(hash) % SUBJECT_COLORS.length];
}

function formatDueDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(day).padStart(2, '0')} ${months[month - 1]} ${year}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function HomeworkSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
          <div className="flex items-start gap-3">
            <div className="h-6 w-20 bg-gray-200 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="h-5 bg-gray-200 rounded w-2/3" />
              <div className="h-3 bg-gray-200 rounded w-full" />
              <div className="h-3 bg-gray-200 rounded w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Homework Card ─────────────────────────────────────────────────────────────

function HomeworkCard({
  item,
  ackCount,
  onEdit,
  onDelete,
}: {
  item: HomeworkItem;
  ackCount: AckCount | null;
  onEdit: (item: HomeworkItem) => void;
  onDelete: (item: HomeworkItem) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const colorClass = subjectColor(item.subject_name ?? 'General');

  return (
    <div
      className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-sm transition-shadow relative group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Subject badge */}
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap flex-shrink-0 ${colorClass}`}>
            {item.subject_name ?? 'General'}
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-gray-900 leading-snug">{item.title}</h3>
            {item.description && (
              <p className="mt-1 text-sm text-gray-500 line-clamp-2">{item.description}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Due: {formatDueDate(item.due_date)}
              </span>
              {ackCount !== null && (
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {ackCount.acknowledged_count} / {ackCount.total_students} students acknowledged
                </span>
              )}
              {item.file_url && (
                <a href={item.file_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-blue-600 hover:underline">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  Attachment
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Action buttons — visible on hover */}
        <div className={`flex items-center gap-2 flex-shrink-0 transition-opacity ${hovered ? 'opacity-100' : 'opacity-0'}`}>
          <button onClick={() => onEdit(item)}
            className="px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
            Edit
          </button>
          <button onClick={() => onDelete(item)}
            className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Homework Form Modal ───────────────────────────────────────────────────────

function HomeworkFormModal({
  open,
  onClose,
  mode,
  initial,
  subjects,
  myClasses,
  assignments,
  filterClass,
  filterSection,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  initial?: HomeworkItem | null;
  subjects: Subject[];
  myClasses: string[];
  assignments: TeacherAssignment[];
  filterClass: string;
  filterSection: string;
  onSuccess: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<HomeworkForm>({
    subject_id: '',
    custom_subject: '',
    class_name: filterClass,
    section: filterSection,
    title: '',
    description: '',
    due_date: '',
    file: null,
  });
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  // Pre-fill on edit or when filter changes
  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && initial) {
      const matchedSubject = subjects.find((s) => s.name === initial.subject_name);
      setForm({
        subject_id: matchedSubject?.id ?? initial.subject_id ?? '',
        custom_subject: matchedSubject ? '' : (initial.subject_name ?? ''),
        class_name: filterClass,
        section: filterSection,
        title: initial.title,
        description: initial.description ?? '',
        due_date: initial.due_date,
        file: null,
      });
    } else {
      setForm({
        subject_id: '',
        custom_subject: '',
        class_name: filterClass,
        section: filterSection,
        title: '',
        description: '',
        due_date: '',
        file: null,
      });
    }
    setError('');
  }, [open, mode, initial, filterClass, filterSection, subjects]);

  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === form.class_name).map((a) => a.section)
  )].sort();

  // Subjects assigned to this teacher for the selected class/section,
  // enriched with IDs from the subjects API where available.
  const subjectsForClassSection: (Subject & { missing?: boolean })[] = (() => {
    if (!form.class_name || !form.section) return [];
    const assignedNames = [...new Set(
      assignments
        .filter((a) => a.class_name === form.class_name && a.section === form.section)
        .map((a) => a.subject)
    )].sort();

    return assignedNames.map((name) => {
      const found = subjects.find((s) => s.name.toLowerCase() === name.toLowerCase());
      return found ? found : { id: '', name, missing: true };
    });
  })();

  const useCustomSubject = form.subject_id === '__custom__';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // Resolve the effective subject_id and name
    let effectiveSubjectId = form.subject_id;
    const isCustom = form.subject_id === '__custom__';
    const customName = form.custom_subject.trim();

    if (isCustom) {
      if (!customName) { setError('Please enter a subject name.'); return; }
      // Look up by custom name in subjects list
      const found = subjects.find((s) => s.name.toLowerCase() === customName.toLowerCase());
      if (!found) { setError(`Subject "${customName}" is not in the school subjects list. Please ask your admin to add it first.`); return; }
      effectiveSubjectId = found.id;
    } else {
      // Check if it's a missing-ID subject (assigned but not in DB)
      const sel = subjectsForClassSection.find((s) => s.id === effectiveSubjectId || (s.id === '' && s.name === effectiveSubjectId));
      if (sel && !sel.id) { setError(`Subject "${sel.name}" is not yet in the school subjects list. Please ask your admin to add it.`); return; }
    }

    if (!effectiveSubjectId || !form.class_name || !form.section || !form.title || !form.due_date) {
      setError('Please fill in all required fields.');
      return;
    }
    const token = getToken();
    if (!token) return;
    setUploading(true);

    try {
      let file_url: string | undefined;

      // Upload file if provided
      if (form.file) {
        const fd = new FormData();
        fd.append('file', form.file);
        const uploadRes = await fetch(`${BASE_URL}/api/homework/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        const uploadJson = await uploadRes.json();
        if (!uploadRes.ok) throw new Error(uploadJson.message ?? 'File upload failed');
        file_url = uploadJson.data?.url;
      }

      const payload: Record<string, unknown> = {
        subject_id: effectiveSubjectId,
        class: form.class_name,
        section: form.section,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        due_date: form.due_date,
        ...(file_url ? { file_url } : {}),
      };

      const url = mode === 'edit' && initial
        ? `${BASE_URL}/api/homework/${initial.id}`
        : `${BASE_URL}/api/homework/create`;
      const method = mode === 'edit' ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Request failed');

      onSuccess();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={mode === 'create' ? 'Create Homework' : 'Edit Homework'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="Class" htmlFor="hw-class" required>
            <select id="hw-class" className={inputClass} value={form.class_name}
              onChange={(e) => setForm((f) => ({ ...f, class_name: e.target.value, section: '', subject_id: '' }))}>
              <option value="">Select class…</option>
              {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
          <FormField label="Section" htmlFor="hw-section" required>
            <select id="hw-section" className={inputClass} value={form.section} disabled={!form.class_name}
              onChange={(e) => setForm((f) => ({ ...f, section: e.target.value, subject_id: '' }))}>
              <option value="">Select section…</option>
              {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </FormField>
        </div>

        <FormField label="Subject" htmlFor="hw-subject" required>
          <select id="hw-subject" className={inputClass} value={form.subject_id} disabled={!form.section}
            onChange={(e) => setForm((f) => ({ ...f, subject_id: e.target.value, custom_subject: '' }))}>
            <option value="">Select subject…</option>
            {subjectsForClassSection.map((s) => (
              <option key={s.id || s.name} value={s.id || `__missing__${s.name}`} disabled={!s.id}>
                {s.name}{!s.id ? ' (not in DB — contact admin)' : ''}
              </option>
            ))}
            <option value="__custom__">✏️ Type a different subject…</option>
          </select>
          {useCustomSubject && (
            <input
              type="text"
              className={`${inputClass} mt-2`}
              placeholder="Enter subject name…"
              value={form.custom_subject}
              onChange={(e) => setForm((f) => ({ ...f, custom_subject: e.target.value }))}
              autoFocus
            />
          )}
          {!form.section && (
            <p className="mt-1 text-xs text-gray-400">Select a section first</p>
          )}
          {form.section && subjectsForClassSection.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">No subjects assigned for this class/section. Use "Type a different subject" or ask your admin to set up assignments.</p>
          )}
        </FormField>

        <FormField label="Title" htmlFor="hw-title" required>
          <input id="hw-title" type="text" className={inputClass} maxLength={200}
            placeholder="e.g. Chapter 5 Exercise Questions"
            value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          <p className="mt-1 text-xs text-gray-400 text-right">{form.title.length}/200</p>
        </FormField>

        <FormField label="Description" htmlFor="hw-desc">
          <textarea id="hw-desc" className={`${inputClass} resize-none`} rows={3} maxLength={2000}
            placeholder="Optional instructions or details…"
            value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          <p className="mt-1 text-xs text-gray-400 text-right">{form.description.length}/2000</p>
        </FormField>

        <FormField label="Due Date" htmlFor="hw-due" required>
          <input id="hw-due" type="date" className={inputClass} min={todayISO()}
            value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
        </FormField>

        <FormField label="Attachment (optional)" htmlFor="hw-file">
          <div className="flex items-center gap-3">
            <input ref={fileInputRef} id="hw-file" type="file" accept=".pdf,image/*" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && f.size > 5 * 1024 * 1024) { setError('File must be under 5 MB'); return; }
                setForm((prev) => ({ ...prev, file: f ?? null }));
              }} />
            <button type="button" onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-gray-700">
              {form.file ? 'Change file' : 'Choose file'}
            </button>
            {form.file ? (
              <span className="text-sm text-gray-600 truncate max-w-xs">{form.file.name}</span>
            ) : (
              <span className="text-xs text-gray-400">PDF or image, max 5 MB</span>
            )}
          </div>
        </FormField>

        {error && (
          <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={uploading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
            {uploading && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {uploading ? 'Saving…' : mode === 'create' ? 'Create Homework' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TeacherHomeworkPage() {
  const { user } = useAuth();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterSubject, setFilterSubject] = useState('');

  // Homework list
  const [homework, setHomework] = useState<HomeworkItem[]>([]);
  const [loadingHomework, setLoadingHomework] = useState(false);
  const [ackCounts, setAckCounts] = useState<Record<string, AckCount>>({});

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [editItem, setEditItem] = useState<HomeworkItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<HomeworkItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [listError, setListError] = useState('');

  // ── Load assignments + subjects ─────────────────────────────────────────────

  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;

    Promise.all([
      assignmentsApi.list(token, user.school_id),
      fetch(`${BASE_URL}/api/subjects?school_id=${user.school_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
    ])
      .then(([assignRes, subjectRes]) => {
        const myAssignments = assignRes.data.filter((a) => a.teacher_id === user.id);
        setAssignments(myAssignments);
        setSubjects((subjectRes.data as Subject[]) ?? []);
      })
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  // ── Derived dropdowns ───────────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === filterClass).map((a) => a.section)
  )].sort();
  const subjectsForFilter = [...new Set(
    assignments.filter((a) => a.class_name === filterClass && a.section === filterSection).map((a) => a.subject)
  )].sort();

  // ── Fetch homework ──────────────────────────────────────────────────────────

  const fetchHomework = useCallback(async () => {
    if (!filterClass || !filterSection || !user?.school_id) return;
    const token = getToken();
    if (!token) return;
    setLoadingHomework(true);
    setListError('');
    try {
      const qs = new URLSearchParams({
        class: filterClass,
        section: filterSection,
        school_id: user.school_id,
      });
      const res = await fetch(`${BASE_URL}/api/homework/class?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load homework');

      let list: HomeworkItem[] = (json.data as HomeworkItem[]) ?? [];
      // Sort by due_date descending
      list = list.sort((a, b) => b.due_date.localeCompare(a.due_date));
      // Filter by subject if selected
      if (filterSubject) {
        list = list.filter((h) => h.subject_name === filterSubject);
      }
      setHomework(list);

      // Fetch ack counts for each homework item
      const counts: Record<string, AckCount> = {};
      await Promise.all(
        list.map(async (hw) => {
          try {
            const ackRes = await fetch(`${BASE_URL}/api/homework/acknowledgements/${hw.id}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (ackRes.ok) {
              const ackJson = await ackRes.json();
              counts[hw.id] = ackJson.data as AckCount;
            }
          } catch { /* best-effort */ }
        })
      );
      setAckCounts(counts);
    } catch (err: unknown) {
      setListError(err instanceof Error ? err.message : 'Failed to load homework');
    } finally {
      setLoadingHomework(false);
    }
  }, [filterClass, filterSection, filterSubject, user]);

  useEffect(() => {
    fetchHomework();
  }, [fetchHomework]);

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteItem) return;
    const token = getToken();
    if (!token) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const res = await fetch(`${BASE_URL}/api/homework/${deleteItem.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Delete failed');
      setDeleteItem(null);
      fetchHomework();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Homework"
        description="Manage homework assignments for your classes"
        action={
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create Homework
          </button>
        }
      />

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <select className={inputClass} disabled={loadingAssignments}
            value={filterClass}
            onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setFilterSubject(''); }}>
            <option value="">{loadingAssignments ? 'Loading…' : 'All classes'}</option>
            {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className={inputClass} disabled={!filterClass}
            value={filterSection}
            onChange={(e) => { setFilterSection(e.target.value); setFilterSubject(''); }}>
            <option value="">All sections</option>
            {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className={inputClass} disabled={!filterSection}
            value={filterSubject}
            onChange={(e) => setFilterSubject(e.target.value)}>
            <option value="">All subjects</option>
            {subjectsForFilter.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* ── Homework list ────────────────────────────────────────────────── */}
      {!filterClass || !filterSection ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <p className="text-sm text-gray-500">Select a class and section to view homework</p>
        </div>
      ) : loadingHomework ? (
        <HomeworkSkeleton />
      ) : listError ? (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{listError}</div>
      ) : homework.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <p className="text-sm text-gray-500 mb-3">No homework found for this class</p>
          <button onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
            Create first homework
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {homework.map((hw) => (
            <HomeworkCard
              key={hw.id}
              item={hw}
              ackCount={ackCounts[hw.id] ?? null}
              onEdit={(item) => setEditItem(item)}
              onDelete={(item) => { setDeleteItem(item); setDeleteError(''); }}
            />
          ))}
        </div>
      )}

      {/* ── Create modal ─────────────────────────────────────────────────── */}
      <HomeworkFormModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        mode="create"
        subjects={subjects}
        myClasses={myClasses}
        assignments={assignments}
        filterClass={filterClass}
        filterSection={filterSection}
        onSuccess={fetchHomework}
      />

      {/* ── Edit modal ───────────────────────────────────────────────────── */}
      <HomeworkFormModal
        open={!!editItem}
        onClose={() => setEditItem(null)}
        mode="edit"
        initial={editItem}
        subjects={subjects}
        myClasses={myClasses}
        assignments={assignments}
        filterClass={filterClass}
        filterSection={filterSection}
        onSuccess={() => { setEditItem(null); fetchHomework(); }}
      />

      {/* ── Delete confirmation modal ────────────────────────────────────── */}
      <Modal open={!!deleteItem} onClose={() => setDeleteItem(null)} title="Delete Homework" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Delete this homework?{' '}
            <span className="font-semibold text-gray-900">{deleteItem?.title}</span>
            <br />
            <span className="text-gray-500">Students will no longer see it.</span>
          </p>
          {deleteError && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{deleteError}</div>
          )}
          <div className="flex justify-end gap-3">
            <button onClick={() => setDeleteItem(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button onClick={handleDelete} disabled={deleting}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 rounded-lg transition-colors">
              {deleting && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
