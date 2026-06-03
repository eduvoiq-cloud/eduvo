'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { schoolsApi, superadminApi, studentsApi, type School } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AddSchoolForm {
  name: string;
  address: string;
  phone: string;
  email: string;
}

interface AddAdminForm {
  name: string;
  email: string;
  password: string;
}

const EMPTY_SCHOOL_FORM: AddSchoolForm = { name: '', address: '', phone: '', email: '' };
const EMPTY_ADMIN_FORM: AddAdminForm = { name: '', email: '', password: '' };

// ── Main page ─────────────────────────────────────────────────────────────────

function SchoolsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [schools, setSchools] = useState<School[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Modal state
  const [showAddSchool, setShowAddSchool] = useState(false);
  const [showAddAdmin, setShowAddAdmin] = useState<School | null>(null); // school to add admin for
  const [showConfirmToggle, setShowConfirmToggle] = useState<School | null>(null);

  // Form state
  const [schoolForm, setSchoolForm] = useState<AddSchoolForm>(EMPTY_SCHOOL_FORM);
  const [adminForm, setAdminForm] = useState<AddAdminForm>(EMPTY_ADMIN_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Search
  const [search, setSearch] = useState('');

  // Open "Add School" modal if ?action=new in URL
  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setShowAddSchool(true);
      router.replace('/superadmin/schools');
    }
  }, [searchParams, router]);

  // ── Fetch schools ─────────────────────────────────────────────────────────

  const fetchSchools = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const [schoolsRes, studentsRes] = await Promise.all([
        schoolsApi.list(token),
        // limit=0 → returns a flat array (no pagination envelope)
        studentsApi.list(token, { limit: 0 }),
      ]);

      // Unwrap: limit=0 returns a flat array; paginated calls return an envelope
      const studentList = Array.isArray(studentsRes.data)
        ? (studentsRes.data as unknown as { school_id: string }[])
        : ((studentsRes.data as unknown as { data: { school_id: string }[] }).data ?? []);

      // Count students per school
      const countMap: Record<string, number> = {};
      for (const s of studentList) {
        countMap[s.school_id] = (countMap[s.school_id] ?? 0) + 1;
      }

      const enriched = schoolsRes.data.map((school) => ({
        ...school,
        student_count: countMap[school.id] ?? 0,
      }));

      setSchools(enriched);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load schools');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSchools(); }, [fetchSchools]);

  // ── Add school ────────────────────────────────────────────────────────────

  async function handleAddSchool(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!schoolForm.name.trim() || !schoolForm.address.trim()) {
      setFormError('Name and address are required.');
      return;
    }
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await schoolsApi.create(token, {
        name: schoolForm.name.trim(),
        address: schoolForm.address.trim(),
        phone: schoolForm.phone.trim() || undefined,
        email: schoolForm.email.trim() || undefined,
      });
      setShowAddSchool(false);
      setSchoolForm(EMPTY_SCHOOL_FORM);
      await fetchSchools();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to create school');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Toggle subscription ───────────────────────────────────────────────────

  async function handleToggleSubscription() {
    if (!showConfirmToggle) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await schoolsApi.update(token, showConfirmToggle.id, {
        is_active: !showConfirmToggle.is_active,
      });
      setShowConfirmToggle(null);
      await fetchSchools();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update school');
      setShowConfirmToggle(null);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Create school admin ───────────────────────────────────────────────────

  async function handleAddAdmin(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!adminForm.name.trim() || !adminForm.email.trim() || adminForm.password.length < 8) {
      setFormError('All fields required. Password must be at least 8 characters.');
      return;
    }
    if (!showAddAdmin) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await superadminApi.createSchoolAdmin(token, showAddAdmin.id, {
        name: adminForm.name.trim(),
        email: adminForm.email.trim(),
        password: adminForm.password,
      });
      setShowAddAdmin(null);
      setAdminForm(EMPTY_ADMIN_FORM);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to create admin account');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Filtered list ─────────────────────────────────────────────────────────

  const filtered = schools.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.address.toLowerCase().includes(search.toLowerCase())
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Schools"
        description="Manage all schools on the platform"
        action={
          <button
            onClick={() => { setSchoolForm(EMPTY_SCHOOL_FORM); setFormError(''); setShowAddSchool(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add School
          </button>
        }
      />

      {/* Error banner */}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <div className="relative max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search schools…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-sm text-gray-500">
            {search ? 'No schools match your search.' : 'No schools yet. Add your first school.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">School</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Address</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Students</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((school) => (
                  <tr key={school.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-medium text-gray-900">{school.name}</p>
                      {school.email && <p className="text-xs text-gray-400 mt-0.5">{school.email}</p>}
                    </td>
                    <td className="px-6 py-4 text-gray-600 max-w-xs truncate">{school.address}</td>
                    <td className="px-6 py-4 text-center">
                      <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold">
                        {school.student_count ?? 0}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        school.is_active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}>
                        {school.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        {/* Create admin */}
                        <button
                          onClick={() => { setAdminForm(EMPTY_ADMIN_FORM); setFormError(''); setShowAddAdmin(school); }}
                          className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                          title="Create school admin"
                        >
                          Add Admin
                        </button>
                        {/* Toggle subscription */}
                        <button
                          onClick={() => setShowConfirmToggle(school)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                            school.is_active
                              ? 'text-orange-700 bg-orange-50 hover:bg-orange-100'
                              : 'text-green-700 bg-green-50 hover:bg-green-100'
                          }`}
                        >
                          {school.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add School Modal ─────────────────────────────────────────────── */}
      <Modal
        open={showAddSchool}
        onClose={() => setShowAddSchool(false)}
        title="Add New School"
      >
        <form onSubmit={handleAddSchool} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {formError}
            </div>
          )}

          <FormField label="School Name" htmlFor="school-name" required>
            <input
              id="school-name"
              type="text"
              className={inputClass}
              placeholder="e.g. Greenwood Academy"
              value={schoolForm.name}
              onChange={(e) => setSchoolForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </FormField>

          <FormField label="Address" htmlFor="school-address" required>
            <input
              id="school-address"
              type="text"
              className={inputClass}
              placeholder="123 Main Street, City"
              value={schoolForm.address}
              onChange={(e) => setSchoolForm((f) => ({ ...f, address: e.target.value }))}
              required
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Phone" htmlFor="school-phone">
              <input
                id="school-phone"
                type="tel"
                className={inputClass}
                placeholder="+1 555 000 0000"
                value={schoolForm.phone}
                onChange={(e) => setSchoolForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </FormField>
            <FormField label="Email" htmlFor="school-email">
              <input
                id="school-email"
                type="email"
                className={inputClass}
                placeholder="school@example.com"
                value={schoolForm.email}
                onChange={(e) => setSchoolForm((f) => ({ ...f, email: e.target.value }))}
              />
            </FormField>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddSchool(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
            >
              {submitting ? 'Creating…' : 'Create School'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Add Admin Modal ──────────────────────────────────────────────── */}
      <Modal
        open={!!showAddAdmin}
        onClose={() => setShowAddAdmin(null)}
        title={`Create Admin — ${showAddAdmin?.name ?? ''}`}
      >
        <form onSubmit={handleAddAdmin} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {formError}
            </div>
          )}

          <div className="px-3 py-2.5 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
            This account will have <strong>School Admin</strong> access for{' '}
            <strong>{showAddAdmin?.name}</strong>.
          </div>

          <FormField label="Full Name" htmlFor="admin-name" required>
            <input
              id="admin-name"
              type="text"
              className={inputClass}
              placeholder="Jane Smith"
              value={adminForm.name}
              onChange={(e) => setAdminForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </FormField>

          <FormField label="Email Address" htmlFor="admin-email" required>
            <input
              id="admin-email"
              type="email"
              className={inputClass}
              placeholder="admin@school.com"
              value={adminForm.email}
              onChange={(e) => setAdminForm((f) => ({ ...f, email: e.target.value }))}
              required
            />
          </FormField>

          <FormField label="Password" htmlFor="admin-password" required>
            <input
              id="admin-password"
              type="password"
              className={inputClass}
              placeholder="Min. 8 characters"
              value={adminForm.password}
              onChange={(e) => setAdminForm((f) => ({ ...f, password: e.target.value }))}
              minLength={8}
              required
            />
          </FormField>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddAdmin(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
            >
              {submitting ? 'Creating…' : 'Create Admin Account'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Confirm Toggle Modal ─────────────────────────────────────────── */}
      <Modal
        open={!!showConfirmToggle}
        onClose={() => setShowConfirmToggle(null)}
        title={showConfirmToggle?.is_active ? 'Deactivate School' : 'Activate School'}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {showConfirmToggle?.is_active ? (
              <>
                Are you sure you want to <strong>deactivate</strong>{' '}
                <strong>{showConfirmToggle?.name}</strong>? Their subscription will be paused and
                users will lose access.
              </>
            ) : (
              <>
                Are you sure you want to <strong>activate</strong>{' '}
                <strong>{showConfirmToggle?.name}</strong>? Their subscription will be restored.
              </>
            )}
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowConfirmToggle(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleToggleSubscription}
              disabled={submitting}
              className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 ${
                showConfirmToggle?.is_active
                  ? 'bg-orange-600 hover:bg-orange-700'
                  : 'bg-green-600 hover:bg-green-700'
              }`}
            >
              {submitting
                ? 'Updating…'
                : showConfirmToggle?.is_active
                ? 'Yes, Deactivate'
                : 'Yes, Activate'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// Wrap in Suspense because useSearchParams requires it in Next.js App Router
export default function SchoolsPage() {
  return (
    <Suspense>
      <SchoolsPageInner />
    </Suspense>
  );
}
