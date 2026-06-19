'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useAuth } from '@/context/AuthContext';
import { teacherActivityApi, type TeacherActivityRow } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseUtcDate(iso: string): Date {
  if (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + 'Z');
  }
  return new Date(iso);
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - parseUtcDate(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function activityLevel(row: TeacherActivityRow): 'high' | 'medium' | 'low' | 'inactive' {
  const total = row.tests_created + row.marks_entered + row.homework_assigned;
  if (!row.last_active_at) return 'inactive';
  const daysSince = (Date.now() - parseUtcDate(row.last_active_at).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 14 || total === 0) return 'inactive';
  if (total >= 20 || daysSince <= 3) return 'high';
  if (total >= 5) return 'medium';
  return 'low';
}

const LEVEL_STYLES = {
  high:     { badge: 'bg-green-100 text-green-700',  dot: 'bg-green-500',  label: 'Active'   },
  medium:   { badge: 'bg-blue-100 text-blue-700',    dot: 'bg-blue-400',   label: 'Moderate' },
  low:      { badge: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400', label: 'Low'      },
  inactive: { badge: 'bg-gray-100 text-gray-500',    dot: 'bg-gray-300',   label: 'Inactive' },
};

// ── Metric bar ────────────────────────────────────────────────────────────────

function MetricBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-sm font-medium text-gray-800 w-6 text-right shrink-0">{value}</span>
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-4 items-center px-5 py-4 animate-pulse border-b border-gray-50">
      <div className="space-y-1.5">
        <div className="h-3.5 bg-gray-200 rounded w-36" />
        <div className="h-3 bg-gray-200 rounded w-44" />
      </div>
      <div className="h-4 bg-gray-200 rounded w-16" />
      <div className="h-4 bg-gray-200 rounded w-16" />
      <div className="h-4 bg-gray-200 rounded w-16" />
      <div className="h-4 bg-gray-200 rounded w-20" />
      <div className="h-5 bg-gray-200 rounded-full w-16" />
    </div>
  );
}

// ── Inner page ────────────────────────────────────────────────────────────────

const DAY_OPTIONS = [7, 14, 30, 60, 90];

function TeacherActivityPageInner() {
  const { user } = useAuth();
  void user;

  const [teachers, setTeachers] = useState<TeacherActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [filterLevel, setFilterLevel] = useState('');

  const fetchData = useCallback(async (d: number) => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await teacherActivityApi.get(token, d);
      setTeachers(res.data.teachers ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load teacher activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(days); }, [days, fetchData]);

  // Compute max values for bar scaling
  const maxTests = Math.max(1, ...teachers.map((t) => t.tests_created));
  const maxMarks = Math.max(1, ...teachers.map((t) => t.marks_entered));
  const maxHw    = Math.max(1, ...teachers.map((t) => t.homework_assigned));

  // Summary counts
  const counts = {
    high:     teachers.filter((t) => activityLevel(t) === 'high').length,
    medium:   teachers.filter((t) => activityLevel(t) === 'medium').length,
    low:      teachers.filter((t) => activityLevel(t) === 'low').length,
    inactive: teachers.filter((t) => activityLevel(t) === 'inactive').length,
  };

  const displayed = filterLevel
    ? teachers.filter((t) => activityLevel(t) === filterLevel)
    : teachers;

  return (
    <>
      <PageHeader
        title="Teacher Activity Report"
        description="See how actively each teacher has been using the platform"
        action={
          <div className="flex items-center gap-2">
            <label htmlFor="days-select" className="text-sm text-gray-500 font-medium whitespace-nowrap">Last</label>
            <select
              id="days-select"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Select time window"
            >
              {DAY_OPTIONS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
            <button
              onClick={() => fetchData(days)}
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
          <button onClick={() => fetchData(days)} className="ml-auto text-red-600 underline text-sm font-medium">Retry</button>
        </div>
      )}

      {/* ── Summary cards ──────────────────────────────────────────────────── */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          {(['high', 'medium', 'low', 'inactive'] as const).map((level) => {
            const s = LEVEL_STYLES[level];
            return (
              <button
                key={level}
                onClick={() => setFilterLevel(filterLevel === level ? '' : level)}
                className={`bg-white rounded-xl border p-4 text-left transition-all ${
                  filterLevel === level ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                  <span className="text-xs font-medium text-gray-500">{s.label}</span>
                </div>
                <p className="text-2xl font-semibold text-gray-900">{counts[level]}</p>
                <p className="text-xs text-gray-400 mt-0.5">teacher{counts[level] !== 1 ? 's' : ''}</p>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Column headers */}
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-4 items-center px-5 py-3 bg-gray-50 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
          <span>Teacher</span>
          <span className="text-right w-20">Tests</span>
          <span className="text-right w-20 hidden sm:block">Marks</span>
          <span className="text-right w-20 hidden sm:block">Homework</span>
          <span className="text-right hidden md:block">Last Active</span>
          <span className="text-right">Activity</span>
        </div>

        {loading ? (
          <>
            {[...Array(5)].map((_, i) => <RowSkeleton key={i} />)}
          </>
        ) : displayed.length === 0 ? (
          <div className="px-5 py-16 text-center text-sm text-gray-400">
            {filterLevel ? 'No teachers in this category.' : 'No teachers found.'}
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {displayed.map((t) => {
              const level = activityLevel(t);
              const s = LEVEL_STYLES[level];
              return (
                <div
                  key={t.teacher_id}
                  className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-4 items-center px-5 py-4"
                >
                  {/* Teacher name + email */}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{t.name}</p>
                    <p className="text-xs text-gray-400 truncate">{t.email}</p>
                  </div>

                  {/* Tests created */}
                  <div className="w-20">
                    <MetricBar value={t.tests_created} max={maxTests} color="bg-indigo-400" />
                  </div>

                  {/* Marks entered */}
                  <div className="w-20 hidden sm:block">
                    <MetricBar value={t.marks_entered} max={maxMarks} color="bg-blue-400" />
                  </div>

                  {/* Homework assigned */}
                  <div className="w-20 hidden sm:block">
                    <MetricBar value={t.homework_assigned} max={maxHw} color="bg-teal-400" />
                  </div>

                  {/* Last active */}
                  <span className="text-xs text-gray-400 text-right whitespace-nowrap hidden md:block">
                    {timeAgo(t.last_active_at)}
                  </span>

                  {/* Activity badge */}
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${s.badge}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Legend footer */}
        {!loading && displayed.length > 0 && (
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex flex-wrap gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-indigo-400" />Tests created</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-400" />Marks entered</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-teal-400" />Homework assigned</span>
            <span className="ml-auto">Window: last {days} days</span>
          </div>
        )}
      </div>
    </>
  );
}

export default function AdminTeacherActivityPage() {
  return (
    <Suspense>
      <TeacherActivityPageInner />
    </Suspense>
  );
}
