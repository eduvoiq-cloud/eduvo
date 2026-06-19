'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useAuth } from '@/context/AuthContext';
import { atRiskApi, type AtRiskStudent, type AtRiskResponse } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Filter tab type ───────────────────────────────────────────────────────────

type RiskFilter = 'all' | 3 | 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

function RiskBadge({ score }: { score: number }) {
  if (score === 3) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        High Risk
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
      <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
      Medium Risk
    </span>
  );
}

function FlagDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
        active ? 'bg-red-500' : 'bg-gray-200'
      }`}
    />
  );
}

function TableSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-5 py-4 border-b border-gray-50"
        >
          <div className="h-4 bg-gray-200 rounded flex-1" />
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-200 rounded w-20" />
          <div className="h-6 bg-gray-200 rounded-full w-24" />
        </div>
      ))}
    </div>
  );
}

// ── Inner page ────────────────────────────────────────────────────────────────

function AtRiskPageInner() {
  const { user } = useAuth();
  void user;

  const [data, setData] = useState<AtRiskResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RiskFilter>('all');

  const fetchData = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await atRiskApi.get(token);
      setData(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load at-risk data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Derived stats
  const allStudents: AtRiskStudent[] = data?.students ?? [];
  const highRisk   = allStudents.filter((s) => s.risk_score === 3);
  const medRisk    = allStudents.filter((s) => s.risk_score === 2);

  const filtered =
    filter === 3 ? highRisk :
    filter === 2 ? medRisk  :
    allStudents;

  return (
    <>
      <PageHeader
        title="At-Risk Students"
        description="Students flagged across attendance, marks, and fees"
        action={
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-colors disabled:opacity-40"
            aria-label="Refresh"
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
          <button onClick={fetchData} className="ml-auto text-red-600 underline text-sm font-medium">Retry</button>
        </div>
      )}

      {/* Summary stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {/* Total at-risk */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500 font-medium">Total At-Risk</p>
          <p className="mt-1 text-2xl font-semibold text-red-600">
            {loading ? '—' : (data?.total_at_risk ?? 0)}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">2+ risk flags</p>
        </div>

        {/* High risk */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500 font-medium">High Risk</p>
          <p className="mt-1 text-2xl font-semibold text-red-700">
            {loading ? '—' : highRisk.length}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">All 3 flags triggered</p>
        </div>

        {/* Medium risk */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm text-gray-500 font-medium">Medium Risk</p>
          <p className="mt-1 text-2xl font-semibold text-orange-600">
            {loading ? '—' : medRisk.length}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">2 of 3 flags triggered</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-5">
        {([
          { key: 'all', label: `All (${allStudents.length})` },
          { key: 3,     label: `3 Flags (${highRisk.length})` },
          { key: 2,     label: `2 Flags (${medRisk.length})` },
        ] as const).map(({ key, label }) => (
          <button
            key={String(key)}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
              filter === key
                ? 'bg-blue-600 text-white border-blue-600'
                : 'text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 items-center px-5 py-3 bg-gray-50 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
          <span>Student</span>
          <span className="text-right">Attendance %</span>
          <span className="text-right">Avg Marks %</span>
          <span className="text-right hidden sm:block">Fee Status</span>
          <span className="text-right">Risk</span>
        </div>

        {loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-3xl mb-2">✅</p>
            <p className="text-sm text-gray-400">No at-risk students found</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map((s) => (
              <div
                key={s.student_id}
                className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 items-center px-5 py-3 hover:bg-gray-50 transition-colors"
              >
                {/* Student name + class */}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{s.full_name}</p>
                  <p className="text-xs text-gray-400">{s.class_name} · {s.section}</p>
                </div>

                {/* Attendance % with flag dot */}
                <div className="flex items-center gap-1.5 justify-end">
                  <FlagDot active={s.low_attendance} />
                  <span className={`text-sm font-medium ${s.low_attendance ? 'text-red-600' : 'text-gray-700'}`}>
                    {s.attendance_pct.toFixed(1)}%
                  </span>
                </div>

                {/* Marks % with flag dot */}
                <div className="flex items-center gap-1.5 justify-end">
                  <FlagDot active={s.low_marks} />
                  <span className={`text-sm font-medium ${s.low_marks ? 'text-red-600' : 'text-gray-700'}`}>
                    {s.avg_marks_pct.toFixed(1)}%
                  </span>
                </div>

                {/* Fee status with flag dot */}
                <div className="hidden sm:flex items-center gap-1.5 justify-end">
                  <FlagDot active={s.fee_unpaid} />
                  <span className={`text-sm font-medium capitalize ${s.fee_unpaid ? 'text-red-600' : 'text-gray-700'}`}>
                    {s.fee_status}
                  </span>
                </div>

                {/* Risk badge */}
                <div className="flex justify-end">
                  <RiskBadge score={s.risk_score} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Legend footer */}
        {!loading && filtered.length > 0 && (
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex flex-wrap gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Flag triggered
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-gray-200" /> Flag clear
            </span>
          </div>
        )}
      </div>
    </>
  );
}

// ── Export with Suspense wrapper ──────────────────────────────────────────────

export default function AdminAtRiskPage() {
  return (
    <Suspense>
      <AtRiskPageInner />
    </Suspense>
  );
}
