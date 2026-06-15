'use client';

/**
 * Teacher Attendance History
 * - Filter by class, section, month → Load
 * - Section A: Daily summary table (Date | Present | Absent | Total | Actions)
 *   - "View Details" opens a modal with full student list for that day
 * - Section B: Student summary table (Roll No | Name | Present | Absent | %)
 *   - % color-coded: green ≥75%, yellow 50-74%, red <50%
 * - Export as CSV button
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DailySummaryRow {
  date: string;
  present: number;
  absent: number;
  total: number;
}

interface StudentSummaryRow {
  student_id: string;
  name: string;
  roll_number: string | null;
  present_count: number;
  absent_count: number;
  total_days: number;
  percentage: number;
}

interface StudentDetailRow {
  student_id: string;
  name: string;
  roll_number: string | null;
  status: 'present' | 'absent' | 'late' | 'excused';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

async function apiFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `Request failed: ${res.status}`);
  return json.data as T;
}

/** Returns YYYY-MM for the current month */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Given YYYY-MM, returns { start: YYYY-MM-01, end: YYYY-MM-DD (last day) } */
function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number);
  const start = `${ym}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${ym}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

/** Percentage color class */
function pctColor(pct: number): string {
  if (pct >= 75) return 'text-green-600 font-semibold';
  if (pct >= 50) return 'text-yellow-600 font-semibold';
  return 'text-red-600 font-semibold';
}

/** Percentage badge class */
function pctBadge(pct: number): string {
  if (pct >= 75) return 'bg-green-100 text-green-700';
  if (pct >= 50) return 'bg-yellow-100 text-yellow-700';
  return 'bg-red-100 text-red-700';
}

/** Format YYYY-MM-DD → readable date */
function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Export student summary as CSV */
function exportCSV(
  rows: StudentSummaryRow[],
  className: string,
  section: string,
  month: string
) {
  const header = ['Roll No', 'Name', 'Present Days', 'Absent Days', 'Total Days', 'Attendance %'];
  const lines = rows.map((r) => [
    r.roll_number ?? '',
    r.name,
    r.present_count,
    r.absent_count,
    r.total_days,
    r.percentage,
  ]);
  const csv = [header, ...lines].map((row) => row.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `attendance_${className}_${section}_${month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TeacherAttendanceHistoryPage() {
  const { user } = useAuth();

  // ── Assignments ───────────────────────────────────────────────────────────
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // ── Filters ───────────────────────────────────────────────────────────────
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);

  // ── Data ──────────────────────────────────────────────────────────────────
  const [dailyRows, setDailyRows] = useState<DailySummaryRow[]>([]);
  const [studentRows, setStudentRows] = useState<StudentSummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  // ── Detail modal ──────────────────────────────────────────────────────────
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<StudentDetailRow[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');

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
    ...new Set(
      assignments
        .filter((a) => a.class_name === selectedClass)
        .map((a) => a.section)
    ),
  ].sort();

  // ── Load history ──────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    if (!selectedClass || !selectedSection || !selectedMonth || !user?.school_id) return;
    const token = getToken();
    if (!token) return;

    setLoading(true);
    setError('');
    setLoaded(false);
    setDailyRows([]);
    setStudentRows([]);

    const { start, end } = monthRange(selectedMonth);

    try {
      // Fetch class-history (per-student summary)
      const studentData = await apiFetch<StudentSummaryRow[]>(
        `/api/attendance/class-history?class=${encodeURIComponent(selectedClass)}&section=${encodeURIComponent(selectedSection)}&start_date=${start}&end_date=${end}&school_id=${user.school_id}`,
        token
      );
      setStudentRows(studentData);

      // Build daily summary from class attendance records
      // We fetch each day's data by querying /api/attendance/class for each date
      // that has at least one record. Instead, we derive daily summary from
      // the class-history endpoint by fetching raw records via a dedicated call.
      // Use /api/attendance/class for each date that has records.
      // More efficient: fetch all records for the range and aggregate client-side.
      // We'll use the existing /api/attendance/class endpoint per date only for
      // the detail modal. For the daily summary we derive from student data by
      // fetching a daily breakdown endpoint.
      //
      // Since the backend exposes /api/attendance/class?date=X, we build the
      // daily summary by fetching the class roster for each calendar day in the
      // month that has at least one submitted record. We detect submitted days
      // by checking if any student has total_days > 0 and then fetching per-day.
      //
      // Simpler approach: fetch /api/attendance/class for every day in the month
      // in parallel (capped), then aggregate. But that's many requests.
      //
      // Best approach: use the student summary data we already have to infer
      // which days were submitted, then fetch each submitted day's detail.
      // We know total_days per student; the max total_days = number of submitted days.
      const maxDays = studentData.reduce((m, s) => Math.max(m, s.total_days), 0);

      if (maxDays === 0) {
        setDailyRows([]);
        setLoaded(true);
        return;
      }

      // Enumerate all calendar days in the month and fetch each in parallel
      const [y, mo] = selectedMonth.split('-').map(Number);
      const daysInMonth = new Date(y, mo, 0).getDate();
      const allDates: string[] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        allDates.push(`${selectedMonth}-${String(d).padStart(2, '0')}`);
      }

      // Fetch all dates in parallel, ignore dates with no records
      const results = await Promise.allSettled(
        allDates.map((date) =>
          apiFetch<{ student_id: string; name: string; roll_number: string | null; status: string }[]>(
            `/api/attendance/class?class=${encodeURIComponent(selectedClass)}&section=${encodeURIComponent(selectedSection)}&date=${date}&school_id=${user.school_id}`,
            token
          ).then((data) => ({ date, data }))
        )
      );

      const daily: DailySummaryRow[] = [];
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { date, data } = r.value;
        // A day is "submitted" if at least one student has a non-not_marked status
        const submitted = data.some((s) => s.status !== 'not_marked');
        if (!submitted) continue;
        const present = data.filter((s) => s.status === 'present').length;
        const absent = data.filter((s) => s.status === 'absent').length;
        daily.push({ date, present, absent, total: data.length });
      }

      // Sort by date ascending
      daily.sort((a, b) => a.date.localeCompare(b.date));
      setDailyRows(daily);
      setLoaded(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load attendance history');
    } finally {
      setLoading(false);
    }
  }, [selectedClass, selectedSection, selectedMonth, user?.school_id]);

  // ── Open detail modal ─────────────────────────────────────────────────────
  async function openDetail(date: string) {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setDetailDate(date);
    setDetailRows([]);
    setDetailError('');
    setLoadingDetail(true);
    try {
      const data = await apiFetch<
        { student_id: string; name: string; roll_number: string | null; status: string }[]
      >(
        `/api/attendance/class?class=${encodeURIComponent(selectedClass)}&section=${encodeURIComponent(selectedSection)}&date=${date}&school_id=${user.school_id}`,
        token
      );
      setDetailRows(
        data.map((s) => ({
          student_id: s.student_id,
          name: s.name,
          roll_number: s.roll_number,
          status: (s.status as StudentDetailRow['status']) ?? 'present',
        }))
      );
    } catch (e: unknown) {
      setDetailError(e instanceof Error ? e.message : 'Failed to load details');
    } finally {
      setLoadingDetail(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Attendance History"
        description="View monthly attendance records for your classes"
        action={
          loaded && studentRows.length > 0 ? (
            <button
              type="button"
              onClick={() => exportCSV(studentRows, selectedClass, selectedSection, selectedMonth)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          ) : undefined
        }
      />

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
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
              setLoaded(false);
              setDailyRows([]);
              setStudentRows([]);
              setError('');
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
              setLoaded(false);
              setDailyRows([]);
              setStudentRows([]);
              setError('');
            }}
            disabled={!selectedClass}
          >
            <option value="">Select section…</option>
            {mySections.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Month picker */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">Month</label>
          <input
            type="month"
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={selectedMonth}
            max={currentMonth()}
            onChange={(e) => {
              setSelectedMonth(e.target.value);
              setLoaded(false);
              setDailyRows([]);
              setStudentRows([]);
              setError('');
            }}
          />
        </div>

        {/* Load button */}
        <button
          type="button"
          onClick={loadHistory}
          disabled={!selectedClass || !selectedSection || !selectedMonth || loading}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 rounded-lg transition-colors self-end"
        >
          {loading ? 'Loading…' : 'Load'}
        </button>
      </div>

      {/* ── Error ───────────────────────────────────────────────────────────── */}
      {error && (
        <div className="mb-5 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Loading spinner ──────────────────────────────────────────────────── */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* ── Empty / prompt state ─────────────────────────────────────────────── */}
      {!loading && !loaded && !error && (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16 text-sm text-gray-400">
          Select a class, section, and month, then click &quot;Load&quot;.
        </div>
      )}

      {/* ── No data ──────────────────────────────────────────────────────────── */}
      {!loading && loaded && dailyRows.length === 0 && studentRows.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16 text-sm text-gray-400">
          No attendance records found for {selectedClass} {selectedSection} in{' '}
          {new Date(selectedMonth + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}.
        </div>
      )}

      {/* ── Section A: Daily Summary ─────────────────────────────────────────── */}
      {!loading && loaded && dailyRows.length > 0 && (
        <section className="mb-8">
          <h2 className="text-base font-semibold text-gray-800 mb-3">Daily Summary</h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Present</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Absent</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {dailyRows.map((row) => (
                    <tr key={row.date} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-gray-900">{fmtDate(row.date)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          {row.present}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                          {row.absent}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-gray-600">{row.total}</td>
                      <td className="px-5 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => openDetail(row.date)}
                          className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                        >
                          View Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Section B: Student Summary ───────────────────────────────────────── */}
      {!loading && loaded && studentRows.length > 0 && (
        <section>
          <h2 className="text-base font-semibold text-gray-800 mb-3">Student Summary</h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Roll No</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Present Days</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Absent Days</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Attendance %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {studentRows.map((row) => (
                    <tr key={row.student_id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 text-gray-500 text-xs">
                        {row.roll_number ? `#${row.roll_number}` : '—'}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{row.name}</td>
                      <td className="px-4 py-3 text-center text-green-700 font-medium">{row.present_count}</td>
                      <td className="px-4 py-3 text-center text-red-600 font-medium">{row.absent_count}</td>
                      <td className="px-5 py-3 text-center">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs ${pctBadge(row.percentage)}`}>
                          <span className={pctColor(row.percentage)}>{row.percentage}%</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Detail Modal ─────────────────────────────────────────────────────── */}
      <Modal
        open={detailDate !== null}
        onClose={() => setDetailDate(null)}
        title={detailDate ? `Attendance — ${fmtDate(detailDate)}` : ''}
        size="lg"
      >
        {loadingDetail && (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {detailError && (
          <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {detailError}
          </div>
        )}

        {!loadingDetail && !detailError && detailRows.length > 0 && (
          <>
            {/* Summary chips */}
            <div className="flex gap-3 mb-4">
              <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                {detailRows.filter((r) => r.status === 'present').length} Present
              </span>
              <span className="px-3 py-1 bg-red-100 text-red-700 text-xs font-medium rounded-full">
                {detailRows.filter((r) => r.status === 'absent').length} Absent
              </span>
              <span className="px-3 py-1 bg-gray-100 text-gray-600 text-xs font-medium rounded-full">
                {detailRows.length} Total
              </span>
            </div>

            <div className="overflow-x-auto max-h-96 overflow-y-auto rounded-lg border border-gray-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="border-b border-gray-100">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Roll No</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {detailRows.map((row) => (
                    <tr key={row.student_id} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 text-xs text-gray-500">
                        {row.roll_number ? `#${row.roll_number}` : '—'}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-gray-900">{row.name}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${
                            row.status === 'present'
                              ? 'bg-green-100 text-green-700'
                              : row.status === 'absent'
                              ? 'bg-red-100 text-red-700'
                              : row.status === 'late'
                              ? 'bg-orange-100 text-orange-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!loadingDetail && !detailError && detailRows.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8">No records found for this date.</p>
        )}
      </Modal>
    </>
  );
}
