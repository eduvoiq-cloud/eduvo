'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  classAdminApi,
  listClassCombos,
  usersApi,
  type ClassAdminRow,
  type ClassCombo,
  type Teacher,
} from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';

// ── Toast ─────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

let _toastId = 0;

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  return { toasts, show };
}

// ── Sort helper ───────────────────────────────────────────────────────────────

function sortKey(c: ClassCombo) {
  // Numeric class sort (e.g. "1" < "10" < "12"), then section alpha
  const num = parseInt(c.class_name, 10);
  return `${isNaN(num) ? c.class_name.padStart(4, '0') : String(num).padStart(4, '0')}||${c.section}`;
}

// ── Page component ────────────────────────────────────────────────────────────

export default function ClassAdminPage() {
  const { user } = useAuth();
  const { toasts, show: showToast } = useToast();

  // Table data
  const [appointments, setAppointments] = useState<ClassAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Remove confirm modal
  const [removeTarget, setRemoveTarget] = useState<ClassAdminRow | null>(null);
  const [removing, setRemoving] = useState(false);

  // Appoint modal state
  const [showAppoint, setShowAppoint] = useState(false);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [classes, setClasses] = useState<ClassCombo[]>([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState('');

  // Step 1: teacher selection
  const [teacherSearch, setTeacherSearch] = useState('');
  const [selectedTeacher, setSelectedTeacher] = useState<Teacher | null>(null);

  // Step 2: class selection
  const [selectedClasses, setSelectedClasses] = useState<Set<string>>(new Set());
  const [appointing, setAppointing] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // ── Fetch appointments ───────────────────────────────────────────────────

  const fetchAppointments = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await classAdminApi.list(token);
      setAppointments(res.data ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load class admins');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAppointments(); }, [fetchAppointments]);

  // ── Open appoint modal ────────────────────────────────────────────────────

  async function openAppointModal() {
    setShowAppoint(true);
    setSelectedTeacher(null);
    setSelectedClasses(new Set());
    setTeacherSearch('');
    setModalError('');
    setModalLoading(true);
    const token = getToken();
    if (!token || !user?.school_id) { setModalLoading(false); return; }
    try {
      const [tRes, cRes] = await Promise.all([
        usersApi.list(token, { role: 'teacher', school_id: user.school_id, limit: 500 }),
        listClassCombos(token),
      ]);
      const rawTeachers = (tRes.data as { data?: Teacher[] } & Teacher[]).data ?? (tRes.data as unknown as Teacher[]);
      setTeachers(Array.isArray(rawTeachers) ? rawTeachers : []);
      const rawClasses: ClassCombo[] = (cRes.data as unknown as ClassCombo[]) ?? [];
      setClasses([...rawClasses].sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
    } catch (e: unknown) {
      setModalError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setModalLoading(false);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }

  function closeAppointModal() {
    setShowAppoint(false);
    setSelectedTeacher(null);
    setSelectedClasses(new Set());
    setTeacherSearch('');
    setModalError('');
  }

  // ── Teacher filter ────────────────────────────────────────────────────────

  const filteredTeachers = teachers.filter((t) =>
    t.name.toLowerCase().includes(teacherSearch.toLowerCase())
  );

  // ── Class checkbox toggle ─────────────────────────────────────────────────

  function toggleClass(key: string) {
    setSelectedClasses((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (selectedClasses.size === classes.length) {
      setSelectedClasses(new Set());
    } else {
      setSelectedClasses(new Set(classes.map((c) => `${c.class_name}||${c.section}`)));
    }
  }

  // ── Appoint submit ────────────────────────────────────────────────────────

  async function handleAppoint() {
    if (!selectedTeacher || selectedClasses.size === 0) return;
    const token = getToken();
    if (!token) return;
    setAppointing(true);
    setModalError('');
    try {
      const tasks = [...selectedClasses].map((key) => {
        const [class_name, section] = key.split('||');
        return classAdminApi.appoint(token, {
          teacher_id: selectedTeacher.id,
          class_name,
          section,
        });
      });
      await Promise.all(tasks);
      showToast(
        `Appointed ${selectedTeacher.name} as class admin for ${selectedClasses.size} class${selectedClasses.size > 1 ? 'es' : ''}`,
        'success'
      );
      closeAppointModal();
      await fetchAppointments();
    } catch (e: unknown) {
      setModalError(e instanceof Error ? e.message : 'Failed to appoint class admin');
    } finally {
      setAppointing(false);
    }
  }

  // ── Remove ────────────────────────────────────────────────────────────────

  async function handleRemove() {
    if (!removeTarget) return;
    const token = getToken();
    if (!token) return;
    setRemoving(true);
    try {
      await classAdminApi.remove(token, {
        class_name: removeTarget.class_name,
        section: removeTarget.section,
      });
      showToast(`Removed ${removeTarget.teacher_name ?? 'teacher'} as class admin`, 'success');
      setRemoveTarget(null);
      await fetchAppointments();
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to remove class admin', 'error');
      setRemoveTarget(null);
    } finally {
      setRemoving(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const allSelected = classes.length > 0 && selectedClasses.size === classes.length;
  const someSelected = selectedClasses.size > 0 && selectedClasses.size < classes.length;

  return (
    <>
      {/* Toast container */}
      <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-3 rounded-xl shadow-lg text-sm font-medium pointer-events-auto ${
              t.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>

      <PageHeader
        title="Class Admins"
        description="Appoint teachers as class administrators for specific classes"
        action={
          <button
            onClick={openAppointModal}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Appoint Class Admin
          </button>
        }
      />

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : appointments.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16">
          <div className="flex items-center justify-center w-12 h-12 bg-blue-50 rounded-full mx-auto mb-4">
            <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-700 mb-1">No class admins appointed yet</p>
          <p className="text-xs text-gray-400">Click &ldquo;Appoint Class Admin&rdquo; to get started.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Teacher Name
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Class
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Section
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Appointed Date
                </th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {appointments.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-semibold text-xs shrink-0">
                        {(row.teacher_name ?? '?').charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium text-gray-900">{row.teacher_name ?? '—'}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-gray-700">{row.class_name}</td>
                  <td className="px-5 py-3.5 text-gray-700">{row.section}</td>
                  <td className="px-5 py-3.5 text-gray-500">
                    {row.appointed_at
                      ? new Date(row.appointed_at).toLocaleDateString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })
                      : '—'}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      onClick={() => setRemoveTarget(row)}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Remove confirm modal ───────────────────────────────────────────── */}
      <Modal
        open={!!removeTarget}
        onClose={() => !removing && setRemoveTarget(null)}
        title="Remove Class Admin"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Remove{' '}
            <strong className="text-gray-900">{removeTarget?.teacher_name ?? 'this teacher'}</strong>{' '}
            as class admin for{' '}
            <strong className="text-gray-900">
              Class {removeTarget?.class_name} {removeTarget?.section}
            </strong>
            ?
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setRemoveTarget(null)}
              disabled={removing}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleRemove}
              disabled={removing}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              {removing ? 'Removing…' : 'Yes, Remove'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Appoint modal ──────────────────────────────────────────────────── */}
      <Modal
        open={showAppoint}
        onClose={() => !appointing && closeAppointModal()}
        title="Appoint Class Admin"
        size="lg"
      >
        {modalLoading ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-5">
            {modalError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {modalError}
              </div>
            )}

            {/* Step 1: Select teacher */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Step 1 — Select Teacher
              </p>
              <div className="relative mb-2">
                <svg
                  className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
                </svg>
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search teachers…"
                  value={teacherSearch}
                  onChange={(e) => setTeacherSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div className="border border-gray-200 rounded-lg max-h-44 overflow-y-auto divide-y divide-gray-100">
                {filteredTeachers.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">No teachers found</p>
                ) : (
                  filteredTeachers.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setSelectedTeacher(t);
                        setSelectedClasses(new Set());
                      }}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-blue-50 transition-colors ${
                        selectedTeacher?.id === t.id ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-800'
                      }`}
                    >
                      <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-semibold text-xs shrink-0">
                        {t.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate">{t.name}</p>
                        <p className="text-xs text-gray-400 truncate">{t.email}</p>
                      </div>
                      {selectedTeacher?.id === t.id && (
                        <svg className="w-4 h-4 ml-auto shrink-0 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Step 2: Select classes (shown after teacher selected) */}
            {selectedTeacher && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Step 2 — Select Classes
                  </p>
                  <span className="text-xs text-gray-400">
                    {selectedClasses.size} selected
                  </span>
                </div>

                {classes.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-4">No classes found in this school</p>
                ) : (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    {/* Select all row */}
                    <label className="flex items-center gap-3 px-4 py-2.5 bg-gray-50 border-b border-gray-200 cursor-pointer hover:bg-gray-100 transition-colors">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someSelected;
                        }}
                        onChange={toggleAll}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      />
                      <span className="text-sm font-medium text-gray-700">Select All</span>
                    </label>
                    {/* Class checkboxes */}
                    <div className="max-h-48 overflow-y-auto divide-y divide-gray-100">
                      {classes.map((c) => {
                        const key = `${c.class_name}||${c.section}`;
                        return (
                          <label
                            key={key}
                            className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-blue-50 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={selectedClasses.has(key)}
                              onChange={() => toggleClass(key)}
                              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            />
                            <span className="text-sm text-gray-800">
                              Class <strong>{c.class_name}</strong> — Section {c.section}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={closeAppointModal}
                disabled={appointing}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAppoint}
                disabled={!selectedTeacher || selectedClasses.size === 0 || appointing}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors flex items-center gap-2"
              >
                {appointing && (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                )}
                {appointing
                  ? `Appointing… (${selectedClasses.size})`
                  : `Appoint for ${selectedClasses.size} class${selectedClasses.size !== 1 ? 'es' : ''}`}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
