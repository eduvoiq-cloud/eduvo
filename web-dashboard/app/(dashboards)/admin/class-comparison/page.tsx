'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useAuth } from '@/context/AuthContext';
import { classComparisonApi, type ClassComparisonRow } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function buildMonthOptions(count = 12) {
  const options: { year: number; month: number; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    options.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` });
  }
  return options;
}

function fmt(val: number | null, suffix = '%'): string {
  if (val === null || val === undefined) return '—';
  return `${val.toFixed(1)}${suffix}`;
}

function pctColor(val: number | null): string {
  if (val === null) return 'text-gray-400';
  if (val >= 75) return 'text-green-700 font-semibold';
  if (val >= 50) return 'text-yellow-700 font-semibold';
  return 'text-red-600 font-semibold';
}

// ── Inline mini bar ───────────────────────────────────────────────────────────

function MiniBar({ value, color }: { value: number | null; color: string }) {
  const pct = value !== null ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden mt-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%`, transition: 'width 0.4s ease' }} />
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="animate-pulse">
      {[...Array(rows)].map((_, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-6 items-center px-5 py-4 border-b border-gray-50">
          <div className="h-4 bg-gray-200 rounded w-24" />
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-200 rounded w-10" />
        </div>
      ))}
    </div>
  );
}

// ── Metric cell ───────────────────────────────────────────────────────────────

function MetricCell({ value, barColor }: { value: number | null; barColor: string }) {
  return (
    <div className="min-w-[64px]">
      <span className={`text-sm ${pctColor(value)}`}>{fmt(value)}</span>
      <MiniBar value={value} color={barColor} />
    </div>
  );
}

// ── Inner page ────────────────────────────────────────────────────────────────

function ClassComparisonPageInner() {
  const { user } = useAuth();
  void user;

  const monthOptions = buildMonthOptions(24);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [classes, setClasses] = useState<ClassComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { year, month } = monthOptions[selectedIdx];

  const fetchData = useCallback(async (y: number, m: number) => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await classComparisonApi.get(token, { year: y, month: m });
      setClasses(res.data.classes ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load class comparison');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(year, month); }, [year, month, fetchData]);

  // School-wide averages
  const withData = classes.filter((c) => c.avg_marks_pct !== null);
  const schoolAvgMarks = withData.length
    ? Math.round((withData.reduce((s, c) => s + (c.avg_marks_pct ?? 0), 0) / withData.length) * 10) / 10
    : null;
  const withAtt = classes.filter((c) => c.attendance_pct !== null);
  const schoolAvgAtt = withAtt.length
    ? Math.round((withAtt.reduce((s, c) => s + (c.attendance_pct ?? 0), 0) / withAtt.length) * 10) / 10
    : null;

  return (
    <>
      <PageHeader
        title="Class-wise Comparison"
        description="Side-by-side performance snapshot across all classes for the selected month"
        action={
          <div className="flex items-center gap-2">
            <label htmlFor="cc-month" className="text-sm text-gray-500 font-medium whitespace-nowrap">Month:</label>
            <select
              id="cc-month"
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Select month"
            >
              {monthOptions.map((opt, idx) => (
                <option key={`${opt.year}-${opt.month}`} value={idx}>
                  {idx === 0 ? `${opt.label} (Current)` : opt.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => fetchData(year, month)}
              disabled={loading}
              className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-colors disabled:opacity-40"
              aria-label="Refresh"
              title="Refresh"
            >
              <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        }
      />

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="mb-5 flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {error}
          <button onClick={() => fetchData(year, month)} className="ml-auto text-red-600 underline text-sm font-medium">Retry</button>
        </div>
      )}

      {/* ── School-wide summary badges ──────────────────────────────────────── */}
      {!loading && classes.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-6">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full text-xs font-medium">
            {classes.length} class{classes.length !== 1 ? 'es' : ''} in view
          </span>
          {schoolAvgMarks !== null && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-100 rounded-full text-xs font-medium">
              School avg marks: {fmt(schoolAvgMarks)}
            </span>
          )}
          {schoolAvgAtt !== null && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal-50 text-teal-700 border border-teal-100 rounded-full text-xs font-medium">
              School avg attendance: {fmt(schoolAvgAtt)}
            </span>
          )}
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto_auto] gap-x-4 items-center px-5 py-3 bg-gray-50 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
          <span>Class</span>
          <span>Avg Marks</span>
          <span className="hidden sm:block">Attendance</span>
          <span className="hidden md:block">HW Submission</span>
          <span className="text-right hidden md:block">Tests</span>
          <span className="text-right">Students</span>
        </div>

        {loading ? (
          <TableSkeleton rows={6} />
        ) : classes.length === 0 ? (
          <div className="px-5 py-16 text-center text-sm text-gray-400">
            No class data found for this month.
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {classes.map((c, idx) => {
              const isBest  = idx === 0 && c.avg_marks_pct !== null;
              const isWorst = idx === classes.length - 1 && classes.length > 1 && c.avg_marks_pct !== null;
              return (
                <div
                  key={`${c.class_name}-${c.section}`}
                  className={`grid grid-cols-[1fr_1fr_1fr_1fr_auto_auto] gap-x-4 items-center px-5 py-4 ${
                    isBest ? 'bg-green-50' : isWorst ? 'bg-red-50' : ''
                  }`}
                >
                  {/* Class name */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">
                        {c.class_name}{c.section ? ` — ${c.section}` : ''}
                      </span>
                      {isBest && (
                        <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-100 text-green-700">Best</span>
                      )}
                      {isWorst && (
                        <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-700">Needs Attention</span>
                      )}
                    </div>
                  </div>

                  {/* Avg marks */}
                  <MetricCell value={c.avg_marks_pct} barColor={
                    c.avg_marks_pct !== null && c.avg_marks_pct >= 75 ? 'bg-green-500' :
                    c.avg_marks_pct !== null && c.avg_marks_pct >= 50 ? 'bg-yellow-400' : 'bg-red-400'
                  } />

                  {/* Attendance */}
                  <div className="hidden sm:block">
                    <MetricCell value={c.attendance_pct} barColor={
                      c.attendance_pct !== null && c.attendance_pct >= 75 ? 'bg-teal-500' :
                      c.attendance_pct !== null && c.attendance_pct >= 60 ? 'bg-yellow-400' : 'bg-red-400'
                    } />
                  </div>

                  {/* Homework completion */}
                  <div className="hidden md:block">
                    <MetricCell value={c.homework_completion} barColor="bg-blue-400" />
                  </div>

                  {/* Tests conducted */}
                  <span className="text-sm text-gray-700 text-right font-medium hidden md:block">
                    {c.tests_conducted}
                  </span>

                  {/* Student count */}
                  <span className="text-sm text-gray-500 text-right">
                    {c.student_count}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Legend */}
        {!loading && classes.length > 0 && (
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex flex-wrap gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />≥ 75% — Good</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400" />50–75% — Moderate</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" />{'<'} 50% — Needs Attention</span>
            <span className="ml-auto text-gray-400">— = no data this month</span>
          </div>
        )}
      </div>
    </>
  );
}

export default function AdminClassComparisonPage() {
  return (
    <Suspense>
      <ClassComparisonPageInner />
    </Suspense>
  );
}
