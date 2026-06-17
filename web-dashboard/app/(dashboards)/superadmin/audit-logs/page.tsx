'use client';

import { useCallback, useEffect, useState } from 'react';
import { schoolsApi, type AuditLog, type School } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuditLogsResponse {
  logs: AuditLog[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

async function apiFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `Request failed: ${res.status}`);
  return json.data as T;
}

const ACTION_COLORS: Record<string, string> = {
  SCHOOL_CREATED: 'bg-green-100 text-green-700',
  SCHOOL_SUBSCRIPTION_ACTIVATED: 'bg-green-100 text-green-700',
  SCHOOL_SUBSCRIPTION_DEACTIVATED: 'bg-red-100 text-red-600',
  SCHOOL_SUBSCRIPTION_DEACTIVATION_WARNING: 'bg-amber-100 text-amber-700',
  SCHOOL_ADMIN_CREATED: 'bg-blue-100 text-blue-700',
  SCHOOL_DATA_EXPORTED: 'bg-purple-100 text-purple-700',
  STUDENT_CREATED: 'bg-green-100 text-green-700',
  STUDENT_UPDATED: 'bg-blue-100 text-blue-700',
  STUDENT_DELETED: 'bg-red-100 text-red-600',
  TEACHER_CREATED: 'bg-green-100 text-green-700',
  TEACHER_DELETED: 'bg-red-100 text-red-600',
  manual_attendance_batch: 'bg-blue-100 text-blue-700',
  attendance_corrected: 'bg-amber-100 text-amber-700',
};

function actionBadgeClass(action: string): string {
  return ACTION_COLORS[action] ?? 'bg-gray-100 text-gray-600';
}

function formatAction(action: string): string {
  return action
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse an ISO timestamp as UTC. Supabase may return timestamptz values without
 * a timezone designator, which JavaScript would interpret as local time.
 */
function parseUtcDate(iso: string): Date {
  if (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + 'Z');
  }
  return new Date(iso);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - parseUtcDate(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [filterSchool, setFilterSchool] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchLogs = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ page: String(page) });
      if (filterSchool) qs.set('school_id', filterSchool);
      if (filterAction) qs.set('action', filterAction);
      if (filterFrom) qs.set('from', filterFrom);
      if (filterTo) qs.set('to', filterTo);

      const data = await apiFetch<AuditLogsResponse>(
        `/api/superadmin/audit-logs?${qs.toString()}`,
        token
      );
      setLogs(data.logs);
      setTotalPages(data.total_pages);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, filterSchool, filterAction, filterFrom, filterTo]);

  const fetchSchools = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await schoolsApi.list(token);
      setSchools(res.data);
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => { fetchSchools(); }, [fetchSchools]);
  useEffect(() => { fetchLogs(); }, [fetchLogs]);


  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="All actions across every school on the platform"
      />

      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-3 mb-5">
        <select
          value={filterSchool}
          onChange={(e) => { setFilterSchool(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          aria-label="Filter by school"
        >
          <option value="">All Schools</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Filter by action…"
          value={filterAction}
          onChange={(e) => { setFilterAction(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
        />

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => { setFilterFrom(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="From date"
          />
          <span className="text-gray-400 text-sm">to</span>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => { setFilterTo(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="To date"
          />
        </div>

        {(filterSchool || filterAction || filterFrom || filterTo) && (
          <button
            onClick={() => {
              setFilterSchool('');
              setFilterAction('');
              setFilterFrom('');
              setFilterTo('');
              setPage(1);
            }}
            className="px-3 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Summary ── */}
      {!loading && (
        <p className="text-xs text-gray-500 mb-3">
          {total.toLocaleString()} total log{total !== 1 ? 's' : ''}
          {totalPages > 1 && ` · Page ${page} of ${totalPages}`}
        </p>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Table ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-16 text-sm text-gray-400">
            No audit logs found for the selected filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">User</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Table</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Details</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${actionBadgeClass(log.action)}`}>
                        {formatAction(log.action)}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      {log.users ? (
                        <div>
                          <p className="text-sm font-medium text-gray-900">{log.users.name}</p>
                          <p className="text-xs text-gray-400 capitalize">{log.users.role}</p>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">System</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-gray-500 text-xs font-mono">
                      {log.table_name ?? '—'}
                    </td>
                    <td className="px-6 py-3 max-w-xs">
                      {log.details && Object.keys(log.details).length > 0 ? (
                        <details className="group">
                          <summary className="text-xs text-blue-600 cursor-pointer hover:text-blue-700 list-none flex items-center gap-1">
                            <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                            View details
                          </summary>
                          <pre className="mt-1.5 text-xs text-gray-600 bg-gray-50 rounded-lg p-2 overflow-x-auto max-w-xs whitespace-pre-wrap break-all">
                            {JSON.stringify(log.details, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <p className="text-xs text-gray-500 whitespace-nowrap">
                        {timeAgo(log.created_at)}
                      </p>
                      <p className="text-xs text-gray-300 whitespace-nowrap">
                        {parseUtcDate(log.created_at).toLocaleDateString()}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Previous
          </button>

          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
              // Show pages around current page
              let pageNum: number;
              if (totalPages <= 7) {
                pageNum = i + 1;
              } else if (page <= 4) {
                pageNum = i + 1;
              } else if (page >= totalPages - 3) {
                pageNum = totalPages - 6 + i;
              } else {
                pageNum = page - 3 + i;
              }
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  disabled={loading}
                  className={`w-8 h-8 text-xs font-medium rounded-lg transition-colors ${
                    pageNum === page
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-600 hover:bg-gray-100 border border-gray-200'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages || loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}
