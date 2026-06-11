'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { type AuditLog } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuperAdminSchool {
  id: string;
  name: string;
  address: string;
  phone?: string;
  email?: string;
  subscription_status: boolean;
  student_count: number;
  teacher_count: number;
  last_active_date: string | null;
  created_at: string;
}

interface PlatformStats {
  total_schools: number;
  active_schools: number;
  total_students: number;
  attendance_today: number;
  revenue_estimate: number;
  subscription_price: number;
}

interface AuditLogsResponse {
  logs: AuditLog[];
  total: number;
}

interface SchoolsPageResponse {
  data: SuperAdminSchool[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

async function apiFetch<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options?.headers as Record<string, string>),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `Request failed: ${res.status}`);
  return json.data as T;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SuperAdminDashboard() {
  const { user } = useAuth();
  const [schools, setSchools] = useState<SuperAdminSchool[]>([]);
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state for audit logs
  const [logSchoolFilter, setLogSchoolFilter] = useState('');

  // Subscription toggle modal
  const [toggleTarget, setToggleTarget] = useState<SuperAdminSchool | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);

  // Deactivate confirmation modal
  const [deactivateTarget, setDeactivateTarget] = useState<SuperAdminSchool | null>(null);
  const [deactivateLoading, setDeactivateLoading] = useState(false);

  // Create admin modal
  const [adminTarget, setAdminTarget] = useState<SuperAdminSchool | null>(null);
  const [adminForm, setAdminForm] = useState({ name: '', email: '', phone: '' });
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminCreated, setAdminCreated] = useState<{ email: string; default_password?: string; password_is_phone?: boolean; already_existed?: boolean } | null>(null);

  // Add school modal
  const [showAddSchool, setShowAddSchool] = useState(false);
  const [schoolForm, setSchoolForm] = useState({ name: '', address: '', phone: '', email: '' });
  const [schoolLoading, setSchoolLoading] = useState(false);
  const [schoolError, setSchoolError] = useState<string | null>(null);

  // ── Data fetching ───────────────────────────────────────────────────────────

  const fetchSchools = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      // Backend returns a pagination envelope: { data: [...], total, page, ... }
      const result = await apiFetch<SchoolsPageResponse>('/api/superadmin/schools', token);
      setSchools(result.data ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const data = await apiFetch<PlatformStats>('/api/superadmin/stats', token);
      setStats(data);
    } catch {
      // stats are non-critical
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchAuditLogs = useCallback(async (schoolId?: string) => {
    const token = getToken();
    if (!token) return;
    setLogsLoading(true);
    try {
      const qs = new URLSearchParams({ page: '1' });
      if (schoolId) qs.set('school_id', schoolId);
      const data = await apiFetch<AuditLogsResponse>(
        `/api/superadmin/audit-logs?${qs.toString()}`,
        token
      );
      setAuditLogs((data.logs ?? []).slice(0, 20));
    } catch {
      // logs are non-critical
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSchools();
    fetchStats();
    fetchAuditLogs();
  }, [fetchSchools, fetchStats, fetchAuditLogs]);

  useEffect(() => {
    fetchAuditLogs(logSchoolFilter || undefined);
  }, [logSchoolFilter, fetchAuditLogs]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleToggleSubscription = async () => {
    if (!toggleTarget) return;
    const token = getToken();
    if (!token) return;
    setToggleLoading(true);
    try {
      await apiFetch(`/api/superadmin/schools/${toggleTarget.id}/subscription`, token, {
        method: 'PUT',
        body: JSON.stringify({ status: !toggleTarget.subscription_status }),
      });
      setSchools((prev) =>
        prev.map((s) =>
          s.id === toggleTarget.id
            ? { ...s, subscription_status: !s.subscription_status }
            : s
        )
      );
      setToggleTarget(null);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setToggleLoading(false);
    }
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    const token = getToken();
    if (!token) return;
    setDeactivateLoading(true);
    try {
      await apiFetch(`/api/superadmin/schools/${deactivateTarget.id}/subscription`, token, {
        method: 'PUT',
        body: JSON.stringify({ status: false }),
      });
      setSchools((prev) =>
        prev.map((s) =>
          s.id === deactivateTarget.id ? { ...s, subscription_status: false } : s
        )
      );
      setDeactivateTarget(null);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setDeactivateLoading(false);
    }
  };

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminTarget) return;
    const token = getToken();
    if (!token) return;
    setAdminLoading(true);
    setAdminError(null);
    try {
      const result = await apiFetch<{ email: string; default_password?: string; password_is_phone?: boolean; already_existed?: boolean }>(
        `/api/superadmin/schools/${adminTarget.id}/admin`, token, {
          method: 'POST',
          body: JSON.stringify(adminForm),
        }
      );
      setAdminForm({ name: '', email: '', phone: '' });
      setAdminCreated({
        email:             result.email ?? adminForm.email,
        default_password:  result.default_password,
        password_is_phone: result.password_is_phone,
        already_existed:   result.already_existed,
      });
    } catch (e) {
      setAdminError((e as Error).message);
    } finally {
      setAdminLoading(false);
    }
  };

  const handleAddSchool = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = getToken();
    if (!token) return;
    setSchoolLoading(true);
    setSchoolError(null);
    try {
      await apiFetch('/api/superadmin/schools', token, {
        method: 'POST',
        body: JSON.stringify(schoolForm),
      });
      setShowAddSchool(false);
      setSchoolForm({ name: '', address: '', phone: '', email: '' });
      fetchSchools();
    } catch (e) {
      setSchoolError((e as Error).message);
    } finally {
      setSchoolLoading(false);
    }
  };

  const handleExport = (school: SuperAdminSchool) => {
    const token = getToken();
    if (!token) return;
    window.open(
      `${BASE_URL}/api/superadmin/export/${school.id}?token=${token}`,
      '_blank'
    );
  };

  // ── Derived values ───────────────────────────────────────────────────────────

  const totalSchools = stats?.total_schools ?? schools.length;
  const activeSchools = stats?.active_schools ?? schools.filter((s) => s.subscription_status).length;
  const totalStudents = stats?.total_students ?? schools.reduce((sum, s) => sum + s.student_count, 0);
  const avgStudents = activeSchools > 0 ? Math.round(totalStudents / activeSchools) : 0;
  const revenueEstimate =
    stats?.revenue_estimate ?? activeSchools * 25 * avgStudents;
  const attendancePct =
    stats && stats.total_students > 0
      ? Math.round((stats.attendance_today / stats.total_students) * 100)
      : null;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.name ?? 'Super Admin'}`}
        description="Platform overview across all schools"
      />

      {/* ── Top Stats Row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total Schools"
          value={statsLoading ? '—' : totalSchools}
          sub={statsLoading ? 'Loading…' : `${activeSchools} active`}
          icon={<SchoolIcon />}
        />
        <StatCard
          label="Active Schools"
          value={statsLoading ? '—' : activeSchools}
          sub={statsLoading ? 'Loading…' : `${totalSchools - activeSchools} inactive`}
          icon={<CheckCircleIcon />}
        />
        <StatCard
          label="Total Students"
          value={statsLoading ? '—' : totalStudents.toLocaleString()}
          sub="Across all schools"
          icon={<UsersIcon />}
        />
        <StatCard
          label={attendancePct !== null ? "Today's Attendance" : "Est. Monthly Revenue"}
          value={
            statsLoading
              ? '—'
              : attendancePct !== null
              ? `${attendancePct}%`
              : `$${revenueEstimate.toLocaleString()}`
          }
          sub={
            attendancePct !== null
              ? `${stats?.attendance_today ?? 0} present today`
              : `${activeSchools} schools × $${stats?.subscription_price ?? 25}/mo`
          }
          icon={attendancePct !== null ? <AttendanceIcon /> : <RevenueIcon />}
        />
      </div>

      {/* ── Schools Table ── */}
      <div className="bg-white rounded-xl border border-gray-200 mb-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Schools</h2>
          <button
            onClick={() => setShowAddSchool(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <PlusIcon />
            Add School
          </button>
        </div>

        {error && (
          <div className="px-6 py-4 text-sm text-red-600 bg-red-50 border-b border-red-100">
            {error}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">School Name</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Students</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Teachers</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Subscription</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Last Active</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-10 text-center text-sm text-gray-400">
                    <div className="flex justify-center">
                      <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    </div>
                  </td>
                </tr>
              ) : schools.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-10 text-center text-sm text-gray-400">
                    No schools yet. Add one to get started.
                  </td>
                </tr>
              ) : (
                schools.map((school) => (
                  <tr key={school.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3.5">
                      <p className="font-medium text-gray-900">{school.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{school.address}</p>
                    </td>
                    <td className="px-4 py-3.5 text-right text-gray-700">{school.student_count}</td>
                    <td className="px-4 py-3.5 text-right text-gray-700">{school.teacher_count}</td>
                    <td className="px-4 py-3.5 text-center">
                      <button
                        onClick={() => setToggleTarget(school)}
                        className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                          school.subscription_status
                            ? 'bg-green-100 text-green-700 hover:bg-green-200'
                            : 'bg-red-100 text-red-600 hover:bg-red-200'
                        }`}
                        title="Click to toggle subscription"
                      >
                        {school.subscription_status ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-3.5 text-gray-500 text-xs">
                      {school.last_active_date
                        ? new Date(school.last_active_date).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="px-6 py-3.5">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/superadmin/schools`}
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                          View
                        </Link>
                        <button
                          onClick={() => { setAdminTarget(school); setAdminError(null); }}
                          className="text-xs text-gray-600 hover:text-gray-800 font-medium"
                        >
                          Create Admin
                        </button>
                        <button
                          onClick={() => handleExport(school)}
                          className="text-xs text-gray-600 hover:text-gray-800 font-medium"
                        >
                          Export
                        </button>
                        {school.subscription_status && (
                          <button
                            onClick={() => setDeactivateTarget(school)}
                            className="text-xs text-red-600 hover:text-red-700 font-medium"
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Audit Log Section ── */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Recent Audit Logs</h2>
          <div className="flex items-center gap-3">
            <select
              value={logSchoolFilter}
              onChange={(e) => setLogSchoolFilter(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Filter by school"
            >
              <option value="">All Schools</option>
              {schools.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <Link
              href="/superadmin/audit-logs"
              className="text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
            >
              View All Logs →
            </Link>
          </div>
        </div>

        {logsLoading ? (
          <div className="flex justify-center py-10">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : auditLogs.length === 0 ? (
          <p className="px-6 py-8 text-sm text-gray-400 text-center">No audit logs found.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {auditLogs.map((log) => (
              <div key={log.id} className="flex items-start justify-between px-6 py-3 gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{log.action}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {log.users?.name ?? 'System'} · {log.table_name ?? '—'}
                  </p>
                </div>
                <p className="text-xs text-gray-400 whitespace-nowrap shrink-0">
                  {new Date(log.created_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Toggle Subscription Modal ── */}
      <Modal
        open={!!toggleTarget}
        onClose={() => setToggleTarget(null)}
        title="Toggle Subscription"
        size="sm"
      >
        <p className="text-sm text-gray-600 mb-5">
          {toggleTarget?.subscription_status
            ? `Deactivate subscription for "${toggleTarget?.name}"? This will restrict school access.`
            : `Activate subscription for "${toggleTarget?.name}"?`}
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setToggleTarget(null)}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleToggleSubscription}
            disabled={toggleLoading}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 ${
              toggleTarget?.subscription_status
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            {toggleLoading ? 'Saving…' : toggleTarget?.subscription_status ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </Modal>

      {/* ── Deactivate Confirmation Modal ── */}
      <Modal
        open={!!deactivateTarget}
        onClose={() => setDeactivateTarget(null)}
        title="Deactivate School"
        size="sm"
      >
        <p className="text-sm text-gray-600 mb-2">
          Are you sure you want to deactivate <strong>{deactivateTarget?.name}</strong>?
        </p>
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-5">
          Warning: This will restrict access for all users at this school. Export school data first if needed.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setDeactivateTarget(null)}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleDeactivate}
            disabled={deactivateLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
          >
            {deactivateLoading ? 'Deactivating…' : 'Deactivate'}
          </button>
        </div>
      </Modal>

      {/* ── Create Admin Modal ── */}
      <Modal
        open={!!adminTarget}
        onClose={() => { setAdminTarget(null); setAdminError(null); setAdminCreated(null); }}
        title={`Create Admin — ${adminTarget?.name ?? ''}`}
        size="md"
      >
        {adminCreated ? (
          <div className="space-y-4">
            {adminCreated.already_existed ? (
              <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                An admin with email <strong>{adminCreated.email}</strong> already exists for this school.
                They can log in with their existing credentials, or use &ldquo;Forgot Password&rdquo; to reset.
              </div>
            ) : (
              <>
                <div className="px-3 py-2.5 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                  ✓ Admin account created for <strong>{adminCreated.email}</strong>.
                </div>
                {adminCreated.default_password && (
                  <div className="px-3 py-2.5 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-900 space-y-2">
                    <p className="font-semibold">Share these login credentials with the school admin:</p>
                    <div className="bg-white border border-yellow-200 rounded-lg p-3 space-y-1 text-sm font-mono">
                      <p><span className="text-gray-500 font-sans">Email: </span>{adminCreated.email}</p>
                      <p><span className="text-gray-500 font-sans">Password: </span><span className="font-bold tracking-wider">{adminCreated.default_password}</span></p>
                    </div>
                    <p className="text-xs text-yellow-700">
                      {adminCreated.password_is_phone
                        ? 'Password is their phone number. They will be prompted to change it on first login.'
                        : 'A temporary password was generated. They will be prompted to change it on first login.'}
                    </p>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => { setAdminTarget(null); setAdminCreated(null); }}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleCreateAdmin} className="space-y-4">
            {adminError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {adminError}
              </p>
            )}
            <div className="px-3 py-2.5 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
              This account will have <strong>School Admin</strong> access for <strong>{adminTarget?.name}</strong>.
              Password will be set to their phone number and they&apos;ll be asked to change it on first login.
            </div>
            <FormField label="Full Name" htmlFor="admin-name" required>
              <input
                id="admin-name"
                type="text"
                required
                value={adminForm.name}
                onChange={(e) => setAdminForm((f) => ({ ...f, name: e.target.value }))}
                className={inputClass}
                placeholder="Jane Smith"
              />
            </FormField>
            <FormField label="Email" htmlFor="admin-email" required>
              <input
                id="admin-email"
                type="email"
                required
                value={adminForm.email}
                onChange={(e) => setAdminForm((f) => ({ ...f, email: e.target.value }))}
                className={inputClass}
                placeholder="admin@school.edu"
              />
            </FormField>
            <FormField label="Phone Number" htmlFor="admin-phone">
              <input
                id="admin-phone"
                type="tel"
                value={adminForm.phone}
                onChange={(e) => setAdminForm((f) => ({ ...f, phone: e.target.value }))}
                className={inputClass}
                placeholder="+1 555 000 0000"
              />
              <p className="text-xs text-gray-400 mt-1">Used as the default password. If left blank, a temporary password is generated.</p>
            </FormField>
            <div className="flex justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={() => { setAdminTarget(null); setAdminError(null); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={adminLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
              >
                {adminLoading ? 'Creating…' : 'Create Admin'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ── Add School Modal ── */}
      <Modal
        open={showAddSchool}
        onClose={() => { setShowAddSchool(false); setSchoolError(null); }}
        title="Add New School"
        size="md"
      >
        <form onSubmit={handleAddSchool} className="space-y-4">
          {schoolError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {schoolError}
            </p>
          )}
          <FormField label="School Name" htmlFor="school-name" required>
            <input
              id="school-name"
              type="text"
              required
              value={schoolForm.name}
              onChange={(e) => setSchoolForm((f) => ({ ...f, name: e.target.value }))}
              className={inputClass}
              placeholder="Greenwood Academy"
            />
          </FormField>
          <FormField label="Address" htmlFor="school-address" required>
            <input
              id="school-address"
              type="text"
              required
              value={schoolForm.address}
              onChange={(e) => setSchoolForm((f) => ({ ...f, address: e.target.value }))}
              className={inputClass}
              placeholder="123 Main St, City, State"
            />
          </FormField>
          <FormField label="Phone" htmlFor="school-phone" required>
            <input
              id="school-phone"
              type="tel"
              required
              value={schoolForm.phone}
              onChange={(e) => setSchoolForm((f) => ({ ...f, phone: e.target.value }))}
              className={inputClass}
              placeholder="+1 555 000 0000"
            />
          </FormField>
          <FormField label="Email" htmlFor="school-email" required>
            <input
              id="school-email"
              type="email"
              required
              value={schoolForm.email}
              onChange={(e) => setSchoolForm((f) => ({ ...f, email: e.target.value }))}
              className={inputClass}
              placeholder="info@school.edu"
            />
          </FormField>
          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => { setShowAddSchool(false); setSchoolError(null); }}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={schoolLoading}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              {schoolLoading ? 'Creating…' : 'Create School'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SchoolIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function AttendanceIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  );
}

function RevenueIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}
