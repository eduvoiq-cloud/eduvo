'use client';

import { useEffect, useState, useCallback, useRef, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useAuth } from '@/context/AuthContext';
import { adminApi, feesApi, authApi, type AdminStudent, type FeeRecord } from '@/lib/api';
import { getToken, saveSession } from '@/lib/session';
import { useDebounce } from '@/lib/useDebounce';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentForm {
  name: string;
  class: string;
  section: string;
  roll_number: string;
  parent_email: string;
  phone: string;
  photo_url: string;
}

const EMPTY_FORM: StudentForm = {
  name: '', class: '', section: '', roll_number: '',
  parent_email: '', phone: '', photo_url: '',
};

// ── Skeleton loader ───────────────────────────────────────────────────────────

function StudentTableSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Photo', 'Name', 'Roll No', 'Class', 'Section', 'Fees', 'Actions'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                <td className="px-4 py-3"><div className="w-9 h-9 rounded-full bg-gray-200" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-32" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-12" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-16" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-8" /></td>
                <td className="px-4 py-3"><div className="h-5 bg-gray-200 rounded-full w-16" /></td>
                <td className="px-4 py-3"><div className="h-6 bg-gray-200 rounded w-20 ml-auto" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function compressImage(file: File, maxKB = 200): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      const MAX_DIM = 800;
      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas not supported')); return; }
      ctx.drawImage(img, 0, 0, width, height);
      let quality = 0.8;
      let dataUrl = canvas.toDataURL('image/jpeg', quality);
      while (dataUrl.length * 0.75 > maxKB * 1024 && quality > 0.1) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      resolve(dataUrl);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

function exportCSV(students: AdminStudent[]) {
  const headers = ['Name', 'Roll No', 'Class', 'Section', 'Phone'];
  const rows = students.map((s) => [
    `"${s.full_name}"`, s.roll_number ?? '', s.class_name, s.section ?? '',
    s.phone ?? '',
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `students_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadIdCard(student: AdminStudent, schoolName: string) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>ID Card – ${student.full_name}</title>
<style>
  body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f3f4f6}
  .card{width:340px;border:2px solid #2563eb;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12)}
  .header{background:#2563eb;color:#fff;padding:16px 20px;text-align:center}
  .header h1{margin:0;font-size:18px;font-weight:700}
  .header p{margin:4px 0 0;font-size:12px;opacity:.85}
  .body{padding:20px;display:flex;gap:16px;align-items:flex-start}
  .photo{width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid #2563eb;flex-shrink:0;background:#dbeafe;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#2563eb}
  .info{flex:1}
  .name{font-size:16px;font-weight:700;color:#111827;margin:0 0 4px}
  .row{font-size:12px;color:#6b7280;margin:2px 0}
  .row span{font-weight:600;color:#374151}
  .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:10px 20px;text-align:center;font-size:11px;color:#9ca3af}
</style></head><body>
<div class="card">
  <div class="header"><h1>${schoolName}</h1><p>Student Identity Card</p></div>
  <div class="body">
    ${student.photo_url
      ? `<img class="photo" src="${student.photo_url}" alt="${student.full_name}" />`
      : `<div class="photo">${student.full_name.charAt(0).toUpperCase()}</div>`}
    <div class="info">
      <p class="name">${student.full_name}</p>
      <p class="row">Roll No: <span>${student.roll_number ?? '—'}</span></p>
      <p class="row">Class: <span>${student.class_name}${student.section ? ' – ' + student.section : ''}</span></p>
    </div>
  </div>
  <div class="footer">This card is the property of ${schoolName}</div>
</div>
<script>window.onload=()=>window.print()</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FeeBadge({ paid }: { paid: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
      paid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full inline-block ${paid ? 'bg-green-500' : 'bg-red-400'}`} />
      {paid ? 'Paid' : 'Unpaid'}
    </span>
  );
}

function PhotoUpload({ preview, onFile }: { preview: string; onFile: (dataUrl: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [compressing, setCompressing] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCompressing(true);
    try {
      const dataUrl = await compressImage(file);
      onFile(dataUrl);
    } catch {
      onFile(URL.createObjectURL(file));
    } finally {
      setCompressing(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div onClick={() => ref.current?.click()}
        className="w-16 h-16 rounded-full border-2 border-dashed border-gray-300 hover:border-blue-400 flex items-center justify-center cursor-pointer overflow-hidden transition-colors bg-gray-50">
        {compressing ? (
          <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        ) : preview ? (
          <Image src={preview} alt="Preview" width={64} height={64} className="w-full h-full object-cover" />
        ) : (
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        )}
      </div>
      <div>
        <p className="text-sm font-medium text-gray-700">Student Photo</p>
        <p className="text-xs text-gray-400">Click to upload · auto-compressed to ≤200 KB</p>
        <input ref={ref} type="file" accept="image/*" className="hidden" onChange={handleChange} />
      </div>
    </div>
  );
}

function StudentFormFields({
  form, setForm, photoPreview, setPhotoPreview, formError, submitting, onCancel, submitLabel,
}: {
  form: StudentForm;
  setForm: React.Dispatch<React.SetStateAction<StudentForm>>;
  photoPreview: string;
  setPhotoPreview: (v: string) => void;
  formError: string;
  submitting: boolean;
  onCancel: () => void;
  submitLabel: string;
}) {
  return (
    <div className="space-y-4">
      {formError && (
        <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
      )}
      <PhotoUpload preview={photoPreview}
        onFile={(url) => { setPhotoPreview(url); setForm((f) => ({ ...f, photo_url: url })); }} />
      <FormField label="Full Name" htmlFor="sf-name" required>
        <input id="sf-name" type="text" className={inputClass} placeholder="e.g. John Doe"
          value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Class" htmlFor="sf-class" required>
          <input id="sf-class" type="text" className={inputClass} placeholder="e.g. Grade 5"
            value={form.class} onChange={(e) => setForm((f) => ({ ...f, class: e.target.value }))} required />
        </FormField>
        <FormField label="Section" htmlFor="sf-section" required>
          <input id="sf-section" type="text" className={inputClass} placeholder="e.g. A"
            value={form.section} onChange={(e) => setForm((f) => ({ ...f, section: e.target.value }))} required />
        </FormField>
      </div>
      <FormField label="Roll Number" htmlFor="sf-roll">
        <input id="sf-roll" type="text" className={inputClass} placeholder="e.g. 42"
          value={form.roll_number} onChange={(e) => setForm((f) => ({ ...f, roll_number: e.target.value }))} />
      </FormField>
      <FormField label="Parent Email" htmlFor="sf-pemail">
        <input id="sf-pemail" type="email" className={inputClass} placeholder="parent@example.com"
          value={form.parent_email} onChange={(e) => setForm((f) => ({ ...f, parent_email: e.target.value }))} />
        <p className="mt-1 text-xs text-gray-400">An invite will be sent automatically if the parent has no account.</p>
      </FormField>
      <FormField label="Student Phone (used for mobile app login)" htmlFor="sf-pphone">
        <input id="sf-pphone" type="tel" className={inputClass} placeholder="10-digit mobile number e.g. 9812345678"
          value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
        <p className="mt-1 text-xs text-gray-400">Student logs into the mobile app with this number. Default password = last 5 digits.</p>
      </FormField>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={submitting}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
          {submitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Pagination controls ───────────────────────────────────────────────────────

function Pagination({
  page, totalPages, onPrev, onNext,
}: { page: number; totalPages: number; onPrev: () => void; onNext: () => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50">
      <p className="text-xs text-gray-500">
        Page {page} of {totalPages}
      </p>
      <div className="flex items-center gap-2">
        <button onClick={onPrev} disabled={page <= 1}
          className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          ← Prev
        </button>
        <button onClick={onNext} disabled={page >= totalPages}
          className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          Next →
        </button>
      </div>
    </div>
  );
}

// ── Main inner component ──────────────────────────────────────────────────────

function StudentsPageInner() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();

  // ── Data state ──────────────────────────────────────────────────────────
  const [students, setStudents] = useState<AdminStudent[]>([]);
  const [feeMap, setFeeMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // ── Pagination state ────────────────────────────────────────────────────
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // ── Filter state ────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedStudents, setDeletedStudents] = useState<AdminStudent[]>([]);

  // Debounce search — only fires API call 300ms after user stops typing
  const debouncedSearch = useDebounce(search, 300);

  // ── Modal state ─────────────────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminStudent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminStudent | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<AdminStudent | null>(null);

  // ── Form state ──────────────────────────────────────────────────────────
  const [form, setForm] = useState<StudentForm>(EMPTY_FORM);
  const [photoPreview, setPhotoPreview] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Open add modal from URL param
  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setShowAdd(true);
      router.replace('/admin/students');
    }
  }, [searchParams, router]);

  // ── Fetch paginated active students ─────────────────────────────────────

  const fetchStudents = useCallback(async (currentPage: number) => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      // Self-heal: if school_id is missing from cached session, fetch fresh profile
      if (!user?.school_id) {
        const meRes = await authApi.me(token);
        if (meRes.data.user.school_id) {
          saveSession(token, meRes.data.user);
        } else {
          setLoading(false);
          return;
        }
      }

      const res = await adminApi.listStudents(token, {
        include_deleted: false,
        page: currentPage,
        limit: PAGE_SIZE,
        search: debouncedSearch || undefined,
        class_name: filterClass || undefined,
        section: filterSection || undefined,
      });
      // adminApi.listStudents returns paginated envelope when limit > 0
      const envelope = res.data as unknown as {
        data: AdminStudent[];
        total: number;
        page: number;
        limit: number;
        total_pages: number;
      };
      if (envelope && 'total_pages' in envelope) {
        setStudents(envelope.data ?? []);
        setTotal(envelope.total ?? 0);
        setTotalPages(envelope.total_pages ?? 1);
      } else {
        // Fallback: plain array (older API)
        const plain = res.data as unknown as AdminStudent[];
        setStudents(plain ?? []);
        setTotal(plain?.length ?? 0);
        setTotalPages(1);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load students');
    } finally {
      setLoading(false);
    }
  }, [user, debouncedSearch, filterClass, filterSection]);

  // Fetch deleted students separately (only when panel is open)
  const fetchDeleted = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await adminApi.listStudents(token, { include_deleted: true });
      const all = res.data as unknown as AdminStudent[];
      setDeletedStudents((all ?? []).filter((s) => s.is_deleted));
    } catch { /* swallow */ }
  }, []);

  // Fetch fees once
  const fetchFees = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const feesRes = await feesApi.list(token).catch(() => ({ data: [] as FeeRecord[] }));
      const map: Record<string, boolean> = {};
      for (const f of feesRes.data ?? []) map[f.student_id] = f.fee_paid;
      setFeeMap(map);
    } catch { /* swallow */ }
  }, []);

  // Reset to page 1 when filters/search change
  useEffect(() => { setPage(1); }, [debouncedSearch, filterClass, filterSection]);

  useEffect(() => { fetchStudents(page); }, [fetchStudents, page]);
  useEffect(() => { fetchFees(); }, [fetchFees]);
  useEffect(() => { if (showDeleted) fetchDeleted(); }, [showDeleted, fetchDeleted]);

  // ── Add student ─────────────────────────────────────────────────────────

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!form.name.trim() || !form.class.trim() || !form.section.trim()) {
      setFormError('Full name, class, and section are required.');
      return;
    }
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await adminApi.createStudent(token, {
        name: form.name.trim(), class: form.class.trim(), section: form.section.trim(),
        roll_number: form.roll_number.trim() || undefined,
        parent_email: form.parent_email.trim() || undefined,
        parent_phone: form.phone.trim() || undefined,
        photo_url: form.photo_url || undefined,
      });
      setShowAdd(false);
      setForm(EMPTY_FORM);
      setPhotoPreview('');
      fetchStudents(page);
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to add student');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Edit student ────────────────────────────────────────────────────────

  function openEdit(s: AdminStudent) {
    setEditTarget(s);
    setForm({ name: s.full_name, class: s.class_name, section: s.section ?? '',
      roll_number: s.roll_number ?? '', parent_email: '', phone: s.phone ?? '',
      photo_url: s.photo_url ?? '' });
    setPhotoPreview(s.photo_url ?? '');
    setFormError('');
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    setFormError('');
    if (!form.name.trim() || !form.class.trim() || !form.section.trim()) {
      setFormError('Full name, class, and section are required.');
      return;
    }
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await adminApi.updateStudent(token, editTarget.id, {
        name: form.name.trim(), class: form.class.trim(), section: form.section.trim(),
        roll_number: form.roll_number.trim() || undefined,
        parent_email: form.parent_email.trim() || undefined,
        parent_phone: form.phone.trim() || undefined,
        photo_url: form.photo_url || undefined,
      });
      setEditTarget(null);
      setForm(EMPTY_FORM);
      setPhotoPreview('');
      fetchStudents(page);
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to update student');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Delete / Restore ────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteTarget) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await adminApi.deleteStudent(token, deleteTarget.id);
      setDeleteTarget(null);
      fetchStudents(page);
      if (showDeleted) fetchDeleted();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to delete student');
      setDeleteTarget(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRestore() {
    if (!restoreTarget) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await adminApi.restoreStudent(token, restoreTarget.id);
      setRestoreTarget(null);
      fetchStudents(page);
      fetchDeleted();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to restore student');
      setRestoreTarget(null);
    } finally {
      setSubmitting(false);
    }
  }

  const schoolName = user?.name ?? 'School';

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Students"
        description={`${total} student${total !== 1 ? 's' : ''} enrolled`}
        action={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button onClick={() => exportCSV(students)}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
            <button onClick={() => router.push('/admin/import/students')}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Bulk Import
            </button>
            <button onClick={() => { setForm(EMPTY_FORM); setPhotoPreview(''); setFormError(''); setShowAdd(true); }}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Student
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        {/* Search with debounce — API call fires 300ms after typing stops */}
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input type="text" placeholder="Search by name or roll number…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          {/* Show spinner while debounce is pending */}
          {search !== debouncedSearch && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        <input type="text" placeholder="Filter by class…" value={filterClass}
          onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); }}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-36" />
        <input type="text" placeholder="Filter by section…" value={filterSection}
          onChange={(e) => setFilterSection(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-36" />
      </div>

      {/* ── Active Students Table ─────────────────────────────────────────── */}
      {loading ? (
        <StudentTableSkeleton />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
          {students.length === 0 ? (
            <div className="text-center py-16 text-sm text-gray-500">
              {search || filterClass || filterSection
                ? 'No students match your filters.'
                : 'No students yet. Add your first student.'}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Photo</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Roll No</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Class</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Section</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Fees</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {students.map((s) => (
                      <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3">
                          {s.photo_url ? (
                            <Image src={s.photo_url} alt={s.full_name} width={36} height={36}
                              className="w-9 h-9 rounded-full object-cover" />
                          ) : (
                            <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-semibold">
                              {s.full_name.charAt(0).toUpperCase()}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900">{s.full_name}</td>
                        <td className="px-4 py-3 text-gray-500">{s.roll_number ?? '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{s.class_name}</td>
                        <td className="px-4 py-3 text-gray-600">{s.section ?? '—'}</td>
                        <td className="px-4 py-3"><FeeBadge paid={feeMap[s.id] ?? false} /></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <Link
                              href={`/admin/marks/student/${s.id}`}
                              title="View marks"
                              className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded-md transition-colors"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            </Link>
                            <button onClick={() => openEdit(s)} title="Edit student"
                              className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button onClick={() => downloadIdCard(s, schoolName)} title="Download ID card"
                              className="p-1.5 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded-md transition-colors">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0" />
                              </svg>
                            </button>
                            <button onClick={() => setDeleteTarget(s)} title="Delete student"
                              className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Pagination — shows 50 students per page */}
              <Pagination page={page} totalPages={totalPages}
                onPrev={() => setPage((p) => Math.max(1, p - 1))}
                onNext={() => setPage((p) => Math.min(totalPages, p + 1))} />
            </>
          )}
        </div>
      )}

      {/* ── Deleted Students Toggle ───────────────────────────────────────── */}
      <div className="mb-4">
        <button onClick={() => setShowDeleted((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
          <svg className={`w-4 h-4 transition-transform ${showDeleted ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          {showDeleted ? 'Hide' : 'Show'} deleted students
          {deletedStudents.length > 0 && (
            <span className="ml-1 px-1.5 py-0.5 text-xs bg-gray-200 text-gray-600 rounded-full">{deletedStudents.length}</span>
          )}
        </button>
      </div>

      {showDeleted && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
          <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Deleted Students</p>
          </div>
          {deletedStudents.length === 0 ? (
            <p className="text-center py-8 text-sm text-gray-400">No deleted students.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Class</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Section</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Deleted At</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {deletedStudents.map((s) => (
                    <tr key={s.id} className="opacity-70 hover:opacity-100 transition-opacity">
                      <td className="px-4 py-3 font-medium text-gray-700">{s.full_name}</td>
                      <td className="px-4 py-3 text-gray-500">{s.class_name}</td>
                      <td className="px-4 py-3 text-gray-500">{s.section ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {s.deleted_at ? new Date(s.deleted_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => setRestoreTarget(s)}
                          className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded-md transition-colors">
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      <Modal open={showAdd} onClose={() => { setShowAdd(false); setFormError(''); }} title="Add Student" size="lg">
        <form onSubmit={handleAdd}>
          <StudentFormFields form={form} setForm={setForm} photoPreview={photoPreview}
            setPhotoPreview={setPhotoPreview} formError={formError} submitting={submitting}
            onCancel={() => { setShowAdd(false); setFormError(''); }} submitLabel="Add Student" />
        </form>
      </Modal>

      <Modal open={!!editTarget} onClose={() => { setEditTarget(null); setFormError(''); }} title="Edit Student" size="lg">
        <form onSubmit={handleEdit}>
          <StudentFormFields form={form} setForm={setForm} photoPreview={photoPreview}
            setPhotoPreview={setPhotoPreview} formError={formError} submitting={submitting}
            onCancel={() => { setEditTarget(null); setFormError(''); }} submitLabel="Save Changes" />
        </form>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Student" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Are you sure you want to delete <strong>{deleteTarget?.full_name}</strong>?
          </p>
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            This will soft delete the student. They can be restored from the &quot;Show deleted students&quot; section.
          </p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setDeleteTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button onClick={handleDelete} disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors">
              {submitting ? 'Deleting…' : 'Yes, Delete'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!restoreTarget} onClose={() => setRestoreTarget(null)} title="Restore Student" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Restore <strong>{restoreTarget?.full_name}</strong> back to the active student list?
          </p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setRestoreTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button onClick={handleRestore} disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-lg transition-colors">
              {submitting ? 'Restoring…' : 'Yes, Restore'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ── Page export ───────────────────────────────────────────────────────────────

export default function StudentsPage() {
  return <Suspense><StudentsPageInner /></Suspense>;
}
