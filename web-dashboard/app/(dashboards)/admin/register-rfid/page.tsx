'use client';

/**
 * Register RFID Cards — School Admin only
 *
 * Lets a school admin assign RFID card UIDs to students.
 * The USB RFID reader acts as a keyboard; it types the UID and presses Enter.
 *
 * Architecture: This page → Express backend (PUT /api/admin/students/:id/rfid) → Supabase.
 * Never calls Supabase directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import { studentsApi, type Student } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = 'single' | 'bulk';

interface BulkTarget {
  student: Student;
  waiting: boolean; // true = focused, waiting for card tap
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function RfidBadge({ uid }: { uid?: string | null }) {
  if (uid) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
        Registered
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />
      Not registered
    </span>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function RegisterRfidPage() {
  const { user } = useAuth();
  const router = useRouter();

  // ── Auth guard: schooladmin only ──────────────────────────────────────────
  useEffect(() => {
    if (user && user.role !== 'schooladmin') {
      router.replace('/login');
    }
  }, [user, router]);

  // ── All students for this school ──────────────────────────────────────────
  const [allStudents, setAllStudents] = useState<Student[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [fetchError, setFetchError] = useState('');

  const fetchStudents = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoadingStudents(true);
    setFetchError('');
    try {
      const res = await studentsApi.list(token, user.school_id);
      setAllStudents(res.data);
    } catch (e: unknown) {
      setFetchError(e instanceof Error ? e.message : 'Failed to load students');
    } finally {
      setLoadingStudents(false);
    }
  }, [user]);

  useEffect(() => { fetchStudents(); }, [fetchStudents]);

  // ── Mode toggle ───────────────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>('single');

  // ── Single mode state ─────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [scannedUid, setScannedUid] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Hidden input for RFID reader
  const rfidInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Bulk mode state ───────────────────────────────────────────────────────
  const [bulkClass, setBulkClass] = useState('');
  const [bulkSection, setBulkSection] = useState('');
  const [bulkTargets, setBulkTargets] = useState<BulkTarget[]>([]);
  const [bulkError, setBulkError] = useState('');
  const [bulkSuccess, setBulkSuccess] = useState('');
  const bulkRfidRef = useRef<HTMLInputElement>(null);

  // ── Derived data ──────────────────────────────────────────────────────────

  const classes = [...new Set(allStudents.map((s) => s.class_name))].sort();

  const sections = bulkClass
    ? [...new Set(
        allStudents
          .filter((s) => s.class_name === bulkClass)
          .map((s) => s.section ?? '')
      )].filter(Boolean).sort()
    : [];

  const searchResults = search.trim().length >= 1
    ? allStudents.filter((s) =>
        s.full_name.toLowerCase().includes(search.toLowerCase())
      ).slice(0, 8)
    : [];

  const unregisteredStudents = [...allStudents]
    .filter((s) => !s.rfid_uid)
    .sort((a, b) => {
      const classCompare = a.class_name.localeCompare(b.class_name);
      if (classCompare !== 0) return classCompare;
      return (a.section ?? '').localeCompare(b.section ?? '');
    });

  // ── Single mode: select student ───────────────────────────────────────────

  function selectStudent(s: Student) {
    setSelectedStudent(s);
    setSearch(s.full_name);
    setShowDropdown(false);
    setScannedUid('');
    setSuccessMsg('');
    setErrorMsg('');
    // Focus the hidden RFID input so the reader can type into it
    setTimeout(() => rfidInputRef.current?.focus(), 50);
  }

  function clearSelection() {
    setSelectedStudent(null);
    setSearch('');
    setScannedUid('');
    setSuccessMsg('');
    setErrorMsg('');
    setConfirming(false);
    setTimeout(() => searchRef.current?.focus(), 50);
  }

  // ── Single mode: RFID card tapped ─────────────────────────────────────────

  function handleRfidKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const uid = e.currentTarget.value.trim();
      e.currentTarget.value = '';
      if (uid && selectedStudent) {
        setScannedUid(uid);
        setErrorMsg('');
        setSuccessMsg('');
        setConfirming(false);
      }
    }
  }

  // ── Single mode: confirm registration ─────────────────────────────────────

  async function handleConfirm() {
    if (!selectedStudent || !scannedUid) return;
    const token = getToken();
    if (!token) return;
    setConfirming(true);
    setErrorMsg('');
    try {
      await studentsApi.registerRfid(token, selectedStudent.id, scannedUid);
      const name = selectedStudent.full_name;
      setSuccessMsg(`${name}'s card registered successfully`);
      // Update local list
      setAllStudents((prev) =>
        prev.map((s) => s.id === selectedStudent.id ? { ...s, rfid_uid: scannedUid } : s)
      );
      // Auto-clear after 2 seconds
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => {
        clearSelection();
      }, 2000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Registration failed';
      if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('duplicate')) {
        setErrorMsg('This card is already registered to another student.');
      } else {
        setErrorMsg(msg);
      }
    } finally {
      setConfirming(false);
    }
  }

  function handleCancel() {
    setScannedUid('');
    setErrorMsg('');
    setTimeout(() => rfidInputRef.current?.focus(), 50);
  }

  // ── Bulk mode: load class/section ─────────────────────────────────────────

  useEffect(() => {
    if (!bulkClass) {
      setBulkTargets([]);
      return;
    }
    const filtered = allStudents.filter((s) => {
      const classMatch = s.class_name === bulkClass;
      const sectionMatch = bulkSection ? (s.section ?? '') === bulkSection : true;
      return classMatch && sectionMatch;
    });
    setBulkTargets(filtered.map((s) => ({ student: s, waiting: false })));
    setBulkError('');
    setBulkSuccess('');
  }, [bulkClass, bulkSection, allStudents]);

  // ── Bulk mode: focus a student row ────────────────────────────────────────

  function bulkFocusStudent(studentId: string) {
    setBulkTargets((prev) =>
      prev.map((t) => ({ ...t, waiting: t.student.id === studentId }))
    );
    setBulkError('');
    setBulkSuccess('');
    setTimeout(() => bulkRfidRef.current?.focus(), 50);
  }

  // ── Bulk mode: RFID card tapped ───────────────────────────────────────────

  async function handleBulkRfidKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const uid = e.currentTarget.value.trim();
    e.currentTarget.value = '';
    if (!uid) return;

    const target = bulkTargets.find((t) => t.waiting);
    if (!target) return;

    const token = getToken();
    if (!token) return;

    setBulkError('');
    setBulkSuccess('');

    try {
      await studentsApi.registerRfid(token, target.student.id, uid);
      // Update local state
      setAllStudents((prev) =>
        prev.map((s) => s.id === target.student.id ? { ...s, rfid_uid: uid } : s)
      );
      setBulkTargets((prev) =>
        prev.map((t) =>
          t.student.id === target.student.id
            ? { student: { ...t.student, rfid_uid: uid }, waiting: false }
            : t
        )
      );
      setBulkSuccess(`${target.student.full_name}'s card registered`);
      setTimeout(() => setBulkSuccess(''), 2000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Registration failed';
      if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('duplicate')) {
        setBulkError('This card is already registered to another student.');
      } else {
        setBulkError(msg);
      }
      // Keep waiting so admin can try again
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!user || user.role !== 'schooladmin') return null;

  return (
    <>
      <PageHeader
        title="Register RFID Cards"
        description="Select a student, then tap their RFID card on the reader"
      />

      {fetchError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {fetchError}
        </div>
      )}

      {/* ── Mode toggle ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-6">
        <span className="text-sm font-medium text-gray-700">Bulk Mode</span>
        <button
          role="switch"
          aria-checked={mode === 'bulk'}
          onClick={() => {
            setMode((m) => (m === 'single' ? 'bulk' : 'single'));
            clearSelection();
            setBulkClass('');
            setBulkSection('');
          }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
            mode === 'bulk' ? 'bg-blue-600' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              mode === 'bulk' ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <span className="text-xs text-gray-400">
          {mode === 'bulk' ? 'Register an entire class at once' : 'Register one student at a time'}
        </span>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          SINGLE MODE
      ════════════════════════════════════════════════════════════════════ */}
      {mode === 'single' && (
        <div className="space-y-4 mb-10">
          {/* Student search */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Search Student</h2>

            <div className="relative max-w-md">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                placeholder="Type student name…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setShowDropdown(true);
                  if (!e.target.value) {
                    setSelectedStudent(null);
                    setScannedUid('');
                    setSuccessMsg('');
                    setErrorMsg('');
                  }
                }}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete="off"
              />

              {/* Dropdown */}
              {showDropdown && searchResults.length > 0 && (
                <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                  {searchResults.map((s) => (
                    <button
                      key={s.id}
                      onMouseDown={() => selectStudent(s)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-blue-50 transition-colors border-b border-gray-50 last:border-0"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">{s.full_name}</p>
                        <p className="text-xs text-gray-400">
                          {s.class_name}{s.section ? ` · ${s.section}` : ''}
                        </p>
                      </div>
                      <RfidBadge uid={s.rfid_uid} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Hidden RFID input — always present, focused after student selected */}
          <input
            ref={rfidInputRef}
            type="text"
            aria-hidden="true"
            autoComplete="off"
            tabIndex={-1}
            onKeyDown={handleRfidKeyDown}
            className="absolute opacity-0 w-px h-px pointer-events-none"
          />

          {/* Selected student + card tap area */}
          {selectedStudent && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1">
                    Selected Student
                  </p>
                  <p className="text-lg font-semibold text-green-900">{selectedStudent.full_name}</p>
                  <p className="text-sm text-green-700">
                    {selectedStudent.class_name}
                    {selectedStudent.section ? ` · ${selectedStudent.section}` : ''}
                  </p>
                  {selectedStudent.rfid_uid && (
                    <p className="text-xs text-green-600 mt-1">
                      Current card: <span className="font-mono">{selectedStudent.rfid_uid}</span>
                    </p>
                  )}
                </div>
                <button
                  onClick={clearSelection}
                  className="text-green-500 hover:text-green-700 transition-colors"
                  aria-label="Clear selection"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Waiting for card */}
              {!scannedUid && !successMsg && (
                <div className="flex items-center gap-3 px-4 py-3 bg-white border border-green-200 rounded-lg">
                  <span className="w-2.5 h-2.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
                  <p className="text-sm text-green-800 font-medium">
                    Now tap the RFID card on the reader
                  </p>
                </div>
              )}

              {/* Scanned UID — confirm / cancel */}
              {scannedUid && !successMsg && (
                <div className="space-y-3">
                  <div className="px-4 py-3 bg-white border border-blue-200 rounded-lg">
                    <p className="text-xs text-gray-500 mb-0.5">Card UID detected</p>
                    <p className="text-base font-mono font-semibold text-blue-700">{scannedUid}</p>
                  </div>
                  {errorMsg && (
                    <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                      {errorMsg}
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      onClick={handleConfirm}
                      disabled={confirming}
                      className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
                    >
                      {confirming ? 'Registering…' : 'Confirm'}
                    </button>
                    <button
                      onClick={handleCancel}
                      disabled={confirming}
                      className="px-5 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Success */}
              {successMsg && (
                <div className="flex items-center gap-2 px-4 py-3 bg-green-100 border border-green-300 rounded-lg">
                  <svg className="w-4 h-4 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <p className="text-sm font-medium text-green-800">{successMsg}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          BULK MODE
      ════════════════════════════════════════════════════════════════════ */}
      {mode === 'bulk' && (
        <div className="space-y-4 mb-10">
          {/* Hidden RFID input for bulk mode */}
          <input
            ref={bulkRfidRef}
            type="text"
            aria-hidden="true"
            autoComplete="off"
            tabIndex={-1}
            onKeyDown={handleBulkRfidKeyDown}
            className="absolute opacity-0 w-px h-px pointer-events-none"
          />

          {/* Class / section selectors */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Select Class</h2>
            <div className="flex flex-col sm:flex-row gap-3">
              <select
                value={bulkClass}
                onChange={(e) => { setBulkClass(e.target.value); setBulkSection(''); }}
                className="px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">— Select class —</option>
                {classes.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>

              {sections.length > 0 && (
                <select
                  value={bulkSection}
                  onChange={(e) => setBulkSection(e.target.value)}
                  className="px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">All sections</option>
                  {sections.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
          </div>

          {/* Feedback banners */}
          {bulkError && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {bulkError}
            </div>
          )}
          {bulkSuccess && (
            <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800 font-medium">
              <svg className="w-4 h-4 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {bulkSuccess}
            </div>
          )}

          {/* Bulk student list */}
          {bulkClass && bulkTargets.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-8">No students found for this class.</p>
          )}

          {bulkTargets.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {bulkTargets.length} student{bulkTargets.length !== 1 ? 's' : ''} in {bulkClass}
                  {bulkSection ? ` · ${bulkSection}` : ''}
                </p>
              </div>
              <div className="divide-y divide-gray-50">
                {bulkTargets.map(({ student, waiting }) => (
                  <div
                    key={student.id}
                    className={`flex items-center justify-between px-6 py-3 transition-colors ${
                      waiting ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-semibold flex-shrink-0">
                        {student.full_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{student.full_name}</p>
                        <p className="text-xs text-gray-400">
                          {student.class_name}{student.section ? ` · ${student.section}` : ''}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                      <RfidBadge uid={student.rfid_uid} />
                      {waiting ? (
                        <span className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-100 rounded-md">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                          Tap card…
                        </span>
                      ) : (
                        <button
                          onClick={() => bulkFocusStudent(student.id)}
                          className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 hover:border-blue-400 hover:text-blue-700 hover:bg-blue-50 rounded-md transition-colors"
                        >
                          Register
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          BOTTOM SECTION — Students with no RFID registered
      ════════════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Unregistered Students</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {loadingStudents ? '…' : `${unregisteredStudents.length} student${unregisteredStudents.length !== 1 ? 's' : ''} without an RFID card`}
            </p>
          </div>
        </div>

        {loadingStudents ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : unregisteredStudents.length === 0 ? (
          <div className="text-center py-12">
            <svg className="w-10 h-10 text-green-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-gray-700">All students have RFID cards registered</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Student</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Class</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Section</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {unregisteredStudents.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 text-xs font-semibold flex-shrink-0">
                          {s.full_name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium text-gray-900">{s.full_name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3 text-gray-600">{s.class_name}</td>
                    <td className="px-6 py-3 text-gray-500">{s.section ?? '—'}</td>
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={() => {
                          setMode('single');
                          selectStudent(s);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                      >
                        Quick Register
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
