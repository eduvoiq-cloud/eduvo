'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Activity {
  instruction: string;
  type: 'verbal' | 'written' | 'physical';
}

interface ActivityPack {
  id: string;
  class: string;
  section: string;
  subject: string;
  topic: string;
  activity_date: string;
  created_at: string;
  activities?: Activity[];
  users: { id: string; name: string } | null;
}

interface AdminStats {
  packs_created_today: number;
  class_completion: Record<string, { total: number; completed: number }>;
  inactive_teachers: Array<{ teacher_id: string; teacher_name: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classNum(className: string): number {
  const n = parseInt(className.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const TYPE_BADGE: Record<string, string> = {
  verbal:   'bg-blue-100 text-blue-700',
  written:  'bg-purple-100 text-purple-700',
  physical: 'bg-green-100 text-green-700',
};

const TYPE_ICON: Record<string, string> = {
  verbal: '💬', written: '✏️', physical: '🤸',
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Date', 'Teacher', 'Class', 'Section', 'Subject', 'Topic', 'Activities'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                {Array.from({ length: 7 }).map((__, j) => (
                  <td key={j} className="px-4 py-3">
                    <div className="h-4 bg-gray-200 rounded w-full" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AdminActivityPacksPage() {
  const { user } = useAuth();

  const [packs, setPacks] = useState<ActivityPack[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterDate, setFilterDate] = useState('');

  // Expanded row
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // ── Load data ───────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterClass) params.set('class', filterClass);
      if (filterSection) params.set('section', filterSection);
      if (filterDate) params.set('date', filterDate);

      const [packsRes, statsRes] = await Promise.all([
        fetch(`${BASE_URL}/api/activity-packs/school?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${BASE_URL}/api/activity-packs/admin/stats`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      const packsJson = await packsRes.json();
      if (!packsRes.ok) throw new Error(packsJson.message ?? 'Failed to load packs');
      setPacks(packsJson.data ?? []);

      if (statsRes.ok) {
        const statsJson = await statsRes.json();
        setStats(statsJson.data ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterSection, filterDate]);

  useEffect(() => { load(); }, [load]);

  function showToast(msg: string, type: 'success' | 'error') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  // ── Derived data ────────────────────────────────────────────────────────────

  const classes = useMemo(
    () => [...new Set(packs.map((p) => p.class))].sort((a, b) => classNum(a) - classNum(b)),
    [packs]
  );

  const sections = useMemo(() => {
    const base = filterClass ? packs.filter((p) => p.class === filterClass) : packs;
    return [...new Set(base.map((p) => p.section).filter(Boolean))].sort();
  }, [packs, filterClass]);

  const filtered = useMemo(() => {
    let data = packs;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      data = data.filter((p) =>
        p.topic.toLowerCase().includes(q) ||
        p.subject.toLowerCase().includes(q) ||
        (p.users?.name ?? '').toLowerCase().includes(q)
      );
    }
    return data;
  }, [packs, search]);

  // ── Stats summary cards ─────────────────────────────────────────────────────

  const totalCompletions = stats
    ? Object.values(stats.class_completion).reduce((sum, v) => sum + v.completed, 0)
    : 0;
  const totalAssigned = stats
    ? Object.values(stats.class_completion).reduce((sum, v) => sum + v.total, 0)
    : 0;
  const completionPct = totalAssigned > 0
    ? Math.round((totalCompletions / totalAssigned) * 100)
    : 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity Packs"
        description="View all AI-generated home activity packs sent to parents."
      />

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white transition-all ${
            toast.type === 'success' ? 'bg-emerald-600' : 'bg-red-600'
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Packs Today', value: stats?.packs_created_today ?? '—', color: 'text-blue-600' },
          { label: 'Completed Today', value: totalAssigned > 0 ? `${completionPct}%` : '—', color: 'text-emerald-600' },
          {
            label: 'Total Packs',
            value: loading ? '—' : packs.length,
            color: 'text-gray-900',
          },
          {
            label: 'Inactive Teachers',
            value: stats?.inactive_teachers.length ?? '—',
            color: 'text-orange-500',
          },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 px-5 py-4">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{loading ? '—' : value}</p>
          </div>
        ))}
      </div>

      {/* Class completion breakdown */}
      {stats && Object.keys(stats.class_completion).length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Today&apos;s Completion by Class</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {Object.entries(stats.class_completion).map(([key, val]) => {
              const pct = val.total > 0 ? Math.round((val.completed / val.total) * 100) : 0;
              return (
                <div key={key} className="border border-gray-100 rounded-lg p-3">
                  <p className="text-xs font-semibold text-gray-700 mb-1">Class {key}</p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs font-medium text-gray-600 shrink-0">{pct}%</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">{val.completed}/{val.total} done</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Inactive teachers alert */}
      {stats && stats.inactive_teachers.length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
          <p className="text-sm font-medium text-orange-800 mb-1">
            ⚠️ {stats.inactive_teachers.length} teacher{stats.inactive_teachers.length !== 1 ? 's' : ''} haven&apos;t sent activity packs in 3+ days
          </p>
          <p className="text-xs text-orange-600">
            {stats.inactive_teachers.map((t) => t.teacher_name).join(', ')}
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search topic, subject, teacher…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
        />
        <select
          value={filterClass}
          onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); }}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Classes</option>
          {classes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={filterSection}
          onChange={(e) => setFilterSection(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={sections.length === 0}
        >
          <option value="">All Sections</option>
          {sections.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          type="date"
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {(search || filterClass || filterSection || filterDate) && (
          <button
            onClick={() => { setSearch(''); setFilterClass(''); setFilterSection(''); setFilterDate(''); }}
            className="text-sm text-gray-500 hover:text-gray-800 underline"
          >
            Clear filters
          </button>
        )}
        <span className="text-sm text-gray-500 ml-auto">
          {filtered.length} pack{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          {error} —{' '}
          <button onClick={load} className="underline">retry</button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <TableSkeleton />
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 px-6 py-12 text-center text-sm text-gray-500">
          {packs.length === 0 ? 'No activity packs have been created yet.' : 'No packs match the current filters.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Date', 'Teacher', 'Class', 'Section', 'Subject', 'Topic', 'Activities'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((pack) => (
                  <>
                    <tr
                      key={pack.id}
                      className="hover:bg-gray-50 transition-colors cursor-pointer"
                      onClick={() => setExpandedId(expandedId === pack.id ? null : pack.id)}
                    >
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {formatDate(pack.activity_date)}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {pack.users?.name ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{pack.class}</td>
                      <td className="px-4 py-3 text-gray-600">{pack.section}</td>
                      <td className="px-4 py-3 text-gray-700">{pack.subject}</td>
                      <td className="px-4 py-3 text-gray-800 max-w-xs truncate">{pack.topic}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                          {Array.isArray(pack.activities) ? pack.activities.length : '—'} activities
                          <svg
                            className={`w-3.5 h-3.5 transition-transform ${expandedId === pack.id ? 'rotate-180' : ''}`}
                            fill="none" stroke="currentColor" viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </span>
                      </td>
                    </tr>

                    {expandedId === pack.id && Array.isArray(pack.activities) && (
                      <tr key={`${pack.id}-expanded`}>
                        <td colSpan={7} className="px-6 py-4 bg-gray-50 border-t border-gray-100">
                          <div className="space-y-2">
                            <p className="text-xs font-semibold text-gray-600 mb-3">Activities sent to parents:</p>
                            {pack.activities.map((a, i) => (
                              <div key={i} className="flex items-start gap-3 text-sm">
                                <span className="shrink-0 text-gray-400 font-mono text-xs mt-0.5">{i + 1}.</span>
                                <span
                                  className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_BADGE[a.type] ?? 'bg-gray-100 text-gray-600'}`}
                                >
                                  {TYPE_ICON[a.type]} {a.type}
                                </span>
                                <span className="text-gray-700 leading-relaxed">{a.instruction}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
