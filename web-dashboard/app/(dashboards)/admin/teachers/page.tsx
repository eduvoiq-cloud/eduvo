'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { authApi, usersApi, assignmentsApi, type Teacher, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AddTeacherForm { name: string; email: string; password: string; }
interface AssignForm { class_name: string; section: string; subject: string; }

const EMPTY_TEACHER: AddTeacherForm = { name: '', email: '', password: '' };
const EMPTY_ASSIGN: AssignForm = { class_name: '', section: '', subject: '' };

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
  const [assignForm, setAssignForm] = useState<AssignForm>(EMPTY_ASSIGN);
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
      // Self-heal: if school_id is missing from cached session, fetch fresh profile
      let schoolId = user?.school_id ?? null;
      if (!schoolId) {
        const meRes = await authApi.me(token);
        schoolId = meRes.data.school_id;
        if (schoolId) {
          const { saveSession } = await import('@/lib/session');
          saveSession(token, meRes.data);
        }
      }
      if (!schoolId) { setLoading(false); return; }

      const [tRes, aRes] = await Promise.all([
        usersApi.list(token, { role: 'teacher', school_id: schoolId }),
        assignmentsApi.list(token, schoolId),
      ]);
      setTeachers(tRes.data);
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
    if (!teacherForm.name.trim() || !teacherForm.email.trim() || teacherForm.password.length < 8) {
      setFormError('All fields required. Password must be at least 8 characters.');
      return;
    }
    const token = getToken();
    if (!token || !user?.school_id) return;
    setSubmitting(true);
    try {
      await authApi.createUser(token, {
        name: teacherForm.name.trim(),
        email: teacherForm.email.trim(),
        password: teacherForm.password,
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

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!assignForm.class_name.trim() || !assignForm.section.trim() || !assignForm.subject.trim()) {
      setFormError('All fields are required.');
      return;
    }
    const token = getToken();
    if (!token || !assignTarget || !user?.school_id) return;
    setSubmitting(true);
    try {
      await assignmentsApi.create(token, {
        teacher_id: assignTarget.id,
        school_id: user.school_id,
        class_name: assignForm.class_name.trim(),
        section: assignForm.section.trim(),
        subject: assignForm.subject.trim(),
      });
      setAssignTarget(null);
      setAssignForm(EMPTY_ASSIGN);
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
          <button
            onClick={() => { setTeacherForm(EMPTY_TEACHER); setFormError(''); setShowAdd(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Teacher
          </button>
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
          No teachers yet. Add your first teacher.
        </div>
      ) : (
        <div className="space-y-3">
          {teachers.map((teacher) => {
            const ta = teacherAssignments(teacher.id);
            return (
              <div key={teacher.id} className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-start justify-between gap-4">
                  {/* Teacher info */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-semibold text-sm shrink-0">
                      {teacher.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 text-sm">{teacher.name}</p>
                      <p className="text-xs text-gray-400 truncate">{teacher.email}</p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => { setAssignForm(EMPTY_ASSIGN); setFormError(''); setAssignTarget(teacher); }}
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

                {/* Assignments */}
                {ta.length > 0 && (
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
                )}

                {ta.length === 0 && (
                  <p className="mt-3 text-xs text-gray-400 italic">No class assignments yet.</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Add Teacher Modal ──────────────────────────────────────────────── */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Teacher">
        <form onSubmit={handleAddTeacher} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
          )}
          <FormField label="Full Name" htmlFor="t-name" required>
            <input id="t-name" type="text" className={inputClass} placeholder="Jane Smith"
              value={teacherForm.name} onChange={(e) => setTeacherForm((f) => ({ ...f, name: e.target.value }))} required />
          </FormField>
          <FormField label="Email Address" htmlFor="t-email" required>
            <input id="t-email" type="email" className={inputClass} placeholder="teacher@school.com"
              value={teacherForm.email} onChange={(e) => setTeacherForm((f) => ({ ...f, email: e.target.value }))} required />
          </FormField>
          <FormField label="Temporary Password" htmlFor="t-pass" required>
            <input id="t-pass" type="password" className={inputClass} placeholder="Min. 8 characters"
              value={teacherForm.password} onChange={(e) => setTeacherForm((f) => ({ ...f, password: e.target.value }))} minLength={8} required />
          </FormField>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowAdd(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {submitting ? 'Creating…' : 'Create Teacher'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Assign Class Modal ─────────────────────────────────────────────── */}
      <Modal open={!!assignTarget} onClose={() => setAssignTarget(null)}
        title={`Assign Class — ${assignTarget?.name ?? ''}`}>
        <form onSubmit={handleAssign} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Class" htmlFor="a-class" required>
              <input id="a-class" type="text" className={inputClass} placeholder="e.g. Grade 5"
                value={assignForm.class_name} onChange={(e) => setAssignForm((f) => ({ ...f, class_name: e.target.value }))} required />
            </FormField>
            <FormField label="Section" htmlFor="a-section" required>
              <input id="a-section" type="text" className={inputClass} placeholder="e.g. A"
                value={assignForm.section} onChange={(e) => setAssignForm((f) => ({ ...f, section: e.target.value }))} required />
            </FormField>
          </div>
          <FormField label="Subject" htmlFor="a-subject" required>
            <input id="a-subject" type="text" className={inputClass} placeholder="e.g. Mathematics"
              value={assignForm.subject} onChange={(e) => setAssignForm((f) => ({ ...f, subject: e.target.value }))} required />
          </FormField>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setAssignTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {submitting ? 'Saving…' : 'Save Assignment'}
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
            <button onClick={() => setRemoveTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button onClick={handleRemoveTeacher} disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors">
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
