'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { authApi, usersApi, assignmentsApi, type Teacher, type TeacherAssignment } from '@/lib/api';
import { getToken, saveSession } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AddTeacherForm { name: string; email: string; phone: string; }
interface AssignRow { class_name: string; section: string; subject: string; }

const EMPTY_TEACHER: AddTeacherForm = { name: '', email: '', phone: '' };
const EMPTY_ROW: AssignRow = { class_name: '', section: '', subject: '' };

// ── Page ──────────────────────────────────────────────────────────────────────

function TeachersPageInner() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Modals
  const [showAdd, setShowAdd] = useState(false);
  const [assignTarget, setAssignTarget] = useState<Teacher | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Teacher | null>(null);

  // Forms
  const [teacherForm, setTeacherForm] = useState<AddTeacherForm>(EMPTY_TEACHER);
  const [assignRows, setAssignRows] = useState<AssignRow[]>([{ ...EMPTY_ROW }]);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Open add modal from URL param
  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setShowAdd(true);
      router.replace('/admin/teachers');
    }
  }, [searchParams, router]);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      let schoolId = user?.school_id ?? null;
      if (!schoolId) {
        const meRes = await authApi.me(token);
        schoolId = meRes.data.user.school_id;
        if (schoolId) saveSession(token, meRes.data.user);
      }
      if (!schoolId) { setLoading(false); return; }

      const [tRes, aRes] = await Promise.all([
        usersApi.list(token, { role: 'teacher', school_id: schoolId }),
        assignmentsApi.list(token, schoolId),
      ]);
      setTeachers(tRes.data.data ?? tRes.data as unknown as Teacher[]);
      setAssignments(aRes.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load teachers');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Add teacher ───────────────────────────────────────────────────────────

  async function handleAddTeacher(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!teacherForm.name.trim() || !teacherForm.email.trim()) {
      setFormError('Name and email are required.');
      return;
    }
    if (!/^\d{10}$/.test(teacherForm.phone)) {
      setFormError('Phone number must be exactly 10 digits.');
      return;
    }
    const token = getToken();
    if (!token || !user?.school_id) return;
    setSubmitting(true);
    try {
      await authApi.createUser(token, {
        name: teacherForm.name.trim(),
        email: teacherForm.email.trim(),
        phone: teacherForm.phone.trim(),
        role: 'teacher',
        school_id: user.school_id,
      });
      setShowAdd(false);
      setTeacherForm(EMPTY_TEACHER);
      await fetchAll();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to create teacher');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Assign teacher ────────────────────────────────────────────────────────

  function updateAssignRow(index: number, field: keyof AssignRow, value: string) {
    setAssignRows((rows) => rows.map((r, i) => i === index ? { ...r, [field]: value } : r));
  }

  function addAssignRow() {
    setAssignRows((rows) => [...rows, { ...EMPTY_ROW }]);
  }

  function removeAssignRow(index: number) {
    setAssignRows((rows) => rows.filter((_, i) => i !== index));
  }

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    const filled = assignRows.filter(
      (r) => r.class_name.trim() || r.section.trim() || r.subject.trim()
    );
    if (filled.length === 0) {
      setFormError('Add at least one class assignment.');
      return;
    }
    const incomplete = filled.find(
      (r) => !r.class_name.trim() || !r.section.trim() || !r.subject.trim()
    );
    if (incomplete) {
      setFormError('All fields (Class, Section, Subject) are required in each row.');
      return;
    }

    const token = getToken();
    if (!token || !assignTarget || !user?.school_id) return;
    setSubmitting(true);
    try {
      await Promise.all(
        filled.map((r) =>
          assignmentsApi.create(token, {
            teacher_id: assignTarget.id,
            school_id: user.school_id!,
            class_name: r.class_name.trim(),
            section: r.section.trim(),
            subject: r.subject.trim(),
          })
        )
      );
      setAssignTarget(null);
      setAssignRows([{ ...EMPTY_ROW }]);
      await fetchAll();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to assign teacher');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Remove assignment ─────────────────────────────────────────────────────

  async function handleRemoveAssignment(assignmentId: string) {
    const token = getToken();
    if (!token) return;
    try {
      await assignmentsApi.remove(token, assignmentId);
      await fetchAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to remove assignment');
    }
  }

  // ── Remove teacher ────────────────────────────────────────────────────────

  async function handleRemoveTeacher() {
    if (!removeTarget) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await usersApi.remove(token, removeTarget.id);
      setRemoveTarget(null);
      await fetchAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to remove teacher');
      setRemoveTarget(null);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function teacherAssignments(teacherId: string) {
    return assignments.filter((a) => a.teacher_id === teacherId);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Teachers"
        description="Manage teaching staff and class assignments"
        action={
          <div className="flex items-center gap-2">
            {/* Bulk import button */}
            <button
              onClick={() => router.push('/admin/import/teachers')}
              className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg border border-gray-300 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Import Teachers
            </button>
            {/* Class Admins button */}
            <button
              onClick={() => router.push('/admin/teachers/class-admin')}
              className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg border border-gray-300 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Class Admins
            </button>
            {/* Add single teacher button */}
            <button
              onClick={() => {
                setTeacherForm(EMPTY_TEACHER);
                setFormError('');
                setShowAdd(true);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Teacher
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : teachers.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16 text-sm text-gray-500">
          No teachers yet.{' '}
          <button
            onClick={() => router.push('/admin/import/teachers')}
            className="text-blue-600 hover:underline font-medium"
          >
            Import in bulk
          </button>
          {' '}or add your first teacher above.
        </div>
      ) : (
        <div className="space-y-3">
          {teachers.map((teacher) => {
            const ta = teacherAssignments(teacher.id);
            return (
              <div key={teacher.id} className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-semibold text-sm shrink-0">
                      {teacher.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 text-sm">{teacher.name}</p>
                      <p className="text-xs text-gray-400 truncate">{teacher.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => { setAssignRows([{ ...EMPTY_ROW }]); setFormError(''); setAssignTarget(teacher); }}
                      className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                    >
                      Assign Class
                    </button>
                    <button
                      onClick={() => setRemoveTarget(teacher)}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {ta.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {ta.map((a) => (
                      <span
                        key={a.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-700 text-xs rounded-full"
                      >
                        <span className="font-medium">{a.class_name} {a.section}</span>
                        <span className="text-gray-400">·</span>
                        <span>{a.subject}</span>
                        <button
                          onClick={() => handleRemoveAssignment(a.id)}
                          className="ml-0.5 text-gray-400 hover:text-red-500 transition-colors"
                          aria-label="Remove assignment"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-gray-400 italic">No class assignments yet.</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Add Teacher Modal ──────────────────────────────────────────────── */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Teacher"
      >
        <form onSubmit={handleAddTeacher} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
          )}
          <FormField label="Full Name" htmlFor="t-name" required>
            <input
              id="t-name" type="text" className={inputClass} placeholder="Jane Smith"
              value={teacherForm.name}
              onChange={(e) => setTeacherForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </FormField>
          <FormField label="Email Address" htmlFor="t-email" required>
            <input
              id="t-email" type="email" className={inputClass} placeholder="teacher@school.com"
              value={teacherForm.email}
              onChange={(e) => setTeacherForm((f) => ({ ...f, email: e.target.value }))}
              required
            />
          </FormField>
          <FormField label="Phone Number" htmlFor="t-phone" required>
            <input
              id="t-phone" type="tel" className={inputClass} placeholder="10-digit mobile number"
              value={teacherForm.phone}
              onChange={(e) => setTeacherForm((f) => ({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }))}
              maxLength={10}
              required
            />
            <p className="mt-1 text-xs text-gray-400">This will be the teacher&apos;s default login password.</p>
          </FormField>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
            >
              {submitting ? 'Creating…' : 'Create Teacher'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Assign Class Modal ─────────────────────────────────────────────── */}
      <Modal
        open={!!assignTarget}
        onClose={() => { setAssignTarget(null); setAssignRows([{ ...EMPTY_ROW }]); }}
        title={`Assign Class — ${assignTarget?.name ?? ''}`}
      >
        <form onSubmit={handleAssign} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
          )}

          <div className="space-y-3">
            {assignRows.map((row, idx) => (
              <div key={idx} className="relative grid grid-cols-[1fr_1fr_1.5fr_auto] gap-2 items-end">
                <FormField label={idx === 0 ? 'Class' : ''} htmlFor={`a-class-${idx}`} required={idx === 0}>
                  <input
                    id={`a-class-${idx}`}
                    type="text"
                    className={inputClass}
                    placeholder="e.g. 10"
                    value={row.class_name}
                    onChange={(e) => updateAssignRow(idx, 'class_name', e.target.value)}
                  />
                </FormField>
                <FormField label={idx === 0 ? 'Section' : ''} htmlFor={`a-section-${idx}`} required={idx === 0}>
                  <input
                    id={`a-section-${idx}`}
                    type="text"
                    className={inputClass}
                    placeholder="e.g. A"
                    value={row.section}
                    onChange={(e) => updateAssignRow(idx, 'section', e.target.value)}
                  />
                </FormField>
                <FormField label={idx === 0 ? 'Subject' : ''} htmlFor={`a-subject-${idx}`} required={idx === 0}>
                  <input
                    id={`a-subject-${idx}`}
                    type="text"
                    className={inputClass}
                    placeholder="e.g. Mathematics"
                    value={row.subject}
                    onChange={(e) => updateAssignRow(idx, 'subject', e.target.value)}
                  />
                </FormField>
                <div className={idx === 0 ? 'pb-0.5' : ''}>
                  {assignRows.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeAssignRow(idx)}
                      className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                      aria-label="Remove row"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  ) : <div className="w-7" />}
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addAssignRow}
            className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add another class
          </button>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button" onClick={() => { setAssignTarget(null); setAssignRows([{ ...EMPTY_ROW }]); }}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
            >
              {submitting ? 'Saving…' : `Save ${assignRows.filter(r => r.class_name.trim()).length > 1 ? 'Assignments' : 'Assignment'}`}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Remove Teacher Confirm ─────────────────────────────────────────── */}
      <Modal open={!!removeTarget} onClose={() => setRemoveTarget(null)} title="Remove Teacher" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Are you sure you want to remove <strong>{removeTarget?.name}</strong>? Their account and all
            class assignments will be deleted. This cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setRemoveTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleRemoveTeacher} disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              {submitting ? 'Removing…' : 'Yes, Remove'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export default function TeachersPage() {
  return <Suspense><TeachersPageInner /></Suspense>;
}
