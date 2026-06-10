'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import {
  performanceApi,
  type MonthlySnapshot,
  type ClassRankingRow,
  type SnapshotStudentRow,
} from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Build a list of the last N months as { year, month, label } options. */
function buildMonthOptions(count = 12) {
  const options: { year: number; month: number; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    options.push({
      year:  d.getFullYear(),
      month: d.getMonth() + 1,
      label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
    });
  }
  return options;
}

function fmt(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

// ── Skeleton helpers ──────────────────────────────────────────────────────────

function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="animate-pulse">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-3 border-b border-gray-50">
          <div className="h-4 bg-gray-200 rounded w-8 shrink-0" />
          <div className="h-4 bg-gray-200 rounded flex-1" />
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-200 rounded w-20" />
        </div>
      ))}
    </div>
  );
}

// ── Row colour helpers ────────────────────────────────────────────────────────

/** Returns Tailwind class(es) for a student row based on their average %. */
function studentRowClass(pct: number): string {
  if (pct < 40)  return 'bg-red-50';
  if (pct < 50)  return 'bg-amber-50';
  return '';
}

function studentPctClass(pct: number): string {
  if (pct < 40)  return 'text-red-600 font-semibold';
  if (pct < 50)  return 'text-amber-600 font-semibold';
  return 'text-gray-800 font-semibold';
}

// ── Component 1 — Class Rankings ──────────────────────────────────────────────

function ClassRankings({ rankings, loading }: { rankings: ClassRankingRow[]; loading: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Class Performance Rankings</h2>
          <p className="text-xs text-gray-500 mt-0.5">Average % across all marks entered this month</p>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={5} />
      ) : rankings.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-gray-400">
          No mark entries found for this month.
        </div>
      ) : (
        <>
          {/* Table header */}
          <div className="grid grid-cols-[2.5rem_1fr_auto_auto_auto] gap-x-3 items-center px-5 py-2 bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
            <span>#</span>
            <span>Class</span>
            <span className="text-right hidden sm:block">Tests / Exams</span>
            <span className="text-right hidden sm:block">Students</span>
            <span className="text-right">Avg %</span>
          </div>

          <div className="divide-y divide-gray-50">
            {rankings.map((row, idx) => {
              const isBest   = idx === 0;
              const isWorst  = idx === rankings.length - 1 && rankings.length > 1;

              return (
                <div
                  key={`${row.class_name}-${row.section}`}
                  className={`grid grid-cols-[2.5rem_1fr_auto_auto_auto] gap-x-3 items-center px-5 py-3 ${
                    isBest ? 'bg-green-50' : isWorst ? 'bg-red-50' : ''
                  }`}
                >
                  {/* Rank */}
                  <span className="text-sm font-semibold text-gray-500">{row.rank}</span>

                  {/* Class name + badge */}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {row.class_name}{row.section ? ` — ${row.section}` : ''}
                    </span>
                    {isBest && (
                      <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-100 text-green-700">
                        Best Performing
                      </span>
                    )}
                    {isWorst && (
                      <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-700">
                        Needs Attention
                      </span>
                    )}
                  </div>

                  {/* Tests taken */}
                  <span className="text-sm text-gray-500 text-right hidden sm:block">
                    {row.exam_count}
                  </span>

                  {/* Students */}
                  <span className="text-sm text-gray-500 text-right hidden sm:block">
                    {row.student_count}
                  </span>

                  {/* Avg % */}
                  <span className={`text-sm text-right font-semibold ${
                    isBest ? 'text-green-700' : isWorst ? 'text-red-600' : 'text-gray-800'
                  }`}>
                    {fmt(row.avg_pct)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Mobile column legend */}
          <div className="sm:hidden px-5 py-2 bg-gray-50 text-xs text-gray-400 border-t border-gray-100">
            Swipe or rotate device to see Tests &amp; Student columns
          </div>
        </>
      )}
    </div>
  );
}

// ── Component 2 — Top 10 Students ─────────────────────────────────────────────

function TopStudents({ students, loading }: { students: SnapshotStudentRow[]; loading: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="w-8 h-8 bg-yellow-50 rounded-lg flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Top 10 Students — School-Wide</h2>
          <p className="text-xs text-gray-500 mt-0.5">Highest average % across all marks this month</p>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={10} />
      ) : students.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-gray-400">
          No mark entries found for this month.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[2.5rem_1fr_auto_auto] gap-x-3 items-center px-5 py-2 bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
            <span>Rank</span>
            <span>Student</span>
            <span className="text-right hidden sm:block">Class</span>
            <span className="text-right">Avg %</span>
          </div>

          <div className="divide-y divide-gray-50">
            {students.map((row) => (
              <div
                key={row.student_id}
                className="grid grid-cols-[2.5rem_1fr_auto_auto] gap-x-3 items-center px-5 py-3"
              >
                {/* Rank + trophy for #1 */}
                <div className="flex items-center gap-1">
                  {row.rank === 1 ? (
                    <svg className="w-4 h-4 text-yellow-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                  ) : (
                    <span className="text-sm font-semibold text-gray-500 w-4">{row.rank}</span>
                  )}
                </div>

                {/* Name */}
                <span className="text-sm font-medium text-gray-900 truncate">{row.full_name}</span>

                {/* Class */}
                <span className="text-sm text-gray-500 text-right hidden sm:block truncate max-w-[120px]">
                  {row.class_name}{row.section ? ` ${row.section}` : ''}
                </span>

                {/* Avg % */}
                <span className="text-sm text-right font-semibold text-gray-800">
                  {fmt(row.avg_pct)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Component 3 — Bottom 10 Students ─────────────────────────────────────────

function BottomStudents({ students, loading }: { students: SnapshotStudentRow[]; loading: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Bottom 10 Students — Needs Improvement</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            <span className="inline-block w-2 h-2 rounded-sm bg-red-200 mr-1 align-middle" />below 40%&nbsp;
            <span className="inline-block w-2 h-2 rounded-sm bg-amber-200 mr-1 align-middle" />40–50%&nbsp;
            <span className="inline-block w-2 h-2 rounded-sm bg-gray-100 mr-1 align-middle" />above 50%
          </p>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={10} />
      ) : students.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-gray-400">
          No mark entries found for this month.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[2.5rem_1fr_auto_auto] gap-x-3 items-center px-5 py-2 bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
            <span>Rank</span>
            <span>Student</span>
            <span className="text-right hidden sm:block">Class</span>
            <span className="text-right">Avg %</span>
          </div>

          <div className="divide-y divide-gray-50">
            {students.map((row) => (
              <div
                key={row.student_id}
                className={`grid grid-cols-[2.5rem_1fr_auto_auto] gap-x-3 items-center px-5 py-3 ${studentRowClass(row.avg_pct)}`}
              >
                {/* Rank */}
                <span className="text-sm font-semibold text-gray-500">{row.rank}</span>

                {/* Name */}
                <span className="text-sm font-medium text-gray-900 truncate">{row.full_name}</span>

                {/* Class */}
                <span className="text-sm text-gray-500 text-right hidden sm:block truncate max-w-[120px]">
                  {row.class_name}{row.section ? ` ${row.section}` : ''}
                </span>

                {/* Avg % — coloured based on threshold */}
                <span className={`text-sm text-right ${studentPctClass(row.avg_pct)}`}>
                  {fmt(row.avg_pct)}
                </span>
              </div>
            ))}
          </div>

          {/* Legend for mobile */}
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex flex-wrap gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-red-100 border border-red-200" />
              Below 40% — critical
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-amber-100 border border-amber-200" />
              40–50% — warning
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MonthlyPerformancePage() {
  const { user } = useAuth();
  const router   = useRouter();

  // ── Admin-only guard ────────────────────────────────────────────────────────
  // The layout already redirects non-authenticated users; this guard handles
  // non-admin roles that somehow reach this URL.
  useEffect(() => {
    if (user && user.role !== 'schooladmin') {
      router.replace('/login');
    }
  }, [user, router]);

  // ── Month selector state ────────────────────────────────────────────────────
  const monthOptions = buildMonthOptions(24);
  const [selectedIdx, setSelectedIdx] = useState(0); // 0 = current month

  const { year, month } = monthOptions[selectedIdx];

  // ── Data state ──────────────────────────────────────────────────────────────
  const [snapshot, setSnapshot] = useState<MonthlySnapshot | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  const fetchSnapshot = useCallback(async (y: number, m: number) => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await performanceApi.monthlySnapshot(token, { year: y, month: m });
      setSnapshot(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load snapshot');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'schooladmin') {
      fetchSnapshot(year, month);
    }
  }, [user, year, month, fetchSnapshot]);

  // Don't render anything if not admin (redirect is in flight)
  if (user && user.role !== 'schooladmin') return null;

  return (
    <>
      <PageHeader
        title="Monthly Performance Snapshot"
        description="Class rankings and student performance highlights for the selected month"
        action={
          <div className="flex items-center gap-2">
            {/* Month selector */}
            <label htmlFor="month-select" className="text-sm text-gray-500 font-medium whitespace-nowrap">
              Month:
            </label>
            <select
              id="month-select"
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
              aria-label="Select month for performance snapshot"
            >
              {monthOptions.map((opt, idx) => (
                <option key={`${opt.year}-${opt.month}`} value={idx}>
                  {idx === 0 ? `${opt.label} (Current)` : opt.label}
                </option>
              ))}
            </select>

            {/* Refresh button */}
            <button
              onClick={() => fetchSnapshot(year, month)}
              disabled={loading}
              className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Refresh data"
              title="Refresh"
            >
              <svg
                className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        }
      />

      {/* Error banner */}
      {error && (
        <div className="mb-6 flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 8v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          {error}
          <button
            onClick={() => fetchSnapshot(year, month)}
            className="ml-auto text-red-600 underline text-sm font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {/* Summary badges */}
      {!loading && snapshot && (
        <div className="flex flex-wrap gap-2 mb-6">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full text-xs font-medium">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            {snapshot.classRankings.length} class{snapshot.classRankings.length !== 1 ? 'es' : ''} ranked
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-100 rounded-full text-xs font-medium">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {snapshot.topStudents.length + snapshot.bottomStudents.length} students with data
          </span>
          {snapshot.classRankings.length > 0 && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 border border-green-100 rounded-full text-xs font-medium">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              Top class: {snapshot.classRankings[0]?.class_name} ({fmt(snapshot.classRankings[0]?.avg_pct)})
            </span>
          )}
        </div>
      )}

      {/* Three section cards */}
      <div className="space-y-6">
        <ClassRankings
          rankings={snapshot?.classRankings ?? []}
          loading={loading}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TopStudents
            students={snapshot?.topStudents ?? []}
            loading={loading}
          />
          <BottomStudents
            students={snapshot?.bottomStudents ?? []}
            loading={loading}
          />
        </div>
      </div>
    </>
  );
}
