'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { adminApi, premiumApi, type AdminStudent, type ParentSubscription } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentRow {
  id: string;
  full_name: string;
  class_name: string;
  section: string;
  // premium state
  premium_status: 'active' | 'inactive' | 'none';
  activated_at: string | null;
  expires_at: string | null;
  activated_by_admin_id: string | null;
  subscription_id: string | null;
  // optimistic toggle tracking
  toggling: boolean;
  renewing: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classNum(className: string): number {
  const n = parseInt(className.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function planBadge(className: string): 'Junior (1–6)' | 'Senior (7–12)' {
  return classNum(className) >= 7 ? 'Senior (7–12)' : 'Junior (1–6)';
}

// ── Toggle switch component ───────────────────────────────────────────────────

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      } ${checked ? 'bg-emerald-500' : 'bg-gray-200'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['', 'Name', 'Class', 'Section', 'Plan', 'Premium', 'Activated On', 'Expires On', 'Activated By', 'Actions'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                <td className="px-4 py-3"><div className="w-4 h-4 bg-gray-200 rounded" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-32" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-12" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-8" /></td>
                <td className="px-4 py-3"><div className="h-5 bg-gray-200 rounded-full w-20" /></td>
                <td className="px-4 py-3"><div className="w-11 h-6 bg-gray-200 rounded-full" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-24" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-24" /></td>
                <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-20" /></td>
                <td className="px-4 py-3"><div className="h-6 bg-gray-200 rounded w-24" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PremiumManagementPage() {
  const { user } = useAuth();

  const [rows, setRows] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // ── Load data ───────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      // Fetch all students (paginated, max 200/page) + all subscriptions in parallel
      const PAGE = 200;
      const firstStudentRes = await adminApi.listStudents(token, { limit: PAGE, page: 1 });
      const firstStudents = firstStudentRes.data as AdminStudent[];

      // Determine total pages from the response header-style data
      // adminApi.listStudents returns AdminStudent[] (no envelope) — fetch by pages
      // Backend caps at 200, so fetch subsequent pages if needed
      let allStudents: AdminStudent[] = [...firstStudents];
      if (firstStudents.length === PAGE) {
        // There might be more — fetch subsequent pages
        let page = 2;
        while (true) {
          const res = await adminApi.listStudents(token, { limit: PAGE, page });
          const batch = res.data as AdminStudent[];
          allStudents = allStudents.concat(batch);
          if (batch.length < PAGE) break;
          page++;
        }
      }

      // Fetch all subscriptions (also paginated)
      const firstSubsRes = await premiumApi.listSubscriptions(token, { limit: 200, page: 1 });
      let allSubs: ParentSubscription[] = [...firstSubsRes.data.data];
      const totalSubPages = firstSubsRes.data.total_pages;
      if (totalSubPages > 1) {
        const extraPages = await Promise.all(
          Array.from({ length: totalSubPages - 1 }, (_, i) =>
            premiumApi.listSubscriptions(token, { limit: 200, page: i + 2 })
          )
        );
        for (const r of extraPages) allSubs = allSubs.concat(r.data.data);
      }

      // Build subscription lookup by student_id
      const subMap: Record<string, ParentSubscription> = {};
      for (const s of allSubs) {
        subMap[s.student_id] = s;
      }

      const merged: StudentRow[] = allStudents.map((st) => {
        const sub = subMap[st.id];
        return {
          id: st.id,
          full_name: st.full_name,
          class_name: st.class_name,
          section: st.section ?? '',
          premium_status: sub ? sub.status : 'none',
          activated_at: sub?.activated_at ?? null,
          expires_at: sub?.expires_at ?? null,
          activated_by_admin_id: sub?.activated_by_admin_id ?? null,
          subscription_id: sub?.id ?? null,
          toggling: false,
          renewing: false,
        };
      });

      setRows(merged);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Toast helper ────────────────────────────────────────────────────────────

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ── Toggle single student ───────────────────────────────────────────────────

  const handleToggle = useCallback(async (studentId: string, currentStatus: string) => {
    const token = getToken();
    if (!token) return;

    setRows((prev) =>
      prev.map((r) => (r.id === studentId ? { ...r, toggling: true } : r))
    );

    try {
      if (currentStatus === 'active') {
        await premiumApi.deactivate(token, studentId);
        setRows((prev) =>
          prev.map((r) =>
            r.id === studentId
              ? { ...r, premium_status: 'inactive', expires_at: null, toggling: false }
              : r
          )
        );
        showToast('Premium deactivated', 'success');
      } else {
        const res = await premiumApi.activate(token, studentId);
        const sub = res.data;
        setRows((prev) =>
          prev.map((r) =>
            r.id === studentId
              ? {
                  ...r,
                  premium_status: 'active',
                  activated_at: sub.activated_at,
                  expires_at: sub.expires_at ?? null,
                  activated_by_admin_id: sub.activated_by_admin_id,
                  subscription_id: sub.id,
                  toggling: false,
                }
              : r
          )
        );
        showToast('Premium activated', 'success');
      }
    } catch (e) {
      setRows((prev) =>
        prev.map((r) => (r.id === studentId ? { ...r, toggling: false } : r))
      );
      showToast(e instanceof Error ? e.message : 'Failed to update', 'error');
    }
  }, []);

  // ── Renew single student ────────────────────────────────────────────────────

  const handleRenew = useCallback(async (studentId: string) => {
    const token = getToken();
    if (!token) return;

    setRows((prev) =>
      prev.map((r) => (r.id === studentId ? { ...r, renewing: true } : r))
    );

    try {
      const res = await premiumApi.renew(token, studentId);
      const sub = res.data;
      setRows((prev) =>
        prev.map((r) =>
          r.id === studentId
            ? {
                ...r,
                premium_status: 'active',
                expires_at: sub.expires_at ?? null,
                renewing: false,
              }
            : r
        )
      );
      showToast('Renewed by 1 month', 'success');
    } catch (e) {
      setRows((prev) =>
        prev.map((r) => (r.id === studentId ? { ...r, renewing: false } : r))
      );
      showToast(e instanceof Error ? e.message : 'Failed to renew', 'error');
    }
  }, []);

  // ── Bulk actions ────────────────────────────────────────────────────────────

  const handleBulk = async (action: 'activate' | 'deactivate' | 'renew') => {
    const token = getToken();
    if (!token || selected.size === 0) return;
    setBulkLoading(true);

    const ids = Array.from(selected);
    let successCount = 0;
    let failCount = 0;

    for (const id of ids) {
      try {
        if (action === 'activate') {
          const res = await premiumApi.activate(token, id);
          const sub = res.data;
          setRows((prev) =>
            prev.map((r) =>
              r.id === id
                ? {
                    ...r,
                    premium_status: 'active',
                    activated_at: sub.activated_at,
                    expires_at: sub.expires_at ?? null,
                    activated_by_admin_id: sub.activated_by_admin_id,
                    subscription_id: sub.id,
                  }
                : r
            )
          );
        } else if (action === 'renew') {
          const res = await premiumApi.renew(token, id);
          const sub = res.data;
          setRows((prev) =>
            prev.map((r) =>
              r.id === id
                ? {
                    ...r,
                    premium_status: 'active',
                    expires_at: sub.expires_at ?? null,
                  }
                : r
            )
          );
        } else {
          await premiumApi.deactivate(token, id);
          setRows((prev) =>
            prev.map((r) =>
              r.id === id ? { ...r, premium_status: 'inactive', expires_at: null } : r
            )
          );
        }
        successCount++;
      } catch {
        failCount++;
      }
    }

    setBulkLoading(false);
    setSelected(new Set());
    const actionLabel = action === 'activate' ? 'Activated' : action === 'renew' ? 'Renewed' : 'Deactivated';
    if (failCount === 0) {
      showToast(`${actionLabel} ${successCount} student(s)`, 'success');
    } else {
      showToast(`Done: ${successCount} succeeded, ${failCount} failed`, 'error');
    }
  };

  // ── Derived data ────────────────────────────────────────────────────────────

  const classes = useMemo(
    () => [...new Set(rows.map((r) => r.class_name))].sort((a, b) => classNum(a) - classNum(b)),
    [rows]
  );

  const sections = useMemo(() => {
    const base = filterClass ? rows.filter((r) => r.class_name === filterClass) : rows;
    return [...new Set(base.map((r) => r.section).filter(Boolean))].sort();
  }, [rows, filterClass]);

  const filtered = useMemo(() => {
    let data = rows;
    if (filterClass) data = data.filter((r) => r.class_name === filterClass);
    if (filterSection) data = data.filter((r) => r.section === filterSection);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      data = data.filter((r) => r.full_name.toLowerCase().includes(q));
    }
    return data;
  }, [rows, filterClass, filterSection, search]);

  const stats = useMemo(() => {
    const total = rows.length;
    const active = rows.filter((r) => r.premium_status === 'active').length;
    const junior = rows.filter(
      (r) => r.premium_status === 'active' && classNum(r.class_name) <= 6
    ).length;
    const senior = rows.filter(
      (r) => r.premium_status === 'active' && classNum(r.class_name) >= 7
    ).length;
    return { total, active, junior, senior };
  }, [rows]);

  // Selection helpers
  const allFilteredIds = filtered.map((r) => r.id);
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        allFilteredIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        allFilteredIds.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Premium Management"
        description="Manually activate or deactivate parent premium subscriptions for students."
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
          { label: 'Total Students', value: stats.total, color: 'text-gray-900' },
          { label: 'Premium Active', value: stats.active, color: 'text-emerald-600' },
          { label: 'Junior (1–6)', value: stats.junior, color: 'text-blue-600' },
          { label: 'Senior (7–12)', value: stats.senior, color: 'text-purple-600' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 px-5 py-4">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{loading ? '—' : value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-52"
        />
        <select
          value={filterClass}
          onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); }}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Classes</option>
          {classes.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={filterSection}
          onChange={(e) => setFilterSection(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={sections.length === 0}
        >
          <option value="">All Sections</option>
          {sections.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
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

      {/* Bulk action bar */}
      {someSelected && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
          <span className="text-sm font-medium text-blue-700">
            {selected.size} student{selected.size !== 1 ? 's' : ''} selected
          </span>
          <button
            disabled={bulkLoading}
            onClick={() => handleBulk('activate')}
            className="px-4 py-1.5 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            {bulkLoading ? 'Processing…' : 'Activate Selected'}
          </button>
          <button
            disabled={bulkLoading}
            onClick={() => handleBulk('renew')}
            className="px-4 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {bulkLoading ? 'Processing…' : 'Renew Selected'}
          </button>
          <button
            disabled={bulkLoading}
            onClick={() => handleBulk('deactivate')}
            className="px-4 py-1.5 text-sm font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors"
          >
            {bulkLoading ? 'Processing…' : 'Deactivate Selected'}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-sm text-blue-600 hover:text-blue-800"
          >
            Clear
          </button>
        </div>
      )}

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
          {rows.length === 0 ? 'No students found in this school.' : 'No students match the current filters.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Class</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Section</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Plan</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Premium</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Activated On</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Expires On</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Activated By</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((row) => (
                  <tr
                    key={row.id}
                    className={`hover:bg-gray-50 transition-colors ${selected.has(row.id) ? 'bg-blue-50/50' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleSelect(row.id)}
                        aria-label={`Select ${row.full_name}`}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{row.full_name}</td>
                    <td className="px-4 py-3 text-gray-600">{row.class_name}</td>
                    <td className="px-4 py-3 text-gray-600">{row.section || '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          classNum(row.class_name) >= 7
                            ? 'bg-purple-50 text-purple-700'
                            : 'bg-blue-50 text-blue-700'
                        }`}
                      >
                        {planBadge(row.class_name)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {row.toggling ? (
                        <div className="w-11 h-6 flex items-center justify-center">
                          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                      ) : (
                        <Toggle
                          checked={row.premium_status === 'active'}
                          disabled={false}
                          onChange={() => handleToggle(row.id, row.premium_status)}
                          label={`Toggle premium for ${row.full_name}`}
                        />
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {row.premium_status === 'active' ? formatDate(row.activated_at) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {row.premium_status === 'active' ? formatDate(row.expires_at) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {row.premium_status === 'active' && row.activated_by_admin_id
                        ? user?.id === row.activated_by_admin_id
                          ? 'You'
                          : 'Admin'
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {row.premium_status === 'active' && (
                        row.renewing ? (
                          <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <button
                            onClick={() => handleRenew(row.id)}
                            className="px-3 py-1 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap"
                            title="Extend subscription by 1 month"
                          >
                            Renew 1 Month
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
