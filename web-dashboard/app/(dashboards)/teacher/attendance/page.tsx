'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, attendanceApi, type TeacherAssignment, type AttendanceCheckResult } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

interface StudentRow {
  id: string;
  full_name: string;
  class_name: string;
  section: string;
  status: AttendanceStatus;
  rfidMarked: boolean;
  rfidStatus?: string;
}

export default function AttendancePage() {
  const { user } = useAuth();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);

  // Attendance state
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [loadingCheck, setLoadingCheck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [alreadyAllRfid, setAlreadyAllRfid] = useState(false);

  // ── Correction section state ──────────────────────────────────────────────
  const [corrDate, setCorrDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [corrClass, setCorrClass] = useState('');
  const [corrSection, setCorrSection] = useState('');
  interface CorrRow { id: string; student_id: string; full_name: string; status: string; source?: string }
  const [corrRows, setCorrRows] = useState<CorrRow[]>([]);
  const [loadingCorr, setLoadingCorr] = useState(false);
  const [corrError, setCorrError] = useState('');
  const [corrTarget, setCorrTarget] = useState<CorrRow | null>(null);
  const [corrNewStatus, setCorrNewStatus] = useState('present');
  const [corrReason, setCorrReason] = useState('');
  const [corrSubmitting, setCorrSubmitting] = useState(false);
  const [corrFormError, setCorrFormError] = useState('');
  const [corrSuccess, setCorrSuccess] = useState('');

  // Load teacher's assignments
  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    assignmentsApi.list(token, user.school_id)
      .then((res) => setAssignments(res.data.filter((a) => a.teacher_id === user.id)))
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  // Load students + existing attendance when class/section/date changes
  const loadAttendance = useCallback(async () => {
    if (!filterClass || !filterSection || !date) return;
    const token = getToken();
    if (!token) return;
    setLoadingCheck(true);
    setSuccess(''); setError(''); setAlreadyAllRfid(false);
    try {
      const res = await attendanceApi.check(token, {
        class_name: filterClass,
        section: filterSection,
        date,
      });
      const { students, existing }: AttendanceCheckResult = res.data;
      const existingMap = new Map(existing.map((e) => [e.student_id, e]));

      const studentRows: StudentRow[] = students.map((s) => {
        const ex = existingMap.get(s.id);
        return {
          id: s.id,
          full_name: s.full_name,
          class_name: s.class_name,
          section: s.section,
          status: (ex?.status as AttendanceStatus) ?? 'present',
          rfidMarked: ex?.source === 'rfid',
          rfidStatus: ex?.source === 'rfid' ? ex.status : undefined,
        };
      });

      setRows(studentRows);
      // If every student is already RFID-marked, show info banner
      if (studentRows.length > 0 && studentRows.every((r) => r.rfidMarked)) {
        setAlreadyAllRfid(true);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load attendance');
    } finally {
      setLoadingCheck(false);
    }
  }, [filterClass, filterSection, date]);

  useEffect(() => { loadAttendance(); }, [loadAttendance]);

  function setStatus(studentId: string, status: AttendanceStatus) {
    setRows((prev) => prev.map((r) => r.id === studentId ? { ...r, status } : r));
  }

  function markAll(status: AttendanceStatus) {
    setRows((prev) => prev.map((r) => r.rfidMarked ? r : { ...r, status }));
  }

  async function handleSubmit() {
    setError(''); setSuccess('');
    const token = getToken();
    if (!token) return;

    // Only submit non-RFID rows
    const toSubmit = rows
      .filter((r) => !r.rfidMarked)
      .map((r) => ({ student_id: r.id, date, status: r.status }));

    if (toSubmit.length === 0) {
      setSuccess('All attendance already marked via RFID — nothing to submit.');
      return;
    }

    setSubmitting(true);
    try {
      await attendanceApi.bulkSubmit(token, toSubmit);
      setSuccess(`Attendance saved for ${toSubmit.length} student${toSubmit.length !== 1 ? 's' : ''}.`);
      await loadAttendance();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save attendance');
    } finally {
      setSubmitting(false);
    }
  }

  const myClasses = [...new Set(assignments.map((a) => a.class_name))];
  const mySections = [...new Set(assignments.filter((a) => a.class_name === filterClass).map((a) => a.section))];
  const manualCount = rows.filter((r) => !r.rfidMarked).length;
  const rfidCount = rows.filter((r) => r.rfidMarked).length;

  // ── Correction helpers ────────────────────────────────────────────────────

  const corrSections = [...new Set(assignments.filter((a) => a.class_name === corrClass).map((a) => a.section))];

  async function loadCorrAttendance() {
    if (!corrClass || !corrSection || !corrDate) { setCorrError('Select class, section and date.'); return; }
    const token = getToken();
    if (!token) return;
    setCorrError(''); setCorrSuccess('');
    setLoadingCorr(true);
    try {
      const res = await attendanceApi.check(token, { class_name: corrClass, section: corrSection, date: corrDate });
      const { students, existing } = res.data;
      const existingMap = new Map(existing.map((e) => [e.student_id, e]));
      const mapped: CorrRow[] = students
        .filter((s) => existingMap.has(s.id))
        .map((s) => {
          const ex = existingMap.get(s.id)!;
          return { id: (ex as { id?: string }).id ?? '', student_id: s.id, full_name: s.full_name, status: ex.status, source: ex.source };
        });
      setCorrRows(mapped);
      if (mapped.length === 0) setCorrError('No attendance records found for this date.');
    } catch (e: unknown) {
      setCorrError(e instanceof Error ? e.message : 'Failed to load attendance');
    } finally {
      setLoadingCorr(false);
    }
  }

  function openCorrModal(row: CorrRow) {
    setCorrTarget(row);
    setCorrNewStatus(row.status === 'present' ? 'absent' : 'present');
    setCorrReason('');
    setCorrFormError('');
  }

  async function handleCorrect(e: React.FormEvent) {
    e.preventDefault();
    setCorrFormError('');
    if (!corrTarget) return;
    if (!corrReason.trim()) { setCorrFormError('Reason is required.'); return; }
    const token = getToken();
    if (!token) return;
    setCorrSubmitting(true);
    try {
      await attendanceApi.correct(token, {
        attendance_id: corrTarget.id,
        new_status: corrNewStatus,
        reason: corrReason.trim(),
      });
      setCorrSuccess(`Attendance for ${corrTarget.full_name} corrected to ${corrNewStatus}.`);
      setCorrTarget(null);
      await loadCorrAttendance();
    } catch (e: unknown) {
      setCorrFormError(e instanceof Error ? e.message : 'Failed to correct attendance');
    } finally {
      setCorrSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="Manual Attendance" description="Mark attendance for your assigned classes" />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <select className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterClass} onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setRows([]); }}
          disabled={loadingAssignments}>
          <option value="">Select class…</option>
          {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterSection} onChange={(e) => { setFilterSection(e.target.value); setRows([]); }}
          disabled={!filterClass}>
          <option value="">Select section…</option>
          {mySections.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <input type="date" className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      {/* Feedback */}
      {success && (
        <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {success}
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* RFID info banner */}
      {alreadyAllRfid && (
        <div className="mb-4 px-4 py-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          All students in this class have already been marked via RFID today.
        </div>
      )}

      {/* Student list */}
      {!filterClass || !filterSection ? (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16 text-sm text-gray-400">
          Select a class and section to load students.
        </div>
      ) : loadingCheck ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16 text-sm text-gray-400">
          No students found for {filterClass} · {filterSection}.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {/* Bulk actions */}
          <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 bg-gray-50">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>{rows.length} students</span>
              {rfidCount > 0 && (
                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">
                  {rfidCount} via RFID
                </span>
              )}
              {manualCount > 0 && (
                <span className="px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full">
                  {manualCount} manual
                </span>
              )}
            </div>
            {manualCount > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Mark all:</span>
                {(['present', 'absent'] as AttendanceStatus[]).map((s) => (
                  <button key={s} onClick={() => markAll(s)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors capitalize ${
                      s === 'present' ? 'bg-green-50 text-green-700 hover:bg-green-100' : 'bg-red-50 text-red-600 hover:bg-red-100'
                    }`}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="divide-y divide-gray-50">
            {rows.map((row) => (
              <div key={row.id} className="flex items-center justify-between px-6 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-semibold">
                    {row.full_name.charAt(0).toUpperCase()}
                  </div>
                  <p className="text-sm font-medium text-gray-900">{row.full_name}</p>
                </div>

                {row.rfidMarked ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full font-medium">
                      RFID · {row.rfidStatus}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {(['present', 'absent', 'late', 'excused'] as AttendanceStatus[]).map((s) => (
                      <button key={s} onClick={() => setStatus(row.id, s)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors capitalize ${
                          row.status === s
                            ? s === 'present' ? 'bg-green-600 text-white'
                              : s === 'absent' ? 'bg-red-600 text-white'
                              : s === 'late' ? 'bg-orange-500 text-white'
                              : 'bg-gray-500 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Submit */}
          {manualCount > 0 && (
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
              <button onClick={handleSubmit} disabled={submitting}
                className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors">
                {submitting ? (
                  <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving…</>
                ) : (
                  <>Submit Attendance ({manualCount} students)</>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Attendance Correction Section ──────────────────────────────────── */}
      <div className="mt-10">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-px flex-1 bg-gray-200" />
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">
            Attendance Correction
          </h2>
          <div className="h-px flex-1 bg-gray-200" />
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Select a date and class to view existing records, then correct any wrong entry. A notification will be sent to the parent.
        </p>

        {/* Correction filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <select
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            value={corrClass}
            onChange={(e) => { setCorrClass(e.target.value); setCorrSection(''); setCorrRows([]); setCorrError(''); setCorrSuccess(''); }}
            disabled={loadingAssignments}
          >
            <option value="">Select class…</option>
            {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          <select
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            value={corrSection}
            onChange={(e) => { setCorrSection(e.target.value); setCorrRows([]); setCorrError(''); setCorrSuccess(''); }}
            disabled={!corrClass}
          >
            <option value="">Select section…</option>
            {corrSections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <input
            type="date"
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={corrDate}
            onChange={(e) => { setCorrDate(e.target.value); setCorrRows([]); setCorrError(''); setCorrSuccess(''); }}
          />

          <button
            type="button"
            onClick={loadCorrAttendance}
            disabled={loadingCorr}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-900 disabled:bg-gray-400 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loadingCorr ? (
              <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Loading…</>
            ) : 'Load Attendance'}
          </button>
        </div>

        {/* Correction feedback */}
        {corrSuccess && (
          <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {corrSuccess}
          </div>
        )}
        {corrError && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{corrError}</div>
        )}

        {/* Correction table */}
        {corrRows.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {corrClass} · {corrSection} — {corrDate} — {corrRows.length} record{corrRows.length !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="divide-y divide-gray-50">
              {corrRows.map((row) => (
                <div key={row.student_id} className="flex items-center justify-between px-6 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 text-xs font-semibold">
                      {row.full_name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{row.full_name}</p>
                      {row.source && (
                        <p className="text-xs text-gray-400">Source: {row.source}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${
                      row.status === 'present' ? 'bg-green-100 text-green-700'
                      : row.status === 'absent' ? 'bg-red-100 text-red-600'
                      : row.status === 'late' ? 'bg-orange-100 text-orange-600'
                      : 'bg-gray-100 text-gray-600'
                    }`}>
                      {row.status}
                    </span>
                    <button
                      type="button"
                      onClick={() => openCorrModal(row)}
                      className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                    >
                      Correct
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Correction Modal ───────────────────────────────────────────────── */}
      <Modal open={!!corrTarget} onClose={() => setCorrTarget(null)} title="Correct Attendance">
        <form onSubmit={handleCorrect} className="space-y-4">
          {corrFormError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{corrFormError}</div>
          )}

          {corrTarget && (
            <div className="px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg space-y-1">
              <p className="text-xs text-gray-500 font-medium">Student</p>
              <p className="text-sm font-semibold text-gray-900">{corrTarget.full_name}</p>
              <p className="text-xs text-gray-500">
                Current status: <span className="font-medium capitalize text-gray-700">{corrTarget.status}</span>
              </p>
            </div>
          )}

          <FormField label="New Status" htmlFor="corr-status" required>
            <select
              id="corr-status"
              className={inputClass}
              value={corrNewStatus}
              onChange={(e) => setCorrNewStatus(e.target.value)}
            >
              {(['present', 'absent', 'late', 'excused'] as const).map((s) => (
                <option key={s} value={s} className="capitalize">{s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
          </FormField>

          <FormField label="Reason" htmlFor="corr-reason" required>
            <textarea
              id="corr-reason"
              rows={3}
              className={`${inputClass} resize-none`}
              placeholder="Explain why this correction is needed…"
              value={corrReason}
              onChange={(e) => setCorrReason(e.target.value)}
            />
          </FormField>

          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => setCorrTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={corrSubmitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
            >
              {corrSubmitting ? 'Saving…' : 'Submit Correction'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
