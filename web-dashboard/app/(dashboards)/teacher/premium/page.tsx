'use client';

/**
 * /teacher/premium
 *
 * Teacher-facing premium subscription management.
 * Teachers can activate, deactivate, and renew premium for students
 * in their assigned classes only.
 *
 * Features:
 * - Days remaining column (red when ≤ 5 days)
 * - "Send Renewal Reminder" button → SMS + push notification to parents
 * - Activate / deactivate toggle per student
 * - Renew 1 month per active student
 * - Deactivate a wrongly-activated student (correction)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { teacherPremiumApi, type TeacherPremiumStudent } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentRow extends TeacherPremiumStudent {
  toggling: boolean;
  renewing: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classNum(cn: string): number {
  const n = parseInt(cn.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function planBadge(className: string): string {
  return classNum(className) >= 7 ? 'Senior (7–12)' : 'Junior (1–6)';
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

// ── Toggle switch ─────────────────────────────────────────────────────────────

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
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
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
              {['Name', 'Class', 'Section', 'Plan', 'Premium', 'Activated On', 'Expires On', 'Days Left', 'Actions'].map(
                (h) => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                {Array.from({ length: 9 }).map((_, j) => (
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

// ── Main ──────────────────────────────────────────────────────────────────────

export default function TeacherPremiumPage() {
  const { user } = useAuth();

  const [rows, setRows]         = useState<StudentRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  // Filters
  const [search, setSearch]             = useState('');
  const [filterClass, setFilterClass]   = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');

  // Toast
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Notification state
  const [notifying, setNotifying] = useState(false);
  const [notifyResult, setNotifyResult] = useState<{ notified: number; sms_sent: number; push_sent: number } | null>(null);

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await teacherPremiumApi.listStudents(token);
      const students: TeacherPremiumStudent[] = Array.isArray(res.data) ? res.data : [];
      setRows(students.map((s) => ({ ...s, toggling: false, renewing: false })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load students');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Toast ───────────────────────────────────────────────────────────────────

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ── Toggle activate / deactivate ────────────────────────────────────────────

  const handleToggle = useCallback(async (studentId: string, currentStatus: string) => {
    const token = getToken();
    if (!token) return;

    setRows((prev) => prev.map((r) => r.id === studentId ? { ...r, toggling: true } : r));

    try {
      if (currentStatus === 'active') {
        await teacherPremiumApi.deactivate(token, studentId);
        setRows((prev) =>
          prev.map((r) =>
            r.id === studentId
              ? { ...r, premium_status: 'inactive', expires_at: null, days_left: null, toggling: false }
              : r
          )
        );
        showToast('Premium deactivated', 'success');
      } else {
        const res = await teacherPremiumApi.activate(token, studentId);
        const sub = res.data;
        // Recalculate days_left from new expires_at
        const expiresAt = (sub as unknown as Record<string, string | null>).expires_at ?? null;
        let daysLeft: number | null = null;
        if (expiresAt) {
          const today = new Date(); today.setHours(0, 0, 0, 0);
          const expiry = new Date(expiresAt); expiry.setHours(0, 0, 0, 0);
          daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          if (daysLeft < 0) daysLeft = 0;
        }
        setRows((prev) =>
          prev.map((r) =>
            r.id === studentId
              ? {
                  ...r,
                  premium_status: 'active',
                  activated_at: (sub as unknown as Record<string, string | null>).activated_at ?? null,
                  expires_at: expiresAt,
                  days_left: daysLeft,
                  activated_by_admin_id: (sub as unknown as Record<string, string | null>).activated_by_admin_id ?? null,
                  subscription_id: (sub as unknown as Record<string, string | null>).id ?? null,
                  toggling: false,
                }
              : r
          )
        );
        showToast('Premium activated', 'success');
      }
    } catch (e) {
      setRows((prev) => prev.map((r) => r.id === studentId ? { ...r, toggling: false } : r));
      showToast(e instanceof Error ? e.message : 'Failed to update', 'error');
    }
  }, []);

  // ── Renew ────────────────────────────────────────────────────────────────────

  const handleRenew = useCallback(async (studentId: string) => {
    const token = getToken();
    if (!token) return;

    setRows((prev) => prev.map((r) => r.id === studentId ? { ...r, renewing: true } : r));

    try {
      const res = await teacherPremiumApi.renew(token, studentId);
      const sub = res.data;
      const expiresAt = (sub as unknown as Record<string, string | null>).expires_at ?? null;
      let daysLeft: number | null = null;
      if (expiresAt) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const expiry = new Date(expiresAt); expiry.setHours(0, 0, 0, 0);
        daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (daysLeft < 0) daysLeft = 0;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.id === studentId
            ? { ...r, premium_status: 'active', expires_at: expiresAt, days_left: daysLeft, renewing: false }
            : r
        )
      );
      showToast('Renewed by 1 month', 'success');
    } catch (e) {
      setRows((prev) => prev.map((r) => r.id === studentId ? { ...r, renewing: false } : r));
      showToast(e instanceof Error ? e.message : 'Failed to renew', 'error');
    }
  }, []);

  // ── Send Renewal Notification ─────────────────────────────────────────────

  const handleNotifyExpiring = async () => {
    const token = getToken();
    if (!token) return;
    setNotifying(true);
    setNotifyResult(null);
    try {
      const res = await teacherPremiumApi.notifyRenewal(token, { days_threshold: 5 });
      setNotifyResult(res.data);
      showToast(
        `Notified ${res.data.notified} parent(s) — ${res.data.sms_sent} SMS sent`,
        'success'
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to send notifications', 'error');
    } finally {
      setNotifying(false);
      setTimeout(() => setNotifyResult(null), 8000);
    }
  };

  // ── Derived data ─────────────────────────────────────────────────────────────

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
    if (filterClass)   data = data.filter((r) => r.class_name === filterClass);
    if (filterSection) data = data.filter((r) => r.section === filterSection);
    if (filterStatus !== 'all') {
      data = data.filter((r) =>
        filterStatus === 'active'
          ? r.premium_status === 'active'
          : r.premium_status !== 'active'
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      data = data.filter((r) => r.full_name.toLowerCase().includes(q));
    }
    return data;
  }, [rows, filterClass, filterSection, filterStatus, search]);

  const stats = useMemo(() => {
    const total    = rows.length;
    const active   = rows.filter((r) => r.premium_status === 'active').length;
    const expiring = rows.filter((r) => r.premium_status === 'active' && r.days_left !== null && r.days_left <= 5).length;
    return { total, active, notActive: total - active, expiring };
  }, [rows]);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Premium Management"
        description="Manage premium subscriptions for students in your assigned classes."
        action={
          <button
            onClick={handleNotifyExpiring}
            disabled={notifying || loading || stats.expiring === 0}
            title={stats.expiring === 0 ? 'No subscriptions expiring in the next 5 days' : `Send reminder to ${stats.expiring} parent(s) whose subscription expires in ≤ 5 days`}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {notifying ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <BellIcon />
                Send Renewal Reminder
                {stats.expiring > 0 && (
                  <span className="ml-1 bg-white text-red-600 text-xs font-bold px-1.5 py-0.5 rounded-full">
                    {stats.expiring}
                  </span>
                )}
              </>
            )}
          </button>
        }
      />

      {/* Notification result banner */}
      {notifyResult && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 text-sm text-blue-800 flex items-center gap-3">
          <span className="text-lg">✅</span>
          <span>
            Reminder sent to <strong>{notifyResult.notified}</strong> parent(s) —{' '}
            <strong>{notifyResult.sms_sent}</strong> SMS &amp; <strong>{notifyResult.push_sent}</strong> push notification(s)
          </span>
        </div>
      )}

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
          { label: 'My Students',    value: stats.total,    color: 'text-gray-900' },
          { label: 'Premium Active', value: stats.active,   color: 'text-emerald-600' },
          { label: 'Not Activated',  value: stats.notActive, color: 'text-gray-500' },
          { label: 'Expiring ≤ 5d',  value: stats.expiring, color: 'text-red-600' },
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
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as 'all' | 'active' | 'inactive')}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Status</option>
          <option value="active">Active Only</option>
          <option value="inactive">Not Activated</option>
        </select>
        {(search || filterClass || filterSection || filterStatus !== 'all') && (
          <button
            onClick={() => { setSearch(''); setFilterClass(''); setFilterSection(''); setFilterStatus('all'); }}
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
          {rows.length === 0
            ? 'No students found in your assigned classes. Contact your admin to assign classes.'
            : 'No students match the current filters.'}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Name', 'Class', 'Sec', 'Plan', 'Premium', 'Activated On', 'Expires On', 'Days Left', 'Actions'].map(
                    (h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap"
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((row) => {
                  const isActive = row.premium_status === 'active';
                  const isExpiringSoon = isActive && row.days_left !== null && row.days_left <= 5;

                  return (
                    <tr
                      key={row.id}
                      className={`hover:bg-gray-50 transition-colors ${
                        isExpiringSoon ? 'bg-red-50/30' : ''
                      }`}
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

                      {/* Class */}
                      <td className="px-4 py-3 text-gray-600">{row.class_name}</td>

                      {/* Section */}
                      <td className="px-4 py-3 text-gray-600">{row.section || '—'}</td>

                      {/* Plan */}
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

                      {/* Toggle */}
                      <td className="px-4 py-3">
                        {row.toggling ? (
                          <div className="w-11 h-6 flex items-center justify-center">
                            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                          </div>
                        ) : (
                          <Toggle
                            checked={isActive}
                            disabled={false}
                            onChange={() => handleToggle(row.id, row.premium_status)}
                            label={`Toggle premium for ${row.full_name}`}
                          />
                        )}
                      </td>

                      {/* Activated On */}
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {isActive ? formatDate(row.activated_at) : '—'}
                      </td>

                      {/* Expires On */}
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {isActive ? formatDate(row.expires_at) : '—'}
                      </td>

                      {/* Days Left */}
                      <td className={`px-4 py-3 text-xs whitespace-nowrap ${daysLeftColor(isActive ? row.days_left : null)}`}>
                        {isActive ? daysLeftLabel(row.days_left) : '—'}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {isActive && (
                            row.renewing ? (
                              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <button
                                onClick={() => handleRenew(row.id)}
                                className="px-3 py-1 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                                title="Extend subscription by 1 month"
                              >
                                Renew 1 Month
                              </button>
                            )
                          )}
                          {isActive && (
                            <button
                              onClick={() => handleToggle(row.id, 'active')}
                              disabled={row.toggling}
                              className="px-3 py-1 text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200 rounded-lg hover:bg-red-50 hover:text-red-700 hover:border-red-200 transition-colors"
                              title="Deactivate — use this to correct a mistake"
                            >
                              Correct / Deactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Expiring soon legend */}
      {!loading && stats.expiring > 0 && (
        <p className="text-xs text-red-600 flex items-center gap-1.5">
          <span>⚠</span>
          <span>
            <strong>{stats.expiring}</strong> subscription{stats.expiring !== 1 ? 's' : ''} expiring within 5 days.
            Use the <strong>"Send Renewal Reminder"</strong> button at the top to notify parents.
          </span>
        </p>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
      />
    </svg>
  );
}
