'use client';

import { useEffect, useState, useCallback } from 'react';
import { usersApi, schoolsApi, authApi, type School } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

type AppRole = 'schooladmin' | 'teacher' | 'parent' | 'student';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  school_id: string | null;
  created_at: string;
}

interface CreateUserForm {
  name: string;
  email: string;
  password: string;
  role: AppRole;
  school_id: string;
}

const EMPTY_FORM: CreateUserForm = {
  name: '', email: '', password: '', role: 'schooladmin', school_id: '',
};

const ROLE_BADGE: Record<string, string> = {
  superadmin: 'bg-purple-100 text-purple-700',
  schooladmin: 'bg-blue-100 text-blue-700',
  teacher: 'bg-green-100 text-green-700',
  parent: 'bg-yellow-100 text-yellow-700',
  student: 'bg-gray-100 text-gray-600',
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SuperAdminUsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [filterRole, setFilterRole] = useState('');
  const [filterSchool, setFilterSchool] = useState('');
  const [search, setSearch] = useState('');

  // Create user modal
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateUserForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createSuccess, setCreateSuccess] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Remove confirm
  const [removeTarget, setRemoveTarget] = useState<UserRow | null>(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const [uRes, sRes] = await Promise.all([
        usersApi.list(token, {
          role: filterRole || undefined,
          school_id: filterSchool || undefined,
        }),
        schoolsApi.list(token),
      ]);
      setUsers(uRes.data as unknown as UserRow[]);
      setSchools(sRes.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [filterRole, filterSchool]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Create user ───────────────────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(''); setCreateSuccess('');
    if (!form.name.trim() || !form.email.trim() || form.password.length < 8) {
      setFormError('All fields required. Password must be at least 8 characters.');
      return;
    }
    if (!form.school_id) {
      setFormError('Please select a school.');
      return;
    }
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await authApi.createUser(token, {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        school_id: form.school_id,
      });
      setCreateSuccess(`Account created for ${form.name}.`);
      setForm(EMPTY_FORM);
      await fetchAll();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Remove user ───────────────────────────────────────────────────────────

  async function handleRemove() {
    if (!removeTarget) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await usersApi.remove(token, removeTarget.id);
      setRemoveTarget(null);
      await fetchAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to remove user');
      setRemoveTarget(null);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function schoolName(schoolId: string | null) {
    if (!schoolId) return '—';
    return schools.find((s) => s.id === schoolId)?.name ?? schoolId.slice(0, 8);
  }

  const filtered = users.filter((u) => {
    const q = search.toLowerCase();
    return !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Users"
        description="Manage all user accounts across every school"
        action={
          <button
            onClick={() => { setForm(EMPTY_FORM); setFormError(''); setCreateSuccess(''); setShowPassword(false); setShowCreate(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create Account
          </button>
        }
      />

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text" placeholder="Search by name or email…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <select
          value={filterRole} onChange={(e) => setFilterRole(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="">All roles</option>
          <option value="schooladmin">School Admin</option>
          <option value="teacher">Teacher</option>
          <option value="parent">Parent</option>
          <option value="student">Student</option>
        </select>

        <select
          value={filterSchool} onChange={(e) => setFilterSchool(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="">All schools</option>
          {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {/* Summary */}
      {!loading && (
        <p className="text-xs text-gray-500 mb-3">
          Showing {filtered.length} of {users.length} user{users.length !== 1 ? 's' : ''}
        </p>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-sm text-gray-400">
            {search || filterRole || filterSchool ? 'No users match your filters.' : 'No users found.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">User</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Role</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">School</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Joined</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-semibold shrink-0">
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{u.name}</p>
                          <p className="text-xs text-gray-400">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${ROLE_BADGE[u.role] ?? 'bg-gray-100 text-gray-600'}`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-600 text-sm">{schoolName(u.school_id)}</td>
                    <td className="px-6 py-4 text-gray-500 text-xs">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => setRemoveTarget(u)}
                        className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create User Modal ──────────────────────────────────────────────── */}
      <Modal open={showCreate} onClose={() => { setShowCreate(false); setShowPassword(false); }} title="Create User Account">
        <form onSubmit={handleCreate} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
          )}
          {createSuccess && (
            <div className="px-3 py-2.5 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {createSuccess}
            </div>
          )}

          <FormField label="Full Name" htmlFor="u-name" required>
            <input id="u-name" type="text" className={inputClass} placeholder="Jane Smith"
              value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </FormField>

          <FormField label="Email Address" htmlFor="u-email" required>
            <input id="u-email" type="email" className={inputClass} placeholder="user@school.com"
              value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
          </FormField>

          <FormField label="Password" htmlFor="u-pass" required>
            <div className="relative">
              <input
                id="u-pass"
                type={showPassword ? 'text' : 'password'}
                className={`${inputClass} pr-10`}
                placeholder="Min. 8 characters"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                minLength={8}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Role" htmlFor="u-role" required>
              <select id="u-role" className={inputClass}
                value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as AppRole }))}>
                <option value="schooladmin">School Admin</option>
                <option value="teacher">Teacher</option>
                <option value="parent">Parent</option>
                <option value="student">Student</option>
              </select>
            </FormField>

            <FormField label="School" htmlFor="u-school" required>
              <select id="u-school" className={inputClass}
                value={form.school_id} onChange={(e) => setForm((f) => ({ ...f, school_id: e.target.value }))}>
                <option value="">Select school…</option>
                {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </FormField>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowCreate(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {submitting ? 'Creating…' : 'Create Account'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Remove Confirm ─────────────────────────────────────────────────── */}
      <Modal open={!!removeTarget} onClose={() => setRemoveTarget(null)} title="Remove User" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Are you sure you want to permanently remove{' '}
            <strong>{removeTarget?.name}</strong> ({removeTarget?.email})?
            This will delete their auth account and all associated data.
          </p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setRemoveTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button onClick={handleRemove} disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors">
              {submitting ? 'Removing…' : 'Yes, Remove'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
