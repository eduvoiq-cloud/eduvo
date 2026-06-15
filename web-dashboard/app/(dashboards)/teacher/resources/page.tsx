'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResourceItem {
  id: string;
  school_id: string;
  teacher_id: string;
  class: string;
  section: string;
  subject: string;
  title: string;
  description: string | null;
  resource_type: 'note' | 'assignment';
  file_urls: string[];
  due_date: string | null;
  created_at: string;
}

interface UploadForm {
  class_name: string;
  section: string;
  subject: string;
  title: string;
  description: string;
  resource_type: 'note' | 'assignment';
  due_date: string;
  files: File[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '—';
  const [year, month, day] = iso.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(day).padStart(2,'0')} ${months[month - 1]} ${year}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isImageUrl(url: string): boolean {
  return /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url);
}

function fileLabel(url: string, idx: number): string {
  try {
    const parts = new URL(url).pathname.split('/');
    const name = decodeURIComponent(parts[parts.length - 1] ?? '');
    return name.length > 40 ? name.slice(0, 37) + '…' : name;
  } catch {
    return `File ${idx + 1}`;
  }
}

const DEFAULT_FORM: UploadForm = {
  class_name: '',
  section: '',
  subject: '',
  title: '',
  description: '',
  resource_type: 'note',
  due_date: todayISO(),
  files: [],
};

// ── Sub-components ────────────────────────────────────────────────────────────

function ResourceSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
          <div className="flex items-start gap-3">
            <div className="h-5 w-20 bg-gray-200 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="h-5 bg-gray-200 rounded w-2/3" />
              <div className="h-3 bg-gray-200 rounded w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResourceTypeBadge({ type }: { type: 'note' | 'assignment' }) {
  return type === 'note' ? (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
      📚 Note
    </span>
  ) : (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
      📝 Assignment
    </span>
  );
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({
  item,
  onClose,
  onSuccess,
}: {
  item: ResourceItem;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [dueDate, setDueDate] = useState(item.due_date ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setError('');
    const token = getToken();
    if (!token) return;
    if (!title.trim()) { setError('Title is required.'); return; }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { title: title.trim() };
      if (description.trim()) payload.description = description.trim();
      else payload.description = null;
      if (dueDate) payload.due_date = dueDate;
      else payload.due_date = null;

      const res = await fetch(`${BASE_URL}/api/subject-resources/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Update failed');
      onSuccess();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">Edit Resource</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          <FormField label="Title" htmlFor="edit-title">
            <input id="edit-title" type="text" className={inputClass}
              value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
          </FormField>

          <FormField label="Description (optional)" htmlFor="edit-desc">
            <textarea id="edit-desc" className={`${inputClass} resize-none`} rows={3}
              value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </FormField>

          {item.resource_type === 'assignment' && (
            <FormField label="Due Date" htmlFor="edit-due">
              <input id="edit-due" type="date" className={inputClass}
                value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </FormField>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button onClick={onClose}
              className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors">
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TeacherResourcesPage() {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [form, setForm] = useState<UploadForm>({ ...DEFAULT_FORM });
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [loadingResources, setLoadingResources] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<ResourceItem | null>(null);

  const token = getToken();

  // ── Load teacher assignments ────────────────────────────────────────────────
  useEffect(() => {
    if (!token || !user?.school_id) return;
    assignmentsApi.list(token, user.school_id)
      .then((res) => {
        // Filter to only this teacher's assignments
        const all = (res.data as unknown as { data: TeacherAssignment[] }).data
          ?? (res.data as unknown as TeacherAssignment[])
          ?? [];
        setAssignments(all.filter((a: TeacherAssignment) => a.teacher_id === user.id));
      })
      .catch(() => {});
  }, [token, user?.school_id, user?.id]);

  // ── Load teacher's uploaded resources ──────────────────────────────────────
  const loadResources = useCallback(async () => {
    if (!token) return;
    setLoadingResources(true);
    try {
      const res = await fetch(`${BASE_URL}/api/subject-resources/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      setResources(json.data ?? []);
    } catch {
      // silent
    } finally {
      setLoadingResources(false);
    }
  }, [token]);

  useEffect(() => { loadResources(); }, [loadResources]);

  // ── Derived dropdown options from assignments ───────────────────────────────
  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === form.class_name).map((a) => a.section)
  )].sort();
  const subjectsForClassSection = [...new Set(
    assignments
      .filter((a) => a.class_name === form.class_name && a.section === form.section)
      .map((a) => a.subject)
  )].sort();

  function setField<K extends keyof UploadForm>(key: K, value: UploadForm[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // Reset cascading fields
      if (key === 'class_name') { next.section = ''; next.subject = ''; }
      if (key === 'section')    { next.subject = ''; }
      return next;
    });
  }

  // ── File selection ──────────────────────────────────────────────────────────
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    setForm((prev) => ({ ...prev, files: [...prev.files, ...selected].slice(0, 10) }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeFile(idx: number) {
    setForm((prev) => ({ ...prev, files: prev.files.filter((_, i) => i !== idx) }));
  }

  // ── Upload + create resource ────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    setFormSuccess('');

    if (!form.class_name)  { setFormError('Please select a class.'); return; }
    if (!form.section)     { setFormError('Please select a section.'); return; }
    if (!form.subject)     { setFormError('Please select a subject.'); return; }
    if (!form.title.trim()) { setFormError('Title is required.'); return; }
    if (form.files.length === 0) { setFormError('Please select at least one file to upload.'); return; }
    if (!token) return;

    setUploading(true);
    try {
      // 1. Upload files
      const fd = new FormData();
      form.files.forEach((f) => fd.append('files', f));
      const uploadRes = await fetch(`${BASE_URL}/api/subject-resources/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const uploadJson = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadJson.message ?? 'File upload failed');
      const fileUrls: string[] = uploadJson.data?.urls ?? [];

      // 2. Create resource record
      const payload: Record<string, unknown> = {
        class: form.class_name,
        section: form.section,
        subject: form.subject,
        title: form.title.trim(),
        description: form.description.trim() || null,
        resource_type: form.resource_type,
        file_urls: fileUrls,
      };
      if (form.resource_type === 'assignment' && form.due_date) {
        payload.due_date = form.due_date;
      }

      const createRes = await fetch(`${BASE_URL}/api/subject-resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const createJson = await createRes.json();
      if (!createRes.ok) throw new Error(createJson.message ?? 'Failed to create resource');

      setFormSuccess('Resource uploaded and students have been notified! 🎉');
      setForm({ ...DEFAULT_FORM });
      loadResources();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  // ── Delete resource ─────────────────────────────────────────────────────────
  async function handleDelete(item: ResourceItem) {
    if (!confirm(`Delete "${item.title}"? This will also remove the uploaded files.`)) return;
    if (!token) return;
    setDeletingId(item.id);
    try {
      const res = await fetch(`${BASE_URL}/api/subject-resources/${item.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = await res.json();
        alert(json.message ?? 'Delete failed');
        return;
      }
      setResources((prev) => prev.filter((r) => r.id !== item.id));
    } catch {
      alert('Delete failed. Please try again.');
    } finally {
      setDeletingId(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      {editItem && (
        <EditModal
          item={editItem}
          onClose={() => setEditItem(null)}
          onSuccess={() => { setEditItem(null); loadResources(); }}
        />
      )}

      <PageHeader
        title="Notes & Resources"
        description="Upload notes and assignments for your students — they'll be notified instantly"
      />

      {/* ── Upload form ───────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-8">
        <h2 className="text-base font-semibold text-gray-900 mb-5">Upload New Resource</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Class + Section */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Class *" htmlFor="res-class">
              <select id="res-class" className={inputClass}
                value={form.class_name} onChange={(e) => setField('class_name', e.target.value)}>
                <option value="">Select class…</option>
                {myClasses.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </FormField>

            <FormField label="Section *" htmlFor="res-section">
              <select id="res-section" className={inputClass}
                value={form.section} onChange={(e) => setField('section', e.target.value)}
                disabled={!form.class_name}>
                <option value="">Select section…</option>
                {sectionsForClass.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </FormField>
          </div>

          {/* Subject */}
          <FormField label="Subject *" htmlFor="res-subject">
            <select id="res-subject" className={inputClass}
              value={form.subject} onChange={(e) => setField('subject', e.target.value)}
              disabled={!form.section}>
              <option value="">Select subject…</option>
              {subjectsForClassSection.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </FormField>

          {/* Title */}
          <FormField label="Title *" htmlFor="res-title">
            <input id="res-title" type="text" className={inputClass}
              placeholder="e.g. Chapter 5 Notes, Assignment — Quadratic Equations"
              value={form.title} onChange={(e) => setField('title', e.target.value)}
              maxLength={300} />
          </FormField>

          {/* Description */}
          <FormField label="Description (optional)" htmlFor="res-desc">
            <textarea id="res-desc" className={`${inputClass} resize-none`} rows={2}
              placeholder="Short note for students (optional)…"
              value={form.description} onChange={(e) => setField('description', e.target.value)}
              maxLength={2000} />
          </FormField>

          {/* Type toggle */}
          <div>
            <p className="block text-sm font-medium text-gray-700 mb-2">Resource Type</p>
            <div className="flex gap-3">
              {(['note', 'assignment'] as const).map((t) => (
                <button key={t} type="button"
                  onClick={() => setField('resource_type', t)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border-2 transition-colors ${
                    form.resource_type === t
                      ? t === 'note'
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-orange-500 bg-orange-500 text-white'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300 bg-white'
                  }`}>
                  {t === 'note' ? '📚 Note' : '📝 Assignment'}
                </button>
              ))}
            </div>
          </div>

          {/* Due date (assignment only) */}
          {form.resource_type === 'assignment' && (
            <FormField label="Due Date *" htmlFor="res-due">
              <input id="res-due" type="date" className={inputClass}
                value={form.due_date} onChange={(e) => setField('due_date', e.target.value)} />
            </FormField>
          )}

          {/* File upload */}
          <div>
            <p className="block text-sm font-medium text-gray-700 mb-2">Files * (PDF or images, max 10)</p>
            <div
              className="border-2 border-dashed border-gray-300 hover:border-blue-400 rounded-xl px-4 py-6 text-center cursor-pointer transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              aria-label="Click to select files"
            >
              <svg className="w-8 h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-sm text-gray-500">
                Click to select or drag &amp; drop
              </p>
              <p className="text-xs text-gray-400 mt-1">PDF, JPEG, PNG, WebP — up to 20 MB each</p>
            </div>
            <input ref={fileInputRef} type="file" multiple accept=".pdf,image/*"
              className="hidden" onChange={handleFileChange} />

            {/* Selected files list */}
            {form.files.length > 0 && (
              <div className="mt-3 space-y-2">
                {form.files.map((file, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-lg">{file.type.startsWith('image/') ? '🖼️' : '📄'}</span>
                      <span className="text-sm text-gray-700 truncate">{file.name}</span>
                      <span className="text-xs text-gray-400 shrink-0">
                        ({(file.size / 1024 / 1024).toFixed(1)} MB)
                      </span>
                    </div>
                    <button type="button" onClick={() => removeFile(idx)}
                      className="text-red-400 hover:text-red-600 shrink-0" aria-label={`Remove ${file.name}`}>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Errors / success */}
          {formError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              {formError}
            </div>
          )}
          {formSuccess && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
              {formSuccess}
            </div>
          )}

          <button type="submit" disabled={uploading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2">
            {uploading ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Uploading &amp; Notifying…
              </>
            ) : (
              '📤 Upload Resource'
            )}
          </button>
        </form>
      </div>

      {/* ── Previously uploaded resources ─────────────────────────────────── */}
      <div>
        <h2 className="text-base font-semibold text-gray-900 mb-4">Your Uploaded Resources</h2>

        {loadingResources ? (
          <ResourceSkeleton />
        ) : resources.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-12 text-center">
            <p className="text-3xl mb-3">📁</p>
            <p className="text-sm text-gray-500">No resources uploaded yet. Use the form above to get started.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {resources.map((item) => (
              <div key={item.id}
                className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-sm transition-shadow group">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <ResourceTypeBadge type={item.resource_type} />
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-semibold text-gray-900 leading-snug">{item.title}</h3>
                      {item.description && (
                        <p className="mt-1 text-sm text-gray-500 line-clamp-2">{item.description}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                          </svg>
                          {item.subject}
                        </span>
                        <span>{item.class} — {item.section}</span>
                        <span>Uploaded {formatDate(item.created_at.slice(0, 10))}</span>
                        {item.due_date && (
                          <span className="text-orange-600 font-medium">Due {formatDate(item.due_date)}</span>
                        )}
                      </div>

                      {/* Files */}
                      {item.file_urls.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {item.file_urls.map((url, idx) => (
                            <a key={idx} href={url} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors">
                              <span>{isImageUrl(url) ? '🖼️' : '📄'}</span>
                              {fileLabel(url, idx)}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setEditItem(item)}
                      className="px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
                      Edit
                    </button>
                    <button onClick={() => handleDelete(item)}
                      disabled={deletingId === item.id}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50">
                      {deletingId === item.id ? '…' : 'Delete'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
