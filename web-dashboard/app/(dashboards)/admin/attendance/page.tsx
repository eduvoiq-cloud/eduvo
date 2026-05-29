'use client';

/**
 * Admin Attendance Overview
 * - Today's summary cards: Total Students, Present, Absent, Classes Not Submitted
 * - Class-wise breakdown table with date picker
 * - Student search → attendance history calendar
 * - Export entire school attendance as Excel (CSV)
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getToken } from '@/lib/session';
import { useDebounce } from '@/lib/useDebounce';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Modal from '@/components/Modal';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TodaySummary {
  total_students: number;
  present: number;
  absent: number;
  not_submitted_classes: { class_name: string; section: string }[];
}

interface ClassBreakdownRow {
  class_name: string;
  section: string;
  total: number;
  present: number;
  absent: number;
  submitted: boolean;
}

interface StudentSearchResult {
  id: string;
  full_name: string;
  class_name: string;
  section: string;
  roll_number: string | null;
}

interface AttendanceHistoryRecord {
  date: string;
  status: 'present' | 'absent' | 'late' | 'excused';
}

interface AttendanceHistorySummary {
  total_days: number;
  present_count: number;
  absent_count: number;
  percentage: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, '0')}` };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Export school attendance as CSV */
function exportSchoolCSV(rows: ClassBreakdownRow[], date: string) {
  const header = ['Class', 'Section', 'Total Students', 'Present', 'Absent', 'Status'];
  const lines = rows.map((r) => [
    r.class_name, r.section, r.total, r.present, r.absent,
    r.submitted ? 'Submitted' : 'Pending',
  ]);
  const csv = [header, ...lines].map((row) => row.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `school_attendance_${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Calendar component ────────────────────────────────────────────────────────

interface AttendanceCalendarProps {
  records: AttendanceHistoryRecord[];
  month: string; // YYYY-MM
}

function AttendanceCalendar({ records, month }: AttendanceCalendarProps) {
  const [y, m] = month.split('-').map(Number);
  const firstDay = new Date(y, m - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(y, m, 0).getDate();

  const statusMap = new Map(records.map((r) => [r.date, r.status]));

  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function cellStyle(day: number | null): string {
    if (!day) return '';
    const dateStr = `${month}-${String(day).padStart(2, '0')}`;
    const status = statusMap.get(dateStr);
    if (status === 'present') return 'bg-green-100 text-green-800 font-semibold';
    if (status === 'absent') return 'bg-red-100 text-red-700 font-semibold';
    if (status === 'late') return 'bg-orange-100 text-orange-700 font-semibold';
    if (status === 'excused') return 'bg-gray-100 text-gray-600';
    return 'text-gray-400';
  }

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 mb-1">
        {dayLabels.map((d) => (
          <div key={d} className="text-center text-xs font-semibold text-gray-400 py-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => (
          <div
            key={i}
            className={`aspect-square flex items-center justify-center rounded-lg text-xs ${day ? cellStyle(day) : ''}`}
          >
            {day ?? ''}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-3 text-xs">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-100 inline-block" />Present</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 inline-block" />Absent</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-100 inline-block" />Late</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-gray-100 inline-block" />Excused</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AdminAttendancePage() {
  const { user } = useAuth();

  // ── Today summary ─────────────────────────────────────────────────────────
  const [todaySummary, setTodaySummary] = useState<TodaySummary | null>(null);
  const [loadingToday, setLoadingToday] = useState(true);
  const [showNotSubmitted, setShowNotSubmitted] = useState(false);

  // ── Class breakdown ───────────────────────────────────────────────────────
  const [breakdownDate, setBreakdownDate] = useState(todayStr);
  const [breakdownRows, setBreakdownRows] = useState<ClassBreakdownRow[]>([]);
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);
  const [breakdownError, setBreakdownError] = useState('');

  // ── Student search ────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StudentSearchResult[]>([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [allStudents, setAllStudents] = useState<StudentSearchResult[]>([]);

  // Debounce search — filters client-side but avoids thrashing on every keystroke
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // ── Student history modal ─────────────────────────────────────────────────
  const [selectedStudent, setSelectedStudent] = useState<StudentSearchResult | null>(null);
  const [historyMonth, setHistoryMonth] = useState(currentMonth);
  const [historyRecords, setHistoryRecords] = useState<AttendanceHistoryRecord[]>([]);
  const [historySummary, setHistorySummary] = useState<AttendanceHistorySummary | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');

  // ── Load today's summary ──────────────────────────────────────────────────
  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    apiFetch<TodaySummary>(`/api/attendance/today-summary?school_id=${user.school_id}`, token)
      .then(setTodaySummary)
      .catch(() => {})
      .finally(() => setLoadingToday(false));
  }, [user]);

  // ── Load all students for search ──────────────────────────────────────────
  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    apiFetch<StudentSearchResult[]>(
      `/api/students?school_id=${user.school_id}`,
      token
    )
      .then((data) => setAllStudents(data))
      .catch(() => {});
  }, [user]);

  // ── Load class breakdown ──────────────────────────────────────────────────
  const loadBreakdown = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id || !breakdownDate) return;
    setLoadingBreakdown(true);
    setBreakdownError('');
    try {
      // Fetch all students to get class/section list
      const students = await apiFetch<
        { id: string; class_name: string; section?: string }[]
      >(`/api/students?school_id=${user.school_id}`, token);

      // Build unique class+section combos
      const classMap = new Map<string, { class_name: string; section: string; ids: string[] }>();
      for (const s of students) {
        const sec = s.section ?? '';
        const key = `${s.class_name}||${sec}`;
        if (!classMap.has(key)) classMap.set(key, { class_name: s.class_name, section: sec, ids: [] });
        classMap.get(key)!.ids.push(s.id);
      }

      // For each class, fetch attendance for the selected date
      const entries = Array.from(classMap.values());
      const results = await Promise.allSettled(
        entries.map(async (cls) => {
          const data = await apiFetch<{ student_id: string; status: string }[]>(
            `/api/attendance/class?class=${encodeURIComponent(cls.class_name)}&section=${encodeURIComponent(cls.section)}&date=${breakdownDate}&school_id=${user.school_id}`,
            token
          );
          const submitted = data.some((s) => s.status !== 'not_marked');
          const present = data.filter((s) => s.status === 'present').length;
          const absent = data.filter((s) => s.status === 'absent').length;
          return {
            class_name: cls.class_name,
            section: cls.section,
            total: data.length,
            present,
            absent,
            submitted,
          } as ClassBreakdownRow;
        })
      );

      const rows: ClassBreakdownRow[] = results
        .filter((r): r is PromiseFulfilledResult<ClassBreakdownRow> => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => a.class_name.localeCompare(b.class_name) || a.section.localeCompare(b.section));

      setBreakdownRows(rows);
    } catch (e: unknown) {
      setBreakdownError(e instanceof Error ? e.message : 'Failed to load breakdown');
    } finally {
      setLoadingBreakdown(false);
    }
  }, [breakdownDate, user?.school_id]);

  useEffect(() => { loadBreakdown(); }, [loadBreakdown]);

  // ── Student search ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!debouncedSearchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setLoadingSearch(true);
    const q = debouncedSearchQuery.toLowerCase();
    const filtered = allStudents.filter((s) =>
      s.full_name.toLowerCase().includes(q)
    ).slice(0, 10);
    setSearchResults(filtered);
    setLoadingSearch(false);
  }, [debouncedSearchQuery, allStudents]);

  // ── Load student history ──────────────────────────────────────────────────
  const loadStudentHistory = useCallback(async () => {
    if (!selectedStudent || !historyMonth) return;
    const token = getToken();
    if (!token) return;
    setLoadingHistory(true);
    setHistoryError('');
    const { start, end } = monthRange(historyMonth);
    try {
      const data = await apiFetch<{
        records: AttendanceHistoryRecord[];
        summary: AttendanceHistorySummary;
      }>(
        `/api/attendance/history?student_id=${selectedStudent.id}&start_date=${start}&end_date=${end}`,
        token
      );
      setHistoryRecords(data.records);
      setHistorySummary(data.summary);
    } catch (e: unknown) {
      setHistoryError(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      setLoadingHistory(false);
    }
  }, [selectedStudent, historyMonth]);

  useEffect(() => {
    if (selectedStudent) loadStudentHistory();
  }, [selectedStudent, loadStudentHistory]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const notSubmittedCount = todaySummary?.not_submitted_classes.length ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Attendance Overview"
        description="School-wide attendance monitoring and reporting"
        action={
          breakdownRows.length > 0 ? (
            <button
              type="button"
              onClick={() => exportSchoolCSV(breakdownRows, breakdownDate)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export Excel
            </button>
          ) : undefined
        }
      />

      {/* ── Today's Summary Cards ────────────────────────────────────────────── */}
      {loadingToday ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
              <div className="h-3 bg-gray-200 rounded w-24 mb-3" />
              <div className="h-7 bg-gray-200 rounded w-16 mb-2" />
              <div className="h-3 bg-gray-200 rounded w-20" />
            </div>
          ))}
        </div>
      ) : todaySummary ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Total Students"
            value={todaySummary.total_students}
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
          />
          <StatCard
            label="Present Today"
            value={todaySummary.present}
            sub={todaySummary.total_students > 0 ? `${Math.round((todaySummary.present / todaySummary.total_students) * 100)}%` : '—'}
            icon={
              <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
          <StatCard
            label="Absent Today"
            value={todaySummary.absent}
            sub={todaySummary.total_students > 0 ? `${Math.round((todaySummary.absent / todaySummary.total_students) * 100)}%` : '—'}
            icon={
              <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
          <button
            type="button"
            onClick={() => setShowNotSubmitted(true)}
            className="bg-white rounded-xl border border-gray-200 p-5 text-left hover:border-orange-300 transition-colors"
          >
            <p className="text-sm text-gray-500 font-medium">Not Submitted</p>
            <p className="mt-1 text-2xl font-semibold text-orange-600">{notSubmittedCount}</p>
            <p className="mt-0.5 text-xs text-orange-400">
              {notSubmittedCount > 0 ? 'Click to view classes' : 'All classes submitted'}
            </p>
          </button>
        </div>
      ) : null}

      {/* ── Class-wise Breakdown ─────────────────────────────────────────────── */}
      <section className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-base font-semibold text-gray-800">Class-wise Breakdown</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-500">Date</label>
            <input
              type="date"
              value={breakdownDate}
              max={todayStr()}
              onChange={(e) => setBreakdownDate(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {breakdownError && (
          <div className="mb-3 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {breakdownError}
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {loadingBreakdown ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Class', 'Section', 'Total', 'Present', 'Absent', 'Status'].map((h) => (
                      <th key={h} className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-5 py-3"><div className="h-4 bg-gray-200 rounded w-16" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-8" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-10 mx-auto" /></td>
                      <td className="px-4 py-3"><div className="h-5 bg-gray-200 rounded-full w-10 mx-auto" /></td>
                      <td className="px-4 py-3"><div className="h-5 bg-gray-200 rounded-full w-10 mx-auto" /></td>
                      <td className="px-5 py-3"><div className="h-5 bg-gray-200 rounded-full w-20 mx-auto" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : breakdownRows.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400">
              No class data available for {fmtDate(breakdownDate)}.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Class</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Section</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Present</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Absent</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {breakdownRows.map((row) => (
                    <tr key={`${row.class_name}-${row.section}`} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-gray-900">{row.class_name}</td>
                      <td className="px-4 py-3 text-gray-600">{row.section || '—'}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{row.total}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          {row.present}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                          {row.absent}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            row.submitted
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-600'
                          }`}
                        >
                          {row.submitted ? 'Submitted' : 'Pending'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ── Student Search ───────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-base font-semibold text-gray-800 mb-3">Student Attendance Search</h2>
        <div className="relative mb-4">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search student by name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {loadingSearch && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {/* Debounce pending indicator */}
          {!loadingSearch && searchQuery !== debouncedSearchQuery && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-3.5 h-3.5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        {/* Search results */}
        {searchResults.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Class</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Section</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {searchResults.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-gray-900">{s.full_name}</td>
                      <td className="px-4 py-3 text-gray-600">{s.class_name}</td>
                      <td className="px-4 py-3 text-gray-600">{s.section || '—'}</td>
                      <td className="px-5 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedStudent(s);
                            setHistoryMonth(currentMonth());
                            setSearchQuery('');
                            setSearchResults([]);
                          }}
                          className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          View History
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {searchQuery.trim() && searchResults.length === 0 && !loadingSearch && searchQuery === debouncedSearchQuery && (
          <p className="text-sm text-gray-400 text-center py-6">No students found matching &quot;{searchQuery}&quot;.</p>
        )}
      </section>

      {/* ── Not Submitted Modal ──────────────────────────────────────────────── */}
      <Modal
        open={showNotSubmitted}
        onClose={() => setShowNotSubmitted(false)}
        title="Classes Not Yet Submitted"
        size="md"
      >
        {todaySummary?.not_submitted_classes.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">All classes have submitted attendance today.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {todaySummary?.not_submitted_classes.map((c) => (
              <li key={`${c.class_name}-${c.section}`} className="flex items-center justify-between py-2.5">
                <span className="text-sm font-medium text-gray-800">{c.class_name}</span>
                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{c.section}</span>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      {/* ── Student History Modal ────────────────────────────────────────────── */}
      <Modal
        open={selectedStudent !== null}
        onClose={() => {
          setSelectedStudent(null);
          setHistoryRecords([]);
          setHistorySummary(null);
          setHistoryError('');
        }}
        title={selectedStudent ? `${selectedStudent.full_name} — Attendance History` : ''}
        size="lg"
      >
        {/* Month picker */}
        <div className="flex items-center gap-3 mb-4">
          <label className="text-xs font-medium text-gray-500">Month</label>
          <input
            type="month"
            value={historyMonth}
            max={currentMonth()}
            onChange={(e) => setHistoryMonth(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {selectedStudent && (
            <span className="text-xs text-gray-400">
              {selectedStudent.class_name} · {selectedStudent.section}
            </span>
          )}
        </div>

        {loadingHistory && (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {historyError && (
          <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">
            {historyError}
          </div>
        )}

        {!loadingHistory && !historyError && historySummary && (
          <>
            {/* Summary chips */}
            <div className="flex flex-wrap gap-3 mb-4">
              <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                {historySummary.present_count} Present
              </span>
              <span className="px-3 py-1 bg-red-100 text-red-700 text-xs font-medium rounded-full">
                {historySummary.absent_count} Absent
              </span>
              <span className="px-3 py-1 bg-blue-100 text-blue-700 text-xs font-medium rounded-full">
                {historySummary.percentage}% Attendance
              </span>
              <span className="px-3 py-1 bg-gray-100 text-gray-600 text-xs font-medium rounded-full">
                {historySummary.total_days} Days Recorded
              </span>
            </div>

            {/* Calendar */}
            <AttendanceCalendar records={historyRecords} month={historyMonth} />
          </>
        )}

        {!loadingHistory && !historyError && historySummary?.total_days === 0 && (
          <p className="text-sm text-gray-400 text-center py-6">
            No attendance records found for{' '}
            {new Date(historyMonth + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}.
          </p>
        )}
      </Modal>
    </>
  );
}
