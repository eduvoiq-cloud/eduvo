'use client';

import { useEffect, useState, useCallback } from 'react';
import Image from 'next/image';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────────

type StudentStatus = 'present' | 'absent';

interface StudentCard {
  student_id: string;
  name: string;
  roll_number: string | null;
  photo_url: string | null;
  /** Current status in the UI (toggled by teacher) */
  status: StudentStatus;
  /** Original status from the server (for correction diff) */
  originalStatus?: StudentStatus;
  /** attendance record id — only present in read-only / correction mode */
  attendance_id?: string;
}

type PageMode = 'marking' | 'readonly' | 'correction';

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

async function apiFetch<T>(path: string, options: RequestInit, token: string): Promise<T> {
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const { user } = useAuth();

  // ── Assignments ───────────────────────────────────────────────────────────
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [date, setDate] = useState(todayStr);

  // ── Student grid state ────────────────────────────────────────────────────
  const [students, setStudents] = useState<StudentCard[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [mode, setMode] = useState<PageMode>('marking');
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);

  // ── Correction state ──────────────────────────────────────────────────────
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionReasonError, setCorrectionReasonError] = useState(false);

  // ── Confirm modal ─────────────────────────────────────────────────────────
  const [showConfirm, setShowConfirm] = useState(false);

  // ── Feedback ──────────────────────────────────────────────────────────────
  const [banner, setBanner] = useState<{ type: 'success' | 'warning' | 'error'; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Load assignments ──────────────────────────────────────────────────────
  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    assignmentsApi
      .list(token, user.school_id)
      .then((res) => setAssignments(res.data.filter((a) => a.teacher_id === user.id)))
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const mySections = [
    ...new Set(assignments.filter((a) => a.class_name === selectedClass).map((a) => a.section)),
  ].sort();

  // ── Load students for selected class/section/date ─────────────────────────
  const loadStudents = useCallback(async () => {
    if (!selectedClass || !selectedSection || !date || !user?.school_id) return;
    const token = getToken();
    if (!token) return;

    setLoadingStudents(true);
    setBanner(null);
    setStudents([]);
    setMode('marking');
    setSubmittedAt(null);
    setCorrectionReason('');
    setCorrectionReasonError(false);

    try {
      const data = await apiFetch<
        {
          student_id: string;
          name: string;
          roll_number: string | null;
          photo_url: string | null;
          status: 'present' | 'absent' | 'not_marked';
          id: string | null;
        }[]
      >(
        `/api/attendance/class?class=${encodeURIComponent(selectedClass)}&section=${encodeURIComponent(selectedSection)}&date=${date}&school_id=${user.school_id}`,
        { method: 'GET' },
        token
      );

      const alreadySubmitted = data.some((s) => s.status !== 'not_marked');

      if (alreadySubmitted) {
        // Read-only mode — show what was submitted
        const cards: StudentCard[] = data.map((s) => ({
          student_id: s.student_id,
          name: s.name,
          roll_number: s.roll_number,
          photo_url: s.photo_url,
          status: s.status === 'absent' ? 'absent' : 'present',
          originalStatus: s.status === 'absent' ? 'absent' : 'present',
          attendance_id: s.id ?? undefined,
        }));
        setStudents(cards);
        setMode('readonly');
        setSubmittedAt(date);
      } else {
        // Fresh marking — everyone starts as present
        const cards: StudentCard[] = data.map((s) => ({
          student_id: s.student_id,
          name: s.name,
          roll_number: s.roll_number,
          photo_url: s.photo_url,
          status: 'present',
        }));
        setStudents(cards);
        setMode('marking');
      }
    } catch (e: unknown) {
      setBanner({ type: 'error', msg: e instanceof Error ? e.message : 'Failed to load students' });
    } finally {
      setLoadingStudents(false);
    }
  }, [selectedClass, selectedSection, date, user?.school_id]);

  // ── Toggle a student's status ─────────────────────────────────────────────
  function toggleStudent(id: string) {
    if (mode === 'readonly') return;
    setStudents((prev) =>
      prev.map((s) =>
        s.student_id === id
          ? { ...s, status: s.status === 'present' ? 'absent' : 'present' }
          : s
      )
    );
  }

  // ── Submit attendance ─────────────────────────────────────────────────────
  async function submitAttendance() {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setSubmitting(true);
    setBanner(null);
    try {
      const absentIds = students.filter((s) => s.status === 'absent').map((s) => s.student_id);
      await apiFetch(
        '/api/attendance/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            class: selectedClass,
            section: selectedSection,
            date,
            school_id: user.school_id,
            absent_student_ids: absentIds,
          }),
        },
        token
      );
      setBanner({ type: 'success', msg: 'Attendance submitted. Parents will be notified.' });
      setMode('readonly');
      setSubmittedAt(date);
      // Refresh to get server state
      await loadStudents();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to submit attendance';
      if (msg.toLowerCase().includes('already')) {
        setBanner({ type: 'warning', msg: 'Attendance already submitted for today.' });
        setMode('readonly');
        await loadStudents();
      } else {
        setBanner({ type: 'error', msg });
      }
    } finally {
      setSubmitting(false);
      setShowConfirm(false);
    }
  }

  // ── Enter correction mode ─────────────────────────────────────────────────
  function enterCorrectionMode() {
    setMode('correction');
    setBanner(null);
    setCorrectionReason('');
    setCorrectionReasonError(false);
    // snapshot original statuses
    setStudents((prev) => prev.map((s) => ({ ...s, originalStatus: s.status })));
  }

  // ── Submit corrections ────────────────────────────────────────────────────
  async function submitCorrections() {
    if (!correctionReason.trim()) {
      setCorrectionReasonError(true);
      return;
    }
    const token = getToken();
    if (!token) return;

    const changed = students.filter((s) => s.status !== s.originalStatus);
    if (changed.length === 0) {
      setBanner({ type: 'warning', msg: 'No changes detected.' });
      setMode('readonly');
      return;
    }

    setSubmitting(true);
    setBanner(null);
    try {
      await Promise.all(
        changed.map((s) => {
          if (s.attendance_id) {
            // Existing record — update it
            return apiFetch('/api/attendance/correct', {
              method: 'PUT',
              body: JSON.stringify({
                attendance_id: s.attendance_id,
                new_status: s.status,
                reason: correctionReason.trim(),
              }),
            }, token!);
          } else {
            // No record yet (was not_marked) — create it
            return apiFetch('/api/attendance/correct', {
              method: 'PUT',
              body: JSON.stringify({
                student_id: s.student_id,
                date,
                new_status: s.status,
                reason: correctionReason.trim(),
              }),
            }, token!);
          }
        })
      );

      setBanner({ type: 'success', msg: `${changed.length} record${changed.length !== 1 ? 's' : ''} corrected successfully.` });
      setMode('readonly');
      await loadStudents();
    } catch (e: unknown) {
      setBanner({ type: 'error', msg: e instanceof Error ? e.message : 'Failed to submit corrections' });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Derived counts ────────────────────────────────────────────────────────
  const presentCount = students.filter((s) => s.status === 'present').length;
  const absentCount = students.filter((s) => s.status === 'absent').length;
  const changedCount = mode === 'correction'
    ? students.filter((s) => s.status !== s.originalStatus).length
    : 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Mark Attendance"
        description="Select a class and date, then click absent students"
      />

      {/* ── Top filter bar ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 mb-6">
        {/* Class */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">Class</label>
          <select
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-[140px]"
            value={selectedClass}
            onChange={(e) => {
              setSelectedClass(e.target.value);
              setSelectedSection('');
              setStudents([]);
              setBanner(null);
            }}
            disabled={loadingAssignments}
          >
            <option value="">Select class…</option>
            {myClasses.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        {/* Section */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">Section</label>
          <select
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-[120px]"
            value={selectedSection}
            onChange={(e) => {
              setSelectedSection(e.target.value);
              setStudents([]);
              setBanner(null);
            }}
            disabled={!selectedClass}
          >
            <option value="">Select section…</option>
            {mySections.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">Date</label>
          <input
            type="date"
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={date}
            max={todayStr()}
            onChange={(e) => {
              setDate(e.target.value);
              setStudents([]);
              setBanner(null);
            }}
          />
        </div>

        {/* Load button */}
        <button
          type="button"
          onClick={loadStudents}
          disabled={!selectedClass || !selectedSection || !date || loadingStudents}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors self-end"
        >
          {loadingStudents ? 'Loading…' : 'Load Students'}
        </button>
      </div>

      {/* ── Banner ─────────────────────────────────────────────────────────── */}
      {banner && (
        <div
          className={`mb-5 px-4 py-3 rounded-lg text-sm flex items-center gap-2 ${
            banner.type === 'success'
              ? 'bg-green-50 border border-green-200 text-green-700'
              : banner.type === 'warning'
              ? 'bg-yellow-50 border border-yellow-200 text-yellow-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}
        >
          {banner.type === 'success' && (
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          )}
          {banner.msg}
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {students.length === 0 && !loadingStudents && (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16 text-sm text-gray-400">
          {!selectedClass || !selectedSection
            ? 'Select a class and section, then click "Load Students".'
            : 'No students found for this class and section.'}
        </div>
      )}

      {/* ── Loading spinner ──────────────────────────────────────────────────── */}
      {loadingStudents && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* ── Student grid ─────────────────────────────────────────────────────── */}
      {students.length > 0 && !loadingStudents && (
        <>
          {/* Summary bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <p className="text-sm font-semibold text-gray-800">
                {selectedClass} {selectedSection} — {date} — {students.length} Students
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                <span className="text-green-600 font-medium">{presentCount} Present</span>
                {' · '}
                <span className="text-red-600 font-medium">{absentCount} Absent</span>
              </p>
            </div>

            {/* Readonly badge + Correct button */}
            {mode === 'readonly' && (
              <div className="flex items-center gap-3">
                {submittedAt && (
                  <span className="text-xs text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
                    Submitted at {submittedAt}
                  </span>
                )}
                <button
                  type="button"
                  onClick={enterCorrectionMode}
                  className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                >
                  Correct Attendance
                </button>
              </div>
            )}

            {/* Correction mode hint */}
            {mode === 'correction' && (
              <span className="text-xs font-medium text-orange-600 bg-orange-50 px-3 py-1.5 rounded-full">
                Correction mode — {changedCount} change{changedCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Instruction hint for marking mode */}
          {mode === 'marking' && (
            <p className="text-xs text-gray-400 mb-3">
              All students are <span className="text-green-600 font-medium">present</span> by default. Click a card to mark as <span className="text-red-600 font-medium">absent</span>.
            </p>
          )}

          {/* Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-6">
            {students.map((s) => {
              const isAbsent = s.status === 'absent';
              const isChanged = mode === 'correction' && s.status !== s.originalStatus;
              const isClickable = mode === 'marking' || mode === 'correction';

              return (
                <button
                  key={s.student_id}
                  type="button"
                  onClick={() => isClickable && toggleStudent(s.student_id)}
                  disabled={!isClickable}
                  className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 text-left transition-colors ${
                    isChanged
                      ? 'border-yellow-400 bg-yellow-50'
                      : isAbsent
                      ? 'border-red-300 bg-red-50'
                      : 'border-green-300 bg-green-50'
                  } ${isClickable ? 'cursor-pointer hover:opacity-90' : 'cursor-default'}`}
                >
                  {/* Changed indicator */}
                  {isChanged && (
                    <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-yellow-500" />
                  )}

                  {/* Avatar */}
                  {s.photo_url ? (
                    <Image
                      src={s.photo_url}
                      alt={s.name}
                      width={48}
                      height={48}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <div
                      className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold ${
                        isAbsent ? 'bg-red-200 text-red-700' : 'bg-green-200 text-green-700'
                      }`}
                    >
                      {s.name.charAt(0).toUpperCase()}
                    </div>
                  )}

                  {/* Name */}
                  <p className="text-xs font-semibold text-gray-900 text-center leading-tight line-clamp-2">
                    {s.name}
                  </p>

                  {/* Roll number */}
                  {s.roll_number && (
                    <p className="text-xs text-gray-400">#{s.roll_number}</p>
                  )}

                  {/* Status badge */}
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      isAbsent
                        ? 'bg-red-100 text-red-700'
                        : 'bg-green-100 text-green-700'
                    }`}
                  >
                    {isAbsent ? 'Absent' : 'Present'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* ── Correction reason input ─────────────────────────────────────── */}
          {mode === 'correction' && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reason for correction <span className="text-red-500">*</span>
              </label>
              <textarea
                rows={2}
                className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none ${
                  correctionReasonError ? 'border-red-400' : 'border-gray-300'
                }`}
                placeholder="Explain why you are correcting this attendance…"
                value={correctionReason}
                onChange={(e) => {
                  setCorrectionReason(e.target.value);
                  if (e.target.value.trim()) setCorrectionReasonError(false);
                }}
              />
              {correctionReasonError && (
                <p className="text-xs text-red-600 mt-1">Reason is required before submitting corrections.</p>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Sticky bottom bar ─────────────────────────────────────────────────── */}
      {students.length > 0 && !loadingStudents && mode !== 'readonly' && (
        <div className="sticky bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-4 py-3 flex flex-wrap items-center justify-between gap-3 z-10">
          <p className="text-sm text-gray-700">
            <span className="font-semibold text-green-600">{presentCount} Present</span>
            {', '}
            <span className="font-semibold text-red-600">{absentCount} Absent</span>
            {mode === 'correction' && changedCount > 0 && (
              <span className="ml-2 text-yellow-600 font-medium">· {changedCount} changed</span>
            )}
          </p>

          <div className="flex items-center gap-3">
            {mode === 'correction' && (
              <button
                type="button"
                onClick={() => {
                  setMode('readonly');
                  setStudents((prev) => prev.map((s) => ({ ...s, status: s.originalStatus ?? s.status })));
                  setCorrectionReason('');
                  setCorrectionReasonError(false);
                  setBanner(null);
                }}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                if (mode === 'correction') {
                  submitCorrections();
                } else {
                  setShowConfirm(true);
                }
              }}
              disabled={submitting || students.length === 0}
              className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors"
            >
              {submitting
                ? 'Submitting…'
                : mode === 'correction'
                ? 'Submit Correction'
                : 'Submit Attendance'}
            </button>
          </div>
        </div>
      )}

      {/* ── Confirm modal ─────────────────────────────────────────────────────── */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Confirm Submission</h2>
            <p className="text-sm text-gray-600 mb-4">
              Submit attendance for{' '}
              <span className="font-medium">{selectedClass} {selectedSection}</span>?
            </p>
            <div className="flex gap-4 mb-5">
              <div className="flex-1 bg-green-50 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-green-600">{presentCount}</p>
                <p className="text-xs text-green-700 mt-0.5">Present</p>
              </div>
              <div className="flex-1 bg-red-50 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-red-600">{absentCount}</p>
                <p className="text-xs text-red-700 mt-0.5">Absent</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAttendance}
                disabled={submitting}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
              >
                {submitting ? 'Submitting…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
