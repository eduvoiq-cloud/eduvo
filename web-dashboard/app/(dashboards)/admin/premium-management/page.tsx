'use client';

/**
 * /admin/premium-management
 *
 * Admin view — read-only summary.
 * Shows how many students are activated vs not activated, with names and days left.
 * Activation/deactivation/renewal is handled by class teachers on their own page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { premiumApi } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentSummaryRow {
  id: string;
  full_name: string;
  class_name: string;
  section: string;
  is_activated: boolean;
  activated_at: string | null;
  expires_at: string | null;
  days_left: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classNum(cn: string): number {
  const n = parseInt(cn.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso))
    ? new Date(iso + 'Z') : new Date(iso);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function daysLeftColor(days: number | null): string {
  if (days === null) return 'text-gray-400';
  if (days <= 5)  return 'text-red-600 font-bold';
  if (days <= 15) return 'text-amber-600 font-semibold';
  return 'text-emerald-600';
}

function daysLeftLabel(days: number | null): string {
  if (days === null) return '—';
  if (days === 0)    return 'Expires today';
  if (days < 0)     return 'Expired';
  return `${days}d left`;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Name', 'Class', 'Section', 'Status', 'Activated On', 'Expires On', 'Days Left'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                {Array.from({ length: 7 }).map((_, j) => (
                  <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-full" /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function PremiumManagementPage() {
  const [summary, setSummary] = useState<{
    total: number;
    activated: number;
    not_activated: number;
    students: StudentSummaryRow[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Filters
  const [search, setSearch]               = useState('');
  const [filterClass, setFilterClass]     = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterTab, setFilterTab]         = useState<'all' | 'activated' | 'not_activated'>('all');

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await premiumApi.getStudentSummary(token);
      setSummary(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Derived data ────────────────────────────────────────────────────────────

  const students = useMemo(() => summary?.students ?? [], [summary]);

  const classes = useMemo(
    () => [...new Set(students.map((r) => r.class_name))].sort((a, b) => classNum(a) - classNum(b)),
    [students]
  );

  const sections = useMemo(() => {
    const base = filterClass ? students.filter((r) => r.class_name === filterClass) : students;
    return [...new Set(base.map((r) => r.section).filter(Boolean))].sort();
  }, [students, filterClass]);

  const filtered = useMemo(() => {
    let data = students;
    if (filterTab === 'activated')     data = data.filter((r) => r.is_activated);
    if (filterTab === 'not_activated') data = data.filter((r) => !r.is_activated);
    if (filterClass)   data = data.filter((r) => r.class_name === filterClass);
    if (filterSection) data = data.filter((r) => r.section === filterSection);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      data = data.filter((r) => r.full_name.toLowerCase().includes(q));
    }
    return data;
  }, [students, filterTab, filterClass, filterSection, search]);

  const expiringSoon = useMemo(
    () => students.filter((r) => r.is_activated && r.days_left !== null && r.days_left <= 5).length,
    [students]
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Premium Management"
        description="Overview of student subscription status. Activation is managed by class teachers."
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Students',  value: summary?.total ?? 0,         color: 'text-gray-900' },
          { label: 'Activated',       value: summary?.activated ?? 0,     color: 'text-emerald-600' },
          { label: 'Not Activated',   value: summary?.not_activated ?? 0, color: 'text-gray-500' },
          { label: 'Expiring ≤ 5d',  value: expiringSoon,                 color: 'text-red-600' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 px-5 py-4">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{loading ? '—' : value}</p>
          </div>
        ))}
      </div>

      {/* Info note */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 text-sm text-blue-800 flex items-start gap-3">
        <span className="text-lg shrink-0">ℹ️</span>
        <span>
          Activation and renewal are handled by <strong>class teachers</strong> from their Premium Management page.
          This page shows a read-only overview for your records.
        </span>
      </div>

      {/* Tab filter */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {(['all', 'activated', 'not_activated'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilterTab(tab)}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              filterTab === tab
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'all' ? 'All' : tab === 'activated' ? '✅ Activated' : '⬜ Not Activated'}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
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
        {(search || filterClass || filterSection) && (
          <button
            onClick={() => { setSearch(''); setFilterClass(''); setFilterSection(''); }}
            className="text-sm text-gray-500 hover:text-gray-800 underline"
          >
            Clear filters
          </button>
        )}
        <span className="text-sm text-gray-500 ml-auto">
          {filtered.length} student{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          {error} — <button onClick={load} className="underline">retry</button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <TableSkeleton />
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 px-6 py-12 text-center text-sm text-gray-500">
          {students.length === 0 ? 'No students found.' : 'No students match the current filters.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Name', 'Class', 'Section', 'Status', 'Activated On', 'Expires On', 'Days Left'].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((row) => {
                  const isExpiringSoon = row.is_activated && row.days_left !== null && row.days_left <= 5;
                  return (
                    <tr
                      key={row.id}
                      className={`hover:bg-gray-50 transition-colors ${isExpiringSoon ? 'bg-red-50/30' : ''}`}
                    >
                      {/* Name */}
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                        {row.full_name}
                        {isExpiringSoon && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                            ⚠ Expiring
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{row.class_name}</td>
                      <td className="px-4 py-3 text-gray-600">{row.section || '—'}</td>
                      {/* Status badge */}
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            row.is_activated
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {row.is_activated ? '✅ Activated' : '⬜ Not Activated'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {formatDate(row.activated_at)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {formatDate(row.expires_at)}
                      </td>
                      <td className={`px-4 py-3 text-xs whitespace-nowrap ${daysLeftColor(row.is_activated ? row.days_left : null)}`}>
                        {row.is_activated ? daysLeftLabel(row.days_left) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
