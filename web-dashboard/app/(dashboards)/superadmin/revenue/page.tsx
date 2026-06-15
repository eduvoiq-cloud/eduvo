'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { premiumApi, type RevenueShare, type ParentSubscription } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SchoolSummaryRow {
  school_id: string;
  school_name: string;
  subscription_status: boolean;
  total_students: number;
  active_premium_count: number;
  junior_count: number;
  senior_count: number;
  rate_per_student: number;
  amount_owed: number;
  this_month_status: 'pending' | 'invoiced' | 'paid' | null;
}

type PayoutStatus = 'pending' | 'invoiced' | 'paid';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** First day of the current month as YYYY-MM-DD */
function currentMonthFirst(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function formatMonth(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}

function statusBadge(status: PayoutStatus | null) {
  if (!status) return <span className="text-gray-400 text-xs">—</span>;
  const map: Record<PayoutStatus, string> = {
    pending: 'bg-yellow-50 text-yellow-700',
    invoiced: 'bg-blue-50 text-blue-700',
    paid: 'bg-emerald-50 text-emerald-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${map[status]}`}>
      {status}
    </span>
  );
}

// ── School detail modal ───────────────────────────────────────────────────────

function SchoolDetailModal({
  school,
  onClose,
}: {
  school: SchoolSummaryRow;
  onClose: () => void;
}) {
  const [subs, setSubs] = useState<ParentSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    premiumApi
      .listSchoolSubscriptions(token, school.school_id, { status: 'active', limit: 500 })
      .then((res) => {
        setSubs(res.data.data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [school.school_id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{school.school_name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Active premium students — verification view
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <p className="text-sm text-red-600 text-center py-8">{error}</p>
          ) : subs.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No active premium students.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['#', 'Student Name', 'Class', 'Section', 'Plan', 'Activated On'].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {subs.map((sub, i) => {
                  const st = sub.students;
                  return (
                    <tr key={sub.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5 text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2.5 font-medium text-gray-900">{st?.full_name ?? sub.student_id}</td>
                      <td className="px-3 py-2.5 text-gray-600">{st?.class_name ?? '—'}</td>
                      <td className="px-3 py-2.5 text-gray-600">{st?.section ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          sub.plan_type === 'premium_senior'
                            ? 'bg-purple-50 text-purple-700'
                            : 'bg-blue-50 text-blue-700'
                        }`}>
                          {sub.plan_type === 'premium_senior' ? 'Senior' : 'Junior'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 text-xs">
                        {sub.activated_at
                          ? new Date(sub.activated_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 bg-gray-50 rounded-b-2xl flex items-center justify-between">
          <span className="text-xs text-gray-500">
            Total active: <strong className="text-gray-900">{subs.length}</strong>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
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
              {['School', 'Students', 'Active Premium', 'Junior', 'Senior', 'Rate', 'Amount Owed', 'This Month', 'Actions'].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="animate-pulse">
                {Array.from({ length: 9 }).map((__, j) => (
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

// ── Main component ────────────────────────────────────────────────────────────

export default function SuperadminRevenuePage() {

  const [summary, setSummary] = useState<SchoolSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail modal
  const [detailSchool, setDetailSchool] = useState<SchoolSummaryRow | null>(null);

  // Generate report state
  const [generating, setGenerating] = useState(false);
  const [genToast, setGenToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Updating payout status per row
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null); // school_id

  // Revenue history modal
  const [historySchool, setHistorySchool] = useState<SchoolSummaryRow | null>(null);
  const [history, setHistory] = useState<RevenueShare[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Load summary ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await premiumApi.getSchoolsSummary(token);
      setSummary(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Toast ───────────────────────────────────────────────────────────────────

  const showToast = (msg: string, type: 'success' | 'error') => {
    setGenToast({ msg, type });
    setTimeout(() => setGenToast(null), 3500);
  };

  // ── Generate monthly report ─────────────────────────────────────────────────

  const handleGenerateReport = async () => {
    const token = getToken();
    if (!token) return;
    setGenerating(true);
    try {
      const month = currentMonthFirst();
      await premiumApi.calculateRevenue(token, { month });
      showToast(`Report generated for ${formatMonth(month)}`, 'success');
      // Refresh summary so this_month_status updates
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to generate report', 'error');
    } finally {
      setGenerating(false);
    }
  };

  // ── Update payout status ────────────────────────────────────────────────────

  const handleStatusChange = async (school: SchoolSummaryRow, newStatus: PayoutStatus) => {
    const token = getToken();
    if (!token) return;

    // We need the revenue_share row id — fetch it first
    setUpdatingStatus(school.school_id);
    try {
      const month = currentMonthFirst();
      // Calculate to ensure row exists, then fetch it
      const calcRes = await premiumApi.calculateRevenue(token, {
        month,
        school_id: school.school_id,
        rate_per_student: school.rate_per_student,
      });
      const rows = calcRes.data;
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row?.id) throw new Error('Revenue row not found');

      await premiumApi.updatePayoutStatus(token, row.id, newStatus);
      setSummary((prev) =>
        prev.map((s) =>
          s.school_id === school.school_id
            ? { ...s, this_month_status: newStatus }
            : s
        )
      );
      showToast('Status updated', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to update status', 'error');
    } finally {
      setUpdatingStatus(null);
    }
  };

  // ── Revenue history ─────────────────────────────────────────────────────────

  const loadHistory = async (school: SchoolSummaryRow) => {
    const token = getToken();
    if (!token) return;
    setHistorySchool(school);
    setHistoryLoading(true);
    try {
      const res = await premiumApi.getAllRevenue(token);
      const schoolHistory = res.data.filter((r) => r.school_id === school.school_id);
      setHistory(schoolHistory);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  // ── Derived totals ──────────────────────────────────────────────────────────

  const totals = useMemo(() => {
    const totalSchools = summary.length;
    const totalActive = summary.reduce((sum, s) => sum + s.active_premium_count, 0);
    const totalJunior = summary.reduce((sum, s) => sum + s.junior_count, 0);
    const totalSenior = summary.reduce((sum, s) => sum + s.senior_count, 0);
    const totalOwed = summary.reduce((sum, s) => sum + s.amount_owed, 0);
    return { totalSchools, totalActive, totalJunior, totalSenior, totalOwed };
  }, [summary]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Revenue Dashboard"
        description={`Manual billing tracker — ${formatMonth(currentMonthFirst())}`}
      />

      {/* Toast */}
      {genToast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white ${
            genToast.type === 'success' ? 'bg-emerald-600' : 'bg-red-600'
          }`}
        >
          {genToast.msg}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {[
          { label: 'Schools', value: totals.totalSchools, color: 'text-gray-900' },
          { label: 'Active Premium', value: totals.totalActive, color: 'text-emerald-600' },
          { label: 'Junior (1–6)', value: totals.totalJunior, color: 'text-blue-600' },
          { label: 'Senior (7–12)', value: totals.totalSenior, color: 'text-purple-600' },
          { label: 'Total Owed', value: loading ? '—' : formatCurrency(totals.totalOwed), color: 'text-orange-600', raw: true },
        ].map(({ label, value, color, raw }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 px-5 py-4">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>
              {loading ? '—' : (raw ? value : value)}
            </p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Source of truth for billing schools via WhatsApp / email invoice.
        </p>
        <button
          onClick={handleGenerateReport}
          disabled={generating}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {generating ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Generate Monthly Report
            </>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          {error} —{' '}
          <button onClick={load} className="underline">retry</button>
        </div>
      )}

      {/* Main table */}
      {loading ? (
        <TableSkeleton />
      ) : summary.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 px-6 py-12 text-center text-sm text-gray-500">
          No schools found.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">School</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Students</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Active</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Junior</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Senior</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Rate/Student</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount Owed</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">This Month</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {summary.map((school) => (
                  <tr key={school.school_id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div>
                        <button
                          onClick={() => setDetailSchool(school)}
                          className="font-medium text-gray-900 hover:text-blue-600 text-left transition-colors"
                        >
                          {school.school_name}
                        </button>
                        {!school.subscription_status && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-50 text-red-600">
                            Inactive
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{school.total_students}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold text-emerald-600">{school.active_premium_count}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-blue-600">{school.junior_count}</td>
                    <td className="px-4 py-3 text-right text-purple-600">{school.senior_count}</td>
                    <td className="px-4 py-3 text-right text-gray-700">₹{school.rate_per_student}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {school.amount_owed > 0 ? formatCurrency(school.amount_owed) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {statusBadge(school.this_month_status)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {/* Payout status dropdown */}
                        {updatingStatus === school.school_id ? (
                          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <select
                            value={school.this_month_status ?? ''}
                            onChange={(e) => handleStatusChange(school, e.target.value as PayoutStatus)}
                            className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                            aria-label={`Update payout status for ${school.school_name}`}
                          >
                            <option value="" disabled>Mark as…</option>
                            <option value="pending">Pending</option>
                            <option value="invoiced">Invoiced</option>
                            <option value="paid">Paid</option>
                          </select>
                        )}
                        {/* View students button */}
                        <button
                          onClick={() => setDetailSchool(school)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium whitespace-nowrap"
                          title="View premium students"
                        >
                          View
                        </button>
                        {/* History button */}
                        <button
                          onClick={() => loadHistory(school)}
                          className="text-xs text-gray-500 hover:text-gray-800 font-medium"
                          title="View history"
                        >
                          History
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* Totals row */}
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td className="px-4 py-3 font-semibold text-gray-700">Total</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-700">
                    {summary.reduce((s, r) => s + r.total_students, 0)}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-emerald-600">
                    {totals.totalActive}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-blue-600">{totals.totalJunior}</td>
                  <td className="px-4 py-3 text-right font-semibold text-purple-600">{totals.totalSenior}</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    {formatCurrency(totals.totalOwed)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* School detail modal (premium students list) */}
      {detailSchool && (
        <SchoolDetailModal
          school={detailSchool}
          onClose={() => setDetailSchool(null)}
        />
      )}

      {/* Revenue history modal */}
      {historySchool && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setHistorySchool(null); }}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[70vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">{historySchool.school_name}</h2>
                <p className="text-xs text-gray-500 mt-0.5">Revenue history</p>
              </div>
              <button
                onClick={() => setHistorySchool(null)}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
                aria-label="Close"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {historyLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : history.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">No history yet. Generate a monthly report first.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      {['Month', 'Active', 'Rate', 'Owed', 'Status'].map((h) => (
                        <th key={h} className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {history.map((row) => (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2.5 text-gray-900">{formatMonth(row.month)}</td>
                        <td className="px-3 py-2.5 text-gray-700">{row.total_active_premium_count}</td>
                        <td className="px-3 py-2.5 text-gray-700">₹{row.rate_per_student}</td>
                        <td className="px-3 py-2.5 font-semibold text-gray-900">{formatCurrency(row.amount_owed)}</td>
                        <td className="px-3 py-2.5">{statusBadge(row.payout_status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-6 py-3 border-t border-gray-100 bg-gray-50 rounded-b-2xl flex justify-end">
              <button
                onClick={() => setHistorySchool(null)}
                className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
